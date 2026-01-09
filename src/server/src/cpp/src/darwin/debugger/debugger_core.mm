/**
 * @file debugger_core.mm
 * @brief Core debugger functionality - initialization, main loop, global state (Darwin/macOS)
 *
 * This file contains:
 * - Global debugger pointer and signal configuration
 * - Dynamic library initialization
 * - Exception handler callback
 * - Constructors and destructor
 * - Initialization methods
 * - Debug message loop
 * - Helper functions (kern_return_to_string)
 */

#include "debugger_internal.h"

// =============================================================================
// Exception handler callback
// =============================================================================

__attribute__((used)) extern "C" kern_return_t catch_exception_raise(
    mach_port_t exception_port, mach_port_t thread, mach_port_t task, exception_type_t exception,
    mach_exception_data_t code, mach_msg_type_number_t code_count)
{
    // debug_log(LOG_ERROR, "catch_exception_raise called with exception: %d", exception);
#ifndef DYNAMIC_LIB_BUILD
    typedef kern_return_t (*handle_exception_func_t)(Debugger*, mach_port_t, mach_port_t,
                                                     mach_port_t, exception_type_t,
                                                     mach_exception_data_t, mach_msg_type_number_t);
    static handle_exception_func_t dynamic_handle_exception = nullptr;
    static Debugger* dynamic_debugger_ptr = nullptr;
    static bool tried_resolve = false;

    if (!tried_resolve)
    {
        // Clear any existing error
        dlerror();

        // Try to open the dynamic library if it's already loaded
        void* handle = dlopen("libdbgsrv_native.dylib", RTLD_NOLOAD | RTLD_LAZY);
        if (!handle)
        {
            // Try alternative paths
            handle = dlopen("./libdbgsrv_native.dylib", RTLD_NOLOAD | RTLD_LAZY);
        }

        if (handle)
        {
            // debug_log_develop(LOG_INFO, "Found loaded dynamic library handle: %p", handle);

            // Get g_debugger_dynamic pointer
            Debugger** g_debugger_dynamic_addr = (Debugger**)dlsym(handle, "_g_debugger_dynamic");
            if (!g_debugger_dynamic_addr)
            {
                // Try without underscore prefix
                g_debugger_dynamic_addr = (Debugger**)dlsym(handle, "g_debugger_dynamic");
            }

            if (g_debugger_dynamic_addr)
            {
                dynamic_debugger_ptr = *g_debugger_dynamic_addr;
                // debug_log_develop(LOG_INFO, "Resolved g_debugger_dynamic at %p (value: %p)",
                //                   g_debugger_dynamic_addr, dynamic_debugger_ptr);
            }

            // Try to resolve handle_exception function symbol (non-mangled C function)
            dynamic_handle_exception =
                (handle_exception_func_t)dlsym(handle, "handle_exception_dynamic");
            if (!dynamic_handle_exception)
            {
                // Try with underscore prefix
                dynamic_handle_exception =
                    (handle_exception_func_t)dlsym(handle, "_handle_exception_dynamic");
            }

            if (dynamic_handle_exception)
            {
                // debug_log_develop(LOG_INFO, "Resolved dynamic handle_exception at %p",
                //                   dynamic_handle_exception);
            }
            else
            {
                const char* err = dlerror();
                debug_log(LOG_ERROR, "Failed to resolve handle_exception symbol in dynamic lib: %s",
                          err ? err : "unknown error");
            }
        }
        else
        {
            // debug_log_develop(LOG_DEBUG, "Dynamic library not loaded, using static version");
        }

        tried_resolve = true;
    }

    if (dynamic_handle_exception && dynamic_debugger_ptr)
    {
        return dynamic_handle_exception(dynamic_debugger_ptr, exception_port, thread, task,
                                        exception, code, code_count);
    }
    else
    {
        // debug_log_develop(LOG_DEBUG, "Dynamic handle_exception not available, using static");
    }
#endif

    if (g_debugger)
    {
        // debug_log_develop(LOG_INFO, "Using static debugger at %p", g_debugger);
        return g_debugger->handle_exception(exception_port, thread, task, exception, code,
                                            code_count);
    }
    return KERN_FAILURE;
}

// =============================================================================
// Global definitions
// =============================================================================

#ifdef DYNAMIC_LIB_BUILD
__attribute__((visibility("default"))) __attribute__((used))
#endif
extern "C" Debugger* g_debugger = nullptr;

// Global signal configuration (persists even when debugger is not attached)
std::map<int, SignalConfig> g_signal_config;
std::mutex g_signal_config_mutex;

// =============================================================================
// Dynamic library initialization
// =============================================================================

#ifdef DYNAMIC_LIB_BUILD
// Global function pointers for dynamically loaded functions
send_exception_info_func_t g_send_exception_info = nullptr;

