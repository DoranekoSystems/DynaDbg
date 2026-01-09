/**
 * @file callback_stubs.mm
 * @brief Callback stubs for dynamic library mode (Darwin/macOS)
 *
 * These functions allow users to replace callback implementations
 * by setting function pointers after loading the library.
 *
 * In static linking mode, the host application provides native_log and
 * send_exception_info implementations directly.
 *
 * In dynamic library mode (DYNAMIC_LIB_BUILD), this file provides:
 * 1. Default fallback implementations
 * 2. Setter functions for users to inject custom callbacks
 */

#import <Foundation/Foundation.h>
#include <cstdio>

#include "../../common/dll_export.h"
#include "../../common/exception_info.h"
#include "native_api.h"

#ifdef DYNAMIC_LIB_BUILD

// =============================================================================
// Function pointer types
// =============================================================================

typedef void (*native_log_fn)(int level, const char* message);
typedef bool (*send_exception_info_fn)(const NativeExceptionInfo* info, pid_t pid);

// =============================================================================
// Global function pointers (can be set by user after library load)
// =============================================================================

static native_log_fn g_native_log = nullptr;
static send_exception_info_fn g_send_exception_info = nullptr;

// =============================================================================
// Callback setter/getter functions
// =============================================================================

extern "C" NATIVE_API void set_native_log_callback(native_log_fn fn)
{
    g_native_log = fn;
}

extern "C" NATIVE_API void set_send_exception_info_callback(send_exception_info_fn fn)
{
    g_send_exception_info = fn;
}

extern "C" NATIVE_API native_log_fn get_native_log_callback()
{
    return g_native_log;
}

extern "C" NATIVE_API send_exception_info_fn get_send_exception_info_callback()
{
    return g_send_exception_info;
}

// =============================================================================
// Callback implementations
// =============================================================================

/**
 * Implementation of native_log
 * If callback is set, calls user's function; otherwise prints to stderr
 */
extern "C" void native_log(int level, const char* message)
{
    if (g_native_log)
    {
        g_native_log(level, message);
    }
    else
    {
        // Fallback: print to stderr with level string
        const char* level_str = "UNKNOWN";
        switch (level)
        {
            case 1:
                level_str = "ERROR";
                break;
            case 2:
                level_str = "WARN";
                break;
            case 3:
                level_str = "INFO";
                break;
            case 4:
                level_str = "DEBUG";
                break;
            case 5:
                level_str = "TRACE";
                break;
        }
        fprintf(stderr, "[%s] %s\n", level_str, message);
    }
}

/**
 * Implementation of send_exception_info
 * If callback is set, calls user's function; otherwise prints summary to stderr
 * @return true = notify UI and break, false = silent continue
 */
extern "C" bool send_exception_info(const NativeExceptionInfo* info, pid_t pid)
{
    if (g_send_exception_info)
    {
        return g_send_exception_info(info, pid);
    }
    else
    {
        // Fallback: print basic info to stderr and return true to notify
        const char* exception_type_str = "UNKNOWN";
        switch (info->exception_type)
        {
            case EXCEPTION_BREAKPOINT:
                exception_type_str = "BREAKPOINT";
                break;
            case EXCEPTION_WATCHPOINT:
                exception_type_str = "WATCHPOINT";
                break;
            case EXCEPTION_SINGLESTEP:
                exception_type_str = "SINGLESTEP";
                break;
            case EXCEPTION_SIGNAL:
                exception_type_str = "SIGNAL";
                break;
            default:
                break;
        }
        
        fprintf(stderr, "[EXCEPTION] Type: %s, Thread: %llu, PID: %d\n",
                exception_type_str, info->thread_id, pid);
        
        if (info->architecture == ARCH_ARM64)
        {
            fprintf(stderr, "  PC: 0x%llx\n", info->regs.arm64.pc);
        }
        
        return true;  // Default: notify UI
    }
}

#endif  // DYNAMIC_LIB_BUILD
