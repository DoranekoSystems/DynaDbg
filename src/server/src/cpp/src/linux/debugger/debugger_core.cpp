/**
 * @file debugger_core.cpp
 * @brief Core debugger functionality - initialization, main loop, command queue
 *
 * This file contains:
 * - Constructors and destructor
 * - Initialization methods
 * - Debug message loop
 * - Command queue processing
 * - Memory read/write helpers
 */

#include "debugger_internal.h"

// =============================================================================
// Global definitions
// =============================================================================

Debugger* g_debugger = nullptr;

// Global signal configuration (persists even when debugger is not attached)
std::map<int, SignalConfig> g_signal_config;
std::mutex g_signal_config_mutex;

// =============================================================================
// Helper functions for exception info population
// =============================================================================

#if defined(__aarch64__)
void populate_exception_info(NativeExceptionInfo& info, const struct user_pt_regs& regs,
                             ExceptionType exception_type, pid_t thread_id, uint64_t memory_address,
                             uint64_t singlestep_mode, bool is_trace)
{
    memset(&info, 0, sizeof(info));

    info.architecture = ARCH_ARM64;

    // Copy general-purpose registers (x0-x29)
    for (int i = 0; i < 30; ++i)
    {
        info.regs.arm64.x[i] = regs.regs[i];
    }

    info.regs.arm64.lr = regs.regs[30];  // x30 is LR
    info.regs.arm64.sp = regs.sp;
    info.regs.arm64.pc = regs.pc;
    info.regs.arm64.cpsr = regs.pstate;
    info.regs.arm64.fp = regs.regs[29];  // x29 is FP

    info.exception_type = static_cast<uint64_t>(exception_type);
    info.thread_id = static_cast<uint64_t>(thread_id);
    info.memory_address = memory_address;
    info.singlestep_mode = singlestep_mode;
    info.is_trace = is_trace ? 1 : 0;
}

#elif defined(__x86_64__)
void populate_exception_info(NativeExceptionInfo& info, const struct user_regs_struct& regs,
                             ExceptionType exception_type, pid_t thread_id, uint64_t memory_address,
                             uint64_t singlestep_mode, bool is_trace)
{
    memset(&info, 0, sizeof(info));

    info.architecture = ARCH_X86_64;

    // Copy x86_64 registers
    info.regs.x86_64.rax = regs.rax;
    info.regs.x86_64.rbx = regs.rbx;
    info.regs.x86_64.rcx = regs.rcx;
    info.regs.x86_64.rdx = regs.rdx;
    info.regs.x86_64.rsi = regs.rsi;
    info.regs.x86_64.rdi = regs.rdi;
    info.regs.x86_64.rbp = regs.rbp;
    info.regs.x86_64.rsp = regs.rsp;
    info.regs.x86_64.r8 = regs.r8;
    info.regs.x86_64.r9 = regs.r9;
    info.regs.x86_64.r10 = regs.r10;
    info.regs.x86_64.r11 = regs.r11;
    info.regs.x86_64.r12 = regs.r12;
    info.regs.x86_64.r13 = regs.r13;
    info.regs.x86_64.r14 = regs.r14;
    info.regs.x86_64.r15 = regs.r15;
    info.regs.x86_64.rip = regs.rip;
    info.regs.x86_64.rflags = regs.eflags;
    info.regs.x86_64.cs = regs.cs;
    info.regs.x86_64.ss = regs.ss;
    info.regs.x86_64.ds = regs.ds;
    info.regs.x86_64.es = regs.es;
    info.regs.x86_64.fs = regs.fs;
    info.regs.x86_64.gs = regs.gs;
    info.regs.x86_64.fs_base = regs.fs_base;
    info.regs.x86_64.gs_base = regs.gs_base;

    info.exception_type = static_cast<uint64_t>(exception_type);
    info.thread_id = static_cast<uint64_t>(thread_id);
    info.memory_address = memory_address;
    info.singlestep_mode = singlestep_mode;
    info.is_trace = is_trace ? 1 : 0;
}
#endif

// =============================================================================
// Memory access helpers using ptrace
// =============================================================================

uint64_t read_memory_word(pid_t pid, uint64_t address)
{
    errno = 0;
    long data = PTRACE_CALL(PTRACE_PEEKDATA, pid, (void*)address, nullptr);
    if (errno != 0)
    {
        return 0;
    }
    return (uint64_t)data;
}

int write_memory_word(pid_t pid, uint64_t address, uint64_t data)
{
    if (PTRACE_CALL(PTRACE_POKEDATA, pid, (void*)address, (void*)data) == -1)
    {
        debug_log(LOG_ERROR, "Failed to write memory at 0x%lx: %s", address, strerror(errno));
        return -1;
    }
    return 0;
}

