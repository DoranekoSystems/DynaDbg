import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from "react";
import {
  Box,
  Typography,
  LinearProgress,
  Tabs,
  Tab,
  TextField,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  InputLabel,
  Select,
  useMediaQuery,
  Paper,
  Popover,
  ListSubheader,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  FormControlLabel,
  Radio,
  RadioGroup,
} from "@mui/material";
import {
  MoreVert,
  Edit,
  Delete,
  Bookmark,
  Storage,
  BookmarkBorderOutlined,
  Add as AddIcon,
  Stop,
  BugReport,
  History,
  Search,
  FilterList,
  ArrowUpward,
  ArrowDownward,
  Map as MapIcon,
} from "@mui/icons-material";
import { borderColors } from "../utils/theme";
import { MainContent, TabContent, TabPanelProps } from "../utils/constants";
import { useAppState } from "../hooks/useAppState";
import { useColumnResize } from "../hooks/useColumnResize";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { ColumnResizer } from "./ColumnResizer";
import { getApiClient } from "../lib/api";
import {
  normalizeAddressString,
  isLibraryExpression,
  encodeAddressToLibraryExpression,
} from "../utils/addressEncoder";
import {
  ScanResult,
  ScanValueType,
  BookmarkItem,
  WatchpointAccessType,
  WatchpointSize,
  ScanHistoryItem,
} from "../types/index";

