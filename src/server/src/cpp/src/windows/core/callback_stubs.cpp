// Callback stubs for DLL mode
// These functions are normally provided by Rust when statically linked.
// In DLL mode, Rust must set these function pointers after loading the DLL.

#include "../../common/dll_export.h"
#include "../../common/exception_info.h"
#include "native_api.h"

// Function pointer types
typedef void (*native_log_fn)(int level, const char* message);
typedef bool (*send_exception_info_fn)(const NativeExceptionInfo* info, int pid);

// Function pointers (set by Rust after DLL load)
static native_log_fn g_native_log = nullptr;
static send_exception_info_fn g_send_exception_info = nullptr;

// Set callback functions (called by Rust after DLL load)
extern "C" NATIVE_API void set_native_log_callback(native_log_fn fn)
{
    g_native_log = fn;
}

extern "C" NATIVE_API void set_send_exception_info_callback(send_exception_info_fn fn)
{
    g_send_exception_info = fn;
}

// Implementations called by C++ code
extern "C" void native_log(int level, const char* message)
{
    if (g_native_log)
    {
        g_native_log(level, message);
    }
    else
    {
        // Fallback: print to stderr
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

extern "C" bool send_exception_info(const NativeExceptionInfo* info, int pid)
{
    if (g_send_exception_info)
    {
        return g_send_exception_info(info, pid);
    }
    else
    {
        // Fallback: print basic info
        fprintf(stderr, "[WARN] send_exception_info: callback not set (rip=0x%llx, pid=%d)\n",
                (unsigned long long)info->regs.x86_64.rip, pid);
        return false;
    }
}
