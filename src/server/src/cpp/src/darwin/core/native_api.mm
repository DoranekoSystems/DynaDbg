#include "native_api.h"
#include <Foundation/Foundation.h>
#include <dlfcn.h>
#include <errno.h>
#include <mach-o/dyld_images.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <mach-o/stab.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/queue.h>
#include <sys/sysctl.h>
#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <vector>

PROC_REGIONFILENAME proc_regionfilename = nullptr;
PROC_PIDPATH proc_pidpath = nullptr;
ServerState global_server_state = {0};

// Task port cache to avoid repeated task_for_pid calls
static std::map<pid_t, mach_port_t> g_task_port_cache;
static std::mutex g_task_port_mutex;

// Helper function to get cached task port
static mach_port_t get_cached_task_port(pid_t pid)
{
    if (pid == getpid())
    {
        return mach_task_self();
    }

    std::lock_guard<std::mutex> lock(g_task_port_mutex);

    auto it = g_task_port_cache.find(pid);
    if (it != g_task_port_cache.end())
    {
        debug_log(LOG_DEBUG, "Task port cache hit for pid %d: %d", pid, it->second);
        return it->second;
    }

    // debug_log_develop(LOG_DEBUG, "Task port cache miss for pid %d, calling task_for_pid", pid);
    mach_port_t task;
    kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_for_pid failed with error %d (%s)\n", kr, mach_error_string(kr));
        return MACH_PORT_NULL;
    }

    g_task_port_cache[pid] = task;
    // debug_log_develop(LOG_INFO, "Cached task port for pid %d: %d", pid, task);
    return task;
}

// Function to invalidate cached task port (call when process exits)
extern "C" void invalidate_task_port_cache(pid_t pid)
{
    std::lock_guard<std::mutex> lock(g_task_port_mutex);
    auto it = g_task_port_cache.find(pid);
    if (it != g_task_port_cache.end())
    {
        mach_port_deallocate(mach_task_self(), it->second);
        g_task_port_cache.erase(it);
        debug_log(LOG_INFO, "Invalidated task port cache for pid %d", pid);
    }
}

// Function to set cached task port from external source (e.g., debugger)
extern "C" void set_cached_task_port(pid_t pid, mach_port_t task)
{
    if (pid == getpid() || task == MACH_PORT_NULL)
    {
        return;
    }

    std::lock_guard<std::mutex> lock(g_task_port_mutex);

    // Only set if not already cached
    if (g_task_port_cache.find(pid) == g_task_port_cache.end())
    {
        g_task_port_cache[pid] = task;
        debug_log(LOG_INFO, "Set cached task port for pid %d: %d (from external)", pid, task);
    }
}

int debug_log(LogLevel level, const char *format, ...)
{
    va_list list;
    va_start(list, format);

    char buffer[1024];

    char tagged_format[1024];
    snprintf(tagged_format, sizeof(tagged_format), "[NATIVE] %s", format);

    vsnprintf(buffer, sizeof(buffer), tagged_format, list);
    native_log(level, buffer);

    NSString *nsFinalMessage = [NSString stringWithUTF8String:buffer];
    if (global_server_state.mode == ServerMode::EMBEDDED)
    {
        NSLog(@"%@", nsFinalMessage);
    }
    va_end(list);
    return 0;
}

#ifdef ENABLE_LOG_DEVELOP
int _debug_log_develop_impl(const char *func, int line, LogLevel level, const char *format, ...)
{
    va_list list;
    va_start(list, format);

    char buffer[1024];

    char tagged_format[1024];
    const char *build_type = "STATIC";
#ifdef DYNAMIC_LIB_BUILD
    build_type = "DYNAMIC";
#endif

    snprintf(tagged_format, sizeof(tagged_format), "[NATIVE][DEVELOP][%s] %s:%d %s", build_type,
             func, line, format);

    vsnprintf(buffer, sizeof(buffer), tagged_format, list);
    native_log(level, buffer);  // Output at specified level

    NSString *nsFinalMessage = [NSString stringWithUTF8String:buffer];
    if (global_server_state.mode == ServerMode::EMBEDDED)
    {
        NSLog(@"%@", nsFinalMessage);
    }
    va_end(list);
    return 0;
}
#else
// No-op function when ENABLE_LOG_DEVELOP is not defined
int _debug_log_develop_impl(const char *func __attribute__((unused)),
                            int line __attribute__((unused)),
                            LogLevel level __attribute__((unused)),
                            const char *format __attribute__((unused)), ...)
{
    // Do nothing
    return 0;
}
#endif

pid_t get_pid_native()
{
    return getpid();
}

ssize_t read_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                           unsigned char *buffer)
{
    return read_memory_native_with_method(pid, address, size, buffer, 0);
}

ssize_t read_memory_native_with_method(int pid, mach_vm_address_t address, mach_vm_size_t size,
                                       unsigned char *buffer, int mode __attribute__((unused)))
{
    // Darwin doesn't use mode parameter, always uses mach_vm_read
    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        debug_log(LOG_ERROR, "read_memory_native_with_method: No task port for pid %d\n", pid);
        errno = ESRCH;  // Set proper errno for "No such process"
        return -1;
    }

    mach_vm_size_t out_size;
    kern_return_t kr =
        mach_vm_read_overwrite(task, address, size, (mach_vm_address_t)buffer, &out_size);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_DEBUG, "mach_vm_read_overwrite failed with error %d (%s)\n", kr,
                  mach_error_string(kr));
        return -1;
    }

    return static_cast<ssize_t>(out_size);
}

