import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  Box,
  styled,
  Typography,
  TextField,
  InputAdornment,
  Autocomplete,
  useMediaQuery,
} from "@mui/material";
import VirtualizedTable, { ColumnDef, SortDirection } from "./VirtualizedTable";
import {
  FilterList as FilterListIcon,
  DataObject as DataObjectIcon,
  Functions as FunctionsIcon,
  Storage as StorageIcon,
  LibraryBooks as LibraryBooksIcon,
  Search as SearchIcon,
  DragHandle as DragHandleIcon,
  InsertDriveFile as FileIcon,
  FolderOpen as FolderOpenIcon,
  AccountTree as OutlineIcon,
  DataArray as DataArrayIcon,
} from "@mui/icons-material";
import SidebarPanel from "./SidebarPanel";
import { getApiClient, ModuleInfo, SymbolInfo } from "../lib/api";
import { useAppState } from "../hooks/useAppState";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUIStore } from "../stores/uiStore";
import { invoke } from "@tauri-apps/api/core";
import {
  useGhidraAnalysis,
  GhidraFunctionEntry,
  GhidraDataItem,
} from "../hooks/useGhidraAnalysis";

// Tauri-side cache types (matching Rust structs)
// Note: Rust uses snake_case for field names
interface TauriCachedSymbol {
  address: string;
  name: string;
  size: number;
  symbol_type: string; // Rust field name
  scope: string;
  module_base: string;
  file_name?: string;
  line_number?: number;
  is_external?: boolean;
  is_private_external?: boolean;
  is_weak_def?: boolean;
  is_weak_ref?: boolean;
  is_thumb?: boolean;
  section_index?: number;
  library_ordinal?: number;
}

interface TauriCachedGhidraData {
  address: string;
  name: string | null;
  data_type: string; // Rust field name
  category: string;
  size: number;
  value: string | null;
}

interface TauriSidebarCache {
  modules: ModuleInfo[];
  symbols: TauriCachedSymbol[];
  ghidra_functions: GhidraFunctionEntry[];
  ghidra_data_items: TauriCachedGhidraData[];
  cached_process_pid: number | null;
  cached_module_path: string | null;
  last_update: number;
}

// Helper to convert Tauri cached symbol to frontend SymbolInfo
const convertCachedSymbol = (cached: TauriCachedSymbol): SymbolInfo => ({
  address: cached.address,
  name: cached.name,
  size: cached.size,
  type: cached.symbol_type, // Map symbol_type -> type
  scope: cached.scope,
  module_base: cached.module_base,
  file_name: cached.file_name,
  line_number: cached.line_number,
  is_external: cached.is_external,
  is_private_external: cached.is_private_external,
  is_weak_def: cached.is_weak_def,
  is_weak_ref: cached.is_weak_ref,
  is_thumb: cached.is_thumb,
  section_index: cached.section_index,
  library_ordinal: cached.library_ordinal,
});

// Helper to convert Tauri cached ghidra data to frontend GhidraDataItem
const convertCachedGhidraData = (
  cached: TauriCachedGhidraData
): GhidraDataItem => ({
  address: cached.address,
  name: cached.name,
  type: cached.data_type, // Map data_type -> type
  category: cached.category as GhidraDataItem["category"],
  size: cached.size,
  value: cached.value,
});

// Helper function to get display module name (same as in DebuggerContent)
const getDisplayModuleName = (moduleName: string): string => {
  if (!moduleName) return "Unknown Module";

  // For Linux/Android/Windows, extract only the module name from path
  if (moduleName.includes("/") || moduleName.includes("\\")) {
    const pathParts = moduleName.split(/[\/\\]/);
    return pathParts[pathParts.length - 1] || moduleName;
  }

  return moduleName;
};

const SidebarContainer = styled(Box)(() => ({
  gridArea: "sidebar",
  backgroundColor: "#252526",
  borderRight: "1px solid #2d2d30",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
}));

const SidebarContent = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  flex: 1,
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  pointerEvents: isResizing ? "none" : "auto",
}));

const ResizeHandle = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  position: "absolute",
  top: 0,
  right: "0px",
  width: "8px",
  height: "100%",
  cursor: "col-resize",
  backgroundColor: isResizing
    ? "rgba(0, 122, 204, 0.5)"
    : "rgba(66, 66, 66, 0.2)",
  zIndex: 1001,
  pointerEvents: "auto",
  border: isResizing ? "1px solid #007acc" : "none",
  userSelect: "none",

  "&::before": {
    content: '""',
    position: "absolute",
    right: "2px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "2px",
    height: "40px",
    backgroundColor: isResizing ? "#007acc" : "#424242",
    opacity: isResizing ? 1 : 0.6,
  },

  "&:hover": {
    backgroundColor: "rgba(0, 122, 204, 0.4)",

    "&::before": {
      backgroundColor: "#007acc",
      opacity: 1,
      width: "3px",
      height: "60px",
    },
  },

  "&:active": {
    backgroundColor: "rgba(0, 122, 204, 0.7)",

    "&::before": {
      backgroundColor: "#007acc",
      opacity: 1,
      width: "4px",
      height: "80px",
    },
  },
}));

// Panel height resize divider
const PanelDivider = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  height: "6px",
  cursor: "row-resize",
  backgroundColor: isResizing ? "rgba(0, 122, 204, 0.5)" : "#2d2d30",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background-color 0.15s ease",
  flexShrink: 0,
  "&:hover": {
    backgroundColor: "rgba(0, 122, 204, 0.4)",
  },
  "& .drag-icon": {
    fontSize: "12px",
    color: isResizing ? "#4fc1ff" : "#555",
    opacity: 0.6,
  },
  "@media (max-height: 800px)": {
    height: "4px",
    "& .drag-icon": {
      fontSize: "10px",
    },
  },
}));

const accentColors = {
  blue: "#4fc1ff",
  green: "#89d185",
  purple: "#c586c0",
  orange: "#ce9178",
  yellow: "#dcdcaa",
};

// Interface for combined functions
interface CombinedFunction {
  name: string;
  address: string;
  size: number;
  source: "symbol" | "ghidra" | "both";
}

interface DebuggerSidebarProps {
  activeFunction: string;
  onFunctionClick: (functionName: string, functionAddress?: string) => void;
  onModuleClick?: (module: any) => void;
}

