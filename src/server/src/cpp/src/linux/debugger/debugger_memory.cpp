/**
 * @file debugger_memory.cpp
 * @brief Memory read operations for the Linux debugger
 *
 * This file contains the memory read functionality for the Debugger class,
 * including internal ptrace-based memory reading and the public API.
 *
 * Memory reading strategy:
 * 1. If current_thread is stopped (break state), use it
 * 2. Otherwise, find any already-stopped thread via /proc
 * 3. If no stopped thread found, stop all threads temporarily
 *
 * Memory is shared across all threads, so we can read from any stopped thread.
 */

#include "debugger_internal.h"

/**
 * @brief Internal memory read implementation using ptrace PEEKDATA
 *
 * Reads memory from the target process using ptrace. This function handles
 * finding an appropriate stopped thread, reading memory word by word, and
 * handling various error conditions.
 *
 * @param address The starting address to read from
 * @param size The number of bytes to read
 * @param buffer The buffer to store the read data
 * @return The number of bytes read, or -1 on failure
 */
ssize_t Debugger::read_memory_internal(uint64_t address, size_t size, unsigned char* buffer)
{
    debug_log(LOG_DEBUG, "read_memory_internal: address=0x%lx, size=%zu, attached_threads=%zu",
              address, size, attached_threads_.size());

    // Memory is shared across all threads, so we can read from any stopped thread
    // Strategy:
    // 1. If current_thread is stopped (break state), use it
    // 2. Otherwise, find any already-stopped thread via /proc
    // 3. If no stopped thread found, stop all threads temporarily

    bool need_resume = false;
    std::vector<pid_t> stopped_threads;
    pid_t read_thread = 0;

    // Try to find any stopped thread via /proc
    if (read_thread == 0)
    {
        read_thread = find_stopped_thread();
        debug_log(LOG_DEBUG, "find_stopped_thread returned: %d", read_thread);
    }

    // If no stopped thread found, we need to stop threads
    if (read_thread == 0)
    {
        debug_log(LOG_DEBUG, "No stopped thread found, calling stop_all_threads");
        stopped_threads = stop_all_threads();
        if (stopped_threads.empty())
        {
            debug_log(LOG_ERROR, "Failed to stop threads for memory read");
            return -1;
        }
        read_thread = stopped_threads[0];
        need_resume = true;
    }

    if (read_thread == 0)
    {
        debug_log(LOG_ERROR, "No thread available for memory read");
        return -1;
    }

    // Read memory using ptrace PEEKDATA
    size_t bytes_read = 0;
    size_t word_size = sizeof(long);
    int consecutive_failures = 0;
    const int max_consecutive_failures = 3;

    while (bytes_read < size && consecutive_failures < max_consecutive_failures)
    {
        uintptr_t aligned_addr = (address + bytes_read) & ~(word_size - 1);
        size_t offset = (address + bytes_read) - aligned_addr;

        errno = 0;
        long word = PTRACE_CALL(PTRACE_PEEKDATA, read_thread, reinterpret_cast<void*>(aligned_addr),
                                nullptr);

        if (errno != 0)
        {
            consecutive_failures++;
            debug_log(LOG_ERROR, "PTRACE_PEEKDATA failed at 0x%lx: %d (%s)", aligned_addr, errno,
                      strerror(errno));

            if (errno == EIO || errno == EFAULT)
            {
                size_t skip_bytes = word_size - offset;
                if (bytes_read + skip_bytes >= size) break;
                bytes_read += skip_bytes;
                continue;
            }
            else if (errno == ESRCH)
            {
                break;
            }
            else
            {
                bytes_read += 1;
                continue;
            }
        }

        consecutive_failures = 0;

        size_t bytes_to_copy = std::min(size - bytes_read, word_size - offset);
        unsigned char* word_bytes = reinterpret_cast<unsigned char*>(&word);
        memcpy(buffer + bytes_read, word_bytes + offset, bytes_to_copy);
        bytes_read += bytes_to_copy;
    }

    // Resume threads if we stopped them
    if (need_resume)
    {
        resume_threads(stopped_threads);
    }

    return bytes_read > 0 ? static_cast<ssize_t>(bytes_read) : -1;
}

/**
 * @brief Public API for reading memory from the target process
 *
 * This function enqueues a memory read command to be executed by the
 * debugger's command processing thread. It blocks until the read is complete.
 *
 * @param address The starting address to read from
 * @param size The number of bytes to read
 * @param buffer The buffer to store the read data (must be pre-allocated)
 * @return The number of bytes read, or -1 on failure
 */
ssize_t Debugger::read_memory(uint64_t address, size_t size, unsigned char* buffer)
{
    if (!buffer || size == 0)
    {
        return -1;
    }

    auto request = std::make_shared<DebugRequest>(DebugCommand::ReadMemory);
    request->address = address;
    request->memory_size = size;
    request->memory_buffer = buffer;

    enqueue_command(request);

    // Wait for completion
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [&request] { return request->completed; });

    return request->memory_bytes_read;
}
