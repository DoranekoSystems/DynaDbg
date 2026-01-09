/**
 * @file debugger_breakpoint.mm
 * @brief Breakpoint-related member functions for the Debugger class (Darwin/macOS)
 *
 * This file contains all breakpoint management functionality including:
 * - Hardware breakpoint set/remove operations
 * - Software breakpoint set/remove operations
 * - Breakpoint hit handling
 * - Single-step continuation for breakpoints
 *
 * Part of the DynaDbg Darwin debugger implementation.
 */

#include "debugger_internal.h"

// =============================================================================
// Public Breakpoint API
// =============================================================================

kern_return_t Debugger::set_breakpoint(mach_vm_address_t address, int hit_count, bool is_software,
                                       mach_vm_address_t end_address)
{
    if (is_software)
    {
        return set_software_breakpoint(address, hit_count);
    }
    else
    {
        return set_hardware_breakpoint(address, hit_count, end_address);
    }
}

kern_return_t Debugger::set_hardware_breakpoint(mach_vm_address_t address, int hit_count,
                                                mach_vm_address_t end_address)
{
    // Reset trace ended flag when setting a new breakpoint (new trace session)
    trace_session_ended_by_end_address_ = false;

    // Reset tracked trace thread for new trace session
    tracked_trace_thread_.store(MACH_PORT_NULL);

    thread_act_array_t thread_list;
    mach_msg_type_number_t thread_count;
    kern_return_t kr;

    kr = task_threads(task_port_, &thread_list, &thread_count);
    if (kr != KERN_SUCCESS || thread_count == 0)
    {
        debug_log(LOG_ERROR, "Failed to get threads: %s", kern_return_to_string(kr).c_str());
        return kr;
    }

    int index = find_free_breakpoint();
    if (index == -1)
    {
        debug_log(LOG_ERROR, "No free breakpoints available.");
        return KERN_NO_SPACE;
    }

    // Reset sync state for this breakpoint slot
    breakpoint_sync_[index].removing.store(false);
    breakpoint_sync_[index].active_handlers.store(0);

    // Use scope guard to ensure cleanup
    auto cleanup = [&](void*)
    {
        for (mach_msg_type_number_t i = 0; i < thread_count; i++)
        {
            mach_port_deallocate(mach_task_self(), thread_list[i]);
        }
        vm_deallocate(mach_task_self(), (vm_address_t)thread_list,
                      thread_count * sizeof(thread_act_t));
    };
    std::unique_ptr<void, decltype(cleanup)> guard(nullptr, cleanup);

    // Set breakpoint on all threads
    bool all_success = true;
    for (mach_msg_type_number_t i = 0; i < thread_count; i++)
    {
        arm_debug_state64_t debug_state;
        memset(&debug_state, 0, sizeof(debug_state));
        mach_msg_type_number_t count = ARM_DEBUG_STATE64_COUNT;
        kr = thread_get_state(thread_list[i], ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                              &count);
        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to get debug state for thread %d: %s", i,
                      kern_return_to_string(kr).c_str());
            all_success = false;
            continue;
        }

        debug_state.__bvr[index] = address;
        debug_state.__bcr[index] =
            (1ULL << 0) | (2ULL << 1) | (1ULL << 5);  // Enable, EL1, all sizes
        debug_state.__mdscr_el1 |= (1ULL << 15);      // Enable debug

        kr = thread_set_state(thread_list[i], ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                              count);
        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to set breakpoint on thread %d: %s", i,
                      kern_return_to_string(kr).c_str());
            all_success = false;
        }
    }

    if (all_success)
    {
        breakpoint_used[index] = true;
        breakpoint_addresses[index] = address;
        breakpoint_hit_counts[index] = 0;
        breakpoint_target_counts[index] = hit_count;
        breakpoint_end_addresses[index] = end_address;
        if (end_address != 0)
        {
            debug_log(LOG_INFO,
                      "Hardware breakpoint set successfully at address 0x%llx on all %d "
                      "threads (end_address: 0x%llx)",
                      address, thread_count, end_address);
        }
        else
        {
            debug_log(LOG_INFO,
                      "Hardware breakpoint set successfully at address 0x%llx on all %d threads",
                      address, thread_count);
        }
    }
    else
    {
        debug_log(LOG_ERROR, "Failed to set hardware breakpoint on some threads");
    }

    return all_success ? KERN_SUCCESS : kr;
}

