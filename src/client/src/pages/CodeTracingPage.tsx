import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  IconButton,
  Tooltip,
  styled,
  alpha,
  Button,
  CircularProgress,
  LinearProgress,
  Divider,
  Select,
  MenuItem,
  FormControlLabel,
  Checkbox,
} from "@mui/material";
import { useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { darkTheme } from "../utils/theme";
import { useTauriSystemStateSingleton } from "../hooks/useTauriSystemStateSingleton";
import {
  useTauriTraceStore,
  TauriTraceEntryData,
  TauriTraceSession,
} from "../hooks/useTauriExceptionStore";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { encodeAddressToLibraryExpression } from "../utils/addressEncoder";
import { useSymbolCache } from "../hooks/useSymbolCache";
import { ColumnResizer } from "../components/ColumnResizer";
import {
  Close as CloseIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  KeyboardArrowRight as ArrowRightIcon,
  KeyboardArrowDown as ArrowDownIcon,
  Timeline as TimelineIcon,
  ContentCopy as CopyIcon,
  Download as DownloadIcon,
  SwapHoriz as SwapHorizIcon,
  ViewColumn as ViewColumnIcon,
} from "@mui/icons-material";
import { parseTraceFile } from "../utils/traceFileParser";
import { getApiClient } from "../lib/api";

// Memory dump for a register
export interface RegisterMemoryDump {
  register: string;
  data: Uint8Array;
}

// Trace entry representing a single instruction execution
export interface TraceEntry {
  id: number;
  address: string;
  instruction: string;
  opcode: string;
  operands: string;
  registers: Record<string, string>;
  depth: number;
  isCall: boolean;
  isReturn: boolean;
  functionName?: string;
  timestamp?: number;
  libraryExpression?: string;
  memory?: RegisterMemoryDump[]; // Memory dumps for x0-x5
}

// Tree node for hierarchical display
interface TraceTreeNode {
  entry: TraceEntry;
  children: TraceTreeNode[];
}

// Styled components
const WindowHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #3c3c3c",
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
  gap: "12px",
  padding: "8px 16px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #2d2d30",
}));

const MainContent = styled(Box)(() => ({
  flex: 1,
  display: "flex",
  overflow: "hidden",
}));

const TreePanel = styled(Box)(() => ({
  flex: "1 1 70%",
  overflow: "hidden",
  borderRight: "1px solid #3c3c3c",
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: "12px",
  display: "flex",
  flexDirection: "column",
}));

const TreePanelContent = styled(Box)(() => ({
  flex: 1,
  overflow: "auto",
  position: "relative",
  "&::-webkit-scrollbar": { width: "8px" },
  "&::-webkit-scrollbar-track": { background: "#1e1e1e" },
  "&::-webkit-scrollbar-thumb": { background: "#424242", borderRadius: "4px" },
}));

const RegisterPanel = styled(Box)(() => ({
  flex: "0 0 30%",
  minWidth: "200px",
  maxWidth: "350px",
  overflow: "auto",
  backgroundColor: "#1a1a1a",
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: "12px",
  "&::-webkit-scrollbar": { width: "8px" },
  "&::-webkit-scrollbar-track": { background: "#1a1a1a" },
  "&::-webkit-scrollbar-thumb": { background: "#424242", borderRadius: "4px" },
}));

const RegisterPanelHeader = styled(Box)(() => ({
  padding: "6px 8px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #3c3c3c",
  position: "sticky",
  top: 0,
  zIndex: 1,
}));

const RegisterSection = styled(Box)(() => ({
  padding: "4px 8px",
}));

const RegisterRow = styled(Box, {
  shouldForwardProp: (prop) => prop !== "changed",
})<{ changed?: boolean }>(({ changed }) => ({
  display: "flex",
  justifyContent: "space-between",
  padding: "1px 6px",
  borderRadius: "2px",
  backgroundColor: changed ? alpha("#ff9800", 0.15) : "transparent",
  "&:hover": { backgroundColor: alpha("#4fc1ff", 0.1) },
}));

const RegisterName = styled("span")(() => ({
  color: "#9cdcfe",
  fontWeight: "bold",
  minWidth: "45px",
}));

const RegisterValue = styled("span")(() => ({
  color: "#ce9178",
  fontFamily: 'Consolas, "Courier New", monospace',
}));

const TreeRow = styled(Box, {
  shouldForwardProp: (prop) => prop !== "selected",
})<{ selected?: boolean }>(({ selected }) => ({
  display: "flex",
  alignItems: "center",
  padding: "1px 8px",
  cursor: "pointer",
  backgroundColor: selected ? alpha("#4fc1ff", 0.2) : "transparent",
  borderLeft: selected ? "2px solid #4fc1ff" : "2px solid transparent",
  "&:hover": {
    backgroundColor: selected ? alpha("#4fc1ff", 0.25) : alpha("#4fc1ff", 0.08),
  },
}));

const TreeExpandIcon = styled(Box)(() => ({
  width: "16px",
  height: "16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  color: "#858585",
  "&:hover": { color: "#d4d4d4" },
}));

const TreeContent = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flex: 1,
  overflow: "hidden",
}));