// Initialization function to resolve all dynamic symbols
extern "C" void init_dynamic_functions()
{
    static bool initialized = false;
    if (initialized)
    {
        return;
    }

    // debug_log_develop(LOG_INFO, "Initializing dynamic library functions...");

    // Clear any existing error
    dlerror();

    // Try to resolve send_exception_info from main executable
    // RTLD_DEFAULT searches in the global symbol table
    g_send_exception_info = (send_exception_info_func_t)dlsym(RTLD_DEFAULT, "send_exception_info");
    if (!g_send_exception_info)
    {
        // Try with underscore prefix (macOS convention)
        g_send_exception_info =
            (send_exception_info_func_t)dlsym(RTLD_DEFAULT, "_send_exception_info");
    }

    if (g_send_exception_info)
    {
        // debug_log_develop(LOG_INFO, "Resolved send_exception_info at %p", g_send_exception_info);
    }
    else
    {
        const char* err = dlerror();
        debug_log(LOG_ERROR, "Failed to resolve send_exception_info: %s",
                  err ? err : "unknown error");
    }

    initialized = true;
    // debug_log_develop(LOG_INFO, "Dynamic library initialization complete");
}

// C function wrapper for handle_exception to avoid name mangling
extern "C" kern_return_t handle_exception_dynamic(Debugger* debugger, mach_port_t exception_port,
                                                  mach_port_t thread, mach_port_t task,
                                                  exception_type_t exception,
                                                  mach_exception_data_t code,
                                                  mach_msg_type_number_t code_count)
{
    if (debugger)
    {
        return debugger->handle_exception(exception_port, thread, task, exception, code,
                                          code_count);
    }
    return KERN_FAILURE;
}
#endif

// =============================================================================
// Constructor and Destructor
// =============================================================================

Debugger::Debugger(pid_t pid)
    : pid_(pid),
      task_port_(MACH_PORT_NULL),
      exception_port_(MACH_PORT_NULL),
      watchpoint_used(MAX_WATCHPOINTS, false),
      watchpoint_addresses(MAX_WATCHPOINTS, 0),
      watchpoint_sizes(MAX_WATCHPOINTS, 0),
      breakpoint_used(MAX_BREAKPOINTS, false),
      breakpoint_addresses(MAX_BREAKPOINTS, 0),
      breakpoint_hit_counts(MAX_BREAKPOINTS, 0),
      breakpoint_target_counts(MAX_BREAKPOINTS, 0),
      breakpoint_end_addresses(MAX_BREAKPOINTS, 0),
      software_breakpoint_used(MAX_SOFTWARE_BREAKPOINTS, false),
      software_breakpoint_addresses(MAX_SOFTWARE_BREAKPOINTS, 0),
      software_breakpoint_original_bytes(MAX_SOFTWARE_BREAKPOINTS * 4,
                                         0)  // 4 bytes per breakpoint for ARM64
{
}

Debugger::~Debugger()
{
    if (exception_port_ != MACH_PORT_NULL)
    {
        mach_port_deallocate(mach_task_self(), exception_port_);
    }
    if (task_port_ != MACH_PORT_NULL)
    {
        mach_port_deallocate(mach_task_self(), task_port_);
    }
}

// =============================================================================
// Initialization
// =============================================================================

// Forward declaration for task port cache function from native_api.mm
extern "C" void set_cached_task_port(pid_t pid, mach_port_t task);

bool Debugger::initialize()
{
    kern_return_t kr;

    kr = task_for_pid(mach_task_self(), pid_, &task_port_);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_for_pid failed: %s", kern_return_to_string(kr).c_str());
        return false;
    }

    // Share the task port with native_api.mm's cache
    set_cached_task_port(pid_, task_port_);

    kr = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &exception_port_);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_port_allocate failed: %s", kern_return_to_string(kr).c_str());
        return false;
    }

    kr = mach_port_insert_right(mach_task_self(), exception_port_, exception_port_,
                                MACH_MSG_TYPE_MAKE_SEND);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_port_insert_right failed: %s",
                  kern_return_to_string(kr).c_str());
        return false;
    }

    kr = task_set_exception_ports(task_port_, EXC_MASK_ALL, exception_port_, EXCEPTION_DEFAULT,
                                  ARM_THREAD_STATE64);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "task_set_exception_ports failed: %s",
                  kern_return_to_string(kr).c_str());
        return false;
    }

    // debug_log_develop(LOG_INFO, "Debugger initialized for process %d", pid_);
    return true;
}

// =============================================================================
// Main Loop
// =============================================================================

void Debugger::run()
{
    kern_return_t kr = mach_msg_server(exc_server, 2048, exception_port_, MACH_MSG_OPTION_NONE);

    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "mach_msg_server failed: %s", kern_return_to_string(kr).c_str());
    }
    else
    {
        // debug_log_develop(LOG_INFO, "mach_msg_server succeeded.");
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

std::string Debugger::kern_return_to_string(kern_return_t kr)
{
    return mach_error_string(kr);
}
