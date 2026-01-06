import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  IconButton,
  Tooltip,
  styled,
  alpha,
  CircularProgress,
} from "@mui/material";
import { useSearchParams } from "react-router-dom";
import { darkTheme } from "../utils/theme";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  Close as CloseIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  CenterFocusStrong as CenterIcon,
  AccountTree as GraphIcon,
} from "@mui/icons-material";
import {
  useGhidraAnalysis,
  GhidraCfgBlock,
  GhidraCfgEdge,
  BlockReachability,
} from "../hooks/useGhidraAnalysis";
import { useTauriSystemState } from "../hooks/useTauriSystemState";
import { useTauriExceptionStore } from "../hooks/useTauriExceptionStore";

// Basic block structure
interface BasicBlock {
  id: string;
  startAddress: string;
  endAddress: string;
  instructions: Instruction[];
  successors: string[]; // IDs of successor blocks
  predecessors: string[]; // IDs of predecessor blocks
  isEntry: boolean;
  isExit: boolean;
}

interface Instruction {
  address: string;
  bytes: string;
  opcode: string;
  operands: string;
  detail?: string; // Module detail info
}

// Layout position for blocks
interface BlockLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Edge between blocks
interface Edge {
  from: string;
  to: string;
  type: "normal" | "conditional-true" | "conditional-false" | "unconditional";
}

// Data from Tauri store
interface GraphViewStoredData {
  address: string;
  function_name: string;
  instructions: string; // JSON string
  function_start_address: string;
  function_end_address: string;
  // Ghidra CFG mode fields (optional)
  ghidra_mode?: boolean;
  library_path?: string;
  function_offset?: string;
  // dbgsrv URL for Z3 reachability analysis
  server_url?: string;
  // Breakpoint register values for reachability analysis (optional)
  breakpoint_registers?: Record<string, string>;
  // Library base address for offset calculation (optional)
  library_base_address?: string;
}

// CFG source mode
type CfgSourceMode = "dynamic" | "ghidra";

// Styled components
const WindowContainer = styled(Box)(() => ({
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  width: "100vw",
  backgroundColor: "#1e1e1e",
  overflow: "hidden",
}));

const WindowHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #3c3c3c",
  flexShrink: 0,
}));

const WindowTitle = styled(Typography)(() => ({
  fontSize: "14px",
  fontWeight: "bold",
  color: "#4fc1ff",
  display: "flex",
  alignItems: "center",
  gap: "8px",
}));

const ToolbarContainer = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "6px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #2d2d30",
  flexShrink: 0,
}));

const GraphCanvas = styled(Box)(() => ({
  flex: 1,
  overflow: "hidden",
  position: "relative",
  cursor: "grab",
  "&:active": {
    cursor: "grabbing",
  },
}));

const BlockContainer = styled(Box, {
  shouldForwardProp: (prop) =>
    prop !== "isEntry" && prop !== "isExit" && prop !== "isDragging",
})<{ isEntry?: boolean; isExit?: boolean; isDragging?: boolean }>(
  ({ isEntry, isExit, isDragging }) => ({
    position: "absolute",
    backgroundColor: "#252526",
    border: `2px solid ${isEntry ? "#4caf50" : isExit ? "#ff5722" : "#3c3c3c"}`,
    borderRadius: "4px",
    overflow: "hidden",
    minWidth: "420px",
    maxWidth: "600px",
    boxShadow: isDragging
      ? "0 8px 24px rgba(0,0,0,0.5)"
      : "0 2px 8px rgba(0,0,0,0.3)",
    cursor: isDragging ? "grabbing" : "grab",
    transition: isDragging ? "none" : "box-shadow 0.2s ease",
    zIndex: isDragging ? 1000 : 1,
    "&:hover": {
      borderColor: "#4fc1ff",
    },
  })
);

const BlockHeader = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isEntry" && prop !== "isExit",
})<{ isEntry?: boolean; isExit?: boolean }>(({ isEntry, isExit }) => ({
  padding: "4px 8px",
  backgroundColor: isEntry
    ? alpha("#4caf50", 0.2)
    : isExit
      ? alpha("#ff5722", 0.2)
      : "#1a1a1a",
  borderBottom: "1px solid #3c3c3c",
  fontSize: "12px",
  fontFamily: 'Consolas, "Courier New", monospace',
  color: isEntry ? "#4caf50" : isExit ? "#ff5722" : "#4fc1ff",
  fontWeight: "bold",
  cursor: "grab",
  userSelect: "none",
}));

const InstructionRow = styled(Box)(() => ({
  display: "flex",
  padding: "1px 8px",
  fontSize: "12px",
  fontFamily: 'Consolas, "Courier New", monospace',
  lineHeight: 1.2,
  cursor: "pointer",
  "&:hover": {
    backgroundColor: alpha("#4fc1ff", 0.1),
  },
}));

const AddressText = styled(Typography)(() => ({
  color: "#4fc1ff",
  fontSize: "12px",
  fontFamily: 'Consolas, "Courier New", monospace',
  minWidth: "90px",
  marginRight: "12px",
  flexShrink: 0,
}));

const OpcodeText = styled(Typography)(() => ({
  color: "#569cd6",
  fontSize: "12px",
  fontFamily: 'Consolas, "Courier New", monospace',
  fontWeight: "bold",
  minWidth: "60px",
  marginRight: "12px",
  flexShrink: 0,
}));

const OperandsText = styled(Typography)(() => ({
  color: "#d4d4d4",
  fontSize: "12px",
  fontFamily: 'Consolas, "Courier New", monospace',
  flexGrow: 1,
  whiteSpace: "nowrap",
}));

const LoadingOverlay = styled(Box)(() => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: alpha("#1e1e1e", 0.9),
  zIndex: 100,
}));

// Minimap container
const MinimapContainer = styled(Box)(() => ({
  position: "absolute",
  top: 10,
  left: 10,
  width: 200,
  height: 150,
  backgroundColor: alpha("#1a1a1a", 0.95),
  border: "1px solid #3c3c3c",
  borderRadius: 4,
  overflow: "hidden",
  zIndex: 50,
  cursor: "pointer",
  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
}));

// Jump instruction detection
// Note: bl, blr, call are function calls that return to the next instruction,
// so they should NOT split blocks
const JUMP_OPCODES = new Set([
  "b",
  "br",
  "ret",
  "b.eq",
  "b.ne",
  "b.cs",
  "b.cc",
  "b.mi",
  "b.pl",
  "b.vs",
  "b.vc",
  "b.hi",
  "b.ls",
  "b.ge",
  "b.lt",
  "b.gt",
  "b.le",
  "b.al",
  "cbz",
  "cbnz",
  "tbz",
  "tbnz",
  "jmp",
  "je",
  "jne",
  "jz",
  "jnz",
  "jc",
  "jnc",
  "js",
  "jns",
  "jo",
  "jno",
  "jp",
  "jnp",
  "ja",
  "jae",
  "jb",
  "jbe",
  "jg",
  "jge",
  "jl",
  "jle",
  "ret",
  "retn",
]);

const CONDITIONAL_JUMP_OPCODES = new Set([
  "b.eq",
  "b.ne",
  "b.cs",
  "b.cc",
  "b.mi",
  "b.pl",
  "b.vs",
  "b.vc",
  "b.hi",
  "b.ls",
  "b.ge",
  "b.lt",
  "b.gt",
  "b.le",
  "cbz",
  "cbnz",
  "tbz",
  "tbnz",
  "je",
  "jne",
  "jz",
  "jnz",
  "jc",
  "jnc",
  "js",
  "jns",
  "jo",
  "jno",
  "jp",
  "jnp",
  "ja",
  "jae",
  "jb",
  "jbe",
  "jg",
  "jge",
  "jl",
  "jle",
]);

const RETURN_OPCODES = new Set(["ret", "retn"]);

const isJumpInstruction = (opcode: string): boolean => {
  return JUMP_OPCODES.has(opcode.toLowerCase());
};

const isConditionalJump = (opcode: string): boolean => {
  return CONDITIONAL_JUMP_OPCODES.has(opcode.toLowerCase());
};

const isReturnInstruction = (opcode: string): boolean => {
  return RETURN_OPCODES.has(opcode.toLowerCase());
};

// Extract jump target from operands
const extractJumpTarget = (operands: string): string | null => {
  const match = operands.match(/(0x[0-9a-fA-F]+)/);
  return match ? match[1].toLowerCase() : null;
};

