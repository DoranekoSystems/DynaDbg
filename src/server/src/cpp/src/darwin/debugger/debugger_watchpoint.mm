/**
 * @file debugger_watchpoint.mm
 * @brief Watchpoint-related member functions for the Debugger class (Darwin/macOS)
 *
 * This file contains all watchpoint management functionality including:
 * - Hardware watchpoint set/remove operations
 * - Watchpoint hit handling
 * - Thread-specific watchpoint application
 * - Single-step completion for watchpoints
 *
 * Part of the DynaDbg Darwin debugger implementation.
 */

#include "debugger_internal.h"

// =============================================================================
// Public Watchpoint API
// =============================================================================

kern_return_t Debugger::set_watchpoint(mach_vm_address_t address, int size, WatchpointType type)
{
    thread_act_array_t thread_list;
    mach_msg_type_number_t thread_count;
    kern_return_t kr;

    kr = task_threads(task_port_, &thread_list, &thread_count);
    if (kr != KERN_SUCCESS || thread_count == 0)
    {
        debug_log(LOG_ERROR, "Failed to get threads: %s", kern_return_to_string(kr).c_str());
        return kr;
    }

    int index = find_free_watchpoint();
    if (index == -1)
    {
        debug_log(LOG_ERROR, "No free watchpoints available.");
        vm_deallocate(mach_task_self(), (vm_address_t)thread_list,
                      thread_count * sizeof(thread_act_t));
        return KERN_NO_SPACE;
    }

    // Reset sync state for this watchpoint slot
    watchpoint_sync_[index].removing.store(false);
    watchpoint_sync_[index].active_handlers.store(0);

    // Set watchpoint on all threads
    bool all_success = true;
    for (mach_msg_type_number_t i = 0; i < thread_count; i++)
    {
        kr = set_watchpoint_on_thread(thread_list[i], address, size, type, index);
        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to set watchpoint on thread %d: %s", i,
                      kern_return_to_string(kr).c_str());
            all_success = false;
            // Clear watchpoints on threads that were already set
            for (mach_msg_type_number_t j = 0; j < i; j++)
            {
                clear_watchpoint_on_thread(thread_list[j], index);
            }
            break;
        }
    }

    if (all_success)
    {
        std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
        watchpoint_used[index] = true;
        watchpoint_addresses[index] = address;
        watchpoint_sizes[index] = size;
        debug_log(LOG_INFO, "Watchpoint set successfully on all %d threads at address 0x%llx",
                  thread_count, address);
    }

    // Cleanup thread list
    for (mach_msg_type_number_t i = 0; i < thread_count; i++)
    {
        mach_port_deallocate(mach_task_self(), thread_list[i]);
    }
    vm_deallocate(mach_task_self(), (vm_address_t)thread_list, thread_count * sizeof(thread_act_t));

    return all_success ? KERN_SUCCESS : kr;
}

// Remove watchpoint from all threads
kern_return_t Debugger::remove_watchpoint(mach_vm_address_t address)
{
    int index = find_watchpoint_index(address);
    if (index == -1)
    {
        debug_log(LOG_ERROR, "Watchpoint not found for address: 0x%llx", address);
        return KERN_INVALID_ARGUMENT;
    }

    return remove_watchpoint_by_index(index);
}