const IndexSpan = styled("span")(() => ({
  color: "#6a9955",
  fontSize: "11px",
  fontWeight: "bold",
  flexShrink: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

const AddressSpan = styled("span")(() => ({
  color: "#dcdcaa",
  flexShrink: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

const LibraryExprSpan = styled("span")(() => ({
  color: "#9cdcfe",
  fontSize: "11px",
  flexShrink: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

const InstructionContainer = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "4px",
}));

const OpcodeSpan = styled("span")(() => ({
  color: "#569cd6",
  fontWeight: "bold",
  minWidth: "45px",
}));

const OperandsSpan = styled("span")(() => ({
  color: "#d4d4d4",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

const FunctionNameSpan = styled("span")(() => ({
  color: "#dcdcaa",
  marginLeft: "8px",
  fontStyle: "italic",
  opacity: 0.8,
}));

const CallReturnBadge = styled("span", {
  shouldForwardProp: (prop) => prop !== "type",
})<{ type: "call" | "return" }>(({ type }) => ({
  fontSize: "10px",
  padding: "1px 4px",
  borderRadius: "3px",
  marginLeft: "4px",
  backgroundColor:
    type === "call" ? alpha("#4caf50", 0.3) : alpha("#ff9800", 0.3),
  color: type === "call" ? "#4caf50" : "#ff9800",
}));

const StatusBar = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 16px",
  backgroundColor: "#252526",
  borderTop: "1px solid #3c3c3c",
  fontSize: "11px",
  color: "#858585",
}));

const TableHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  padding: "4px 8px",
  backgroundColor: "#2d2d30",
  borderBottom: "1px solid #3c3c3c",
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: "11px",
  fontWeight: "bold",
  color: "#858585",
  position: "sticky",
  top: 0,
  zIndex: 1,
}));

const HeaderCell = styled("span")(() => ({
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

// Build tree structure from flat trace entries
const buildTraceTree = (entries: TraceEntry[]): TraceTreeNode[] => {
  const roots: TraceTreeNode[] = [];
  const stack: TraceTreeNode[] = [];

  entries.forEach((entry) => {
    const node: TraceTreeNode = { entry, children: [] };

    if (entry.isReturn && stack.length > 0) {
      stack[stack.length - 1].children.push(node);
      stack.pop();
      return;
    }

    while (
      stack.length > 0 &&
      stack[stack.length - 1].entry.depth >= entry.depth
    ) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    if (entry.isCall) {
      stack.push(node);
    }
  });

  return roots;
};

// Column widths type
type ColumnWidths = {
  index: number;
  address: number;
  library: number;
};

// FlatRowComponent
const FlatRowComponent: React.FC<{
  entry: TraceEntry;
  selected: boolean;
  onSelect: (entry: TraceEntry) => void;
  columnWidths: ColumnWidths;
}> = ({ entry, selected, onSelect, columnWidths }) => (
  <TreeRow selected={selected} onClick={() => onSelect(entry)}>
    <TreeContent>
      <IndexSpan
        style={{ width: columnWidths.index, minWidth: columnWidths.index }}
      >
        #{entry.id}
      </IndexSpan>
      <AddressSpan
        style={{ width: columnWidths.address, minWidth: columnWidths.address }}
      >
        {entry.address}
      </AddressSpan>
      <LibraryExprSpan
        style={{ width: columnWidths.library, minWidth: columnWidths.library }}
      >
        {entry.libraryExpression || ""}
      </LibraryExprSpan>
      <InstructionContainer>
        <OpcodeSpan>{entry.opcode}</OpcodeSpan>
        <OperandsSpan>{entry.operands}</OperandsSpan>
        {entry.isCall && <CallReturnBadge type="call">CALL</CallReturnBadge>}
        {entry.isReturn && <CallReturnBadge type="return">RET</CallReturnBadge>}
        {entry.functionName && (
          <FunctionNameSpan>→ {entry.functionName}</FunctionNameSpan>
        )}
      </InstructionContainer>
    </TreeContent>
  </TreeRow>
);

// Convert TauriTraceEntryData to TraceEntry
const convertToTraceEntry = (data: TauriTraceEntryData): TraceEntry => ({
  id: data.id,
  address: data.address,
  instruction: data.instruction,
  opcode: data.opcode,
  operands: data.operands,
  registers: data.registers || {},
  depth: data.depth,
  isCall: data.is_call,
  isReturn: data.is_return,
  functionName: data.function_name,
  timestamp: data.timestamp,
  libraryExpression: data.library_expression,
});

// Code Tracing Page Component
const CodeTracingPageInner: React.FC = () => {
  const [searchParams] = useSearchParams();
  const targetAddress = searchParams.get("address") || "";
  const traceCount = parseInt(searchParams.get("count") || "100", 10);
  const loadFromFile = searchParams.get("loadFromFile") === "true";
  const localFilePath = searchParams.get("localFilePath"); // Path to local trace file

  const [selectedEntry, setSelectedEntry] = useState<TraceEntry | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [useTreeView, setUseTreeView] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // File-loaded trace data
  const [fileTraceEntries, setFileTraceEntries] = useState<TraceEntry[]>([]);
  const [isFileLoaded, setIsFileLoaded] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);

  // File loading progress
  const [loadingProgress, setLoadingProgress] = useState<{
    isLoading: boolean;
    phase: string;
    current: number;
    total: number;
  } | null>(null);

  // Memory panel settings
  const [memoryDisplayBytes, setMemoryDisplayBytes] = useState<number>(64);
  const [showAscii, setShowAscii] = useState<boolean>(true);
  const [hexUnitSize, setHexUnitSize] = useState<1 | 2 | 4 | 8>(1); // 1, 2, 4, or 8 bytes per hex unit
  const [hexPrefixFormat, setHexPrefixFormat] = useState<"padded" | "0x">(
    "padded"
  ); // "padded" = 00000002822a0150, "0x" = 0x2822a0150

  // Panel widths for resizable panels
  // sidePanelWidth: total width of the right side panel (Registers + Memory Dumps)
  // registerRatio: ratio of register panel width within the side panel (0.0 to 1.0)
  const [sidePanelWidth, setSidePanelWidth] = useState(680);
  const [registerRatio, setRegisterRatio] = useState(0.4); // 40% for registers, 60% for memory

  // Column width state for resizable columns
  const [columnWidths, setColumnWidths] = useState({
    index: 45,
    address: 145,
    library: 200,
  });
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Address display format state (library or function)
  const [addressDisplayFormat, setAddressDisplayFormat] = useState<
    "library" | "function"
  >("library");

  // Virtual scrolling state
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 20;
  const OVERSCAN = 10;

  // Use Tauri system state singleton for global state
  const { state: tauriState, isLoading: tauriLoading } =
    useTauriSystemStateSingleton();

  // Use symbol cache for symbol resolution
  const { formatAddressWithSymbol, updateServerInfo, loadedModules } =
    useSymbolCache();

  // Use Tauri trace store for trace data (shared with main window)
  const {
    traceEntries: tauriTraceEntries,
    traceSession,
    getTraceEntries: fetchTraceEntries,
    getTraceSession: fetchTraceSession,
  } = useTauriTraceStore();

  // Local state for trace data (updated via polling)
  const [localTraceEntries, setLocalTraceEntries] = useState<
    TauriTraceEntryData[]
  >([]);
  const [localTraceSession, setLocalTraceSession] =
    useState<TauriTraceSession | null>(null);

  // Fetch trace data from Tauri store (polling pattern like Watchpoint)
  const fetchTraceData = useCallback(async () => {
    try {
      const session = await fetchTraceSession();
      if (session) {
        setLocalTraceSession(session);
        const entries = await fetchTraceEntries(undefined);
        setLocalTraceEntries(entries);

        // Check if trace ended by end_address (server-side termination)
        // Only check if connected to server and session is active
        if (
          session.is_active &&
          tauriState?.connectionHost &&
          tauriState?.connectionPort
        ) {
          try {
            const apiClient = getApiClient();
            // Ensure apiClient has the correct server connection
            apiClient.updateConnection(
              tauriState.connectionHost,
              tauriState.connectionPort
            );
            const status = await apiClient.getTraceStatus();
            console.log("[CodeTracingPage] Trace status:", status);
            if (status.ended_by_end_address) {
              console.log(
                "[CodeTracingPage] Trace ended by end_address, stopping session"
              );
              // Stop the Tauri session to update UI
              await invoke("stop_trace_session");
              // Update local state immediately
              setLocalTraceSession((prev) =>
                prev ? { ...prev, is_active: false } : null
              );
            }
          } catch (statusError) {
            // Ignore errors from getTraceStatus - server might not be available
            console.debug(
              "[CodeTracingPage] Failed to get trace status:",
              statusError
            );
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch trace data:", err);
    }
  }, [
    fetchTraceSession,
    fetchTraceEntries,
    tauriState?.connectionHost,
    tauriState?.connectionPort,
  ]);

  // Ref to track current state for close handler (to avoid stale closures)
  const closeHandlerStateRef = useRef({
    localTraceEntries: [] as TauriTraceEntryData[],
    localTraceSession: null as TauriTraceSession | null,
    connectionHost: "",
    connectionPort: 0,
  });

  // Ref to prevent multiple close attempts (shared across handlers)
  const isClosingRef = useRef(false);

  // Keep ref updated with latest state
  useEffect(() => {
    closeHandlerStateRef.current = {
      localTraceEntries,
      localTraceSession,
      connectionHost: tauriState?.connectionHost || "",
      connectionPort: tauriState?.connectionPort || 0,
    };
  }, [
    localTraceEntries,
    localTraceSession,
    tauriState?.connectionHost,
    tauriState?.connectionPort,
  ]);

  // Handle window close event (when user clicks X button)
  // This ensures breakpoint is removed even when closing via window controls
  useEffect(() => {
    if (loadFromFile || localFilePath) {
      // Don't need to handle breakpoint cleanup for file loading mode
      return;
    }

    const currentWindow = getCurrentWebviewWindow();

    const setupCloseHandler = async () => {
      const unlisten = await currentWindow.onCloseRequested(async () => {
        // Prevent multiple close attempts
        if (isClosingRef.current) {
          return;
        }
        isClosingRef.current = true;

        // Get current state from ref
        const state = closeHandlerStateRef.current;

        // Check if we need to remove breakpoint
        const hasTraceEntries =
          state.localTraceEntries.length > 0 ||
          (state.localTraceSession &&
            state.localTraceSession.current_count > 0);

        if (!hasTraceEntries && targetAddress) {
          console.log(
            "[CodeTracingPage] Window close requested, removing pending breakpoint:",
            targetAddress
          );
          try {
            const apiClient = getApiClient();
            if (state.connectionHost && state.connectionPort) {
              apiClient.updateConnection(
                state.connectionHost,
                state.connectionPort
              );
            }
            const addressNum = parseInt(targetAddress.replace(/^0x/i, ""), 16);
            if (!isNaN(addressNum)) {
              // Fire and forget - don't wait for the response
              apiClient
                .removeBreakpoint({ address: addressNum })
                .then(() => {
                  console.log(
                    "[CodeTracingPage] Breakpoint removed successfully"
                  );
                })
                .catch((error) => {
                  console.error(
                    "[CodeTracingPage] Failed to remove breakpoint:",
                    error
                  );
                });
            }
          } catch (error) {
            console.error(
              "[CodeTracingPage] Failed to remove breakpoint:",
              error
            );
          }
        }

        // Don't call preventDefault() - let the window close naturally
        // The breakpoint removal is fire-and-forget
      });

      return unlisten;
    };

    let unlistenFn: (() => void) | undefined;
    setupCloseHandler().then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [loadFromFile, localFilePath, targetAddress]); // Minimal dependencies - state accessed via ref

  // Polling for trace data (same pattern as WatchpointExceptionWindow)
  // Skip polling when loading from file
  useEffect(() => {
    if (loadFromFile || localFilePath) {
      // Don't poll when in file loading mode
      return;
    }

    // Initial fetch
    fetchTraceData();

    // Poll for updates every 250ms
    const interval = setInterval(fetchTraceData, 250);

    return () => {
      clearInterval(interval);
    };
  }, [fetchTraceData, loadFromFile, localFilePath]);

  // Also update when tauriTraceEntries changes (from event listeners)
  useEffect(() => {
    if (tauriTraceEntries.length > 0) {
      setLocalTraceEntries(tauriTraceEntries);
    }
  }, [tauriTraceEntries]);

  // Also update session when traceSession changes
  useEffect(() => {
    if (traceSession) {
      setLocalTraceSession(traceSession);
    }
  }, [traceSession]);

  // Get attached modules from Tauri state for address resolution
  const attachedModules = useMemo(() => {
    return tauriState?.attachedModules || [];
  }, [tauriState?.attachedModules]);

  // Convert Tauri trace entries to local format, remove duplicates, sort by ID,
  // and recalculate libraryExpression from current module info with symbol resolution
  const traceEntries = useMemo(() => {
    const converted = localTraceEntries.map((data) => {
      const entry = convertToTraceEntry(data);

      // If we have attached modules, try to resolve address based on display format
      if (attachedModules.length > 0) {
        const addressNum = parseInt(entry.address.replace(/^0x/i, ""), 16);
        if (!isNaN(addressNum)) {
          // Use formatAddressWithSymbol with current display format
          const expr = formatAddressWithSymbol(
            addressNum,
            attachedModules,
            addressDisplayFormat
          );
          if (expr) {
            entry.libraryExpression = expr;
          } else {
            // Fallback to library + offset
            const libraryExpr = encodeAddressToLibraryExpression(
              addressNum,
              attachedModules,
              true // prefer short name
            );
            if (libraryExpr) {
              entry.libraryExpression = libraryExpr;
            }
          }
        }
      }

      return entry;
    });
    // Remove duplicates by ID (keep first occurrence)
    const uniqueMap = new Map<number, TraceEntry>();
    converted.forEach((entry) => {
      if (!uniqueMap.has(entry.id)) {
        uniqueMap.set(entry.id, entry);
      }
    });
    // Sort by ID to ensure correct order
    return Array.from(uniqueMap.values()).sort((a, b) => a.id - b.id);
  }, [
    localTraceEntries,
    attachedModules,
    formatAddressWithSymbol,
    loadedModules,
    addressDisplayFormat,
  ]);

  // Get active trace entries (file-loaded or live) with symbol resolution
  const activeTraceEntries = useMemo(() => {
    const baseEntries =
      isFileLoaded && fileTraceEntries.length > 0
        ? fileTraceEntries
        : traceEntries;

    // For file-loaded entries, apply symbol resolution
    if (
      isFileLoaded &&
      fileTraceEntries.length > 0 &&
      attachedModules.length > 0
    ) {
      return baseEntries.map((entry) => {
        const addressNum = parseInt(entry.address.replace(/^0x/i, ""), 16);
        if (!isNaN(addressNum)) {
          const expr = formatAddressWithSymbol(
            addressNum,
            attachedModules,
            addressDisplayFormat
          );
          if (expr) {
            return { ...entry, libraryExpression: expr };
          } else {
            const libraryExpr = encodeAddressToLibraryExpression(
              addressNum,
              attachedModules,
              true
            );
            if (libraryExpr) {
              return { ...entry, libraryExpression: libraryExpr };
            }
          }
        }
        return entry;
      });
    }

    return baseEntries;
  }, [
    isFileLoaded,
    fileTraceEntries,
    traceEntries,
    attachedModules,
    formatAddressWithSymbol,
    addressDisplayFormat,
  ]);

  // Derive tracing state from session
  // File loading mode is never in tracing state
  const isTracing =
    loadFromFile || localFilePath
      ? false
      : (localTraceSession?.is_active ?? false);
  const tracingProgress = localTraceSession
    ? {
        current: localTraceSession.current_count,
        total: localTraceSession.total_count,
      }
    : { current: 0, total: traceCount };

  // Show error if not connected, and update symbol cache server info
  useEffect(() => {
    if (tauriLoading) return;

    if (!tauriState?.connectionHost || !tauriState?.connectionPort) {
      setError("No connection information available");
    } else {
      setError(null);
      // Update symbol cache with server info for symbol loading
      updateServerInfo({
        ip: tauriState.connectionHost,
        port: tauriState.connectionPort,
      });
    }
  }, [tauriState, tauriLoading, updateServerInfo]);

  // Update expanded IDs only on initial load (not on every poll)
  const initialExpandedRef = useRef(false);
  useEffect(() => {
    if (activeTraceEntries.length > 0 && !initialExpandedRef.current) {
      setExpandedIds(
        new Set(activeTraceEntries.filter((e) => e.isCall).map((e) => e.id))
      );
      initialExpandedRef.current = true;
    }
  }, [activeTraceEntries]);

  // Reset expanded state when trace session changes (new trace started)
  useEffect(() => {
    if (localTraceSession?.started_at) {
      initialExpandedRef.current = false;
    }
  }, [localTraceSession?.started_at]);

  const treeNodes = useMemo(
    () => buildTraceTree(activeTraceEntries),
    [activeTraceEntries]
  );

  const flattenedTreeRows = useMemo(() => {
    const rows: { node: TraceTreeNode; depth: number }[] = [];
    const traverse = (nodes: TraceTreeNode[], depth: number) => {
      nodes.forEach((node) => {
        rows.push({ node, depth });
        if (node.children.length > 0 && expandedIds.has(node.entry.id)) {
          traverse(node.children, depth + 1);
        }
      });
    };
    traverse(treeNodes, 0);
    return rows;
  }, [treeNodes, expandedIds]);

  const visibleRows = useMemo(() => {
    const containerHeight = containerRef.current?.clientHeight || 600;
    const totalRows = useTreeView
      ? flattenedTreeRows.length
      : activeTraceEntries.length;
    const startIndex = Math.max(
      0,
      Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN
    );
    const endIndex = Math.min(
      totalRows,
      Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN
    );
    return { startIndex, endIndex, totalRows };
  }, [
    scrollTop,
    flattenedTreeRows.length,
    activeTraceEntries.length,
    useTreeView,
  ]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Column resize handler
  const handleColumnResizeStart = useCallback(
    (column: keyof typeof columnWidths) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingColumn(column);
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = columnWidths[column];

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(30, resizeStartWidth.current + delta);
        setColumnWidths((prev) => ({ ...prev, [column]: newWidth }));
      };

      const handleMouseUp = () => {
        setResizingColumn(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [columnWidths]
  );

  const previousEntry = useMemo(() => {
    if (!selectedEntry) return null;
    const idx = activeTraceEntries.findIndex((e) => e.id === selectedEntry.id);
    return idx > 0 ? activeTraceEntries[idx - 1] : null;
  }, [selectedEntry, activeTraceEntries]);

  const changedRegisters = useMemo(() => {
    if (!selectedEntry || !previousEntry) return new Set<string>();
    const changed = new Set<string>();
    Object.keys(selectedEntry.registers).forEach((reg) => {
      if (selectedEntry.registers[reg] !== previousEntry.registers[reg]) {
        changed.add(reg);
      }
    });
    return changed;
  }, [selectedEntry, previousEntry]);

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedIds(
      new Set(activeTraceEntries.filter((e) => e.isCall).map((e) => e.id))
    );
  }, [activeTraceEntries]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  // Handle downloading trace file from server
  const handleDownloadFromServer = useCallback(async () => {
    try {
      // Clear existing entries before loading
      setFileTraceEntries([]);
      setIsFileLoaded(false);

      setLoadingProgress({
        isLoading: true,
        phase: "Downloading from server...",
        current: 0,
        total: 0,
      });

      const api = getApiClient();

      // Try to download directly - don't check status first as file_path may be empty after completion
      const blob = await api.downloadTraceFile();

      if (blob.size === 0) {
        console.log("No trace file available on server (empty response)");
        setLoadingProgress(null);
        return;
      }

      setLoadingProgress({
        isLoading: true,
        phase: "Parsing trace file...",
        current: 0,
        total: 0,
      });
      const arrayBuffer = await blob.arrayBuffer();
      const result = parseTraceFile(arrayBuffer);

      if (!result || !result.entries) {
        console.error("Failed to parse downloaded trace file");
        setLoadingProgress(null);
        return;
      }

      // ParsedTraceEntry is compatible with TraceEntry, use directly without copying
      setFileTraceEntries(result.entries as TraceEntry[]);
      setIsFileLoaded(true);
      setShowMemoryPanel(true);
      setLoadingProgress(null);
    } catch (err) {
      console.error("Failed to download trace file from server:", err);
      setLoadingProgress(null);
    }
  }, []);

  // Auto-download from server when loadFromFile is true, or load from local file when localFilePath is provided
  useEffect(() => {
    if (localFilePath && !isFileLoaded) {
      console.log(`Loading trace file from local path: ${localFilePath}`);

      // Read file using Rust backend
      (async () => {
        try {
          // Clear existing entries before loading
          setFileTraceEntries([]);

          setLoadingProgress({
            isLoading: true,
            phase: "Reading file...",
            current: 0,
            total: 0,
          });

          // Receive base64 encoded file data for faster transfer
          const base64Data = await invoke<string>("read_trace_file", {
            path: localFilePath,
          });

          // Decode base64 to ArrayBuffer
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const arrayBuffer = bytes.buffer;

          setLoadingProgress({
            isLoading: true,
            phase: "Parsing trace file...",
            current: 0,
            total: 0,
          });
          const result = parseTraceFile(arrayBuffer);

          if (!result || !result.entries) {
            console.error("Failed to parse trace file");
            setLoadingProgress(null);
            return;
          }

          // ParsedTraceEntry is compatible with TraceEntry, use directly without copying
          setFileTraceEntries(result.entries as TraceEntry[]);
          setIsFileLoaded(true);
          setShowMemoryPanel(true);
          setLoadingProgress(null);

          console.log(
            `Loaded ${result.entries.length} entries from file: ${localFilePath}`
          );
        } catch (err) {
          console.error("Failed to load trace file:", err);
          setLoadingProgress(null);
        }
      })();
    } else if (loadFromFile && !isFileLoaded) {
      console.log("Auto-downloading trace file from server...");
      handleDownloadFromServer();
    }
  }, [loadFromFile, localFilePath, isFileLoaded, handleDownloadFromServer]);

  const handleRowClick = useCallback((entry: TraceEntry) => {
    setSelectedEntry(entry);
    // TODO: Emit event to main window to navigate to address
  }, []);

  const handleCopyToClipboard = useCallback(() => {
    const text = activeTraceEntries
      .map((e) => `${e.address}: ${e.opcode} ${e.operands}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  }, [activeTraceEntries]);

  const handleExportJson = useCallback(() => {
    const json = JSON.stringify(activeTraceEntries, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trace_${targetAddress || "unknown"}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeTraceEntries, targetAddress]);

  const handleClose = useCallback(async () => {
    // Just trigger window close - the onCloseRequested handler will handle breakpoint cleanup
    try {
      const currentWindow = getCurrentWebviewWindow();
      await currentWindow.close();
    } catch (err) {
      console.error("Failed to close window:", err);
    }
  }, []);

  const stats = useMemo(() => {
    let calls = 0,
      returns = 0,
      maxDepth = 0;
    activeTraceEntries.forEach((e) => {
      if (e.isCall) calls++;
      if (e.isReturn) returns++;
      if (e.depth > maxDepth) maxDepth = e.depth;
    });
    return { calls, returns, maxDepth };
  }, [activeTraceEntries]);

  const registerGroups = useMemo(() => {
    if (!selectedEntry) return [];

    // Detect architecture based on available registers
    const isX86_64 =
      selectedEntry.registers["rax"] !== undefined ||
      selectedEntry.registers["RAX"] !== undefined ||
      selectedEntry.registers["rip"] !== undefined ||
      selectedEntry.registers["RIP"] !== undefined;

    if (isX86_64) {
      // x86_64 registers
      const generalRegs = [
        {
          name: "rax",
          value: selectedEntry.registers["rax"] || "0x0",
          changed: changedRegisters.has("rax"),
        },
        {
          name: "rbx",
          value: selectedEntry.registers["rbx"] || "0x0",
          changed: changedRegisters.has("rbx"),
        },
        {
          name: "rcx",
          value: selectedEntry.registers["rcx"] || "0x0",
          changed: changedRegisters.has("rcx"),
        },
        {
          name: "rdx",
          value: selectedEntry.registers["rdx"] || "0x0",
          changed: changedRegisters.has("rdx"),
        },
        {
          name: "rsi",
          value: selectedEntry.registers["rsi"] || "0x0",
          changed: changedRegisters.has("rsi"),
        },
        {
          name: "rdi",
          value: selectedEntry.registers["rdi"] || "0x0",
          changed: changedRegisters.has("rdi"),
        },
        {
          name: "rbp",
          value: selectedEntry.registers["rbp"] || "0x0",
          changed: changedRegisters.has("rbp"),
        },
        {
          name: "r8",
          value: selectedEntry.registers["r8"] || "0x0",
          changed: changedRegisters.has("r8"),
        },
        {
          name: "r9",
          value: selectedEntry.registers["r9"] || "0x0",
          changed: changedRegisters.has("r9"),
        },
        {
          name: "r10",
          value: selectedEntry.registers["r10"] || "0x0",
          changed: changedRegisters.has("r10"),
        },
        {
          name: "r11",
          value: selectedEntry.registers["r11"] || "0x0",
          changed: changedRegisters.has("r11"),
        },
        {
          name: "r12",
          value: selectedEntry.registers["r12"] || "0x0",
          changed: changedRegisters.has("r12"),
        },
        {
          name: "r13",
          value: selectedEntry.registers["r13"] || "0x0",
          changed: changedRegisters.has("r13"),
        },
        {
          name: "r14",
          value: selectedEntry.registers["r14"] || "0x0",
          changed: changedRegisters.has("r14"),
        },
        {
          name: "r15",
          value: selectedEntry.registers["r15"] || "0x0",
          changed: changedRegisters.has("r15"),
        },
      ];
      const specialRegs = [
        {
          name: "rsp",
          value: selectedEntry.registers["rsp"] || "0x0",
          changed: changedRegisters.has("rsp"),
        },
        {
          name: "rip",
          value: selectedEntry.registers["rip"] || "0x0",
          changed: changedRegisters.has("rip"),
        },
        {
          name: "rflags",
          value: selectedEntry.registers["rflags"] || "0x0",
          changed: changedRegisters.has("rflags"),
        },
      ];
      const segmentRegs = [
        {
          name: "cs",
          value: selectedEntry.registers["cs"] || "0x0",
          changed: changedRegisters.has("cs"),
        },
        {
          name: "ss",
          value: selectedEntry.registers["ss"] || "0x0",
          changed: changedRegisters.has("ss"),
        },
        {
          name: "ds",
          value: selectedEntry.registers["ds"] || "0x0",
          changed: changedRegisters.has("ds"),
        },
        {
          name: "es",
          value: selectedEntry.registers["es"] || "0x0",
          changed: changedRegisters.has("es"),
        },
        {
          name: "fs",
          value: selectedEntry.registers["fs"] || "0x0",
          changed: changedRegisters.has("fs"),
        },
        {
          name: "gs",
          value: selectedEntry.registers["gs"] || "0x0",
          changed: changedRegisters.has("gs"),
        },
      ];
      return [
        { title: "General Purpose Registers", regs: generalRegs },
        { title: "Special Registers", regs: specialRegs },
        { title: "Segment Registers", regs: segmentRegs },
      ];
    } else {
      // ARM64 registers
      const generalRegs = [];
      for (let i = 0; i <= 29; i++) {
        const name = `x${i}`;
        if (selectedEntry.registers[name]) {
          generalRegs.push({
            name,
            value: selectedEntry.registers[name],
            changed: changedRegisters.has(name),
          });
        }
      }
      const specialRegs = [
        {
          name: "lr",
          value: selectedEntry.registers["lr"] || "0x0",
          changed: changedRegisters.has("lr"),
        },
        {
          name: "fp",
          value: selectedEntry.registers["fp"] || "0x0",
          changed: changedRegisters.has("fp"),
        },
        {
          name: "sp",
          value: selectedEntry.registers["sp"] || "0x0",
          changed: changedRegisters.has("sp"),
        },
        {
          name: "pc",
          value: selectedEntry.registers["pc"] || "0x0",
          changed: changedRegisters.has("pc"),
        },
        {
          name: "cpsr",
          value: selectedEntry.registers["cpsr"] || "0x0",
          changed: changedRegisters.has("cpsr"),
        },
      ];
      return [
        { title: "General Purpose Registers", regs: generalRegs },
        { title: "Special Registers", regs: specialRegs },
      ];
    }
  }, [selectedEntry, changedRegisters]);

  if (error) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <Box
          sx={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#f44336",
          }}
        >
          <Typography>{error}</Typography>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Box
        sx={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#1e1e1e",
        }}
      >
        <WindowHeader>
          <WindowTitle>
            <TimelineIcon />
            Code Tracing
            {localFilePath ? (
              <Typography
                variant="caption"
                sx={{ color: "#858585", ml: 1, fontWeight: "normal" }}
              >
                - {localFilePath.split("/").pop() || "File"}
              </Typography>
            ) : loadFromFile ? (
              <Typography
                variant="caption"
                sx={{ color: "#858585", ml: 1, fontWeight: "normal" }}
              >
                - Downloaded
              </Typography>
            ) : targetAddress && targetAddress !== "0x0" ? (
              <Typography
                variant="caption"
                sx={{ color: "#858585", ml: 1, fontWeight: "normal" }}
              >
                @ {targetAddress}
              </Typography>
            ) : null}
          </WindowTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <Tooltip title="Copy all to clipboard">
              <IconButton
                size="small"
                onClick={handleCopyToClipboard}
                sx={{ color: "#858585" }}
                disabled={activeTraceEntries.length === 0}
              >
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Export as JSON">
              <IconButton
                size="small"
                onClick={handleExportJson}
                sx={{ color: "#858585" }}
                disabled={activeTraceEntries.length === 0}
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <IconButton
              size="small"
              onClick={handleClose}
              sx={{ color: "#858585" }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        </WindowHeader>

        <ToolbarContainer>
          <Button
            size="small"
            onClick={() => setUseTreeView(!useTreeView)}
            sx={{ color: "#858585", fontSize: "11px", textTransform: "none" }}
          >
            {useTreeView ? "Flat View" : "Tree View"}
          </Button>
          <Divider
            orientation="vertical"
            flexItem
            sx={{ mx: 1, borderColor: "#3c3c3c" }}
          />
          <Tooltip title="Expand All">
            <IconButton
              size="small"
              onClick={expandAll}
              sx={{ color: "#858585" }}
              disabled={!useTreeView}
            >
              <ExpandMoreIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Collapse All">
            <IconButton
              size="small"
              onClick={collapseAll}
              sx={{ color: "#858585" }}
              disabled={!useTreeView}
            >
              <ExpandLessIcon />
            </IconButton>
          </Tooltip>

          {isFileLoaded && (
            <Tooltip
              title={
                showMemoryPanel ? "Hide memory panel" : "Show memory panel"
              }
            >
              <IconButton
                size="small"
                onClick={() => setShowMemoryPanel(!showMemoryPanel)}
                sx={{ color: showMemoryPanel ? "#4fc1ff" : "#858585" }}
              >
                <ViewColumnIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </ToolbarContainer>

        <Box
          sx={{
            flex: 1,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {isTracing && tracingProgress && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px",
                gap: 2,
                backgroundColor: alpha("#4fc1ff", 0.1),
              }}
            >
              {tracingProgress.current === 0 ? (
                <Typography variant="body2" sx={{ color: "#d4d4d4" }}>
                  Waiting for breakpoint hit...
                </Typography>
              ) : (
                <>
                  <CircularProgress size={20} />
                  <Typography variant="body2" sx={{ color: "#d4d4d4" }}>
                    Tracing... {tracingProgress.current} /{" "}
                    {tracingProgress.total} instructions
                  </Typography>
                </>
              )}
            </Box>
          )}

          {/* File loading progress */}
          {loadingProgress && (
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "20px",
                backgroundColor: "#252526",
                borderBottom: "1px solid #3c3c3c",
              }}
            >
              <Typography variant="body2" sx={{ color: "#d4d4d4", mb: 1 }}>
                {loadingProgress.phase}
                {loadingProgress.total > 0 && (
                  <>
                    {" "}
                    ({loadingProgress.current.toLocaleString()} /{" "}
                    {loadingProgress.total.toLocaleString()})
                  </>
                )}
              </Typography>
              <Box sx={{ width: "100%", maxWidth: 400 }}>
                {loadingProgress.total > 0 ? (
                  <LinearProgress
                    variant="determinate"
                    value={
                      (loadingProgress.current / loadingProgress.total) * 100
                    }
                    sx={{
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: "#3c3c3c",
                      "& .MuiLinearProgress-bar": {
                        backgroundColor: "#4fc1ff",
                        borderRadius: 3,
                      },
                    }}
                  />
                ) : (
                  <LinearProgress
                    sx={{
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: "#3c3c3c",
                      "& .MuiLinearProgress-bar": {
                        backgroundColor: "#4fc1ff",
                      },
                    }}
                  />
                )}
              </Box>
              {loadingProgress.total > 0 && (
                <Typography variant="caption" sx={{ color: "#858585", mt: 1 }}>
                  {Math.round(
                    (loadingProgress.current / loadingProgress.total) * 100
                  )}
                  %
                </Typography>
              )}
            </Box>
          )}

          {!loadingProgress && (
            <MainContent>
              <TreePanel>
                <TableHeader>
                  <Box
                    sx={{
                      width: `${columnWidths.index}px`,
                      minWidth: `${columnWidths.index}px`,
                      flexShrink: 0,
                      position: "relative",
                    }}
                  >
                    <HeaderCell>#</HeaderCell>
                    <ColumnResizer
                      onMouseDown={handleColumnResizeStart("index")}
                      isResizing={resizingColumn === "index"}
                    />
                  </Box>
                  <Box
                    sx={{
                      width: `${columnWidths.address}px`,
                      minWidth: `${columnWidths.address}px`,
                      flexShrink: 0,
                      ml: 1,
                      position: "relative",
                    }}
                  >
                    <HeaderCell>Address</HeaderCell>
                    <ColumnResizer
                      onMouseDown={handleColumnResizeStart("address")}
                      isResizing={resizingColumn === "address"}
                    />
                  </Box>
                  <Box
                    sx={{
                      width: `${columnWidths.library}px`,
                      minWidth: `${columnWidths.library}px`,
                      flexShrink: 0,
                      ml: 1,
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <HeaderCell>Detail</HeaderCell>
                    <Tooltip
                      title={
                        addressDisplayFormat === "library"
                          ? "library + offset (click to switch to function)"
                          : "module@function + offset (click to switch to library)"
                      }
                    >
                      <IconButton
                        size="small"
                        onClick={() =>
                          setAddressDisplayFormat((prev) =>
                            prev === "library" ? "function" : "library"
                          )
                        }
                        sx={{
                          padding: "2px",
                          ml: 0.5,
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
                    <ColumnResizer
                      onMouseDown={handleColumnResizeStart("library")}
                      isResizing={resizingColumn === "library"}
                    />
                  </Box>
                  <HeaderCell sx={{ flex: 1, ml: 1 }}>Instruction</HeaderCell>
                </TableHeader>
                {activeTraceEntries.length === 0 ? (
                  <Box
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: 1,
                      color: "#858585",
                    }}
                  >
                    <TimelineIcon sx={{ fontSize: 48, opacity: 0.5, mb: 2 }} />
                    <Typography variant="body2">
                      {isTracing
                        ? "Waiting for trace data..."
                        : "No trace data"}
                    </Typography>
                  </Box>
                ) : (
                  <TreePanelContent ref={containerRef} onScroll={handleScroll}>
                    <Box
                      sx={{
                        height: visibleRows.totalRows * ROW_HEIGHT,
                        position: "relative",
                      }}
                    >
                      <Box
                        sx={{
                          position: "absolute",
                          top: visibleRows.startIndex * ROW_HEIGHT,
                          left: 0,
                          right: 0,
                        }}
                      >
                        {useTreeView
                          ? flattenedTreeRows
                              .slice(
                                visibleRows.startIndex,
                                visibleRows.endIndex
                              )
                              .map(({ node, depth }) => (
                                <Box
                                  key={node.entry.id}
                                  sx={{ height: ROW_HEIGHT }}
                                >
                                  <TreeRow
                                    selected={
                                      selectedEntry?.id === node.entry.id
                                    }
                                    onClick={() => handleRowClick(node.entry)}
                                  >
                                    <TreeContent>
                                      <IndexSpan
                                        style={{
                                          width: columnWidths.index,
                                          minWidth: columnWidths.index,
                                        }}
                                      >
                                        #{node.entry.id}
                                      </IndexSpan>
                                      <AddressSpan
                                        style={{
                                          width: columnWidths.address,
                                          minWidth: columnWidths.address,
                                        }}
                                      >
                                        {node.entry.address}
                                      </AddressSpan>
                                      <LibraryExprSpan
                                        style={{
                                          width: columnWidths.library,
                                          minWidth: columnWidths.library,
                                        }}
                                      >
                                        {node.entry.libraryExpression || ""}
                                      </LibraryExprSpan>
                                      <InstructionContainer
                                        style={{ paddingLeft: depth * 16 }}
                                      >
                                        {node.children.length > 0 ? (
                                          <TreeExpandIcon
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              e.preventDefault();
                                              toggleExpand(node.entry.id);
                                            }}
                                          >
                                            {expandedIds.has(node.entry.id) ? (
                                              <ArrowDownIcon
                                                sx={{ fontSize: 14 }}
                                              />
                                            ) : (
                                              <ArrowRightIcon
                                                sx={{ fontSize: 14 }}
                                              />
                                            )}
                                          </TreeExpandIcon>
                                        ) : (
                                          <Box sx={{ width: 16 }} />
                                        )}
                                        <OpcodeSpan>
                                          {node.entry.opcode}
                                        </OpcodeSpan>
                                        <OperandsSpan>
                                          {node.entry.operands}
                                        </OperandsSpan>
                                        {node.entry.isCall && (
                                          <CallReturnBadge type="call">
                                            CALL
                                          </CallReturnBadge>
                                        )}
                                        {node.entry.isReturn && (
                                          <CallReturnBadge type="return">
                                            RET
                                          </CallReturnBadge>
                                        )}
                                        {node.entry.functionName && (
                                          <FunctionNameSpan>
                                            → {node.entry.functionName}
                                          </FunctionNameSpan>
                                        )}
                                      </InstructionContainer>
                                    </TreeContent>
                                  </TreeRow>
                                </Box>
                              ))
                          : activeTraceEntries
                              .slice(
                                visibleRows.startIndex,
                                visibleRows.endIndex
                              )
                              .map((entry) => (
                                <Box key={entry.id} sx={{ height: ROW_HEIGHT }}>
                                  <FlatRowComponent
                                    entry={entry}
                                    selected={selectedEntry?.id === entry.id}
                                    onSelect={handleRowClick}
                                    columnWidths={columnWidths}
                                  />
                                </Box>
                              ))}
                      </Box>
                    </Box>
                  </TreePanelContent>
                )}
              </TreePanel>

              {/* Resizer between Tree Panel and Side Panel (Registers + Memory) */}
              <Box
                sx={{
                  width: "4px",
                  cursor: "col-resize",
                  backgroundColor: "#3c3c3c",
                  "&:hover": { backgroundColor: "#4fc1ff" },
                  "&:active": { backgroundColor: "#4fc1ff" },
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startWidth = sidePanelWidth;
                  const onMouseMove = (moveEvent: MouseEvent) => {
                    const delta = startX - moveEvent.clientX;
                    setSidePanelWidth(
                      Math.max(300, Math.min(900, startWidth + delta))
                    );
                  };
                  const onMouseUp = () => {
                    document.removeEventListener("mousemove", onMouseMove);
                    document.removeEventListener("mouseup", onMouseUp);
                  };
                  document.addEventListener("mousemove", onMouseMove);
                  document.addEventListener("mouseup", onMouseUp);
                }}
              />

              {/* Side Panel Container (Registers + Memory Dumps) */}
              <Box
                sx={{
                  width: sidePanelWidth,
                  minWidth: 300,
                  maxWidth: 900,
                  display: "flex",
                  flexDirection: "row",
                  flex: "none",
                }}
              >
                <RegisterPanel
                  sx={{
                    width:
                      showMemoryPanel && isFileLoaded && selectedEntry?.memory
                        ? `${registerRatio * 100}%`
                        : "100%",
                    minWidth: 180,
                    flex: "none",
                  }}
                >
                  <RegisterPanelHeader>
                    <Typography
                      variant="subtitle2"
                      sx={{ color: "#4fc1ff", fontWeight: "bold" }}
                    >
                      Registers
                    </Typography>
                    {selectedEntry && (
                      <Typography
                        variant="caption"
                        sx={{ color: "#858585", display: "block", mt: 0.5 }}
                      >
                        #{selectedEntry.id} @ {selectedEntry.address}
                      </Typography>
                    )}
                  </RegisterPanelHeader>

                  {selectedEntry ? (
                    <>
                      {registerGroups.map((group, groupIdx) => (
                        <RegisterSection key={groupIdx}>
                          <Typography
                            variant="caption"
                            sx={{
                              color: "#858585",
                              fontSize: "10px",
                              textTransform: "uppercase",
                              letterSpacing: "0.5px",
                              display: "block",
                              mb: 1,
                            }}
                          >
                            {group.title}
                          </Typography>
                          {group.regs.map((reg) => (
                            <RegisterRow key={reg.name} changed={reg.changed}>
                              <RegisterName>{reg.name}</RegisterName>
                              <RegisterValue>{reg.value}</RegisterValue>
                            </RegisterRow>
                          ))}
                          {groupIdx < registerGroups.length - 1 && (
                            <Divider sx={{ my: 1, borderColor: "#3c3c3c" }} />
                          )}
                        </RegisterSection>
                      ))}
                    </>
                  ) : (
                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        height: "200px",
                        color: "#858585",
                      }}
                    >
                      <Typography variant="caption">
                        Select an instruction to view registers
                      </Typography>
                    </Box>
                  )}
                </RegisterPanel>

                {/* Internal Resizer between Register Panel and Memory Panel (within the side panel) */}
                {showMemoryPanel && isFileLoaded && selectedEntry?.memory && (
                  <Box
                    sx={{
                      width: "4px",
                      cursor: "col-resize",
                      backgroundColor: "#3c3c3c",
                      "&:hover": { backgroundColor: "#4fc1ff" },
                      "&:active": { backgroundColor: "#4fc1ff" },
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const startRatio = registerRatio;
                      const containerWidth = sidePanelWidth - 4; // minus resizer width
                      const onMouseMove = (moveEvent: MouseEvent) => {
                        const delta = moveEvent.clientX - startX;
                        const newRatio = startRatio + delta / containerWidth;
                        setRegisterRatio(
                          Math.max(0.2, Math.min(0.8, newRatio))
                        );
                      };
                      const onMouseUp = () => {
                        document.removeEventListener("mousemove", onMouseMove);
                        document.removeEventListener("mouseup", onMouseUp);
                      };
                      document.addEventListener("mousemove", onMouseMove);
                      document.addEventListener("mouseup", onMouseUp);
                    }}
                  />
                )}

                {/* Memory Panel for file-loaded traces */}
                {showMemoryPanel && isFileLoaded && selectedEntry?.memory && (
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 200,
                      borderLeft: "1px solid #3c3c3c",
                      backgroundColor: "#1e1e1e",
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                    {/* Header - matching RegisterPanelHeader style */}
                    <Box
                      sx={{
                        padding: "6px 8px",
                        backgroundColor: "#252526",
                        borderBottom: "1px solid #3c3c3c",
                      }}
                    >
                      <Typography
                        variant="subtitle2"
                        sx={{ color: "#4fc1ff", fontWeight: "bold" }}
                      >
                        Memory Dumps
                      </Typography>
                      {selectedEntry && (
                        <Typography
                          variant="caption"
                          sx={{ color: "#858585", display: "block", mt: 0.5 }}
                        >
                          #{selectedEntry.id} @ {selectedEntry.address}
                        </Typography>
                      )}
                    </Box>
                    {/* Controls */}
                    <Box
                      sx={{
                        padding: "4px 8px",
                        borderBottom: "1px solid #3c3c3c",
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        backgroundColor: "#252526",
                      }}
                    >
                      <Select
                        size="small"
                        value={memoryDisplayBytes}
                        onChange={(e) =>
                          setMemoryDisplayBytes(Number(e.target.value))
                        }
                        sx={{
                          color: "#d4d4d4",
                          fontSize: "10px",
                          height: "22px",
                          "& .MuiOutlinedInput-notchedOutline": {
                            borderColor: "#3c3c3c",
                          },
                          "&:hover .MuiOutlinedInput-notchedOutline": {
                            borderColor: "#4fc1ff",
                          },
                          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                            borderColor: "#4fc1ff",
                          },
                          "& .MuiSelect-icon": { color: "#858585" },
                        }}
                      >
                        <MenuItem value={16}>16B</MenuItem>
                        <MenuItem value={32}>32B</MenuItem>
                        <MenuItem value={64}>64B</MenuItem>
                        <MenuItem value={128}>128B</MenuItem>
                        <MenuItem value={256}>256B</MenuItem>
                      </Select>
                      <Box
                        sx={{
                          display: "flex",
                          border: "1px solid #3c3c3c",
                          borderRadius: "3px",
                        }}
                      >
                        {([1, 2, 4, 8] as const).map((size) => (
                          <Box
                            key={size}
                            onClick={() => setHexUnitSize(size)}
                            sx={{
                              px: 0.8,
                              py: 0.3,
                              fontSize: "10px",
                              cursor: "pointer",
                              backgroundColor:
                                hexUnitSize === size
                                  ? "#4fc1ff"
                                  : "transparent",
                              color:
                                hexUnitSize === size ? "#1e1e1e" : "#858585",
                              fontWeight:
                                hexUnitSize === size ? "bold" : "normal",
                              "&:hover": {
                                backgroundColor:
                                  hexUnitSize === size
                                    ? "#4fc1ff"
                                    : alpha("#4fc1ff", 0.2),
                              },
                              borderRight:
                                size !== 8 ? "1px solid #3c3c3c" : "none",
                            }}
                          >
                            {size}B
                          </Box>
                        ))}
                      </Box>
                      {/* Hex format toggle - only shown for 2B/4B/8B */}
                      {hexUnitSize > 1 && (
                        <Box
                          sx={{
                            display: "flex",
                            border: "1px solid #3c3c3c",
                            borderRadius: "3px",
                          }}
                        >
                          {(["padded", "0x"] as const).map((fmt) => (
                            <Box
                              key={fmt}
                              onClick={() => setHexPrefixFormat(fmt)}
                              sx={{
                                px: 0.8,
                                py: 0.3,
                                fontSize: "10px",
                                cursor: "pointer",
                                backgroundColor:
                                  hexPrefixFormat === fmt
                                    ? "#4fc1ff"
                                    : "transparent",
                                color:
                                  hexPrefixFormat === fmt
                                    ? "#1e1e1e"
                                    : "#858585",
                                fontWeight:
                                  hexPrefixFormat === fmt ? "bold" : "normal",
                                "&:hover": {
                                  backgroundColor:
                                    hexPrefixFormat === fmt
                                      ? "#4fc1ff"
                                      : alpha("#4fc1ff", 0.2),
                                },
                                borderRight:
                                  fmt === "padded"
                                    ? "1px solid #3c3c3c"
                                    : "none",
                              }}
                            >
                              {fmt === "padded" ? "Pad" : "0x"}
                            </Box>
                          ))}
                        </Box>
                      )}
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={showAscii}
                            onChange={(e) => setShowAscii(e.target.checked)}
                            size="small"
                            sx={{
                              color: "#858585",
                              "&.Mui-checked": { color: "#4fc1ff" },
                              padding: "2px",
                            }}
                          />
                        }
                        label={
                          <Typography
                            sx={{ color: "#858585", fontSize: "10px" }}
                          >
                            ASCII
                          </Typography>
                        }
                        sx={{ margin: 0, marginLeft: 0.5 }}
                      />
                    </Box>
                    <Box
                      sx={{
                        flex: 1,
                        overflow: "auto",
                        padding: "4px 8px",
                      }}
                    >
                      {["x0", "x1", "x2", "x3", "x4", "x5"].map((reg) => {
                        // Find memory dump for this register in the array
                        const memEntry = selectedEntry.memory?.find(
                          (m) => m.register === reg
                        );
                        const memDump = memEntry?.data;
                        if (!memDump || memDump.length === 0) return null;
                        const address = selectedEntry.registers[reg];
                        const displayData = memDump.slice(
                          0,
                          memoryDisplayBytes
                        );
                        const bytesPerLine = 16;

                        // Format hex values based on unit size
                        const formatHexUnits = (chunk: Uint8Array) => {
                          const units: string[] = [];
                          const hexChars = hexUnitSize * 2;

                          for (let i = 0; i < chunk.length; i += hexUnitSize) {
                            let value = 0n;
                            // Little-endian: first byte is least significant
                            for (
                              let j = 0;
                              j < hexUnitSize && i + j < chunk.length;
                              j++
                            ) {
                              value |= BigInt(chunk[i + j]) << BigInt(j * 8);
                            }
                            if (hexUnitSize > 1 && hexPrefixFormat === "0x") {
                              // 0x format with zero padding
                              units.push(
                                "0x" +
                                  value.toString(16).padStart(hexChars, "0")
                              );
                            } else {
                              // Padded format
                              units.push(
                                value.toString(16).padStart(hexChars, "0")
                              );
                            }
                          }
                          return units;
                        };

                        return (
                          <Box key={reg} sx={{ mb: 1.5 }}>
                            <Typography
                              variant="caption"
                              sx={{
                                color: "#858585",
                                fontSize: "10px",
                                letterSpacing: "0.5px",
                                display: "block",
                                mb: 0.5,
                              }}
                            >
                              {reg.toUpperCase()} @{" "}
                              {address?.startsWith("0x") ||
                              address?.startsWith("0X")
                                ? "0x" + address.slice(2).toLowerCase()
                                : address?.toLowerCase()}
                            </Typography>
                            <Box
                              sx={{
                                backgroundColor: "#252525",
                                borderRadius: "3px",
                                padding: "4px 6px",
                                fontFamily: "monospace",
                                fontSize: "10px",
                                overflow: "auto",
                              }}
                            >
                              {Array.from({
                                length: Math.ceil(
                                  displayData.length / bytesPerLine
                                ),
                              }).map((_, lineIndex) => {
                                const start = lineIndex * bytesPerLine;
                                const chunk = displayData.slice(
                                  start,
                                  start + bytesPerLine
                                );
                                return (
                                  <Box
                                    key={lineIndex}
                                    sx={{
                                      display: "flex",
                                      whiteSpace: "pre",
                                      lineHeight: "1.4",
                                    }}
                                  >
                                    {/* Offset */}
                                    <Box
                                      component="span"
                                      sx={{
                                        color: "#569cd6",
                                        minWidth: "36px",
                                      }}
                                    >
                                      {start.toString(16).padStart(4, "0")}
                                    </Box>
                                    {/* Separator between Offset and Hex */}
                                    <Box
                                      component="span"
                                      sx={{
                                        color: "#3c3c3c",
                                        width: "12px",
                                        textAlign: "center",
                                      }}
                                    >
                                      {" "}
                                    </Box>
                                    {/* Hex bytes - with configurable unit size */}
                                    <Box
                                      component="span"
                                      sx={{
                                        color: "#dcdcaa",
                                      }}
                                    >
                                      {formatHexUnits(chunk).map(
                                        (hexVal, i, arr) => (
                                          <span key={i}>
                                            {hexVal}
                                            {i < arr.length - 1 ? " " : ""}
                                          </span>
                                        )
                                      )}
                                    </Box>
                                    {/* ASCII */}
                                    {showAscii && (
                                      <>
                                        {/* Separator between Hex and ASCII */}
                                        <Box
                                          component="span"
                                          sx={{
                                            color: "#3c3c3c",
                                            width: "12px",
                                            textAlign: "center",
                                          }}
                                        >
                                          {" "}
                                        </Box>
                                        <Box
                                          component="span"
                                          sx={{ color: "#ce9178" }}
                                        >
                                          {Array.from(chunk).map((b, i) => (
                                            <span key={i}>
                                              {b >= 32 && b < 127
                                                ? String.fromCharCode(b)
                                                : "."}
                                            </span>
                                          ))}
                                        </Box>
                                      </>
                                    )}
                                  </Box>
                                );
                              })}
                            </Box>
                          </Box>
                        );
                      })}
                    </Box>
                  </Box>
                )}
              </Box>
              {/* End of Side Panel Container */}
            </MainContent>
          )}
        </Box>

        <StatusBar>
          <Box display="flex" gap={3}>
            <span>Total: {activeTraceEntries.length} instructions</span>
            <span>Calls: {stats.calls}</span>
            <span>Returns: {stats.returns}</span>
            <span>Max Depth: {stats.maxDepth}</span>
          </Box>
          {isTracing && (
            <Typography variant="caption" sx={{ color: "#4caf50" }}>
              ● Tracing in progress...
            </Typography>
          )}
        </StatusBar>
      </Box>
    </ThemeProvider>
  );
};

export const CodeTracingPage: React.FC = () => {
  return <CodeTracingPageInner />;
};
