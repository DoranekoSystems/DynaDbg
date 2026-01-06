/**
 * @file memory_io.cpp
 * @brief Memory read/write operations for process memory access
 */

#include "memory_io.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>

#include "native_api.h"  // For debug_log, get_pid_native (same folder)

#ifdef TARGET_IS_ANDROID
#include <dlfcn.h>
typedef ssize_t (*process_vm_readv_func)(pid_t, const struct iovec*, unsigned long,
                                         const struct iovec*, unsigned long, unsigned long);
typedef ssize_t (*process_vm_writev_func)(pid_t, const struct iovec*, unsigned long,
                                          const struct iovec*, unsigned long, unsigned long);
static process_vm_readv_func g_process_vm_readv = nullptr;
static process_vm_writev_func g_process_vm_writev = nullptr;

static bool init_android_memory_funcs()
{
    if (g_process_vm_readv && g_process_vm_writev) return true;

    void* handle = dlopen("libc.so", RTLD_NOW);
    if (!handle) return false;

    g_process_vm_readv = (process_vm_readv_func)dlsym(handle, "process_vm_readv");
    g_process_vm_writev = (process_vm_writev_func)dlsym(handle, "process_vm_writev");
    dlclose(handle);

    return (g_process_vm_readv && g_process_vm_writev);
}
#endif

// External declarations for debugger integration
extern "C" bool is_debugger_attached_native();
extern "C" ssize_t read_memory_debugger_native(uint64_t address, size_t size,
                                               unsigned char* buffer);

ssize_t read_memory_native(int pid, uintptr_t address, size_t size, unsigned char* buffer)
{
    return read_memory_native_with_method(pid, address, size, buffer, 0);
}

ssize_t read_memory_proc_mem(int pid, uintptr_t address, size_t size, unsigned char* buffer)
{
    char mem_path[64];
    snprintf(mem_path, sizeof(mem_path), "/proc/%d/mem", pid);

    int fd = open(mem_path, O_RDONLY);
    if (fd < 0)
    {
        debug_log(LOG_ERROR, "Failed to open %s: %d (%s)\n", mem_path, errno, strerror(errno));
        return -errno;
    }

    // Seek to the target address
    if (lseek64(fd, static_cast<off64_t>(address), SEEK_SET) == -1)
    {
        debug_log(LOG_ERROR, "Failed to seek to 0x%lx in %s: %d (%s)\n", address, mem_path, errno,
                  strerror(errno));
        close(fd);
        return -errno;
    }

    // Read the memory
    ssize_t bytes_read = read(fd, buffer, size);
    close(fd);

    if (bytes_read < 0)
    {
        return -errno;
    }

    return bytes_read;
}

ssize_t read_memory_native_with_method(int pid, uintptr_t address, size_t size,
                                       unsigned char* buffer, int mode)
{
    switch (mode)
    {
        case 0:  // process_vm_readv (default, fastest)
            return read_memory_vm_readv(pid, address, size, buffer);

        case 1:  // /proc/pid/mem (no thread stop needed)
            return read_memory_proc_mem(pid, address, size, buffer);

        case 2:  // ptrace PEEKDATA (requires attach or debugger)
            return read_memory_ptrace(pid, address, size, buffer);

        default:
            return read_memory_vm_readv(pid, address, size, buffer);
    }
}

ssize_t read_memory_vm_readv(int pid, uintptr_t address, size_t size, unsigned char* buffer)
{
    struct iovec local_iov;
    struct iovec remote_iov;

    local_iov.iov_base = buffer;
    local_iov.iov_len = size;
    remote_iov.iov_base = reinterpret_cast<void*>(address);
    remote_iov.iov_len = size;

#ifdef TARGET_IS_ANDROID
    if (!init_android_memory_funcs()) return -ENOSYS;
    ssize_t nread = g_process_vm_readv(pid, &local_iov, 1, &remote_iov, 1, 0);
#else
    ssize_t nread = process_vm_readv(pid, &local_iov, 1, &remote_iov, 1, 0);
#endif

    if (nread < 0)
    {
        return -errno;
    }

    if (static_cast<size_t>(nread) < size)
    {
        debug_log(LOG_WARN, "Partial read from process %d. Requested %zu bytes, read %zd bytes\n",
                  pid, size, nread);
    }

    return nread;
}

