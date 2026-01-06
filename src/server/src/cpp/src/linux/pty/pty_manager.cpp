/**
 * @file pty_manager.cpp
 * @brief Pseudo-terminal (PTY) management for process I/O
 */

#include "pty_manager.h"

#include <errno.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "../core/native_api.h"  // For debug_log
#include "../debugger/debugger.h"

// Global storage for PTY file descriptors (indexed by PID)
static std::map<pid_t, int> g_pty_fds;
static std::mutex g_pty_mutex;

int spawn_process_with_pty(const char* executable_path, const char** args, int argc, pid_t* out_pid,
                           int* out_pty_fd)
{
    debug_log(LOG_INFO, "Spawning process with PTY: %s with %d args", executable_path, argc);

    // Destroy existing debugger if any
    if (g_debugger != nullptr)
    {
        debug_log(LOG_INFO, "Destroying existing debugger before PTY spawn");
        delete g_debugger;
        g_debugger = nullptr;
    }

    // Create debugger with pid=0 (will be set during spawn)
    g_debugger = new Debugger();
    if (!g_debugger->initialize())
    {
        debug_log(LOG_ERROR, "Failed to initialize debugger");
        delete g_debugger;
        g_debugger = nullptr;
        return -1;
    }

    // Start the debug thread
    g_debugger->run();

    // Prepare arguments
    std::vector<std::string> spawn_args;
    for (int i = 0; i < argc; i++)
    {
        spawn_args.push_back(args[i]);
    }

    // Spawn process with PTY in debug thread
    pid_t pid = 0;
    int pty_fd = -1;
    int result = g_debugger->spawn_process_with_pty(executable_path, spawn_args, &pid, &pty_fd);

    if (result == 0)
    {
        if (out_pid != nullptr)
        {
            *out_pid = pid;
        }
        if (out_pty_fd != nullptr)
        {
            *out_pty_fd = pty_fd;
        }

        // Store PTY fd
        {
            std::lock_guard<std::mutex> lock(g_pty_mutex);
            g_pty_fds[pid] = pty_fd;
        }

        debug_log(LOG_INFO, "PTY spawn successful: pid=%d, pty_fd=%d", pid, pty_fd);
    }
    else
    {
        debug_log(LOG_ERROR, "PTY spawn failed");
        delete g_debugger;
        g_debugger = nullptr;
    }

    return result;
}

ssize_t read_pty(int pty_fd, char* buffer, size_t buffer_size)
{
    if (pty_fd < 0 || buffer == nullptr || buffer_size == 0)
    {
        return -1;
    }

    ssize_t bytes_read = read(pty_fd, buffer, buffer_size);

    if (bytes_read < 0)
    {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
        {
            // No data available (non-blocking)
            return 0;
        }
        debug_log(LOG_ERROR, "read_pty failed: %s", strerror(errno));
        return -1;
    }

    return bytes_read;
}

ssize_t write_pty(int pty_fd, const char* data, size_t data_len)
{
    if (pty_fd < 0 || data == nullptr || data_len == 0)
    {
        return -1;
    }

    ssize_t bytes_written = write(pty_fd, data, data_len);

    if (bytes_written < 0)
    {
        debug_log(LOG_ERROR, "write_pty failed: %s", strerror(errno));
        return -1;
    }

    return bytes_written;
}

void close_pty(int pty_fd)
{
    if (pty_fd >= 0)
    {
        close(pty_fd);

        // Remove from global map
        std::lock_guard<std::mutex> lock(g_pty_mutex);
        for (auto it = g_pty_fds.begin(); it != g_pty_fds.end(); ++it)
        {
            if (it->second == pty_fd)
            {
                g_pty_fds.erase(it);
                break;
            }
        }
    }
}

int get_pty_size(int pty_fd, int* rows, int* cols)
{
    struct winsize ws;
    if (ioctl(pty_fd, TIOCGWINSZ, &ws) < 0)
    {
        debug_log(LOG_ERROR, "TIOCGWINSZ failed: %s", strerror(errno));
        return -1;
    }

    if (rows != nullptr) *rows = ws.ws_row;
    if (cols != nullptr) *cols = ws.ws_col;

    return 0;
}

int set_pty_size(int pty_fd, int rows, int cols)
{
    struct winsize ws;
    ws.ws_row = rows;
    ws.ws_col = cols;
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;

    if (ioctl(pty_fd, TIOCSWINSZ, &ws) < 0)
    {
        debug_log(LOG_ERROR, "TIOCSWINSZ failed: %s", strerror(errno));
        return -1;
    }

    return 0;
}
