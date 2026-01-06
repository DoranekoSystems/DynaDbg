/**
 * @file native_api.cpp
 * @brief Core native API for Linux/Android debugger
 *
 * This file contains:
 * - Logging utilities
 * - Process/thread enumeration
 * - Memory region enumeration
 * - Process control (suspend/resume)
 * - Process spawning
 * - Initialization
 *
 * Memory I/O operations are in memory_io.cpp
 * ELF parsing is in elf_parser.cpp
 * PTY management is in pty_manager.cpp
 */

#include "native_api.h"

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../debugger/debugger.h"
#include "../elf/elf_parser.h"
#include "../pty/pty_manager.h"
#include "memory_io.h"

#ifdef TARGET_IS_ANDROID
#include <android/log.h>
#endif

// Helper macro to call native_log conditionally for dynamic library builds
// In dynamic mode, native_log() in callback_stubs.cpp handles the callback check
#define NATIVE_LOG(level, msg) native_log(level, msg)

// ============================================================================
// Logging
// ============================================================================

int debug_log(LogLevel level, const char* format, ...)
{
    va_list args;
    va_start(args, format);

    char tagged_format[1024];
    char buffer[1024];
    snprintf(tagged_format, sizeof(tagged_format), "[NATIVE] %s", format);
    vsnprintf(buffer, sizeof(buffer), tagged_format, args);

    NATIVE_LOG(level, buffer);

#ifdef TARGET_IS_ANDROID
    __android_log_vprint(ANDROID_LOG_DEBUG, "DYNADBG", tagged_format, args);
#endif

    va_end(args);
    return 0;
}

// ============================================================================
// Process utilities
// ============================================================================

pid_t get_pid_native()
{
    return getpid();
}

// ============================================================================
// Memory region enumeration
// ============================================================================

void enumerate_regions_to_buffer(pid_t pid, char* buffer, size_t buffer_size,
                                 bool include_filenames)
{
    char maps_file_path[64];
    snprintf(maps_file_path, sizeof(maps_file_path), "/proc/%d/maps", pid);

    int fd = open(maps_file_path, O_RDONLY);
    if (fd < 0)
    {
        debug_log(LOG_ERROR, "Failed to open file: %s, error: %s\n", maps_file_path,
                  strerror(errno));
        snprintf(buffer, buffer_size, "Failed to open file: %s", maps_file_path);
        return;
    }

    size_t total_bytes_read = 0;
    ssize_t bytes_read;

    while (total_bytes_read < buffer_size - 1)
    {
        bytes_read = read(fd, buffer + total_bytes_read, buffer_size - 1 - total_bytes_read);

        if (bytes_read < 0)
        {
            if (errno == EINTR) continue;
            debug_log(LOG_ERROR, "Failed to read file: %s, error: %s\n", maps_file_path,
                      strerror(errno));
            snprintf(buffer, buffer_size, "Failed to read file: %s", maps_file_path);
            close(fd);
            return;
        }

        if (bytes_read == 0) break;

        total_bytes_read += bytes_read;
    }

    close(fd);

    if (total_bytes_read >= buffer_size - 1)
    {
        debug_log(
            LOG_WARN,
            "Buffer size %zu may not be enough to store all regions for pid %d (read %zu bytes)\n",
            buffer_size, pid, total_bytes_read);
    }

    buffer[total_bytes_read] = '\0';
}

// ============================================================================
// Process enumeration
// ============================================================================

