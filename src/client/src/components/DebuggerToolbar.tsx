import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  Box,
  TextField,
  IconButton,
  Tooltip,
  Stack,
  Divider,
  Chip,
  Typography,
  Alert,
  Snackbar,
  Autocomplete,
  Paper,
  Popover,
  List,
  ListItem,
  ListItemButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Checkbox,
} from "@mui/material";
import { Delete as DeleteIcon } from "@mui/icons-material";
import {
  PlayArrow,
  FiberManualRecord,
  MyLocation,
  SwapHoriz,
  SkipNext,
  ArrowBack,
  ViewSidebar,
  Settings as SettingsIcon,
} from "@mui/icons-material";
import { getApiClient, ModuleInfo } from "../lib/api";
import { useGlobalDebugLogger } from "../hooks/useGlobalDebugLogger";
import { useGlobalExceptionHandler } from "../hooks/useGlobalExceptionHandler";
import { useUIActions } from "../stores/uiStore";
import { useUIStore } from "../stores/uiStore";
import {
  normalizeAddressString,
  normalizeAddressStringAsync,
  isLibraryExpression,
} from "../utils/addressEncoder";
import { useSymbolCache } from "../hooks/useSymbolCache";

// LocalStorage key for Go to history
const GOTO_HISTORY_KEY = "debugger_goto_history";
const MAX_HISTORY_ITEMS = 5;

// Stopped thread info for thread switching
export interface StoppedThreadInfo {
  threadId: number;
  address: string;
  instruction: string;
  timestamp: Date;
  isCurrent: boolean;
  exceptionType: string; // "breakpoint", "watchpoint", "singlestep"
}

export interface DebuggerToolbarProps {
  debuggerConnected: boolean;
  debuggerState: "idle" | "attached" | "debugging";
  visible: boolean;
  showRegisters?: boolean;
  showSidebar?: boolean;
  attachedProcess?: {
    pid: number;
    name: string;
  };
  isInBreakState?: boolean;
  currentThreadId?: number | null; // Current active thread for debugging operations
  onToggleRegisters?: () => void;
  onToggleSidebar?: () => void;
  onGoToAddress?: (address: string) => void;
  onSetBreakpoint?: (address: string, isSoftware?: boolean) => void;
  onRemoveBreakpoint?: (address: string) => void;
  onRemoveBreakpoints?: (addresses: string[]) => void; // Bulk delete
  breakpoints?: string[];
  softwareBreakpoints?: string[]; // Track which breakpoints are software
  breakpointInputValue?: string;
  onBreakpointInputChange?: (value: string) => void;
  isSoftwareBreakpoint?: boolean; // Current breakpoint type toggle state
  onBreakpointTypeChange?: (isSoftware: boolean) => void; // Callback for breakpoint type change
  onBreakStateChange?: (isBreaking: boolean) => void;
  onLastActionChange?: (
    action: "continue" | "single_step" | "breakpoint" | null
  ) => void;
  onSwitchThread?: (threadId: number, exception: any) => void; // Switch to another stopped thread
  attachedModules?: ModuleInfo[]; // Add attached modules for library+offset parsing
  connectionHost?: string; // Server connection host for symbol loading
  connectionPort?: number; // Server connection port for symbol loading
  targetOs?: string; // Target OS (e.g., "ios", "macos", "android")
}

