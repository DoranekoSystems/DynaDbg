/**
 * @file debugger_breakpoint.cpp
 * @brief Breakpoint-related member functions for the Debugger class
 *
 * This file contains all breakpoint management functionality including:
 * - Hardware breakpoint set/remove operations
 * - Software breakpoint set/remove operations
 * - Breakpoint hit handling
 * - Thread-specific breakpoint application
 *
 * Part of the DynaDbg Linux debugger implementation.
 */

#include "debugger_internal.h"

// =============================================================================
// Public Breakpoint API
// =============================================================================

int Debugger::set_breakpoint(uint64_t address, int hit_count, bool is_software)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::SetBreakpoint);
    request->address = address;
    request->hit_count = hit_count;
    request->breakpoint_type = is_software ? BreakpointType::SOFTWARE : BreakpointType::HARDWARE;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::remove_breakpoint(uint64_t address)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::RemoveBreakpoint);
    request->address = address;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

// =============================================================================
// Internal Breakpoint Implementation
// =============================================================================

int Debugger::set_breakpoint_internal(uint64_t address, int hit_count, BreakpointType bp_type)
{
    // Route to appropriate implementation based on breakpoint type
    if (bp_type == BreakpointType::SOFTWARE)
    {
        return set_software_breakpoint_internal(address, hit_count);
    }
    else
    {
        return set_hardware_breakpoint_internal(address, hit_count);
    }
}

int Debugger::set_hardware_breakpoint_internal(uint64_t address, int hit_count)
{
    int index = find_free_breakpoint();
    if (index == -1)
    {
        debug_log(LOG_ERROR, "No free breakpoints available");
        return -1;
    }

    // Step 1: Stop all threads, tracking which were already stopped
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(0, &already_stopped);
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for breakpoint setup");
        return -1;
    }

    // Step 2: Apply breakpoint to all stopped threads
    bool success = apply_breakpoint_to_threads(stopped_threads, index, address);

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
        {
            std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
            breakpoint_used[index] = true;
            breakpoint_addresses[index] = address;
            // hit_count == 0 means wait mode (target_count = 0)
            // hit_count > 0 means trace mode (target_count = hit_count)
            breakpoint_target_counts[index] = hit_count;
            breakpoint_hit_counts[index] = 0;
            breakpoint_types[index] = BreakpointType::HARDWARE;
        }

        return 0;
    }
    else
    {
        debug_log(LOG_ERROR, "Failed to apply breakpoint to threads");
        return -1;
    }
}

int Debugger::set_software_breakpoint_internal(uint64_t address, int hit_count)
{
    // Find free software breakpoint slot
    int index = -1;
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
        {
            if (!software_breakpoint_used[i])
            {
                index = i;
                break;
            }
        }
    }

    if (index == -1)
    {
        debug_log(LOG_ERROR, "No free software breakpoints available");
        return -1;
    }

    // Step 1: Stop all threads, tracking which were already stopped
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(0, &already_stopped);
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for software breakpoint setup");
        return -1;
    }

    // Step 2: Read original instruction bytes
#if defined(__aarch64__)
    const size_t bp_size = 4;                     // ARM64 instructions are 4 bytes
    const uint32_t brk_instruction = 0xD4200000;  // BRK #0
#elif defined(__x86_64__)
    const size_t bp_size = 1;              // x86 INT3 is 1 byte
    const uint8_t brk_instruction = 0xCC;  // INT3
#endif

    uint8_t original_bytes[4] = {0};

    // Read original instruction using PTRACE_PEEKDATA
    errno = 0;
    long word = ptrace(PTRACE_PEEKDATA, pid_, (void*)address, nullptr);
    if (errno != 0)
    {
        debug_log(LOG_ERROR, "Failed to read memory at 0x%lx for software breakpoint: %s", address,
                  strerror(errno));
        // Resume threads
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
        return -1;
    }

    memcpy(original_bytes, &word, bp_size);

    // Step 3: Write breakpoint instruction
#if defined(__aarch64__)
    // Replace first 4 bytes with BRK #0
    uint32_t new_word = brk_instruction;
    // Preserve rest of word if needed (for alignment)
    long patched_word = (word & ~0xFFFFFFFFUL) | new_word;
