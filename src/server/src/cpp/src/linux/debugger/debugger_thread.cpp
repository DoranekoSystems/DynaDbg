/**
 * @file debugger_thread.cpp
 * @brief Thread management functions for the Linux Debugger class
 *
 * This file contains member functions of the Debugger class that handle
 * thread-related operations including:
 * - Thread enumeration and listing
 * - Thread attachment using ptrace
 * - Debug message loop and event handling
 * - Stopping and resuming threads
 * - Thread state verification
 *
 * These functions are extracted from the main debugger.cpp for better
 * code organization and maintainability.
 */

#include "debugger_internal.h"

std::vector<pid_t> Debugger::get_thread_list()
{
    std::vector<pid_t> threads;
    char task_path[256];
    snprintf(task_path, sizeof(task_path), "/proc/%d/task", pid_);

    DIR* dir = opendir(task_path);
    if (!dir)
    {
        debug_log(LOG_ERROR, "Failed to open task directory: %s", task_path);
        return threads;
    }

    struct dirent* entry;
    while ((entry = readdir(dir)) != nullptr)
    {
        if (entry->d_type == DT_DIR)
        {
            pid_t tid = atoi(entry->d_name);
            if (tid > 0)
            {
                // Check thread state to exclude zombie/dead threads
                char status_path[256];
                snprintf(status_path, sizeof(status_path), "/proc/%d/task/%d/status", pid_, tid);

                FILE* fp = fopen(status_path, "r");
                if (!fp)
                {
                    // Thread may have exited, skip it
                    continue;
                }

                char line[256];
                char state = '\0';
                while (fgets(line, sizeof(line), fp))
                {
                    if (strncmp(line, "State:", 6) == 0)
                    {
                        // Find state character after whitespace
                        const char* state_ptr = line + 6;
                        while (*state_ptr == ' ' || *state_ptr == '\t') state_ptr++;
                        state = *state_ptr;
                        break;
                    }
                }
                fclose(fp);

                // Skip zombie (Z), dead (X/x) threads
                // R=running, S=sleeping, D=disk sleep, T=stopped, t=tracing stop
                if (state == 'Z' || state == 'X' || state == 'x')
                {
                    continue;
                }

                threads.push_back(tid);
            }
        }
    }

    closedir(dir);
    return threads;
}

int Debugger::attach_to_threads()
{
    std::vector<pid_t> threads = get_thread_list();

    for (pid_t tid : threads)
    {
        // Use PTRACE_SEIZE with PTRACE_O_TRACECLONE option
        // This automatically attaches to new threads created via clone()
        if (PTRACE_CALL(DYNA_PTRACE_SEIZE, tid, nullptr, PTRACE_O_TRACECLONE) == -1)
        {
            debug_log(LOG_ERROR, "Failed to seize thread %d: %s", tid, strerror(errno));
            continue;
        }

        // PTRACE_SEIZE doesn't stop the process, so we continue normally
        // No need to wait or continue as the thread remains running

        attached_threads_.insert(tid);
        thread_states_[tid].is_attached = true;
    }

    return attached_threads_.empty() ? -1 : 0;
}