// =============================================================================
// Constructors and Destructor
// =============================================================================

Debugger::Debugger()
    : pid_(0),
      debug_loop_running_(false),
      watchpoint_used(MAX_WATCHPOINTS, false),
      watchpoint_addresses(MAX_WATCHPOINTS, 0),
      watchpoint_sizes(MAX_WATCHPOINTS, 0),
      watchpoint_types(MAX_WATCHPOINTS, WatchpointType::READWRITE),
      breakpoint_used(MAX_BREAKPOINTS, false),
      breakpoint_addresses(MAX_BREAKPOINTS, 0),
      breakpoint_hit_counts(MAX_BREAKPOINTS, 0),
      breakpoint_target_counts(MAX_BREAKPOINTS, 0),
      breakpoint_types(MAX_BREAKPOINTS, BreakpointType::HARDWARE),
      software_breakpoint_used(MAX_SOFTWARE_BREAKPOINTS, false),
      software_breakpoint_addresses(MAX_SOFTWARE_BREAKPOINTS, 0),
      software_breakpoint_original_bytes(MAX_SOFTWARE_BREAKPOINTS * 4, 0)
{
}

Debugger::Debugger(pid_t pid)
    : pid_(pid),
      debug_loop_running_(false),
      watchpoint_used(MAX_WATCHPOINTS, false),
      watchpoint_addresses(MAX_WATCHPOINTS, 0),
      watchpoint_sizes(MAX_WATCHPOINTS, 0),
      watchpoint_types(MAX_WATCHPOINTS, WatchpointType::READWRITE),
      breakpoint_used(MAX_BREAKPOINTS, false),
      breakpoint_addresses(MAX_BREAKPOINTS, 0),
      breakpoint_hit_counts(MAX_BREAKPOINTS, 0),
      breakpoint_target_counts(MAX_BREAKPOINTS, 0),
      breakpoint_types(MAX_BREAKPOINTS, BreakpointType::HARDWARE),
      software_breakpoint_used(MAX_SOFTWARE_BREAKPOINTS, false),
      software_breakpoint_addresses(MAX_SOFTWARE_BREAKPOINTS, 0),
      software_breakpoint_original_bytes(MAX_SOFTWARE_BREAKPOINTS * 4, 0)
{
}

Debugger::~Debugger()
{
    debug_loop_running_ = false;
    if (debug_thread_.joinable())
    {
        debug_thread_.join();
    }

    // Detach from all threads
    for (pid_t tid : attached_threads_)
    {
        PTRACE_CALL(PTRACE_DETACH, tid, nullptr, nullptr);
    }
}

// =============================================================================
// Initialization
// =============================================================================

bool Debugger::initialize()
{
    return true;
}

bool Debugger::initialize_for_spawn()
{
    attached_threads_.insert(pid_);
    thread_states_[pid_].is_attached = true;
    thread_states_[pid_].is_stopped = true;
    thread_states_[pid_].current_breakpoint_index = -1;
    thread_states_[pid_].single_step_mode = SingleStepMode::None;
    threads_attached_ = true;

    current_thread = pid_;
    debug_state_ = DebugState::Paused;

    return true;
}

void Debugger::run()
{
    debug_loop_running_ = true;
    debug_thread_ = std::thread(&Debugger::debug_message_loop, this);
}

// =============================================================================
// Debug State
// =============================================================================

DebugState Debugger::get_debug_state() const
{
    return debug_state_;
}

bool Debugger::is_in_break_state() const
{
    return debug_state_ == DebugState::BreakpointHit || debug_state_ == DebugState::WatchpointHit;
}

// =============================================================================
// Signal Configuration
// =============================================================================

void Debugger::set_signal_config(int signal, const SignalConfig& config)
{
    std::lock_guard<std::mutex> lock(signal_config_mutex_);
    signal_config_[signal] = config;
    debug_log(LOG_INFO, "Set signal %d (%s) config: catch=%d, pass=%d", signal, strsignal(signal),
              config.catch_signal, config.pass_signal);
}

SignalConfig Debugger::get_signal_config(int signal) const
{
    std::lock_guard<std::mutex> lock(signal_config_mutex_);
    auto it = signal_config_.find(signal);
    if (it != signal_config_.end())
    {
        return it->second;
    }
    return SignalConfig(false, false);
}

std::map<int, SignalConfig> Debugger::get_all_signal_configs() const
{
    std::lock_guard<std::mutex> lock(signal_config_mutex_);
    return signal_config_;
}

void Debugger::set_all_signal_configs(const std::map<int, SignalConfig>& configs)
{
    std::lock_guard<std::mutex> lock(signal_config_mutex_);
    signal_config_ = configs;
    debug_log(LOG_INFO, "Set %zu signal configs", configs.size());
}

