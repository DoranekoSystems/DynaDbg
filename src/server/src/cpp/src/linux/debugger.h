// Linux debugger core class
// Handles process attachment, breakpoints, watchpoints, and debug events

#ifndef DEBUGGER_H
#define DEBUGGER_H

#include <array>
#include <atomic>
#include <map>
#include <memory>
#include <queue>
#include <set>
#include <thread>

#include "../common/util.h"
#include "arch_defs.h"
#include "debugger_types.h"
#include "native_api.h"

// Architecture-specific register structure includes
#if defined(__aarch64__)
#include <asm/ptrace.h>
#elif defined(__x86_64__)
#include <sys/user.h>
#endif

#ifdef DYNAMIC_LIB_BUILD
// In dynamic library mode, use callback_stubs.cpp for native_log and send_exception_info
// Users can set custom callbacks via set_native_log_callback() and
// set_send_exception_info_callback()
#define Debugger DebuggerDynamic
#endif

// =============================================================================
// Debugger class
// =============================================================================

class Debugger
{
public:
    Debugger();  // Default constructor for spawn (pid will be set later)
    explicit Debugger(pid_t pid);
    ~Debugger();

    bool initialize();
    bool initialize_for_spawn();  // Initialize for PTRACE_TRACEME spawned process
    void run();

    // Spawn process in debugger thread (solves ptrace thread affinity)
    int spawn_process(const std::string& executable_path, const std::vector<std::string>& args,
                      pid_t* out_pid);
    int spawn_process_with_pty(const std::string& executable_path,
                               const std::vector<std::string>& args, pid_t* out_pid,
                               int* out_pty_fd);

    // Breakpoint and watchpoint management
    int set_watchpoint(uint64_t address, int size, WatchpointType type);
    int remove_watchpoint(uint64_t address);
    int set_breakpoint(uint64_t address, int hit_count, bool is_software = false);
    int remove_breakpoint(uint64_t address);

    // Software breakpoint original instruction query
    bool get_software_breakpoint_original_bytes(uint64_t address, uint8_t* out_bytes,
                                                size_t* out_size);

    // Exception handling
    int handle_exception(pid_t pid, int status);

    // Execution control
    int continue_execution(pid_t thread_id);
    int single_step(pid_t thread_id);

    // Register and memory access
    int read_register(pid_t thread_id, const std::string& reg_name, uint64_t* value);
    int write_register(pid_t thread_id, const std::string& reg_name, uint64_t value);
    ssize_t read_memory(uint64_t address, size_t size, unsigned char* buffer);

    // State queries
    DebugState get_debug_state() const;
    bool is_in_break_state() const;
    pid_t get_pid() const
    {
        return pid_;
    }
    bool is_running() const
    {
        return debug_loop_running_;
    }

    // Signal/Exception monitoring configuration
    void set_signal_config(int signal, const SignalConfig& config);
    SignalConfig get_signal_config(int signal) const;
    std::map<int, SignalConfig> get_all_signal_configs() const;
    void set_all_signal_configs(const std::map<int, SignalConfig>& configs);
    void remove_signal_config(int signal);

    // User suspend/resume control (called from native_api.cpp)
    void set_user_suspend_pending(bool pending)
    {
        user_suspend_pending_.store(pending);
    }
    bool is_user_suspend_pending() const
    {
        return user_suspend_pending_.load();
    }
    int resume_all_user_stopped_threads();

private:
    // =========================================================================
    // Synchronization structures
    // =========================================================================

    // Per-watchpoint/breakpoint synchronization structure
    // Uses atomics only to avoid pthread_cond_clockwait
    struct WatchpointSync
    {
        std::atomic<bool> removing{false};
        std::atomic<int> active_handlers{0};
    };

    struct BreakpointSync
    {
        std::atomic<bool> removing{false};
        std::atomic<int> active_handlers{0};
    };