ssize_t write_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                            unsigned char *buffer)
{
    vm_prot_t original_protection;
    vm_region_basic_info_data_64_t info;
    mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object_name;
    bool is_embedded_mode = pid == getpid();

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        return -1;
    }

    kern_return_t err;
    if (!is_embedded_mode)
    {
        task_suspend(task);
    }

    mach_vm_address_t region_address = address;
    mach_vm_size_t region_size = size;
    err = mach_vm_region(task, &region_address, &region_size, VM_REGION_BASIC_INFO_64,
                         (vm_region_info_t)&info, &info_count, &object_name);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR,
                  "mach_vm_region failed with error %d (%s) at address "
                  "0x%llx, size 0x%llx\n",
                  err, mach_error_string(err), address, size);
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }
    original_protection = info.protection;

    err = mach_vm_protect(task, address, size, false, VM_PROT_READ | VM_PROT_WRITE);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_vm_protect (write enable) failed with error %d (%s)\n", err,
                  mach_error_string(err));
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }

    err = mach_vm_write(task, address, (vm_offset_t)buffer, size);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR,
                  "mach_vm_write failed with error %d (%s) at address "
                  "0x%llx, size 0x%llx\n",
                  err, mach_error_string(err), address, size);
        mach_vm_protect(task, address, size, false, original_protection);
        if (!is_embedded_mode)
        {
            task_resume(task);
        }
        return -1;
    }

    err = mach_vm_protect(task, address, size, false, original_protection);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR,
                  "mach_vm_protect (restore protection) failed with error "
                  "%d (%s)\n",
                  err, mach_error_string(err));
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

void enumerate_regions_to_buffer(pid_t pid, char *buffer, size_t buffer_size)
{
    vm_address_t address = 0;
    vm_size_t size = 0;
    natural_t depth = 1;

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        snprintf(buffer, buffer_size, "Failed to get task for pid %d\n", pid);
        return;
    }

    size_t pos = 0;
    char buf[PATH_MAX];
    memset(buf, 0, PATH_MAX);
    while (true)
    {
        vm_region_submap_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_SUBMAP_INFO_COUNT_64;

        if (vm_region_recurse_64(task, &address, &size, &depth, (vm_region_info_t)&info,
                                 &info_count) != KERN_SUCCESS)
        {
            break;
        }

        if (info.is_submap)
        {
            depth++;
        }
        else
        {
            char protection[4] = "---";
            if (info.protection & VM_PROT_READ) protection[0] = 'r';
            if (info.protection & VM_PROT_WRITE) protection[1] = 'w';
            if (info.protection & VM_PROT_EXECUTE) protection[2] = 'x';

            int ret = proc_regionfilename(pid, static_cast<unsigned long long>(address), buf,
                                          sizeof(buf));

            if (ret <= 0)
            {
                buf[0] = '\x00';
            }

            pos += snprintf(buffer + pos, buffer_size - pos, "%llx-%llx %s _ _ _ %s\n",
                            static_cast<unsigned long long>(address),
                            static_cast<unsigned long long>(address + size), protection, buf);

            if (pos >= buffer_size - 1) break;

            address += size;
        }
    }
}

// Fast version: optional filename retrieval
void enumerate_regions_to_buffer_fast(pid_t pid, char *buffer, size_t buffer_size,
                                      bool include_filenames)
{
    vm_address_t address = 0;
    vm_size_t size = 0;
    natural_t depth = 1;

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        snprintf(buffer, buffer_size, "Failed to get task for pid %d\n", pid);
        return;
    }

    size_t pos = 0;
    char buf[PATH_MAX] = {0};  // Zero-initialize
    int region_count = 0;
    auto filename_total_time = std::chrono::duration<double, std::milli>::zero();

    while (true)
    {
        vm_region_submap_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_SUBMAP_INFO_COUNT_64;

        if (vm_region_recurse_64(task, &address, &size, &depth, (vm_region_info_t)&info,
                                 &info_count) != KERN_SUCCESS)
        {
            break;
        }

        if (info.is_submap)
        {
            depth++;
        }
        else
        {
            region_count++;
            char protection[4] = "---";
            if (info.protection & VM_PROT_READ) protection[0] = 'r';
            if (info.protection & VM_PROT_WRITE) protection[1] = 'w';
            if (info.protection & VM_PROT_EXECUTE) protection[2] = 'x';

            // Filename retrieval is conditional
            if (include_filenames && proc_regionfilename != nullptr)
            {
                auto filename_start = std::chrono::high_resolution_clock::now();
                int ret = proc_regionfilename(pid, static_cast<unsigned long long>(address), buf,
                                              sizeof(buf));
                auto filename_elapsed = std::chrono::high_resolution_clock::now() - filename_start;
                filename_total_time += filename_elapsed;

                if (ret <= 0)
                {
                    buf[0] = '\x00';
                }
            }
            else
            {
                buf[0] = '\x00';  // No filename
            }

            pos += snprintf(buffer + pos, buffer_size - pos, "%llx-%llx %s _ _ _ %s\n",
                            static_cast<unsigned long long>(address),
                            static_cast<unsigned long long>(address + size), protection, buf);

            if (pos >= buffer_size - 1) break;

            address += size;
        }
    }
}

