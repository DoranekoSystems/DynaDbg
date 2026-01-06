import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import {
  Box,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  TextField,
  InputAdornment,
  TableSortLabel,
  IconButton,
  Tooltip,
  Chip,
  CircularProgress,
  Autocomplete,
  ToggleButton,
  Select,
  MenuItem,
  FormControl,
  Menu,
  ListItemIcon,
} from "@mui/material";
import { ContentCopy } from "@mui/icons-material";
import {
  ViewModule,
  Search,
  Refresh as RefreshIcon,
  AccountTree,
  Memory,
  Functions,
  Code,
} from "@mui/icons-material";
import { List } from "react-window";
import { invoke } from "@tauri-apps/api/core";
import { ModuleInfo, SymbolInfo, getApiClient, ServerInfo } from "../lib/api";
import { encodeAddressToLibraryExpression } from "../utils/addressEncoder";
import { useUIStore, RegionInfo } from "../stores/uiStore";
import { ColumnResizer } from "./ColumnResizer";
import { useGhidraAnalysis } from "../hooks/useGhidraAnalysis";

interface InformationContentProps {
  attachedModules?: ModuleInfo[];
  currentTab?: number;
  onTabChange?: (tab: number) => void;
  onRefreshModules?: () => void;
  nameFilter?: string;
  onNameFilterChange?: (filter: string) => void;
  sortField?: "baseAddress" | "size" | null;
  sortDirection?: "asc" | "desc";
  onSortChange?: (
    field: "baseAddress" | "size" | null,
    direction: "asc" | "desc"
  ) => void;
  serverInfo?: ServerInfo;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`info-tabpanel-${index}`}
      aria-labelledby={`info-tab-${index}`}
      {...other}
    >
      {value === index && (
        <Paper
          sx={{
            p: 2,
            backgroundColor: "background.paper",
            borderRadius: "0 4px 4px 4px",
            border: "1px solid",
            borderColor: "divider",
            borderTop: "none",
          }}
        >
          {children}
        </Paper>
      )}
    </div>
  );
}

// Row data interface for virtualized regions list
interface RegionRowData {
  regions: RegionInfo[];
  formatFileSize: (bytes: number) => string;
  onContextMenu: (event: React.MouseEvent, region: RegionInfo) => void;
  columnWidths: {
    start: number;
    end: number;
    size: number;
    protection: number;
    path: number;
  };
}

// Row data interface for virtualized symbols list
interface SymbolRowData {
  symbols: SymbolInfo[];
  formatFileSize: (bytes: number) => string;
  demangleEnabled: boolean;
  demangledNames: Map<string, string>;
  columnWidths: {
    name: number;
    address: number;
    size: number;
    type: number;
    scope: number;
    flags: number;
  };
  isMachoTarget: boolean; // true for iOS/macOS
  moduleName: string; // Module name for Copy Address (Module + offset)
  moduleBase: number | null; // Module base address for offset calculation
}

// Virtualized row component for symbols
const SYMBOL_ROW_HEIGHT = 32;

