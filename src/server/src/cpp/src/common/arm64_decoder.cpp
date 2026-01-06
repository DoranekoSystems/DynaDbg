#include "arm64_decoder.h"

// ARM64 instruction encoding helpers
#define EXTRACT_BITS(val, start, len) (((val) >> (start)) & ((1ULL << (len)) - 1))
#define SIGN_EXTEND(val, bits) ((int64_t)((val) << (64 - (bits))) >> (64 - (bits)))

// Get register value (handling SP specially for register 31)
static inline uint64_t get_reg_or_sp(const uint64_t* registers, uint64_t sp, uint32_t reg_num)
{
    if (reg_num == 31)
    {
        return sp;  // Register 31 is SP in addressing context
    }
    return registers[reg_num];
}

// Get register value (ZR for register 31)
static inline uint64_t get_reg_or_zr(const uint64_t* registers, uint32_t reg_num)
{
    if (reg_num == 31)
    {
        return 0;  // Register 31 is ZR in data context
    }
    return registers[reg_num];
}

Arm64MemoryAccess decode_arm64_memory_access(uint32_t instruction, const uint64_t* registers,
                                             uint64_t sp, uint64_t pc)
{
    Arm64MemoryAccess result = {0};
    result.is_valid = 0;

    // Extract top-level opcode bits
    uint32_t op0 = EXTRACT_BITS(instruction, 25, 4);  // bits [28:25]
    uint32_t op1 = EXTRACT_BITS(instruction, 23, 2);  // bits [24:23]

    // Load/Store encoding: op0 = x1x0 (bits 28:25)
    // This covers most load/store instructions
    if ((op0 & 0b0101) != 0b0100)
    {
        return result;  // Not a load/store instruction
    }

    // Extract common fields
    uint32_t size = EXTRACT_BITS(instruction, 30, 2);  // bits [31:30]
    uint32_t v = EXTRACT_BITS(instruction, 26, 1);     // bit 26 (SIMD/FP)
    uint32_t opc = EXTRACT_BITS(instruction, 22, 2);   // bits [23:22]
    uint32_t rn = EXTRACT_BITS(instruction, 5, 5);     // bits [9:5] base register
    uint32_t rt = EXTRACT_BITS(instruction, 0, 5);     // bits [4:0] target register

    uint64_t base_addr = get_reg_or_sp(registers, sp, rn);
    uint64_t effective_addr = 0;
    uint32_t access_size = 0;
    uint8_t is_write = 0;

    // Determine instruction class from bits [29:28] and [24]
    uint32_t op2 = EXTRACT_BITS(instruction, 28, 2);  // bits [29:28]
    uint32_t op3 = EXTRACT_BITS(instruction, 24, 1);  // bit 24

    // Load/Store Register (all variants) - op0 = 1x00, bit 24 determines indexing type
    if ((op0 & 0b1011) == 0b1000)
    {
        // Determine access size based on size field and V bit
        if (v == 0)
        {
            // General purpose register
            switch (size)
            {
                case 0:
                    access_size = 1;
                    break;  // B (byte)
                case 1:
                    access_size = 2;
                    break;  // H (halfword)
                case 2:
                    access_size = 4;
                    break;  // W (word)
                case 3:
                    access_size = 8;
                    break;  // X (doubleword)
            }
            // opc[0] determines load/store for most cases
            is_write = (opc & 1) == 0;
        }
        else
        {
            // SIMD/FP register
            switch (size)
            {
                case 0:
                    access_size = (opc == 0) ? 1 : ((opc == 2) ? 16 : 1);
                    break;  // B or Q
                case 1:
                    access_size = 2;
                    break;  // H
                case 2:
                    access_size = 4;
                    break;  // S
                case 3:
                    access_size = 8;
                    break;  // D
            }
            is_write = (opc & 1) == 0;
        }

        // Check specific encoding patterns
        uint32_t op4 = EXTRACT_BITS(instruction, 10, 2);  // bits [11:10]

        if (op3 == 1)
        {
            // Unsigned offset: LDR/STR (immediate, unsigned offset)
            // Format: [Xn, #imm12]
            uint32_t imm12 = EXTRACT_BITS(instruction, 10, 12);
            uint32_t scale = (v == 0) ? size : ((size == 0 && opc == 2) ? 4 : size);
            effective_addr = base_addr + (imm12 << scale);
            result.is_valid = 1;
        }
        else if (op4 == 0b01)
        {
            // Post-index: [Xn], #imm9
            int64_t imm9 = SIGN_EXTEND(EXTRACT_BITS(instruction, 12, 9), 9);
            effective_addr = base_addr;  // Post-index uses original base
            result.is_valid = 1;
        }
        else if (op4 == 0b11)
        {
            // Pre-index: [Xn, #imm9]!
            int64_t imm9 = SIGN_EXTEND(EXTRACT_BITS(instruction, 12, 9), 9);
            effective_addr = base_addr + imm9;
            result.is_valid = 1;
        }
        else if (op4 == 0b00)
        {
            // Unscaled: LDUR/STUR
            int64_t imm9 = SIGN_EXTEND(EXTRACT_BITS(instruction, 12, 9), 9);
            effective_addr = base_addr + imm9;
            result.is_valid = 1;
        }
        else if (op4 == 0b10)
        {
            // Register offset: [Xn, Rm{, extend {#amount}}]
            uint32_t rm = EXTRACT_BITS(instruction, 16, 5);
            uint32_t option = EXTRACT_BITS(instruction, 13, 3);
            uint32_t s = EXTRACT_BITS(instruction, 12, 1);

            uint64_t offset = get_reg_or_zr(registers, rm);

            // Apply extension
            switch (option)
            {
                case 0b010:  // UXTW
                    offset = (uint32_t)offset;
                    break;
                case 0b011:  // LSL (default)
                    break;
                case 0b110:  // SXTW
                    offset = (int64_t)(int32_t)offset;
                    break;
                case 0b111:  // SXTX
                    break;
            }

            // Apply shift
            if (s)
            {
                uint32_t scale = (v == 0) ? size : ((size == 0 && opc == 2) ? 4 : size);
                offset <<= scale;
            }

            effective_addr = base_addr + offset;
            result.is_valid = 1;
        }
    }

    // Load/Store Pair - op0 = 0x10
    if ((op0 & 0b1011) == 0b0010)
    {
        uint32_t rt2 = EXTRACT_BITS(instruction, 10, 5);  // Second target register
        int64_t imm7 = SIGN_EXTEND(EXTRACT_BITS(instruction, 15, 7), 7);

        // Determine size based on opc and V
        if (v == 0)
        {
            // General purpose: STP/LDP
            access_size = (opc & 2) ? 8 : 4;  // X or W
        }
        else
        {
            // SIMD/FP: STP/LDP for S/D/Q
            switch (opc)
            {
                case 0:
                    access_size = 4;
                    break;  // S
                case 1:
                    access_size = 8;
                    break;  // D
                case 2:
                    access_size = 16;
                    break;  // Q
            }
        }

        uint32_t scale = (v == 0) ? ((opc & 2) ? 3 : 2) : (2 + opc);
        int64_t offset = imm7 << scale;

        // Determine addressing mode from bits [24:23]
        uint32_t l = EXTRACT_BITS(instruction, 22, 1);  // Load/Store bit
        is_write = (l == 0);

        switch (op1)
        {
            case 0b01:  // Post-index
                effective_addr = base_addr;
                break;
            case 0b10:  // Signed offset (no writeback)
                effective_addr = base_addr + offset;
                break;
            case 0b11:  // Pre-index
                effective_addr = base_addr + offset;
                break;
            default:
                return result;  // Non-temporal pairs (0b00) not commonly used
        }

        result.is_valid = 1;
        result.is_pair = 1;
        result.address2 = effective_addr + access_size;
    }

    // Load/Store Exclusive - op0 = 0x00, bits [23:21] determine variant
    if (op0 == 0b0000 || op0 == 0b0100)
    {
        uint32_t o2 = EXTRACT_BITS(instruction, 23, 1);
        uint32_t l = EXTRACT_BITS(instruction, 22, 1);
        uint32_t o1 = EXTRACT_BITS(instruction, 21, 1);
        uint32_t o0 = EXTRACT_BITS(instruction, 15, 1);

        if (o2 == 0)
        {
            // Exclusive load/store
            access_size = 1 << size;
            is_write = (l == 0);
            effective_addr = base_addr;
            result.is_valid = 1;

            // LDXP/STXP (pair)
            if (o1 == 1)
            {
                result.is_pair = 1;
                result.address2 = effective_addr + access_size;
            }
        }
    }

    if (result.is_valid)
    {
        result.address = effective_addr;
        result.size = access_size;
        result.is_write = is_write;
    }

    return result;
}