ProcessInfo *enumerate_processes(size_t *count)
{
    int err;
    struct kinfo_proc *result;
    bool done;
    static const int name[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    size_t length;

    result = nullptr;
    done = false;

    do
    {
        length = 0;
        err = sysctl(const_cast<int *>(name), (sizeof(name) / sizeof(*name)) - 1, nullptr, &length,
                     nullptr, 0);
        if (err == -1)
        {
            err = errno;
        }

        if (err == 0)
        {
            result = static_cast<struct kinfo_proc *>(malloc(length));
            if (result == nullptr)
            {
                err = ENOMEM;
            }
        }

        if (err == 0)
        {
            err = sysctl(const_cast<int *>(name), (sizeof(name) / sizeof(*name)) - 1, result,
                         &length, nullptr, 0);
            if (err == -1)
            {
                err = errno;
            }
            if (err == 0)
            {
                done = true;
            }
            else if (err == ENOMEM)
            {
                free(result);
                result = nullptr;
                err = 0;
            }
        }
    } while (err == 0 && !done);

    if (err == 0 && result != nullptr)
    {
        *count = length / sizeof(struct kinfo_proc);
        ProcessInfo *processes = static_cast<ProcessInfo *>(malloc(*count * sizeof(ProcessInfo)));

        for (size_t i = 0; i < *count; i++)
        {
            processes[i].pid = result[i].kp_proc.p_pid;
            processes[i].processname = strdup(result[i].kp_proc.p_comm);
        }

        free(result);
        return processes;
    }
    else
    {
        if (result != nullptr)
        {
            free(result);
        }
        debug_log(LOG_ERROR, "Failed to enumerate processes, error %d\n", err);
        return nullptr;
    }
}

bool suspend_process(pid_t pid)
{
    bool is_embedded_mode = pid == getpid();
    if (is_embedded_mode)
    {
        debug_log(LOG_ERROR, "Cannot suspend self process\n");
        return false;
    }

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        return false;
    }

    kern_return_t err = task_suspend(task);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_suspend failed with error %d (%s)\n", err,
                  mach_error_string(err));
        return false;
    }

    return true;
}

bool resume_process(pid_t pid)
{
    bool is_embedded_mode = pid == getpid();
    if (is_embedded_mode)
    {
        debug_log(LOG_ERROR, "Cannot resume self process\n");
        return false;
    }

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        return false;
    }

    kern_return_t err = task_resume(task);
    if (err != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_resume failed with error %d (%s)\n", err,
                  mach_error_string(err));
        return false;
    }

    return true;
}

static std::uint64_t get_image_size_64(int pid, mach_vm_address_t base_address)
{
    mach_header_64 header;
    if (read_memory_native(pid, base_address, sizeof(mach_header_64),
                           reinterpret_cast<unsigned char *>(&header)) <= 0)
    {
        debug_log(LOG_ERROR, "Failed to read 64-bit Mach-O header\n");
        return 0;
    }

    std::uint64_t text_size = 0;
    mach_vm_address_t current_address = base_address + sizeof(mach_header_64);

    for (int i = 0; i < header.ncmds; i++)
    {
        load_command lc;
        if (read_memory_native(pid, current_address, sizeof(load_command),
                               reinterpret_cast<unsigned char *>(&lc)) <= 0)
        {
            debug_log(LOG_ERROR, "Failed to read load command\n");
            return 0;
        }

        if (lc.cmd == LC_SEGMENT_64)
        {
            segment_command_64 seg;
            if (read_memory_native(pid, current_address, sizeof(segment_command_64),
                                   reinterpret_cast<unsigned char *>(&seg)) <= 0)
            {
                debug_log(LOG_ERROR, "Failed to read segment command\n");
                return 0;
            }
            // For dyld shared cache libraries, segments are not contiguous.
            // Return __TEXT segment size only (matches Frida's behavior)
            if (strncmp(seg.segname, "__TEXT", 16) == 0)
            {
                text_size = seg.vmsize;
                break;
            }
        }

        current_address += lc.cmdsize;
    }

    return text_size;
}

static std::uint64_t get_image_size_32(int pid, mach_vm_address_t base_address)
{
    mach_header header;
    if (read_memory_native(pid, base_address, sizeof(mach_header),
                           reinterpret_cast<unsigned char *>(&header)) <= 0)
    {
        debug_log(LOG_ERROR, "Failed to read 32-bit Mach-O header\n");
        return 0;
    }

    std::uint64_t image_size = 0;
    mach_vm_address_t current_address = base_address + sizeof(mach_header);

    for (int i = 0; i < header.ncmds; i++)
    {
        load_command lc;
        if (read_memory_native(pid, current_address, sizeof(load_command),
                               reinterpret_cast<unsigned char *>(&lc)) <= 0)
        {
            debug_log(LOG_ERROR, "Failed to read load command\n");
            return 0;
        }

        if (lc.cmd == LC_SEGMENT)
        {
            segment_command seg;
            if (read_memory_native(pid, current_address, sizeof(segment_command),
                                   reinterpret_cast<unsigned char *>(&seg)) <= 0)
            {
                debug_log(LOG_ERROR, "Failed to read segment command\n");
                return 0;
            }
            image_size += seg.vmsize;
        }

        current_address += lc.cmdsize;
    }

    return image_size;
}

// Try to get module size using MachOBridge (for embedded/local process)
static std::uint64_t get_module_size_via_macho_bridge(mach_vm_address_t address, bool *is_64bit)
{
    // Try to get size via MachOBridge (Swift/MachOKit)
    uint64_t size = macho_get_module_size_by_address(static_cast<uint64_t>(address));
    if (size > 0)
    {
        // Determine if 64-bit by reading magic
        std::uint32_t magic = 0;
        if (read_memory_native(getpid(), address, sizeof(std::uint32_t),
                               reinterpret_cast<unsigned char *>(&magic)) > 0)
        {
            *is_64bit = (magic == MH_MAGIC_64);
        }
        else
        {
            *is_64bit = true;  // Default to 64-bit on modern systems
        }
        return size;
    }
    return 0;
}

// Check if a path is a system library (likely to be in dyld shared cache)
static bool is_system_library_path(const char *path)
{
    if (path == nullptr || path[0] == '\0')
    {
        return false;
    }

    // System library paths on iOS/macOS
    static const char *system_prefixes[] = {"/System/",
                                            "/usr/lib/",
                                            "/Library/Apple/",
                                            "/Library/Frameworks/",
                                            "/private/preboot/",  // Cryptex paths
                                            nullptr};

    for (const char **prefix = system_prefixes; *prefix != nullptr; prefix++)
    {
        if (strncmp(path, *prefix, strlen(*prefix)) == 0)
        {
            return true;
        }
    }

    return false;
}