#elif defined(__x86_64__)
    // Replace first byte with INT3
    long patched_word = (word & ~0xFFUL) | brk_instruction;
#endif

    if (ptrace(PTRACE_POKEDATA, pid_, (void*)address, (void*)patched_word) == -1)
    {
        debug_log(LOG_ERROR, "Failed to write software breakpoint at 0x%lx: %s", address,
                  strerror(errno));
        // Resume threads
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
        return -1;
    }

    // Step 4: Resume threads
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

    // Step 5: Store breakpoint info
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        software_breakpoint_used[index] = true;
        software_breakpoint_addresses[index] = address;
        // Store original bytes (4 bytes per breakpoint)
        memcpy(&software_breakpoint_original_bytes[index * 4], original_bytes, 4);
    }

    // Also register in main breakpoint tracking (for hit detection)
    {
        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
        // Find a hardware breakpoint slot to track this (use negative index or separate tracking)
        // For now, we track software breakpoints separately
    }

    return 0;
}

// =============================================================================
// Remove Breakpoint Functions
// =============================================================================

int Debugger::remove_software_breakpoint_internal(uint64_t address)
{
    // Find the software breakpoint
    int index = -1;
    uint8_t original_bytes[4] = {0};
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
        {
            if (software_breakpoint_used[i] && software_breakpoint_addresses[i] == address)
            {
                index = i;
                memcpy(original_bytes, &software_breakpoint_original_bytes[i * 4], 4);
                break;
            }
        }
    }

    if (index == -1)
    {
        debug_log(LOG_ERROR, "Software breakpoint not found at address 0x%lx", address);
        return -1;
    }

    // Stop all threads
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(0, &already_stopped);
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for software breakpoint removal");
        return -1;
    }

    // Read current memory word
    errno = 0;
    long word = ptrace(PTRACE_PEEKDATA, pid_, (void*)address, nullptr);
    if (errno != 0)
    {
        debug_log(LOG_ERROR, "Failed to read memory at 0x%lx for software breakpoint removal: %s",
                  address, strerror(errno));
        // Resume threads
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
        return -1;
    }

    // Restore original bytes
#if defined(__aarch64__)
    const size_t bp_size = 4;
    uint32_t orig_instr;
    memcpy(&orig_instr, original_bytes, 4);
    long restored_word = (word & ~0xFFFFFFFFUL) | orig_instr;
#elif defined(__x86_64__)
    const size_t bp_size = 1;
    long restored_word = (word & ~0xFFUL) | original_bytes[0];
#endif

    if (ptrace(PTRACE_POKEDATA, pid_, (void*)address, (void*)restored_word) == -1)
    {
        debug_log(LOG_ERROR, "Failed to restore original instruction at 0x%lx: %s", address,
                  strerror(errno));
        // Resume threads
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
        return -1;
    }

    // Resume threads
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

    // Clear disabled_watchpoint_index for any threads that were stopped at this breakpoint
    int full_bp_index = index + 1000;  // Software breakpoint index format
    for (auto& [tid, state] : thread_states_)
    {
        if (state.disabled_watchpoint_index == full_bp_index)
        {
            debug_log(LOG_INFO,
                      "Clearing software breakpoint state for thread %d (breakpoint removed)", tid);
            state.disabled_watchpoint_index = -1;
        }
    }

    // Clear breakpoint info
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        software_breakpoint_used[index] = false;
        software_breakpoint_addresses[index] = 0;
        memset(&software_breakpoint_original_bytes[index * 4], 0, 4);
    }

    return 0;
}

bool Debugger::get_software_breakpoint_original_bytes(uint64_t address, uint8_t* out_bytes,
                                                      size_t* out_size)
{
    std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
    for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
    {
        if (software_breakpoint_used[i] && software_breakpoint_addresses[i] == address)
        {
            memcpy(out_bytes, &software_breakpoint_original_bytes[i * 4], 4);
#if defined(__aarch64__)
            *out_size = 4;
#elif defined(__x86_64__)
            *out_size = 1;
#endif
            return true;
        }
    }
    return false;
}

