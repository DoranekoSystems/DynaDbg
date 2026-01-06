#ifndef ARM64_DECODER_H
#define ARM64_DECODER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

    // Memory access information extracted from ARM64 instruction
    typedef struct
    {
        uint64_t address;   // Computed effective address
        uint32_t size;      // Size of access in bytes
        uint8_t is_write;   // 1 if store, 0 if load
        uint8_t is_pair;    // 1 if pair load/store (STP/LDP)
        uint8_t is_valid;   // 1 if this is a valid memory access instruction
        uint8_t reserved;   // Padding
        uint64_t address2;  // Second address for pair operations
    } Arm64MemoryAccess;

    /**
     * Decode ARM64 instruction and compute memory access address
     *
     * @param instruction   The 32-bit ARM64 instruction
     * @param registers     Array of 31 registers (x0-x30, where x30 is LR)
     * @param sp            Stack pointer value
     * @param pc            Program counter value
     * @return              Memory access information
     */
    Arm64MemoryAccess decode_arm64_memory_access(uint32_t instruction, const uint64_t* registers,
                                                 uint64_t sp, uint64_t pc);

#ifdef __cplusplus
}
#endif

#endif  // ARM64_DECODER_H