export const DebuggerSidebar: React.FC<DebuggerSidebarProps> = ({
  activeFunction,
  onFunctionClick,
}) => {
  const { system, ui, uiActions } = useAppState();
  const attachedProcess = system.attachedProcess;
  const selectedModule = ui.debuggerState.selectedModule;
  const serverInfo = system.serverInfo;
  const debuggerSidebarWidth = ui.debuggerSidebarWidth;
  const setDebuggerSidebarWidth = uiActions.setDebuggerSidebarWidth;
  const setSelectedModule = uiActions.setSelectedModule;
  const setMemoryAddress = uiActions.setMemoryAddress;

  // Break state for variable value display
  const isInBreakState = system.isInBreakState;
  const currentBreakAddress = system.currentBreakAddress;
  const currentRegisterData = system.currentRegisterData;

  // Selected module base address for offset calculation (from DWARF debug state)
  const dwarfModuleBase = useUIStore(
    (state) => state.toolsState?.debugState?.selectedModuleBase
  );

  // Source code level debug state
  const sourceCodeLevelDebug = ui.debuggerState.sourceCodeLevelDebug;
  const dwarfAnalysisResult = useUIStore(
    (state) => state.toolsState?.debugState?.analysisResult
  );
  const setPendingSourceJump = useUIStore(
    (state) => state.actions.setPendingSourceJump
  );

  // Responsive: detect compact height mode
  const isCompactHeight = useMediaQuery("(max-height: 800px)");
  const compactRowHeight = isCompactHeight ? 20 : 24;

  // Local state backed by Tauri cache (survives React StrictMode re-mounts)
  const [modules, setModulesLocal] = useState<ModuleInfo[]>([]);
  const [selectedModuleSymbols, setSelectedModuleSymbolsLocal] = useState<
    SymbolInfo[]
  >([]);
  const [ghidraFunctions, setGhidraFunctionsLocal] = useState<
    GhidraFunctionEntry[]
  >([]);
  const [ghidraDataItems, setGhidraDataItemsLocal] = useState<GhidraDataItem[]>(
    []
  );
  const [cacheInitialized, setCacheInitialized] = useState(false);

  // Track cached module path and process PID
  const cachedModulePathRef = useRef<string | null>(null);
  const cachedProcessPidRef = useRef<number | null>(null);

  // Initialize from Tauri cache on mount
  useEffect(() => {
    const initFromCache = async () => {
      try {
        const cache = await invoke<TauriSidebarCache>("get_sidebar_cache");
        console.log("[DebuggerSidebar] Loaded cache from Tauri:", {
          modules: cache?.modules?.length || 0,
          symbols: cache?.symbols?.length || 0,
          cachedModulePath: cache?.cached_module_path,
          cachedProcessPid: cache?.cached_process_pid,
        });
        if (cache) {
          setModulesLocal(cache.modules || []);
          // Convert Tauri cache format to frontend format
          setSelectedModuleSymbolsLocal(
            (cache.symbols || []).map(convertCachedSymbol)
          );
          setGhidraFunctionsLocal(cache.ghidra_functions || []);
          setGhidraDataItemsLocal(
            (cache.ghidra_data_items || []).map(convertCachedGhidraData)
          );
          cachedModulePathRef.current = cache.cached_module_path;
          cachedProcessPidRef.current = cache.cached_process_pid;
          // Also update the "lastLoaded" refs so we don't re-fetch on mount
          lastLoadedProcessPidRef.current = cache.cached_process_pid;
          lastLoadedModulePathRef.current = cache.cached_module_path;
          lastLoadedSymbolsModuleRef.current = cache.cached_module_path;
          lastLoadedDataModuleRef.current = cache.cached_module_path;
        }
      } catch (e) {
        console.error("Failed to load sidebar cache from Tauri:", e);
      }
      setCacheInitialized(true);
    };
    initFromCache();
  }, []);

  // Ghidra analysis hook
  const {
    isLibraryAnalyzed,
    getCachedFunctionsAsync,
    getData,
    serverRunning,
    serverProjectPath,
    getAnalyzedLibraryInfo,
    analyzedLibraries, // Added to track when analysis completes
  } = useGhidraAnalysis();

  const [showFunctionFilter, setShowFunctionFilter] = useLocalStorage<boolean>(
    "debugger-sidebar-show-function-filter",
    false
  );
  const [showVariableFilter, setShowVariableFilter] = useLocalStorage<boolean>(
    "debugger-sidebar-show-variable-filter",
    false
  );
  const [showDataFilter, setShowDataFilter] = useLocalStorage<boolean>(
    "debugger-sidebar-show-data-filter",
    false
  );
  const [isResizing, setIsResizing] = useState(false);

  // Panel expanded states - persisted to localStorage
  const [functionsExpanded, setFunctionsExpanded] = useLocalStorage<boolean>(
    "debugger-sidebar-functions-expanded",
    true
  );
  const [variablesExpanded, setVariablesExpanded] = useLocalStorage<boolean>(
    "debugger-sidebar-variables-expanded",
    true
  );
  const [dataExpanded, setDataExpanded] = useLocalStorage<boolean>(
    "debugger-sidebar-data-expanded",
    false
  );

  // Panel heights - persisted to localStorage
  const [functionsHeight, setFunctionsHeight] = useLocalStorage<number>(
    "debugger-sidebar-functions-height",
    200
  );
  const [variablesHeight, setVariablesHeight] = useLocalStorage<number>(
    "debugger-sidebar-variables-height",
    150
  );
  const [dataHeight, setDataHeight] = useLocalStorage<number>(
    "debugger-sidebar-data-height",
    200
  );

  // Source mode panel heights - persisted to localStorage
  const [sourceFilesHeight, setSourceFilesHeight] = useLocalStorage<number>(
    "debugger-sidebar-source-files-height",
    150
  );
  const [outlineHeight, setOutlineHeight] = useLocalStorage<number>(
    "debugger-sidebar-outline-height",
    200
  );
  const [sourceVariablesHeight, setSourceVariablesHeight] =
    useLocalStorage<number>("debugger-sidebar-source-variables-height", 150);

  // Panel resize state
  const [resizingPanel, setResizingPanel] = useState<string | null>(null);
  const resizeStartRef = useRef<{ y: number; height: number }>({
    y: 0,
    height: 0,
  });

  // Filter states - persisted to localStorage
  const [functionFilter, setFunctionFilter] = useLocalStorage<string>(
    "debugger-sidebar-function-filter",
    ""
  );
  const [variableFilter, setVariableFilter] = useLocalStorage<string>(
    "debugger-sidebar-variable-filter",
    ""
  );
  const [dataNameFilter, setDataNameFilter] = useLocalStorage<string>(
    "debugger-sidebar-data-name-filter",
    ""
  );
  const [dataTypeFilter, setDataTypeFilter] = useLocalStorage<string>(
    "debugger-sidebar-data-type-filter",
    ""
  );

  // Sort states - persisted to localStorage
  type ModuleSortField = "name" | "address" | "size";
  type FunctionSortField = "name" | "address" | "size";
  type VariableSortField = "name" | "address" | "size";
  type DataSortField = "name" | "address" | "type";

  const [moduleSortField] = useLocalStorage<ModuleSortField>(
    "debugger-sidebar-module-sort-field",
    "name"
  );
  const [moduleSortDir] = useLocalStorage<SortDirection>(
    "debugger-sidebar-module-sort-dir",
    "asc"
  );
  const [functionSortField, setFunctionSortField] =
    useLocalStorage<FunctionSortField>(
      "debugger-sidebar-function-sort-field",
      "name"
    );
  const [functionSortDir, setFunctionSortDir] = useLocalStorage<SortDirection>(
    "debugger-sidebar-function-sort-dir",
    "asc"
  );
  const [variableSortField, setVariableSortField] =
    useLocalStorage<VariableSortField>(
      "debugger-sidebar-variable-sort-field",
      "name"
    );
  const [variableSortDir, setVariableSortDir] = useLocalStorage<SortDirection>(
    "debugger-sidebar-variable-sort-dir",
    "asc"
  );

  // Sort handlers
  const handleFunctionSort = (field: FunctionSortField) => {
    if (functionSortField === field) {
      setFunctionSortDir(functionSortDir === "asc" ? "desc" : "asc");
    } else {
      setFunctionSortField(field);
      setFunctionSortDir("asc");
    }
  };

  const handleVariableSort = (field: VariableSortField) => {
    if (variableSortField === field) {
      setVariableSortDir(variableSortDir === "asc" ? "desc" : "asc");
    } else {
      setVariableSortField(field);
      setVariableSortDir("asc");
    }
  };

  // Data sort states
  const [dataSortField, setDataSortField] = useLocalStorage<DataSortField>(
    "debugger-sidebar-data-sort-field",
    "address"
  );
  const [dataSortDir, setDataSortDir] = useLocalStorage<SortDirection>(
    "debugger-sidebar-data-sort-dir",
    "asc"
  );

  const handleDataSort = (field: DataSortField) => {
    if (dataSortField === field) {
      setDataSortDir(dataSortDir === "asc" ? "desc" : "asc");
    } else {
      setDataSortField(field);
      setDataSortDir("asc");
    }
  };

  // Find current function based on break address
  const currentFunction = useMemo(() => {
    if (
      !isInBreakState ||
      !currentBreakAddress ||
      !dwarfAnalysisResult?.functions ||
      !dwarfModuleBase
    ) {
      return null;
    }

    // Parse break address
    let breakAddr: number;
    if (typeof currentBreakAddress === "string") {
      breakAddr = parseInt(currentBreakAddress.replace(/^0x/i, ""), 16);
    } else {
      breakAddr = currentBreakAddress;
    }

    // Calculate offset from module base
    const offset = breakAddr - dwarfModuleBase;

    // Find function containing this offset
    for (const func of dwarfAnalysisResult.functions) {
      if (func.low_pc !== null && func.high_pc !== null) {
        if (offset >= func.low_pc && offset < func.high_pc) {
          return func;
        }
      }
    }
    return null;
  }, [
    isInBreakState,
    currentBreakAddress,
    dwarfAnalysisResult?.functions,
    dwarfModuleBase,
  ]);

  // Cache for resolved variable values (async memory reads)
  const [resolvedVariableValues, setResolvedVariableValues] = useState<
    Map<string, string>
  >(new Map());
  const pendingReadsRef = useRef<Set<string>>(new Set());

  // Helper to get type size in bytes
  const getTypeSize = useCallback((typeName: string | null): number => {
    if (!typeName) return 8; // default to pointer size
    const t = typeName.toLowerCase();
    if (t.includes("char") && !t.includes("*")) return 1;
    if (t.includes("short")) return 2;
    if (t.includes("int") && !t.includes("long")) return 4;
    if (t.includes("long long") || t.includes("int64")) return 8;
    if (t.includes("long")) return 8; // ARM64: long is 8 bytes
    if (t.includes("float") && !t.includes("double")) return 4;
    if (t.includes("double")) return 8;
    if (t.includes("*") || t.includes("ptr")) return 8; // pointer
    return 4; // default to 4 bytes
  }, []);

  // Helper to format value based on type
  const formatValueByType = useCallback(
    (bytes: Uint8Array, typeName: string | null): string => {
      const t = (typeName || "").toLowerCase();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

      try {
        if (t.includes("char") && !t.includes("*")) {
          const val = view.getInt8(0);
          if (val >= 32 && val < 127) {
            return `'${String.fromCharCode(val)}' (${val})`;
          }
          return `${val}`;
        }
        if (t.includes("short")) {
          return `${view.getInt16(0, true)}`;
        }
        if (
          t.includes("unsigned") &&
          t.includes("int") &&
          !t.includes("long")
        ) {
          return `${view.getUint32(0, true)}`;
        }
        if (t.includes("int") && !t.includes("long")) {
          return `${view.getInt32(0, true)}`;
        }
        if (t.includes("float") && !t.includes("double")) {
          return `${view.getFloat32(0, true).toFixed(2)}`;
        }
        if (t.includes("double")) {
          return `${view.getFloat64(0, true).toFixed(4)}`;
        }
        if (t.includes("*") || t.includes("ptr")) {
          // Pointer - show as hex
          const ptr =
            bytes.length >= 8
              ? view.getBigUint64(0, true)
              : BigInt(view.getUint32(0, true));
          return `0x${ptr.toString(16)}`;
        }
        // Default: try as signed 32-bit or 64-bit
        if (bytes.length >= 8) {
          const val = view.getBigInt64(0, true);
          if (val >= -2147483648n && val <= 2147483647n) {
            return `${val}`;
          }
          return `0x${val.toString(16)}`;
        }
        return `${view.getInt32(0, true)}`;
      } catch {
        // Fallback: hex dump
        return `0x${Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`;
      }
    },
    []
  );

  // Calculate absolute address from location expression
  const calculateAddress = useCallback(
    (
      location: string,
      moduleBase: number
    ): { address: number; source: string } | null => {
      // Helper to get register value (case-insensitive)
      const getRegValue = (name: string): string | undefined => {
        if (!currentRegisterData) return undefined;
        return (
          currentRegisterData[name] ||
          currentRegisterData[name.toUpperCase()] ||
          currentRegisterData[name.toLowerCase()]
        );
      };

      // Handle address locations (e.g., "DW_OP_addr 0x1234") - relative to module base
      const addrMatch = location.match(/DW_OP_addr\s*(0x[0-9a-fA-F]+|\d+)/);
      if (addrMatch) {
        const relativeAddr =
          parseInt(addrMatch[1], 16) || parseInt(addrMatch[1], 10);
        return { address: moduleBase + relativeAddr, source: "addr" };
      }

      // Handle register offset (e.g., "DW_OP_breg31 -8" = sp+offset)
      const bregMatch = location.match(/DW_OP_breg(\d+)\s*([-+]?\d+)/);
      if (bregMatch) {
        const regNum = parseInt(bregMatch[1], 10);
        const offset = parseInt(bregMatch[2], 10);
        // Get display name
        const regName =
          regNum === 31 ? "sp" : regNum === 29 ? "fp" : `x${regNum}`;
        // Try to get register value (case-insensitive)
        const regValue = getRegValue(regName) || getRegValue(`x${regNum}`);
        if (regValue) {
          const regAddr = parseInt(regValue.replace(/^0x/i, ""), 16);
          return {
            address: regAddr + offset,
            source: `${regName}${offset >= 0 ? "+" : ""}${offset}`,
          };
        }
        return null;
      }

      // Handle frame base relative locations (e.g., "DW_OP_fbreg -8")
      const fbregMatch = location.match(/DW_OP_fbreg\s*([-+]?\d+)/);
      if (fbregMatch) {
        const offset = parseInt(fbregMatch[1], 10);
        // Try fp, x29, or sp as frame base (case-insensitive)
        const fpValue =
          getRegValue("fp") || getRegValue("x29") || getRegValue("sp");
        if (fpValue) {
          const fpAddr = parseInt(fpValue.replace(/^0x/i, ""), 16);
          return {
            address: fpAddr + offset,
            source: `fp${offset >= 0 ? "+" : ""}${offset}`,
          };
        }
        return null;
      }

      return null;
    },
    [currentRegisterData]
  );

  // Async read variable value from memory
  useEffect(() => {
    if (!isInBreakState || !dwarfModuleBase || !dwarfAnalysisResult) {
      setResolvedVariableValues(new Map());
      pendingReadsRef.current.clear();
      return;
    }

    // Check if register data is available (not empty)
    const hasRegisterData =
      currentRegisterData && Object.keys(currentRegisterData).length > 0;

    // Log for debugging
    console.log("[Variable] useEffect triggered:", {
      isInBreakState,
      dwarfModuleBase,
      hasRegisterData,
      registerKeys: currentRegisterData
        ? Object.keys(currentRegisterData).slice(0, 5)
        : [],
    });

    // Helper to check if type is a string pointer
    const isStringPointer = (typeName: string | null): boolean => {
      if (!typeName) return false;
      const t = typeName.toLowerCase();
      return (
        t.includes("char*") ||
        t.includes("char *") ||
        t === "const char*" ||
        t === "const char *" ||
        t.includes("char const*") ||
        t.includes("char const *")
      );
    };

    // Helper to read null-terminated string from memory
    const readStringFromMemory = async (
      api: ReturnType<typeof getApiClient>,
      address: number,
      maxLength: number = 64
    ): Promise<string | null> => {
      try {
        const data = await api.readMemory(
          `0x${address.toString(16)}`,
          maxLength,
          true
        );
        const bytes = new Uint8Array(data);
        // Find null terminator
        let end = bytes.indexOf(0);
        if (end === -1) end = maxLength;
        // Convert to string (ASCII)
        const str = String.fromCharCode(...bytes.slice(0, Math.min(end, 32)));
        // Check if it looks like a valid string
        if (str.length > 0 && /^[\x20-\x7E\t\n\r]+$/.test(str)) {
          return str.length > 24 ? str.substring(0, 24) + "…" : str;
        }
        return null;
      } catch {
        return null;
      }
    };

    const readVariableValue = async (variable: any) => {
      const key = `${variable.name}:${variable.location}`;
      if (pendingReadsRef.current.has(key) || resolvedVariableValues.has(key)) {
        return;
      }

      const location = variable.location;
      if (!location) {
        // No location info - show N/A
        setResolvedVariableValues((prev) => new Map(prev).set(key, "<no loc>"));
        return;
      }

      // Handle register locations (e.g., "DW_OP_reg0" = x0) - direct register value
      const regMatch = location.match(/DW_OP_reg(\d+)/);
      if (regMatch) {
        const regNum = parseInt(regMatch[1], 10);
        const regName =
          regNum === 31 ? "sp" : regNum === 29 ? "fp" : `x${regNum}`;
        if (!currentRegisterData) {
          setResolvedVariableValues((prev) =>
            new Map(prev).set(key, `[${regName}]`)
          );
          return;
        }
        // Case-insensitive register lookup
        const value =
          currentRegisterData[regName] ||
          currentRegisterData[regName.toUpperCase()] ||
          currentRegisterData[`X${regNum}`] ||
          currentRegisterData[`x${regNum}`];
        if (value !== undefined) {
          // If it's a string pointer in a register, try to read the string
          if (isStringPointer(variable.type_name)) {
            const api = getApiClient();
            const addr = parseInt(value.replace(/^0x/i, ""), 16);
            if (addr > 0 && addr < 0xffffffffffff) {
              pendingReadsRef.current.add(key);
              const str = await readStringFromMemory(api, addr);
              pendingReadsRef.current.delete(key);
              if (str) {
                setResolvedVariableValues((prev) =>
                  new Map(prev).set(key, `"${str}"`)
                );
                return;
              }
            }
          }
          setResolvedVariableValues((prev) => new Map(prev).set(key, value));
          return;
        } else {
          // Register not found in data
          setResolvedVariableValues((prev) =>
            new Map(prev).set(key, `[${regName}?]`)
          );
          return;
        }
      }

      // Handle constant values
      const constMatch = location.match(/DW_OP_const[us]\s*(\d+)/);
      if (constMatch) {
        setResolvedVariableValues((prev) =>
          new Map(prev).set(key, constMatch[1])
        );
        return;
      }

      // Calculate address for memory read
      const addrInfo = calculateAddress(location, dwarfModuleBase);
      if (!addrInfo) {
        // Could not calculate address - show location info as fallback
        // Extract first operation for display
        const opMatch = location.match(/DW_OP_\w+/);
        if (opMatch) {
          setResolvedVariableValues((prev) =>
            new Map(prev).set(key, `[${opMatch[0]}]`)
          );
        } else {
          setResolvedVariableValues((prev) => new Map(prev).set(key, `[?]`));
        }
        return;
      }

      pendingReadsRef.current.add(key);

      try {
        const api = getApiClient();

        // For string pointers, read pointer value first, then the string
        if (isStringPointer(variable.type_name)) {
          const ptrData = await api.readMemory(
            `0x${addrInfo.address.toString(16)}`,
            8,
            true
          );
          const ptrBytes = new Uint8Array(ptrData);
          const view = new DataView(
            ptrBytes.buffer,
            ptrBytes.byteOffset,
            ptrBytes.length
          );
          const strAddr = Number(view.getBigUint64(0, true));

          if (strAddr > 0 && strAddr < 0xffffffffffff) {
            const str = await readStringFromMemory(api, strAddr);
            if (str) {
              setResolvedVariableValues((prev) =>
                new Map(prev).set(key, `"${str}"`)
              );
              return;
            }
          }
          // Fallback: show pointer value
          setResolvedVariableValues((prev) =>
            new Map(prev).set(key, `0x${strAddr.toString(16)}`)
          );
          return;
        }

        const size = getTypeSize(variable.type_name);
        const data = await api.readMemory(
          `0x${addrInfo.address.toString(16)}`,
          size,
          true
        );
        const bytes = new Uint8Array(data);
        const formatted = formatValueByType(bytes, variable.type_name);
        setResolvedVariableValues((prev) => new Map(prev).set(key, formatted));
      } catch (err) {
        console.error(`[Variable] Failed to read ${variable.name}:`, err);
        // Show address info as fallback
        setResolvedVariableValues((prev) =>
          new Map(prev).set(key, `[${addrInfo.source}]`)
        );
      } finally {
        pendingReadsRef.current.delete(key);
      }
    };

    // Collect all variables including parameters
    const globalVars = dwarfAnalysisResult.variables || [];
    const functionVars =
      dwarfAnalysisResult.functions?.flatMap((f: any) => [
        ...(f.parameters || []),
        ...(f.variables || []),
      ]) || [];
    const allVariables = [...globalVars, ...functionVars];

    // Read values for all variables (with small delay to batch)
    const timeout = setTimeout(() => {
      allVariables.forEach((v) => readVariableValue(v));
    }, 100);

    return () => clearTimeout(timeout);
  }, [
    isInBreakState,
    dwarfModuleBase,
    dwarfAnalysisResult,
    currentRegisterData,
    calculateAddress,
    getTypeSize,
    formatValueByType,
  ]);

  // Helper to get resolved value for a variable
  const getResolvedValue = useCallback(
    (variable: any): string | null => {
      if (!isInBreakState || !variable.location) return null;
      const key = `${variable.name}:${variable.location}`;
      return resolvedVariableValues.get(key) || null;
    },
    [isInBreakState, resolvedVariableValues]
  );

  // Get stable module path string for dependency tracking
  const selectedModulePath =
    selectedModule?.path || selectedModule?.modulename || null;
  const selectedModuleBase = selectedModule?.base;

  // Track the last loaded module path to avoid clearing ghidra functions on tab switch
  const lastLoadedModulePathRef = useRef<string | null>(
    cachedModulePathRef.current
  );
  // Track the last loaded symbols/data module path to avoid reloading on tab switch
  const lastLoadedSymbolsModuleRef = useRef<string | null>(
    cachedModulePathRef.current
  );
  const lastLoadedDataModuleRef = useRef<string | null>(
    cachedModulePathRef.current
  );
  // Track the last loaded process PID to avoid reloading modules on tab switch
  const lastLoadedProcessPidRef = useRef<number | null>(
    cachedProcessPidRef.current
  );
  const [loading, setLoading] = useState(false);
  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [loadingData, setLoadingData] = useState(false);

  // Functions to update both local state and Tauri cache
  const setModules = useCallback(
    (mods: ModuleInfo[]) => {
      setModulesLocal(mods);
      if (attachedProcess?.pid) {
        invoke("set_sidebar_modules", {
          modules: mods.map((m) => ({
            modulename: m.modulename,
            base: m.base,
            size: m.size,
            path: m.path,
            is_64bit: m.is_64bit,
          })),
          processPid: attachedProcess.pid,
        }).catch((e) =>
          console.error("Failed to save modules to Tauri cache:", e)
        );
        lastLoadedProcessPidRef.current = attachedProcess.pid;
        cachedProcessPidRef.current = attachedProcess.pid;
      }
    },
    [attachedProcess?.pid]
  );

  const setSelectedModuleSymbols = useCallback(
    (symbols: SymbolInfo[]) => {
      setSelectedModuleSymbolsLocal(symbols);
      if (selectedModulePath) {
        invoke("set_sidebar_symbols", {
          symbols: symbols.map((s) => ({
            address: s.address,
            name: s.name,
            size: s.size,
            symbol_type: s.type,
            scope: s.scope,
            module_base: s.module_base,
            file_name: s.file_name,
            line_number: s.line_number,
            is_external: s.is_external,
            is_private_external: s.is_private_external,
            is_weak_def: s.is_weak_def,
            is_weak_ref: s.is_weak_ref,
            is_thumb: s.is_thumb,
            section_index: s.section_index,
            library_ordinal: s.library_ordinal,
          })),
          modulePath: selectedModulePath,
        }).catch((e) =>
          console.error("Failed to save symbols to Tauri cache:", e)
        );
        lastLoadedSymbolsModuleRef.current = selectedModulePath;
        cachedModulePathRef.current = selectedModulePath;
      }
    },
    [selectedModulePath]
  );

  const setGhidraFunctions = useCallback(
    (functions: GhidraFunctionEntry[]) => {
      setGhidraFunctionsLocal(functions);
      if (selectedModulePath) {
        invoke("set_sidebar_ghidra_functions", {
          functions: functions.map((f) => ({
            name: f.name,
            address: f.address,
            size: f.size,
          })),
          modulePath: selectedModulePath,
        }).catch((e) =>
          console.error("Failed to save ghidra functions to Tauri cache:", e)
        );
        lastLoadedModulePathRef.current = selectedModulePath;
        cachedModulePathRef.current = selectedModulePath;
      }
    },
    [selectedModulePath]
  );

  const setGhidraDataItems = useCallback(
    (items: GhidraDataItem[]) => {
      setGhidraDataItemsLocal(items);
      if (selectedModulePath) {
        invoke("set_sidebar_ghidra_data", {
          dataItems: items.map((d) => ({
            address: d.address,
            name: d.name,
            data_type: d.type,
            category: d.category,
            size: d.size,
            value: d.value,
          })),
          modulePath: selectedModulePath,
        }).catch((e) =>
          console.error("Failed to save ghidra data to Tauri cache:", e)
        );
        lastLoadedDataModuleRef.current = selectedModulePath;
        cachedModulePathRef.current = selectedModulePath;
      }
    },
    [selectedModulePath]
  );

  const clearSidebarCache = useCallback(async () => {
    setModulesLocal([]);
    setSelectedModuleSymbolsLocal([]);
    setGhidraFunctionsLocal([]);
    setGhidraDataItemsLocal([]);
    cachedModulePathRef.current = null;
    cachedProcessPidRef.current = null;
    lastLoadedModulePathRef.current = null;
    lastLoadedSymbolsModuleRef.current = null;
    lastLoadedDataModuleRef.current = null;
    lastLoadedProcessPidRef.current = null;
    try {
      await invoke("clear_sidebar_cache");
    } catch (e) {
      console.error("Failed to clear Tauri sidebar cache:", e);
    }
  }, []);

  const sidebarRef = useRef<HTMLDivElement>(null);

  const [dragState, setDragState] = useState<{
    isDragging: boolean;
    startX: number;
    startWidth: number;
  }>({ isDragging: false, startX: 0, startWidth: 0 });

  // Load modules when process is attached
  useEffect(() => {
    // Wait for cache to be initialized from Tauri
    if (!cacheInitialized) return;

    const loadModules = async () => {
      if (!attachedProcess) {
        setModulesLocal([]);
        setSelectedModuleSymbolsLocal([]);
        return;
      }

      // Check if we already have cached modules for this process using ref
      if (lastLoadedProcessPidRef.current === attachedProcess.pid) {
        // Already loaded for this process, skip
        return;
      }

      // Clear cache if process changed
      if (
        lastLoadedProcessPidRef.current !== null &&
        lastLoadedProcessPidRef.current !== attachedProcess.pid
      ) {
        await clearSidebarCache();
      }

      try {
        setLoading(true);
        const apiClient = getApiClient();
        const response = await apiClient.enumerateModules();
        if (response.data) {
          setModules(response.data.modules);
        }
      } catch (error) {
        console.error("Failed to load modules:", error);
        setModulesLocal([]);
      } finally {
        setLoading(false);
      }
    };

    loadModules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedProcess?.pid, cacheInitialized]);

  // Clear cached data when module actually changes (different path)
  // Only run after cache is initialized to avoid clearing restored data
  useEffect(() => {
    if (!cacheInitialized) return;

    if (
      selectedModulePath &&
      lastLoadedSymbolsModuleRef.current !== null &&
      lastLoadedSymbolsModuleRef.current !== selectedModulePath
    ) {
      // Module changed - clear old data (local state only, don't persist empty)
      setSelectedModuleSymbolsLocal([]);
      setGhidraFunctionsLocal([]);
      setGhidraDataItemsLocal([]);
      lastLoadedSymbolsModuleRef.current = null;
      lastLoadedDataModuleRef.current = null;
      lastLoadedModulePathRef.current = null;
    }
  }, [selectedModulePath, cacheInitialized]);

  // Load symbols when module is selected
  useEffect(() => {
    // Wait for cache to be initialized from Tauri
    if (!cacheInitialized) return;

    const loadSymbols = async () => {
      console.log("[DebuggerSidebar] loadSymbols check:", {
        selectedModulePath,
        lastLoadedSymbolsModuleRef: lastLoadedSymbolsModuleRef.current,
        hasSelectedModule: !!selectedModule,
      });

      if (!selectedModule || !selectedModulePath) {
        // Don't clear data when module becomes null (tab switch)
        // The data will be maintained in Tauri cache until a new module is explicitly selected
        console.log("[DebuggerSidebar] loadSymbols: no module, skipping");
        return;
      }

      // Skip if this module's symbols are already loaded
      if (lastLoadedSymbolsModuleRef.current === selectedModulePath) {
        console.log("[DebuggerSidebar] loadSymbols: already loaded, skipping");
        return;
      }

      console.log("[DebuggerSidebar] loadSymbols: fetching from API");
      const currentModulePath = selectedModulePath;

      // If module changed, clear ghidra functions (local only)
      if (lastLoadedModulePathRef.current !== currentModulePath) {
        setGhidraFunctionsLocal([]);
        lastLoadedModulePathRef.current = currentModulePath;
      }

      try {
        setLoadingSymbols(true);
        const apiClient = getApiClient();
        const symbols =
          await apiClient.enumerateSymbolsForModule(selectedModule);
        setSelectedModuleSymbols(symbols);

        // Also load Ghidra functions if library is analyzed
        if (currentModulePath && isLibraryAnalyzed(currentModulePath)) {
          const ghidraFuncs = await getCachedFunctionsAsync(currentModulePath);
          if (ghidraFuncs) {
            setGhidraFunctions(ghidraFuncs);
          }
          // Don't set to empty if getCachedFunctionsAsync returns null - keep previous
        }
        // Don't clear ghidra functions if not analyzed - keep previous from cache
      } catch (error) {
        console.error(
          "Failed to load symbols for module:",
          selectedModule.name,
          error
        );
        // Don't clear data on error - keep previous from cache
      } finally {
        setLoadingSymbols(false);
      }
    };

    loadSymbols();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedModulePath,
    selectedModuleBase,
    analyzedLibraries,
    cacheInitialized,
  ]);

  // Load Ghidra data items when module is selected and server is running
  useEffect(() => {
    // Wait for cache to be initialized from Tauri
    if (!cacheInitialized) return;

    const loadDataItems = async () => {
      if (!selectedModule || !selectedModulePath) {
        // Don't clear data when module becomes null (tab switch)
        return;
      }

      const modulePath = selectedModulePath;
      if (!isLibraryAnalyzed(modulePath)) {
        // Not analyzed, keep any existing data
        return;
      }

      // Skip if this module's data is already loaded
      if (lastLoadedDataModuleRef.current === modulePath) {
        return;
      }

      // Check if Ghidra server is running for this library
      const libInfo = getAnalyzedLibraryInfo(modulePath);
      if (
        !libInfo ||
        !serverRunning ||
        serverProjectPath !== libInfo.projectPath
      ) {
        // Server not running or project mismatch, keep existing data
        return;
      }

      try {
        setLoadingData(true);
        const result = await getData(modulePath);
        if (result && result.success && result.data) {
          setGhidraDataItems(result.data);
          lastLoadedDataModuleRef.current = modulePath;
        }
        // Don't clear on failure - keep previous data
      } catch (error) {
        console.error("Failed to load data items:", error);
        // Don't clear on error - keep previous data
      } finally {
        setLoadingData(false);
      }
    };

    loadDataItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModulePath, serverRunning, serverProjectPath, cacheInitialized]);

  // Filter functions and variables from symbols
  // Darwin (iOS/macOS): type is "SECT", "ABS", etc., use scope and name heuristics
  // Linux/Android: type is "Function", "Public", "Object", etc.
  // Detect Darwin by serverInfo OR by symbol type (SECT is Darwin-specific)
  const isDarwin = useMemo(() => {
    // First check serverInfo
    if (serverInfo?.target_os === "ios" || serverInfo?.target_os === "macos") {
      return true;
    }
    // Fallback: detect from symbol types (SECT is Darwin-specific)
    if (selectedModuleSymbols.length > 0) {
      const hasDarwinSymbols = selectedModuleSymbols.some(
        (s) => s.type === "SECT" || s.type === "ABS" || s.type === "INDR"
      );
      return hasDarwinSymbols;
    }
    return false;
  }, [serverInfo?.target_os, selectedModuleSymbols]);

  const symbolFunctions = useMemo(() => {
    const result = selectedModuleSymbols.filter((symbol) => {
      if (!symbol.name) return false;

      if (isDarwin) {
        // Darwin: Functions typically have "SECT" type and names starting with underscore
        // Exclude symbols that look like data (ending with common data suffixes)
        const name = symbol.name;

        // These are likely data, not functions
        const isLikelyData =
          name.startsWith("_OBJC_CLASS_$") ||
          name.startsWith("_OBJC_METACLASS_$") ||
          name.startsWith("_OBJC_IVAR_$") ||
          name.startsWith("__OBJC_$_") ||
          name.startsWith("__OBJC_LABEL_") ||
          name.includes("_$classMetadata") ||
          name.includes("_$nominal") ||
          name.includes("_$type_metadata") ||
          name.endsWith("Wvd") || // Swift witness table
          name.endsWith("WV") || // Swift value witness
          (name.endsWith("N") && name.includes("_$s")); // Swift type metadata

        if (isLikelyData) return false;

        // Functions are typically in SECT type with Global, Local, or Private scope
        return (
          symbol.type === "SECT" &&
          (symbol.scope === "Global" ||
            symbol.scope === "Local" ||
            symbol.scope === "Private")
        );
      } else {
        // Linux/Android: Use explicit type field
        return symbol.type === "Function" || symbol.type === "Public";
      }
    });

    return result;
  }, [selectedModuleSymbols, isDarwin]);

  const variables = useMemo(() => {
    return selectedModuleSymbols.filter(
      (symbol) => symbol.name && !symbolFunctions.includes(symbol)
    );
  }, [selectedModuleSymbols, symbolFunctions]);

  // Combined functions: symbol functions + ghidra functions (deduplicated)
  const combinedFunctions = useMemo((): CombinedFunction[] => {
    const result: CombinedFunction[] = [];
    const addressMap = new Map<string, CombinedFunction>();

    // Add symbol functions
    for (const func of symbolFunctions) {
      const normalizedAddr = func.address.toLowerCase();
      addressMap.set(normalizedAddr, {
        name: func.name,
        address: func.address,
        size: func.size || 0,
        source: "symbol",
      });
    }

    // Add/merge Ghidra functions
    const moduleBase = selectedModule?.base || 0;
    for (const gFunc of ghidraFunctions) {
      // Ghidra address is offset from base, convert to absolute
      const absoluteAddr =
        moduleBase + parseInt(gFunc.address.replace("0x", ""), 16);
      const addrHex = `0x${absoluteAddr.toString(16).toUpperCase()}`;
      const normalizedAddr = addrHex.toLowerCase();

      const existing = addressMap.get(normalizedAddr);
      if (existing) {
        // Function exists in both sources
        existing.source = "both";
        // Prefer Ghidra name if different (usually more meaningful)
        if (gFunc.name !== existing.name && !gFunc.name.startsWith("FUN_")) {
          existing.name = gFunc.name;
        }
        // Use Ghidra size if available and larger
        if (gFunc.size > existing.size) {
          existing.size = gFunc.size;
        }
      } else {
        addressMap.set(normalizedAddr, {
          name: gFunc.name,
          address: addrHex,
          size: gFunc.size || 0,
          source: "ghidra",
        });
      }
    }

    result.push(...addressMap.values());
    return result;
  }, [symbolFunctions, ghidraFunctions, selectedModule?.base]);

  // Filtered and sorted modules
  const filteredModules = useMemo(() => {
    let result = [...modules];

    // Apply sort by field
    result.sort((a, b) => {
      let cmp = 0;
      if (moduleSortField === "name") {
        const nameA = getDisplayModuleName(a.modulename).toLowerCase();
        const nameB = getDisplayModuleName(b.modulename).toLowerCase();
        cmp = nameA.localeCompare(nameB);
      } else if (moduleSortField === "address") {
        const addrA = (a.base_address || "").toLowerCase();
        const addrB = (b.base_address || "").toLowerCase();
        cmp = addrA.localeCompare(addrB);
      } else {
        cmp = (a.size || 0) - (b.size || 0);
      }
      return moduleSortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [modules, moduleSortField, moduleSortDir]);

  // Filtered and sorted functions
  const filteredFunctions = useMemo(() => {
    let result = [...combinedFunctions];

    // Apply filter
    if (functionFilter.trim()) {
      const filter = functionFilter.toLowerCase();
      result = result.filter(
        (f) =>
          f.name.toLowerCase().includes(filter) ||
          f.address.toLowerCase().includes(filter)
      );
    }

    // Apply sort
    result.sort((a, b) => {
      let cmp = 0;
      if (functionSortField === "name") {
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (functionSortField === "address") {
        // Sort by address numerically
        const addrA = parseInt(a.address.replace("0x", ""), 16);
        const addrB = parseInt(b.address.replace("0x", ""), 16);
        cmp = addrA - addrB;
      } else {
        // Sort by size
        cmp = (a.size || 0) - (b.size || 0);
      }
      return functionSortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [combinedFunctions, functionFilter, functionSortField, functionSortDir]);

  // Filtered and sorted variables
  const filteredVariables = useMemo(() => {
    let result = [...variables];

    // Apply filter
    if (variableFilter.trim()) {
      const filter = variableFilter.toLowerCase();
      result = result.filter(
        (v) =>
          v.name.toLowerCase().includes(filter) ||
          v.address.toLowerCase().includes(filter)
      );
    }

    // Apply sort
    result.sort((a, b) => {
      let cmp = 0;
      if (variableSortField === "name") {
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (variableSortField === "address") {
        // Sort by address numerically
        const addrA = parseInt(a.address.replace("0x", ""), 16);
        const addrB = parseInt(b.address.replace("0x", ""), 16);
        cmp = addrA - addrB;
      } else {
        // Sort by size
        cmp = (a.size || 0) - (b.size || 0);
      }
      return variableSortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [variables, variableFilter, variableSortField, variableSortDir]);

  // Unique data types for dropdown filter
  const uniqueDataTypes = useMemo(() => {
    const types = new Set<string>();
    ghidraDataItems.forEach((d) => {
      if (d.type) types.add(d.type);
    });
    return Array.from(types).sort();
  }, [ghidraDataItems]);

  // Filtered and sorted data items (limit to 50000 items)
  const filteredDataItems = useMemo(() => {
    let result = [...ghidraDataItems].slice(0, 50000);

    // Apply name filter
    if (dataNameFilter.trim()) {
      const filter = dataNameFilter.toLowerCase();
      result = result.filter(
        (d) => d.name && d.name.toLowerCase().includes(filter)
      );
    }

    // Apply type filter (exact match for dropdown)
    if (dataTypeFilter) {
      result = result.filter((d) => d.type === dataTypeFilter);
    }

    // Apply sort
    result.sort((a, b) => {
      let cmp = 0;
      if (dataSortField === "name") {
        const nameA = (a.name || a.address).toLowerCase();
        const nameB = (b.name || b.address).toLowerCase();
        cmp = nameA.localeCompare(nameB);
      } else if (dataSortField === "address") {
        // Sort by address numerically
        const addrA = parseInt(a.address.replace("0x", ""), 16);
        const addrB = parseInt(b.address.replace("0x", ""), 16);
        cmp = addrA - addrB;
      } else {
        // Sort by type
        cmp = a.type.toLowerCase().localeCompare(b.type.toLowerCase());
      }
      return dataSortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [
    ghidraDataItems,
    dataNameFilter,
    dataTypeFilter,
    dataSortField,
    dataSortDir,
  ]);

  // Column definitions for VirtualizedTable
  const functionColumns = useMemo(
    (): ColumnDef<CombinedFunction>[] => [
      {
        key: "name",
        label: "Name",
        width: 50,
        render: (f: CombinedFunction) => f.name,
        getCellStyle: (f: CombinedFunction) => ({
          color: f.source === "ghidra" ? accentColors.blue : accentColors.green,
        }),
      },
      {
        key: "address",
        label: "Address",
        width: 30,
        render: (f: CombinedFunction) => f.address,
        getCellStyle: () => ({
          fontFamily: 'Consolas, "Courier New", monospace',
          color: "#9cdcfe",
        }),
      },
      {
        key: "size",
        label: "Size",
        width: 20,
        align: "right",
        render: (f: CombinedFunction) =>
          f.size > 0
            ? f.size >= 1024
              ? `${(f.size / 1024).toFixed(1)}KB`
              : `${f.size}B`
            : "-",
        getCellStyle: () => ({ color: "#b5cea8" }),
      },
    ],
    []
  );

  const variableColumns = useMemo(
    (): ColumnDef<SymbolInfo>[] => [
      {
        key: "name",
        label: "Name",
        width: 50,
        render: (v: SymbolInfo) => v.name,
        getCellStyle: () => ({ color: accentColors.orange }),
      },
      {
        key: "address",
        label: "Address",
        width: 30,
        render: (v: SymbolInfo) => v.address,
        getCellStyle: () => ({
          fontFamily: 'Consolas, "Courier New", monospace',
          color: "#9cdcfe",
        }),
      },
      {
        key: "size",
        label: "Size",
        width: 20,
        align: "right",
        render: (v: SymbolInfo) =>
          v.size
            ? v.size >= 1024
              ? `${(v.size / 1024).toFixed(1)}KB`
              : `${v.size}B`
            : "-",
        getCellStyle: () => ({ color: "#b5cea8" }),
      },
    ],
    []
  );

  // Helper function to convert Ghidra offset to absolute address
  const getAbsoluteDataAddress = useCallback(
    (offset: string): string => {
      const moduleBase = selectedModule?.base || 0;
      const offsetValue = parseInt(offset.replace(/0x/i, ""), 16);
      const absoluteAddr = moduleBase + offsetValue;
      return `0x${absoluteAddr.toString(16).toUpperCase()}`;
    },
    [selectedModule?.base]
  );

  const dataColumns = useMemo(
    (): ColumnDef<GhidraDataItem>[] => [
      {
        key: "name",
        label: "Name",
        width: 40,
        render: (d: GhidraDataItem) =>
          d.name ||
          (d.value
            ? `"${d.value.substring(0, 20)}${d.value.length > 20 ? "..." : ""}"`
            : `DAT_${d.address}`),
        getCellStyle: (d: GhidraDataItem) => ({
          color:
            d.category === "string"
              ? accentColors.green
              : d.category === "pointer"
                ? accentColors.purple
                : accentColors.yellow,
          fontStyle: d.name ? "normal" : "italic",
        }),
      },
      {
        key: "address",
        label: "Address",
        width: 30,
        render: (d: GhidraDataItem) => getAbsoluteDataAddress(d.address),
        getCellStyle: () => ({
          fontFamily: 'Consolas, "Courier New", monospace',
          color: "#9cdcfe",
        }),
      },
      {
        key: "type",
        label: "Type",
        width: 30,
        render: (d: GhidraDataItem) => d.type,
        getCellStyle: (d: GhidraDataItem) => ({
          color:
            d.category === "string"
              ? "#ce9178"
              : d.category === "pointer"
                ? "#c586c0"
                : "#4ec9b0",
        }),
      },
    ],
    []
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      console.log(
        "DebuggerSidebar: Mouse down on resize handle, current width:",
        debuggerSidebarWidth
      );

      const startX = e.clientX;
      const startWidth = debuggerSidebarWidth;

      setDragState({ isDragging: true, startX, startWidth });
      setIsResizing(true);

      console.log(
        `DebuggerSidebar: Starting resize - startX: ${startX}, startWidth: ${startWidth}`
      );
    },
    [debuggerSidebarWidth]
  );

  // Global mouse event handlers
  useEffect(() => {
    if (!dragState.isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();

      const deltaX = e.clientX - dragState.startX;
      const newWidth = dragState.startWidth + deltaX;
      const minWidth = 200;
      const maxWidth = 800;

      console.log(
        `DebuggerSidebar: Mouse move - clientX: ${e.clientX}, deltaX: ${deltaX}, newWidth: ${newWidth}`
      );

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setDebuggerSidebarWidth(newWidth);
        console.log(`DebuggerSidebar: Setting sidebar width to ${newWidth}`);
      } else {
        console.log(
          `DebuggerSidebar: Width ${newWidth} outside bounds (${minWidth}-${maxWidth})`
        );
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      console.log("DebuggerSidebar: Mouse up, ending resize");
      setDragState({ isDragging: false, startX: 0, startWidth: 0 });
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove, { passive: false });
    document.addEventListener("mouseup", handleMouseUp, { passive: false });
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragState, setDebuggerSidebarWidth]);

  // Panel height resize handlers
  const handlePanelResizeStart = useCallback(
    (panelName: string, currentHeight: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setResizingPanel(panelName);
      resizeStartRef.current = { y: e.clientY, height: currentHeight };
    },
    []
  );

  useEffect(() => {
    if (!resizingPanel) return;

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      const deltaY = e.clientY - resizeStartRef.current.y;

      // Calculate available height for all panels
      // Fixed elements: Modules (~80px), panel headers (~32px each for expanded), dividers (~6px each)
      const sidebarHeight = sidebarRef.current?.clientHeight || 600;

      // Calculate fixed height based on which panels are expanded
      // Modules section height depends on compact mode
      const modulesHeight = isCompactHeight ? 60 : 80;
      const headerHeight = isCompactHeight ? 28 : 32;
      const dividerHeight = isCompactHeight ? 4 : 6;
      const minPanelHeight = isCompactHeight ? 30 : 50;

      // Count expanded panels and their headers
      const numHeaders = 3; // Functions, Variables, Data always have headers
      const numDividers =
        (functionsExpanded ? 1 : 0) + (variablesExpanded ? 1 : 0);

      const fixedHeight =
        modulesHeight + numHeaders * headerHeight + numDividers * dividerHeight;
      const availableHeight = sidebarHeight - fixedHeight;

      // Only subtract heights of OTHER expanded panels
      let maxHeight: number;
      switch (resizingPanel) {
        case "functions":
          // Max height = available - (other expanded panels' heights)
          maxHeight = Math.max(
            minPanelHeight,
            availableHeight -
              (variablesExpanded ? variablesHeight : 0) -
              (dataExpanded ? dataHeight : 0)
          );
          break;
        case "variables":
          // Max height = available - (other expanded panels' heights)
          maxHeight = Math.max(
            minPanelHeight,
            availableHeight -
              (functionsExpanded ? functionsHeight : 0) -
              (dataExpanded ? dataHeight : 0)
          );
          break;
        case "data":
          // Max height = available - (other expanded panels' heights)
          maxHeight = Math.max(
            minPanelHeight,
            availableHeight -
              (functionsExpanded ? functionsHeight : 0) -
              (variablesExpanded ? variablesHeight : 0)
          );
          break;
        case "sourceFiles":
          maxHeight = Math.max(
            minPanelHeight,
            availableHeight - outlineHeight - sourceVariablesHeight
          );
          break;
        case "outline":
          maxHeight = Math.max(
            minPanelHeight,
            availableHeight - sourceFilesHeight - sourceVariablesHeight
          );
          break;
        case "sourceVariables":
          maxHeight = Math.max(
            minPanelHeight,
            availableHeight - sourceFilesHeight - outlineHeight
          );
          break;
        default:
          maxHeight = 500;
      }

      const newHeight = Math.max(
        minPanelHeight,
        Math.min(maxHeight, resizeStartRef.current.height + deltaY)
      );

      switch (resizingPanel) {
        case "functions":
          setFunctionsHeight(newHeight);
          break;
        case "variables":
          setVariablesHeight(newHeight);
          break;
        case "data":
          setDataHeight(newHeight);
          break;
        case "sourceFiles":
          setSourceFilesHeight(newHeight);
          break;
        case "outline":
          setOutlineHeight(newHeight);
          break;
        case "sourceVariables":
          setSourceVariablesHeight(newHeight);
          break;
      }
    };

    const handleMouseUp = () => {
      setResizingPanel(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [
    resizingPanel,
    setFunctionsHeight,
    setVariablesHeight,
    setDataHeight,
    setSourceFilesHeight,
    setOutlineHeight,
    setSourceVariablesHeight,
    functionsHeight,
    variablesHeight,
    dataHeight,
    sourceFilesHeight,
    outlineHeight,
    sourceVariablesHeight,
    functionsExpanded,
    variablesExpanded,
    dataExpanded,
    isCompactHeight,
  ]);

  const handleFunctionClick = (
    functionName: string,
    functionAddress?: string
  ) => {
    console.log(
      `DebuggerSidebar: Function clicked - name: ${functionName}, address: ${functionAddress}`
    );
    onFunctionClick(functionName, functionAddress);
  };

  return (
    <SidebarContainer ref={sidebarRef}>
      <SidebarContent isResizing={isResizing || !!resizingPanel}>
        {sourceCodeLevelDebug ? (
          // Source Code Level Debug Mode - Show Files & Outline & Variables
          <>
            {/* Source Files Panel */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                padding: "4px 8px",
                backgroundColor: "#252526",
                borderBottom: "1px solid #2d2d30",
                minHeight: "24px",
                fontWeight: 600,
                fontSize: "10px",
                color: "#4ec9b0",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                gap: 0.75,
                flexShrink: 0,
                "@media (max-height: 800px)": {
                  padding: "3px 8px",
                  minHeight: "20px",
                  fontSize: "9px",
                },
              }}
            >
              <FolderOpenIcon
                sx={{
                  fontSize: 12,
                  color: "#4ec9b0",
                  "@media (max-height: 800px)": {
                    fontSize: 10,
                  },
                }}
              />
              <span style={{ flex: 1 }}>Source Files</span>
              {dwarfAnalysisResult?.source_files?.length > 0 && (
                <Box
                  component="span"
                  sx={{
                    backgroundColor: "rgba(78, 201, 176, 0.15)",
                    color: "#4ec9b0",
                    borderRadius: "4px",
                    padding: "0px 4px",
                    fontSize: "9px",
                    fontWeight: 600,
                    ml: 1,
                    "@media (max-height: 800px)": {
                      fontSize: "8px",
                      padding: "0px 3px",
                    },
                  }}
                >
                  {dwarfAnalysisResult.source_files.length}
                </Box>
              )}
            </Box>
            <Box
              sx={{
                height: `${sourceFilesHeight}px`,
                overflow: "auto",
                backgroundColor: "#1e1e1e",
                flexShrink: 0,
              }}
            >
              {dwarfAnalysisResult?.source_files?.length > 0 ? (
                dwarfAnalysisResult.source_files.map(
                  (file: any, idx: number) => {
                    const fileName = file.path.split("/").pop() || file.path;
                    return (
                      <Box
                        key={idx}
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent("openSourceFile", {
                              detail: {
                                path: file.path,
                                directory: file.directory,
                              },
                            })
                          );
                        }}
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          px: 1.5,
                          py: 0.5,
                          cursor: "pointer",
                          "&:hover": {
                            backgroundColor: "rgba(255, 255, 255, 0.05)",
                          },
                        }}
                      >
                        <FileIcon sx={{ fontSize: 14, color: "#4fc1ff" }} />
                        <Typography
                          sx={{
                            color: "#d4d4d4",
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                        >
                          {fileName}
                        </Typography>
                      </Box>
                    );
                  }
                )
              ) : (
                <Box sx={{ p: 2 }}>
                  <Typography
                    sx={{
                      color: "#808080",
                      fontSize: "11px",
                      textAlign: "center",
                    }}
                  >
                    No source files available
                  </Typography>
                </Box>
              )}
            </Box>
            {/* Source Files Resize Handle */}
            <Box
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingPanel("sourceFiles");
                resizeStartRef.current = {
                  y: e.clientY,
                  height: sourceFilesHeight,
                };
              }}
              sx={{
                height: "4px",
                backgroundColor: "#2d2d30",
                cursor: "row-resize",
                "&:hover": {
                  backgroundColor: "#007acc",
                },
                flexShrink: 0,
              }}
            />

            {/* Outline Panel - Show DWARF functions */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                padding: "4px 8px",
                backgroundColor: "#252526",
                borderBottom: "1px solid #2d2d30",
                minHeight: "24px",
                fontWeight: 600,
                fontSize: "10px",
                color: "#dcdcaa",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                gap: 0.75,
                flexShrink: 0,
                "@media (max-height: 800px)": {
                  padding: "3px 8px",
                  minHeight: "20px",
                  fontSize: "9px",
                },
              }}
            >
              <OutlineIcon
                sx={{
                  fontSize: 12,
                  color: "#dcdcaa",
                  "@media (max-height: 800px)": {
                    fontSize: 10,
                  },
                }}
              />
              <span style={{ flex: 1 }}>Outline</span>
              {dwarfAnalysisResult?.functions?.length > 0 && (
                <Box
                  component="span"
                  sx={{
                    backgroundColor: "rgba(220, 220, 170, 0.15)",
                    color: "#dcdcaa",
                    borderRadius: "4px",
                    padding: "0px 4px",
                    fontSize: "9px",
                    fontWeight: 600,
                    ml: 1,
                    "@media (max-height: 800px)": {
                      fontSize: "8px",
                      padding: "0px 3px",
                    },
                  }}
                >
                  {dwarfAnalysisResult.functions.length}
                </Box>
              )}
            </Box>
            <Box
              sx={{
                height: `${outlineHeight}px`,
                overflow: "auto",
                backgroundColor: "#1e1e1e",
                flexShrink: 0,
              }}
            >
              {dwarfAnalysisResult?.functions?.length > 0 ? (
                dwarfAnalysisResult.functions.map((func: any, idx: number) => {
                  const isCurrentFunc =
                    isInBreakState && currentFunction?.name === func.name;

                  return (
                    <Box
                      key={idx}
                      onClick={() => {
                        // If function has decl_file and decl_line, jump to source code line
                        if (func.decl_file && func.decl_line) {
                          // Request jump to source line
                          setPendingSourceJump({
                            filePath: func.decl_file,
                            line: func.decl_line,
                          });
                        } else if (func.low_pc) {
                          // Fallback to disasm if no source info
                          onFunctionClick(
                            func.name,
                            `0x${func.low_pc.toString(16)}`
                          );
                        }
                      }}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        px: 1.5,
                        py: 0.5,
                        cursor: func.low_pc ? "pointer" : "default",
                        opacity: func.low_pc ? 1 : 0.5,
                        backgroundColor: isCurrentFunc
                          ? "rgba(255, 204, 0, 0.15)"
                          : "transparent",
                        borderLeft: isCurrentFunc
                          ? "2px solid #ffcc00"
                          : "2px solid transparent",
                        "&:hover": {
                          backgroundColor: isCurrentFunc
                            ? "rgba(255, 204, 0, 0.2)"
                            : func.low_pc
                              ? "rgba(255, 255, 255, 0.05)"
                              : "transparent",
                        },
                      }}
                    >
                      {/* Current function indicator */}
                      {isCurrentFunc && (
                        <Box
                          sx={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            backgroundColor: "#ffcc00",
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <FunctionsIcon
                        sx={{
                          fontSize: 14,
                          color: isCurrentFunc ? "#ffcc00" : "#dcdcaa",
                        }}
                      />
                      <Typography
                        sx={{
                          color: isCurrentFunc
                            ? "#ffcc00"
                            : activeFunction === func.name
                              ? "#4fc1ff"
                              : "#d4d4d4",
                          fontSize: "11px",
                          fontFamily: "monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                          fontWeight: isCurrentFunc ? 600 : 400,
                        }}
                      >
                        {func.name}
                      </Typography>
                      {/* Show current line if in break state */}
                      {isCurrentFunc && func.decl_line && (
                        <Typography
                          sx={{
                            color: "#808080",
                            fontSize: "9px",
                            fontFamily: "monospace",
                            flexShrink: 0,
                          }}
                        >
                          :{func.decl_line}
                        </Typography>
                      )}
                    </Box>
                  );
                })
              ) : (
                <Box sx={{ p: 2 }}>
                  <Typography
                    sx={{
                      color: "#808080",
                      fontSize: "11px",
                      textAlign: "center",
                    }}
                  >
                    No functions found
                  </Typography>
                </Box>
              )}
            </Box>
            {/* Outline Resize Handle */}
            <Box
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingPanel("outline");
                resizeStartRef.current = {
                  y: e.clientY,
                  height: outlineHeight,
                };
              }}
              sx={{
                height: "4px",
                backgroundColor: "#2d2d30",
                cursor: "row-resize",
                "&:hover": {
                  backgroundColor: "#007acc",
                },
                flexShrink: 0,
              }}
            />

            {/* Call Stack / Current Location Panel - Show when in break state */}
            {isInBreakState && currentFunction && (
              <Box
                sx={{
                  backgroundColor: "rgba(255, 204, 0, 0.1)",
                  borderBottom: "1px solid rgba(255, 204, 0, 0.3)",
                  px: 1.5,
                  py: 1,
                  flexShrink: 0,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 0.5,
                  }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: "#ffcc00",
                      animation: "pulse 1.5s infinite",
                      "@keyframes pulse": {
                        "0%": { opacity: 1 },
                        "50%": { opacity: 0.5 },
                        "100%": { opacity: 1 },
                      },
                    }}
                  />
                  <Typography
                    sx={{
                      color: "#ffcc00",
                      fontSize: "10px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                    }}
                  >
                    Paused
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    color: "#dcdcaa",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={currentFunction.name}
                >
                  {currentFunction.name}()
                </Typography>
                {currentBreakAddress && dwarfModuleBase && (
                  <Typography
                    sx={{
                      color: "#808080",
                      fontSize: "10px",
                      fontFamily: "monospace",
                      mt: 0.25,
                    }}
                  >
                    {(() => {
                      const addr =
                        typeof currentBreakAddress === "string"
                          ? parseInt(
                              currentBreakAddress.replace(/^0x/i, ""),
                              16
                            )
                          : currentBreakAddress;
                      const offset = addr - dwarfModuleBase;
                      const funcOffset =
                        currentFunction.low_pc !== null
                          ? offset - currentFunction.low_pc
                          : 0;
                      return `+0x${funcOffset.toString(16)} (0x${offset.toString(16)})`;
                    })()}
                  </Typography>
                )}
                {currentFunction.decl_file && currentFunction.decl_line && (
                  <Typography
                    sx={{
                      color: "#6a9955",
                      fontSize: "10px",
                      fontFamily: "monospace",
                      mt: 0.25,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={currentFunction.decl_file}
                  >
                    {currentFunction.decl_file.split("/").pop()}:
                    {currentFunction.decl_line}
                  </Typography>
                )}
              </Box>
            )}

            {/* Variables Panel - Show DWARF variables (names only) */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                padding: "4px 8px",
                backgroundColor: "#252526",
                borderBottom: "1px solid #2d2d30",
                minHeight: "24px",
                fontWeight: 600,
                fontSize: "10px",
                color: "#9cdcfe",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                gap: 0.75,
                flexShrink: 0,
                "@media (max-height: 800px)": {
                  padding: "3px 8px",
                  minHeight: "20px",
                  fontSize: "9px",
                },
              }}
            >
              <DataArrayIcon
                sx={{
                  fontSize: 12,
                  color: "#9cdcfe",
                  "@media (max-height: 800px)": {
                    fontSize: 10,
                  },
                }}
              />
              <span style={{ flex: 1 }}>Variables</span>
              {(() => {
                const allVariables = [
                  ...(dwarfAnalysisResult?.variables || []),
                  ...(dwarfAnalysisResult?.functions?.flatMap((f: any) => [
                    ...(f.parameters || []),
                    ...(f.variables || []),
                  ]) || []),
                ];
                return allVariables.length > 0 ? (
                  <Box
                    component="span"
                    sx={{
                      backgroundColor: "rgba(156, 220, 254, 0.15)",
                      color: "#9cdcfe",
                      borderRadius: "4px",
                      padding: "0px 4px",
                      fontSize: "9px",
                      fontWeight: 600,
                      ml: 1,
                      "@media (max-height: 800px)": {
                        fontSize: "8px",
                        padding: "0px 3px",
                      },
                    }}
                  >
                    {allVariables.length}
                  </Box>
                ) : null;
              })()}
            </Box>
            <Box
              sx={{
                height: `${sourceVariablesHeight}px`,
                overflow: "auto",
                backgroundColor: "#1e1e1e",
                flexShrink: 0,
              }}
            >
              {(() => {
                const globalVars = (dwarfAnalysisResult?.variables || []).map(
                  (v: any) => ({
                    ...v,
                    scope: null,
                    isCurrentScope: false,
                    isParameter: false,
                  })
                );
                const functionVars =
                  dwarfAnalysisResult?.functions?.flatMap((f: any) => [
                    ...(f.parameters || []).map((v: any) => ({
                      ...v,
                      scope: f.name,
                      isCurrentScope: currentFunction?.name === f.name,
                      isParameter: true,
                    })),
                    ...(f.variables || []).map((v: any) => ({
                      ...v,
                      scope: f.name,
                      isCurrentScope: currentFunction?.name === f.name,
                      isParameter: false,
                    })),
                  ]) || [];

                // Sort: current scope first, then others
                const allVariables = [...globalVars, ...functionVars].sort(
                  (a, b) => {
                    if (a.isCurrentScope && !b.isCurrentScope) return -1;
                    if (!a.isCurrentScope && b.isCurrentScope) return 1;
                    return 0;
                  }
                );

                return allVariables.length > 0 ? (
                  allVariables.map((variable: any, idx: number) => {
                    const resolvedValue = getResolvedValue(variable);
                    const isInScope =
                      variable.isCurrentScope || !variable.scope;

                    return (
                      <Box
                        key={idx}
                        sx={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 0.5,
                          px: 1.5,
                          py: 0.5,
                          backgroundColor:
                            variable.isCurrentScope && isInBreakState
                              ? "rgba(79, 193, 255, 0.1)"
                              : "transparent",
                          opacity: isInBreakState && !isInScope ? 0.5 : 1,
                          "&:hover": {
                            backgroundColor:
                              variable.isCurrentScope && isInBreakState
                                ? "rgba(79, 193, 255, 0.15)"
                                : "rgba(255, 255, 255, 0.05)",
                          },
                        }}
                      >
                        {/* Scope badge: P=Parameter, L=Local, G=Global */}
                        <Box
                          sx={{
                            width: 14,
                            height: 14,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "9px",
                            fontWeight: 600,
                            color: variable.isParameter
                              ? "#dcdcaa"
                              : variable.scope
                                ? "#4ec9b0"
                                : "#9cdcfe",
                            backgroundColor: variable.isParameter
                              ? "rgba(220, 220, 170, 0.15)"
                              : variable.scope
                                ? "rgba(78, 201, 176, 0.15)"
                                : "rgba(156, 220, 254, 0.15)",
                            borderRadius: "2px",
                            flexShrink: 0,
                            mt: "2px",
                          }}
                        >
                          {variable.isParameter
                            ? "P"
                            : variable.scope
                              ? "L"
                              : "G"}
                        </Box>
                        {/* Variable info container */}
                        <Box
                          sx={{
                            display: "flex",
                            flexDirection: "column",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {/* Name and value row */}
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Typography
                              sx={{
                                color:
                                  variable.isCurrentScope && isInBreakState
                                    ? "#4fc1ff"
                                    : "#9cdcfe",
                                fontSize: "11px",
                                fontFamily: "monospace",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={`${variable.name}${variable.type_name ? `: ${variable.type_name}` : ""}${variable.location ? ` (${variable.location})` : ""}`}
                            >
                              {variable.name}
                            </Typography>
                            {/* Show value when in break state and can resolve */}
                            {isInBreakState && resolvedValue && (
                              <Typography
                                sx={{
                                  color: "#ce9178",
                                  fontSize: "10px",
                                  fontFamily: "monospace",
                                  flexShrink: 0,
                                  maxWidth: "100px",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={resolvedValue}
                              >
                                = {resolvedValue}
                              </Typography>
                            )}
                          </Box>
                          {/* Type row - always show if available */}
                          {variable.type_name && (
                            <Typography
                              sx={{
                                color: "#4ec9b0",
                                fontSize: "9px",
                                fontFamily: "monospace",
                                opacity: 0.8,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={variable.type_name}
                            >
                              {variable.type_name.length > 25
                                ? variable.type_name.substring(0, 23) + "…"
                                : variable.type_name}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    );
                  })
                ) : (
                  <Box sx={{ p: 2 }}>
                    <Typography
                      sx={{
                        color: "#808080",
                        fontSize: "11px",
                        textAlign: "center",
                      }}
                    >
                      No variables found
                    </Typography>
                  </Box>
                );
              })()}
            </Box>
            {/* Variables Resize Handle */}
            <Box
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingPanel("sourceVariables");
                resizeStartRef.current = {
                  y: e.clientY,
                  height: sourceVariablesHeight,
                };
              }}
              sx={{
                height: "4px",
                backgroundColor: "#2d2d30",
                cursor: "row-resize",
                "&:hover": {
                  backgroundColor: "#007acc",
                },
                flexShrink: 0,
              }}
            />
            {/* Spacer */}
            <Box sx={{ flex: 1 }} />
          </>
        ) : (
          // Assembly Mode - Show Modules/Functions/Variables/Data
          <>
            {/* Module Selector (SidebarPanel風ヘッダー) */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                padding: "4px 8px",
                backgroundColor: "#252526",
                borderBottom: "1px solid #2d2d30",
                minHeight: "24px",
                fontWeight: 600,
                fontSize: "10px",
                color: "#4fc1ff",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                gap: 0.75,
                flexShrink: 0,
                "@media (max-height: 800px)": {
                  padding: "3px 8px",
                  minHeight: "20px",
                  fontSize: "9px",
                },
              }}
            >
              <LibraryBooksIcon
                sx={{
                  fontSize: 12,
                  color: "#4fc1ff",
                  "@media (max-height: 800px)": {
                    fontSize: 10,
                  },
                }}
              />
              <span style={{ flex: 1 }}>Modules</span>
              {modules.length > 0 && (
                <Box
                  component="span"
                  sx={{
                    backgroundColor: "rgba(79, 193, 255, 0.15)",
                    color: "#4fc1ff",
                    borderRadius: "4px",
                    padding: "0px 4px",
                    fontSize: "9px",
                    fontWeight: 600,
                    ml: 1,
                    "@media (max-height: 800px)": {
                      fontSize: "8px",
                      padding: "0px 3px",
                    },
                  }}
                >
                  {modules.length}
                </Box>
              )}
            </Box>
            <Box
              sx={{
                p: 1,
                flexShrink: 0,
                "@media (max-height: 800px)": {
                  p: 0.5,
                },
              }}
            >
              {!attachedProcess ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: "11px",
                    "@media (max-height: 800px)": {
                      fontSize: "10px",
                    },
                  }}
                >
                  Attach to a process to view modules
                </Typography>
              ) : loading ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: "11px",
                    "@media (max-height: 800px)": {
                      fontSize: "10px",
                    },
                  }}
                >
                  Loading modules...
                </Typography>
              ) : (
                <Autocomplete
                  size="small"
                  options={filteredModules}
                  value={selectedModule}
                  onChange={(_event, newValue) => {
                    setSelectedModule(newValue);
                  }}
                  getOptionLabel={(option) =>
                    getDisplayModuleName(option.modulename)
                  }
                  isOptionEqualToValue={(option, value) =>
                    option.base === value.base
                  }
                  filterOptions={(options, { inputValue }) => {
                    if (!inputValue) return options;
                    const filter = inputValue.toLowerCase();
                    return options.filter(
                      (m) =>
                        m.modulename?.toLowerCase().includes(filter) ||
                        m.path?.toLowerCase().includes(filter)
                    );
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      placeholder="Select module..."
                      sx={{
                        "& .MuiOutlinedInput-root": {
                          fontSize: "11px",
                          backgroundColor: "#252526",
                          "& fieldset": { borderColor: "#3c3c3c" },
                          "&:hover fieldset": { borderColor: "#4fc1ff" },
                          "&.Mui-focused fieldset": { borderColor: "#4fc1ff" },
                          "@media (max-height: 800px)": {
                            fontSize: "10px",
                            minHeight: "28px",
                          },
                        },
                        "& .MuiInputBase-input": { color: "#d4d4d4" },
                      }}
                    />
                  )}
                  renderOption={(props, option) => {
                    const fileName = getDisplayModuleName(option.modulename);
                    const sizeStr =
                      option.size >= 1024 * 1024
                        ? `${(option.size / (1024 * 1024)).toFixed(1)}MB`
                        : `${(option.size / 1024).toFixed(1)}KB`;

                    return (
                      <li
                        {...props}
                        key={option.base}
                        style={{
                          ...props.style,
                          fontSize: isCompactHeight ? "10px" : "11px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: isCompactHeight ? "2px 6px" : "4px 8px",
                        }}
                      >
                        <span style={{ color: accentColors.purple, flex: 1 }}>
                          {fileName}
                        </span>
                        <span
                          style={{
                            color: "#858585",
                            fontSize: isCompactHeight ? "9px" : "10px",
                            marginLeft: isCompactHeight ? 4 : 8,
                          }}
                        >
                          {sizeStr}
                        </span>
                      </li>
                    );
                  }}
                  sx={{
                    "& .MuiAutocomplete-popupIndicator": { color: "#858585" },
                    "& .MuiAutocomplete-clearIndicator": { color: "#858585" },
                  }}
                  slotProps={{
                    listbox: {
                      sx: {
                        "@media (max-height: 800px)": {
                          "& .MuiAutocomplete-option": {
                            minHeight: "24px",
                            fontSize: "10px",
                            padding: "2px 6px",
                          },
                        },
                      },
                    },
                  }}
                />
              )}
            </Box>

            {/* Functions Panel */}
            <SidebarPanel
              title="Functions"
              icon={FunctionsIcon}
              badge={filteredFunctions.length.toString()}
              actions={[
                {
                  icon: <FilterListIcon fontSize="small" />,
                  tooltip: showFunctionFilter
                    ? "Hide filter"
                    : "Filter functions",
                  onClick: () => setShowFunctionFilter(!showFunctionFilter),
                },
              ]}
              expanded={functionsExpanded}
              onExpandedChange={setFunctionsExpanded}
              height={functionsExpanded ? functionsHeight : undefined}
            >
              {showFunctionFilter && (
                <Box
                  sx={{
                    px: isCompactHeight ? 0.5 : 1,
                    pb: isCompactHeight ? 0.5 : 1,
                  }}
                >
                  <TextField
                    size="small"
                    placeholder="Filter functions..."
                    value={functionFilter}
                    onChange={(e) => setFunctionFilter(e.target.value)}
                    fullWidth
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon
                            sx={{
                              fontSize: isCompactHeight ? 12 : 14,
                              color: "#858585",
                            }}
                          />
                        </InputAdornment>
                      ),
                      sx: {
                        fontSize: isCompactHeight ? "10px" : "11px",
                        height: isCompactHeight ? 20 : 24,
                        "& input": { padding: "2px 0" },
                      },
                    }}
                  />
                </Box>
              )}
              {!selectedModule ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  Select a module to view functions
                </Typography>
              ) : loadingSymbols ? (
                <Box
                  sx={{
                    p: isCompactHeight ? 1 : 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
                  >
                    Loading symbols for{" "}
                    {getDisplayModuleName(selectedModule.modulename)}...
                  </Typography>
                </Box>
              ) : filteredFunctions.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  {combinedFunctions.length === 0
                    ? "No functions found"
                    : "No matching functions"}
                </Typography>
              ) : (
                <VirtualizedTable<CombinedFunction>
                  data={filteredFunctions}
                  columns={functionColumns}
                  sortField={functionSortField}
                  sortDirection={functionSortDir}
                  maxHeight={functionsHeight - (isCompactHeight ? 8 : 12)}
                  rowHeight={compactRowHeight}
                  onSort={(field: string) =>
                    handleFunctionSort(field as FunctionSortField)
                  }
                  onRowClick={(func: CombinedFunction) =>
                    handleFunctionClick(func.name, func.address)
                  }
                  isRowActive={(f: CombinedFunction) =>
                    activeFunction === f.name
                  }
                  getRowColor={(f: CombinedFunction) =>
                    f.source === "ghidra"
                      ? accentColors.blue
                      : accentColors.green
                  }
                  getRowKey={(f: CombinedFunction) => f.address}
                />
              )}
            </SidebarPanel>
            {/* Functions-Variables Resize Divider */}
            {functionsExpanded && (
              <PanelDivider
                isResizing={resizingPanel === "functions"}
                onMouseDown={handlePanelResizeStart(
                  "functions",
                  functionsHeight
                )}
              >
                <DragHandleIcon className="drag-icon" />
              </PanelDivider>
            )}

            {/* Variables Panel */}
            <SidebarPanel
              title="Variables"
              icon={DataObjectIcon}
              badge={filteredVariables.length.toString()}
              actions={[
                {
                  icon: <FilterListIcon fontSize="small" />,
                  tooltip: showVariableFilter
                    ? "Hide filter"
                    : "Filter variables",
                  onClick: () => setShowVariableFilter(!showVariableFilter),
                },
              ]}
              expanded={variablesExpanded}
              onExpandedChange={setVariablesExpanded}
              height={variablesExpanded ? variablesHeight : undefined}
            >
              {showVariableFilter && (
                <Box
                  sx={{
                    px: isCompactHeight ? 0.5 : 1,
                    pb: isCompactHeight ? 0.5 : 1,
                  }}
                >
                  <TextField
                    size="small"
                    placeholder="Filter variables..."
                    value={variableFilter}
                    onChange={(e) => setVariableFilter(e.target.value)}
                    fullWidth
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon
                            sx={{
                              fontSize: isCompactHeight ? 12 : 14,
                              color: "#858585",
                            }}
                          />
                        </InputAdornment>
                      ),
                      sx: {
                        fontSize: isCompactHeight ? "10px" : "11px",
                        height: isCompactHeight ? 20 : 24,
                        "& input": { padding: "2px 0" },
                      },
                    }}
                  />
                </Box>
              )}
              {!selectedModule ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  Select a module to view variables
                </Typography>
              ) : loadingSymbols ? (
                <Box
                  sx={{
                    p: isCompactHeight ? 1 : 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
                  >
                    Loading symbols for{" "}
                    {getDisplayModuleName(selectedModule.modulename)}...
                  </Typography>
                </Box>
              ) : filteredVariables.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  {variables.length === 0
                    ? "No variables found"
                    : "No matching variables"}
                </Typography>
              ) : (
                <VirtualizedTable<SymbolInfo>
                  data={filteredVariables}
                  columns={variableColumns}
                  sortField={variableSortField}
                  sortDirection={variableSortDir}
                  maxHeight={variablesHeight - (isCompactHeight ? 8 : 12)}
                  rowHeight={compactRowHeight}
                  onSort={(field: string) =>
                    handleVariableSort(field as VariableSortField)
                  }
                  onRowClick={(v: SymbolInfo) => {
                    // Navigate to variable address in memory view
                    if (v.address) {
                      setMemoryAddress(v.address);
                    }
                  }}
                  getRowColor={() => accentColors.orange}
                  getRowKey={(v: SymbolInfo) => v.address}
                />
              )}
            </SidebarPanel>
            {/* Variables-Data Resize Divider */}
            {variablesExpanded && (
              <PanelDivider
                isResizing={resizingPanel === "variables"}
                onMouseDown={handlePanelResizeStart(
                  "variables",
                  variablesHeight
                )}
              >
                <DragHandleIcon className="drag-icon" />
              </PanelDivider>
            )}

            {/* Data Panel */}
            <SidebarPanel
              title="Data"
              icon={StorageIcon}
              badge={filteredDataItems.length.toString()}
              actions={[
                {
                  icon: <FilterListIcon fontSize="small" />,
                  tooltip: showDataFilter ? "Hide filter" : "Filter data",
                  onClick: () => setShowDataFilter(!showDataFilter),
                },
              ]}
              expanded={dataExpanded}
              onExpandedChange={setDataExpanded}
              height={dataExpanded ? dataHeight : undefined}
            >
              {showDataFilter && (
                <Box
                  sx={{
                    px: isCompactHeight ? 0.5 : 1,
                    pb: isCompactHeight ? 0.5 : 1,
                    display: "flex",
                    gap: isCompactHeight ? 0.5 : 1,
                  }}
                >
                  <TextField
                    size="small"
                    placeholder="Name..."
                    value={dataNameFilter}
                    onChange={(e) => setDataNameFilter(e.target.value)}
                    sx={{ flex: 1 }}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon
                            sx={{
                              fontSize: isCompactHeight ? 12 : 14,
                              color: "#858585",
                            }}
                          />
                        </InputAdornment>
                      ),
                      sx: {
                        fontSize: isCompactHeight ? "10px" : "11px",
                        height: isCompactHeight ? 20 : 24,
                        "& input": { padding: "2px 0" },
                      },
                    }}
                  />
                  <Autocomplete
                    size="small"
                    options={uniqueDataTypes}
                    value={dataTypeFilter || null}
                    onChange={(_event, newValue) => {
                      setDataTypeFilter(newValue || "");
                    }}
                    sx={{ flex: 1 }}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        placeholder="Type..."
                        sx={{
                          "& .MuiOutlinedInput-root": {
                            fontSize: isCompactHeight ? "10px" : "11px",
                            height: isCompactHeight ? 20 : 24,
                            padding: "0 8px !important",
                            "& fieldset": { borderColor: "#3c3c3c" },
                            "&:hover fieldset": { borderColor: "#4fc1ff" },
                            "&.Mui-focused fieldset": {
                              borderColor: "#4fc1ff",
                            },
                          },
                          "& .MuiInputBase-input": {
                            color: "#d4d4d4",
                            padding: "2px 0 !important",
                          },
                        }}
                      />
                    )}
                    componentsProps={{
                      popupIndicator: { sx: { padding: 0 } },
                      clearIndicator: { sx: { padding: 0 } },
                    }}
                  />
                </Box>
              )}
              {!selectedModule ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  Select a module to view data definitions
                </Typography>
              ) : !isLibraryAnalyzed(
                  selectedModule.path || selectedModule.modulename
                ) ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  Analyze module with Ghidra to view data
                </Typography>
              ) : !serverRunning ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  Start Ghidra server to view data definitions
                </Typography>
              ) : loadingData ? (
                <Box
                  sx={{
                    p: isCompactHeight ? 1 : 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
                  >
                    Loading data items...
                  </Typography>
                </Box>
              ) : filteredDataItems.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    p: isCompactHeight ? 1 : 2,
                  }}
                >
                  {ghidraDataItems.length === 0
                    ? "No data items found"
                    : "No matching data items"}
                </Typography>
              ) : (
                <VirtualizedTable<GhidraDataItem>
                  data={filteredDataItems}
                  columns={dataColumns}
                  sortField={dataSortField}
                  sortDirection={dataSortDir}
                  maxHeight={dataHeight - (isCompactHeight ? 8 : 12)}
                  rowHeight={compactRowHeight}
                  onSort={(field: string) =>
                    handleDataSort(field as DataSortField)
                  }
                  onRowClick={(d: GhidraDataItem) => {
                    // Navigate to data address in memory view
                    const absoluteAddr = getAbsoluteDataAddress(d.address);
                    setMemoryAddress(absoluteAddr);
                  }}
                  getRowColor={(d: GhidraDataItem) => {
                    if (d.category === "string") return accentColors.green;
                    if (d.category === "pointer") return accentColors.purple;
                    if (d.category === "struct") return accentColors.yellow;
                    return accentColors.blue;
                  }}
                  getRowKey={(d: GhidraDataItem, i: number) =>
                    `${d.address}-${i}`
                  }
                />
              )}
            </SidebarPanel>
          </>
        )}
      </SidebarContent>

      <ResizeHandle isResizing={isResizing} onMouseDown={handleMouseDown} />
    </SidebarContainer>
  );
};
