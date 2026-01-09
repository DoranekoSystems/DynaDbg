/**
 * @file debugger_exception.mm
 * @brief Exception handling and single-step related Debugger class member functions (Darwin/macOS)
 *
 * This file contains the implementation of exception handling, execution control,
 * and single-step functionality for the Darwin debugger.
 *
 * Functions included:
 *   - handle_exception: Main exception handling function for Mach exceptions
 *   - handle_single_step: Dispatcher for single step completion handling
 */

#include "debugger_internal.h"

// =============================================================================
// Main Exception Handler
// =============================================================================

kern_return_t Debugger::handle_exception(mach_port_t exception_port, mach_port_t thread,
                                         mach_port_t task, exception_type_t exception,
                                         mach_exception_data_t code,
                                         mach_msg_type_number_t code_count)
{
    if (exception == EXC_SYSCALL)
    {
        debug_log_develop(LOG_INFO, "Received EXC_SYSCALL exception");
        return KERN_FAILURE;  // Ignore syscall exceptions
    }
    if (exception != EXC_BREAKPOINT && exception != EXC_GUARD)
    {
        return KERN_FAILURE;
    }

    arm_thread_state64_t thread_state;
    mach_msg_type_number_t thread_state_count = ARM_THREAD_STATE64_COUNT;
    kern_return_t kr = thread_get_state(thread, ARM_THREAD_STATE64, (thread_state_t)&thread_state,
                                        &thread_state_count);
    if (kr != KERN_SUCCESS)
    {
        debug_log_develop(LOG_ERROR, "Failed to get thread state: %s", mach_error_string(kr));
        return kr;
    }

    arm_debug_state64_t debug_state;
    mach_msg_type_number_t debug_state_count = ARM_DEBUG_STATE64_COUNT;
    kr = thread_get_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                          &debug_state_count);
    if (kr != KERN_SUCCESS)
    {
        debug_log_develop(LOG_ERROR, "Failed to get debug state: %s", mach_error_string(kr));
        return kr;
    }

    arm_exception_state64_t exception_state;
    mach_msg_type_number_t exception_state_count = ARM_EXCEPTION_STATE64_COUNT;
    kr = thread_get_state(thread, ARM_EXCEPTION_STATE64, (thread_state_t)&exception_state,
                          &exception_state_count);
    if (kr != KERN_SUCCESS)
    {
        debug_log_develop(LOG_ERROR, "Failed to get exception state: %s", mach_error_string(kr));
        return kr;
    }

    NativeExceptionInfo info = {};
    info.architecture = ARCH_ARM64;
    for (int i = 0; i < 30; ++i)
    {
        info.regs.arm64.x[i] = thread_state.__x[i];
    }
    info.regs.arm64.lr = thread_state.__lr;
    info.regs.arm64.fp = thread_state.__fp;
    info.regs.arm64.sp = thread_state.__sp;
    info.regs.arm64.pc = thread_state.__pc;
    info.regs.arm64.cpsr = thread_state.__cpsr;
    info.thread_id = (uint64_t)thread;

    uint32_t esr = exception_state.__esr;
    uint32_t ec = (esr >> 26) & 0x3F;  // Exception Class

    // Handle single step mode - but only for the correct exception type
    // debug_log_develop(LOG_DEBUG, "handle_exception: Checking thread_states_ for thread %d",
    // thread);
    auto thread_it = thread_states_.find(thread);
    if (thread_it != thread_states_.end() &&
        thread_it->second.single_step_mode != SingleStepMode::None)
    {
        // debug_log_develop(LOG_ERROR, "Handling single step for thread %d, EC: 0x%02x", thread,
        // ec);

        // Only send exception info to UI for Breakpoint/SoftwareBreakpoint single steps
        int matched_sw_bp = -1;
        {
            for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
            {
                if (software_breakpoint_used[i] &&
                    software_breakpoint_addresses[i] == thread_state.__pc)
                {
                    matched_sw_bp = i;
                    break;
                }
            }
        }
        if ((thread_it->second.single_step_mode == SingleStepMode::Breakpoint ||
             thread_it->second.single_step_mode == SingleStepMode::SoftwareBreakpoint) &&
            matched_sw_bp == -1)
        {
            info.exception_type = EXCEPTION_SINGLESTEP;
            info.singlestep_mode = (uint64_t)thread_it->second.single_step_mode;

            // Check if this is a trace exception (target_count > 0)
            int bp_index = thread_it->second.current_breakpoint_index;
            if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
            {
                std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                int target_count = breakpoint_target_counts[bp_index];
                info.is_trace = (target_count > 0) ? 1 : 0;
            }
            else
            {
                info.is_trace = 0;
            }

            // Check if trace file output is enabled
            bool write_to_file = false;
            {
                std::lock_guard<std::mutex> lock(trace_file_mutex_);
                write_to_file = trace_file_enabled_ && trace_file_writer_ && info.is_trace;
            }

            if (write_to_file)
            {
                // Write to trace file instead of sending to UI
                TraceEntryArm64 entry;
                memset(&entry, 0, sizeof(entry));

                auto now = std::chrono::system_clock::now();
                auto duration = now.time_since_epoch();
                entry.timestamp =
                    std::chrono::duration_cast<std::chrono::microseconds>(duration).count();

                entry.pc = thread_state.__pc;
                for (int i = 0; i < 30; ++i)
                {
                    entry.x[i] = thread_state.__x[i];
                }
                entry.lr = thread_state.__lr;
                entry.sp = thread_state.__sp;
                entry.cpsr = thread_state.__cpsr;

                // Read instruction at PC
                uint8_t instr_bytes[4];
                mach_vm_size_t bytes_read = 0;
                kern_return_t read_kr = mach_vm_read_overwrite(
                    task_port_, thread_state.__pc, 4, (mach_vm_address_t)instr_bytes, &bytes_read);

                if (read_kr == KERN_SUCCESS && bytes_read == 4)
                {
#ifdef DYNAMIC_LIB_BUILD
                    snprintf(entry.instruction, TRACE_INSTRUCTION_SIZE, "%02x %02x %02x %02x",
                             instr_bytes[0], instr_bytes[1], instr_bytes[2], instr_bytes[3]);
                    entry.instruction_length = strlen(entry.instruction);
#else
                    char* disasm = disassemble_at_address(instr_bytes, 4, thread_state.__pc);
                    if (disasm)
                    {
                        strncpy(entry.instruction, disasm, TRACE_INSTRUCTION_SIZE - 1);
                        entry.instruction[TRACE_INSTRUCTION_SIZE - 1] = '\0';
                        entry.instruction_length = strlen(entry.instruction);
                        free_string(disasm);
                    }
                    else
                    {
                        snprintf(entry.instruction, TRACE_INSTRUCTION_SIZE, "%02x %02x %02x %02x",
                                 instr_bytes[0], instr_bytes[1], instr_bytes[2], instr_bytes[3]);
                        entry.instruction_length = strlen(entry.instruction);
                    }
#endif
                }

                // Read memory at x0-x5
                for (int i = 0; i < TRACE_MEMORY_REG_COUNT; ++i)
                {
                    uint64_t addr = thread_state.__x[i];
                    if (addr != 0)
                    {
                        mach_vm_size_t mem_read = 0;
                        mach_vm_read_overwrite(task_port_, addr, TRACE_MEMORY_DUMP_SIZE,
                                               (mach_vm_address_t)entry.memory[i], &mem_read);
                    }
                }

                // Perform full memory dump on first breakpoint hit
                if (full_memory_cache_enabled_ && !memory_dump_completed_)
                {
                    debug_log_develop(LOG_INFO,
                                      "Performing initial memory dump on first breakpoint hit");
                    if (dump_all_memory_regions())
                    {
                        memory_dump_completed_ = true;
                    }
                }

                // Write entry to trace file
                uint32_t current_entry_index = 0;
                {
                    std::lock_guard<std::mutex> lock(trace_file_mutex_);
                    if (trace_file_writer_)
                    {
                        current_entry_index = trace_file_writer_->get_entry_count();
                        trace_file_writer_->write_entry(entry);
                    }
                }

                // Log memory access if full memory cache is enabled
                if (full_memory_cache_enabled_ && read_kr == KERN_SUCCESS && bytes_read == 4)
                {
                    uint32_t instruction = instr_bytes[0] | (instr_bytes[1] << 8) |
                                           (instr_bytes[2] << 16) | (instr_bytes[3] << 24);

                    Arm64MemoryAccess mem_access = decode_arm64_memory_access(
                        instruction, thread_state.__x, thread_state.__sp, thread_state.__pc);

                    if (mem_access.is_valid && mem_access.size > 0 && mem_access.size <= 256)
                    {
                        std::lock_guard<std::mutex> lock(memory_cache_mutex_);
                        if (memory_access_log_writer_)
                        {
                            uint8_t mem_data[256];
                            mach_vm_size_t mem_read = 0;
                            kern_return_t mem_kr = mach_vm_read_overwrite(
                                task_port_, mem_access.address, mem_access.size,
                                (mach_vm_address_t)mem_data, &mem_read);

                            if (mem_kr == KERN_SUCCESS && mem_read > 0)
                            {
                                memory_access_log_writer_->write_access(
                                    current_entry_index, mem_access.address, (uint32_t)mem_read,
                                    mem_access.is_write != 0, mem_data);

                                if (mem_access.is_pair && mem_access.address2 != 0)
                                {
                                    mem_kr = mach_vm_read_overwrite(
                                        task_port_, mem_access.address2, mem_access.size,
                                        (mach_vm_address_t)mem_data, &mem_read);

                                    if (mem_kr == KERN_SUCCESS && mem_read > 0)
                                    {
                                        memory_access_log_writer_->write_access(
                                            current_entry_index, mem_access.address2,
                                            (uint32_t)mem_read, mem_access.is_write != 0, mem_data);
                                    }
                                }
                            }
                        }
                    }
                }

                debug_log_develop(LOG_DEBUG, "Wrote trace entry to file (PC: 0x%llx)", entry.pc);
            }
            else
            {
#ifdef DYNAMIC_LIB_BUILD
                if (g_send_exception_info)
                {
                    g_send_exception_info(&info, pid_);
                }
#else
                send_exception_info(&info, pid_);
#endif
            }
        }

        // debug_log_develop(LOG_DEBUG, "handle_exception: Calling handle_single_step");
        return handle_single_step(thread, debug_state, thread_state, exception_state);
    }

    if (ec == 0x34 || ec == 0x35)
    {
        // Watchpoint exception
        uint64_t far = exception_state.__far;
        info.memory_address = far;
        info.exception_type = EXCEPTION_WATCHPOINT;

        int matched_watchpoint = -1;
        {
            std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
            for (int i = 0; i < MAX_WATCHPOINTS; i++)
            {
                if (watchpoint_used[i] && far >= watchpoint_addresses[i] &&
                    far < watchpoint_addresses[i] + watchpoint_sizes[i])
                {
                    matched_watchpoint = i;
                    break;
                }
            }
        }

        if (matched_watchpoint != -1)
        {
#ifdef DYNAMIC_LIB_BUILD
            if (g_send_exception_info)
            {
                g_send_exception_info(&info, pid_);
            }
#else
            send_exception_info(&info, pid_);
#endif
            return handle_watchpoint_hit(thread, debug_state, thread_state, exception_state,
                                         matched_watchpoint);
        }

        debug_log_develop(LOG_ERROR, "Watchpoint exception but no matching watchpoint found");
    }
    else if (ec == 0x3c)  // BRK instruction (software breakpoint)
    {
        info.exception_type = EXCEPTION_BREAKPOINT;

        int matched_sw_bp = -1;
        {
            std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
            for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
            {
                if (software_breakpoint_used[i] &&
                    software_breakpoint_addresses[i] == thread_state.__pc)
                {
                    matched_sw_bp = i;
                    break;
                }
            }
        }

        if (matched_sw_bp != -1)
        {
            bool should_notify = false;
#ifdef DYNAMIC_LIB_BUILD
            if (g_send_exception_info)
            {
                should_notify = g_send_exception_info(&info, pid_);
            }
#else
            should_notify = send_exception_info(&info, pid_);
#endif

            if (!should_notify)
            {
                bool bp_still_exists = false;
                {
                    std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
                    bp_still_exists = software_breakpoint_used[matched_sw_bp];
                }

                if (bp_still_exists)
                {
                    uint8_t original_bytes[4];
                    memcpy(original_bytes, &software_breakpoint_original_bytes[matched_sw_bp * 4],
                           4);

                    ssize_t bytes_written =
                        write_memory_native(pid_, thread_state.__pc, 4, original_bytes);
                    if (bytes_written != 4)
                    {
                        debug_log_develop(LOG_ERROR,
                                          "Failed to restore original instruction for step-over");
                        return KERN_FAILURE;
                    }
                }

                debug_state.__mdscr_el1 |= 1ULL;
                kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                      ARM_DEBUG_STATE64_COUNT);
                if (kr != KERN_SUCCESS)
                {
                    debug_log_develop(LOG_ERROR, "Failed to enable single-step: %s",
                                      mach_error_string(kr));
                    return kr;
                }

                thread_states_[thread] =
                    ThreadState{.single_step_mode = SingleStepMode::SoftwareBreakpointContinue,
                                .single_step_count = 0,
                                .current_breakpoint_index = -1,
                                .current_watchpoint_index = -1,
                                .current_software_breakpoint_index = matched_sw_bp,
                                .is_stopped = false,
                                .thread_state = thread_state,
                                .debug_state = debug_state,
                                .exception_state = exception_state};

                return KERN_SUCCESS;
            }

            // Enter break state
            current_thread = thread;
            thread_states_[thread] = ThreadState{.single_step_mode = SingleStepMode::None,
                                                 .single_step_count = 0,
                                                 .current_breakpoint_index = -1,
                                                 .current_watchpoint_index = -1,
                                                 .current_software_breakpoint_index = matched_sw_bp,
                                                 .is_stopped = true,
                                                 .thread_state = thread_state,
                                                 .debug_state = debug_state,
                                                 .exception_state = exception_state};
            debug_state_ = DebugState::BreakpointHit;

            kern_return_t suspend_result = thread_suspend(thread);
            if (suspend_result != KERN_SUCCESS)
            {
                debug_log(LOG_ERROR, "Failed to suspend thread: %s",
                          kern_return_to_string(suspend_result).c_str());
            }

            return KERN_SUCCESS;
        }
    }
    else if (ec == 0x30 || ec == 0x31)  // Hardware breakpoint
    {
        info.exception_type = EXCEPTION_BREAKPOINT;

        for (int i = 0; i < MAX_BREAKPOINTS; i++)
        {
            if (breakpoint_used[i] && thread_state.__pc == breakpoint_addresses[i])
            {
                int target_count = 0;
                {
                    std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                    target_count = breakpoint_target_counts[i];
                }
                info.is_trace = (target_count > 0) ? 1 : 0;

                // Check tracked thread for tracing
                if (target_count > 0)
                {
                    mach_port_t expected = MACH_PORT_NULL;
                    bool is_tracked_thread =
                        tracked_trace_thread_.compare_exchange_strong(expected, thread);

                    if (!is_tracked_thread && tracked_trace_thread_.load() != thread)
                    {
                        debug_log_develop(LOG_INFO, "Thread %d not tracked, resuming", thread);
#ifdef DYNAMIC_LIB_BUILD
                        if (g_send_exception_info)
                        {
                            g_send_exception_info(&info, pid_);
                        }
#else
                        send_exception_info(&info, pid_);
#endif
                        return KERN_SUCCESS;
                    }
                }

                // Check if trace file output is enabled
                bool write_to_file = false;
                {
                    std::lock_guard<std::mutex> lock(trace_file_mutex_);
                    write_to_file = trace_file_enabled_ && trace_file_writer_ && info.is_trace;
                }

                if (write_to_file)
                {
                    // Write first trace entry to file
                    TraceEntryArm64 entry;
                    memset(&entry, 0, sizeof(entry));

                    auto now = std::chrono::system_clock::now();
                    auto duration = now.time_since_epoch();
                    entry.timestamp =
                        std::chrono::duration_cast<std::chrono::microseconds>(duration).count();

                    entry.pc = thread_state.__pc;
                    for (int j = 0; j < 30; ++j)
                    {
                        entry.x[j] = thread_state.__x[j];
                    }
                    entry.lr = thread_state.__lr;
                    entry.sp = thread_state.__sp;
                    entry.cpsr = thread_state.__cpsr;

                    // Read instruction at PC
                    uint8_t instr_bytes[4];
                    mach_vm_size_t bytes_read = 0;
                    kern_return_t read_kr =
                        mach_vm_read_overwrite(task_port_, thread_state.__pc, 4,
                                               (mach_vm_address_t)instr_bytes, &bytes_read);

                    if (read_kr == KERN_SUCCESS && bytes_read == 4)
                    {
#ifdef DYNAMIC_LIB_BUILD
                        snprintf(entry.instruction, TRACE_INSTRUCTION_SIZE, "%02x %02x %02x %02x",
                                 instr_bytes[0], instr_bytes[1], instr_bytes[2], instr_bytes[3]);
                        entry.instruction_length = strlen(entry.instruction);
#else
                        char* disasm = disassemble_at_address(instr_bytes, 4, thread_state.__pc);
                        if (disasm)
                        {
                            strncpy(entry.instruction, disasm, TRACE_INSTRUCTION_SIZE - 1);
                            entry.instruction[TRACE_INSTRUCTION_SIZE - 1] = '\0';
                            entry.instruction_length = strlen(entry.instruction);
                            free_string(disasm);
                        }
                        else
                        {
                            snprintf(entry.instruction, TRACE_INSTRUCTION_SIZE,
                                     "%02x %02x %02x %02x", instr_bytes[0], instr_bytes[1],
                                     instr_bytes[2], instr_bytes[3]);
                            entry.instruction_length = strlen(entry.instruction);
                        }
#endif
                    }

                    // Read memory at x0-x5
                    for (int j = 0; j < TRACE_MEMORY_REG_COUNT; ++j)
                    {
                        uint64_t addr = thread_state.__x[j];
                        if (addr != 0)
                        {
                            mach_vm_size_t mem_read = 0;
                            mach_vm_read_overwrite(task_port_, addr, TRACE_MEMORY_DUMP_SIZE,
                                                   (mach_vm_address_t)entry.memory[j], &mem_read);
                        }
                    }

                    // Perform full memory dump on first breakpoint hit
                    if (full_memory_cache_enabled_ && !memory_dump_completed_)
                    {
                        if (dump_all_memory_regions())
                        {
                            memory_dump_completed_ = true;
                        }
                    }

                    {
                        std::lock_guard<std::mutex> lock(trace_file_mutex_);
                        if (trace_file_writer_)
                        {
                            trace_file_writer_->write_entry(entry);
                        }
                    }
                }
                else
                {
                    // Check callback
                    bool should_notify = false;
#ifdef DYNAMIC_LIB_BUILD
                    if (g_send_exception_info)
                    {
                        should_notify = g_send_exception_info(&info, pid_);
                    }
#else
                    should_notify = send_exception_info(&info, pid_);
#endif
                    if (!should_notify)
                    {
                        debug_state.__bcr[i] = 0;
                        debug_state.__mdscr_el1 |= 1ULL;

                        kr =
                            thread_set_state(thread, ARM_DEBUG_STATE64,
                                             (thread_state_t)&debug_state, ARM_DEBUG_STATE64_COUNT);
                        if (kr != KERN_SUCCESS)
                        {
                            debug_log_develop(LOG_ERROR, "Failed to set debug state: %s",
                                              mach_error_string(kr));
                            return kr;
                        }

                        thread_states_[thread] = ThreadState{
                            .single_step_mode = SingleStepMode::HardwareBreakpointContinue,
                            .single_step_count = 0,
                            .current_breakpoint_index = i,
                            .current_watchpoint_index = -1,
                            .is_stopped = false,
                            .thread_state = thread_state,
                            .debug_state = debug_state,
                            .exception_state = exception_state};
                        debug_state_ = DebugState::SingleStepping;

                        return KERN_SUCCESS;
                    }
                }

                // Re-check hit count
                int current_hit_count = 0;
                {
                    std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                    target_count = breakpoint_target_counts[i];
                    breakpoint_hit_counts[i]++;
                    current_hit_count = breakpoint_hit_counts[i];
                }

                if (target_count > 0 && current_hit_count < target_count)
                {
                    // Tracing mode: single-step and continue
                    debug_state.__bcr[i] = 0;
                    debug_state.__mdscr_el1 |= 1ULL;

                    kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                          ARM_DEBUG_STATE64_COUNT);
                    if (kr != KERN_SUCCESS)
                    {
                        debug_log_develop(LOG_ERROR, "Failed to set debug state for tracing: %s",
                                          mach_error_string(kr));
                        return kr;
                    }

                    current_thread = thread;
                    thread_states_[thread] =
                        ThreadState{.single_step_mode = SingleStepMode::Breakpoint,
                                    .single_step_count = 0,
                                    .current_breakpoint_index = i,
                                    .current_watchpoint_index = -1,
                                    .is_stopped = false,
                                    .thread_state = thread_state,
                                    .debug_state = debug_state,
                                    .exception_state = exception_state};
                    debug_state_ = DebugState::SingleStepping;

                    return KERN_SUCCESS;
                }

                // Wait mode or tracing complete - enter break state
                current_thread = thread;
                thread_states_[thread] = ThreadState{.single_step_mode = SingleStepMode::None,
                                                     .single_step_count = 0,
                                                     .current_breakpoint_index = i,
                                                     .current_watchpoint_index = -1,
                                                     .is_stopped = true,
                                                     .thread_state = thread_state,
                                                     .debug_state = debug_state,
                                                     .exception_state = exception_state};
                debug_state_ = DebugState::BreakpointHit;

                kern_return_t suspend_result = thread_suspend(thread);
                if (suspend_result != KERN_SUCCESS)
                {
                    debug_log_develop(LOG_ERROR, "Failed to suspend thread: %s",
                                      kern_return_to_string(suspend_result).c_str());
                }

                return KERN_SUCCESS;
            }
        }
        debug_log_develop(LOG_ERROR, "Breakpoint exception but no matching breakpoint found");
    }
    else
    {
        debug_log_develop(LOG_ERROR, "Unhandled exception class: 0x%02x", ec);
    }

    return KERN_SUCCESS;
}

