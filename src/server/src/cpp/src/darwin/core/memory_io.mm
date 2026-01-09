/**
 * @file memory_io.mm
 * @brief Memory read/write operations for Darwin/macOS using Mach VM APIs
 *
 * Implementation of process memory access functions. Uses mach_vm_read_overwrite
 * for reading and mach_vm_write for writing, with proper memory protection handling.
 */

#include "memory_io.h"
#include "native_api.h"

#include <errno.h>
#include <mach/mach_error.h>
#include <unistd.h>

#include <map>
#include <mutex>

// =============================================================================
// Task Port Cache
// =============================================================================

// Task port cache to avoid repeated task_for_pid calls
static std::map<pid_t, mach_port_t> g_memory_task_port_cache;
static std::mutex g_memory_task_port_mutex;

mach_port_t get_task_port_for_pid(pid_t pid)
{
    if (pid == getpid())
    {
        return mach_task_self();
    }

    std::lock_guard<std::mutex> lock(g_memory_task_port_mutex);

    auto it = g_memory_task_port_cache.find(pid);
    if (it != g_memory_task_port_cache.end())
    {
        debug_log(LOG_DEBUG, "Memory task port cache hit for pid %d: %d", pid, it->second);
        return it->second;
    }

    // debug_log_develop(LOG_DEBUG, "Memory task port cache miss for pid %d, calling task_for_pid",
    // pid);

    mach_port_t task;
    kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_for_pid failed for memory access: %d (%s)", kr,
                  mach_error_string(kr));
        return MACH_PORT_NULL;
    }

    g_memory_task_port_cache[pid] = task;
    // debug_log_develop(LOG_INFO, "Cached memory task port for pid %d: %d", pid, task);
    return task;
}

void clear_task_port_cache(pid_t pid)
{
    std::lock_guard<std::mutex> lock(g_memory_task_port_mutex);
    auto it = g_memory_task_port_cache.find(pid);
    if (it != g_memory_task_port_cache.end())
    {
        mach_port_deallocate(mach_task_self(), it->second);
        g_memory_task_port_cache.erase(it);
        debug_log(LOG_INFO, "Cleared memory task port cache for pid %d", pid);
    }
}

// =============================================================================
// Memory Read Operations
// =============================================================================

ssize_t read_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                           unsigned char* buffer)
{
    return read_memory_native_with_method(pid, address, size, buffer, 0);
}

ssize_t read_memory_native_with_method(int pid, mach_vm_address_t address, mach_vm_size_t size,
                                       unsigned char* buffer, int mode __attribute__((unused)))
{
    // Darwin doesn't use mode parameter, always uses mach_vm_read
    mach_port_t task = get_task_port_for_pid(pid);
    if (task == MACH_PORT_NULL)
    {
        debug_log(LOG_ERROR, "read_memory_native_with_method: No task port for pid %d", pid);
        errno = ESRCH;  // Set proper errno for "No such process"
        return -1;
    }

    mach_vm_size_t out_size;
    kern_return_t kr =
        mach_vm_read_overwrite(task, address, size, (mach_vm_address_t)buffer, &out_size);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_DEBUG, "mach_vm_read_overwrite failed: %d (%s) at 0x%llx size %llu", kr,
                  mach_error_string(kr), address, size);
        return -1;
    }

    return static_cast<ssize_t>(out_size);
}

// =============================================================================
// Memory Write Operations
// =============================================================================

ssize_t write_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                            unsigned char* buffer)
{
    vm_prot_t original_protection;
    vm_region_basic_info_data_64_t info;
    mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object_name;
    bool is_embedded_mode = pid == getpid();

    mach_port_t task = get_task_port_for_pid(pid);
    if (task == MACH_PORT_NULL)
    {
        debug_log(LOG_ERROR, "write_memory_native: No task port for pid %d", pid);
        return -1;
    }

    kern_return_t err;
    if (!is_embedded_mode)
    {
        task_suspend(task);
    }

    // Get region information to save original protection
    mach_vm_address_t region_address = address;
    mach_vm_size_t region_size = size;
    err = mach_vm_region(task, &region_address, &region_size, VM_REGION_BASIC_INFO_64,
                         (vm_region_info_t)&info, &info_count, &object_name);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_vm_region failed: %d (%s) at 0x%llx size %llu", err,
                  mach_error_string(err), address, size);
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }
    original_protection = info.protection;

    // Enable write access
    err = mach_vm_protect(task, address, size, false, VM_PROT_READ | VM_PROT_WRITE);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_vm_protect (write enable) failed: %d (%s)", err,
                  mach_error_string(err));
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }

    // Write memory
    err = mach_vm_write(task, address, (vm_offset_t)buffer, size);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_vm_write failed: %d (%s) at 0x%llx size %llu", err,
                  mach_error_string(err), address, size);
        mach_vm_protect(task, address, size, false, original_protection);
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }

    // Restore original protection
    err = mach_vm_protect(task, address, size, false, original_protection);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_vm_protect (restore) failed: %d (%s)", err,
                  mach_error_string(err));
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }

    if (!is_embedded_mode)
    {
        task_resume(task);
    }
    return static_cast<ssize_t>(size);
}
