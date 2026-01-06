/**
 * Trace File Parser for DynaDbg Binary Trace Format
 *
 * File Format:
 * - Header (32 bytes): Magic, Version, Entry Count, Architecture
 * - Entries (1920 bytes each): Timestamp, PC, Registers, Instruction, Memory
 */

// Magic number for validation
export const TRACE_FILE_MAGIC = "DYNATRC\0";
export const TRACE_FILE_VERSION = 1;
export const TRACE_ARCH_ARM64 = 1;
export const TRACE_ARCH_X86_64 = 2;

// Size constants
export const TRACE_HEADER_SIZE = 32;
export const TRACE_ENTRY_SIZE = 1920;
export const TRACE_INSTRUCTION_SIZE = 64;
export const TRACE_MEMORY_DUMP_SIZE = 256;
export const TRACE_MEMORY_REG_COUNT = 6;

// Header structure
export interface TraceFileHeader {
  magic: string;
  version: number;
  entryCount: number;
  architecture: number;
}

// ARM64 trace entry
export interface TraceEntryArm64 {
  timestamp: bigint;
  pc: bigint;
  x: bigint[]; // x0-x29
  lr: bigint;
  sp: bigint;
  cpsr: bigint;
  instructionLength: number;
  instruction: string;
  memory: Uint8Array[]; // Memory at x0-x5 (256 bytes each)
}

// Converted trace entry for UI
export interface ParsedTraceEntry {
  id: number;
  timestamp: number;
  address: string;
  registers: Record<string, string>;
  instruction: string;
  opcode: string;
  operands: string;
  memory: { register: string; data: Uint8Array }[];
  isCall: boolean;
  isReturn: boolean;
  depth: number;
}

/**
 * Parse trace file header
 */
export function parseTraceHeader(data: ArrayBuffer): TraceFileHeader | null {
  if (data.byteLength < TRACE_HEADER_SIZE) {
    console.error("Trace file too small for header");
    return null;
  }

  const view = new DataView(data);
  const decoder = new TextDecoder("utf-8");

  // Read magic (8 bytes)
  const magicBytes = new Uint8Array(data, 0, 8);
  const magic = decoder.decode(magicBytes);

  // Validate magic (check without null terminator)
  if (!magic.startsWith("DYNATRC")) {
    console.error("Invalid trace file magic:", magic);
    return null;
  }

  // Read version (4 bytes, little-endian)
  const version = view.getUint32(8, true);
  if (version !== TRACE_FILE_VERSION) {
    console.error("Unsupported trace file version:", version);
    return null;
  }

  // Read entry count (4 bytes, little-endian)
  const entryCount = view.getUint32(12, true);

  // Read architecture (4 bytes, little-endian)
  const architecture = view.getUint32(16, true);

  return {
    magic,
    version,
    entryCount,
    architecture,
  };
}

/**
 * Parse a single ARM64 trace entry
 */
export function parseTraceEntryArm64(
  data: ArrayBuffer,
  offset: number
): TraceEntryArm64 | null {
  if (data.byteLength < offset + TRACE_ENTRY_SIZE) {
    console.error("Insufficient data for trace entry at offset:", offset);
    return null;
  }

  const view = new DataView(data, offset, TRACE_ENTRY_SIZE);
  const decoder = new TextDecoder("utf-8");

  let pos = 0;

  // Timestamp (8 bytes)
  const timestamp = view.getBigUint64(pos, true);
  pos += 8;

  // PC (8 bytes)
  const pc = view.getBigUint64(pos, true);
  pos += 8;

  // x0-x29 (30 * 8 = 240 bytes)
  const x: bigint[] = [];
  for (let i = 0; i < 30; i++) {
    x.push(view.getBigUint64(pos, true));
    pos += 8;
  }

  // LR (8 bytes)
  const lr = view.getBigUint64(pos, true);
  pos += 8;

  // SP (8 bytes)
  const sp = view.getBigUint64(pos, true);
  pos += 8;

  // CPSR (8 bytes)
  const cpsr = view.getBigUint64(pos, true);
  pos += 8;

  // Instruction length (4 bytes)
  const instructionLength = view.getUint32(pos, true);
  pos += 4;

  // Instruction string (64 bytes)
  const instructionBytes = new Uint8Array(
    data,
    offset + pos,
    TRACE_INSTRUCTION_SIZE
  );
  // Find null terminator
  let nullPos = instructionBytes.indexOf(0);
  if (nullPos === -1) nullPos = TRACE_INSTRUCTION_SIZE;
  const instruction = decoder.decode(instructionBytes.slice(0, nullPos));
  pos += TRACE_INSTRUCTION_SIZE;

  // Memory at x0-x5 (6 * 256 = 1536 bytes)
  const memory: Uint8Array[] = [];
  for (let i = 0; i < TRACE_MEMORY_REG_COUNT; i++) {
    const memData = new Uint8Array(data, offset + pos, TRACE_MEMORY_DUMP_SIZE);
    memory.push(memData.slice()); // Copy the data
    pos += TRACE_MEMORY_DUMP_SIZE;
  }

  return {
    timestamp,
    pc,
    x,
    lr,
    sp,
    cpsr,
    instructionLength,
    instruction,
    memory,
  };
}