// Try to get module size from dyld shared cache
static std::uint64_t get_module_size_from_cache(const char *module_path, bool *is_64bit)
{
    if (module_path == nullptr || module_path[0] == '\0')
    {
        return 0;
    }

    uint64_t size = macho_get_module_size_from_cache(module_path);
    if (size > 0)
    {
        *is_64bit = true;  // System libraries in cache are typically 64-bit
        return size;
    }
    return 0;
}

static std::uint64_t get_module_size(int pid, mach_vm_address_t address, bool *is_64bit,
                                     const char *module_path)
{
    // Method 1: For embedded mode (same process), try MachOBridge by address first
    if (pid == getpid())
    {
        uint64_t size = get_module_size_via_macho_bridge(address, is_64bit);
        if (size > 0)
        {
            debug_log(LOG_DEBUG, "Got module size via MachOBridge by address: 0x%llx", size);
            return size;
        }
    }

    // Method 2: If we have a system library path, try dyld cache (works for any process)
    // The dyld cache is shared across all processes on the same iOS/macOS version
    if (is_system_library_path(module_path))
    {
        uint64_t size = get_module_size_from_cache(module_path, is_64bit);
        if (size > 0)
        {
            debug_log(LOG_DEBUG, "Got module size via dyld cache: 0x%llx for %s", size,
                      module_path);
            return size;
        }
    }

    // Fallback: read directly from memory
    std::uint32_t magic;
    if (read_memory_native(pid, address, sizeof(std::uint32_t),
                           reinterpret_cast<unsigned char *>(&magic)) <= 0)
    {
        debug_log(LOG_ERROR, "Failed to read Mach-O magic number\n");
        return 0;
    }

    if (magic == MH_MAGIC_64)
    {
        *is_64bit = true;
        return get_image_size_64(pid, address);
    }
    else if (magic == MH_MAGIC)
    {
        *is_64bit = false;
        return get_image_size_32(pid, address);
    }
    else if (magic == FAT_MAGIC || magic == FAT_CIGAM)
    {
        fat_header fatHeader;
        if (read_memory_native(pid, address, sizeof(fat_header),
                               reinterpret_cast<unsigned char *>(&fatHeader)) <= 0)
        {
            debug_log(LOG_ERROR, "Failed to read FAT header\n");
            return 0;
        }

        std::vector<fat_arch> archs(fatHeader.nfat_arch);
        if (read_memory_native(pid, address + sizeof(fat_header),
                               fatHeader.nfat_arch * sizeof(fat_arch),
                               reinterpret_cast<unsigned char *>(archs.data())) <= 0)
        {
            debug_log(LOG_ERROR, "Failed to read FAT architectures\n");
            return 0;
        }

        for (const auto &arch : archs)
        {
            if (read_memory_native(pid, address + arch.offset, sizeof(std::uint32_t),
                                   reinterpret_cast<unsigned char *>(&magic)) <= 0)
            {
                debug_log(LOG_ERROR, "Failed to read Mach-O magic "
                                     "number in FAT binary\n");
                continue;
            }
            if (magic == MH_MAGIC_64)
            {
                *is_64bit = true;
                return get_image_size_64(pid, address + arch.offset);
            }
            else if (magic == MH_MAGIC)
            {
                *is_64bit = false;
                return get_image_size_32(pid, address + arch.offset);
            }
        }
    }

    debug_log(LOG_ERROR, "Unknown Mach-O format\n");
    return 0;
}

// Overload without module_path parameter
static std::uint64_t get_module_size(int pid, mach_vm_address_t address, bool *is_64bit)
{
    return get_module_size(pid, address, is_64bit, nullptr);
}

// Embedded mode: Use MachOBridge APIs directly for the current process
static ModuleInfo *enummodule_native_embedded(size_t *count)
{
    uint32_t image_count = macho_get_loaded_image_count();
    if (image_count == 0)
    {
        *count = 0;
        return nullptr;
    }

    std::vector<ModuleInfo> moduleList;
    moduleList.reserve(image_count);

    for (uint32_t i = 0; i < image_count; i++)
    {
        char *path = macho_get_loaded_image_path(i);
        uint64_t base = macho_get_loaded_image_base(i);
        uint64_t macho_kit_size = macho_get_loaded_image_size(i);

        if (base == 0)
        {
            if (path) macho_free_string(path);
            continue;
        }

        // Calculate native size for comparison
        bool is_64bit = true;
        uint64_t native_size = get_image_size_64(getpid(), static_cast<mach_vm_address_t>(base));

        // Log comparison between MachOKit and native implementation
        const char *module_name = path ? path : "Unknown";
        debug_log(LOG_INFO,
                  "Module: %s, base: 0x%llx, MachOKit size: %llu (0x%llx), "
                  "Native size: %llu (0x%llx)\n",
                  module_name, base, macho_kit_size, macho_kit_size, native_size, native_size);

        ModuleInfo module;
        module.modulename = path ? strdup(path) : strdup("Unknown");
        module.base = static_cast<std::uintptr_t>(base);
        module.size = static_cast<std::int32_t>(macho_kit_size);

        // Determine if 64-bit by reading magic
        std::uint32_t magic = 0;
        if (read_memory_native(getpid(), base, sizeof(std::uint32_t),
                               reinterpret_cast<unsigned char *>(&magic)) > 0)
        {
            module.is_64bit = (magic == MH_MAGIC_64);
        }
        else
        {
            module.is_64bit = true;  // Default to 64-bit on modern systems
        }

        moduleList.push_back(module);

        if (path) macho_free_string(path);
    }

    *count = moduleList.size();
    ModuleInfo *result = static_cast<ModuleInfo *>(malloc(*count * sizeof(ModuleInfo)));
    std::copy(moduleList.begin(), moduleList.end(), result);

    return result;
}

