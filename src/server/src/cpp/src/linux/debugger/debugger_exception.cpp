/**
 * @file debugger_exception.cpp
 * @brief Exception handling and single-step related Debugger class member functions
 *
 * This file contains the implementation of exception handling, execution control,
 * and single-step functionality for the Linux debugger.
 *
 * Functions included:
 *   - handle_exception: Main exception handling function for ptrace events
 *   - continue_execution: Public API for resuming thread execution
 *   - continue_execution_internal: Internal implementation of continue
 *   - single_step: Public API for single-stepping a thread
 *   - single_step_internal: Internal implementation of single step
 *   - handle_single_step: Dispatcher for single step completion handling
 *   - complete_watchpoint_single_step: Completes watchpoint single step sequence
 *   - continue_breakpoint_single_step: Handles breakpoint single step continuation
 */

#include "debugger_internal.h"

int Debugger::handle_exception(pid_t pid, int status)
{
    if (WIFSTOPPED(status))
    {
        // Check for PTRACE_EVENT_CLONE (new thread created)
        if ((status >> 16) == PTRACE_EVENT_CLONE)
        {
            // Get the new thread's tid
            unsigned long new_tid = 0;
            if (PTRACE_CALL(PTRACE_GETEVENTMSG, pid, nullptr, &new_tid) == 0 && new_tid > 0)
            {
                // Register the new thread - it's automatically attached due to PTRACE_O_TRACECLONE
                // The new thread inherits the ptrace options from the parent
                // The new thread's first stop event (SIGSTOP) will be handled by the main waitpid
                // loop
                pid_t new_thread = static_cast<pid_t>(new_tid);
                attached_threads_.insert(new_thread);
                thread_states_[new_thread].is_attached = true;
            }
            else
            {
                debug_log(LOG_ERROR, "Failed to get new thread id from PTRACE_EVENT_CLONE: %s",
                          strerror(errno));
            }

            // Resume the parent thread that triggered the clone event
            if (PTRACE_CALL(PTRACE_CONT, pid, nullptr, nullptr) == -1)
            {
                debug_log(LOG_ERROR, "Failed to resume thread %d after PTRACE_EVENT_CLONE: %s", pid,
                          strerror(errno));
            }
            return 0;
        }

        // Check for PTRACE_EVENT_STOP (PTRACE_INTERRUPT induced stop)
        if ((status >> 16) == PTRACE_EVENT_STOP)
        {
            // This is a PTRACE_INTERRUPT induced stop
            // Resume the thread immediately - it was likely a late event from a completed operation
            if (PTRACE_CALL(PTRACE_CONT, pid, nullptr, nullptr) == -1)
            {
                debug_log(LOG_ERROR, "Failed to resume thread %d after PTRACE_EVENT_STOP: %s", pid,
                          strerror(errno));
            }
            return 0;
        }

        int signal = WSTOPSIG(status);

        switch (signal)
        {
            case SIGTRAP:
            {
                // Get register state
#if defined(__aarch64__)
                struct iovec iov;
                struct user_pt_regs regs;
                iov.iov_base = &regs;
                iov.iov_len = sizeof(regs);
                if (PTRACE_CALL(DYNA_PTRACE_GETREGSET, pid, NT_PRSTATUS, &iov) == -1)
#elif defined(__x86_64__)
                struct user_regs_struct regs;
                if (PTRACE_CALL(PTRACE_GETREGS, pid, nullptr, &regs) == -1)
#endif
                {
#if defined(__aarch64__)
                    // Test if hardware debug registers are accessible using ARM64 hardware
                    // breakpoint regset
                    struct user_hwdebug_state test_hw_state;
                    memset(&test_hw_state, 0, sizeof(test_hw_state));
                    struct iovec iov;
                    iov.iov_base = &test_hw_state;
                    iov.iov_len = sizeof(test_hw_state);
                    if (ptrace(PTRACE_GETREGSET, pid, NT_ARM_HW_BREAK, &iov) == 0)
                    {
                    }
                    else
                    {
                    }
#endif

                    // This is likely a PTRACE_INTERRUPT induced SIGTRAP
                    // The thread is stopped but register access might be temporarily unavailable
                    return 0;  // Don't continue, leave stopped for register access
                }

                // Check for single step completion first
                auto thread_it = thread_states_.find(pid);
                if (thread_it != thread_states_.end() &&
                    thread_it->second.single_step_mode != SingleStepMode::None)
                {
                    // Send exception info for single step using NativeExceptionInfo
                    NativeExceptionInfo exception_info;
                    populate_exception_info(
                        exception_info, regs, EXCEPTION_SINGLESTEP, pid, 0,
                        static_cast<uint64_t>(thread_it->second.single_step_mode));

                    // Check if this is a trace exception (target_count > 0)
                    int bp_index = thread_it->second.current_breakpoint_index;
                    if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
                    {
                        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                        int target_count = breakpoint_target_counts[bp_index];
                        exception_info.is_trace = (target_count > 0) ? 1 : 0;
                    }
                    else
                    {
                        exception_info.is_trace = 0;
                    }

                    SEND_EXCEPTION_INFO(&exception_info, pid_);

                    return handle_single_step(pid);
                }

                // Get signal info to determine fault address for watchpoint detection
                siginfo_t siginfo;
                memset(&siginfo, 0, sizeof(siginfo));
                uint64_t fault_address = 0;
                bool has_fault_address = false;

                if (PTRACE_CALL(PTRACE_GETSIGINFO, pid, nullptr, &siginfo) == 0)
                {
                    // si_addr contains the fault address for hardware watchpoint/breakpoint
                    fault_address = reinterpret_cast<uint64_t>(siginfo.si_addr);
                    has_fault_address = true;
                }

                // Check if it's a watchpoint hit by examining fault address
                bool watchpoint_hit = false;
                int wp_index = -1;

#if defined(__x86_64__)
                // x86_64: Read DR6 to determine which watchpoint was hit
                // DR6 bits 0-3 indicate which watchpoint (DR0-DR3) triggered
                (void)has_fault_address;  // Unused on x86_64, suppress warning
                errno = 0;                // Clear errno before PTRACE_PEEKUSER
                unsigned long dr6 =
                    ptrace((__ptrace_request)PTRACE_PEEKUSER, pid, X86_DR6_OFFSET, nullptr);
                if (errno == 0)
                {
                    std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
                    for (int i = 0; i < MAX_WATCHPOINTS; i++)
                    {
                        if ((dr6 & (1UL << i)) && watchpoint_used[i])
                        {
                            wp_index = i;
                            watchpoint_hit = true;
                            fault_address = watchpoint_addresses[i];
                            break;
                        }
                    }

                    // Clear DR6 after reading to prepare for next watchpoint
                    if (watchpoint_hit)
                    {
                        ptrace((__ptrace_request)PTRACE_POKEUSER, pid, X86_DR6_OFFSET, (void*)0);
                    }
                }
#elif defined(__aarch64__)
                if (has_fault_address && fault_address != 0)
                {
                    // Check which watchpoint matches the fault address
                    std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
                    for (int i = 0; i < MAX_WATCHPOINTS; i++)
                    {
                        if (watchpoint_used[i])
                        {
                            uint64_t wp_start = watchpoint_addresses[i];
                            uint64_t wp_end = wp_start + watchpoint_sizes[i];

                            // Check if fault address falls within the watchpoint range
                            if (fault_address >= wp_start && fault_address < wp_end)
                            {
                                wp_index = i;
                                watchpoint_hit = true;
                                break;
                            }
                        }
                    }

                    // If no exact match found, check with aligned addresses
                    // Hardware watchpoints may report aligned addresses
                    if (!watchpoint_hit)
                    {
                        uint64_t aligned_fault = fault_address & ~0x7ULL;  // 8-byte alignment
                        for (int i = 0; i < MAX_WATCHPOINTS; i++)
                        {
                            if (watchpoint_used[i])
                            {
                                uint64_t wp_aligned = watchpoint_addresses[i] & ~0x7ULL;
                                if (aligned_fault == wp_aligned)
                                {
                                    wp_index = i;
                                    watchpoint_hit = true;
                                    break;
                                }
                            }
                        }
                    }
                }
#endif

                if (watchpoint_hit && wp_index != -1)
                {
                    debug_state_ = DebugState::WatchpointHit;
                    current_thread = pid;

                    // Store thread state
                    thread_states_[pid].regs = regs;
                    thread_states_[pid].current_breakpoint_index = -1;
                    thread_states_[pid].is_stopped = true;  // Mark as stopped

                    // Send exception info for watchpoint hit using NativeExceptionInfo
                    NativeExceptionInfo exception_info;
                    populate_exception_info(exception_info, regs, EXCEPTION_WATCHPOINT, pid,
                                            watchpoint_addresses[wp_index]);
                    SEND_EXCEPTION_INFO(&exception_info, pid_);

                    return handle_watchpoint_hit(pid, wp_index);
                }

                // Check if it's a breakpoint hit
#if defined(__aarch64__)
                uint64_t pc = regs.pc;
#elif defined(__x86_64__)
                uint64_t pc = regs.rip;
#endif
                int bp_index = find_breakpoint_index(pc);

                if (bp_index != -1)
                {
                    // Get target_count to determine if trace mode
                    // Software breakpoints (bp_index >= 1000) don't have target counts, so skip
                    int target_count = 0;
                    bool is_software_bp = (bp_index >= 1000);
                    int actual_index = is_software_bp ? (bp_index - 1000) : bp_index;

#if defined(__x86_64__)
                    // On x86_64, when INT3 is executed, RIP points past the INT3 instruction
                    // We need to set RIP back to the breakpoint address
                    if (is_software_bp)
                    {
                        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
                        if (actual_index >= 0 && actual_index < MAX_SOFTWARE_BREAKPOINTS &&
                            software_breakpoint_used[actual_index])
                        {
                            uint64_t bp_addr = software_breakpoint_addresses[actual_index];
                            if (regs.rip != bp_addr)
                            {
                                debug_log(LOG_INFO,
                                          "Adjusting RIP from 0x%lx to breakpoint address 0x%lx",
                                          regs.rip, bp_addr);
                                regs.rip = bp_addr;
                                pc = bp_addr;
                                if (PTRACE_CALL(PTRACE_SETREGS, pid, nullptr, &regs) == -1)
                                {
                                    debug_log(LOG_ERROR, "Failed to adjust RIP: %s",
                                              strerror(errno));
                                }
                            }
                        }
                    }
#endif

                    if (!is_software_bp && actual_index >= 0 && actual_index < MAX_BREAKPOINTS)
                    {
                        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                        target_count = breakpoint_target_counts[actual_index];
                        breakpoint_hit_counts[actual_index]++;
                    }

                    debug_log(
                        LOG_DEBUG,
                        "Breakpoint hit at PC 0x%lx, bp_index=%d (software=%d, actual_index=%d)",
                        pc, bp_index, is_software_bp ? 1 : 0, actual_index);

                    debug_state_ = DebugState::BreakpointHit;
                    current_thread = pid;

                    // Store thread state
                    // For software breakpoints, store negative index to indicate software
                    thread_states_[pid].regs = regs;
                    thread_states_[pid].current_breakpoint_index =
                        is_software_bp ? -1 : actual_index;
                    thread_states_[pid].is_stopped = true;  // Mark as stopped

                    // For software breakpoints, store the software bp index for single-step
                    // handling
                    if (is_software_bp)
                    {
                        thread_states_[pid].disabled_watchpoint_index =
                            bp_index;  // Store full index (>= 1000)
                    }

                    // Send exception info for breakpoint hit using NativeExceptionInfo
                    // The return value indicates whether to notify UI and break (true)
                    // or to silently continue execution (false)
                    NativeExceptionInfo exception_info;
                    populate_exception_info(exception_info, regs, EXCEPTION_BREAKPOINT, pid);
                    exception_info.is_trace = (target_count > 0) ? 1 : 0;

                    bool should_break = SEND_EXCEPTION_INFO(&exception_info, pid_);

                    if (!should_break)
                    {
                        // Callback returned CONTINUE - silently continue execution
                        debug_log(LOG_INFO,
                                  "Breakpoint callback returned CONTINUE, resuming thread %d", pid);
                        thread_states_[pid].is_stopped = false;

                        // For software breakpoints, need to restore original instruction, step,
                        // then re-insert
                        if (is_software_bp)
                        {
                            return handle_software_breakpoint_continue(pid, bp_index);
                        }
                        else
                        {
                            // Hardware breakpoint - just continue
                            if (PTRACE_CALL(PTRACE_CONT, pid, nullptr, nullptr) == -1)
                            {
                                debug_log(LOG_ERROR,
                                          "Failed to continue thread %d after callback: %s", pid,
                                          strerror(errno));
                                return -1;
                            }
                            return 0;
                        }
                    }

                    return handle_breakpoint_hit(pid, bp_index);
                }
                else
                {
                    // For PTRACE_INTERRUPT induced SIGTRAP, leave the thread stopped
                    return 0;  // Don't continue, leave stopped
                }
                break;
            }

            case SIGSTOP:
            case SIGTSTP:
            {
                // Check if this SIGSTOP is from user API (suspend_process)
                // Use load() instead of exchange() - we don't consume the flag here
                // The flag will be cleared when resume_process is called
                bool is_user_suspend = user_suspend_pending_.load();

                if (is_user_suspend)
                {
                    // Mark this thread as stopped by user
                    thread_states_[pid].is_stopped = true;
                    thread_states_[pid].stopped_by_user = true;

                    kill(pid, SIGSTOP);  // Pass SIGSTOP to actually stop the thread
                }
                else
                {
                    thread_states_[pid].is_stopped = true;
                    // Don't set stopped_by_user for non-user SIGSTOPs (e.g., from thread creation)
                    // Don't continue automatically - leave stopped for hardware register access
                }
                return 0;
            }

            case SIGCONT:
            {
                // SIGCONT is received when resume_process is called
                // Only resume if the thread was previously stopped by user (SIGSTOP)
                auto it = thread_states_.find(pid);
                if (it != thread_states_.end() && it->second.stopped_by_user)
                {
                    it->second.stopped_by_user = false;
                    it->second.is_stopped = false;
                    // Pass SIGCONT to actually resume the process
                    if (kill(pid, SIGCONT) == -1)
                    {
                        debug_log(LOG_ERROR, "Failed to continue thread %d with SIGCONT: %s", pid,
                                  strerror(errno));
                        return -1;
                    }
                }
                else
                {
                    // Not stopped by user, just pass the signal through
                    if (kill(pid, SIGCONT) == -1)
                    {
                        debug_log(LOG_ERROR, "Failed to continue thread %d with SIGCONT: %s", pid,
                                  strerror(errno));
                        return -1;
                    }
                }
                return 0;
            }

            default:
            {
                // Get signal configuration (catch/pass settings)
                SignalConfig config = get_signal_config(signal);

                // Skip logging for common signals that are frequently received
                // SIGPWR=30 (Power failure), SIGXCPU=24 (CPU time limit exceeded)
                // These are typically used for internal system purposes
                if (signal != 30 && signal != 24)
                {
                    debug_log(LOG_INFO, "handle_exception: signal %d (%s), catch=%d, pass=%d",
                              signal, strsignal(signal), config.catch_signal, config.pass_signal);
                }

                // Determine what to do based on catch/pass configuration:
                // - catch=true, pass=true: Stop, notify UI, deliver signal on continue
                // - catch=true, pass=false: Stop, notify UI, suppress signal on continue
                // - catch=false, pass=true: Don't stop, deliver signal immediately
                // - catch=false, pass=false: Don't stop, suppress signal (silent ignore)

                if (config.catch_signal)
                {
                    // Catch mode: Get register state for exception info
#if defined(__aarch64__)
                    struct iovec sig_iov;
                    struct user_pt_regs sig_regs;
                    sig_iov.iov_base = &sig_regs;
                    sig_iov.iov_len = sizeof(sig_regs);
                    if (PTRACE_CALL(DYNA_PTRACE_GETREGSET, pid, NT_PRSTATUS, &sig_iov) == 0)
#elif defined(__x86_64__)
                    struct user_regs_struct sig_regs;
                    if (PTRACE_CALL(PTRACE_GETREGS, pid, nullptr, &sig_regs) == 0)
#endif
                    {
                        // Log register values for debugging
#if defined(__x86_64__)
                        debug_log(LOG_INFO,
                                  "Signal %d: registers read - rip=0x%lx, rsp=0x%lx, rax=0x%lx, "
                                  "rbx=0x%lx",
                                  signal, sig_regs.rip, sig_regs.rsp, sig_regs.rax, sig_regs.rbx);
#elif defined(__aarch64__)
                        debug_log(
                            LOG_INFO,
                            "Signal %d: registers read - pc=0x%lx, sp=0x%lx, x0=0x%lx, x1=0x%lx",
                            signal, sig_regs.pc, sig_regs.sp, sig_regs.regs[0], sig_regs.regs[1]);
#endif
                        // Determine exception type based on signal
                        ExceptionType exc_type = EXCEPTION_SIGNAL;
                        switch (signal)
                        {
                            case SIGSEGV:
                                exc_type = EXCEPTION_SIGSEGV;
                                break;
                            case SIGBUS:
                                exc_type = EXCEPTION_SIGBUS;
                                break;
                            case SIGFPE:
                                exc_type = EXCEPTION_SIGFPE;
                                break;
                            case SIGILL:
                                exc_type = EXCEPTION_SIGILL;
                                break;
                            case SIGABRT:
                                exc_type = EXCEPTION_SIGABRT;
                                break;
                            default:
                                exc_type = EXCEPTION_SIGNAL;
                                break;
                        }

                        // Get fault address from siginfo
                        siginfo_t sig_siginfo;
                        memset(&sig_siginfo, 0, sizeof(sig_siginfo));
                        uint64_t fault_addr = 0;
                        if (PTRACE_CALL(PTRACE_GETSIGINFO, pid, nullptr, &sig_siginfo) == 0)
                        {
                            fault_addr = reinterpret_cast<uint64_t>(sig_siginfo.si_addr);
                        }

                        debug_state_ = DebugState::Paused;
                        current_thread = pid;

                        // Store thread state, including pending signal for continue
                        thread_states_[pid].regs = sig_regs;
                        thread_states_[pid].current_breakpoint_index = -1;
                        thread_states_[pid].is_stopped = true;
                        // Store the signal to potentially deliver on continue
                        thread_states_[pid].pending_signal = config.pass_signal ? signal : 0;

                        // Send exception info for signal
                        NativeExceptionInfo exception_info;
                        populate_exception_info(exception_info, sig_regs, exc_type, pid,
                                                fault_addr);
                        exception_info.is_trace = 0;
                        SEND_EXCEPTION_INFO(&exception_info, pid_);

                        debug_log(
                            LOG_INFO, "Signal %d (%s) caught at thread %d (pass=%s), notifying UI",
                            signal, strsignal(signal), pid, config.pass_signal ? "true" : "false");

                        // Leave thread stopped for user to inspect
                        return 0;
                    }
                    else
                    {
                        // PTRACE_GETREGS failed - log error but still try to handle
                        debug_log(LOG_ERROR,
                                  "Failed to get registers for signal %d in thread %d: %s", signal,
                                  pid, strerror(errno));
                    }
                }

                // Not catching: continue immediately
                // Determine signal to pass (0 = suppress, signal = pass)
                // Always pass SIGPWR(30) and SIGXCPU(24) - these are system signals
                int signal_to_pass =
                    (config.pass_signal || signal == 30 || signal == 24) ? signal : 0;

                // Mark thread as running before continuing
                auto thread_it = thread_states_.find(pid);
                if (thread_it != thread_states_.end())
                {
                    thread_it->second.is_stopped = false;
                }

                // If thread was in single step mode, use PTRACE_SINGLESTEP to preserve the step
                // Otherwise the single step would be cancelled
                bool use_single_step = false;
                if (thread_it != thread_states_.end() &&
                    thread_it->second.single_step_mode != SingleStepMode::None)
                {
                    use_single_step = true;
                    debug_log(
                        LOG_INFO,
                        "Thread %d in single step mode, using PTRACE_SINGLESTEP for signal %d", pid,
                        signal);
                }

                // Continue execution (pass or suppress the signal)
                int continue_req = use_single_step ? PTRACE_SINGLESTEP : PTRACE_CONT;
                if (PTRACE_CALL(continue_req, pid, nullptr, (void*)(long)signal_to_pass) == -1)
                {
                    debug_log(LOG_ERROR, "Failed to continue thread %d with signal %d: %s", pid,
                              signal_to_pass, strerror(errno));
                    // Restore stopped state on failure
                    if (thread_it != thread_states_.end())
                    {
                        thread_it->second.is_stopped = true;
                    }
                    return -1;
                }
                return 0;
            }
        }

        // All signals during hardware register access should leave threads stopped
        // Manual continuation will be done after register operations complete
    }
    else if (WIFEXITED(status))
    {
        attached_threads_.erase(pid);
        thread_states_.erase(pid);
    }

    return 0;
}