/**
 * Parse instruction string to extract opcode and operands
 * Format from disassembler: "0xADDRESS|BYTECODE|OPCODE OPERANDS"
 */
function parseInstruction(instruction: string): {
  opcode: string;
  operands: string;
} {
  if (!instruction) {
    return { opcode: "", operands: "" };
  }

  // Try to parse disassembler output format
  const parts = instruction.split("|");
  if (parts.length >= 3) {
    const opcodeOperands = parts[2].trim();
    const spaceIndex = opcodeOperands.indexOf(" ");
    if (spaceIndex !== -1) {
      return {
        opcode: opcodeOperands.substring(0, spaceIndex),
        operands: opcodeOperands.substring(spaceIndex + 1).trim(),
      };
    }
    return { opcode: opcodeOperands, operands: "" };
  }

  // Fallback: treat as raw instruction
  const spaceIndex = instruction.indexOf(" ");
  if (spaceIndex !== -1) {
    return {
      opcode: instruction.substring(0, spaceIndex),
      operands: instruction.substring(spaceIndex + 1).trim(),
    };
  }

  return { opcode: instruction, operands: "" };
}

/**
 * Check if instruction is a call/branch
 */
function isCallInstruction(opcode: string): boolean {
  const callOpcodes = ["bl", "blr", "blx"];
  return callOpcodes.includes(opcode.toLowerCase());
}

/**
 * Check if instruction is a return
 */
function isReturnInstruction(opcode: string): boolean {
  const retOpcodes = ["ret", "eret"];
  return retOpcodes.includes(opcode.toLowerCase());
}

/**
 * Convert raw entry to UI-friendly format
 */
export function convertToUIEntry(
  entry: TraceEntryArm64,
  id: number
): ParsedTraceEntry {
  const { opcode, operands } = parseInstruction(entry.instruction);

  // Build registers object
  const registers: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    registers[`x${i}`] = `0x${entry.x[i].toString(16)}`;
  }
  registers.lr = `0x${entry.lr.toString(16)}`;
  registers.sp = `0x${entry.sp.toString(16)}`;
  registers.pc = `0x${entry.pc.toString(16)}`;
  registers.cpsr = `0x${entry.cpsr.toString(16)}`;
  registers.fp = `0x${entry.x[29].toString(16)}`; // fp = x29

  // Build memory array for x0-x5
  const memory = entry.memory.slice(0, 6).map((data, i) => ({
    register: `x${i}`,
    data,
  }));

  return {
    id,
    timestamp: Number(entry.timestamp),
    address: `0x${entry.pc.toString(16)}`,
    registers,
    instruction: entry.instruction,
    opcode,
    operands,
    memory,
    isCall: isCallInstruction(opcode),
    isReturn: isReturnInstruction(opcode),
    depth: 0, // Can be calculated based on call/return tracking
  };
}

/**
 * Parse entire trace file and return all entries
 */
export function parseTraceFile(data: ArrayBuffer): {
  header: TraceFileHeader;
  entries: ParsedTraceEntry[];
} | null {
  const header = parseTraceHeader(data);
  if (!header) {
    return null;
  }

  const entries: ParsedTraceEntry[] = [];
  let depth = 0;

  for (let i = 0; i < header.entryCount; i++) {
    const offset = TRACE_HEADER_SIZE + i * TRACE_ENTRY_SIZE;
    const rawEntry = parseTraceEntryArm64(data, offset);

    if (!rawEntry) {
      console.warn(`Failed to parse entry ${i} at offset ${offset}`);
      continue;
    }

    const entry = convertToUIEntry(rawEntry, i + 1);

    // Track call depth
    if (entry.isReturn && depth > 0) {
      depth--;
    }
    entry.depth = depth;
    if (entry.isCall) {
      depth++;
    }

    entries.push(entry);
  }

  return { header, entries };
}

/**
 * Format memory dump as hex string with optional ASCII display
 */
export function formatMemoryDump(
  data: Uint8Array,
  bytesPerLine: number = 16
): string {
  const lines: string[] = [];

  for (let i = 0; i < data.length; i += bytesPerLine) {
    const chunk = data.slice(i, Math.min(i + bytesPerLine, data.length));

    // Hex representation
    const hex = Array.from(chunk)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");

    // ASCII representation
    const ascii = Array.from(chunk)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");

    lines.push(
      `${i.toString(16).padStart(4, "0")}  ${hex.padEnd(bytesPerLine * 3)}  ${ascii}`
    );
  }

  return lines.join("\n");
}