// Index-based removal (reusable)
kern_return_t Debugger::remove_watchpoint_by_index(int index)
{
    if (index < 0 || index >= MAX_WATCHPOINTS || !watchpoint_used[index])
    {
        return KERN_INVALID_ARGUMENT;
    }

    // Set the removal flag for this specific watchpoint
    watchpoint_sync_[index].removing.store(true);

    // Wait for any in-progress hit handlers for this watchpoint to complete
    {
        std::unique_lock<std::mutex> lock(watchpoint_sync_[index].mutex);
        bool completed = watchpoint_sync_[index].cv.wait_for(
            lock, std::chrono::seconds(1),
            [this, index] { return watchpoint_sync_[index].active_handlers.load() == 0; });

        if (!completed)
        {
            debug_log(LOG_WARN,
                      "Timeout waiting for watchpoint %d handlers (count: %d), forcing reset",
                      index, watchpoint_sync_[index].active_handlers.load());
            // Force reset the counter to prevent accumulation
            watchpoint_sync_[index].active_handlers.store(0);
        }
    }

    thread_act_array_t thread_list;
    mach_msg_type_number_t thread_count;

    kern_return_t kr = task_threads(task_port_, &thread_list, &thread_count);
    if (kr != KERN_SUCCESS)
    {
        watchpoint_sync_[index].removing.store(false);  // Clear the flag
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

    // Remove from all threads
    bool all_success = true;
    for (mach_msg_type_number_t i = 0; i < thread_count; i++)
    {
        kr = clear_watchpoint_on_thread(thread_list[i], index);
        if (kr != KERN_SUCCESS)
        {
            all_success = false;
        }
    }

    // Clear the removal flag for this watchpoint
    watchpoint_sync_[index].removing.store(false);

    if (all_success)
    {
        std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
        mach_vm_address_t old_address = watchpoint_addresses[index];
        watchpoint_used[index] = false;
        watchpoint_addresses[index] = 0;
        watchpoint_sizes[index] = 0;

        debug_log(LOG_INFO, "Watchpoint removed from address 0x%llx", old_address);
        return KERN_SUCCESS;
    }

    return kr;
}

// =============================================================================
// Internal Watchpoint Operations
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

int Debugger::find_watchpoint_index(mach_vm_address_t address)
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

int Debugger::get_available_watchpoints(mach_port_t thread)
{
    arm_debug_state64_t debug_state;
    mach_msg_type_number_t count = ARM_DEBUG_STATE64_COUNT;
    kern_return_t kr =
        thread_get_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state, &count);
    if (kr != KERN_SUCCESS)
    {
        return MAX_WATCHPOINTS;
    }

    int available = 0;
    for (int i = 0; i < MAX_WATCHPOINTS; i++)
    {
        if ((debug_state.__wcr[i] & 1) == 0)
        {
            available++;
        }
    }
    return available;
}

kern_return_t Debugger::set_watchpoint_on_thread(mach_port_t thread, mach_vm_address_t address,
                                                 int size, WatchpointType type, int index)
{
    arm_debug_state64_t debug_state;
    memset(&debug_state, 0, sizeof(debug_state));
    mach_msg_type_number_t count = ARM_DEBUG_STATE64_COUNT;

    kern_return_t kr =
        thread_get_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state, &count);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to get thread debug state: %s",
                  kern_return_to_string(kr).c_str());
        return kr;
    }

    debug_state.__wvr[index] = address;

    uint64_t control = 0;
    switch (type)
    {
        case WatchpointType::READ:
            control = (1ULL << 0);
            break;  // Enable
        case WatchpointType::WRITE:
            control = (1ULL << 0) | (2ULL << 3);
            break;  // Enable + Write
        case WatchpointType::READWRITE:
            control = (1ULL << 0) | (3ULL << 3);
            break;  // Enable + Read/Write
    }

    // Set the LEN field based on the size
    uint64_t len_field = 0;
    switch (size)
    {
        case 1:
            len_field = 0;
            break;
        case 2:
            len_field = 1;
            break;
        case 4:
            len_field = 2;
            break;
        case 8:
            len_field = 3;
            break;
        default:
            debug_log(LOG_ERROR, "Invalid watchpoint size");
            return KERN_INVALID_ARGUMENT;
    }
    control |= (len_field << 5);

    // Set the security state bits
    control |= (2ULL << 1);  // Enable watchpoint for EL1 mode

    debug_state.__wcr[index] = control;

    // Set the MDSCR_EL1 bit (bit 15) to enable debug
    debug_state.__mdscr_el1 |= (1ULL << 15);

    kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state, count);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "thread_set_state failed: %s", kern_return_to_string(kr).c_str());
    }

    return kr;
}

// Helper function: Clear watchpoint from a single thread
kern_return_t Debugger::clear_watchpoint_on_thread(thread_t thread, int index)
{
    arm_debug_state64_t debug_state;
    memset(&debug_state, 0, sizeof(debug_state));
    mach_msg_type_number_t count = ARM_DEBUG_STATE64_COUNT;

    kern_return_t kr =
        thread_get_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state, &count);
    if (kr != KERN_SUCCESS)
    {
        return kr;
    }

    // Disable only the specified watchpoint
    debug_state.__wcr[index] = 0;
    debug_state.__wvr[index] = 0;

    return thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state, count);
}

// =============================================================================
// Watchpoint Hit Handling
// =============================================================================

