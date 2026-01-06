/**
 * @file debugger_watchpoint.cpp
 * @brief Watchpoint-related member functions for the Debugger class
 *
 * This file contains all watchpoint management functionality including:
 * - Hardware watchpoint set/remove operations
 * - Watchpoint hit handling
 * - Thread-specific watchpoint application
 * - Watchpoint reapplication after single-step
 *
 * Part of the DynaDbg Linux debugger implementation.
 */

#include "debugger_internal.h"

// =============================================================================
// Public Watchpoint API
// =============================================================================

int Debugger::set_watchpoint(uint64_t address, int size, WatchpointType type)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::SetWatchpoint);
    request->address = address;
    request->size = size;
    request->watchpoint_type = type;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::remove_watchpoint(uint64_t address)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::RemoveWatchpoint);
    request->address = address;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

// =============================================================================
// Internal Watchpoint Operations
// =============================================================================

int Debugger::set_watchpoint_internal(uint64_t address, int size, WatchpointType type)
{
    int index = find_free_watchpoint();
    if (index == -1)
    {
        debug_log(LOG_ERROR, "No free watchpoints available");
        return -1;
    }

    // Step 1: Stop all threads, tracking which were already stopped
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(0, &already_stopped);
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for watchpoint setup");
        return -1;
    }

    // Step 2: Apply watchpoint to all stopped threads
    bool success = apply_watchpoint_to_threads(stopped_threads, index, address, size, type);

    // Step 3: Resume only threads that were NOT already stopped before this call
    std::set<pid_t> already_stopped_set(already_stopped.begin(), already_stopped.end());
    std::vector<pid_t> threads_to_resume;
    for (pid_t tid : stopped_threads)
    {
        if (already_stopped_set.find(tid) == already_stopped_set.end())
        {
            threads_to_resume.push_back(tid);
        }
    }
    resume_threads(threads_to_resume);

    if (success)
    {
        std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
        watchpoint_used[index] = true;
        watchpoint_addresses[index] = address;
        watchpoint_sizes[index] = size;
        watchpoint_types[index] = type;

        return 0;
    }
    else
    {
        debug_log(LOG_ERROR, "Failed to apply watchpoint to threads");
        return -1;
    }
}

int Debugger::remove_watchpoint_internal(uint64_t address)
{
    int index = find_watchpoint_index(address);
    if (index == -1)
    {
        debug_log(LOG_ERROR, "Watchpoint not found at address 0x%lx", address);
        return -1;
    }

    // Set the removal flag for this watchpoint
    watchpoint_sync_[index].removing.store(true);
    removing_mask_.fetch_or(1U << index);

    // Wait for any in-progress hit handlers on this watchpoint to complete
    // Use polling instead of pthread_cond_clockwait for compatibility
    {
        const int max_wait_ms = 1000;
        const int poll_interval_ms = 10;
        int waited_ms = 0;

        while (watchpoint_sync_[index].active_handlers.load() > 0 && waited_ms < max_wait_ms)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(poll_interval_ms));
            waited_ms += poll_interval_ms;
        }

        if (watchpoint_sync_[index].active_handlers.load() > 0)
        {
            debug_log(
                LOG_WARN,
                "Timeout waiting for watchpoint %d handlers (count: %d), proceeding with removal",
                index, watchpoint_sync_[index].active_handlers.load());
        }
    }

    // Step 1: Stop all threads, tracking which were already stopped
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(0, &already_stopped);
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for watchpoint removal");
        watchpoint_sync_[index].removing.store(false);
        removing_mask_.fetch_and(~(1U << index));
        return -1;
    }

    // Step 2: Clear watchpoint from all stopped threads
    bool success = clear_watchpoint_from_threads(stopped_threads, index);

    // Step 3: Resume only threads that were NOT already stopped before this call
    std::set<pid_t> already_stopped_set(already_stopped.begin(), already_stopped.end());
    std::vector<pid_t> threads_to_resume;
    for (pid_t tid : stopped_threads)
    {
        if (already_stopped_set.find(tid) == already_stopped_set.end())
        {
            threads_to_resume.push_back(tid);
        }
    }
    resume_threads(threads_to_resume);

    // Cleanup
    watchpoint_sync_[index].removing.store(false);
    removing_mask_.fetch_and(~(1U << index));

    if (success)
    {
        std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
        watchpoint_used[index] = false;
        watchpoint_addresses[index] = 0;
        watchpoint_sizes[index] = 0;

        return 0;
    }
    else
    {
        debug_log(LOG_ERROR, "Failed to clear watchpoint from threads");
        return -1;
    }
}

