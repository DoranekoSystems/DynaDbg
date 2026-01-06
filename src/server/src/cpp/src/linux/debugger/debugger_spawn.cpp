/**
 * @file debugger_spawn.cpp
 * @brief Process spawning functions for the Linux debugger
 *
 * This file contains the Debugger class member functions related to process
 * spawning, including:
 * - spawn_process: Public API for spawning a new process
 * - spawn_process_with_pty: Public API for spawning with PTY support
 * - spawn_process_internal: Internal implementation for debug thread
 * - spawn_process_with_pty_internal: Internal PTY spawn implementation
 * - is_thread_stopped: Helper to check thread state via /proc
 * - find_stopped_thread: Find any stopped thread from attached threads
 *
 * @note PTY spawn is not supported on Android.
 */

#include "debugger_internal.h"

// Helper function to check if a thread is stopped via /proc
bool is_thread_stopped(pid_t pid, pid_t tid)
{
    char status_path[256];
    snprintf(status_path, sizeof(status_path), "/proc/%d/task/%d/status", pid, tid);

    FILE* fp = fopen(status_path, "r");
    if (!fp)
    {
        return false;
    }

    char line[256];
    bool is_stopped = false;
    while (fgets(line, sizeof(line), fp))
    {
        if (strncmp(line, "State:", 6) == 0)
        {
            // State: T (stopped) or t (tracing stop)
            char state = line[7];
            while (state == ' ' || state == '\t')
            {
                state = *(strchr(line, state) + 1);
            }
            // Find the actual state character after whitespace
            const char* state_ptr = line + 6;
            while (*state_ptr == ' ' || *state_ptr == '\t') state_ptr++;
            state = *state_ptr;

            is_stopped = (state == 'T' || state == 't');
            break;
        }
    }

    fclose(fp);
    return is_stopped;
}

// Find any stopped thread from attached threads
pid_t Debugger::find_stopped_thread()
{
    for (pid_t tid : attached_threads_)
    {
        if (is_thread_stopped(pid_, tid))
        {
            return tid;
        }
    }
    return 0;
}

// Spawn a new process - public API (enqueues command to debug thread)
int Debugger::spawn_process(const std::string& executable_path,
                            const std::vector<std::string>& args, pid_t* out_pid)
{
    auto request = std::make_shared<DebugRequest>(DebugCommand::SpawnProcess);
    request->executable_path = executable_path;
    request->spawn_args = args;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    if (out_pid != nullptr)
    {
        *out_pid = request->spawned_pid;
    }

    return request->result;
}

// Spawn a new process with PTY - public API (enqueues command to debug thread)
int Debugger::spawn_process_with_pty(const std::string& executable_path,
                                     const std::vector<std::string>& args, pid_t* out_pid,
                                     int* out_pty_fd)
{
    auto request = std::make_shared<DebugRequest>(DebugCommand::SpawnProcessWithPty);
    request->executable_path = executable_path;
    request->spawn_args = args;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    if (out_pid != nullptr)
    {
        *out_pid = request->spawned_pid;
    }
    if (out_pty_fd != nullptr)
    {
        *out_pty_fd = request->pty_fd;
    }

    return request->result;
}