int Debugger::remove_breakpoint_internal(uint64_t address)
{
    int index = find_breakpoint_index(address);
    if (index == -1)
    {
        debug_log(LOG_ERROR, "Breakpoint not found at address 0x%lx", address);
        return -1;
    }

    // Check if this is a software breakpoint (index >= 1000)
    if (index >= 1000)
    {
        return remove_software_breakpoint_internal(address);
    }

    // Set the removal flag
    breakpoint_sync_[index].removing.store(true);

    // Step 1: Stop all threads, tracking which were already stopped
    std::vector<pid_t> already_stopped;
    std::vector<pid_t> stopped_threads = stop_all_threads(0, &already_stopped);
    if (stopped_threads.empty())
    {
        debug_log(LOG_ERROR, "Failed to stop any threads for breakpoint removal");
        breakpoint_sync_[index].removing.store(false);
        return -1;
    }

    // Step 2: Clear breakpoint from all stopped threads
    bool success = clear_breakpoint_from_threads(stopped_threads, index);

    // Step 3: Resume only threads that were NOT already stopped before this call
    // Threads that were already stopped (e.g., at another breakpoint) should remain stopped
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
        {
            std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
            breakpoint_used[index] = false;
            breakpoint_addresses[index] = 0;
            breakpoint_target_counts[index] = 0;
            breakpoint_hit_counts[index] = 0;
        }
        breakpoint_sync_[index].removing.store(false);

        return 0;
    }
    else
    {
        breakpoint_sync_[index].removing.store(false);
        debug_log(LOG_ERROR, "Failed to clear breakpoint from threads");
        return -1;
    }
}

// =============================================================================
// Breakpoint Index Management
// =============================================================================

int Debugger::find_free_breakpoint()
{
    std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
    for (int i = 0; i < MAX_BREAKPOINTS; i++)
    {
        if (!breakpoint_used[i])
        {
            return i;
        }
    }
    return -1;
}

int Debugger::find_breakpoint_index(uint64_t address)
{
    // First check hardware breakpoints
    {
        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
        for (int i = 0; i < MAX_BREAKPOINTS; i++)
        {
            if (breakpoint_used[i] && breakpoint_addresses[i] == address)
            {
                return i;
            }
        }
    }

    // Then check software breakpoints (return index + 1000 to distinguish)
    // Note: On x86_64, when INT3 is hit, RIP points to the instruction AFTER INT3
    // So we check both the address and address-1 (for INT3 case)
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
        {
            if (software_breakpoint_used[i])
            {
                uint64_t bp_addr = software_breakpoint_addresses[i];
                if (bp_addr == address)
                {
                    return i + 1000;  // Offset to indicate software breakpoint
                }
#if defined(__x86_64__)
                // On x86_64, RIP points past the INT3 instruction
                if (address > 0 && bp_addr == address - 1)
                {
                    return i + 1000;  // Offset to indicate software breakpoint
                }
#endif
            }
        }
    }

    return -1;
}

// =============================================================================
// Breakpoint Hit Handling
// =============================================================================

