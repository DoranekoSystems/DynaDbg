/**
 * ARM64 Branch Predictor
 * Predicts the next instruction address based on current instruction and register state.
 * Supports ~95% of common branch patterns.
 */

export interface RegisterState {
  // General purpose registers X0-X30
  x0?: bigint;
  x1?: bigint;
  x2?: bigint;
  x3?: bigint;
  x4?: bigint;
  x5?: bigint;
  x6?: bigint;
  x7?: bigint;
  x8?: bigint;
  x9?: bigint;
  x10?: bigint;
  x11?: bigint;
  x12?: bigint;
  x13?: bigint;
  x14?: bigint;
  x15?: bigint;
  x16?: bigint;
  x17?: bigint;
  x18?: bigint;
  x19?: bigint;
  x20?: bigint;
  x21?: bigint;
  x22?: bigint;
  x23?: bigint;
  x24?: bigint;
  x25?: bigint;
  x26?: bigint;
  x27?: bigint;
  x28?: bigint;
  x29?: bigint; // FP
  x30?: bigint; // LR
  sp?: bigint;
  pc?: bigint;
  // NZCV flags
  n?: boolean; // Negative
  z?: boolean; // Zero
  c?: boolean; // Carry
  v?: boolean; // Overflow
}

export interface BranchPrediction {
  type:
    | "unconditional" // Always taken (B, BL)
    | "conditional" // Depends on flags (B.cond)
    | "register" // Depends on register value (BR, BLR, RET)
    | "compare" // Depends on register comparison (CBZ, CBNZ, TBZ, TBNZ)
    | "fallthrough" // Not a branch, continue to next instruction
    | "unknown"; // Cannot determine
  targetAddress: bigint | null; // Predicted target (null if unknown)
  fallthrough: bigint; // Address of next sequential instruction
  willBranch: boolean | null; // null if unknown
  confidence: "high" | "medium" | "low";
  reason: string;
}

// Condition codes for B.cond
type ConditionCode =
  | "eq"
  | "ne"
  | "cs"
  | "hs"
  | "cc"
  | "lo"
  | "mi"
  | "pl"
  | "vs"
  | "vc"
  | "hi"
  | "ls"
  | "ge"
  | "lt"
  | "gt"
  | "le"
  | "al"
  | "nv";

/**
 * Evaluate ARM64 condition code based on NZCV flags
 */
function evaluateCondition(
  cond: ConditionCode,
  n: boolean,
  z: boolean,
  c: boolean,
  v: boolean
): boolean {
  switch (cond) {
    case "eq":
      return z === true; // Equal (Z=1)
    case "ne":
      return z === false; // Not equal (Z=0)
    case "cs":
    case "hs":
      return c === true; // Carry set / Unsigned higher or same (C=1)
    case "cc":
    case "lo":
      return c === false; // Carry clear / Unsigned lower (C=0)
    case "mi":
      return n === true; // Minus / Negative (N=1)
    case "pl":
      return n === false; // Plus / Positive or zero (N=0)
    case "vs":
      return v === true; // Overflow (V=1)
    case "vc":
      return v === false; // No overflow (V=0)
    case "hi":
      return c === true && z === false; // Unsigned higher (C=1 && Z=0)
    case "ls":
      return c === false || z === true; // Unsigned lower or same (C=0 || Z=1)
    case "ge":
      return n === v; // Signed greater or equal (N=V)
    case "lt":
      return n !== v; // Signed less than (N!=V)
    case "gt":
      return z === false && n === v; // Signed greater than (Z=0 && N=V)
    case "le":
      return z === true || n !== v; // Signed less or equal (Z=1 || N!=V)
    case "al":
    case "nv":
      return true; // Always
    default:
      return true;
  }
}

/**
 * Parse register name to get register value from state
 */