// =============================================================================
// Watchpoint Lookup Functions
// =============================================================================

int Debugger::find_free_watchpoint()
{
    std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
    for (int i = 0; i < MAX_WATCHPOINTS; i++)
    {
        if (!watchpoint_used[i])
        {
            return i;
        }
    }
    return -1;
}

int Debugger::find_watchpoint_index(uint64_t address)
{
    std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
    for (int i = 0; i < MAX_WATCHPOINTS; i++)
    {
        if (watchpoint_used[i] && watchpoint_addresses[i] == address)
        {
            return i;
        }
    }
    return -1;
}

// =============================================================================
// Watchpoint Helper Functions
// =============================================================================

int Debugger::get_available_watchpoints(pid_t thread)
{
    return MAX_WATCHPOINTS;
}

int Debugger::set_watchpoint_on_thread(pid_t thread, uint64_t address, int size,
                                       WatchpointType type, int index)
{
    return 0;
}

int Debugger::clear_watchpoint_on_thread(pid_t thread, int index)
{
    return 0;
}

int Debugger::remove_watchpoint_by_index(int index)
{
    return 0;
}

// =============================================================================
// Watchpoint Hit Handling
// =============================================================================

int Debugger::handle_watchpoint_hit(pid_t thread, int watchpoint_index)
{
    // Check if watchpoint is being removed using bitmask
    if (removing_mask_.load() & (1U << watchpoint_index))
    {
        // Thread must be resumed even during removal
        if (PTRACE_CALL(PTRACE_CONT, thread, nullptr, nullptr) == -1)
        {
            debug_log(LOG_ERROR, "Failed to continue thread %d after ignored watchpoint: %s",
                      thread, strerror(errno));
        }
        return 0;
    }

    // Increment handler count
    watchpoint_sync_[watchpoint_index].active_handlers.fetch_add(1);

#if defined(__aarch64__)
    // For Linux ARM64, we'll temporarily disable the watchpoint using hardware debug registers
    struct user_hwdebug_state wp_state;
    memset(&wp_state, 0, sizeof(wp_state));

    // Set proper iov length: 8 bytes header + 16 bytes per watchpoint * MAX_WATCHPOINTS
    struct iovec iov = {.iov_base = &wp_state, .iov_len = 8 + 16 * MAX_WATCHPOINTS};

    // Get current watchpoint state
    if (ptrace(PTRACE_GETREGSET, thread, NT_ARM_HW_WATCH, &iov) == -1)
    {
        debug_log(LOG_ERROR, "Failed to get hardware watchpoint state for thread %d: %s", thread,
                  strerror(errno));
        // Decrement handler count
        watchpoint_sync_[watchpoint_index].active_handlers.fetch_sub(1);
        return -1;
    }

    // Store original control register value and watchpoint index for restoration
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        thread_states_[thread].original_wcr = wp_state.dbg_regs[watchpoint_index].ctrl;
        thread_states_[thread].disabled_watchpoint_index = watchpoint_index;
    }

    // Temporarily disable the watchpoint that was hit
    wp_state.dbg_regs[watchpoint_index].ctrl = 0;

    // Apply the modified state
    if (ptrace(PTRACE_SETREGSET, thread, NT_ARM_HW_WATCH, &iov) == -1)
    {
        debug_log(LOG_ERROR, "Failed to disable watchpoint %d for thread %d: %s", watchpoint_index,
                  thread, strerror(errno));
    }
#elif defined(__x86_64__)
    // x86_64: Temporarily disable the watchpoint using debug registers
    unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, thread, X86_DR7_OFFSET, nullptr);

    // Store original DR7 for restoration
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        thread_states_[thread].original_wcr = static_cast<uint32_t>(dr7 & 0xFFFFFFFF);
        thread_states_[thread].disabled_watchpoint_index = watchpoint_index;
    }

    // Clear local enable bit for this watchpoint
    dr7 &= ~(1UL << (watchpoint_index * 2));
    if (ptrace((__ptrace_request)PTRACE_POKEUSER, thread, X86_DR7_OFFSET, (void*)dr7) == -1)
    {
        debug_log(LOG_ERROR, "Failed to disable watchpoint %d for thread %d: %s", watchpoint_index,
                  thread, strerror(errno));
    }