    // =========================================================================
    // Constants
    // =========================================================================

    static const int MAX_WATCHPOINTS = 1;  // Limited to 1 for stability
    static const int MAX_BREAKPOINTS = 4;
    static const int MAX_SOFTWARE_BREAKPOINTS = 1000000;

    // =========================================================================
    // Single step mode
    // =========================================================================

    enum class SingleStepMode
    {
        None,
        Watchpoint,
        Breakpoint,
        HardwareBreakpointContinue,
        SoftwareBreakpoint,
        SoftwareBreakpointContinue
    };

    // =========================================================================
    // Thread state
    // =========================================================================

    struct ThreadState
    {
        SingleStepMode single_step_mode = SingleStepMode::None;
        int single_step_count = 0;
        int current_breakpoint_index = -1;
#if defined(__aarch64__)
        struct user_pt_regs regs;
#elif defined(__x86_64__)
        struct user_regs_struct regs;
#endif
        bool is_attached = false;
        bool is_stopped = false;
        bool stopped_by_user = false;
        uint32_t original_wcr = 0;
        int disabled_watchpoint_index = -1;
        int pending_signal = 0;
    };

    // =========================================================================
    // Member variables
    // =========================================================================

    // Synchronization
    std::array<WatchpointSync, 1> watchpoint_sync_;
    std::array<BreakpointSync, 4> breakpoint_sync_;
    std::mutex thread_states_mutex_;
    mutable std::mutex watchpoint_data_mutex_;
    mutable std::mutex breakpoint_data_mutex_;
    std::atomic<uint32_t> removing_mask_{0};

    // Process state
    pid_t pid_;
    std::set<pid_t> attached_threads_;
    bool debug_loop_running_;
    std::thread debug_thread_;
    std::atomic<bool> user_suspend_pending_{false};

    // Command queue
    std::queue<std::shared_ptr<DebugRequest>> debug_command_queue_;
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    bool threads_attached_ = false;

    // Watchpoint data
    std::vector<bool> watchpoint_used;
    std::vector<uint64_t> watchpoint_addresses;
    std::vector<int> watchpoint_sizes;
    std::vector<WatchpointType> watchpoint_types;

    // Hardware breakpoint data
    std::vector<bool> breakpoint_used;
    std::vector<uint64_t> breakpoint_addresses;
    std::vector<int> breakpoint_hit_counts;
    std::vector<int> breakpoint_target_counts;
    std::vector<BreakpointType> breakpoint_types;

    // Software breakpoint data
    std::vector<bool> software_breakpoint_used;
    std::vector<uint64_t> software_breakpoint_addresses;
    std::vector<uint8_t> software_breakpoint_original_bytes;
    mutable std::mutex software_breakpoint_mutex_;

    // Thread and debug state
    std::map<pid_t, ThreadState> thread_states_;
    DebugState debug_state_ = DebugState::Running;
    pid_t current_thread = 0;

    // Signal configuration
    std::map<int, SignalConfig> signal_config_;
    mutable std::mutex signal_config_mutex_;

    // =========================================================================
    // Private helper methods
    // =========================================================================

    std::vector<pid_t> get_thread_list();
    pid_t find_stopped_thread();
    int attach_to_threads();
    void debug_message_loop();
    int wait_for_debug_event(pid_t* thread_id, int* status);

    // Command queue processing
    void enqueue_command(std::shared_ptr<DebugRequest> request);
    void process_command_queue();
    int process_set_watchpoint_command(std::shared_ptr<DebugRequest> request);
    int process_remove_watchpoint_command(std::shared_ptr<DebugRequest> request);
    int process_set_breakpoint_command(std::shared_ptr<DebugRequest> request);
    int process_remove_breakpoint_command(std::shared_ptr<DebugRequest> request);
    int process_continue_execution_command(std::shared_ptr<DebugRequest> request);
    int process_single_step_command(std::shared_ptr<DebugRequest> request);
    int process_reapply_watchpoints_command(std::shared_ptr<DebugRequest> request);
    int process_read_register_command(std::shared_ptr<DebugRequest> request);
    int process_write_register_command(std::shared_ptr<DebugRequest> request);
    int process_read_memory_command(std::shared_ptr<DebugRequest> request);
    int process_spawn_command(std::shared_ptr<DebugRequest> request);
    int process_spawn_with_pty_command(std::shared_ptr<DebugRequest> request);