kern_return_t Debugger::set_software_breakpoint(mach_vm_address_t address, int hit_count)
{
    // debug_log_develop(LOG_INFO, "Setting software breakpoint at 0x%llx", address);

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
        return KERN_NO_SPACE;
    }

    // ARM64: 4 bytes per instruction
    const size_t bp_size = 4;
    const uint32_t brk_instruction = 0xD4200000;  // BRK #0

    // Read original instruction bytes
    uint8_t original_bytes[4] = {0};
    ssize_t bytes_read = read_memory_native(pid_, address, bp_size, original_bytes);
    if (bytes_read != (ssize_t)bp_size)
    {
        debug_log(LOG_ERROR, "Failed to read memory at 0x%llx for software breakpoint", address);
        return KERN_FAILURE;
    }

    // debug_log_develop(LOG_DEBUG, "Original bytes at 0x%llx: %02x %02x %02x %02x", address,
    //                  original_bytes[0], original_bytes[1], original_bytes[2], original_bytes[3]);

    // Write breakpoint instruction
    ssize_t bytes_written =
        write_memory_native(pid_, address, bp_size, (unsigned char*)&brk_instruction);
    if (bytes_written != (ssize_t)bp_size)
    {
        debug_log(LOG_ERROR, "Failed to write software breakpoint at 0x%llx", address);
        return KERN_FAILURE;
    }

    // Store breakpoint info
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        software_breakpoint_used[index] = true;
        software_breakpoint_addresses[index] = address;
        memcpy(&software_breakpoint_original_bytes[index * 4], original_bytes, 4);
    }

    // debug_log(
    //    LOG_INFO, "Software breakpoint set at 0x%llx (index %d), original: %02x %02x %02x %02x",
    //    address, index, original_bytes[0], original_bytes[1], original_bytes[2],
    //    original_bytes[3]);

    return KERN_SUCCESS;
}

kern_return_t Debugger::remove_software_breakpoint(mach_vm_address_t address)
{
    // debug_log_develop(LOG_INFO, "Removing software breakpoint at 0x%llx", address);

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
        debug_log(LOG_ERROR, "Software breakpoint not found at address 0x%llx", address);
        return KERN_INVALID_ARGUMENT;
    }

    // Restore original instruction
    const size_t bp_size = 4;
    ssize_t bytes_written = write_memory_native(pid_, address, bp_size, original_bytes);
    if (bytes_written != (ssize_t)bp_size)
    {
        debug_log(LOG_ERROR, "Failed to restore original instruction at 0x%llx", address);
        return KERN_FAILURE;
    }

    // Clear breakpoint info
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        software_breakpoint_used[index] = false;
        software_breakpoint_addresses[index] = 0;
        memset(&software_breakpoint_original_bytes[index * 4], 0, 4);
    }

    // debug_log_develop(LOG_INFO, "Software breakpoint removed at 0x%llx (index %d)", address,
    // index);

    return KERN_SUCCESS;
}

