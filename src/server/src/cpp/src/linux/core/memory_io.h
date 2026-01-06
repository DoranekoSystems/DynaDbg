/**
 * @file memory_io.h
 * @brief Memory read/write operations for process memory access
 *
 * Provides multiple methods for reading/writing process memory:
 * - process_vm_readv/writev (fastest, requires same UID or CAP_SYS_PTRACE)
 * - /proc/pid/mem (no thread stop needed with proper permissions)
 * - ptrace PEEKDATA/POKEDATA (requires attach, most compatible)
 */

#ifndef MEMORY_IO_H
#define MEMORY_IO_H

#include <sys/types.h>

#include <cstddef>
#include <cstdint>

// External C API functions (called from Rust)
#ifdef __cplusplus
extern "C"
{
#endif

    /**
     * Read memory from target process using default method (process_vm_readv)
     * @param pid Target process ID
     * @param address Memory address to read from
     * @param size Number of bytes to read
     * @param buffer Output buffer to store read data
     * @return Number of bytes read, or negative errno on error
     */
    ssize_t read_memory_native(int pid, uintptr_t address, size_t size, unsigned char* buffer);

    /**
     * Read memory with specific method selection
     * @param pid Target process ID
     * @param address Memory address to read from
     * @param size Number of bytes to read
     * @param buffer Output buffer to store read data
     * @param mode Read method: 0=process_vm_readv, 1=/proc/pid/mem, 2=ptrace
     * @return Number of bytes read, or negative errno on error
     */
    ssize_t read_memory_native_with_method(int pid, uintptr_t address, size_t size,
                                           unsigned char* buffer, int mode);

    /**
     * Write memory to target process
     * Uses process_vm_writev for own process, ptrace for others
     * @param pid Target process ID
     * @param address Memory address to write to
     * @param size Number of bytes to write
     * @param buffer Data to write
     * @return Number of bytes written, or -1 on error
     */
    ssize_t write_memory_native(int pid, void* address, size_t size, unsigned char* buffer);

#ifdef __cplusplus
}
#endif

// Internal C++ helper functions (not exposed to Rust)
#ifdef __cplusplus

/**
 * Read memory using process_vm_readv (fastest method)
 */
ssize_t read_memory_vm_readv(int pid, uintptr_t address, size_t size, unsigned char* buffer);

/**
 * Read memory using /proc/pid/mem (no thread stop required)
 */
ssize_t read_memory_proc_mem(int pid, uintptr_t address, size_t size, unsigned char* buffer);

/**
 * Read memory using ptrace PEEKDATA (requires attach or debugger)
 */
ssize_t read_memory_ptrace(int pid, uintptr_t address, size_t size, unsigned char* buffer);

#endif  // __cplusplus

#endif  // MEMORY_IO_H