    // Internal implementations (called by debug thread)
    int set_watchpoint_internal(uint64_t address, int size, WatchpointType type);
    int remove_watchpoint_internal(uint64_t address);
    int set_breakpoint_internal(uint64_t address, int hit_count, BreakpointType bp_type);
    int set_hardware_breakpoint_internal(uint64_t address, int hit_count);
    int set_software_breakpoint_internal(uint64_t address, int hit_count);
    int remove_breakpoint_internal(uint64_t address);
    int remove_software_breakpoint_internal(uint64_t address);
    int continue_execution_internal(pid_t thread_id);
    int single_step_internal(pid_t thread_id);
    int reapply_all_watchpoints_internal();
    int reapply_all_watchpoints_internal(pid_t already_stopped_thread);
    int read_register_internal(pid_t thread_id, const std::string& reg_name, uint64_t* value);
    int write_register_internal(pid_t thread_id, const std::string& reg_name, uint64_t value);
    ssize_t read_memory_internal(uint64_t address, size_t size, unsigned char* buffer);
    int spawn_process_internal(std::shared_ptr<DebugRequest> request);
    int spawn_process_with_pty_internal(std::shared_ptr<DebugRequest> request);
    int resume_all_user_stopped_threads_internal();

    // Thread control
    std::vector<pid_t> stop_all_threads(pid_t exclude_thread_id = 0,
                                        std::vector<pid_t>* already_stopped_out = nullptr);
    void resume_threads(const std::vector<pid_t>& stopped_threads);
    void cancel_interrupt_for_non_stopped_threads(const std::vector<pid_t>& stopped_threads);
    bool verify_threads_stopped(std::vector<pid_t>& threads_to_verify);

    // Hardware register operations
    bool apply_watchpoint_to_threads(const std::vector<pid_t>& threads, int index, uint64_t address,
                                     int size, WatchpointType type);
    bool apply_watchpoint_to_thread(pid_t thread, int index, uint64_t address, int size,
                                    WatchpointType type);
    bool clear_watchpoint_from_threads(const std::vector<pid_t>& threads, int index);
    bool apply_breakpoint_to_threads(const std::vector<pid_t>& threads, int index,
                                     uint64_t address);
    bool apply_breakpoint_to_thread(pid_t thread, int index, uint64_t address);
    bool clear_breakpoint_from_threads(const std::vector<pid_t>& threads, int index);

    // Event handlers
    int handle_single_step(pid_t thread);
    int complete_watchpoint_single_step(pid_t thread);
    int continue_breakpoint_single_step(pid_t thread);
    int handle_watchpoint_hit(pid_t thread, int watchpoint_index);
    int handle_breakpoint_hit(pid_t thread, int breakpoint_index);
    int handle_software_breakpoint_continue(pid_t thread, int breakpoint_index);

    // Utility methods
    int find_free_watchpoint();
    int find_watchpoint_index(uint64_t address);
    int find_free_breakpoint();
    int find_breakpoint_index(uint64_t address);
    int get_available_watchpoints(pid_t thread);
    int set_watchpoint_on_thread(pid_t thread, uint64_t address, int size, WatchpointType type,
                                 int index);
    int clear_watchpoint_on_thread(pid_t thread, int index);
    int remove_watchpoint_by_index(int index);
};

// Global pointer to the Debugger instance
extern Debugger* g_debugger;

#endif  // DEBUGGER_H