#endif

    // Set thread-specific single step mode to re-enable watchpoint after one instruction
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        thread_states_[thread].single_step_mode = SingleStepMode::Watchpoint;
        thread_states_[thread].single_step_count = 0;
        thread_states_[thread].current_breakpoint_index = -1;
        thread_states_[thread].is_stopped = false;  // Mark as no longer stopped before single step
    }

    // Enable single step for one instruction
    if (PTRACE_CALL(PTRACE_SINGLESTEP, thread, nullptr, nullptr) == -1)
    {
        debug_log(LOG_ERROR, "Failed to enable single step for thread %d", thread);
        // Decrement handler count
        watchpoint_sync_[watchpoint_index].active_handlers.fetch_sub(1);
        return -1;
    }

    return 0;
}

// =============================================================================
// Thread-Specific Watchpoint Operations
// =============================================================================

bool Debugger::apply_watchpoint_to_threads(const std::vector<pid_t>& threads, int index,
                                           uint64_t address, int size, WatchpointType type)
{
    for (pid_t tid : threads)
    {
#if defined(__aarch64__)
        struct user_hwdebug_state wp_state;
        memset(&wp_state, 0, sizeof(wp_state));

        // Set proper iov length: 8 bytes header + 16 bytes per watchpoint * MAX_WATCHPOINTS
        struct iovec iov = {.iov_base = &wp_state, .iov_len = 8 + 16 * MAX_WATCHPOINTS};

        // Get current watchpoint state using ARM64 hardware watchpoint regset
        if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_WATCH, &iov) == -1)
        {
            debug_log(LOG_ERROR, "Failed to get hardware watchpoint state for thread %d: %s", tid,
                      strerror(errno));
            continue;
        }

        // Re-enable existing watchpoints that have addresses set
        for (int i = 0; i < MAX_WATCHPOINTS; i++)
        {
            if (wp_state.dbg_regs[i].addr != 0)
            {
                wp_state.dbg_regs[i].ctrl = wp_state.dbg_regs[i].ctrl | 1;
            }
        }

        // Determine watchpoint length encoding based on size
        uint32_t arm_length;
        if (size <= 1)
            arm_length = ARM_BREAKPOINT_LEN_1;
        else if (size <= 2)
            arm_length = ARM_BREAKPOINT_LEN_2;
        else if (size <= 4)
            arm_length = ARM_BREAKPOINT_LEN_4;
        else
            arm_length = ARM_BREAKPOINT_LEN_8;

        // Determine access type
        int btype;
        switch (type)
        {
            case WatchpointType::READ:
                btype = ARM_BREAKPOINT_LOAD;
                break;
            case WatchpointType::WRITE:
                btype = ARM_BREAKPOINT_STORE;
                break;
            case WatchpointType::READWRITE:
                btype = ARM_BREAKPOINT_STORE | ARM_BREAKPOINT_LOAD;
                break;
            default:
                btype = ARM_BREAKPOINT_RW;
                break;
        }

        // Set watchpoint address and control register
        // encode_ctrl_reg(ssc, bas, lsc, pmc, enabled) - PMC=2 for EL1
        wp_state.dbg_regs[index].addr = address;
        wp_state.dbg_regs[index].ctrl = encode_ctrl_reg(0, arm_length, btype, 2, 1);

        // Apply the watchpoint state using ARM64 hardware watchpoint regset
        if (ptrace(PTRACE_SETREGSET, tid, NT_ARM_HW_WATCH, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to set hardware watchpoint for thread %d: %s", tid,
                      strerror(err));
            return false;
        }
#elif defined(__x86_64__)
        // x86_64: Use debug registers DR0-DR3 for watchpoints
        // Set the address in DR0-DR3 (index)
        if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, x86_dr_offset(index), (void*)address) ==
            -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to set watchpoint address for thread %d: %s", tid,
                      strerror(err));
            return false;
        }

        // Configure DR7
        unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, tid, X86_DR7_OFFSET, nullptr);

        // Determine length encoding for x86_64
        int x86_len;
        if (size <= 1)
            x86_len = X86_DR7_LEN_1;
        else if (size <= 2)
            x86_len = X86_DR7_LEN_2;
        else if (size <= 4)
            x86_len = X86_DR7_LEN_4;
        else
            x86_len = X86_DR7_LEN_8;

        // Determine condition (break type)
        int x86_cond;
        switch (type)
        {
            case WatchpointType::WRITE:
                x86_cond = X86_DR7_BREAK_ON_WRITE;
                break;
            case WatchpointType::READ:
            case WatchpointType::READWRITE:
                x86_cond = X86_DR7_BREAK_ON_RW;
                break;
            default:
                x86_cond = X86_DR7_BREAK_ON_RW;
                break;
        }

        // Set local enable bit for this watchpoint
        dr7 |= (1UL << (index * 2));

        // Clear and set condition and length bits
        int shift = 16 + index * 4;
        dr7 &= ~(0xFUL << shift);
        dr7 |= ((x86_cond | (x86_len << 2)) << shift);

        if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, X86_DR7_OFFSET, (void*)dr7) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to set DR7 for thread %d: %s", tid, strerror(err));
            return false;
        }