int Debugger::handle_breakpoint_hit(pid_t thread, int breakpoint_index)
{
    // Note: hit count was already incremented in handle_exception
    // Check if this is a software breakpoint (index >= 1000)
    bool is_software_bp = (breakpoint_index >= 1000);
    int actual_index = is_software_bp ? (breakpoint_index - 1000) : breakpoint_index;

    // Read current registers
#if defined(__aarch64__)
    struct user_pt_regs regs;
    struct iovec iov = {.iov_base = &regs, .iov_len = sizeof(regs)};
    if (PTRACE_CALL(DYNA_PTRACE_GETREGSET, thread, NT_PRSTATUS, &iov) == -1)
#elif defined(__x86_64__)
    struct user_regs_struct regs;
    if (PTRACE_CALL(PTRACE_GETREGS, thread, nullptr, &regs) == -1)
#endif
    {
        debug_log(LOG_ERROR, "Failed to get registers for thread %d: %s", thread, strerror(errno));
        return -1;
    }

    // Get target_count and current_hit_count (only for hardware breakpoints)
    int target_count = 0;
    int current_hit_count = 0;
    if (!is_software_bp && actual_index >= 0 && actual_index < MAX_BREAKPOINTS)
    {
        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
        target_count = breakpoint_target_counts[actual_index];
        current_hit_count = breakpoint_hit_counts[actual_index];
    }

    // Set thread-specific state
    // For software breakpoints, set current_breakpoint_index to -1 (no hardware bp)
    thread_states_[thread] =
        ThreadState{.single_step_mode = SingleStepMode::Breakpoint,
                    .single_step_count = 0,
                    .current_breakpoint_index = is_software_bp ? -1 : actual_index,
                    .regs = regs,
                    .is_attached = true,
                    .is_stopped = true,
                    .disabled_watchpoint_index = is_software_bp ? breakpoint_index : -1};

    // Software breakpoints don't support trace mode, so just return and wait for user action
    if (is_software_bp)
    {
        return 0;  // Stay stopped
    }

    // Check if this is trace mode (target_count > 0) - only for hardware breakpoints
    if (target_count > 0 && current_hit_count < target_count)
    {
        // Trace mode: set up single-step and continue without suspending

#if defined(__aarch64__)
        // Temporarily disable the breakpoint to avoid re-triggering
        struct user_hwdebug_state bp_state;
        memset(&bp_state, 0, sizeof(bp_state));
        struct iovec bp_iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

        if (ptrace(PTRACE_GETREGSET, thread, NT_ARM_HW_BREAK, &bp_iov) == 0)
        {
            bp_state.dbg_regs[actual_index].ctrl = 0;  // Disable breakpoint
            if (ptrace(PTRACE_SETREGSET, thread, NT_ARM_HW_BREAK, &bp_iov) == -1)
            {
                debug_log(LOG_ERROR, "Failed to disable breakpoint for tracing: %s",
                          strerror(errno));
            }
        }
#elif defined(__x86_64__)
        // x86_64: Temporarily disable the breakpoint
        unsigned long dr7 =
            ptrace((__ptrace_request)PTRACE_PEEKUSER, thread, X86_DR7_OFFSET, nullptr);
        dr7 &= ~(1UL << (actual_index * 2));  // Clear local enable bit
        if (ptrace((__ptrace_request)PTRACE_POKEUSER, thread, X86_DR7_OFFSET, (void*)dr7) == -1)
        {
            debug_log(LOG_ERROR, "Failed to disable breakpoint for tracing: %s", strerror(errno));
        }
#endif

        debug_state_ = DebugState::SingleStepping;

        // Mark thread as no longer stopped before single stepping
        thread_states_[thread].is_stopped = false;

        // Enable single step
        if (PTRACE_CALL(PTRACE_SINGLESTEP, thread, nullptr, nullptr) == -1)
        {
            debug_log(LOG_ERROR, "Failed to enable single step for thread %d: %s", thread,
                      strerror(errno));
            return -1;
        }

        return 0;
    }
    else
    {
        // Wait mode (target_count == 0): thread stays stopped at breakpoint
        thread_states_[thread].is_stopped = true;
    }

    return 0;
}

// =============================================================================
// Thread-Specific Breakpoint Operations
// =============================================================================

bool Debugger::apply_breakpoint_to_threads(const std::vector<pid_t>& threads, int index,
                                           uint64_t address)
{
    for (pid_t tid : threads)
    {
#if defined(__aarch64__)
        struct user_hwdebug_state bp_state;
        memset(&bp_state, 0, sizeof(bp_state));

        // Set proper iov length: 8 bytes header + 16 bytes per breakpoint * MAX_BREAKPOINTS
        struct iovec iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

        // Get current breakpoint state using ARM64 hardware breakpoint regset
        if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to get hardware breakpoint state for thread %d: %s", tid,
                      strerror(err));
            return false;
        }

        // Re-enable existing breakpoints that have addresses set
        for (int i = 0; i < MAX_BREAKPOINTS; i++)
        {
            if (bp_state.dbg_regs[i].addr != 0)
            {
                bp_state.dbg_regs[i].ctrl =
                    encode_ctrl_reg(0, ARM_BREAKPOINT_LEN_4, ARM_BREAKPOINT_EXECUTE, 0, 1);
            }
        }

        // encode_ctrl_reg(mismatch, len, type, privilege, enabled)
        // For execute breakpoint: mismatch=0, len=LEN_4, type=EXECUTE, privilege=0, enabled=1
        bp_state.dbg_regs[index].addr = address;
        bp_state.dbg_regs[index].ctrl =
            encode_ctrl_reg(0, ARM_BREAKPOINT_LEN_4, ARM_BREAKPOINT_EXECUTE, 0, 1);

        // Apply the breakpoint state using ARM64 hardware breakpoint regset
        if (ptrace(PTRACE_SETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to set hardware breakpoint for thread %d: %s", tid,
                      strerror(err));
            return false;
        }
