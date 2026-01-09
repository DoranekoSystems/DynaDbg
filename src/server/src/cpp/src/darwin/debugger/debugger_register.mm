/**
 * @file debugger_register.mm
 * @brief Register read/write and execution control related Debugger class member functions
 * (Darwin/macOS)
 *
 * This file contains the implementation of register read/write, execution continuation,
 * and single-step functionality for the Darwin debugger.
 *
 * Functions included:
 *   - read_register: Read register value from stopped thread
 *   - write_register: Write register value to stopped thread
 *   - continue_execution: Continue execution from break state
 *   - single_step: Execute single step from break state
 */

#include "debugger_internal.h"

// =============================================================================
// Execution Control
// =============================================================================

kern_return_t Debugger::continue_execution(mach_port_t thread_id)
{
    std::lock_guard<std::mutex> lock(thread_states_mutex_);

    auto thread_it = thread_states_.find(thread_id);
    if (thread_it == thread_states_.end())
    {
        debug_log_develop(LOG_ERROR, "Thread %d not found in break state", thread_id);
        return KERN_INVALID_ARGUMENT;
    }

    // Check if thread is actually stopped
    if (!thread_it->second.is_stopped)
    {
        debug_log(LOG_WARN, "Thread %d is not in stopped state", thread_id);
        return KERN_INVALID_ARGUMENT;
    }

    int sw_bp_index = thread_it->second.current_software_breakpoint_index;

    // Handle software breakpoint: need to restore original, single step, then re-insert
    if (sw_bp_index >= 0 && sw_bp_index < MAX_SOFTWARE_BREAKPOINTS)
    {
        mach_vm_address_t bp_addr;
        uint8_t original_bytes[4];
        bool valid = false;

        {
            std::lock_guard<std::mutex> sw_lock(software_breakpoint_mutex_);
            if (software_breakpoint_used[sw_bp_index])
            {
                bp_addr = software_breakpoint_addresses[sw_bp_index];
                int offset = sw_bp_index * 4;
                for (int j = 0; j < 4; j++)
                {
                    original_bytes[j] = software_breakpoint_original_bytes[offset + j];
                }
                valid = true;
            }
        }

        if (valid)
        {
            // debug_log_develop(
            //     LOG_INFO,
            //     "Continuing from software breakpoint at 0x%llx - restoring original instruction",
            //     bp_addr);

            // Restore original instruction
            ssize_t bytes_written = write_memory_native(pid_, bp_addr, 4, original_bytes);
            if (bytes_written != 4)
            {
                debug_log(LOG_ERROR, "Failed to restore original instruction at 0x%llx", bp_addr);
            }

            // Enable single-step mode to step over and re-insert breakpoint
            thread_it->second.debug_state.__mdscr_el1 |= 1ULL;
            kern_return_t kr = thread_set_state(thread_id, ARM_DEBUG_STATE64,
                                                (thread_state_t)&thread_it->second.debug_state,
                                                ARM_DEBUG_STATE64_COUNT);
            if (kr != KERN_SUCCESS)
            {
                debug_log(LOG_ERROR, "Failed to enable single-step mode for continue: %s",
                          mach_error_string(kr));
            }

            // Set up for software breakpoint continue
            thread_it->second.single_step_mode = SingleStepMode::SoftwareBreakpointContinue;
            thread_it->second.is_stopped = false;
            debug_state_ = DebugState::SingleStepping;

            // Resume thread
            kr = thread_resume(thread_id);
            if (kr != KERN_SUCCESS)
            {
                debug_log(LOG_ERROR, "Failed to resume thread %d: %s", thread_id,
                          mach_error_string(kr));
                return kr;
            }

            // debug_log_develop(LOG_INFO, "Thread %d single-stepping over software breakpoint",
            //                   thread_id);
            return KERN_SUCCESS;
        }
    }

    // Always resume the suspended thread to continue execution
    kern_return_t kr = thread_resume(thread_id);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to resume thread %d: %s", thread_id, mach_error_string(kr));
        return kr;
    }

    // Mark thread as running
    thread_it->second.is_stopped = false;

    if (thread_it->second.current_breakpoint_index >= 0)
    {
        // debug_log_develop(LOG_INFO,
        //                   "Thread %d resumed, execution "
        //                   "continuing from hardware breakpoint",
        //                   thread_id);
    }
    else
    {
        // debug_log_develop(LOG_INFO,
        //                   "Thread %d resumed, execution "
        //                   "continuing (breakpoint was removed)",
        //                   thread_id);
    }

    // If this was the current thread, reset global state
    if (current_thread == thread_id)
    {
        debug_state_ = DebugState::Running;
        current_thread = MACH_PORT_NULL;
    }

    return KERN_SUCCESS;
}