int Debugger::continue_execution(pid_t thread_id)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::ContinueExecution);
    request->thread_id = thread_id;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::continue_execution_internal(pid_t thread_id)
{
    auto thread_it = thread_states_.find(thread_id);
    if (thread_it == thread_states_.end())
    {
        // If debug state is already Running, thread was likely already resumed
        // This can happen when multiple threads are continued in a batch
        if (debug_state_ == DebugState::Running)
        {
            return 0;
        }
        debug_log(LOG_ERROR, "Thread %d not found in break state", thread_id);
        return -1;
    }

    // Check if thread is actually stopped (like darwin)
    if (!thread_it->second.is_stopped)
    {
        return -1;
    }

    if (attached_threads_.count(thread_id) == 0)
    {
        debug_log(LOG_ERROR, "Thread %d is not attached", thread_id);
        return -1;
    }

    // Check if we're at a software breakpoint - if so, we need to single step over it first
    int sw_bp_index = thread_it->second.disabled_watchpoint_index;
    if (sw_bp_index >= 1000)
    {
        int actual_sw_index = sw_bp_index - 1000;
        debug_log(LOG_INFO,
                  "Continuing from software breakpoint (index %d), need to single step first",
                  actual_sw_index);

        // Get current PC
        uint64_t current_pc = 0;
#if defined(__aarch64__)
        current_pc = thread_it->second.regs.pc;
#elif defined(__x86_64__)
        current_pc = thread_it->second.regs.rip;
#endif

        // Temporarily restore the original instruction
        {
            std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
            if (actual_sw_index >= 0 && actual_sw_index < MAX_SOFTWARE_BREAKPOINTS &&
                software_breakpoint_used[actual_sw_index])
            {
                uint64_t bp_addr = software_breakpoint_addresses[actual_sw_index];
                if (bp_addr == current_pc)
                {
                    // Read current memory word
                    errno = 0;
                    long word = ptrace(PTRACE_PEEKDATA, pid_, (void*)current_pc, nullptr);
                    if (errno == 0)
                    {
                        // Get original bytes
                        uint8_t original_bytes[4] = {0};
                        size_t offset = actual_sw_index * 4;
#if defined(__aarch64__)
                        const size_t bp_size = 4;
#elif defined(__x86_64__)
                        const size_t bp_size = 1;
#endif
                        for (size_t j = 0; j < bp_size; j++)
                        {
                            original_bytes[j] = software_breakpoint_original_bytes[offset + j];
                        }

                        // Restore original instruction
#if defined(__aarch64__)
                        uint32_t original_instruction;
                        memcpy(&original_instruction, original_bytes, 4);
                        long restored_word = (word & ~0xFFFFFFFFUL) | original_instruction;
#elif defined(__x86_64__)
                        long restored_word = (word & ~0xFFUL) | original_bytes[0];
#endif
                        if (ptrace(PTRACE_POKEDATA, pid_, (void*)current_pc,
                                   (void*)restored_word) == 0)
                        {
                            debug_log(
                                LOG_INFO,
                                "Temporarily restored original instruction at 0x%lx for continue",
                                current_pc);
                        }
                    }
                }
            }
        }

        // Set up single step mode to re-insert breakpoint after step and continue
        thread_it->second.single_step_mode = SingleStepMode::SoftwareBreakpointContinue;
        thread_it->second.single_step_count = 0;
        thread_it->second.is_stopped = false;
        thread_it->second.stopped_by_user = false;  // Clear user suspend flag on continue

        // Single step first
        int signal_to_pass = thread_it->second.pending_signal;
        thread_it->second.pending_signal = 0;

        debug_state_ = DebugState::SingleStepping;

        if (PTRACE_CALL(PTRACE_SINGLESTEP, thread_id, nullptr, (void*)(long)signal_to_pass) == -1)
        {
            debug_log(LOG_ERROR, "Failed to single step thread %d from software breakpoint: %s",
                      thread_id, strerror(errno));
            return -1;
        }

        return 0;
    }

    // Resume only this specific thread (consistent with darwin behavior)
    int signal_to_pass = thread_it->second.pending_signal;
    thread_it->second.pending_signal = 0;  // Clear after use

    if (PTRACE_CALL(PTRACE_CONT, thread_id, nullptr, (void*)(long)signal_to_pass) == -1)
    {
        debug_log(LOG_ERROR, "Failed to resume thread %d: %s", thread_id, strerror(errno));
        return -1;
    }

    // Mark thread as running (consistent with darwin)
    thread_it->second.is_stopped = false;
    thread_it->second.stopped_by_user = false;  // Clear user suspend flag on continue

    if (signal_to_pass != 0)
    {
        debug_log(LOG_INFO, "Thread %d resumed with signal %d (%s)", thread_id, signal_to_pass,
                  strsignal(signal_to_pass));
    }

    // If this was the current thread, check if any other threads are still stopped
    if (current_thread == thread_id)
    {
        bool any_stopped = false;
        for (const auto& state_pair : thread_states_)
        {
            if (state_pair.second.is_stopped)
            {
                any_stopped = true;
                break;
            }
        }

        // Only reset global state if no other threads are stopped
        if (!any_stopped)
        {
            debug_state_ = DebugState::Running;
            current_thread = 0;
        }
    }

    return 0;
}

