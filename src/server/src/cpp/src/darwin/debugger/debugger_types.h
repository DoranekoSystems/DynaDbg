/**
 * @file debugger_types.h
 * @brief Type definitions for Darwin/macOS debugger
 *
 * Separated from debugger.h for cleaner organization.
 * Contains common types, enums, and structures used by the debugger.
 */

#ifndef DARWIN_DEBUGGER_TYPES_H
#define DARWIN_DEBUGGER_TYPES_H

#include <mach/mach.h>

#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

// =============================================================================
// Signal configuration
// =============================================================================

/**
 * Configuration for signal catch/pass behavior
 */
struct SignalConfig
{
    bool catch_signal;  // If true, stop and notify UI when signal received
    bool pass_signal;   // If true, deliver signal to process on continue

    // Default: catch=false (don't stop), pass=false (suppress signal, like GDB)
    SignalConfig() : catch_signal(false), pass_signal(false) {}
    SignalConfig(bool catch_sig, bool pass_sig) : catch_signal(catch_sig), pass_signal(pass_sig) {}
};

// =============================================================================
// Debugger enums
// =============================================================================

/**
 * Watchpoint type enumeration
 */
enum class WatchpointType
{
    READ = 1,
    WRITE = 2,
    READWRITE = 3
};

/**
 * Breakpoint type enumeration
 */
enum class BreakpointType
{
    HARDWARE = 0,
    SOFTWARE = 1
};

/**
 * Debug state enumeration
 */
enum class DebugState
{
    Running,
    BreakpointHit,
    WatchpointHit,
    SingleStepping
};

/**
 * Single step mode enumeration
 * Used to track the reason for single-stepping
 */
enum class SingleStepMode
{
    None,
    Watchpoint,                  // Single step to complete watchpoint handling
    Breakpoint,                  // Single step for tracing at hardware breakpoint
    HardwareBreakpointContinue,  // Single step to silently continue over hardware breakpoint
    SoftwareBreakpoint,          // Single step from software breakpoint (user requested)
    SoftwareBreakpointContinue   // Single step to continue over software breakpoint
};

// =============================================================================
// Thread state structure
// =============================================================================

/**
 * Per-thread debug state information
 */
struct ThreadState
{
    SingleStepMode single_step_mode = SingleStepMode::None;
    int single_step_count = 0;
    int current_breakpoint_index = -1;
    int current_watchpoint_index = -1;           // Track which watchpoint was hit
    int current_software_breakpoint_index = -1;  // Track which software breakpoint was hit
    bool is_stopped = false;  // True if thread is currently stopped/suspended
    arm_thread_state64_t thread_state;
    arm_debug_state64_t debug_state;
    arm_exception_state64_t exception_state;
};

// =============================================================================
// Synchronization structures
// =============================================================================

/**
 * Per-watchpoint synchronization structure
 * Used to safely handle concurrent watchpoint operations
 */
struct WatchpointSync
{
    std::atomic<bool> removing{false};    // Deletion in progress flag
    std::atomic<int> active_handlers{0};  // Number of active handlers for this watchpoint
    std::mutex mutex;                     // Per-watchpoint mutex
    std::condition_variable cv;           // Per-watchpoint condition variable
};

/**
 * Per-breakpoint synchronization structure
 * Used to safely handle concurrent breakpoint operations
 */
struct BreakpointSync
{
    std::atomic<bool> removing{false};    // Deletion in progress flag
    std::atomic<int> active_handlers{0};  // Number of active handlers for this breakpoint
    std::mutex mutex;                     // Per-breakpoint mutex
    std::condition_variable cv;           // Per-breakpoint condition variable
};

// =============================================================================
// Hardware limits
// =============================================================================

// Maximum number of hardware watchpoints on ARM64
constexpr int MAX_WATCHPOINTS = 4;

// Maximum number of hardware breakpoints on ARM64
constexpr int MAX_BREAKPOINTS = 16;

// Maximum number of software breakpoints (limited by memory/management)
constexpr int MAX_SOFTWARE_BREAKPOINTS = 1000000;

#endif  // DARWIN_DEBUGGER_TYPES_H
