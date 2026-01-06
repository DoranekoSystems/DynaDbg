import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  styled,
  alpha,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableSortLabel,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  CircularProgress,
  Snackbar,
  Alert,
  Checkbox,
  FormControlLabel,
} from "@mui/material";
import {
  Functions as FunctionsIcon,
  KeyboardArrowUp as ArrowUpIcon,
  KeyboardArrowDown as ArrowDownIcon,
  Clear as ClearIcon,
  Refresh as RefreshIcon,
  AutoStories as DecompileIcon,
  Timeline as TimelineIcon,
  PushPin as BreakpointIcon,
  ContentCopy as CopyIcon,
  SwapHoriz as SwapHorizIcon,
  Code as CodeIcon,
  AccountTree as GraphIcon,
  VerticalAlignTop as FunctionStartIcon,
  VerticalAlignBottom as FunctionEndIcon,
  CallReceived as CallReceivedIcon,
  CheckCircleOutline as CheckCircleOutlineIcon,
  BlockOutlined as NopIcon,
  Settings as SettingsIcon,
  Close as CloseIcon,
  InsertDriveFile as FileIcon,
} from "@mui/icons-material";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ServerInfo,
  DisassembleResponse,
  getApiClient,
  ModuleInfo,
} from "../lib/api";
import { useGlobalDebugLogger } from "../hooks/useGlobalDebugLogger";
import { useTableColumnResize } from "../hooks/useTableColumnResize";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { ColumnResizer } from "./ColumnResizer";
import { useUIStore, SourceBreakpoint } from "../stores/uiStore";
import { useSymbolCache } from "../hooks/useSymbolCache";
import { useTauriSystemStateSingleton } from "../hooks/useTauriSystemStateSingleton";
import { encodeAddressToLibraryExpression } from "../utils/addressEncoder";
import { openCodeTracingWindow, startTraceSession } from "./CodeTracingWindow";
import {
  predictNextInstruction,
  convertRegistersToState,
} from "../utils/arm64BranchPredictor";
import {
  openGraphViewWindow,
  GraphViewData,
  GraphViewInstruction,
} from "./GraphViewWindow";
import { useGhidraAnalysis, GhidraTokenInfo } from "../hooks/useGhidraAnalysis";

// Empty array constant for default value (prevents infinite loop in zustand selector)
const EMPTY_SOURCE_BREAKPOINTS: SourceBreakpoint[] = [];

interface Instruction {
  address: string;
  bytes: string;
  opcode: string;
  operands: Array<{
    type: string;
    value: string;
  }>;
  comment: string;
  active: boolean;
  breakpoint: boolean;
  isSoftwareBreakpoint?: boolean; // true if software breakpoint, false/undefined if hardware
  jumpTarget: boolean;
  isFunction?: boolean;
  isFunctionStart?: boolean;
  isFunctionEnd?: boolean;
}

// Branch arrow information for visualization
interface BranchArrowInfo {
  fromIndex: number;
  toIndex: number;
  fromAddress: string;
  toAddress: string;
  isConditional: boolean;
  isDownward: boolean;
  depth: number; // For nested arrows (0 = leftmost)
  isPredictedNext?: boolean; // True if this is the predicted next instruction based on register state
}

const DisassemblyContainer = styled(Box)(() => ({
  overflowY: "hidden",
  height: "100%",
  backgroundColor: "#1e1e1e",
  position: "relative",
  "&:focus": {
    outline: "none",
  },
}));

const ScrollableContent = styled(Box)(() => ({
  height: "100%",
  overflowY: "auto",
  "&::-webkit-scrollbar": {
    width: "8px",
  },
  "&::-webkit-scrollbar-track": {
    background: "#1e1e1e",
  },
  "&::-webkit-scrollbar-thumb": {
    background: "#424242",
    borderRadius: "4px",
  },
  "&::-webkit-scrollbar-thumb:hover": {
    background: "#5a5a5e",
  },
}));

// New table components for assembly view, similar to MemoryView
const AssemblyTable = styled(Table)(() => ({
  backgroundColor: "#1a1a1a",
  tableLayout: "fixed",
  "& .MuiTableCell-root": {
    borderBottom: "1px solid #2d2d30",
    padding: "2px 4px",
    fontSize: "12px",
    fontFamily: 'Consolas, "Courier New", monospace',
    color: "#d4d4d4",
  },
  "& .MuiTableHead-root .MuiTableCell-root": {
    backgroundColor: "#252526",
    color: "#4fc1ff",
    fontWeight: 600,
    fontSize: "10px",
    padding: "4px",
    position: "sticky",
    top: 0,
    zIndex: 1,
    borderBottom: "2px solid #4fc1ff",
  },
  "& .MuiTableBody-root .MuiTableRow-root": {
    minHeight: "18px",
    "&:hover": {
      backgroundColor: "rgba(79, 193, 255, 0.08)",
    },
    "& .MuiTableCell-root": {
      padding: "1px 4px",
    },
    // Ensure bytes column maintains its orange color
    "& .MuiTableCell-root:nth-of-type(3)": {
      color: "#ce9178 !important",
    },
  },
  "@media (max-height: 800px)": {
    "& .MuiTableCell-root": {
      padding: "1px 2px",
      fontSize: "10px",
    },
    "& .MuiTableHead-root .MuiTableCell-root": {
      fontSize: "9px",
      padding: "2px",
    },
    "& .MuiTableBody-root .MuiTableRow-root": {
      minHeight: "14px",
      "& .MuiTableCell-root": {
        padding: "0px 2px",
      },
    },
  },
}));

const AssemblyTableWrapper = styled(Box)(() => ({
  margin: "8px",
  backgroundColor: "#1a1a1a",
  border: "1px solid #2d2d30",
  borderRadius: "4px",
  height: "calc(100% - 16px)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  "@media (max-height: 800px)": {
    margin: "4px",
    height: "calc(100% - 8px)",
  },
}));

const AssemblyTableContainer = styled(Box)(() => ({
  flex: 1,
  overflow: "hidden",
  position: "relative", // For SVG branch arrow overlay positioning
}));

const BreakpointTableCell = styled(TableCell)(() => ({
  textAlign: "center",
  padding: "2px !important",
  borderRight: "1px solid #2d2d30",
  cursor: "pointer",
  position: "relative",
  "&:hover": {
    backgroundColor: "rgba(255, 68, 68, 0.2)",
  },
}));

const AddressTableCell = styled(TableCell)(() => ({
  color: "#4fc1ff", // Keep original address color
  borderRight: "1px solid #2d2d30",
  cursor: "pointer",
  position: "relative",
  "&:hover": {
    color: "#4fc1ff",
    textDecoration: "underline",
  },
}));

const BytesTableCell = styled(TableCell)(() => ({
  color: "#ce9178", // Orange bytes color
  borderRight: "1px solid #2d2d30",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  position: "relative",
  "& .MuiTableCell-root": {
    color: "#ce9178 !important", // Ensure bytes color is applied
  },
}));

const DetailTableCell = styled(TableCell)(() => ({
  color: "#d4d4d4", // Default text color
  borderRight: "1px solid #2d2d30",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontSize: "11px",
  position: "relative",
  "& .filename": {
    color: "#569cd6", // Same blue as opcode for filename part
    fontWeight: "bold",
  },
  "& .offset": {
    color: "#d4d4d4", // Default color for offset part
  },
}));

const InstructionTableCell = styled(TableCell)(() => ({
  color: "#d4d4d4",
  paddingLeft: "8px !important",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}));

const BreakpointIndicator = styled(Box, {
  shouldForwardProp: (prop) => prop !== "active" && prop !== "isSoftware",
})<{ active?: boolean; isSoftware?: boolean }>(({ active, isSoftware }) => ({
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  backgroundColor: active
    ? isSoftware
      ? "#44bb44"
      : "#ff4444"
    : "transparent",
  border: "1px solid",
  borderColor: active
    ? isSoftware
      ? "#44bb44"
      : "#ff4444"
    : "rgba(255, 255, 255, 0.3)",
  transition: "all 0.15s ease",
  pointerEvents: "none",
  margin: "0 auto",
}));

const OpcodeText = styled(Box)(() => ({
  color: "#569cd6", // Keep original opcode color
  marginRight: "8px",
  fontWeight: "bold",
  minWidth: "40px",
  display: "inline-block",
}));

const OperandsText = styled(Box)(() => ({
  color: "#d4d4d4", // Keep original operands color
  marginRight: "12px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  display: "inline",
}));

const CommentText = styled(Box)(() => ({
  color: "#6a9955", // Keep original comment color
  fontSize: "11px",
  fontStyle: "italic",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  display: "inline",
  flexShrink: 0,
  maxWidth: "100%",
}));

const NavigationButtons = styled(Box)(() => ({
  position: "absolute",
  right: "8px",
  top: "50%",
  transform: "translateY(-50%)",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  zIndex: 1,
}));

const NavButton = styled(IconButton)(() => ({
  width: "24px",
  height: "24px",
  backgroundColor: "rgba(37, 37, 38, 0.9)",
  border: "1px solid #2d2d30",
  "&:hover": {
    backgroundColor: "rgba(45, 45, 48, 0.9)",
  },
  "& .MuiSvgIcon-root": {
    fontSize: "16px",
    color: "#cccccc",
  },
}));

const DisassemblyHeader = styled(Box)(() => ({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #2d2d30",
  minHeight: "40px",
  height: "40px",
  "@media (max-height: 800px)": {
    padding: "4px 8px",
    minHeight: "30px",
    height: "30px",
  },
}));

const DisassemblyTitle = styled(Typography)(() => ({
  fontSize: "12px",
  fontWeight: "bold",
  color: "#4fc1ff",
  display: "flex",
  alignItems: "center",
  "& .MuiSvgIcon-root": {
    fontSize: "16px",
    marginRight: "4px",
    "@media (max-height: 800px)": {
      fontSize: "12px",
      marginRight: "2px",
    },
  },
  "@media (max-height: 800px)": {
    fontSize: "10px",
  },
}));

const DisassemblyActions = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "4px",
}));

interface AssemblyViewProps {
  serverInfo?: ServerInfo;
  onBreakpointSet?: (address: string, isSoftware?: boolean) => void;
  onBreakpointRemove?: (address: string) => void;
  onBreakpointHit?: (address: string) => void;
  currentBreakAddress?: string | null; // Add break address for highlighting
  isInBreakState?: boolean; // Add break state for conditional highlighting
  activeBreakpoints?: string[]; // Add active breakpoints list from parent
  softwareBreakpoints?: Map<string, string>; // Map of address to original bytes for software BPs
  isSoftwareBreakpoint?: boolean; // Whether to set software breakpoints (from toolbar toggle)
  attachedModules?: ModuleInfo[]; // Add attached modules for detail info
  registerData?: Record<string, string>; // Register values for branch prediction
  // Decompile view related props
  isDecompileVisible?: boolean;
  onToggleDecompile?: () => void;
  hasDecompileResult?: boolean; // Whether there's a decompile result available to show
  // Ghidra integration props
  onDecompileRequest?: (
    libraryPath: string,
    address: string,
    functionName: string | null,
    decompiledCode: string,
    moduleBase: number,
    lineMapping: Record<number, string> | null,
    tokens?: GhidraTokenInfo[] | null
  ) => void;
  onDecompileError?: (error: string | null) => void; // Callback for decompile errors
  // Callback when assembly address is clicked (for syncing with DecompileView)
  onAssemblyAddressClicked?: (address: string) => void;
  // Address to highlight (without scrolling if visible, with scrolling if not)
  highlightAddress?: string | null;
  // Callback when highlight is complete
  onHighlightComplete?: () => void;
}

// Function to format operands as string
const formatOperands = (operands: any[]): string => {
  return operands
    .map((op) => {
      switch (op.type) {
        case "reg":
          return op.value;
        case "imm":
          return op.value;
        case "mem":
          if (op.base && op.disp) {
            return `[${op.base}+${op.disp}]`;
          } else if (op.base) {
            return `[${op.base}]`;
          }
          return op.value || "";
        default:
          return op.value || "";
      }
    })
    .join(", ");
};

// Function to detect jump instructions (b系とretのみ)
const isJumpInstruction = (opcode: string): boolean => {
  const jumpOpcodes = [
    // ARM64 branch instructions (b系とret)
    "b", // Unconditional branch
    "bl", // Branch with link
    "br", // Branch to register
    "blr", // Branch with link to register
    "ret", // Return
    "b.eq", // Branch if equal
    "b.ne", // Branch if not equal
    "b.cs", // Branch if carry set
    "b.cc", // Branch if carry clear
    "b.mi", // Branch if minus
    "b.pl", // Branch if plus
    "b.vs", // Branch if overflow
    "b.vc", // Branch if no overflow
    "b.hi", // Branch if higher
    "b.ls", // Branch if lower or same
    "b.ge", // Branch if greater or equal
    "b.lt", // Branch if less than
    "b.gt", // Branch if greater than
    "b.le", // Branch if less or equal
    "b.al", // Branch always (unconditional)
    // ARM64 compare and branch instructions
    "cbz", // Compare and Branch if Zero
    "cbnz", // Compare and Branch if Not Zero
    "tbz", // Test Bit and Branch if Zero
    "tbnz", // Test Bit and Branch if Not Zero
    // x86/x86_64 jump instructions
    "jmp", // Unconditional jump
    "je",
    "jz", // Jump if equal/zero
    "jne",
    "jnz", // Jump if not equal/not zero
    "jc",
    "jb",
    "jnae", // Jump if carry/below/not above or equal
    "jnc",
    "jae",
    "jnb", // Jump if not carry/above or equal/not below
    "js", // Jump if sign
    "jns", // Jump if not sign
    "jo", // Jump if overflow
    "jno", // Jump if not overflow
    "jp",
    "jpe", // Jump if parity/parity even
    "jnp",
    "jpo", // Jump if not parity/parity odd
    "ja",
    "jnbe", // Jump if above/not below or equal
    "jbe",
    "jna", // Jump if below or equal/not above
    "jg",
    "jnle", // Jump if greater/not less or equal
    "jge",
    "jnl", // Jump if greater or equal/not less
    "jl",
    "jnge", // Jump if less/not greater or equal
    "jle",
    "jng", // Jump if less or equal/not greater
    "call", // Call
    "ret",
    "retn", // Return
  ];
  return jumpOpcodes.includes(opcode.toLowerCase());
};

// Function to check if jump is conditional (includes ARM64 instructions)
const isConditionalJump = (opcode: string): boolean => {
  const conditionalOpcodes = [
    // x86/x86_64 conditional jumps
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
    "jpe",
    "jpo",
    "ja",
    "jae",
    "jb",
    "jbe",
    "jg",
    "jge",
    "jl",
    "jle",
    "loop",
    "loope",
    "loopne",
    "loopz",
    "loopnz",
    "jcxz",
    "jecxz",
    "jrcxz",
    // ARM64 conditional branches
    "b.eq", // Branch if equal
    "b.ne", // Branch if not equal
    "b.cs", // Branch if carry set
    "b.cc", // Branch if carry clear
    "b.mi", // Branch if minus
    "b.pl", // Branch if plus
    "b.vs", // Branch if overflow
    "b.vc", // Branch if no overflow
    "b.hi", // Branch if higher
    "b.ls", // Branch if lower or same
    "b.ge", // Branch if greater or equal
    "b.lt", // Branch if less than
    "b.gt", // Branch if greater than
    "b.le", // Branch if less or equal
    // ARM64 compare and branch instructions (conditional)
    "cbz", // Compare and Branch if Zero
    "cbnz", // Compare and Branch if Not Zero
    "tbz", // Test Bit and Branch if Zero
    "tbnz", // Test Bit and Branch if Not Zero
  ];
  return conditionalOpcodes.includes(opcode.toLowerCase());
};

// Function to extract jump target address from instruction operands
const extractJumpTargetAddress = (instruction: Instruction): string | null => {
  if (!isJumpInstruction(instruction.opcode)) return null;
  if (instruction.operands.length === 0) return null;

  const operandsStr = instruction.operands.map((op) => op.value).join(", ");
  // Extract address from operands (handle various formats)
  // Common patterns: "0x1234", "#0x1234", "0x1234 <symbol>"
  const addressMatch = operandsStr.match(/(0x[0-9a-fA-F]+)/i);
  if (addressMatch) {
    return addressMatch[1].toLowerCase();
  }

  return null;
};

// Function to calculate branch arrows for the current view
const calculateBranchArrows = (
  instructions: Instruction[]
): BranchArrowInfo[] => {
  const arrows: BranchArrowInfo[] = [];

  // Build address to index map for quick lookup
  const addressToIndex = new Map<string, number>();
  // Also build address to numeric value map for range comparison
  const addressValues: number[] = [];

  instructions.forEach((instruction, index) => {
    // Normalize address for comparison
    const normalizedAddr = instruction.address
      .toLowerCase()
      .replace(/^0x0*/, "0x");
    addressToIndex.set(normalizedAddr, index);
    // Also store without leading zeros
    const withoutLeadingZeros = instruction.address
      .toLowerCase()
      .replace(/^0x/, "");
    addressToIndex.set("0x" + withoutLeadingZeros, index);

    // Store numeric value
    const numericAddr = parseInt(instruction.address.replace(/^0x/i, ""), 16);
    addressValues.push(numericAddr);
  });

  // Get view range for out-of-bounds detection
  const viewMinAddr = addressValues.length > 0 ? Math.min(...addressValues) : 0;
  const viewMaxAddr = addressValues.length > 0 ? Math.max(...addressValues) : 0;

  // Find all branch instructions
  instructions.forEach((instruction, fromIndex) => {
    if (!isJumpInstruction(instruction.opcode)) return;
    // Skip ret instructions - they don't have a visible target
    if (
      instruction.opcode.toLowerCase() === "ret" ||
      instruction.opcode.toLowerCase() === "retn"
    )
      return;
    // Skip call instructions for cleaner display
    if (
      instruction.opcode.toLowerCase() === "call" ||
      instruction.opcode.toLowerCase() === "bl" ||
      instruction.opcode.toLowerCase() === "blr"
    )
      return;

    const targetAddress = extractJumpTargetAddress(instruction);
    if (!targetAddress) return;

    // Normalize target address
    const normalizedTarget = targetAddress.toLowerCase().replace(/^0x0*/, "0x");
    const targetNumeric = parseInt(targetAddress.replace(/^0x/i, ""), 16);

    // Check if target is in current view
    let toIndex = addressToIndex.get(normalizedTarget);
    if (toIndex === undefined) {
      // Try alternative normalization
      const altNormalized =
        "0x" + targetAddress.toLowerCase().replace(/^0x/, "");
      toIndex = addressToIndex.get(altNormalized);
    }

    if (toIndex !== undefined && toIndex !== fromIndex) {
      // Target is in view
      arrows.push({
        fromIndex,
        toIndex,
        fromAddress: instruction.address,
        toAddress: targetAddress,
        isConditional: isConditionalJump(instruction.opcode),
        isDownward: toIndex > fromIndex,
        depth: 0,
      });
    } else if (toIndex === undefined) {
      // Target is out of view - determine direction
      if (targetNumeric < viewMinAddr) {
        // Target is above current view - arrow goes up from fromIndex to top (index -1)
        arrows.push({
          fromIndex,
          toIndex: -1, // Special value for "above view"
          fromAddress: instruction.address,
          toAddress: targetAddress,
          isConditional: isConditionalJump(instruction.opcode),
          isDownward: false,
          depth: 0,
        });
      } else if (targetNumeric > viewMaxAddr) {
        // Target is below current view - arrow goes down from fromIndex to bottom
        arrows.push({
          fromIndex,
          toIndex: instructions.length, // Special value for "below view"
          fromAddress: instruction.address,
          toAddress: targetAddress,
          isConditional: isConditionalJump(instruction.opcode),
          isDownward: true,
          depth: 0,
        });
      }
    }
  });

  // Calculate depths to avoid overlapping arrows
  // Sort arrows by span size (smaller spans get higher priority/lower depth)
  arrows.sort((a, b) => {
    const spanA = Math.abs(a.toIndex - a.fromIndex);
    const spanB = Math.abs(b.toIndex - b.fromIndex);
    return spanA - spanB;
  });

  // Assign depths to avoid overlaps
  const usedDepths: Map<number, number[]>[] = []; // For each row, track which depths are in use

  // Initialize usedDepths for each row
  for (let i = 0; i < instructions.length; i++) {
    usedDepths.push(new Map());
  }

  arrows.forEach((arrow) => {
    // Handle out-of-bounds arrows
    const effectiveFromIndex = Math.max(0, arrow.fromIndex);
    const effectiveToIndex = Math.min(
      instructions.length - 1,
      Math.max(0, arrow.toIndex)
    );
    const minIndex = Math.min(effectiveFromIndex, effectiveToIndex);
    const maxIndex = Math.max(effectiveFromIndex, effectiveToIndex);

    // Find first available depth for this arrow's range
    let depth = 0;
    let depthFound = false;

    while (!depthFound && depth < 10) {
      let depthAvailable = true;
      for (let row = minIndex; row <= maxIndex; row++) {
        if (row >= 0 && row < usedDepths.length) {
          const rowDepths = usedDepths[row].get(depth);
          if (rowDepths !== undefined) {
            depthAvailable = false;
            break;
          }
        }
      }

      if (depthAvailable) {
        depthFound = true;
        arrow.depth = depth;
        // Mark this depth as used for all rows in range
        for (let row = minIndex; row <= maxIndex; row++) {
          if (row >= 0 && row < usedDepths.length) {
            usedDepths[row].set(depth, []);
          }
        }
      } else {
        depth++;
      }
    }
  });

  return arrows;
};

// Fixed width for arrow area (4 depth levels reserved)
const ARROW_AREA_WIDTH = 44; // 4 levels * 6px + 20px padding

// Arrow line info for a specific row
interface RowArrowInfo {
  depth: number;
  color: string;
  isStart: boolean; // This row is the start of the arrow
  isEnd: boolean; // This row is the end of the arrow
  isVertical: boolean; // This row has a vertical line passing through
  isDownward: boolean; // Arrow direction: true = downward, false = upward
  isOutOfBoundsStart: boolean; // Arrow starts from outside view (above)
  isOutOfBoundsEnd: boolean; // Arrow ends outside view (below)
}

// Function to calculate arrow info for each row
const calculateRowArrowInfo = (
  rowIndex: number,
  arrows: BranchArrowInfo[],
  totalRows: number
): RowArrowInfo[] => {
  const rowArrows: RowArrowInfo[] = [];

  arrows.forEach((arrow) => {
    // Handle out-of-bounds arrows
    // isOutOfBoundsAbove: target is above view (arrow goes upward and exits top)
    const isOutOfBoundsAbove = arrow.toIndex < 0;
    // isOutOfBoundsBelow: target is below view (arrow goes downward and exits bottom)
    const isOutOfBoundsBelow = arrow.toIndex >= totalRows;

    // Calculate the visible range of this arrow
    // For arrows going out of bounds, we extend to the edge of the view
    let visibleStartRow: number;
    let visibleEndRow: number;

    if (isOutOfBoundsAbove) {
      // Arrow goes from fromIndex upward to above the view (row 0 and beyond)
      visibleStartRow = 0;
      visibleEndRow = arrow.fromIndex;
    } else if (isOutOfBoundsBelow) {
      // Arrow goes from fromIndex downward to below the view (last row and beyond)
      visibleStartRow = arrow.fromIndex;
      visibleEndRow = totalRows - 1;
    } else {
      // Normal arrow within view
      visibleStartRow = Math.min(arrow.fromIndex, arrow.toIndex);
      visibleEndRow = Math.max(arrow.fromIndex, arrow.toIndex);
    }

    // Check if this row is involved in this arrow
    if (rowIndex >= visibleStartRow && rowIndex <= visibleEndRow) {
      // Predicted next instruction arrow gets special cyan color
      const color = arrow.isPredictedNext
        ? "#00d4ff" // Cyan for predicted next instruction
        : arrow.isConditional
          ? arrow.isDownward
            ? "#cc9900" // Yellow for conditional downward
            : "#ff6b6b" // Red for conditional upward (loop-like)
          : "#66cc66"; // Green for unconditional

      const isStart = rowIndex === arrow.fromIndex;
      const isEnd =
        !isOutOfBoundsAbove &&
        !isOutOfBoundsBelow &&
        rowIndex === arrow.toIndex;

      // Vertical line is needed for:
      // 1. Rows between start and end (exclusive)
      // 2. Boundary rows for out-of-bounds arrows (but not if it's also the start)
      const isMiddleRow =
        rowIndex > visibleStartRow && rowIndex < visibleEndRow;
      const isBoundaryRow =
        (isOutOfBoundsAbove && rowIndex === 0) ||
        (isOutOfBoundsBelow && rowIndex === totalRows - 1);

      rowArrows.push({
        depth: arrow.depth,
        color,
        isStart,
        isEnd,
        isVertical: isMiddleRow || (isBoundaryRow && !isStart),
        isDownward: arrow.isDownward,
        isOutOfBoundsStart: isOutOfBoundsAbove && rowIndex === 0,
        isOutOfBoundsEnd: isOutOfBoundsBelow && rowIndex === totalRows - 1,
      });
    }
  });

  return rowArrows;
};

interface DisasmLineComponentProps {
  instruction: Instruction;
  rowIndex: number;
  isFocused?: boolean;
  onFocus?: (address: string) => void;
  onBreakpointClick: (address: string, event: React.MouseEvent) => void;
  onAddressClick: (address: string, event: React.MouseEvent) => void;
  onDetailClick?: (address: string, event: React.MouseEvent) => void; // Function to handle detail column click
  onBytesClick?: (address: string, event: React.MouseEvent) => void; // Function to handle bytes column click (DecompileView sync only)
  onInstructionClick?: (address: string, event: React.MouseEvent) => void; // Function to handle instruction column click (DecompileView sync only)
  onCommentClick?: (address: string) => void; // Function to handle comment click (jump to branch target)
  onContextMenu?: (
    address: string,
    instruction: Instruction,
    event: React.MouseEvent
  ) => void;
  currentBreakAddress?: string | null;
  isInBreakState?: boolean;
  softwareBreakpointOriginalBytes?: string; // Original bytes for software breakpoint (if any)
  getModuleDetail?: (address: string) => React.ReactNode; // Function to get module detail for address
  getModuleDetailText?: (address: string) => string; // Function to get module detail text for tooltip
  getFormattedComment?: (instruction: Instruction) => string; // Function to get formatted comment based on address display format
  getBranchTargetAddress?: (instruction: Instruction) => string | null; // Function to extract branch target address from instruction
  columnWidths?: Record<string, number>; // Add column widths prop
  rowArrowInfo: RowArrowInfo[]; // Arrow info for this row
}