kern_return_t Debugger::handle_watchpoint_hit(mach_port_t thread, arm_debug_state64_t& debug_state,
                                              arm_thread_state64_t& thread_state,
                                              arm_exception_state64_t& exception_state,
                                              int watchpoint_index)
{
    // Increment active handler count for this specific watchpoint
    watchpoint_sync_[watchpoint_index].active_handlers.fetch_add(1);

    // Scope guard to ensure count is decremented and condition variable is notified
    auto decrement_guard = [this, watchpoint_index](int*)
    {
        watchpoint_sync_[watchpoint_index].active_handlers.fetch_sub(1);
        if (watchpoint_sync_[watchpoint_index].active_handlers.load() == 0)
        {
            std::lock_guard<std::mutex> lock(watchpoint_sync_[watchpoint_index].mutex);
            watchpoint_sync_[watchpoint_index].cv.notify_all();
        }
    };
    static int dummy = 0;
    std::unique_ptr<int, decltype(decrement_guard)> guard(&dummy, decrement_guard);

    // Check if this watchpoint is being removed
    if (watchpoint_sync_[watchpoint_index].removing.load())
    {
        return KERN_SUCCESS;
    }

    // Temporarily disable the watchpoint
    debug_state.__wcr[watchpoint_index] &= ~(1ULL << 0);

    // Enable single-step mode
    debug_state.__mdscr_el1 |= 1ULL;

    kern_return_t kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                        ARM_DEBUG_STATE64_COUNT);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to set debug state: %s", mach_error_string(kr));
        return kr;
    }

    // debug_log_develop(LOG_INFO, "handle_watchpoint_hit: Updating thread_states_ map");

    // Update thread_states_ with mutex protection
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);

        // Re-check if being removed (may have been removed while acquiring lock)
        if (watchpoint_sync_[watchpoint_index].removing.load())
        {
            debug_log(LOG_INFO, "Watchpoint %d removed during processing, aborting",
                      watchpoint_index);
            return KERN_SUCCESS;
        }

        thread_states_[thread] = ThreadState{.single_step_mode = SingleStepMode::Watchpoint,
                                             .single_step_count = 0,
                                             .current_breakpoint_index = -1,
                                             .current_watchpoint_index = watchpoint_index,
                                             .is_stopped = false,  // Running during single-step
                                             .thread_state = thread_state,
                                             .debug_state = debug_state,
                                             .exception_state = exception_state};
    }

    // debug_log_develop(
    //     LOG_INFO,
    //     "handle_watchpoint_hit: Thread state updated successfully with watchpoint index %d",
    //     watchpoint_index);

    return KERN_SUCCESS;
}

// =============================================================================
// Watchpoint Single-Step Completion
// =============================================================================

kern_return_t Debugger::complete_watchpoint_single_step(mach_port_t thread,
                                                        arm_debug_state64_t& debug_state,
                                                        arm_thread_state64_t& thread_state,
                                                        arm_exception_state64_t& exception_state)
{
    // Get stored state for this thread
    int watchpoint_index = -1;
    arm_thread_state64_t original_thread_state = {};
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        auto it = thread_states_.find(thread);
        if (it != thread_states_.end())
        {
            watchpoint_index = it->second.current_watchpoint_index;
            original_thread_state = it->second.thread_state;  // PC at watchpoint hit
        }
    }

    if (watchpoint_index < 0 || watchpoint_index >= MAX_WATCHPOINTS)
    {
        debug_log(LOG_ERROR, "Invalid watchpoint index in single step completion");
        return KERN_INVALID_ARGUMENT;
    }

    // Check if this watchpoint is being removed
    if (watchpoint_sync_[watchpoint_index].removing.load())
    {
        debug_log(LOG_INFO, "Watchpoint %d is being removed, skipping re-enable", watchpoint_index);
        // Just disable single-step and return
        debug_state.__mdscr_el1 &= ~1ULL;
        return thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                ARM_DEBUG_STATE64_COUNT);
    }

    // Re-enable the watchpoint
    {
        std::lock_guard<std::mutex> lock(watchpoint_data_mutex_);
        if (watchpoint_used[watchpoint_index])
        {
            debug_state.__wcr[watchpoint_index] |= (1ULL << 0);
        }
    }

    // Disable single-step mode
    debug_state.__mdscr_el1 &= ~1ULL;

    // Clear thread state
    {
        std::lock_guard<std::mutex> lock(thread_states_mutex_);
        thread_states_.erase(thread);
    }

    kern_return_t kr = thread_set_state(thread, ARM_DEBUG_STATE64, (thread_state_t)&debug_state,
                                        ARM_DEBUG_STATE64_COUNT);
    if (kr != KERN_SUCCESS)
    {
        debug_log(LOG_ERROR, "Failed to set debug state: %s", mach_error_string(kr));
        return kr;
    }

    // debug_log_develop(LOG_INFO, "Watchpoint hit notification sent for address 0x%llx",
    //                   watchpoint_address);

    return KERN_SUCCESS;
}