int Debugger::single_step(pid_t thread_id)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::SingleStep);
    request->thread_id = thread_id;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::single_step_internal(pid_t thread_id)
{
    auto thread_it = thread_states_.find(thread_id);
    if (thread_it == thread_states_.end())
    {
        debug_log(LOG_ERROR, "Thread %d not found in break state", thread_id);
        return -1;
    }

    if (attached_threads_.count(thread_id) == 0)
    {
        debug_log(LOG_ERROR, "Thread %d is not attached", thread_id);
        return -1;
    }

    // Check if thread is actually stopped (like continue_execution_internal)
    if (!thread_it->second.is_stopped)
    {
        debug_log(LOG_ERROR, "Thread %d is not stopped (cannot single step a running thread)",
                  thread_id);
        return -1;
    }

    // Get current PC to check for software breakpoint
    uint64_t current_pc = 0;
#if defined(__aarch64__)
    struct iovec iov;
    struct user_pt_regs regs;
    iov.iov_base = &regs;
    iov.iov_len = sizeof(regs);
    if (PTRACE_CALL(DYNA_PTRACE_GETREGSET, thread_id, NT_PRSTATUS, &iov) == 0)
    {
        current_pc = regs.pc;
    }
#elif defined(__x86_64__)
    struct user_regs_struct regs;
    if (PTRACE_CALL(PTRACE_GETREGS, thread_id, nullptr, &regs) == 0)
    {
        current_pc = regs.rip;
    }
#endif

    // Check if there's a software breakpoint at current PC and temporarily restore original
    // instruction
    int software_bp_index = -1;
    if (current_pc != 0)
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
        {
            if (software_breakpoint_used[i] && software_breakpoint_addresses[i] == current_pc)
            {
                software_bp_index = i;
                debug_log(LOG_DEBUG,
                          "Software breakpoint found at PC 0x%lx (index %d), temporarily restoring "
                          "original instruction for single step",
                          current_pc, i);

                // Restore original instruction
#if defined(__aarch64__)
                const size_t bp_size = 4;
#elif defined(__x86_64__)
                const size_t bp_size = 1;
#endif
                // Read current memory word
                errno = 0;
                long word = ptrace(PTRACE_PEEKDATA, pid_, (void*)current_pc, nullptr);
                if (errno != 0)
                {
                    debug_log(LOG_ERROR,
                              "Failed to read memory at 0x%lx for software breakpoint restore: %s",
                              current_pc, strerror(errno));
                }
                else
                {
                    // Get original bytes from storage
                    uint8_t original_bytes[4] = {0};
                    size_t offset = i * 4;  // 4 bytes per breakpoint in storage
                    for (size_t j = 0; j < bp_size; j++)
                    {
                        original_bytes[j] = software_breakpoint_original_bytes[offset + j];
                    }

                    // Restore original bytes
#if defined(__aarch64__)
                    uint32_t original_instruction;
                    memcpy(&original_instruction, original_bytes, 4);
                    long restored_word = (word & ~0xFFFFFFFFUL) | original_instruction;
#elif defined(__x86_64__)
                    long restored_word = (word & ~0xFFUL) | original_bytes[0];
#endif
                    if (ptrace(PTRACE_POKEDATA, pid_, (void*)current_pc, (void*)restored_word) ==
                        -1)
                    {
                        debug_log(LOG_ERROR, "Failed to restore original instruction at 0x%lx: %s",
                                  current_pc, strerror(errno));
                    }
                    else
                    {
                        debug_log(
                            LOG_DEBUG,
                            "Temporarily restored original instruction at 0x%lx for single step",
                            current_pc);
                        // Store the index so we can re-insert the breakpoint after single step
                        thread_it->second.disabled_watchpoint_index =
                            software_bp_index +
                            1000;  // Use offset to distinguish from watchpoint index
                    }
                }
                break;
            }
        }
    }

    // Temporarily disable the current breakpoint to avoid re-triggering during single step
    int bp_index = thread_it->second.current_breakpoint_index;
    if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
    {
#if defined(__aarch64__)
        struct user_hwdebug_state bp_state;
        memset(&bp_state, 0, sizeof(bp_state));
        struct iovec iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

        // Get current breakpoint state
        if (ptrace(PTRACE_GETREGSET, thread_id, NT_ARM_HW_BREAK, &iov) == 0)
        {
            // Disable the specific breakpoint temporarily
            bp_state.dbg_regs[bp_index].ctrl = 0;

            if (ptrace(PTRACE_SETREGSET, thread_id, NT_ARM_HW_BREAK, &iov) == -1)
            {
                debug_log(LOG_ERROR, "Failed to disable breakpoint %d for single step: %s",
                          bp_index, strerror(errno));
            }
        }
        else
        {
            debug_log(LOG_ERROR, "Failed to get breakpoint state for single step: %s",
                      strerror(errno));
        }
#elif defined(__x86_64__)
        // x86_64: Disable hardware breakpoint by clearing DR7 enable bits
        unsigned long dr7 =
            ptrace((__ptrace_request)PTRACE_PEEKUSER, thread_id, X86_DR7_OFFSET, nullptr);
        // Clear local enable bit for this breakpoint
        dr7 &= ~(1UL << (bp_index * 2));
        if (ptrace((__ptrace_request)PTRACE_POKEUSER, thread_id, X86_DR7_OFFSET, (void*)dr7) == -1)
        {
            debug_log(LOG_ERROR, "Failed to disable breakpoint %d for single step: %s", bp_index,
                      strerror(errno));
        }
#endif
    }

    // Set debug state before single stepping
    if (current_thread == thread_id)
    {
        debug_state_ = DebugState::SingleStepping;
    }

    // Update single step mode if not already set
    if (thread_it->second.single_step_mode == SingleStepMode::None)
    {
        thread_it->second.single_step_mode = SingleStepMode::Breakpoint;
    }
    thread_it->second.single_step_count = 0;

    // Mark thread as no longer stopped before single stepping
    thread_it->second.is_stopped = false;

    // Get pending signal to deliver during single step (for pass_signal=true)
    int signal_to_pass = thread_it->second.pending_signal;
    thread_it->second.pending_signal = 0;  // Clear after use

    if (signal_to_pass != 0)
    {
        debug_log(LOG_INFO, "Single stepping thread %d with signal %d (%s)", thread_id,
                  signal_to_pass, strsignal(signal_to_pass));
    }

    if (PTRACE_CALL(PTRACE_SINGLESTEP, thread_id, nullptr, (void*)(long)signal_to_pass) == -1)
    {
        debug_log(LOG_ERROR, "Failed to single step thread %d: %s", thread_id, strerror(errno));
        return -1;
    }
    return 0;
}