// Build CFG from instructions
const buildCFG = (
  instructions: Instruction[]
): { blocks: BasicBlock[]; edges: Edge[] } => {
  if (instructions.length === 0) {
    return { blocks: [], edges: [] };
  }

  // Build address to index map
  const addressToIndex = new Map<string, number>();
  instructions.forEach((instr, idx) => {
    const normalizedAddr = instr.address.toLowerCase().replace(/^0x0*/, "0x");
    addressToIndex.set(normalizedAddr, idx);
    addressToIndex.set(instr.address.toLowerCase(), idx);
  });

  // Identify block leaders (first instruction of each block)
  const leaders = new Set<number>();
  leaders.add(0); // First instruction is always a leader

  instructions.forEach((instr, idx) => {
    const opcode = instr.opcode.toLowerCase();

    if (isJumpInstruction(opcode)) {
      // Next instruction after jump is a leader
      if (idx + 1 < instructions.length) {
        leaders.add(idx + 1);
      }

      // Jump target is a leader
      const target = extractJumpTarget(instr.operands);
      if (target) {
        const normalizedTarget = target.toLowerCase().replace(/^0x0*/, "0x");
        const targetIdx = addressToIndex.get(normalizedTarget);
        if (targetIdx !== undefined) {
          leaders.add(targetIdx);
        }
      }
    }
  });

  // Sort leaders to create blocks
  const sortedLeaders = Array.from(leaders).sort((a, b) => a - b);

  // Create basic blocks
  const blocks: BasicBlock[] = [];
  const addressToBlockId = new Map<string, string>();

  sortedLeaders.forEach((leaderIdx, blockIdx) => {
    const nextLeaderIdx =
      blockIdx + 1 < sortedLeaders.length
        ? sortedLeaders[blockIdx + 1]
        : instructions.length;

    const blockInstructions = instructions.slice(leaderIdx, nextLeaderIdx);
    const blockId = `block_${blockIdx}`;

    const block: BasicBlock = {
      id: blockId,
      startAddress: blockInstructions[0].address,
      endAddress: blockInstructions[blockInstructions.length - 1].address,
      instructions: blockInstructions,
      successors: [],
      predecessors: [],
      isEntry: blockIdx === 0,
      isExit: false,
    };

    blocks.push(block);

    // Map addresses to block ID
    blockInstructions.forEach((instr) => {
      const normalizedAddr = instr.address.toLowerCase().replace(/^0x0*/, "0x");
      addressToBlockId.set(normalizedAddr, blockId);
      addressToBlockId.set(instr.address.toLowerCase(), blockId);
    });
  });

  // Build edges
  const edges: Edge[] = [];

  blocks.forEach((block) => {
    const lastInstr = block.instructions[block.instructions.length - 1];
    const opcode = lastInstr.opcode.toLowerCase();

    if (isReturnInstruction(opcode)) {
      block.isExit = true;
      return;
    }

    if (isJumpInstruction(opcode)) {
      const target = extractJumpTarget(lastInstr.operands);

      if (target) {
        const normalizedTarget = target.toLowerCase().replace(/^0x0*/, "0x");
        const targetBlockId = addressToBlockId.get(normalizedTarget);

        if (targetBlockId) {
          block.successors.push(targetBlockId);
          const targetBlock = blocks.find((b) => b.id === targetBlockId);
          if (targetBlock) {
            targetBlock.predecessors.push(block.id);
          }

          const edgeType = isConditionalJump(opcode)
            ? "conditional-true"
            : "unconditional";
          edges.push({ from: block.id, to: targetBlockId, type: edgeType });
        }
      }

      // Conditional jumps fall through to next block
      if (isConditionalJump(opcode)) {
        const blockIdx = blocks.indexOf(block);
        if (blockIdx + 1 < blocks.length) {
          const nextBlock = blocks[blockIdx + 1];
          block.successors.push(nextBlock.id);
          nextBlock.predecessors.push(block.id);
          edges.push({
            from: block.id,
            to: nextBlock.id,
            type: "conditional-false",
          });
        }
      }
    } else {
      // Non-jump instruction falls through
      const blockIdx = blocks.indexOf(block);
      if (blockIdx + 1 < blocks.length) {
        const nextBlock = blocks[blockIdx + 1];
        block.successors.push(nextBlock.id);
        nextBlock.predecessors.push(block.id);
        edges.push({ from: block.id, to: nextBlock.id, type: "normal" });
      } else {
        block.isExit = true;
      }
    }
  });

  // Mark blocks with no successors as exits
  blocks.forEach((block) => {
    if (block.successors.length === 0) {
      block.isExit = true;
    }
  });

  return { blocks, edges };
};