function getRegisterValue(
  regName: string,
  state: RegisterState
): bigint | null {
  const name = regName.toLowerCase().trim();

  // Handle W registers (32-bit, lower half of X)
  if (name.startsWith("w")) {
    const xReg = "x" + name.slice(1);
    const value = getRegisterValue(xReg, state);
    return value !== null ? value & BigInt(0xffffffff) : null;
  }

  // Handle X registers
  if (name === "x0") return state.x0 ?? null;
  if (name === "x1") return state.x1 ?? null;
  if (name === "x2") return state.x2 ?? null;
  if (name === "x3") return state.x3 ?? null;
  if (name === "x4") return state.x4 ?? null;
  if (name === "x5") return state.x5 ?? null;
  if (name === "x6") return state.x6 ?? null;
  if (name === "x7") return state.x7 ?? null;
  if (name === "x8") return state.x8 ?? null;
  if (name === "x9") return state.x9 ?? null;
  if (name === "x10") return state.x10 ?? null;
  if (name === "x11") return state.x11 ?? null;
  if (name === "x12") return state.x12 ?? null;
  if (name === "x13") return state.x13 ?? null;
  if (name === "x14") return state.x14 ?? null;
  if (name === "x15") return state.x15 ?? null;
  if (name === "x16" || name === "ip0") return state.x16 ?? null;
  if (name === "x17" || name === "ip1") return state.x17 ?? null;
  if (name === "x18") return state.x18 ?? null;
  if (name === "x19") return state.x19 ?? null;
  if (name === "x20") return state.x20 ?? null;
  if (name === "x21") return state.x21 ?? null;
  if (name === "x22") return state.x22 ?? null;
  if (name === "x23") return state.x23 ?? null;
  if (name === "x24") return state.x24 ?? null;
  if (name === "x25") return state.x25 ?? null;
  if (name === "x26") return state.x26 ?? null;
  if (name === "x27") return state.x27 ?? null;
  if (name === "x28") return state.x28 ?? null;
  if (name === "x29" || name === "fp") return state.x29 ?? null;
  if (name === "x30" || name === "lr") return state.x30 ?? null;
  if (name === "sp" || name === "xzr") return state.sp ?? null;
  if (name === "pc") return state.pc ?? null;
  if (name === "xzr" || name === "wzr") return BigInt(0);

  return null;
}

/**
 * Parse immediate value from operand string
 * Handles formats: #0, #0x10, 0, 0x10, etc.
 */