function SymbolRow({
  index,
  style,
  ...rowProps
}: {
  index: number;
  style: React.CSSProperties;
  data: SymbolRowData;
}) {
  const data = rowProps.data as SymbolRowData;
  const {
    symbols,
    formatFileSize,
    demangleEnabled,
    demangledNames,
    columnWidths,
    moduleName,
    moduleBase,
  } = data;
  const symbol = symbols[index];

  // Context menu state
  const [contextMenu, setContextMenu] = React.useState<{
    mouseX: number;
    mouseY: number;
  } | null>(null);

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu(
      contextMenu === null
        ? { mouseX: event.clientX + 2, mouseY: event.clientY - 6 }
        : null
    );
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleCopyAddress = () => {
    const address = symbol.address.startsWith("0x")
      ? symbol.address
      : `0x${symbol.address}`;
    navigator.clipboard.writeText(address);
    handleCloseContextMenu();
  };

  const handleCopyAddressWithOffset = () => {
    // Calculate offset from module base (use selected module base, fallback to symbol.module_base)
    const addressNum = parseInt(symbol.address.replace(/^0x/i, ""), 16);
    const moduleBaseNum =
      moduleBase !== null
        ? moduleBase
        : symbol.module_base
          ? parseInt(symbol.module_base.replace(/^0x/i, ""), 16)
          : 0;
    const offset = addressNum - moduleBaseNum;
    const result = `${moduleName}+0x${offset.toString(16)}`;
    navigator.clipboard.writeText(result);
    handleCloseContextMenu();
  };

  const handleCopyName = () => {
    const nameToCopy = demangleEnabled
      ? demangledNames.get(symbol.name) || symbol.name
      : symbol.name;
    navigator.clipboard.writeText(nameToCopy);
    handleCloseContextMenu();
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "Function":
        return { bg: "rgba(76, 175, 80, 0.15)", color: "#4caf50" };
      case "Object":
        return { bg: "rgba(33, 150, 243, 0.15)", color: "#2196f3" };
      default:
        return { bg: "rgba(156, 39, 176, 0.15)", color: "#9c27b0" };
    }
  };

  const typeColors = getTypeColor(symbol.type);
  const displayName = demangleEnabled
    ? demangledNames.get(symbol.name) || symbol.name
    : symbol.name;

  return (
    <Box
      style={style}
      onContextMenu={handleContextMenu}
      sx={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid",
        borderColor: "divider",
        cursor: "default",
        "&:hover": {
          backgroundColor: "action.hover",
        },
      }}
    >
      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
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
            minWidth: "150px",
          },
        }}
      >
        <MenuItem onClick={handleCopyName} sx={{ fontSize: "12px", py: 0.5 }}>
          <ListItemIcon sx={{ minWidth: "28px" }}>
            <ContentCopy sx={{ fontSize: 14 }} />
          </ListItemIcon>
          Copy Name
        </MenuItem>
        <MenuItem
          onClick={handleCopyAddress}
          sx={{ fontSize: "12px", py: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: "28px" }}>
            <ContentCopy sx={{ fontSize: 14 }} />
          </ListItemIcon>
          Copy Address
        </MenuItem>
        <MenuItem
          onClick={handleCopyAddressWithOffset}
          sx={{ fontSize: "12px", py: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: "28px" }}>
            <ContentCopy sx={{ fontSize: 14 }} />
          </ListItemIcon>
          Copy Address (Module + offset)
        </MenuItem>
      </Menu>
      {/* Name */}
      <Box
        sx={{
          width: `${columnWidths.name}px`,
          minWidth: `${columnWidths.name}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontFamily: "monospace",
            fontSize: "11px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
            color:
              demangleEnabled && displayName !== symbol.name
                ? "#dcdcaa"
                : "inherit",
          }}
          title={
            demangleEnabled
              ? `${displayName}\n(mangled: ${symbol.name})`
              : symbol.name
          }
        >
          {displayName}
        </Typography>
      </Box>
      {/* Address */}
      <Box
        sx={{
          width: `${columnWidths.address}px`,
          minWidth: `${columnWidths.address}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#4fc1ff",
          }}
        >
          {symbol.address.startsWith("0x")
            ? `0x${symbol.address.slice(2).toUpperCase()}`
            : `0x${symbol.address.toUpperCase()}`}
        </Typography>
      </Box>
      {/* Size */}
      <Box
        sx={{
          width: `${columnWidths.size}px`,
          minWidth: `${columnWidths.size}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontFamily: "monospace",
            fontSize: "11px",
          }}
        >
          {symbol.size > 0 ? formatFileSize(symbol.size) : "-"}
        </Typography>
      </Box>
      {/* Type */}
      <Box
        sx={{
          width: `${columnWidths.type}px`,
          minWidth: `${columnWidths.type}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Chip
          label={symbol.type}
          size="small"
          sx={{
            height: "18px",
            fontSize: "9px",
            backgroundColor: typeColors.bg,
            color: typeColors.color,
          }}
        />
      </Box>
      {/* Scope */}
      <Box
        sx={{
          width: `${columnWidths.scope}px`,
          minWidth: `${columnWidths.scope}px`,
          px: 1,
          py: "4px",
          display: "flex",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        {symbol.scope === "Ghidra" ? (
          <Chip
            label="Ghidra"
            size="small"
            sx={{
              height: "18px",
              fontSize: "9px",
              backgroundColor: "rgba(129, 199, 132, 0.15)",
              color: "#81c784",
              fontWeight: 500,
            }}
          />
        ) : (
          <Typography
            sx={{
              fontSize: "11px",
              color: symbol.scope === "Global" ? "#ce9178" : "text.secondary",
            }}
          >
            {symbol.scope || "-"}
          </Typography>
        )}
      </Box>
      {/* Flags (iOS/macOS only) */}
      {data.isMachoTarget && (
        <Box
          sx={{
            width: `${columnWidths.flags}px`,
            minWidth: `${columnWidths.flags}px`,
            px: 1,
            py: "4px",
            display: "flex",
            gap: 0.5,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {symbol.is_external && (
            <Chip
              label="EXT"
              size="small"
              sx={{
                height: "16px",
                fontSize: "8px",
                backgroundColor: "rgba(76, 175, 80, 0.2)",
                color: "#4caf50",
              }}
            />
          )}
          {symbol.is_weak_def && (
            <Chip
              label="WEAK"
              size="small"
              sx={{
                height: "16px",
                fontSize: "8px",
                backgroundColor: "rgba(255, 152, 0, 0.2)",
                color: "#ff9800",
              }}
            />
          )}
          {symbol.is_thumb && (
            <Chip
              label="THUMB"
              size="small"
              sx={{
                height: "16px",
                fontSize: "8px",
                backgroundColor: "rgba(33, 150, 243, 0.2)",
                color: "#2196f3",
              }}
            />
          )}
          {symbol.source === "export_trie" && (
            <Chip
              label="EXPORT"
              size="small"
              sx={{
                height: "16px",
                fontSize: "8px",
                backgroundColor: "rgba(156, 39, 176, 0.2)",
                color: "#9c27b0",
              }}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

// Virtualized row component for regions
const REGION_ROW_HEIGHT = 32;

function RegionRow({
  index,
  style,
  ...rowProps
}: {
  index: number;
  style: React.CSSProperties;
  data: RegionRowData;
}) {
  const data = rowProps.data as RegionRowData;
  const { regions, formatFileSize, onContextMenu, columnWidths } = data;
  const region = regions[index];

  // Calculate size from hex addresses
  let size = 0n;
  try {
    const startAddr = BigInt("0x" + region.start_address);
    const endAddr = BigInt("0x" + region.end_address);
    size = endAddr - startAddr;
  } catch {
    // If parsing fails, show 0
  }

  return (
    <Box
      style={style}
      onContextMenu={(e) => onContextMenu(e, region)}
      sx={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid",
        borderColor: "divider",
        cursor: "default",
        "&:hover": {
          backgroundColor: "action.hover",
        },
      }}
    >
      {/* Start Address */}
      <Box
        sx={{
          width: `${columnWidths.start}px`,
          minWidth: `${columnWidths.start}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#4fc1ff",
          }}
        >
          0x{region.start_address}
        </Typography>
      </Box>
      {/* End Address */}
      <Box
        sx={{
          width: `${columnWidths.end}px`,
          minWidth: `${columnWidths.end}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#4fc1ff",
          }}
        >
          0x{region.end_address}
        </Typography>
      </Box>
      {/* Size */}
      <Box
        sx={{
          width: `${columnWidths.size}px`,
          minWidth: `${columnWidths.size}px`,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontFamily: "monospace",
            fontSize: "11px",
          }}
        >
          {formatFileSize(Number(size))}
        </Typography>
      </Box>
      {/* Protection */}
      <Box
        sx={{
          width: `${columnWidths.protection}px`,
          minWidth: `${columnWidths.protection}px`,
          px: 1,
          py: "4px",
          textAlign: "center",
        }}
      >
        <Chip
          label={region.protection}
          size="small"
          sx={{
            height: "18px",
            fontSize: "10px",
            fontFamily: "monospace",
            backgroundColor: "rgba(76, 175, 80, 0.15)",
            color: "#4caf50",
          }}
        />
      </Box>
      {/* File Path */}
      <Box
        sx={{
          width: `${columnWidths.path}px`,
          minWidth: `${columnWidths.path}px`,
          flex: 1,
          px: 1,
          py: "4px",
        }}
      >
        <Typography
          sx={{
            fontSize: "11px",
            color: "text.secondary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={region.file_path || ""}
        >
          {region.file_path || "-"}
        </Typography>
      </Box>
    </Box>
  );
}

export const InformationContent: React.FC<InformationContentProps> = ({
  attachedModules = [],
  currentTab = 0,
  onTabChange,
  onRefreshModules,
  nameFilter = "",
  onNameFilterChange,
  sortField: propSortField = null,
  sortDirection: propSortDirection = "asc",
  onSortChange,
  serverInfo,
}) => {
  // Check if platform is iOS/macOS (Mach-O based)
  const isIOS = serverInfo?.target_os?.toLowerCase() === "ios";
  const isMacOS = serverInfo?.target_os?.toLowerCase() === "macos";
  const isMachoTarget = isIOS || isMacOS;

  // Ghidra analysis hook for function resolution
  const { getCachedFunctions, loadFunctionsFromDb } = useGhidraAnalysis();

  // State for Ghidra functions loaded from SQLite
  const [ghidraFunctions, setGhidraFunctions] = useState<
    Array<{ name: string; address: string; size: number }>
  >([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_isLoadingGhidraFunctions, setIsLoadingGhidraFunctions] =
    useState(false);

  const [internalTab, setInternalTab] = useState(currentTab);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Thread and Region state from UI Store
  const {
    threads,
    threadFilter,
    regions,
    regionFilter,
    regionProtectionFilter,
    networkConnections,
    networkFilter,
  } = useUIStore((state) => state.informationState);
  const uiActions = useUIStore((state) => state.actions);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);
  const [isLoadingRegions, setIsLoadingRegions] = useState(false);
  const [isLoadingNetwork, setIsLoadingNetwork] = useState(false);

  // Context menu state for Modules
  const [moduleContextMenu, setModuleContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    module: ModuleInfo | null;
  } | null>(null);

  // Context menu state for Regions
  const [regionContextMenu, setRegionContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    region: RegionInfo | null;
  } | null>(null);

  // Context menu state for Threads
  const [threadContextMenu, setThreadContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    thread: { thread_id: number; name: string } | null;
  } | null>(null);

  // Symbols state from UI Store (persisted)
  const {
    selectedModuleBase,
    symbols: storedSymbols,
    symbolFilter,
    symbolDemangleEnabled,
    symbolSortField,
    symbolSortDirection,
    symbolTypeFilter,
    symbolScopeFilter,
    symbolColumnWidths,
    moduleColumnWidths,
    regionColumnWidths,
    threadColumnWidths,
  } = useUIStore((state) => state.informationState);

  // Column resize state
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const [resizingTable, setResizingTable] = useState<
    "symbol" | "module" | "region" | "thread" | null
  >(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Sort state for Modules table
  const [moduleSortField, setModuleSortField] = useState<
    "name" | "size" | "arch" | "path" | null
  >(null);
  const [moduleSortDirection, setModuleSortDirection] = useState<
    "asc" | "desc"
  >("asc");

  // Sort state for Regions table
  const [regionSortField, setRegionSortField] = useState<
    "start" | "end" | "size" | "path" | null
  >(null);
  const [regionSortDirection, setRegionSortDirection] = useState<
    "asc" | "desc"
  >("asc");

  // Sort state for Threads table
  const [threadSortField, setThreadSortField] = useState<"id" | "name" | null>(
    null
  );
  const [threadSortDirection, setThreadSortDirection] = useState<
    "asc" | "desc"
  >("asc");

  // Local symbols state
  const [symbols, setSymbols] = useState<SymbolInfo[]>(
    storedSymbols as SymbolInfo[]
  );
  const [isLoadingSymbols, setIsLoadingSymbols] = useState(false);

  // Demangled names cache
  const [demangledNames, setDemangledNames] = useState<Map<string, string>>(
    new Map()
  );
  const [isDemanglingInProgress, setIsDemanglingInProgress] = useState(false);

  // Find selected module from attachedModules using stored base
  const selectedModuleForSymbols = useMemo(() => {
    if (selectedModuleBase === null) return null;
    return attachedModules.find((m) => m.base === selectedModuleBase) || null;
  }, [attachedModules, selectedModuleBase]);

  // Load Ghidra functions from SQLite when module is selected
  useEffect(() => {
    console.log(
      `[InformationContent] useEffect triggered - selectedModuleForSymbols:`,
      selectedModuleForSymbols,
      `selectedModuleBase:`,
      selectedModuleBase
    );

    const loadGhidraFunctions = async () => {
      if (!selectedModuleForSymbols) {
        console.log(
          `[InformationContent] No module selected, clearing ghidraFunctions`
        );
        setGhidraFunctions([]);
        return;
      }

      // Use path, name, or modulename (the API returns modulename)
      const modulePath =
        selectedModuleForSymbols.path ||
        selectedModuleForSymbols.name ||
        selectedModuleForSymbols.modulename ||
        "";
      console.log(`[InformationContent] modulePath: ${modulePath}`);
      if (!modulePath) {
        setGhidraFunctions([]);
        return;
      }

      // First check in-memory cache
      const cachedFunctions = getCachedFunctions(modulePath);
      if (cachedFunctions && cachedFunctions.length > 0) {
        setGhidraFunctions(cachedFunctions);
        return;
      }

      // Then try loading from SQLite
      setIsLoadingGhidraFunctions(true);
      try {
        const pathParts = modulePath.split(/[/\\]/);
        const libraryName = pathParts[pathParts.length - 1];

        // Try multiple targetOs variations to handle case sensitivity
        const targetOs = serverInfo?.target_os || "unknown";
        const targetOsLower = targetOs.toLowerCase();

        console.log(
          `[InformationContent] Loading Ghidra functions - modulePath: ${modulePath}, libraryName: ${libraryName}, targetOs: ${targetOs}`
        );

        // Try with lowercase first (as saved by GhidraAnalyzer), then original case, then "unknown"
        let functions = await loadFunctionsFromDb(targetOsLower, libraryName);
        if (!functions || functions.length === 0) {
          functions = await loadFunctionsFromDb(targetOs, libraryName);
        }
        if (!functions || functions.length === 0) {
          functions = await loadFunctionsFromDb("unknown", libraryName);
        }

        if (functions && functions.length > 0) {
          console.log(
            `[InformationContent] Loaded ${functions.length} Ghidra functions for ${libraryName}`
          );
          setGhidraFunctions(functions);
        } else {
          console.log(
            `[InformationContent] No Ghidra functions found for ${libraryName} (tried targetOs: ${targetOs}, ${targetOsLower}, unknown)`
          );
          setGhidraFunctions([]);
        }
      } catch (e) {
        console.error("Failed to load Ghidra functions from SQLite:", e);
        setGhidraFunctions([]);
      } finally {
        setIsLoadingGhidraFunctions(false);
      }
    };

    loadGhidraFunctions();
  }, [
    selectedModuleForSymbols,
    serverInfo?.target_os,
    getCachedFunctions,
    loadFunctionsFromDb,
  ]);

  // Sync symbols from store on mount
  useEffect(() => {
    if (storedSymbols.length > 0 && symbols.length === 0) {
      setSymbols(storedSymbols as SymbolInfo[]);
    }
  }, [storedSymbols, symbols.length]);

  // Demangle symbols using Tauri when symbols change or demangle is enabled
  useEffect(() => {
    if (!symbolDemangleEnabled || symbols.length === 0) {
      return;
    }

    // Get names that need demangling (not already in cache)
    const namesToDemangle = symbols
      .map((s) => s.name)
      .filter((name) => !demangledNames.has(name));

    if (namesToDemangle.length === 0) {
      return;
    }

    setIsDemanglingInProgress(true);

    // Call Tauri demangle command
    invoke<string[]>("demangle_symbols", { names: namesToDemangle })
      .then((demangled) => {
        const newCache = new Map(demangledNames);
        namesToDemangle.forEach((name, index) => {
          newCache.set(name, demangled[index]);
        });
        setDemangledNames(newCache);
      })
      .catch((error) => {
        console.error("Failed to demangle symbols:", error);
      })
      .finally(() => {
        setIsDemanglingInProgress(false);
      });
  }, [symbols, symbolDemangleEnabled, demangledNames]);

  // Use local state as fallback if props not provided
  const [localNameFilter, setLocalNameFilter] = useState("");
  const [localSortField, setLocalSortField] = useState<
    "baseAddress" | "size" | null
  >(null);
  const [localSortDirection, setLocalSortDirection] = useState<"asc" | "desc">(
    "asc"
  );

  // Use props if provided, otherwise use local state
  const currentNameFilter = onNameFilterChange ? nameFilter : localNameFilter;
  const currentSortField = onSortChange ? propSortField : localSortField;
  const currentSortDirection = onSortChange
    ? propSortDirection
    : localSortDirection;

  // Sync internal tab with external tab
  useEffect(() => {
    setInternalTab(currentTab);
  }, [currentTab]);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setInternalTab(newValue);
    if (onTabChange) {
      onTabChange(newValue);
    }
    // Load modules when switching to modules tab
    if (newValue === 0) {
      handleRefreshModules();
    }
    // Symbols tab (index 1) - no auto-load, wait for module selection
    // Load regions when switching to regions tab
    if (newValue === 2) {
      loadRegions();
    }
    // Load threads when switching to threads tab
    if (newValue === 3) {
      loadThreads();
    }
    // Load network connections when switching to network tab
    if (newValue === 4) {
      loadNetworkConnections();
    }
  };

  const handleSort = (field: "baseAddress" | "size") => {
    const isAsc = currentSortField === field && currentSortDirection === "asc";
    const newDirection: "asc" | "desc" = isAsc ? "desc" : "asc";

    if (onSortChange) {
      onSortChange(field, newDirection);
    } else {
      setLocalSortDirection(newDirection);
      setLocalSortField(field);
    }
  };

  const handleRefreshModules = async () => {
    if (!onRefreshModules || isRefreshing) return;

    setIsRefreshing(true);
    try {
      await onRefreshModules();
    } finally {
      setIsRefreshing(false);
    }
  };

  const loadThreads = useCallback(async () => {
    setIsLoadingThreads(true);
    try {
      const client = getApiClient();
      const response = await client.enumerateThreads();
      if (response.success && response.data?.threads) {
        uiActions.setInformationThreads(response.data.threads);
      } else {
        uiActions.setInformationThreads([]);
      }
    } catch (error) {
      console.error("Failed to load threads:", error);
      uiActions.setInformationThreads([]);
    } finally {
      setIsLoadingThreads(false);
    }
  }, [uiActions]);

  const handleRefreshThreads = async () => {
    await loadThreads();
  };

  const loadRegions = useCallback(async () => {
    setIsLoadingRegions(true);
    try {
      const client = getApiClient();
      const response = await client.enumerateRegions();
      if (response.regions) {
        uiActions.setInformationRegions(response.regions);
      } else {
        uiActions.setInformationRegions([]);
      }
    } catch (error) {
      console.error("Failed to load regions:", error);
      uiActions.setInformationRegions([]);
    } finally {
      setIsLoadingRegions(false);
    }
  }, [uiActions]);

  const handleRefreshRegions = async () => {
    await loadRegions();
  };

  // Network connections loading
  const loadNetworkConnections = useCallback(async () => {
    setIsLoadingNetwork(true);
    try {
      const client = getApiClient();
      const response = await client.enumerateNetwork();
      console.log("Network API response:", response);
      if (response.success && response.data?.connections) {
        console.log(
          "Network connections found:",
          response.data.connections.length
        );
        uiActions.setNetworkConnections(response.data.connections);
      } else {
        console.log("No network connections in response:", response);
        uiActions.setNetworkConnections([]);
      }
    } catch (error) {
      console.error("Failed to load network connections:", error);
      uiActions.setNetworkConnections([]);
    } finally {
      setIsLoadingNetwork(false);
    }
  }, [uiActions]);

  const handleRefreshNetwork = async () => {
    await loadNetworkConnections();
  };

  // Column resize handlers for symbols table
  const handleSymbolColumnResizeStart = useCallback(
    (column: keyof typeof symbolColumnWidths) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingColumn(column);
      setResizingTable("symbol");
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = symbolColumnWidths[column];

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(50, resizeStartWidth.current + delta);
        uiActions.setSymbolColumnWidth(column, newWidth);
      };

      const handleMouseUp = () => {
        setResizingColumn(null);
        setResizingTable(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [symbolColumnWidths, uiActions]
  );

  // Column resize handlers for modules table
  const handleModuleColumnResizeStart = useCallback(
    (column: keyof typeof moduleColumnWidths) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingColumn(column);
      setResizingTable("module");
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = moduleColumnWidths[column];

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(50, resizeStartWidth.current + delta);
        uiActions.setModuleColumnWidth(column, newWidth);
      };

      const handleMouseUp = () => {
        setResizingColumn(null);
        setResizingTable(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [moduleColumnWidths, uiActions]
  );

  // Column resize handlers for regions table
  const handleRegionColumnResizeStart = useCallback(
    (column: keyof typeof regionColumnWidths) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingColumn(column);
      setResizingTable("region");
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = regionColumnWidths[column];

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(50, resizeStartWidth.current + delta);
        uiActions.setRegionColumnWidth(column, newWidth);
      };

      const handleMouseUp = () => {
        setResizingColumn(null);
        setResizingTable(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [regionColumnWidths, uiActions]
  );

  // Column resize handlers for threads table
  const handleThreadColumnResizeStart = useCallback(
    (column: keyof typeof threadColumnWidths) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingColumn(column);
      setResizingTable("thread");
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = threadColumnWidths[column];

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(50, resizeStartWidth.current + delta);
        uiActions.setThreadColumnWidth(column, newWidth);
      };

      const handleMouseUp = () => {
        setResizingColumn(null);
        setResizingTable(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [threadColumnWidths, uiActions]
  );

  // Load symbols for selected module
  const loadSymbols = useCallback(
    async (module: ModuleInfo) => {
      setIsLoadingSymbols(true);
      uiActions.setSymbolsSelectedModule(module.base);
      // Clear demangle cache when loading new module
      setDemangledNames(new Map());
      // Reset filter when loading new module
      uiActions.setSymbolFilter("");
      try {
        const client = getApiClient();
        const symbolsData = await client.enumerateSymbolsForModule(module);
        setSymbols(symbolsData);
        // Store symbols in uiStore for persistence
        uiActions.setSymbols(
          symbolsData.map((s) => ({
            name: s.name,
            address: s.address,
            size: s.size,
            type: s.type,
            scope: s.scope,
          }))
        );
      } catch (error) {
        console.error("Failed to load symbols:", error);
        setSymbols([]);
        uiActions.setSymbols([]);
      } finally {
        setIsLoadingSymbols(false);
      }
    },
    [uiActions]
  );

  const handleModuleSelectForSymbols = (
    _event: React.SyntheticEvent,
    module: ModuleInfo | null
  ) => {
    if (module) {
      loadSymbols(module);
    } else {
      uiActions.setSymbolsSelectedModule(null);
      uiActions.setSymbolFilter("");
      setSymbols([]);
      uiActions.setSymbols([]);
    }
  };

  // Filter and sort symbols
  const filteredSymbols = useMemo(() => {
    // First, deduplicate symbols by name and address
    // If duplicates exist, prefer the one with size > 0
    const symbolMap = new Map<
      string,
      SymbolInfo & { isGhidraAnalyzed?: boolean }
    >();
    for (const symbol of symbols) {
      const key = `${symbol.name}_${symbol.address}`;
      const existing = symbolMap.get(key);
      if (!existing) {
        symbolMap.set(key, symbol);
      } else if (symbol.size > 0 && existing.size === 0) {
        // Prefer symbol with size information
        symbolMap.set(key, symbol);
      }
    }

    // Add Ghidra analyzed functions for selected module (loaded from SQLite)
    if (selectedModuleForSymbols && ghidraFunctions.length > 0) {
      const moduleBase = selectedModuleForSymbols.base || 0;
      for (const func of ghidraFunctions) {
        // Convert offset to absolute address by adding module base
        const offsetHex = func.address.startsWith("0x")
          ? func.address
          : `0x${func.address}`;
        const offset = parseInt(offsetHex, 16);
        const absoluteAddress = (BigInt(moduleBase) + BigInt(offset)).toString(
          16
        );
        const absoluteAddressFormatted = `0x${absoluteAddress}`;

        const key = `${func.name}_${absoluteAddressFormatted}`;
        if (!symbolMap.has(key)) {
          // Add as a new symbol with Ghidra marker
          symbolMap.set(key, {
            name: func.name,
            address: absoluteAddressFormatted,
            size: func.size,
            type: "Function",
            scope: "Ghidra",
            module_base: moduleBase.toString(16),
            isGhidraAnalyzed: true,
          });
        }
      }
    }

    let result = Array.from(symbolMap.values());

    // Apply type filter
    if (symbolTypeFilter !== "all") {
      result = result.filter((symbol) => symbol.type === symbolTypeFilter);
    }

    // Apply scope filter
    if (symbolScopeFilter !== "all") {
      result = result.filter((symbol) => symbol.scope === symbolScopeFilter);
    }

    // Apply name/address filter
    if (symbolFilter.trim()) {
      const lowerFilter = symbolFilter.toLowerCase();
      result = result.filter(
        (symbol) =>
          symbol.name.toLowerCase().includes(lowerFilter) ||
          symbol.type.toLowerCase().includes(lowerFilter) ||
          symbol.address.toLowerCase().includes(lowerFilter)
      );
    }

    // Sort by selected field
    result = [...result].sort((a, b) => {
      let comparison = 0;
      if (symbolSortField === "name") {
        comparison = a.name.localeCompare(b.name);
      } else if (symbolSortField === "address") {
        const addrA = BigInt(
          a.address.startsWith("0x") ? a.address : `0x${a.address}`
        );
        const addrB = BigInt(
          b.address.startsWith("0x") ? b.address : `0x${b.address}`
        );
        comparison = addrA < addrB ? -1 : addrA > addrB ? 1 : 0;
      } else if (symbolSortField === "size") {
        comparison = a.size - b.size;
      } else if (symbolSortField === "type") {
        comparison = a.type.localeCompare(b.type);
      } else if (symbolSortField === "scope") {
        comparison = (a.scope || "").localeCompare(b.scope || "");
      }
      return symbolSortDirection === "asc" ? comparison : -comparison;
    });

    return result;
  }, [
    symbols,
    symbolFilter,
    symbolTypeFilter,
    symbolScopeFilter,
    symbolSortField,
    symbolSortDirection,
    selectedModuleForSymbols,
    ghidraFunctions,
  ]);

  // Get unique symbol types for filter dropdown
  const symbolTypes = useMemo(() => {
    const types = new Set(symbols.map((s) => s.type));
    return Array.from(types).sort();
  }, [symbols]);

  // Get unique symbol scopes for filter dropdown
  const symbolScopes = useMemo(() => {
    const scopes = new Set(symbols.map((s) => s.scope).filter(Boolean));
    // Add "Ghidra" scope if we have analyzed functions
    if (selectedModuleForSymbols && ghidraFunctions.length > 0) {
      scopes.add("Ghidra");
    }
    return Array.from(scopes).sort();
  }, [symbols, selectedModuleForSymbols, ghidraFunctions]);

  // Filter and sort regions by protection
  const filteredRegions = useMemo(() => {
    let result = regions.filter((region) => {
      const protection = region.protection || "";
      const hasR = protection.includes("r");
      const hasW = protection.includes("w");
      const hasX = protection.includes("x");
      const hasP = protection.includes("p");

      // Check each filter - null means "don't care"
      if (
        regionProtectionFilter.readable !== null &&
        regionProtectionFilter.readable !== hasR
      ) {
        return false;
      }
      if (
        regionProtectionFilter.writable !== null &&
        regionProtectionFilter.writable !== hasW
      ) {
        return false;
      }
      if (
        regionProtectionFilter.executable !== null &&
        regionProtectionFilter.executable !== hasX
      ) {
        return false;
      }
      if (
        regionProtectionFilter.private !== null &&
        regionProtectionFilter.private !== hasP
      ) {
        return false;
      }

      // Apply file path filter
      if (regionFilter.trim()) {
        const filePath = region.file_path || "";
        if (!filePath.toLowerCase().includes(regionFilter.toLowerCase())) {
          return false;
        }
      }

      return true;
    });

    // Apply sorting
    if (regionSortField) {
      result = [...result].sort((a, b) => {
        let comparison = 0;
        switch (regionSortField) {
          case "start":
            try {
              const startA = BigInt("0x" + a.start_address);
              const startB = BigInt("0x" + b.start_address);
              comparison = startA < startB ? -1 : startA > startB ? 1 : 0;
            } catch {
              comparison = 0;
            }
            break;
          case "end":
            try {
              const endA = BigInt("0x" + a.end_address);
              const endB = BigInt("0x" + b.end_address);
              comparison = endA < endB ? -1 : endA > endB ? 1 : 0;
            } catch {
              comparison = 0;
            }
            break;
          case "size":
            try {
              const sizeA =
                BigInt("0x" + a.end_address) - BigInt("0x" + a.start_address);
              const sizeB =
                BigInt("0x" + b.end_address) - BigInt("0x" + b.start_address);
              comparison = sizeA < sizeB ? -1 : sizeA > sizeB ? 1 : 0;
            } catch {
              comparison = 0;
            }
            break;
          case "path":
            comparison = (a.file_path || "").localeCompare(b.file_path || "");
            break;
        }
        return regionSortDirection === "asc" ? comparison : -comparison;
      });
    }

    return result;
  }, [
    regions,
    regionProtectionFilter,
    regionFilter,
    regionSortField,
    regionSortDirection,
  ]);

  const formatFileSize = (bytes: number): string => {
    const sizes = ["B", "KB", "MB", "GB"];
    if (bytes === 0) return "0 B";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round((bytes / Math.pow(1024, i)) * 100) / 100} ${sizes[i]}`;
  };

  // Filter and sort modules
  const filteredAndSortedModules = useMemo(() => {
    let filtered = attachedModules;

    // Apply name filter
    if (currentNameFilter.trim()) {
      filtered = attachedModules.filter((module) => {
        const moduleName = module.modulename || module.name || "Unknown";
        const fileName = moduleName.split(/[\/\\]/).pop() || moduleName;
        return fileName.toLowerCase().includes(currentNameFilter.toLowerCase());
      });
    }

    // Apply sorting - first check new local sort, then fallback to prop-based sort
    const sortField = moduleSortField || currentSortField;
    const sortDirection = moduleSortField
      ? moduleSortDirection
      : currentSortDirection;

    if (sortField) {
      return [...filtered].sort((a, b) => {
        let comparison = 0;
        const moduleNameA = a.modulename || a.name || "";
        const moduleNameB = b.modulename || b.name || "";
        const fileNameA = moduleNameA.split(/[\/\\]/).pop() || moduleNameA;
        const fileNameB = moduleNameB.split(/[\/\\]/).pop() || moduleNameB;

        switch (sortField) {
          case "name":
            comparison = fileNameA.localeCompare(fileNameB);
            break;
          case "baseAddress":
            comparison = a.base - b.base;
            break;
          case "size":
            comparison = a.size - b.size;
            break;
          case "arch":
            // Sort by is_64bit boolean
            comparison = (a.is_64bit ? 1 : 0) - (b.is_64bit ? 1 : 0);
            break;
          case "path":
            comparison = moduleNameA.localeCompare(moduleNameB);
            break;
        }

        return sortDirection === "asc" ? comparison : -comparison;
      });
    }

    return filtered;
  }, [
    attachedModules,
    currentNameFilter,
    currentSortField,
    currentSortDirection,
    moduleSortField,
    moduleSortDirection,
  ]);

  // Filter threads
  const filteredThreads = useMemo(() => {
    let result = threads;

    // Apply filter
    if (threadFilter.trim()) {
      result = threads.filter((thread) => {
        const searchLower = threadFilter.toLowerCase();
        return (
          thread.name.toLowerCase().includes(searchLower) ||
          thread.thread_id.toString().includes(searchLower) ||
          thread.pc.toLowerCase().includes(searchLower) ||
          thread.state.toLowerCase().includes(searchLower)
        );
      });
    }

    // Apply sorting
    if (threadSortField) {
      result = [...result].sort((a, b) => {
        let comparison = 0;
        switch (threadSortField) {
          case "id":
            comparison = a.thread_id - b.thread_id;
            break;
          case "name":
            comparison = a.name.localeCompare(b.name);
            break;
        }
        return threadSortDirection === "asc" ? comparison : -comparison;
      });
    }

    return result;
  }, [threads, threadFilter, threadSortField, threadSortDirection]);

  const getStateColor = (state: string) => {
    switch (state) {
      case "Running":
        return "#4caf50";
      case "Waiting":
        return "#5c6bc0"; // 落ち着いた青紫色
      case "Stopped":
        return "#f44336";
      case "Halted":
        return "#9e9e9e";
      default:
        return "#78909c";
    }
  };

  return (
    <Box sx={{ width: "100%", height: "100%", p: 2 }}>
      {/* Chrome-style tabs */}
      <Box sx={{ display: "flex", alignItems: "flex-end" }}>
        <Tabs
          value={internalTab}
          onChange={handleTabChange}
          aria-label="information tabs"
          sx={{
            minHeight: "28px",
            "& .MuiTabs-indicator": {
              display: "none",
            },
            "& .MuiTab-root": {
              minHeight: "28px",
              minWidth: "80px",
              fontSize: "11px",
              textTransform: "none",
              fontWeight: 500,
              px: 1.5,
              py: 0.5,
              borderTopLeftRadius: "6px",
              borderTopRightRadius: "6px",
              border: "1px solid",
              borderBottom: "none",
              borderColor: "divider",
              backgroundColor: "action.hover",
              color: "text.secondary",
              marginRight: "2px",
              "&.Mui-selected": {
                backgroundColor: "background.paper",
                color: "primary.main",
                fontWeight: 600,
              },
            },
          }}
        >
          <Tab
            icon={<ViewModule sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Modules"
            id="info-tab-0"
            aria-controls="info-tabpanel-0"
            sx={{ gap: 0.5 }}
          />
          <Tab
            icon={<Functions sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Symbols"
            id="info-tab-1"
            aria-controls="info-tabpanel-1"
            sx={{ gap: 0.5 }}
          />
          <Tab
            icon={<Memory sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Regions"
            id="info-tab-2"
            aria-controls="info-tabpanel-2"
            sx={{ gap: 0.5 }}
          />
          <Tab
            icon={<AccountTree sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Threads"
            id="info-tab-3"
            aria-controls="info-tabpanel-3"
            sx={{ gap: 0.5 }}
          />
          {/* Network tab hidden for now
          <Tab
            icon={<NetworkIcon sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Network"
            id="info-tab-4"
            aria-controls="info-tabpanel-4"
            sx={{ gap: 0.5 }}
          />
          */}
        </Tabs>
      </Box>

      {/* Content area with top border connecting to tabs */}
      <Box
        sx={{
          borderTop: "1px solid",
          borderColor: "divider",
          mt: "-1px",
        }}
      >
        {/* Modules Tab */}
        <TabPanel value={internalTab} index={0}>
          <Box
            sx={{
              mb: 2,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="h6" sx={{ fontSize: "14px" }}>
                Modules
              </Typography>
              {isRefreshing ? (
                <CircularProgress size={16} />
              ) : (
                <Chip
                  label={attachedModules.length}
                  size="small"
                  sx={{ height: "20px", fontSize: "11px" }}
                />
              )}
              <Tooltip title="Refresh modules">
                <IconButton
                  size="small"
                  onClick={handleRefreshModules}
                  disabled={!onRefreshModules || isRefreshing}
                >
                  <RefreshIcon sx={{ fontSize: "16px" }} />
                </IconButton>
              </Tooltip>
            </Box>
            <TextField
              size="small"
              placeholder="Filter by name..."
              value={currentNameFilter}
              onChange={(e) => {
                if (onNameFilterChange) {
                  onNameFilterChange(e.target.value);
                } else {
                  setLocalNameFilter(e.target.value);
                }
              }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search sx={{ fontSize: "16px" }} />
                  </InputAdornment>
                ),
              }}
              sx={{
                width: "250px",
                "& .MuiOutlinedInput-root": {
                  fontSize: "12px",
                },
              }}
            />
          </Box>
          <TableContainer
            component={Paper}
            sx={{
              maxHeight: "calc(100vh - 200px)",
              "&::-webkit-scrollbar": {
                width: "10px",
                height: "10px",
              },
              "&::-webkit-scrollbar-track": {
                background: "#1e1e1e",
              },
              "&::-webkit-scrollbar-thumb": {
                background: "#3e3e42",
                borderRadius: "4px",
                "&:hover": {
                  background: "#5a5a5e",
                },
              },
              "&::-webkit-scrollbar-corner": {
                background: "#1e1e1e",
              },
            }}
          >
            <Table stickyHeader size="small">
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{
                      fontSize: "11px",
                      fontWeight: 600,
                      width: `${moduleColumnWidths.name}px`,
                      minWidth: `${moduleColumnWidths.name}px`,
                      position: "relative",
                    }}
                  >
                    <TableSortLabel
                      active={moduleSortField === "name"}
                      direction={
                        moduleSortField === "name" ? moduleSortDirection : "asc"
                      }
                      onClick={() => {
                        const isAsc =
                          moduleSortField === "name" &&
                          moduleSortDirection === "asc";
                        setModuleSortDirection(isAsc ? "desc" : "asc");
                        setModuleSortField("name");
                      }}
                      sx={{
                        fontSize: "11px",
                        "& .MuiTableSortLabel-icon": {
                          opacity: moduleSortField === "name" ? 1 : 0,
                        },
                        "&:hover .MuiTableSortLabel-icon": {
                          opacity: 0.5,
                        },
                        "&.Mui-active .MuiTableSortLabel-icon": {
                          opacity: 1,
                        },
                      }}
                    >
                      Name
                    </TableSortLabel>
                    <ColumnResizer
                      onMouseDown={handleModuleColumnResizeStart("name")}
                      isResizing={
                        resizingColumn === "name" && resizingTable === "module"
                      }
                    />
                  </TableCell>
                  <TableCell
                    sx={{
                      fontSize: "11px",
                      fontWeight: 600,
                      width: `${moduleColumnWidths.base}px`,
                      minWidth: `${moduleColumnWidths.base}px`,
                      position: "relative",
                    }}
                  >
                    <TableSortLabel
                      active={currentSortField === "baseAddress"}
                      direction={
                        currentSortField === "baseAddress"
                          ? currentSortDirection
                          : "asc"
                      }
                      onClick={() => handleSort("baseAddress")}
                      sx={{
                        fontSize: "11px",
                        "& .MuiTableSortLabel-icon": {
                          opacity: currentSortField === "baseAddress" ? 1 : 0,
                        },
                        "&:hover .MuiTableSortLabel-icon": {
                          opacity: 0.5,
                        },
                        "&.Mui-active .MuiTableSortLabel-icon": {
                          opacity: 1,
                        },
                      }}
                    >
                      Base Address
                    </TableSortLabel>
                    <ColumnResizer
                      onMouseDown={handleModuleColumnResizeStart("base")}
                      isResizing={
                        resizingColumn === "base" && resizingTable === "module"
                      }
                    />
                  </TableCell>
                  <TableCell
                    sx={{
                      fontSize: "11px",
                      fontWeight: 600,
                      width: `${moduleColumnWidths.size}px`,
                      minWidth: `${moduleColumnWidths.size}px`,
                      position: "relative",
                    }}
                  >
                    <TableSortLabel
                      active={moduleSortField === "size"}
                      direction={
                        moduleSortField === "size" ? moduleSortDirection : "asc"
                      }
                      onClick={() => {
                        const isAsc =
                          moduleSortField === "size" &&
                          moduleSortDirection === "asc";
                        setModuleSortDirection(isAsc ? "desc" : "asc");
                        setModuleSortField("size");
                      }}
                      sx={{
                        fontSize: "11px",
                        "& .MuiTableSortLabel-icon": {
                          opacity: moduleSortField === "size" ? 1 : 0,
                        },
                        "&:hover .MuiTableSortLabel-icon": {
                          opacity: 0.5,
                        },
                        "&.Mui-active .MuiTableSortLabel-icon": {
                          opacity: 1,
                        },
                      }}
                    >
                      Size
                    </TableSortLabel>
                    <ColumnResizer
                      onMouseDown={handleModuleColumnResizeStart("size")}
                      isResizing={
                        resizingColumn === "size" && resizingTable === "module"
                      }
                    />
                  </TableCell>
                  <TableCell
                    sx={{
                      fontSize: "11px",
                      fontWeight: 600,
                      width: `${moduleColumnWidths.arch}px`,
                      minWidth: `${moduleColumnWidths.arch}px`,
                      textAlign: "center",
                      position: "relative",
                    }}
                  >
                    <TableSortLabel
                      active={moduleSortField === "arch"}
                      direction={
                        moduleSortField === "arch" ? moduleSortDirection : "asc"
                      }
                      onClick={() => {
                        const isAsc =
                          moduleSortField === "arch" &&
                          moduleSortDirection === "asc";
                        setModuleSortDirection(isAsc ? "desc" : "asc");
                        setModuleSortField("arch");
                      }}
                      sx={{
                        fontSize: "11px",
                        "& .MuiTableSortLabel-icon": {
                          opacity: moduleSortField === "arch" ? 1 : 0,
                        },
                        "&:hover .MuiTableSortLabel-icon": {
                          opacity: 0.5,
                        },
                        "&.Mui-active .MuiTableSortLabel-icon": {
                          opacity: 1,
                        },
                      }}
                    >
                      Architecture
                    </TableSortLabel>
                    <ColumnResizer
                      onMouseDown={handleModuleColumnResizeStart("arch")}
                      isResizing={
                        resizingColumn === "arch" && resizingTable === "module"
                      }
                    />
                  </TableCell>
                  <TableCell
                    sx={{
                      fontSize: "11px",
                      fontWeight: 600,
                      width: `${moduleColumnWidths.path}px`,
                      minWidth: `${moduleColumnWidths.path}px`,
                      position: "relative",
                    }}
                  >
                    <TableSortLabel
                      active={moduleSortField === "path"}
                      direction={
                        moduleSortField === "path" ? moduleSortDirection : "asc"
                      }
                      onClick={() => {
                        const isAsc =
                          moduleSortField === "path" &&
                          moduleSortDirection === "asc";
                        setModuleSortDirection(isAsc ? "desc" : "asc");
                        setModuleSortField("path");
                      }}
                      sx={{
                        fontSize: "11px",
                        "& .MuiTableSortLabel-icon": {
                          opacity: moduleSortField === "path" ? 1 : 0,
                        },
                        "&:hover .MuiTableSortLabel-icon": {
                          opacity: 0.5,
                        },
                        "&.Mui-active .MuiTableSortLabel-icon": {
                          opacity: 1,
                        },
                      }}
                    >
                      Path
                    </TableSortLabel>
                    <ColumnResizer
                      onMouseDown={handleModuleColumnResizeStart("path")}
                      isResizing={
                        resizingColumn === "path" && resizingTable === "module"
                      }
                    />
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredAndSortedModules.map((module, index) => {
                  const moduleName =
                    module.modulename || module.name || "Unknown";
                  const fileName =
                    moduleName.split(/[\/\\]/).pop() || moduleName;
                  const baseAddress = `0x${module.base.toString(16).toUpperCase()}`;

                  return (
                    <TableRow
                      key={`${module.base}-${index}`}
                      hover
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setModuleContextMenu({
                          mouseX: e.clientX + 2,
                          mouseY: e.clientY - 6,
                          module,
                        });
                      }}
                      sx={{ cursor: "default" }}
                    >
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          width: `${moduleColumnWidths.name}px`,
                          minWidth: `${moduleColumnWidths.name}px`,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                          }}
                          title={fileName}
                        >
                          {fileName}
                        </Typography>
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          color: "#4fc1ff",
                          width: `${moduleColumnWidths.base}px`,
                          minWidth: `${moduleColumnWidths.base}px`,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                          }}
                          title={baseAddress}
                        >
                          {baseAddress}
                        </Typography>
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          width: `${moduleColumnWidths.size}px`,
                          minWidth: `${moduleColumnWidths.size}px`,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                          }}
                          title={formatFileSize(module.size)}
                        >
                          {formatFileSize(module.size)}
                        </Typography>
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          width: `${moduleColumnWidths.arch}px`,
                          minWidth: `${moduleColumnWidths.arch}px`,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          textAlign: "center",
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                            textAlign: "center",
                            color: "#ce9178",
                            fontWeight: 500,
                          }}
                          title={module.is_64bit ? "64-bit" : "32-bit"}
                        >
                          {module.is_64bit ? "64-bit" : "32-bit"}
                        </Typography>
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          width: `${moduleColumnWidths.path}px`,
                          minWidth: `${moduleColumnWidths.path}px`,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                          }}
                          title={module.path || moduleName}
                        >
                          {module.path || moduleName}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          {/* Module Context Menu */}
          <Menu
            open={moduleContextMenu !== null}
            onClose={() => setModuleContextMenu(null)}
            anchorReference="anchorPosition"
            anchorPosition={
              moduleContextMenu !== null
                ? {
                    top: moduleContextMenu.mouseY,
                    left: moduleContextMenu.mouseX,
                  }
                : undefined
            }
            sx={{
              "& .MuiPaper-root": {
                backgroundColor: "#252526",
                border: "1px solid #3c3c3c",
                minWidth: "160px",
              },
            }}
          >
            <MenuItem
              onClick={() => {
                if (moduleContextMenu?.module) {
                  const name =
                    moduleContextMenu.module.modulename ||
                    moduleContextMenu.module.name ||
                    "";
                  const fileName = name.split("/").pop() || name;
                  navigator.clipboard.writeText(fileName);
                }
                setModuleContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy Name
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (moduleContextMenu?.module) {
                  const addr = `0x${moduleContextMenu.module.base.toString(16).toUpperCase()}`;
                  navigator.clipboard.writeText(addr);
                }
                setModuleContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy Base Address
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (moduleContextMenu?.module) {
                  const path =
                    moduleContextMenu.module.path ||
                    moduleContextMenu.module.modulename ||
                    moduleContextMenu.module.name ||
                    "";
                  navigator.clipboard.writeText(path);
                }
                setModuleContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy Path
            </MenuItem>
          </Menu>
        </TabPanel>

        {/* Regions Tab */}
        <TabPanel value={internalTab} index={2}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="h6" sx={{ fontSize: "14px" }}>
                Regions
              </Typography>
              {isLoadingRegions ? (
                <CircularProgress size={16} />
              ) : (
                <Chip
                  label={filteredRegions.length}
                  size="small"
                  sx={{ height: "20px", fontSize: "11px" }}
                />
              )}
              <Tooltip title="Refresh regions">
                <IconButton
                  size="small"
                  onClick={handleRefreshRegions}
                  disabled={isLoadingRegions}
                >
                  <RefreshIcon sx={{ fontSize: "16px" }} />
                </IconButton>
              </Tooltip>
            </Box>
            {/* Protection Filter */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", mr: 0.5 }}
              >
                Protection:
              </Typography>
              {(
                [
                  "readable",
                  "writable",
                  "executable",
                  ...(isIOS ? [] : ["private" as const]),
                ] as const
              ).map((perm) => {
                const label =
                  perm === "readable"
                    ? "R"
                    : perm === "writable"
                      ? "W"
                      : perm === "executable"
                        ? "X"
                        : "P";
                const value = regionProtectionFilter[perm];
                const color =
                  value === true
                    ? "#4caf50"
                    : value === false
                      ? "#f44336"
                      : "text.secondary";
                return (
                  <Tooltip
                    key={perm}
                    title={`${label}: ${value === null ? "Any" : value ? "Yes" : "No"} (Click to toggle)`}
                  >
                    <Chip
                      label={label}
                      size="small"
                      onClick={() => {
                        // Cycle: null -> true -> false -> null
                        const newValue =
                          value === null ? true : value === true ? false : null;
                        uiActions.setRegionProtectionFilter({
                          ...regionProtectionFilter,
                          [perm]: newValue,
                        });
                      }}
                      sx={{
                        height: "22px",
                        fontSize: "11px",
                        fontWeight: 600,
                        minWidth: "28px",
                        cursor: "pointer",
                        backgroundColor:
                          value === null
                            ? "transparent"
                            : value
                              ? "rgba(76, 175, 80, 0.15)"
                              : "rgba(244, 67, 54, 0.15)",
                        color: color,
                        border: "1px solid",
                        borderColor:
                          value === null ? "rgba(255,255,255,0.23)" : color,
                        "&:hover": {
                          backgroundColor:
                            value === null
                              ? "rgba(255,255,255,0.08)"
                              : value
                                ? "rgba(76, 175, 80, 0.25)"
                                : "rgba(244, 67, 54, 0.25)",
                        },
                      }}
                    />
                  </Tooltip>
                );
              })}
              {/* File Path Filter */}
              <TextField
                size="small"
                placeholder="Filter by file path..."
                value={regionFilter}
                onChange={(e) =>
                  uiActions.setInformationRegionFilter(e.target.value)
                }
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <Search sx={{ fontSize: "16px" }} />
                    </InputAdornment>
                  ),
                }}
                sx={{
                  width: "200px",
                  ml: 2,
                  "& .MuiOutlinedInput-root": {
                    fontSize: "12px",
                  },
                }}
              />
            </Box>
          </Box>
          {isLoadingRegions ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress />
            </Box>
          ) : filteredRegions.length === 0 ? (
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                py: 4,
                color: "text.secondary",
              }}
            >
              <Memory sx={{ fontSize: 48, mb: 1, opacity: 0.5 }} />
              <Typography variant="body2">No memory regions found</Typography>
            </Box>
          ) : (
            <Paper
              sx={{
                height: "calc(100vh - 280px)",
                overflow: "hidden",
                "&::-webkit-scrollbar": {
                  width: "10px",
                  height: "10px",
                },
                "&::-webkit-scrollbar-track": {
                  background: "#1e1e1e",
                },
                "&::-webkit-scrollbar-thumb": {
                  background: "#3e3e42",
                  borderRadius: "4px",
                  "&:hover": {
                    background: "#5a5a5e",
                  },
                },
                "&::-webkit-scrollbar-corner": {
                  background: "#1e1e1e",
                },
              }}
            >
              {/* Virtualized Table Header */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  backgroundColor: "background.paper",
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                <Box
                  sx={{
                    width: `${regionColumnWidths.start}px`,
                    minWidth: `${regionColumnWidths.start}px`,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                    position: "relative",
                  }}
                >
                  <TableSortLabel
                    active={regionSortField === "start"}
                    direction={
                      regionSortField === "start" ? regionSortDirection : "asc"
                    }
                    onClick={() => {
                      const isAsc =
                        regionSortField === "start" &&
                        regionSortDirection === "asc";
                      setRegionSortDirection(isAsc ? "desc" : "asc");
                      setRegionSortField("start");
                    }}
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: regionSortField === "start" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Start Address
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleRegionColumnResizeStart("start")}
                    isResizing={resizingTable === "region"}
                  />
                </Box>
                <Box
                  sx={{
                    width: `${regionColumnWidths.end}px`,
                    minWidth: `${regionColumnWidths.end}px`,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                    position: "relative",
                  }}
                >
                  <TableSortLabel
                    active={regionSortField === "end"}
                    direction={
                      regionSortField === "end" ? regionSortDirection : "asc"
                    }
                    onClick={() => {
                      const isAsc =
                        regionSortField === "end" &&
                        regionSortDirection === "asc";
                      setRegionSortDirection(isAsc ? "desc" : "asc");
                      setRegionSortField("end");
                    }}
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: regionSortField === "end" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    End Address
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleRegionColumnResizeStart("end")}
                    isResizing={resizingTable === "region"}
                  />
                </Box>
                <Box
                  sx={{
                    width: `${regionColumnWidths.size}px`,
                    minWidth: `${regionColumnWidths.size}px`,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                    position: "relative",
                  }}
                >
                  <TableSortLabel
                    active={regionSortField === "size"}
                    direction={
                      regionSortField === "size" ? regionSortDirection : "asc"
                    }
                    onClick={() => {
                      const isAsc =
                        regionSortField === "size" &&
                        regionSortDirection === "asc";
                      setRegionSortDirection(isAsc ? "desc" : "asc");
                      setRegionSortField("size");
                    }}
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: regionSortField === "size" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Size
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleRegionColumnResizeStart("size")}
                    isResizing={resizingTable === "region"}
                  />
                </Box>
                <Box
                  sx={{
                    width: `${regionColumnWidths.protection}px`,
                    minWidth: `${regionColumnWidths.protection}px`,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                    textAlign: "center",
                    position: "relative",
                  }}
                >
                  Protection
                  <ColumnResizer
                    onMouseDown={handleRegionColumnResizeStart("protection")}
                    isResizing={resizingTable === "region"}
                  />
                </Box>
                <Box
                  sx={{
                    width: `${regionColumnWidths.path}px`,
                    minWidth: `${regionColumnWidths.path}px`,
                    flex: 1,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  <TableSortLabel
                    active={regionSortField === "path"}
                    direction={
                      regionSortField === "path" ? regionSortDirection : "asc"
                    }
                    onClick={() => {
                      const isAsc =
                        regionSortField === "path" &&
                        regionSortDirection === "asc";
                      setRegionSortDirection(isAsc ? "desc" : "asc");
                      setRegionSortField("path");
                    }}
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: regionSortField === "path" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    File Path
                  </TableSortLabel>
                </Box>
              </Box>
              {/* Virtualized List Body */}
              <List
                style={{
                  height: Math.min(
                    filteredRegions.length * REGION_ROW_HEIGHT,
                    window.innerHeight - 350
                  ),
                }}
                rowCount={filteredRegions.length}
                rowHeight={REGION_ROW_HEIGHT}
                rowProps={{
                  data: {
                    regions: filteredRegions,
                    formatFileSize,
                    onContextMenu: (
                      e: React.MouseEvent,
                      region: RegionInfo
                    ) => {
                      e.preventDefault();
                      setRegionContextMenu({
                        mouseX: e.clientX + 2,
                        mouseY: e.clientY - 6,
                        region,
                      });
                    },
                    columnWidths: regionColumnWidths,
                  },
                }}
                rowComponent={RegionRow as any}
              />
            </Paper>
          )}
          {/* Region Context Menu */}
          <Menu
            open={regionContextMenu !== null}
            onClose={() => setRegionContextMenu(null)}
            anchorReference="anchorPosition"
            anchorPosition={
              regionContextMenu !== null
                ? {
                    top: regionContextMenu.mouseY,
                    left: regionContextMenu.mouseX,
                  }
                : undefined
            }
            sx={{
              "& .MuiPaper-root": {
                backgroundColor: "#252526",
                border: "1px solid #3c3c3c",
                minWidth: "160px",
              },
            }}
          >
            <MenuItem
              onClick={() => {
                if (regionContextMenu?.region) {
                  navigator.clipboard.writeText(
                    `0x${regionContextMenu.region.start_address}`
                  );
                }
                setRegionContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy Start Address
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (regionContextMenu?.region) {
                  navigator.clipboard.writeText(
                    `0x${regionContextMenu.region.end_address}`
                  );
                }
                setRegionContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy End Address
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (regionContextMenu?.region) {
                  navigator.clipboard.writeText(
                    regionContextMenu.region.file_path || ""
                  );
                }
                setRegionContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy File Path
            </MenuItem>
          </Menu>
        </TabPanel>

        {/* Threads Tab */}
        <TabPanel value={internalTab} index={3}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="h6" sx={{ fontSize: "14px" }}>
                Threads
              </Typography>
              {isLoadingThreads ? (
                <CircularProgress size={16} />
              ) : (
                <Chip
                  label={threads.length}
                  size="small"
                  sx={{ height: "20px", fontSize: "11px" }}
                />
              )}
              <Tooltip title="Refresh threads">
                <IconButton
                  size="small"
                  onClick={handleRefreshThreads}
                  disabled={isLoadingThreads}
                >
                  <RefreshIcon sx={{ fontSize: "16px" }} />
                </IconButton>
              </Tooltip>
            </Box>
            <TextField
              size="small"
              placeholder="Filter threads..."
              value={threadFilter}
              onChange={(e) =>
                uiActions.setInformationThreadFilter(e.target.value)
              }
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search sx={{ fontSize: "16px" }} />
                  </InputAdornment>
                ),
              }}
              sx={{
                width: "250px",
                "& .MuiOutlinedInput-root": {
                  fontSize: "12px",
                },
              }}
            />
          </Box>

          {isLoadingThreads ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <CircularProgress />
            </Box>
          ) : filteredThreads.length === 0 ? (
            <Box sx={{ textAlign: "center", p: 4, color: "text.secondary" }}>
              <Typography variant="body2">
                {threads.length === 0
                  ? "No threads found"
                  : "No threads match the filter"}
              </Typography>
            </Box>
          ) : (
            <TableContainer
              component={Paper}
              sx={{
                maxHeight: "calc(100vh - 200px)",
                "&::-webkit-scrollbar": {
                  width: "10px",
                  height: "10px",
                },
                "&::-webkit-scrollbar-track": {
                  background: "#1e1e1e",
                },
                "&::-webkit-scrollbar-thumb": {
                  background: "#3e3e42",
                  borderRadius: "4px",
                  "&:hover": {
                    background: "#5a5a5e",
                  },
                },
                "&::-webkit-scrollbar-corner": {
                  background: "#1e1e1e",
                },
              }}
            >
              <Table stickyHeader size="small">
                <TableHead>
                  <TableRow>
                    <TableCell
                      sx={{
                        fontSize: "11px",
                        fontWeight: 600,
                        width: `${threadColumnWidths.id}px`,
                        minWidth: `${threadColumnWidths.id}px`,
                        position: "relative",
                      }}
                    >
                      <TableSortLabel
                        active={threadSortField === "id"}
                        direction={
                          threadSortField === "id" ? threadSortDirection : "asc"
                        }
                        onClick={() => {
                          const isAsc =
                            threadSortField === "id" &&
                            threadSortDirection === "asc";
                          setThreadSortDirection(isAsc ? "desc" : "asc");
                          setThreadSortField("id");
                        }}
                        sx={{
                          fontSize: "11px",
                          "& .MuiTableSortLabel-icon": {
                            opacity: threadSortField === "id" ? 1 : 0,
                          },
                          "&:hover .MuiTableSortLabel-icon": {
                            opacity: 0.5,
                          },
                          "&.Mui-active .MuiTableSortLabel-icon": {
                            opacity: 1,
                          },
                        }}
                      >
                        Thread ID
                      </TableSortLabel>
                      <ColumnResizer
                        onMouseDown={handleThreadColumnResizeStart("id")}
                        isResizing={resizingTable === "thread"}
                      />
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: "11px",
                        fontWeight: 600,
                        width: `${threadColumnWidths.name}px`,
                        minWidth: `${threadColumnWidths.name}px`,
                        position: "relative",
                      }}
                    >
                      <TableSortLabel
                        active={threadSortField === "name"}
                        direction={
                          threadSortField === "name"
                            ? threadSortDirection
                            : "asc"
                        }
                        onClick={() => {
                          const isAsc =
                            threadSortField === "name" &&
                            threadSortDirection === "asc";
                          setThreadSortDirection(isAsc ? "desc" : "asc");
                          setThreadSortField("name");
                        }}
                        sx={{
                          fontSize: "11px",
                          "& .MuiTableSortLabel-icon": {
                            opacity: threadSortField === "name" ? 1 : 0,
                          },
                          "&:hover .MuiTableSortLabel-icon": {
                            opacity: 0.5,
                          },
                          "&.Mui-active .MuiTableSortLabel-icon": {
                            opacity: 1,
                          },
                        }}
                      >
                        Name
                      </TableSortLabel>
                      <ColumnResizer
                        onMouseDown={handleThreadColumnResizeStart("name")}
                        isResizing={resizingTable === "thread"}
                      />
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: "11px",
                        fontWeight: 600,
                        width: `${threadColumnWidths.address}px`,
                        minWidth: `${threadColumnWidths.address}px`,
                        position: "relative",
                      }}
                    >
                      Address
                      <ColumnResizer
                        onMouseDown={handleThreadColumnResizeStart("address")}
                        isResizing={resizingTable === "thread"}
                      />
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: "11px",
                        fontWeight: 600,
                        width: `${threadColumnWidths.detail}px`,
                        minWidth: `${threadColumnWidths.detail}px`,
                        position: "relative",
                      }}
                    >
                      Detail
                      <ColumnResizer
                        onMouseDown={handleThreadColumnResizeStart("detail")}
                        isResizing={resizingTable === "thread"}
                      />
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: "11px",
                        fontWeight: 600,
                        width: `${threadColumnWidths.state}px`,
                        minWidth: `${threadColumnWidths.state}px`,
                      }}
                    >
                      State
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredThreads.map((thread) => (
                    <TableRow
                      key={thread.thread_id}
                      hover
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setThreadContextMenu({
                          mouseX: e.clientX + 2,
                          mouseY: e.clientY - 6,
                          thread: {
                            thread_id: thread.thread_id,
                            name: thread.name,
                          },
                        });
                      }}
                      sx={{ cursor: "default" }}
                    >
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          color: "#ce9178",
                          width: `${threadColumnWidths.id}px`,
                          minWidth: `${threadColumnWidths.id}px`,
                        }}
                      >
                        {thread.thread_id}
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          width: `${threadColumnWidths.name}px`,
                          minWidth: `${threadColumnWidths.name}px`,
                          maxWidth: `${threadColumnWidths.name}px`,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={thread.name}
                      >
                        {thread.name || "(unnamed)"}
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          color: "#4fc1ff",
                          width: `${threadColumnWidths.address}px`,
                          minWidth: `${threadColumnWidths.address}px`,
                        }}
                      >
                        {thread.pc === "0x0" || thread.pc === "0"
                          ? "?"
                          : thread.pc}
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          color: "#4ec9b0",
                          width: `${threadColumnWidths.detail}px`,
                          minWidth: `${threadColumnWidths.detail}px`,
                        }}
                      >
                        {(() => {
                          const pcValue = parseInt(
                            thread.pc.replace("0x", ""),
                            16
                          );
                          if (
                            pcValue === 0 ||
                            isNaN(pcValue) ||
                            !attachedModules ||
                            attachedModules.length === 0
                          ) {
                            return "-";
                          }
                          const detail = encodeAddressToLibraryExpression(
                            pcValue,
                            attachedModules,
                            true
                          );
                          return detail || "-";
                        })()}
                      </TableCell>
                      <TableCell
                        sx={{
                          fontSize: "11px",
                          width: `${threadColumnWidths.state}px`,
                          minWidth: `${threadColumnWidths.state}px`,
                        }}
                      >
                        <Chip
                          label={thread.state}
                          size="small"
                          variant="outlined"
                          sx={{
                            height: "18px",
                            fontSize: "9px",
                            borderColor: getStateColor(thread.state),
                            color: getStateColor(thread.state),
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {/* Thread Context Menu */}
          <Menu
            open={threadContextMenu !== null}
            onClose={() => setThreadContextMenu(null)}
            anchorReference="anchorPosition"
            anchorPosition={
              threadContextMenu !== null
                ? {
                    top: threadContextMenu.mouseY,
                    left: threadContextMenu.mouseX,
                  }
                : undefined
            }
            sx={{
              "& .MuiPaper-root": {
                backgroundColor: "#252526",
                border: "1px solid #3c3c3c",
                minWidth: "160px",
              },
            }}
          >
            <MenuItem
              onClick={() => {
                if (threadContextMenu?.thread) {
                  navigator.clipboard.writeText(
                    threadContextMenu.thread.thread_id.toString()
                  );
                }
                setThreadContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy Thread ID
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (threadContextMenu?.thread) {
                  navigator.clipboard.writeText(
                    threadContextMenu.thread.name || ""
                  );
                }
                setThreadContextMenu(null);
              }}
              sx={{ fontSize: "12px", py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: "28px" }}>
                <ContentCopy sx={{ fontSize: 14 }} />
              </ListItemIcon>
              Copy Name
            </MenuItem>
          </Menu>
        </TabPanel>

        {/* Network Tab */}
        <TabPanel value={internalTab} index={4}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="h6" sx={{ fontSize: "14px" }}>
                Network Connections
              </Typography>
              {isLoadingNetwork ? (
                <CircularProgress size={16} />
              ) : (
                <Chip
                  label={networkConnections.length}
                  size="small"
                  sx={{ height: "20px", fontSize: "11px" }}
                />
              )}
              <Tooltip title="Refresh network connections">
                <IconButton
                  size="small"
                  onClick={handleRefreshNetwork}
                  disabled={isLoadingNetwork}
                >
                  <RefreshIcon sx={{ fontSize: "16px" }} />
                </IconButton>
              </Tooltip>
            </Box>
            <TextField
              size="small"
              placeholder="Filter connections..."
              value={networkFilter}
              onChange={(e) => uiActions.setNetworkFilter(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search sx={{ fontSize: "16px" }} />
                  </InputAdornment>
                ),
              }}
              sx={{
                width: "250px",
                "& .MuiOutlinedInput-root": {
                  fontSize: "12px",
                },
              }}
            />
          </Box>

          {isLoadingNetwork ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <CircularProgress />
            </Box>
          ) : networkConnections.length === 0 ? (
            <Box sx={{ textAlign: "center", p: 4, color: "text.secondary" }}>
              <Typography variant="body2">
                No network connections found
              </Typography>
              <Typography
                variant="caption"
                sx={{ color: "text.disabled", mt: 1, display: "block" }}
              >
                Note: This feature is only supported on Linux targets
              </Typography>
            </Box>
          ) : (
            <TableContainer
              component={Paper}
              sx={{
                maxHeight: "calc(100vh - 200px)",
                "&::-webkit-scrollbar": {
                  width: "10px",
                  height: "10px",
                },
                "&::-webkit-scrollbar-track": {
                  background: "#1e1e1e",
                },
                "&::-webkit-scrollbar-thumb": {
                  background: "#3e3e42",
                  borderRadius: "4px",
                  "&:hover": {
                    background: "#5a5a5e",
                  },
                },
              }}
            >
              <Table stickyHeader size="small">
                <TableHead>
                  <TableRow>
                    <TableCell
                      sx={{ fontSize: "11px", fontWeight: 600, width: "80px" }}
                    >
                      Protocol
                    </TableCell>
                    <TableCell
                      sx={{ fontSize: "11px", fontWeight: 600, width: "180px" }}
                    >
                      Local Address
                    </TableCell>
                    <TableCell
                      sx={{ fontSize: "11px", fontWeight: 600, width: "80px" }}
                    >
                      Local Port
                    </TableCell>
                    <TableCell
                      sx={{ fontSize: "11px", fontWeight: 600, width: "180px" }}
                    >
                      Remote Address
                    </TableCell>
                    <TableCell
                      sx={{ fontSize: "11px", fontWeight: 600, width: "80px" }}
                    >
                      Remote Port
                    </TableCell>
                    <TableCell
                      sx={{ fontSize: "11px", fontWeight: 600, width: "120px" }}
                    >
                      State
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {networkConnections
                    .filter((conn) => {
                      if (!networkFilter) return true;
                      const filter = networkFilter.toLowerCase();
                      return (
                        conn.protocol.toLowerCase().includes(filter) ||
                        conn.local_address.toLowerCase().includes(filter) ||
                        conn.remote_address.toLowerCase().includes(filter) ||
                        conn.state.toLowerCase().includes(filter) ||
                        conn.local_port.toString().includes(filter) ||
                        conn.remote_port.toString().includes(filter)
                      );
                    })
                    .map((conn, index) => (
                      <TableRow
                        key={`${conn.protocol}-${conn.local_port}-${index}`}
                        hover
                      >
                        <TableCell
                          sx={{ fontSize: "11px", fontFamily: "monospace" }}
                        >
                          <Chip
                            label={conn.protocol}
                            size="small"
                            sx={{
                              height: "18px",
                              fontSize: "9px",
                              backgroundColor: conn.protocol.startsWith("TCP")
                                ? "#1e3a5f"
                                : "#3d2f1f",
                              color: conn.protocol.startsWith("TCP")
                                ? "#4fc1ff"
                                : "#daa520",
                            }}
                          />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontFamily: "monospace",
                            color: "#4fc1ff",
                          }}
                        >
                          {conn.local_address}
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontFamily: "monospace",
                            color: "#ce9178",
                          }}
                        >
                          {conn.local_port}
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontFamily: "monospace",
                            color: "#4ec9b0",
                          }}
                        >
                          {conn.remote_address === "0.0.0.0" ||
                          conn.remote_address === "::"
                            ? "-"
                            : conn.remote_address}
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontFamily: "monospace",
                            color: "#ce9178",
                          }}
                        >
                          {conn.remote_port === 0 ? "-" : conn.remote_port}
                        </TableCell>
                        <TableCell sx={{ fontSize: "11px" }}>
                          <Chip
                            label={conn.state}
                            size="small"
                            variant="outlined"
                            sx={{
                              height: "18px",
                              fontSize: "9px",
                              borderColor:
                                conn.state === "LISTEN"
                                  ? "#4caf50"
                                  : conn.state === "ESTABLISHED"
                                    ? "#2196f3"
                                    : conn.state === "TIME_WAIT"
                                      ? "#ff9800"
                                      : conn.state === "CLOSE_WAIT"
                                        ? "#f44336"
                                        : "#9e9e9e",
                              color:
                                conn.state === "LISTEN"
                                  ? "#4caf50"
                                  : conn.state === "ESTABLISHED"
                                    ? "#2196f3"
                                    : conn.state === "TIME_WAIT"
                                      ? "#ff9800"
                                      : conn.state === "CLOSE_WAIT"
                                        ? "#f44336"
                                        : "#9e9e9e",
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </TabPanel>

        {/* Symbols Tab */}
        <TabPanel value={internalTab} index={1}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <Typography variant="h6" sx={{ fontSize: "14px" }}>
                Symbols
              </Typography>
              <Autocomplete
                size="small"
                options={attachedModules}
                value={selectedModuleForSymbols}
                onChange={handleModuleSelectForSymbols}
                getOptionLabel={(option) => {
                  const moduleName =
                    option.modulename || option.name || "Unknown";
                  return moduleName.split(/[\/\\]/).pop() || moduleName;
                }}
                isOptionEqualToValue={(option, value) =>
                  option.base === value.base
                }
                renderInput={(params) => (
                  <TextField
                    {...params}
                    placeholder="Select Module..."
                    sx={{
                      "& .MuiOutlinedInput-root": {
                        fontSize: "12px",
                      },
                    }}
                  />
                )}
                renderOption={(props, option) => {
                  const moduleName =
                    option.modulename || option.name || "Unknown";
                  const fileName =
                    moduleName.split(/[\/\\]/).pop() || moduleName;
                  return (
                    <li
                      {...props}
                      key={option.base}
                      style={{ fontSize: "12px" }}
                    >
                      {fileName}
                    </li>
                  );
                }}
                sx={{ width: 300 }}
              />
              {isLoadingSymbols ? (
                <CircularProgress size={16} />
              ) : selectedModuleForSymbols ? (
                <>
                  <Chip
                    label={filteredSymbols.length}
                    size="small"
                    sx={{ height: "20px", fontSize: "11px" }}
                  />
                  {isDemanglingInProgress && (
                    <Tooltip title="Demangling symbols...">
                      <CircularProgress size={12} sx={{ ml: 0.5 }} />
                    </Tooltip>
                  )}
                </>
              ) : null}
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {/* Type Filter */}
              <FormControl size="small" sx={{ minWidth: 100 }}>
                <Select
                  value={symbolTypeFilter}
                  onChange={(e) =>
                    uiActions.setSymbolTypeFilter(e.target.value)
                  }
                  displayEmpty
                  sx={{
                    fontSize: "12px",
                    "& .MuiSelect-select": { py: 0.5 },
                  }}
                >
                  <MenuItem value="all" sx={{ fontSize: "12px" }}>
                    All Types
                  </MenuItem>
                  {symbolTypes.map((type) => (
                    <MenuItem key={type} value={type} sx={{ fontSize: "12px" }}>
                      {type}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {/* Scope Filter */}
              <FormControl size="small" sx={{ minWidth: 90 }}>
                <Select
                  value={symbolScopeFilter}
                  onChange={(e) =>
                    uiActions.setSymbolScopeFilter(e.target.value)
                  }
                  displayEmpty
                  sx={{
                    fontSize: "12px",
                    "& .MuiSelect-select": { py: 0.5 },
                  }}
                >
                  <MenuItem value="all" sx={{ fontSize: "12px" }}>
                    All Scopes
                  </MenuItem>
                  {symbolScopes.map((scope) => (
                    <MenuItem
                      key={scope}
                      value={scope}
                      sx={{ fontSize: "12px" }}
                    >
                      {scope}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {/* Demangle Toggle */}
              <Tooltip
                title={
                  symbolDemangleEnabled ? "Disable demangle" : "Enable demangle"
                }
              >
                <ToggleButton
                  value="demangle"
                  selected={symbolDemangleEnabled}
                  onChange={() =>
                    uiActions.setSymbolDemangleEnabled(!symbolDemangleEnabled)
                  }
                  size="small"
                  sx={{
                    px: 1,
                    py: 0.5,
                    fontSize: "11px",
                    textTransform: "none",
                    borderColor: symbolDemangleEnabled ? "#4caf50" : "divider",
                    color: symbolDemangleEnabled ? "#4caf50" : "text.secondary",
                    backgroundColor: symbolDemangleEnabled
                      ? "rgba(76, 175, 80, 0.1)"
                      : "transparent",
                    "&.Mui-selected": {
                      backgroundColor: "rgba(76, 175, 80, 0.15)",
                      color: "#4caf50",
                      borderColor: "#4caf50",
                      "&:hover": {
                        backgroundColor: "rgba(76, 175, 80, 0.2)",
                      },
                    },
                    "&:hover": {
                      backgroundColor: symbolDemangleEnabled
                        ? "rgba(76, 175, 80, 0.2)"
                        : "rgba(255, 255, 255, 0.05)",
                    },
                  }}
                >
                  <Code sx={{ fontSize: "14px", mr: 0.5 }} />
                  Demangle
                </ToggleButton>
              </Tooltip>
              {/* Symbol Filter */}
              <TextField
                size="small"
                placeholder="Filter symbols..."
                value={symbolFilter}
                onChange={(e) => uiActions.setSymbolFilter(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <Search sx={{ fontSize: "16px" }} />
                    </InputAdornment>
                  ),
                }}
                sx={{
                  width: "200px",
                  "& .MuiOutlinedInput-root": {
                    fontSize: "12px",
                  },
                }}
              />
            </Box>
          </Box>

          {!selectedModuleForSymbols ? (
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                py: 4,
                color: "text.secondary",
              }}
            >
              <Functions sx={{ fontSize: 48, mb: 1, opacity: 0.5 }} />
              <Typography variant="body2">
                Select a module to view its symbols
              </Typography>
            </Box>
          ) : isLoadingSymbols ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <CircularProgress />
            </Box>
          ) : filteredSymbols.length === 0 ? (
            <Box sx={{ textAlign: "center", p: 4, color: "text.secondary" }}>
              <Typography variant="body2">
                {symbols.length === 0
                  ? "No symbols found in this module"
                  : "No symbols match the filter"}
              </Typography>
            </Box>
          ) : (
            <Paper
              sx={{
                height: "calc(100vh - 280px)",
                overflow: "hidden",
                "&::-webkit-scrollbar": {
                  width: "10px",
                  height: "10px",
                },
                "&::-webkit-scrollbar-track": {
                  background: "#1e1e1e",
                },
                "&::-webkit-scrollbar-thumb": {
                  background: "#3e3e42",
                  borderRadius: "4px",
                  "&:hover": {
                    background: "#5a5a5e",
                  },
                },
                "&::-webkit-scrollbar-corner": {
                  background: "#1e1e1e",
                },
              }}
            >
              {/* Virtualized Table Header */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  backgroundColor: "background.paper",
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                {/* Name Column Header */}
                <Box
                  sx={{
                    width: `${symbolColumnWidths.name}px`,
                    minWidth: `${symbolColumnWidths.name}px`,
                    px: 1,
                    py: 0.5,
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    position: "relative",
                  }}
                  onClick={() => {
                    if (symbolSortField === "name") {
                      uiActions.setSymbolSortDirection(
                        symbolSortDirection === "asc" ? "desc" : "asc"
                      );
                    } else {
                      uiActions.setSymbolSortField("name");
                      uiActions.setSymbolSortDirection("asc");
                    }
                  }}
                >
                  <TableSortLabel
                    active={symbolSortField === "name"}
                    direction={
                      symbolSortField === "name" ? symbolSortDirection : "asc"
                    }
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: symbolSortField === "name" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Name
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleSymbolColumnResizeStart("name")}
                    isResizing={resizingColumn === "name"}
                  />
                </Box>
                {/* Address Column Header */}
                <Box
                  sx={{
                    width: `${symbolColumnWidths.address}px`,
                    minWidth: `${symbolColumnWidths.address}px`,
                    px: 1,
                    py: 0.5,
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    position: "relative",
                  }}
                  onClick={() => {
                    if (symbolSortField === "address") {
                      uiActions.setSymbolSortDirection(
                        symbolSortDirection === "asc" ? "desc" : "asc"
                      );
                    } else {
                      uiActions.setSymbolSortField("address");
                      uiActions.setSymbolSortDirection("asc");
                    }
                  }}
                >
                  <TableSortLabel
                    active={symbolSortField === "address"}
                    direction={
                      symbolSortField === "address"
                        ? symbolSortDirection
                        : "asc"
                    }
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: symbolSortField === "address" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Address
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleSymbolColumnResizeStart("address")}
                    isResizing={resizingColumn === "address"}
                  />
                </Box>
                {/* Size Column Header */}
                <Box
                  sx={{
                    width: `${symbolColumnWidths.size}px`,
                    minWidth: `${symbolColumnWidths.size}px`,
                    px: 1,
                    py: 0.5,
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    position: "relative",
                  }}
                  onClick={() => {
                    if (symbolSortField === "size") {
                      uiActions.setSymbolSortDirection(
                        symbolSortDirection === "asc" ? "desc" : "asc"
                      );
                    } else {
                      uiActions.setSymbolSortField("size");
                      uiActions.setSymbolSortDirection("desc");
                    }
                  }}
                >
                  <TableSortLabel
                    active={symbolSortField === "size"}
                    direction={
                      symbolSortField === "size" ? symbolSortDirection : "asc"
                    }
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: symbolSortField === "size" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Size
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleSymbolColumnResizeStart("size")}
                    isResizing={resizingColumn === "size"}
                  />
                </Box>
                {/* Type Column Header */}
                <Box
                  sx={{
                    width: `${symbolColumnWidths.type}px`,
                    minWidth: `${symbolColumnWidths.type}px`,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                    position: "relative",
                  }}
                >
                  <TableSortLabel
                    active={symbolSortField === "type"}
                    direction={
                      symbolSortField === "type" ? symbolSortDirection : "asc"
                    }
                    onClick={() => {
                      const isAsc =
                        symbolSortField === "type" &&
                        symbolSortDirection === "asc";
                      uiActions.setSymbolSortDirection(isAsc ? "desc" : "asc");
                      uiActions.setSymbolSortField("type");
                    }}
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: symbolSortField === "type" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Type
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleSymbolColumnResizeStart("type")}
                    isResizing={resizingColumn === "type"}
                  />
                </Box>
                {/* Scope Column Header */}
                <Box
                  sx={{
                    width: `${symbolColumnWidths.scope}px`,
                    minWidth: `${symbolColumnWidths.scope}px`,
                    px: 1,
                    py: 1,
                    fontSize: "11px",
                    fontWeight: 600,
                    position: "relative",
                  }}
                >
                  <TableSortLabel
                    active={symbolSortField === "scope"}
                    direction={
                      symbolSortField === "scope" ? symbolSortDirection : "asc"
                    }
                    onClick={() => {
                      const isAsc =
                        symbolSortField === "scope" &&
                        symbolSortDirection === "asc";
                      uiActions.setSymbolSortDirection(isAsc ? "desc" : "asc");
                      uiActions.setSymbolSortField("scope");
                    }}
                    sx={{
                      fontSize: "11px",
                      "& .MuiTableSortLabel-icon": {
                        opacity: symbolSortField === "scope" ? 1 : 0,
                      },
                      "&:hover .MuiTableSortLabel-icon": {
                        opacity: 0.5,
                      },
                      "&.Mui-active .MuiTableSortLabel-icon": {
                        opacity: 1,
                      },
                    }}
                  >
                    Scope
                  </TableSortLabel>
                  <ColumnResizer
                    onMouseDown={handleSymbolColumnResizeStart("scope")}
                    isResizing={resizingColumn === "scope"}
                  />
                </Box>
                {/* Flags Column Header (iOS/macOS only) */}
                {isMachoTarget && (
                  <Box
                    sx={{
                      width: `${symbolColumnWidths.flags}px`,
                      minWidth: `${symbolColumnWidths.flags}px`,
                      px: 1,
                      py: 1,
                      fontSize: "11px",
                      fontWeight: 600,
                      position: "relative",
                    }}
                  >
                    <Typography sx={{ fontSize: "11px", fontWeight: 600 }}>
                      Flags
                    </Typography>
                    <ColumnResizer
                      onMouseDown={handleSymbolColumnResizeStart("flags")}
                      isResizing={resizingColumn === "flags"}
                    />
                  </Box>
                )}
              </Box>
              {/* Virtualized List Body */}
              <List
                style={{
                  height: Math.min(
                    filteredSymbols.length * SYMBOL_ROW_HEIGHT,
                    window.innerHeight - 350
                  ),
                }}
                rowCount={filteredSymbols.length}
                rowHeight={SYMBOL_ROW_HEIGHT}
                rowProps={{
                  data: {
                    symbols: filteredSymbols,
                    formatFileSize,
                    demangleEnabled: symbolDemangleEnabled,
                    demangledNames,
                    columnWidths: symbolColumnWidths,
                    isMachoTarget,
                    moduleName: (() => {
                      const fullPath =
                        selectedModuleForSymbols?.modulename ||
                        selectedModuleForSymbols?.name ||
                        "";
                      return (
                        fullPath.split("/").pop()?.split("\\").pop() || fullPath
                      );
                    })(),
                    moduleBase: selectedModuleBase,
                  },
                }}
                rowComponent={SymbolRow as any}
              />
            </Paper>
          )}
        </TabPanel>
      </Box>
    </Box>
  );
};