int Debugger::handle_single_step(pid_t thread)
{
    auto thread_it = thread_states_.find(thread);
    if (thread_it == thread_states_.end())
    {
        debug_log(LOG_ERROR, "Thread %d not found in single step state", thread);
        return -1;
    }

    switch (thread_it->second.single_step_mode)
    {
        case SingleStepMode::Watchpoint:
            return complete_watchpoint_single_step(thread);
        case SingleStepMode::Breakpoint:
        case SingleStepMode::SoftwareBreakpointContinue:
            return continue_breakpoint_single_step(thread);
        default:
            debug_log(LOG_ERROR, "Unknown single step mode for thread %d", thread);
            return -1;
    }
}

int Debugger::complete_watchpoint_single_step(pid_t thread)
{
    auto thread_it = thread_states_.find(thread);
    if (thread_it == thread_states_.end())
    {
        debug_log(LOG_ERROR, "Thread %d not found in watchpoint single step state", thread);
        return -1;
    }

    // Decrement handler count (detected by polling)
    int wp_index = thread_it->second.disabled_watchpoint_index;
    if (wp_index >= 0 && wp_index < MAX_WATCHPOINTS)
    {
        watchpoint_sync_[wp_index].active_handlers.fetch_sub(1);
    }

    // Clear single step mode and restoration info
    // Keep is_stopped = true because thread is still stopped after PTRACE_SINGLESTEP completion
    thread_it->second.single_step_mode = SingleStepMode::None;
    thread_it->second.original_wcr = 0;
    thread_it->second.disabled_watchpoint_index = -1;
    thread_it->second.is_stopped = false;  // Thread is still stopped after single step

    // Enqueue command to reapply all watchpoints to all threads
    // Pass the thread ID so stop_all_threads won't send PTRACE_INTERRUPT to it
    // (it's already stopped temporarily for reapply, but should be resumed after)
    auto request = std::make_shared<DebugRequest>(DebugCommand::ReapplyWatchpoints);
    request->thread_id = thread;
    enqueue_command(request);

    return 0;
}

