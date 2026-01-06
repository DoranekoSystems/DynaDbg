/**
 * @file pty_manager.h
 * @brief Pseudo-terminal (PTY) management for process I/O
 *
 * Provides PTY-based process spawning and I/O operations.
 * PTY allows capturing stdout/stderr and sending stdin to spawned processes.
 */

#ifndef PTY_MANAGER_H
#define PTY_MANAGER_H

#include <sys/types.h>

#include <cstddef>

#ifdef __cplusplus
extern "C"
{
#endif

    /**
     * Spawn a new process with PTY (pseudo terminal) for I/O
     * @param executable_path Path to executable
     * @param args Array of argument strings
     * @param argc Number of arguments
     * @param out_pid Output: spawned process ID
     * @param out_pty_fd Output: PTY file descriptor for I/O
     * @return 0 on success, -1 on failure
     */
    int spawn_process_with_pty(const char* executable_path, const char** args, int argc,
                               pid_t* out_pid, int* out_pty_fd);

    /**
     * Read from PTY (non-blocking)
     * @param pty_fd PTY file descriptor
     * @param buffer Output buffer
     * @param buffer_size Buffer size
     * @return Number of bytes read, 0 if no data available, -1 on error
     */
    ssize_t read_pty(int pty_fd, char* buffer, size_t buffer_size);

    /**
     * Write to PTY
     * @param pty_fd PTY file descriptor
     * @param data Data to write
     * @param data_len Data length
     * @return Number of bytes written, -1 on error
     */
    ssize_t write_pty(int pty_fd, const char* data, size_t data_len);

    /**
     * Close PTY and cleanup resources
     * @param pty_fd PTY file descriptor
     */
    void close_pty(int pty_fd);

    /**
     * Get PTY window size
     * @param pty_fd PTY file descriptor
     * @param rows Output: number of rows
     * @param cols Output: number of columns
     * @return 0 on success, -1 on error
     */
    int get_pty_size(int pty_fd, int* rows, int* cols);

    /**
     * Set PTY window size
     * @param pty_fd PTY file descriptor
     * @param rows Number of rows
     * @param cols Number of columns
     * @return 0 on success, -1 on error
     */
    int set_pty_size(int pty_fd, int rows, int cols);

#ifdef __cplusplus
}
#endif

#endif  // PTY_MANAGER_H
