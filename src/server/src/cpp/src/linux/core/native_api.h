/**
 * @file native_api.h
 * @brief Core native API definitions for Linux/Android debugger
 *
 * This header provides the main API interface for:
 * - Logging utilities
 * - Process/thread enumeration
 * - Memory operations (via memory_io.h)
 * - ELF parsing (via elf_parser.h)
 * - PTY management (via pty_manager.h)
 */

#ifndef NATIVEAPI_H
#define NATIVEAPI_H

#include <sys/types.h>
#include <unistd.h>

#include <cstdarg>
#include <cstddef>
#include <cstdint>

// ============================================================================
// Log levels
// ============================================================================

enum LogLevel
{
    LOG_ERROR = 1,
    LOG_WARN = 2,
    LOG_INFO = 3,
    LOG_DEBUG = 4,
    LOG_TRACE = 5
};

// ============================================================================
// Exception types
// ============================================================================

enum ExceptionType
{
    EXCEPTION_UNKNOWN = 0,
    EXCEPTION_BREAKPOINT = 1,
    EXCEPTION_WATCHPOINT = 2,
    EXCEPTION_SINGLESTEP = 3,
    EXCEPTION_SIGNAL = 4,
    EXCEPTION_SIGSEGV = 5,
    EXCEPTION_SIGBUS = 6,
    EXCEPTION_SIGFPE = 7,
    EXCEPTION_SIGILL = 8,
    EXCEPTION_SIGABRT = 9,
    EXCEPTION_SIGTRAP = 10,
};

// ============================================================================
// Data structures
// ============================================================================

typedef struct
{
    int pid;
    char* processname;
} ProcessInfo;

typedef struct
{
    uintptr_t base;
    size_t size;
    bool is_64bit;
    char* modulename;
} ModuleInfo;

typedef struct
{
    uintptr_t address;
    char* name;
    size_t size;
    char* type;
    char* scope;
    uintptr_t module_base;
    char* file_name;
    int line_number;
} SymbolInfo;

typedef struct
{
    uint64_t thread_id;
    char* name;
    uint64_t pc;
    uint64_t sp;
    uint64_t fp;
    int state;
    int suspend_count;
} ThreadInfo;

/**
 * Memory region information structure
 * Used for structured region enumeration
 */
typedef struct
{
    uintptr_t start;
    uintptr_t end;
    uint32_t protection;  // PROT_READ=1, PROT_WRITE=2, PROT_EXEC=4
    char* pathname;
} RegionInfo;

#include <string>

#include "../../common/exception_info.h"

// ============================================================================
// Logging API
// ============================================================================

extern "C" void native_log(int level, const char* message);
extern "C" bool send_exception_info(const NativeExceptionInfo* info, pid_t pid);

int debug_log(LogLevel level, const char* format, ...);

// ============================================================================
// Process enumeration
// ============================================================================

extern "C" pid_t get_pid_native();
extern "C" ProcessInfo* enumerate_processes(size_t* count);
extern "C" bool suspend_process(pid_t pid);
extern "C" bool resume_process(pid_t pid);

// ============================================================================
// Module utilities
// ============================================================================

/**
 * Get module path from process maps
 * @param pid Process ID
 * @param module_base Base address of the module
 * @return Module file path, or empty string if not found
 */
std::string get_module_path(int pid, uintptr_t module_base);

// ============================================================================
// Memory region enumeration
// ============================================================================

// Preferred API: Returns structured array
extern "C" RegionInfo* enumerate_regions(pid_t pid, size_t* count);
extern "C" void free_region_info(RegionInfo* regions, size_t count);

// Legacy API: Returns raw /proc/pid/maps content to buffer (for backward compatibility)
extern "C" void enumerate_regions_to_buffer(pid_t pid, char* buffer, size_t buffer_size,
                                            bool include_filenames);

// ============================================================================
// Thread enumeration
// ============================================================================

extern "C" ThreadInfo* enumerate_threads(pid_t pid, size_t* count);
extern "C" void free_thread_info(ThreadInfo* threads, size_t count);

// ============================================================================
// Initialization
// ============================================================================

extern "C" int native_init(int mode);

// ============================================================================
// Process spawning
// ============================================================================

extern "C" int spawn_process_native(const char* executable_path, const char** args, int argc,
                                    pid_t* out_pid);

// ============================================================================
// Memory I/O (implemented in memory_io.cpp)
// ============================================================================

extern "C" ssize_t read_memory_native(int pid, uintptr_t address, size_t size,
                                      unsigned char* buffer);
extern "C" ssize_t read_memory_native_with_method(int pid, uintptr_t address, size_t size,
                                                  unsigned char* buffer, int mode);
ssize_t read_memory_vm_readv(int pid, uintptr_t address, size_t size, unsigned char* buffer);
ssize_t read_memory_ptrace(int pid, uintptr_t address, size_t size, unsigned char* buffer);
ssize_t read_memory_proc_mem(int pid, uintptr_t address, size_t size, unsigned char* buffer);
extern "C" ssize_t write_memory_native(int pid, void* address, size_t size, unsigned char* buffer);

// ============================================================================
// Module enumeration (implemented in native_api.cpp, uses elf_parser.h helpers)
// ============================================================================

extern "C" ModuleInfo* enumerate_modules(pid_t pid, size_t* count);
extern "C" SymbolInfo* enum_symbols_native(int pid, uintptr_t module_base, size_t* count);

// ============================================================================
// PTY operations (implemented in pty_manager.cpp)
// ============================================================================

extern "C" int spawn_process_with_pty(const char* executable_path, const char** args, int argc,
                                      pid_t* out_pid, int* out_pty_fd);
extern "C" ssize_t read_pty(int pty_fd, char* buffer, size_t buffer_size);
extern "C" ssize_t write_pty(int pty_fd, const char* data, size_t data_len);
extern "C" void close_pty(int pty_fd);
extern "C" int get_pty_size(int pty_fd, int* rows, int* cols);
extern "C" int set_pty_size(int pty_fd, int rows, int cols);

#endif  // NATIVEAPI_H