int Debugger::continue_breakpoint_single_step(pid_t thread)
{
    auto thread_it = thread_states_.find(thread);
    if (thread_it == thread_states_.end())
    {
        debug_log(LOG_ERROR, "Thread %d not found in breakpoint single step state", thread);
        return -1;
    }

    int bp_index = thread_it->second.current_breakpoint_index;
    SingleStepMode step_mode = thread_it->second.single_step_mode;

    if (bp_index < 0 || bp_index >= MAX_BREAKPOINTS)
    {
        // bp_index == -1 is normal for non-hardware-breakpoint single steps (e.g., spawn, or
        // software breakpoint) Re-insert software breakpoint if it was temporarily removed
        if (thread_it->second.disabled_watchpoint_index >= 1000)
        {
            int sw_bp_index = thread_it->second.disabled_watchpoint_index - 1000;
            std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
            if (sw_bp_index >= 0 && sw_bp_index < MAX_SOFTWARE_BREAKPOINTS &&
                software_breakpoint_used[sw_bp_index])
            {
                uint64_t bp_addr = software_breakpoint_addresses[sw_bp_index];
                debug_log(LOG_DEBUG,
                          "Re-inserting software breakpoint at 0x%lx after single step (no hw bp)",
                          bp_addr);

                errno = 0;
                long word = ptrace(PTRACE_PEEKDATA, pid_, (void*)bp_addr, nullptr);
                if (errno == 0)
                {
#if defined(__aarch64__)
                    const uint32_t brk_instruction = 0xD4200000;  // BRK #0
                    long patched_word = (word & ~0xFFFFFFFFUL) | brk_instruction;
#elif defined(__x86_64__)
                    const uint8_t brk_instruction = 0xCC;  // INT3
                    long patched_word = (word & ~0xFFUL) | brk_instruction;
#endif
                    if (ptrace(PTRACE_POKEDATA, pid_, (void*)bp_addr, (void*)patched_word) == 0)
                    {
                        // debug_log(LOG_DEBUG, "Software breakpoint re-inserted at 0x%lx", bp_addr);
                    }
                }
            }
            thread_it->second.disabled_watchpoint_index = -1;
        }

        // Reset single step mode
        thread_it->second.single_step_mode = SingleStepMode::None;
        thread_it->second.current_breakpoint_index = -1;

        // If this was a software breakpoint continue, resume execution
        if (step_mode == SingleStepMode::SoftwareBreakpointContinue)
        {
            debug_log(LOG_INFO, "Continuing execution after software breakpoint step-over");
            thread_it->second.is_stopped = false;
            debug_state_ = DebugState::Running;

            if (PTRACE_CALL(PTRACE_CONT, thread, nullptr, nullptr) == -1)
            {
                debug_log(LOG_ERROR, "Failed to continue after software breakpoint: %s",
                          strerror(errno));
                return -1;
            }
            return 0;
        }

        // Just reset state and return success (for user-initiated single step)
        thread_it->second.is_stopped = true;  // Mark as stopped (back in break state)
        debug_state_ = DebugState::BreakpointHit;
        return 0;
    }

    // Get target_count and increment hit count (for single-step counting)
    int target_count = 0;
    int current_hit_count = 0;
    {
        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
        target_count = breakpoint_target_counts[bp_index];
        breakpoint_hit_counts[bp_index]++;
        current_hit_count = breakpoint_hit_counts[bp_index];
    }

    // Check if trace mode is complete
    if (target_count > 0 && current_hit_count >= target_count)
    {
        // Trace complete: remove breakpoint and let execution continue

#if defined(__aarch64__)
        // Breakpoint is already disabled from initial hit, ensure it stays disabled
        struct user_hwdebug_state bp_state;
        memset(&bp_state, 0, sizeof(bp_state));
        struct iovec iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

        if (ptrace(PTRACE_GETREGSET, thread, NT_ARM_HW_BREAK, &iov) == 0)
        {
            bp_state.dbg_regs[bp_index].ctrl = 0;
            bp_state.dbg_regs[bp_index].addr = 0;
            ptrace(PTRACE_SETREGSET, thread, NT_ARM_HW_BREAK, &iov);
        }
#elif defined(__x86_64__)
        // x86_64: Clear the hardware breakpoint
        unsigned long dr7 =
            ptrace((__ptrace_request)PTRACE_PEEKUSER, thread, X86_DR7_OFFSET, nullptr);
        dr7 &= ~(1UL << (bp_index * 2));  // Clear local enable bit
        ptrace((__ptrace_request)PTRACE_POKEUSER, thread, X86_DR7_OFFSET, (void*)dr7);
        ptrace((__ptrace_request)PTRACE_POKEUSER, thread, x86_dr_offset(bp_index), (void*)0);
#endif

        // Clean up thread state
        thread_it->second.single_step_mode = SingleStepMode::None;
        thread_it->second.single_step_count = 0;
        thread_it->second.is_stopped = false;  // Mark as not stopped before continuing

        // Remove breakpoint data
        {
            std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
            breakpoint_used[bp_index] = false;
            breakpoint_addresses[bp_index] = 0;
            breakpoint_hit_counts[bp_index] = 0;
            breakpoint_target_counts[bp_index] = 0;
        }

        debug_state_ = DebugState::Running;
        current_thread = 0;

        // Continue execution (don't suspend)
        if (PTRACE_CALL(PTRACE_CONT, thread, nullptr, nullptr) == -1)
        {
            debug_log(LOG_ERROR, "Failed to continue thread %d after trace complete: %s", thread,
                      strerror(errno));
            return -1;
        }

        return 0;
    }

    // Trace mode: continue single-stepping
    if (target_count > 0 && current_hit_count < target_count)
    {
        debug_state_ = DebugState::SingleStepping;

        if (PTRACE_CALL(PTRACE_SINGLESTEP, thread, nullptr, nullptr) == -1)
        {
            debug_log(LOG_ERROR, "Failed to continue single step for thread %d: %s", thread,
                      strerror(errno));
            return -1;
        }

        return 0;
    }

    // Wait mode (target_count == 0): return to break state
    // Re-enable the breakpoint that was temporarily disabled
#if defined(__aarch64__)
    struct user_hwdebug_state bp_state;
    memset(&bp_state, 0, sizeof(bp_state));
    struct iovec iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

    if (ptrace(PTRACE_GETREGSET, thread, NT_ARM_HW_BREAK, &iov) == 0)
    {
        bp_state.dbg_regs[bp_index].addr = breakpoint_addresses[bp_index];
        bp_state.dbg_regs[bp_index].ctrl =
            encode_ctrl_reg(0, ARM_BREAKPOINT_LEN_4, ARM_BREAKPOINT_EXECUTE, 0, 1);

        if (ptrace(PTRACE_SETREGSET, thread, NT_ARM_HW_BREAK, &iov) == 0)
        {
        }
        else
        {
            debug_log(LOG_ERROR, "Failed to re-enable breakpoint %d: %s", bp_index,
                      strerror(errno));
        }
    }
#elif defined(__x86_64__)
    // x86_64: Re-enable the hardware breakpoint
    unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, thread, X86_DR7_OFFSET, nullptr);
    dr7 |= (1UL << (bp_index * 2));  // Set local enable bit
    // Set condition (execution) and length (1 byte for exec)
    int shift = 16 + bp_index * 4;
    dr7 &= ~(0xFUL << shift);
    dr7 |= ((X86_DR7_BREAK_ON_EXEC | (X86_DR7_LEN_1 << 2)) << shift);
    ptrace((__ptrace_request)PTRACE_POKEUSER, thread, X86_DR7_OFFSET, (void*)dr7);