ssize_t read_memory_ptrace(int pid, uintptr_t address, size_t size, unsigned char* buffer)
{
    debug_log(LOG_DEBUG, "Using ptrace to read memory from process %d at address 0x%lx, size %zu\n",
              pid, address, size);

    // Check if process is still alive
    if (kill(pid, 0) != 0)
    {
        debug_log(LOG_ERROR, "Process %d is not accessible or has exited: %d (%s)\n", pid, errno,
                  strerror(errno));
        return -ESRCH;
    }

    // Check if debugger is already attached (debug mode)
    if (is_debugger_attached_native())
    {
        debug_log(LOG_DEBUG, "Debugger attached, using debugger queue for memory read\n");
        return read_memory_debugger_native(static_cast<uint64_t>(address), size, buffer);
    }

    // Non-debug mode: attach, read, detach
    if (ptrace(PTRACE_ATTACH, pid, nullptr, nullptr) == -1)
    {
        if (errno != EPERM && errno != ESRCH)
        {
            debug_log(LOG_ERROR, "Failed to attach to process %d: %d (%s)\n", pid, errno,
                      strerror(errno));
            return -errno;
        }
        debug_log(LOG_WARN, "Attach returned %d (%s), continuing anyway\n", errno, strerror(errno));
    }

    // Wait for process to stop (with timeout)
    int status;
    struct timespec timeout = {1, 0};  // 1 second timeout
    sigset_t mask, orig_mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);

    if (sigprocmask(SIG_BLOCK, &mask, &orig_mask) == -1)
    {
        debug_log(LOG_WARN, "Failed to block SIGCHLD: %d (%s)\n", errno, strerror(errno));
    }

    pid_t wait_result = waitpid(pid, &status, WNOHANG);
    if (wait_result == 0)
    {
#ifdef TARGET_IS_ANDROID
        // Android doesn't have sigtimedwait, use poll-based approach
        for (int i = 0; i < 100; i++)
        {
            usleep(10000);  // 10ms
            wait_result = waitpid(pid, &status, WNOHANG);
            if (wait_result != 0) break;
        }
        if (wait_result == 0)
        {
            debug_log(LOG_WARN, "Timeout waiting for process %d to stop\n", pid);
        }
#else
        if (sigtimedwait(&mask, nullptr, &timeout) == -1)
        {
            if (errno == EAGAIN)
            {
                debug_log(LOG_WARN, "Timeout waiting for process %d to stop\n", pid);
            }
            else
            {
                debug_log(LOG_WARN, "Error waiting for process %d: %d (%s)\n", pid, errno,
                          strerror(errno));
            }
        }
        wait_result = waitpid(pid, &status, WNOHANG);
#endif
    }

    sigprocmask(SIG_SETMASK, &orig_mask, nullptr);

    if (wait_result == -1)
    {
        debug_log(LOG_ERROR, "Failed to wait for process %d: %d (%s)\n", pid, errno,
                  strerror(errno));
        ptrace(PTRACE_DETACH, pid, nullptr, nullptr);
        return -errno;
    }

    size_t bytes_read = 0;
    size_t word_size = sizeof(long);
    int consecutive_failures = 0;
    const int max_consecutive_failures = 3;

    while (bytes_read < size && consecutive_failures < max_consecutive_failures)
    {
        uintptr_t aligned_addr = (address + bytes_read) & ~(word_size - 1);
        size_t offset = (address + bytes_read) - aligned_addr;

        errno = 0;
        long word = ptrace(PTRACE_PEEKDATA, pid, reinterpret_cast<void*>(aligned_addr), nullptr);

        if (errno != 0)
        {
            consecutive_failures++;

            if (errno == EIO || errno == EFAULT)
            {
                size_t skip_bytes = word_size - offset;
                if (bytes_read + skip_bytes >= size) break;
                bytes_read += skip_bytes;
                continue;
            }
            else if (errno == ESRCH)
            {
                debug_log(LOG_ERROR, "Process %d no longer exists\n", pid);
                break;
            }
            else
            {
                bytes_read += 1;
                continue;
            }
        }

        consecutive_failures = 0;

        size_t bytes_to_copy = std::min(size - bytes_read, word_size - offset);
        unsigned char* word_bytes = reinterpret_cast<unsigned char*>(&word);

        memcpy(buffer + bytes_read, word_bytes + offset, bytes_to_copy);
        bytes_read += bytes_to_copy;
    }

    if (ptrace(PTRACE_DETACH, pid, nullptr, nullptr) == -1)
    {
        debug_log(LOG_WARN, "Failed to detach from process %d: %d (%s)\n", pid, errno,
                  strerror(errno));
    }

    if (bytes_read < size)
    {
        debug_log(
            LOG_WARN,
            "Partial read from process %d using ptrace. Requested %zu bytes, read %zu bytes\n", pid,
            size, bytes_read);
    }

    if (bytes_read == 0)
    {
        return -EIO;
    }

    return bytes_read;
}

