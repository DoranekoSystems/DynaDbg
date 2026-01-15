#ifndef WINDOWS_DEBUGGER_H
#define WINDOWS_DEBUGGER_H

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <mutex>

#include "../../common/dll_export.h"
#include "../../common/exception_info.h"

// Watchpoint type enumeration
enum class WatchpointType
{
    READ = 1,
    WRITE = 2,
    READWRITE = 3
};

// Debug state enumeration
enum class DebugState
{
    NotStarted,
    Running,
    BreakpointHit,
    WatchpointHit,
    SingleStepping,
    Stopped
};

// Maximum number of hardware watchpoints/breakpoints (x86_64 has DR0-DR3)
static const int MAX_WATCHPOINTS = 4;
static const int MAX_BREAKPOINTS = 4;
static const int MAX_SOFTWARE_BREAKPOINTS = 256;

// Watchpoint slot info
struct WatchpointSlot
{
    bool used = false;
    uint64_t address = 0;
    int size = 0;
    WatchpointType type = WatchpointType::WRITE;
};

// Breakpoint slot info
struct BreakpointSlot
{
    bool used = false;
    uint64_t address = 0;
    int hit_count = 0;
    int target_count = 0;
};

// Software breakpoint slot info
struct SoftwareBreakpointSlot
{
    bool used = false;
    uint64_t address = 0;
    uint8_t original_byte = 0;  // Original byte at BP address (before INT3)
    int hit_count = 0;
    int target_count = 0;
};

// Exception type constants (matching common/exception_info.h)
#define EXCEPTION_BREAKPOINT_TYPE 1
#define EXCEPTION_WATCHPOINT_TYPE 2
#define EXCEPTION_SINGLE_STEP_TYPE 3

/**
 * Mock Debugger class for Windows
 *
 * This is a mock implementation that provides the expected interface
 * without actual debugging functionality. It can be extended with
 * real Windows Debug API implementation in the future.
 */
class Debugger
{
public:
    Debugger(int pid);
    ~Debugger();

    // Initialization and control
    bool initialize();
    void run();
    void stop();
    bool wait_for_attach(int timeout_ms = 10000);

    // Watchpoint operations (mock)
    int set_watchpoint(uint64_t address, int size, WatchpointType type);
    int remove_watchpoint(uint64_t address);

    // Hardware breakpoint operations (mock)
    int set_breakpoint(uint64_t address, int hit_count, bool is_software = false);
    int remove_breakpoint(uint64_t address);

    // Software breakpoint operations (mock)
    int set_software_breakpoint(uint64_t address, int hit_count);
    int remove_software_breakpoint(uint64_t address);
    bool get_software_breakpoint_original_bytes(uint64_t address, uint8_t* out_bytes,
                                                size_t* out_size);

    // Debug control
    int continue_execution(DWORD thread_id);
    int single_step(DWORD thread_id);

    // State accessors
    DebugState get_debug_state() const
    {
        return debug_state_.load();
    }
    bool is_in_break_state() const;

    int get_pid() const
    {
        return pid_;
    }
    bool is_running() const
    {
        return running_.load();
    }

private:
    int pid_;
    std::atomic<bool> running_;
    std::atomic<DebugState> debug_state_;
    std::mutex mutex_;

    // Watchpoint and breakpoint storage (for mock state tracking)
    WatchpointSlot watchpoints_[MAX_WATCHPOINTS];
    BreakpointSlot breakpoints_[MAX_BREAKPOINTS];
    SoftwareBreakpointSlot software_breakpoints_[MAX_SOFTWARE_BREAKPOINTS];

    // Helper functions
    int find_free_watchpoint_slot();
    int find_watchpoint_index(uint64_t address);
    int find_free_breakpoint_slot();
    int find_breakpoint_index(uint64_t address);
    int find_free_software_breakpoint_slot();
    int find_software_breakpoint_index(uint64_t address);
};

// Global debugger instance
extern Debugger* g_debugger;

// C API for Rust FFI
extern "C"
{
    // Debugger control
    NATIVE_API int continue_execution_native(uintptr_t thread_id);
    NATIVE_API int single_step_native(uintptr_t thread_id);
    NATIVE_API bool is_in_break_state_native();

    // Watchpoint operations
    NATIVE_API int set_watchpoint_native(int pid, uint64_t address, int size, int type);
    NATIVE_API int remove_watchpoint_native(int pid, uint64_t address);

    // Hardware breakpoint operations
    NATIVE_API int set_breakpoint_native(int pid, uint64_t address, int hit_count);
    NATIVE_API int remove_breakpoint_native(int pid, uint64_t address);

    // Software breakpoint operations
    NATIVE_API int set_software_breakpoint_native(int pid, uint64_t address, int hit_count);
    NATIVE_API int remove_software_breakpoint_native(int pid, uint64_t address);
    NATIVE_API bool get_software_breakpoint_original_bytes_native(uint64_t address,
                                                                  uint8_t* out_bytes,
                                                                  size_t* out_size);

    // Signal configuration (mock for Windows - signals are Unix-specific)
    NATIVE_API void set_signal_config_native(int signal, bool catch_signal, bool pass_signal);
    NATIVE_API void get_signal_config_native(int signal, bool* catch_signal, bool* pass_signal);
    NATIVE_API size_t get_all_signal_configs_native(int* signals, bool* catch_signals,
                                                    bool* pass_signals, size_t max_count);
    NATIVE_API void remove_signal_config_native(int signal);

    // Debugger lifecycle
    NATIVE_API bool debugger_new(int pid);
    NATIVE_API int attach_debugger_native(int pid);
    NATIVE_API int detach_debugger_native(int pid);
    NATIVE_API bool is_debugger_attached_native(int pid);
}

#endif  // WINDOWS_DEBUGGER_H