ProcessInfo* enumerate_processes(size_t* count)
{
    DIR* proc_dir = opendir("/proc");
    if (!proc_dir)
    {
        debug_log(LOG_ERROR, "Failed to open /proc directory\n");
        return nullptr;
    }

    ProcessInfo* processes = nullptr;
    *count = 0;

    struct dirent* entry;
    while ((entry = readdir(proc_dir)) != nullptr)
    {
        int pid = atoi(entry->d_name);
        if (pid > 0)
        {
            std::string processname;

            // Try /proc/%d/cmdline first
            char cmdline_path[256];
            snprintf(cmdline_path, sizeof(cmdline_path), "/proc/%d/cmdline", pid);

            std::ifstream cmdline_file(cmdline_path, std::ios::binary);
            if (cmdline_file.is_open())
            {
                std::string cmdline;
                std::getline(cmdline_file, cmdline, '\0');
                cmdline_file.close();

                if (!cmdline.empty())
                {
                    size_t last_slash = cmdline.find_last_of('/');
                    if (last_slash != std::string::npos)
                    {
                        processname = cmdline.substr(last_slash + 1);
                    }
                    else
                    {
                        processname = cmdline;
                    }
                }
            }

            // Fallback to /proc/%d/comm
            if (processname.empty())
            {
                char comm_path[256];
                snprintf(comm_path, sizeof(comm_path), "/proc/%d/comm", pid);

                std::ifstream comm_file(comm_path);
                if (comm_file.is_open())
                {
                    std::getline(comm_file, processname);
                    comm_file.close();
                }
            }

            if (!processname.empty())
            {
                ProcessInfo process;
                process.pid = pid;

                size_t len = processname.length();
                process.processname = static_cast<char*>(malloc(len + 1));
                if (!process.processname)
                {
                    debug_log(LOG_ERROR, "Failed to allocate memory for process name (pid: %d)\n",
                              pid);
                    continue;
                }
                memcpy(process.processname, processname.c_str(), len);
                process.processname[len] = '\0';

                ProcessInfo* new_processes = static_cast<ProcessInfo*>(
                    realloc(processes, (*count + 1) * sizeof(ProcessInfo)));
                if (!new_processes)
                {
                    debug_log(LOG_ERROR, "Failed to reallocate memory for processes array\n");
                    free(process.processname);
                    break;
                }
                processes = new_processes;
                processes[*count] = process;
                (*count)++;
            }
            else
            {
                debug_log(LOG_WARN, "Failed to get process name for pid %d\n", pid);
            }
        }
    }

    closedir(proc_dir);
    return processes;
}

// ============================================================================
// Process control
// ============================================================================

bool suspend_process(pid_t pid)
{
    if (g_debugger != nullptr)
    {
        g_debugger->set_user_suspend_pending(true);
    }

    if (kill(pid, SIGSTOP) == -1)
    {
        debug_log(LOG_ERROR, "Failed to suspend process %d. Error: %d (%s)\n", pid, errno,
                  strerror(errno));
        if (g_debugger != nullptr)
        {
            g_debugger->set_user_suspend_pending(false);
        }
        return false;
    }
    return true;
}

bool resume_process(pid_t pid)
{
    if (g_debugger != nullptr)
    {
        g_debugger->set_user_suspend_pending(false);

        int result = g_debugger->resume_all_user_stopped_threads();
        if (result < 0)
        {
            debug_log(LOG_ERROR, "Failed to resume user-stopped threads\n");
            return false;
        }
        debug_log(LOG_INFO, "Resumed %d user-stopped threads\n", result);
        return true;
    }

    if (kill(pid, SIGCONT) == -1)
    {
        debug_log(LOG_ERROR, "Failed to resume process %d. Error: %d (%s)\n", pid, errno,
                  strerror(errno));
        return false;
    }
    return true;
}

// ============================================================================
// Module utilities
// ============================================================================

std::string get_module_path(int pid, uintptr_t module_base)
{
    char maps_path[256];
    snprintf(maps_path, sizeof(maps_path), "/proc/%d/maps", pid);

    std::ifstream maps_file(maps_path);
    if (!maps_file.is_open())
    {
        debug_log(LOG_ERROR, "Failed to open maps file for pid %d", pid);
        return "";
    }

    std::string line;
    while (std::getline(maps_file, line))
    {
        std::istringstream iss(line);
        std::string addr_range, perms, offset, dev, inode, pathname;

        if (!(iss >> addr_range >> perms >> offset >> dev >> inode))
        {
            continue;
        }

        size_t dash_pos = addr_range.find('-');
        if (dash_pos == std::string::npos) continue;

        uintptr_t start_addr = std::stoull(addr_range.substr(0, dash_pos), nullptr, 16);

        if (start_addr == module_base)
        {
            std::getline(iss, pathname);
            pathname.erase(0, pathname.find_first_not_of(" \t"));
            if (!pathname.empty() && pathname[0] == '/')
            {
                return pathname;
            }
        }
    }

    return "";
}

// ============================================================================
// Thread enumeration
// ============================================================================