export const DebuggerToolbar: React.FC<DebuggerToolbarProps> = ({
  debuggerConnected,
  visible,
  attachedProcess,
  isInBreakState = false,
  showSidebar = false,
  currentThreadId, // Extract currentThreadId from props
  onGoToAddress,
  onSetBreakpoint,
  onRemoveBreakpoint,
  onRemoveBreakpoints,
  breakpoints = [],
  softwareBreakpoints = [],
  breakpointInputValue = "",
  onBreakpointInputChange,
  isSoftwareBreakpoint = false,
  onBreakpointTypeChange,
  onBreakStateChange,
  onLastActionChange,
  onSwitchThread, // Thread switching callback
  onToggleSidebar,
  attachedModules = [], // Extract attached modules
  connectionHost,
  connectionPort,
  targetOs,
}) => {
  const { logInfo, logError, logDebug, logWarn } = useGlobalDebugLogger();
  const { allStoppedThreads, clearAllStoppedThreads, checkNow } =
    useGlobalExceptionHandler();
  const uiActions = useUIActions();
  const gotoAddress = useUIStore((state) => state.debuggerState.gotoAddress);
  const assemblyNavigationHistory = useUIStore(
    (state) => state.debuggerState.assemblyNavigationHistory
  );
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error" | "info";
  }>({ open: false, message: "", severity: "info" });

  // Thread list popover anchor
  const [threadPopoverAnchor, setThreadPopoverAnchor] =
    useState<HTMLElement | null>(null);
  const threadPopoverOpen = Boolean(threadPopoverAnchor);

  // Address display format toggle (true = detail with symbol, false = raw hex)
  const [showDetailFormat, setShowDetailFormat] = useState(true);

  // Breakpoint list dialog state
  const [breakpointListOpen, setBreakpointListOpen] = useState(false);
  const [selectedBreakpoints, setSelectedBreakpoints] = useState<Set<string>>(
    new Set()
  );

  // Symbol cache for address formatting
  const { formatAddressWithSymbol } = useSymbolCache();

  // Build stopped threads list from allStoppedThreads map
  const stoppedThreads = useMemo((): StoppedThreadInfo[] => {
    const threads: StoppedThreadInfo[] = [];

    // Build list from allStoppedThreads map
    allStoppedThreads.forEach((exception, threadId) => {
      threads.push({
        threadId,
        address: exception.address || "unknown",
        instruction: exception.instruction || "unknown",
        timestamp: exception.timestamp,
        isCurrent: threadId === currentThreadId,
        exceptionType: exception.type || "unknown",
      });
    });

    // Sort by thread ID (ascending)
    threads.sort((a, b) => a.threadId - b.threadId);

    return threads;
  }, [allStoppedThreads, currentThreadId]);

  // Format address based on display mode
  const formatThreadAddress = useCallback(
    (address: string): string => {
      if (!showDetailFormat) {
        return address;
      }

      // Try to convert to module@function+offset format
      try {
        // Handle addresses with leading 0x or without
        const cleanAddress =
          address.replace(/^0x/i, "").replace(/^0+/, "") || "0";
        const numericAddress = parseInt(cleanAddress, 16);
        if (!isNaN(numericAddress) && attachedModules.length > 0) {
          // Use formatAddressWithSymbol for module@function+offset format
          const symbolExpr = formatAddressWithSymbol(
            numericAddress,
            attachedModules,
            "function" // Use function format for symbol names
          );
          if (symbolExpr) {
            return symbolExpr;
          }
        }
      } catch (e) {
        // Fallback to original address
      }
      return address;
    },
    [showDetailFormat, attachedModules, formatAddressWithSymbol]
  );

  // Convert number to circled number (①②③...)
  const toCircledNumber = (n: number): string => {
    const circledNumbers = [
      "①",
      "②",
      "③",
      "④",
      "⑤",
      "⑥",
      "⑦",
      "⑧",
      "⑨",
      "⑩",
      "⑪",
      "⑫",
      "⑬",
      "⑭",
      "⑮",
      "⑯",
      "⑰",
      "⑱",
      "⑲",
      "⑳",
    ];
    if (n >= 1 && n <= 20) {
      return circledNumbers[n - 1];
    }
    return `(${n})`;
  };

  // Get exception type display string
  const getExceptionTypeLabel = (type: string): string => {
    switch (type.toLowerCase()) {
      case "breakpoint":
        return "BREAKPOINT";
      case "watchpoint":
        return "WATCHPOINT";
      case "singlestep":
        return "SINGLE STEP";
      default:
        return type.toUpperCase();
    }
  };

  // Handle thread chip click to open popover
  const handleThreadChipClick = (event: React.MouseEvent<HTMLElement>) => {
    if (stoppedThreads.length > 1) {
      setThreadPopoverAnchor(event.currentTarget);
    }
  };

  // Handle thread switch
  const handleThreadSwitch = (threadId: number) => {
    // Find the exception for this thread from allStoppedThreads
    const exception = allStoppedThreads.get(threadId);

    if (exception && onSwitchThread) {
      logInfo("DEBUGGER_TOOLBAR", `Switching to thread ${threadId}`);
      onSwitchThread(threadId, exception);
    }

    setThreadPopoverAnchor(null);
  };

  // Go to address history
  const [gotoHistory, setGotoHistory] = useState<string[]>([]);

  // Load history from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(GOTO_HISTORY_KEY);
      if (saved) {
        setGotoHistory(JSON.parse(saved));
      }
    } catch (e) {
      console.error("Failed to load goto history:", e);
    }
  }, []);

  // Save history to localStorage
  const saveHistory = useCallback((history: string[]) => {
    try {
      localStorage.setItem(GOTO_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.error("Failed to save goto history:", e);
    }
  }, []);

  // Add address to history
  const addToHistory = useCallback(
    (address: string) => {
      setGotoHistory((prev) => {
        // Remove if already exists, then add to front
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

  const apiClient = getApiClient();

  // Get setCurrentHitAddress for source-level debugging
  const setCurrentHitAddress = useUIStore(
    (state) => state.actions.setCurrentHitAddress
  );

  // Use controlled input for breakpoint if provided, otherwise use local state
  const [localBreakpointInput, setLocalBreakpointInput] = useState("");
  const breakpointInput =
    breakpointInputValue !== undefined
      ? breakpointInputValue
      : localBreakpointInput;
  const setBreakpointInput = onBreakpointInputChange || setLocalBreakpointInput;

  // Handle continue execution
  const handleContinue = useCallback(async () => {
    try {
      // Get all stopped thread IDs
      const stoppedThreadIds = Array.from(allStoppedThreads.keys());

      logInfo(
        "DEBUGGER_TOOLBAR",
        `Continuing ${stoppedThreadIds.length} stopped thread(s)`,
        {
          threadIds: stoppedThreadIds,
          currentThreadId,
        }
      );

      // Threads at active breakpoints need single-step first
      const threadsNeedingSingleStep: number[] = [];
      const threadsForDirectContinue: number[] = [];

      for (const threadId of stoppedThreadIds) {
        const exception = allStoppedThreads.get(threadId);
        const isBreakpointHit = exception?.type === "breakpoint";
        const threadAddress = exception?.address;
        const breakpointStillExists =
          threadAddress &&
          breakpoints.some(
            (bp) => bp.toLowerCase() === threadAddress.toLowerCase()
          );

        if (isBreakpointHit && breakpointStillExists) {
          threadsNeedingSingleStep.push(threadId);
        } else {
          threadsForDirectContinue.push(threadId);
        }
      }

      // シングルステップが必要なスレッドを先に処理
      for (const threadId of threadsNeedingSingleStep) {
        logInfo(
          "DEBUGGER_TOOLBAR",
          "Breakpoint hit detected and still exists - executing single step before continue",
          { threadId }
        );
        const stepResponse = await apiClient.singleStep(threadId);
        if (!stepResponse.success) {
          logError(
            "DEBUGGER_TOOLBAR",
            `Failed to single step thread ${threadId}: ${stepResponse.message}`
          );
        }
      }

      // 全スレッドを一括でcontinue（シングルステップ後のスレッドも含む）
      logInfo(
        "DEBUGGER_TOOLBAR",
        `Continuing all ${stoppedThreadIds.length} threads in single API call`,
        { threadIds: stoppedThreadIds }
      );

      const response =
        await apiClient.continueExecutionMultiple(stoppedThreadIds);
      if (!response.success) {
        logError("DEBUGGER_TOOLBAR", `Continue failed: ${response.message}`);
        if (response.results) {
          for (const result of response.results) {
            if (!result.success) {
              logError(
                "DEBUGGER_TOOLBAR",
                `Thread ${result.thread_id} failed: ${result.message}`
              );
            }
          }
        }
      } else {
        logDebug(
          "DEBUGGER_TOOLBAR",
          `All threads continued: ${response.message}`
        );
      }

      // Clear all stopped threads after continuing all
      clearAllStoppedThreads();
      logDebug("DEBUGGER_TOOLBAR", "Cleared all stopped threads on continue");

      // Clear current hit address for source-level debugging
      setCurrentHitAddress(null);

      // Set break state to false immediately after continue command
      logDebug(
        "DEBUGGER_TOOLBAR",
        "Setting break state to false after continue",
        {
          threadIds: stoppedThreadIds,
        }
      );
      if (onBreakStateChange) {
        onBreakStateChange(false);
        logDebug("DEBUGGER_TOOLBAR", "Break state set to false successfully");
      } else {
        logWarn(
          "DEBUGGER_TOOLBAR",
          "onBreakStateChange callback is not available"
        );
      }
      // Record that continue action was performed
      if (onLastActionChange) {
        onLastActionChange("continue");
      }
      // Trigger immediate exception check after continue with slight delay
      setTimeout(() => {
        if ((window as any).forceExceptionCheck) {
          (window as any).forceExceptionCheck();
        }
      }, 100);
    } catch (error) {
      console.error("Continue execution failed:", error);
      setSnackbar({
        open: true,
        message:
          error instanceof Error
            ? error.message
            : "Failed to continue execution",
        severity: "error",
      });
    }
  }, [
    apiClient,
    currentThreadId,
    onBreakStateChange,
    onLastActionChange,
    clearAllStoppedThreads,
    allStoppedThreads,
    breakpoints,
    logInfo,
    logError,
    logDebug,
    setCurrentHitAddress,
  ]);

  // Handle single step
  const handleSingleStep = useCallback(async () => {
    const startTime = performance.now();
    console.log(`[SINGLE_STEP] Button clicked at ${new Date().toISOString()}`);
    try {
      logInfo("DEBUGGER_TOOLBAR", "Executing single step command", {
        threadId: currentThreadId,
        action: "single_step",
      });
      console.log(
        `[SINGLE_STEP] About to call API, elapsed: ${(performance.now() - startTime).toFixed(2)}ms`
      );
      const response = await apiClient.singleStep(currentThreadId || undefined);
      console.log(
        `[SINGLE_STEP] API response received, elapsed: ${(performance.now() - startTime).toFixed(2)}ms`
      );
      logDebug("DEBUGGER_TOOLBAR", "Single step server response", response);

      if (response.success) {
        logInfo("DEBUGGER_TOOLBAR", "Single step successful", {
          threadId: currentThreadId,
          action: "single_step",
        });
        // Record that single step action was performed
        if (onLastActionChange) {
          onLastActionChange("single_step");
        }
        // Immediately check for exceptions instead of waiting for polling
        console.log(`[SINGLE_STEP] Triggering immediate exception check`);
        checkNow();
      } else {
        logError("DEBUGGER_TOOLBAR", "Single step failed", {
          message: response.message,
          threadId: currentThreadId,
        });
        throw new Error(response.message || "Failed to single step");
      }
    } catch (error) {
      logError("DEBUGGER_TOOLBAR", "Single step execution failed", {
        error: error instanceof Error ? error.message : String(error),
        threadId: currentThreadId,
      });
      setSnackbar({
        open: true,
        message:
          error instanceof Error ? error.message : "Failed to single step",
        severity: "error",
      });
    }
  }, [apiClient, currentThreadId, onLastActionChange, checkNow]);

  // Handle go to address
  const handleGoToAddress = useCallback(async () => {
    if (gotoAddress.trim()) {
      // Check if it's a library+offset expression
      const isLibExpr = isLibraryExpression(gotoAddress);

      if (isLibExpr) {
        // Check if we have connection info for async symbol loading
        const serverInfo =
          connectionHost && connectionPort
            ? {
                ip: connectionHost,
                port: connectionPort,
              }
            : null;

        if (serverInfo && attachedModules.length > 0) {
          // Use async version that can load symbols on-demand
          const normalizedAddress = await normalizeAddressStringAsync(
            gotoAddress,
            attachedModules,
            serverInfo
          );

          if (normalizedAddress) {
            console.log(
              `Parsed library+offset expression "${gotoAddress}" to address ${normalizedAddress}`
            );
            addToHistory(gotoAddress);
            // Use setAssemblyAddressWithHistory to track navigation for Back button
            uiActions.setAssemblyAddressWithHistory(normalizedAddress);
            if (onGoToAddress) {
              onGoToAddress(normalizedAddress);
            }
          } else {
            setSnackbar({
              open: true,
              message: `Failed to parse library+offset expression: ${gotoAddress}. Make sure the module is loaded.`,
              severity: "error",
            });
            console.error(
              `Failed to parse library+offset expression: ${gotoAddress}`
            );
          }
        } else {
          // Fallback to sync version (library+offset only, no function lookup)
          const normalizedAddress = normalizeAddressString(
            gotoAddress,
            attachedModules
          );

          if (normalizedAddress) {
            console.log(
              `Parsed library+offset expression "${gotoAddress}" to address ${normalizedAddress}`
            );
            addToHistory(gotoAddress);
            // Use setAssemblyAddressWithHistory to track navigation for Back button
            uiActions.setAssemblyAddressWithHistory(normalizedAddress);
            if (onGoToAddress) {
              onGoToAddress(normalizedAddress);
            }
          } else {
            setSnackbar({
              open: true,
              message: `Failed to parse library+offset expression: ${gotoAddress}. Make sure the module is loaded.`,
              severity: "error",
            });
            console.error(
              `Failed to parse library+offset expression: ${gotoAddress}`
            );
          }
        }
      } else {
        // Direct address - normalize and navigate
        const normalizedAddress = normalizeAddressString(gotoAddress);

        if (normalizedAddress) {
          addToHistory(gotoAddress); // Add to history
          // Use setAssemblyAddressWithHistory to track navigation for Back button
          uiActions.setAssemblyAddressWithHistory(normalizedAddress);
          if (onGoToAddress) {
            onGoToAddress(normalizedAddress);
          }
        } else {
          // Show error for invalid address format
          setSnackbar({
            open: true,
            message: `Invalid address format: ${gotoAddress}`,
            severity: "error",
          });
          console.error(`Invalid address format: ${gotoAddress}`);
        }
      }
    }
  }, [
    gotoAddress,
    onGoToAddress,
    attachedModules,
    addToHistory,
    connectionHost,
    connectionPort,
    uiActions,
  ]);

  // Handle set breakpoint
  const handleSetBreakpoint = useCallback(async () => {
    if (breakpointInput.trim() && onSetBreakpoint) {
      // Check if it's a library+offset expression
      const isLibExpr = isLibraryExpression(breakpointInput);

      if (isLibExpr) {
        // Check if we have connection info for async symbol loading
        const serverInfo =
          connectionHost && connectionPort
            ? {
                ip: connectionHost,
                port: connectionPort,
              }
            : null;

        if (serverInfo && attachedModules.length > 0) {
          // Use async version that can load symbols on-demand
          const normalizedAddress = await normalizeAddressStringAsync(
            breakpointInput,
            attachedModules,
            serverInfo
          );

          if (normalizedAddress) {
            console.log(
              `Parsed breakpoint library+offset expression "${breakpointInput}" to address ${normalizedAddress} (software: ${isSoftwareBreakpoint})`
            );
            onSetBreakpoint(normalizedAddress, isSoftwareBreakpoint);
            setBreakpointInput("");
          } else {
            setSnackbar({
              open: true,
              message: `Failed to parse library+offset expression: ${breakpointInput}. Make sure the module is loaded.`,
              severity: "error",
            });
            console.error(
              `Failed to parse library+offset expression: ${breakpointInput}`
            );
          }
        } else {
          // Fallback to sync version
          const normalizedAddress = normalizeAddressString(
            breakpointInput,
            attachedModules
          );

          if (normalizedAddress) {
            console.log(
              `Parsed breakpoint library+offset expression "${breakpointInput}" to address ${normalizedAddress} (software: ${isSoftwareBreakpoint})`
            );
            onSetBreakpoint(normalizedAddress, isSoftwareBreakpoint);
            setBreakpointInput("");
          } else {
            setSnackbar({
              open: true,
              message: `Failed to parse library+offset expression: ${breakpointInput}. Make sure the module is loaded.`,
              severity: "error",
            });
            console.error(
              `Failed to parse library+offset expression: ${breakpointInput}`
            );
          }
        }
      } else {
        // Direct address - normalize and set breakpoint
        const normalizedAddress = normalizeAddressString(breakpointInput);

        if (normalizedAddress) {
          console.log(
            "[BP SET] Direct address, isSoftwareBreakpoint:",
            isSoftwareBreakpoint
          );
          onSetBreakpoint(normalizedAddress, isSoftwareBreakpoint);
          setBreakpointInput(""); // Clear input after setting
        } else {
          // Show error for invalid address format
          setSnackbar({
            open: true,
            message: `Invalid address format: ${breakpointInput}`,
            severity: "error",
          });
          console.error(`Invalid address format: ${breakpointInput}`);
        }
      }
    }
  }, [
    breakpointInput,
    onSetBreakpoint,
    isSoftwareBreakpoint,
    attachedModules,
    connectionHost,
    connectionPort,
  ]);

  // Handle remove breakpoint
  const handleRemoveBreakpoint = useCallback(
    (address: string) => {
      if (onRemoveBreakpoint) {
        onRemoveBreakpoint(address);
      }
    },
    [onRemoveBreakpoint]
  );

  // Handle navigate to breakpoint address
  const handleNavigateToBreakpoint = useCallback(
    (address: string) => {
      if (onGoToAddress) {
        onGoToAddress(address);
      }
    },
    [onGoToAddress]
  );

  if (!visible) return null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        p: 1,
        borderBottom: 1,
        borderColor: "divider",
        backgroundColor: "background.paper",
        minHeight: 48,
        flexWrap: "wrap",
        "@media (max-height: 800px)": {
          gap: 0.5,
          p: 0.5,
          minHeight: 36,
        },
      }}
    >
      {/* Debugger Settings Button - Hidden on iOS */}
      {targetOs !== "ios" && (
        <Tooltip title="Debugger Settings">
          <IconButton
            size="small"
            onClick={() => uiActions.setDebuggerSettingsOpen(true)}
            sx={{
              color: "#858585",
              "&:hover": { backgroundColor: "#2d2d30", color: "#4fc1ff" },
              "@media (max-height: 800px)": {
                padding: 0.25,
                "& .MuiSvgIcon-root": { fontSize: "18px" },
              },
            }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {/* Sidebar Toggle Button */}
      <Tooltip title={showSidebar ? "Hide Sidebar" : "Show Sidebar"}>
        <IconButton
          size="small"
          onClick={onToggleSidebar}
          color={showSidebar ? "primary" : "default"}
          sx={{
            backgroundColor: showSidebar
              ? "rgba(33, 150, 243, 0.15)"
              : "transparent",
            "&:hover": {
              backgroundColor: showSidebar
                ? "rgba(33, 150, 243, 0.25)"
                : "rgba(255, 255, 255, 0.08)",
            },
            "@media (max-height: 800px)": {
              padding: 0.25,
              "& .MuiSvgIcon-root": { fontSize: "18px" },
            },
          }}
        >
          <ViewSidebar fontSize="small" />
        </IconButton>
      </Tooltip>

      <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

      {/* Debug Control Buttons */}
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{
          "@media (max-height: 800px)": {
            spacing: 0.25,
          },
        }}
      >
        {/* Break State Controls - Only show when in break state */}
        {isInBreakState && (
          <>
            <Tooltip title="Continue Execution (F5)">
              <span>
                <IconButton
                  size="small"
                  onClick={handleContinue}
                  disabled={!debuggerConnected || !attachedProcess}
                  color="success"
                  sx={{
                    backgroundColor: "rgba(76, 175, 80, 0.1)",
                    "&:hover": { backgroundColor: "rgba(76, 175, 80, 0.2)" },
                    "@media (max-height: 800px)": {
                      padding: 0.25,
                      "& .MuiSvgIcon-root": { fontSize: "18px" },
                    },
                  }}
                >
                  <PlayArrow fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="Step Into (F10)">
              <span>
                <IconButton
                  size="small"
                  onClick={handleSingleStep}
                  disabled={!debuggerConnected || !attachedProcess}
                  color="primary"
                  sx={{
                    backgroundColor: "rgba(33, 150, 243, 0.1)",
                    "&:hover": { backgroundColor: "rgba(33, 150, 243, 0.2)" },
                    "@media (max-height: 800px)": {
                      padding: 0.25,
                      "& .MuiSvgIcon-root": { fontSize: "18px" },
                    },
                  }}
                >
                  <SkipNext fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>

            {/* Thread ID Display - Clickable to show thread list */}
            {currentThreadId !== null && currentThreadId !== undefined && (
              <Tooltip
                title={
                  stoppedThreads.length > 1
                    ? "Click to switch threads"
                    : `Thread ${currentThreadId}`
                }
              >
                <Chip
                  icon={
                    stoppedThreads.length > 1 ? (
                      <SwapHoriz sx={{ fontSize: "14px !important" }} />
                    ) : undefined
                  }
                  label={`Thread:${currentThreadId}${stoppedThreads.length > 1 ? ` ${toCircledNumber(stoppedThreads.length)}` : ""}`}
                  size="small"
                  variant="outlined"
                  color="info"
                  onClick={handleThreadChipClick}
                  sx={{
                    ml: 1,
                    height: 24,
                    fontSize: "10px",
                    fontFamily: "monospace",
                    fontWeight: 600,
                    cursor: stoppedThreads.length > 1 ? "pointer" : "default",
                    "& .MuiChip-label": {
                      px: 1,
                    },
                    "&:hover":
                      stoppedThreads.length > 1
                        ? {
                            backgroundColor: "rgba(33, 150, 243, 0.1)",
                          }
                        : {},
                    "@media (max-height: 800px)": {
                      height: 20,
                      fontSize: "9px",
                      "& .MuiChip-label": { px: 0.5 },
                    },
                  }}
                />
              </Tooltip>
            )}

            {/* Thread Switcher Popover */}
            <Popover
              open={threadPopoverOpen}
              anchorEl={threadPopoverAnchor}
              onClose={() => setThreadPopoverAnchor(null)}
              anchorOrigin={{
                vertical: "bottom",
                horizontal: "left",
              }}
              transformOrigin={{
                vertical: "top",
                horizontal: "left",
              }}
            >
              <Paper sx={{ minWidth: 220, maxHeight: 300, overflow: "auto" }}>
                <Box
                  sx={{
                    px: 1,
                    py: 0.5,
                    borderBottom: 1,
                    borderColor: "divider",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: 600, fontSize: "10px" }}
                  >
                    Stopped Threads ({stoppedThreads.length})
                  </Typography>
                  <Tooltip
                    title={
                      showDetailFormat
                        ? "Show raw address"
                        : "Show detailed (module@symbol+offset)"
                    }
                  >
                    <Typography
                      variant="caption"
                      onClick={() => setShowDetailFormat(!showDetailFormat)}
                      sx={{
                        fontSize: "9px",
                        color: "primary.main",
                        cursor: "pointer",
                        "&:hover": { textDecoration: "underline" },
                      }}
                    >
                      {showDetailFormat ? "[detail]" : "[raw]"}
                    </Typography>
                  </Tooltip>
                </Box>
                <List dense disablePadding>
                  {stoppedThreads.map((thread, index) => (
                    <ListItem
                      key={thread.threadId}
                      disablePadding
                      sx={{
                        borderBottom:
                          index < stoppedThreads.length - 1
                            ? "1px solid"
                            : "none",
                        borderColor: "divider",
                      }}
                    >
                      <ListItemButton
                        selected={thread.isCurrent}
                        onClick={() =>
                          !thread.isCurrent &&
                          handleThreadSwitch(thread.threadId)
                        }
                        disabled={thread.isCurrent}
                        sx={{ py: 0.5, px: 1 }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            flexDirection: "column",
                            width: "100%",
                          }}
                        >
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Typography
                              variant="body2"
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "11px",
                                fontWeight: thread.isCurrent ? 600 : 400,
                              }}
                            >
                              {toCircledNumber(index + 1)} {thread.threadId}
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{
                                fontSize: "9px",
                                color: "text.secondary",
                              }}
                            >
                              {getExceptionTypeLabel(thread.exceptionType)}
                            </Typography>
                            {thread.isCurrent && (
                              <Typography
                                variant="caption"
                                sx={{
                                  fontSize: "9px",
                                  color: "info.main",
                                  fontWeight: 600,
                                }}
                              >
                                *
                              </Typography>
                            )}
                          </Box>
                          <Tooltip title={thread.address} placement="right">
                            <Typography
                              variant="caption"
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "9px",
                                color: "text.secondary",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: 200,
                                cursor: "help",
                              }}
                            >
                              {formatThreadAddress(thread.address)}
                            </Typography>
                          </Tooltip>
                        </Box>
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              </Paper>
            </Popover>

            <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />
          </>
        )}
      </Stack>

      {/* Disassembly Navigation - Only show when stopped */}
      <Stack direction="row" spacing={1} alignItems="center">
        <Autocomplete
          freeSolo
          options={gotoHistory}
          inputValue={gotoAddress}
          onInputChange={(_, value) => uiActions.setGotoAddress(value)}
          onChange={(_, value) => {
            if (value) {
              uiActions.setGotoAddress(value);
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
                  uiActions.setGotoAddress(option);
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
              placeholder="0x400000, lib.so+0x120, lib.so@func"
              InputLabelProps={{ shrink: true }}
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  handleGoToAddress();
                }
              }}
              size="small"
              variant="outlined"
              sx={{
                width: 280,
                "& .MuiInputBase-input": {
                  fontSize: "11px",
                  fontFamily: "monospace",
                  py: 0.5,
                },
                "@media (max-height: 800px)": {
                  width: 220,
                  "& .MuiInputBase-input": {
                    fontSize: "9px",
                    py: 0.25,
                  },
                },
              }}
            />
          )}
          sx={{
            width: 280,
            "& .MuiOutlinedInput-root": {
              height: "32px",
            },
            "@media (max-height: 800px)": {
              width: 220,
              "& .MuiOutlinedInput-root": {
                height: "24px",
              },
            },
          }}
        />
        <Tooltip title="Go to Address">
          <span>
            <IconButton
              size="small"
              onClick={handleGoToAddress}
              disabled={!gotoAddress.trim()}
              sx={{
                "@media (max-height: 800px)": {
                  padding: 0.25,
                  "& .MuiSvgIcon-root": { fontSize: "18px" },
                },
              }}
            >
              <MyLocation fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Go Back">
          <span>
            <IconButton
              size="small"
              onClick={() => uiActions.goBackAssemblyNavigation()}
              disabled={assemblyNavigationHistory.length === 0}
              sx={{
                "@media (max-height: 800px)": {
                  padding: 0.25,
                  "& .MuiSvgIcon-root": { fontSize: "18px" },
                },
              }}
            >
              <ArrowBack fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />

      {/* Breakpoint Management - Always show */}
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          label="Set Breakpoint"
          placeholder=""
          InputLabelProps={{ shrink: true }}
          value={breakpointInput}
          onChange={(e) => setBreakpointInput(e.target.value)}
          onKeyPress={(e) => {
            if (e.key === "Enter") {
              handleSetBreakpoint();
            }
          }}
          size="small"
          variant="outlined"
          sx={{
            width: 210,
            "& .MuiOutlinedInput-root": {
              height: "32px",
            },
            "& .MuiInputBase-input": {
              fontSize: "11px",
              fontFamily: "monospace",
              py: 0.5,
            },
            "@media (max-height: 800px)": {
              width: 165,
              "& .MuiOutlinedInput-root": {
                height: "24px",
              },
              "& .MuiInputBase-input": {
                fontSize: "9px",
                py: 0.25,
              },
            },
          }}
        />
        <Tooltip title="Set Breakpoint">
          <span>
            <IconButton
              size="small"
              onClick={handleSetBreakpoint}
              disabled={!breakpointInput.trim()}
              color="error"
              sx={{
                "@media (max-height: 800px)": {
                  padding: 0.25,
                  "& .MuiSvgIcon-root": { fontSize: "18px" },
                },
              }}
            >
              <FiberManualRecord fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {/* Software/Hardware Breakpoint Toggle */}
        <Tooltip
          title={
            isSoftwareBreakpoint
              ? "Software Breakpoint (click for Hardware)"
              : "Hardware Breakpoint (click for Software)"
          }
        >
          <Chip
            size="small"
            label={isSoftwareBreakpoint ? "SW" : "HW"}
            onClick={() => {
              console.log(
                "[BP TYPE] Toggle clicked, current:",
                isSoftwareBreakpoint,
                "-> new:",
                !isSoftwareBreakpoint
              );
              onBreakpointTypeChange?.(!isSoftwareBreakpoint);
            }}
            color={isSoftwareBreakpoint ? "warning" : "primary"}
            variant="outlined"
            sx={{
              minWidth: 36,
              height: 24,
              fontSize: "10px",
              fontWeight: 600,
              cursor: "pointer",
              "@media (max-height: 800px)": {
                height: 20,
                fontSize: "8px",
                minWidth: 28,
              },
            }}
          />
        </Tooltip>
      </Stack>

      {/* Active Breakpoints Display - Always show when breakpoints exist */}
      {breakpoints.length > 0 && (
        <>
          <Divider
            orientation="vertical"
            flexItem
            sx={{
              mx: 1,
              "@media (max-height: 800px)": { mx: 0.5 },
            }}
          />
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{
              maxWidth: 300,
              overflow: "hidden",
              "@media (max-height: 800px)": {
                maxWidth: 200,
                spacing: 0.25,
              },
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontSize: "10px",
                fontWeight: 600,
                color: "text.secondary",
                "@media (max-height: 800px)": {
                  fontSize: "8px",
                },
              }}
            >
              Active:
            </Typography>
            <Box
              sx={{
                display: "flex",
                gap: 0.5,
                flexWrap: "wrap",
                overflow: "auto",
                "@media (max-height: 800px)": {
                  gap: 0.25,
                },
              }}
            >
              {breakpoints.slice(0, 3).map((bp) => (
                <Chip
                  key={bp}
                  label={bp}
                  size="small"
                  variant="outlined"
                  color="error"
                  onClick={() => handleNavigateToBreakpoint(bp)}
                  onDelete={() => handleRemoveBreakpoint(bp)}
                  sx={{
                    height: 22,
                    fontSize: "9px",
                    fontFamily: "monospace",
                    cursor: "pointer",
                    "& .MuiChip-label": {
                      px: 0.5,
                      py: 0,
                      lineHeight: 1.2,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100%",
                    },
                    "& .MuiChip-deleteIcon": { fontSize: "12px" },
                    "&:hover": {
                      backgroundColor: "rgba(244, 67, 54, 0.1)",
                    },
                    "@media (max-height: 800px)": {
                      height: 18,
                      fontSize: "8px",
                      "& .MuiChip-label": { px: 0.25 },
                      "& .MuiChip-deleteIcon": { fontSize: "10px" },
                    },
                  }}
                />
              ))}
              {breakpoints.length > 3 && (
                <Chip
                  size="small"
                  label={`+${breakpoints.length - 3}`}
                  onClick={() => setBreakpointListOpen(true)}
                  variant="outlined"
                  color="default"
                  sx={{
                    height: 22,
                    fontSize: "9px",
                    cursor: "pointer",
                    "& .MuiChip-label": {
                      px: 0.5,
                    },
                    "&:hover": {
                      backgroundColor: "rgba(255, 255, 255, 0.1)",
                    },
                    "@media (max-height: 800px)": {
                      height: 18,
                      fontSize: "7px",
                    },
                  }}
                />
              )}
            </Box>
          </Stack>
        </>
      )}

      <Box sx={{ flex: 1 }} />

      {/* Right side controls */}
      <Stack direction="row" spacing={0.5} alignItems="center"></Stack>

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>

      {/* Breakpoint List Dialog */}
      <Dialog
        open={breakpointListOpen}
        onClose={() => {
          setBreakpointListOpen(false);
          setSelectedBreakpoints(new Set());
        }}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Active Breakpoints ({breakpoints.length})</span>
          {selectedBreakpoints.size > 0 && (
            <Button
              size="small"
              color="error"
              variant="contained"
              startIcon={<DeleteIcon />}
              onClick={() => {
                if (onRemoveBreakpoints) {
                  onRemoveBreakpoints(Array.from(selectedBreakpoints));
                } else {
                  // Fallback: remove one by one
                  selectedBreakpoints.forEach((bp) =>
                    handleRemoveBreakpoint(bp)
                  );
                }
                setSelectedBreakpoints(new Set());
              }}
            >
              Delete Selected ({selectedBreakpoints.size})
            </Button>
          )}
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          {breakpoints.length === 0 ? (
            <Typography
              color="text.secondary"
              sx={{ py: 4, textAlign: "center" }}
            >
              No breakpoints set
            </Typography>
          ) : (
            <TableContainer sx={{ maxHeight: 400 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox
                        indeterminate={
                          selectedBreakpoints.size > 0 &&
                          selectedBreakpoints.size < breakpoints.length
                        }
                        checked={
                          breakpoints.length > 0 &&
                          selectedBreakpoints.size === breakpoints.length
                        }
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedBreakpoints(new Set(breakpoints));
                          } else {
                            setSelectedBreakpoints(new Set());
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: "bold" }}>#</TableCell>
                    <TableCell sx={{ fontWeight: "bold" }}>Address</TableCell>
                    <TableCell sx={{ fontWeight: "bold" }}>Detail</TableCell>
                    <TableCell sx={{ fontWeight: "bold", width: 80 }}>
                      Type
                    </TableCell>
                    <TableCell
                      sx={{ fontWeight: "bold", width: 60 }}
                      align="center"
                    >
                      Delete
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {breakpoints.map((bp, index) => {
                    const isSoftware = softwareBreakpoints.includes(bp);
                    return (
                      <TableRow
                        key={bp}
                        hover
                        sx={{
                          "&:hover": { backgroundColor: "action.hover" },
                        }}
                      >
                        <TableCell padding="checkbox">
                          <Checkbox
                            checked={selectedBreakpoints.has(bp)}
                            onChange={(e) => {
                              const newSelected = new Set(selectedBreakpoints);
                              if (e.target.checked) {
                                newSelected.add(bp);
                              } else {
                                newSelected.delete(bp);
                              }
                              setSelectedBreakpoints(newSelected);
                            }}
                          />
                        </TableCell>
                        <TableCell
                          sx={{ fontFamily: "monospace", fontSize: "12px" }}
                        >
                          {index + 1}
                        </TableCell>
                        <TableCell>
                          <Typography
                            component="span"
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "13px",
                              cursor: "pointer",
                              "&:hover": {
                                color: "primary.main",
                                textDecoration: "underline",
                              },
                            }}
                            onClick={() => {
                              handleNavigateToBreakpoint(bp);
                              setBreakpointListOpen(false);
                            }}
                          >
                            {bp}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography
                            component="span"
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "12px",
                              color: "text.secondary",
                            }}
                          >
                            {(() => {
                              try {
                                const addr = parseInt(
                                  bp.replace(/^0x/i, ""),
                                  16
                                );
                                if (!isNaN(addr)) {
                                  const detail = formatAddressWithSymbol(
                                    addr,
                                    attachedModules,
                                    "function"
                                  );
                                  // Only show if it's different from the raw address
                                  if (
                                    detail &&
                                    detail !== bp &&
                                    !detail.startsWith("0x")
                                  ) {
                                    return detail;
                                  }
                                }
                                return "-";
                              } catch {
                                return "-";
                              }
                            })()}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={isSoftware ? "SW" : "HW"}
                            size="small"
                            sx={{
                              backgroundColor: isSoftware
                                ? "#4caf50"
                                : "#f44336",
                              color: "white",
                              fontWeight: "bold",
                              fontSize: "10px",
                              height: "20px",
                            }}
                          />
                        </TableCell>
                        <TableCell align="center">
                          <IconButton
                            size="small"
                            onClick={() => handleRemoveBreakpoint(bp)}
                            sx={{ color: "error.main" }}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setBreakpointListOpen(false);
              setSelectedBreakpoints(new Set());
            }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
