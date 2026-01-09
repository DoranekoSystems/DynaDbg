/**
 * @file process_api.cpp
 * @brief Process spawning and management API for Linux/Android
 *
 * This file provides basic process lifecycle management functions.
 * For debugger-integrated spawning with ptrace support, see debugger_spawn.cpp.
 */

#include "process_api.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef TARGET_IS_ANDROID
#include <pty.h>
#endif

#include "native_api.h"

// =============================================================================
// Process Spawning
// =============================================================================

// Internal helper for spawning with argv/envp arrays (not used by Rust FFI)
static pid_t spawn_process_internal(const char* executable_path, char* const argv[],
                                    char* const envp[], int suspended)
{
    pid_t pid = fork();

    if (pid < 0)
    {
        debug_log(LOG_ERROR, "fork() failed: %s", strerror(errno));
        return -1;
    }

    if (pid == 0)
    {
        // Child process

        // If suspended, stop self immediately
        if (suspended)
        {
            raise(SIGSTOP);
        }

        // Execute the target
        if (envp != NULL)
        {
            execve(executable_path, argv, envp);
        }
        else
        {
            execv(executable_path, argv);
        }

        // If exec returns, it failed
        fprintf(stderr, "exec failed for %s: %s\n", executable_path, strerror(errno));
        _exit(127);
    }

    // Parent process

    if (suspended)
    {
        // Wait for child to stop from SIGSTOP
        int status;
        pid_t result = waitpid(pid, &status, WUNTRACED);
        if (result != pid)
        {
            debug_log(LOG_ERROR, "waitpid failed for suspended child: %s", strerror(errno));
            kill(pid, SIGKILL);
            return -1;
        }

        if (!WIFSTOPPED(status))
        {
            debug_log(LOG_ERROR, "Child did not stop as expected");
            kill(pid, SIGKILL);
            return -1;
        }

        debug_log(LOG_INFO, "Spawned suspended process: %d", pid);
    }
    else
    {
        debug_log(LOG_INFO, "Spawned process: %d", pid);
    }

    return pid;
}

#ifndef TARGET_IS_ANDROID
pid_t spawn_process_with_pty_native(const char* executable_path, char* const argv[],
                                    char* const envp[], int* pty_fd_out)
{
    int master_fd;
    pid_t pid = forkpty(&master_fd, NULL, NULL, NULL);

    if (pid < 0)
    {
        debug_log(LOG_ERROR, "forkpty() failed: %s", strerror(errno));
        return -1;
    }

    if (pid == 0)
    {
        // Child process (in new PTY)

        // Execute the target
        if (envp != NULL)
        {
            execve(executable_path, argv, envp);
        }
        else
        {
            execv(executable_path, argv);
        }

        // If exec returns, it failed
        fprintf(stderr, "exec failed for %s: %s\n", executable_path, strerror(errno));
        _exit(127);
    }

    // Parent process
    if (pty_fd_out != NULL)
    {
        *pty_fd_out = master_fd;
    }

    debug_log(LOG_INFO, "Spawned process with PTY: pid=%d, pty_fd=%d", pid, master_fd);
    return pid;
}
#else
// Android stub
pid_t spawn_process_with_pty_native(const char* executable_path, char* const argv[],
                                    char* const envp[], int* pty_fd_out)
{
    (void)executable_path;
    (void)argv;
    (void)envp;
    if (pty_fd_out) *pty_fd_out = -1;
    debug_log(LOG_ERROR, "PTY spawn not supported on Android");
    return -1;
}
#endif

// =============================================================================
// Process Termination
// =============================================================================

int terminate_process_native(pid_t pid, int force)
{
    if (pid <= 0)
    {
        return -1;
    }

    int sig = force ? SIGKILL : SIGTERM;
    int result = kill(pid, sig);

    if (result < 0)
    {
        debug_log(LOG_ERROR, "kill(%d, %d) failed: %s", pid, sig, strerror(errno));
        return -1;
    }

    debug_log(LOG_INFO, "Sent signal %d to process %d", sig, pid);
    return 0;
}

// =============================================================================
// Process Suspend/Resume
// =============================================================================

int suspend_process_native(pid_t pid)
{
    if (pid <= 0)
    {
        return -1;
    }

    int result = kill(pid, SIGSTOP);
    if (result < 0)
    {
        debug_log(LOG_ERROR, "kill(%d, SIGSTOP) failed: %s", pid, strerror(errno));
        return -1;
    }

    debug_log(LOG_DEBUG, "Sent SIGSTOP to process %d", pid);
    return 0;
}

int resume_process_native(pid_t pid)
{
    if (pid <= 0)
    {
        return -1;
    }

    int result = kill(pid, SIGCONT);
    if (result < 0)
    {
        debug_log(LOG_ERROR, "kill(%d, SIGCONT) failed: %s", pid, strerror(errno));
        return -1;
    }

    debug_log(LOG_DEBUG, "Sent SIGCONT to process %d", pid);
    return 0;
}

// =============================================================================
// Process Status
// =============================================================================

int is_process_running_native(pid_t pid)
{
    if (pid <= 0)
    {
        return -1;
    }

    // Check if process exists by sending signal 0
    int result = kill(pid, 0);
    if (result < 0)
    {
        if (errno == ESRCH)
        {
            return 0;  // Process not found
        }
        else if (errno == EPERM)
        {
            return 1;  // Process exists but no permission
        }
        return -1;  // Error
    }

    return 1;  // Process exists
}

int get_process_exit_status_native(pid_t pid, int* status_out)
{
    if (pid <= 0)
    {
        return -1;
    }

    int status;
    pid_t result = waitpid(pid, &status, WNOHANG);

    if (result < 0)
    {
        debug_log(LOG_ERROR, "waitpid(%d) failed: %s", pid, strerror(errno));
        return -1;
    }

    if (result == 0)
    {
        // Process still running
        return 1;
    }

    // Process exited
    if (status_out != NULL)
    {
        if (WIFEXITED(status))
        {
            *status_out = WEXITSTATUS(status);
        }
        else if (WIFSIGNALED(status))
        {
            *status_out = -WTERMSIG(status);  // Negative to indicate signal
        }
        else
        {
            *status_out = -1;
        }
    }

    return 0;
}