#elif defined(__x86_64__)
        // x86_64: Use debug registers DR0-DR3 for breakpoints
        if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, x86_dr_offset(index), (void*)address) ==
            -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to set breakpoint address for thread %d: %s", tid,
                      strerror(err));
            return false;
        }

        // Configure DR7 for execution breakpoint
        unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, tid, X86_DR7_OFFSET, nullptr);

        // Set local enable bit
        dr7 |= (1UL << (index * 2));

        // Set condition (execution) and length (1 byte for exec)
        int shift = 16 + index * 4;
        dr7 &= ~(0xFUL << shift);
        dr7 |= ((X86_DR7_BREAK_ON_EXEC | (X86_DR7_LEN_1 << 2)) << shift);

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

// Apply breakpoint to a single thread (used when new thread is created)
bool Debugger::apply_breakpoint_to_thread(pid_t tid, int index, uint64_t address)
{
#if defined(__aarch64__)
    struct user_hwdebug_state bp_state;
    memset(&bp_state, 0, sizeof(bp_state));

    struct iovec iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

    if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
    {
        debug_log(LOG_ERROR, "Failed to get hardware breakpoint state for thread %d: %s", tid,
                  strerror(errno));
        return false;
    }

    bp_state.dbg_regs[index].addr = address;
    bp_state.dbg_regs[index].ctrl =
        encode_ctrl_reg(0, ARM_BREAKPOINT_LEN_4, ARM_BREAKPOINT_EXECUTE, 0, 1);

    if (ptrace(PTRACE_SETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
    {
        debug_log(LOG_ERROR, "Failed to set hardware breakpoint for thread %d: %s", tid,
                  strerror(errno));
        return false;
    }
#elif defined(__x86_64__)
    if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, x86_dr_offset(index), (void*)address) == -1)
    {
        debug_log(LOG_ERROR, "Failed to set breakpoint address for thread %d: %s", tid,
                  strerror(errno));
        return false;
    }

    unsigned long dr7 = ptrace((__ptrace_request)PTRACE_PEEKUSER, tid, X86_DR7_OFFSET, nullptr);
    dr7 |= (1UL << (index * 2));
    int shift = 16 + index * 4;
    dr7 &= ~(0xFUL << shift);
    dr7 |= ((X86_DR7_BREAK_ON_EXEC | (X86_DR7_LEN_1 << 2)) << shift);

    if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, X86_DR7_OFFSET, (void*)dr7) == -1)
    {
        debug_log(LOG_ERROR, "Failed to set DR7 for thread %d: %s", tid, strerror(errno));
        return false;
    }
#endif

    return true;
}