// Helper function to format bytes to human readable format
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Tab Panel Component
function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`scanner-tabpanel-${index}`}
      aria-labelledby={`scanner-tab-${index}`}
      {...other}
    >
      {value === index && (
        <Paper
          sx={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
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

/**
 * ScannerContent Component
 *
 * フィルタの進捗監視とサーバー側の整合性チェックの実装例:
 *
 * const handleFilter = async (filterParams) => {
 *   setIsFiltering(true);
 *   setFilterProgress(0);
 *
 *   try {
 *     // 1. フィルタ操作を開始
 *     const response = await api.memoryFilter(filterParams);
 *     if (!response.success) {
 *       throw new Error(response.message || 'Filter failed');
 *     }
 *
 *     const filterId = response.data.filter_id;
 *
 *     // 2. 進捗を監視するポーリング
 *     const pollInterval = setInterval(async () => {
 *       try {
 *         const progressResponse = await api.getFilterProgress(filterId);
 *         if (!progressResponse.success) {
 *           throw new Error('Failed to get filter progress');
 *         }
 *
 *         const {
 *           progress_percentage,
 *           is_filtering,
 *           processed_results,
 *           total_results
 *         } = progressResponse.data;
 *
 *         setFilterProgress(progress_percentage);
 *
 *         // 3. フィルタが完了したかチェック
 *         if (!is_filtering && progress_percentage >= 100) {
 *           clearInterval(pollInterval);
 *           setIsFiltering(false);
 *
 *           // 4. 結果が準備できてからfetch
 *           if (total_results > 0 || processed_results >= 0) {
 *             await fetchFilteredResults(filterId);
 *           }
 *         }
 *       } catch (error) {
 *         console.error('Progress polling error:', error);
 *         clearInterval(pollInterval);
 *         setIsFiltering(false);
 *       }
 *     }, 200); // 200msごとにポーリング
 *
 *     // 5. タイムアウト処理 (30秒)
 *     setTimeout(() => {
 *       if (isFiltering) {
 *         clearInterval(pollInterval);
 *         setIsFiltering(false);
 *         console.error('Filter timeout');
 *       }
 *     }, 30000);
 *
 *   } catch (error) {
 *     console.error('Filter error:', error);
 *     setIsFiltering(false);
 *   }
 * };
 *
 * // サーバー側レスポンスフォーマット例:
 * // {
 * //   "success": true,
 * //   "data": {
 * //     "filter_id": "scan_1753605446953_z7uq124ap",
 * //     "progress_percentage": 75,
 * //     "processed_results": 1500,
 * //     "total_results": 2000,
 * //     "is_filtering": true,
 * //     "current_region": "heap"
 * //   }
 * // }
 */

interface ScannerContentProps {
  // Legacy props for backward compatibility - now optional
  scanResults?: ScanResult[];
  isScanning?: boolean;
  isFiltering?: boolean;
  filterProgress?: number;
  scanProgress?: number;
  totalResults?: number;
  scannedBytes?: number;
  totalBytes?: number;
  currentRegion?: string;
  currentScanId?: string;

  // Required callback props
  onResultEdit: (
    address: string,
    newValue: string,
    valueType: ScanValueType,
    inputFormat?: "dec" | "hex"
  ) => void;
  onResultDelete: (address: string) => void;
  onResultBookmark: (address: string, bookmarked: boolean) => void;
  onMemoryRead?: (address: string, size: number) => Promise<ArrayBuffer>;
  onStopScan?: () => Promise<void>;

  // Bookmark props
  bookmarks?: BookmarkItem[];
  onAddManualBookmark?: (
    address: string,
    valueType: ScanValueType,
    description?: string,
    libraryExpression?: string,
    size?: number,
    displayFormat?: "dec" | "hex",
    ptrValueType?: Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">
  ) => Promise<boolean>;
  onUpdateBookmark?: (bookmarkId: string, updates: Partial<BookmarkItem>) => void;
  onRemoveBookmark?: (bookmarkId: string) => void;
  isAddressBookmarked?: (address: string) => boolean;
  attachedModules?: any[]; // ModuleInfo array for library+offset parsing

  // Watchpoint props
  onSetWatchpoint?: (
    address: string,
    size: WatchpointSize,
    accessType: WatchpointAccessType,
    description?: string
  ) => Promise<boolean>;
  onRemoveWatchpoint?: (address: string) => Promise<boolean>;
  // watchpoints?: WatchpointInfo[]; // Now using global state
  // isAddressWatched?: (address: string) => boolean; // Now using global state

  // History props
  scanHistory?: ScanHistoryItem[];
  onSelectHistory?: (item: ScanHistoryItem) => void;
  onRemoveHistoryItem?: (id: string) => void;
  onClearHistory?: () => void;

  // Tab control
  currentTab?: number;
  onTabChange?: (tabIndex: number) => void;

  // History search with execution
  onExecuteHistorySearch?: (item: ScanHistoryItem) => void;
}

// Virtual table constants
const ROW_HEIGHT = 32;
const COMPACT_ROW_HEIGHT = 24;
const HEADER_HEIGHT = 36;
const COMPACT_HEADER_HEIGHT = 28;

export const ScannerContent: React.FC<ScannerContentProps> = ({
  // Legacy props (now optional)
  scanResults: propsScanResults,
  isScanning: propsIsScanning,
  isFiltering: propsIsFiltering = false,
  filterProgress: propsFilterProgress = 0,
  scanProgress: propsScanProgress = 0,
  totalResults: propsTotalResults,
  scannedBytes: propsScannedBytes = 0,
  totalBytes: propsTotalBytes = 0,
  currentRegion: propsCurrentRegion,
  currentScanId: propsCurrentScanId,

  // Required callback props
  onResultEdit,
  onResultDelete,
  onResultBookmark,
  onMemoryRead,
  onStopScan,

  // Bookmark props
  bookmarks = [],
  onAddManualBookmark,
  onUpdateBookmark,
  onRemoveBookmark,
  isAddressBookmarked,
  attachedModules = [],
  // Watchpoint props
  onSetWatchpoint,
  // onRemoveWatchpoint, // Not used in this component
  // watchpoints = [], // Now using global state
  // isAddressWatched, // Now using global state
  // History props
  scanHistory = [],
  onSelectHistory,
  onRemoveHistoryItem,
  onClearHistory,
  // Tab control
  currentTab: externalCurrentTab,
  onTabChange,
  // History search with execution
  onExecuteHistorySearch,
}) => {
  // Use global app state
  const { ui, system } = useAppState();

  // Get watchpoints from global state
  const watchpoints = system.watchpoints || [];

  // Helper function to normalize address for comparison (remove 0x prefix, lowercase)
  const normalizeAddress = useCallback((addr: string): string => {
    const stripped = addr.toLowerCase().replace(/^0x/, "");
    return stripped;
  }, []);

  // Helper function to format pointer expression for display
  // Converts [[base+0x10]+0x18] to "base → [+0x10] → [+0x18]"
  const _formatPointerExpressionForDisplay = useCallback((expr: string): string => {
    // Extract all parts by matching the pattern
    const fullPattern = /([A-Za-z0-9_.\-]+\+0x[0-9A-Fa-f]+|\+0x[0-9A-Fa-f]+)/g;
    const matches = expr.match(fullPattern);
    
    if (!matches || matches.length === 0) {
      return expr;
    }
    
    // First match is the base, rest are offsets
    const base = matches[0];
    const offsets = matches.slice(1);
    
    // Build readable format: base → [+0x10] → [+0x18]
    let result = base;
    for (const offset of offsets) {
      result += ` → [${offset}]`;
    }
    
    return result;
  }, []);
  void _formatPointerExpressionForDisplay; // Reserved for future use

  // Helper function to check if an address is watched
  const isAddressWatched = useCallback(
    (address: string): boolean => {
      const normalizedInput = normalizeAddress(address);
      return watchpoints.some(
        (w) => normalizeAddress(String(w.address)) === normalizedInput
      );
    },
    [watchpoints, normalizeAddress]
  );

  // Use app state with fallback to props (for backward compatibility)
  const scanResults = ui.scannerState.scanResults || propsScanResults || [];
  const isScanning = ui.scannerState.isScanning ?? propsIsScanning ?? false;
  const isFiltering = propsIsFiltering; // UI state doesn't have isFiltering yet
  const filterProgress = propsFilterProgress;
  const scanProgress = ui.scannerState.scanProgress ?? propsScanProgress ?? 0;
  const totalResults = ui.scannerState.totalResults ?? propsTotalResults ?? 0;
  const scannedBytes = propsScannedBytes;
  const totalBytes = propsTotalBytes;
  const currentRegion = ui.scannerState.currentRegion ?? propsCurrentRegion;
  const currentScanId = ui.scannerState.scanId ?? propsCurrentScanId;
  const scanSettings = ui.scannerState.scanSettings;
  const unknownScanId = ui.scannerState.unknownScanId;
  
  // Check if this is PTR scan mode
  const isPtrScanMode = (scanSettings as { searchMode?: string })?.searchMode === "ptr";

  // Check if this is an unknown scan that hasn't been narrowed down yet
  // totalResults === -1 means unknown scan with too many results to display
  const isUnknownScanPending = unknownScanId && totalResults === -1;

  const isCompactHeight = useMediaQuery("(max-height: 800px)");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [currentTab, setCurrentTab] = useState(0);
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    address: string;
  } | null>(null);

  // Bookmark context menu state
  const [bookmarkContextMenu, setBookmarkContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    bookmark: BookmarkItem;
  } | null>(null);

  // Use external tab control if provided, otherwise use internal state
  const activeTab =
    externalCurrentTab !== undefined ? externalCurrentTab : currentTab;

  const handleTabChange = useCallback(
    (newValue: number) => {
      if (onTabChange) {
        onTabChange(newValue);
      } else {
        setCurrentTab(newValue);
      }
    },
    [onTabChange]
  );

  // Edit dialog state
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    address: string;
    currentValue: string; // Formatted display value
    rawValue: string; // Raw decimal value for conversions
    valueType: ScanValueType | null;
    ptrValueType?: Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">; // For ptr type: the underlying value type
    newValue: string;
    inputFormat: "dec" | "hex";
    bookmarkId?: string; // For updating bookmark type without writing value
  }>({
    open: false,
    address: "",
    currentValue: "",
    rawValue: "",
    valueType: null,
    ptrValueType: "int32",
    newValue: "",
    inputFormat: "dec",
    bookmarkId: undefined,
  });

  // Manual bookmark dialog state
  const [manualBookmarkDialog, setManualBookmarkDialog] = useState<{
    open: boolean;
    address: string;
    valueType: ScanValueType;
    ptrValueType: Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">; // For ptr type: the underlying value type
    size: number;
    description: string;
    displayFormat: "dec" | "hex";
  }>({
    open: false,
    address: "",
    valueType: "int32",
    ptrValueType: "int32",
    size: 4,
    description: "",
    displayFormat: "dec",
  });

  // Watchpoint dialog state
  const [watchpointDialog, setWatchpointDialog] = useState<{
    open: boolean;
    address: string;
    size: WatchpointSize;
    accessType: WatchpointAccessType;
    description: string;
  }>({
    open: false,
    address: "",
    size: 4,
    accessType: "rw",
    description: "",
  });

  // PointerMap generation state
  const [isGeneratingPointerMap, setIsGeneratingPointerMap] = useState(false);
  const [pointerMapStatus, setPointerMapStatus] = useState<{
    message: string;
    type: "info" | "success" | "error";
  } | null>(null);

  // Filter state for Scan Results (persisted in localStorage)
  const [moduleFilter, setModuleFilter] = useLocalStorage<string>(
    "scanResultsModuleFilter",
    ""
  );

  // Sort state for Address column (persisted in localStorage): "asc" | "desc" | "" (default order)
  const [addressSortOrder, setAddressSortOrder] = useLocalStorage<
    "asc" | "desc" | ""
  >("scanResultsAddressSortOrder", "");

  // Popover state for module filter
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(
    null
  );
  const filterPopoverOpen = Boolean(filterAnchorEl);

  // Column resize state for Scan Results table
  const scanResultsColumnResize = useColumnResize({
    storageKey: "scanResultsColumnWidths",
    defaultWidths: {
      address: 140,
      detail: 200,
      value: 100,
      description: 200,
    },
    minWidth: 40,
    maxWidth: 600,
  });

  // Memory update state
  const [updatedValues, setUpdatedValues] = useState<Map<string, string>>(
    new Map()
  );
  // Bookmark memory update state
  const [updatedBookmarkValues, setUpdatedBookmarkValues] = useState<
    Map<string, string>
  >(new Map());
  const updatedBookmarkValuesRef = useRef<Map<string, string>>(new Map());
  const memoryUpdateInterval = useRef<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    updatedBookmarkValuesRef.current = updatedBookmarkValues;
  }, [updatedBookmarkValues]);

  // Force re-fetch when bookmark ptrValueType changes
  const bookmarkTypesKey = useMemo(() => {
    return bookmarks.map(b => `${b.id}:${b.ptrValueType || ''}:${b.type}`).join(',');
  }, [bookmarks]);

  // Track last update time to avoid too frequent re-renders
  const lastBookmarkUpdateRef = useRef<number>(0);

  // Compute library+offset expressions for all scan results (needed for filtering)
  const addressDetails = useMemo(() => {
    const detailsMap = new Map<string, string>();
    if (!attachedModules || attachedModules.length === 0) {
      return detailsMap;
    }

    scanResults.forEach((result) => {
      const addressNum = parseInt(result.address.replace("0x", ""), 16);
      if (isNaN(addressNum)) return;

      const libraryExpr = encodeAddressToLibraryExpression(
        addressNum,
        attachedModules,
        true // prefer short filename
      );

      if (libraryExpr) {
        detailsMap.set(result.address, libraryExpr);
      }
    });

    return detailsMap;
  }, [scanResults, attachedModules]);

  // Get unique module names that appear in scan results for filter dropdown
  const availableModules = useMemo(() => {
    const moduleNames = new Set<string>();
    addressDetails.forEach((detail) => {
      // Extract module name from detail (e.g., "libfoo.dylib + 0x1234" -> "libfoo.dylib")
      const moduleName = detail.split(" + ")[0].trim();
      if (moduleName) {
        moduleNames.add(moduleName);
      }
    });
    return Array.from(moduleNames).sort();
  }, [addressDetails]);

  // Filter scan results based on selected module
  const filteredScanResults = useMemo(() => {
    if (!moduleFilter) {
      return scanResults;
    }

    if (moduleFilter === "__within_modules__") {
      // Show only addresses within any module
      return scanResults.filter((result) => {
        return addressDetails.has(result.address);
      });
    }

    if (moduleFilter === "__outside_modules__") {
      // Show only addresses outside all modules
      return scanResults.filter((result) => {
        return !addressDetails.has(result.address);
      });
    }

    // Filter by specific module name
    return scanResults.filter((result) => {
      const detail = addressDetails.get(result.address);
      if (!detail) return false;
      // Extract module name from detail (e.g., "libfoo.dylib + 0x1234" -> "libfoo.dylib")
      const moduleName = detail.split(" + ")[0].trim();
      return moduleName === moduleFilter;
    });
  }, [scanResults, moduleFilter, addressDetails]);

  // Sort filtered results by address if sort order is set
  const sortedScanResults = useMemo(() => {
    if (!addressSortOrder) {
      return filteredScanResults;
    }

    return [...filteredScanResults].sort((a, b) => {
      const addrA = parseInt(a.address.replace("0x", ""), 16);
      const addrB = parseInt(b.address.replace("0x", ""), 16);
      return addressSortOrder === "asc" ? addrA - addrB : addrB - addrA;
    });
  }, [filteredScanResults, addressSortOrder]);

  // Parse PTR scan results to get pointer chains
  // Each result.value is in format: "module+0x1234 | 0x8 | 0x10"
  const ptrScanData = useMemo((): { 
    maxOffsets: number; 
    parsedResults: Array<{
      address: string;
      baseAddress: string;
      offsets: string[];
      originalResult: typeof sortedScanResults[0];
    }>;
  } => {
    if (!isPtrScanMode) return { maxOffsets: 0, parsedResults: [] };
    
    let maxOffsets = 0;
    const parsedResults = sortedScanResults.map(result => {
      const parts = result.value.split(" | ");
      const baseAddress = parts[0] || "";
      const offsets = parts.slice(1);
      maxOffsets = Math.max(maxOffsets, offsets.length);
      return {
        address: result.address,
        baseAddress,
        offsets,
        originalResult: result,
      };
    });
    
    return { maxOffsets, parsedResults };
  }, [isPtrScanMode, sortedScanResults]);

  const bookmarkUpdateInterval = useRef<number | null>(null);

  // Virtual scrolling state
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(800); // より大きな初期値

  // PTR virtual scrolling state
  const ptrContainerRef = useRef<HTMLDivElement>(null);
  const [ptrScrollTop, setPtrScrollTop] = useState(0);
  const [ptrContainerHeight, setPtrContainerHeight] = useState(400);

  // Bookmark table column widths
  const [bookmarkColumnWidths, setBookmarkColumnWidths] = useState({
    address: 180,
    type: 80,
    value: 120,
    description: 200,
  });
  const [resizingBookmarkColumn, setResizingBookmarkColumn] = useState<
    string | null
  >(null);

  // Bookmark column resize handlers
  const handleBookmarkColumnResizeStart =
    (column: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizingBookmarkColumn(column);
      const startX = e.clientX;
      const startWidth =
        bookmarkColumnWidths[column as keyof typeof bookmarkColumnWidths];

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const diff = moveEvent.clientX - startX;
        const newWidth = Math.max(50, startWidth + diff);
        setBookmarkColumnWidths((prev) => ({
          ...prev,
          [column]: newWidth,
        }));
      };

      const handleMouseUp = () => {
        setResizingBookmarkColumn(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    };

  // Bookmark context menu handlers
  const handleBookmarkContextMenu = useCallback(
    (event: React.MouseEvent, bookmark: BookmarkItem) => {
      event.preventDefault();
      setBookmarkContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        bookmark,
      });
    },
    []
  );

  const handleCloseBookmarkContextMenu = useCallback(() => {
    setBookmarkContextMenu(null);
  }, []);

  const handleCopyBookmarkAddress = useCallback(() => {
    if (bookmarkContextMenu?.bookmark) {
      const addr = bookmarkContextMenu.bookmark.address;
      const formatted =
        addr.startsWith("0x") || addr.startsWith("0X")
          ? `0x${addr.slice(2).toUpperCase()}`
          : addr.toUpperCase();
      navigator.clipboard.writeText(formatted);
    }
    handleCloseBookmarkContextMenu();
  }, [bookmarkContextMenu, handleCloseBookmarkContextMenu]);

  const handleCopyBookmarkType = useCallback(() => {
    if (bookmarkContextMenu?.bookmark) {
      navigator.clipboard.writeText(bookmarkContextMenu.bookmark.type);
    }
    handleCloseBookmarkContextMenu();
  }, [bookmarkContextMenu, handleCloseBookmarkContextMenu]);

  const handleCopyBookmarkValue = useCallback(() => {
    if (bookmarkContextMenu?.bookmark) {
      const currentValue =
        updatedBookmarkValues.get(bookmarkContextMenu.bookmark.address) ||
        bookmarkContextMenu.bookmark.value;
      navigator.clipboard.writeText(currentValue);
    }
    handleCloseBookmarkContextMenu();
  }, [
    bookmarkContextMenu,
    updatedBookmarkValues,
    handleCloseBookmarkContextMenu,
  ]);

  const handleCopyBookmarkDescription = useCallback(() => {
    if (bookmarkContextMenu?.bookmark) {
      navigator.clipboard.writeText(
        bookmarkContextMenu.bookmark.description || ""
      );
    }
    handleCloseBookmarkContextMenu();
  }, [bookmarkContextMenu, handleCloseBookmarkContextMenu]);

  // Generate PointerMap for a specific bookmark address
  const handleGeneratePointerMap = useCallback(async (address: string) => {
    setIsGeneratingPointerMap(true);
    setPointerMapStatus({ message: "Starting PointerMap generation...", type: "info" });
    
    try {
      const api = getApiClient();
      
      // Start pointermap generation with progress tracking
      const startResponse = await api.startPointerMapGeneration();
      if (!startResponse.success) {
        throw new Error(startResponse.message || "Failed to start generation");
      }
      
      const taskId = startResponse.task_id;
      
      // Poll for progress
      let isComplete = false;
      let lastProgress = 0;
      while (!isComplete) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Poll every 500ms
        
        const progress = await api.getPointerMapProgress(taskId);
        
        if (progress.error) {
          throw new Error(progress.error);
        }
        
        // Update status with progress
        const progressPct = Math.round(progress.progress_percentage);
        if (progressPct !== lastProgress || progress.current_phase !== "Scanning memory") {
          lastProgress = progressPct;
          const bytesStr = progress.total_bytes > 0 
            ? ` (${formatBytes(progress.processed_bytes)}/${formatBytes(progress.total_bytes)})`
            : "";
          setPointerMapStatus({ 
            message: `${progress.current_phase}: ${progressPct}%${bytesStr}`, 
            type: "info" 
          });
        }
        
        isComplete = progress.is_complete;
      }
      
      // Download the completed pointermap
      setPointerMapStatus({ message: "Downloading PointerMap data...", type: "info" });
      const pointerMapData = await api.downloadPointerMap(taskId);
      
      // Create default filename with the target address
      const addressHex = address.replace("0x", "").replace("0X", "").toUpperCase();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const defaultFilename = `pointermap_${addressHex}_${timestamp}.dptr`;
      
      setPointerMapStatus({ message: "Saving file...", type: "info" });
      
      // Try to use Tauri save dialog if available
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const dataArray = new Uint8Array(pointerMapData);
        
        const savedPath = await invoke<string | null>("save_binary_file_dialog", {
          title: "Save PointerMap",
          defaultFilename: defaultFilename,
          filterName: "PointerMap Files",
          filterExtensions: ["dptr"],
          data: Array.from(dataArray),
        });
        
        if (savedPath) {
          setPointerMapStatus({ message: `Saved to: ${savedPath}`, type: "success" });
          console.log(`PointerMap saved to: ${savedPath}`);
        } else {
          // User cancelled the dialog
          setPointerMapStatus(null);
        }
      } catch (tauriError) {
        // Fallback to browser download if Tauri is not available
        console.log("Tauri not available, using browser download");
        const blob = new Blob([pointerMapData], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        setPointerMapStatus({ message: `Downloaded: ${defaultFilename}`, type: "success" });
        console.log(`PointerMap saved as ${defaultFilename}`);
      }
      
      // Auto-hide success message after 5 seconds
      setTimeout(() => {
        setPointerMapStatus((prev) => 
          prev?.type === "success" ? null : prev
        );
      }, 5000);
      
    } catch (error) {
      console.error("Failed to generate PointerMap:", error);
      setPointerMapStatus({ 
        message: `Failed: ${error instanceof Error ? error.message : "Unknown error"}`, 
        type: "error" 
      });
    } finally {
      setIsGeneratingPointerMap(false);
    }
  }, []);

  // Calculate visible range for virtual scrolling
  const currentRowHeight = isCompactHeight ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  // Ensure at least 10 items are shown even if container height is not calculated yet
  const itemsPerView = Math.max(10, Math.ceil(containerHeight / currentRowHeight));
  const bufferSize = 2; // Small buffer for smooth scrolling
  const visibleStart = Math.max(
    0,
    Math.floor(scrollTop / currentRowHeight) - bufferSize
  );
  const visibleEnd = Math.min(
    visibleStart + itemsPerView + bufferSize * 2,
    scanResults.length
  );

  const visibleResults = useMemo(() => {
    const maxViewableItems = Math.ceil(containerHeight / currentRowHeight);
    console.log(`Virtual scrolling debug:`, {
      visibleStart,
      visibleEnd,
      itemsPerView,
      maxViewableItems,
      containerHeight,
      currentRowHeight,
      totalResults: sortedScanResults.length,
      scrollTop,
      totalContentHeight: sortedScanResults.length * currentRowHeight,
    });
    return sortedScanResults.slice(visibleStart, visibleEnd);
  }, [
    sortedScanResults,
    visibleStart,
    visibleEnd,
    containerHeight,
    scrollTop,
    itemsPerView,
    currentRowHeight,
  ]);

  // Encode visible addresses to library+offset expressions (only for visible rows)
  const visibleAddressDetails = useMemo(() => {
    const detailsMap = new Map<string, string>();
    if (!attachedModules || attachedModules.length === 0) {
      return detailsMap;
    }

    visibleResults.forEach((result) => {
      // Parse address to numeric value
      const addressNum = parseInt(result.address, 16);
      if (!isNaN(addressNum)) {
        // Try to encode to library+offset expression
        const libraryExpr = encodeAddressToLibraryExpression(
          addressNum,
          attachedModules,
          true // prefer short filename
        );
        if (libraryExpr) {
          detailsMap.set(result.address, libraryExpr);
        }
      }
    });

    return detailsMap;
  }, [visibleResults, attachedModules]);

  // Helper function to get data type size
  const getDataTypeSize = useCallback(
    (
      valueType: ScanValueType,
      value?: string,
      explicitSize?: number
    ): number => {
      switch (valueType) {
        case "int8":
        case "uint8":
          return 1;
        case "int16":
        case "uint16":
          return 2;
        case "int32":
        case "uint32":
        case "float":
          return 4;
        case "int64":
        case "uint64":
        case "double":
          return 8;
        case "string":
          // For strings, use explicit size if provided, or value length, otherwise default
          if (explicitSize && explicitSize > 0) {
            return explicitSize;
          }
          // Use the string value length (character count = byte count for ASCII)
          if (value && value.length > 0) {
            return value.length;
          }
          return 64; // Default size for string bookmarks
        case "bytes":
          // For bytes, use explicit size if provided
          if (explicitSize && explicitSize > 0) {
            return explicitSize;
          }
          // Fallback: try to calculate from value
          if (value) {
            // Remove spaces and calculate byte length
            const cleanHex = value.toString().replace(/\s/g, "");
            return Math.max(cleanHex.length / 2, 1); // Each pair of hex chars = 1 byte, minimum 1
          }
          return 4; // Default to 4 bytes if no value or size
        case "regex":
          // For regex type, use explicit size if provided, or value length (UTF-8 encoded)
          if (explicitSize && explicitSize > 0) {
            return explicitSize;
          }
          // Use the string value length (UTF-8 byte length)
          if (value && value.length > 0) {
            // Calculate UTF-8 byte length
            const encoder = new TextEncoder();
            return encoder.encode(value).length;
          }
          return 64; // Default size for regex matches
        default:
          return 4;
      }
    },
    []
  );

  // Helper function to convert ArrayBuffer to value based on type
  const convertArrayBufferToValue = useCallback(
    (buffer: ArrayBuffer, valueType: ScanValueType): string => {
      const view = new DataView(buffer);
      const byteLength = buffer.byteLength;
      
      // Helper to check buffer size and return default if insufficient
      const checkSize = (requiredBytes: number): boolean => {
        return byteLength >= requiredBytes;
      };
      
      try {
        switch (valueType) {
          case "int8":
            return checkSize(1) ? view.getInt8(0).toString() : "0";
          case "uint8":
            return checkSize(1) ? view.getUint8(0).toString() : "0";
          case "int16":
            return checkSize(2) ? view.getInt16(0, true).toString() : "0"; // little-endian
          case "uint16":
            return checkSize(2) ? view.getUint16(0, true).toString() : "0"; // little-endian
          case "int32":
            return checkSize(4) ? view.getInt32(0, true).toString() : "0";
          case "uint32":
            return checkSize(4) ? view.getUint32(0, true).toString() : "0"; // little-endian
          case "int64":
            return checkSize(8) ? view.getBigInt64(0, true).toString() : "0";
          case "uint64":
            return checkSize(8) ? view.getBigUint64(0, true).toString() : "0"; // little-endian
          case "float":
            return checkSize(4) ? view.getFloat32(0, true).toString() : "0";
          case "double":
            return checkSize(8) ? view.getFloat64(0, true).toString() : "0";
          case "string":
            // Convert buffer to string, handling null termination
            const uint8Array = new Uint8Array(buffer);
            let str = "";
            for (let i = 0; i < uint8Array.length; i++) {
              const byte = uint8Array[i];
              if (byte === 0) break; // Stop at null terminator
              // Only include printable ASCII characters
              if (byte >= 32 && byte <= 126) {
                str += String.fromCharCode(byte);
              }
              // Non-printable characters are ignored
            }
            return str; // Return empty string if no printable characters
          case "bytes":
            // For bytes type, return space-separated hex format like "11 22 33"
            return Array.from(new Uint8Array(buffer))
              .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
              .join(" ");
          case "regex": {
            // For regex type, convert bytes to UTF-8 string
            const uint8ArrayRegex = new Uint8Array(buffer);
            try {
              const decoder = new TextDecoder("utf-8", { fatal: false });
              return decoder.decode(uint8ArrayRegex);
            } catch (error) {
              // Fallback to hex display
              return Array.from(uint8ArrayRegex)
                .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                .join(" ");
            }
          }
          default:
            return Array.from(new Uint8Array(buffer))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
              .toUpperCase();
        }
      } catch (error) {
        console.error("Failed to convert buffer to value:", error);
        // Return empty string for string type, "0" for others
        return valueType === "string" ? "" : "0";
      }
    },
    []
  );

  // Function to update memory values for bookmarks
  const updateBookmarkMemoryValues = useCallback(async () => {
    if (!onMemoryRead || bookmarks.length === 0) return;

    try {
      const updatePromises = bookmarks.map(async (bookmark) => {
        try {
          // For PTR type, resolve the pointer chain first
          if (bookmark.type === "ptr") {
            const api = getApiClient();
            const resolveResult = await api.resolveAddress(bookmark.address);
            if (resolveResult.success && resolveResult.data?.address) {
              const resolvedAddr = `0x${resolveResult.data.address.toString(16).toUpperCase()}`;
              // Always read 8 bytes for PTR type, mask based on ptrValueType for display
              const buffer = await onMemoryRead(resolvedAddr, 8);
              const view = new DataView(buffer);
              const fullValue = view.getBigUint64(0, true);
              
              // Mask based on ptrValueType for display
              const ptrValueType = bookmark.ptrValueType || "int32";
              let maskedValue: bigint;
              switch (ptrValueType) {
                case "int8":
                case "uint8":
                  maskedValue = fullValue & 0xFFn;
                  break;
                case "int16":
                case "uint16":
                  maskedValue = fullValue & 0xFFFFn;
                  break;
                case "int32":
                case "uint32":
                case "float":
                  maskedValue = fullValue & 0xFFFFFFFFn;
                  break;
                default:
                  maskedValue = fullValue;
              }
              return { id: bookmark.id, value: maskedValue.toString() };
            }
            // Resolve failed - keep previous value or use stored value
            const previousValue = updatedBookmarkValuesRef.current.get(bookmark.id);
            return { id: bookmark.id, value: previousValue || bookmark.value };
          }
          
          const size = getDataTypeSize(
            bookmark.type,
            bookmark.value,
            bookmark.size
          );
          const buffer = await onMemoryRead(bookmark.address, size);
          const newValue = convertArrayBufferToValue(buffer, bookmark.type);
          return { id: bookmark.id, value: newValue };
        } catch (error) {
          // Memory read failed, keep old value
          const previousValue = updatedBookmarkValuesRef.current.get(bookmark.id);
          return { id: bookmark.id, value: previousValue || bookmark.value };
        }
      });

      const updates = await Promise.all(updatePromises);
      const newUpdatedValues = new Map<string, string>();

      updates.forEach(({ id, value }) => {
        newUpdatedValues.set(id, String(value));
      });

      setUpdatedBookmarkValues(newUpdatedValues);
    } catch (error) {
      console.error("Failed to update bookmark memory values:", error);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMemoryRead, bookmarks, getDataTypeSize, convertArrayBufferToValue, bookmarkTypesKey]);

  // Function to update memory values for visible results
  const updateMemoryValues = useCallback(async () => {
    if (
      !onMemoryRead ||
      isScanning ||
      isFiltering ||
      visibleResults.length === 0
    )
      return;

    try {
      const updatePromises = visibleResults.map(async (result) => {
        try {
          const size = getDataTypeSize(result.type, String(result.value));
          const buffer = await onMemoryRead(result.address, size);
          const newValue = convertArrayBufferToValue(buffer, result.type);
          return { address: result.address, value: newValue };
        } catch (error) {
          // Memory read failed, keep old value
          return { address: result.address, value: result.value };
        }
      });

      const updates = await Promise.all(updatePromises);
      const newUpdatedValues = new Map<string, string>();

      updates.forEach(({ address, value }) => {
        newUpdatedValues.set(address, String(value));
      });

      setUpdatedValues(newUpdatedValues);
    } catch (error) {
      console.error("Failed to update memory values:", error);
    }
  }, [
    onMemoryRead,
    isScanning,
    isFiltering,
    visibleResults,
    getDataTypeSize,
    convertArrayBufferToValue,
  ]);

  // Start/stop memory update interval
  useEffect(() => {
    if (activeTab === 0 && !isScanning && !isFiltering && onMemoryRead) {
      // Start memory updates every 400ms for scan results
      memoryUpdateInterval.current = setInterval(updateMemoryValues, 400);

      return () => {
        if (memoryUpdateInterval.current) {
          clearInterval(memoryUpdateInterval.current);
          memoryUpdateInterval.current = null;
        }
      };
    } else {
      // Stop memory updates
      if (memoryUpdateInterval.current) {
        clearInterval(memoryUpdateInterval.current);
        memoryUpdateInterval.current = null;
      }
    }
  }, [activeTab, isScanning, isFiltering, onMemoryRead, updateMemoryValues]);

  // Start/stop bookmark memory update interval
  useEffect(() => {
    if (activeTab === 1 && onMemoryRead && bookmarks.length > 0) {
      // Start bookmark memory updates every 200ms
      bookmarkUpdateInterval.current = setInterval(
        updateBookmarkMemoryValues,
        200
      );

      return () => {
        if (bookmarkUpdateInterval.current) {
          clearInterval(bookmarkUpdateInterval.current);
          bookmarkUpdateInterval.current = null;
        }
      };
    } else {
      // Stop bookmark memory updates
      if (bookmarkUpdateInterval.current) {
        clearInterval(bookmarkUpdateInterval.current);
        bookmarkUpdateInterval.current = null;
      }
    }
  }, [activeTab, onMemoryRead, bookmarks.length, updateBookmarkMemoryValues]);

  // Trigger immediate update when bookmark types change
  useEffect(() => {
    if (activeTab === 1 && onMemoryRead && bookmarks.length > 0) {
      // Immediate update - don't wait for interval
      const now = Date.now();
      if (now - lastBookmarkUpdateRef.current > 100) {
        lastBookmarkUpdateRef.current = now;
        updateBookmarkMemoryValues();
      }
    }
  }, [activeTab, onMemoryRead, bookmarks, bookmarkTypesKey, updateBookmarkMemoryValues]);

  // Debug watchpoint dialog state changes
  useEffect(() => {
    console.log("Watchpoint dialog state changed:", watchpointDialog);
  }, [watchpointDialog]);
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        // Use the actual container height
        const actualHeight = rect.height;
        if (actualHeight > 0) {
          // 有効な高さのみ設定
          console.log(
            "Container height updated:",
            actualHeight,
            "Previous height:",
            containerHeight
          );
          setContainerHeight(actualHeight);
        }
      }
    };

    // 初期設定
    updateHeight();

    // 少し遅延させて再度実行（レンダリング完了後）
    const timer1 = setTimeout(updateHeight, 100);
    const timer2 = setTimeout(updateHeight, 500);

    // Use ResizeObserver for more accurate height tracking
    let resizeObserver: ResizeObserver | null = null;
    if (containerRef.current && window.ResizeObserver) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.contentRect.height;
          if (height > 0) {
            console.log("ResizeObserver: Container height changed to:", height);
            setContainerHeight(height);
          }
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    // PTR container ResizeObserver
    let ptrResizeObserver: ResizeObserver | null = null;
    if (ptrContainerRef.current && window.ResizeObserver) {
      ptrResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.contentRect.height;
          if (height > 0) {
            setPtrContainerHeight(height);
          }
        }
      });
      ptrResizeObserver.observe(ptrContainerRef.current);
    }

    const handleResize = () => {
      setTimeout(updateHeight, 100);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      window.removeEventListener("resize", handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (ptrResizeObserver) {
        ptrResizeObserver.disconnect();
      }
    };
  }, [isCompactHeight, scanResults.length]); // scanResults.lengthも依存関係に追加

  // Clear selections when scan results change (e.g., after clear)
  useEffect(() => {
    setSelectedRows(new Set());
  }, [scanResults]);

  const handleRowClick = useCallback(
    (address: string, event: React.MouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        // Ctrl/Cmd+Click: Toggle selection
        setSelectedRows((prev) => {
          const newSet = new Set(prev);
          if (newSet.has(address)) {
            newSet.delete(address);
          } else {
            newSet.add(address);
          }
          return newSet;
        });
      } else if (event.shiftKey && selectedRows.size > 0) {
        // Shift+Click: Range selection
        const selectedArray = Array.from(selectedRows);
        const lastSelected = selectedArray[selectedArray.length - 1];
        const lastIndex = scanResults.findIndex(
          (r) => r.address === lastSelected
        );
        const currentIndex = scanResults.findIndex(
          (r) => r.address === address
        );

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeAddresses = scanResults
            .slice(start, end + 1)
            .map((r) => r.address);

          setSelectedRows((prev) => {
            const newSet = new Set(prev);
            rangeAddresses.forEach((addr) => newSet.add(addr));
            return newSet;
          });
        }
      } else {
        // Normal click: Single selection
        setSelectedRows(new Set([address]));
      }
    },
    [selectedRows, scanResults]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, address: string) => {
      event.preventDefault();
      setContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        address,
      });
    },
    []
  );

  const handleContextMenuClose = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleEditStart = useCallback(
    (address: string, currentValue: string) => {
      const result = scanResults.find((r) => r.address === address);
      if (result) {
        setEditDialog({
          open: true,
          address,
          currentValue,
          rawValue: currentValue, // For scan results, raw value is the same as current value (decimal)
          valueType: result.type,
          newValue: currentValue,
          inputFormat: scanSettings?.valueInputFormat || "dec",
          bookmarkId: undefined, // Scan results don't have bookmark ID
        });
      }
      handleContextMenuClose();
    },
    [handleContextMenuClose, scanResults, scanSettings?.valueInputFormat]
  );

  const handleEditDialogClose = useCallback(() => {
    setEditDialog((prev) => ({ ...prev, open: false }));
  }, []);

  const handleEditDialogSave = useCallback(async () => {
    if (editDialog.valueType) {
      try {
        // For ptr type, we need to use the ptrValueType for the actual edit
        const effectiveValueType = editDialog.valueType === "ptr" 
          ? (editDialog.ptrValueType || "int32") 
          : editDialog.valueType;
        
        await onResultEdit(
          editDialog.address,
          editDialog.newValue,
          effectiveValueType,
          editDialog.inputFormat
        );
        handleEditDialogClose();
      } catch (error) {
        console.error("Failed to save edit:", error);
        // Keep dialog open on error
      }
    }
  }, [editDialog, onResultEdit, handleEditDialogClose]);

  const handleManualBookmarkDialogOpen = useCallback(() => {
    setManualBookmarkDialog({
      open: true,
      address: "",
      valueType: "int32",
      ptrValueType: "int32",
      size: 4,
      description: "",
      displayFormat: scanSettings?.valueInputFormat || "dec",
    });
  }, [scanSettings?.valueInputFormat]);

  const handleManualBookmarkDialogClose = useCallback(() => {
    setManualBookmarkDialog((prev) => ({ ...prev, open: false }));
  }, []);

  const handleManualBookmarkDialogSave = useCallback(async () => {
    if (onAddManualBookmark && manualBookmarkDialog.address) {
      try {
        const trimmedAddress = manualBookmarkDialog.address.trim();
        
        console.log("[Bookmark] Adding bookmark with address:", trimmedAddress);
        console.log("[Bookmark] Value type:", manualBookmarkDialog.valueType);

        // Check if the input looks like a pointer expression (arrow format or nested brackets)
        const isArrowFormat = trimmedAddress.includes("→") || trimmedAddress.includes("->");
        const isNestedBracket = trimmedAddress.includes("[[") || (trimmedAddress.startsWith("[") && trimmedAddress.includes("]+"));
        const looksLikePointerExpression = isArrowFormat || isNestedBracket;

        // If user didn't select ptr type but input looks like pointer expression, auto-detect
        if (looksLikePointerExpression && manualBookmarkDialog.valueType !== "ptr") {
          console.log("[Bookmark] Auto-detected pointer expression, switching to ptr type");
          // Handle as ptr type
        }

        // For PTR type OR detected pointer expression, handle pointer expression format
        if (manualBookmarkDialog.valueType === "ptr" || looksLikePointerExpression) {
          console.log("[Bookmark] Detected pointer expression type");
          console.log("[Bookmark] Ptr value type:", manualBookmarkDialog.ptrValueType);
          console.log("[Bookmark] Display format:", manualBookmarkDialog.displayFormat);
          
          // Convert nested format [[base]+0x10]+0x18 to arrow format: base → [0x10] → [0x18]
          let pointerExpression = trimmedAddress;
          
          // Normalize various arrow formats to " → " (with spaces)
          // First, replace -> with →
          pointerExpression = pointerExpression.replace(/->/g, "→");
          // Then normalize spacing around → (remove existing spaces and add consistent ones)
          pointerExpression = pointerExpression.replace(/\s*→\s*/g, " → ");
          
          // Check if it's in nested bracket format [[...]] and convert to arrow format
          if (pointerExpression.includes("[[") || (pointerExpression.startsWith("[") && pointerExpression.includes("]+"))) {
            // Convert [[base+0x10]+0x18]+0x20 to base+0x10 → [0x18] → [0x20]
            // First, extract the innermost base and offsets
            const convertNestedToArrow = (expr: string): string => {
              // Remove outer whitespace
              expr = expr.trim();
              
              // Pattern to match nested pointer format
              // Example: [[Tutorial-x86_64.exe+0x34ECA0]+0x10]+0x18
              const parts: string[] = [];
              let current = expr;
              
              // Extract each level from outside in
              while (current.startsWith("[")) {
                // Find the matching closing bracket and offset
                let depth = 0;
                let closingIndex = -1;
                for (let i = 0; i < current.length; i++) {
                  if (current[i] === "[") depth++;
                  else if (current[i] === "]") {
                    depth--;
                    if (depth === 0) {
                      closingIndex = i;
                      break;
                    }
                  }
                }
                
                if (closingIndex === -1) break;
                
                // Get the offset after the closing bracket
                const after = current.slice(closingIndex + 1);
                const offsetMatch = after.match(/^([+\-]0x[0-9A-Fa-f]+|\+[0-9]+)/i);
                if (offsetMatch) {
                  parts.unshift(offsetMatch[1]);
                }
                
                // Continue with inner content
                current = current.slice(1, closingIndex);
              }
              
              // The remaining current is the base
              if (current) {
                parts.unshift(current);
              }
              
              // Build arrow format: base → [offset1] → [offset2]
              if (parts.length === 0) return expr;
              let result = parts[0];
              for (let i = 1; i < parts.length; i++) {
                result += ` → [${parts[i]}]`;
              }
              return result;
            };
            
            pointerExpression = convertNestedToArrow(pointerExpression);
            console.log("[Bookmark] Converted to arrow format:", pointerExpression);
          }
          
          // Normalize case in the pointer expression (uppercase hex values)
          pointerExpression = pointerExpression.replace(/0x([0-9a-f]+)/gi, (_, hex) => `0x${hex.toUpperCase()}`);
          
          const success = await onAddManualBookmark(
            pointerExpression,
            "ptr",
            manualBookmarkDialog.description || "Pointer chain",
            undefined, // no library expression for ptr
            undefined, // no size for ptr
            manualBookmarkDialog.displayFormat,
            manualBookmarkDialog.ptrValueType
          );

          console.log("[Bookmark] Add result:", success);

          if (success) {
            handleManualBookmarkDialogClose();
          } else {
            alert("Failed to add bookmark. Address may already be bookmarked.");
          }
          return;
        }

        // Non-ptr type handling (original logic)
        let normalizedAddress: string | null;
        let libraryExpression: string | undefined;

        console.log(
          "[Bookmark] Attached modules count:",
          attachedModules?.length || 0
        );

        // Check if it's a library+offset expression
        if (isLibraryExpression(trimmedAddress)) {
          console.log("[Bookmark] Detected library+offset expression");
          // Save the original library expression
          libraryExpression = trimmedAddress;

          normalizedAddress = normalizeAddressString(
            trimmedAddress,
            attachedModules
          );

          console.log("[Bookmark] Normalized address:", normalizedAddress);

          if (!normalizedAddress) {
            console.error(
              "Failed to parse library+offset expression:",
              trimmedAddress
            );
            alert(
              "Failed to parse library+offset expression. Make sure the module is loaded."
            );
            return;
          }
        } else {
          console.log("[Bookmark] Detected direct address");
          // Direct address - normalize (no library expression)
          normalizedAddress = normalizeAddressString(trimmedAddress);

          console.log("[Bookmark] Normalized address:", normalizedAddress);

          if (!normalizedAddress) {
            console.error("Invalid address format:", trimmedAddress);
            alert("Invalid address format");
            return;
          }
        }

        // Ensure uppercase format
        const hexPart = normalizedAddress.replace(/^0x/i, "");
        normalizedAddress = `0x${hexPart.toUpperCase()}`;

        console.log("[Bookmark] Final normalized address:", normalizedAddress);
        console.log("[Bookmark] Library expression:", libraryExpression);
        console.log("[Bookmark] Value type:", manualBookmarkDialog.valueType);
        console.log("[Bookmark] Size:", manualBookmarkDialog.size);
        console.log(
          "[Bookmark] Display format:",
          manualBookmarkDialog.displayFormat
        );

        // Determine size for string/bytes types
        const size =
          manualBookmarkDialog.valueType === "string" ||
          manualBookmarkDialog.valueType === "bytes"
            ? manualBookmarkDialog.size
            : undefined;

        const success = await onAddManualBookmark(
          normalizedAddress,
          manualBookmarkDialog.valueType,
          manualBookmarkDialog.description || undefined,
          libraryExpression,
          size,
          manualBookmarkDialog.displayFormat,
          undefined // no ptrValueType for non-ptr types
        );

        console.log("[Bookmark] Add result:", success);

        if (success) {
          handleManualBookmarkDialogClose();
        } else {
          alert("Failed to add bookmark. Address may already be bookmarked.");
        }
      } catch (error) {
        console.error("Failed to add manual bookmark:", error);
        alert(
          `Error adding bookmark: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        // Keep dialog open on error
      }
    }
  }, [
    manualBookmarkDialog,
    onAddManualBookmark,
    handleManualBookmarkDialogClose,
    attachedModules,
  ]);

  const handleWatchpointDialogOpen = useCallback((address?: string) => {
    console.log("handleWatchpointDialogOpen called with address:", address);
    const newDialog = {
      open: true,
      address: address || "",
      size: 4 as WatchpointSize,
      accessType: "rw" as WatchpointAccessType,
      description: "",
    };
    console.log("Setting watchpoint dialog state:", newDialog);
    setWatchpointDialog(newDialog);
  }, []);

  const handleWatchpointDialogClose = useCallback(() => {
    setWatchpointDialog((prev) => ({ ...prev, open: false }));
  }, []);

  const handleWatchpointDialogSave = useCallback(async () => {
    console.log("handleWatchpointDialogSave called with:", watchpointDialog);
    if (onSetWatchpoint && watchpointDialog.address) {
      try {
        // Normalize address to hex format
        let normalizedAddress = watchpointDialog.address.trim();

        // If address is decimal, convert to hex
        if (!/^0x/i.test(normalizedAddress)) {
          const decimalValue = parseInt(normalizedAddress, 10);
          if (!isNaN(decimalValue)) {
            normalizedAddress = `0x${decimalValue.toString(16).toUpperCase()}`;
          }
        } else {
          // If already hex, ensure proper format (0x + uppercase hex)
          const hexPart = normalizedAddress.slice(2);
          normalizedAddress = `0x${hexPart.toUpperCase()}`;
        }

        console.log("Calling onSetWatchpoint with:", {
          address: normalizedAddress,
          size: watchpointDialog.size,
          accessType: watchpointDialog.accessType,
          description: watchpointDialog.description || undefined,
        });

        const success = await onSetWatchpoint(
          normalizedAddress,
          watchpointDialog.size,
          watchpointDialog.accessType,
          watchpointDialog.description || undefined
        );
        if (success) {
          handleWatchpointDialogClose();
        }
      } catch (error) {
        console.error("Failed to set watchpoint:", error);
        // Keep dialog open on error
      }
    } else {
      console.warn("onSetWatchpoint handler not provided or address is empty");
      // For testing, just close the dialog
      alert(
        `Watchpoint would be set for ${watchpointDialog.address} (${watchpointDialog.size} bytes, ${watchpointDialog.accessType})`
      );
      handleWatchpointDialogClose();
    }
  }, [watchpointDialog, onSetWatchpoint, handleWatchpointDialogClose]);

  const handleEditSave = useCallback(
    async (address: string) => {
      try {
        const result = scanResults.find((r) => r.address === address);
        if (result) {
          await onResultEdit(address, editValue, result.type);
          setEditingRow(null);
          setEditValue("");
        }
      } catch (error) {
        console.error("Failed to save edit:", error);
        // Keep editing mode on error so user can try again
      }
    },
    [editValue, onResultEdit, scanResults]
  );

  const handleEditCancel = useCallback(() => {
    setEditingRow(null);
    setEditValue("");
  }, []);

  const formatValue = useCallback(
    (result: ScanResult) => {
      // Check if we have an updated value from memory reading
      const updatedValue = updatedValues.get(result.address);
      const value = updatedValue || result.value;
      //console.log(updatedValue);

      // Check if hex display is requested for integer types
      const isHexDisplay = scanSettings?.valueInputFormat === "hex";
      const isIntegerType = [
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
        "int64",
        "uint64",
      ].includes(result.type);

      // For bytes type, the value has already been processed by convertHexBytesToValue
      // and should be in the correct format (space-separated hex), so just return it
      if (result.type === "bytes") {
        return value.toString();
      }

      // For regex type, the value should already be a UTF-8 string
      if (result.type === "regex") {
        return value.toString();
      }

      // Special handling for string type - display as readable text
      if (result.type === "string") {
        // If the value is a hex string, try to convert it to readable text
        if (typeof value === "string" && value.startsWith("0x")) {
          try {
            const hexString = value.slice(2); // Remove "0x" prefix
            let text = "";
            for (let i = 0; i < hexString.length; i += 2) {
              const byte = parseInt(hexString.substr(i, 2), 16);
              // Only include printable ASCII characters (32-126) and common extended chars
              if ((byte >= 32 && byte <= 126) || byte === 0) {
                text += byte === 0 ? "" : String.fromCharCode(byte);
              } else {
                // For non-printable characters, show as hex
                text += `\\x${byte.toString(16).padStart(2, "0")}`;
              }
            }
            return text || value; // Return hex if conversion fails
          } catch (error) {
            return value; // Return original value if parsing fails
          }
        }
        // If already a readable string, return as-is
        return value.toString();
      }

      // For integer types with hex display mode
      if (isIntegerType && isHexDisplay) {
        try {
          // Parse the value as a number
          let numValue: bigint | number;
          if (typeof value === "string") {
            if (value.startsWith("0x")) {
              numValue = BigInt(value);
            } else {
              numValue = ["int64", "uint64"].includes(result.type)
                ? BigInt(value)
                : parseInt(value, 10);
            }
          } else {
            numValue = Number(value);
          }
          // Format as hex with 0x prefix (handle signed integers with two's complement)
          let hexStr: string;
          if (typeof numValue === "bigint") {
            if (numValue < 0n) {
              // Two's complement for 64-bit
              const mask = (1n << 64n) - 1n;
              hexStr = (numValue & mask).toString(16).toUpperCase();
            } else {
              hexStr = numValue.toString(16).toUpperCase();
            }
          } else {
            if (numValue < 0) {
              // Two's complement based on type using bitwise AND with proper mask
              let hexStr: string;
              if (result.type === "int8") {
                hexStr = ((numValue & 0xff) >>> 0)
                  .toString(16)
                  .toUpperCase()
                  .padStart(2, "0");
              } else if (result.type === "int16") {
                hexStr = ((numValue & 0xffff) >>> 0)
                  .toString(16)
                  .toUpperCase()
                  .padStart(4, "0");
              } else {
                // int32: >>> 0 converts to unsigned 32-bit
                hexStr = (numValue >>> 0)
                  .toString(16)
                  .toUpperCase()
                  .padStart(8, "0");
              }
              return "0x" + hexStr;
            } else {
              hexStr = numValue.toString(16).toUpperCase();
            }
          }
          return "0x" + hexStr;
        } catch (e) {
          // Fallback to original value
          return value.toString();
        }
      }

      // If value is already a number or formatted string from our converter, display it directly
      if (typeof value === "string" && !value.startsWith("0x")) {
        // For numeric types, display the value as is
        switch (result.type) {
          case "int8":
          case "int16":
          case "int32":
          case "int64":
          case "uint8":
          case "uint16":
          case "uint32":
          case "uint64":
            return value; // Display the converted integer value
          case "float":
          case "double":
            return parseFloat(value).toString(); // Display float value
          default:
            return value;
        }
      } else if (typeof value === "string" && value.startsWith("0x")) {
        // For hex values - if dec mode for integer types, convert to decimal
        if (!isHexDisplay && isIntegerType) {
          try {
            const numValue = ["int64", "uint64"].includes(result.type)
              ? BigInt(value)
              : parseInt(value, 16);
            return numValue.toString();
          } catch {
            return value;
          }
        }
        // Otherwise display as hex
        return value;
      } else {
        // Fallback: try to interpret as number for display
        try {
          const numValue = Number(value);
          if (!isNaN(numValue)) {
            switch (result.type) {
              case "int8":
              case "int16":
              case "int32":
              case "int64":
              case "uint8":
              case "uint16":
              case "uint32":
              case "uint64":
                return numValue.toString();
              case "float":
              case "double":
                return numValue.toString();
              default:
                return value.toString();
            }
          }
        } catch (e) {
          // ignore
        }
        return value.toString();
      }
    },
    [updatedValues, scanSettings?.valueInputFormat]
  );

  return (
    <MainContent sx={{ height: "100%", p: 2 }}>
      {/* Chrome-style tabs */}
      <Box sx={{ display: "flex", alignItems: "flex-end" }}>
        <Tabs
          value={activeTab}
          onChange={(_, newValue) => handleTabChange(newValue)}
          aria-label="scanner tabs"
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
            icon={<Storage sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Results"
            id="scanner-tab-0"
            aria-controls="scanner-tabpanel-0"
            sx={{ gap: 0.5 }}
          />
          <Tab
            icon={<BookmarkBorderOutlined sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="Bookmarks"
            id="scanner-tab-1"
            aria-controls="scanner-tabpanel-1"
            sx={{ gap: 0.5 }}
          />
          <Tab
            icon={<History sx={{ fontSize: "12px" }} />}
            iconPosition="start"
            label="History"
            id="scanner-tab-2"
            aria-controls="scanner-tabpanel-2"
            sx={{ gap: 0.5 }}
          />
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
        <TabPanel value={activeTab} index={0}>
          <TabContent sx={{ overflow: "hidden", height: "100%" }}>
            {isScanning || isFiltering ? (
              <Box sx={{ p: isCompactHeight ? 2 : 3, textAlign: "center" }}>
                <Typography
                  variant="h6"
                  gutterBottom
                  sx={{
                    fontSize: isCompactHeight ? "14px" : "18px",
                    mb: isCompactHeight ? 1 : 2,
                  }}
                >
                  {isScanning ? "Scanning Memory..." : "Filtering Results..."}
                </Typography>
                {isScanning && (
                  <>
                    <LinearProgress
                      variant="determinate"
                      value={scanProgress}
                      sx={{
                        mb: isCompactHeight ? 1 : 2,
                        width: "100%",
                        maxWidth: 400,
                        mx: "auto",
                        height: isCompactHeight ? "4px" : "6px",
                      }}
                    />
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      gutterBottom
                      sx={{
                        fontSize: isCompactHeight ? "10px" : "14px",
                        mb: isCompactHeight ? 0.5 : 1,
                      }}
                    >
                      {scanProgress.toFixed(1)}% complete
                    </Typography>
                    {totalBytes > 0 && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{
                          fontSize: isCompactHeight ? "9px" : "12px",
                        }}
                      >
                        {(scannedBytes / (1024 * 1024)).toFixed(1)} MB /{" "}
                        {(totalBytes / (1024 * 1024)).toFixed(1)} MB
                      </Typography>
                    )}
                    {currentRegion && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{
                          mt: isCompactHeight ? 0.5 : 1,
                          fontSize: isCompactHeight ? "9px" : "12px",
                        }}
                      >
                        Scanning: {currentRegion}
                      </Typography>
                    )}
                    <Box sx={{ mt: isCompactHeight ? 1 : 2 }}>
                      <Button
                        variant="outlined"
                        color="error"
                        startIcon={<Stop />}
                        onClick={async () => {
                          if (onStopScan && currentScanId) {
                            try {
                              await onStopScan();
                            } catch (error) {
                              console.error("Failed to stop scan:", error);
                            }
                          }
                        }}
                        sx={{
                          mr: 1,
                          fontSize: isCompactHeight ? "10px" : "14px",
                          minHeight: isCompactHeight ? "24px" : "32px",
                          padding: isCompactHeight ? "2px 8px" : "4px 12px",
                        }}
                      >
                        Stop Scan
                      </Button>
                    </Box>
                  </>
                )}
                {isFiltering && (
                  <>
                    <LinearProgress
                      variant={
                        filterProgress > 0 ? "determinate" : "indeterminate"
                      }
                      value={filterProgress > 0 ? filterProgress : undefined}
                      sx={{
                        mb: isCompactHeight ? 1 : 2,
                        width: "100%",
                        maxWidth: 400,
                        mx: "auto",
                        height: isCompactHeight ? "4px" : "6px",
                      }}
                    />
                    {filterProgress > 0 && (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        gutterBottom
                        sx={{
                          fontSize: isCompactHeight ? "10px" : "14px",
                          mb: isCompactHeight ? 0.5 : 1,
                        }}
                      >
                        {filterProgress.toFixed(1)}% complete
                      </Typography>
                    )}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      sx={{
                        fontSize: isCompactHeight ? "9px" : "12px",
                      }}
                    >
                      Please wait for filter to complete before viewing results
                    </Typography>
                  </>
                )}
              </Box>
            ) : scanResults.length === 0 ? (
              /* Empty state - no scan results OR unknown scan pending */
              <Box
                sx={{
                  p: isCompactHeight ? 2 : 3,
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                }}
              >
                {isUnknownScanPending ? (
                  /* Unknown scan completed but results too large to display */
                  <>
                    <Storage
                      sx={{
                        fontSize: isCompactHeight ? 32 : 48,
                        color: "info.main",
                        mb: isCompactHeight ? 1 : 2,
                      }}
                    />
                    <Typography
                      variant="h6"
                      gutterBottom
                      sx={{
                        fontSize: isCompactHeight ? "14px" : "18px",
                        mb: isCompactHeight ? 1 : 2,
                      }}
                    >
                      Unknown Scan Complete
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        fontSize: isCompactHeight ? "11px" : "14px",
                        mb: 1,
                      }}
                    >
                      Memory snapshot saved. Use Next Scan to filter results.
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        fontSize: isCompactHeight ? "10px" : "12px",
                      }}
                    >
                      Results will be displayed after narrowing down to ~1M
                      entries
                    </Typography>
                  </>
                ) : (
                  /* Normal empty state */
                  <>
                    <Search
                      sx={{
                        fontSize: isCompactHeight ? 32 : 48,
                        color: "text.disabled",
                        mb: isCompactHeight ? 1 : 2,
                      }}
                    />
                    <Typography
                      variant="h6"
                      gutterBottom
                      sx={{
                        fontSize: isCompactHeight ? "14px" : "18px",
                        mb: isCompactHeight ? 1 : 2,
                      }}
                    >
                      No Scan Results
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        fontSize: isCompactHeight ? "11px" : "14px",
                      }}
                    >
                      Use the scanner panel to search for values in memory
                    </Typography>
                  </>
                )}
              </Box>
            ) : (
              <>
                {/* Header */}
                <Box
                  sx={{
                    p: isCompactHeight ? 1.5 : 2,
                    borderBottom: `1px solid ${borderColors.main}`,
                  }}
                >
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Typography
                      variant="h6"
                      sx={{
                        fontSize: isCompactHeight ? "14px" : "18px",
                      }}
                    >
                      Scan Results
                    </Typography>
                    <Stack direction="row" spacing={2} alignItems="center">
                      {selectedRows.size > 0 && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            fontSize: isCompactHeight ? "10px" : "14px",
                          }}
                        >
                          {selectedRows.size} selected
                        </Typography>
                      )}
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{
                          fontSize: isCompactHeight ? "10px" : "14px",
                        }}
                      >
                        {filteredScanResults.length.toLocaleString()} /{" "}
                        {totalResults.toLocaleString()} results
                      </Typography>
                    </Stack>
                  </Stack>

                  {/* Divider line below Scan Results header */}
                  <Box
                    sx={{
                      mt: 1.5,
                      borderBottom: `1px solid ${borderColors.main}`,
                    }}
                  />
                </Box>

                {/* Virtual Results Table - PTR mode has different structure */}
                {isPtrScanMode ? (
                  /* PTR Scan Results Table - shows pointer chains */
                  <Box
                    sx={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                      overflow: "hidden",
                    }}
                  >
                    {/* PTR Table Header */}
                    <Box
                      sx={{
                        backgroundColor: "#080808",
                        borderBottom: `2px solid ${borderColors.main}`,
                        display: "flex",
                        alignItems: "center",
                        height: isCompactHeight
                          ? COMPACT_HEADER_HEIGHT
                          : HEADER_HEIGHT,
                        px: isCompactHeight ? 1 : 2,
                        overflowX: "auto",
                      }}
                    >
                      {/* Base Address Column */}
                      <Box
                        sx={{
                          width: "auto",
                          minWidth: "150px",
                          maxWidth: "300px",
                          fontWeight: 600,
                          color: "text.primary",
                          fontSize: isCompactHeight ? "11px" : "13px",
                          px: 1,
                        }}
                      >
                        Base Address
                      </Box>
                      {/* Offset Columns - dynamically generated based on max chain length */}
                      {Array.from({ length: ptrScanData.maxOffsets }, (_, i) => (
                        <Box
                          key={`offset-header-${i}`}
                          sx={{
                            width: "auto",
                            minWidth: "70px",
                            maxWidth: "120px",
                            fontWeight: 600,
                            color: "text.primary",
                            fontSize: isCompactHeight ? "11px" : "13px",
                            px: 1,
                            borderLeft: "1px solid #333",
                          }}
                        >
                          Offset {i}
                        </Box>
                      ))}
                      {/* Actions Column */}
                      <Box
                        sx={{
                          width: "48px",
                          fontWeight: 600,
                          color: "text.primary",
                          fontSize: isCompactHeight ? "11px" : "13px",
                          textAlign: "center",
                          marginLeft: "auto",
                        }}
                      >
                        Actions
                      </Box>
                    </Box>

                    {/* PTR Table Body - Manual Virtual Scrolling */}
                    <Box
                      ref={ptrContainerRef}
                      sx={{
                        flex: 1,
                        overflow: "auto",
                        position: "relative",
                        minHeight: 200,
                        maxHeight: "calc(100vh - 300px)",
                        height: "100%",
                        "&::-webkit-scrollbar": {
                          width: "14px",
                          backgroundColor: "#1e1e1e",
                        },
                        "&::-webkit-scrollbar-track": {
                          background: "#1e1e1e",
                          borderRadius: "7px",
                          border: "1px solid #333",
                        },
                        "&::-webkit-scrollbar-thumb": {
                          background: "#555",
                          borderRadius: "7px",
                          border: "2px solid #1e1e1e",
                          backgroundClip: "content-box",
                          minHeight: "30px",
                          "&:hover": {
                            background: "#777",
                          },
                          "&:active": {
                            background: "#999",
                          },
                        },
                        scrollbarWidth: "auto",
                        scrollbarColor: "#555 #1e1e1e",
                      }}
                      onScroll={(e) => {
                        const target = e.target as HTMLDivElement;
                        setPtrScrollTop(target.scrollTop);
                      }}
                    >
                      {(() => {
                        const ptrRowHeight = isCompactHeight ? 24 : 32;
                        // Ensure at least 10 items are shown even if container height is not calculated yet
                        const ptrItemsPerView = Math.max(10, Math.ceil(ptrContainerHeight / ptrRowHeight));
                        const ptrBufferSize = 5;
                        const ptrVisibleStart = Math.max(
                          0,
                          Math.floor(ptrScrollTop / ptrRowHeight) - ptrBufferSize
                        );
                        const ptrVisibleEnd = Math.min(
                          ptrVisibleStart + ptrItemsPerView + ptrBufferSize * 2,
                          ptrScanData.parsedResults.length
                        );
                        const ptrVisibleResults = ptrScanData.parsedResults.slice(ptrVisibleStart, ptrVisibleEnd);

                        return (
                          <>
                            {/* Total height container for proper scrollbar */}
                            <Box
                              sx={{
                                height: ptrScanData.parsedResults.length * ptrRowHeight,
                                position: "relative",
                                width: "100%",
                              }}
                            >
                              {/* Visible items positioned absolutely */}
                              <Box
                                sx={{
                                  position: "absolute",
                                  top: ptrVisibleStart * ptrRowHeight,
                                  left: 0,
                                  right: 0,
                                  width: "100%",
                                }}
                              >
                                {ptrVisibleResults.map((item, index) => {
                                  const actualIndex = ptrVisibleStart + index;
                                  const buildExpression = () => {
                                    const offsets = item.offsets.filter((o: string) => o);
                                    let expr = item.baseAddress;
                                    for (const offset of offsets) {
                                      expr += ` → [${offset}]`;
                                    }
                                    return expr;
                                  };

                                  return (
                                    <Box
                                      key={`ptr-result-${actualIndex}`}
                                      sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        height: ptrRowHeight,
                                        px: isCompactHeight ? 1 : 2,
                                        borderBottom: "1px solid",
                                        borderColor: "divider",
                                        backgroundColor: selectedRows.has(item.address)
                                          ? "action.selected"
                                          : actualIndex % 2 === 0
                                            ? "#2a2a2a"
                                            : "#1e1e1e",
                                        "&:hover": {
                                          backgroundColor: "action.hover",
                                        },
                                        cursor: "pointer",
                                      }}
                                      onClick={(event) =>
                                        handleRowClick(item.address, event)
                                      }
                                      onContextMenu={(event) => {
                                        event.preventDefault();
                                        setContextMenu({
                                          mouseX: event.clientX,
                                          mouseY: event.clientY,
                                          address: buildExpression(),
                                        });
                                      }}
                                    >
                                      {/* Base Address */}
                                      <Box
                                        sx={{
                                          width: "auto",
                                          minWidth: "150px",
                                          maxWidth: "300px",
                                          fontFamily: "monospace",
                                          fontSize: isCompactHeight ? "10px" : "11px",
                                          fontWeight: 500,
                                          color: "#4fc1ff",
                                          px: 1,
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                        title={item.baseAddress}
                                      >
                                        {item.baseAddress}
                                      </Box>
                                      {/* Offset Values */}
                                      {Array.from({ length: ptrScanData.maxOffsets }, (_, i) => (
                                        <Box
                                          key={`offset-${i}`}
                                          sx={{
                                            width: "auto",
                                            minWidth: "70px",
                                            maxWidth: "120px",
                                            fontFamily: "monospace",
                                            fontSize: isCompactHeight ? "10px" : "11px",
                                            fontWeight: 500,
                                            color: "#ce9178",
                                            px: 1,
                                            borderLeft: "1px solid #333",
                                          }}
                                        >
                                          {item.offsets[i] || "-"}
                                        </Box>
                                      ))}
                                      {/* Action Menu */}
                                      <Box
                                        sx={{
                                          width: "48px",
                                          display: "flex",
                                          justifyContent: "center",
                                          marginLeft: "auto",
                                        }}
                                      >
                                        <IconButton
                                          size="small"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setContextMenu({
                                              mouseX: event.clientX,
                                              mouseY: event.clientY,
                                              address: buildExpression(),
                                            });
                                          }}
                                        >
                                          <MoreVert
                                            sx={{
                                              fontSize: isCompactHeight ? "14px" : "20px",
                                            }}
                                          />
                                        </IconButton>
                                      </Box>
                                    </Box>
                                  );
                                })}
                              </Box>
                            </Box>
                          </>
                        );
                      })()}
                    </Box>
                  </Box>
                ) : (
                /* Normal Results Table */
                <Box
                  sx={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                    overflow: "hidden",
                  }}
                >
                  {/* Table Header */}
                  <Box
                    sx={{
                      backgroundColor: "#080808",
                      borderBottom: `2px solid ${borderColors.main}`,
                      display: "flex",
                      alignItems: "center",
                      height: isCompactHeight
                        ? COMPACT_HEADER_HEIGHT
                        : HEADER_HEIGHT,
                      px: isCompactHeight ? 1 : 2,
                    }}
                  >
                    <Box
                      sx={{
                        width: `${scanResultsColumnResize.getColumnWidth("address")}px`,
                        minWidth: `${scanResultsColumnResize.getColumnWidth("address")}px`,
                        fontWeight: 600,
                        color: "text.primary",
                        fontSize: isCompactHeight ? "11px" : "13px",
                        position: "relative",
                        px: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                      }}
                    >
                      Address
                      <IconButton
                        size="small"
                        onClick={() => {
                          // Cycle through: "" -> asc -> desc -> ""
                          if (addressSortOrder === "") {
                            setAddressSortOrder("asc");
                          } else if (addressSortOrder === "asc") {
                            setAddressSortOrder("desc");
                          } else {
                            setAddressSortOrder("");
                          }
                        }}
                        sx={{
                          p: 0.25,
                          color: addressSortOrder
                            ? "primary.main"
                            : "text.secondary",
                        }}
                      >
                        {addressSortOrder === "desc" ? (
                          <ArrowDownward
                            sx={{ fontSize: isCompactHeight ? 14 : 16 }}
                          />
                        ) : (
                          <ArrowUpward
                            sx={{ fontSize: isCompactHeight ? 14 : 16 }}
                          />
                        )}
                      </IconButton>
                      <ColumnResizer
                        onMouseDown={(e) =>
                          scanResultsColumnResize.handleResizeStart(
                            "address",
                            e
                          )
                        }
                        isResizing={
                          scanResultsColumnResize.resizingColumn === "address"
                        }
                      />
                    </Box>
                    <Box
                      sx={{
                        width: `${scanResultsColumnResize.getColumnWidth("detail")}px`,
                        minWidth: `${scanResultsColumnResize.getColumnWidth("detail")}px`,
                        fontWeight: 600,
                        color: "text.primary",
                        fontSize: isCompactHeight ? "11px" : "13px",
                        position: "relative",
                        px: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                      }}
                    >
                      Detail
                      <IconButton
                        size="small"
                        onClick={(e) => setFilterAnchorEl(e.currentTarget)}
                        sx={{
                          p: 0.25,
                          color: moduleFilter
                            ? "primary.main"
                            : "text.secondary",
                        }}
                      >
                        <FilterList
                          sx={{ fontSize: isCompactHeight ? 14 : 16 }}
                        />
                      </IconButton>
                      <Popover
                        open={filterPopoverOpen}
                        anchorEl={filterAnchorEl}
                        onClose={() => setFilterAnchorEl(null)}
                        anchorOrigin={{
                          vertical: "bottom",
                          horizontal: "left",
                        }}
                        transformOrigin={{
                          vertical: "top",
                          horizontal: "left",
                        }}
                      >
                        <Box sx={{ minWidth: 200, py: 0.5 }}>
                          <MenuItem
                            selected={moduleFilter === ""}
                            onClick={() => {
                              setModuleFilter("");
                              setFilterAnchorEl(null);
                            }}
                            sx={{ fontSize: "13px" }}
                          >
                            All
                          </MenuItem>
                          <MenuItem
                            selected={moduleFilter === "__within_modules__"}
                            onClick={() => {
                              setModuleFilter("__within_modules__");
                              setFilterAnchorEl(null);
                            }}
                            sx={{ fontSize: "13px" }}
                          >
                            Within Modules
                          </MenuItem>
                          <MenuItem
                            selected={moduleFilter === "__outside_modules__"}
                            onClick={() => {
                              setModuleFilter("__outside_modules__");
                              setFilterAnchorEl(null);
                            }}
                            sx={{ fontSize: "13px" }}
                          >
                            Outside Modules
                          </MenuItem>
                          {availableModules.length > 0 && (
                            <>
                              <Divider sx={{ my: 0.5 }} />
                              <ListSubheader
                                sx={{
                                  fontSize: "11px",
                                  lineHeight: "24px",
                                  backgroundColor: "transparent",
                                }}
                              >
                                Modules
                              </ListSubheader>
                              {availableModules.map((moduleName) => (
                                <MenuItem
                                  key={moduleName}
                                  selected={moduleFilter === moduleName}
                                  onClick={() => {
                                    setModuleFilter(moduleName);
                                    setFilterAnchorEl(null);
                                  }}
                                  sx={{ fontSize: "13px" }}
                                >
                                  {moduleName}
                                </MenuItem>
                              ))}
                            </>
                          )}
                        </Box>
                      </Popover>
                      <ColumnResizer
                        onMouseDown={(e) =>
                          scanResultsColumnResize.handleResizeStart("detail", e)
                        }
                        isResizing={
                          scanResultsColumnResize.resizingColumn === "detail"
                        }
                      />
                    </Box>
                    <Box
                      sx={{
                        width: `${scanResultsColumnResize.getColumnWidth("value")}px`,
                        minWidth: `${scanResultsColumnResize.getColumnWidth("value")}px`,
                        fontWeight: 600,
                        color: "text.primary",
                        fontSize: isCompactHeight ? "11px" : "13px",
                        position: "relative",
                        px: 1,
                      }}
                    >
                      Value
                      <ColumnResizer
                        onMouseDown={(e) =>
                          scanResultsColumnResize.handleResizeStart("value", e)
                        }
                        isResizing={
                          scanResultsColumnResize.resizingColumn === "value"
                        }
                      />
                    </Box>
                    <Box
                      sx={{
                        width: `${scanResultsColumnResize.getColumnWidth("description")}px`,
                        minWidth: `${scanResultsColumnResize.getColumnWidth("description")}px`,
                        fontWeight: 600,
                        color: "text.primary",
                        fontSize: isCompactHeight ? "11px" : "13px",
                        position: "relative",
                        px: 1,
                      }}
                    >
                      Description
                      <ColumnResizer
                        onMouseDown={(e) =>
                          scanResultsColumnResize.handleResizeStart(
                            "description",
                            e
                          )
                        }
                        isResizing={
                          scanResultsColumnResize.resizingColumn ===
                          "description"
                        }
                      />
                    </Box>
                    <Box sx={{ width: "48px" }}></Box>
                  </Box>

                  {/* Virtual Scrollable Content */}
                  <Box
                    ref={containerRef}
                    sx={{
                      flex: 1,
                      overflow: "auto",
                      position: "relative",
                      minHeight: 200, // 最小高さを保証
                      maxHeight: "calc(100vh - 300px)", // ビューポートに基づく最大高さ
                      height: "100%",
                      // Custom scrollbar styles
                      "&::-webkit-scrollbar": {
                        width: "14px",
                        backgroundColor: "#1e1e1e",
                      },
                      "&::-webkit-scrollbar-track": {
                        background: "#1e1e1e",
                        borderRadius: "7px",
                        border: "1px solid #333",
                      },
                      "&::-webkit-scrollbar-thumb": {
                        background: "#555",
                        borderRadius: "7px",
                        border: "2px solid #1e1e1e",
                        backgroundClip: "content-box",
                        minHeight: "30px", // Minimum thumb height
                        "&:hover": {
                          background: "#777",
                        },
                        "&:active": {
                          background: "#999",
                        },
                      },
                      // For Firefox
                      scrollbarWidth: "auto",
                      scrollbarColor: "#555 #1e1e1e",
                    }}
                    onScroll={(e) => {
                      const target = e.target as HTMLDivElement;
                      const newScrollTop = target.scrollTop;
                      const maxScrollTop =
                        target.scrollHeight - target.clientHeight;
                      setScrollTop(newScrollTop);
                      console.log(`Scroll event:`, {
                        scrollTop: newScrollTop,
                        maxScrollTop,
                        scrollHeight: target.scrollHeight,
                        clientHeight: target.clientHeight,
                        containerHeight,
                        totalContentHeight:
                          sortedScanResults.length * currentRowHeight,
                        scrollPercentage:
                          ((newScrollTop / maxScrollTop) * 100).toFixed(1) +
                          "%",
                      });
                    }}
                  >
                    {/* Total height container for proper scrollbar */}
                    <Box
                      sx={{
                        height: sortedScanResults.length * currentRowHeight,
                        position: "relative",
                        width: "100%",
                      }}
                    >
                      {/* Visible items positioned absolutely */}
                      <Box
                        sx={{
                          position: "absolute",
                          top: visibleStart * currentRowHeight,
                          left: 0,
                          right: 0,
                          width: "100%",
                        }}
                      >
                        {visibleResults.map((result, index) => {
                          const actualIndex = visibleStart + index;
                          return (
                            <Box
                              key={result.address}
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                height: currentRowHeight,
                                px: isCompactHeight ? 1 : 2,
                                borderBottom: "1px solid",
                                borderColor: "divider",
                                backgroundColor: selectedRows.has(
                                  result.address
                                )
                                  ? "action.selected"
                                  : actualIndex % 2 === 0
                                    ? "#2a2a2a"
                                    : "#1e1e1e",
                                "&:hover": {
                                  backgroundColor: "action.hover",
                                },
                                cursor: "pointer",
                              }}
                              onClick={(event) =>
                                handleRowClick(result.address, event)
                              }
                              onContextMenu={(event) =>
                                handleContextMenu(event, result.address)
                              }
                            >
                              <Box
                                sx={{
                                  width: `${scanResultsColumnResize.getColumnWidth("address")}px`,
                                  minWidth: `${scanResultsColumnResize.getColumnWidth("address")}px`,
                                  fontFamily: "monospace",
                                  fontSize: isCompactHeight ? "10px" : "11px",
                                  fontWeight: 500,
                                  color: "#4fc1ff",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  px: 1,
                                }}
                              >
                                {result.address.startsWith("0x") ||
                                result.address.startsWith("0X")
                                  ? `0x${result.address.slice(2).toUpperCase()}`
                                  : result.address.toUpperCase()}
                              </Box>
                              <Box
                                sx={{
                                  width: `${scanResultsColumnResize.getColumnWidth("detail")}px`,
                                  minWidth: `${scanResultsColumnResize.getColumnWidth("detail")}px`,
                                  fontFamily: "monospace",
                                  fontSize: isCompactHeight ? "10px" : "11px",
                                  fontWeight: 500,
                                  color: "#90ee90",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  px: 1,
                                }}
                                title={
                                  visibleAddressDetails.get(result.address) ||
                                  "-"
                                }
                              >
                                {visibleAddressDetails.get(result.address) ||
                                  "-"}
                              </Box>
                              <Box
                                sx={{
                                  width: `${scanResultsColumnResize.getColumnWidth("value")}px`,
                                  minWidth: `${scanResultsColumnResize.getColumnWidth("value")}px`,
                                  fontFamily: "monospace",
                                  fontSize: isCompactHeight ? "10px" : "11px",
                                  fontWeight: 500,
                                  color: "text.primary",
                                  px: 1,
                                }}
                              >
                                {editingRow === result.address ? (
                                  <TextField
                                    size="small"
                                    value={editValue}
                                    onChange={(e) =>
                                      setEditValue(e.target.value)
                                    }
                                    onBlur={() =>
                                      handleEditSave(result.address)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        handleEditSave(result.address);
                                      } else if (e.key === "Escape") {
                                        handleEditCancel();
                                      }
                                    }}
                                    autoFocus
                                    sx={{
                                      "& .MuiInputBase-input": {
                                        fontFamily: "monospace",
                                        fontSize: isCompactHeight
                                          ? "10px"
                                          : "11px",
                                        fontWeight: 500,
                                        padding: isCompactHeight
                                          ? "2px 4px"
                                          : "4px 8px",
                                      },
                                    }}
                                  />
                                ) : (
                                  <Box
                                    onDoubleClick={() => {
                                      setEditDialog({
                                        open: true,
                                        address: result.address,
                                        currentValue: formatValue(result),
                                        rawValue: String(result.value), // Raw decimal value
                                        newValue: formatValue(result),
                                        valueType: result.type,
                                        inputFormat:
                                          scanSettings?.valueInputFormat ||
                                          "dec",
                                        bookmarkId: undefined, // Scan results don't have bookmark ID
                                      });
                                    }}
                                  >
                                    {formatValue(result)}
                                  </Box>
                                )}
                              </Box>
                              <Box
                                sx={{
                                  width: `${scanResultsColumnResize.getColumnWidth("description")}px`,
                                  minWidth: `${scanResultsColumnResize.getColumnWidth("description")}px`,
                                  fontSize: isCompactHeight ? "10px" : "11px",
                                  fontWeight: 400,
                                  color: "text.primary",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  px: 1,
                                }}
                              >
                                {result.description || "-"}
                              </Box>
                              <Box
                                sx={{
                                  width: "48px",
                                  display: "flex",
                                  justifyContent: "center",
                                }}
                              >
                                <IconButton
                                  size="small"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleContextMenu(event, result.address);
                                  }}
                                >
                                  <MoreVert
                                    sx={{
                                      fontSize: isCompactHeight
                                        ? "14px"
                                        : "20px",
                                    }}
                                  />
                                </IconButton>
                              </Box>
                            </Box>
                          );
                        })}
                      </Box>
                    </Box>
                  </Box>
                </Box>
                )}
              </>
            )}
          </TabContent>
        </TabPanel>

        <TabPanel value={activeTab} index={1}>
          <TabContent sx={{ position: "relative" }}>
            {bookmarks.length === 0 ? (
              <Box sx={{ p: isCompactHeight ? 2 : 3, textAlign: "center" }}>
                <BookmarkBorderOutlined
                  sx={{
                    fontSize: isCompactHeight ? 36 : 48,
                    color: "text.secondary",
                    mb: isCompactHeight ? 1 : 2,
                  }}
                />
                <Typography
                  variant="h6"
                  gutterBottom
                  sx={{
                    fontSize: isCompactHeight ? "14px" : "18px",
                    mb: isCompactHeight ? 1 : 2,
                  }}
                >
                  No Bookmarks
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    mb: isCompactHeight ? 2 : 3,
                    fontSize: isCompactHeight ? "11px" : "14px",
                  }}
                >
                  Add bookmarks from scan results or manually by address
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={handleManualBookmarkDialogOpen}
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "14px",
                    minHeight: isCompactHeight ? "24px" : "32px",
                    padding: isCompactHeight ? "2px 8px" : "4px 12px",
                  }}
                >
                  Add Manual Bookmark
                </Button>
              </Box>
            ) : (
              <>
                {/* Header */}
                <Box
                  sx={{
                    p: isCompactHeight ? 1.5 : 2,
                    borderBottom: `1px solid ${borderColors.main}`,
                  }}
                >
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Typography
                      variant="h6"
                      sx={{
                        fontSize: isCompactHeight ? "14px" : "18px",
                      }}
                    >
                      Bookmarks
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{
                          fontSize: isCompactHeight ? "10px" : "14px",
                        }}
                      >
                        {bookmarks.length} bookmark
                        {bookmarks.length !== 1 ? "s" : ""}
                      </Typography>
                      {/* PointerMap Generation Status */}
                      {(isGeneratingPointerMap || pointerMapStatus) && (
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            px: 1.5,
                            py: 0.5,
                            borderRadius: 1,
                            backgroundColor: pointerMapStatus?.type === "error" 
                              ? "error.dark" 
                              : pointerMapStatus?.type === "success"
                              ? "success.dark"
                              : "info.dark",
                            opacity: 0.9,
                          }}
                        >
                          {isGeneratingPointerMap && (
                            <Box
                              sx={{
                                width: 14,
                                height: 14,
                                border: "2px solid",
                                borderColor: "transparent",
                                borderTopColor: "white",
                                borderRadius: "50%",
                                animation: "spin 1s linear infinite",
                                "@keyframes spin": {
                                  "0%": { transform: "rotate(0deg)" },
                                  "100%": { transform: "rotate(360deg)" },
                                },
                              }}
                            />
                          )}
                          <Typography
                            variant="body2"
                            sx={{
                              fontSize: isCompactHeight ? "10px" : "12px",
                              color: "white",
                              maxWidth: 300,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {pointerMapStatus?.message || "Processing..."}
                          </Typography>
                          {pointerMapStatus && !isGeneratingPointerMap && (
                            <IconButton
                              size="small"
                              onClick={() => setPointerMapStatus(null)}
                              sx={{ 
                                p: 0, 
                                minWidth: 16, 
                                color: "white",
                                "&:hover": { opacity: 0.8 },
                              }}
                            >
                              ×
                            </IconButton>
                          )}
                        </Box>
                      )}
                      <Button
                        size="small"
                        startIcon={<AddIcon />}
                        onClick={handleManualBookmarkDialogOpen}
                        sx={{
                          fontSize: isCompactHeight ? "10px" : "12px",
                          minHeight: isCompactHeight ? "20px" : "24px",
                          padding: isCompactHeight ? "1px 6px" : "2px 8px",
                        }}
                      >
                        Add
                      </Button>
                    </Stack>
                  </Stack>
                </Box>

                {/* Bookmarks Table */}
                <TableContainer
                  sx={{
                    flex: 1,
                    overflow: "auto",
                    "&::-webkit-scrollbar": {
                      width: "8px",
                      height: "8px",
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
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontWeight: 600,
                            backgroundColor: "background.paper",
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            width: bookmarkColumnWidths.address,
                            minWidth: bookmarkColumnWidths.address,
                            maxWidth: bookmarkColumnWidths.address,
                            position: "relative",
                          }}
                        >
                          Address
                          <ColumnResizer
                            onMouseDown={handleBookmarkColumnResizeStart(
                              "address"
                            )}
                            isResizing={resizingBookmarkColumn === "address"}
                          />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontWeight: 600,
                            backgroundColor: "background.paper",
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            width: bookmarkColumnWidths.type,
                            minWidth: bookmarkColumnWidths.type,
                            maxWidth: bookmarkColumnWidths.type,
                            position: "relative",
                          }}
                        >
                          Type
                          <ColumnResizer
                            onMouseDown={handleBookmarkColumnResizeStart(
                              "type"
                            )}
                            isResizing={resizingBookmarkColumn === "type"}
                          />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontWeight: 600,
                            backgroundColor: "background.paper",
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            width: bookmarkColumnWidths.value,
                            minWidth: bookmarkColumnWidths.value,
                            maxWidth: bookmarkColumnWidths.value,
                            position: "relative",
                          }}
                        >
                          Value
                          <ColumnResizer
                            onMouseDown={handleBookmarkColumnResizeStart(
                              "value"
                            )}
                            isResizing={resizingBookmarkColumn === "value"}
                          />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontWeight: 600,
                            backgroundColor: "background.paper",
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            width: bookmarkColumnWidths.description,
                            minWidth: bookmarkColumnWidths.description,
                            maxWidth: bookmarkColumnWidths.description,
                            position: "relative",
                          }}
                        >
                          Description
                          <ColumnResizer
                            onMouseDown={handleBookmarkColumnResizeStart(
                              "description"
                            )}
                            isResizing={
                              resizingBookmarkColumn === "description"
                            }
                          />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "11px",
                            fontWeight: 600,
                            backgroundColor: "background.paper",
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            textAlign: "center",
                          }}
                        >
                          Actions
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {bookmarks.map((bookmark) => {
                        const currentValue =
                          updatedBookmarkValues.get(bookmark.id) ||
                          bookmark.value;

                        // Format value based on bookmark's displayFormat
                        // For ptr type, use ptrValueType; otherwise use bookmark.type
                        const effectiveType = bookmark.type === "ptr" 
                          ? (bookmark.ptrValueType || "int32") 
                          : bookmark.type;
                        const isIntegerType = [
                          "int8",
                          "uint8",
                          "int16",
                          "uint16",
                          "int32",
                          "uint32",
                          "int64",
                          "uint64",
                        ].includes(effectiveType);
                        let displayValue = currentValue;
                        if (isIntegerType && bookmark.displayFormat === "hex") {
                          try {
                            const numValue = ["int64", "uint64"].includes(
                              effectiveType
                            )
                              ? BigInt(currentValue)
                              : parseInt(currentValue, 10);
                            // Handle signed integers with two's complement
                            let hexStr: string;
                            if (typeof numValue === "bigint") {
                              if (numValue < 0n) {
                                const mask = (1n << 64n) - 1n;
                                hexStr = (numValue & mask)
                                  .toString(16)
                                  .toUpperCase();
                              } else {
                                hexStr = numValue.toString(16).toUpperCase();
                              }
                            } else {
                              if (numValue < 0) {
                                // Two's complement based on type using bitwise AND with proper mask
                                if (effectiveType === "int8") {
                                  hexStr = ((numValue & 0xff) >>> 0)
                                    .toString(16)
                                    .toUpperCase()
                                    .padStart(2, "0");
                                } else if (effectiveType === "int16") {
                                  hexStr = ((numValue & 0xffff) >>> 0)
                                    .toString(16)
                                    .toUpperCase()
                                    .padStart(4, "0");
                                } else {
                                  // int32: >>> 0 converts to unsigned 32-bit
                                  hexStr = (numValue >>> 0)
                                    .toString(16)
                                    .toUpperCase()
                                    .padStart(8, "0");
                                }
                              } else {
                                hexStr = numValue.toString(16).toUpperCase();
                              }
                            }
                            displayValue = "0x" + hexStr;
                          } catch {
                            // Keep original value on error
                          }
                        }

                        return (
                          <TableRow
                            key={bookmark.id}
                            hover
                            sx={{
                              "&:hover": {
                                backgroundColor: "action.hover",
                              },
                            }}
                            onContextMenu={(e) =>
                              handleBookmarkContextMenu(e, bookmark)
                            }
                          >
                            {/* Address */}
                            <TableCell
                              sx={{
                                fontFamily: "monospace",
                                fontSize: isCompactHeight ? "10px" : "11px",
                                py: isCompactHeight ? 0.5 : 1,
                                width: bookmarkColumnWidths.address,
                                minWidth: bookmarkColumnWidths.address,
                                maxWidth: bookmarkColumnWidths.address,
                              }}
                            >
                              {/* PTR type: show structured pointer chain with colored arrows */}
                              {bookmark.type === "ptr" ? (
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    flexWrap: "wrap",
                                    gap: 0.5,
                                    fontFamily: "monospace",
                                    fontSize: isCompactHeight ? "10px" : "11px",
                                  }}
                                >
                                  {(() => {
                                    // Parse pointer expression: "base → [0x10] → [0x18]"
                                    const parts = bookmark.address.split(" → ");
                                    return parts.map((part, idx) => (
                                      <Box key={idx} component="span" sx={{ display: "flex", alignItems: "center" }}>
                                        {idx > 0 && (
                                          <Box component="span" sx={{ color: "#ffcc00", mx: 0.5, fontWeight: 600 }}>→</Box>
                                        )}
                                        {idx === 0 ? (
                                          <Box component="span" sx={{ color: "#4fc1ff" }}>
                                            {part.replace(/0X/g, '0x')}
                                          </Box>
                                        ) : (
                                          <>
                                            <Box component="span" sx={{ color: "#888" }}>[</Box>
                                            <Box component="span" sx={{ color: "#ce9178" }}>
                                              {part.replace(/[\[\]]/g, '').replace(/0X/g, '0x')}
                                            </Box>
                                            <Box component="span" sx={{ color: "#888" }}>]</Box>
                                          </>
                                        )}
                                      </Box>
                                    ));
                                  })()}
                                </Box>
                              ) : bookmark.libraryExpression ? (
                                <>
                                  <Typography
                                    sx={{
                                      fontFamily: "monospace",
                                      fontWeight: 600,
                                      color: "primary.main",
                                      fontSize: isCompactHeight
                                        ? "10px"
                                        : "11px",
                                    }}
                                  >
                                    {bookmark.libraryExpression}
                                  </Typography>
                                  <Typography
                                    sx={{
                                      fontFamily: "monospace",
                                      fontSize: isCompactHeight
                                        ? "9px"
                                        : "10px",
                                      color: "text.secondary",
                                      fontStyle: "italic",
                                    }}
                                  >
                                    {bookmark.address.startsWith("0x") ||
                                    bookmark.address.startsWith("0X")
                                      ? `0x${bookmark.address.slice(2).toUpperCase()}`
                                      : bookmark.address.toUpperCase()}
                                  </Typography>
                                </>
                              ) : (
                                <Typography
                                  sx={{
                                    fontFamily: "monospace",
                                    fontSize: isCompactHeight ? "10px" : "11px",
                                  }}
                                >
                                  {bookmark.address.startsWith("0x") ||
                                  bookmark.address.startsWith("0X")
                                    ? `0x${bookmark.address.slice(2).toUpperCase()}`
                                    : bookmark.address.toUpperCase()}
                                </Typography>
                              )}
                            </TableCell>
                            {/* Type */}
                            <TableCell
                              sx={{
                                py: isCompactHeight ? 0.5 : 1,
                                width: bookmarkColumnWidths.type,
                                minWidth: bookmarkColumnWidths.type,
                                maxWidth: bookmarkColumnWidths.type,
                              }}
                            >
                              <Typography
                                sx={{
                                  backgroundColor: "#2d2d30",
                                  color: "#4fc1ff",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  fontSize: isCompactHeight ? "9px" : "10px",
                                  display: "inline-block",
                                }}
                              >
                                {bookmark.type === "ptr" 
                                  ? `ptr ${bookmark.ptrValueType || "int32"}` 
                                  : bookmark.type}
                              </Typography>
                            </TableCell>
                            {/* Value */}
                            <TableCell
                              sx={{
                                fontFamily: "monospace",
                                fontSize: isCompactHeight ? "10px" : "11px",
                                py: isCompactHeight ? 0.5 : 1,
                                width: bookmarkColumnWidths.value,
                                minWidth: bookmarkColumnWidths.value,
                                maxWidth: bookmarkColumnWidths.value,
                              }}
                            >
                              <Typography
                                sx={{
                                  fontFamily: "monospace",
                                  fontSize: isCompactHeight ? "10px" : "11px",
                                  color: "#ccc",
                                  backgroundColor: "#1e1e1e",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  display: "inline-block",
                                }}
                              >
                                {displayValue}
                              </Typography>
                            </TableCell>
                            {/* Description */}
                            <TableCell
                              sx={{
                                fontSize: isCompactHeight ? "10px" : "11px",
                                color: "text.secondary",
                                py: isCompactHeight ? 0.5 : 1,
                                width: bookmarkColumnWidths.description,
                                minWidth: bookmarkColumnWidths.description,
                                maxWidth: bookmarkColumnWidths.description,
                              }}
                            >
                              {bookmark.description || "-"}
                            </TableCell>
                            {/* Actions */}
                            <TableCell
                              sx={{
                                py: isCompactHeight ? 0.5 : 1,
                                textAlign: "center",
                              }}
                            >
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  gap: 0.5,
                                }}
                              >
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    // currentValue is raw decimal from memory, displayValue is formatted
                                    // Ensure rawValue is always stored as decimal string for conversions
                                    let rawDecimalValue = currentValue;
                                    // If currentValue looks like hex, convert to decimal
                                    if (typeof currentValue === "string" && currentValue.toLowerCase().startsWith("0x")) {
                                      try {
                                        rawDecimalValue = BigInt(currentValue).toString();
                                      } catch {
                                        rawDecimalValue = currentValue;
                                      }
                                    }
                                    setEditDialog({
                                      open: true,
                                      address: bookmark.address,
                                      currentValue: displayValue,
                                      rawValue: rawDecimalValue, // Raw decimal value from memory
                                      valueType: bookmark.type,
                                      ptrValueType: bookmark.ptrValueType || "int32",
                                      newValue: displayValue,
                                      inputFormat:
                                        bookmark.displayFormat || "dec",
                                      bookmarkId: bookmark.id,
                                    });
                                  }}
                                  title="Edit Value"
                                >
                                  <Edit sx={{ fontSize: "16px" }} />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  onClick={() => handleGeneratePointerMap(bookmark.address)}
                                  disabled={isGeneratingPointerMap}
                                  title={isGeneratingPointerMap ? "Generating PointerMap..." : "Generate PointerMap for this address"}
                                  sx={{
                                    color: isGeneratingPointerMap ? "info.main" : "text.secondary",
                                  }}
                                >
                                  <MapIcon sx={{ fontSize: "16px" }} />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    const currentAddress =
                                      bookmark.address.startsWith("0x") ||
                                      bookmark.address.startsWith("0X")
                                        ? bookmark.address
                                        : `0x${bookmark.address}`;
                                    handleWatchpointDialogOpen(currentAddress);
                                  }}
                                  title="Set Hardware Watchpoint"
                                  sx={{
                                    color: isAddressWatched?.(bookmark.address)
                                      ? "warning.main"
                                      : "text.secondary",
                                  }}
                                >
                                  <BugReport sx={{ fontSize: "16px" }} />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  color="error"
                                  onClick={() =>
                                    onRemoveBookmark?.(bookmark.id)
                                  }
                                  title="Remove Bookmark"
                                >
                                  <Delete sx={{ fontSize: "16px" }} />
                                </IconButton>
                              </Box>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            )}
          </TabContent>
        </TabPanel>

        <TabPanel value={activeTab} index={2}>
          <TabContent sx={{ position: "relative" }}>
            {scanHistory.length === 0 ? (
              <Box sx={{ p: isCompactHeight ? 2 : 3, textAlign: "center" }}>
                <History
                  sx={{
                    fontSize: isCompactHeight ? 36 : 48,
                    color: "text.secondary",
                    mb: isCompactHeight ? 1 : 2,
                  }}
                />
                <Typography
                  variant="h6"
                  gutterBottom
                  sx={{
                    fontSize: isCompactHeight ? "14px" : "18px",
                    mb: isCompactHeight ? 1 : 2,
                  }}
                >
                  No Search History
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    mb: isCompactHeight ? 2 : 3,
                    fontSize: isCompactHeight ? "11px" : "14px",
                  }}
                >
                  Your search history will appear here after performing scans
                </Typography>
              </Box>
            ) : (
              <>
                {/* Header */}
                <Box
                  sx={{
                    p: isCompactHeight ? 1.5 : 2,
                    borderBottom: `1px solid ${borderColors.main}`,
                  }}
                >
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Typography
                      variant="h6"
                      sx={{
                        fontSize: isCompactHeight ? "14px" : "18px",
                      }}
                    >
                      Search History
                    </Typography>
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{
                          fontSize: isCompactHeight ? "10px" : "14px",
                        }}
                      >
                        {scanHistory.length}/10 searches
                      </Typography>
                      <Button
                        size="small"
                        onClick={() => {
                          onClearHistory?.();
                        }}
                        sx={{
                          color: "#4fc1ff",
                          fontSize: isCompactHeight ? "10px" : "12px",
                          minHeight: isCompactHeight ? "20px" : "24px",
                          padding: isCompactHeight ? "1px 6px" : "2px 8px",
                        }}
                      >
                        Clear
                      </Button>
                    </Stack>
                  </Stack>
                </Box>

                {/* History List */}
                <Box
                  sx={{
                    flex: 1,
                    overflow: "auto",
                    p: isCompactHeight ? 0.5 : 1,
                  }}
                >
                  {scanHistory.map((item) => (
                    <Box
                      key={item.id}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        p: isCompactHeight ? 0.75 : 1.25,
                        mb: isCompactHeight ? 0.25 : 0.5,
                        borderRadius: 1,
                        border: "1px solid",
                        borderColor: "divider",
                        backgroundColor: "background.paper",
                        cursor: "pointer",
                        "&:hover": {
                          backgroundColor: "action.hover",
                          borderColor: "#4fc1ff",
                        },
                      }}
                      onClick={() => onSelectHistory?.(item)}
                    >
                      <Box sx={{ flex: 1 }}>
                        <Typography
                          variant="body1"
                          sx={{
                            fontWeight: 600,
                            fontSize: isCompactHeight ? "11px" : "13px",
                            mb: 0.25,
                          }}
                        >
                          {item.description}
                        </Typography>

                        <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}>
                          <Typography
                            variant="caption"
                            sx={{
                              backgroundColor: "#2d2d30",
                              color: "#4fc1ff",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: isCompactHeight ? "9px" : "10px",
                            }}
                          >
                            {item.valueType}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{
                              backgroundColor: "#2d2d30",
                              color: "#ccc",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: isCompactHeight ? "9px" : "10px",
                            }}
                          >
                            {item.scanType}
                          </Typography>
                        </Stack>

                        {item.value && (
                          <Typography
                            variant="body2"
                            sx={{
                              fontFamily: "monospace",
                              fontSize: isCompactHeight ? "10px" : "12px",
                              color: "#ccc",
                              backgroundColor: "#1e1e1e",
                              padding: "3px 6px",
                              borderRadius: "4px",
                              mb: 0.5,
                              maxWidth: "300px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.value}
                          </Typography>
                        )}

                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            fontSize: isCompactHeight ? "9px" : "11px",
                          }}
                        >
                          {new Date(item.timestamp).toLocaleString()}
                        </Typography>
                      </Box>

                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: isCompactHeight ? 0.5 : 1,
                        }}
                      >
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Execute search with this history item and switch to Results tab
                            if (onExecuteHistorySearch && handleTabChange) {
                              onExecuteHistorySearch(item);
                              handleTabChange(0); // Switch to Results tab (index 0)
                            }
                          }}
                          sx={{
                            color: "#4fc1ff",
                            "&:hover": {
                              color: "#fff",
                              backgroundColor: "rgba(79, 193, 255, 0.1)",
                            },
                          }}
                          title="Search with this condition and view results"
                        >
                          <Search
                            sx={{ fontSize: isCompactHeight ? "14px" : "18px" }}
                          />
                        </IconButton>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveHistoryItem?.(item.id);
                          }}
                          color="error"
                          title="Remove from history"
                        >
                          <Delete
                            sx={{ fontSize: isCompactHeight ? "14px" : "18px" }}
                          />
                        </IconButton>
                      </Box>
                    </Box>
                  ))}
                </Box>
              </>
            )}
          </TabContent>
        </TabPanel>

        {/*<TabPanel value={currentTab} index={2}>
        <TabContent>
          <Box sx={{ p: 3, textAlign: "center" }}>
            <VisibilityOutlined
              sx={{ fontSize: 48, color: "text.secondary", mb: 2 }}
            />
            <Typography variant="h6" gutterBottom>
              Watch List
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Watched addresses will appear here with real-time updates
            </Typography>
          </Box>
        </TabContent>
      </TabPanel>*/}

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
        >
          {/* Edit Value - hide for PTR scan mode */}
          {!isPtrScanMode && (
          <MenuItem
            onClick={() =>
              contextMenu &&
              handleEditStart(
                contextMenu.address,
                formatValue(
                  scanResults.find((r) => r.address === contextMenu.address)!
                )
              )
            }
          >
            <Edit sx={{ mr: 1 }} />
            Edit Value
          </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                // For PTR scan, add the pointer expression as address
                // The address field contains the pointer expression like [[base]+0x8]+0x10
                if (isPtrScanMode) {
                  // Add as a manual bookmark with pointer expression
                  onAddManualBookmark?.(
                    contextMenu.address,
                    "ptr" as ScanValueType,
                    "Pointer chain"
                  );
                } else {
                  const isBookmarked =
                    isAddressBookmarked?.(contextMenu.address) || false;
                  onResultBookmark(contextMenu.address, !isBookmarked);
                }
                handleContextMenuClose();
              }
            }}
          >
            <Bookmark sx={{ mr: 1 }} />
            {isPtrScanMode
              ? "Add to Bookmarks"
              : isAddressBookmarked?.(contextMenu?.address || "")
                ? "Remove from Bookmarks"
                : "Add to Bookmarks"}
          </MenuItem>
          {/*<MenuItem
          onClick={() => {
            if (contextMenu) {
              onResultWatch(contextMenu.address, true);
              handleContextMenuClose();
            }
          }}
        >
          <Visibility sx={{ mr: 1 }} />
          Add to Watchlist
        </MenuItem>*/}
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                onResultDelete(contextMenu.address);
                handleContextMenuClose();
              }
            }}
          >
            <Delete sx={{ mr: 1 }} />
            Remove
          </MenuItem>
        </Menu>

        {/* Bookmark Context Menu */}
        <Menu
          open={bookmarkContextMenu !== null}
          onClose={handleCloseBookmarkContextMenu}
          anchorReference="anchorPosition"
          anchorPosition={
            bookmarkContextMenu !== null
              ? {
                  top: bookmarkContextMenu.mouseY,
                  left: bookmarkContextMenu.mouseX,
                }
              : undefined
          }
        >
          <MenuItem onClick={handleCopyBookmarkAddress}>Copy Address</MenuItem>
          <MenuItem onClick={handleCopyBookmarkType}>Copy Type</MenuItem>
          <MenuItem onClick={handleCopyBookmarkValue}>Copy Value</MenuItem>
          <MenuItem onClick={handleCopyBookmarkDescription}>
            Copy Description
          </MenuItem>
        </Menu>

        {/* Edit Value Dialog */}
        <Dialog
          open={editDialog.open}
          onClose={handleEditDialogClose}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Edit Memory Value</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {/* Info Section */}
              <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                <Typography variant="body2" color="text.secondary">
                  Address: <code style={{ fontFamily: "monospace" }}>{editDialog.address}</code>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Mode: {editDialog.valueType === "ptr" ? "Pointer Chain" : "Direct"}
                </Typography>
              </Box>
              
              {/* Setting Section */}
              <Typography variant="subtitle2" sx={{ fontWeight: 600, color: "primary.main", mt: 0.5 }}>
                Setting
              </Typography>
              
              {/* Value Type Row */}
              <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <InputLabel sx={{ minWidth: 90, fontSize: "0.875rem" }}>Value Type</InputLabel>
                <Select
                  size="small"
                  sx={{ flex: 1 }}
                  value={editDialog.valueType === "ptr" ? (editDialog.ptrValueType || "int32") : (editDialog.valueType || "int32")}
                  onChange={(e) => {
                    const newType = e.target.value as ScanValueType;
                    const integerTypes = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"];
                    
                    // Get type size info for masking
                    const getTypeMask = (type: string): { mask: bigint; signed: boolean } => {
                      switch (type) {
                        case "int8": return { mask: 0xFFn, signed: true };
                        case "uint8": return { mask: 0xFFn, signed: false };
                        case "int16": return { mask: 0xFFFFn, signed: true };
                        case "uint16": return { mask: 0xFFFFn, signed: false };
                        case "int32": return { mask: 0xFFFFFFFFn, signed: true };
                        case "uint32": return { mask: 0xFFFFFFFFn, signed: false };
                        case "int64": return { mask: 0xFFFFFFFFFFFFFFFFn, signed: true };
                        case "uint64": return { mask: 0xFFFFFFFFFFFFFFFFn, signed: false };
                        default: return { mask: 0xFFFFFFFFn, signed: true };
                      }
                    };
                    
                    let convertedValue = editDialog.currentValue;
                    if (integerTypes.includes(newType) && editDialog.rawValue) {
                      try {
                        // Parse the raw value and mask to new type's size
                        let numValue = BigInt(editDialog.rawValue);
                        const { mask } = getTypeMask(newType);
                        numValue = numValue & mask;
                        
                        // Re-format in current display format
                        if (editDialog.inputFormat === "hex") {
                          convertedValue = "0x" + numValue.toString(16).toUpperCase();
                        } else {
                          convertedValue = numValue.toString();
                        }
                      } catch {
                        // Keep original value if conversion fails
                      }
                    }
                    
                    if (editDialog.valueType === "ptr") {
                      setEditDialog((prev) => ({
                        ...prev,
                        ptrValueType: newType as Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">,
                        newValue: convertedValue,
                      }));
                    } else {
                      setEditDialog((prev) => ({
                        ...prev,
                        valueType: newType,
                        newValue: convertedValue,
                      }));
                    }
                  }}
                >
                  <MenuItem value="int8">int8</MenuItem>
                  <MenuItem value="uint8">uint8</MenuItem>
                  <MenuItem value="int16">int16</MenuItem>
                  <MenuItem value="uint16">uint16</MenuItem>
                  <MenuItem value="int32">int32</MenuItem>
                  <MenuItem value="uint32">uint32</MenuItem>
                  <MenuItem value="int64">int64</MenuItem>
                  <MenuItem value="uint64">uint64</MenuItem>
                  <MenuItem value="float">float</MenuItem>
                  <MenuItem value="double">double</MenuItem>
                  {editDialog.valueType !== "ptr" && (
                    <>
                      <MenuItem value="string">string</MenuItem>
                      <MenuItem value="bytes">bytes</MenuItem>
                    </>
                  )}
                </Select>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => {
                    if (editDialog.bookmarkId && onUpdateBookmark) {
                      const effectiveValueType = editDialog.valueType === "ptr"
                        ? (editDialog.ptrValueType || "int32")
                        : editDialog.valueType;
                      
                      if (editDialog.valueType === "ptr") {
                        onUpdateBookmark(editDialog.bookmarkId, {
                          ptrValueType: effectiveValueType as Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">,
                        });
                      } else {
                        onUpdateBookmark(editDialog.bookmarkId, {
                          type: (editDialog.valueType || "int32") as ScanValueType,
                        });
                      }
                      const btn = document.activeElement as HTMLButtonElement;
                      if (btn) {
                        const originalText = btn.innerText;
                        btn.innerText = "✓";
                        btn.style.color = "#4caf50";
                        btn.style.borderColor = "#4caf50";
                        setTimeout(() => {
                          btn.innerText = originalText;
                          btn.style.color = "";
                          btn.style.borderColor = "";
                        }, 1500);
                      }
                    }
                  }}
                  disabled={!editDialog.bookmarkId || !onUpdateBookmark}
                  sx={{ minWidth: 60 }}
                >
                  Apply
                </Button>
              </Box>
              
              {/* Display Format Row */}
              {(() => {
                if (!editDialog.valueType) return null;
                const integerTypes = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"];
                if (editDialog.valueType === "ptr") {
                  const ptrType = editDialog.ptrValueType || "int32";
                  if (!integerTypes.includes(ptrType)) return null;
                } else if (!integerTypes.includes(editDialog.valueType)) {
                  return null;
                }
                return (
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                    <InputLabel sx={{ minWidth: 90, fontSize: "0.875rem" }}>Format</InputLabel>
                    <RadioGroup
                      row
                      value={editDialog.inputFormat}
                      onChange={(e) => {
                        const newFormat = e.target.value as "dec" | "hex";
                        
                        // Get current type for masking
                        const currentType = editDialog.valueType === "ptr" 
                          ? (editDialog.ptrValueType || "int32") 
                          : editDialog.valueType;
                        const getTypeMask = (type: string): bigint => {
                          switch (type) {
                            case "int8": case "uint8": return 0xFFn;
                            case "int16": case "uint16": return 0xFFFFn;
                            case "int32": case "uint32": return 0xFFFFFFFFn;
                            case "int64": case "uint64": return 0xFFFFFFFFFFFFFFFFn;
                            default: return 0xFFFFFFFFn;
                          }
                        };
                        
                        let convertedValue = editDialog.rawValue || editDialog.currentValue;
                        if (editDialog.rawValue) {
                          try {
                            let numValue = BigInt(editDialog.rawValue);
                            numValue = numValue & getTypeMask(currentType || "int32");
                            if (newFormat === "hex") {
                              convertedValue = "0x" + numValue.toString(16).toUpperCase();
                            } else {
                              convertedValue = numValue.toString();
                            }
                          } catch {
                            // Keep original value if conversion fails
                          }
                        }
                        setEditDialog((prev) => ({
                          ...prev,
                          inputFormat: newFormat,
                          newValue: convertedValue,
                        }));
                      }}
                      sx={{ flex: 1 }}
                    >
                      <FormControlLabel
                        value="dec"
                        control={<Radio size="small" />}
                        label="Dec"
                      />
                      <FormControlLabel
                        value="hex"
                        control={<Radio size="small" />}
                        label="Hex"
                      />
                    </RadioGroup>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => {
                        if (editDialog.bookmarkId && onUpdateBookmark) {
                          onUpdateBookmark(editDialog.bookmarkId, {
                            displayFormat: editDialog.inputFormat,
                          });
                          const btn = document.activeElement as HTMLButtonElement;
                          if (btn) {
                            const originalText = btn.innerText;
                            btn.innerText = "✓";
                            btn.style.color = "#4caf50";
                            btn.style.borderColor = "#4caf50";
                            setTimeout(() => {
                              btn.innerText = originalText;
                              btn.style.color = "";
                              btn.style.borderColor = "";
                            }, 1500);
                          }
                        }
                      }}
                      disabled={!editDialog.bookmarkId || !onUpdateBookmark}
                      sx={{ minWidth: 60 }}
                    >
                      Apply
                    </Button>
                  </Box>
                );
              })()}
              
              {/* Divider */}
              <Divider />
              
              {/* Edit Section */}
              <Typography variant="subtitle2" sx={{ fontWeight: 600, color: "primary.main" }}>
                Edit
              </Typography>
              <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                <TextField
                  fullWidth
                  label="New Value"
                  size="small"
                  value={editDialog.newValue}
                  onChange={(e) =>
                    setEditDialog((prev) => ({
                      ...prev,
                      newValue: e.target.value,
                    }))
                  }
                  placeholder={(() => {
                    const effectiveType = editDialog.valueType === "ptr" 
                      ? (editDialog.ptrValueType || "int32") 
                      : editDialog.valueType;
                    const integerTypes = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"];
                    if (effectiveType && integerTypes.includes(effectiveType)) {
                      return editDialog.inputFormat === "hex"
                        ? "0x1A2B or 1A2B"
                        : "Enter decimal value...";
                    }
                    return "Enter value...";
                  })()}
                  autoFocus
                  sx={{
                    "& .MuiInputBase-input": {
                      fontFamily: "monospace",
                    },
                  }}
                />
                <Button 
                  onClick={handleEditDialogSave} 
                  variant="contained"
                  sx={{ minWidth: 70, height: 40 }}
                >
                  Save
                </Button>
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleEditDialogClose}>Close</Button>
          </DialogActions>
        </Dialog>

        {/* Manual Bookmark Dialog */}
        <Dialog
          open={manualBookmarkDialog.open}
          onClose={handleManualBookmarkDialogClose}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Add Manual Bookmark</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                fullWidth
                label={manualBookmarkDialog.valueType === "ptr" ? "Pointer Expression" : "Memory Address"}
                placeholder={
                  manualBookmarkDialog.valueType === "ptr"
                    ? "BASE+0x34ECA0 → [0x10] → [0x18] or [[Tutorial...]+0x100]+0x18"
                    : "0x12345678 or libc.so + 0x120000"
                }
                value={manualBookmarkDialog.address}
                onChange={(e) =>
                  setManualBookmarkDialog((prev) => ({
                    ...prev,
                    address: e.target.value,
                  }))
                }
                autoFocus
                helperText={
                  manualBookmarkDialog.valueType === "ptr"
                    ? "Enter pointer chain: BASE+offset → [offset] → [offset] or nested [[base]+offset]+offset"
                    : "Enter address in hex (0x...), decimal, or library+offset format"
                }
                sx={{
                  "& .MuiInputBase-input": {
                    fontFamily: "monospace",
                  },
                }}
              />
              <Box>
                <InputLabel id="bookmark-value-type-label">
                  Value Type
                </InputLabel>
                <Select
                  labelId="bookmark-value-type-label"
                  fullWidth
                  value={manualBookmarkDialog.valueType}
                  onChange={(e) => {
                    const newType = e.target.value as ScanValueType;
                    // Set default size based on type
                    let defaultSize = 4;
                    if (newType === "string") defaultSize = 64;
                    else if (newType === "bytes") defaultSize = 4;
                    setManualBookmarkDialog((prev) => ({
                      ...prev,
                      valueType: newType,
                      size: defaultSize,
                    }));
                  }}
                >
                  <MenuItem value="ptr">ptr (Pointer Chain)</MenuItem>
                  <MenuItem value="int8">int8</MenuItem>
                  <MenuItem value="uint8">uint8</MenuItem>
                  <MenuItem value="int16">int16</MenuItem>
                  <MenuItem value="uint16">uint16</MenuItem>
                  <MenuItem value="int32">int32</MenuItem>
                  <MenuItem value="uint32">uint32</MenuItem>
                  <MenuItem value="int64">int64</MenuItem>
                  <MenuItem value="uint64">uint64</MenuItem>
                  <MenuItem value="float">float</MenuItem>
                  <MenuItem value="double">double</MenuItem>
                  <MenuItem value="string">string</MenuItem>
                  <MenuItem value="bytes">bytes</MenuItem>
                </Select>
              </Box>
              {/* Pointer value type selection for ptr type */}
              {manualBookmarkDialog.valueType === "ptr" && (
                <Box>
                  <InputLabel id="bookmark-ptr-value-type-label">
                    Value Type (at final address)
                  </InputLabel>
                  <Select
                    labelId="bookmark-ptr-value-type-label"
                    fullWidth
                    value={manualBookmarkDialog.ptrValueType}
                    onChange={(e) =>
                      setManualBookmarkDialog((prev) => ({
                        ...prev,
                        ptrValueType: e.target.value as Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">,
                      }))
                    }
                  >
                    <MenuItem value="int8">int8</MenuItem>
                    <MenuItem value="uint8">uint8</MenuItem>
                    <MenuItem value="int16">int16</MenuItem>
                    <MenuItem value="uint16">uint16</MenuItem>
                    <MenuItem value="int32">int32</MenuItem>
                    <MenuItem value="uint32">uint32</MenuItem>
                    <MenuItem value="int64">int64</MenuItem>
                    <MenuItem value="uint64">uint64</MenuItem>
                    <MenuItem value="float">float</MenuItem>
                    <MenuItem value="double">double</MenuItem>
                  </Select>
                </Box>
              )}
              {/* Size field for string/bytes types */}
              {(manualBookmarkDialog.valueType === "string" ||
                manualBookmarkDialog.valueType === "bytes") && (
                <TextField
                  fullWidth
                  label="Size (bytes)"
                  type="number"
                  value={manualBookmarkDialog.size}
                  onChange={(e) =>
                    setManualBookmarkDialog((prev) => ({
                      ...prev,
                      size: Math.max(1, parseInt(e.target.value) || 1),
                    }))
                  }
                  helperText={
                    manualBookmarkDialog.valueType === "string"
                      ? "Number of characters to read"
                      : "Number of bytes to read"
                  }
                  inputProps={{ min: 1, max: 1024 }}
                />
              )}
              {/* Display format for integer types (including ptr with integer ptrValueType) */}
              {(() => {
                const valueType = manualBookmarkDialog.valueType;
                const ptrValueType = manualBookmarkDialog.ptrValueType;
                const showDisplayFormat =
                  (valueType === "ptr" && !["float", "double"].includes(ptrValueType)) ||
                  (!["string", "bytes", "float", "double", "ptr"].includes(valueType));
                return showDisplayFormat ? (
                  <Box>
                    <InputLabel id="bookmark-display-format-label">
                      Display Format
                    </InputLabel>
                    <RadioGroup
                      row
                      value={manualBookmarkDialog.displayFormat}
                      onChange={(e) =>
                        setManualBookmarkDialog((prev) => ({
                          ...prev,
                          displayFormat: e.target.value as "dec" | "hex",
                        }))
                      }
                    >
                      <FormControlLabel
                        value="dec"
                        control={<Radio size="small" />}
                        label="Decimal"
                      />
                      <FormControlLabel
                        value="hex"
                        control={<Radio size="small" />}
                        label="Hexadecimal"
                      />
                    </RadioGroup>
                  </Box>
                ) : null;
              })()}
              <TextField
                fullWidth
                label="Description (Optional)"
                placeholder=""
                value={manualBookmarkDialog.description}
                onChange={(e) =>
                  setManualBookmarkDialog((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleManualBookmarkDialogClose}>Cancel</Button>
            <Button
              onClick={handleManualBookmarkDialogSave}
              variant="contained"
              disabled={!manualBookmarkDialog.address.trim()}
            >
              Add Bookmark
            </Button>
          </DialogActions>
        </Dialog>

        {/* Hardware Watchpoint Dialog */}
        <Dialog
          open={watchpointDialog.open}
          onClose={handleWatchpointDialogClose}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Set Hardware Watchpoint</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                fullWidth
                label="Memory Address"
                placeholder="0x12345678 or 305419896"
                value={watchpointDialog.address}
                onChange={(e) =>
                  setWatchpointDialog((prev) => ({
                    ...prev,
                    address: e.target.value,
                  }))
                }
                autoFocus
                helperText="Enter address in hex (0x...) or decimal format"
                sx={{
                  "& .MuiInputBase-input": {
                    fontFamily: "monospace",
                  },
                }}
              />
              <Box>
                <InputLabel id="watchpoint-size-label">Size (bytes)</InputLabel>
                <Select
                  labelId="watchpoint-size-label"
                  fullWidth
                  value={watchpointDialog.size}
                  onChange={(e) =>
                    setWatchpointDialog((prev) => ({
                      ...prev,
                      size: e.target.value as WatchpointSize,
                    }))
                  }
                >
                  <MenuItem value={1}>1 byte</MenuItem>
                  <MenuItem value={2}>2 bytes</MenuItem>
                  <MenuItem value={4}>4 bytes</MenuItem>
                  <MenuItem value={8}>8 bytes</MenuItem>
                </Select>
              </Box>
              <Box>
                <InputLabel id="watchpoint-access-type-label">
                  Trigger Condition
                </InputLabel>
                <Select
                  labelId="watchpoint-access-type-label"
                  fullWidth
                  value={watchpointDialog.accessType}
                  onChange={(e) =>
                    setWatchpointDialog((prev) => ({
                      ...prev,
                      accessType: e.target.value as WatchpointAccessType,
                    }))
                  }
                >
                  <MenuItem value="r">Read</MenuItem>
                  <MenuItem value="w">Write</MenuItem>
                  <MenuItem value="rw">Read/Write</MenuItem>
                </Select>
              </Box>
              <TextField
                fullWidth
                label="Description (Optional)"
                placeholder="Optional description for this watchpoint"
                value={watchpointDialog.description}
                onChange={(e) =>
                  setWatchpointDialog((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleWatchpointDialogClose}>Cancel</Button>
            <Button
              onClick={handleWatchpointDialogSave}
              variant="contained"
              disabled={!watchpointDialog.address.trim()}
              color="warning"
            >
              Set Watchpoint
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </MainContent>
  );
};