#endif
    }
    return true;
}

bool Debugger::apply_watchpoint_to_thread(pid_t tid, int index, uint64_t address, int size,
                                          WatchpointType type)
{
#if defined(__aarch64__)
    struct user_hwdebug_state wp_state;
    memset(&wp_state, 0, sizeof(wp_state));

    struct iovec iov = {.iov_base = &wp_state, .iov_len = 8 + 16 * MAX_WATCHPOINTS};

    if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_WATCH, &iov) == -1)
    {
        debug_log(LOG_ERROR, "Failed to get hardware watchpoint state for thread %d: %s", tid,
                  strerror(errno));
        return false;
    }

    uint32_t arm_length;
    if (size <= 1)
        arm_length = ARM_BREAKPOINT_LEN_1;
    else if (size <= 2)
        arm_length = ARM_BREAKPOINT_LEN_2;
    else if (size <= 4)
        arm_length = ARM_BREAKPOINT_LEN_4;
    else
        arm_length = ARM_BREAKPOINT_LEN_8;

    int btype;
    switch (type)
    {
        case WatchpointType::READ:
            btype = ARM_BREAKPOINT_LOAD;
            break;
        case WatchpointType::WRITE:
            btype = ARM_BREAKPOINT_STORE;
            break;
        case WatchpointType::READWRITE:
            btype = ARM_BREAKPOINT_STORE | ARM_BREAKPOINT_LOAD;
            break;
        default:
            btype = ARM_BREAKPOINT_RW;
            break;
    }

    wp_state.dbg_regs[index].addr = address;
    wp_state.dbg_regs[index].ctrl = encode_ctrl_reg(0, arm_length, btype, 2, 1);

    if (ptrace(PTRACE_SETREGSET, tid, NT_ARM_HW_WATCH, &iov) == -1)
    {
        debug_log(LOG_ERROR, "Failed to set hardware watchpoint for thread %d: %s", tid,
                  strerror(errno));
        return false;
    }
#elif defined(__x86_64__)
    if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, x86_dr_offset(index), (void*)address) == -1)
    {
        debug_log(LOG_ERROR, "Failed to set watchpoint address for thread %d: %s", tid,
                  strerror(errno));
        return false;
    }

    unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, tid, X86_DR7_OFFSET, nullptr);

    uint32_t x86_len;
    if (size <= 1)
        x86_len = X86_DR7_LEN_1;
    else if (size <= 2)
        x86_len = X86_DR7_LEN_2;
    else if (size <= 4)
        x86_len = X86_DR7_LEN_4;
    else
        x86_len = X86_DR7_LEN_8;

    uint32_t x86_type;
    switch (type)
    {
        case WatchpointType::WRITE:
            x86_type = X86_DR7_BREAK_ON_WRITE;
            break;
        case WatchpointType::READ:
        case WatchpointType::READWRITE:
        default:
            x86_type = X86_DR7_BREAK_ON_RW;
            break;
    }

    dr7 |= (1UL << (index * 2));
    int shift = 16 + index * 4;
    dr7 &= ~(0xFUL << shift);
    dr7 |= ((x86_type | (x86_len << 2)) << shift);

    if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, X86_DR7_OFFSET, (void*)dr7) == -1)
    {
        debug_log(LOG_ERROR, "Failed to set DR7 for watchpoint on thread %d: %s", tid,
                  strerror(errno));
        return false;
    }
#endif

    return true;
}