enum ThreadState
{
    THREAD_STATE_RUNNING = 0,
    THREAD_STATE_SLEEPING = 1,
    THREAD_STATE_DISK_SLEEP = 2,
    THREAD_STATE_STOPPED = 3,
    THREAD_STATE_ZOMBIE = 4,
    THREAD_STATE_DEAD = 5,
    THREAD_STATE_UNKNOWN = 6
};

static int parse_thread_state(char state_char)
{
    switch (state_char)
    {
        case 'R':
            return THREAD_STATE_RUNNING;
        case 'S':
            return THREAD_STATE_SLEEPING;
        case 'D':
            return THREAD_STATE_DISK_SLEEP;
        case 'T':
        case 't':
            return THREAD_STATE_STOPPED;
        case 'Z':
            return THREAD_STATE_ZOMBIE;
        case 'X':
        case 'x':
            return THREAD_STATE_DEAD;
        default:
            return THREAD_STATE_UNKNOWN;
    }
}

ThreadInfo* enumerate_threads(pid_t pid, size_t* count)
{
    *count = 0;

    char task_path[64];
    snprintf(task_path, sizeof(task_path), "/proc/%d/task", pid);

    DIR* task_dir = opendir(task_path);
    if (!task_dir)
    {
        debug_log(LOG_ERROR, "Failed to open task directory: %s, error: %s", task_path,
                  strerror(errno));
        return nullptr;
    }

    std::vector<ThreadInfo> threads;
    struct dirent* entry;

    while ((entry = readdir(task_dir)) != nullptr)
    {
        int tid = atoi(entry->d_name);
        if (tid <= 0) continue;

        ThreadInfo info;
        memset(&info, 0, sizeof(ThreadInfo));
        info.thread_id = tid;
        info.name = nullptr;
        info.pc = 0;
        info.sp = 0;
        info.fp = 0;
        info.state = THREAD_STATE_UNKNOWN;
        info.suspend_count = 0;

        // Read thread name
        char comm_path[128];
        snprintf(comm_path, sizeof(comm_path), "/proc/%d/task/%d/comm", pid, tid);
        std::ifstream comm_file(comm_path);
        if (comm_file.is_open())
        {
            std::string name;
            std::getline(comm_file, name);
            if (!name.empty())
            {
                info.name = strdup(name.c_str());
            }
            comm_file.close();
        }

        if (!info.name)
        {
            char name_buf[64];
            snprintf(name_buf, sizeof(name_buf), "Thread %d", tid);
            info.name = strdup(name_buf);
        }

        // Read thread state
        char stat_path[128];
        snprintf(stat_path, sizeof(stat_path), "/proc/%d/task/%d/stat", pid, tid);
        std::ifstream stat_file(stat_path);
        if (stat_file.is_open())
        {
            std::string stat_line;
            std::getline(stat_file, stat_line);
            stat_file.close();

            size_t comm_end = stat_line.rfind(')');
            if (comm_end != std::string::npos && comm_end + 2 < stat_line.size())
            {
                char state_char = stat_line[comm_end + 2];
                info.state = parse_thread_state(state_char);

                if (state_char == 'T' || state_char == 't')
                {
                    info.suspend_count = 1;
                }
            }
        }

        threads.push_back(info);
    }

    closedir(task_dir);

    if (threads.empty())
    {
        debug_log(LOG_WARN, "No threads found for pid %d", pid);
        return nullptr;
    }

    ThreadInfo* result = static_cast<ThreadInfo*>(malloc(threads.size() * sizeof(ThreadInfo)));
    if (!result)
    {
        debug_log(LOG_ERROR, "Failed to allocate memory for thread info array");
        for (auto& t : threads)
        {
            if (t.name) free(t.name);
        }
        return nullptr;
    }

    for (size_t i = 0; i < threads.size(); i++)
    {
        result[i] = threads[i];
    }

    *count = threads.size();
    debug_log(LOG_INFO, "Successfully enumerated %zu threads for pid %d", *count, pid);

    return result;
}

void free_thread_info(ThreadInfo* threads, size_t count)
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

// ============================================================================
// Memory region enumeration (structured)
// ============================================================================

static uint32_t parse_protection(const char* perms)
{
    uint32_t prot = 0;
    if (perms[0] == 'r') prot |= 1;  // PROT_READ
    if (perms[1] == 'w') prot |= 2;  // PROT_WRITE
    if (perms[2] == 'x') prot |= 4;  // PROT_EXEC
    return prot;
}