kern_return_t Debugger::single_step(mach_port_t thread_id)
{
    std::lock_guard<std::mutex> lock(thread_states_mutex_);

    auto thread_it = thread_states_.find(thread_id);
    if (thread_it == thread_states_.end())
    {
        // Log which threads are actually in break state
        debug_log(LOG_ERROR, "Thread %d not found in break state. Stopped threads:", thread_id);
        for (const auto& pair : thread_states_)
        {
            debug_log(LOG_ERROR, "  - Thread %d (is_stopped=%d, bp_index=%d)", pair.first,
                      pair.second.is_stopped, pair.second.current_breakpoint_index);
        }
        if (thread_states_.empty())
        {
            debug_log(LOG_ERROR, "  (no threads in break state)");
        }
        return KERN_INVALID_ARGUMENT;
    }

    // Check if thread is actually stopped
    if (!thread_it->second.is_stopped)
    {
        debug_log(LOG_WARN, "Thread %d is not in stopped state for single step", thread_id);
        return KERN_INVALID_ARGUMENT;
    }

    // Temporarily disable the current breakpoint to avoid re-triggering during
    // single step
    int bp_index = thread_it->second.current_breakpoint_index;
    int sw_bp_index = thread_it->second.current_software_breakpoint_index;

    if (bp_index >= 0 && bp_index < MAX_BREAKPOINTS)
    {
        debug_log(LOG_ERROR,
                  "Temporarily disabling breakpoint %d "
                  "for single step",
                  bp_index);
        thread_it->second.debug_state.__bcr[bp_index] = 0;  // Disable breakpoint
    }

    // Handle software breakpoint: restore original instruction before stepping
    if (sw_bp_index >= 0 && sw_bp_index < MAX_SOFTWARE_BREAKPOINTS)
    {
        mach_vm_address_t bp_addr;
        uint8_t original_bytes[4];
        bool valid = false;

        {
            std::lock_guard<std::mutex> sw_lock(software_breakpoint_mutex_);
            if (software_breakpoint_used[sw_bp_index])
            {
                bp_addr = software_breakpoint_addresses[sw_bp_index];
                int offset = sw_bp_index * 4;
                for (int j = 0; j < 4; j++)
                {
                    original_bytes[j] = software_breakpoint_original_bytes[offset + j];
                }
                valid = true;
            }
        }

        if (valid)
        {
            // debug_log_develop(
            //     LOG_INFO, "Temporarily restoring original instruction at 0x%llx for single step",
            //     bp_addr);

            // Restore original instruction
            ssize_t bytes_written = write_memory_native(pid_, bp_addr, 4, original_bytes);
            if (bytes_written != 4)
            {
                debug_log(LOG_ERROR, "Failed to restore original instruction at 0x%llx", bp_addr);
            }
        }
    }

    // Enable single-step mode
    thread_it->second.debug_state.__mdscr_el1 |= 1ULL;
    kern_return_t kr =
        thread_set_state(thread_id, ARM_DEBUG_STATE64,
                         (thread_state_t)&thread_it->second.debug_state, ARM_DEBUG_STATE64_COUNT);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR,
                  "Failed to enable single-step mode "
                  "for thread %d: %s",
                  thread_id, mach_error_string(kr));
        return kr;
    }

    // Set debug state before resuming thread
    if (current_thread == thread_id)
    {
        debug_state_ = DebugState::SingleStepping;
    }
    // Use appropriate single step mode based on breakpoint type
    if (sw_bp_index >= 0)
    {
        thread_it->second.single_step_mode = SingleStepMode::SoftwareBreakpoint;
    }
    else
    {
        thread_it->second.single_step_mode = SingleStepMode::Breakpoint;
    }
    thread_it->second.single_step_count = 1;
    thread_it->second.is_stopped = false;  // Mark as running during single-step

    // Resume the suspended thread for single step execution
    kr = thread_resume(thread_id);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to resume thread %d for single step: %s", thread_id,
                  mach_error_string(kr));
        thread_it->second.is_stopped = true;  // Restore stopped state on failure
        return kr;
    }

    // debug_log_develop(LOG_INFO, "Single step initiated for thread %d", thread_id);

    return KERN_SUCCESS;
}

// =============================================================================
// Register Read/Write
// =============================================================================