const DisasmLineComponent: React.FC<DisasmLineComponentProps> = React.memo(
  ({
    instruction,
    rowIndex: _rowIndex,
    onAddressClick,
    onDetailClick,
    onBytesClick,
    onInstructionClick,
    onBreakpointClick,
    onCommentClick,
    onContextMenu,
    currentBreakAddress,
    isFocused = false,
    onFocus,
    isInBreakState = false,
    softwareBreakpointOriginalBytes,
    getModuleDetail,
    getModuleDetailText,
    getFormattedComment,
    getBranchTargetAddress,
    rowArrowInfo,
    columnWidths = {},
  }) => {
    const isJump = useMemo(
      () => isJumpInstruction(instruction.opcode),
      [instruction.opcode]
    );
    const isConditional = useMemo(
      () => isConditionalJump(instruction.opcode),
      [instruction.opcode]
    );

    // Helper function to normalize addresses for comparison
    const normalizeAddress = useCallback((addr: string) => {
      if (!addr) return "";
      const cleaned =
        addr.replace(/^0x/i, "").toLowerCase().replace(/^0+/, "") || "0";
      return `0x${cleaned}`;
    }, []);

    // Check if this instruction is at the current breakpoint address
    const isCurrentBreakpoint = useMemo(
      () =>
        isInBreakState &&
        currentBreakAddress &&
        normalizeAddress(instruction.address) ===
          normalizeAddress(currentBreakAddress),
      [
        isInBreakState,
        currentBreakAddress,
        instruction.address,
        normalizeAddress,
      ]
    );

    const formattedOperands = useMemo(
      () => formatOperands(instruction.operands),
      [instruction.operands]
    );

    // Determine row background color and border
    const getRowStyle = () => {
      // If focused (from DecompileView click), use hover-like background
      if (isFocused) {
        const hoverBg = instruction.active
          ? alpha("#4fc1ff", 0.15)
          : instruction.isFunction
            ? alpha("#89d185", 0.2)
            : instruction.isFunctionStart
              ? alpha("#ffa500", 0.15)
              : instruction.isFunctionEnd
                ? alpha("#ff6b6b", 0.15)
                : alpha("#3c3c3c", 0.8);
        return {
          backgroundColor: hoverBg,
          borderLeft: "3px solid #569cd6",
        };
      }
      if (isCurrentBreakpoint) {
        return {
          backgroundColor: "rgba(76, 175, 80, 0.2)",
          borderLeft: "3px solid #4CAF50",
        };
      }
      if (instruction.active) {
        return {
          backgroundColor: alpha("#4fc1ff", 0.1),
          borderLeft: "3px solid #4fc1ff",
        };
      }
      if (instruction.isFunction) {
        return {
          backgroundColor: alpha("#89d185", 0.15),
          borderLeft: "3px solid #89d185",
        };
      }
      if (instruction.isFunctionStart) {
        return {
          backgroundColor: alpha("#ffa500", 0.1),
          borderLeft: "3px solid #ffa500",
        };
      }
      if (instruction.isFunctionEnd) {
        return {
          backgroundColor: alpha("#ff6b6b", 0.1),
          borderLeft: "3px solid #ff6b6b",
        };
      }
      return {
        backgroundColor: "transparent",
        borderLeft: "3px solid transparent",
      };
    };

    return (
      <TableRow
        data-address={instruction.address}
        sx={{
          ...getRowStyle(),
          "&:hover": {
            backgroundColor: instruction.active
              ? alpha("#4fc1ff", 0.15)
              : instruction.isFunction
                ? alpha("#89d185", 0.2)
                : instruction.isFunctionStart
                  ? alpha("#ffa500", 0.15)
                  : instruction.isFunctionEnd
                    ? alpha("#ff6b6b", 0.15)
                    : alpha("#3c3c3c", 0.8),
          },
          cursor: "pointer",
          transition: "background-color 0.15s ease, border-color 0.15s ease",
        }}
        onMouseEnter={() => {
          if (onFocus) {
            onFocus(instruction.address);
          }
        }}
        onContextMenu={(e) => {
          if (onContextMenu) {
            e.preventDefault();
            onContextMenu(instruction.address, instruction, e);
          }
        }}
      >
        {/* Arrow Column - renders branch arrow lines */}
        <TableCell
          sx={{
            width: `${ARROW_AREA_WIDTH}px`,
            minWidth: `${ARROW_AREA_WIDTH}px`,
            maxWidth: `${ARROW_AREA_WIDTH}px`,
            padding: "0 !important",
            position: "relative",
            borderRight: "1px solid #2d2d30",
            borderBottom: "none !important",
            backgroundColor: "transparent",
          }}
        >
          <svg
            width={ARROW_AREA_WIDTH}
            height="100%"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              pointerEvents: "none",
            }}
          >
            {rowArrowInfo.map((arrowInfo, idx) => {
              const x = ARROW_AREA_WIDTH - 12 - arrowInfo.depth * 6;
              const startX = ARROW_AREA_WIDTH - 4;
              const midY = 10; // Half of row height (20px / 2)

              // Calculate vertical line y coordinates based on arrow direction
              // For start: line goes from midY toward the target direction
              // For end: line comes from the source direction to midY
              // For middle/vertical: line goes full height (0 to 20)
              let y1 = 0;
              let y2 = 20;

              if (arrowInfo.isStart && !arrowInfo.isEnd) {
                // Start point: line goes from midY in the direction of the target
                y1 = midY;
                y2 = arrowInfo.isDownward ? 20 : 0; // Down: toward bottom, Up: toward top
              } else if (arrowInfo.isEnd && !arrowInfo.isStart) {
                // End point: line comes from the source direction to midY
                y1 = arrowInfo.isDownward ? 0 : 20; // Down: from top, Up: from bottom
                y2 = midY;
              } else if (arrowInfo.isStart && arrowInfo.isEnd) {
                // Same row (shouldn't happen for branch arrows, but handle it)
                y1 = midY;
                y2 = midY;
              }
              // else: vertical/middle row, use full height (0 to 20)

              return (
                <g key={`arrow-line-${idx}`}>
                  {/* Vertical line through the cell */}
                  {(arrowInfo.isVertical ||
                    arrowInfo.isStart ||
                    arrowInfo.isEnd) && (
                    <line
                      x1={x}
                      y1={y1}
                      x2={x}
                      y2={y2}
                      stroke={arrowInfo.color}
                      strokeWidth="1.5"
                      strokeOpacity="0.8"
                    />
                  )}
                  {/* Horizontal line from start point */}
                  {arrowInfo.isStart && (
                    <>
                      <line
                        x1={startX}
                        y1={midY}
                        x2={x}
                        y2={midY}
                        stroke={arrowInfo.color}
                        strokeWidth="1.5"
                        strokeOpacity="0.8"
                      />
                      {/* Source dot */}
                      <circle
                        cx={startX}
                        cy={midY}
                        r="2"
                        fill={arrowInfo.color}
                        fillOpacity="0.8"
                      />
                    </>
                  )}
                  {/* Horizontal line to end point with arrowhead */}
                  {arrowInfo.isEnd && (
                    <>
                      <line
                        x1={x}
                        y1={midY}
                        x2={startX - 5}
                        y2={midY}
                        stroke={arrowInfo.color}
                        strokeWidth="1.5"
                        strokeOpacity="0.8"
                      />
                      {/* Arrowhead */}
                      <polygon
                        points={`${startX},${midY} ${startX - 5},${midY - 3} ${startX - 5},${midY + 3}`}
                        fill={arrowInfo.color}
                        fillOpacity="0.8"
                      />
                    </>
                  )}
                  {/* Out of bounds indicator at top (arrow coming from above) */}
                  {arrowInfo.isOutOfBoundsStart && (
                    <>
                      {/* Vertical line extending to top of cell */}
                      <line
                        x1={x}
                        y1={0}
                        x2={x}
                        y2={20}
                        stroke={arrowInfo.color}
                        strokeWidth="1.5"
                        strokeOpacity="0.8"
                      />
                      {/* Triangle pointing up at top */}
                      <polygon
                        points={`${x},0 ${x - 3},6 ${x + 3},6`}
                        fill={arrowInfo.color}
                        fillOpacity="0.8"
                      />
                    </>
                  )}
                  {/* Out of bounds indicator at bottom (arrow going below) */}
                  {arrowInfo.isOutOfBoundsEnd && (
                    <>
                      {/* Vertical line extending to bottom of cell */}
                      <line
                        x1={x}
                        y1={0}
                        x2={x}
                        y2={20}
                        stroke={arrowInfo.color}
                        strokeWidth="1.5"
                        strokeOpacity="0.8"
                      />
                      {/* Triangle pointing down at bottom */}
                      <polygon
                        points={`${x},20 ${x - 3},14 ${x + 3},14`}
                        fill={arrowInfo.color}
                        fillOpacity="0.8"
                      />
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        </TableCell>

        {/* Breakpoint Column */}
        <BreakpointTableCell
          sx={{
            width: columnWidths.breakpoint
              ? `${columnWidths.breakpoint}px`
              : undefined,
            minWidth: columnWidths.breakpoint
              ? `${columnWidths.breakpoint}px`
              : undefined,
            maxWidth: columnWidths.breakpoint
              ? `${columnWidths.breakpoint}px`
              : undefined,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onBreakpointClick(instruction.address, e);
          }}
        >
          {isFocused ? (
            <BreakpointIndicator
              active={instruction.breakpoint}
              isSoftware={instruction.isSoftwareBreakpoint}
            />
          ) : instruction.breakpoint ? (
            <Box
              sx={{
                color: instruction.isSoftwareBreakpoint ? "#44bb44" : "#ff4444",
                fontSize: "12px",
              }}
            >
              ●
            </Box>
          ) : null}
        </BreakpointTableCell>

        {/* Address Column */}
        <AddressTableCell
          sx={{
            width: columnWidths.address
              ? `${columnWidths.address}px`
              : undefined,
            minWidth: columnWidths.address
              ? `${columnWidths.address}px`
              : undefined,
            maxWidth: columnWidths.address
              ? `${columnWidths.address}px`
              : undefined,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onAddressClick(instruction.address, e);
          }}
        >
          {instruction.address}
        </AddressTableCell>

        {/* Detail Column */}
        <DetailTableCell
          sx={{
            width: columnWidths.detail ? `${columnWidths.detail}px` : undefined,
            minWidth: columnWidths.detail
              ? `${columnWidths.detail}px`
              : undefined,
            maxWidth: columnWidths.detail
              ? `${columnWidths.detail}px`
              : undefined,
            cursor: onDetailClick ? "pointer" : "default",
          }}
          title={
            getModuleDetailText ? getModuleDetailText(instruction.address) : ""
          }
          onClick={(e) => {
            if (onDetailClick) {
              e.stopPropagation();
              onDetailClick(instruction.address, e);
            }
          }}
        >
          {getModuleDetail ? getModuleDetail(instruction.address) : ""}
        </DetailTableCell>

        {/* Bytes Column */}
        <BytesTableCell
          sx={{
            width: columnWidths.bytes ? `${columnWidths.bytes}px` : undefined,
            minWidth: columnWidths.bytes
              ? `${columnWidths.bytes}px`
              : undefined,
            maxWidth: columnWidths.bytes
              ? `${columnWidths.bytes}px`
              : undefined,
            cursor: onBytesClick ? "pointer" : "default",
          }}
          title={
            softwareBreakpointOriginalBytes
              ? `Original: ${softwareBreakpointOriginalBytes} (SW BP active)`
              : instruction.bytes
          }
          onClick={(e) => {
            if (onBytesClick) {
              e.stopPropagation();
              onBytesClick(instruction.address, e);
            }
          }}
        >
          <span
            style={{
              color: softwareBreakpointOriginalBytes ? "#ffa726" : "#ce9178",
              fontStyle: softwareBreakpointOriginalBytes ? "italic" : "normal",
            }}
          >
            {softwareBreakpointOriginalBytes || instruction.bytes || "-- -- --"}
          </span>
        </BytesTableCell>

        {/* Instruction Column */}
        <InstructionTableCell
          sx={{
            cursor: onInstructionClick ? "pointer" : "default",
          }}
          onClick={(e) => {
            if (onInstructionClick) {
              e.stopPropagation();
              onInstructionClick(instruction.address, e);
            }
          }}
        >
          <OpcodeText
            sx={{
              color:
                instruction.opcode === "???" ||
                instruction.opcode === "unknown" ||
                instruction.opcode === "error"
                  ? "#808080" // Gray for invalid/unknown instructions
                  : isJump
                    ? isConditional
                      ? "#cc9900"
                      : "#66cc66"
                    : instruction.isFunctionStart
                      ? "#ffa500"
                      : instruction.isFunctionEnd
                        ? "#ff6b6b"
                        : "#569cd6",
            }}
          >
            {instruction.opcode}
          </OpcodeText>
          <OperandsText>{formattedOperands}</OperandsText>
          {(() => {
            // getFormattedCommentがあればそれを使い、なければinstruction.commentを使う
            const displayComment = getFormattedComment
              ? getFormattedComment(instruction)
              : instruction.comment;
            // ブランチターゲットアドレスを取得（クリック可能かどうかの判定用）
            const branchTargetAddress = getBranchTargetAddress
              ? getBranchTargetAddress(instruction)
              : null;
            const isClickable = branchTargetAddress && onCommentClick;
            return displayComment ? (
              <CommentText
                sx={{
                  color:
                    instruction.isFunctionStart || instruction.isFunctionEnd
                      ? "#ffa500"
                      : "#6a9955",
                  cursor: isClickable ? "pointer" : "inherit",
                  "&:hover": isClickable
                    ? {
                        textDecoration: "underline",
                        color: "#89d185",
                      }
                    : {},
                }}
                onClick={
                  isClickable
                    ? (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onCommentClick(branchTargetAddress);
                      }
                    : undefined
                }
              >
                ; {displayComment}
              </CommentText>
            ) : null;
          })()}
        </InstructionTableCell>
      </TableRow>
    );
  }
);

// VS Code-style C syntax highlighting
const highlightCCode = (code: string): React.ReactNode[] => {
  const tokens: React.ReactNode[] = [];
  let remaining = code;
  let key = 0;

  // Color definitions (VS Code Dark+ theme)
  const colors = {
    keyword: "#569cd6", // blue - control keywords
    type: "#4ec9b0", // teal - types
    function: "#dcdcaa", // yellow - function calls
    string: "#ce9178", // orange - strings
    number: "#b5cea8", // light green - numbers
    comment: "#6a9955", // green - comments
    preprocessor: "#c586c0", // purple - preprocessor
    operator: "#d4d4d4", // white - operators
    default: "#d4d4d4", // white - default
  };

  const keywords = [
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "return",
    "goto",
    "sizeof",
    "NULL",
    "nullptr",
  ];

  const types = [
    "void",
    "int",
    "char",
    "short",
    "long",
    "float",
    "double",
    "unsigned",
    "signed",
    "const",
    "static",
    "extern",
    "volatile",
    "struct",
    "typedef",
    "enum",
    "union",
    "auto",
    "register",
    "inline",
    "size_t",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "int8_t",
    "int16_t",
    "int32_t",
    "int64_t",
    "bool",
    "true",
    "false",
  ];

  const addToken = (text: string, color: string) => {
    tokens.push(
      <span key={key++} style={{ color }}>
        {text}
      </span>
    );
  };

  while (remaining.length > 0) {
    let matched = false;

    // Single-line comment
    if (remaining.startsWith("//")) {
      const endIdx = remaining.indexOf("\n");
      const comment = endIdx >= 0 ? remaining.slice(0, endIdx) : remaining;
      addToken(comment, colors.comment);
      remaining = endIdx >= 0 ? remaining.slice(endIdx) : "";
      matched = true;
    }
    // Multi-line comment
    else if (remaining.startsWith("/*")) {
      const endIdx = remaining.indexOf("*/");
      const comment = endIdx >= 0 ? remaining.slice(0, endIdx + 2) : remaining;
      addToken(comment, colors.comment);
      remaining = endIdx >= 0 ? remaining.slice(endIdx + 2) : "";
      matched = true;
    }
    // Preprocessor directive
    else if (remaining.match(/^#\w*/)) {
      const match = remaining.match(/^#\w*/);
      if (match) {
        addToken(match[0], colors.preprocessor);
        remaining = remaining.slice(match[0].length);
        matched = true;
      }
    }
    // String literal
    else if (remaining.startsWith('"')) {
      let endIdx = 1;
      while (endIdx < remaining.length) {
        if (remaining[endIdx] === "\\") {
          endIdx += 2;
        } else if (remaining[endIdx] === '"') {
          endIdx++;
          break;
        } else {
          endIdx++;
        }
      }
      addToken(remaining.slice(0, endIdx), colors.string);
      remaining = remaining.slice(endIdx);
      matched = true;
    }
    // Character literal
    else if (remaining.startsWith("'")) {
      let endIdx = 1;
      while (endIdx < remaining.length) {
        if (remaining[endIdx] === "\\") {
          endIdx += 2;
        } else if (remaining[endIdx] === "'") {
          endIdx++;
          break;
        } else {
          endIdx++;
        }
      }
      addToken(remaining.slice(0, endIdx), colors.string);
      remaining = remaining.slice(endIdx);
      matched = true;
    }
    // Number (hex, float, int)
    else if (remaining.match(/^0x[0-9a-fA-F]+/)) {
      const match = remaining.match(/^0x[0-9a-fA-F]+/);
      if (match) {
        addToken(match[0], colors.number);
        remaining = remaining.slice(match[0].length);
        matched = true;
      }
    } else if (remaining.match(/^\d+\.?\d*[fF]?/)) {
      const match = remaining.match(/^\d+\.?\d*[fF]?/);
      if (match) {
        addToken(match[0], colors.number);
        remaining = remaining.slice(match[0].length);
        matched = true;
      }
    }
    // Identifier (keyword, type, or function)
    else if (remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
      const match = remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      if (match) {
        const word = match[0];
        const afterWord = remaining.slice(word.length);
        // Check if it's a function call (followed by parenthesis)
        const isFunctionCall = afterWord.match(/^\s*\(/);

        if (keywords.includes(word)) {
          addToken(word, colors.keyword);
        } else if (types.includes(word)) {
          addToken(word, colors.type);
        } else if (isFunctionCall) {
          addToken(word, colors.function);
        } else {
          addToken(word, colors.default);
        }
        remaining = afterWord;
        matched = true;
      }
    }

    // If nothing matched, add single character
    if (!matched) {
      addToken(remaining[0], colors.default);
      remaining = remaining.slice(1);
    }
  }

  return tokens;
};

export const AssemblyView: React.FC<AssemblyViewProps> = ({
  serverInfo,
  onBreakpointSet,
  onBreakpointRemove,
  onBreakpointHit,
  currentBreakAddress,
  isInBreakState = false,
  activeBreakpoints = [], // Add activeBreakpoints prop with default empty array
  softwareBreakpoints = new Map(), // Map of address to original bytes for software BPs
  isSoftwareBreakpoint = false, // Whether to set software breakpoints
  attachedModules = [], // Add attachedModules prop with default empty array
  registerData = {}, // Register data for branch prediction
  isDecompileVisible = true,
  onToggleDecompile: _onToggleDecompile,
  hasDecompileResult: _hasDecompileResult = false,
  onDecompileRequest,
  onDecompileError,
  onAssemblyAddressClicked,
  highlightAddress,
  onHighlightComplete,
}) => {
  const { addLog } = useGlobalDebugLogger();

  // グローバルストアからassemblyAddressを取得
  const assemblyAddress = useUIStore(
    (state) => state.debuggerState.assemblyAddress
  );
  // ナビゲーショントリガーも取得（同じアドレスへの連続goto用）
  const assemblyNavigationTrigger = useUIStore(
    (state) => state.debuggerState.assemblyNavigationTrigger
  );
  // グローバルストアへの更新関数を取得
  const setAssemblyAddress = useUIStore(
    (state) => state.actions.setAssemblyAddress
  );
  // Navigate with history tracking for Back button
  const setAssemblyAddressWithHistory = useUIStore(
    (state) => state.actions.setAssemblyAddressWithHistory
  );

  // Table column resize hook
  const columnResize = useTableColumnResize({
    storageKey: "assembly-view-column-widths",
    defaultWidths: {
      breakpoint: 24,
      address: 120,
      detail: 200,
      bytes: 120,
    },
    minWidth: 30,
    maxWidth: 500,
  });

  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentBaseAddress, setCurrentBaseAddress] = useState<number>(0); // Always points to the first instruction in buffer
  const [bufferSize] = useState<number>(1024); // Reduced buffer size for faster loading
  const [instructionBuffer, setInstructionBuffer] = useState<Instruction[]>([]);
  const [viewportStart, setViewportStart] = useState<number>(0);
  const [viewportSize] = useState<number>(40); // Instructions to display in viewport

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    address: string;
    instruction: Instruction;
  } | null>(null);

  // Trace count dialog state
  const [traceCountDialogOpen, setTraceCountDialogOpen] = useState(false);
  const [traceCountInput, setTraceCountInput] = useState("100");
  const [traceEndAddressInput, setTraceEndAddressInput] = useState(""); // Optional end address
  const [pendingTraceAddress, setPendingTraceAddress] = useState<string>("");
  const [traceToFile, setTraceToFile] = useState(false); // Trace to file option
  // Full memory cache option (currently disabled in UI)
  const fullMemoryCache = false;

  // File trace progress state
  const [fileTraceProgress, setFileTraceProgress] = useState<{
    isActive: boolean;
    current: number;
    total: number;
    filePath: string;
  } | null>(null);

  // File trace download dialog state
  const [fileTraceCompleteDialog, setFileTraceCompleteDialog] = useState<{
    open: boolean;
    entryCount: number;
    filePath: string;
    downloaded: boolean;
  }>({ open: false, entryCount: 0, filePath: "", downloaded: false });

  // Graph View address range dialog state
  const [graphViewDialogOpen, setGraphViewDialogOpen] = useState(false);
  const [graphViewStartAddress, setGraphViewStartAddress] =
    useState<string>("");
  const [graphViewEndAddress, setGraphViewEndAddress] = useState<string>("");
  const [pendingGraphViewAddress, setPendingGraphViewAddress] =
    useState<string>("");
  const [pendingGraphViewFunctionName, setPendingGraphViewFunctionName] =
    useState<string | undefined>(undefined);

  // Ghidra integration state
  const GHIDRA_PATH_KEY = "dynadbg_ghidra_path";
  const [ghidraSettingsDialogOpen, setGhidraSettingsDialogOpen] =
    useState(false);
  const [ghidraPathInput, setGhidraPathInput] = useState<string>("");
  const [pendingGhidraAction, setPendingGhidraAction] = useState<
    "analyze" | "decompile" | null
  >(null);
  const [pendingGhidraLibraryInfo, setPendingGhidraLibraryInfo] = useState<{
    path: string;
    offset: number;
    functionStartOffset: number | null;
    functionName: string | null;
    moduleBase: number;
  } | null>(null);
  const [pendingGhidraAddress, setPendingGhidraAddress] = useState<
    string | null
  >(null);
  const {
    isAnalyzing,
    isDecompiling,
    analysisProgress,
    isLibraryAnalyzed,
    analyzeLibrary,
    decompileFunction,
    getXrefs,
    getDecompileFromCache,
    getXrefFromCache,
    saveDecompileToCache,
    saveXrefToCache,
    serverRunning,
    serverProjectPath,
    getAnalyzedLibraryInfo,
  } = useGhidraAnalysis();

  // Xref dialog state
  const [xrefDialogOpen, setXrefDialogOpen] = useState(false);
  const [xrefLoading, setXrefLoading] = useState(false);
  const [xrefData, setXrefData] = useState<{
    targetFunction: string;
    targetAddress: string;
    moduleBase: number; // Module base address for converting offset to real address
    moduleName: string; // Module name for display
    xrefs: Array<{
      from_address: string;
      from_function: string | null;
      from_function_offset?: string | null;
      ref_type: string;
      instruction?: string | null;
    }>;
  } | null>(null);

  // Debugger settings dialog state (from global store)
  const debuggerSettingsOpen = useUIStore(
    (state) => state.debuggerState.debuggerSettingsOpen
  );
  const setDebuggerSettingsOpen = useUIStore(
    (state) => state.actions.setDebuggerSettingsOpen
  );
  // Signal configs: map from signal number to {catch_signal, pass_signal}
  // Persisted to localStorage as array of [signal, config] tuples
  const [signalConfigsArray, setSignalConfigsArray] = useLocalStorage<
    Array<[number, { catch_signal: boolean; pass_signal: boolean }]>
  >("debugger-signal-configs", []);

  // Convert array to Map for easy lookup
  const signalConfigs = useMemo(
    () => new Map(signalConfigsArray),
    [signalConfigsArray]
  );

  // Helper to update signal configs (converts Map to array for storage)
  const setSignalConfigs = useCallback(
    (
      updater:
        | Map<number, { catch_signal: boolean; pass_signal: boolean }>
        | ((
            prev: Map<number, { catch_signal: boolean; pass_signal: boolean }>
          ) => Map<number, { catch_signal: boolean; pass_signal: boolean }>)
    ) => {
      if (typeof updater === "function") {
        setSignalConfigsArray((prevArray) => {
          const prevMap = new Map(prevArray);
          const newMap = updater(prevMap);
          return Array.from(newMap.entries());
        });
      } else {
        setSignalConfigsArray(Array.from(updater.entries()));
      }
    },
    [setSignalConfigsArray]
  );

  const [loadingSignals, setLoadingSignals] = useState(false);
  const [signalSortField, setSignalSortField] = useState<"signal" | "name">(
    "signal"
  );
  const [signalSortOrder, setSignalSortOrder] = useState<"asc" | "desc">("asc");

  // Signal definitions for UI (default: not monitored = signals passed to process)
  const signalDefinitions = useMemo(() => {
    const defs = [
      { signal: 4, name: "SIGILL", description: "Illegal instruction" },
      { signal: 6, name: "SIGABRT", description: "Process abort signal" },
      {
        signal: 7,
        name: "SIGBUS",
        description: "Bus error (bad memory access)",
      },
      { signal: 8, name: "SIGFPE", description: "Floating-point exception" },
      { signal: 11, name: "SIGSEGV", description: "Segmentation fault" },
    ];
    return [...defs].sort((a, b) => {
      const aVal = a[signalSortField];
      const bVal = b[signalSortField];
      if (typeof aVal === "number" && typeof bVal === "number") {
        return signalSortOrder === "asc" ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal);
      const bStr = String(bVal);
      return signalSortOrder === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [signalSortField, signalSortOrder]);

  const handleSignalSortChange = useCallback(
    (field: "signal" | "name") => {
      if (signalSortField === field) {
        setSignalSortOrder((order) => (order === "asc" ? "desc" : "asc"));
      } else {
        setSignalSortField(field);
        setSignalSortOrder("asc");
      }
    },
    [signalSortField]
  );

  // Processing snackbar state for long-running Ghidra operations
  const [processingSnackbar, setProcessingSnackbar] = useState<{
    open: boolean;
    message: string;
  }>({ open: false, message: "" });

  // Convert activeBreakpoints array to Set for faster lookups
  const breakpoints = useMemo(
    () => new Set(activeBreakpoints),
    [activeBreakpoints]
  );

  /* Check if the current view's module is analyzed (for showing Decompile icon) - currently unused
  const isCurrentLibraryAnalyzed = useMemo(() => {
    if (!instructionBuffer.length || !attachedModules.length) return false;

    // Get the first instruction's address to determine the module
    const firstInstruction = instructionBuffer[0];
    if (!firstInstruction) return false;

    const address = firstInstruction.address;
    let numericAddress: number;
    if (address.startsWith("0x") || address.startsWith("0X")) {
      numericAddress = parseInt(address, 16);
    } else {
      numericAddress = parseInt(address, 10);
    }

    if (isNaN(numericAddress)) return false;

    // Find the module for this address
    for (const module of attachedModules) {
      const moduleBase = module.base;
      const moduleEnd = moduleBase + module.size;

      if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
        const modulePath = module.modulename || module.name || "";
        return isLibraryAnalyzed(modulePath);
      }
    }

    return false;
  }, [instructionBuffer, attachedModules, isLibraryAnalyzed]);
  */

  // アドレス表示形式の取得（library / function）
  const addressDisplayFormat = useUIStore(
    (state) => state.debuggerState.addressDisplayFormat
  );
  const toggleAddressDisplayFormat = useUIStore(
    (state) => state.actions.toggleAddressDisplayFormat
  );

  // Assembly Demangle設定の取得
  const assemblyDemangleEnabled = useUIStore(
    (state) => state.debuggerState.assemblyDemangleEnabled
  );
  const toggleAssemblyDemangle = useUIStore(
    (state) => state.actions.toggleAssemblyDemangle
  );

  // Source Code Level Debug設定の取得
  const sourceCodeLevelDebug = useUIStore(
    (state) => state.debuggerState.sourceCodeLevelDebug
  );
  const toggleSourceCodeLevelDebug = useUIStore(
    (state) => state.actions.toggleSourceCodeLevelDebug
  );

  // DWARF解析結果を取得（ソースコード表示用）
  const dwarfAnalysisResult = useUIStore(
    (state) => state.toolsState.debugState?.analysisResult
  );

  // ソースブレークポイント一覧を取得
  const sourceBreakpoints = useUIStore(
    (state) =>
      state.toolsState.debugState?.sourceBreakpoints ?? EMPTY_SOURCE_BREAKPOINTS
  );

  // 現在停止中のアドレス
  const currentHitAddress = useUIStore(
    (state) => state.toolsState.debugState?.currentHitAddress
  );

  const selectedModuleBase = useUIStore(
    (state) => state.toolsState.debugState?.selectedModuleBase
  );

  const addSourceBreakpoint = useUIStore(
    (state) => state.actions.addSourceBreakpoint
  );
  const removeSourceBreakpoint = useUIStore(
    (state) => state.actions.removeSourceBreakpoint
  );

  const sourceRootPath = useUIStore(
    (state) => state.toolsState.debugState?.sourceRootPath || ""
  );

  // NDKパスを取得（Android NDK用）
  const ndkPath = useUIStore(
    (state) => state.toolsState.debugState?.ndkPath || ""
  );

  // OUTLINEからのソースジャンプリクエストを取得
  const pendingSourceJump = useUIStore(
    (state) => state.toolsState.debugState?.pendingSourceJump
  );
  const setPendingSourceJump = useUIStore(
    (state) => state.actions.setPendingSourceJump
  );

  // ソースコードキャッシュ（ファイルパス -> ソースコード行配列）
  const [sourceCodeCache, setSourceCodeCache] = useState<
    Map<string, { lines: string[]; loading: boolean; error: string | null }>
  >(new Map());

  // 選択中のソースファイルタブ（VS Codeライクなタブ管理）
  const [activeSourceTab, setActiveSourceTab] = useState<string | null>(null);
  const [openSourceTabs, setOpenSourceTabs] = useState<string[]>([]);

  // ソースファイルを読み込む（ホストOSのローカルファイルから）
  const loadSourceFile = useCallback(
    async (filePath: string, _directory: string | null) => {
      // sourceRootPathが設定されていない場合はスキップ
      if (!sourceRootPath) {
        setSourceCodeCache((prev) => {
          const next = new Map(prev);
          next.set(filePath, {
            lines: [],
            loading: false,
            error:
              "Source root path not set. Configure it in Tools → DWARF tab.",
          });
          return next;
        });
        return;
      }

      // 既にキャッシュにある場合はスキップ
      if (sourceCodeCache.has(filePath)) return;

      // ローディング状態を設定
      setSourceCodeCache((prev) => {
        const next = new Map(prev);
        next.set(filePath, { lines: [], loading: true, error: null });
        return next;
      });

      // ファイルパスの候補を構築
      const pathCandidates: string[] = [];

      // 1. ソースルートパスからの相対パス
      pathCandidates.push(`${sourceRootPath}/${filePath}`);

      // 2. NDKシステムヘッダーへのフォールバック（Android用）
      if (ndkPath) {
        // NDKヘッダーのパス例:
        // NDK/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/include/...
        // NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/...
        const sysrootPaths = [
          `${ndkPath}/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/include`,
          `${ndkPath}/toolchains/llvm/prebuilt/darwin-arm64/sysroot/usr/include`,
          `${ndkPath}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include`,
          `${ndkPath}/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include`,
        ];

        // ファイルパスからヘッダー部分を抽出
        // 例: /path/to/ndk/.../sysroot/usr/include/bits/fortify/string.h
        //     -> bits/fortify/string.h
        const headerMatch = filePath.match(
          /(?:sysroot\/usr\/include\/|usr\/include\/)(.+)$/
        );
        if (headerMatch) {
          const headerPath = headerMatch[1];
          for (const sysroot of sysrootPaths) {
            pathCandidates.push(`${sysroot}/${headerPath}`);
          }
        }

        // システムヘッダーパターン（例: <string.h>, <stdio.h>）
        // DWARFのパスがNDKのsysroot内を指している場合
        if (
          filePath.includes("/sysroot/") ||
          filePath.includes("/include/") ||
          filePath.includes("\\sysroot\\") ||
          filePath.includes("\\include\\")
        ) {
          const parts = filePath.split(/[\/\\]/);
          const includeIdx = parts.lastIndexOf("include");
          if (includeIdx >= 0 && includeIdx < parts.length - 1) {
            const headerRelPath = parts.slice(includeIdx + 1).join("/");
            for (const sysroot of sysrootPaths) {
              pathCandidates.push(`${sysroot}/${headerRelPath}`);
            }
          }
        }
      }

      // 3. 絶対パスの場合はそのまま試す
      if (filePath.startsWith("/")) {
        pathCandidates.push(filePath);
      }

      // 候補を順に試す
      let lastError: string | null = null;
      for (const candidatePath of pathCandidates) {
        try {
          const content = await invoke<string>("read_local_text_file", {
            filePath: candidatePath,
          });

          const lines = content.split("\n");

          setSourceCodeCache((prev) => {
            const next = new Map(prev);
            next.set(filePath, { lines, loading: false, error: null });
            return next;
          });
          return; // 成功したら終了
        } catch (e) {
          lastError = `${e}`;
          // 次の候補を試す
        }
      }

      // 全ての候補が失敗
      console.error(`Failed to load source file: ${filePath}`, lastError);
      setSourceCodeCache((prev) => {
        const next = new Map(prev);
        next.set(filePath, {
          lines: [],
          loading: false,
          error: `Failed to load: ${lastError}`,
        });
        return next;
      });
    },
    [sourceCodeCache, sourceRootPath, ndkPath]
  );

  // ソースファイルが変わったら読み込む＆タブを開く
  // Also auto-open first file when sourceCodeLevelDebug is enabled
  useEffect(() => {
    if (
      sourceCodeLevelDebug &&
      sourceRootPath &&
      dwarfAnalysisResult?.source_files?.length > 0
    ) {
      // 最初のソースファイルを読み込む
      const firstFile = dwarfAnalysisResult.source_files[0];
      if (firstFile) {
        loadSourceFile(firstFile.path, firstFile.directory);
        // タブが開いていなければ開く
        if (!openSourceTabs.includes(firstFile.path)) {
          setOpenSourceTabs((prev) => [...prev, firstFile.path]);
        }
        // アクティブタブを設定（常に設定して初期表示を確実に）
        if (!activeSourceTab) {
          setActiveSourceTab(firstFile.path);
        }
      }
    }
  }, [
    sourceCodeLevelDebug,
    sourceRootPath,
    dwarfAnalysisResult?.source_files,
    loadSourceFile,
  ]);

  // Ensure activeSourceTab is set when openSourceTabs changes
  useEffect(() => {
    if (sourceCodeLevelDebug && openSourceTabs.length > 0 && !activeSourceTab) {
      setActiveSourceTab(openSourceTabs[0]);
    }
  }, [sourceCodeLevelDebug, openSourceTabs, activeSourceTab]);

  // ソースタブを開く
  const openSourceTab = useCallback(
    (filePath: string, directory: string | null) => {
      loadSourceFile(filePath, directory);
      if (!openSourceTabs.includes(filePath)) {
        setOpenSourceTabs((prev) => [...prev, filePath]);
      }
      setActiveSourceTab(filePath);
    },
    [loadSourceFile, openSourceTabs]
  );

  // ソースタブを閉じる
  const closeSourceTab = useCallback(
    (filePath: string) => {
      setOpenSourceTabs((prev) => {
        const newTabs = prev.filter((p) => p !== filePath);
        // 閉じたタブがアクティブだった場合、別のタブをアクティブにする
        if (activeSourceTab === filePath && newTabs.length > 0) {
          const idx = prev.indexOf(filePath);
          const newActiveIdx = Math.min(idx, newTabs.length - 1);
          setActiveSourceTab(newTabs[newActiveIdx]);
        } else if (newTabs.length === 0) {
          setActiveSourceTab(null);
        }
        return newTabs;
      });
    },
    [activeSourceTab]
  );

  // サイドバーからのソースファイル開くイベントをリッスン
  useEffect(() => {
    const handleOpenSourceFile = (
      event: CustomEvent<{ path: string; directory: string | null }>
    ) => {
      openSourceTab(event.detail.path, event.detail.directory);
    };

    window.addEventListener(
      "openSourceFile",
      handleOpenSourceFile as EventListener
    );
    return () => {
      window.removeEventListener(
        "openSourceFile",
        handleOpenSourceFile as EventListener
      );
    };
  }, [openSourceTab]);

  // Scroll target line ref for OUTLINE jump
  const pendingScrollLineRef = useRef<number | null>(null);

  // Handle pending source jump from OUTLINE click
  useEffect(() => {
    if (!pendingSourceJump || !sourceCodeLevelDebug) return;

    const { filePath, line } = pendingSourceJump;

    // Find matching file in DWARF analysis result
    const matchingFile = dwarfAnalysisResult?.source_files?.find(
      (f: any) =>
        f.path === filePath ||
        f.path.endsWith(filePath) ||
        filePath.endsWith(f.path)
    );

    if (matchingFile) {
      // Open the tab and set scroll target
      const directory = matchingFile.directory || null;
      openSourceTab(matchingFile.path, directory);
      pendingScrollLineRef.current = line;
    }

    // Clear the pending jump request
    setPendingSourceJump(null);
  }, [
    pendingSourceJump,
    sourceCodeLevelDebug,
    dwarfAnalysisResult?.source_files,
    openSourceTab,
    setPendingSourceJump,
  ]);

  // Scroll to target line when source code is loaded
  useEffect(() => {
    if (pendingScrollLineRef.current === null || !activeSourceTab) return;

    const cache = sourceCodeCache.get(activeSourceTab);
    if (!cache || cache.loading || cache.error) return;

    // Scroll to the target line
    const targetLine = pendingScrollLineRef.current;
    pendingScrollLineRef.current = null;

    // Use setTimeout to ensure DOM is updated
    setTimeout(() => {
      const lineElement = document.querySelector(
        `[data-line-number="${targetLine}"]`
      );
      if (lineElement) {
        lineElement.scrollIntoView({ behavior: "smooth", block: "center" });
        // Briefly highlight the line
        (lineElement as HTMLElement).style.backgroundColor =
          "rgba(79, 193, 255, 0.3)";
        setTimeout(() => {
          (lineElement as HTMLElement).style.backgroundColor = "";
        }, 1500);
      }
    }, 100);
  }, [activeSourceTab, sourceCodeCache]);

  const {
    formatAddressWithSymbol,
    ensureModuleSymbolsLoaded,
    loadedModuleCount,
    updateServerInfo,
  } = useSymbolCache();

  const { state: tauriState } = useTauriSystemStateSingleton();

  // Must sync server info before formatAddressWithSymbol calls loadModuleSymbolsInternal
  useEffect(() => {
    console.log(
      `[AssemblyView] tauriState check: host=${tauriState?.connectionHost}, port=${tauriState?.connectionPort}, tauriState=${tauriState ? "exists" : "null"}`
    );
    if (tauriState?.connectionHost && tauriState?.connectionPort) {
      console.log(
        `[AssemblyView] Updating server info: ${tauriState.connectionHost}:${tauriState.connectionPort}, targetOs: ${serverInfo?.target_os}`
      );
      updateServerInfo({
        ip: tauriState.connectionHost,
        port: tauriState.connectionPort,
        targetOs: serverInfo?.target_os,
      });
    }
  }, [
    tauriState?.connectionHost,
    tauriState?.connectionPort,
    serverInfo?.target_os,
    updateServerInfo,
  ]);

  // 接続情報が更新されたら、現在表示中のモジュールのシンボルをロード
  // これにより、build時の初期化タイミング問題を解消
  useEffect(() => {
    if (currentBaseAddress === 0 || !attachedModules.length) return;

    // 接続情報がない場合はスキップ
    if (!tauriState?.connectionHost || !tauriState?.connectionPort) {
      return;
    }

    const serverInfo = {
      ip: tauriState.connectionHost,
      port: tauriState.connectionPort,
    };

    // モジュールのシンボルがなければバックグラウンドでロード
    ensureModuleSymbolsLoaded(
      currentBaseAddress,
      attachedModules,
      serverInfo
    ).then((loaded) => {
      if (loaded) {
        console.log(
          `[AssemblyView] Symbol loading triggered for address 0x${currentBaseAddress.toString(16)}`
        );
      }
    });
  }, [
    currentBaseAddress,
    attachedModules,
    ensureModuleSymbolsLoaded,
    tauriState?.connectionHost,
    tauriState?.connectionPort,
  ]);

  // アドレス解決結果のキャッシュ（レンダリングパフォーマンス向上用）
  const addressResolutionCache = useRef<Map<string, string>>(new Map());

  // キャッシュをクリアするトリガー（モジュール情報やシンボルが変わったとき）
  useEffect(() => {
    addressResolutionCache.current.clear();
  }, [attachedModules, loadedModuleCount, addressDisplayFormat]);

  // Function to get module detail text for tooltip
  const getModuleDetailText = useCallback(
    (address: string): string => {
      if (!attachedModules.length) return "";

      // キャッシュをチェック
      const cached = addressResolutionCache.current.get(address);
      if (cached !== undefined) return cached;

      // アドレスを数値に変換
      let numericAddress: number;
      if (address.startsWith("0x") || address.startsWith("0X")) {
        numericAddress = parseInt(address, 16);
      } else {
        numericAddress = parseInt(address, 10);
      }

      if (isNaN(numericAddress)) {
        addressResolutionCache.current.set(address, "");
        return "";
      }

      const result = formatAddressWithSymbol(
        numericAddress,
        attachedModules,
        addressDisplayFormat
      );
      if (result) {
        addressResolutionCache.current.set(address, result);
        return result;
      }

      // フォールバック: 従来の library + offset 形式
      for (const module of attachedModules) {
        const moduleBase = module.base;
        const moduleEnd = moduleBase + module.size;

        if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
          const offset = numericAddress - moduleBase;
          const fullModuleName = module.modulename || module.name || "unknown";

          // フルパスからファイル名のみを抽出
          const fileName =
            fullModuleName.split(/[\/\\]/).pop() || fullModuleName;

          const fallbackResult = `${fileName} + 0x${offset.toString(16)}`;
          addressResolutionCache.current.set(address, fallbackResult);
          return fallbackResult;
        }
      }

      // モジュール外のアドレスもキャッシュ
      addressResolutionCache.current.set(address, "");
      return "";
    },
    [
      attachedModules,
      addressDisplayFormat,
      formatAddressWithSymbol,
      loadedModuleCount,
    ]
  );

  // Function to get module detail for an address
  const getModuleDetail = useCallback(
    (address: string): React.ReactNode => {
      if (!attachedModules.length) return "";

      // アドレスを数値に変換
      let numericAddress: number;
      if (address.startsWith("0x") || address.startsWith("0X")) {
        numericAddress = parseInt(address, 16);
      } else {
        numericAddress = parseInt(address, 10);
      }

      if (isNaN(numericAddress)) return "";

      const result = formatAddressWithSymbol(
        numericAddress,
        attachedModules,
        addressDisplayFormat
      );
      if (result) {
        if (addressDisplayFormat === "function" && result.includes("@")) {
          // module@function + offset 形式
          const atIndex = result.indexOf("@");
          const plusIndex = result.indexOf(" + ");
          if (plusIndex > atIndex) {
            const modulePart = result.substring(0, atIndex);
            const funcPart = result.substring(atIndex + 1, plusIndex);
            const offsetPart = result.substring(plusIndex);
            return (
              <>
                <span className="filename">{modulePart}</span>
                <span className="function" style={{ color: "#dcdcaa" }}>
                  @{funcPart}
                </span>
                <span className="offset">{offsetPart}</span>
              </>
            );
          } else if (plusIndex === -1 && result.includes("@")) {
            // offset なし (module@function のみ)
            const modulePart = result.substring(0, atIndex);
            const funcPart = result.substring(atIndex + 1);
            return (
              <>
                <span className="filename">{modulePart}</span>
                <span className="function" style={{ color: "#dcdcaa" }}>
                  @{funcPart}
                </span>
              </>
            );
          }
        }
        // library + offset 形式
        const plusIndex = result.indexOf(" + ");
        if (plusIndex > 0) {
          const fileName = result.substring(0, plusIndex);
          const offset = result.substring(plusIndex);
          return (
            <>
              <span className="filename">{fileName}</span>
              <span className="offset">{offset}</span>
            </>
          );
        }
        return result;
      }

      // フォールバック: 従来の処理
      for (const module of attachedModules) {
        const moduleBase = module.base;
        const moduleEnd = moduleBase + module.size;

        if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
          const offset = numericAddress - moduleBase;
          const fullModuleName = module.modulename || module.name || "unknown";

          // フルパスからファイル名のみを抽出
          const fileName =
            fullModuleName.split(/[\/\\]/).pop() || fullModuleName;

          // filename部分に色を付けてJSXで返す
          return (
            <>
              <span className="filename">{fileName}</span>
              <span className="offset"> + 0x{offset.toString(16)}</span>
            </>
          );
        }
      }

      return "";
    },
    [
      attachedModules,
      addressDisplayFormat,
      formatAddressWithSymbol,
      loadedModuleCount,
    ]
  );

  // Function to get library+offset or library@function+offset expression for branch target addresses
  const getBranchTargetLibraryExpression = useCallback(
    (operands: string): string | null => {
      if (!attachedModules.length) return null;

      // Extract address from operands (handle various formats)
      // Common patterns: "0x1234", "#0x1234", "0x1234 <symbol>"
      const addressMatch = operands.match(/(0x[0-9a-fA-F]+)/);
      if (!addressMatch) return null;

      const addressStr = addressMatch[1];
      const numericAddress = parseInt(addressStr, 16);

      if (isNaN(numericAddress)) return null;

      const result = formatAddressWithSymbol(
        numericAddress,
        attachedModules,
        addressDisplayFormat
      );
      if (result) return result;

      // フォールバック: 従来の library+offset 形式
      const libraryExpr = encodeAddressToLibraryExpression(
        numericAddress,
        attachedModules,
        true // prefer short filename
      );

      return libraryExpr;
    },
    [
      attachedModules,
      addressDisplayFormat,
      formatAddressWithSymbol,
      loadedModuleCount,
    ]
  );

  // Function to get formatted comment for an instruction based on address display format
  // This allows comments to dynamically update when addressDisplayFormat changes
  const getFormattedComment = useCallback(
    (instruction: Instruction): string => {
      // Function labels and special comments should be preserved as-is
      if (
        instruction.isFunction ||
        instruction.isFunctionStart ||
        instruction.isFunctionEnd
      ) {
        return instruction.comment;
      }

      // For RET/BR/BLR instructions in break state, show the predicted target address
      const opcodeLower = instruction.opcode.toLowerCase();
      if (
        isInBreakState &&
        currentBreakAddress &&
        Object.keys(registerData).length > 0
      ) {
        // Normalize addresses for comparison
        const normalizedInstrAddr = instruction.address
          .toLowerCase()
          .replace(/^0x0*/, "0x");
        const normalizedBreakAddr = currentBreakAddress
          .toLowerCase()
          .replace(/^0x0*/, "0x");

        // Only show prediction for the current break instruction
        if (normalizedInstrAddr === normalizedBreakAddr) {
          // RET instructions - use LR (X30)
          if (
            opcodeLower === "ret" ||
            opcodeLower === "retaa" ||
            opcodeLower === "retab"
          ) {
            // Get LR (X30) value from register data
            const lrValue =
              registerData["LR"] ||
              registerData["lr"] ||
              registerData["X30"] ||
              registerData["x30"];
            if (lrValue) {
              // Format the return address
              const lrAddr = lrValue.startsWith("0x")
                ? lrValue
                : `0x${lrValue}`;
              // Try to get library expression for the return address
              const libraryExpr = getBranchTargetLibraryExpression(lrAddr);
              if (libraryExpr) {
                return `return to ${libraryExpr}`;
              }
              return `return to ${lrAddr}`;
            }
          }

          // BR/BLR instructions - use the register from operand
          if (
            opcodeLower === "br" ||
            opcodeLower === "blr" ||
            opcodeLower === "braa" ||
            opcodeLower === "brab" ||
            opcodeLower === "blraa" ||
            opcodeLower === "blrab" ||
            opcodeLower === "braaz" ||
            opcodeLower === "brabz" ||
            opcodeLower === "blraaz" ||
            opcodeLower === "blrabz"
          ) {
            // Get the register name from operands
            const operandsStr = instruction.operands
              .map((op) => op.value)
              .join(", ")
              .trim();
            // Extract register name (e.g., "x8", "x16", etc.)
            const regMatch = operandsStr.match(/^(x\d+|lr)$/i);
            if (regMatch) {
              const regName = regMatch[1].toLowerCase();
              // Map lr to x30
              const lookupName = regName === "lr" ? "x30" : regName;
              const regValue =
                registerData[lookupName.toUpperCase()] ||
                registerData[lookupName];
              if (regValue) {
                const targetAddr = regValue.startsWith("0x")
                  ? regValue
                  : `0x${regValue}`;
                const libraryExpr =
                  getBranchTargetLibraryExpression(targetAddr);
                const actionWord = opcodeLower.startsWith("blr")
                  ? "call"
                  : "jump to";
                if (libraryExpr) {
                  return `${actionWord} ${libraryExpr}`;
                }
                return `${actionWord} ${targetAddr}`;
              }
            }
          }
        }
      }

      // For jump instructions, dynamically generate the comment based on current display format
      if (
        isJumpInstruction(instruction.opcode) &&
        instruction.operands.length > 0
      ) {
        const operandsStr = instruction.operands
          .map((op) => op.value)
          .join(", ");
        const libraryExpr = getBranchTargetLibraryExpression(operandsStr);
        if (libraryExpr) {
          return libraryExpr;
        }
      }

      // For other instructions, return the original comment
      return instruction.comment;
    },
    [
      getBranchTargetLibraryExpression,
      isInBreakState,
      currentBreakAddress,
      registerData,
    ]
  );

  // Function to extract branch target address from instruction operands
  // Returns the raw address string if found, null otherwise
  const getBranchTargetAddress = useCallback(
    (instruction: Instruction): string | null => {
      const opcodeLower = instruction.opcode.toLowerCase();

      // For RET/BR/BLR instructions in break state, return register value as target
      if (
        isInBreakState &&
        currentBreakAddress &&
        Object.keys(registerData).length > 0
      ) {
        // Normalize addresses for comparison
        const normalizedInstrAddr = instruction.address
          .toLowerCase()
          .replace(/^0x0*/, "0x");
        const normalizedBreakAddr = currentBreakAddress
          .toLowerCase()
          .replace(/^0x0*/, "0x");

        // Only return register value for the current break instruction
        if (normalizedInstrAddr === normalizedBreakAddr) {
          // RET instructions - use LR (X30)
          if (
            opcodeLower === "ret" ||
            opcodeLower === "retaa" ||
            opcodeLower === "retab"
          ) {
            const lrValue =
              registerData["LR"] ||
              registerData["lr"] ||
              registerData["X30"] ||
              registerData["x30"];
            if (lrValue) {
              return lrValue.startsWith("0x") ? lrValue : `0x${lrValue}`;
            }
          }

          // BR/BLR instructions - use the register from operand
          if (
            opcodeLower === "br" ||
            opcodeLower === "blr" ||
            opcodeLower === "braa" ||
            opcodeLower === "brab" ||
            opcodeLower === "blraa" ||
            opcodeLower === "blrab" ||
            opcodeLower === "braaz" ||
            opcodeLower === "brabz" ||
            opcodeLower === "blraaz" ||
            opcodeLower === "blrabz"
          ) {
            // Get the register name from operands
            const operandsStr = instruction.operands
              .map((op) => op.value)
              .join(", ")
              .trim();
            // Extract register name (e.g., "x8", "x16", etc.)
            const regMatch = operandsStr.match(/^(x\d+|lr)$/i);
            if (regMatch) {
              const regName = regMatch[1].toLowerCase();
              // Map lr to x30
              const lookupName = regName === "lr" ? "x30" : regName;
              const regValue =
                registerData[lookupName.toUpperCase()] ||
                registerData[lookupName];
              if (regValue) {
                return regValue.startsWith("0x") ? regValue : `0x${regValue}`;
              }
            }
          }
        }
      }

      // Only extract address for jump instructions
      if (
        !isJumpInstruction(instruction.opcode) ||
        instruction.operands.length === 0
      ) {
        return null;
      }

      const operandsStr = instruction.operands.map((op) => op.value).join(", ");
      // Extract address from operands (handle various formats)
      // Common patterns: "0x1234", "#0x1234", "0x1234 <symbol>"
      const addressMatch = operandsStr.match(/(0x[0-9a-fA-F]+)/);
      if (addressMatch) {
        return addressMatch[1];
      }

      return null;
    },
    [isInBreakState, currentBreakAddress, registerData]
  );

  const [focusedLineAddress, setFocusedLineAddress] = useState<string | null>(
    null
  );

  // Visibility and caching states for tab switching optimization
  const [isVisible, setIsVisible] = useState(true);
  const [cachedInstructions, setCachedInstructions] = useState<Instruction[]>(
    []
  );
  const [cachedInstructionBuffer, setCachedInstructionBuffer] = useState<
    Instruction[]
  >([]);
  const [cachedViewportStart, setCachedViewportStart] = useState<number>(0);
  const [cachedBaseAddress, setCachedBaseAddress] = useState<number>(0);
  const [previousInstructions, setPreviousInstructions] = useState<
    Instruction[]
  >([]);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [pendingNavigationAddress, setPendingNavigationAddress] = useState<
    string | null
  >(null);

  // Calculate branch arrows for visible instructions (x64dbg-style arrows)
  const branchArrows = useMemo(() => {
    const displayInstructions =
      instructions.length > 0 ? instructions : previousInstructions;
    const arrows = calculateBranchArrows(displayInstructions);

    // Add predicted next instruction arrow if in break state with register data
    if (
      isInBreakState &&
      currentBreakAddress &&
      Object.keys(registerData).length > 0
    ) {
      // Find the current instruction
      const normalizedCurrentAddr = currentBreakAddress
        .toLowerCase()
        .replace(/^0x0*/, "0x");
      const currentIndex = displayInstructions.findIndex((instr) => {
        const normalizedAddr = instr.address
          .toLowerCase()
          .replace(/^0x0*/, "0x");
        return normalizedAddr === normalizedCurrentAddr;
      });

      if (currentIndex >= 0) {
        const currentInstr = displayInstructions[currentIndex];
        const currentAddr = BigInt(
          currentInstr.address.startsWith("0x")
            ? currentInstr.address
            : `0x${currentInstr.address}`
        );

        // Convert register data to state for prediction
        const regState = convertRegistersToState(registerData);
        regState.pc = currentAddr;

        // Get operands as string
        const operandsStr =
          typeof currentInstr.operands === "string"
            ? currentInstr.operands
            : currentInstr.operands
                .map((op: any) => {
                  if (typeof op === "string") return op;
                  return op.value || "";
                })
                .join(", ");

        // Predict next instruction
        const prediction = predictNextInstruction(
          currentAddr,
          currentInstr.opcode,
          operandsStr,
          regState
        );

        // Debug logging for branch prediction
        console.log("[BranchPredictor] Prediction for:", {
          address: `0x${currentAddr.toString(16)}`,
          opcode: currentInstr.opcode,
          operands: operandsStr,
          prediction: {
            type: prediction.type,
            willBranch: prediction.willBranch,
            targetAddress: prediction.targetAddress?.toString(16),
            fallthrough: prediction.fallthrough.toString(16),
            confidence: prediction.confidence,
            reason: prediction.reason,
          },
          registerData: Object.fromEntries(
            Object.entries(registerData).filter(
              ([k]) =>
                k.toLowerCase().includes("11") ||
                k.toLowerCase() === "cpsr" ||
                k.toLowerCase() === "nzcv"
            )
          ),
        });

        // If prediction is confident and has a target, add the arrow
        if (prediction.willBranch !== null && prediction.confidence !== "low") {
          const targetAddr = prediction.willBranch
            ? prediction.targetAddress
            : prediction.fallthrough;

          if (targetAddr !== null) {
            const targetHex = `0x${targetAddr.toString(16)}`;
            const normalizedTarget = targetHex
              .toLowerCase()
              .replace(/^0x0*/, "0x");

            // Find target index
            const targetIndex = displayInstructions.findIndex((instr) => {
              const normalizedAddr = instr.address
                .toLowerCase()
                .replace(/^0x0*/, "0x");
              return normalizedAddr === normalizedTarget;
            });

            if (targetIndex >= 0 && targetIndex !== currentIndex) {
              // Target is in view - add prediction arrow
              arrows.push({
                fromIndex: currentIndex,
                toIndex: targetIndex,
                fromAddress: currentInstr.address,
                toAddress: targetHex,
                isConditional: false,
                isDownward: targetIndex > currentIndex,
                depth: 0, // Will be recalculated
                isPredictedNext: true,
              });
            } else if (targetIndex < 0) {
              // Target is out of view
              const targetNumeric = Number(targetAddr);
              const firstAddr = displayInstructions[0]?.address
                ? parseInt(
                    displayInstructions[0].address.replace(/^0x/i, ""),
                    16
                  )
                : 0;
              const lastAddr = displayInstructions[
                displayInstructions.length - 1
              ]?.address
                ? parseInt(
                    displayInstructions[
                      displayInstructions.length - 1
                    ].address.replace(/^0x/i, ""),
                    16
                  )
                : 0;

              if (targetNumeric < firstAddr) {
                arrows.push({
                  fromIndex: currentIndex,
                  toIndex: -1,
                  fromAddress: currentInstr.address,
                  toAddress: targetHex,
                  isConditional: false,
                  isDownward: false,
                  depth: 0,
                  isPredictedNext: true,
                });
              } else if (targetNumeric > lastAddr) {
                arrows.push({
                  fromIndex: currentIndex,
                  toIndex: displayInstructions.length,
                  fromAddress: currentInstr.address,
                  toAddress: targetHex,
                  isConditional: false,
                  isDownward: true,
                  depth: 0,
                  isPredictedNext: true,
                });
              }
            }
          }
        }
      }
    }

    return arrows;
  }, [
    instructions,
    previousInstructions,
    isInBreakState,
    currentBreakAddress,
    registerData,
  ]);

  // Helper function to normalize addresses for comparison
  const normalizeAddress = useCallback((addr: string) => {
    if (!addr) return "";
    // Remove 0x prefix, convert to lowercase, remove leading zeros, then add 0x back
    const cleaned =
      addr.replace(/^0x/i, "").toLowerCase().replace(/^0+/, "") || "0";
    return `0x${cleaned}`;
  }, []);

  // Handle highlight address from DecompileView click
  // If the target address is visually visible in the table, just highlight it
  // If not visible on screen, scroll to it
  useEffect(() => {
    if (!highlightAddress) return;

    const normalizedTarget = normalizeAddress(highlightAddress);

    // Check if the address exists in current instructions
    const isInInstructions = instructions.some(
      (instr) => normalizeAddress(instr.address) === normalizedTarget
    );

    if (isInInstructions) {
      // Address is in instructions - check if it's actually visible on screen
      // Find the row element by data attribute
      const rowElement = tableContainerRef.current?.querySelector(
        `[data-address="${highlightAddress}"]`
      ) as HTMLElement | null;

      if (rowElement && tableContainerRef.current) {
        const containerRect = tableContainerRef.current.getBoundingClientRect();
        const rowRect = rowElement.getBoundingClientRect();

        // Check if the row is within the visible area of the container
        const isVisibleOnScreen =
          rowRect.top >= containerRect.top &&
          rowRect.bottom <= containerRect.bottom;

        if (isVisibleOnScreen) {
          // Row is visible - just highlight without scrolling
          setFocusedLineAddress(highlightAddress);
          setTimeout(() => {
            setFocusedLineAddress(null);
          }, 3000);
        } else {
          // Row exists but is not visible on screen - scroll to it instantly
          rowElement.scrollIntoView({ behavior: "instant", block: "center" });
          setFocusedLineAddress(highlightAddress);
          setTimeout(() => {
            setFocusedLineAddress(null);
          }, 3000);
        }
      } else {
        // Row element not found - just set highlight
        setFocusedLineAddress(highlightAddress);
        setTimeout(() => {
          setFocusedLineAddress(null);
        }, 5000);
      }
    } else {
      // Address is not in current instructions - navigate to it (which will load new data and scroll)
      setAssemblyAddress(highlightAddress);
      // Set focus immediately - the address navigation handles scroll
      setFocusedLineAddress(highlightAddress);
      setTimeout(() => {
        setFocusedLineAddress(null);
      }, 3000);
    }

    // Notify parent that highlight is complete
    if (onHighlightComplete) {
      onHighlightComplete();
    }
  }, [
    highlightAddress,
    instructions,
    normalizeAddress,
    setAssemblyAddress,
    onHighlightComplete,
  ]);

  // Prefetch system for seamless scrolling
  const [prefetchBuffers, setPrefetchBuffers] = useState<
    Map<number, Instruction[]>
  >(new Map());
  const prefetchDistance = useState<number>(512)[0]; // Reduced distance for faster loading
  const containerRef = useRef<HTMLDivElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const lastProcessedBreakAddressRef = useRef<string | null>(null);

  // アンマウント時に保存するための最新値を保持するref
  const latestStateRef = useRef({
    instructions,
  });

  // 最新の状態をrefに反映
  useEffect(() => {
    latestStateRef.current = {
      instructions,
    };
  }, [instructions]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    console.log("[ASSEMBLY VIEW LIFECYCLE] Component mounted");

    return () => {
      mountedRef.current = false;
      console.log("[ASSEMBLY VIEW LIFECYCLE] Component unmounted");

      // アンマウント時に現在表示中のアドレスをグローバルストアに保存（refから最新値を取得）
      const latest = latestStateRef.current;
      if (latest.instructions.length > 0) {
        // 一番上に表示されている命令のアドレスを保存
        const topVisibleAddress = latest.instructions[0]?.address || null;

        if (topVisibleAddress) {
          console.log(
            `[ASSEMBLY VIEW LIFECYCLE] Saving top visible address to global store: ${topVisibleAddress}`
          );
          setAssemblyAddress(topVisibleAddress);
        }
      }
    };
  }, [setAssemblyAddress]);

  // Tab visibility monitoring for preventing unnecessary re-renders (simplified)
  useEffect(() => {
    console.log("[VISIBILITY] Setting up visibilitychange listener");

    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      console.log(
        `[VISIBILITY] Visibility changed - document.hidden: ${document.hidden}, visible: ${visible}`
      );
      setIsVisible(visible);

      if (
        visible &&
        cachedInstructions.length > 0 &&
        instructions.length === 0
      ) {
        // Tab became visible and we have cached instructions, restore them
        console.log("[VISIBILITY] Tab became visible, restoring cached state");
        console.log(
          `[VISIBILITY] Cached instructions count: ${cachedInstructions.length}`
        );
        console.log(
          `[VISIBILITY] Current instructions count: ${instructions.length}`
        );

        // Restore instructions with current breakpoint state
        const restoredInstructions = cachedInstructions.map((instruction) => ({
          ...instruction,
          breakpoint: breakpoints.has(instruction.address),
          isSoftwareBreakpoint: softwareBreakpoints.has(instruction.address),
        }));

        // Restore all scroll-related state
        setInstructions(restoredInstructions);
        if (cachedInstructionBuffer.length > 0) {
          setInstructionBuffer(cachedInstructionBuffer);
        }
        setViewportStart(cachedViewportStart);
        setCurrentBaseAddress(cachedBaseAddress);

        console.log(
          `AssemblyView: Restored state - baseAddress: 0x${cachedBaseAddress.toString(16)}, viewportStart: ${cachedViewportStart}, buffer size: ${cachedInstructionBuffer.length}`
        );
      } else if (!visible && instructions.length > 0) {
        // Tab became hidden, cache current instructions and state for later
        console.log("[VISIBILITY] Tab became hidden, caching state");
        console.log(
          `[VISIBILITY] Instructions to cache: ${instructions.length}`
        );
        console.log(
          `[VISIBILITY] Current base address: 0x${currentBaseAddress.toString(16)}`
        );
        setCachedInstructions(instructions);
        setCachedInstructionBuffer(instructionBuffer);
        setCachedViewportStart(viewportStart);
        setCachedBaseAddress(currentBaseAddress);

        console.log(
          `[VISIBILITY] Cached state - baseAddress: 0x${currentBaseAddress.toString(16)}, viewportStart: ${viewportStart}, buffer size: ${instructionBuffer.length}`
        );
      } else {
        console.log(
          `[VISIBILITY] Visibility changed but no action taken - visible: ${visible}, cachedInstructions: ${cachedInstructions.length}, instructions: ${instructions.length}`
        );
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    console.log("[VISIBILITY] Listener registered");

    return () => {
      console.log("[VISIBILITY] Removing listener");
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    instructions,
    cachedInstructions,
    activeBreakpoints,
    instructionBuffer,
    cachedInstructionBuffer,
    viewportStart,
    cachedViewportStart,
    currentBaseAddress,
    cachedBaseAddress,
    breakpoints,
  ]);

  // Listen for navigate-to-address events from other windows (e.g., GraphView)
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ address: string }>(
        "navigate-to-address",
        (event) => {
          const { address } = event.payload;
          console.log(
            "[AssemblyView] Received navigate-to-address event:",
            address
          );
          setAssemblyAddress(address);
        }
      );
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [setAssemblyAddress]);

  // Update instructions when breakpoint state changes
  useEffect(() => {
    if (instructions.length > 0) {
      // Update instructions with current breakpoint state
      const updatedInstructions = instructions.map((instruction) => ({
        ...instruction,
        breakpoint: breakpoints.has(instruction.address),
        isSoftwareBreakpoint: softwareBreakpoints.has(instruction.address),
      }));

      // Only update if there are actual changes to prevent infinite loops
      const hasChanges = updatedInstructions.some(
        (updated, index) =>
          instructions[index] &&
          updated.breakpoint !== instructions[index].breakpoint
      );

      if (hasChanges) {
        console.log(
          "AssemblyView: Updating instructions with new breakpoint state"
        );
        setInstructions(updatedInstructions);

        // Also update the instruction buffer
        if (instructionBuffer.length > 0) {
          const updatedBuffer = instructionBuffer.map((instruction) => ({
            ...instruction,
            breakpoint: breakpoints.has(instruction.address),
            isSoftwareBreakpoint: softwareBreakpoints.has(instruction.address),
          }));
          setInstructionBuffer(updatedBuffer);
        }

        // Also update cached instructions if they exist
        if (cachedInstructions.length > 0) {
          const updatedCache = cachedInstructions.map((instruction) => ({
            ...instruction,
            breakpoint: breakpoints.has(instruction.address),
            isSoftwareBreakpoint: softwareBreakpoints.has(instruction.address),
          }));
          setCachedInstructions(updatedCache);
        }
      }
    }
  }, [activeBreakpoints]); // Depend on activeBreakpoints instead of breakpoints

  // Cache previous instructions to prevent flickering during transitions
  useEffect(() => {
    if (instructions.length > 0 && !loading) {
      setPreviousInstructions(instructions);
    }
  }, [instructions, loading]);

  // Check for breakpoint hits and notify parent
  useEffect(() => {
    const breakpointHitInstruction = instructions.find(
      (instruction) => instruction.address.includes("1004") // デモ用: アドレスに1004が含まれる場合
    );

    if (breakpointHitInstruction && onBreakpointHit) {
      onBreakpointHit(breakpointHitInstruction.address);
    }
  }, [instructions, onBreakpointHit]);

  // Single step optimization - check if the break address is within current viewport
  useEffect(() => {
    if (!currentBreakAddress) {
      // Clear the last processed address when break state ends
      lastProcessedBreakAddressRef.current = null;
      return;
    }

    // Skip if we already processed this exact break address
    if (lastProcessedBreakAddressRef.current === currentBreakAddress) {
      console.log(
        `[SINGLE STEP DEBUG] Already processed break address ${currentBreakAddress}, skipping to allow free scrolling`
      );
      return;
    }

    // Use ref to get latest instructions without triggering re-render
    const currentInstructions = latestStateRef.current.instructions;

    console.log(
      `[SINGLE STEP DEBUG] AssemblyView: Break address changed to ${currentBreakAddress}, isInBreakState: ${isInBreakState}, loading: ${loading}, instructions.length: ${currentInstructions.length}`
    );

    // Skip if we're already loading to prevent infinite loops
    if (loading) {
      console.log(
        `[SINGLE STEP DEBUG] Already loading, skipping navigation for ${currentBreakAddress}`
      );
      return;
    }

    // Skip if we're already showing the correct address
    const currentFunctionAddress =
      useUIStore.getState().debuggerState.assemblyAddress;
    if (
      currentFunctionAddress &&
      normalizeAddress(currentFunctionAddress) ===
        normalizeAddress(currentBreakAddress)
    ) {
      console.log(
        `[SINGLE STEP DEBUG] Already showing correct address ${currentBreakAddress} (functionAddress: ${currentFunctionAddress}), no navigation needed`
      );
      // Still mark as processed to prevent future re-navigation
      lastProcessedBreakAddressRef.current = currentBreakAddress;
      return;
    }

    console.log(
      `[SINGLE STEP DEBUG] functionAddress: ${currentFunctionAddress}, normalized: ${currentFunctionAddress ? normalizeAddress(currentFunctionAddress) : "null"}, currentBreakAddress normalized: ${normalizeAddress(currentBreakAddress)}`
    );

    // For initial breakpoint hits or when instructions are empty, we need to navigate
    // But check if we're already close to the target address first
    if (currentInstructions.length === 0) {
      console.log(
        `[SINGLE STEP DEBUG] Initial breakpoint hit: No instructions loaded, navigating to ${currentBreakAddress}`
      );
      setAssemblyAddress(currentBreakAddress);
      lastProcessedBreakAddressRef.current = currentBreakAddress;
      return;
    }

    // Log current instruction range for debugging
    console.log(
      `[SINGLE STEP DEBUG] Current instructions range: ${currentInstructions[0]?.address} - ${currentInstructions[currentInstructions.length - 1]?.address} (${currentInstructions.length} instructions)`
    );

    // Check if we're already showing a nearby range (within reasonable distance)
    const currentBreakAddressNum = parseInt(
      currentBreakAddress.replace(/^0x/i, ""),
      16
    );
    console.log(
      `[SINGLE STEP DEBUG] Checking proximity for break address ${currentBreakAddress} (0x${currentBreakAddressNum.toString(16)})`
    );

    const isNearCurrentRange = currentInstructions.some((instruction) => {
      const instrAddressNum = parseInt(
        instruction.address.replace(/^0x/i, ""),
        16
      );
      const distance = Math.abs(instrAddressNum - currentBreakAddressNum);
      if (distance < 0x100) {
        console.log(
          `[SINGLE STEP DEBUG] Found nearby instruction ${instruction.address} (0x${instrAddressNum.toString(16)}), distance: 0x${distance.toString(16)}`
        );
        return true;
      }
      return false;
    });

    console.log(
      `Debug: Is near current range: ${isNearCurrentRange}, instructions count: ${currentInstructions.length}`
    );

    // First, always check if the exact address is within the displayed instructions
    const isAddressInCurrentView = currentInstructions.some(
      (instruction) =>
        normalizeAddress(instruction.address) ===
        normalizeAddress(currentBreakAddress)
    );

    console.log(
      `Debug: Is exact address in current view: ${isAddressInCurrentView}`
    );

    if (isAddressInCurrentView) {
      console.log(
        `Single step optimization: Break address ${currentBreakAddress} is within current view, skipping re-fetch`
      );
      // Address is in current view, no need to reload - just highlight will change automatically
      // Mark as processed so we don't keep trying to navigate to it
      lastProcessedBreakAddressRef.current = currentBreakAddress;
      // Note: Decompile view sync will be handled by a separate useEffect after syncDecompileView is defined
      return;
    }

    // If not in current view, check if it's nearby (expand range for single steps)
    if (isNearCurrentRange) {
      console.log(
        `Break address ${currentBreakAddress} is near current view but not visible, checking if we should expand view or navigate`
      );

      // For single step operations, we want to try to keep the current view if the target is very close
      // Expand the view slightly by prefetching around the current range instead of full navigation
      const shouldExpandView = currentInstructions.some((instruction) => {
        const instrAddressNum = parseInt(
          instruction.address.replace(/^0x/i, ""),
          16
        );
        const distance = Math.abs(instrAddressNum - currentBreakAddressNum);
        return distance < 0x40; // Within 64 bytes - very close, try to expand view instead of navigate
      });

      if (shouldExpandView) {
        console.log(
          `Debug: Target is very close, expanding current view instead of navigation`
        );
        // TODO: Could implement view expansion here instead of navigation
        // For now, keep current view and let the highlight system attempt to show it
        // Mark as processed to allow free scrolling
        lastProcessedBreakAddressRef.current = currentBreakAddress;
        // Note: Decompile view sync will be handled by a separate useEffect after syncDecompileView is defined
        return;
      } else {
        console.log(
          `Debug: Target is nearby but not very close, performing navigation`
        );
        setAssemblyAddress(currentBreakAddress);
        lastProcessedBreakAddressRef.current = currentBreakAddress;
        // Note: Decompile view sync will be handled by a separate useEffect after syncDecompileView is defined
      }
    } else {
      console.log(
        `Single step: Break address ${currentBreakAddress} is outside current view, need to navigate at ${new Date().toISOString()}`
      );
      // Address is outside current view, need to navigate to it
      // This will trigger the normal loading process
      setAssemblyAddress(currentBreakAddress);
      lastProcessedBreakAddressRef.current = currentBreakAddress;
      // Note: Decompile view sync will be handled by a separate useEffect after syncDecompileView is defined
    }
    // Note: intentionally not including 'instructions' in dependencies to prevent
    // re-navigation when user manually navigates to a different address during break state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBreakAddress, normalizeAddress, loading]);

  // Convert hex address string to number
  const parseAddress = (addressStr: string): number => {
    return parseInt(addressStr.replace("0x", ""), 16);
  };

  // Function to parse disassembly text to Instruction objects
  const parseDisassembly = (
    disassemblyText: string,
    baseAddress: number
  ): Instruction[] => {
    try {
      if (!disassemblyText || disassemblyText.trim() === "") {
        console.warn("Empty disassembly text received");
        return [];
      }

      const lines = disassemblyText.split("\n").filter((line) => line.trim());

      if (lines.length === 0) {
        console.warn("No valid lines found in disassembly text");
        return [];
      }

      const instructions: Instruction[] = [];

      lines.forEach((line, index) => {
        try {
          // Check for function labels (e.g., "function_name:")
          if (line.includes(":") && !line.includes("|")) {
            const functionMatch = line.match(/^([^:]+):\s*$/);
            if (functionMatch) {
              const functionName = functionMatch[1].trim();
              // Add a special instruction for function labels
              instructions.push({
                address: `0x${(baseAddress + index * 4).toString(16)}`,
                bytes: "",
                opcode: "",
                operands: [],
                comment: `Function: ${functionName}`,
                active: false,
                breakpoint: false,
                jumpTarget: true,
                isFunction: true,
              });
              return;
            }
          }

          // Parse format: address|bytes|mnemonic operands
          const parts = line.split("|");

          if (parts.length >= 3) {
            const address = parts[0].trim();
            const bytes = parts[1].trim();
            const instructionPart = parts[2].trim();

            // Split instruction into mnemonic and operands
            const instructionMatch = instructionPart.match(/^(\S+)\s*(.*)?$/);
            if (instructionMatch) {
              const [, opcode, operands = ""] = instructionMatch;

              // Detect function prologue patterns (disabled for cleaner display)
              const isFunctionStart = false;

              // Detect function epilogue patterns (disabled for cleaner display)
              const isFunctionEnd = false;

              // Check if this is a branch instruction and add library+offset comment
              let comment = "";
              if (isJumpInstruction(opcode) && operands) {
                const libraryExpr = getBranchTargetLibraryExpression(operands);
                if (libraryExpr) {
                  comment = libraryExpr;
                }
              }

              const result = {
                address,
                bytes,
                opcode,
                operands: operands
                  ? operands.split(",").map((op) => ({
                      type: "reg" as const,
                      value: op.trim(),
                    }))
                  : [],
                comment,
                active: false,
                breakpoint: false,
                jumpTarget: false,
                isFunctionStart,
                isFunctionEnd,
              };
              instructions.push(result);
              return;
            }
          }

          // Fallback for old format or malformed lines
          const match = line.match(/^(0x[a-fA-F0-9]+):\s*([^\s]+)\s*(.*)?$/);
          if (match) {
            const [, address, opcode, operands = ""] = match;

            // Check if this is a branch instruction and add library+offset comment
            let comment = "";
            if (isJumpInstruction(opcode) && operands) {
              const libraryExpr = getBranchTargetLibraryExpression(operands);
              if (libraryExpr) {
                comment = libraryExpr;
              }
            }

            instructions.push({
              address,
              bytes: "",
              opcode,
              operands: operands
                ? operands.split(",").map((op) => ({
                    type: "reg" as const,
                    value: op.trim(),
                  }))
                : [],
              comment,
              active: false,
              breakpoint: false,
              jumpTarget: false,
            });
            return;
          }

          // Final fallback for unparseable lines
          instructions.push({
            address: `0x${(baseAddress + index * 4).toString(16)}`,
            bytes: "",
            opcode: "unknown",
            operands: [],
            comment: line,
            active: false,
            breakpoint: false,
            jumpTarget: false,
          });
        } catch (lineErr) {
          console.warn(
            `Failed to parse disassembly line ${index}: ${line}`,
            lineErr
          );
          // Return a safe fallback instruction
          instructions.push({
            address: `0x${(baseAddress + index * 4).toString(16)}`,
            bytes: "",
            opcode: "error",
            operands: [],
            comment: `Parse error: ${line}`,
            active: false,
            breakpoint: false,
            jumpTarget: false,
          });
        }
      });

      return instructions.filter((instruction) => instruction !== null);
    } catch (err) {
      console.error("Failed to parse disassembly text:", err);
      return [];
    }
  };

  // Load disassembly at specific address using Tauri
  const loadDisassemblyAtAddress = useCallback(
    async (address: number) => {
      if (!mountedRef.current) {
        console.log(
          "AssemblyView: Component not mounted, skipping disassembly load"
        );
        return;
      }

      // Allow new address loads even while loading (cancel previous load)
      // Only prevent duplicate loads of the exact same address
      if (loading && currentBaseAddress === address) {
        console.log(
          `AssemblyView: Already loading same address 0x${address.toString(16)}, skipping duplicate load`
        );
        return;
      }

      if (loading) {
        console.log(
          `AssemblyView: Currently loading different address, proceeding with new address 0x${address.toString(16)}`
        );
      }

      const loadStartTime = performance.now();
      console.log(
        `AssemblyView: Starting Tauri disassembly load for address 0x${address.toString(16)} at ${new Date().toISOString()}`
      );
      console.log(
        `AssemblyView: Current state - loading: ${loading}, isTransitioning: ${isTransitioning}, instructions.length: ${instructions.length}`
      );

      // Set transition state to prevent flickering
      setIsTransitioning(true);

      if (mountedRef.current) {
        setLoading(true);
        setError(null);
        // Don't clear instructions immediately to prevent flickering
        // They will be updated once new data is loaded
      }

      const timeoutId = setTimeout(() => {
        if (!mountedRef.current) return;
        console.error("AssemblyView: Request timeout after 10 seconds");
        setError("Request timeout - server may be unresponsive");
        setLoading(false);
      }, 10000);

      try {
        // Determine architecture from serverInfo, default to arm64 for iOS/macOS
        const architecture = serverInfo?.arch || "arm64";
        const memorySize = bufferSize; // Use smaller buffer for faster loading

        console.log(
          "AssemblyView: Reading optimized memory buffer first, then disassembling locally"
        );

        // First, read memory from server using API client (with ptrace for debugger)
        const apiClient = getApiClient();
        const memoryReadStart = performance.now();
        const memoryBuffer = await apiClient.readMemory(
          `0x${address.toString(16)}`,
          memorySize,
          true // use ptrace for debugger memory read
        );
        console.log(
          `AssemblyView: Memory read took ${(performance.now() - memoryReadStart).toFixed(2)}ms`
        );

        // Convert ArrayBuffer to Uint8Array, then to regular array
        const memoryData = Array.from(new Uint8Array(memoryBuffer));

        console.log(
          "AssemblyView: Memory read successful, sending to Tauri for disassembly:",
          { address, memorySize, dataLength: memoryData.length }
        );

        // Use new Tauri function that takes memory data directly
        const disasmStart = performance.now();
        const response: DisassembleResponse = await invoke(
          "disassemble_memory_direct",
          {
            memoryData,
            address,
            architecture,
          }
        );
        console.log(
          `AssemblyView: Tauri disassemble took ${(performance.now() - disasmStart).toFixed(2)}ms`
        );

        console.log(
          "AssemblyView: Received Tauri disassemble response:",
          response
        );

        if (!mountedRef.current) {
          console.log(
            "AssemblyView: Component unmounted during request, ignoring response"
          );
          return;
        }

        if (response.success && response.disassembly) {
          console.log("AssemblyView: Parsing disassembly data...");
          const parsedInstructions = parseDisassembly(
            response.disassembly,
            address
          );
          console.log(
            `AssemblyView: Parsed ${parsedInstructions.length} instructions in ${(performance.now() - loadStartTime).toFixed(2)}ms total`
          );

          if (parsedInstructions.length > 0) {
            // Find the requested address in the parsed instructions
            const requestedIndex = parsedInstructions.findIndex(
              (instr) =>
                parseInt(instr.address.replace("0x", ""), 16) === address
            );

            // Store all instructions in buffer
            setInstructionBuffer(parsedInstructions);
            setCurrentBaseAddress(
              parseInt(parsedInstructions[0].address.replace("0x", ""), 16)
            );

            // Set viewport to show requested address at the top
            if (requestedIndex !== -1) {
              setViewportStart(requestedIndex);
              const viewportInstructions = parsedInstructions.slice(
                requestedIndex,
                requestedIndex + viewportSize
              );
              setInstructions(viewportInstructions);
            } else {
              // Fallback: show from beginning
              setViewportStart(0);
              const viewportInstructions = parsedInstructions.slice(
                0,
                viewportSize
              );
              setInstructions(viewportInstructions);
            }

            setIsTransitioning(false);
            console.log(
              `AssemblyView: Loaded buffer from 0x${parsedInstructions[0].address}, showing viewport at requested 0x${address.toString(16)}`
            );
          } else {
            console.warn(
              "AssemblyView: No instructions parsed from disassembly data"
            );
            setError("No valid instructions found at this address");
            // Only clear instructions if we don't have previous ones to show
            if (instructions.length === 0) {
              setInstructions([]);
              setInstructionBuffer([]);
            }
            setIsTransitioning(false);
          }
        } else {
          console.error("AssemblyView: Tauri API failure:", response);
          setError(response.error || "Failed to disassemble memory");

          // Only clear instructions if we don't have previous ones to show
          if (instructions.length === 0) {
            setInstructions([]);
            setInstructionBuffer([]);
          }
          setIsTransitioning(false);
        }
      } catch (err) {
        console.error("AssemblyView: Tauri disassembly error:", err);

        if (!mountedRef.current) {
          console.log(
            "AssemblyView: Component unmounted during error handling"
          );
          return;
        }

        if (err instanceof Error) {
          setError(`Error: ${err.message}`);
        } else {
          setError("Unknown error occurred during disassembly");
        }

        // Only clear instructions if we don't have previous ones to show
        if (instructions.length === 0) {
          setInstructions([]);
          setInstructionBuffer([]);
        }
        setIsTransitioning(false);
      } finally {
        clearTimeout(timeoutId);

        if (mountedRef.current) {
          console.log(
            "AssemblyView: Tauri disassembly load completed, setting loading to false"
          );
          setLoading(false);
          setIsTransitioning(false);
        }
      }
    },
    [bufferSize, serverInfo, viewportSize, parseAddress]
  );

  // Prefetch memory chunks around current address for seamless scrolling
  const prefetchMemoryChunks = useCallback(
    async (centerAddress: number) => {
      // Check loading state at the time of execution
      if (!mountedRef.current) return;

      setLoading(true);

      try {
        const chunks: Array<{ address: number; instructions: Instruction[] }> =
          [];

        // Prefetch chunks above and below current address
        const addresses = [
          Math.max(0, centerAddress - prefetchDistance * 2), // Far above
          Math.max(0, centerAddress - prefetchDistance), // Near above
          centerAddress + prefetchDistance, // Near below
          centerAddress + prefetchDistance * 2, // Far below
        ];

        for (const address of addresses) {
          if (address < 0) continue;

          try {
            // Check current prefetch buffers at execution time
            setPrefetchBuffers((currentBuffers) => {
              // If we already have this chunk, skip
              if (currentBuffers.has(address)) return currentBuffers;

              // Perform async loading
              (async () => {
                try {
                  const apiClient = getApiClient();
                  const memoryBuffer = await apiClient.readMemory(
                    `0x${address.toString(16)}`,
                    bufferSize,
                    true // use ptrace for debugger memory read
                  );

                  const memoryData = Array.from(new Uint8Array(memoryBuffer));
                  const architecture = serverInfo?.arch || "arm64";

                  const response: DisassembleResponse = await invoke(
                    "disassemble_memory_direct",
                    {
                      memoryData,
                      address,
                      architecture,
                    }
                  );

                  if (response.success && response.disassembly) {
                    const parsedInstructions = parseDisassembly(
                      response.disassembly,
                      address
                    );
                    chunks.push({ address, instructions: parsedInstructions });

                    // Update buffers with new data
                    setPrefetchBuffers((prev) => {
                      const newBuffers = new Map(prev);
                      newBuffers.set(address, parsedInstructions);

                      // Limit buffer size to prevent memory bloat
                      if (newBuffers.size > 8) {
                        const entries = Array.from(newBuffers.entries());
                        entries.sort(
                          (a, b) =>
                            Math.abs(a[0] - centerAddress) -
                            Math.abs(b[0] - centerAddress)
                        );

                        const newLimitedBuffers = new Map();
                        entries.slice(0, 8).forEach(([addr, instr]) => {
                          newLimitedBuffers.set(addr, instr);
                        });

                        return newLimitedBuffers;
                      }

                      return newBuffers;
                    });
                  }
                } catch (err) {
                  console.warn(
                    `Failed to prefetch chunk at 0x${address.toString(16)}:`,
                    err
                  );
                }
              })();

              return currentBuffers;
            });
          } catch (err) {
            console.warn(
              `Failed to prefetch chunk at 0x${address.toString(16)}:`,
              err
            );
          }
        }
      } catch (err) {
        console.error("Prefetch failed:", err);
      } finally {
        setLoading(false);
      }
    },
    [prefetchDistance, bufferSize]
  );

  // Enhanced load disassembly with prefetch integration
  const loadDisassemblyAtAddressWithPrefetch = useCallback(
    async (address: number, skipPrefetch = false) => {
      // First load the main chunk
      await loadDisassemblyAtAddress(address);

      // Then prefetch surrounding chunks in background
      if (!skipPrefetch) {
        setTimeout(() => {
          prefetchMemoryChunks(address);
        }, 100); // Small delay to prioritize main loading
      }
    },
    [loadDisassemblyAtAddress, prefetchMemoryChunks]
  );

  // Enhanced smooth scroll up with prefetch buffer integration
  const scrollUp = useCallback(async () => {
    if (loading) return;

    // Use smaller scroll increment for smoother performance
    const scrollIncrement = 3; // Reduced from 5 to 3

    // Try to find prefetched data first
    if (viewportStart <= scrollIncrement && instructionBuffer.length > 0) {
      const firstInstruction = instructionBuffer[0];
      const firstAddress = parseInt(
        firstInstruction.address.replace("0x", ""),
        16
      );
      const targetAddress = Math.max(0, firstAddress - prefetchDistance);

      // Check if we have prefetched data for this address
      const prefetchedInstructions = prefetchBuffers.get(targetAddress);
      if (prefetchedInstructions && prefetchedInstructions.length > 0) {
        // Use prefetched data seamlessly
        const combinedInstructions = [
          ...prefetchedInstructions,
          ...instructionBuffer,
        ];
        setInstructionBuffer(combinedInstructions);
        const newViewportStart = prefetchedInstructions.length - 10; // Position near the transition
        setViewportStart(newViewportStart);
        const viewportInstructions = combinedInstructions.slice(
          newViewportStart,
          newViewportStart + viewportSize
        );
        setInstructions(viewportInstructions);

        // Update base address to the first instruction in combined buffer
        if (combinedInstructions.length > 0) {
          const firstInstructionAddress = parseInt(
            combinedInstructions[0].address.replace("0x", ""),
            16
          );
          setCurrentBaseAddress(firstInstructionAddress);
        }

        // Remove used prefetch data and trigger new prefetch
        setPrefetchBuffers((prev) => {
          const newBuffers = new Map(prev);
          newBuffers.delete(targetAddress);
          return newBuffers;
        });

        // Trigger new prefetch for the new position
        setTimeout(() => prefetchMemoryChunks(targetAddress), 50);
        return;
      }

      // No prefetch - load more data but maintain current position
      const newStartAddress = Math.max(0, firstAddress - bufferSize / 2);
      if (newStartAddress < firstAddress) {
        // Load data from newStartAddress, but keep firstAddress in viewport
        setLoading(true);
        try {
          const apiClient = getApiClient();
          const memoryBuffer = await apiClient.readMemory(
            `0x${newStartAddress.toString(16)}`,
            bufferSize,
            true // use ptrace for debugger memory read
          );
          const memoryData = Array.from(new Uint8Array(memoryBuffer));
          const architecture = serverInfo?.arch || "arm64";
          const response: DisassembleResponse = await invoke(
            "disassemble_memory_direct",
            { memoryData, address: newStartAddress, architecture }
          );

          if (response.success && response.disassembly) {
            const parsedInstructions = parseDisassembly(
              response.disassembly,
              newStartAddress
            );
            if (parsedInstructions.length > 0) {
              // Find where firstAddress is in the new buffer
              const firstAddressIndex = parsedInstructions.findIndex(
                (instr) =>
                  parseInt(instr.address.replace("0x", ""), 16) === firstAddress
              );

              setInstructionBuffer(parsedInstructions);
              setCurrentBaseAddress(newStartAddress);

              if (firstAddressIndex !== -1) {
                // Keep firstAddress at top of viewport
                setViewportStart(firstAddressIndex);
                const viewportInstructions = parsedInstructions.slice(
                  firstAddressIndex,
                  firstAddressIndex + viewportSize
                );
                setInstructions(viewportInstructions);
              }

              setTimeout(() => prefetchMemoryChunks(newStartAddress), 100);
            }
          }
        } catch (error) {
          // Memory read failed - continue with existing buffer if possible
          console.warn("Failed to load more data during scroll up:", error);
          // Try to scroll within existing buffer anyway
          const newViewportStart = Math.max(0, viewportStart - scrollIncrement);
          if (newViewportStart !== viewportStart) {
            setViewportStart(newViewportStart);
            const viewportInstructions = instructionBuffer.slice(
              newViewportStart,
              newViewportStart + viewportSize
            );
            setInstructions(viewportInstructions);
          }
        } finally {
          setLoading(false);
        }
        return;
      }
    }

    // Use existing buffer data for smooth scrolling
    const newViewportStart = Math.max(0, viewportStart - scrollIncrement);
    setViewportStart(newViewportStart);
    const viewportInstructions = instructionBuffer.slice(
      newViewportStart,
      newViewportStart + viewportSize
    );
    setInstructions(viewportInstructions);
  }, [
    currentBaseAddress,
    loading,
    bufferSize,
    prefetchDistance,
    prefetchBuffers,
    loadDisassemblyAtAddressWithPrefetch,
    prefetchMemoryChunks,
    setPrefetchBuffers,
    viewportStart,
    instructionBuffer,
    viewportSize,
  ]);

  // Enhanced smooth scroll down with prefetch buffer integration
  const scrollDown = useCallback(async () => {
    if (loading) return;

    const scrollIncrement = 3; // Reduced from 5 to 3 for smoother performance
    const newViewportStart = viewportStart + scrollIncrement;

    // Check if we need more data and have prefetched buffer
    if (newViewportStart + viewportSize + 10 > instructionBuffer.length) {
      const lastInstruction = instructionBuffer[instructionBuffer.length - 1];
      const lastAddress = parseInt(
        lastInstruction.address.replace("0x", ""),
        16
      );
      const targetAddress = lastAddress + prefetchDistance;

      // Check if we have prefetched data for this address
      const prefetchedInstructions = prefetchBuffers.get(targetAddress);
      if (prefetchedInstructions && prefetchedInstructions.length > 0) {
        // Use prefetched data seamlessly
        const combinedInstructions = [
          ...instructionBuffer,
          ...prefetchedInstructions,
        ];
        setInstructionBuffer(combinedInstructions);
        setViewportStart(newViewportStart);
        const viewportInstructions = combinedInstructions.slice(
          newViewportStart,
          newViewportStart + viewportSize
        );
        setInstructions(viewportInstructions);

        // Update base address to the first instruction in combined buffer
        if (combinedInstructions.length > 0) {
          const firstInstructionAddress = parseInt(
            combinedInstructions[0].address.replace("0x", ""),
            16
          );
          setCurrentBaseAddress(firstInstructionAddress);
        }

        // Remove used prefetch data and trigger new prefetch
        setPrefetchBuffers((prev) => {
          const newBuffers = new Map(prev);
          newBuffers.delete(targetAddress);
          return newBuffers;
        });

        // Trigger new prefetch for the new position
        setTimeout(() => prefetchMemoryChunks(targetAddress), 50);
        return;
      }

      // No prefetch - load more data from the end of current buffer
      const newStartAddress = lastAddress + 4; // Start from the next instruction after current buffer
      setLoading(true);
      try {
        const apiClient = getApiClient();
        const memoryBuffer = await apiClient.readMemory(
          `0x${newStartAddress.toString(16)}`,
          bufferSize,
          true // use ptrace for debugger memory read
        );
        const memoryData = Array.from(new Uint8Array(memoryBuffer));
        const architecture = serverInfo?.arch || "arm64";
        const response: DisassembleResponse = await invoke(
          "disassemble_memory_direct",
          { memoryData, address: newStartAddress, architecture }
        );

        if (response.success && response.disassembly) {
          const parsedInstructions = parseDisassembly(
            response.disassembly,
            newStartAddress
          );
          if (parsedInstructions.length > 0) {
            // Append new instructions to existing buffer instead of replacing
            const combinedInstructions = [
              ...instructionBuffer,
              ...parsedInstructions,
            ];
            setInstructionBuffer(combinedInstructions);
            // Keep the base address as the first instruction
            const firstInstructionAddress = parseInt(
              combinedInstructions[0].address.replace("0x", ""),
              16
            );
            setCurrentBaseAddress(firstInstructionAddress);
            // Now scroll down with the combined buffer
            setViewportStart(newViewportStart);
            const viewportInstructions = combinedInstructions.slice(
              newViewportStart,
              newViewportStart + viewportSize
            );
            setInstructions(viewportInstructions);

            setTimeout(() => prefetchMemoryChunks(newStartAddress), 100);
          }
        }
      } catch (error) {
        // Memory read failed - continue with existing buffer if possible
        console.warn("Failed to load more data during scroll down:", error);
        // Try to scroll within existing buffer anyway (up to the end)
        const maxViewportStart = Math.max(
          0,
          instructionBuffer.length - viewportSize
        );
        const clampedViewportStart = Math.min(
          newViewportStart,
          maxViewportStart
        );
        if (clampedViewportStart !== viewportStart) {
          setViewportStart(clampedViewportStart);
          const viewportInstructions = instructionBuffer.slice(
            clampedViewportStart,
            clampedViewportStart + viewportSize
          );
          setInstructions(viewportInstructions);
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    // Use existing buffer data for smooth scrolling
    setViewportStart(newViewportStart);
    const viewportInstructions = instructionBuffer.slice(
      newViewportStart,
      newViewportStart + viewportSize
    );
    setInstructions(viewportInstructions);
  }, [
    loading,
    bufferSize,
    prefetchDistance,
    prefetchBuffers,
    loadDisassemblyAtAddressWithPrefetch,
    prefetchMemoryChunks,
    setPrefetchBuffers,
    viewportStart,
    instructionBuffer,
    viewportSize,
  ]);

  // Track the last loaded function address to prevent re-triggering on scroll
  // Removed: No longer needed as we handle address changes reactively

  // Load disassembly when function is selected or address changes
  useEffect(() => {
    console.log(
      `AssemblyView: useEffect triggered - assemblyAddress: ${assemblyAddress}, serverInfo:`,
      serverInfo,
      `mounted: ${mountedRef.current}`
    );

    if (assemblyAddress && mountedRef.current) {
      try {
        const address = parseAddress(assemblyAddress);
        if (!isNaN(address) && address > 0) {
          // If currently loading, queue this navigation for later (only in break state)
          if (loading && currentBaseAddress !== address && isInBreakState) {
            console.log(
              `[MAIN USEEFFECT] Currently loading in break state, queueing navigation to ${assemblyAddress} for after load completes`
            );
            setPendingNavigationAddress(assemblyAddress);
            return;
          }

          // Skip if already loading the same address
          if (loading && currentBaseAddress === address) {
            console.log(
              `[MAIN USEEFFECT] Already loading address ${assemblyAddress}, skipping duplicate load`
            );
            return;
          }

          console.log(
            `[MAIN USEEFFECT] Loading disassembly for address ${assemblyAddress} (0x${address.toString(16)})`
          );

          // Check if the target address is already within the current instruction buffer
          const targetAddressInBuffer = instructionBuffer.find(
            (instruction) =>
              normalizeAddress(instruction.address) ===
              normalizeAddress(assemblyAddress)
          );

          if (targetAddressInBuffer) {
            // Address is in buffer, just adjust viewport to show it
            console.log(
              `[MAIN USEEFFECT] Target address ${assemblyAddress} found in buffer, adjusting viewport`
            );
            const targetIndex = instructionBuffer.findIndex(
              (instruction) =>
                normalizeAddress(instruction.address) ===
                normalizeAddress(assemblyAddress)
            );

            if (targetIndex !== -1) {
              // Set target address at the TOP of viewport (index 0), not centered
              const newViewportStart = targetIndex;
              setViewportStart(newViewportStart);

              const viewportInstructions = instructionBuffer.slice(
                newViewportStart,
                newViewportStart + viewportSize
              );
              setInstructions(viewportInstructions);

              // Always update base address to the first instruction in buffer
              if (instructionBuffer.length > 0) {
                const firstInstructionAddress = parseInt(
                  instructionBuffer[0].address.replace("0x", ""),
                  16
                );
                setCurrentBaseAddress(firstInstructionAddress);
              }

              console.log(
                `[MAIN USEEFFECT] Viewport adjusted to show address ${assemblyAddress} at TOP (index ${targetIndex})`
              );
              return;
            }
          }

          // Target address not in buffer or buffer is empty, need to reload
          console.log(
            `[MAIN USEEFFECT] Target address ${assemblyAddress} not in buffer, reloading disassembly`
          );

          // Reset buffer and viewport when going to new address
          setInstructionBuffer([]);
          setViewportStart(0);
          setInstructions([]);
          setPrefetchBuffers(new Map()); // Clear prefetch buffers

          // Use regular loading and then prefetch
          loadDisassemblyAtAddress(address);
        } else {
          console.warn(
            `AssemblyView: Invalid function address: ${assemblyAddress}`
          );
          setError("");
          setInstructions([]);
          setInstructionBuffer([]);
          setPrefetchBuffers(new Map());
          setLoading(false);
        }
      } catch (err) {
        console.error("Address parsing error:", err);
        setError("Failed to parse function address");
        setInstructions([]);
        setInstructionBuffer([]);
        setPrefetchBuffers(new Map());
        setLoading(false);
      }
    } else {
      console.log(
        "AssemblyView: No function address provided or component not mounted, showing empty state"
      );
      setInstructions([]);
      setInstructionBuffer([]);
      setPrefetchBuffers(new Map());
      setError(null);
      setLoading(false);
    }
  }, [
    assemblyAddress, // React to address changes from global store
    assemblyNavigationTrigger, // Force re-execution for same address navigation
    serverInfo?.arch, // Only watch arch changes, not the entire serverInfo object
    isVisible, // React to visibility changes
    // Removed dependencies that cause infinite loops:
    // - normalizeAddress (useCallback, stable reference)
    // - loadDisassemblyAtAddress (useCallback, stable reference)
    // - loading (changes during effect execution, causes infinite loop)
    // - currentBaseAddress (changes during scroll/effect, causes infinite loop)
  ]);

  // Process pending navigation when loading completes (only in break state)
  useEffect(() => {
    if (
      !loading &&
      pendingNavigationAddress &&
      mountedRef.current &&
      isInBreakState
    ) {
      console.log(
        `[PENDING NAV] Loading completed in break state, processing pending navigation to ${pendingNavigationAddress}`
      );
      const pendingAddr = pendingNavigationAddress;
      setPendingNavigationAddress(null);

      try {
        const pendingAddrNum = parseAddress(pendingAddr);
        if (!isNaN(pendingAddrNum) && pendingAddrNum > 0) {
          // Trigger navigation by updating the address
          setTimeout(() => {
            setAssemblyAddress(pendingAddr);
          }, 50);
        }
      } catch (err) {
        console.error("Failed to process pending navigation:", err);
      }
    }
    // Clear pending navigation if we exit break state
    if (!isInBreakState && pendingNavigationAddress) {
      console.log(
        `[PENDING NAV] Exited break state, clearing pending navigation to ${pendingNavigationAddress}`
      );
      setPendingNavigationAddress(null);
    }
  }, [loading, pendingNavigationAddress, parseAddress, isInBreakState]);

  // Handle breakpoint toggle with improved debouncing and state management
  const toggleBreakpoint = useCallback(
    async (address: string) => {
      const timestamp = new Date().toISOString();

      // Improved debounce mechanism with shorter timeout and better state tracking
      const key = `toggle_${address}`;
      if ((window as any)[key]) {
        console.log(
          `[${timestamp}] DEBOUNCE: Ignoring duplicate toggle for ${address}`
        );
        return;
      }
      (window as any)[key] = true;
      setTimeout(() => delete (window as any)[key], 500); // Reduced from 1000ms to 500ms

      try {
        console.log(`=== TOGGLE BREAKPOINT START [${timestamp}] ===`);
        console.log("Address:", address);
        console.log("Current breakpoints state:", Array.from(breakpoints));

        const addressNum = parseInt(address.replace("0x", ""), 16);

        if (isNaN(addressNum)) {
          console.error("Invalid address format:", address);
          delete (window as any)[key];
          return;
        }

        // Get the current state snapshot to avoid race conditions
        const currentBreakpointsSnapshot = new Set(breakpoints);
        console.log(
          "Snapshot of breakpoints:",
          Array.from(currentBreakpointsSnapshot)
        );

        if (currentBreakpointsSnapshot.has(address)) {
          // Remove breakpoint - delegate to parent callback which handles API call
          console.log(
            `[${timestamp}] REMOVING breakpoint at:`,
            address,
            "numeric:",
            addressNum
          );
          // Call onBreakpointRemove callback - parent will call API
          if (onBreakpointRemove) {
            console.log(`[${timestamp}] Calling onBreakpointRemove callback`);
            onBreakpointRemove(address);
          }
        } else {
          // Set breakpoint - delegate to parent callback which handles API call
          console.log(
            `[${timestamp}] SETTING breakpoint at:`,
            address,
            "numeric:",
            addressNum,
            "isSoftware:",
            isSoftwareBreakpoint
          );
          // Call onBreakpointSet callback - parent will call API
          if (onBreakpointSet) {
            console.log(
              `[${timestamp}] Calling onBreakpointSet callback with isSoftware:`,
              isSoftwareBreakpoint
            );
            onBreakpointSet(address, isSoftwareBreakpoint);
          }
        }
        console.log(`=== TOGGLE BREAKPOINT END [${timestamp}] ===`);
      } catch (error) {
        addLog(
          "ERROR",
          "BREAKPOINT",
          `Failed to toggle breakpoint at ${address}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        console.error("Failed to toggle breakpoint:", error);
      } finally {
        // Ensure cleanup happens with a small delay
        setTimeout(() => delete (window as any)[key], 100);
      }
    },
    [onBreakpointSet, onBreakpointRemove, addLog, isSoftwareBreakpoint]
  );

  // Handle breakpoint column click with additional safeguards
  const handleBreakpointClick = useCallback(
    (address: string, event: React.MouseEvent) => {
      console.log("=== BREAKPOINT COLUMN CLICKED ===");
      console.log("Address:", address);
      console.log("Event target:", event.target);
      console.log("Event currentTarget:", event.currentTarget);
      console.log(
        "Current breakpoints before toggle:",
        Array.from(breakpoints)
      );

      // Prevent all event propagation
      event.stopPropagation();
      event.preventDefault();

      // Add a small delay to ensure UI state is stable
      setTimeout(() => {
        toggleBreakpoint(address);
      }, 50);
    },
    [toggleBreakpoint]
  );

  // Sync DecompileView for a given address (no assembly navigation)
  const syncDecompileView = useCallback(
    async (address: string) => {
      console.log(
        `[SYNC DECOMPILE] syncDecompileView called with address: ${address}`
      );

      // Notify parent about address click for DecompileView sync
      if (onAssemblyAddressClicked) {
        onAssemblyAddressClicked(address);
      }

      // If Decompile View is visible and the library is analyzed, trigger decompile for the function at this address
      console.log(
        `[SYNC DECOMPILE] isDecompileVisible: ${isDecompileVisible}, attachedModules.length: ${attachedModules.length}, onDecompileRequest: ${!!onDecompileRequest}`
      );

      if (isDecompileVisible && onDecompileRequest && attachedModules.length) {
        // Find the module for this address
        let numericAddress: number;
        if (address.startsWith("0x") || address.startsWith("0X")) {
          numericAddress = parseInt(address, 16);
        } else {
          numericAddress = parseInt(address, 10);
        }

        console.log(
          `[SYNC DECOMPILE] Parsed numeric address: 0x${numericAddress.toString(16)}`
        );

        if (!isNaN(numericAddress)) {
          for (const module of attachedModules) {
            const moduleBase = module.base;
            const moduleEnd = moduleBase + module.size;

            if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
              const modulePath = module.modulename || module.name || "";
              console.log(
                `[SYNC DECOMPILE] Found module: ${modulePath}, base: 0x${moduleBase.toString(16)}`
              );

              // Check if this library is analyzed
              const analyzed = isLibraryAnalyzed(modulePath);
              console.log(`[SYNC DECOMPILE] Library analyzed: ${analyzed}`);

              if (analyzed) {
                // Get function info from the detail text
                const rawFunctionName = getModuleDetailText
                  ? getModuleDetailText(address)
                  : null;

                // Check if we're inside a function (contains @ symbol) or if library is analyzed
                // We'll let Ghidra find the function containing this address
                const clickedOffset = numericAddress - moduleBase;
                let offsetHex = `0x${clickedOffset.toString(16)}`;
                console.log(
                  `[SYNC DECOMPILE] Offset: ${offsetHex}, rawFunctionName: ${rawFunctionName}`
                );

                const moduleName =
                  modulePath.split(/[/\\]/).pop() || modulePath;
                const osKey = serverInfo?.target_os || "unknown";

                // Try to find function start from instructionBuffer for cache lookup
                if (rawFunctionName && rawFunctionName.includes("@")) {
                  const clickedIndex = instructionBuffer.findIndex(
                    (instr) =>
                      parseInt(instr.address.replace(/^0x/i, ""), 16) ===
                      numericAddress
                  );

                  console.log(
                    `[SYNC DECOMPILE] Looking for address ${numericAddress.toString(16)} in instructionBuffer (${instructionBuffer.length} entries), found at index: ${clickedIndex}`
                  );

                  if (clickedIndex >= 0) {
                    // Find the function start by scanning backward for isFunctionStart
                    let functionStartIndex = clickedIndex;
                    for (let i = clickedIndex; i >= 0; i--) {
                      if (instructionBuffer[i].isFunctionStart) {
                        functionStartIndex = i;
                        break;
                      }
                    }

                    console.log(
                      `[SYNC DECOMPILE] Function start found at index ${functionStartIndex}, address: ${instructionBuffer[functionStartIndex]?.address}`
                    );

                    const startInstruction =
                      instructionBuffer[functionStartIndex];
                    if (startInstruction) {
                      const startAddress = parseInt(
                        startInstruction.address.replace(/^0x/i, ""),
                        16
                      );
                      const functionStartOffset = startAddress - moduleBase;
                      const newOffsetHex = `0x${functionStartOffset.toString(16)}`;
                      console.log(
                        `[SYNC DECOMPILE] Calculated function start offset: ${newOffsetHex} (was ${offsetHex})`
                      );
                      offsetHex = newOffsetHex;
                    }
                  } else {
                    // Address not in instructionBuffer - use the clicked offset directly
                    // Ghidra will find the containing function
                    console.log(
                      `[SYNC DECOMPILE] Address not in buffer, using offset directly: ${offsetHex}`
                    );
                  }
                }

                // Get saved Ghidra path from localStorage
                const savedGhidraPath = localStorage.getItem(GHIDRA_PATH_KEY);
                if (!savedGhidraPath) {
                  addLog(
                    "WARN",
                    "GHIDRA",
                    "Ghidra path not configured. Please set it in the Tools tab."
                  );
                  return;
                }

                console.log(
                  `[SYNC DECOMPILE] Final offset for decompile: ${offsetHex}, checking cache...`
                );

                // Check cache first
                const cachedResult = await getDecompileFromCache(
                  osKey,
                  moduleName,
                  offsetHex
                );
                console.log(
                  `[SYNC DECOMPILE] Cache result:`,
                  cachedResult
                    ? `found (function: ${cachedResult.function_name})`
                    : "not found"
                );

                if (cachedResult?.success && cachedResult.decompiled_code) {
                  addLog(
                    "INFO",
                    "GHIDRA",
                    `Using cached decompile for: ${cachedResult.function_name || offsetHex}`
                  );
                  console.log(
                    `[SYNC DECOMPILE] Calling onDecompileRequest with cached result, offset: ${offsetHex}`
                  );
                  onDecompileRequest(
                    modulePath,
                    offsetHex,
                    cachedResult.function_name || null,
                    cachedResult.decompiled_code,
                    moduleBase,
                    cachedResult.line_mapping || null,
                    cachedResult.tokens || null
                  );
                  // Clear any previous error on success
                  onDecompileError?.(null);
                  return;
                }

                addLog(
                  "INFO",
                  "GHIDRA",
                  `Starting decompilation at offset: ${offsetHex}`
                );

                console.log(
                  `[SYNC DECOMPILE] No cache, calling decompileFunction with offset: ${offsetHex}`
                );
                const result = await decompileFunction(
                  modulePath,
                  offsetHex,
                  savedGhidraPath
                );

                console.log(
                  `[SYNC DECOMPILE] decompileFunction result:`,
                  result
                    ? `success=${result.success}, function=${result.function_name}`
                    : "null"
                );

                if (result?.success && result.decompiled_code) {
                  addLog(
                    "INFO",
                    "GHIDRA",
                    `Decompilation completed for: ${result.function_name || offsetHex}`
                  );

                  // Save to cache
                  await saveDecompileToCache(
                    osKey,
                    moduleName,
                    offsetHex,
                    result.function_name || "",
                    result.decompiled_code,
                    result.line_mapping
                  );

                  console.log(
                    `[SYNC DECOMPILE] Calling onDecompileRequest with new result, offset: ${offsetHex}, function: ${result.function_name}`
                  );
                  onDecompileRequest(
                    modulePath,
                    offsetHex,
                    result.function_name || null,
                    result.decompiled_code,
                    moduleBase,
                    result.line_mapping || null,
                    result.tokens || null
                  );
                  // Clear any previous error on success
                  onDecompileError?.(null);
                } else {
                  const errorMsg = result?.error || "Unknown error";
                  addLog("WARN", "GHIDRA", `Decompilation failed: ${errorMsg}`);
                  onDecompileError?.(errorMsg);
                }
              }
              break;
            }
          }
        }
      }
    },
    [
      onAssemblyAddressClicked,
      isDecompileVisible,
      onDecompileRequest,
      onDecompileError,
      attachedModules,
      isLibraryAnalyzed,
      getModuleDetailText,
      instructionBuffer,
      serverInfo?.target_os,
      getDecompileFromCache,
      decompileFunction,
      saveDecompileToCache,
      addLog,
    ]
  );

  // Handle click on instruction area (Bytes, Instruction columns) - sync DecompileView only, no assembly navigation
  const handleInstructionAreaClick = useCallback(
    async (address: string, event?: React.MouseEvent) => {
      if (event) {
        event.stopPropagation();
      }
      // Only sync DecompileView, don't navigate assembly
      await syncDecompileView(address);
    },
    [syncDecompileView]
  );

  // Sync decompile view when break address changes (for single step / breakpoint hit)
  // This is a separate useEffect because syncDecompileView is defined after the single step useEffect
  const lastSyncedDecompileAddressRef = useRef<string | null>(null);
  useEffect(() => {
    console.log(
      `[DECOMPILE SYNC EFFECT] currentBreakAddress: ${currentBreakAddress}, isInBreakState: ${isInBreakState}, lastSynced: ${lastSyncedDecompileAddressRef.current}`
    );

    if (!currentBreakAddress || !isInBreakState) {
      console.log(
        `[DECOMPILE SYNC EFFECT] Skipping - no break address or not in break state`
      );
      lastSyncedDecompileAddressRef.current = null;
      return;
    }

    // Skip if we already synced this address
    if (lastSyncedDecompileAddressRef.current === currentBreakAddress) {
      console.log(
        `[DECOMPILE SYNC EFFECT] Skipping - already synced this address`
      );
      return;
    }

    // Check if the break address is in an analyzed library before syncing
    // Parse address to check which module it belongs to
    let numericAddress: number;
    if (
      currentBreakAddress.startsWith("0x") ||
      currentBreakAddress.startsWith("0X")
    ) {
      numericAddress = parseInt(currentBreakAddress, 16);
    } else {
      numericAddress = parseInt(currentBreakAddress, 10);
    }

    if (isNaN(numericAddress)) {
      console.log(`[DECOMPILE SYNC EFFECT] Skipping - invalid address`);
      return;
    }

    // Find the module containing this address
    let isInAnalyzedLibrary = false;
    for (const module of attachedModules) {
      const moduleBase = module.base;
      const moduleEnd = moduleBase + module.size;

      if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
        const modulePath = module.modulename || module.name || "";
        isInAnalyzedLibrary = isLibraryAnalyzed(modulePath);
        console.log(
          `[DECOMPILE SYNC EFFECT] Address is in module: ${modulePath}, analyzed: ${isInAnalyzedLibrary}`
        );
        break;
      }
    }

    if (!isInAnalyzedLibrary) {
      console.log(
        `[DECOMPILE SYNC EFFECT] Skipping - address not in analyzed library`
      );
      lastSyncedDecompileAddressRef.current = currentBreakAddress;
      return;
    }

    // Sync decompile view to the current break address (if analyzed and in a function)
    console.log(
      `[DECOMPILE SYNC] Syncing decompile view to break address: ${currentBreakAddress}`
    );
    syncDecompileView(currentBreakAddress);
    lastSyncedDecompileAddressRef.current = currentBreakAddress;
  }, [
    currentBreakAddress,
    isInBreakState,
    syncDecompileView,
    attachedModules,
    isLibraryAnalyzed,
  ]);

  const handleAddressClick = useCallback(
    async (address: string, event?: React.MouseEvent) => {
      console.log("=== ADDRESS COLUMN CLICKED ===");
      console.log("Address:", address);
      console.log("This should NOT trigger breakpoint toggle");
      // Stop event propagation to prevent double-click with instruction line
      if (event) {
        event.stopPropagation();
      }
      // Address click should navigate to that address (same as Go to Address)
      console.log("Address navigation clicked:", address);

      // Navigate to the clicked address with history tracking for Back button
      setAssemblyAddressWithHistory(address);

      // Sync DecompileView
      await syncDecompileView(address);
    },
    [setAssemblyAddressWithHistory, syncDecompileView]
  );

  // Context menu handler
  const handleContextMenu = useCallback(
    (address: string, instruction: Instruction, event: React.MouseEvent) => {
      event.preventDefault();
      setContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        address,
        instruction,
      });
    },
    []
  );

  const handleContextMenuClose = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Load signal configs when debugger settings dialog opens
  // Only load from server if localStorage is empty (first time)
  useEffect(() => {
    if (debuggerSettingsOpen) {
      // If we already have configs in localStorage, don't overwrite with server data
      if (signalConfigs.size > 0) {
        setLoadingSignals(false);
        return;
      }

      setLoadingSignals(true);
      const loadConfigs = async () => {
        try {
          const apiClient = getApiClient();
          const response = await apiClient.getSignalConfigs();
          console.log("Get signal configs response:", response);
          if (response.success && response.configs) {
            const configMap = new Map<
              number,
              { catch_signal: boolean; pass_signal: boolean }
            >();
            for (const cfg of response.configs) {
              configMap.set(cfg.signal, {
                catch_signal: cfg.catch_signal,
                pass_signal: cfg.pass_signal,
              });
            }
            setSignalConfigs(configMap);
          }
        } catch (error) {
          addLog(
            "ERROR",
            "SETTINGS",
            `Failed to load signal settings: ${error}`
          );
        } finally {
          setLoadingSignals(false);
        }
      };
      loadConfigs();
    }
  }, [debuggerSettingsOpen, addLog, signalConfigs.size]);

  // Helper to get config for a signal (with defaults)
  // Default: catch=false (don't stop), pass=false (suppress signal, like GDB)
  const getSignalConfig = useCallback(
    (signal: number) => {
      return (
        signalConfigs.get(signal) ?? { catch_signal: false, pass_signal: false }
      );
    },
    [signalConfigs]
  );

  const handleToggleSignalCatch = useCallback(
    async (signal: number) => {
      const current = getSignalConfig(signal);
      const newCatch = !current.catch_signal;

      try {
        const apiClient = getApiClient();
        const response = await apiClient.setSignalConfig(
          signal,
          newCatch,
          current.pass_signal
        );
        console.log("Signal config update response:", response);
        if (response.success && response.configs) {
          const configMap = new Map<
            number,
            { catch_signal: boolean; pass_signal: boolean }
          >();
          for (const cfg of response.configs) {
            configMap.set(cfg.signal, {
              catch_signal: cfg.catch_signal,
              pass_signal: cfg.pass_signal,
            });
          }
          setSignalConfigs(configMap);
          addLog(
            "INFO",
            "SETTINGS",
            `Signal ${signal}: catch=${newCatch}, pass=${current.pass_signal}`
          );
        } else if (response.success) {
          // Update local state if configs not in response
          setSignalConfigs((prev) => {
            const newMap = new Map(prev);
            newMap.set(signal, {
              catch_signal: newCatch,
              pass_signal: current.pass_signal,
            });
            return newMap;
          });
          addLog(
            "INFO",
            "SETTINGS",
            `Signal ${signal}: catch=${newCatch}, pass=${current.pass_signal}`
          );
        }
      } catch (error) {
        addLog("ERROR", "SETTINGS", `Failed to update signal: ${error}`);
      }
    },
    [getSignalConfig, addLog]
  );

  const handleToggleSignalPass = useCallback(
    async (signal: number) => {
      const current = getSignalConfig(signal);
      const newPass = !current.pass_signal;

      try {
        const apiClient = getApiClient();
        const response = await apiClient.setSignalConfig(
          signal,
          current.catch_signal,
          newPass
        );
        console.log("Signal config update response:", response);
        if (response.success && response.configs) {
          const configMap = new Map<
            number,
            { catch_signal: boolean; pass_signal: boolean }
          >();
          for (const cfg of response.configs) {
            configMap.set(cfg.signal, {
              catch_signal: cfg.catch_signal,
              pass_signal: cfg.pass_signal,
            });
          }
          setSignalConfigs(configMap);
          addLog(
            "INFO",
            "SETTINGS",
            `Signal ${signal}: catch=${current.catch_signal}, pass=${newPass}`
          );
        } else if (response.success) {
          // Update local state if configs not in response
          setSignalConfigs((prev) => {
            const newMap = new Map(prev);
            newMap.set(signal, {
              catch_signal: current.catch_signal,
              pass_signal: newPass,
            });
            return newMap;
          });
          addLog(
            "INFO",
            "SETTINGS",
            `Signal ${signal}: catch=${current.catch_signal}, pass=${newPass}`
          );
        }
      } catch (error) {
        addLog("ERROR", "SETTINGS", `Failed to update signal: ${error}`);
      }
    },
    [getSignalConfig, addLog]
  );

  // Copy address to clipboard
  const handleCopyAddress = useCallback(() => {
    if (contextMenu) {
      navigator.clipboard.writeText(contextMenu.address);
      addLog("INFO", "CLIPBOARD", `Copied address: ${contextMenu.address}`);
    }
    handleContextMenuClose();
  }, [contextMenu, addLog, handleContextMenuClose]);

  // Copy address as Module + offset format
  const handleCopyAddressWithOffset = useCallback(() => {
    if (contextMenu) {
      const address = contextMenu.address;
      let numericAddress: number;
      if (address.startsWith("0x") || address.startsWith("0X")) {
        numericAddress = parseInt(address, 16);
      } else {
        numericAddress = parseInt(address, 10);
      }

      if (!isNaN(numericAddress)) {
        for (const module of attachedModules) {
          const moduleBase = module.base;
          const moduleEnd = moduleBase + module.size;

          if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
            const offset = numericAddress - moduleBase;
            const fullModuleName =
              module.modulename || module.name || "unknown";
            const fileName =
              fullModuleName.split(/[\/\\]/).pop() || fullModuleName;
            const result = `${fileName}+0x${offset.toString(16)}`;
            navigator.clipboard.writeText(result);
            addLog("INFO", "CLIPBOARD", `Copied: ${result}`);
            handleContextMenuClose();
            return;
          }
        }
      }
      // Fallback to just the address if module not found
      navigator.clipboard.writeText(address);
      addLog("INFO", "CLIPBOARD", `Copied address: ${address}`);
    }
    handleContextMenuClose();
  }, [contextMenu, attachedModules, addLog, handleContextMenuClose]);

  // Copy instruction to clipboard
  const handleCopyInstruction = useCallback(() => {
    if (contextMenu) {
      const { instruction } = contextMenu;
      const text = `${instruction.address}: ${instruction.opcode} ${formatOperands(instruction.operands)}`;
      navigator.clipboard.writeText(text);
      addLog("INFO", "CLIPBOARD", `Copied instruction: ${text}`);
    }
    handleContextMenuClose();
  }, [contextMenu, addLog, handleContextMenuClose]);

  // Copy bytecode to clipboard
  const handleCopyBytecode = useCallback(() => {
    if (contextMenu) {
      const { instruction } = contextMenu;
      // Remove spaces from bytes for clean copy
      const bytecode = instruction.bytes.replace(/\s+/g, "");
      navigator.clipboard.writeText(bytecode);
      addLog("INFO", "CLIPBOARD", `Copied bytecode: ${bytecode}`);
    }
    handleContextMenuClose();
  }, [contextMenu, addLog, handleContextMenuClose]);

  // Replace instruction with NOP
  const handleReplaceWithNop = useCallback(async () => {
    if (!contextMenu) {
      handleContextMenuClose();
      return;
    }

    const { address, instruction } = contextMenu;
    const architecture = serverInfo?.arch || "arm64";

    // Calculate instruction size from bytes
    const bytesString = instruction.bytes.replace(/\s+/g, "");
    const instructionSize = bytesString.length / 2; // Each byte is 2 hex characters

    let nopBytes: Uint8Array;
    let nopOpcode: string;
    let nopOperands: string;

    if (
      architecture === "x86_64" ||
      architecture === "x86" ||
      architecture === "i386"
    ) {
      // x86/x86_64: NOP is 0x90 (1 byte), repeat for instruction size
      nopBytes = new Uint8Array(instructionSize);
      nopBytes.fill(0x90);
      nopOpcode = "nop";
      nopOperands = "";
    } else {
      // ARM64: Use NOP instruction (0xD503201F) - 4 bytes
      nopBytes = new Uint8Array(4);
      // NOP instruction: 0x1F 0x20 0x03 0xD5 (little-endian for 0xD503201F)
      nopBytes[0] = 0x1f;
      nopBytes[1] = 0x20;
      nopBytes[2] = 0x03;
      nopBytes[3] = 0xd5;
      nopOpcode = "nop";
      nopOperands = "";
    }

    try {
      const apiClient = getApiClient();
      await apiClient.writeMemory(address, nopBytes.buffer as ArrayBuffer);

      const nopHex = Array.from(nopBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      addLog(
        "INFO",
        "PATCH",
        `Replaced instruction at ${address} with NOP: ${nopHex}`
      );

      // Create updated instruction
      const updatedInstr = {
        ...instruction,
        bytes: nopHex,
        opcode: nopOpcode,
        operands: nopOperands ? [{ type: "imm", value: nopOperands }] : [],
        comment: `; patched from: ${instruction.opcode} ${formatOperands(instruction.operands)}`,
      };

      // Update both instructionBuffer and instructions (display) state
      const updateInstructions = (prevList: Instruction[]) =>
        prevList.map((instr) =>
          instr.address === address ? updatedInstr : instr
        );

      setInstructionBuffer(updateInstructions);
      setInstructions(updateInstructions);
    } catch (error) {
      addLog(
        "ERROR",
        "PATCH",
        `Failed to replace with NOP at ${address}: ${error}`
      );
    }

    handleContextMenuClose();
  }, [contextMenu, serverInfo?.arch, addLog, handleContextMenuClose]);

  // Get current function boundaries for the context menu address
  const getContextMenuFunctionBounds = useCallback((): {
    startIndex: number;
    endIndex: number;
    functionName: string | null;
  } | null => {
    if (!contextMenu || !getModuleDetailText) return null;

    const address = contextMenu.address;
    const addressNum = parseInt(address.replace(/^0x/i, ""), 16);
    const rawFunctionName = getModuleDetailText(address);
    const functionName = rawFunctionName
      ? stripFunctionOffset(rawFunctionName)
      : null;

    // Only show function navigation if we're inside a named function (contains @)
    // e.g., "libc.so@open64" is a function, "libc.so + 0x1234" is not
    if (!functionName || !functionName.includes("@")) return null;

    const clickedIndex = instructionBuffer.findIndex(
      (instr) => parseInt(instr.address.replace(/^0x/i, ""), 16) === addressNum
    );

    if (clickedIndex === -1) return null;

    let startIndex = -1;
    let endIndex = -1;

    // Search backward for function start
    for (let i = clickedIndex; i >= 0; i--) {
      const instrFuncName = stripFunctionOffset(
        getModuleDetailText(instructionBuffer[i].address) || ""
      );
      if (instrFuncName !== functionName) {
        startIndex = i + 1;
        break;
      }
      if (i === 0) startIndex = 0;
    }

    // Search forward for function end
    for (let i = clickedIndex; i < instructionBuffer.length; i++) {
      const instrFuncName = stripFunctionOffset(
        getModuleDetailText(instructionBuffer[i].address) || ""
      );
      if (instrFuncName !== functionName) {
        endIndex = i - 1;
        break;
      }
      if (i === instructionBuffer.length - 1) endIndex = i;
    }

    if (startIndex === -1 || endIndex === -1) return null;

    return { startIndex, endIndex, functionName };
  }, [contextMenu, getModuleDetailText, instructionBuffer]);

  // Go to function start
  const handleGoToFunctionStart = useCallback(() => {
    const bounds = getContextMenuFunctionBounds();
    if (
      bounds &&
      bounds.startIndex >= 0 &&
      bounds.startIndex < instructionBuffer.length
    ) {
      const startAddr = instructionBuffer[bounds.startIndex].address;
      // Navigate to function start address
      setAssemblyAddress(startAddr);
      addLog("INFO", "NAVIGATION", `Jumped to function start: ${startAddr}`);
    }
    handleContextMenuClose();
  }, [
    getContextMenuFunctionBounds,
    instructionBuffer,
    setAssemblyAddress,
    addLog,
    handleContextMenuClose,
  ]);

  // Go to function end
  const handleGoToFunctionEnd = useCallback(() => {
    const bounds = getContextMenuFunctionBounds();
    if (
      bounds &&
      bounds.endIndex >= 0 &&
      bounds.endIndex < instructionBuffer.length
    ) {
      const endAddr = instructionBuffer[bounds.endIndex].address;
      // Navigate to function end address
      setAssemblyAddress(endAddr);
      addLog("INFO", "NAVIGATION", `Jumped to function end: ${endAddr}`);
    }
    handleContextMenuClose();
  }, [
    getContextMenuFunctionBounds,
    instructionBuffer,
    setAssemblyAddress,
    addLog,
    handleContextMenuClose,
  ]);

  // Start Code Tracing dialog - enabled for iOS
  const handleStartCodeTracing = useCallback(() => {
    if (contextMenu) {
      setPendingTraceAddress(contextMenu.address);
      setTraceCountDialogOpen(true);
    }
    handleContextMenuClose();
  }, [contextMenu, handleContextMenuClose]);

  // Helper to remove offset from function name (e.g., "libc.so@open64 + 0x38" -> "libc.so@open64")
  const stripFunctionOffset = (name: string): string => {
    if (!name) return "";
    const plusIndex = name.indexOf(" + ");
    if (plusIndex > 0) {
      return name.substring(0, plusIndex);
    }
    return name;
  };

  // Open Graph View dialog to set address range
  const handleOpenGraphView = useCallback(() => {
    if (!contextMenu) {
      handleContextMenuClose();
      return;
    }

    const address = contextMenu.address;
    const addressNum = parseInt(address.replace(/^0x/i, ""), 16);

    // Try to get function name from module detail (strip offset)
    const rawFunctionName = getModuleDetailText
      ? getModuleDetailText(address)
      : undefined;
    const functionName = rawFunctionName
      ? stripFunctionOffset(rawFunctionName)
      : undefined;

    // Find function boundaries using function name matching
    let functionStartIndex = -1;
    let functionEndIndex = -1;

    // Find the index of the clicked address in the instruction buffer
    const clickedIndex = instructionBuffer.findIndex(
      (instr) => parseInt(instr.address.replace(/^0x/i, ""), 16) === addressNum
    );

    if (clickedIndex !== -1 && functionName && getModuleDetailText) {
      // Search backward for function start by finding where function name changes or starts
      for (let i = clickedIndex; i >= 0; i--) {
        const instrFuncName = stripFunctionOffset(
          getModuleDetailText(instructionBuffer[i].address) || ""
        );
        if (instrFuncName !== functionName) {
          // Found a different function, so the next instruction is our function start
          functionStartIndex = i + 1;
          break;
        }
        // If we're at the beginning and still same function
        if (i === 0) {
          functionStartIndex = 0;
        }
      }

      // Search forward for function end by finding where function name changes
      for (let i = clickedIndex; i < instructionBuffer.length; i++) {
        const instrFuncName = stripFunctionOffset(
          getModuleDetailText(instructionBuffer[i].address) || ""
        );
        if (instrFuncName !== functionName) {
          // Found a different function, so the previous instruction is our function end
          functionEndIndex = i - 1;
          break;
        }
        // If we're at the end and still same function
        if (i === instructionBuffer.length - 1) {
          functionEndIndex = i;
        }
      }
    }

    // Fallback: if function name matching didn't work, use isFunctionStart/isFunctionEnd flags
    if (functionStartIndex === -1 && clickedIndex !== -1) {
      for (let i = clickedIndex; i >= 0; i--) {
        if (instructionBuffer[i].isFunctionStart) {
          functionStartIndex = i;
          break;
        }
      }
    }

    if (functionEndIndex === -1 && clickedIndex !== -1) {
      for (let i = clickedIndex; i < instructionBuffer.length; i++) {
        if (instructionBuffer[i].isFunctionEnd) {
          functionEndIndex = i;
          break;
        }
      }
    }

    // Final fallback: search for ret instruction
    if (functionStartIndex === -1) {
      if (clickedIndex !== -1) {
        for (let i = clickedIndex - 1; i >= 0; i--) {
          const opcode = instructionBuffer[i].opcode.toLowerCase();
          if (opcode === "ret" || opcode === "retn") {
            functionStartIndex = i + 1;
            break;
          }
        }
      }
      if (functionStartIndex === -1) functionStartIndex = 0;
    }

    if (functionEndIndex === -1) {
      if (clickedIndex !== -1) {
        for (let i = clickedIndex; i < instructionBuffer.length; i++) {
          const opcode = instructionBuffer[i].opcode.toLowerCase();
          if (opcode === "ret" || opcode === "retn") {
            functionEndIndex = i;
            break;
          }
        }
      }
      if (functionEndIndex === -1)
        functionEndIndex = instructionBuffer.length - 1;
    }

    // Set default addresses for dialog
    const startAddr = instructionBuffer[functionStartIndex]?.address || address;
    const endAddr = instructionBuffer[functionEndIndex]?.address || address;

    setPendingGraphViewAddress(address);
    setPendingGraphViewFunctionName(functionName);
    setGraphViewStartAddress(startAddr);
    setGraphViewEndAddress(endAddr);
    setGraphViewDialogOpen(true);

    handleContextMenuClose();
  }, [
    contextMenu,
    handleContextMenuClose,
    getModuleDetailText,
    instructionBuffer,
  ]);

  // Execute Graph View with specified address range
  const handleExecuteGraphView = useCallback(async () => {
    const startAddrNum = parseInt(
      graphViewStartAddress.replace(/^0x/i, ""),
      16
    );
    const endAddrNum = parseInt(graphViewEndAddress.replace(/^0x/i, ""), 16);

    if (isNaN(startAddrNum) || isNaN(endAddrNum)) {
      addLog("ERROR", "GRAPH", "Invalid address format");
      return;
    }

    if (startAddrNum >= endAddrNum) {
      addLog("ERROR", "GRAPH", "Start address must be less than end address");
      return;
    }

    setGraphViewDialogOpen(false);

    addLog(
      "INFO",
      "GRAPH",
      `Opening graph view for range ${graphViewStartAddress} - ${graphViewEndAddress}`
    );

    // Filter instructions within the specified range
    const rangeInstructions = instructionBuffer.filter((instr) => {
      const instrAddr = parseInt(instr.address.replace(/^0x/i, ""), 16);
      return instrAddr >= startAddrNum && instrAddr <= endAddrNum;
    });

    if (rangeInstructions.length === 0) {
      addLog("ERROR", "GRAPH", "No instructions found in the specified range");
      return;
    }

    // Convert to GraphViewInstruction format with detail info
    const graphInstructions: GraphViewInstruction[] = rangeInstructions.map(
      (instr) => ({
        address: instr.address,
        bytes: instr.bytes,
        opcode: instr.opcode,
        operands: instr.operands.map((op) => op.value).join(", "),
        detail: getModuleDetailText
          ? getModuleDetailText(instr.address)
          : undefined,
      })
    );

    // Find module info for Ghidra CFG support
    let libraryPath: string | undefined;
    let functionOffset: string | undefined;

    if (attachedModules.length > 0) {
      for (const module of attachedModules) {
        const moduleBase = BigInt(module.base);
        const moduleSize = BigInt(module.size);
        const moduleEnd = moduleBase + moduleSize;

        if (
          BigInt(startAddrNum) >= moduleBase &&
          BigInt(startAddrNum) < moduleEnd
        ) {
          // Found the module containing this address
          libraryPath = module.path || module.modulename || module.name;
          // Calculate function offset from module base
          const offset = BigInt(startAddrNum) - moduleBase;
          functionOffset = `0x${offset.toString(16)}`;
          addLog(
            "DEBUG",
            "GRAPH",
            `Found module: ${libraryPath}, offset: ${functionOffset}`
          );
          break;
        }
      }
    }

    const graphViewData: GraphViewData = {
      address: pendingGraphViewAddress,
      functionName: pendingGraphViewFunctionName,
      instructions: graphInstructions,
      functionStartAddress: graphViewStartAddress,
      functionEndAddress: graphViewEndAddress,
      libraryPath,
      functionOffset,
      serverUrl: getApiClient().getBaseUrl(),
    };

    try {
      await openGraphViewWindow(graphViewData);
    } catch (error) {
      addLog("ERROR", "GRAPH", `Failed to open graph view: ${error}`);
    }
  }, [
    graphViewStartAddress,
    graphViewEndAddress,
    pendingGraphViewAddress,
    pendingGraphViewFunctionName,
    instructionBuffer,
    getModuleDetailText,
    addLog,
    attachedModules,
  ]);

  // Execute Code Tracing with specified count
  const handleExecuteCodeTracing = useCallback(async () => {
    const count = parseInt(traceCountInput, 10);
    if (isNaN(count) || count <= 0) {
      addLog("ERROR", "TRACING", "Invalid trace count");
      return;
    }

    // Get optional end address
    const endAddress = traceEndAddressInput.trim() || undefined;

    setTraceCountDialogOpen(false);

    if (traceToFile) {
      // Trace to file mode - show progress UI, no window
      const endAddrMsg = endAddress ? `, end: ${endAddress}` : "";
      const memCacheMsg = fullMemoryCache ? " (full memory cache)" : "";
      addLog(
        "INFO",
        "TRACING",
        `Starting file trace session for ${pendingTraceAddress} with max ${count} hits${endAddrMsg}${memCacheMsg}`
      );

      const result = await startTraceSession(
        pendingTraceAddress,
        count,
        true,
        endAddress,
        fullMemoryCache
      );

      if (!result.success) {
        addLog("ERROR", "TRACING", "Failed to start file trace session");
        return;
      }

      const filePath = result.traceFilePath || "server default";
      addLog(
        "INFO",
        "TRACING",
        `File trace session started. Output: ${filePath}`
      );

      // Set initial progress state
      setFileTraceProgress({
        isActive: true,
        current: 0,
        total: count,
        filePath: filePath,
      });

      // Poll for trace completion
      const apiClient = getApiClient();
      const targetCount = count;
      let lastKnownFilePath = filePath; // Keep track of file path
      const pollInterval = setInterval(async () => {
        try {
          const status = await apiClient.getTraceStatus();

          // Remember file path while it's available
          if (status.file_path) {
            lastKnownFilePath = status.file_path;
          }

          // Update progress
          setFileTraceProgress((prev) =>
            prev
              ? {
                  ...prev,
                  current: status.entry_count,
                  filePath: lastKnownFilePath,
                }
              : null
          );

          // Trace is complete when:
          // 1. enabled becomes false (server closed the file), or
          // 2. entry_count >= targetCount, or
          // 3. ended_by_end_address is true (reached end address)
          if (
            !status.enabled ||
            status.entry_count >= targetCount ||
            status.ended_by_end_address
          ) {
            // Trace complete
            clearInterval(pollInterval);

            const reason = status.ended_by_end_address
              ? "end address reached"
              : status.entry_count >= targetCount
                ? "target count reached"
                : "server closed file";

            addLog(
              "INFO",
              "TRACING",
              `File trace completed (${reason}) with ${status.entry_count} entries. File saved to: ${lastKnownFilePath}`
            );

            // Clear progress and show completion dialog
            setFileTraceProgress(null);
            setFileTraceCompleteDialog({
              open: true,
              entryCount: status.entry_count,
              filePath: lastKnownFilePath,
              downloaded: false,
            });
          }
        } catch (pollError) {
          console.error("Error polling trace status:", pollError);
        }
      }, 300); // Poll every 300ms for smoother progress

      // Stop polling after 5 minutes timeout
      setTimeout(
        () => {
          clearInterval(pollInterval);
          setFileTraceProgress(null);
        },
        5 * 60 * 1000
      );

      // Reset the checkbox and end address
      setTraceToFile(false);
      setTraceEndAddressInput("");
    } else {
      // Normal UI trace mode
      const endAddrMsg = endAddress ? `, end: ${endAddress}` : "";
      addLog(
        "INFO",
        "TRACING",
        `Starting trace session for ${pendingTraceAddress} with max ${count} hits${endAddrMsg}`
      );

      // Start trace session in Tauri store and set breakpoint
      const result = await startTraceSession(
        pendingTraceAddress,
        count,
        false,
        endAddress
      );

      if (!result.success) {
        addLog("ERROR", "TRACING", "Failed to start trace session");
        return;
      }

      // Open independent Code Tracing window
      openCodeTracingWindow(pendingTraceAddress, count);
      addLog(
        "INFO",
        "TRACING",
        `Opened code tracing window for ${pendingTraceAddress}`
      );

      // Reset end address
      setTraceEndAddressInput("");
    }
  }, [
    traceCountInput,
    traceEndAddressInput,
    pendingTraceAddress,
    traceToFile,
    addLog,
  ]);

  // Helper: Get module info for an address
  const getModuleForAddress = useCallback(
    (address: string): ModuleInfo | null => {
      if (!attachedModules.length) return null;

      let numericAddress: number;
      if (address.startsWith("0x") || address.startsWith("0X")) {
        numericAddress = parseInt(address, 16);
      } else {
        numericAddress = parseInt(address, 10);
      }

      if (isNaN(numericAddress)) return null;

      for (const module of attachedModules) {
        const moduleBase = module.base;
        const moduleEnd = moduleBase + module.size;

        if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
          return module;
        }
      }

      return null;
    },
    [attachedModules]
  );

  // Get library path for context menu address
  const getContextMenuLibraryInfo = useCallback((): {
    path: string;
    offset: number;
    functionStartOffset: number | null; // Offset of function start (for Ghidra decompile)
    functionName: string | null;
    moduleBase: number; // Base address of the module in memory
  } | null => {
    if (!contextMenu) return null;

    const address = contextMenu.address;
    const module = getModuleForAddress(address);
    if (!module) return null;

    const numericAddress = parseInt(address.replace(/^0x/i, ""), 16);
    const offset = numericAddress - module.base;

    // Get function name
    const rawFunctionName = getModuleDetailText
      ? getModuleDetailText(address)
      : null;
    let functionName: string | null = null;

    if (rawFunctionName && rawFunctionName.includes("@")) {
      const atIndex = rawFunctionName.indexOf("@");
      const plusIndex = rawFunctionName.indexOf(" + ");
      functionName =
        plusIndex > 0
          ? rawFunctionName.substring(atIndex + 1, plusIndex)
          : rawFunctionName.substring(atIndex + 1);
    }

    // Get function start offset using getContextMenuFunctionBounds
    let functionStartOffset: number | null = null;
    const bounds = getContextMenuFunctionBounds();
    if (
      bounds &&
      bounds.startIndex >= 0 &&
      instructionBuffer[bounds.startIndex]
    ) {
      const startAddress = instructionBuffer[bounds.startIndex].address;
      const startNumericAddress = parseInt(
        startAddress.replace(/^0x/i, ""),
        16
      );
      functionStartOffset = startNumericAddress - module.base;
    }

    return {
      path: module.modulename || module.name || "",
      offset,
      functionStartOffset,
      functionName,
      moduleBase: module.base,
    };
  }, [
    contextMenu,
    getModuleForAddress,
    getModuleDetailText,
    getContextMenuFunctionBounds,
    instructionBuffer,
  ]);

  // Check if current address has library resolved
  const contextMenuHasLibrary = useMemo(() => {
    return getContextMenuLibraryInfo() !== null;
  }, [getContextMenuLibraryInfo]);

  // Check if current library is analyzed with Ghidra
  const contextMenuLibraryAnalyzed = useMemo(() => {
    const info = getContextMenuLibraryInfo();
    if (!info) return false;
    return isLibraryAnalyzed(info.path);
  }, [getContextMenuLibraryInfo, isLibraryAnalyzed]);

  // Handle Decompile with Ghidra
  const handleDecompileWithGhidra = useCallback(async () => {
    const info = getContextMenuLibraryInfo();
    if (!info) {
      addLog("ERROR", "GHIDRA", "No library found for this address");
      handleContextMenuClose();
      return;
    }

    if (!contextMenu) {
      handleContextMenuClose();
      return;
    }

    // Check if library is already analyzed
    if (!isLibraryAnalyzed(info.path)) {
      const moduleName = info.path.split(/[/\\]/).pop() || info.path;
      addLog(
        "ERROR",
        "GHIDRA",
        `Library not analyzed: ${moduleName}. Please analyze it first in the Tools tab (Ghidra section).`
      );
      handleContextMenuClose();
      return;
    }

    // Get saved Ghidra path from localStorage
    const savedGhidraPath = localStorage.getItem(GHIDRA_PATH_KEY);
    if (!savedGhidraPath) {
      addLog(
        "ERROR",
        "GHIDRA",
        "Ghidra path not configured. Please set it in the Tools tab (Ghidra section)."
      );
      handleContextMenuClose();
      return;
    }

    // Library is analyzed, proceed directly to decompile without dialog
    handleContextMenuClose();

    // Check if Ghidra server is running for this library
    const libInfo = getAnalyzedLibraryInfo(info.path);
    const isServerRunningForLib =
      serverRunning && libInfo && serverProjectPath === libInfo.projectPath;
    if (!isServerRunningForLib) {
      addLog(
        "INFO",
        "GHIDRA",
        "Ghidra server is not running. Decompilation may take longer. Start the server in Tools > Ghidra for faster results."
      );
      // Show processing snackbar for slow operation
      setProcessingSnackbar({
        open: true,
        message:
          "Decompiling... This may take a while without Ghidra server running.",
      });
    }

    // Use function start offset for decompilation
    const functionStartOffset = info.functionStartOffset;
    if (functionStartOffset === null) {
      addLog("ERROR", "GHIDRA", "Not inside a function - cannot decompile");
      return;
    }

    const offsetHex = `0x${functionStartOffset.toString(16)}`;
    const moduleName = info.path.split(/[/\\]/).pop() || info.path;
    const osKey = serverInfo?.target_os || "unknown";

    // Check cache first
    const cachedResult = await getDecompileFromCache(
      osKey,
      moduleName,
      offsetHex
    );
    if (cachedResult?.success && cachedResult.decompiled_code) {
      addLog(
        "INFO",
        "GHIDRA",
        `Using cached decompile for: ${cachedResult.function_name || offsetHex}`
      );
      if (onDecompileRequest) {
        onDecompileRequest(
          info.path,
          offsetHex,
          cachedResult.function_name || null,
          cachedResult.decompiled_code,
          info.moduleBase,
          cachedResult.line_mapping || null,
          cachedResult.tokens || null
        );
      }
      return;
    }

    addLog("INFO", "GHIDRA", `Starting decompilation at offset: ${offsetHex}`);

    const result = await decompileFunction(
      info.path,
      offsetHex,
      savedGhidraPath
    );

    // Close processing snackbar
    setProcessingSnackbar({ open: false, message: "" });

    if (result?.success) {
      addLog(
        "INFO",
        "GHIDRA",
        `Decompilation completed for: ${result.function_name || offsetHex}`
      );

      // Save to cache
      if (result.decompiled_code) {
        await saveDecompileToCache(
          osKey,
          moduleName,
          offsetHex,
          result.function_name || "",
          result.decompiled_code,
          result.line_mapping
        );
      }

      if (onDecompileRequest && result.decompiled_code) {
        onDecompileRequest(
          info.path,
          offsetHex,
          result.function_name || null,
          result.decompiled_code,
          info.moduleBase,
          result.line_mapping || null,
          result.tokens || null
        );
      }
    } else {
      addLog(
        "ERROR",
        "GHIDRA",
        `Decompilation failed: ${result?.error || "Unknown error"}`
      );
    }
  }, [
    getContextMenuLibraryInfo,
    contextMenu,
    addLog,
    handleContextMenuClose,
    isLibraryAnalyzed,
    decompileFunction,
    onDecompileRequest,
    serverInfo?.target_os,
    getDecompileFromCache,
    saveDecompileToCache,
  ]);

  // Handle Get Xrefs with Ghidra
  const handleGetXrefs = useCallback(async () => {
    const info = getContextMenuLibraryInfo();
    if (!info) {
      addLog("ERROR", "GHIDRA", "No library found for this address");
      handleContextMenuClose();
      return;
    }

    // Check if library is already analyzed
    if (!isLibraryAnalyzed(info.path)) {
      const moduleName = info.path.split(/[/\\]/).pop() || info.path;
      addLog(
        "ERROR",
        "GHIDRA",
        `Library not analyzed: ${moduleName}. Please analyze it first in the Tools tab (Ghidra section).`
      );
      handleContextMenuClose();
      return;
    }

    // Get saved Ghidra path from localStorage
    const savedGhidraPath = localStorage.getItem(GHIDRA_PATH_KEY);
    if (!savedGhidraPath) {
      addLog(
        "ERROR",
        "GHIDRA",
        "Ghidra path not configured. Please set it in the Tools tab (Ghidra section)."
      );
      handleContextMenuClose();
      return;
    }

    handleContextMenuClose();

    // Check if Ghidra server is running for this library
    const libInfo = getAnalyzedLibraryInfo(info.path);
    const isServerRunningForLib =
      serverRunning && libInfo && serverProjectPath === libInfo.projectPath;
    if (!isServerRunningForLib) {
      addLog(
        "INFO",
        "GHIDRA",
        "Ghidra server is not running. Xref lookup may take longer. Start the server in Tools > Ghidra for faster results."
      );
      // Show processing snackbar for slow operation
      setProcessingSnackbar({
        open: true,
        message:
          "Loading Xrefs... This may take a while without Ghidra server running.",
      });
    }

    // Use function start offset for xref lookup
    const functionStartOffset = info.functionStartOffset;
    if (functionStartOffset === null) {
      addLog("ERROR", "GHIDRA", "Not inside a function - cannot get xrefs");
      return;
    }

    const offsetHex = `0x${functionStartOffset.toString(16)}`;
    const moduleName = info.path.split(/[/\\]/).pop() || info.path;
    const osKey = serverInfo?.target_os || "unknown";

    // Reference types that are code references (call/jump instructions)
    const codeRefTypes = [
      "UNCONDITIONAL_CALL",
      "CONDITIONAL_CALL",
      "UNCONDITIONAL_JUMP",
      "CONDITIONAL_JUMP",
      "CALL_OVERRIDE_UNCONDITIONAL",
      "JUMP_OVERRIDE_UNCONDITIONAL",
    ];

    // Helper function to fetch instructions for code reference xrefs
    const fetchInstructionsForXrefs = async (
      xrefs: Array<{
        from_address: string;
        from_function: string | null;
        ref_type: string;
        instruction?: string | null;
      }>,
      moduleBase: number
    ) => {
      const apiClient = getApiClient();
      const architecture = serverInfo?.arch || "arm64";

      return Promise.all(
        xrefs.map(async (xref) => {
          // Only fetch instruction for code references (CALL/JUMP types)
          if (!codeRefTypes.includes(xref.ref_type)) {
            return xref;
          }

          try {
            const addressStr = xref.from_address.startsWith("0x")
              ? xref.from_address.slice(2)
              : xref.from_address;
            const offset = parseInt(addressStr, 16);
            if (isNaN(offset)) return xref;

            const realAddress = moduleBase + offset;

            const memoryBuffer = await apiClient.readMemory(
              `0x${realAddress.toString(16)}`,
              16,
              true
            );
            const memoryData = Array.from(new Uint8Array(memoryBuffer));

            const response: DisassembleResponse = await invoke(
              "disassemble_memory_direct",
              {
                memoryData,
                address: realAddress,
                architecture,
              }
            );

            if (response.success && response.disassembly) {
              const lines = response.disassembly
                .split("\n")
                .filter((line: string) => line.trim());
              if (lines.length > 0) {
                const parts = lines[0].split("|");
                if (parts.length >= 3) {
                  return { ...xref, instruction: parts[2].trim() };
                }
              }
            }
          } catch (e) {
            console.error("Failed to get instruction for xref:", e);
          }
          return xref;
        })
      );
    };

    // Check cache first
    const cachedResult = await getXrefFromCache(osKey, moduleName, offsetHex);
    if (cachedResult?.success && cachedResult.xrefs) {
      addLog(
        "INFO",
        "GHIDRA",
        `Using cached xrefs for: ${cachedResult.target_function}`
      );

      // Fetch instructions for code references
      const xrefsWithInstructions = await fetchInstructionsForXrefs(
        cachedResult.xrefs,
        info.moduleBase
      );

      setXrefData({
        targetFunction: cachedResult.target_function,
        targetAddress: cachedResult.target_address,
        moduleBase: info.moduleBase,
        moduleName: moduleName,
        xrefs: xrefsWithInstructions,
      });
      setXrefDialogOpen(true);
      return;
    }

    addLog(
      "INFO",
      "GHIDRA",
      `Getting xrefs for function at offset: ${offsetHex}`
    );

    setXrefLoading(true);
    setXrefDialogOpen(true);
    setXrefData(null);

    const result = await getXrefs(info.path, offsetHex, savedGhidraPath);

    setXrefLoading(false);
    // Close processing snackbar
    setProcessingSnackbar({ open: false, message: "" });

    if (result?.success) {
      // Fetch instructions for code references
      const xrefsWithInstructions = await fetchInstructionsForXrefs(
        result.xrefs,
        info.moduleBase
      );

      // Save to cache
      await saveXrefToCache(
        osKey,
        moduleName,
        offsetHex,
        result.target_function,
        xrefsWithInstructions
      );

      setXrefData({
        targetFunction: result.target_function,
        targetAddress: result.target_address,
        moduleBase: info.moduleBase,
        moduleName: moduleName,
        xrefs: xrefsWithInstructions,
      });
      addLog(
        "INFO",
        "GHIDRA",
        `Found ${result.xrefs.length} xrefs for: ${result.target_function}`
      );
    } else {
      addLog(
        "ERROR",
        "GHIDRA",
        `Failed to get xrefs: ${result?.error || "Unknown error"}`
      );
      setXrefDialogOpen(false);
    }
  }, [
    getContextMenuLibraryInfo,
    addLog,
    handleContextMenuClose,
    isLibraryAnalyzed,
    getXrefs,
    serverInfo?.target_os,
    serverInfo?.arch,
    getXrefFromCache,
    saveXrefToCache,
  ]);

  // Handle Ghidra settings save and execute action
  const handleSaveGhidraSettings = useCallback(async () => {
    setGhidraSettingsDialogOpen(false);
    addLog("INFO", "GHIDRA", `Ghidra path: ${ghidraPathInput}`);

    // Use saved library info instead of getContextMenuLibraryInfo
    const info = pendingGhidraLibraryInfo;
    if (!info) {
      console.log("[GHIDRA] No pending library info available");
      addLog("ERROR", "GHIDRA", "No library information available");
      setPendingGhidraAction(null);
      setPendingGhidraLibraryInfo(null);
      setPendingGhidraAddress(null);
      return;
    }

    if (pendingGhidraAction === "analyze") {
      addLog("INFO", "GHIDRA", `Starting Ghidra analysis for: ${info.path}`);
      console.log("[GHIDRA] Starting analysis with path:", ghidraPathInput);
      console.log("[GHIDRA] Library path:", info.path);
      const result = await analyzeLibrary(info.path, ghidraPathInput);
      console.log("[GHIDRA] Analysis result:", result);

      if (result?.analyzed) {
        console.log("[GHIDRA] Analysis completed successfully");
        addLog(
          "INFO",
          "GHIDRA",
          `Analysis completed successfully for: ${info.path}`
        );
      } else {
        console.log("[GHIDRA] Analysis failed:", result?.error);
        addLog(
          "ERROR",
          "GHIDRA",
          `Analysis failed: ${result?.error || "Unknown error"}`
        );
      }
    } else if (pendingGhidraAction === "decompile") {
      // Use function start offset for decompilation
      const functionStartOffset = info.functionStartOffset;
      if (functionStartOffset === null) {
        console.log("[GHIDRA] No function start offset available");
        addLog("ERROR", "GHIDRA", "Not inside a function - cannot decompile");
        setPendingGhidraAction(null);
        setPendingGhidraLibraryInfo(null);
        setPendingGhidraAddress(null);
        return;
      }

      const offsetHex = `0x${functionStartOffset.toString(16)}`;

      addLog(
        "INFO",
        "GHIDRA",
        `Starting decompilation at offset: ${offsetHex}`
      );
      console.log(
        "[GHIDRA] Starting decompilation with path:",
        ghidraPathInput
      );
      console.log("[GHIDRA] Library path:", info.path);
      console.log("[GHIDRA] Function offset:", offsetHex);
      console.log("[GHIDRA] Original address:", pendingGhidraAddress);
      const result = await decompileFunction(
        info.path,
        offsetHex,
        ghidraPathInput
      );
      console.log("[GHIDRA] Decompile result:", result);

      if (result?.success) {
        console.log("[GHIDRA] Decompilation completed successfully");
        console.log("[GHIDRA] Line mapping:", result.line_mapping);
        addLog(
          "INFO",
          "GHIDRA",
          `Decompilation completed for: ${result.function_name || offsetHex}`
        );
        // Call parent handler to show in DecompileView
        if (onDecompileRequest && result.decompiled_code) {
          onDecompileRequest(
            info.path,
            offsetHex,
            result.function_name || null,
            result.decompiled_code,
            info.moduleBase,
            result.line_mapping || null,
            result.tokens || null
          );
        }
      } else {
        addLog(
          "ERROR",
          "GHIDRA",
          `Decompilation failed: ${result?.error || "Unknown error"}`
        );
      }
    }

    setPendingGhidraAction(null);
    setPendingGhidraLibraryInfo(null);
    setPendingGhidraAddress(null);
  }, [
    ghidraPathInput,
    pendingGhidraAction,
    pendingGhidraLibraryInfo,
    pendingGhidraAddress,
    analyzeLibrary,
    decompileFunction,
    addLog,
    onDecompileRequest,
  ]);

  const handleWheelScroll = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (loading) return;

      event.preventDefault(); // Prevent default scrolling

      // Debounce scroll events for better performance
      clearTimeout((window as any).scrollTimeout);
      (window as any).scrollTimeout = setTimeout(() => {
        // Use smaller scroll steps for smoother experience
        if (event.deltaY < 0) {
          scrollUp();
        } else {
          scrollDown();
        }
      }, 16); // ~60fps debounce
    },
    [loading, scrollUp, scrollDown]
  );

  /* Handle Decompile icon click - currently disabled, use right-click context menu instead
  const handleDecompileIconClick = useCallback(async () => {
    // First, toggle the decompile view
    if (onToggleDecompile) {
      onToggleDecompile();
    }

    // If there's a focused line and the library is analyzed, trigger decompile for that function
    if (
      focusedLineAddress &&
      isCurrentLibraryAnalyzed &&
      onDecompileRequest &&
      attachedModules.length
    ) {
      // Use handleAddressClick logic to trigger decompile
      // Find the module for this address
      let numericAddress: number;
      if (
        focusedLineAddress.startsWith("0x") ||
        focusedLineAddress.startsWith("0X")
      ) {
        numericAddress = parseInt(focusedLineAddress, 16);
      } else {
        numericAddress = parseInt(focusedLineAddress, 10);
      }

      if (!isNaN(numericAddress)) {
        for (const module of attachedModules) {
          const moduleBase = module.base;
          const moduleEnd = moduleBase + module.size;

          if (numericAddress >= moduleBase && numericAddress < moduleEnd) {
            const modulePath = module.modulename || module.name || "";

            // Check if this library is analyzed
            if (isLibraryAnalyzed(modulePath)) {
              // Get function info from the detail text
              const rawFunctionName = getModuleDetailText
                ? getModuleDetailText(focusedLineAddress)
                : null;

              // Check if we're inside a function (contains @ symbol)
              if (rawFunctionName && rawFunctionName.includes("@")) {
                // Find the function start by looking at the instruction buffer
                const clickedIndex = instructionBuffer.findIndex(
                  (instr) =>
                    parseInt(instr.address.replace(/^0x/i, ""), 16) ===
                    numericAddress
                );

                if (clickedIndex >= 0) {
                  // Find the function start by scanning backward for isFunctionStart
                  let functionStartIndex = clickedIndex;
                  for (let i = clickedIndex; i >= 0; i--) {
                    if (instructionBuffer[i].isFunctionStart) {
                      functionStartIndex = i;
                      break;
                    }
                  }

                  const startInstruction =
                    instructionBuffer[functionStartIndex];
                  if (startInstruction) {
                    const startAddress = parseInt(
                      startInstruction.address.replace(/^0x/i, ""),
                      16
                    );
                    const functionStartOffset = startAddress - moduleBase;
                    const offsetHex = `0x${functionStartOffset.toString(16)}`;
                    const moduleName =
                      modulePath.split(/[/\\]/).pop() || modulePath;
                    const osKey = serverInfo?.target_os || "unknown";

                    // Get saved Ghidra path from localStorage
                    const savedGhidraPath =
                      localStorage.getItem(GHIDRA_PATH_KEY);
                    if (!savedGhidraPath) {
                      addLog(
                        "WARN",
                        "GHIDRA",
                        "Ghidra path not configured. Please set it in the Tools tab."
                      );
                      return;
                    }

                    // Check cache first
                    const cachedResult = await getDecompileFromCache(
                      osKey,
                      moduleName,
                      offsetHex
                    );
                    if (cachedResult?.success && cachedResult.decompiled_code) {
                      addLog(
                        "INFO",
                        "GHIDRA",
                        `Using cached decompile for: ${cachedResult.function_name || offsetHex}`
                      );
                      onDecompileRequest(
                        modulePath,
                        offsetHex,
                        cachedResult.function_name || null,
                        cachedResult.decompiled_code,
                        moduleBase,
                        cachedResult.line_mapping || null,
                        cachedResult.tokens || null
                      );
                      return;
                    }

                    addLog(
                      "INFO",
                      "GHIDRA",
                      `Starting decompilation at offset: ${offsetHex}`
                    );

                    const result = await decompileFunction(
                      modulePath,
                      offsetHex,
                      savedGhidraPath
                    );

                    if (result?.success && result.decompiled_code) {
                      addLog(
                        "INFO",
                        "GHIDRA",
                        `Decompilation completed for: ${result.function_name || offsetHex}`
                      );

                      // Save to cache
                      await saveDecompileToCache(
                        osKey,
                        moduleName,
                        offsetHex,
                        result.function_name || "",
                        result.decompiled_code,
                        result.line_mapping
                      );

                      onDecompileRequest(
                        modulePath,
                        offsetHex,
                        result.function_name || null,
                        result.decompiled_code,
                        moduleBase,
                        result.line_mapping || null,
                        result.tokens || null
                      );
                    } else {
                      addLog(
                        "WARN",
                        "GHIDRA",
                        `Decompilation failed: ${result?.error || "Unknown error"}`
                      );
                    }
                  }
                }
              }
            }
            break;
          }
        }
      }
    }
  }, [
    onToggleDecompile,
    focusedLineAddress,
    isCurrentLibraryAnalyzed,
    onDecompileRequest,
    attachedModules,
    isLibraryAnalyzed,
    getModuleDetailText,
    instructionBuffer,
    serverInfo?.target_os,
    getDecompileFromCache,
    decompileFunction,
    saveDecompileToCache,
    addLog,
  ]);
  */

  return (
    <Box display="flex" flexDirection="column" height="100%">
      <DisassemblyHeader>
        <Box display="flex" alignItems="center" sx={{ flex: 1 }}>
          <DisassemblyTitle>
            <FunctionsIcon />
            {sourceCodeLevelDebug &&
            dwarfAnalysisResult?.source_files?.length > 0
              ? "Source"
              : "Assembly"}
          </DisassemblyTitle>
          {/* Source/ASM Toggle - only show when DWARF analysis has source files */}
          {dwarfAnalysisResult?.source_files?.length > 0 && (
            <Tooltip
              title={
                sourceCodeLevelDebug
                  ? "Switch to Assembly"
                  : "Switch to Source Code"
              }
              placement="top"
            >
              <Box
                onClick={toggleSourceCodeLevelDebug}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  ml: 1.5,
                  px: 1,
                  py: 0.25,
                  fontSize: "10px",
                  fontWeight: 500,
                  cursor: "pointer",
                  color: sourceCodeLevelDebug ? "#4fc1ff" : "#808080",
                  backgroundColor: sourceCodeLevelDebug
                    ? "rgba(79, 193, 255, 0.15)"
                    : "#2d2d30",
                  borderRadius: 1,
                  transition: "all 0.15s ease",
                  "&:hover": { backgroundColor: "rgba(79, 193, 255, 0.25)" },
                }}
              >
                <CodeIcon sx={{ fontSize: 12, mr: 0.5 }} />
                {sourceCodeLevelDebug ? "Source" : "ASM"}
              </Box>
            </Tooltip>
          )}

          {/* Decompile icon hidden - use right-click context menu instead
          {!isDecompileVisible &&
            (hasDecompileResult || isCurrentLibraryAnalyzed) &&
            onToggleDecompile && (
              <Tooltip
                title={
                  hasDecompileResult
                    ? "Show Decompile View"
                    : "Show Decompile View (Library Analyzed)"
                }
                placement="top"
              >
                <IconButton
                  size="small"
                  onClick={handleDecompileIconClick}
                  sx={{
                    color: hasDecompileResult ? "#4fc1ff" : "#8bc34a",
                    "&:hover": { backgroundColor: "#2d2d30" },
                    ml: 2,
                  }}
                >
                  <DecompileIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          */}

          {error && (
            <Box display="flex" alignItems="center" gap={1} sx={{ ml: 1 }}>
              <Typography variant="caption" color="error">
                {error}
              </Typography>
              <Tooltip title="Retry disassembly" placement="top">
                <IconButton
                  size="small"
                  onClick={() => {
                    const functionAddress =
                      useUIStore.getState().debuggerState.assemblyAddress;
                    if (functionAddress) {
                      const address = parseAddress(functionAddress);
                      loadDisassemblyAtAddress(address);
                    }
                  }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Clear error" placement="top">
                <IconButton size="small" onClick={() => setError(null)}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        <DisassemblyActions>
          {/* Actions area - toggle moved to header */}
        </DisassemblyActions>
      </DisassemblyHeader>

      <DisassemblyContainer
        ref={containerRef}
        tabIndex={0}
        onWheel={handleWheelScroll}
      >
        <NavigationButtons>
          <Tooltip title="Scroll up (Page Up)" placement="left">
            <NavButton onClick={scrollUp} disabled={loading}>
              <ArrowUpIcon />
            </NavButton>
          </Tooltip>
          <Tooltip title="Scroll down (Page Down)" placement="left">
            <NavButton onClick={scrollDown} disabled={loading}>
              <ArrowDownIcon />
            </NavButton>
          </Tooltip>
        </NavigationButtons>

        <ScrollableContent>
          {sourceCodeLevelDebug ? (
            // Source Code View with VS Code-like tabs
            <Box
              sx={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                fontFamily: "monospace",
                fontSize: "12px",
              }}
            >
              {dwarfAnalysisResult?.source_files &&
              dwarfAnalysisResult.source_files.length > 0 ? (
                <Box
                  sx={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                >
                  {/* VS Code-like Tab Bar */}
                  <Box
                    sx={{
                      display: "flex",
                      backgroundColor: "#252526",
                      borderBottom: "1px solid #3c3c3c",
                      minHeight: "35px",
                      overflow: "hidden",
                    }}
                  >
                    {/* Tab list - scrollable horizontally */}
                    <Box
                      sx={{
                        display: "flex",
                        flex: 1,
                        overflowX: "auto",
                        overflowY: "hidden",
                        "&::-webkit-scrollbar": {
                          height: "4px",
                        },
                        "&::-webkit-scrollbar-thumb": {
                          backgroundColor: "#424242",
                          borderRadius: "2px",
                        },
                      }}
                    >
                      {openSourceTabs.map((tabPath) => {
                        const fileName =
                          tabPath.split(/[\/\\]/).pop() || tabPath;
                        const isActive = activeSourceTab === tabPath;
                        return (
                          <Box
                            key={tabPath}
                            onClick={() => setActiveSourceTab(tabPath)}
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                              px: 1.5,
                              py: 0.5,
                              minWidth: "fit-content",
                              maxWidth: "180px",
                              cursor: "pointer",
                              backgroundColor: isActive
                                ? "#1e1e1e"
                                : "transparent",
                              borderRight: "1px solid #3c3c3c",
                              borderBottom: isActive
                                ? "1px solid #1e1e1e"
                                : "1px solid transparent",
                              marginBottom: isActive ? "-1px" : 0,
                              "&:hover": {
                                backgroundColor: isActive
                                  ? "#1e1e1e"
                                  : "#2d2d2d",
                              },
                              "&:hover .close-btn": {
                                opacity: 1,
                              },
                            }}
                          >
                            <FileIcon
                              sx={{
                                fontSize: 14,
                                color: "#4fc1ff",
                                flexShrink: 0,
                              }}
                            />
                            <Typography
                              sx={{
                                color: isActive ? "#ffffff" : "#969696",
                                fontSize: "11px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={tabPath}
                            >
                              {fileName}
                            </Typography>
                            <IconButton
                              className="close-btn"
                              size="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeSourceTab(tabPath);
                              }}
                              sx={{
                                p: 0.25,
                                ml: 0.5,
                                opacity: isActive ? 1 : 0,
                                color: "#808080",
                                "&:hover": {
                                  color: "#ffffff",
                                  backgroundColor: "rgba(255,255,255,0.1)",
                                },
                              }}
                            >
                              <CloseIcon sx={{ fontSize: 12 }} />
                            </IconButton>
                          </Box>
                        );
                      })}
                    </Box>
                    {/* Add file dropdown */}
                    {dwarfAnalysisResult.source_files.length >
                      openSourceTabs.length && (
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          px: 1,
                          borderLeft: "1px solid #3c3c3c",
                        }}
                      >
                        <Tooltip title="Open file">
                          <IconButton
                            size="small"
                            onClick={() => {
                              // Open first non-opened file
                              const unopenedFile =
                                dwarfAnalysisResult.source_files.find(
                                  (f: any) => !openSourceTabs.includes(f.path)
                                );
                              if (unopenedFile) {
                                openSourceTab(
                                  unopenedFile.path,
                                  unopenedFile.directory
                                );
                              }
                            }}
                            sx={{ color: "#808080" }}
                          >
                            <RefreshIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    )}
                  </Box>

                  {/* Active tab content */}
                  <Box
                    sx={{
                      flex: 1,
                      overflow: "auto",
                      backgroundColor: "#1e1e1e",
                    }}
                  >
                    {activeSourceTab ? (
                      (() => {
                        const file = dwarfAnalysisResult.source_files.find(
                          (f: any) => f.path === activeSourceTab
                        );
                        if (!file) return null;

                        const cached = sourceCodeCache.get(file.path);
                        const lineAddressMap = new Map<number, any>();

                        // Build line number to address mapping
                        if (file.lines) {
                          file.lines.forEach((lineInfo: any) => {
                            if (!lineAddressMap.has(lineInfo.line)) {
                              lineAddressMap.set(lineInfo.line, lineInfo);
                            }
                          });
                        }

                        return (
                          <Box sx={{ minHeight: "100%" }}>
                            {cached?.loading ? (
                              <Box sx={{ p: 2, textAlign: "center" }}>
                                <CircularProgress size={20} />
                                <Typography
                                  sx={{
                                    color: "#808080",
                                    mt: 1,
                                    fontSize: "11px",
                                  }}
                                >
                                  Loading source file...
                                </Typography>
                              </Box>
                            ) : cached?.error ? (
                              <Box sx={{ p: 2 }}>
                                <Typography
                                  sx={{ color: "#f48771", fontSize: "11px" }}
                                >
                                  {cached.error}
                                </Typography>
                                <Typography
                                  sx={{
                                    color: "#808080",
                                    fontSize: "10px",
                                    mt: 1,
                                  }}
                                >
                                  Check the source root path in Tools → DWARF
                                  tab.
                                </Typography>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  onClick={() =>
                                    loadSourceFile(file.path, file.directory)
                                  }
                                  sx={{ mt: 1, fontSize: "10px" }}
                                >
                                  Retry
                                </Button>
                              </Box>
                            ) : cached &&
                              cached.lines &&
                              cached.lines.length > 0 ? (
                              cached.lines.map((codeLine, idx) => {
                                const lineNum = idx + 1;
                                const lineInfo = lineAddressMap.get(lineNum);
                                const canSetBreakpoint = !!lineInfo; // Can set BP only on lines with debug info

                                // Check if this line has a breakpoint
                                const breakpointForLine =
                                  sourceBreakpoints.find(
                                    (bp) =>
                                      bp.filePath === file.path &&
                                      bp.line === lineNum
                                  );
                                const hasBreakpoint =
                                  !!breakpointForLine &&
                                  breakpointForLine.enabled;

                                // Check if current execution is stopped at this line
                                const lineAddress = lineInfo
                                  ? (selectedModuleBase || 0) + lineInfo.address
                                  : null;
                                const isCurrentLine =
                                  lineAddress !== null &&
                                  currentHitAddress === lineAddress;

                                const handleBreakpointClick = async () => {
                                  if (
                                    !canSetBreakpoint ||
                                    !lineInfo ||
                                    !selectedModuleBase
                                  )
                                    return;

                                  const absoluteAddress =
                                    selectedModuleBase + lineInfo.address;

                                  try {
                                    const api = getApiClient();
                                    if (breakpointForLine) {
                                      // Remove existing breakpoint
                                      const result = await api.removeBreakpoint(
                                        {
                                          address: absoluteAddress,
                                        }
                                      );
                                      if (result.success) {
                                        removeSourceBreakpoint(
                                          file.path,
                                          lineNum
                                        );
                                        console.log(
                                          `[SourceView] Removed breakpoint at ${file.path}:${lineNum} (0x${absoluteAddress.toString(16)})`
                                        );
                                      } else {
                                        console.error(
                                          `[SourceView] Failed to remove breakpoint: ${result.message}`
                                        );
                                      }
                                    } else {
                                      // Add new breakpoint (hardware breakpoint)
                                      const result = await api.setBreakpoint({
                                        address: absoluteAddress,
                                        hit_count: 0, // 0 means permanent breakpoint
                                      });
                                      if (result.success) {
                                        addSourceBreakpoint({
                                          filePath: file.path,
                                          line: lineNum,
                                          address: absoluteAddress,
                                          moduleBase: selectedModuleBase,
                                          offset: lineInfo.address,
                                          enabled: true,
                                          isHit: false,
                                        });
                                        console.log(
                                          `[SourceView] Set breakpoint at ${file.path}:${lineNum} (0x${absoluteAddress.toString(16)})`
                                        );
                                      } else {
                                        console.error(
                                          `[SourceView] Failed to set breakpoint: ${result.message}`
                                        );
                                      }
                                    }
                                  } catch (err) {
                                    console.error(
                                      `[SourceView] Error setting/removing breakpoint:`,
                                      err
                                    );
                                  }
                                };

                                return (
                                  <Box
                                    key={idx}
                                    data-line-number={lineNum}
                                    sx={{
                                      display: "flex",
                                      alignItems: "flex-start",
                                      minHeight: "18px",
                                      lineHeight: "18px",
                                      backgroundColor: isCurrentLine
                                        ? "rgba(255, 204, 0, 0.2)"
                                        : hasBreakpoint
                                          ? "rgba(255, 68, 68, 0.1)"
                                          : "transparent",
                                      "&:hover": {
                                        backgroundColor: isCurrentLine
                                          ? "rgba(255, 204, 0, 0.25)"
                                          : "rgba(255, 255, 255, 0.04)",
                                      },
                                      "&:hover .bp-gutter": {
                                        opacity: canSetBreakpoint ? 1 : 0.3,
                                      },
                                    }}
                                  >
                                    {/* Breakpoint gutter */}
                                    <Box
                                      className="bp-gutter"
                                      onClick={handleBreakpointClick}
                                      sx={{
                                        minWidth: "20px",
                                        height: "18px",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        cursor: canSetBreakpoint
                                          ? "pointer"
                                          : "default",
                                        opacity:
                                          hasBreakpoint || isCurrentLine
                                            ? 1
                                            : 0,
                                        transition: "opacity 0.1s",
                                        backgroundColor:
                                          canSetBreakpoint &&
                                          !hasBreakpoint &&
                                          !isCurrentLine
                                            ? "rgba(255, 68, 68, 0.1)"
                                            : "transparent",
                                        "&:hover":
                                          canSetBreakpoint && !hasBreakpoint
                                            ? {
                                                backgroundColor:
                                                  "rgba(255, 68, 68, 0.2)",
                                              }
                                            : {},
                                      }}
                                    >
                                      {hasBreakpoint && (
                                        <Box
                                          sx={{
                                            width: 10,
                                            height: 10,
                                            borderRadius: "50%",
                                            backgroundColor: isCurrentLine
                                              ? "#ff6666"
                                              : "#e51400",
                                            boxShadow:
                                              "0 0 2px rgba(0,0,0,0.5)",
                                          }}
                                        />
                                      )}
                                      {isCurrentLine && !hasBreakpoint && (
                                        <Box
                                          sx={{
                                            width: 0,
                                            height: 0,
                                            borderLeft: "8px solid #ffcc00",
                                            borderTop: "5px solid transparent",
                                            borderBottom:
                                              "5px solid transparent",
                                          }}
                                        />
                                      )}
                                    </Box>
                                    {/* Line number */}
                                    <Typography
                                      sx={{
                                        color: canSetBreakpoint
                                          ? "#c586c0"
                                          : "#5a5a5a",
                                        minWidth: "35px",
                                        textAlign: "right",
                                        pr: 1,
                                        fontSize: "11px",
                                        userSelect: "none",
                                        fontWeight: 400,
                                      }}
                                    >
                                      {lineNum}
                                    </Typography>
                                    {/* Source code with syntax highlighting */}
                                    <Box
                                      component="pre"
                                      sx={{
                                        fontSize: "11px",
                                        fontFamily: "monospace",
                                        m: 0,
                                        whiteSpace: "pre",
                                        flex: 1,
                                      }}
                                    >
                                      {highlightCCode(codeLine)}
                                    </Box>
                                  </Box>
                                );
                              })
                            ) : (
                              <Box sx={{ p: 2 }}>
                                <Typography
                                  sx={{ color: "#808080", fontSize: "11px" }}
                                >
                                  No content loaded yet.
                                </Typography>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  onClick={() =>
                                    loadSourceFile(file.path, file.directory)
                                  }
                                  sx={{ mt: 1, fontSize: "10px" }}
                                >
                                  Load Source
                                </Button>
                              </Box>
                            )}
                          </Box>
                        );
                      })()
                    ) : (
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          height: "100%",
                          color: "#808080",
                        }}
                      >
                        <FileIcon sx={{ fontSize: 48, opacity: 0.3, mb: 2 }} />
                        <Typography sx={{ fontSize: "12px" }}>
                          Select a file from the sidebar or open a tab
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </Box>
              ) : (
                <Box
                  display="flex"
                  flexDirection="column"
                  alignItems="center"
                  justifyContent="center"
                  height="100%"
                  color="#858585"
                >
                  <CodeIcon sx={{ fontSize: "48px", mb: 2, opacity: 0.5 }} />
                  <Typography variant="body2" textAlign="center">
                    No DWARF source info available
                  </Typography>
                  <Typography
                    variant="caption"
                    color="#626262"
                    textAlign="center"
                    sx={{ mt: 1 }}
                  >
                    Analyze a module with DWARF debug info in the Tools → DWARF
                    tab
                  </Typography>
                </Box>
              )}
            </Box>
          ) : instructions.length > 0 ||
            (loading && previousInstructions.length > 0) ? (
            <AssemblyTableWrapper>
              <AssemblyTableContainer
                ref={tableContainerRef}
                onWheel={handleWheelScroll}
              >
                <AssemblyTable size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {/* Arrow Column Header */}
                      <TableCell
                        sx={{
                          width: `${ARROW_AREA_WIDTH}px`,
                          minWidth: `${ARROW_AREA_WIDTH}px`,
                          maxWidth: `${ARROW_AREA_WIDTH}px`,
                          padding: "4px !important",
                          backgroundColor: "#252526",
                          color: "#4fc1ff",
                          fontWeight: 600,
                          fontSize: "10px",
                          borderBottom: "none !important",
                          borderRight: "1px solid #2d2d30",
                        }}
                      ></TableCell>
                      <BreakpointTableCell
                        sx={{
                          width: `${columnResize.getColumnWidth("breakpoint")}px`,
                          minWidth: `${columnResize.getColumnWidth("breakpoint")}px`,
                          maxWidth: `${columnResize.getColumnWidth("breakpoint")}px`,
                        }}
                      >
                        BP
                        <ColumnResizer
                          onMouseDown={(e) =>
                            columnResize.handleResizeStart("breakpoint", e)
                          }
                          isResizing={
                            columnResize.resizingColumn === "breakpoint"
                          }
                        />
                      </BreakpointTableCell>
                      <AddressTableCell
                        sx={{
                          width: `${columnResize.getColumnWidth("address")}px`,
                          minWidth: `${columnResize.getColumnWidth("address")}px`,
                          maxWidth: `${columnResize.getColumnWidth("address")}px`,
                        }}
                      >
                        Address
                        <ColumnResizer
                          onMouseDown={(e) =>
                            columnResize.handleResizeStart("address", e)
                          }
                          isResizing={columnResize.resizingColumn === "address"}
                        />
                      </AddressTableCell>
                      <DetailTableCell
                        sx={{
                          width: `${columnResize.getColumnWidth("detail")}px`,
                          minWidth: `${columnResize.getColumnWidth("detail")}px`,
                          maxWidth: `${columnResize.getColumnWidth("detail")}px`,
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                          }}
                        >
                          Detail
                          <Tooltip
                            title={
                              addressDisplayFormat === "library"
                                ? "library + offset (click to switch to function)"
                                : "module@function + offset (click to switch to library)"
                            }
                          >
                            <IconButton
                              size="small"
                              onClick={toggleAddressDisplayFormat}
                              sx={{
                                padding: "2px",
                                color:
                                  addressDisplayFormat === "function"
                                    ? "#dcdcaa"
                                    : "#808080",
                                "&:hover": { color: "#fff" },
                              }}
                            >
                              <SwapHorizIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip
                            title={
                              assemblyDemangleEnabled
                                ? "Demangle ON (click to disable)"
                                : "Demangle OFF (click to enable)"
                            }
                          >
                            <IconButton
                              size="small"
                              onClick={toggleAssemblyDemangle}
                              sx={{
                                padding: "2px",
                                color: assemblyDemangleEnabled
                                  ? "#4ec9b0"
                                  : "#808080",
                                "&:hover": { color: "#fff" },
                              }}
                            >
                              <CodeIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                        </Box>
                        <ColumnResizer
                          onMouseDown={(e) =>
                            columnResize.handleResizeStart("detail", e)
                          }
                          isResizing={columnResize.resizingColumn === "detail"}
                        />
                      </DetailTableCell>
                      <BytesTableCell
                        sx={{
                          width: `${columnResize.getColumnWidth("bytes")}px`,
                          minWidth: `${columnResize.getColumnWidth("bytes")}px`,
                          maxWidth: `${columnResize.getColumnWidth("bytes")}px`,
                        }}
                      >
                        Bytes
                        <ColumnResizer
                          onMouseDown={(e) =>
                            columnResize.handleResizeStart("bytes", e)
                          }
                          isResizing={columnResize.resizingColumn === "bytes"}
                        />
                      </BytesTableCell>
                      <InstructionTableCell>Instruction</InstructionTableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(isTransitioning &&
                    previousInstructions.length > 0 &&
                    instructions.length === 0
                      ? previousInstructions
                      : instructions
                    ).map((instruction, index) => {
                      // Always update instruction breakpoint status from current breakpoints state
                      const updatedInstruction = {
                        ...instruction,
                        breakpoint: breakpoints.has(instruction.address),
                        isSoftwareBreakpoint: softwareBreakpoints.has(
                          instruction.address
                        ),
                      };

                      // Calculate arrow info for this row
                      const displayedInstructions =
                        isTransitioning &&
                        previousInstructions.length > 0 &&
                        instructions.length === 0
                          ? previousInstructions
                          : instructions;
                      const rowArrowInfo = calculateRowArrowInfo(
                        index,
                        branchArrows,
                        displayedInstructions.length
                      );

                      return (
                        <DisasmLineComponent
                          key={instruction.address} // Use address as key for better performance
                          instruction={updatedInstruction}
                          rowIndex={index}
                          rowArrowInfo={rowArrowInfo}
                          onAddressClick={(address, event) =>
                            handleAddressClick(address, event)
                          }
                          onDetailClick={(address, event) =>
                            handleInstructionAreaClick(address, event)
                          }
                          onBytesClick={(address, event) =>
                            handleInstructionAreaClick(address, event)
                          }
                          onInstructionClick={(address, event) =>
                            handleInstructionAreaClick(address, event)
                          }
                          onBreakpointClick={handleBreakpointClick}
                          onContextMenu={handleContextMenu}
                          currentBreakAddress={currentBreakAddress}
                          isFocused={focusedLineAddress === instruction.address}
                          onFocus={setFocusedLineAddress}
                          isInBreakState={isInBreakState}
                          softwareBreakpointOriginalBytes={softwareBreakpoints.get(
                            instruction.address
                          )}
                          getModuleDetail={getModuleDetail}
                          getModuleDetailText={getModuleDetailText}
                          getFormattedComment={getFormattedComment}
                          getBranchTargetAddress={getBranchTargetAddress}
                          onCommentClick={(address) => {
                            setAssemblyAddressWithHistory(address);
                            // Also trigger decompile for the target function if available
                            syncDecompileView(address);
                          }}
                          columnWidths={columnResize.columnWidths}
                        />
                      );
                    })}
                  </TableBody>
                </AssemblyTable>
              </AssemblyTableContainer>
            </AssemblyTableWrapper>
          ) : (
            <Box
              display="flex"
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              height="100%"
              color="#858585"
              fontSize="14px"
            >
              <FunctionsIcon sx={{ fontSize: "48px", mb: 2, opacity: 0.5 }} />
              <Typography variant="body2" color="inherit" textAlign="center">
                {loading
                  ? "Loading disassembly..."
                  : error
                    ? "Failed to load disassembly"
                    : !useUIStore.getState().debuggerState.assemblyAddress
                      ? "Select a function to view disassembly"
                      : "No instructions available"}
              </Typography>
              {!loading &&
                !error &&
                !useUIStore.getState().debuggerState.assemblyAddress && (
                  <Typography
                    variant="caption"
                    color="#626262"
                    textAlign="center"
                    sx={{ mt: 1 }}
                  >
                    Choose a function from the sidebar to start debugging
                  </Typography>
                )}
            </Box>
          )}
        </ScrollableContent>
      </DisassemblyContainer>

      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleContextMenuClose}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
        sx={{
          "& .MuiPaper-root": {
            backgroundColor: "#252526",
            border: "1px solid #3c3c3c",
            minWidth: "180px",
          },
          "& .MuiMenuItem-root": {
            fontSize: "12px",
            color: "#d4d4d4",
            "&:hover": {
              backgroundColor: "#094771",
            },
          },
          "& .MuiListItemIcon-root": {
            color: "#858585",
            minWidth: "32px",
          },
        }}
      >
        <MenuItem onClick={handleCopyAddress}>
          <ListItemIcon>
            <CopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy Address</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleCopyAddressWithOffset}>
          <ListItemIcon>
            <CopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy Address (Module + offset)</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleCopyInstruction}>
          <ListItemIcon>
            <CopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy Instruction</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleCopyBytecode}>
          <ListItemIcon>
            <CopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy Bytes</ListItemText>
        </MenuItem>
        <Divider sx={{ borderColor: "#3c3c3c" }} />
        {getContextMenuFunctionBounds() && [
          <MenuItem key="func-start" onClick={handleGoToFunctionStart}>
            <ListItemIcon>
              <FunctionStartIcon fontSize="small" sx={{ color: "#4caf50" }} />
            </ListItemIcon>
            <ListItemText>Go to Function Start</ListItemText>
          </MenuItem>,
          <MenuItem key="func-end" onClick={handleGoToFunctionEnd}>
            <ListItemIcon>
              <FunctionEndIcon fontSize="small" sx={{ color: "#ff9800" }} />
            </ListItemIcon>
            <ListItemText>Go to Function End</ListItemText>
          </MenuItem>,
          <Divider key="func-divider" sx={{ borderColor: "#3c3c3c" }} />,
        ]}
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              toggleBreakpoint(contextMenu.address);
            }
            handleContextMenuClose();
          }}
        >
          <ListItemIcon>
            <BreakpointIcon fontSize="small" sx={{ color: "#ff4444" }} />
          </ListItemIcon>
          <ListItemText>
            {contextMenu && breakpoints.has(contextMenu.address)
              ? "Remove Breakpoint"
              : "Set Breakpoint"}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={handleReplaceWithNop}>
          <ListItemIcon>
            <NopIcon fontSize="small" sx={{ color: "#ffa726" }} />
          </ListItemIcon>
          <ListItemText>Replace with NOP</ListItemText>
        </MenuItem>
        <Divider sx={{ borderColor: "#3c3c3c" }} />
        {/* Code Tracing menu item - enabled for iOS */}
        {serverInfo?.target_os === "ios" && (
          <MenuItem onClick={handleStartCodeTracing}>
            <ListItemIcon>
              <TimelineIcon fontSize="small" sx={{ color: "#4caf50" }} />
            </ListItemIcon>
            <ListItemText>Code Tracing</ListItemText>
          </MenuItem>
        )}
        <MenuItem onClick={handleOpenGraphView}>
          <ListItemIcon>
            <GraphIcon fontSize="small" sx={{ color: "#9c27b0" }} />
          </ListItemIcon>
          <ListItemText>Graph View</ListItemText>
        </MenuItem>
        {/* Ghidra Integration - only show when library is analyzed and inside a function */}
        {contextMenuHasLibrary &&
          contextMenuLibraryAnalyzed &&
          getContextMenuFunctionBounds() !== null && [
            <Divider key="ghidra-divider" sx={{ borderColor: "#3c3c3c" }} />,
            <MenuItem
              key="ghidra-decompile"
              onClick={handleDecompileWithGhidra}
              disabled={isDecompiling}
            >
              <ListItemIcon>
                {isDecompiling ? (
                  <CircularProgress size={16} sx={{ color: "#4fc1ff" }} />
                ) : (
                  <DecompileIcon fontSize="small" sx={{ color: "#4fc1ff" }} />
                )}
              </ListItemIcon>
              <ListItemText>
                {isDecompiling ? "Decompiling..." : "Decompile"}
              </ListItemText>
            </MenuItem>,
            <MenuItem
              key="ghidra-xrefs"
              onClick={handleGetXrefs}
              disabled={xrefLoading}
            >
              <ListItemIcon>
                {xrefLoading ? (
                  <CircularProgress size={16} sx={{ color: "#c586c0" }} />
                ) : (
                  <CallReceivedIcon
                    fontSize="small"
                    sx={{ color: "#c586c0" }}
                  />
                )}
              </ListItemIcon>
              <ListItemText>
                {xrefLoading
                  ? "Finding References..."
                  : "Find References to This Function"}
              </ListItemText>
            </MenuItem>,
          ]}
      </Menu>

      {/* Trace Count Dialog */}
      <Dialog
        open={traceCountDialogOpen}
        onClose={() => setTraceCountDialogOpen(false)}
        PaperProps={{
          sx: {
            backgroundColor: "#252526",
            border: "1px solid #3c3c3c",
            minWidth: "350px",
          },
        }}
      >
        <DialogTitle sx={{ color: "#4fc1ff", fontSize: "14px", pb: 1 }}>
          Code Tracing
        </DialogTitle>
        <DialogContent>
          <Typography
            variant="body2"
            sx={{ color: "#d4d4d4", mb: 2, fontSize: "12px" }}
          >
            Trace execution at address:{" "}
            <span style={{ color: "#4fc1ff" }}>{pendingTraceAddress}</span>
          </Typography>
          <TextField
            autoFocus
            label="Max count (stop after N hits)"
            type="number"
            fullWidth
            size="small"
            value={traceCountInput}
            onChange={(e) => setTraceCountInput(e.target.value)}
            inputProps={{ min: 1, max: 100000 }}
            sx={{
              mb: 2,
              "& .MuiInputBase-input": {
                color: "#d4d4d4",
              },
              "& .MuiInputLabel-root": {
                color: "#858585",
              },
              "& .MuiOutlinedInput-root": {
                "& fieldset": { borderColor: "#3c3c3c" },
                "&:hover fieldset": { borderColor: "#4fc1ff" },
                "&.Mui-focused fieldset": { borderColor: "#4fc1ff" },
              },
            }}
          />
          <TextField
            label="End address (optional, e.g. 0x12345678)"
            fullWidth
            size="small"
            value={traceEndAddressInput}
            onChange={(e) => setTraceEndAddressInput(e.target.value)}
            placeholder="Leave empty to trace until max count"
            sx={{
              mb: 2,
              "& .MuiInputBase-input": {
                color: "#d4d4d4",
                fontFamily: 'Consolas, "Courier New", monospace',
              },
              "& .MuiInputLabel-root": {
                color: "#858585",
              },
              "& .MuiOutlinedInput-root": {
                "& fieldset": { borderColor: "#3c3c3c" },
                "&:hover fieldset": { borderColor: "#4fc1ff" },
                "&.Mui-focused fieldset": { borderColor: "#4fc1ff" },
              },
            }}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={traceToFile}
                onChange={(e) => setTraceToFile(e.target.checked)}
                sx={{
                  color: "#858585",
                  "&.Mui-checked": { color: "#4fc1ff" },
                }}
              />
            }
            label={
              <Typography sx={{ color: "#d4d4d4", fontSize: "12px" }}>
                Save to file (includes x0-x5 memory dumps)
              </Typography>
            }
          />
          {traceToFile && (
            <Typography
              variant="caption"
              sx={{ color: "#858585", display: "block", ml: 4, mt: 0.5 }}
            >
              Trace will be saved on server. Download after completion.
            </Typography>
          )}
          <Divider sx={{ my: 2, borderColor: "#3c3c3c" }} />
          <Button
            size="small"
            onClick={async () => {
              setTraceCountDialogOpen(false);
              try {
                // Use Rust-side file dialog
                const filePath = await invoke<string | null>(
                  "open_trace_file_dialog"
                );
                if (!filePath) {
                  return; // User cancelled
                }

                // Open CodeTracingWindow with file path (localFilePath mode)
                openCodeTracingWindow("0x0", 0, false, filePath);
                addLog("INFO", "TRACING", `Loading trace file: ${filePath}`);
              } catch (err) {
                console.error("Failed to open trace file dialog:", err);
                addLog(
                  "ERROR",
                  "TRACING",
                  `Failed to open trace file dialog: ${err}`
                );
              }
            }}
            sx={{
              color: "#9cdcfe",
              fontSize: "11px",
              textTransform: "none",
            }}
          >
            Load from trace file...
          </Button>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setTraceCountDialogOpen(false)}
            sx={{ color: "#858585" }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleExecuteCodeTracing}
            variant="contained"
            sx={{
              backgroundColor: "#0e639c",
              "&:hover": { backgroundColor: "#1177bb" },
            }}
          >
            Start Trace
          </Button>
        </DialogActions>
      </Dialog>

      {/* Graph View Address Range Dialog */}
      <Dialog
        open={graphViewDialogOpen}
        onClose={() => setGraphViewDialogOpen(false)}
        PaperProps={{
          sx: {
            backgroundColor: "#252526",
            border: "1px solid #3c3c3c",
            minWidth: "400px",
          },
        }}
      >
        <DialogTitle sx={{ color: "#4fc1ff", fontSize: "14px", pb: 1 }}>
          Graph View - Address Range
        </DialogTitle>
        <DialogContent>
          {pendingGraphViewFunctionName && (
            <Typography
              variant="body2"
              sx={{
                color: "#dcdcaa",
                mb: 1,
                fontSize: "12px",
                fontFamily: 'Consolas, "Courier New", monospace',
              }}
            >
              Function: {pendingGraphViewFunctionName}
            </Typography>
          )}
          <Typography
            variant="body2"
            sx={{ color: "#808080", mb: 2, fontSize: "11px" }}
          >
            Specify the address range for CFG generation. The range is
            automatically detected from function boundaries.
          </Typography>
          <TextField
            autoFocus
            label="Start Address"
            type="text"
            fullWidth
            size="small"
            value={graphViewStartAddress}
            onChange={(e) => setGraphViewStartAddress(e.target.value)}
            placeholder="0x..."
            sx={{
              mb: 2,
              "& .MuiInputBase-input": {
                color: "#d4d4d4",
                fontFamily: 'Consolas, "Courier New", monospace',
              },
              "& .MuiInputLabel-root": {
                color: "#858585",
              },
              "& .MuiOutlinedInput-root": {
                "& fieldset": { borderColor: "#3c3c3c" },
                "&:hover fieldset": { borderColor: "#4fc1ff" },
                "&.Mui-focused fieldset": { borderColor: "#4fc1ff" },
              },
            }}
          />
          <TextField
            label="End Address"
            type="text"
            fullWidth
            size="small"
            value={graphViewEndAddress}
            onChange={(e) => setGraphViewEndAddress(e.target.value)}
            placeholder="0x..."
            sx={{
              "& .MuiInputBase-input": {
                color: "#d4d4d4",
                fontFamily: 'Consolas, "Courier New", monospace',
              },
              "& .MuiInputLabel-root": {
                color: "#858585",
              },
              "& .MuiOutlinedInput-root": {
                "& fieldset": { borderColor: "#3c3c3c" },
                "&:hover fieldset": { borderColor: "#4fc1ff" },
                "&.Mui-focused fieldset": { borderColor: "#4fc1ff" },
              },
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setGraphViewDialogOpen(false)}
            sx={{ color: "#858585" }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleExecuteGraphView}
            variant="contained"
            sx={{
              backgroundColor: "#0e639c",
              "&:hover": { backgroundColor: "#1177bb" },
            }}
          >
            Open Graph View
          </Button>
        </DialogActions>
      </Dialog>

      {/* Ghidra Settings Dialog */}
      <Dialog
        open={ghidraSettingsDialogOpen}
        onClose={() => {
          setGhidraSettingsDialogOpen(false);
          setPendingGhidraAction(null);
          setPendingGhidraLibraryInfo(null);
          setPendingGhidraAddress(null);
        }}
        PaperProps={{
          sx: {
            backgroundColor: "#252526",
            border: "1px solid #3c3c3c",
            minWidth: "500px",
          },
        }}
      >
        <DialogTitle sx={{ color: "#4fc1ff", fontSize: "14px", pb: 1 }}>
          Ghidra Configuration
        </DialogTitle>
        <DialogContent>
          <Typography
            variant="body2"
            sx={{ color: "#808080", mb: 2, fontSize: "11px" }}
          >
            Configure the path to your Ghidra installation directory. Example:
            C:\ghidra_11.0 or /opt/ghidra
          </Typography>
          <TextField
            autoFocus
            label="Ghidra Installation Path"
            type="text"
            fullWidth
            size="small"
            value={ghidraPathInput}
            onChange={(e) => setGhidraPathInput(e.target.value)}
            placeholder="C:\ghidra_11.0 or /opt/ghidra"
            sx={{
              "& .MuiInputBase-input": {
                color: "#d4d4d4",
                fontFamily: 'Consolas, "Courier New", monospace',
              },
              "& .MuiInputLabel-root": {
                color: "#858585",
              },
              "& .MuiOutlinedInput-root": {
                "& fieldset": { borderColor: "#3c3c3c" },
                "&:hover fieldset": { borderColor: "#4fc1ff" },
                "&.Mui-focused fieldset": { borderColor: "#4fc1ff" },
              },
            }}
          />
          {isAnalyzing && (
            <Box sx={{ mt: 2, display: "flex", alignItems: "center", gap: 1 }}>
              <CircularProgress size={16} sx={{ color: "#ff7043" }} />
              <Typography
                variant="body2"
                sx={{ color: "#d4d4d4", fontSize: "11px" }}
              >
                {analysisProgress}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => {
              setGhidraSettingsDialogOpen(false);
              setPendingGhidraAction(null);
              setPendingGhidraLibraryInfo(null);
              setPendingGhidraAddress(null);
            }}
            sx={{ color: "#858585" }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveGhidraSettings}
            variant="contained"
            disabled={!ghidraPathInput}
            sx={{
              backgroundColor: "#0e639c",
              "&:hover": { backgroundColor: "#1177bb" },
            }}
          >
            {pendingGhidraAction === "analyze"
              ? "Analyze"
              : pendingGhidraAction === "decompile"
                ? "Decompile"
                : "Run"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Xref Dialog */}
      <Dialog
        open={xrefDialogOpen}
        onClose={() => setXrefDialogOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            backgroundColor: "#252526",
            border: "1px solid #3c3c3c",
            maxHeight: "70vh",
          },
        }}
      >
        <DialogTitle
          sx={{
            color: "#cccccc",
            fontSize: "14px",
            display: "flex",
            alignItems: "center",
            gap: 1,
            borderBottom: "1px solid #3c3c3c",
          }}
        >
          <CallReceivedIcon sx={{ color: "#c586c0" }} />
          Cross References to{" "}
          <span style={{ color: "#dcdcaa" }}>
            {xrefData?.targetFunction || "..."}
          </span>
        </DialogTitle>
        <DialogContent sx={{ p: 0 }}>
          {xrefLoading ? (
            <Box
              sx={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                py: 4,
              }}
            >
              <CircularProgress size={24} sx={{ color: "#c586c0" }} />
              <Typography sx={{ ml: 2, color: "#858585" }}>
                Loading xrefs...
              </Typography>
            </Box>
          ) : xrefData === null ? (
            <Box sx={{ py: 4, textAlign: "center" }}>
              <Typography sx={{ color: "#858585" }}>Preparing...</Typography>
            </Box>
          ) : xrefData && xrefData.xrefs.length > 0 ? (
            <Table size="small" sx={{ fontFamily: "Consolas, monospace" }}>
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{
                      color: "#569cd6",
                      borderBottom: "1px solid #3c3c3c",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    From Address
                  </TableCell>
                  <TableCell
                    sx={{
                      color: "#569cd6",
                      borderBottom: "1px solid #3c3c3c",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    From Function
                  </TableCell>
                  <TableCell
                    sx={{
                      color: "#569cd6",
                      borderBottom: "1px solid #3c3c3c",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    Type
                  </TableCell>
                  <TableCell
                    sx={{
                      color: "#569cd6",
                      borderBottom: "1px solid #3c3c3c",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    Instruction
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {xrefData.xrefs.map((xref, index) => {
                  // Convert offset to real memory address
                  const offset = parseInt(xref.from_address, 16);
                  const realAddress = !isNaN(offset)
                    ? xrefData.moduleBase + offset
                    : 0;
                  const realAddressHex = `0x${realAddress.toString(16)}`;

                  return (
                    <TableRow
                      key={index}
                      sx={{
                        "&:hover": {
                          backgroundColor: "rgba(255,255,255,0.05)",
                        },
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        // Jump to the real memory address (with history for Back button)
                        if (realAddress > 0) {
                          setAssemblyAddressWithHistory(realAddressHex);
                          setXrefDialogOpen(false);
                          addLog(
                            "INFO",
                            "XREF",
                            `Navigating to: ${realAddressHex} (${xref.from_function || "unknown"})`
                          );
                        } else {
                          addLog(
                            "INFO",
                            "XREF",
                            `Address: ${realAddressHex} (${xref.from_function || "unknown"})`
                          );
                        }
                      }}
                    >
                      <TableCell
                        sx={{
                          color: "#b5cea8",
                          borderBottom: "1px solid #2d2d2d",
                          fontSize: "11px",
                          fontFamily: "Consolas, monospace",
                        }}
                      >
                        {realAddressHex}
                      </TableCell>
                      <TableCell
                        sx={{
                          color: "#dcdcaa",
                          borderBottom: "1px solid #2d2d2d",
                          fontSize: "11px",
                          fontFamily: "Consolas, monospace",
                          maxWidth: "300px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={
                          xref.from_function
                            ? `${xrefData.moduleName}@${xref.from_function}+${xref.from_function_offset || xref.from_address}`
                            : `${xrefData.moduleName}+${xref.from_address}`
                        }
                      >
                        {(() => {
                          // Truncate template arguments for readability
                          const simplify = (name: string) => {
                            let result = name;
                            let depth = 0;
                            let start = -1;
                            for (let i = 0; i < result.length; i++) {
                              if (result[i] === "<") {
                                if (depth === 0) start = i;
                                depth++;
                              } else if (result[i] === ">") {
                                depth--;
                                if (depth === 0 && start !== -1) {
                                  result =
                                    result.substring(0, start + 1) +
                                    "..." +
                                    result.substring(i);
                                  i = start + 4;
                                  start = -1;
                                }
                              }
                            }
                            return result;
                          };
                          const funcName = xref.from_function
                            ? simplify(xref.from_function)
                            : null;
                          // Use from_function_offset (offset within function) when available,
                          // otherwise fall back to from_address (module offset)
                          const offsetStr =
                            funcName && xref.from_function_offset
                              ? xref.from_function_offset
                              : xref.from_address;
                          return funcName
                            ? `${xrefData.moduleName}@${funcName}+${offsetStr}`
                            : `${xrefData.moduleName}+${xref.from_address}`;
                        })()}
                      </TableCell>
                      <TableCell
                        sx={{
                          color: "#9cdcfe",
                          borderBottom: "1px solid #2d2d2d",
                          fontSize: "11px",
                          fontFamily: "Consolas, monospace",
                        }}
                      >
                        {xref.ref_type}
                      </TableCell>
                      <TableCell
                        sx={{
                          color: "#ce9178",
                          borderBottom: "1px solid #2d2d2d",
                          fontSize: "11px",
                          fontFamily: "Consolas, monospace",
                        }}
                      >
                        {xref.instruction || "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Box sx={{ py: 4, textAlign: "center" }}>
              <Typography sx={{ color: "#858585" }}>
                No cross references found
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5, borderTop: "1px solid #3c3c3c" }}>
          <Typography
            variant="body2"
            sx={{ color: "#858585", fontSize: "11px", mr: "auto" }}
          >
            {xrefData ? `${xrefData.xrefs.length} reference(s) found` : ""}
          </Typography>
          <Button
            onClick={() => setXrefDialogOpen(false)}
            sx={{ color: "#858585" }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Debugger Settings Dialog */}
      <Dialog
        open={debuggerSettingsOpen}
        onClose={() => setDebuggerSettingsOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            backgroundColor: "#1e1e1e",
            color: "#d4d4d4",
            border: "1px solid #3c3c3c",
          },
        }}
      >
        <DialogTitle
          sx={{
            borderBottom: "1px solid #3c3c3c",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <SettingsIcon sx={{ fontSize: 20 }} />
          Debugger Settings
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          <Typography
            variant="subtitle2"
            sx={{ color: "#858585", mt: 1, mb: 3 }}
          >
            Configure signal handling (like GDB's handle command):
            <br />• <strong>Catch</strong>: Stop debugger when signal occurs
            <br />• <strong>Pass</strong>: Deliver signal to process on continue
            <br />
            <em style={{ fontSize: "0.85em" }}>
              Default: Catch=OFF, Pass=OFF (signals suppressed silently, like
              GDB)
            </em>
          </Typography>
          {loadingSignals ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress size={24} sx={{ color: "#4fc1ff" }} />
            </Box>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell
                    padding="checkbox"
                    sx={{ color: "#858585", borderBottom: "1px solid #3c3c3c" }}
                  >
                    Catch
                  </TableCell>
                  <TableCell
                    padding="checkbox"
                    sx={{ color: "#858585", borderBottom: "1px solid #3c3c3c" }}
                  >
                    Pass
                  </TableCell>
                  <TableCell
                    sx={{
                      color: "#858585",
                      borderBottom: "1px solid #3c3c3c",
                      cursor: "pointer",
                    }}
                  >
                    <TableSortLabel
                      active={signalSortField === "signal"}
                      direction={
                        signalSortField === "signal" ? signalSortOrder : "asc"
                      }
                      onClick={() => handleSignalSortChange("signal")}
                      sx={{
                        color: "#858585 !important",
                        "&.Mui-active": { color: "#4fc1ff !important" },
                        "& .MuiTableSortLabel-icon": {
                          color: "#4fc1ff !important",
                        },
                      }}
                    >
                      Signal #
                    </TableSortLabel>
                  </TableCell>
                  <TableCell
                    sx={{
                      color: "#858585",
                      borderBottom: "1px solid #3c3c3c",
                      cursor: "pointer",
                    }}
                  >
                    <TableSortLabel
                      active={signalSortField === "name"}
                      direction={
                        signalSortField === "name" ? signalSortOrder : "asc"
                      }
                      onClick={() => handleSignalSortChange("name")}
                      sx={{
                        color: "#858585 !important",
                        "&.Mui-active": { color: "#4fc1ff !important" },
                        "& .MuiTableSortLabel-icon": {
                          color: "#4fc1ff !important",
                        },
                      }}
                    >
                      Name
                    </TableSortLabel>
                  </TableCell>
                  <TableCell
                    sx={{ color: "#858585", borderBottom: "1px solid #3c3c3c" }}
                  >
                    Description
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {signalDefinitions.map((sig) => {
                  const config = getSignalConfig(sig.signal);
                  return (
                    <TableRow
                      key={sig.signal}
                      hover
                      sx={{
                        "&:hover": {
                          backgroundColor: "rgba(255, 255, 255, 0.05)",
                        },
                      }}
                    >
                      <TableCell
                        padding="checkbox"
                        sx={{ borderBottom: "1px solid #2d2d2d" }}
                      >
                        <Checkbox
                          checked={config.catch_signal}
                          onChange={() => handleToggleSignalCatch(sig.signal)}
                          size="small"
                          sx={{
                            color: "#858585",
                            "&.Mui-checked": {
                              color: "#4fc1ff",
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell
                        padding="checkbox"
                        sx={{ borderBottom: "1px solid #2d2d2d" }}
                      >
                        <Checkbox
                          checked={config.pass_signal}
                          onChange={() => handleToggleSignalPass(sig.signal)}
                          size="small"
                          sx={{
                            color: "#858585",
                            "&.Mui-checked": {
                              color: "#ce9178",
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell
                        sx={{
                          color: "#d4d4d4",
                          fontFamily: "monospace",
                          borderBottom: "1px solid #2d2d2d",
                        }}
                      >
                        {sig.signal}
                      </TableCell>
                      <TableCell
                        sx={{
                          color: "#4fc1ff",
                          fontFamily: "monospace",
                          fontWeight: 500,
                          borderBottom: "1px solid #2d2d2d",
                        }}
                      >
                        {sig.name}
                      </TableCell>
                      <TableCell
                        sx={{
                          color: "#858585",
                          borderBottom: "1px solid #2d2d2d",
                        }}
                      >
                        {sig.description}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions sx={{ borderTop: "1px solid #3c3c3c", p: 2 }}>
          <Button
            onClick={() => setDebuggerSettingsOpen(false)}
            sx={{ color: "#858585" }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* File Trace Progress Snackbar */}
      <Snackbar
        open={fileTraceProgress?.isActive ?? false}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          severity="info"
          icon={<CircularProgress size={20} sx={{ color: "#4fc1ff" }} />}
          sx={{
            backgroundColor: "#2d2d30",
            color: "#d4d4d4",
            border: "1px solid #4fc1ff",
            minWidth: "300px",
            "& .MuiAlert-icon": {
              alignItems: "center",
            },
          }}
        >
          <Box>
            <Typography variant="body2" sx={{ fontWeight: "bold", mb: 0.5 }}>
              File Trace in Progress
            </Typography>
            <Typography variant="body2">
              {fileTraceProgress?.current ?? 0} /{" "}
              {fileTraceProgress?.total ?? 0} instructions
            </Typography>
            <Box
              sx={{
                width: "100%",
                height: 4,
                backgroundColor: "#3c3c3c",
                borderRadius: 2,
                mt: 1,
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  width: `${((fileTraceProgress?.current ?? 0) / (fileTraceProgress?.total || 1)) * 100}%`,
                  height: "100%",
                  backgroundColor: "#4fc1ff",
                  transition: "width 0.2s ease",
                }}
              />
            </Box>
          </Box>
        </Alert>
      </Snackbar>

      {/* File Trace Complete Dialog */}
      <Dialog
        open={fileTraceCompleteDialog.open}
        onClose={() =>
          setFileTraceCompleteDialog({
            open: false,
            entryCount: 0,
            filePath: "",
            downloaded: false,
          })
        }
        PaperProps={{
          sx: {
            backgroundColor: "#252526",
            border: "1px solid #3c3c3c",
            minWidth: "450px",
          },
        }}
      >
        <DialogTitle
          sx={{
            color: "#4caf50",
            fontSize: "14px",
            pb: 1,
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <CheckCircleOutlineIcon sx={{ color: "#4caf50" }} />
          File Trace Complete
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: "#d4d4d4", mb: 2 }}>
            Trace completed successfully with{" "}
            <strong>{fileTraceCompleteDialog.entryCount}</strong> instructions.
          </Typography>
          <Box
            sx={{
              backgroundColor: "#1e1e1e",
              padding: "12px",
              borderRadius: "4px",
              border: "1px solid #3c3c3c",
            }}
          >
            <Typography
              variant="caption"
              sx={{ color: "#858585", display: "block", mb: 0.5 }}
            >
              {fileTraceCompleteDialog.downloaded
                ? "Downloaded to host:"
                : "File Location (on server/device):"}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "#9cdcfe",
                fontFamily: 'Consolas, "Courier New", monospace',
                wordBreak: "break-all",
              }}
            >
              {fileTraceCompleteDialog.filePath}
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() =>
              setFileTraceCompleteDialog({
                open: false,
                entryCount: 0,
                filePath: "",
                downloaded: false,
              })
            }
            sx={{ color: "#858585" }}
          >
            Close
          </Button>
          {!fileTraceCompleteDialog.downloaded && (
            <Button
              onClick={async () => {
                // Download file to host PC using browser download
                try {
                  const api = getApiClient();
                  const blob = await api.downloadTraceFile();

                  const fileName = `trace_${Date.now()}.dyntrace`;
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = fileName;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);

                  addLog(
                    "INFO",
                    "TRACING",
                    `Trace file downloaded: ${fileName} (check your Downloads folder)`
                  );

                  // Show success message in dialog and mark as downloaded
                  setFileTraceCompleteDialog((prev) => ({
                    ...prev,
                    filePath: `${fileName}\n(Check your browser's Downloads folder)`,
                    downloaded: true,
                  }));
                } catch (err) {
                  console.error("Failed to download trace file:", err);
                  addLog(
                    "ERROR",
                    "TRACING",
                    `Failed to download trace file: ${err}`
                  );
                  setFileTraceCompleteDialog((prev) => ({
                    ...prev,
                    filePath: `✗ Download failed: ${err}`,
                  }));
                }
              }}
              variant="outlined"
              sx={{
                borderColor: "#4fc1ff",
                color: "#4fc1ff",
                "&:hover": {
                  borderColor: "#6fd3ff",
                  backgroundColor: "rgba(79, 193, 255, 0.1)",
                },
              }}
            >
              Download
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Processing Snackbar for long-running Ghidra operations */}
      <Snackbar
        open={processingSnackbar.open}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity="info"
          icon={<CircularProgress size={20} sx={{ color: "#4fc1ff" }} />}
          sx={{
            backgroundColor: "#2d2d30",
            color: "#d4d4d4",
            border: "1px solid #4fc1ff",
            "& .MuiAlert-icon": {
              alignItems: "center",
            },
          }}
        >
          {processingSnackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};