bool Debugger::clear_watchpoint_from_threads(const std::vector<pid_t>& threads, int index)
{
    for (pid_t tid : threads)
    {
#if defined(__aarch64__)
        struct user_hwdebug_state wp_state;
        memset(&wp_state, 0, sizeof(wp_state));

        // Set proper iov length: 8 bytes header + 16 bytes per watchpoint * MAX_WATCHPOINTS
        struct iovec iov = {.iov_base = &wp_state, .iov_len = 8 + 16 * MAX_WATCHPOINTS};

        // Get current watchpoint state using ARM64 hardware watchpoint regset
        if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_WATCH, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to get hardware watchpoint state for thread %d: %s", tid,
                      strerror(err));
            return false;
        }

        // Clear watchpoint control register to disable
        wp_state.dbg_regs[index].ctrl = 0;
        wp_state.dbg_regs[index].addr = 0;

        // Apply the changes using ARM64 hardware watchpoint regset
        if (ptrace(PTRACE_SETREGSET, tid, NT_ARM_HW_WATCH, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to clear hardware watchpoint for thread %d: %s", tid,
                      strerror(err));
            return false;
        }
#elif defined(__x86_64__)
        // x86_64: Clear the debug register for this watchpoint
        if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, x86_dr_offset(index), (void*)0) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to clear watchpoint address for thread %d: %s", tid,
                      strerror(err));
            return false;
        }

        // Clear enable bit in DR7
        unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, tid, X86_DR7_OFFSET, nullptr);
        dr7 &= ~(1UL << (index * 2));  // Clear local enable bit
        // Clear condition and length bits
        int shift = 16 + index * 4;
        dr7 &= ~(0xFUL << shift);

        if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, X86_DR7_OFFSET, (void*)dr7) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to clear DR7 for thread %d: %s", tid, strerror(err));
            return false;
        }
#endif
    }

    return true;
}

// =============================================================================
// Watchpoint Reapplication
// =============================================================================

int Debugger::reapply_all_watchpoints_internal()
{
    return reapply_all_watchpoints_internal(0);
}

int Debugger::reapply_all_watchpoints_internal(pid_t already_stopped_thread)
{
    // Step 1: Stop all threads, tracking which were already stopped
    // Note: already_stopped_thread is the watchpoint hit thread which completed single-step
    // It should be resumed after reapply, so we pass it to stop_all_threads to avoid
    // sending PTRACE_INTERRUPT to it (it's already stopped), but we do NOT add it to
    // already_stopped list because it should be resumed.
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(already_stopped_thread, &already_stopped);

    // Add the watchpoint hit thread to stopped_threads first
    // (it needs watchpoints reapplied too, and should be resumed at the end)
    if (already_stopped_thread != 0)
    {
        bool found = false;
        for (pid_t tid : stopped_threads)
        {
            if (tid == already_stopped_thread)
            {
                found = true;
                break;
            }
        }
        if (!found)
        {
            stopped_threads.push_back(already_stopped_thread);
        }
        // Note: Do NOT add to already_stopped - this thread completed watchpoint handling
        // and should be resumed
    }

    // Now check if we have any threads to work with
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for watchpoint reapplication");
        return -1;
    }

    // Step 2: Reapply all active watchpoints to all stopped threads
    // Skip watchpoints that are being removed
    bool success = true;
    {
        std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
        for (int i = 0; i < MAX_WATCHPOINTS; i++)
        {
            // Skip watchpoints that are being removed
            if (watchpoint_sync_[i].removing.load())
            {
                continue;
            }

            if (watchpoint_used[i])
            {
                if (!apply_watchpoint_to_threads(stopped_threads, i, watchpoint_addresses[i],
                                                 watchpoint_sizes[i], watchpoint_types[i]))
                {
                    debug_log(LOG_ERROR, "Failed to reapply watchpoint %d", i);
                    success = false;
                }
            }
        }
    }

    // Step 3: Resume only threads that were NOT already stopped before this call
    // Threads at breakpoints or other watchpoints should remain stopped
    std::set<pid_t> already_stopped_set(already_stopped.begin(), already_stopped.end());
    std::vector<pid_t> threads_to_resume;
    for (pid_t tid : stopped_threads)
    {
        if (already_stopped_set.find(tid) == already_stopped_set.end())
        {
            threads_to_resume.push_back(tid);
            // Update thread state to running
            std::lock_guard<std::mutex> lock(thread_states_mutex_);
            if (thread_states_.find(tid) != thread_states_.end())
            {
                thread_states_[tid].is_stopped = false;
            }
        }
    }
    resume_threads(threads_to_resume);

    if (!success)
    {
        debug_log(LOG_ERROR, "Failed to reapply some watchpoints");
        return -1;
    }

    return 0;
}