ModuleInfo *enumerate_modules(pid_t pid, size_t *count)
{
    task_t task;
    kern_return_t err;
    bool is_embedded_mode = pid == getpid();

    // For embedded mode, try using MachOBridge APIs first
    if (is_embedded_mode)
    {
        ModuleInfo *result = enummodule_native_embedded(count);
        if (result != nullptr && *count > 0)
        {
            return result;
        }
        // Fallback to the standard method if MachOBridge fails
        task = mach_task_self();
    }
    else
    {
        task = get_cached_task_port(pid);
        if (task == MACH_PORT_NULL)
        {
            *count = 0;
            return nullptr;
        }
    }
    task_dyld_info dyld_info;
    mach_msg_type_number_t count_info = TASK_DYLD_INFO_COUNT;

    if (task_info(task, TASK_DYLD_INFO, reinterpret_cast<task_info_t>(&dyld_info), &count_info) !=
        KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to get task info\n");
        *count = 0;
        return nullptr;
    }

    dyld_all_image_infos all_image_infos;
    if (read_memory_native(pid, dyld_info.all_image_info_addr, sizeof(dyld_all_image_infos),
                           reinterpret_cast<unsigned char *>(&all_image_infos)) <= 0)
    {
        debug_log(LOG_ERROR, "Failed to read all_image_infos\n");
        *count = 0;
        return nullptr;
    }

    std::vector<dyld_image_info> image_infos(all_image_infos.infoArrayCount);
    if (read_memory_native(pid, reinterpret_cast<mach_vm_address_t>(all_image_infos.infoArray),
                           sizeof(dyld_image_info) * all_image_infos.infoArrayCount,
                           reinterpret_cast<unsigned char *>(image_infos.data())) <= 0)
    {
        debug_log(LOG_ERROR, "Failed to read image_infos\n");
        *count = 0;
        return nullptr;
    }

    std::vector<ModuleInfo> moduleList;
    moduleList.reserve(all_image_infos.infoArrayCount);

    for (const auto &info : image_infos)
    {
        char fpath[PATH_MAX];
        if (read_memory_native(pid, reinterpret_cast<mach_vm_address_t>(info.imageFilePath),
                               PATH_MAX, reinterpret_cast<unsigned char *>(fpath)) > 0)
        {
            ModuleInfo module;
            if (strlen(fpath) == 0 && proc_regionfilename != nullptr)
            {
                char buffer[PATH_MAX];
                int ret =
                    proc_regionfilename(pid, reinterpret_cast<std::uint64_t>(info.imageLoadAddress),
                                        buffer, sizeof(buffer));
                module.modulename = strdup(ret > 0 ? buffer : "None");
            }
            else
            {
                module.modulename = strdup(fpath);
            }

            module.base = reinterpret_cast<std::uintptr_t>(info.imageLoadAddress);
            // Pass module path to get_module_size for better size calculation
            module.size = static_cast<std::int32_t>(
                get_module_size(pid, static_cast<mach_vm_address_t>(module.base), &module.is_64bit,
                                module.modulename));

            moduleList.push_back(module);
        }
    }

    *count = moduleList.size();
    ModuleInfo *result = static_cast<ModuleInfo *>(malloc(*count * sizeof(ModuleInfo)));
    std::copy(moduleList.begin(), moduleList.end(), result);

    return result;
}

int native_init(int mode)
{
#if defined(ENABLE_LOG_DEVELOP) && defined(BUILD_TIMESTAMP)
    // debug_log_develop(LOG_INFO, "=== Native Library Initialized ===");
    // debug_log_develop(LOG_INFO, "Build timestamp: %s", BUILD_TIMESTAMP);
    // debug_log_develop(LOG_INFO, "==================================");
#endif

    global_server_state.mode = mode;
    void *libsystem_kernel = dlopen("/usr/lib/system/libsystem_kernel.dylib", RTLD_NOW);
    if (!libsystem_kernel)
    {
        debug_log(LOG_ERROR, "Failed to load libsystem_kernel.dylib: %s\n", dlerror());
        return -1;
    }

    // Clear any existing error
    dlerror();

    proc_pidpath = (PROC_PIDPATH)dlsym(libsystem_kernel, "proc_pidpath");
    char *dlsym_error = dlerror();
    if (dlsym_error)
    {
        debug_log(LOG_ERROR, "Failed to load proc_pidpath symbol: %s\n", dlsym_error);
        proc_pidpath = nullptr;
    }

    if (proc_pidpath == nullptr)
    {
        debug_log(LOG_ERROR, "proc_pidpath is not available. Some functionality "
                             "may be limited.\n");
    }

    proc_regionfilename = (PROC_REGIONFILENAME)dlsym(libsystem_kernel, "proc_regionfilename");
    dlsym_error = dlerror();
    if (dlsym_error)
    {
        debug_log(LOG_ERROR, "Failed to load proc_regionfilename symbol: %s\n", dlsym_error);
        proc_regionfilename = nullptr;
    }

    if (proc_regionfilename == nullptr)
    {
        debug_log(LOG_ERROR, "proc_regionfilename is not available. Some "
                             "functionality may be limited.\n");
    }
    return 1;
}

// Helper function to get symbol type string
static const char *get_symbol_type_string(uint8_t n_type)
{
    switch (n_type & N_TYPE)
    {
        case N_UNDF:
            return "Undefined";
        case N_ABS:
            return "Absolute";
        case N_SECT:
            return "Section";
        case N_PBUD:
            return "Prebound";
        case N_INDR:
            return "Indirect";
        default:
            return "Unknown";
    }
}

// Helper function to get symbol scope string
static const char *get_symbol_scope_string(uint8_t n_type)
{
    if (n_type & N_EXT)
    {
        return "Global";
    }
    else
    {
        return "Local";
    }
}