void Debugger::remove_signal_config(int signal)
{
    std::lock_guard<std::mutex> lock(signal_config_mutex_);
    signal_config_.erase(signal);
    debug_log(LOG_INFO, "Removed signal %d (%s) config", signal, strsignal(signal));
}

// =============================================================================
// Command Queue
// =============================================================================

void Debugger::enqueue_command(std::shared_ptr<DebugRequest> request)
{
    std::lock_guard<std::mutex> lock(queue_mutex_);
    debug_command_queue_.push(request);
    queue_cv_.notify_one();
}

void Debugger::process_command_queue()
{
    std::unique_lock<std::mutex> lock(queue_mutex_);

    while (!debug_command_queue_.empty())
    {
        auto request = debug_command_queue_.front();
        debug_command_queue_.pop();
        lock.unlock();

        int result = -1;
        switch (request->command)
        {
            case DebugCommand::SetWatchpoint:
                result = process_set_watchpoint_command(request);
                break;
            case DebugCommand::RemoveWatchpoint:
                result = process_remove_watchpoint_command(request);
                break;
            case DebugCommand::SetBreakpoint:
                result = process_set_breakpoint_command(request);
                break;
            case DebugCommand::RemoveBreakpoint:
                result = process_remove_breakpoint_command(request);
                break;
            case DebugCommand::ContinueExecution:
                result = process_continue_execution_command(request);
                break;
            case DebugCommand::SingleStep:
                result = process_single_step_command(request);
                break;
            case DebugCommand::ReapplyWatchpoints:
                result = process_reapply_watchpoints_command(request);
                break;
            case DebugCommand::ReadRegister:
                result = process_read_register_command(request);
                break;
            case DebugCommand::WriteRegister:
                result = process_write_register_command(request);
                break;
            case DebugCommand::ReadMemory:
                result = process_read_memory_command(request);
                break;
            case DebugCommand::SpawnProcess:
                result = process_spawn_command(request);
                break;
            case DebugCommand::SpawnProcessWithPty:
                result = process_spawn_with_pty_command(request);
                break;
            case DebugCommand::ResumeUserStoppedThreads:
                result = resume_all_user_stopped_threads_internal();
                break;
            default:
                debug_log(LOG_ERROR, "Unknown debug command: %d",
                          static_cast<int>(request->command));
                break;
        }

        {
            std::lock_guard<std::mutex> result_lock(request->result_mutex);
            request->result = result;
            request->completed = true;
        }
        request->result_cv.notify_one();

        lock.lock();
    }
}

int Debugger::process_set_watchpoint_command(std::shared_ptr<DebugRequest> request)
{
    return set_watchpoint_internal(request->address, request->size, request->watchpoint_type);
}

int Debugger::process_remove_watchpoint_command(std::shared_ptr<DebugRequest> request)
{
    return remove_watchpoint_internal(request->address);
}

int Debugger::process_set_breakpoint_command(std::shared_ptr<DebugRequest> request)
{
    return set_breakpoint_internal(request->address, request->hit_count, request->breakpoint_type);
}

int Debugger::process_remove_breakpoint_command(std::shared_ptr<DebugRequest> request)
{
    return remove_breakpoint_internal(request->address);
}

int Debugger::process_continue_execution_command(std::shared_ptr<DebugRequest> request)
{
    return continue_execution_internal(request->thread_id);
}

int Debugger::process_single_step_command(std::shared_ptr<DebugRequest> request)
{
    return single_step_internal(request->thread_id);
}

int Debugger::process_reapply_watchpoints_command(std::shared_ptr<DebugRequest> request)
{
    return reapply_all_watchpoints_internal(request->thread_id);
}

int Debugger::process_read_register_command(std::shared_ptr<DebugRequest> request)
{
    return read_register_internal(request->thread_id, request->reg_name, request->reg_value_ptr);
}

int Debugger::process_write_register_command(std::shared_ptr<DebugRequest> request)
{
    return write_register_internal(request->thread_id, request->reg_name, request->reg_value);
}

int Debugger::process_read_memory_command(std::shared_ptr<DebugRequest> request)
{
    request->memory_bytes_read =
        read_memory_internal(request->address, request->memory_size, request->memory_buffer);
    return (request->memory_bytes_read > 0) ? 0 : -1;
}

int Debugger::process_spawn_command(std::shared_ptr<DebugRequest> request)
{
    return spawn_process_internal(request);
}

int Debugger::process_spawn_with_pty_command(std::shared_ptr<DebugRequest> request)
{
    return spawn_process_with_pty_internal(request);
}