bool Debugger::clear_breakpoint_from_threads(const std::vector<pid_t>& threads, int index)
{
    for (pid_t tid : threads)
    {
#if defined(__aarch64__)
        struct user_hwdebug_state bp_state;
        memset(&bp_state, 0, sizeof(bp_state));

        // Set proper iov length: 8 bytes header + 16 bytes per breakpoint * MAX_BREAKPOINTS
        struct iovec iov = {.iov_base = &bp_state, .iov_len = 8 + 16 * MAX_BREAKPOINTS};

        // Get current breakpoint state using ARM64 hardware breakpoint regset

        if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to get hardware breakpoint state for thread %d: %s", tid,
                      strerror(err));
            return false;
        }

        // Re-enable other breakpoints that have addresses set (they may have been disabled during
        // single-step)
        for (int i = 0; i < MAX_BREAKPOINTS; i++)
        {
            if (i != index && bp_state.dbg_regs[i].addr != 0)
            {
                bp_state.dbg_regs[i].ctrl =
                    encode_ctrl_reg(0, ARM_BREAKPOINT_LEN_4, ARM_BREAKPOINT_EXECUTE, 0, 1);
            }
        }

        // Clear the target breakpoint control register to disable
        bp_state.dbg_regs[index].ctrl = 0;
        bp_state.dbg_regs[index].addr = 0;

        // Apply the changes using ARM64 hardware breakpoint regset
        if (ptrace(PTRACE_SETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to clear hardware breakpoint for thread %d: %s", tid,
                      strerror(err));
            return false;
        }
#elif defined(__x86_64__)
        // x86_64: Clear the debug register for this breakpoint
        if (ptrace((__ptrace_request)PTRACE_POKEUSER, tid, x86_dr_offset(index), (void*)0) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                continue;
            }
            debug_log(LOG_ERROR, "Failed to clear breakpoint address for thread %d: %s", tid,
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
// Software Breakpoint Continue (for callback-driven silent continue)
// =============================================================================

int Debugger::handle_software_breakpoint_continue(pid_t thread, int breakpoint_index)
{
    // Software breakpoint index is stored as >= 1000
    int actual_index = breakpoint_index - 1000;

    debug_log(LOG_INFO, "handle_software_breakpoint_continue: thread=%d, bp_index=%d, actual=%d",
              thread, breakpoint_index, actual_index);

    if (actual_index < 0 || actual_index >= MAX_SOFTWARE_BREAKPOINTS)
    {
        debug_log(LOG_ERROR, "Invalid software breakpoint index: %d", actual_index);
        return -1;
    }

    uint64_t bp_addr = 0;
    uint8_t original_bytes[4] = {0};

    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        if (!software_breakpoint_used[actual_index])
        {
            debug_log(LOG_ERROR, "Software breakpoint %d not in use", actual_index);
            return -1;
        }
        bp_addr = software_breakpoint_addresses[actual_index];
        int offset = actual_index * 4;
        for (int j = 0; j < 4; j++)
        {
            original_bytes[j] = software_breakpoint_original_bytes[offset + j];
        }
    }

    // Step 1: Restore original instruction bytes using PTRACE_PEEKDATA/POKEDATA
    errno = 0;
    long word = ptrace(PTRACE_PEEKDATA, thread, (void*)bp_addr, nullptr);
    if (errno != 0)
    {
        debug_log(LOG_ERROR, "Failed to read memory at 0x%lx for restore: %s", bp_addr,
                  strerror(errno));
        return -1;
    }

#if defined(__aarch64__)
    // ARM64: Replace 4 bytes with original instruction
    long patched_word = (word & ~0xFFFFFFFFUL) | *reinterpret_cast<uint32_t*>(original_bytes);
#elif defined(__x86_64__)
    // x86_64: Replace 1 byte with original
    long patched_word = (word & ~0xFFUL) | original_bytes[0];
#endif

    if (ptrace(PTRACE_POKEDATA, thread, (void*)bp_addr, (void*)patched_word) == -1)
    {
        debug_log(LOG_ERROR, "Failed to restore original instruction at 0x%lx: %s", bp_addr,
                  strerror(errno));
        return -1;
    }

    // Step 2: Set up single-step to execute original instruction
    thread_states_[thread].single_step_mode = SingleStepMode::SoftwareBreakpointContinue;
    thread_states_[thread].disabled_watchpoint_index = breakpoint_index;  // Store for re-insertion
    thread_states_[thread].is_stopped = false;

    // Step 3: Single-step to execute the original instruction
    if (PTRACE_CALL(PTRACE_SINGLESTEP, thread, nullptr, nullptr) == -1)
    {
        debug_log(LOG_ERROR, "Failed to single-step thread %d: %s", thread, strerror(errno));
        return -1;
    }

    debug_log(LOG_INFO, "Software breakpoint continue: single-stepping thread %d", thread);
    return 0;
}
