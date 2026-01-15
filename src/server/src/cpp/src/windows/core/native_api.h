/**
 * @file native_api.h
 * @brief Native API declarations for Windows platform
 *
 * Provides process, module, thread, and symbol enumeration functions
 * using Windows APIs like CreateToolhelp32Snapshot and SymEnumSymbols.
 *
 * Memory operations are in memory_io.h
 */

#ifndef WINDOWS_NATIVE_API_H
#define WINDOWS_NATIVE_API_H

#include <windows.h>
//
#include <dbghelp.h>
#include <psapi.h>
#include <stdio.h>
#include <tlhelp32.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <vector>

#include "../../common/dll_export.h"

// =============================================================================
// Log Level Enumeration
// =============================================================================

enum LogLevel
{
    LOG_ERROR = 1,
    LOG_WARN = 2,
    LOG_INFO = 3,
    LOG_DEBUG = 4,
    LOG_TRACE = 5
};

// =============================================================================
// Data Structures
// =============================================================================

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
    char* type;             // Function, Variable, etc.
    char* scope;            // Global, Local, etc.
    uintptr_t module_base;  // Base address of containing module
    char* file_name;        // Source file name (if available)
    int line_number;        // Line number (if available)
} SymbolInfo;

typedef struct
{
    uint64_t thread_id;  // Thread ID
    char* name;          // Thread name (if available)
    uint64_t pc;         // Program counter (RIP)
    uint64_t sp;         // Stack pointer (RSP)
    uint64_t fp;         // Frame pointer (RBP)
    int state;           // Thread state (running, waiting, etc.)
    int suspend_count;   // Suspend count
} ThreadInfo;

typedef struct
{
    uintptr_t start;
    uintptr_t end;
    uint32_t protection;  // PROT_READ=1, PROT_WRITE=2, PROT_EXEC=4
    char* pathname;
} RegionInfo;

// =============================================================================
// Logging Functions
// =============================================================================

extern "C" NATIVE_API void native_log(int level, const char* message);
NATIVE_API int debug_log(LogLevel level, const char* format, ...);

// =============================================================================
// Process Functions
// =============================================================================

extern "C" NATIVE_API int get_pid_native();
extern "C" NATIVE_API ProcessInfo* enumerate_processes(size_t* count);
extern "C" NATIVE_API bool suspend_process(int pid);
extern "C" NATIVE_API bool resume_process(int pid);

// =============================================================================
// Module Functions
// =============================================================================

extern "C" NATIVE_API ModuleInfo* enumerate_modules(DWORD pid, size_t* count);

// =============================================================================
// Symbol Functions
// =============================================================================

extern "C" NATIVE_API SymbolInfo* enumerate_symbols(int pid, uintptr_t module_base, size_t* count);

// =============================================================================
// Thread Functions
// =============================================================================

extern "C" NATIVE_API ThreadInfo* enumerate_threads(int pid, size_t* count);
extern "C" NATIVE_API void free_thread_info(ThreadInfo* threads, size_t count);

// =============================================================================
// Region Functions
// =============================================================================

/**
 * Enumerate memory regions (structured array)
 * @param pid Process ID
 * @param count Output parameter for number of regions
 * @param include_filenames Whether to include mapped file names
 * @return Array of RegionInfo structures, or nullptr on error. Caller must call free_region_info.
 */
extern "C" NATIVE_API RegionInfo* enumerate_regions(DWORD pid, size_t* count,
                                                    bool include_filenames);

/**
 * Free region info array
 * @param regions Array returned by enumerate_regions
 * @param count Number of elements in array
 */
extern "C" NATIVE_API void free_region_info(RegionInfo* regions, size_t count);

/**
 * Enumerate memory regions to buffer (legacy API for backward compatibility)
 * @param pid Process ID
 * @param buffer Output buffer
 * @param buffer_size Buffer size
 * @param include_filenames Whether to include mapped file names
 */
extern "C" NATIVE_API void enumerate_regions_to_buffer(DWORD pid, char* buffer, size_t buffer_size,
                                                       bool include_filenames);

// =============================================================================
// Initialization
// =============================================================================

extern "C" NATIVE_API int native_init(int mode);

// =============================================================================
// Process Icon
// =============================================================================

extern "C" NATIVE_API const unsigned char* get_process_icon_native(int pid, size_t* size);

// =============================================================================
// Debugger Control Functions (stub implementations for Windows)
// =============================================================================

extern "C" NATIVE_API int continue_execution_native(uintptr_t thread_id);
extern "C" NATIVE_API int single_step_native(uintptr_t thread_id);
extern "C" NATIVE_API int read_register_native(uintptr_t thread_id, const char* reg_name,
                                               uint64_t* value);
extern "C" NATIVE_API int write_register_native(uintptr_t thread_id, const char* reg_name,
                                                uint64_t value);
extern "C" NATIVE_API bool is_in_break_state_native();

// =============================================================================
// Trace File Output Functions (stub implementations for Windows)
// =============================================================================

extern "C" NATIVE_API void enable_trace_file_output_native(const char* filepath);
extern "C" NATIVE_API void disable_trace_file_output_native();
extern "C" NATIVE_API bool is_trace_file_output_enabled_native();
extern "C" NATIVE_API const char* get_trace_file_path_native();
extern "C" NATIVE_API uint32_t get_trace_file_entry_count_native();
extern "C" NATIVE_API bool is_trace_ended_by_end_address_native();
extern "C" NATIVE_API void enable_full_memory_cache_native(const char* dump_filepath,
                                                           const char* log_filepath);
extern "C" NATIVE_API void disable_full_memory_cache_native();

#endif  // WINDOWS_NATIVE_API_H