kern_return_t Debugger::remove_breakpoint(mach_vm_address_t address)
{
    // First, check if this is a software breakpoint
    bool is_software_bp = false;
    {
        std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);
        for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
        {
            if (software_breakpoint_used[i] && software_breakpoint_addresses[i] == address)
            {
                is_software_bp = true;
                break;
            }
        }
    }

    if (is_software_bp)
    {
        // Found as software breakpoint, remove it (outside of lock)
        return remove_software_breakpoint(address);
    }

    // Otherwise, try to remove as hardware breakpoint
    int index = find_breakpoint_index(address);
    if (index == -1)
    {
        debug_log(LOG_ERROR, "Breakpoint not found for address: 0x%llx", address);
        return KERN_INVALID_ARGUMENT;
    }

    // Set the removal flag for this specific breakpoint
    breakpoint_sync_[index].removing.store(true);

    // Wait for any in-progress hit handlers for this breakpoint to complete
    {
        std::unique_lock<std::mutex> lock(breakpoint_sync_[index].mutex);
        bool completed = breakpoint_sync_[index].cv.wait_for(
            lock, std::chrono::seconds(1),
            [this, index] { return breakpoint_sync_[index].active_handlers.load() == 0; });

        if (!completed)
        {
            debug_log(LOG_WARN,
                      "Timeout waiting for breakpoint %d handlers (count: %d), forcing reset",
                      index, breakpoint_sync_[index].active_handlers.load());
            // Force reset the counter to prevent accumulation
            breakpoint_sync_[index].active_handlers.store(0);
        }
    }

    thread_act_array_t thread_list;
    mach_msg_type_number_t thread_count;
    kern_return_t kr;

    kr = task_threads(task_port_, &thread_list, &thread_count);
    if (kr != KERN_SUCCESS || thread_count == 0)
    {
        debug_log(LOG_ERROR, "Failed to get threads: %s", kern_return_to_string(kr).c_str());
        breakpoint_sync_[index].removing.store(false);  // Clear the flag
        return kr;
    }

    // Use scope guard to ensure cleanup
    auto cleanup = [&](void*)
    {
        for (mach_msg_type_number_t i = 0; i < thread_count; i++)
        {
            mach_port_deallocate(mach_task_self(), thread_list[i]);
        }
        vm_deallocate(mach_task_self(), (vm_address_t)thread_list,
                      thread_count * sizeof(thread_act_t));
    };
    std::unique_ptr<void, decltype(cleanup)> guard(nullptr, cleanup);

    // Remove breakpoint from all threads
    bool all_success = true;
    for (mach_msg_type_number_t i = 0; i < thread_count; i++)
    {
        arm_debug_state64_t debug_state;
        memset(&debug_state, 0, sizeof(debug_state));
        mach_msg_type_number_t count = ARM_DEBUG_STATE64_COUNT;
        kr = thread_get_state(thread_list[i], ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                              &count);
        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to get debug state for thread %d: %s", i,
                      kern_return_to_string(kr).c_str());
            all_success = false;
            continue;
        }

        debug_state.__bcr[index] = 0;  // Disable the breakpoint
        kr = thread_set_state(thread_list[i], ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                              count);
        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to remove breakpoint from thread %d: %s", i,
                      kern_return_to_string(kr).c_str());
            all_success = false;
        }
    }

    if (all_success)
    {
        breakpoint_used[index] = false;
        breakpoint_addresses[index] = 0;
        breakpoint_hit_counts[index] = 0;
        breakpoint_target_counts[index] = 0;
        breakpoint_end_addresses[index] = 0;

        // Update thread states related to this breakpoint - clear breakpoint reference but keep
        // thread state
        for (auto& thread_state_pair : thread_states_)
        {
            if (thread_state_pair.second.current_breakpoint_index == index)
            {
                // debug_log(
                //    LOG_DEBUG,
                //    "Clearing breakpoint reference for thread %d but keeping thread in break
                //    state", thread_state_pair.first);

                // Clear the breakpoint index but keep the thread in break state
                thread_state_pair.second.current_breakpoint_index = -1;
            }
        }

        // debug_log_develop(LOG_INFO,
        //                  "Breakpoint removed successfully from address 0x%llx on all %d threads",
        //                  address, thread_count);
    }
    else
    {
        debug_log(LOG_ERROR, "Failed to remove breakpoint from some threads");
    }

    // Clear the removal flag for this breakpoint
    breakpoint_sync_[index].removing.store(false);

    return all_success ? KERN_SUCCESS : kr;
}

// Get original instruction bytes for software breakpoint
bool Debugger::get_software_breakpoint_original_bytes(uint64_t address, uint8_t* out_bytes,
                                                      size_t* out_size)
{
    if (!out_bytes || !out_size)
    {
        return false;
    }

    std::lock_guard<std::mutex> lock(software_breakpoint_mutex_);

    for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
    {
        if (software_breakpoint_used[i] && software_breakpoint_addresses[i] == address)
        {
            // ARM64: 4 bytes per instruction
            memcpy(out_bytes, &software_breakpoint_original_bytes[i * 4], 4);
            *out_size = 4;

            return true;
        }
    }

    return false;
}

// =============================================================================
// Internal Breakpoint Operations
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

int Debugger::find_breakpoint_index(mach_vm_address_t address)
{
    std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
    for (int i = 0; i < MAX_BREAKPOINTS; i++)
    {
        if (breakpoint_used[i] && breakpoint_addresses[i] == address)
        {
            return i;
        }
    }
    return -1;
}

// =============================================================================
// Breakpoint Hit Handling
// =============================================================================