// Internal spawn implementation - runs in debug thread
int Debugger::spawn_process_internal(std::shared_ptr<DebugRequest> request)
{
    debug_log(LOG_INFO, "Spawning process in debug thread: %s", request->executable_path.c_str());

    pid_t pid = fork();

    if (pid < 0)
    {
        debug_log(LOG_ERROR, "fork() failed: %s", strerror(errno));
        return -1;
    }

    if (pid == 0)
    {
        // Child process
        if (ptrace(PTRACE_TRACEME, 0, nullptr, nullptr) < 0)
        {
            debug_log(LOG_ERROR, "PTRACE_TRACEME failed: %s", strerror(errno));
            _exit(1);
        }

        // Prepare argv
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(request->executable_path.c_str()));
        for (const auto& arg : request->spawn_args)
        {
            argv.push_back(const_cast<char*>(arg.c_str()));
        }
        argv.push_back(nullptr);

        execvp(request->executable_path.c_str(), argv.data());

        // If execvp returns, it failed
        fprintf(stderr, "execvp failed: %s\n", strerror(errno));
        _exit(1);
    }
    else
    {
        // Parent process (debug thread)
        int status;
        pid_t result = waitpid(pid, &status, 0);

        if (result < 0)
        {
            debug_log(LOG_ERROR, "waitpid failed: %s", strerror(errno));
            return -1;
        }

        if (WIFSTOPPED(status))
        {
            int sig = WSTOPSIG(status);
            debug_log(LOG_INFO, "Child process %d stopped with signal %d (TRACEME)", pid, sig);

            // Transition from PTRACE_TRACEME to PTRACE_SEIZE for consistency
            // 1. Send SIGSTOP to ensure process stays stopped after detach
            if (kill(pid, SIGSTOP) < 0)
            {
                debug_log(LOG_ERROR, "Failed to send SIGSTOP to pid %d: %s", pid, strerror(errno));
                return -1;
            }

            // 2. Detach from PTRACE_TRACEME tracing
            if (ptrace(PTRACE_DETACH, pid, nullptr, nullptr) < 0)
            {
                debug_log(LOG_ERROR, "Failed to detach from pid %d: %s", pid, strerror(errno));
                return -1;
            }

            // 3. Wait for SIGSTOP to take effect
            int stop_status;
            pid_t wait_result = waitpid(pid, &stop_status, WUNTRACED);
            if (wait_result != pid || !WIFSTOPPED(stop_status))
            {
                debug_log(LOG_ERROR, "Failed to wait for SIGSTOP on pid %d", pid);
                return -1;
            }

            // 4. Re-attach using PTRACE_SEIZE with PTRACE_O_TRACECLONE
            if (PTRACE_CALL(DYNA_PTRACE_SEIZE, pid, nullptr, PTRACE_O_TRACECLONE) < 0)
            {
                debug_log(LOG_ERROR, "Failed to PTRACE_SEIZE pid %d: %s", pid, strerror(errno));
                return -1;
            }

            // 5. Use PTRACE_INTERRUPT to stop the process under SEIZE tracing
            if (PTRACE_CALL(DYNA_PTRACE_INTERRUPT, pid, nullptr, nullptr) < 0)
            {
                debug_log(LOG_ERROR, "Failed to PTRACE_INTERRUPT pid %d: %s", pid, strerror(errno));
                return -1;
            }

            // 6. Wait for the interrupt-induced stop
            int int_status;
            wait_result = waitpid(pid, &int_status, 0);
            if (wait_result != pid)
            {
                debug_log(LOG_ERROR, "Failed to wait for PTRACE_INTERRUPT on pid %d", pid);
                return -1;
            }

            debug_log(LOG_INFO, "Child process %d re-attached with PTRACE_SEIZE", pid);

            // Update debugger state
            pid_ = pid;
            attached_threads_.insert(pid);
            thread_states_[pid].is_attached = true;
            thread_states_[pid].is_stopped = true;
            thread_states_[pid].current_breakpoint_index = -1;
            thread_states_[pid].single_step_mode = SingleStepMode::None;
            threads_attached_ = true;
            current_thread = pid;
            debug_state_ = DebugState::Paused;

            // Send exception info
#if defined(__aarch64__)
            struct user_pt_regs regs;
            struct iovec iov = {.iov_base = &regs, .iov_len = sizeof(regs)};

            if (ptrace(PTRACE_GETREGSET, pid, NT_PRSTATUS, &iov) == 0)
            {
                NativeExceptionInfo exception_info;
                memset(&exception_info, 0, sizeof(exception_info));
                exception_info.architecture = ARCH_ARM64;
                for (int i = 0; i < 30; i++)
                {
                    exception_info.regs.arm64.x[i] = regs.regs[i];
                }
                exception_info.regs.arm64.lr = regs.regs[30];
                exception_info.regs.arm64.sp = regs.sp;
                exception_info.regs.arm64.pc = regs.pc;
                exception_info.regs.arm64.cpsr = regs.pstate;
                exception_info.regs.arm64.fp = regs.regs[29];
                exception_info.exception_type = EXCEPTION_BREAKPOINT;
                exception_info.thread_id = pid;
                SEND_EXCEPTION_INFO(&exception_info, pid);
            }
#elif defined(__x86_64__)
            struct user_regs_struct regs;
            if (ptrace(PTRACE_GETREGS, pid, nullptr, &regs) == 0)
            {
                NativeExceptionInfo exception_info;
                memset(&exception_info, 0, sizeof(exception_info));
                exception_info.architecture = ARCH_X86_64;
                exception_info.regs.x86_64.rax = regs.rax;
                exception_info.regs.x86_64.rbx = regs.rbx;
                exception_info.regs.x86_64.rcx = regs.rcx;
                exception_info.regs.x86_64.rdx = regs.rdx;
                exception_info.regs.x86_64.rsi = regs.rsi;
                exception_info.regs.x86_64.rdi = regs.rdi;
                exception_info.regs.x86_64.rbp = regs.rbp;
                exception_info.regs.x86_64.rsp = regs.rsp;
                exception_info.regs.x86_64.r8 = regs.r8;
                exception_info.regs.x86_64.r9 = regs.r9;
                exception_info.regs.x86_64.r10 = regs.r10;
                exception_info.regs.x86_64.r11 = regs.r11;
                exception_info.regs.x86_64.r12 = regs.r12;
                exception_info.regs.x86_64.r13 = regs.r13;
                exception_info.regs.x86_64.r14 = regs.r14;
                exception_info.regs.x86_64.r15 = regs.r15;
                exception_info.regs.x86_64.rip = regs.rip;
                exception_info.regs.x86_64.rflags = regs.eflags;
                exception_info.exception_type = EXCEPTION_BREAKPOINT;
                exception_info.thread_id = pid;
                SEND_EXCEPTION_INFO(&exception_info, pid);
            }
#endif

            request->spawned_pid = pid;
            debug_log(LOG_INFO, "Spawn successful in debug thread: pid=%d", pid);
            return 0;
        }
        else if (WIFEXITED(status))
        {
            debug_log(LOG_ERROR, "Child process exited with status %d", WEXITSTATUS(status));
            return -1;
        }
        else if (WIFSIGNALED(status))
        {
            debug_log(LOG_ERROR, "Child process killed by signal %d", WTERMSIG(status));
            return -1;
        }
    }

    return -1;
}