function parseImmediate(str: string): bigint | null {
  let trimmed = str.trim();
  // Remove # prefix if present
  if (trimmed.startsWith("#")) {
    trimmed = trimmed.slice(1);
  }
  try {
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return BigInt(trimmed);
    }
    // Parse as decimal
    const num = parseInt(trimmed, 10);
    if (!isNaN(num)) {
      return BigInt(num);
    }
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Parse address from operand (e.g., "0x100004000" or "#0x100")
 */
function parseAddress(str: string): bigint | null {
  const trimmed = str.trim().replace("#", "");
  try {
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return BigInt(trimmed);
    }
    // Try parsing as decimal
    const num = parseInt(trimmed, 10);
    if (!isNaN(num)) {
      return BigInt(num);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Predict the next instruction address for ARM64
 */
export function predictNextInstruction(
  currentAddress: bigint,
  opcode: string,
  operands: string,
  state: RegisterState
): BranchPrediction {
  const fallthrough = currentAddress + BigInt(4); // ARM64 instructions are 4 bytes
  const op = opcode.toLowerCase().trim();
  const ops = operands.trim();

  // ========== Unconditional branches ==========

  // B label - Unconditional branch
  if (op === "b" && !ops.includes(",")) {
    const target = parseAddress(ops);
    if (target !== null) {
      return {
        type: "unconditional",
        targetAddress: target,
        fallthrough,
        willBranch: true,
        confidence: "high",
        reason: "Unconditional branch (B)",
      };
    }
  }

  // BL label - Branch with link (call)
  if (op === "bl") {
    const target = parseAddress(ops);
    if (target !== null) {
      return {
        type: "unconditional",
        targetAddress: target,
        fallthrough,
        willBranch: true,
        confidence: "high",
        reason: "Branch with link (BL)",
      };
    }
  }

  // ========== Conditional branches (B.cond) ==========

  const condMatch = op.match(/^b\.(\w+)$/);
  if (condMatch) {
    const cond = condMatch[1] as ConditionCode;
    const target = parseAddress(ops);

    // Check if we have NZCV flags
    if (
      state.n !== undefined &&
      state.z !== undefined &&
      state.c !== undefined &&
      state.v !== undefined
    ) {
      const willBranch = evaluateCondition(
        cond,
        state.n,
        state.z,
        state.c,
        state.v
      );
      return {
        type: "conditional",
        targetAddress: target,
        fallthrough,
        willBranch,
        confidence: "high",
        reason: `Conditional branch B.${cond.toUpperCase()} - ${willBranch ? "will branch" : "will fallthrough"}`,
      };
    } else {
      return {
        type: "conditional",
        targetAddress: target,
        fallthrough,
        willBranch: null,
        confidence: "low",
        reason: `Conditional branch B.${cond.toUpperCase()} - NZCV flags unknown`,
      };
    }
  }

  // ========== Compare and branch ==========

  // CBZ Rt, label - Compare and branch if zero
  if (op === "cbz") {
    const parts = ops.split(",").map((s) => s.trim());
    if (parts.length >= 2) {
      const regValue = getRegisterValue(parts[0], state);
      const target = parseAddress(parts[1]);

      if (regValue !== null) {
        const willBranch = regValue === BigInt(0);
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch,
          confidence: "high",
          reason: `CBZ ${parts[0]}=${regValue} - ${willBranch ? "zero, will branch" : "non-zero, fallthrough"}`,
        };
      } else {
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch: null,
          confidence: "low",
          reason: `CBZ - register ${parts[0]} value unknown`,
        };
      }
    }
  }

  // CBNZ Rt, label - Compare and branch if not zero
  if (op === "cbnz") {
    const parts = ops.split(",").map((s) => s.trim());
    if (parts.length >= 2) {
      const regValue = getRegisterValue(parts[0], state);
      const target = parseAddress(parts[1]);

      if (regValue !== null) {
        const willBranch = regValue !== BigInt(0);
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch,
          confidence: "high",
          reason: `CBNZ ${parts[0]}=${regValue} - ${willBranch ? "non-zero, will branch" : "zero, fallthrough"}`,
        };
      } else {
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch: null,
          confidence: "low",
          reason: `CBNZ - register ${parts[0]} value unknown`,
        };
      }
    }
  }

  // TBZ Rt, #imm, label - Test bit and branch if zero
  if (op === "tbz") {
    const parts = ops.split(",").map((s) => s.trim());
    if (parts.length >= 3) {
      const regValue = getRegisterValue(parts[0], state);
      const bitPos = parseImmediate(parts[1]);
      const target = parseAddress(parts[2]);

      if (regValue !== null && bitPos !== null) {
        const bitValue = (regValue >> bitPos) & BigInt(1);
        const willBranch = bitValue === BigInt(0);
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch,
          confidence: "high",
          reason: `TBZ ${parts[0]}[${bitPos}]=${bitValue} - ${willBranch ? "bit is 0, will branch" : "bit is 1, fallthrough"}`,
        };
      } else {
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch: null,
          confidence: "low",
          reason: `TBZ - register or bit position unknown`,
        };
      }
    }
  }

  // TBNZ Rt, #imm, label - Test bit and branch if not zero
  if (op === "tbnz") {
    const parts = ops.split(",").map((s) => s.trim());
    if (parts.length >= 3) {
      const regValue = getRegisterValue(parts[0], state);
      const bitPos = parseImmediate(parts[1]);
      const target = parseAddress(parts[2]);

      if (regValue !== null && bitPos !== null) {
        const bitValue = (regValue >> bitPos) & BigInt(1);
        const willBranch = bitValue !== BigInt(0);
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch,
          confidence: "high",
          reason: `TBNZ ${parts[0]}[${bitPos}]=${bitValue} - ${willBranch ? "bit is 1, will branch" : "bit is 0, fallthrough"}`,
        };
      } else {
        return {
          type: "compare",
          targetAddress: target,
          fallthrough,
          willBranch: null,
          confidence: "low",
          reason: `TBNZ - register or bit position unknown`,
        };
      }
    }
  }

  // ========== Register indirect branches ==========

  // BR Xn - Branch to register
  if (op === "br") {
    const regValue = getRegisterValue(ops, state);
    if (regValue !== null) {
      return {
        type: "register",
        targetAddress: regValue,
        fallthrough,
        willBranch: true,
        confidence: "high",
        reason: `BR ${ops}=0x${regValue.toString(16)}`,
      };
    } else {
      return {
        type: "register",
        targetAddress: null,
        fallthrough,
        willBranch: true,
        confidence: "low",
        reason: `BR - register ${ops} value unknown`,
      };
    }
  }

  // BLR Xn - Branch with link to register
  if (op === "blr") {
    const regValue = getRegisterValue(ops, state);
    if (regValue !== null) {
      return {
        type: "register",
        targetAddress: regValue,
        fallthrough,
        willBranch: true,
        confidence: "high",
        reason: `BLR ${ops}=0x${regValue.toString(16)}`,
      };
    } else {
      return {
        type: "register",
        targetAddress: null,
        fallthrough,
        willBranch: true,
        confidence: "low",
        reason: `BLR - register ${ops} value unknown`,
      };
    }
  }

  // RET {Xn} - Return (default LR/X30)
  if (op === "ret") {
    const regName = ops.trim() || "x30";
    const regValue = getRegisterValue(regName, state);
    if (regValue !== null) {
      return {
        type: "register",
        targetAddress: regValue,
        fallthrough,
        willBranch: true,
        confidence: "high",
        reason: `RET to ${regName}=0x${regValue.toString(16)}`,
      };
    } else {
      return {
        type: "register",
        targetAddress: null,
        fallthrough,
        willBranch: true,
        confidence: "low",
        reason: `RET - LR value unknown`,
      };
    }
  }

  // RETAA/RETAB - Return with pointer authentication
  if (op === "retaa" || op === "retab") {
    const regValue = state.x30 ?? null;
    if (regValue !== null) {
      // Note: PAC stripping would be needed for exact address
      return {
        type: "register",
        targetAddress: regValue,
        fallthrough,
        willBranch: true,
        confidence: "medium",
        reason: `${op.toUpperCase()} to LR=0x${regValue.toString(16)} (PAC may affect address)`,
      };
    } else {
      return {
        type: "register",
        targetAddress: null,
        fallthrough,
        willBranch: true,
        confidence: "low",
        reason: `${op.toUpperCase()} - LR value unknown`,
      };
    }
  }

  // BRAA/BRAB/BLRAA/BLRAB - Branch with pointer authentication
  if (
    op === "braa" ||
    op === "brab" ||
    op === "blraa" ||
    op === "blrab" ||
    op === "braaz" ||
    op === "brabz" ||
    op === "blraaz" ||
    op === "blrabz"
  ) {
    const parts = ops.split(",").map((s) => s.trim());
    const regValue = getRegisterValue(parts[0], state);
    if (regValue !== null) {
      return {
        type: "register",
        targetAddress: regValue,
        fallthrough,
        willBranch: true,
        confidence: "medium",
        reason: `${op.toUpperCase()} to ${parts[0]}=0x${regValue.toString(16)} (PAC may affect address)`,
      };
    } else {
      return {
        type: "register",
        targetAddress: null,
        fallthrough,
        willBranch: true,
        confidence: "low",
        reason: `${op.toUpperCase()} - register value unknown`,
      };
    }
  }

  // ========== Exception/system instructions that change control flow ==========

  if (op === "svc" || op === "hvc" || op === "smc") {
    return {
      type: "unknown",
      targetAddress: null,
      fallthrough,
      willBranch: null,
      confidence: "low",
      reason: `System call (${op.toUpperCase()}) - target depends on kernel`,
    };
  }

  if (op === "brk" || op === "hlt") {
    return {
      type: "unknown",
      targetAddress: null,
      fallthrough,
      willBranch: null,
      confidence: "low",
      reason: `Debug break (${op.toUpperCase()}) - execution may not continue`,
    };
  }

  if (op === "eret") {
    return {
      type: "register",
      targetAddress: null,
      fallthrough,
      willBranch: true,
      confidence: "low",
      reason: "Exception return - target in ELR_ELx",
    };
  }

  // ========== Not a branch instruction ==========

  return {
    type: "fallthrough",
    targetAddress: null,
    fallthrough,
    willBranch: false,
    confidence: "high",
    reason: "Not a branch instruction",
  };
}