kern_return_t Debugger::handle_breakpoint_hit(mach_port_t thread, arm_debug_state64_t& debug_state,
                                              arm_thread_state64_t& thread_state,
                                              arm_exception_state64_t& exception_state,
                                              int breakpoint_index)
{
    // Increment active handler count for this specific breakpoint
    breakpoint_sync_[breakpoint_index].active_handlers.fetch_add(1);

    // Scope guard to ensure count is decremented and condition variable is notified
    auto decrement_guard = [this, breakpoint_index](int*)
    {
        breakpoint_sync_[breakpoint_index].active_handlers.fetch_sub(1);
        if (breakpoint_sync_[breakpoint_index].active_handlers.load() == 0)
        {
            std::lock_guard<std::mutex> lock(breakpoint_sync_[breakpoint_index].mutex);
            breakpoint_sync_[breakpoint_index].cv.notify_all();
        }
    };
    static int dummy = 0;
    std::unique_ptr<int, decltype(decrement_guard)> guard(&dummy, decrement_guard);

    // Check if this breakpoint is being removed
    if (breakpoint_sync_[breakpoint_index].removing.load())
    {
        return KERN_SUCCESS;
    }

    // Increment hit_count protected by breakpoint_data_mutex_
    int current_hit_count;
    int target_count;
    mach_vm_address_t end_address;
    {
        std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
        breakpoint_hit_counts[breakpoint_index]++;
        current_hit_count = breakpoint_hit_counts[breakpoint_index];
        target_count = breakpoint_target_counts[breakpoint_index];
        end_address = breakpoint_end_addresses[breakpoint_index];
    }

    // Check if PC has reached the end address (if set)
    mach_vm_address_t current_pc = thread_state.__pc;
    bool reached_end_address = (end_address != 0) && (current_pc == end_address);

    if (reached_end_address)
    {
        // debug_log_develop(LOG_INFO,
        //                  "PC reached end address 0x%llx, stopping trace",
        //                  end_address);

        // Set flag to indicate trace ended by end_address
        trace_session_ended_by_end_address_ = true;

        // Close trace file if enabled
        {
            std::lock_guard<std::mutex> lock(trace_file_mutex_);
            if (trace_file_enabled_ && trace_file_writer_)
            {
                trace_file_writer_->close();
                debug_log(LOG_INFO, "Trace file closed due to end_address reached (entries: %u)",
                          trace_file_writer_->get_entry_count());
                trace_file_enabled_ = false;
            }
        }

        // Also close memory cache files if enabled
        disable_full_memory_cache();

        mach_vm_address_t bp_address;
        {
            std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
            bp_address = breakpoint_addresses[breakpoint_index];
        }
        remove_breakpoint(bp_address);
        return KERN_SUCCESS;
    }

    if (current_hit_count < target_count)
    {
        // Set thread-specific single step mode
        {
            std::lock_guard<std::mutex> lock(thread_states_mutex_);

            // Re-check if being removed
            if (breakpoint_sync_[breakpoint_index].removing.load())
            {
                return KERN_SUCCESS;
            }

            thread_states_[thread] = ThreadState{.single_step_mode = SingleStepMode::Breakpoint,
                                                 .single_step_count = 0,
                                                 .current_breakpoint_index = breakpoint_index,
                                                 .current_watchpoint_index = -1,
                                                 .is_stopped = false,  // Running during single-step
                                                 .thread_state = thread_state,
                                                 .debug_state = debug_state,
                                                 .exception_state = exception_state};
        }

        // Enable single-step mode
        debug_state.__mdscr_el1 |= 1ULL;
        kern_return_t kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                            ARM_DEBUG_STATE64_COUNT);
        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to set single-step mode: %s", mach_error_string(kr));
            return kr;
        }
    }
    else
    {
        mach_vm_address_t bp_address;
        {
            std::lock_guard<std::mutex> lock(breakpoint_data_mutex_);
            bp_address = breakpoint_addresses[breakpoint_index];
        }
        remove_breakpoint(bp_address);
    }

    return KERN_SUCCESS;
}

// =============================================================================
// Breakpoint Single-Step Continuation
// =============================================================================

kern_return_t Debugger::continue_breakpoint_single_step(mach_port_t thread,
                                                        arm_debug_state64_t& debug_state,
                                                        arm_thread_state64_t& thread_state,
                                                        arm_exception_state64_t& exception_state)
{
    // Disable single-step mode
    debug_state.__mdscr_el1 &= ~1ULL;

    // Get breakpoint index from thread state
    int bp_index = -1;
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        auto it = thread_states_.find(thread);
        if (it != thread_states_.end())
        {
            bp_index = it->second.current_breakpoint_index;
            thread_states_.erase(it);
        }
    }

    kern_return_t kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                        ARM_DEBUG_STATE64_COUNT);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to disable single-step mode: %s", mach_error_string(kr));
        return kr;
    }

    return KERN_SUCCESS;
}