// Parse symbols from a Mach-O image in memory
static std::vector<SymbolInfo> parse_macho_symbols_in_memory(int pid,
                                                             mach_vm_address_t base_address,
                                                             bool is_64bit)
{
    std::vector<SymbolInfo> symbols;

    if (is_64bit)
    {
        mach_header_64 header;
        if (read_memory_native(pid, base_address, sizeof(mach_header_64),
                               reinterpret_cast<unsigned char *>(&header)) <= 0)
        {
            debug_log(LOG_ERROR, "Failed to read 64-bit Mach-O header");
            return symbols;
        }

        mach_vm_address_t current_address = base_address + sizeof(mach_header_64);

        for (uint32_t i = 0; i < header.ncmds; i++)
        {
            load_command lc;
            if (read_memory_native(pid, current_address, sizeof(load_command),
                                   reinterpret_cast<unsigned char *>(&lc)) <= 0)
            {
                debug_log(LOG_ERROR, "Failed to read load command");
                break;
            }

            if (lc.cmd == LC_SYMTAB)
            {
                symtab_command symtab;
                if (read_memory_native(pid, current_address, sizeof(symtab_command),
                                       reinterpret_cast<unsigned char *>(&symtab)) <= 0)
                {
                    debug_log(LOG_ERROR, "Failed to read symtab command");
                    current_address += lc.cmdsize;
                    continue;
                }

                // Read symbol table
                std::vector<nlist_64> symbol_table(symtab.nsyms);
                mach_vm_address_t symtab_addr = base_address + symtab.symoff;
                if (read_memory_native(pid, symtab_addr, symtab.nsyms * sizeof(nlist_64),
                                       reinterpret_cast<unsigned char *>(symbol_table.data())) <= 0)
                {
                    debug_log(LOG_ERROR, "Failed to read symbol table");
                    current_address += lc.cmdsize;
                    continue;
                }

                // Read string table
                std::vector<char> string_table(symtab.strsize);
                mach_vm_address_t strtab_addr = base_address + symtab.stroff;
                if (read_memory_native(pid, strtab_addr, symtab.strsize,
                                       reinterpret_cast<unsigned char *>(string_table.data())) <= 0)
                {
                    debug_log(LOG_ERROR, "Failed to read string table");
                    current_address += lc.cmdsize;
                    continue;
                }

                // Parse symbols
                for (uint32_t j = 0; j < symtab.nsyms; j++)
                {
                    const nlist_64 &sym = symbol_table[j];

                    // Skip debug symbols and undefined symbols
                    if ((sym.n_type & N_STAB) || (sym.n_type & N_TYPE) == N_UNDF)
                    {
                        continue;
                    }

                    // Skip symbols without names
                    if (sym.n_un.n_strx == 0 || sym.n_un.n_strx >= symtab.strsize)
                    {
                        continue;
                    }

                    SymbolInfo symbol_info;
                    symbol_info.address = sym.n_value;
                    symbol_info.name = strdup(&string_table[sym.n_un.n_strx]);
                    symbol_info.size = 0;  // Size information not directly
                                           // available in Mach-O
                    symbol_info.type = strdup(get_symbol_type_string(sym.n_type));
                    symbol_info.scope = strdup(get_symbol_scope_string(sym.n_type));
                    symbol_info.module_base = base_address;
                    symbol_info.file_name = strdup("");  // File name not easily available
                    symbol_info.line_number = 0;         // Line number not available in
                                                         // symbol table

                    symbols.push_back(symbol_info);
                }
            }

            current_address += lc.cmdsize;
        }
    }
    else
    {
        // Similar implementation for 32-bit Mach-O
        mach_header header;
        if (read_memory_native(pid, base_address, sizeof(mach_header),
                               reinterpret_cast<unsigned char *>(&header)) <= 0)
        {
            debug_log(LOG_ERROR, "Failed to read 32-bit Mach-O header");
            return symbols;
        }

        mach_vm_address_t current_address = base_address + sizeof(mach_header);

        for (uint32_t i = 0; i < header.ncmds; i++)
        {
            load_command lc;
            if (read_memory_native(pid, current_address, sizeof(load_command),
                                   reinterpret_cast<unsigned char *>(&lc)) <= 0)
            {
                debug_log(LOG_ERROR, "Failed to read load command");
                break;
            }

            if (lc.cmd == LC_SYMTAB)
            {
                symtab_command symtab;
                if (read_memory_native(pid, current_address, sizeof(symtab_command),
                                       reinterpret_cast<unsigned char *>(&symtab)) <= 0)
                {
                    debug_log(LOG_ERROR, "Failed to read symtab command");
                    current_address += lc.cmdsize;
                    continue;
                }

                // Read symbol table
                std::vector<struct nlist> symbol_table(symtab.nsyms);
                mach_vm_address_t symtab_addr = base_address + symtab.symoff;
                if (read_memory_native(pid, symtab_addr, symtab.nsyms * sizeof(struct nlist),
                                       reinterpret_cast<unsigned char *>(symbol_table.data())) <= 0)
                {
                    debug_log(LOG_ERROR, "Failed to read symbol table");
                    current_address += lc.cmdsize;
                    continue;
                }

                // Read string table
                std::vector<char> string_table(symtab.strsize);
                mach_vm_address_t strtab_addr = base_address + symtab.stroff;
                if (read_memory_native(pid, strtab_addr, symtab.strsize,
                                       reinterpret_cast<unsigned char *>(string_table.data())) <= 0)
                {
                    debug_log(LOG_ERROR, "Failed to read string table");
                    current_address += lc.cmdsize;
                    continue;
                }

                // Parse symbols
                for (uint32_t j = 0; j < symtab.nsyms; j++)
                {
                    const struct nlist &sym = symbol_table[j];

                    // Skip debug symbols and undefined symbols
                    if ((sym.n_type & N_STAB) || (sym.n_type & N_TYPE) == N_UNDF)
                    {
                        continue;
                    }

                    // Skip symbols without names
                    if (sym.n_un.n_strx == 0 || sym.n_un.n_strx >= symtab.strsize)
                    {
                        continue;
                    }

                    SymbolInfo symbol_info;
                    symbol_info.address = sym.n_value;
                    symbol_info.name = strdup(&string_table[sym.n_un.n_strx]);
                    symbol_info.size = 0;  // Size information not directly
                                           // available in Mach-O
                    symbol_info.type = strdup(get_symbol_type_string(sym.n_type));
                    symbol_info.scope = strdup(get_symbol_scope_string(sym.n_type));
                    symbol_info.module_base = base_address;
                    symbol_info.file_name = strdup("");  // File name not easily available
                    symbol_info.line_number = 0;         // Line number not available in
                                                         // symbol table

                    symbols.push_back(symbol_info);
                }
            }

            current_address += lc.cmdsize;
        }
    }

    return symbols;
}

