/**
 * @file arch_defs.h
 * @brief Architecture-specific definitions for Darwin/macOS debugger
 *
 * Provides ARM64-specific definitions for the Mach-based debugger.
 * Supports hardware breakpoints and watchpoints on ARM64.
 */

#ifndef DARWIN_ARCH_DEFS_H
#define DARWIN_ARCH_DEFS_H

#include <mach/mach.h>
#include <mach/arm/thread_status.h>

#include <cstddef>
#include <cstdint>

// =============================================================================
// ARM64 Debug Register Constants
// =============================================================================

// Maximum hardware breakpoints on ARM64
#define MAX_HW_BREAKPOINTS 16

// Maximum hardware watchpoints on ARM64
#define MAX_HW_WATCHPOINTS 4

// =============================================================================
// ARM64 Breakpoint Control Register (BCR) Bit Definitions
// =============================================================================

// BCR Enable bit (bit 0)
#define ARM64_BCR_ENABLE           (1ULL << 0)

// BCR Privilege Mode Control (bits 1-2)
// PMC = 2: EL0 only (user mode)
#define ARM64_BCR_PMC_EL0          (2ULL << 1)
// PMC = 1: EL1 only (kernel mode)
#define ARM64_BCR_PMC_EL1          (1ULL << 1)
// PMC = 3: EL0 and EL1
#define ARM64_BCR_PMC_EL0_EL1      (3ULL << 1)

// BCR Byte Address Select (bits 5-8)
// BAS = 0xF: Match all 4 bytes (for 4-byte aligned address)
#define ARM64_BCR_BAS_ALL          (0xFULL << 5)

// Standard hardware breakpoint control value
// Enable + EL0 mode + Match 4 bytes
#define ARM64_BCR_EXECUTE_BP       (ARM64_BCR_ENABLE | ARM64_BCR_PMC_EL0 | ARM64_BCR_BAS_ALL)

// =============================================================================
// ARM64 Watchpoint Control Register (WCR) Bit Definitions
// =============================================================================

// WCR Enable bit (bit 0)
#define ARM64_WCR_ENABLE           (1ULL << 0)

// WCR Privilege Mode Control (bits 1-2)
#define ARM64_WCR_PMC_EL0          (2ULL << 1)

// WCR Load/Store Control (bits 3-4)
// LSC = 1: Load (read)
#define ARM64_WCR_LSC_LOAD         (1ULL << 3)
// LSC = 2: Store (write)
#define ARM64_WCR_LSC_STORE        (2ULL << 3)
// LSC = 3: Load or Store (read/write)
#define ARM64_WCR_LSC_LOADSTORE    (3ULL << 3)

// WCR Byte Address Select (bits 5-12)
// Length encoding for watchpoints
#define ARM64_WCR_LEN_1            (0ULL << 5)   // 1 byte
#define ARM64_WCR_LEN_2            (1ULL << 5)   // 2 bytes
#define ARM64_WCR_LEN_4            (2ULL << 5)   // 4 bytes
#define ARM64_WCR_LEN_8            (3ULL << 5)   // 8 bytes

// =============================================================================
// ARM64 MDSCR_EL1 (Monitor Debug System Control Register) Bits
// =============================================================================

// Single-step enable bit
#define ARM64_MDSCR_SS             (1ULL << 0)

// Software step enable (bit 15)
#define ARM64_MDSCR_MDE            (1ULL << 15)

// =============================================================================
// Exception Class (EC) values from ESR_EL1
// =============================================================================

// EC for Software breakpoint (BRK instruction)
#define ARM64_EC_SOFTWARE_BP       0x3C

// EC for Hardware breakpoint
#define ARM64_EC_HW_BREAKPOINT_LO  0x30
#define ARM64_EC_HW_BREAKPOINT_HI  0x31

// EC for Watchpoint (read)
#define ARM64_EC_WATCHPOINT_LO     0x34
// EC for Watchpoint (write)
#define ARM64_EC_WATCHPOINT_HI     0x35

// EC for Software step
#define ARM64_EC_SOFTWARE_STEP_LO  0x32
#define ARM64_EC_SOFTWARE_STEP_HI  0x33

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract Exception Class from ESR value
 * @param esr Exception Syndrome Register value
 * @return Exception Class (bits 31:26)
 */
static inline uint32_t arm64_get_exception_class(uint32_t esr)
{
    return (esr >> 26) & 0x3F;
}

/**
 * Encode watchpoint control register value
 * @param size Watchpoint size (1, 2, 4, or 8 bytes)
 * @param type Load/Store control (1=load, 2=store, 3=both)
 * @return WCR value
 */
static inline uint64_t arm64_encode_wcr(int size, int type)
{
    uint64_t control = ARM64_WCR_ENABLE | ARM64_WCR_PMC_EL0;
    
    // Set LSC (Load/Store Control)
    control |= ((uint64_t)type << 3);
    
    // Set length field
    uint64_t len_field = 0;
    switch (size)
    {
        case 1: len_field = 0; break;
        case 2: len_field = 1; break;
        case 4: len_field = 2; break;
        case 8: len_field = 3; break;
        default: len_field = 2; break;  // Default to 4 bytes
    }
    control |= (len_field << 5);
    
    return control;
}

/**
 * Encode breakpoint control register value for execution breakpoint
 * @return BCR value for execution breakpoint
 */
static inline uint64_t arm64_encode_bcr_execute(void)
{
    return ARM64_BCR_EXECUTE_BP;
}

#endif  // DARWIN_ARCH_DEFS_H