// Address-aware layout algorithm - respects address order for natural flow
const layoutBlocks = (blocks: BasicBlock[], edges: Edge[]): BlockLayout[] => {
  if (blocks.length === 0) return [];

  const layouts: BlockLayout[] = [];

  // Calculate block dimensions
  const getBlockDimensions = (
    block: BasicBlock
  ): { width: number; height: number } => {
    const lineHeight = 16;
    const headerHeight = 22;
    const borderHeight = 4;
    const height =
      headerHeight + block.instructions.length * lineHeight + borderHeight;
    const width = 380;
    return { width, height };
  };

  // Extract start address from block ID (format: "block_0x...")
  const getBlockAddress = (block: BasicBlock): bigint => {
    const match = block.id.match(/block_(0x[0-9a-fA-F]+)/);
    if (match) {
      return BigInt(match[1]);
    }
    // Fallback: try to get from first instruction's address
    if (block.instructions.length > 0) {
      const addr = block.instructions[0].address;
      if (addr && addr.startsWith("0x")) {
        return BigInt(addr);
      }
    }
    return BigInt(0);
  };

  // Build adjacency info
  const blockMap = new Map<string, BasicBlock>();
  blocks.forEach((b) => blockMap.set(b.id, b));

  const blockDimensions = new Map<string, { width: number; height: number }>();
  blocks.forEach((block) => {
    blockDimensions.set(block.id, getBlockDimensions(block));
  });

  // Get block addresses for sorting
  const blockAddresses = new Map<string, bigint>();
  blocks.forEach((block) => {
    blockAddresses.set(block.id, getBlockAddress(block));
  });

  // Sort blocks by address
  const sortedByAddress = [...blocks].sort((a, b) => {
    const addrA = blockAddresses.get(a.id)!;
    const addrB = blockAddresses.get(b.id)!;
    if (addrA < addrB) return -1;
    if (addrA > addrB) return 1;
    return 0;
  });

  // Create address rank (0, 1, 2, ... based on address order)
  const addressRank = new Map<string, number>();
  sortedByAddress.forEach((block, index) => {
    addressRank.set(block.id, index);
  });

  // Find entry block
  const entryBlock = blocks.find((b) => b.isEntry);
  if (!entryBlock) return [];

  // Build predecessors map
  const predecessors = new Map<string, string[]>();
  blocks.forEach((b) => predecessors.set(b.id, []));
  blocks.forEach((block) => {
    for (const succ of block.successors) {
      if (predecessors.has(succ)) {
        predecessors.get(succ)!.push(block.id);
      }
    }
  });

  // ========================================
  // Assign levels based on address order + CFG structure
  // ========================================
  // Use a hybrid approach:
  // 1. BFS from entry to determine reachability and basic structure
  // 2. Adjust levels based on address to ensure address-order consistency

  const levels = new Map<string, number>();
  const visited = new Set<string>();

  // First pass: BFS to get basic structure
  const bfsLevels = new Map<string, number>();
  const queue: { id: string; level: number }[] = [
    { id: entryBlock.id, level: 0 },
  ];
  bfsLevels.set(entryBlock.id, 0);

  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const block = blockMap.get(id);
    if (!block) continue;

    for (const successorId of block.successors) {
      if (!blockMap.has(successorId)) continue;
      if (bfsLevels.get(successorId) === undefined) {
        bfsLevels.set(successorId, level + 1);
        queue.push({ id: successorId, level: level + 1 });
      }
    }
  }

  // Second pass: Adjust levels to respect address order
  // Blocks with higher addresses should generally be at higher or equal levels
  // Entry block is always level 0
  levels.set(entryBlock.id, 0);

  // Process blocks in address order (excluding entry)
  for (const block of sortedByAddress) {
    if (block.id === entryBlock.id) continue;

    const myRank = addressRank.get(block.id)!;
    const preds = predecessors.get(block.id) || [];

    // Find the maximum level among predecessors that have lower addresses
    // (forward edges in address space)
    let maxPredLevel = -1;
    let hasForwardPred = false;

    for (const predId of preds) {
      const predRank = addressRank.get(predId)!;
      const predLevel = levels.get(predId);

      if (predLevel !== undefined) {
        if (predRank < myRank) {
          // Forward edge (predecessor has lower address)
          maxPredLevel = Math.max(maxPredLevel, predLevel);
          hasForwardPred = true;
        } else {
          // Back edge (predecessor has higher address) - this is a loop
          // Still consider it but don't require level > predLevel
          maxPredLevel = Math.max(maxPredLevel, predLevel);
        }
      }
    }

    if (maxPredLevel >= 0) {
      // Place at level after the highest predecessor
      // But for back edges (loop targets), we can be at same or lower level
      if (hasForwardPred) {
        levels.set(block.id, maxPredLevel + 1);
      } else {
        // Only back edges - use BFS level as hint
        const bfsLevel = bfsLevels.get(block.id) ?? 1;
        levels.set(block.id, bfsLevel);
      }
    } else {
      // No predecessor with assigned level yet, use address-based level
      // Estimate level based on relative position in address space
      const bfsLevel = bfsLevels.get(block.id) ?? 1;
      levels.set(block.id, bfsLevel);
    }
  }

  // Group by level
  const levelGroups = new Map<number, BasicBlock[]>();
  blocks.forEach((block) => {
    const level = levels.get(block.id) ?? 0;
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(block);
  });

  // Sort blocks within each level by address
  levelGroups.forEach((blocksAtLevel) => {
    blocksAtLevel.sort((a, b) => {
      const addrA = blockAddresses.get(a.id)!;
      const addrB = blockAddresses.get(b.id)!;
      if (addrA < addrB) return -1;
      if (addrA > addrB) return 1;
      return 0;
    });
  });

  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

  // Build tree structure for layout
  // Each block tracks its subtree width
  const subtreeWidth = new Map<string, number>();
  const horizontalGap = 60;
  const verticalGap = 100;

  // Track which blocks are "owned" by which parent for layout purposes
  // A block is owned by its first (leftmost) parent to avoid double-counting at merge points
  const layoutParent = new Map<string, string>();

  // Determine layout parent for each block (the parent that "owns" it for width calculation)
  // Use BFS order to assign ownership to the first parent encountered
  const assignLayoutParents = () => {
    const visited = new Set<string>();
    const queue = [entryBlock.id];
    visited.add(entryBlock.id);

    while (queue.length > 0) {
      const blockId = queue.shift()!;
      const block = blockMap.get(blockId);
      if (!block) continue;

      const myLevel = levels.get(blockId) ?? 0;
      const children = block.successors.filter((sid) => {
        const childLevel = levels.get(sid);
        return (
          childLevel !== undefined && childLevel > myLevel && blockMap.has(sid)
        );
      });

      for (const childId of children) {
        if (!layoutParent.has(childId)) {
          layoutParent.set(childId, blockId);
        }
        if (!visited.has(childId)) {
          visited.add(childId);
          queue.push(childId);
        }
      }
    }
  };

  assignLayoutParents();

  // Calculate subtree widths bottom-up, only counting children owned by this parent
  const calcSubtreeWidth = (
    blockId: string,
    visitedCalc: Set<string>
  ): number => {
    if (visitedCalc.has(blockId)) return 0;
    visitedCalc.add(blockId);

    const block = blockMap.get(blockId);
    if (!block) return 0;

    const dim = blockDimensions.get(blockId)!;

    // Get children that this block "owns" (are assigned to this parent)
    const myLevel = levels.get(blockId) ?? 0;
    const ownedChildren = block.successors.filter((sid) => {
      const childLevel = levels.get(sid);
      return (
        childLevel !== undefined &&
        childLevel > myLevel &&
        blockMap.has(sid) &&
        layoutParent.get(sid) === blockId // Only count if we're the layout parent
      );
    });

    if (ownedChildren.length === 0) {
      subtreeWidth.set(blockId, dim.width);
      return dim.width;
    }

    // Sum of owned children subtree widths + gaps
    let totalChildWidth = 0;
    for (const childId of ownedChildren) {
      totalChildWidth += calcSubtreeWidth(childId, visitedCalc);
    }
    totalChildWidth += Math.max(0, (ownedChildren.length - 1) * horizontalGap);

    const width = Math.max(dim.width, totalChildWidth);
    subtreeWidth.set(blockId, width);
    return width;
  };

  calcSubtreeWidth(entryBlock.id, new Set());

  // Ensure all blocks have a subtree width
  blocks.forEach((b) => {
    if (!subtreeWidth.has(b.id)) {
      subtreeWidth.set(b.id, blockDimensions.get(b.id)!.width);
    }
  });

  // Position blocks
  const blockPositions = new Map<string, { x: number; y: number }>();

  // Calculate Y positions for each level
  const levelY = new Map<number, number>();
  let currentY = 50;
  for (const level of sortedLevels) {
    levelY.set(level, currentY);
    const blocksAtLevel = levelGroups.get(level)!;
    const maxHeight = Math.max(
      ...blocksAtLevel.map((b) => blockDimensions.get(b.id)!.height)
    );
    currentY += maxHeight + verticalGap;
  }

  // Position blocks using DFS, centering owned children under parent
  const positionBlock = (
    blockId: string,
    centerX: number,
    visitedPos: Set<string>
  ) => {
    if (visitedPos.has(blockId)) return;
    visitedPos.add(blockId);

    const block = blockMap.get(blockId);
    if (!block) return;

    const dim = blockDimensions.get(blockId)!;
    const level = levels.get(blockId) ?? 0;
    const y = levelY.get(level) ?? 0;

    // Position this block centered at centerX
    const x = centerX - dim.width / 2;
    blockPositions.set(blockId, { x, y });

    // Get only the children that this block owns (for positioning)
    const myLevel = levels.get(blockId) ?? 0;
    const ownedChildren = block.successors.filter((sid) => {
      const childLevel = levels.get(sid);
      return (
        childLevel !== undefined &&
        childLevel > myLevel &&
        blockMap.has(sid) &&
        layoutParent.get(sid) === blockId
      );
    });

    if (ownedChildren.length === 0) return;

    // Sort children: true branch left, false branch right, unconditional center
    const sortedChildren = [...ownedChildren].sort((a, b) => {
      const edgeA = edges.find((e) => e.from === blockId && e.to === a);
      const edgeB = edges.find((e) => e.from === blockId && e.to === b);
      const orderA =
        edgeA?.type === "conditional-true"
          ? 0
          : edgeA?.type === "unconditional"
            ? 1
            : 2;
      const orderB =
        edgeB?.type === "conditional-true"
          ? 0
          : edgeB?.type === "unconditional"
            ? 1
            : 2;
      return orderA - orderB;
    });

    // Calculate total width needed for owned children
    let totalChildWidth = 0;
    for (const childId of sortedChildren) {
      totalChildWidth +=
        subtreeWidth.get(childId) || blockDimensions.get(childId)!.width;
    }
    totalChildWidth += Math.max(0, (sortedChildren.length - 1) * horizontalGap);

    // Position children
    let childX = centerX - totalChildWidth / 2;
    for (const childId of sortedChildren) {
      const childSubtreeWidth =
        subtreeWidth.get(childId) || blockDimensions.get(childId)!.width;
      const childCenterX = childX + childSubtreeWidth / 2;
      positionBlock(childId, childCenterX, visitedPos);
      childX += childSubtreeWidth + horizontalGap;
    }
  };

  // Start positioning from entry block
  const entrySubtreeWidth =
    subtreeWidth.get(entryBlock.id) ||
    blockDimensions.get(entryBlock.id)!.width;
  positionBlock(entryBlock.id, entrySubtreeWidth / 2 + 50, new Set());

  // Handle any unpositioned blocks (disconnected or only reachable via back edges)
  blocks.forEach((block) => {
    if (!blockPositions.has(block.id)) {
      const level = levels.get(block.id) ?? 0;
      const y = levelY.get(level) ?? 0;
      // Find rightmost block at this level
      let maxX = 0;
      blockPositions.forEach((pos, id) => {
        if (levels.get(id) === level) {
          const d = blockDimensions.get(id)!;
          maxX = Math.max(maxX, pos.x + d.width);
        }
      });
      blockPositions.set(block.id, { x: maxX + horizontalGap, y });
    }
  });

  // Resolve overlaps at each level
  for (const level of sortedLevels) {
    const blocksAtLevel = levelGroups.get(level)!;
    const sortedByX = blocksAtLevel
      .filter((b) => blockPositions.has(b.id))
      .sort(
        (a, b) => blockPositions.get(a.id)!.x - blockPositions.get(b.id)!.x
      );

    for (let i = 1; i < sortedByX.length; i++) {
      const prev = sortedByX[i - 1];
      const curr = sortedByX[i];
      const prevPos = blockPositions.get(prev.id)!;
      const currPos = blockPositions.get(curr.id)!;
      const prevDim = blockDimensions.get(prev.id)!;

      const minX = prevPos.x + prevDim.width + horizontalGap;
      if (currPos.x < minX) {
        currPos.x = minX;
      }
    }
  }

  // Find the overall graph width to use as reference for centering
  let graphMinX = Infinity;
  let graphMaxX = -Infinity;
  blockPositions.forEach((pos, id) => {
    const dim = blockDimensions.get(id)!;
    graphMinX = Math.min(graphMinX, pos.x);
    graphMaxX = Math.max(graphMaxX, pos.x + dim.width);
  });
  const graphCenterX = (graphMinX + graphMaxX) / 2;

  // Center all blocks at each level
  for (const level of sortedLevels) {
    const blocksAtLevel = levelGroups.get(level)!;

    const sortedByX = blocksAtLevel
      .filter((b) => blockPositions.has(b.id))
      .sort(
        (a, b) => blockPositions.get(a.id)!.x - blockPositions.get(b.id)!.x
      );

    if (sortedByX.length === 0) continue;

    // Calculate current level width
    const firstBlock = sortedByX[0];
    const lastBlock = sortedByX[sortedByX.length - 1];
    const firstPos = blockPositions.get(firstBlock.id)!;
    const lastPos = blockPositions.get(lastBlock.id)!;
    const lastDim = blockDimensions.get(lastBlock.id)!;
    const levelWidth = lastPos.x + lastDim.width - firstPos.x;
    const levelCenterX = firstPos.x + levelWidth / 2;

    // Calculate offset to center this level
    const offset = graphCenterX - levelCenterX;

    // Apply offset to all blocks at this level
    for (const block of sortedByX) {
      const pos = blockPositions.get(block.id);
      if (pos) {
        pos.x += offset;
      }
    }
  }

  // Create layouts
  blocks.forEach((block) => {
    const pos = blockPositions.get(block.id);
    const dim = blockDimensions.get(block.id);
    if (pos && dim) {
      layouts.push({
        id: block.id,
        x: pos.x,
        y: pos.y,
        width: dim.width,
        height: dim.height,
      });
    }
  });

  return layouts;
};

// Format function name for title (e.g., "libc.so@open64")
const formatTitleFunctionName = (functionName: string): string => {
  if (!functionName) return "";
  // Already in the format we want (module@function) or just return as-is
  // Extract just module@function part if there's an offset
  const plusIndex = functionName.indexOf(" + ");
  if (plusIndex > 0) {
    return functionName.substring(0, plusIndex);
  }
  return functionName;
};