void Debugger::debug_message_loop()
{
    // Attach to all threads if not already attached and we have a valid pid
    // Skip if pid_ is 0 (spawn mode - pid will be set by spawn command)
    if (!threads_attached_ && pid_ != 0)
    {
        int result = attach_to_threads();
        if (result == 0)
        {
            threads_attached_ = true;
        }
        else
        {
            debug_log(LOG_ERROR, "Failed to attach to threads in debug thread (pid=%d)", pid_);
            return;
        }
    }

    while (debug_loop_running_)
    {
        // Process command queue first (this may include spawn commands that set up threads)
        process_command_queue();

        // Handle debug events
        pid_t thread_id;
        int status;

        int result = wait_for_debug_event(&thread_id, &status);
        if (result == 0)
        {
            handle_exception(thread_id, status);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

int Debugger::wait_for_debug_event(pid_t* thread_id, int* status)
{
    // Wait for any child process
    pid_t tid = waitpid(-1, status, WNOHANG);

    if (tid > 0 && attached_threads_.count(tid) > 0)
    {
        *thread_id = tid;
        return 0;
    }

    return -1;
}

std::vector<pid_t> Debugger::stop_all_threads(pid_t exclude_thread_id,
                                              std::vector<pid_t>* already_stopped_out)
{
    std::vector<pid_t> stopped_threads;

    // With PTRACE_O_TRACECLONE, new threads are automatically attached
    // Just verify our attached_threads_ list against /proc to clean up dead threads
    std::vector<pid_t> current_threads = get_thread_list();
    std::set<pid_t> current_thread_set(current_threads.begin(), current_threads.end());

    // Clean up threads that no longer exist
    for (auto it = attached_threads_.begin(); it != attached_threads_.end();)
    {
        if (current_thread_set.find(*it) == current_thread_set.end())
        {
            thread_states_.erase(*it);
            it = attached_threads_.erase(it);
        }
        else
        {
            ++it;
        }
    }

    // Track which threads have actually stopped to avoid timeout removal
    std::set<pid_t> confirmed_stopped;

    // Send PTRACE_INTERRUPT to all threads except the excluded one and already stopped threads
    for (pid_t tid : attached_threads_)
    {
        // Skip the already-stopped thread (passed as parameter)
        if (tid == exclude_thread_id)
        {
            continue;
        }

        // Check if thread is already stopped (e.g., at a breakpoint)
        auto state_it = thread_states_.find(tid);
        if (state_it != thread_states_.end() && state_it->second.is_stopped)
        {
            stopped_threads.push_back(tid);
            confirmed_stopped.insert(tid);
            // Record this thread as "already stopped" so caller knows not to resume it
            if (already_stopped_out)
            {
                already_stopped_out->push_back(tid);
            }
            continue;
        }

        if (PTRACE_CALL(DYNA_PTRACE_INTERRUPT, tid, nullptr, nullptr) == 0)
        {
            stopped_threads.push_back(tid);
        }
        else
        {
            int err = errno;
            if (err == ESRCH)
            {
                // Thread no longer exists - clean up
                attached_threads_.erase(tid);
                thread_states_.erase(tid);
            }
            else
            {
                debug_log(LOG_ERROR, "Failed to send PTRACE_INTERRUPT to thread %d: %s", tid,
                          strerror(err));
            }
        }
    }

    // Wait for each thread to actually stop using waitpid
    auto start_time = std::chrono::steady_clock::now();
    const auto timeout = std::chrono::milliseconds(5000);  // 5 second timeout

    for (auto it = stopped_threads.begin(); it != stopped_threads.end();)
    {
        pid_t tid = *it;

        // Skip threads that are already confirmed as stopped
        if (confirmed_stopped.find(tid) != confirmed_stopped.end())
        {
            ++it;
            continue;
        }

        int status;

        // Use WNOHANG to avoid blocking indefinitely
        pid_t result = waitpid(tid, &status, WNOHANG);

        if (result == tid)
        {
            // Thread has stopped
            if (WIFSTOPPED(status))
            {
                confirmed_stopped.insert(tid);  // Mark as confirmed stopped
                // Update is_stopped state
                thread_states_[tid].is_stopped = true;
                ++it;
            }
            else
            {
                it = stopped_threads.erase(it);
            }
        }
        else if (result == 0)
        {
            // Thread not ready yet, check timeout
            auto current_time = std::chrono::steady_clock::now();
            if (current_time - start_time > timeout)
            {
                // Only remove threads that haven't been confirmed as stopped
                if (confirmed_stopped.find(tid) == confirmed_stopped.end())
                {
                    it = stopped_threads.erase(it);
                }
                else
                {
                    // Thread is confirmed stopped, keep it
                    ++it;
                }
            }
            else
            {
                // Small delay before checking again
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
                ++it;
            }
        }
        else
        {
            // Error occurred
            debug_log(LOG_ERROR, "Error waiting for thread %d: %s", tid, strerror(errno));
            it = stopped_threads.erase(it);
        }

        // Reset iterator if we've reached the end but still have time
        if (it == stopped_threads.end() && !stopped_threads.empty())
        {
            auto current_time = std::chrono::steady_clock::now();
            if (current_time - start_time < timeout)
            {
                // Check if all remaining threads are confirmed stopped
                bool all_confirmed = true;
                for (pid_t remaining_tid : stopped_threads)
                {
                    if (confirmed_stopped.find(remaining_tid) == confirmed_stopped.end())
                    {
                        all_confirmed = false;
                        break;
                    }
                }

                if (all_confirmed)
                {
                    // All threads are confirmed stopped, no need to continue waiting
                    break;
                }

                it = stopped_threads.begin();
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        }
    }

    // Cancel PTRACE_INTERRUPT for threads that didn't stop
    cancel_interrupt_for_non_stopped_threads(stopped_threads);

    // Final verification using hardware register access
    // verify_threads_stopped(stopped_threads);

    return stopped_threads;
}

void Debugger::resume_threads(const std::vector<pid_t>& stopped_threads)
{
    for (pid_t tid : stopped_threads)
    {
        // Check if there's a pending signal to deliver
        int signal_to_pass = 0;
        auto state_it = thread_states_.find(tid);
        if (state_it != thread_states_.end())
        {
            signal_to_pass = state_it->second.pending_signal;
            state_it->second.pending_signal = 0;  // Clear after use
        }

        if (PTRACE_CALL(PTRACE_CONT, tid, nullptr, (void*)(long)signal_to_pass) == -1)
        {
            int err = errno;
            if (err == ESRCH)
            {
                // Thread no longer exists - clean up
                attached_threads_.erase(tid);
                thread_states_.erase(tid);
            }
            else
            {
                // Failed to resume but thread still exists
                // Keep is_stopped = true since thread is still stopped
                debug_log(LOG_ERROR, "Failed to resume thread %d: %s (thread remains stopped)", tid,
                          strerror(err));
            }
        }
        else
        {
            if (signal_to_pass != 0)
            {
                debug_log(LOG_INFO, "resume_threads: thread %d resumed with signal %d (%s)", tid,
                          signal_to_pass, strsignal(signal_to_pass));
            }
            // Successfully resumed - now mark as not stopped
            if (state_it != thread_states_.end())
            {
                state_it->second.is_stopped = false;
            }
        }
    }
}

void Debugger::cancel_interrupt_for_non_stopped_threads(const std::vector<pid_t>& stopped_threads)
{
    // Find threads that received PTRACE_INTERRUPT but didn't stop
    std::set<pid_t> stopped_set(stopped_threads.begin(), stopped_threads.end());

    for (pid_t tid : attached_threads_)
    {
        if (stopped_set.find(tid) == stopped_set.end())
        {
            // Check if thread might be in a stopped state we haven't detected
            int status;
            pid_t result = waitpid(tid, &status, WNOHANG);

            if (result == tid && WIFSTOPPED(status))
            {
                // Thread is actually stopped, continue it to cancel the interrupt
                if (PTRACE_CALL(PTRACE_CONT, tid, nullptr, nullptr) == 0)
                {
                    debug_log(LOG_ERROR, "Continued thread %d to cancel PTRACE_INTERRUPT", tid);
                }
                else
                {
                    debug_log(LOG_ERROR, "Failed to continue thread %d: %s", tid, strerror(errno));
                }
            }
        }
    }
}

bool Debugger::verify_threads_stopped(std::vector<pid_t>& threads_to_verify)
{
    for (auto it = threads_to_verify.begin(); it != threads_to_verify.end();)
    {
        pid_t tid = *it;

#if defined(__aarch64__)
        struct user_hwdebug_state test_state;
        memset(&test_state, 0, sizeof(test_state));

        // Try to access debug registers using ARM64 hardware breakpoint regset - this will succeed
        // if thread is stopped
        struct iovec iov;
        iov.iov_base = &test_state;
        iov.iov_len = sizeof(test_state);
        if (ptrace(PTRACE_GETREGSET, tid, NT_ARM_HW_BREAK, &iov) == -1)
        {
            it = threads_to_verify.erase(it);
        }
        else
        {
            ++it;
        }
#elif defined(__x86_64__)
        // x86_64: Try to access debug registers
        errno = 0;
        ptrace((__ptrace_request)PTRACE_PEEKUSER, tid, X86_DR7_OFFSET, nullptr);
        if (errno != 0)
        {
            it = threads_to_verify.erase(it);
        }
        else
        {
            ++it;
        }
#endif
    }

    return threads_to_verify.size() == attached_threads_.size();
}
