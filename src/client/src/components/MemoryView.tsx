import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  Box,
  Typography,
  TextField,
  IconButton,
  Tooltip,
  styled,
  Chip,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Autocomplete,
  Paper,
  Select,
  MenuItem,
} from "@mui/material";
import {
  Refresh,
  ViewInAr as MemoryIcon,
  MyLocation,
} from "@mui/icons-material";
import { getApiClient, ServerInfo, ModuleInfo } from "../lib/api";
import { StackView } from "./StackView";
import { Resizer } from "./Resizer";
import { useAppState } from "../hooks/useAppState";
import { useResizable } from "../hooks/useResizable";
import {
  normalizeAddressString,
  isLibraryExpression,
} from "../utils/addressEncoder";

// Styled components for modern design
const MainContainer = styled(Box)(() => ({
  height: "100%",
  display: "flex",
  flexDirection: "row",
  backgroundColor: "#1e1e1e",
  position: "relative",
}));

const MemoryViewContainer = styled(Box)(() => ({
  height: "100%",
  display: "flex",
  flexDirection: "column",
  backgroundColor: "#1e1e1e",
  position: "relative",
  overflow: "hidden",
}));

const MemoryHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #2d2d30",
  minHeight: "48px",
  height: "48px", // 固定の高さを設定（ラベル用に高さを確保）
  "@media (max-height: 800px)": {
    padding: "4px 8px",
    minHeight: "36px",
    height: "36px",
    gap: "4px",
  },
}));

