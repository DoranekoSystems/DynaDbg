import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  styled,
  CircularProgress,
} from "@mui/material";
import { GhidraTokenInfo } from "../hooks/useGhidraAnalysis";
import {
  ToggleOn,
  ToggleOff,
  Code as CodeIcon,
  Transform as AIIcon,
  Refresh as RefreshIcon,
} from "@mui/icons-material";

interface DecompileViewProps {
  functionName?: string;
  functionAddress?: string;
  libraryName?: string; // Library name (e.g., libc.so.6)
  isVisible?: boolean;
  onToggleVisibility?: () => void;
  currentBreakAddress?: string | null;
  isInBreakState?: boolean;
  onLineClick?: (lineNumber: number, lineText: string) => void;
  onAIEnhance?: () => void;
  // Ghidra integration props
  ghidraCode?: string | null;
  ghidraError?: string | null; // Error message from Ghidra
  isGhidraLoading?: boolean;
  onRefreshDecompile?: () => void;
  // Address click handler for navigation to assembly
  onAddressClick?: (address: string) => void;
  // Function click handler - called when FUN_xxx is clicked in decompile code
  onFunctionClick?: (functionOffset: string) => void;
  // Line number to scroll to and highlight (set from assembly view)
  scrollToLineNumber?: number | null;
  // Line mapping from Ghidra (line number as string -> offset)
  lineMapping?: Record<string, string> | null;
  // Module base address for calculating absolute addresses
  moduleBase?: number;
  // Token information from Ghidra for accurate syntax highlighting
  tokens?: GhidraTokenInfo[] | null;
  // Breakpoint support
  activeBreakpoints?: string[]; // List of active breakpoint addresses
  onBreakpointSet?: (address: string) => void;
  onBreakpointRemove?: (address: string) => void;
}

const DecompileContainer = styled(Box)(() => ({
  height: "100%",
  backgroundColor: "#1e1e1e",
  position: "relative",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
}));