// =============================================================================
// Single Step Handler
// =============================================================================

kern_return_t Debugger::handle_single_step(mach_port_t thread, arm_debug_state64_t& debug_state,
                                           arm_thread_state64_t& thread_state,
                                           arm_exception_state64_t& exception_state)
{
    SingleStepMode mode;
    int bp_index = -1;
    int sw_bp_index = -1;

    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        auto thread_it = thread_states_.find(thread);
        if (thread_it == thread_states_.end())
        {
            debug_log(LOG_ERROR, "Thread %d not found in thread_states_", thread);
            return KERN_FAILURE;
        }

        thread_it->second.thread_state = thread_state;
        thread_it->second.debug_state = debug_state;
        thread_it->second.exception_state = exception_state;

        mode = thread_it->second.single_step_mode;
        bp_index = thread_it->second.current_breakpoint_index;
        sw_bp_index = thread_it->second.current_software_breakpoint_index;
    }

    switch (mode)
    {
        case SingleStepMode::Watchpoint:
            return complete_watchpoint_single_step(thread, debug_state, thread_state,
                                                   exception_state);
        case SingleStepMode::Breakpoint:
        {
            int target_count = 0;
            int current_hit_count = 0;
            mach_vm_address_t end_addr = 0;
            if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
            {
                std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                target_count = breakpoint_target_counts[bp_index];
                breakpoint_hit_counts[bp_index]++;
                current_hit_count = breakpoint_hit_counts[bp_index];
                end_addr = breakpoint_end_addresses[bp_index];
            }

            mach_vm_address_t current_pc = thread_state.__pc;
            bool reached_end = (end_addr != 0) && (current_pc == end_addr);

            // Script trace stop check
            bool script_stop_requested = script_trace_stop_requested_.load();
            if (script_stop_requested)
            {
                bool notify_ui = script_trace_stop_with_ui_notification_.load();

                clear_script_trace_stop_request();
                trace_session_ended_by_end_address_ = true;
                tracked_trace_thread_.store(MACH_PORT_NULL);

                {
                    std::lock_guard<std::mutex> lock(trace_file_mutex_);
                    if (trace_file_enabled_ && trace_file_writer_)
                    {
                        trace_file_writer_->close();
                        trace_file_enabled_ = false;
                    }
                }

                disable_full_memory_cache();

                if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
                {
                    mach_vm_address_t bp_addr;
                    {
                        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                        bp_addr = breakpoint_addresses[bp_index];
                    }
                    remove_breakpoint(bp_addr);
                }

                {
                    std::lock_guard<std::mutex> lock(thread_states_mutex_);
                    thread_states_.erase(thread);
                }

                debug_state.__mdscr_el1 &= ~1ULL;
                thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                 ARM_DEBUG_STATE64_COUNT);

                debug_state_ = DebugState::Running;
                current_thread = MACH_PORT_NULL;

                if (notify_ui)
                {
                    NativeExceptionInfo info = {};
                    info.architecture = ARCH_ARM64;
                    info.exception_type = EXCEPTION_SINGLESTEP;
                    info.thread_id = thread;
                    info.regs.arm64.pc = current_pc;
                    send_exception_info(&info, pid_);
                }

                return KERN_SUCCESS;
            }

            if (reached_end)
            {
                debug_log(LOG_INFO, "PC 0x%llx reached end address 0x%llx", current_pc, end_addr);

                trace_session_ended_by_end_address_ = true;
                tracked_trace_thread_.store(MACH_PORT_NULL);

                {
                    std::lock_guard<std::mutex> lock(trace_file_mutex_);
                    if (trace_file_enabled_ && trace_file_writer_)
                    {
                        trace_file_writer_->close();
                        trace_file_enabled_ = false;
                    }
                }

                disable_full_memory_cache();

                if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
                {
                    mach_vm_address_t bp_addr;
                    {
                        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                        bp_addr = breakpoint_addresses[bp_index];
                    }
                    remove_breakpoint(bp_addr);
                }

                {
                    std::lock_guard<std::mutex> lock(thread_states_mutex_);
                    thread_states_.erase(thread);
                }

                debug_state.__mdscr_el1 &= ~1ULL;
                thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                 ARM_DEBUG_STATE64_COUNT);

                debug_state_ = DebugState::Running;
                current_thread = MACH_PORT_NULL;

                return KERN_SUCCESS;
            }

            if (target_count > 0 && current_hit_count < target_count)
            {
                // Continue tracing
                debug_state_ = DebugState::SingleStepping;
                debug_state.__mdscr_el1 |= 1ULL;
                kern_return_t kr =
                    thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                     ARM_DEBUG_STATE64_COUNT);
                if (kr != KERN_SUCCESS)
                {
                    debug_log(LOG_ERROR, "Failed to re-enable single-step: %s",
                              mach_error_string(kr));
                    return kr;
                }
                return KERN_SUCCESS;
            }

            // Tracing complete
            if (target_count > 0)
            {
                tracked_trace_thread_.store(MACH_PORT_NULL);
                debug_state.__mdscr_el1 &= ~1ULL;
                thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                 ARM_DEBUG_STATE64_COUNT);

                {
                    std::lock_guard<std::mutex> lock(thread_states_mutex_);
                    thread_states_.erase(thread);
                }

                debug_state_ = DebugState::Running;
                current_thread = MACH_PORT_NULL;

                // Remove breakpoint from all threads
                mach_vm_address_t bp_address = breakpoint_addresses[bp_index];
                if (bp_address != 0)
                {
                    thread_act_array_t thread_list;
                    mach_msg_type_number_t thread_count;
                    if (task_threads(task_port_, &thread_list, &thread_count) == KERN_SUCCESS)
                    {
                        for (mach_msg_type_number_t i = 0; i < thread_count; i++)
                        {
                            arm_debug_state64_t thread_debug_state;
                            mach_msg_type_number_t count = ARM_DEBUG_STATE64_COUNT;
                            if (thread_get_state(thread_list[i], ARM_DEBUG_STATE64,
                                                 (thread_state_t)&thread_debug_state,
                                                 &count) == KERN_SUCCESS)
                            {
                                thread_debug_state.__bcr[bp_index] = 0;
                                thread_set_state(thread_list[i], ARM_DEBUG_STATE64,
                                                 (thread_state_t)&thread_debug_state, count);
                            }
                            mach_port_deallocate(mach_task_self(), thread_list[i]);
                        }
                        vm_deallocate(mach_task_self(), (vm_address_t)thread_list,
                                      thread_count * sizeof(thread_act_t));
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                    breakpoint_used[bp_index] = false;
                    breakpoint_addresses[bp_index] = 0;
                    breakpoint_hit_counts[bp_index] = 0;
                    breakpoint_target_counts[bp_index] = 0;
                }

                {
                    std::lock_guard<std::mutex> lock(trace_file_mutex_);
                    if (trace_file_enabled_ && trace_file_writer_)
                    {
                        trace_file_writer_->close();
                        trace_file_enabled_ = false;
                    }
                }

                return KERN_SUCCESS;
            }

            // Wait mode: re-enable breakpoint and suspend
            if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
            {
                debug_state.__bcr[bp_index] = (1ULL << 0) | (2ULL << 1) | (1ULL << 5);
            }

            debug_state_ = DebugState::BreakpointHit;
            debug_state.__mdscr_el1 &= ~1ULL;
            thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                             ARM_DEBUG_STATE64_COUNT);

            {
                std::lock_guard<std::mutex> lock(thread_states_mutex_);
                auto thread_it = thread_states_.find(thread);
                if (thread_it != thread_states_.end())
                {
                    thread_it->second.single_step_mode = SingleStepMode::None;
                    thread_it->second.is_stopped = true;
                }
            }

            thread_suspend(thread);
            return KERN_SUCCESS;
        }
        case SingleStepMode::SoftwareBreakpoint:
        case SingleStepMode::SoftwareBreakpointContinue:
        {
            // Re-insert BRK instruction
            if (sw_bp_index >= 0 && sw_bp_index < MAX_SOFTWARE_BREAKPOINTS)
            {
                mach_vm_address_t bp_addr;
                bool still_active = false;

                {
                    std::lock_guard<std::mutex> sw_lock(software_breakpoint_mutex_);
                    if (software_breakpoint_used[sw_bp_index])
                    {
                        bp_addr = software_breakpoint_addresses[sw_bp_index];
                        still_active = true;
                    }
                }

                if (still_active)
                {
                    const uint32_t brk_instruction = 0xD4200000;
                    write_memory_native(pid_, bp_addr, 4, (unsigned char*)&brk_instruction);
                }
            }

            debug_state.__mdscr_el1 &= ~1ULL;
            thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                             ARM_DEBUG_STATE64_COUNT);

            if (mode == SingleStepMode::SoftwareBreakpointContinue)
            {
                std::lock_guard<std::mutex> lock(thread_states_mutex_);
                auto thread_it = thread_states_.find(thread);
                if (thread_it != thread_states_.end())
                {
                    thread_it->second.single_step_mode = SingleStepMode::None;
                    thread_it->second.current_software_breakpoint_index = -1;
                    thread_it->second.is_stopped = false;
                }
                debug_state_ = DebugState::Running;
                return KERN_SUCCESS;
            }

            // User-requested single step
            {
                std::lock_guard<std::mutex> lock(thread_states_mutex_);
                auto thread_it = thread_states_.find(thread);
                if (thread_it != thread_states_.end())
                {
                    thread_it->second.single_step_mode = SingleStepMode::None;
                    thread_it->second.current_software_breakpoint_index = -1;
                    thread_it->second.is_stopped = true;
                }
            }
            debug_state_ = DebugState::BreakpointHit;
            thread_suspend(thread);
            return KERN_SUCCESS;
        }
        case SingleStepMode::HardwareBreakpointContinue:
        {
            // Re-enable hardware breakpoint
            if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
            {
                mach_vm_address_t bp_addr = 0;
                bool still_active = false;

                {
                    std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
                    if (breakpoint_used[bp_index])
                    {
                        bp_addr = breakpoint_addresses[bp_index];
                        still_active = true;
                    }
                }

                if (still_active)
                {
                    debug_state.__bcr[bp_index] = (0xFULL << 5) | (2ULL << 1) | (1ULL << 0);
                }
            }

            debug_state.__mdscr_el1 &= ~1ULL;
            thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                             ARM_DEBUG_STATE64_COUNT);

            {
                std::lock_guard<std::mutex> lock(thread_states_mutex_);
                auto thread_it = thread_states_.find(thread);
                if (thread_it != thread_states_.end())
                {
                    thread_it->second.single_step_mode = SingleStepMode::None;
                    thread_it->second.current_breakpoint_index = -1;
                    thread_it->second.is_stopped = false;
                }
            }
            debug_state_ = DebugState::Running;
            return KERN_SUCCESS;
        }
        default:
            return KERN_FAILURE;
    }
}

// =============================================================================
// Debug State Query
// =============================================================================

DebugState Debugger::get_debug_state() const
{
    return debug_state_;
}

bool Debugger::is_in_break_state() const
{
    return debug_state_ == DebugState::BreakpointHit || debug_state_ == DebugState::WatchpointHit;
}