ssize_t write_memory_native(int pid, void* address, size_t size, unsigned char* buffer)
{
    if (pid == get_pid_native())
    {
        // Writing to own process
        uintptr_t start = reinterpret_cast<uintptr_t>(address);
        uintptr_t end = start + size;
        uintptr_t page_size = getpagesize();
        uintptr_t page_start = start & ~(page_size - 1);
        uintptr_t page_end = (end + page_size - 1) & ~(page_size - 1);
        size_t protected_size = page_end - page_start;

        int result = mprotect(reinterpret_cast<void*>(page_start), protected_size,
                              PROT_READ | PROT_WRITE | PROT_EXEC);
        if (result != 0)
        {
            debug_log(LOG_ERROR, "mprotect failed with error %d (%s)\n", errno, strerror(errno));
            return -1;
        }

        iovec local_iov = {buffer, size};
        iovec remote_iov = {address, size};

#ifdef TARGET_IS_ANDROID
        if (!init_android_memory_funcs()) return -1;
        ssize_t written = g_process_vm_writev(pid, &local_iov, 1, &remote_iov, 1, 0);
#else
        ssize_t written = process_vm_writev(pid, &local_iov, 1, &remote_iov, 1, 0);
#endif
        if (written == -1)
        {
            debug_log(LOG_ERROR, "process_vm_writev failed with error %d (%s)\n", errno,
                      strerror(errno));
            return -1;
        }

        debug_log(LOG_DEBUG, "Successfully wrote %zd bytes to own process memory\n", written);
        return written;
    }
    else
    {
        // Writing to another process
        if (ptrace(PTRACE_ATTACH, pid, NULL, NULL) == -1)
        {
            debug_log(LOG_ERROR, "Failed to attach to process %d. Error: %d (%s)\n", pid, errno,
                      strerror(errno));
            return -1;
        }
        waitpid(pid, NULL, 0);

        ssize_t total_written = 0;
        for (size_t i = 0; i < size; i += sizeof(long))
        {
            if (size - i < sizeof(long))
            {
                errno = 0;
                long orig =
                    ptrace(PTRACE_PEEKDATA, pid, reinterpret_cast<char*>(address) + i, NULL);
                if (errno != 0)
                {
                    debug_log(LOG_ERROR, "ptrace PEEKDATA failed at offset %zu. Error: %d (%s)\n",
                              i, errno, strerror(errno));
                    ptrace(PTRACE_DETACH, pid, NULL, NULL);
                    return -1;
                }

                std::memcpy(&orig, reinterpret_cast<char*>(buffer) + i, size - i);

                if (ptrace(PTRACE_POKEDATA, pid, reinterpret_cast<char*>(address) + i, orig) == -1)
                {
                    debug_log(LOG_ERROR, "ptrace POKEDATA failed at offset %zu. Error: %d (%s)\n",
                              i, errno, strerror(errno));
                    ptrace(PTRACE_DETACH, pid, NULL, NULL);
                    return -1;
                }
                total_written += size - i;
            }
            else
            {
                long data;
                std::memcpy(&data, reinterpret_cast<char*>(buffer) + i, sizeof(long));
                if (ptrace(PTRACE_POKEDATA, pid, reinterpret_cast<char*>(address) + i, data) == -1)
                {
                    debug_log(LOG_ERROR, "ptrace POKEDATA failed at offset %zu. Error: %d (%s)\n",
                              i, errno, strerror(errno));
                    ptrace(PTRACE_DETACH, pid, NULL, NULL);
                    return -1;
                }
                total_written += sizeof(long);
            }
        }

        if (ptrace(PTRACE_DETACH, pid, NULL, NULL) == -1)
        {
            debug_log(LOG_WARN, "Failed to detach from process %d. Error: %d (%s)\n", pid, errno,
                      strerror(errno));
        }

        return total_written;
    }
}