kern_return_t Debugger::read_register(mach_port_t thread_id, const std::string& reg_name,
                                      uint64_t* value)
{
    if (value == nullptr)
    {
        return KERN_INVALID_ARGUMENT;
    }

    std::lock_guard<std::mutex> lock(thread_states_mutex_);

    auto thread_it = thread_states_.find(thread_id);
    if (thread_it == thread_states_.end())
    {
        debug_log(LOG_ERROR, "Thread %d not found in break state", thread_id);
        return KERN_INVALID_ARGUMENT;
    }

    // Check if thread is stopped
    if (!thread_it->second.is_stopped)
    {
        debug_log(LOG_WARN, "Thread %d is not stopped, cannot read register", thread_id);
        return KERN_INVALID_ARGUMENT;
    }

    // Get the latest thread state directly from the thread
    arm_thread_state64_t thread_state;
    mach_msg_type_number_t count = ARM_THREAD_STATE64_COUNT;
    kern_return_t kr =
        thread_get_state(thread_id, ARM_THREAD_STATE64, (thread_state_t)&thread_state, &count);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to get thread state for thread %d: %s", thread_id,
                  mach_error_string(kr));
        return kr;
    }

    // Also update the cached state
    thread_it->second.thread_state = thread_state;

    if (reg_name == "pc")
    {
        *value = thread_state.__pc;
    }
    else if (reg_name == "lr")
    {
        *value = thread_state.__lr;
    }
    else if (reg_name == "fp")
    {
        *value = thread_state.__fp;
    }
    else if (reg_name == "sp")
    {
        *value = thread_state.__sp;
    }
    else if (reg_name == "cpsr")
    {
        *value = thread_state.__cpsr;
    }
    else if (reg_name.length() >= 2 && reg_name[0] == 'x')
    {
        // Handle x0-x29 registers
        int reg_num = std::stoi(reg_name.substr(1));
        if (reg_num >= 0 && reg_num <= 29)
        {
            *value = thread_state.__x[reg_num];
        }
        else
        {
            return KERN_INVALID_ARGUMENT;
        }
    }
    else
    {
        return KERN_INVALID_ARGUMENT;
    }

    return KERN_SUCCESS;
}

kern_return_t Debugger::write_register(mach_port_t thread_id, const std::string& reg_name,
                                       uint64_t value)
{
    // debug_log_develop(LOG_INFO, "write_register: thread_id=%d, reg_name=%s, value=0x%llx",
    //                   thread_id, reg_name.c_str(), value);

    std::lock_guard<std::mutex> lock(thread_states_mutex_);

    auto thread_it = thread_states_.find(thread_id);
    if (thread_it == thread_states_.end())
    {
        debug_log(LOG_ERROR, "Thread %d not found in break state. Available threads:", thread_id);
        for (const auto& pair : thread_states_)
        {
            debug_log(LOG_ERROR, "  - Thread %d (is_stopped=%d)", pair.first,
                      pair.second.is_stopped);
        }
        return KERN_INVALID_ARGUMENT;
    }

    // Check if thread is stopped
    if (!thread_it->second.is_stopped)
    {
        debug_log(LOG_WARN, "Thread %d is not stopped, cannot write register", thread_id);
        return KERN_INVALID_ARGUMENT;
    }

    auto& thread_state = thread_it->second.thread_state;

    if (reg_name == "pc")
    {
        thread_state.__pc = value;
    }
    else if (reg_name == "lr")
    {
        thread_state.__lr = value;
    }
    else if (reg_name == "fp")
    {
        thread_state.__fp = value;
    }
    else if (reg_name == "sp")
    {
        thread_state.__sp = value;
    }
    else if (reg_name == "cpsr")
    {
        thread_state.__cpsr = value;
    }
    else if (reg_name.length() >= 2 && reg_name[0] == 'x')
    {
        // Handle x0-x29 registers
        int reg_num = std::stoi(reg_name.substr(1));
        if (reg_num >= 0 && reg_num <= 29)
        {
            thread_state.__x[reg_num] = value;
        }
        else
        {
            return KERN_INVALID_ARGUMENT;
        }
    }
    else
    {
        return KERN_INVALID_ARGUMENT;
    }

    // Apply the changes to the thread
    kern_return_t kr = thread_set_state(thread_id, ARM_THREAD_STATE64,
                                        (thread_state_t)&thread_state, ARM_THREAD_STATE64_COUNT);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to write register for thread %d: %s", thread_id,
                  mach_error_string(kr));
        return kr;
    }

    // debug_log_develop(LOG_INFO, "write_register: SUCCESS thread_id=%d, reg_name=%s,
    // value=0x%llx",
    //                   thread_id, reg_name.c_str(), value);
    return KERN_SUCCESS;
}