export const GraphViewPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const address = searchParams.get("address") || "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<BasicBlock[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [layouts, setLayouts] = useState<BlockLayout[]>([]);
  const [functionName, setFunctionName] = useState<string>("");
  const [startAddress, setStartAddress] = useState<string>("");
  const [endAddress, setEndAddress] = useState<string>("");

  // CFG source mode: "dynamic" (from DynaDbg) or "ghidra" (from Ghidra analysis)
  const [cfgMode, setCfgMode] = useState<CfgSourceMode>("dynamic");
  const [ghidraAvailable, setGhidraAvailable] = useState(false);
  const [libraryPath, setLibraryPath] = useState<string>("");
  const [functionOffset, setFunctionOffset] = useState<string>("");
  const [, setLoadingGhidra] = useState(false);
  const [ghidraProjectPath, setGhidraProjectPath] = useState<string>("");

  // Reachability analysis state
  const [reachabilityEnabled, setReachabilityEnabled] = useState(false);
  const [, setReachabilityLoading] = useState(false);
  const [blockReachability, setBlockReachability] = useState<
    Map<string, BlockReachability>
  >(new Map());
  const [ghidraPath, setGhidraPath] = useState<string>("");
  const [serverUrl, setServerUrl] = useState<string>(""); // dbgsrv URL for Z3 analysis
  const [breakpointRegisters, setBreakpointRegisters] = useState<
    Record<string, string>
  >({}); // Registers at breakpoint
  const [libraryBaseAddress, setLibraryBaseAddress] = useState<string>(""); // Library base address for offset calculation

  // Exception store hook for getting breakpoint registers
  const { getExceptions } = useTauriExceptionStore();

  // Ghidra analysis hook
  const { getAnalyzedLibraryInfo, checkGhidraServer, analyzeReachability } =
    useGhidraAnalysis();

  // System state hook for auth token
  const { state: tauriState } = useTauriSystemState();

  // Pan and zoom state - initial zoom at 30% for overview
  const initialZoom = 0.3;
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(initialZoom);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Block dragging state
  const [draggingBlock, setDraggingBlock] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragBlockStart, setDragBlockStart] = useState({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Load CFG from Tauri store
  const loadCFG = useCallback(async () => {
    if (!address) {
      setError("No address specified");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get graph view data from Tauri store
      const storedData = await invoke<GraphViewStoredData | null>(
        "get_graph_view_data",
        {
          address,
        }
      );

      if (!storedData) {
        throw new Error(
          "No graph view data found. Please open graph view from the assembly view."
        );
      }

      setFunctionName(storedData.function_name);
      setStartAddress(storedData.function_start_address);
      setEndAddress(storedData.function_end_address);

      // Set server URL for Z3 reachability analysis
      if (storedData.server_url) {
        setServerUrl(storedData.server_url);
        console.log(`[GraphView] Server URL: ${storedData.server_url}`);
      }

      // Load breakpoint registers if available
      if (storedData.breakpoint_registers) {
        setBreakpointRegisters(storedData.breakpoint_registers);
        console.log(
          `[GraphView] Loaded breakpoint registers:`,
          Object.keys(storedData.breakpoint_registers).length,
          "registers"
        );
      } else {
        // Try to get latest breakpoint exception for registers
        try {
          const exceptions = await getExceptions(["breakpoint"], 1);
          if (exceptions.length > 0 && exceptions[0].registers) {
            const regs: Record<string, string> = {};
            const ex = exceptions[0];
            // Extract register values from exception
            for (let i = 0; i <= 29; i++) {
              const regName = `x${i}`;
              const val =
                (ex as any)[regName] ?? (ex.registers as any)?.[regName];
              if (val !== undefined) {
                regs[regName] =
                  typeof val === "number"
                    ? `0x${val.toString(16)}`
                    : String(val);
              }
            }
            ["lr", "fp", "sp", "pc", "cpsr"].forEach((regName) => {
              const val =
                (ex as any)[regName] ?? (ex.registers as any)?.[regName];
              if (val !== undefined) {
                regs[regName] =
                  typeof val === "number"
                    ? `0x${val.toString(16)}`
                    : String(val);
              }
            });
            setBreakpointRegisters(regs);
            console.log(
              `[GraphView] Loaded registers from latest breakpoint:`,
              Object.keys(regs).length,
              "registers"
            );
          }
        } catch (e) {
          console.log(`[GraphView] Failed to get breakpoint registers:`, e);
        }
      }

      // Load library base address if available
      if (storedData.library_base_address) {
        setLibraryBaseAddress(storedData.library_base_address);
        console.log(
          `[GraphView] Library base address: ${storedData.library_base_address}`
        );
      }

      // Check if Ghidra mode is available
      if (storedData.library_path && storedData.function_offset) {
        setLibraryPath(storedData.library_path);
        setFunctionOffset(storedData.function_offset);
        console.log(
          `[GraphView] Ghidra info: library_path=${storedData.library_path}, function_offset=${storedData.function_offset}`
        );

        const libInfo = getAnalyzedLibraryInfo(storedData.library_path);
        console.log(`[GraphView] libInfo=`, libInfo);

        if (libInfo) {
          // Check if Ghidra server is running for this project
          setGhidraProjectPath(libInfo.projectPath);

          // Get Ghidra path from localStorage for reachability analysis
          // Key must match GhidraAnalyzer.tsx: "dynadbg_ghidra_path"
          try {
            const savedGhidraPath = localStorage.getItem("dynadbg_ghidra_path");
            if (savedGhidraPath) {
              setGhidraPath(savedGhidraPath);
              console.log(
                `[GraphView] Loaded Ghidra path from localStorage:`,
                savedGhidraPath
              );
            } else {
              console.log(`[GraphView] No Ghidra path found in localStorage`);
            }
          } catch (e) {
            console.log(
              `[GraphView] Failed to get Ghidra path from localStorage:`,
              e
            );
          }

          try {
            const serverPort = await checkGhidraServer(libInfo.projectPath);
            console.log(`[GraphView] Ghidra server port:`, serverPort);
            if (serverPort !== null) {
              console.log(`[GraphView] Ghidra mode available`);
              setGhidraAvailable(true);
            } else {
              console.log(`[GraphView] Ghidra server not running for project`);
            }
          } catch (e) {
            console.log(`[GraphView] Failed to check Ghidra server:`, e);
          }
        } else {
          console.log(
            `[GraphView] Library not analyzed: ${storedData.library_path}`
          );
        }
      } else {
        console.log(
          `[GraphView] No Ghidra info in storedData: library_path=${storedData.library_path}, function_offset=${storedData.function_offset}`
        );
      }

      // Parse instructions from JSON string
      const instructions: Instruction[] = JSON.parse(storedData.instructions);

      if (instructions.length === 0) {
        throw new Error("No instructions found in function range");
      }

      console.log(
        `[GraphView] Loaded ${instructions.length} instructions for ${address}`
      );

      // Build CFG from instructions
      const { blocks: cfgBlocks, edges: cfgEdges } = buildCFG(instructions);

      // Find blocks reachable from entry block using BFS
      const entryBlock = cfgBlocks.find((b) => b.isEntry);
      const reachableBlockIds = new Set<string>();

      if (entryBlock) {
        const queue: string[] = [entryBlock.id];
        reachableBlockIds.add(entryBlock.id);

        while (queue.length > 0) {
          const currentId = queue.shift()!;
          const currentBlock = cfgBlocks.find((b) => b.id === currentId);

          if (currentBlock) {
            // Add all successors to the queue if not already visited
            for (const successorId of currentBlock.successors) {
              if (!reachableBlockIds.has(successorId)) {
                reachableBlockIds.add(successorId);
                queue.push(successorId);
              }
            }
          }
        }
      }

      // Filter to only include blocks reachable from entry
      const reachableBlocks = cfgBlocks.filter((block) =>
        reachableBlockIds.has(block.id)
      );

      // Also filter edges to only include edges between reachable blocks
      const reachableEdges = cfgEdges.filter(
        (edge) =>
          reachableBlockIds.has(edge.from) && reachableBlockIds.has(edge.to)
      );

      console.log(
        `[GraphView] Filtered ${cfgBlocks.length - reachableBlocks.length} unreachable blocks`
      );

      const blockLayouts = layoutBlocks(reachableBlocks, reachableEdges);

      // Calculate initial pan to focus on entry block
      const entryBlockForLayout = reachableBlocks.find((b) => b.isEntry);
      const entryLayout = entryBlockForLayout
        ? blockLayouts.find((l) => l.id === entryBlockForLayout.id)
        : null;

      if (entryLayout) {
        // Get canvas size (use default if not available yet)
        const canvas = canvasRef.current;
        const canvasWidth = canvas?.clientWidth || 800;

        // Center the entry block horizontally and position it near the top
        const blockCenterX = entryLayout.x + entryLayout.width / 2;
        const blockTopY = entryLayout.y;

        const newPanX = canvasWidth / 2 - blockCenterX * initialZoom;
        const newPanY = 80 - blockTopY * initialZoom;

        setPan({ x: newPanX, y: newPanY });
      } else {
        setPan({ x: 50, y: 50 });
      }

      setBlocks(reachableBlocks);
      setEdges(reachableEdges);
      setLayouts(blockLayouts);
    } catch (err) {
      console.error("Failed to load CFG:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [address, getAnalyzedLibraryInfo, checkGhidraServer]);

  // Load CFG from Ghidra analysis
  const loadGhidraCFG = useCallback(async () => {
    if (!libraryPath || !functionOffset || !ghidraProjectPath) {
      setError(
        "Ghidra CFG requires library path, function offset, and project path"
      );
      return;
    }

    setLoadingGhidra(true);
    setError(null);

    try {
      console.log(
        `[GraphView] Loading Ghidra CFG for ${functionOffset} in ${libraryPath}, project: ${ghidraProjectPath}`
      );

      // Call Tauri command directly since we're in a separate window
      const cfgResult = await invoke<{
        success: boolean;
        function_name: string | null;
        function_offset: string | null;
        blocks: GhidraCfgBlock[];
        edges: GhidraCfgEdge[];
        error: string | null;
      }>("ghidra_server_cfg", {
        projectPath: ghidraProjectPath,
        functionAddress: functionOffset,
      });

      if (!cfgResult || !cfgResult.success) {
        throw new Error(cfgResult?.error || "Failed to get CFG from Ghidra");
      }

      console.log(
        `[GraphView] Ghidra CFG: ${cfgResult.blocks.length} blocks, ${cfgResult.edges.length} edges`
      );

      // Convert Ghidra CFG blocks to BasicBlock format
      const ghidraBlocks: BasicBlock[] = cfgResult.blocks.map(
        (ghBlock: GhidraCfgBlock) => ({
          id: ghBlock.id,
          startAddress: ghBlock.startAddress,
          endAddress: ghBlock.endAddress,
          instructions: ghBlock.instructions.map((instr) => ({
            address: instr.address,
            bytes: instr.bytes,
            opcode: instr.opcode,
            operands: instr.operands,
          })),
          successors: ghBlock.successors,
          predecessors: ghBlock.predecessors,
          isEntry: ghBlock.isEntry,
          isExit: ghBlock.isExit,
        })
      );

      // Convert Ghidra edges to Edge format
      const ghidraEdges: Edge[] = cfgResult.edges.map(
        (ghEdge: GhidraCfgEdge) => ({
          from: ghEdge.from,
          to: ghEdge.to,
          type: ghEdge.type as Edge["type"],
        })
      );

      // Find blocks reachable from entry block using BFS
      const entryBlock = ghidraBlocks.find((b) => b.isEntry);
      const reachableBlockIds = new Set<string>();

      if (entryBlock) {
        const queue: string[] = [entryBlock.id];
        reachableBlockIds.add(entryBlock.id);

        while (queue.length > 0) {
          const currentId = queue.shift()!;
          const currentBlock = ghidraBlocks.find((b) => b.id === currentId);

          if (currentBlock) {
            for (const successorId of currentBlock.successors) {
              if (!reachableBlockIds.has(successorId)) {
                reachableBlockIds.add(successorId);
                queue.push(successorId);
              }
            }
          }
        }
      }

      // Filter to only include blocks reachable from entry
      const reachableBlocks = ghidraBlocks.filter((block) =>
        reachableBlockIds.has(block.id)
      );

      const reachableEdges = ghidraEdges.filter(
        (edge) =>
          reachableBlockIds.has(edge.from) && reachableBlockIds.has(edge.to)
      );

      console.log(
        `[GraphView] Ghidra CFG: Filtered to ${reachableBlocks.length} reachable blocks`
      );

      const blockLayouts = layoutBlocks(reachableBlocks, reachableEdges);

      // Calculate initial pan to focus on entry block
      const entryBlockForLayout = reachableBlocks.find((b) => b.isEntry);
      const entryLayout = entryBlockForLayout
        ? blockLayouts.find((l) => l.id === entryBlockForLayout.id)
        : null;

      if (entryLayout) {
        const canvas = canvasRef.current;
        const canvasWidth = canvas?.clientWidth || 800;
        const blockCenterX = entryLayout.x + entryLayout.width / 2;
        const blockTopY = entryLayout.y;
        const newPanX = canvasWidth / 2 - blockCenterX * initialZoom;
        const newPanY = 80 - blockTopY * initialZoom;
        setPan({ x: newPanX, y: newPanY });
      } else {
        setPan({ x: 50, y: 50 });
      }

      if (cfgResult.function_name) {
        setFunctionName(cfgResult.function_name);
      }

      setBlocks(reachableBlocks);
      setEdges(reachableEdges);
      setLayouts(blockLayouts);
    } catch (err) {
      console.error("Failed to load Ghidra CFG:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingGhidra(false);
    }
  }, [libraryPath, functionOffset, ghidraProjectPath, initialZoom]);

  // Handle mode change (unused - CFG source toggle hidden)
  // @ts-expect-error Unused function kept for future use
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleModeChange = useCallback(
    (_event: React.MouseEvent<HTMLElement>, newMode: CfgSourceMode | null) => {
      if (newMode && newMode !== cfgMode) {
        setCfgMode(newMode);
        if (newMode === "ghidra") {
          loadGhidraCFG();
        } else {
          loadCFG();
        }
      }
    },
    [cfgMode, loadGhidraCFG, loadCFG]
  );

  // Analyze block reachability using Z3
  const runReachabilityAnalysis = useCallback(async () => {
    if (!ghidraAvailable || !libraryPath || !functionOffset) {
      console.log(
        "[GraphView] Reachability analysis not available - missing Ghidra info"
      );
      return;
    }

    if (!ghidraPath) {
      console.error(
        "[GraphView] Ghidra path not set - cannot run reachability analysis"
      );
      return;
    }

    if (!serverUrl) {
      console.error(
        "[GraphView] Server URL not set - cannot run reachability analysis"
      );
      return;
    }

    // Find entry block or first block as "current" block
    const entryBlock = blocks.find((b) => b.isEntry) || blocks[0];
    if (!entryBlock) {
      console.log("[GraphView] No blocks available for reachability analysis");
      return;
    }

    const currentBlockOffset = entryBlock.startAddress;

    // Check for auth token
    const authToken = tauriState?.authToken;
    if (!authToken) {
      console.error(
        "[GraphView] No auth token available - cannot run reachability analysis"
      );
      return;
    }

    setReachabilityLoading(true);
    try {
      console.log(
        `[GraphView] Running reachability analysis from block ${currentBlockOffset}`
      );
      console.log(`[GraphView] dbgsrv URL: ${serverUrl}`);
      console.log(`[GraphView] Library base address: ${libraryBaseAddress}`);
      console.log(
        `[GraphView] Registers count: ${Object.keys(breakpointRegisters).length}`
      );

      // Convert registers to JSON string
      const registersJson = JSON.stringify(breakpointRegisters);

      const result = await analyzeReachability(
        libraryPath,
        functionOffset,
        currentBlockOffset,
        serverUrl,
        authToken,
        ghidraPath,
        registersJson,
        libraryBaseAddress
      );

      if (result.success && result.blocks) {
        // Build reachability map by block ID
        const reachMap = new Map<string, BlockReachability>();
        for (const br of result.blocks) {
          reachMap.set(br.blockId, br);
        }
        setBlockReachability(reachMap);
        setReachabilityEnabled(true);
        console.log(
          `[GraphView] Reachability analysis complete: ${result.blocks.length} blocks analyzed`
        );
      } else {
        console.error(
          "[GraphView] Reachability analysis failed:",
          result.error
        );
      }
    } catch (err) {
      console.error("[GraphView] Reachability analysis error:", err);
    } finally {
      setReachabilityLoading(false);
    }
  }, [
    ghidraAvailable,
    libraryPath,
    functionOffset,
    blocks,
    analyzeReachability,
    ghidraPath,
    serverUrl,
    tauriState?.authToken,
    breakpointRegisters,
    libraryBaseAddress,
  ]);

  // Toggle reachability display (unused - Z3 reachability hidden)
  // @ts-expect-error Unused function kept for future use
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _toggleReachability = useCallback(() => {
    if (reachabilityEnabled) {
      setReachabilityEnabled(false);
      setBlockReachability(new Map());
    } else {
      runReachabilityAnalysis();
    }
  }, [reachabilityEnabled, runReachabilityAnalysis]);

  // Get block border color based on reachability status
  const getBlockBorderColor = useCallback(
    (block: BasicBlock): string => {
      if (!reachabilityEnabled) {
        // Default coloring
        if (block.isEntry) return "#4caf50";
        if (block.isExit) return "#ff5722";
        return "#3c3c3c";
      }

      const reachability = blockReachability.get(block.id);
      if (!reachability) {
        return "#3c3c3c"; // Unknown
      }

      switch (reachability.status) {
        case "current":
          return "#2196f3"; // Blue for current block
        case "reachable":
          return "#4caf50"; // Green for reachable
        case "unreachable":
          return "#f44336"; // Red for unreachable
        case "conditional":
          return "#ff9800"; // Orange for conditional
        default:
          return "#9e9e9e"; // Gray for unknown
      }
    },
    [reachabilityEnabled, blockReachability]
  );

  // Get block header background based on reachability
  const getBlockHeaderBg = useCallback(
    (block: BasicBlock): string => {
      if (!reachabilityEnabled) {
        if (block.isEntry) return alpha("#4caf50", 0.2);
        if (block.isExit) return alpha("#ff5722", 0.2);
        return "#1a1a1a";
      }

      const reachability = blockReachability.get(block.id);
      if (!reachability) return "#1a1a1a";

      switch (reachability.status) {
        case "current":
          return alpha("#2196f3", 0.2);
        case "reachable":
          return alpha("#4caf50", 0.2);
        case "unreachable":
          return alpha("#f44336", 0.2);
        case "conditional":
          return alpha("#ff9800", 0.2);
        default:
          return "#1a1a1a";
      }
    },
    [reachabilityEnabled, blockReachability]
  );

  useEffect(() => {
    loadCFG();
  }, [loadCFG]);

  // Canvas pan handlers (when not dragging a block)
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only start panning if clicking on canvas (not on a block)
      if (e.button === 0 && !draggingBlock) {
        setIsPanning(true);
        setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      }
    },
    [pan, draggingBlock]
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (draggingBlock) {
        // Dragging a block
        const deltaX = (e.clientX - dragStart.x) / zoom;
        const deltaY = (e.clientY - dragStart.y) / zoom;

        setLayouts((prevLayouts) =>
          prevLayouts.map((layout) =>
            layout.id === draggingBlock
              ? {
                  ...layout,
                  x: dragBlockStart.x + deltaX,
                  y: dragBlockStart.y + deltaY,
                }
              : layout
          )
        );
      } else if (isPanning) {
        // Panning the canvas
        setPan({
          x: e.clientX - panStart.x,
          y: e.clientY - panStart.y,
        });
      }
    },
    [draggingBlock, dragStart, dragBlockStart, zoom, isPanning, panStart]
  );

  const handleCanvasMouseUp = useCallback(() => {
    setIsPanning(false);
    setDraggingBlock(null);
  }, []);

  // Block drag handlers
  const handleBlockMouseDown = useCallback(
    (blockId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.button === 0) {
        const layout = layouts.find((l) => l.id === blockId);
        if (layout) {
          setDraggingBlock(blockId);
          setDragStart({ x: e.clientX, y: e.clientY });
          setDragBlockStart({ x: layout.x, y: layout.y });
        }
      }
    },
    [layouts]
  );

  // Zoom handlers - zoom centered on mouse position
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();

      const canvas = canvasRef.current;
      if (!canvas) return;

      // Get mouse position relative to canvas
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Calculate graph position under mouse before zoom
      const graphX = (mouseX - pan.x) / zoom;
      const graphY = (mouseY - pan.y) / zoom;

      // Calculate new zoom
      const delta = e.deltaY > 0 ? 1.1 : 0.9;
      const newZoom = Math.min(Math.max(zoom * delta, 0.05), 3);

      // Calculate new pan to keep mouse position fixed
      const newPanX = mouseX - graphX * newZoom;
      const newPanY = mouseY - graphY * newZoom;

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    },
    [zoom, pan]
  );

  // Toolbar zoom buttons - zoom centered on canvas center
  const handleZoomIn = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setZoom((prev) => Math.min(prev * 1.2, 3));
      return;
    }

    const centerX = canvas.clientWidth / 2;
    const centerY = canvas.clientHeight / 2;
    const graphX = (centerX - pan.x) / zoom;
    const graphY = (centerY - pan.y) / zoom;

    const newZoom = Math.min(zoom * 1.2, 3);
    const newPanX = centerX - graphX * newZoom;
    const newPanY = centerY - graphY * newZoom;

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  }, [zoom, pan]);

  const handleZoomOut = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setZoom((prev) => Math.max(prev * 0.8, 0.05));
      return;
    }

    const centerX = canvas.clientWidth / 2;
    const centerY = canvas.clientHeight / 2;
    const graphX = (centerX - pan.x) / zoom;
    const graphY = (centerY - pan.y) / zoom;

    const newZoom = Math.max(zoom * 0.8, 0.05);
    const newPanX = centerX - graphX * newZoom;
    const newPanY = centerY - graphY * newZoom;

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  }, [zoom, pan]);

  const handleCenter = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  const handleClose = useCallback(async () => {
    const window = getCurrentWebviewWindow();
    await window.close();
  }, []);

  // Calculate graph bounds for minimap
  const graphBounds = React.useMemo(() => {
    if (layouts.length === 0)
      return {
        minX: 0,
        minY: 0,
        maxX: 1000,
        maxY: 1000,
        width: 1000,
        height: 1000,
      };

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    layouts.forEach((layout) => {
      minX = Math.min(minX, layout.x);
      minY = Math.min(minY, layout.y);
      maxX = Math.max(maxX, layout.x + layout.width);
      maxY = Math.max(maxY, layout.y + layout.height);
    });

    // Add padding
    const padding = 50;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, [layouts]);

  // Minimap dimensions
  const minimapWidth = 200;
  const minimapHeight = 150;

  // Calculate minimap scale and offset to center the graph
  const minimapScale = React.useMemo(() => {
    const scaleX = minimapWidth / graphBounds.width;
    const scaleY = minimapHeight / graphBounds.height;
    return Math.min(scaleX, scaleY);
  }, [graphBounds]);

  // Calculate offset to center graph in minimap
  const minimapOffset = React.useMemo(() => {
    const scaledWidth = graphBounds.width * minimapScale;
    const scaledHeight = graphBounds.height * minimapScale;
    return {
      x: (minimapWidth - scaledWidth) / 2,
      y: (minimapHeight - scaledHeight) / 2,
    };
  }, [graphBounds, minimapScale]);

  // Handle minimap click to navigate
  const handleMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left - minimapOffset.x;
      const clickY = e.clientY - rect.top - minimapOffset.y;

      // Convert minimap coordinates to graph coordinates
      const graphX = graphBounds.minX + clickX / minimapScale;
      const graphY = graphBounds.minY + clickY / minimapScale;

      // Get canvas size
      const canvas = canvasRef.current;
      if (!canvas) return;
      const canvasWidth = canvas.clientWidth;
      const canvasHeight = canvas.clientHeight;

      // Center the view on the clicked point
      const newPanX = -(graphX * zoom) + canvasWidth / 2;
      const newPanY = -(graphY * zoom) + canvasHeight / 2;

      setPan({ x: newPanX, y: newPanY });
    },
    [graphBounds, minimapScale, minimapOffset, zoom]
  );

  // Calculate viewport rectangle on minimap
  const viewportRect = React.useMemo(() => {
    const canvas = canvasRef.current;
    if (!canvas)
      return { x: 0, y: 0, width: minimapWidth, height: minimapHeight };

    const canvasWidth = canvas.clientWidth || 800;
    const canvasHeight = canvas.clientHeight || 600;

    // Calculate what portion of the graph is visible
    const visibleLeft = -pan.x / zoom;
    const visibleTop = -pan.y / zoom;
    const visibleWidth = canvasWidth / zoom;
    const visibleHeight = canvasHeight / zoom;

    // Convert to minimap coordinates (with offset for centering)
    const x = (visibleLeft - graphBounds.minX) * minimapScale + minimapOffset.x;
    const y = (visibleTop - graphBounds.minY) * minimapScale + minimapOffset.y;
    const width = visibleWidth * minimapScale;
    const height = visibleHeight * minimapScale;

    return { x, y, width, height };
  }, [pan, zoom, graphBounds, minimapScale, minimapOffset]);

  // Render edge path using straight lines with orthogonal routing
  const renderEdgePath = useCallback(
    (edge: Edge, allEdges: Edge[], edgeIndex: number): string => {
      const fromLayout = layouts.find((l) => l.id === edge.from);
      const toLayout = layouts.find((l) => l.id === edge.to);

      if (!fromLayout || !toLayout) return "";

      const margin = 15; // Margin around blocks for collision detection
      const edgeSpacing = 12; // Spacing between parallel edges

      // Helper: Check if a horizontal line segment intersects a specific block
      const horizontalIntersectsBlock = (
        y: number,
        x1: number,
        x2: number,
        block: BlockLayout
      ): boolean => {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        // Check if horizontal line passes through block
        return (
          y > block.y - margin &&
          y < block.y + block.height + margin &&
          maxX > block.x - margin &&
          minX < block.x + block.width + margin
        );
      };

      // Helper: Check if a vertical line segment intersects a specific block
      const verticalIntersectsBlock = (
        x: number,
        y1: number,
        y2: number,
        block: BlockLayout
      ): boolean => {
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        // Check if vertical line passes through block
        return (
          x > block.x - margin &&
          x < block.x + block.width + margin &&
          maxY > block.y - margin &&
          minY < block.y + block.height + margin
        );
      };

      // Get blocks that are potentially in the path between from and to
      // Only consider blocks whose bounding area overlaps with the edge's bounding box
      const getBlocksInPath = (): BlockLayout[] => {
        const minX = Math.min(fromLayout.x, toLayout.x) - margin;
        const maxX =
          Math.max(
            fromLayout.x + fromLayout.width,
            toLayout.x + toLayout.width
          ) + margin;
        const minY = Math.min(fromLayout.y, toLayout.y) - margin;
        const maxY =
          Math.max(
            fromLayout.y + fromLayout.height,
            toLayout.y + toLayout.height
          ) + margin;

        return layouts.filter((layout) => {
          // Skip source and target blocks
          if (layout.id === edge.from || layout.id === edge.to) return false;

          // Check if block overlaps with the bounding box of the edge
          const blockRight = layout.x + layout.width;
          const blockBottom = layout.y + layout.height;

          return !(
            blockRight < minX ||
            layout.x > maxX ||
            blockBottom < minY ||
            layout.y > maxY
          );
        });
      };

      const blocksInPath = getBlocksInPath();

      // Count edges from same source to offset them
      const edgesFromSame = allEdges.filter((e) => e.from === edge.from);
      const indexInSource = edgesFromSame.indexOf(edge);
      const totalFromSource = edgesFromSame.length;

      // Count edges to same target to offset them
      const edgesToSame = allEdges.filter((e) => e.to === edge.to);
      const indexInTarget = edgesToSame.indexOf(edge);
      const totalToTarget = edgesToSame.length;

      // Calculate offset for multiple edges from same source
      const sourceOffset =
        totalFromSource > 1
          ? (indexInSource - (totalFromSource - 1) / 2) * 25
          : 0;

      // Calculate offset for multiple edges to same target
      const targetOffset =
        totalToTarget > 1 ? (indexInTarget - (totalToTarget - 1) / 2) * 25 : 0;

      // Start from bottom of source block (with offset for multiple edges)
      const fromX = fromLayout.x + fromLayout.width / 2 + sourceOffset;
      const fromY = fromLayout.y + fromLayout.height;

      // End at top of target block (with offset for multiple edges)
      const toX = toLayout.x + toLayout.width / 2 + targetOffset;
      const toY = toLayout.y;

      // Use edge index for vertical offset to prevent overlap
      const verticalOffset = edgeIndex * edgeSpacing;

      // Check if going upward (back edge / loop)
      const isBackEdge = toLayout.y <= fromLayout.y;

      if (isBackEdge) {
        // Back edge - route around the side
        // Find the bounding box of blocks involved in the back edge
        const relevantBlocks = [fromLayout, toLayout, ...blocksInPath];
        let minBlockX = Infinity;
        let maxBlockX = -Infinity;
        let minBlockY = Infinity;
        let maxBlockY = -Infinity;
        for (const block of relevantBlocks) {
          minBlockX = Math.min(minBlockX, block.x);
          maxBlockX = Math.max(maxBlockX, block.x + block.width);
          minBlockY = Math.min(minBlockY, block.y);
          maxBlockY = Math.max(maxBlockY, block.y + block.height);
        }

        const outerMargin = 80; // Increased margin for back edges
        const routeRight = fromX > fromLayout.x + fromLayout.width / 2;
        const sideX = routeRight
          ? maxBlockX + outerMargin + verticalOffset
          : minBlockX - outerMargin - verticalOffset;

        const exitY = fromY + margin + 25 + (edgeIndex % 3) * edgeSpacing;
        const entryY = toY - margin - 25 - (edgeIndex % 3) * edgeSpacing;

        return `M ${fromX} ${fromY}
                L ${fromX} ${exitY}
                L ${sideX} ${exitY}
                L ${sideX} ${entryY}
                L ${toX} ${entryY}
                L ${toX} ${toY}`;
      }

      // Normal downward edge - check for collisions only with blocks in path
      if (blocksInPath.length === 0) {
        // No blocks in the way, use simple routing
        if (Math.abs(fromX - toX) < 5) {
          // Nearly vertical
          return `M ${fromX} ${fromY} L ${toX} ${toY}`;
        }
        // Use midpoint routing with offset to prevent overlapping horizontal segments
        const baseMidY = fromY + (toY - fromY) / 2;
        const midY = baseMidY + ((edgeIndex % 5) - 2) * edgeSpacing;
        return `M ${fromX} ${fromY}
                L ${fromX} ${midY}
                L ${toX} ${midY}
                L ${toX} ${toY}`;
      }

      // There are blocks in the path - check for actual collisions
      const baseMidY = fromY + (toY - fromY) / 2;
      const midY = baseMidY + ((edgeIndex % 5) - 2) * edgeSpacing;

      // Check if midpoint routing collides with any block in path
      let hasCollision = false;
      for (const block of blocksInPath) {
        if (
          verticalIntersectsBlock(fromX, fromY, midY, block) ||
          horizontalIntersectsBlock(midY, fromX, toX, block) ||
          verticalIntersectsBlock(toX, midY, toY, block)
        ) {
          hasCollision = true;
          break;
        }
      }

      if (!hasCollision) {
        // Midpoint routing is clear
        return `M ${fromX} ${fromY}
                L ${fromX} ${midY}
                L ${toX} ${midY}
                L ${toX} ${toY}`;
      }

      // Need to route around the blocking blocks
      // Find the extents of blocking blocks
      let minBlockX = Infinity;
      let maxBlockX = -Infinity;
      for (const block of blocksInPath) {
        minBlockX = Math.min(minBlockX, block.x);
        maxBlockX = Math.max(maxBlockX, block.x + block.width);
      }

      // Decide which side to route around
      const leftDistance = Math.min(fromX, toX) - minBlockX;
      const rightDistance = maxBlockX - Math.max(fromX, toX);
      const routeRight = rightDistance < leftDistance;

      const outerMargin = 80; // Increased margin for collision avoidance
      const sideX = routeRight
        ? maxBlockX + outerMargin + verticalOffset
        : minBlockX - outerMargin - verticalOffset;

      // Route: exit from bottom of source block -> side -> entry to target
      // exitY is just below the source block (fromY is already block bottom)
      const exitY = fromY + 15 + (edgeIndex % 3) * edgeSpacing;
      const entryY = toY - 15 - (edgeIndex % 3) * edgeSpacing;

      return `M ${fromX} ${fromY}
              L ${fromX} ${exitY}
              L ${sideX} ${exitY}
              L ${sideX} ${entryY}
              L ${toX} ${entryY}
              L ${toX} ${toY}`;
    },
    [layouts]
  );

  // Edge color based on type
  const getEdgeColor = (type: Edge["type"]): string => {
    switch (type) {
      case "conditional-true":
        return "#4caf50";
      case "conditional-false":
        return "#ff5722";
      case "unconditional":
        return "#4fc1ff";
      default:
        return "#808080";
    }
  };

  // Format title
  const titleText = formatTitleFunctionName(functionName) || address;

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <WindowContainer>
        <WindowHeader>
          <WindowTitle>
            <GraphIcon sx={{ fontSize: 18, color: "#4fc1ff" }} />
            Graph View - {titleText}
            <Typography
              component="span"
              sx={{
                color: "#808080",
                fontSize: "11px",
                ml: 2,
                fontWeight: "normal",
              }}
            >
              {startAddress} - {endAddress}
            </Typography>
          </WindowTitle>
          <Box display="flex" gap={1}>
            <Tooltip title="Close">
              <IconButton
                size="small"
                onClick={handleClose}
                sx={{ color: "#808080" }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </WindowHeader>

        <ToolbarContainer>
          <Tooltip title="Zoom In">
            <IconButton
              size="small"
              onClick={handleZoomIn}
              sx={{ color: "#808080" }}
            >
              <ZoomInIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom Out">
            <IconButton
              size="small"
              onClick={handleZoomOut}
              sx={{ color: "#808080" }}
            >
              <ZoomOutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Center View">
            <IconButton
              size="small"
              onClick={handleCenter}
              sx={{ color: "#808080" }}
            >
              <CenterIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Typography sx={{ color: "#808080", fontSize: "12px", ml: 2 }}>
            Zoom: {Math.round(zoom * 100)}%
          </Typography>
          <Typography sx={{ color: "#606060", fontSize: "11px", ml: 2 }}>
            Blocks: {blocks.length}
          </Typography>

          {/* Right side spacer */}
          <Box sx={{ ml: "auto" }} />
        </ToolbarContainer>

        <GraphCanvas
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseUp}
          onWheel={handleWheel}
        >
          {loading && (
            <LoadingOverlay>
              <CircularProgress size={40} sx={{ color: "#4fc1ff" }} />
              <Typography sx={{ color: "#808080", mt: 2 }}>
                Loading CFG...
              </Typography>
            </LoadingOverlay>
          )}

          {error && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "#ff5722",
              }}
            >
              <Typography>Error: {error}</Typography>
            </Box>
          )}

          {!loading && !error && (
            <>
              {/* Minimap */}
              <MinimapContainer onClick={handleMinimapClick}>
                <svg
                  width={minimapWidth}
                  height={minimapHeight}
                  style={{ display: "block" }}
                >
                  {/* Background */}
                  <rect
                    x={0}
                    y={0}
                    width={minimapWidth}
                    height={minimapHeight}
                    fill="#1a1a1a"
                  />

                  {/* Edges */}
                  {edges.map((edge, idx) => {
                    const fromLayout = layouts.find((l) => l.id === edge.from);
                    const toLayout = layouts.find((l) => l.id === edge.to);
                    if (!fromLayout || !toLayout) return null;

                    const fromX =
                      (fromLayout.x + fromLayout.width / 2 - graphBounds.minX) *
                        minimapScale +
                      minimapOffset.x;
                    const fromY =
                      (fromLayout.y + fromLayout.height - graphBounds.minY) *
                        minimapScale +
                      minimapOffset.y;
                    const toX =
                      (toLayout.x + toLayout.width / 2 - graphBounds.minX) *
                        minimapScale +
                      minimapOffset.x;
                    const toY =
                      (toLayout.y - graphBounds.minY) * minimapScale +
                      minimapOffset.y;

                    const edgeColor =
                      edge.type === "conditional-true"
                        ? "#4caf50"
                        : edge.type === "conditional-false"
                          ? "#ff5722"
                          : edge.type === "unconditional"
                            ? "#4fc1ff"
                            : "#808080";

                    return (
                      <line
                        key={`minimap-edge-${idx}`}
                        x1={fromX}
                        y1={fromY}
                        x2={toX}
                        y2={toY}
                        stroke={edgeColor}
                        strokeWidth={0.5}
                        opacity={0.6}
                      />
                    );
                  })}

                  {/* Blocks */}
                  {layouts.map((layout) => {
                    const block = blocks.find((b) => b.id === layout.id);
                    const x =
                      (layout.x - graphBounds.minX) * minimapScale +
                      minimapOffset.x;
                    const y =
                      (layout.y - graphBounds.minY) * minimapScale +
                      minimapOffset.y;
                    const width = layout.width * minimapScale;
                    const height = layout.height * minimapScale;

                    const fillColor = block?.isEntry
                      ? "#4caf50"
                      : block?.isExit
                        ? "#ff5722"
                        : "#3c3c3c";

                    return (
                      <rect
                        key={`minimap-block-${layout.id}`}
                        x={x}
                        y={y}
                        width={Math.max(width, 2)}
                        height={Math.max(height, 2)}
                        fill={fillColor}
                        opacity={0.8}
                      />
                    );
                  })}

                  {/* Viewport indicator */}
                  <rect
                    x={Math.max(0, viewportRect.x)}
                    y={Math.max(0, viewportRect.y)}
                    width={Math.min(
                      viewportRect.width,
                      minimapWidth - Math.max(0, viewportRect.x)
                    )}
                    height={Math.min(
                      viewportRect.height,
                      minimapHeight - Math.max(0, viewportRect.y)
                    )}
                    fill="rgba(79, 193, 255, 0.05)"
                    stroke="rgba(79, 193, 255, 0.4)"
                    strokeWidth={1}
                  />
                </svg>
              </MinimapContainer>

              <Box
                sx={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "top left",
                  position: "absolute",
                  top: 0,
                  left: 0,
                }}
              >
                {/* Edges SVG */}
                <svg
                  ref={svgRef}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "3000px",
                    height: "5000px",
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                >
                  <defs>
                    {/* Start markers (circles at the beginning of lines) */}
                    <marker
                      id="startpoint-green"
                      markerWidth="6"
                      markerHeight="6"
                      refX="3"
                      refY="3"
                    >
                      <circle cx="3" cy="3" r="3" fill="#4caf50" />
                    </marker>
                    <marker
                      id="startpoint-red"
                      markerWidth="6"
                      markerHeight="6"
                      refX="3"
                      refY="3"
                    >
                      <circle cx="3" cy="3" r="3" fill="#ff5722" />
                    </marker>
                    <marker
                      id="startpoint-blue"
                      markerWidth="6"
                      markerHeight="6"
                      refX="3"
                      refY="3"
                    >
                      <circle cx="3" cy="3" r="3" fill="#4fc1ff" />
                    </marker>
                    <marker
                      id="startpoint-gray"
                      markerWidth="6"
                      markerHeight="6"
                      refX="3"
                      refY="3"
                    >
                      <circle cx="3" cy="3" r="3" fill="#808080" />
                    </marker>
                    {/* End markers (arrowheads) */}
                    <marker
                      id="arrowhead-green"
                      markerWidth="10"
                      markerHeight="7"
                      refX="0"
                      refY="3.5"
                      orient="auto"
                    >
                      <polygon points="0 0, 10 3.5, 0 7" fill="#4caf50" />
                    </marker>
                    <marker
                      id="arrowhead-red"
                      markerWidth="10"
                      markerHeight="7"
                      refX="0"
                      refY="3.5"
                      orient="auto"
                    >
                      <polygon points="0 0, 10 3.5, 0 7" fill="#ff5722" />
                    </marker>
                    <marker
                      id="arrowhead-blue"
                      markerWidth="10"
                      markerHeight="7"
                      refX="0"
                      refY="3.5"
                      orient="auto"
                    >
                      <polygon points="0 0, 10 3.5, 0 7" fill="#4fc1ff" />
                    </marker>
                    <marker
                      id="arrowhead-gray"
                      markerWidth="10"
                      markerHeight="7"
                      refX="0"
                      refY="3.5"
                      orient="auto"
                    >
                      <polygon points="0 0, 10 3.5, 0 7" fill="#808080" />
                    </marker>
                    {/* Down-pointing arrowheads for downward edges */}
                    <marker
                      id="arrowhead-down-green"
                      markerWidth="5"
                      markerHeight="6"
                      refX="2.5"
                      refY="6"
                    >
                      <polygon points="0 0, 5 0, 2.5 6" fill="#4caf50" />
                    </marker>
                    <marker
                      id="arrowhead-down-red"
                      markerWidth="5"
                      markerHeight="6"
                      refX="2.5"
                      refY="6"
                    >
                      <polygon points="0 0, 5 0, 2.5 6" fill="#ff5722" />
                    </marker>
                    <marker
                      id="arrowhead-down-blue"
                      markerWidth="5"
                      markerHeight="6"
                      refX="2.5"
                      refY="6"
                    >
                      <polygon points="0 0, 5 0, 2.5 6" fill="#4fc1ff" />
                    </marker>
                    <marker
                      id="arrowhead-down-gray"
                      markerWidth="5"
                      markerHeight="6"
                      refX="2.5"
                      refY="6"
                    >
                      <polygon points="0 0, 5 0, 2.5 6" fill="#808080" />
                    </marker>
                    {/* Up-pointing arrowheads for back edges */}
                    <marker
                      id="arrowhead-up-green"
                      markerWidth="7"
                      markerHeight="10"
                      refX="3.5"
                      refY="0"
                    >
                      <polygon points="3.5 0, 7 10, 0 10" fill="#4caf50" />
                    </marker>
                    <marker
                      id="arrowhead-up-red"
                      markerWidth="7"
                      markerHeight="10"
                      refX="3.5"
                      refY="0"
                    >
                      <polygon points="3.5 0, 7 10, 0 10" fill="#ff5722" />
                    </marker>
                    <marker
                      id="arrowhead-up-blue"
                      markerWidth="7"
                      markerHeight="10"
                      refX="3.5"
                      refY="0"
                    >
                      <polygon points="3.5 0, 7 10, 0 10" fill="#4fc1ff" />
                    </marker>
                    <marker
                      id="arrowhead-up-gray"
                      markerWidth="7"
                      markerHeight="10"
                      refX="3.5"
                      refY="0"
                    >
                      <polygon points="3.5 0, 7 10, 0 10" fill="#808080" />
                    </marker>
                  </defs>
                  {edges.map((edge, idx) => {
                    // All edges enter target block from the top, so always use down-pointing arrows
                    const markerEndId =
                      edge.type === "conditional-true"
                        ? "arrowhead-down-green"
                        : edge.type === "conditional-false"
                          ? "arrowhead-down-red"
                          : edge.type === "unconditional"
                            ? "arrowhead-down-blue"
                            : "arrowhead-down-gray";
                    const markerStartId =
                      edge.type === "conditional-true"
                        ? "startpoint-green"
                        : edge.type === "conditional-false"
                          ? "startpoint-red"
                          : edge.type === "unconditional"
                            ? "startpoint-blue"
                            : "startpoint-gray";
                    return (
                      <path
                        key={`edge-${idx}`}
                        d={renderEdgePath(edge, edges, idx)}
                        fill="none"
                        stroke={getEdgeColor(edge.type)}
                        strokeWidth="2"
                        markerStart={`url(#${markerStartId})`}
                        markerEnd={`url(#${markerEndId})`}
                      />
                    );
                  })}
                </svg>

                {/* Blocks */}
                {blocks.map((block) => {
                  const layout = layouts.find((l) => l.id === block.id);
                  if (!layout) return null;

                  const borderColor = getBlockBorderColor(block);
                  const headerBg = getBlockHeaderBg(block);
                  const reachability = blockReachability.get(block.id);

                  return (
                    <BlockContainer
                      key={block.id}
                      isEntry={block.isEntry}
                      isExit={block.isExit}
                      isDragging={draggingBlock === block.id}
                      sx={{
                        left: layout.x,
                        top: layout.y,
                        width: layout.width,
                        borderColor: borderColor,
                      }}
                      onMouseDown={(e) => handleBlockMouseDown(block.id, e)}
                    >
                      <BlockHeader
                        isEntry={!reachabilityEnabled && block.isEntry}
                        isExit={!reachabilityEnabled && block.isExit}
                        sx={{
                          backgroundColor: headerBg,
                          color: borderColor,
                        }}
                      >
                        {block.startAddress}
                        {block.isEntry && " (entry)"}
                        {block.isExit && " (exit)"}
                        {reachabilityEnabled && reachability && (
                          <Typography
                            component="span"
                            sx={{
                              ml: 1,
                              fontSize: "10px",
                              opacity: 0.8,
                            }}
                          >
                            [{reachability.status}]
                            {reachability.condition &&
                              ` - ${reachability.condition}`}
                          </Typography>
                        )}
                      </BlockHeader>
                      {block.instructions.map((instr, idx) => (
                        <InstructionRow
                          key={idx}
                          onClick={() => {
                            // Emit event to main window to navigate to this address
                            emit("navigate-to-address", {
                              address: instr.address,
                            });
                          }}
                        >
                          <AddressText>{instr.address}</AddressText>
                          <OpcodeText
                            sx={{
                              color: isJumpInstruction(instr.opcode)
                                ? isConditionalJump(instr.opcode)
                                  ? "#cc9900"
                                  : "#66cc66"
                                : "#569cd6",
                            }}
                          >
                            {instr.opcode}
                          </OpcodeText>
                          <OperandsText>{instr.operands}</OperandsText>
                        </InstructionRow>
                      ))}
                    </BlockContainer>
                  );
                })}
              </Box>
            </>
          )}
        </GraphCanvas>
      </WindowContainer>
    </ThemeProvider>
  );
};

export default GraphViewPage;