const MemoryTable = styled(Table)(() => ({
  backgroundColor: "#1a1a1a",
  tableLayout: "auto", // 自動レイアウトで内部要素に合わせる
  width: "fit-content", // テーブル幅を内部要素に合わせる
  "& .MuiTableCell-root": {
    borderBottom: "1px solid #2d2d30",
    padding: "2px 4px",
    fontSize: "11px",
    fontFamily: "monospace",
    color: "#d4d4d4",
  },
  "& .MuiTableHead-root .MuiTableCell-root": {
    backgroundColor: "#252526",
    color: "#4fc1ff", // ヘッダーを青色に
    fontWeight: 600,
    fontSize: "10px",
    padding: "4px",
    position: "sticky",
    top: 0,
    zIndex: 1,
    borderBottom: "1px solid #2d2d30",
  },
  // 右上角丸（ヘッダーの最後のセル）
  "& .MuiTableHead-root .MuiTableRow-root .MuiTableCell-root:last-child": {
    borderTopRightRadius: "4px",
  },
  // 右下角丸（最後の行の最後のセル）
  "& .MuiTableBody-root .MuiTableRow-root:last-child .MuiTableCell-root:last-child":
    {
      borderBottomRightRadius: "4px",
    },
  "& .MuiTableBody-root .MuiTableRow-root": {
    minHeight: "18px", // 行の最小高さを設定
    "&:hover": {
      backgroundColor: "rgba(79, 193, 255, 0.08)", // ホバー色を調整
    },
    "& .MuiTableCell-root": {
      padding: "1px 4px", // セル内のパディングをコンパクトに
    },
  },
  "@media (max-height: 800px)": {
    "& .MuiTableCell-root": {
      padding: "1px 2px",
      fontSize: "9px",
    },
    "& .MuiTableHead-root .MuiTableCell-root": {
      fontSize: "8px",
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

const MemoryTableWrapper = styled(Box)(() => ({
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

const MemoryTableContainer = styled(Box)(() => ({
  flex: 1,
  overflow: "hidden", // スクロールバーを完全に無効化
}));

const AddressCell = styled(TableCell)(() => ({
  width: "fit-content",
  fontWeight: "normal",
  padding: "2px 12px 2px 4px", // 右側に間隔を追加
  borderRight: "1px solid #2d2d30",
  // ヘッダーとデータ行で色を分ける
  "&.MuiTableCell-head": {
    color: "#4fc1ff", // ヘッダーは青色
  },
  "&.MuiTableCell-body": {
    color: "#4fc1ff", // データ行のアドレスも青色
  },
}));

const HexCell = styled(TableCell)(() => ({
  width: "fit-content",
  padding: "2px 8px 2px 0px", // 右側に間隔を追加
  borderRight: "1px solid #2d2d30",
  "@media (max-height: 800px)": {
    padding: "1px 6px 1px 0px",
  },
}));

const HexByte = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isZero",
})<{ isZero?: boolean }>(({ isZero }) => ({
  display: "inline-block",
  width: "22px", // 少し幅を広げて余裕を持たせる
  textAlign: "center",
  color: isZero ? "#555" : "#dcdcaa",
  cursor: "pointer",
  padding: "1px 1px",
  borderRadius: "2px",
  transition: "background-color 0.1s ease",
  marginRight: "0px",
  "&:hover": {
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  "@media (max-height: 800px)": {
    width: "16px",
    padding: "0px 0px",
    marginRight: "0px",
  },
}));

const AsciiCell = styled(TableCell)(() => ({
  minWidth: "120px", // 16 characters for monospace
  width: "120px",
  color: "#ce9178",
  fontFamily: "monospace",
  whiteSpace: "pre",
  backgroundColor: "rgba(206, 145, 120, 0.05)",
  padding: "2px 0px 2px 2px",
  "@media (max-height: 800px)": {
    padding: "1px 0px 1px 0px",
  },
}));

const StatusChip = styled(Chip)<{ active?: boolean }>(({ active }) => ({
  height: "20px",
  fontSize: "9px",
  fontWeight: 600,
  cursor: "pointer",
  backgroundColor: active
    ? "rgba(76, 175, 80, 0.15)"
    : "rgba(158, 158, 158, 0.15)",
  color: active ? "#4caf50" : "#9e9e9e",
  border: active
    ? "1px solid rgba(76, 175, 80, 0.3)"
    : "1px solid rgba(158, 158, 158, 0.3)",
  "&:hover": {
    backgroundColor: active
      ? "rgba(76, 175, 80, 0.25)"
      : "rgba(158, 158, 158, 0.25)",
  },
  "& .MuiChip-label": {
    padding: "0 6px",
  },
}));

// LocalStorage key for Go to history
const MEMORY_GOTO_HISTORY_KEY = "memory_view_goto_history";
const MEMORY_DISPLAY_MODE_KEY = "memory_view_display_mode";
const MAX_HISTORY_ITEMS = 5;

// Display mode types
type MemoryDisplayMode =
  | "hex"
  | "uint8"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32"
  | "uint64"
  | "int64"
  | "float32"
  | "float64";

// Display mode configuration
const DISPLAY_MODE_CONFIG: Record<
  MemoryDisplayMode,
  { label: string; bytesPerValue: number; maxWidth: string }
> = {
  hex: { label: "Hex", bytesPerValue: 1, maxWidth: "22px" },
  uint8: { label: "U8", bytesPerValue: 1, maxWidth: "32px" },
  int8: { label: "I8", bytesPerValue: 1, maxWidth: "36px" },
  uint16: { label: "U16", bytesPerValue: 2, maxWidth: "52px" },
  int16: { label: "I16", bytesPerValue: 2, maxWidth: "56px" },
  uint32: { label: "U32", bytesPerValue: 4, maxWidth: "96px" },
  int32: { label: "I32", bytesPerValue: 4, maxWidth: "100px" },
  uint64: { label: "U64", bytesPerValue: 8, maxWidth: "180px" },
  int64: { label: "I64", bytesPerValue: 8, maxWidth: "180px" },
  float32: { label: "F32", bytesPerValue: 4, maxWidth: "110px" },
  float64: { label: "F64", bytesPerValue: 8, maxWidth: "180px" },
};

// Global memory cache to persist across tab switches
const globalMemoryCache = new Map<string, ArrayBuffer>();
let globalAutoRefresh = true;

interface MemoryViewProps {
  serverInfo?: ServerInfo;
  onAddressChange?: (address: string) => void;
  // StackViewに渡すための追加props
  registerData?: Record<string, string>; // レジスタデータ
  isInBreakState?: boolean; // ブレーク状態
  currentThreadId?: number | null; // 現在のスレッドID
  attachedModules?: ModuleInfo[]; // モジュール情報（library+offset解析用）
  resolveFunctionName?: (libraryPath: string, offset: number) => string | null; // 関数名解決
}

export const MemoryView: React.FC<MemoryViewProps> = ({
  onAddressChange,
  registerData = {},
  isInBreakState = false,
  currentThreadId = null,
  attachedModules = [],
  resolveFunctionName,
}) => {
  // Container ref for resize calculations
  const containerRef = useRef<HTMLDivElement>(null);

  // Horizontal resizer for Memory vs Stack split
  const memoryStackSplit = useResizable({
    storageKey: "memory-stack-split",
    defaultSize: 55, // Default to 55% for memory, 45% for stack
    minSize: 30,
    maxSize: 55, // Memory テーブル幅に合わせて制限（広がりすぎないように）
    orientation: "horizontal",
    containerRef,
  });

  // Use the new app state for persistent state across tab switches
  const { ui, uiActions } = useAppState();

  // Memory view uses app state
  const [currentAddress, setCurrentAddress] = useState(
    ui.debuggerState.memoryCurrentAddress
  );
  const [inputAddress, setInputAddress] = useState(
    ui.debuggerState.memoryInputAddress
  );
  const [memoryData, setMemoryData] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(globalAutoRefresh);
  const [gotoHistory, setGotoHistory] = useState<string[]>([]);
  const [displayMode, setDisplayMode] = useState<MemoryDisplayMode>(() => {
    try {
      const saved = localStorage.getItem(MEMORY_DISPLAY_MODE_KEY);
      return (saved as MemoryDisplayMode) || "hex";
    } catch {
      return "hex";
    }
  });
  const refreshIntervalRef = useRef<number | null>(null);

  // Save display mode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(MEMORY_DISPLAY_MODE_KEY, displayMode);
    } catch (e) {
      console.error("Failed to save display mode:", e);
    }
  }, [displayMode]);

  // Load history from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MEMORY_GOTO_HISTORY_KEY);
      if (saved) {
        setGotoHistory(JSON.parse(saved));
      }
    } catch (e) {
      console.error("Failed to load memory goto history:", e);
    }
  }, []);

  // Save history to localStorage
  const saveHistory = useCallback((history: string[]) => {
    try {
      localStorage.setItem(MEMORY_GOTO_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.error("Failed to save memory goto history:", e);
    }
  }, []);

  // Add address to history
  const addToHistory = useCallback(
    (address: string) => {
      setGotoHistory((prev) => {
        const filtered = prev.filter(
          (a) => a.toLowerCase() !== address.toLowerCase()
        );
        const newHistory = [address, ...filtered].slice(0, MAX_HISTORY_ITEMS);
        saveHistory(newHistory);
        return newHistory;
      });
    },
    [saveHistory]
  );

  const scrollTimeoutRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTop = useRef<number>(0);

  // Number of bytes to read per row (16 bytes = x64dbg style)
  const BYTES_PER_ROW = 16;
  const TOTAL_ROWS = 32; // Show 32 rows = 512 bytes
  const TOTAL_BYTES = BYTES_PER_ROW * TOTAL_ROWS;

  // Load memory data from server with caching
  const loadMemory = useCallback(
    async (addr: string, isAutoRefresh = false) => {
      if (!addr) return; // 空文字のみをチェック、0x0は有効なアドレス

      const cacheKey = `${addr}_${TOTAL_BYTES}`;

      // For auto-refresh, always fetch fresh data
      if (isAutoRefresh) {
        try {
          // Save scroll position before updating data
          if (scrollContainerRef.current) {
            lastScrollTop.current = scrollContainerRef.current.scrollTop;
          }

          const apiClient = getApiClient();
          const buffer = await apiClient.readMemory(addr, TOTAL_BYTES);
          setMemoryData(buffer);

          // Update global cache with fresh data
          globalMemoryCache.set(cacheKey, buffer);

          // Restore scroll position after DOM update
          setTimeout(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTop = lastScrollTop.current;
            }
          }, 0);
        } catch (err) {
          console.error("Failed to read memory during auto-refresh:", err);
        }
        return;
      }

      // Check global cache first for smooth scrolling
      if (globalMemoryCache.has(cacheKey)) {
        const cachedData = globalMemoryCache.get(cacheKey);
        if (cachedData) {
          setMemoryData(cachedData);
          return;
        }
      }

      try {
        // Don't clear existing data immediately to prevent flickering
        // setLoading(true); // Skip loading state for smoother experience
        setError(null);

        const apiClient = getApiClient();
        const buffer = await apiClient.readMemory(addr, TOTAL_BYTES);

        // Update memory data and force refresh
        setMemoryData(buffer);

        // Update global cache
        globalMemoryCache.set(cacheKey, buffer);

        // Keep cache size manageable (max 50 entries for better coverage)
        if (globalMemoryCache.size > 50) {
          const firstKey = globalMemoryCache.keys().next().value;
          if (firstKey) {
            globalMemoryCache.delete(firstKey);
          }
        }
      } catch (err) {
        console.error("Failed to read memory:", err);
        setError(err instanceof Error ? err.message : "Failed to read memory");
        // Don't clear memoryData on error to maintain display
      } finally {
        setLoading(false);
      }
    },
    [TOTAL_BYTES]
  );

  // Prefetch adjacent memory blocks for smooth scrolling
  const prefetchAdjacentMemory = useCallback(
    async (addr: string) => {
      if (!addr) return; // 空文字のみをチェック、0x0は有効なアドレス

      const currentAddr = parseInt(addr, 16);

      // Prefetch more blocks for smoother large movements
      const prefetchAddresses = [];

      // Prefetch 5 blocks in each direction for better coverage
      for (let i = 1; i <= 5; i++) {
        const prevAddr = Math.max(0, currentAddr - TOTAL_BYTES * i);
        const nextAddr = currentAddr + TOTAL_BYTES * i;
        prefetchAddresses.push(prevAddr, nextAddr);
      }

      for (const prefetchAddr of prefetchAddresses) {
        const prefetchAddrStr = `0x${prefetchAddr
          .toString(16)
          .toUpperCase()
          .padStart(16, "0")}`;
        const cacheKey = `${prefetchAddrStr}_${TOTAL_BYTES}`;

        if (!globalMemoryCache.has(cacheKey)) {
          try {
            const apiClient = getApiClient();
            const buffer = await apiClient.readMemory(
              prefetchAddrStr,
              TOTAL_BYTES
            );

            globalMemoryCache.set(cacheKey, buffer);

            // Increase cache limit for better coverage
            if (globalMemoryCache.size > 100) {
              const firstKey = globalMemoryCache.keys().next().value;
              if (firstKey) {
                globalMemoryCache.delete(firstKey);
              }
            }
          } catch (err) {
            // Ignore prefetch errors
            console.warn("Prefetch failed for address:", prefetchAddrStr);
          }
        }
      }
    },
    [TOTAL_BYTES]
  );

  // Load memory when address changes
  useEffect(() => {
    loadMemory(currentAddress);
    // Prefetch adjacent blocks for smooth scrolling
    prefetchAdjacentMemory(currentAddress);
  }, [currentAddress, loadMemory, prefetchAdjacentMemory]);

  // Sync occurs only on component unmount/mount (tab switches)
  // The initial values are set from globalStore in useState initialization

  // Auto-refresh functionality
  useEffect(() => {
    // Clear any existing interval
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }

    if (autoRefresh && currentAddress) {
      const interval = setInterval(() => {
        // Only skip auto-refresh if user is actively scrolling (more lenient condition)
        // Note: isScrolling will be false most of the time, allowing normal auto-refresh
        // Remove scrolling check temporarily to test if this is the issue
        // if (isScrolling) {
        //   console.log("Skipping auto-refresh due to scrolling");
        //   return;
        // }

        // Clear cache for current address to force fresh data
        const cacheKey = `${currentAddress}_${TOTAL_BYTES}`;
        globalMemoryCache.delete(cacheKey);

        // Load fresh memory data

        loadMemory(currentAddress, true); // Pass true to indicate auto-refresh
      }, 500); // Refresh every 0.5 seconds

      refreshIntervalRef.current = interval;
    }

    // Cleanup function
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [autoRefresh, currentAddress, loadMemory, TOTAL_BYTES]); // Remove isScrolling from dependency array

  // Scroll up by one row (16 bytes)
  const scrollUp = useCallback(() => {
    const currentAddr = parseInt(currentAddress, 16);
    const newAddr = Math.max(0, currentAddr - BYTES_PER_ROW);
    const newAddressStr = `0x${newAddr
      .toString(16)
      .toUpperCase()
      .padStart(16, "0")}`;

    // Check if data is already cached for immediate display
    const cacheKey = `${newAddressStr}_${TOTAL_BYTES}`;
    const cachedData = globalMemoryCache.get(cacheKey);

    // Only update current address for memory display, keep input address unchanged
    setCurrentAddress(newAddressStr);
    uiActions.setMemoryCurrentAddress(newAddressStr);

    // If cached, update memory data immediately to prevent any flickering
    if (cachedData) {
      setMemoryData(cachedData);
    }
  }, [currentAddress, BYTES_PER_ROW, TOTAL_BYTES, uiActions]);

  // Scroll down by one row (16 bytes)
  const scrollDown = useCallback(() => {
    const currentAddr = parseInt(currentAddress, 16);
    const newAddr = currentAddr + BYTES_PER_ROW;
    const newAddressStr = `0x${newAddr
      .toString(16)
      .toUpperCase()
      .padStart(16, "0")}`;

    // Check if data is already cached for immediate display
    const cacheKey = `${newAddressStr}_${TOTAL_BYTES}`;
    const cachedData = globalMemoryCache.get(cacheKey);

    // Only update current address for memory display, keep input address unchanged
    setCurrentAddress(newAddressStr);
    uiActions.setMemoryCurrentAddress(newAddressStr);

    // If cached, update memory data immediately to prevent any flickering
    if (cachedData) {
      setMemoryData(cachedData);
    }
  }, [currentAddress, BYTES_PER_ROW, TOTAL_BYTES, uiActions]);

  // Page scroll functions for Page Up/Down keys
  const pageScrollUp = useCallback(() => {
    const currentAddr = parseInt(currentAddress, 16);
    const newAddr = Math.max(0, currentAddr - TOTAL_BYTES);
    const newAddressStr = `0x${newAddr
      .toString(16)
      .toUpperCase()
      .padStart(16, "0")}`;

    // Check if data is already cached for immediate display
    const cacheKey = `${newAddressStr}_${TOTAL_BYTES}`;
    const cachedData = globalMemoryCache.get(cacheKey);

    // If cached, update memory data immediately to prevent flickering
    if (cachedData) {
      setMemoryData(cachedData);
    }

    // Only update current address for memory display, keep input address unchanged
    setCurrentAddress(newAddressStr);
    uiActions.setMemoryCurrentAddress(newAddressStr);
  }, [currentAddress, TOTAL_BYTES, uiActions]);

  const pageScrollDown = useCallback(() => {
    const currentAddr = parseInt(currentAddress, 16);
    const newAddr = currentAddr + TOTAL_BYTES;
    const newAddressStr = `0x${newAddr
      .toString(16)
      .toUpperCase()
      .padStart(16, "0")}`;

    // Check if data is already cached for immediate display
    const cacheKey = `${newAddressStr}_${TOTAL_BYTES}`;
    const cachedData = globalMemoryCache.get(cacheKey);

    // If cached, update memory data immediately to prevent flickering
    if (cachedData) {
      setMemoryData(cachedData);
    }

    // Only update current address for memory display, keep input address unchanged
    setCurrentAddress(newAddressStr);
    uiActions.setMemoryCurrentAddress(newAddressStr);
  }, [currentAddress, TOTAL_BYTES, uiActions]);

  // Add keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        // Don't handle keys when input field is focused
        return;
      }

      let isNavigationKey = false;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollUp();
        isNavigationKey = true;
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollDown();
        isNavigationKey = true;
      } else if (e.key === "PageUp") {
        e.preventDefault();
        pageScrollUp();
        isNavigationKey = true;
      } else if (e.key === "PageDown") {
        e.preventDefault();
        pageScrollDown();
        isNavigationKey = true;
      }

      // Navigation key was pressed - no additional action needed
      if (isNavigationKey) {
        // Navigation handled by individual functions above
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // Clean up scroll timeout on unmount
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [scrollUp, scrollDown, pageScrollUp, pageScrollDown]);

  // Handle address input change
  const handleAddressChange = useCallback(
    async (newAddress: string) => {
      try {
        let normalizedAddress: string | null;

        // Check if it's a library+offset expression
        if (isLibraryExpression(newAddress)) {
          // Parse library+offset expression
          normalizedAddress = normalizeAddressString(
            newAddress,
            attachedModules
          );

          if (!normalizedAddress) {
            console.warn(
              "Failed to parse library+offset expression:",
              newAddress
            );
            setError(
              "Failed to parse library+offset expression. Make sure the module is loaded."
            );
            return;
          }

          console.log(
            "[MemoryView] Parsed library+offset:",
            newAddress,
            "->",
            normalizedAddress
          );
        } else {
          // Direct address - normalize
          normalizedAddress = normalizeAddressString(newAddress);

          if (!normalizedAddress) {
            console.warn("Invalid address format:", newAddress);
            setError("Invalid address format");
            return;
          }
        }

        // Ensure uppercase format for consistency
        const addressValue = parseInt(
          normalizedAddress.replace(/^0x/i, ""),
          16
        );
        const formattedAddress = `0x${addressValue.toString(16).toUpperCase().padStart(8, "0")}`;

        console.log(
          "[MemoryView] Address changed:",
          newAddress,
          "->",
          formattedAddress
        );

        // Clear any previous errors
        setError(null);

        // Update both input field and current address to keep them in sync
        setInputAddress(formattedAddress);
        setCurrentAddress(formattedAddress);
        uiActions.setMemoryCurrentAddress(formattedAddress);
        uiActions.setMemoryInputAddress(formattedAddress);
        onAddressChange?.(formattedAddress);

        // Clear cache for new address to force fresh data
        const cacheKey = `${formattedAddress}_${TOTAL_BYTES}`;
        globalMemoryCache.delete(cacheKey);

        // Immediately load memory data for the new address (don't wait for useEffect)
        // This ensures immediate rendering when switching tabs
        await loadMemory(formattedAddress);
      } catch (error) {
        console.error("Error processing address:", newAddress, error);
        setError("Failed to process address");
      }
    },
    [onAddressChange, TOTAL_BYTES, loadMemory, uiActions, attachedModules]
  );

  // Monitor external memory address changes from RegisterView (both props and UI store)
  useEffect(() => {
    // Only handle non-empty addresses
    const handleExternalAddressChange = async () => {
      if (
        ui.debuggerState.memoryAddress &&
        ui.debuggerState.memoryAddress.trim()
      ) {
        console.log(
          "[MemoryView] External address change detected:",
          ui.debuggerState.memoryAddress
        );
        await handleAddressChange(ui.debuggerState.memoryAddress);
        // Clear the external address to avoid repeated triggers
        uiActions.setMemoryAddress("");
      }
    };

    handleExternalAddressChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.debuggerState.memoryAddress]); // handleAddressChange is stable, uiActions too

  // Sync autoRefresh state with global
  useEffect(() => {
    globalAutoRefresh = autoRefresh;
  }, [autoRefresh]);

  // Note: inputAddress sync is handled manually in handleAddressChange to avoid infinite loops

  // Handle auto-refresh toggle
  const handleAutoRefreshToggle = useCallback(() => {
    const newAutoRefresh = !autoRefresh;
    setAutoRefresh(newAutoRefresh);
    globalAutoRefresh = newAutoRefresh;
  }, [autoRefresh]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // より細かいスクロール制御
      const scrollThreshold = 50; // ピクセル単位でのスクロール閾値

      if (Math.abs(e.deltaY) > scrollThreshold) {
        if (e.deltaY > 0) {
          scrollDown();
        } else {
          scrollUp();
        }
      } else {
        // 小さなスクロールの場合は複数行をスクロール
        if (e.deltaY > 0) {
          scrollDown();
        } else {
          scrollUp();
        }
      }
    },
    [scrollUp, scrollDown]
  );

  // Convert buffer to hex and ASCII display data with memoization
  const displayData = useMemo(() => {
    if (!memoryData) return [];

    const uint8Array = new Uint8Array(memoryData);
    const dataView = new DataView(memoryData);
    const rows = [];
    const baseAddr = parseInt(currentAddress, 16);
    const config = DISPLAY_MODE_CONFIG[displayMode];
    const valuesPerRow = Math.floor(BYTES_PER_ROW / config.bytesPerValue);

    for (let i = 0; i < TOTAL_ROWS; i++) {
      const rowOffset = i * BYTES_PER_ROW;
      const rowAddress = baseAddr + rowOffset;
      const rowBytes = Array.from(
        uint8Array.slice(rowOffset, rowOffset + BYTES_PER_ROW)
      );

      // Generate hex representation (always needed for fallback)
      const hexBytes = rowBytes.map((byte) =>
        byte.toString(16).padStart(2, "0").toUpperCase()
      );

      // Generate values based on display mode
      const values: string[] = [];
      for (let j = 0; j < valuesPerRow; j++) {
        const offset = rowOffset + j * config.bytesPerValue;
        if (offset + config.bytesPerValue > uint8Array.length) break;

        try {
          let value: string;
          switch (displayMode) {
            case "hex":
              value =
                rowBytes[j]?.toString(16).padStart(2, "0").toUpperCase() ||
                "--";
              break;
            case "uint8":
              value = uint8Array[offset].toString();
              break;
            case "int8":
              value = (
                uint8Array[offset] > 127
                  ? uint8Array[offset] - 256
                  : uint8Array[offset]
              ).toString();
              break;
            case "uint16":
              value = dataView.getUint16(offset, true).toString();
              break;
            case "int16":
              value = dataView.getInt16(offset, true).toString();
              break;
            case "uint32":
              value = dataView.getUint32(offset, true).toString();
              break;
            case "int32":
              value = dataView.getInt32(offset, true).toString();
              break;
            case "uint64":
              value = dataView.getBigUint64(offset, true).toString();
              break;
            case "int64":
              value = dataView.getBigInt64(offset, true).toString();
              break;
            case "float32":
              const f32 = dataView.getFloat32(offset, true);
              value = isNaN(f32) || !isFinite(f32) ? "NaN" : f32.toPrecision(6);
              break;
            case "float64":
              const f64 = dataView.getFloat64(offset, true);
              value =
                isNaN(f64) || !isFinite(f64) ? "NaN" : f64.toPrecision(10);
              break;
            default:
              value = "--";
          }
          values.push(value);
        } catch {
          values.push("--");
        }
      }

      // Generate ASCII representation
      const asciiChars = rowBytes.map((byte) => {
        // Show printable ASCII characters, otherwise show '.'
        return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";
      });

      rows.push({
        address: `0x${rowAddress.toString(16).toUpperCase().padStart(16, "0")}`,
        hexBytes,
        values,
        asciiString: asciiChars.join(""),
        rawBytes: rowBytes,
      });
    }

    return rows;
  }, [memoryData, currentAddress, BYTES_PER_ROW, TOTAL_ROWS, displayMode]);

  return (
    <MainContainer ref={containerRef}>
      <MemoryViewContainer sx={{ width: `${memoryStackSplit.size}%` }}>
        {/* Memory Address Input */}
        <MemoryHeader>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              height: "100%",
            }}
          >
            <MemoryIcon
              sx={{
                fontSize: "16px",
                color: "#4fc1ff",
                "@media (max-height: 800px)": {
                  fontSize: "12px",
                },
              }}
            />
            <Typography
              variant="body2"
              sx={{
                fontSize: "12px",
                fontWeight: 600,
                color: "#4fc1ff",
                lineHeight: 1,
                "@media (max-height: 800px)": {
                  fontSize: "10px",
                },
              }}
            >
              Memory
            </Typography>
          </Box>

          {/* Spacer for input box positioning */}
          <Box
            sx={{
              width: "5px",
              "@media (max-height: 800px)": {
                width: "2px",
              },
            }}
          />

          {/* Address Input Field with History */}
          <Autocomplete
            freeSolo
            options={gotoHistory}
            inputValue={inputAddress}
            onInputChange={(_, value) => setInputAddress(value)}
            onChange={(_, value) => {
              if (value) {
                setInputAddress(value);
              }
            }}
            PaperComponent={({ children, ...props }) => (
              <Paper {...props} sx={{ backgroundColor: "#2d2d2d" }}>
                {children}
              </Paper>
            )}
            renderOption={(props, option) => {
              const { key, ...restProps } = props as any;
              return (
                <Box
                  key={key}
                  component="li"
                  {...restProps}
                  onMouseDown={(e: React.MouseEvent) => {
                    e.preventDefault();
                    setInputAddress(option);
                  }}
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "11px",
                    cursor: "pointer",
                    padding: "6px 12px",
                    "&:hover": { backgroundColor: "rgba(255,255,255,0.1)" },
                  }}
                >
                  {option}
                </Box>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Go to Address"
                placeholder=""
                InputLabelProps={{ shrink: true }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && inputAddress.trim()) {
                    e.preventDefault();
                    addToHistory(inputAddress.trim());
                    handleAddressChange(inputAddress.trim());
                    (e.target as HTMLInputElement).select();
                  }
                }}
                size="small"
                variant="outlined"
                sx={{
                  "& .MuiInputBase-input": {
                    fontSize: "11px",
                    fontFamily: "monospace",
                    py: 0.5,
                  },
                  "@media (max-height: 800px)": {
                    "& .MuiInputBase-input": {
                      fontSize: "9px",
                      py: 0.25,
                    },
                  },
                }}
              />
            )}
            sx={{
              flex: 1,
              maxWidth: 280,
              "& .MuiOutlinedInput-root": {
                height: "32px",
              },
              "@media (max-height: 800px)": {
                "& .MuiOutlinedInput-root": {
                  height: "24px",
                },
              },
            }}
          />

          <Tooltip title="Go to Address">
            <IconButton
              size="small"
              onClick={() => {
                if (inputAddress.trim()) {
                  addToHistory(inputAddress.trim());
                  handleAddressChange(inputAddress.trim());
                }
              }}
              sx={{
                "@media (max-height: 800px)": {
                  padding: 0.25,
                  "& .MuiSvgIcon-root": { fontSize: "18px" },
                },
              }}
            >
              <MyLocation fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="Refresh Memory">
            <IconButton
              size="small"
              onClick={() => {
                // Clear cache and force refresh memory at current address
                const cacheKey = `${currentAddress}_${TOTAL_BYTES}`;
                globalMemoryCache.delete(cacheKey);
                loadMemory(currentAddress);
              }}
              disabled={loading}
              sx={{
                color: "#9cdcfe",
                "&:hover": { backgroundColor: "rgba(79, 193, 255, 0.1)" },
              }}
            >
              <Refresh fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="Toggle Auto-refresh">
            <StatusChip
              label={autoRefresh ? "Auto-refresh: 0.5s" : "Auto-refresh: OFF"}
              active={autoRefresh}
              size="small"
              onClick={handleAutoRefreshToggle}
            />
          </Tooltip>

          {/* Display Mode Selector */}
          <Select
            value={displayMode}
            onChange={(e) =>
              setDisplayMode(e.target.value as MemoryDisplayMode)
            }
            size="small"
            sx={{
              minWidth: 80,
              height: 24,
              fontSize: "11px",
              fontFamily: "monospace",
              color: "#9cdcfe",
              "& .MuiSelect-select": {
                py: 0.25,
                px: 1,
              },
              "& .MuiOutlinedInput-notchedOutline": {
                borderColor: "rgba(156, 220, 254, 0.3)",
              },
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor: "rgba(156, 220, 254, 0.5)",
              },
              "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                borderColor: "#4fc1ff",
              },
              "& .MuiSvgIcon-root": {
                color: "#9cdcfe",
                fontSize: "16px",
              },
            }}
            MenuProps={{
              PaperProps: {
                sx: {
                  backgroundColor: "#2d2d2d",
                  "& .MuiMenuItem-root": {
                    fontSize: "11px",
                    fontFamily: "monospace",
                    py: 0.5,
                    "&:hover": {
                      backgroundColor: "rgba(79, 193, 255, 0.1)",
                    },
                    "&.Mui-selected": {
                      backgroundColor: "rgba(79, 193, 255, 0.2)",
                    },
                  },
                },
              },
            }}
          >
            <MenuItem value="hex">Hex</MenuItem>
            <MenuItem value="uint8">U8</MenuItem>
            <MenuItem value="int8">I8</MenuItem>
            <MenuItem value="uint16">U16</MenuItem>
            <MenuItem value="int16">I16</MenuItem>
            <MenuItem value="uint32">U32</MenuItem>
            <MenuItem value="int32">I32</MenuItem>
            <MenuItem value="uint64">U64</MenuItem>
            <MenuItem value="int64">I64</MenuItem>
            <MenuItem value="float32">F32</MenuItem>
            <MenuItem value="float64">F64</MenuItem>
          </Select>
        </MemoryHeader>

        {/* Memory Content */}
        <Box
          sx={{
            flex: 1,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {loading && (
            <Box sx={{ p: 2, textAlign: "center" }}>
              <Typography
                variant="body2"
                sx={{ color: "#9b9b9b", fontSize: "12px" }}
              >
                Loading memory...
              </Typography>
            </Box>
          )}

          {error && (
            <Box sx={{ p: 2, textAlign: "center" }}>
              <Typography
                variant="body2"
                sx={{ color: "#f44747", fontSize: "12px" }}
              >
                Error: {error}
              </Typography>
            </Box>
          )}

          {!loading && !error && displayData.length === 0 && (
            <Box sx={{ p: 2, textAlign: "center" }}>
              <Typography
                variant="body2"
                sx={{ color: "#9b9b9b", fontSize: "12px" }}
              >
                No memory data available
              </Typography>
            </Box>
          )}

          {!loading && !error && displayData.length > 0 && (
            <MemoryTableWrapper>
              <MemoryTableContainer
                ref={scrollContainerRef}
                onWheel={handleWheel}
                onScroll={() => {
                  // Track scroll position for restoration
                  if (scrollContainerRef.current) {
                    lastScrollTop.current =
                      scrollContainerRef.current.scrollTop;
                  }
                }}
              >
                <MemoryTable size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <AddressCell>Address</AddressCell>
                      <HexCell>
                        {displayMode === "hex" ? (
                          <Box
                            sx={{
                              display: "flex",
                              justifyContent: "flex-start",
                              alignItems: "center",
                            }}
                          >
                            {Array.from({ length: 16 }, (_, i) => (
                              <Box
                                key={i}
                                sx={{
                                  width: "22px",
                                  textAlign: "center",
                                  fontSize: "10px",
                                  color: "#9b9b9b",
                                  marginRight: "0px",
                                  "@media (max-height: 800px)": {
                                    width: "16px",
                                    marginRight: "0px",
                                  },
                                }}
                              >
                                {i.toString(16).toUpperCase().padStart(2, "0")}
                              </Box>
                            ))}
                          </Box>
                        ) : (
                          <Box
                            sx={{
                              display: "flex",
                              justifyContent: "flex-start",
                              alignItems: "center",
                              gap: 1,
                            }}
                          >
                            {(() => {
                              const config = DISPLAY_MODE_CONFIG[displayMode];
                              const valuesPerRow = Math.floor(
                                16 / config.bytesPerValue
                              );
                              // Match body widths: 150px for 64-bit, 100px for float64, 60px for 32-bit, 40px for 16-bit, 24px for 8-bit
                              const cellWidth =
                                displayMode === "uint64" ||
                                displayMode === "int64"
                                  ? "150px"
                                  : displayMode === "float64"
                                    ? "120px"
                                    : displayMode === "float32"
                                      ? "100px"
                                      : displayMode.includes("32")
                                        ? "80px"
                                        : displayMode.includes("16")
                                          ? "50px"
                                          : "28px";
                              return Array.from(
                                { length: valuesPerRow },
                                (_, i) => (
                                  <Typography
                                    key={i}
                                    sx={{
                                      fontSize: "10px",
                                      color: "#9b9b9b",
                                      width: cellWidth,
                                      textAlign: "right",
                                    }}
                                  >
                                    {(i * config.bytesPerValue).toString()}
                                  </Typography>
                                )
                              );
                            })()}
                          </Box>
                        )}
                      </HexCell>
                      <AsciiCell>ASCII</AsciiCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {displayData.map((row) => (
                      <TableRow key={row.address}>
                        {/* Address */}
                        <AddressCell>{row.address}</AddressCell>

                        {/* Hex Bytes or Decimal Values */}
                        <HexCell>
                          {displayMode === "hex" ? (
                            <Box
                              sx={{
                                display: "flex",
                                justifyContent: "flex-start",
                                alignItems: "center",
                              }}
                            >
                              {row.hexBytes.map((byte, byteIndex) => (
                                <HexByte
                                  key={byteIndex}
                                  isZero={parseInt(byte, 16) === 0}
                                >
                                  {byte}
                                </HexByte>
                              ))}
                              {/* Fill empty bytes if row is incomplete */}
                              {Array.from(
                                { length: BYTES_PER_ROW - row.hexBytes.length },
                                (_, i) => (
                                  <HexByte key={`empty-${i}`} isZero>
                                    --
                                  </HexByte>
                                )
                              )}
                            </Box>
                          ) : (
                            <Box
                              sx={{
                                display: "flex",
                                justifyContent: "flex-start",
                                alignItems: "center",
                                gap: 1,
                              }}
                            >
                              {row.values.map((value, idx) => (
                                <Typography
                                  key={idx}
                                  sx={{
                                    fontSize: "11px",
                                    fontFamily: "monospace",
                                    color:
                                      value === "0" || value === "0.00000"
                                        ? "#6a6a6a"
                                        : "#d4d4d4",
                                    width:
                                      displayMode === "uint64" ||
                                      displayMode === "int64"
                                        ? "150px"
                                        : displayMode === "float64"
                                          ? "120px"
                                          : displayMode === "float32"
                                            ? "100px"
                                            : displayMode.includes("32")
                                              ? "80px"
                                              : displayMode.includes("16")
                                                ? "50px"
                                                : "28px",
                                    textAlign: "right",
                                    "@media (max-height: 800px)": {
                                      fontSize: "9px",
                                    },
                                  }}
                                >
                                  {value}
                                </Typography>
                              ))}
                            </Box>
                          )}
                        </HexCell>

                        {/* ASCII */}
                        <AsciiCell>
                          {row.asciiString}
                          {/* Fill empty ASCII chars if row is incomplete */}
                          {row.hexBytes.length < BYTES_PER_ROW &&
                            ".".repeat(BYTES_PER_ROW - row.hexBytes.length)}
                        </AsciiCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </MemoryTable>
              </MemoryTableContainer>
            </MemoryTableWrapper>
          )}
        </Box>
      </MemoryViewContainer>

      {/* Horizontal Resizer */}
      <Resizer
        orientation="vertical"
        onMouseDown={memoryStackSplit.handleMouseDown}
        isResizing={memoryStackSplit.isResizing}
      />

      {/* Stack View */}
      <Box
        sx={{
          flex: 1,
          overflow: "hidden",
        }}
      >
        <StackView
          spRegister={
            registerData?.SP ||
            registerData?.sp ||
            registerData?.RSP ||
            registerData?.rsp ||
            null
          }
          isInBreakState={isInBreakState}
          currentThreadId={currentThreadId}
          attachedModules={attachedModules}
          resolveFunctionName={resolveFunctionName}
          onNavigateToAddress={(address) => {
            // Navigate to assembly view with the clicked address
            uiActions.setAssemblyAddress(address);
          }}
        />
      </Box>
    </MainContainer>
  );
};
