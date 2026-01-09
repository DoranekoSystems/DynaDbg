/**
 * @file memory_io.h
 * @brief Memory read/write operations for process memory access (Darwin/macOS)
 *
 * Provides memory access via Mach VM APIs:
 * - mach_vm_read_overwrite (primary method)
 * - mach_vm_write (for writing)
 * - Task port caching for performance
 */

#ifndef DARWIN_MEMORY_IO_H
#define DARWIN_MEMORY_IO_H

#include <mach/mach.h>
#include <mach/vm_map.h>
#include <sys/types.h>

#include <cstddef>
#include <cstdint>

// =============================================================================
// Mach VM function declarations
// =============================================================================

extern "C" kern_return_t mach_vm_read_overwrite(vm_map_t target_task,
                                                mach_vm_address_t address,
                                                mach_vm_size_t size,
                                                mach_vm_address_t data,
                                                mach_vm_size_t* outsize);

extern "C" kern_return_t mach_vm_write(vm_map_t target_task,
                                       mach_vm_address_t address,
                                       vm_offset_t data,
                                       mach_msg_type_number_t dataCnt);

extern "C" kern_return_t mach_vm_protect(vm_map_t target_task,
                                         mach_vm_address_t address,
                                         mach_vm_size_t size,
                                         boolean_t set_maximum,
                                         vm_prot_t new_protection);

extern "C" kern_return_t mach_vm_region(vm_map_t target_task,
                                        mach_vm_address_t* address,
                                        mach_vm_size_t* size,
                                        vm_region_flavor_t flavor,
                                        vm_region_info_t info,
                                        mach_msg_type_number_t* infoCnt,
                                        mach_port_t* object_name);

// =============================================================================
// External C API functions (called from Rust)
// =============================================================================

#ifdef __cplusplus
extern "C"
{
#endif

    /**
     * Read memory from target process using Mach VM API
     * @param pid Target process ID
     * @param address Memory address to read from
     * @param size Number of bytes to read
     * @param buffer Output buffer to store read data
     * @return Number of bytes read, or negative value on error
     */
    ssize_t read_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                               unsigned char* buffer);

    /**
     * Read memory with specific method selection
     * @param pid Target process ID
     * @param address Memory address to read from
     * @param size Number of bytes to read
     * @param buffer Output buffer to store read data
     * @param mode Read method: 0=default (Mach VM), others reserved
     * @return Number of bytes read, or negative value on error
     */
    ssize_t read_memory_native_with_method(int pid, mach_vm_address_t address, mach_vm_size_t size,
                                           unsigned char* buffer, int mode);

    /**
     * Write memory to target process using Mach VM API
     * @param pid Target process ID
     * @param address Memory address to write to
     * @param size Number of bytes to write
     * @param buffer Data to write
     * @return Number of bytes written, or negative value on error
     */
    ssize_t write_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                                unsigned char* buffer);

#ifdef __cplusplus
}
#endif

// =============================================================================
// Internal C++ helper functions
// =============================================================================

#ifdef __cplusplus

/**
 * Get or create cached task port for process
 * @param pid Target process ID
 * @return Task port, or MACH_PORT_NULL on failure
 */
mach_port_t get_task_port_for_pid(pid_t pid);

/**
 * Clear cached task port for process
 * @param pid Target process ID
 */
void clear_task_port_cache(pid_t pid);

#endif  // __cplusplus

#endif  // DARWIN_MEMORY_IO_H