SymbolInfo *enumerate_symbols(int pid, uintptr_t module_base, size_t *count)
{
    *count = 0;

    debug_log(LOG_INFO, "Enumerating symbols for module at base address 0x%lx in pid %d",
              module_base, pid);

    // First, determine if this is a 64-bit or 32-bit binary
    bool is_64bit = false;
    std::uint64_t module_size =
        get_module_size(pid, static_cast<mach_vm_address_t>(module_base), &is_64bit);

    if (module_size == 0)
    {
        debug_log(LOG_ERROR, "Failed to determine module size for base address 0x%lx", module_base);
        return nullptr;
    }

    debug_log(LOG_INFO, "Module is %s-bit, size: 0x%llx", is_64bit ? "64" : "32", module_size);

    // Parse symbols from the Mach-O image in memory
    std::vector<SymbolInfo> symbols =
        parse_macho_symbols_in_memory(pid, static_cast<mach_vm_address_t>(module_base), is_64bit);

    if (symbols.empty())
    {
        debug_log(LOG_WARN, "No symbols found in module at base address 0x%lx", module_base);
        return nullptr;
    }

    // Sort symbols by address
    std::sort(symbols.begin(), symbols.end(),
              [](const SymbolInfo &a, const SymbolInfo &b) { return a.address < b.address; });

    // Allocate C array for return
    SymbolInfo *result = static_cast<SymbolInfo *>(malloc(symbols.size() * sizeof(SymbolInfo)));
    if (!result)
    {
        debug_log(LOG_ERROR, "Failed to allocate memory for symbols array");
        // Free allocated strings
        for (auto &sym : symbols)
        {
            free(sym.name);
            free(sym.type);
            free(sym.scope);
            free(sym.file_name);
        }
        return nullptr;
    }

    // Copy symbols to C array
    for (size_t i = 0; i < symbols.size(); i++)
    {
        result[i] = symbols[i];
    }

    *count = symbols.size();
    debug_log(LOG_INFO, "Successfully enumerated %zu symbols from module at base address 0x%lx",
              *count, module_base);

    return result;
}

// Thread state names
static const char *get_thread_state_string(int state)
{
    switch (state)
    {
        case TH_STATE_RUNNING:
            return "Running";
        case TH_STATE_STOPPED:
            return "Stopped";
        case TH_STATE_WAITING:
            return "Waiting";
        case TH_STATE_UNINTERRUPTIBLE:
            return "Uninterruptible";
        case TH_STATE_HALTED:
            return "Halted";
        default:
            return "Unknown";
    }
}