#ifdef TARGET_IS_ANDROID
// PTY spawn not supported on Android
int Debugger::spawn_process_with_pty_internal(std::shared_ptr<DebugRequest> request)
{
    debug_log(LOG_ERROR, "PTY spawn is not supported on Android");
    return -1;
}
#else
// Internal spawn with PTY implementation - runs in debug thread
int Debugger::spawn_process_with_pty_internal(std::shared_ptr<DebugRequest> request)
{
    debug_log(LOG_INFO, "Spawning process with PTY in debug thread: %s",
              request->executable_path.c_str());

    int master_fd;
    pid_t pid;

    // Set up terminal attributes
    struct termios termp;
    memset(&termp, 0, sizeof(termp));
    termp.c_iflag = ICRNL | IXON;
    termp.c_oflag = OPOST | ONLCR;
    termp.c_cflag = B38400 | CS8 | CREAD | CLOCAL;
    termp.c_lflag = ISIG | ICANON | ECHO | ECHOE | ECHOK;
    termp.c_cc[VMIN] = 1;
    termp.c_cc[VTIME] = 0;

    // Set up window size - use larger default for modern terminals
    struct winsize ws;
    ws.ws_row = 50;
    ws.ws_col = 120;
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;

    // Fork with PTY
    pid = forkpty(&master_fd, nullptr, &termp, &ws);

    if (pid < 0)
    {
        debug_log(LOG_ERROR, "forkpty() failed: %s", strerror(errno));
        return -1;
    }

    if (pid == 0)
    {
        // Child process
        if (ptrace(PTRACE_TRACEME, 0, nullptr, nullptr) < 0)
        {
            debug_log(LOG_ERROR, "PTRACE_TRACEME failed: %s", strerror(errno));
            _exit(1);
        }

        // Prepare argv
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(request->executable_path.c_str()));
        for (const auto& arg : request->spawn_args)
        {
            argv.push_back(const_cast<char*>(arg.c_str()));
        }
        argv.push_back(nullptr);

        execvp(request->executable_path.c_str(), argv.data());

        fprintf(stderr, "execvp failed: %s\n", strerror(errno));
        _exit(1);
    }
    else
    {
        // Parent process (debug thread)

        // Set master_fd to non-blocking
        int flags = fcntl(master_fd, F_GETFL, 0);
        if (flags != -1)
        {
            fcntl(master_fd, F_SETFL, flags | O_NONBLOCK);
        }

        int status;
        pid_t result = waitpid(pid, &status, 0);

        if (result < 0)
        {
            debug_log(LOG_ERROR, "waitpid failed: %s", strerror(errno));
            close(master_fd);
            return -1;
        }

        if (WIFSTOPPED(status))
        {
            int sig = WSTOPSIG(status);
            debug_log(LOG_INFO, "Child process %d stopped with signal %d (PTY TRACEME)", pid, sig);

            // Transition from PTRACE_TRACEME to PTRACE_SEIZE for consistency
            // 1. Send SIGSTOP to ensure process stays stopped after detach
            if (kill(pid, SIGSTOP) < 0)
            {
                debug_log(LOG_ERROR, "Failed to send SIGSTOP to pid %d: %s", pid, strerror(errno));
                close(master_fd);
                return -1;
            }

            // 2. Detach from PTRACE_TRACEME tracing
            if (ptrace(PTRACE_DETACH, pid, nullptr, nullptr) < 0)
            {
                debug_log(LOG_ERROR, "Failed to detach from pid %d: %s", pid, strerror(errno));
                close(master_fd);
                return -1;
            }

            // 3. Wait for SIGSTOP to take effect
            int stop_status;
            pid_t wait_result = waitpid(pid, &stop_status, WUNTRACED);
            if (wait_result != pid || !WIFSTOPPED(stop_status))
            {
                debug_log(LOG_ERROR, "Failed to wait for SIGSTOP on pid %d", pid);
                close(master_fd);
                return -1;
            }

            // 4. Re-attach using PTRACE_SEIZE with PTRACE_O_TRACECLONE
            if (PTRACE_CALL(DYNA_PTRACE_SEIZE, pid, nullptr, PTRACE_O_TRACECLONE) < 0)
            {
                debug_log(LOG_ERROR, "Failed to PTRACE_SEIZE pid %d: %s", pid, strerror(errno));
                close(master_fd);
                return -1;
            }

            // 5. Use PTRACE_INTERRUPT to stop the process under SEIZE tracing
            if (PTRACE_CALL(DYNA_PTRACE_INTERRUPT, pid, nullptr, nullptr) < 0)
            {
                debug_log(LOG_ERROR, "Failed to PTRACE_INTERRUPT pid %d: %s", pid, strerror(errno));
                close(master_fd);
                return -1;
            }

            // 6. Wait for the interrupt-induced stop
            int int_status;
            wait_result = waitpid(pid, &int_status, 0);
            if (wait_result != pid)
            {
                debug_log(LOG_ERROR, "Failed to wait for PTRACE_INTERRUPT on pid %d", pid);
                close(master_fd);
                return -1;
            }

            debug_log(LOG_INFO, "Child process %d re-attached with PTRACE_SEIZE (PTY)", pid);

            // Update debugger state
            pid_ = pid;
            attached_threads_.insert(pid);
            thread_states_[pid].is_attached = true;
            thread_states_[pid].is_stopped = true;
            thread_states_[pid].current_breakpoint_index = -1;
            thread_states_[pid].single_step_mode = SingleStepMode::None;
            threads_attached_ = true;
            current_thread = pid;
            debug_state_ = DebugState::Paused;

            // Send exception info
#if defined(__aarch64__)
            struct user_pt_regs regs;
            struct iovec iov = {.iov_base = &regs, .iov_len = sizeof(regs)};

            if (ptrace(PTRACE_GETREGSET, pid, NT_PRSTATUS, &iov) == 0)
            {
                NativeExceptionInfo exception_info;
                memset(&exception_info, 0, sizeof(exception_info));
                exception_info.architecture = ARCH_ARM64;
                for (int i = 0; i < 30; i++)
                {
                    exception_info.regs.arm64.x[i] = regs.regs[i];
                }
                exception_info.regs.arm64.lr = regs.regs[30];
                exception_info.regs.arm64.sp = regs.sp;
                exception_info.regs.arm64.pc = regs.pc;
                exception_info.regs.arm64.cpsr = regs.pstate;
                exception_info.regs.arm64.fp = regs.regs[29];
                exception_info.exception_type = EXCEPTION_BREAKPOINT;
                exception_info.thread_id = pid;
                SEND_EXCEPTION_INFO(&exception_info, pid);
            }
#elif defined(__x86_64__)
            struct user_regs_struct regs;
            if (ptrace(PTRACE_GETREGS, pid, nullptr, &regs) == 0)
            {
                NativeExceptionInfo exception_info;
                memset(&exception_info, 0, sizeof(exception_info));
                exception_info.architecture = ARCH_X86_64;
                exception_info.regs.x86_64.rax = regs.rax;
                exception_info.regs.x86_64.rbx = regs.rbx;
                exception_info.regs.x86_64.rcx = regs.rcx;
                exception_info.regs.x86_64.rdx = regs.rdx;
                exception_info.regs.x86_64.rsi = regs.rsi;
                exception_info.regs.x86_64.rdi = regs.rdi;
                exception_info.regs.x86_64.rbp = regs.rbp;
                exception_info.regs.x86_64.rsp = regs.rsp;
                exception_info.regs.x86_64.r8 = regs.r8;
                exception_info.regs.x86_64.r9 = regs.r9;
                exception_info.regs.x86_64.r10 = regs.r10;
                exception_info.regs.x86_64.r11 = regs.r11;
                exception_info.regs.x86_64.r12 = regs.r12;
                exception_info.regs.x86_64.r13 = regs.r13;
                exception_info.regs.x86_64.r14 = regs.r14;
                exception_info.regs.x86_64.r15 = regs.r15;
                exception_info.regs.x86_64.rip = regs.rip;
                exception_info.regs.x86_64.rflags = regs.eflags;
                exception_info.exception_type = EXCEPTION_BREAKPOINT;
                exception_info.thread_id = pid;
                SEND_EXCEPTION_INFO(&exception_info, pid);
            }
#endif

            request->spawned_pid = pid;
            request->pty_fd = master_fd;
            debug_log(LOG_INFO, "PTY spawn successful in debug thread: pid=%d, pty_fd=%d", pid,
                      master_fd);
            return 0;
        }
        else if (WIFEXITED(status))
        {
            debug_log(LOG_ERROR, "Child process exited with status %d", WEXITSTATUS(status));
            close(master_fd);
            return -1;
        }
        else if (WIFSIGNALED(status))
        {
            debug_log(LOG_ERROR, "Child process killed by signal %d", WTERMSIG(status));
            close(master_fd);
            return -1;
        }
    }

    return -1;
}
#endif  // !TARGET_IS_ANDROID
