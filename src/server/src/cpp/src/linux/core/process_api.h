/**
 * @file process_api.h
 * @brief Process spawning and management API for Linux/Android
 *
 * This header provides process lifecycle management:
 * - Process spawning with PTY support
 * - Process termination
 * - Process suspend/resume
 *
 * Note: On Linux, process spawning is typically done via fork/exec
 * or through the debugger's spawn functionality.
 */

#ifndef LINUX_PROCESS_API_H
#define LINUX_PROCESS_API_H

#include <sys/types.h>

#ifdef __cplusplus
extern "C"
{
#endif

    /**
     * Spawn a new process with PTY
     * @param executable_path Path to the executable
     * @param argv NULL-terminated argument array
     * @param envp NULL-terminated environment array (NULL to inherit)
     * @param pty_fd_out Pointer to store the PTY master file descriptor
     * @return PID of spawned process, or -1 on error
     */
    pid_t spawn_process_with_pty_native(const char* executable_path, char* const argv[],
                                        char* const envp[], int* pty_fd_out);

    /**
     * Terminate a process by PID
     * @param pid Process ID to terminate
     * @param force If non-zero, use SIGKILL instead of SIGTERM
     * @return 0 on success, -1 on error
     */
    int terminate_process_native(pid_t pid, int force);

    /**
     * Suspend a process (send SIGSTOP)
     * @param pid Process ID to suspend
     * @return 0 on success, -1 on error
     */
    int suspend_process_native(pid_t pid);

    /**
     * Resume a suspended process (send SIGCONT)
     * @param pid Process ID to resume
     * @return 0 on success, -1 on error
     */
    int resume_process_native(pid_t pid);

    /**
     * Check if a process is running
     * @param pid Process ID to check
     * @return 1 if running, 0 if not running, -1 on error
     */
    int is_process_running_native(pid_t pid);

    /**
     * Get process exit status (for terminated processes)
     * @param pid Process ID
     * @param status_out Pointer to store exit status
     * @return 0 if exited, 1 if still running, -1 on error
     */
    int get_process_exit_status_native(pid_t pid, int* status_out);

#ifdef __cplusplus
}
#endif

#endif  // LINUX_PROCESS_API_H