const DecompileHeader = styled(Box)(() => ({
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

const DecompileTitle = styled(Typography)(() => ({
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

const DecompileContent = styled(Box)(() => ({
  flex: 1,
  overflow: "auto", // Both vertical and horizontal scroll
  padding: "8px",
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: "12px",
  lineHeight: "18px",
  overflowX: "auto", // Explicit horizontal scroll
  "@media (max-height: 800px)": {
    padding: "4px",
    fontSize: "10px",
    lineHeight: "14px",
  },
  "&::-webkit-scrollbar": {
    width: "8px",
    height: "8px", // For horizontal scrollbar
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

const SourceLine = styled(Box, {
  shouldForwardProp: (prop) =>
    prop !== "isHighlighted" &&
    prop !== "isClickable" &&
    prop !== "hasBreakpoint" &&
    prop !== "isCurrentBreak",
})<{
  isHighlighted?: boolean;
  isClickable?: boolean;
  hasBreakpoint?: boolean;
  isCurrentBreak?: boolean;
}>(({ isHighlighted, isClickable, hasBreakpoint, isCurrentBreak }) => ({
  display: "flex",
  alignItems: "center",
  padding: "2px 8px",
  cursor: isClickable ? "pointer" : "default",
  backgroundColor: isCurrentBreak
    ? "rgba(76, 175, 80, 0.2)" // Green for current break line (same as AssemblyView)
    : hasBreakpoint
      ? "rgba(229, 20, 0, 0.15)"
      : isHighlighted
        ? "rgba(79, 193, 255, 0.15)" // Cyan for selected line (distinct from green)
        : "transparent",
  borderLeft: isCurrentBreak
    ? "3px solid #4CAF50" // Green border for current break line (same as AssemblyView)
    : hasBreakpoint
      ? "3px solid #e51400"
      : isHighlighted
        ? "3px solid #4fc1ff" // Cyan border for selected line
        : "3px solid transparent",
  whiteSpace: "nowrap", // Prevent line wrapping
  minWidth: "fit-content", // Allow line to extend beyond container
  "&:hover": {
    backgroundColor: isClickable
      ? isCurrentBreak
        ? "rgba(76, 175, 80, 0.3)" // Green hover for current break
        : hasBreakpoint
          ? "rgba(229, 20, 0, 0.25)"
          : isHighlighted
            ? "rgba(79, 193, 255, 0.25)"
            : "rgba(79, 193, 255, 0.1)"
      : isCurrentBreak
        ? "rgba(76, 175, 80, 0.2)" // Green for current break
        : hasBreakpoint
          ? "rgba(229, 20, 0, 0.15)"
          : isHighlighted
            ? "rgba(79, 193, 255, 0.15)"
            : "transparent",
  },
  transition: "background-color 0.15s ease, border-color 0.15s ease",
}));

// Code content wrapper - preserves whitespace and enables horizontal scroll
const CodeContent = styled("span")({
  flex: 1,
  whiteSpace: "pre", // Preserve whitespace including indentation
  overflow: "visible", // Allow horizontal scroll at container level
  minWidth: 0,
});

const LineNumber = styled("span")(() => ({
  color: "#858585",
  marginRight: "8px",
  minWidth: "30px",
  display: "inline-block",
  textAlign: "right",
}));

// Breakpoint gutter area (left of line numbers)
const BreakpointGutter = styled("span")<{
  hasBreakpoint?: boolean;
  hasMapping?: boolean;
}>(({ hasBreakpoint, hasMapping }) => ({
  width: "20px",
  minWidth: "20px",
  height: "18px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginRight: "4px",
  cursor: hasMapping ? "pointer" : "default",
  backgroundColor: hasBreakpoint ? "rgba(244, 135, 113, 0.15)" : "transparent",
  "&:hover": hasMapping
    ? {
        backgroundColor: hasBreakpoint
          ? "rgba(244, 135, 113, 0.25)"
          : "rgba(136, 136, 136, 0.15)",
        "& .breakpoint-dot": {
          opacity: 1,
          transform: "scale(1.1)",
        },
      }
    : {},
  "& .breakpoint-dot": {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    backgroundColor: hasBreakpoint ? "#e51400" : "#666",
    opacity: hasBreakpoint ? 1 : 0,
    transition:
      "opacity 0.15s ease, transform 0.15s ease, background-color 0.15s ease",
    boxShadow: hasBreakpoint ? "0 0 4px rgba(229, 20, 0, 0.5)" : "none",
  },
}));

const KeywordSpan = styled("span")(() => ({
  color: "#569cd6", // Blue for keywords
  fontWeight: "bold",
}));

const TypeSpan = styled("span")(() => ({
  color: "#4ec9b0", // Teal for types
}));

const StringSpan = styled("span")(() => ({
  color: "#ce9178", // Orange for strings
}));

const CommentSpan = styled("span")(() => ({
  color: "#6a9955", // Green for comments
  fontStyle: "italic",
}));

// NumberSpan - disabled per user request (no number highlighting)
// const NumberSpan = styled("span")(() => ({
//   color: "#b5cea8", // Light green for numbers
// }));

// AddressSpan - reserved for future use
// const AddressSpan = styled("span")(() => ({
//   color: "#dcdcaa", // Yellow for addresses
//   cursor: "pointer",
//   textDecoration: "underline",
//   textDecorationStyle: "dotted",
//   "&:hover": {
//     color: "#ffcc00",
//     textDecoration: "underline",
//     textDecorationStyle: "solid",
//   },
// }));

const FunctionCallSpan = styled("span")(() => ({
  color: "#dcdcaa", // Yellow for function calls
}));

// ClickableFunctionSpan - reserved for future use
// const ClickableFunctionSpan = styled("span")(() => ({
//   color: "#dcdcaa", // Yellow for function calls
//   cursor: "pointer",
//   textDecoration: "underline",
//   textDecorationStyle: "dotted",
//   "&:hover": {
//     color: "#ffcc00",
//     textDecoration: "underline",
//     textDecorationStyle: "solid",
//   },
// }));

const VariableSpan = styled("span")(() => ({
  color: "#9cdcfe", // Light blue for variables (VS Code style)
}));

// ParameterSpan - reserved for future use
// const ParameterSpan = styled("span")(() => ({
//   color: "#9cdcfe", // Light blue for parameters
// }));

const WarningSpan = styled("span")(() => ({
  color: "#ff8c00", // Orange for warnings
  fontStyle: "italic",
}));

// インデントを追加する関数（行番号を保持）
// Add indentation to decompiled C++ code without changing line numbers
const addIndentation = (lines: string[]): string[] => {
  let indentLevel = 0;
  const indentStr = "    "; // 4 spaces per indent level

  return lines.map((line) => {
    const trimmed = line.trim();

    // Skip empty lines - preserve them as empty
    if (trimmed === "") {
      return "";
    }

    // Count braces, ignoring those inside strings/chars
    let openCount = 0;
    let closeCount = 0;
    let inString = false;
    let inChar = false;
    let escape = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\") {
        escape = true;
        continue;
      }

      if (!inChar && char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString && char === "'") {
        inChar = !inChar;
        continue;
      }

      if (!inString && !inChar) {
        if (char === "{") {
          openCount++;
        } else if (char === "}") {
          closeCount++;
        }
      }
    }

    // Determine indent level for this line
    // If line starts with }, decrease indent before printing this line
    let lineIndent = indentLevel;

    // Count leading close braces to determine how much to decrease for this line
    let leadingCloses = 0;
    for (const char of trimmed) {
      if (char === "}") {
        leadingCloses++;
      } else if (char !== " " && char !== "\t") {
        break;
      }
    }

    // Decrease indent for leading close braces
    lineIndent = Math.max(0, lineIndent - leadingCloses);

    // Apply current indent
    const indented = indentStr.repeat(lineIndent) + trimmed;

    // Update indent level for next line
    // Net effect: +opens, -closes (but leading closes already applied to this line)
    indentLevel = Math.max(0, indentLevel + openCount - closeCount);

    return indented;
  });
};

// シンタックスハイライト機能
const highlightSyntax = (
  line: string,
  onAddressClick?: (address: string) => void,
  onFunctionClick?: (functionOffset: string) => void,
  lineFunctionTokens?: Map<string, GhidraTokenInfo>
): React.ReactNode => {
  // C/C++キーワード
  const keywords = [
    "int",
    "void",
    "char",
    "float",
    "double",
    "if",
    "else",
    "while",
    "for",
    "return",
    "break",
    "continue",
    "sizeof",
    "struct",
    "union",
    "enum",
    "const",
    "static",
    "extern",
    "auto",
    "register",
    "volatile",
    "unsigned",
    "signed",
    "long",
    "short",
    "typedef",
    "include",
    "define",
  ];

  const numberPattern = /\b\d+\b/g;
  const stringPattern = /"[^"]*"/g;
  const commentPattern = /\/\/.*$/;

  const result: React.ReactNode[] = [];

  const commentMatch = line.match(commentPattern);
  if (commentMatch) {
    const commentStart = commentMatch.index!;
    const beforeComment = line.substring(0, commentStart);
    const comment = line.substring(commentStart);

    // WARNINGコメントの特別処理
    if (comment.includes("WARNING")) {
      result.push(
        ...processSyntax(
          beforeComment,
          keywords,
          numberPattern,
          stringPattern,
          onAddressClick,
          onFunctionClick,
          lineFunctionTokens
        )
      );
      result.push(
        <WarningSpan key={`warning-${commentStart}`}>{comment}</WarningSpan>
      );
      return result;
    }

    result.push(
      ...processSyntax(
        beforeComment,
        keywords,
        numberPattern,
        stringPattern,
        onAddressClick,
        onFunctionClick,
        lineFunctionTokens
      )
    );
    result.push(
      <CommentSpan key={`comment-${commentStart}`}>{comment}</CommentSpan>
    );

    return result;
  }

  return processSyntax(
    line,
    keywords,
    numberPattern,
    stringPattern,
    onAddressClick,
    onFunctionClick,
    lineFunctionTokens
  );
};

const processSyntax = (
  text: string,
  keywords: string[],
  _numberPattern: RegExp,
  stringPattern: RegExp,
  onAddressClick?: (address: string) => void,
  onFunctionClick?: (functionOffset: string) => void,
  lineFunctionTokens?: Map<string, GhidraTokenInfo>
): React.ReactNode[] => {
  const result: React.ReactNode[] = [];
  let lastIndex = 0;

  // 文字列を先に処理
  const stringMatches = Array.from(text.matchAll(stringPattern));

  stringMatches.forEach((match, index) => {
    const start = match.index!;
    const end = start + match[0].length;

    // 文字列の前の部分を処理
    if (start > lastIndex) {
      const beforeString = text.substring(lastIndex, start);
      result.push(
        ...processKeywordsAndNumbers(
          beforeString,
          keywords,
          onAddressClick,
          onFunctionClick,
          lineFunctionTokens
        )
      );
    }

    // 文字列部分
    result.push(<StringSpan key={`string-${index}`}>{match[0]}</StringSpan>);
    lastIndex = end;
  });

  // 残りの部分を処理
  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex);
    result.push(
      ...processKeywordsAndNumbers(
        remaining,
        keywords,
        onAddressClick,
        onFunctionClick,
        lineFunctionTokens
      )
    );
  }

  return result;
};

// Variable naming patterns (common prefixes/suffixes used by Ghidra)
const VARIABLE_PATTERNS = [
  /^local_[a-zA-Z0-9_]+$/, // local_10, local_var, etc.
  /^param_\d+$/, // param_1, param_2, etc.
  /^p[A-Z][a-zA-Z0-9]*$/, // pVar1, pContext, etc.
  /^[a-z][A-Z][a-zA-Z0-9]*$/, // iVar1, uVar2, etc.
  /^[a-z]+Var\d*$/, // local var patterns
  /^DAT_[0-9a-fA-F]+$/, // DAT_00100000, etc.
  /^PTR_[0-9a-fA-F]+$/, // PTR_00100000, etc.
  /^s_[a-zA-Z0-9_]+$/, // String references
];

const isVariableName = (word: string): boolean => {
  return VARIABLE_PATTERNS.some((pattern) => pattern.test(word));
};

const processKeywordsAndNumbers = (
  text: string,
  keywords: string[],
  _onAddressClick?: (address: string) => void,
  _onFunctionClick?: (functionOffset: string) => void,
  lineFunctionTokens?: Map<string, GhidraTokenInfo> // token text -> token info for this line
): React.ReactNode[] => {
  const result: React.ReactNode[] = [];
  // Split on whitespace, punctuation, operators, and hex addresses
  // Keep delimiters in the result for proper reconstruction
  const tokens = text.split(/(\s+|[{}();,\[\]=*&<>+\-/|!~%^]|0x[0-9a-fA-F]+)/);

  tokens.forEach((token, index) => {
    if (!token) return; // Skip empty tokens

    if (keywords.includes(token)) {
      result.push(<KeywordSpan key={`keyword-${index}`}>{token}</KeywordSpan>);
    } else if (/^0x[0-9a-fA-F]+$/.test(token)) {
      // Hex address - just display as plain text (no click handler for constants)
      result.push(<span key={`addr-${index}`}>{token}</span>);
    } else if (/^\d+$/.test(token)) {
      // Numbers - just display as plain text (no special highlighting)
      result.push(<span key={`number-${index}`}>{token}</span>);
    } else if (
      token.match(/^[A-Z][a-z]+$/) ||
      token.match(
        /^(uint|int|char|void|long|short|float|double|size_t|ssize_t|bool|ulong|uchar|ushort|undefined\d*)$/
      )
    ) {
      // Type names (capitalized words or common C types)
      result.push(<TypeSpan key={`type-${index}`}>{token}</TypeSpan>);
    } else {
      // Check if this token is a function based only on Ghidra token info
      const ghidraTokenInfo = lineFunctionTokens?.get(token);

      // Token is a function only if Ghidra says it's a function token
      const isFunction =
        ghidraTokenInfo && ghidraTokenInfo.token_type === "function";

      if (isFunction) {
        // Display as function (non-clickable for now)
        result.push(
          <FunctionCallSpan key={`func-${index}`}>{token}</FunctionCallSpan>
        );
      } else if (isVariableName(token)) {
        // Variable names
        result.push(<VariableSpan key={`var-${index}`}>{token}</VariableSpan>);
      } else {
        result.push(<span key={`text-${index}`}>{token}</span>);
      }
    }
  });

  return result;
};

export const DecompileView: React.FC<DecompileViewProps> = ({
  functionName,
  functionAddress,
  libraryName,
  isVisible = true,
  onToggleVisibility,
  currentBreakAddress,
  isInBreakState = false,
  onLineClick,
  onAIEnhance,
  ghidraCode,
  ghidraError,
  isGhidraLoading = false,
  onRefreshDecompile,
  onAddressClick,
  onFunctionClick,
  scrollToLineNumber,
  lineMapping,
  moduleBase,
  tokens,
  activeBreakpoints = [],
  onBreakpointSet,
  onBreakpointRemove,
}) => {
  const [sourceLines, setSourceLines] = useState<string[]>([]);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const [isAIEnhanced, setIsAIEnhanced] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Build a map of function tokens per line for efficient lookup
  const functionTokensByLine = useMemo(() => {
    const map = new Map<number, Map<string, GhidraTokenInfo>>();
    if (tokens) {
      for (const token of tokens) {
        // Include all function tokens, not just those with target_offset
        // This ensures functions like Game::getTotalStages are highlighted
        if (token.token_type === "function") {
          if (!map.has(token.line)) {
            map.set(token.line, new Map());
          }
          const lineMap = map.get(token.line)!;
          // Register the token text as-is
          lineMap.set(token.text, token);
          // Also register without trailing () if present (e.g., "__stack_chk_fail()" -> "__stack_chk_fail")
          if (token.text.endsWith("()")) {
            lineMap.set(token.text.slice(0, -2), token);
          }
          // Also register without trailing () and any namespace prefix stripped won't be needed
          // since we split on :: during tokenization anyway
        }
      }
    }
    return map;
  }, [tokens]);

  // Use Ghidra code if available, otherwise show empty (no pseudo code)
  useEffect(() => {
    if (ghidraCode) {
      // Split Ghidra decompiled code into lines and add proper indentation
      const rawLines = ghidraCode.split("\n");
      const indentedLines = addIndentation(rawLines);
      setSourceLines(indentedLines);
    } else {
      // Don't show pseudo-decompiled code - just show empty or placeholder
      setSourceLines([]);
    }
  }, [functionName, functionAddress, isAIEnhanced, ghidraCode]);

  // Highlight line corresponding to currentBreakAddress when in break state
  useEffect(() => {
    if (
      !isInBreakState ||
      !currentBreakAddress ||
      !lineMapping ||
      moduleBase === undefined
    ) {
      return;
    }

    // Convert currentBreakAddress (absolute) to offset
    const breakAddr = parseInt(currentBreakAddress.replace(/^0x/i, ""), 16);
    const offset = breakAddr - moduleBase;
    const offsetHex = `0x${offset.toString(16)}`;

    // Find the line that maps to this offset (or nearest line before it)
    let targetLine: number | null = null;
    let bestOffset = -Infinity;

    for (const [lineStr, mappedOffset] of Object.entries(lineMapping)) {
      const mappedOffsetNum = parseInt(mappedOffset.replace(/^0x/i, ""), 16);
      // Find the line with the largest offset that is <= our target offset
      if (mappedOffsetNum <= offset && mappedOffsetNum > bestOffset) {
        bestOffset = mappedOffsetNum;
        targetLine = parseInt(lineStr, 10);
      }
    }

    if (targetLine !== null) {
      console.log(
        `[DecompileView] Break at ${currentBreakAddress} (offset ${offsetHex}) -> line ${targetLine}`
      );
      setHighlightedLine(targetLine);

      // Scroll to the line if not visible
      const lineElement = lineRefs.current.get(targetLine);
      if (lineElement && contentRef.current) {
        const container = contentRef.current;
        const lineRect = lineElement.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const isVisible =
          lineRect.top >= containerRect.top &&
          lineRect.bottom <= containerRect.bottom;

        if (!isVisible) {
          lineElement.scrollIntoView({ behavior: "instant", block: "center" });
        }
      }
    }
  }, [isInBreakState, currentBreakAddress, lineMapping, moduleBase]);

  // Scroll to line when scrollToLineNumber changes - only scroll if not visible
  const lastScrolledLineRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollToLineNumber && scrollToLineNumber > 0) {
      // Skip if same line (prevent flicker on rapid updates)
      if (lastScrolledLineRef.current === scrollToLineNumber) {
        return;
      }
      lastScrolledLineRef.current = scrollToLineNumber;

      const lineElement = lineRefs.current.get(scrollToLineNumber);
      if (lineElement && contentRef.current) {
        // Check if the line is already visible in the viewport
        const container = contentRef.current;
        const lineRect = lineElement.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const isVisible =
          lineRect.top >= containerRect.top &&
          lineRect.bottom <= containerRect.bottom;

        // Only scroll if not already visible - instant scroll for auto navigation
        if (!isVisible) {
          lineElement.scrollIntoView({ behavior: "instant", block: "center" });
        }

        // Always highlight the line
        setHighlightedLine(scrollToLineNumber);
      }
    }
  }, [scrollToLineNumber]);

  // AI補完ハンドラー
  const handleAIEnhance = useCallback(async () => {
    setIsAIProcessing(true);

    // Simulate AI processing delay
    await new Promise((resolve) => setTimeout(resolve, 1500));

    setIsAIEnhanced((prev) => !prev);
    setIsAIProcessing(false);

    if (onAIEnhance) {
      onAIEnhance();
    }
  }, [onAIEnhance]);

  // Clear highlight when break state ends
  useEffect(() => {
    if (!isInBreakState) {
      setHighlightedLine(null);
    }
  }, [isInBreakState]);

  const handleLineClick = useCallback(
    (lineNumber: number, lineText: string) => {
      console.log(`Decompile view: Line ${lineNumber} clicked:`, lineText);

      // 行クリック時に行のテキストを親コンポーネントに渡す
      if (onLineClick) {
        onLineClick(lineNumber, lineText);
      }

      // Break中はクリックでハイライトを変更しない（BPハイライトを維持）
      if (isInBreakState) {
        return;
      }

      setHighlightedLine(lineNumber);
      setTimeout(() => {
        setHighlightedLine(null);
      }, 1000);
    },
    [onLineClick, isInBreakState]
  );

  // Handle breakpoint gutter click - toggle breakpoint
  const handleBreakpointClick = useCallback(
    (lineNumber: number, e: React.MouseEvent) => {
      e.stopPropagation(); // Prevent line click handler

      // Check if this line has a mapping to an address
      const lineKey = String(lineNumber);
      if (!lineMapping || !lineMapping[lineKey]) {
        console.log(
          `[DecompileView] Line ${lineNumber} has no address mapping, cannot set breakpoint`
        );
        return;
      }

      const offset = lineMapping[lineKey];
      // Calculate absolute address from module base + offset
      if (moduleBase === undefined) {
        console.log(`[DecompileView] No module base, cannot set breakpoint`);
        return;
      }

      const offsetNum = parseInt(offset.replace(/^0x/i, ""), 16);
      const absoluteAddress = moduleBase + offsetNum;
      const addressHex = `0x${absoluteAddress.toString(16)}`;

      console.log(
        `[DecompileView] Breakpoint click: line ${lineNumber}, offset ${offset}, absolute ${addressHex}`
      );

      // Check if breakpoint already exists at this address
      const hasBreakpoint = activeBreakpoints.some((bp) => {
        const bpNum = parseInt(bp.replace(/^0x/i, ""), 16);
        return bpNum === absoluteAddress;
      });

      if (hasBreakpoint) {
        // Remove breakpoint
        if (onBreakpointRemove) {
          onBreakpointRemove(addressHex);
        }
      } else {
        // Set breakpoint
        if (onBreakpointSet) {
          onBreakpointSet(addressHex);
        }
      }
    },
    [
      lineMapping,
      moduleBase,
      activeBreakpoints,
      onBreakpointSet,
      onBreakpointRemove,
    ]
  );

  // Helper to check if a line has an active breakpoint
  const lineHasBreakpoint = useCallback(
    (lineNumber: number): boolean => {
      const lineKey = String(lineNumber);
      if (!lineMapping || !lineMapping[lineKey] || moduleBase === undefined) {
        return false;
      }
      const offset = lineMapping[lineKey];
      const offsetNum = parseInt(offset.replace(/^0x/i, ""), 16);
      const absoluteAddress = moduleBase + offsetNum;

      return activeBreakpoints.some((bp) => {
        const bpNum = parseInt(bp.replace(/^0x/i, ""), 16);
        return bpNum === absoluteAddress;
      });
    },
    [lineMapping, moduleBase, activeBreakpoints]
  );

  if (!isVisible) {
    return null;
  }

  return (
    <DecompileContainer>
      <DecompileHeader>
        <DecompileTitle>
          <CodeIcon />
          {ghidraCode
            ? `Decompile: ${functionName || "Decompiled"}${libraryName ? ` - (${libraryName})` : ""}`
            : functionName
              ? `Decompiled: ${functionName}`
              : "Decompiled Source"}
          {isGhidraLoading && (
            <CircularProgress size={12} sx={{ color: "#4fc1ff", ml: 1 }} />
          )}
        </DecompileTitle>
        <Box display="flex" alignItems="center" gap={1}>
          {/* Refresh button for Ghidra decompilation */}
          {onRefreshDecompile && ghidraCode && (
            <Tooltip title="Refresh decompilation">
              <IconButton
                size="small"
                onClick={onRefreshDecompile}
                disabled={isGhidraLoading}
                sx={{
                  color: "#cccccc",
                  "&:hover": { backgroundColor: "#3c3c3c" },
                }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}

          {/* AI functionality temporarily hidden */}
          {false && (
            <Tooltip
              title={
                isAIEnhanced
                  ? "Disable AI enhancements"
                  : "Enable AI enhancements"
              }
            >
              <IconButton
                size="small"
                onClick={handleAIEnhance}
                disabled={isAIProcessing}
                sx={{
                  color: isAIEnhanced ? "#4fc1ff" : "#cccccc",
                  "&:hover": { backgroundColor: "#3c3c3c" },
                  ml: 1, // Add margin-left for spacing from title
                }}
              >
                {isAIProcessing ? (
                  <CircularProgress size={16} sx={{ color: "#4fc1ff" }} />
                ) : (
                  <AIIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
          )}

          {onToggleVisibility && (
            <Tooltip title="Toggle decompile view">
              <IconButton
                size="small"
                onClick={onToggleVisibility}
                sx={{
                  color: isVisible ? "#4fc1ff" : "#cccccc",
                  "&:hover": { backgroundColor: "#3c3c3c" },
                }}
              >
                {isVisible ? (
                  <ToggleOn fontSize="small" />
                ) : (
                  <ToggleOff fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </DecompileHeader>

      {/* Error display */}
      {ghidraError && !isGhidraLoading && (
        <Box
          sx={{
            padding: "12px 16px",
            backgroundColor: "#3c1f1f",
            borderBottom: "1px solid #5c2f2f",
            color: "#f48771",
            fontSize: "12px",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "150px",
            overflow: "auto",
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: "#ff6b6b",
              fontWeight: "bold",
              display: "block",
              mb: 0.5,
            }}
          >
            Decompile Error:
          </Typography>
          {ghidraError}
        </Box>
      )}

      <DecompileContent ref={contentRef}>
        {sourceLines.map((line, index) => {
          const lineNumber = index + 1;
          const isCurrentBreak =
            isInBreakState && highlightedLine === lineNumber;
          const isClickable = line.trim() !== "" && !line.startsWith("//");
          // Check if this line has a mapping (clickable to navigate to assembly)
          const lineKey = String(lineNumber);
          const hasMapping = lineMapping && lineMapping[lineKey];
          // Get function tokens for this line
          const lineFunctionTokens = functionTokensByLine.get(lineNumber);
          const hasBp = lineHasBreakpoint(lineNumber);

          return (
            <SourceLine
              key={lineNumber}
              ref={(el: HTMLDivElement | null) => {
                if (el) {
                  lineRefs.current.set(lineNumber, el);
                } else {
                  lineRefs.current.delete(lineNumber);
                }
              }}
              isHighlighted={false}
              isClickable={isClickable || !!hasMapping}
              hasBreakpoint={hasBp && !isCurrentBreak}
              isCurrentBreak={isCurrentBreak}
              onClick={() => isClickable && handleLineClick(lineNumber, line)}
            >
              <BreakpointGutter
                hasBreakpoint={lineHasBreakpoint(lineNumber)}
                hasMapping={!!hasMapping}
                onClick={(e) =>
                  hasMapping && handleBreakpointClick(lineNumber, e)
                }
              >
                <span className="breakpoint-dot" />
              </BreakpointGutter>
              <LineNumber>{lineNumber}</LineNumber>
              <CodeContent>
                {highlightSyntax(
                  line,
                  onAddressClick,
                  onFunctionClick,
                  lineFunctionTokens
                )}
              </CodeContent>
            </SourceLine>
          );
        })}
      </DecompileContent>
    </DecompileContainer>
  );
};
