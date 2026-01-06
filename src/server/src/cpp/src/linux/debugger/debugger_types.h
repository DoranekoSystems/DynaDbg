// Type definitions for Linux debugger
// Separated from debugger.h for cleaner organization

#ifndef DEBUGGER_TYPES_H
#define DEBUGGER_TYPES_H

#include <sys/types.h>

#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

// =============================================================================
// Signal configuration
// =============================================================================

// Configuration for signal catch/pass behavior
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

enum class WatchpointType
{
    READ = 1,
    WRITE = 2,
    READWRITE = 3
};

enum class BreakpointType
{
    HARDWARE = 0,
    SOFTWARE = 1
};

enum class DebugState
{
    Running,
    BreakpointHit,
    WatchpointHit,
    SingleStepping,
    Paused
};

enum class DebugCommand
{
    AttachToThreads,
    SetWatchpoint,
    RemoveWatchpoint,
    SetBreakpoint,
    RemoveBreakpoint,
    ContinueExecution,
    SingleStep,
    ReapplyWatchpoints,
    ReadRegister,
    WriteRegister,
    ReadMemory,
    SpawnProcess,
    SpawnProcessWithPty,
    ResumeUserStoppedThreads
};

// =============================================================================
// Debug request structure
// =============================================================================

// Request structure for queue-based command processing
struct DebugRequest
{
    DebugCommand command;
    std::mutex result_mutex;
    std::condition_variable result_cv;
    bool completed = false;
    int result = -1;

    // Parameters for different commands
    uint64_t address = 0;
    int size = 0;
    WatchpointType watchpoint_type = WatchpointType::READWRITE;
    BreakpointType breakpoint_type = BreakpointType::HARDWARE;
    int hit_count = 0;
    pid_t thread_id = 0;
    std::string reg_name;
    uint64_t reg_value = 0;
    uint64_t* reg_value_ptr = nullptr;

    // Parameters for ReadMemory command
    unsigned char* memory_buffer = nullptr;
    size_t memory_size = 0;
    ssize_t memory_bytes_read = 0;

    // Parameters for SpawnProcess command
    std::string executable_path;
    std::vector<std::string> spawn_args;
    pid_t spawned_pid = 0;
    int pty_fd = -1;  // For SpawnProcessWithPty

    explicit DebugRequest(DebugCommand cmd) : command(cmd) {}
};

#endif  // DEBUGGER_TYPES_H
