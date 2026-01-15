/**
 * @file memory_io.h
 * @brief Memory read/write operations for process memory access (Windows)
 *
 * Provides memory access via Windows APIs:
 * - ReadProcessMemory (for reading)
 * - WriteProcessMemory (for writing)
 * - VirtualQueryEx (for region enumeration)
 */

#ifndef WINDOWS_MEMORY_IO_H
#define WINDOWS_MEMORY_IO_H

#include <windows.h>

#include <cstddef>
#include <cstdint>

#include "../../common/dll_export.h"

// =============================================================================
// Memory Read/Write Functions
// =============================================================================

/**
 * Read memory from a process
 * @param pid Process ID
 * @param address Address to read from
 * @param size Number of bytes to read
 * @param buffer Output buffer
 * @return Number of bytes read, or -1 on error
 */
extern "C" NATIVE_API SSIZE_T read_memory_native(int pid, uintptr_t address, size_t size,
                                                 unsigned char* buffer);

/**
 * Read memory from a process with specified method
 * @param pid Process ID
 * @param address Address to read from
 * @param size Number of bytes to read
 * @param buffer Output buffer
 * @param mode Read mode (ignored on Windows, always uses ReadProcessMemory)
 * @return Number of bytes read, or -1 on error
 */
extern "C" NATIVE_API SSIZE_T read_memory_native_with_method(int pid, uintptr_t address,
                                                             size_t size, unsigned char* buffer,
                                                             int mode);

/**
 * Write memory to a process
 * @param pid Process ID
 * @param address Address to write to
 * @param size Number of bytes to write
 * @param buffer Input buffer
 * @return Number of bytes written, or -1 on error
 */
extern "C" NATIVE_API SSIZE_T write_memory_native(int pid, void* address, size_t size,
                                                  unsigned char* buffer);

#endif  // WINDOWS_MEMORY_IO_H