#endif

    // Re-insert software breakpoint if it was temporarily removed
    if (thread_it->second.disabled_watchpoint_index >= 1000)
    {
        int sw_bp_index = thread_it->second.disabled_watchpoint_index - 1000;
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        if (sw_bp_index >= 0 && sw_bp_index < MAX_SOFTWARE_BREAKPOINTS &&
            software_breakpoint_used[sw_bp_index])
        {
            uint64_t bp_addr = software_breakpoint_addresses[sw_bp_index];

            // Read current memory word
            errno = 0;
            long word = ptrace(PTRACE_PEEKDATA, pid_, (void*)bp_addr, nullptr);
            if (errno == 0)
            {
#if defined(__aarch64__)
                const uint32_t brk_instruction = 0xD4200000;  // BRK #0
                long patched_word = (word & ~0xFFFFFFFFUL) | brk_instruction;
#elif defined(__x86_64__)
                const uint8_t brk_instruction = 0xCC;  // INT3
                long patched_word = (word & ~0xFFUL) | brk_instruction;
#endif
                if (ptrace(PTRACE_POKEDATA, pid_, (void*)bp_addr, (void*)patched_word) == 0)
                {
                    // debug_log(LOG_INFO, "Software breakpoint re-inserted at 0x%lx", bp_addr);
                }
                else
                {
                    debug_log(LOG_ERROR, "Failed to re-insert software breakpoint at 0x%lx: %s",
                              bp_addr, strerror(errno));
                }
            }
        }
        thread_it->second.disabled_watchpoint_index = -1;
    }

    thread_it->second.single_step_mode = SingleStepMode::None;
    thread_it->second.single_step_count = 0;
    thread_it->second.is_stopped = true;  // Mark as stopped (back in break state)
    debug_state_ = DebugState::BreakpointHit;
    return 0;
}