ThreadInfo *enumerate_threads(pid_t pid, size_t *count)
{
    *count = 0;
    kern_return_t kr;

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        return nullptr;
    }

    thread_act_array_t thread_list;
    mach_msg_type_number_t thread_count;

    kr = task_threads(task, &thread_list, &thread_count);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_threads failed: %s", mach_error_string(kr));
        return nullptr;
    }

    if (thread_count == 0)
    {
        vm_deallocate(mach_task_self(), (vm_address_t)thread_list,
                      thread_count * sizeof(thread_act_t));
        return nullptr;
    }

    ThreadInfo *threads = static_cast<ThreadInfo *>(malloc(thread_count * sizeof(ThreadInfo)));
    if (!threads)
    {
        debug_log(LOG_ERROR, "Failed to allocate memory for thread info");
        for (mach_msg_type_number_t i = 0; i < thread_count; i++)
        {
            mach_port_deallocate(mach_task_self(), thread_list[i]);
        }
        vm_deallocate(mach_task_self(), (vm_address_t)thread_list,
                      thread_count * sizeof(thread_act_t));
        return nullptr;
    }

    for (mach_msg_type_number_t i = 0; i < thread_count; i++)
    {
        thread_act_t thread = thread_list[i];
        ThreadInfo *info = &threads[i];

        // Initialize
        info->thread_id = thread;
        info->name = nullptr;
        info->pc = 0;
        info->sp = 0;
        info->fp = 0;
        info->state = 0;
        info->suspend_count = 0;

        // Get thread basic info
        thread_basic_info_data_t basic_info;
        mach_msg_type_number_t info_count = THREAD_BASIC_INFO_COUNT;
        kr = thread_info(thread, THREAD_BASIC_INFO, (thread_info_t)&basic_info, &info_count);
        if (kr == KERN_SUCCESS)
        {
            info->state = basic_info.run_state;
            info->suspend_count = basic_info.suspend_count;
        }

        // Get thread identifier info (for thread name)
        thread_identifier_info_data_t id_info;
        info_count = THREAD_IDENTIFIER_INFO_COUNT;
        kr = thread_info(thread, THREAD_IDENTIFIER_INFO, (thread_info_t)&id_info, &info_count);
        if (kr == KERN_SUCCESS)
        {
            // Keep using mach_port_t for thread_id (needed for debugger
            // operations) info->thread_id = id_info.thread_id;  // Don't override
            // - keep mach_port_t

            // Try to get pthread name first
            char pthread_name[64] = {0};
            bool got_name = false;

            // Get the pthread handle from the thread port
            pthread_t pthread_handle = pthread_from_mach_thread_np(thread);
            if (pthread_handle != NULL)
            {
                if (pthread_getname_np(pthread_handle, pthread_name, sizeof(pthread_name)) == 0 &&
                    pthread_name[0] != '\0')
                {
                    info->name = strdup(pthread_name);
                    got_name = true;
                }
            }

            // If no pthread name, try dispatch queue name (only for embedded
            // mode) For remote processes, dispatch_queue is a remote address and
            // cannot be dereferenced
            if (!got_name && id_info.dispatch_qaddr != 0)
            {
                bool is_embedded_mode = pid == getpid();
                if (is_embedded_mode)
                {
                    // Only safe to read dispatch queue in embedded mode
                    void *dispatch_queue = *(void **)id_info.dispatch_qaddr;
                    if (dispatch_queue != nullptr)
                    {
                        const char *queue_label =
                            dispatch_queue_get_label((dispatch_queue_t)dispatch_queue);
                        if (queue_label != nullptr && queue_label[0] != '\0')
                        {
                            info->name = strdup(queue_label);
                            got_name = true;
                        }
                    }
                }
                // For remote processes, skip dispatch queue reading to avoid
                // segfault
            }

            // Fallback to thread ID (use mach_port_t for consistency with
            // thread_id field)
            if (!got_name)
            {
                char name_buf[128];
                snprintf(name_buf, sizeof(name_buf), "Thread %u", thread);
                info->name = strdup(name_buf);
            }
        }
        else
        {
            char name_buf[64];
            snprintf(name_buf, sizeof(name_buf), "Thread %u", thread);
            info->name = strdup(name_buf);
        }

#if defined(__arm64__) || defined(__aarch64__)
        // Get ARM64 thread state for PC/SP/FP
        arm_thread_state64_t arm_state;
        mach_msg_type_number_t state_count = ARM_THREAD_STATE64_COUNT;
        kr = thread_get_state(thread, ARM_THREAD_STATE64, (thread_state_t)&arm_state, &state_count);
        if (kr == KERN_SUCCESS)
        {
            info->fp = arm_state.__fp;
            info->sp = arm_state.__sp;
            info->pc = arm_state.__pc;
        }
#elif defined(__x86_64__)
        // Get x86_64 thread state for PC/SP/FP
        x86_thread_state64_t x86_state;
        mach_msg_type_number_t state_count = x86_THREAD_STATE64_COUNT;
        kr = thread_get_state(thread, x86_THREAD_STATE64, (thread_state_t)&x86_state, &state_count);
        if (kr == KERN_SUCCESS)
        {
            info->pc = x86_state.__rip;
            info->sp = x86_state.__rsp;
            info->fp = x86_state.__rbp;
        }
#endif

        mach_port_deallocate(mach_task_self(), thread);
    }

    vm_deallocate(mach_task_self(), (vm_address_t)thread_list, thread_count * sizeof(thread_act_t));

    *count = thread_count;
    debug_log(LOG_INFO, "Successfully enumerated %zu threads for pid %d", *count, pid);

    return threads;
}

void free_thread_info(ThreadInfo *threads, size_t count)
{
    if (threads)
    {
        for (size_t i = 0; i < count; i++)
        {
            if (threads[i].name)
            {
                free(threads[i].name);
            }
        }
        free(threads);
    }
}

// ==================== Compatibility functions for Rust native_bridge.rs ====================

extern "C" RegionInfo *enumerate_regions(pid_t pid, size_t *count)
{
    *count = 0;

    mach_port_t task = get_cached_task_port(pid);
    if (task == MACH_PORT_NULL)
    {
        debug_log(LOG_ERROR, "Failed to get task for pid %d", pid);
        return nullptr;
    }

    std::vector<RegionInfo> regions;
    vm_address_t address = 0;
    vm_size_t size = 0;
    natural_t depth = 1;
    char buf[PATH_MAX];

    while (true)
    {
        vm_region_submap_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_SUBMAP_INFO_COUNT_64;

        if (vm_region_recurse_64(task, &address, &size, &depth, (vm_region_info_t)&info,
                                 &info_count) != KERN_SUCCESS)
        {
            break;
        }

        if (info.is_submap)
        {
            depth++;
        }
        else
        {
            RegionInfo region;
            region.start = address;
            region.end = address + size;

            // Convert VM_PROT_* to PROT_* style (READ=1, WRITE=2, EXEC=4)
            region.protection = 0;
            if (info.protection & VM_PROT_READ) region.protection |= 1;
            if (info.protection & VM_PROT_WRITE) region.protection |= 2;
            if (info.protection & VM_PROT_EXECUTE) region.protection |= 4;

            // Get pathname
            memset(buf, 0, PATH_MAX);
            int ret = proc_regionfilename(pid, static_cast<unsigned long long>(address), buf,
                                          sizeof(buf));
            if (ret > 0 && buf[0] != '\0')
            {
                region.pathname = strdup(buf);
            }
            else
            {
                region.pathname = nullptr;
            }

            regions.push_back(region);
            address += size;
        }
    }

    if (regions.empty())
    {
        return nullptr;
    }

    RegionInfo *result = static_cast<RegionInfo *>(malloc(regions.size() * sizeof(RegionInfo)));
    if (!result)
    {
        debug_log(LOG_ERROR, "Failed to allocate memory for region info array");
        for (auto &r : regions)
        {
            if (r.pathname) free(r.pathname);
        }
        return nullptr;
    }

    for (size_t i = 0; i < regions.size(); i++)
    {
        result[i] = regions[i];
    }

    *count = regions.size();
    return result;
}

extern "C" void free_region_info(RegionInfo *regions, size_t count)
{
    if (regions)
    {
        for (size_t i = 0; i < count; i++)
        {
            if (regions[i].pathname)
            {
                free(regions[i].pathname);
            }
        }
        free(regions);
    }
}
