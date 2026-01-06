// Architecture-specific definitions for Linux debugger
// Supports ARM64 and x86_64 architectures

#ifndef ARCH_DEFS_H
#define ARCH_DEFS_H

#include <sys/ptrace.h>
#include <sys/user.h>

#include <cstddef>
#include <cstdint>

// =============================================================================
// PTRACE compatibility definitions
// =============================================================================

// ptrace request values - define unconditionally since they may be enums in system headers
#ifndef DYNA_PTRACE_GETREGSET
#define DYNA_PTRACE_GETREGSET 0x4204
#endif
#ifndef DYNA_PTRACE_SETREGSET
#define DYNA_PTRACE_SETREGSET 0x4205
#endif
#ifndef DYNA_PTRACE_SEIZE
#define DYNA_PTRACE_SEIZE 0x4206
#endif
#ifndef DYNA_PTRACE_INTERRUPT
#define DYNA_PTRACE_INTERRUPT 0x4207
#endif

// NT_PRSTATUS for register access (usually defined in elf.h, but define fallback)
#ifndef NT_PRSTATUS
#define NT_PRSTATUS 1
#endif

// Helper macro for ptrace calls to handle type casting
// Android (bionic) uses int for ptrace request, while glibc uses __ptrace_request enum
#ifdef __ANDROID__
#define PTRACE_CALL(request, ...) ptrace((int)(request), ##__VA_ARGS__)
#else
#define PTRACE_CALL(request, ...) ptrace((__ptrace_request)(request), ##__VA_ARGS__)
#endif

// PTRACE constants compatibility - some systems use PTRACE_PEEKUSR/POKEUSR
#ifndef PTRACE_PEEKUSR
#define PTRACE_PEEKUSR PTRACE_PEEKUSER
#endif
#ifndef PTRACE_POKEUSR
#define PTRACE_POKEUSR PTRACE_POKEUSER
#endif
#ifndef PTRACE_PEEKUSER
#define PTRACE_PEEKUSER PTRACE_PEEKUSR
#endif
#ifndef PTRACE_POKEUSER
#define PTRACE_POKEUSER PTRACE_POKEUSR
#endif

// PTRACE_SEIZE and PTRACE_INTERRUPT for modern ptrace API
#ifndef PTRACE_SEIZE
#define PTRACE_SEIZE 0x4206
#endif
#ifndef PTRACE_INTERRUPT
#define PTRACE_INTERRUPT 0x4207
#endif

// PTRACE_EVENT_STOP for PTRACE_INTERRUPT support
#ifndef PTRACE_EVENT_STOP
#define PTRACE_EVENT_STOP 128
#endif

// =============================================================================
// ARM64-specific definitions
// =============================================================================

#if defined(__aarch64__)

#include <asm/ptrace.h>
#include <linux/hw_breakpoint.h>

// Linux ARM64 hardware debug support
#ifndef PTRACE_GETHBPREGS
#define PTRACE_GETHBPREGS 29
#endif
#ifndef PTRACE_SETHBPREGS
#define PTRACE_SETHBPREGS 30
#endif

// Hardware breakpoint control register bits for ARM64
#define ARM_BREAKPOINT_EXECUTE 0x0
#define ARM_BREAKPOINT_LOAD 0x1
#define ARM_BREAKPOINT_STORE 0x2
#define ARM_BREAKPOINT_RW (ARM_BREAKPOINT_LOAD | ARM_BREAKPOINT_STORE)

// ARM64 breakpoint length encoding
#define ARM_BREAKPOINT_LEN_1 0x1
#define ARM_BREAKPOINT_LEN_2 0x3
#define ARM_BREAKPOINT_LEN_4 0xf
#define ARM_BREAKPOINT_LEN_8 0xff

// NT constants for ARM64 hardware debug
#ifndef NT_ARM_HW_BREAK
#define NT_ARM_HW_BREAK 0x402
#endif
#ifndef NT_ARM_HW_WATCH
#define NT_ARM_HW_WATCH 0x403
#endif

// Encode ARM64 debug control register
// Bit 0: E (Enable)
// Bits 1-2: PMC (Privilege mode control) - 0=User, 1=Privileged, 2=User, 3=Any
// Bits 3-4: LSC/Type (Load/Store Control for watchpoint, Type for breakpoint)
//   - Breakpoint: 0=Execute
//   - Watchpoint: 1=Load, 2=Store, 3=Load+Store
// Bits 5-12: BAS/LEN (Byte Address Select / Length)
//   - 0x1=1byte, 0x3=2bytes, 0xf=4bytes, 0xff=8bytes
// Bit 22: Mismatch (usually 0)
inline uint32_t encode_ctrl_reg(int mismatch, int len, int type, int privilege, int enabled)
{
    return (mismatch << 22) | (len << 5) | (type << 3) | (privilege << 1) | enabled;
}

// =============================================================================
// x86_64-specific definitions
// =============================================================================

#elif defined(__x86_64__)

// x86_64 hardware debug registers
// DR0-DR3: Address registers for breakpoints
// DR6: Debug status register
// DR7: Debug control register

// DR7 bit definitions for x86_64
#define X86_DR7_L0 (1 << 0)       // Local enable for DR0
#define X86_DR7_G0 (1 << 1)       // Global enable for DR0
#define X86_DR7_L1 (1 << 2)       // Local enable for DR1
#define X86_DR7_G1 (1 << 3)       // Global enable for DR1
#define X86_DR7_L2 (1 << 4)       // Local enable for DR2
#define X86_DR7_G2 (1 << 5)       // Global enable for DR2
#define X86_DR7_L3 (1 << 6)       // Local enable for DR3
#define X86_DR7_G3 (1 << 7)       // Global enable for DR3

// DR7 condition bits (bits 16-17, 20-21, 24-25, 28-29 for DR0-DR3)
#define X86_DR7_BREAK_ON_EXEC 0   // Break on execution
#define X86_DR7_BREAK_ON_WRITE 1  // Break on write
#define X86_DR7_BREAK_ON_IO 2     // Break on I/O (not typically used)
#define X86_DR7_BREAK_ON_RW 3     // Break on read/write

// DR7 length bits (bits 18-19, 22-23, 26-27, 30-31 for DR0-DR3)
#define X86_DR7_LEN_1 0           // 1 byte
#define X86_DR7_LEN_2 1           // 2 bytes
#define X86_DR7_LEN_8 2           // 8 bytes (only on 64-bit)
#define X86_DR7_LEN_4 3           // 4 bytes

// Debug register offsets in struct user for x86_64
#define X86_DR0_OFFSET offsetof(struct user, u_debugreg[0])
#define X86_DR1_OFFSET offsetof(struct user, u_debugreg[1])
#define X86_DR2_OFFSET offsetof(struct user, u_debugreg[2])
#define X86_DR3_OFFSET offsetof(struct user, u_debugreg[3])
#define X86_DR6_OFFSET offsetof(struct user, u_debugreg[6])
#define X86_DR7_OFFSET offsetof(struct user, u_debugreg[7])

// Helper function to get debug register offset by index
inline size_t x86_dr_offset(int index)
{
    static const size_t offsets[] = {X86_DR0_OFFSET,
                                     X86_DR1_OFFSET,
                                     X86_DR2_OFFSET,
                                     X86_DR3_OFFSET,
                                     0,
                                     0,  // DR4 and DR5 are reserved
                                     X86_DR6_OFFSET,
                                     X86_DR7_OFFSET};
    return (index >= 0 && index <= 7) ? offsets[index] : 0;
}

#endif  // Architecture selection

#endif  // ARCH_DEFS_H