RegionInfo* enumerate_regions(pid_t pid, size_t* count)
{
    *count = 0;

    char maps_path[64];
    snprintf(maps_path, sizeof(maps_path), "/proc/%d/maps", pid);

    std::ifstream maps_file(maps_path);
    if (!maps_file.is_open())
    {
        debug_log(LOG_ERROR, "Failed to open maps file: %s", maps_path);
        return nullptr;
    }

    std::vector<RegionInfo> regions;
    std::string line;

    while (std::getline(maps_file, line))
    {
        std::istringstream iss(line);
        std::string addr_range, perms, offset, dev, inode, pathname;

        if (!(iss >> addr_range >> perms >> offset >> dev >> inode))
        {
            continue;
        }

        // Parse pathname (may contain spaces)
        std::getline(iss, pathname);
        // Trim leading whitespace
        size_t start = pathname.find_first_not_of(" \t");
        if (start != std::string::npos)
        {
            pathname = pathname.substr(start);
        }
        else
        {
            pathname.clear();
        }

        // Parse address range
        size_t dash_pos = addr_range.find('-');
        if (dash_pos == std::string::npos) continue;

        RegionInfo region;
        region.start = std::stoull(addr_range.substr(0, dash_pos), nullptr, 16);
        region.end = std::stoull(addr_range.substr(dash_pos + 1), nullptr, 16);
        region.protection = parse_protection(perms.c_str());

        if (!pathname.empty())
        {
            region.pathname = strdup(pathname.c_str());
        }
        else
        {
            region.pathname = nullptr;
        }

        regions.push_back(region);
    }

    if (regions.empty())
    {
        return nullptr;
    }

    RegionInfo* result = static_cast<RegionInfo*>(malloc(regions.size() * sizeof(RegionInfo)));
    if (!result)
    {
        debug_log(LOG_ERROR, "Failed to allocate memory for region info array");
        for (auto& r : regions)
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

void free_region_info(RegionInfo* regions, size_t count)
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

// ============================================================================
// Module enumeration (moved from elf_parser.cpp)
// ============================================================================

// Structure to hold parsed maps entry for module enumeration
struct MapsEntryForModule
{
    uintptr_t start;
    uintptr_t end;
    char perms[5];
    unsigned long offset;
    char module_path[PATH_MAX];
};

ModuleInfo* enumerate_modules(pid_t pid, size_t* count)
{
    std::vector<ModuleInfo> modules;
    std::vector<MapsEntryForModule> maps_entries;
    std::ostringstream maps_path;
    maps_path << "/proc/" << pid << "/maps";

    std::ifstream maps_file(maps_path.str());
    if (!maps_file.is_open())
    {
        *count = 0;
        return nullptr;
    }

    // First pass: read all maps entries
    std::string line;
    while (std::getline(maps_file, line))
    {
        std::istringstream iss(line);
        MapsEntryForModule entry;
        char dev[6];
        unsigned long long inode;

        iss >> std::hex >> entry.start;
        iss.ignore(1, '-');
        iss >> std::hex >> entry.end;
        iss >> entry.perms;
        iss >> std::hex >> entry.offset;
        iss >> dev >> std::dec >> inode;
        iss >> entry.module_path;

        if (strlen(entry.module_path) > 0)
        {
            maps_entries.push_back(entry);
        }
    }
    maps_file.close();

    // Second pass: find modules (requires ELF validation)
    for (size_t entry_idx = 0; entry_idx < maps_entries.size(); entry_idx++)
    {
        const auto& entry = maps_entries[entry_idx];

        if (entry.perms[0] != 'r') continue;

        // Use ELF parser helpers
        if (!is_elf(entry.module_path)) continue;
        if (!compare_elf_headers(pid, entry.start, entry.module_path)) continue;

        uintptr_t text_offset = get_text_section_offset(entry.module_path);
        if (text_offset == 0)
        {
            debug_log(LOG_WARN, "No .text section found in file: %s\n", entry.module_path);
            continue;
        }

        uintptr_t text_mem_address = entry.start + text_offset;

        bool text_executable = false;
        for (size_t check_idx = entry_idx; check_idx < maps_entries.size(); check_idx++)
        {
            const auto& check_entry = maps_entries[check_idx];

            if (check_entry.start > text_mem_address) break;

            if (text_mem_address >= check_entry.start && text_mem_address < check_entry.end)
            {
                if (check_entry.perms[2] == 'x')
                {
                    text_executable = true;
                    break;
                }
            }
        }

        if (!text_executable) continue;

        uintptr_t module_end = entry.end;
        for (size_t scan_idx = entry_idx + 1; scan_idx < maps_entries.size(); scan_idx++)
        {
            const auto& scan_entry = maps_entries[scan_idx];
            if (strcmp(scan_entry.module_path, entry.module_path) == 0)
            {
                const uintptr_t MAX_GAP = 0x100000;  // 1MB
                if (scan_entry.start > module_end + MAX_GAP)
                {
                    break;
                }
                module_end = scan_entry.end;
            }
            else
            {
                break;
            }
        }

        ModuleInfo info;
        info.base = entry.start;
        info.size = module_end - entry.start;
        info.is_64bit = is_elf64(entry.module_path);

        size_t nameLength = strlen(entry.module_path) + 1;
        info.modulename = new char[nameLength];
        strcpy(info.modulename, entry.module_path);

        modules.push_back(info);
    }

    *count = modules.size();
    if (*count == 0)
    {
        return nullptr;
    }

    ModuleInfo* result = new ModuleInfo[*count];
    std::copy(modules.begin(), modules.end(), result);

    return result;
}

// ============================================================================
// Process spawning
// ============================================================================

int spawn_process_native(const char* executable_path, const char** args, int argc, pid_t* out_pid)
{
    debug_log(LOG_INFO, "Spawning process: %s with %d args", executable_path, argc);

    if (g_debugger != nullptr)
    {
        debug_log(LOG_INFO, "Destroying existing debugger before spawn");
        delete g_debugger;
        g_debugger = nullptr;
    }

    g_debugger = new Debugger();
    if (!g_debugger->initialize())
    {
        debug_log(LOG_ERROR, "Failed to initialize debugger");
        delete g_debugger;
        g_debugger = nullptr;
        return -1;
    }

    g_debugger->run();

    std::vector<std::string> spawn_args;
    for (int i = 0; i < argc; i++)
    {
        spawn_args.push_back(args[i]);
    }

    pid_t pid = 0;
    int result = g_debugger->spawn_process(executable_path, spawn_args, &pid);

    if (result == 0 && out_pid != nullptr)
    {
        *out_pid = pid;
        debug_log(LOG_INFO, "Spawn successful: pid=%d", pid);
    }
    else if (result != 0)
    {
        debug_log(LOG_ERROR, "Spawn failed");
        delete g_debugger;
        g_debugger = nullptr;
    }

    return result;
}

// ============================================================================
// Initialization
// ============================================================================

int native_init(int mode)
{
#ifdef TARGET_IS_ANDROID
    void* handle = dlopen("libc.so", RTLD_NOW);
    if (!handle)
    {
        debug_log(LOG_ERROR, "Failed to open libc.so. Error: %s\n", dlerror());
        return -1;
    }

    // Note: process_vm_readv/writev are now initialized in memory_io.cpp
    dlclose(handle);
#endif
    return 1;
}

// ============================================================================
// Trace file stubs (Not implemented for Linux/Android)
// ============================================================================

extern "C" void enable_trace_file_output_native(const char* filepath)
{
    (void)filepath;
    // Not implemented for this platform
}

extern "C" void disable_trace_file_output_native()
{
    // Not implemented for this platform
}

extern "C" bool is_trace_file_output_enabled_native()
{
    // Not implemented for this platform
    return false;
}

extern "C" const char* get_trace_file_path_native()
{
    // Not implemented for this platform
    return "";
}

extern "C" uint32_t get_trace_file_entry_count_native()
{
    debug_log(LOG_WARN, "get_trace_file_entry_count_native: Not implemented for this platform");
    return 0;
}

extern "C" bool is_trace_ended_by_end_address_native()
{
    debug_log(LOG_WARN, "is_trace_ended_by_end_address_native: Not implemented for this platform");
    return false;
}

extern "C" void enable_full_memory_cache_native(const char* dump_filepath, const char* log_filepath)
{
    (void)dump_filepath;
    (void)log_filepath;
    debug_log(LOG_WARN, "enable_full_memory_cache_native: Not implemented for this platform");
}

extern "C" void disable_full_memory_cache_native()
{
    debug_log(LOG_WARN, "disable_full_memory_cache_native: Not implemented for this platform");
}
