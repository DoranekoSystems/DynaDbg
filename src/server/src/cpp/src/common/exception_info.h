#ifndef EXCEPTION_INFO_H
#define EXCEPTION_INFO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

    // Architecture-independent exception info structure
    // Contains a union of architecture-specific register sets
    typedef struct
    {
        // Architecture type: 0 = unknown, 1 = ARM64, 2 = x86_64
        uint64_t architecture;

        // ARM64 registers (used when architecture == 1)
        union
        {
            struct
            {
                uint64_t x[30];  // x0-x29
                uint64_t lr;     // x30
                uint64_t sp;
                uint64_t pc;
                uint64_t cpsr;
                uint64_t fp;  // x29 (duplicate but kept for clarity)
            } arm64;

            struct
            {
                uint64_t rax;
                uint64_t rbx;
                uint64_t rcx;
                uint64_t rdx;
                uint64_t rsi;
                uint64_t rdi;
                uint64_t rbp;
                uint64_t rsp;
                uint64_t r8;
                uint64_t r9;
                uint64_t r10;
                uint64_t r11;
                uint64_t r12;
                uint64_t r13;
                uint64_t r14;
                uint64_t r15;
                uint64_t rip;
                uint64_t rflags;
                uint64_t cs;
                uint64_t ss;
                uint64_t ds;
                uint64_t es;
                uint64_t fs;
                uint64_t gs;
                uint64_t fs_base;
                uint64_t gs_base;
            } x86_64;
        } regs;

        uint64_t exception_type;
        uint64_t thread_id;
        uint64_t memory_address;  // FAR for ARM64, fault address for x86_64
        uint64_t singlestep_mode;
        uint64_t is_trace;  // 1 if this is a trace exception (hit_count > 0)
    } NativeExceptionInfo;

// Architecture constants
#define ARCH_UNKNOWN 0
#define ARCH_ARM64 1
#define ARCH_X86_64 2

#ifdef __cplusplus
}
#endif

#endif  // EXCEPTION_INFO_H