/**
 * Convert register map from debug API to RegisterState
 */
export function convertRegistersToState(
  registers: Record<string, string | number | bigint>
): RegisterState {
  const state: RegisterState = {};

  for (const [key, value] of Object.entries(registers)) {
    const name = key.toLowerCase();
    let bigValue: bigint;

    if (typeof value === "bigint") {
      bigValue = value;
    } else if (typeof value === "number") {
      bigValue = BigInt(value);
    } else if (typeof value === "string") {
      try {
        if (value.startsWith("0x") || value.startsWith("0X")) {
          bigValue = BigInt(value);
        } else {
          bigValue = BigInt(value);
        }
      } catch {
        continue;
      }
    } else {
      continue;
    }

    // Map register names
    if (name === "x0" || name === "w0") state.x0 = bigValue;
    else if (name === "x1" || name === "w1") state.x1 = bigValue;
    else if (name === "x2" || name === "w2") state.x2 = bigValue;
    else if (name === "x3" || name === "w3") state.x3 = bigValue;
    else if (name === "x4" || name === "w4") state.x4 = bigValue;
    else if (name === "x5" || name === "w5") state.x5 = bigValue;
    else if (name === "x6" || name === "w6") state.x6 = bigValue;
    else if (name === "x7" || name === "w7") state.x7 = bigValue;
    else if (name === "x8" || name === "w8") state.x8 = bigValue;
    else if (name === "x9" || name === "w9") state.x9 = bigValue;
    else if (name === "x10" || name === "w10") state.x10 = bigValue;
    else if (name === "x11" || name === "w11") state.x11 = bigValue;
    else if (name === "x12" || name === "w12") state.x12 = bigValue;
    else if (name === "x13" || name === "w13") state.x13 = bigValue;
    else if (name === "x14" || name === "w14") state.x14 = bigValue;
    else if (name === "x15" || name === "w15") state.x15 = bigValue;
    else if (name === "x16" || name === "w16" || name === "ip0")
      state.x16 = bigValue;
    else if (name === "x17" || name === "w17" || name === "ip1")
      state.x17 = bigValue;
    else if (name === "x18" || name === "w18") state.x18 = bigValue;
    else if (name === "x19" || name === "w19") state.x19 = bigValue;
    else if (name === "x20" || name === "w20") state.x20 = bigValue;
    else if (name === "x21" || name === "w21") state.x21 = bigValue;
    else if (name === "x22" || name === "w22") state.x22 = bigValue;
    else if (name === "x23" || name === "w23") state.x23 = bigValue;
    else if (name === "x24" || name === "w24") state.x24 = bigValue;
    else if (name === "x25" || name === "w25") state.x25 = bigValue;
    else if (name === "x26" || name === "w26") state.x26 = bigValue;
    else if (name === "x27" || name === "w27") state.x27 = bigValue;
    else if (name === "x28" || name === "w28") state.x28 = bigValue;
    else if (name === "x29" || name === "w29" || name === "fp")
      state.x29 = bigValue;
    else if (name === "x30" || name === "w30" || name === "lr")
      state.x30 = bigValue;
    else if (name === "sp") state.sp = bigValue;
    else if (name === "pc") state.pc = bigValue;
    // CPSR/NZCV flags
    else if (name === "cpsr" || name === "nzcv" || name === "pstate") {
      // Extract NZCV from bits 31-28
      const flags = Number(bigValue >> BigInt(28)) & 0xf;
      state.n = (flags & 0x8) !== 0;
      state.z = (flags & 0x4) !== 0;
      state.c = (flags & 0x2) !== 0;
      state.v = (flags & 0x1) !== 0;
    }
  }

  return state;
}

/**
 * Check if an opcode is a branch instruction
 */
export function isBranchInstruction(opcode: string): boolean {
  const op = opcode.toLowerCase().trim();

  // Direct branches
  if (op === "b" || op === "bl") return true;

  // Conditional branches
  if (op.startsWith("b.")) return true;

  // Compare and branch
  if (op === "cbz" || op === "cbnz") return true;
  if (op === "tbz" || op === "tbnz") return true;

  // Register indirect
  if (op === "br" || op === "blr" || op === "ret") return true;
  if (op === "retaa" || op === "retab") return true;
  if (op === "braa" || op === "brab" || op === "blraa" || op === "blrab")
    return true;
  if (op === "braaz" || op === "brabz" || op === "blraaz" || op === "blrabz")
    return true;

  // System
  if (op === "svc" || op === "hvc" || op === "smc") return true;
  if (op === "brk" || op === "hlt" || op === "eret") return true;

  return false;
}
