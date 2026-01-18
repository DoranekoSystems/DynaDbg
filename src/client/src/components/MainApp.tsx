import React, { useCallback, useState, useEffect, useRef } from "react";
import { ThemeProvider, CssBaseline, Snackbar, Alert } from "@mui/material";
import { AppGrid, ToolbarArea } from "../utils/constants";
import { darkTheme } from "../utils/theme";
import { Header } from "../components/Header";
import { HomePage } from "../components/HomePage";
import { HomeSidebar, HomeSubPage } from "../components/HomeSidebar";
import { HelpContent } from "../components/HelpContent";
import { DocumentationContent } from "../components/DocumentationContent";
import { NewsContent, useUnreadNewsCount } from "../components/NewsContent";
import { AboutContent } from "../components/AboutContent";
import { SettingsContent } from "../components/SettingsContent";
import { DebuggerContent } from "../components/DebuggerContent";
import { DebuggerToolbar } from "../components/DebuggerToolbar";
import { DebuggerSidebar } from "../components/DebuggerSidebar";
import { RegisterView } from "../components/RegisterView";
import { InformationContent } from "../components/InformationContent";
import { ServerContent } from "../components/ServerContent";
import { ScannerSidebar } from "../components/ScannerSidebar";
import { ScannerContent } from "../components/ScannerContent";
import { ScannerToolbar } from "../components/ScannerToolbar";
import { ToolsContent } from "../components/ToolsContent";
import { StatusBarComponent } from "../components/StatusBar";
import { StatePanel } from "../components/StatePanel";
import { DebugLoggerProvider } from "../hooks/useGlobalDebugLogger";
import {} from "../hooks/useGlobalNetworkLogger";
import { GlobalExceptionHandlerProvider } from "../hooks/useGlobalExceptionHandler";

import { useScannerGlobalState } from "../hooks/useScannerGlobalState";
import { useScannerState } from "../hooks/useScannerState";
import { useSymbolCache } from "../hooks/useSymbolCache";
import {
  useWatchpointHandler,
  useBreakpointHandler,
} from "../hooks/useGlobalExceptionHandler";
import type { ScriptBreakpointEvent } from "../hooks/useExceptionHandler";
import { getApiClient } from "../lib/api";
import type {
  WatchpointInfo,
  WatchpointSize,
  WatchpointAccessType,
  ScanHistoryItem,
  ScanSettings,
} from "../types";
import type { ProcessInfo } from "../lib/api";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAppState } from "../hooks/useAppState";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useGhidraAnalysis } from "../hooks/useGhidraAnalysis";

// Props interface for AppContent when it needs to pass state to parent
interface AppContentProps {
  onConnectionStateChange?: (
    serverConnected: boolean,
    debuggerConnected: boolean,
    attachedProcess?: ProcessInfo
  ) => void;
  onBreakpointHit?: any; // Exception data instead of callback
  onBreakpointStateChange?: (hasActiveBreakpoints: boolean) => void;
  // onWatchpointStateChange is no longer needed - use system.watchpoints directly
  onBreakpointHandler?: (handler: (exception: any) => void) => void; // Add this to pass handler up
}

// Main Application Component
const AppContent: React.FC<AppContentProps> = ({
  onConnectionStateChange,
  onBreakpointHit: _onBreakpointHit,
  onBreakpointStateChange,
}) => {
  const { system, ui, systemActions, uiActions } = useAppState();

  // RegisterView width from localStorage (shared with RegisterView component)
  const [registerWidth, setRegisterWidth] = useLocalStorage<number>(
    "register-view-width",
    300
  );

  // Debugger sidebar visibility state (persisted)
  const [showDebuggerSidebar, setShowDebuggerSidebar] =
    useLocalStorage<boolean>("show-debugger-sidebar", false);

  // Toggle debugger sidebar visibility
  const handleToggleDebuggerSidebar = useCallback(() => {
    setShowDebuggerSidebar(!showDebuggerSidebar);
  }, [showDebuggerSidebar, setShowDebuggerSidebar]);

  // Development mode check
  const isDevelopment = false; //import.meta.env.DEV;

  const {
    serverConnected,
    debuggerConnected,
    connectionHost,
    connectionPort,
    attachedProcess,
    serverInfo,
    attachedAppInfo,
    attachedModules,
    isInBreakState,
    currentThreadId,
    currentBreakAddress,
    currentRegisterData,
    activeBreakpoints,
    softwareBreakpoints,
    watchpoints,
    spawnSuspended,
  } = system;

  const {
    currentMode,
    sidebarWidth,
    debuggerSidebarWidth,
    scannerSidebarWidth,
    showRegisters,
    showToolbar,
    debuggerState,
  } = ui;

  // Ghidra analysis hook for function name resolution
  const { resolveFunctionName } = useGhidraAnalysis();

  const handleModeChange = useCallback(
    (mode: any) => {
      uiActions.setCurrentMode(mode);

      // Clear inline styles when switching modes (removes sidebar resize effect)
      const gridElement = document.querySelector(
        "[data-sidebar-grid]"
      ) as HTMLElement;
      if (gridElement) {
        gridElement.style.gridTemplateColumns = "";
      }
    },
    [uiActions]
  );

  const handleToggleRegisters = useCallback(() => {
    uiActions.setShowRegisters(!showRegisters);
  }, [uiActions, showRegisters]);

  const updateCurrentRegisterData = useCallback(
    (data: Record<string, string>) => {
      systemActions.updateDebugState(undefined, undefined, undefined, data);
    },
    [systemActions]
  );

  const [lastDebugAction, setLastDebugAction] = useState<
    "continue" | "single_step" | "breakpoint" | null
  >(null);

  // Software/Hardware breakpoint toggle state
  const [isSoftwareBreakpoint, setIsSoftwareBreakpoint] = useState(false);

  // Debug: log when breakpoint type changes
  useEffect(() => {
    console.log(
      "[MainApp] isSoftwareBreakpoint changed to:",
      isSoftwareBreakpoint
    );
  }, [isSoftwareBreakpoint]);

  // Snackbar state for notifications
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "error" | "warning" | "info" | "success";
  }>({
    open: false,
    message: "",
    severity: "info",
  });

  // Home page sub-navigation state
  const [homeSubPage, setHomeSubPage] = useState<HomeSubPage>("home");
  const [unreadNewsCount, setUnreadNewsCount] = useState(0);

  // Get initial unread news count
  const initialUnreadCount = useUnreadNewsCount();
  useEffect(() => {
    setUnreadNewsCount(initialUnreadCount);
  }, [initialUnreadCount]);

  // Reset homeSubPage when leaving home mode
  useEffect(() => {
    if (currentMode !== "home") {
      setHomeSubPage("home");
    }
  }, [currentMode]);

  // sidebarWidthは既にグローバルストアから取得しているので、追加処理は不要

  // Notify parent about connection state changes
  useEffect(() => {
    if (onConnectionStateChange) {
      onConnectionStateChange(
        serverConnected,
        debuggerConnected,
        attachedProcess
      );
    }
  }, [
    serverConnected,
    debuggerConnected,
    attachedProcess,
    onConnectionStateChange,
  ]);

  // Test logging
  useEffect(() => {
    if (isDevelopment) {
      console.log(
        "MainApp: Development mode detected, test logs should appear"
      );
    }
  }, [isDevelopment]);

  // Scanner state from legacy hooks (for compatibility)
  // Use global scanner state
  const {
    scannerState,
    scanResults,
    scanHistory: globalScanHistory,
    bookmarks,
    scanSettings,
    updateFullScanSettings,
    removeBookmark,
    updateBookmark,
    addManualBookmark,
    isAddressBookmarked,
    handleResultBookmark,
  } = useScannerGlobalState();

  // New scanner state hook with full implementation
  const {
    memoryRegionsLoaded,
    updateScanSettings,
    performFirstScan,
    performNextScan,
    performNewScan,
    handleResultEdit,
    handleResultDelete,
    stopScan,
    clearScan,
    onSelectHistory,
    onRemoveHistoryItem,
    onClearHistory,
    updateBookmarkAddressesFromModules,
  } = useScannerState();

  const { updateServerInfo, clearCache: clearSymbolCache } = useSymbolCache();

  useEffect(() => {
    if (connectionHost && connectionPort) {
      updateServerInfo({ ip: connectionHost, port: connectionPort });
    } else {
      updateServerInfo(null);
    }
  }, [connectionHost, connectionPort, updateServerInfo]);

  // Handle module updates - must be after useScannerState to use updateBookmarkAddressesFromModules
  const handleModulesUpdate = useCallback(
    (modules: any[]) => {
      systemActions.updateModules(modules);
      // Update bookmark addresses when modules are reloaded
      updateBookmarkAddressesFromModules(modules);
    },
    [systemActions, updateBookmarkAddressesFromModules]
  );

  // Track previous mode to only refresh on actual mode change
  const prevModeRef = useRef<string | null>(null);

  // Auto-refresh modules when switching to debugger or scanner mode
  useEffect(() => {
    const prevMode = prevModeRef.current;
    prevModeRef.current = currentMode;

    // Only refresh if mode actually changed (not on initial render or same mode)
    if (
      prevMode !== null &&
      prevMode !== currentMode &&
      (currentMode === "debugger" || currentMode === "scanner") &&
      attachedProcess
    ) {
      const refreshModules = async () => {
        try {
          const apiClient = getApiClient();
          const response = await apiClient.enumerateModules();
          if (response.data?.modules) {
            console.log(
              `[MainApp] Auto-refreshed modules on ${currentMode} mode switch:`,
              response.data.modules.length
            );
            handleModulesUpdate(response.data.modules);
          }
        } catch (error) {
          console.error("[MainApp] Failed to auto-refresh modules:", error);
        }
      };
      refreshModules();
    }
  }, [currentMode, attachedProcess, handleModulesUpdate]);

  // Enhanced history selection handler that ensures global state is updated
  const handleSelectHistory = useCallback(
    (item: ScanHistoryItem) => {
      // First call the original handler
      if (onSelectHistory) {
        onSelectHistory(item);
      }

      // Also ensure global state is updated with all settings from history
      const newSettings: ScanSettings = {
        // Start with current base settings
        ...scanSettings,
        // Apply all settings from the history item including permissions, ranges, alignment
        ...item.scanSettings,
        // Explicitly set the core search parameters
        valueType: item.valueType,
        scanType: item.scanType,
        value: item.value,
      };
      if (updateFullScanSettings) {
        updateFullScanSettings(newSettings);
      }
    },
    [onSelectHistory, scanSettings, updateFullScanSettings]
  );

  // Create a wrapper for scan settings update to match expected signature
  const handleScanSettingsChange = useCallback(
    (settings: ScanSettings) => {
      if (updateFullScanSettings) {
        updateFullScanSettings(settings);
      }
      if (updateScanSettings) {
        updateScanSettings(settings); // Also update the original hook for compatibility
      }
      return true;
    },
    [updateFullScanSettings, updateScanSettings]
  );

  // Debugger content state - now using UI store
  const { breakpointNotification, breakpointInputValue, memoryAddress } =
    debuggerState;

  const updateAssemblyAddress = uiActions.setAssemblyAddress;
  const showBreakpointNotification = uiActions.showBreakpointNotification;
  const hideBreakpointNotification = uiActions.hideBreakpointNotification;
  const updateBreakpointInputValue = uiActions.setBreakpointInputValue;
  const updateMemoryAddress = uiActions.setMemoryAddress;

  const addActiveBreakpoint = (address: string, isSoftware?: boolean) =>
    systemActions.addBreakpoint(address, isSoftware);
  const removeActiveBreakpoint = (address: string) =>
    systemActions.removeBreakpoint(address);

  // Scanner tab state
  const [scannerCurrentTab, setScannerCurrentTab] = useState(0);

  // Information state from UI store
  const {
    currentTab: informationCurrentTab,
    nameFilter: modulesNameFilter,
    sortField: modulesSortField,
    sortDirection: modulesSortDirection,
  } = ui.informationState;

  const setInformationCurrentTab = uiActions.setInformationTab;
  const setModulesNameFilter = uiActions.setInformationNameFilter;
  const handleModulesSortChange = (
    field: "baseAddress" | "size" | null,
    direction: "asc" | "desc"
  ) => {
    uiActions.setInformationSort(field || "name", direction);
  };

  // Notify parent about breakpoint state changes
  const lastBreakpointCount = React.useRef(0);
  useEffect(() => {
    const currentCount = activeBreakpoints.length;
    console.log("[BREAKPOINT STATE] Count changed:", {
      currentCount,
      lastCount: lastBreakpointCount.current,
      activeBreakpoints,
      hasCallback: !!onBreakpointStateChange,
    });

    if (
      onBreakpointStateChange &&
      lastBreakpointCount.current !== currentCount
    ) {
      const hasBreakpoints = currentCount > 0;
      lastBreakpointCount.current = currentCount;
      console.log("[BREAKPOINT STATE] Calling onBreakpointStateChange:", {
        hasBreakpoints,
        currentCount,
      });
      onBreakpointStateChange(hasBreakpoints);
    }
  }, [activeBreakpoints.length, onBreakpointStateChange]);

  // Legacy state for compatibility
  const [lastHealthCheck] = useState<{
    latency: number;
    timestamp: string;
  } | null>(null);

  // Use global watchpoint handler for watchpoint windows (independent of debugger tab)
  useWatchpointHandler((exception) => {
    console.log(`[WATCHPOINT] Watchpoint exception received:`, exception);

    // Find matching watchpoint from state based on memory_address
    const memoryAddress = exception.memory_address;
    if (!memoryAddress) {
      console.warn(
        "[WATCHPOINT] No memory_address in exception, cannot determine watchpoint"
      );
      return;
    }

    // Find the watchpoint that covers this memory address
    const matchingWatchpoint = watchpoints.find((wp) => {
      const wpAddr =
        typeof wp.address === "string" ? parseInt(wp.address, 16) : wp.address;
      return memoryAddress >= wpAddr && memoryAddress < wpAddr + wp.size;
    });

    if (!matchingWatchpoint) {
      console.warn(
        `[WATCHPOINT] No matching watchpoint found for memory address 0x${memoryAddress.toString(16)}`
      );
      return;
    }

    console.log(
      `[WATCHPOINT] Matched watchpoint ${matchingWatchpoint.id} for address ${exception.address}`
    );

    // Check if window is already opened or has been closed for this watchpoint
    const windowLabel = `watchpoint_${matchingWatchpoint.id}`;
    if (
      watchpointWindowsRef.current.has(windowLabel) ||
      closedWatchpointWindowsRef.current.has(windowLabel)
    ) {
      console.log(
        `[WATCHPOINT] Window already exists or was closed for watchpoint: ${windowLabel}`
      );
      return;
    }

    // Create watchpoint window using the matched watchpoint info
    // Convert to WatchpointInfo type (createdAt string to Date)
    const watchpointInfo: WatchpointInfo = {
      ...matchingWatchpoint,
      accessType: matchingWatchpoint.accessType as "r" | "w" | "rw",
      createdAt: new Date(matchingWatchpoint.createdAt),
    };
    createWatchpointWindow(watchpointInfo);
  });

  // Handle register data update from exception handler
  const handleRegisterDataUpdate = useCallback(
    (registerData: Record<string, string>) => {
      console.log(
        "[REGISTER DEBUG] MainApp: Received register data:",
        registerData
      );
      updateCurrentRegisterData(registerData);
    },
    [updateCurrentRegisterData]
  );

  // Track processed exception timestamps to prevent duplicate processing
  const processedExceptionTimestampRef = useRef<number>(0);

  // Handle breakpoint hit from global exception handler - full exception processing
  const handleGlobalBreakpointHit = useCallback(
    (exception: any) => {
      console.log(
        `[SINGLE_STEP] Exception received at ${new Date().toISOString()}, type: ${exception.type}`
      );

      // Prevent duplicate processing of the same exception
      const exceptionTimestamp = exception.timestamp?.getTime?.() || Date.now();
      if (processedExceptionTimestampRef.current === exceptionTimestamp) {
        console.log(
          `[MAINAPP BREAK DEBUG] Skipping duplicate exception processing for timestamp ${exceptionTimestamp}`
        );
        return;
      }
      processedExceptionTimestampRef.current = exceptionTimestamp;

      // Detect architecture based on available registers
      const isX86_64 =
        (exception as any).rax !== undefined ||
        (exception as any).rip !== undefined;

      // Get the program counter address based on architecture
      // For x86_64: use RIP, for ARM64: use PC or address field
      let address = exception.address || "unknown";
      if (isX86_64 && (exception as any).rip !== undefined) {
        const rip = (exception as any).rip;
        address =
          typeof rip === "number"
            ? `0x${rip.toString(16)}`
            : typeof rip === "string"
              ? rip
              : address;
      } else if (!isX86_64 && (exception as any).pc !== undefined) {
        const pc = (exception as any).pc;
        address =
          typeof pc === "number"
            ? `0x${pc.toString(16)}`
            : typeof pc === "string"
              ? pc
              : address;
      }

      console.log(
        `[MAINAPP BREAK DEBUG] Breakpoint hit at address: ${address} (isX86_64: ${isX86_64})`
      );

      // Record breakpoint hit time to prevent interference from onBreakStateChange
      (window as any).__lastBreakpointHitTime = Date.now();

      // Switch to debugger mode when breakpoint is hit
      uiActions.setCurrentMode("debugger");

      // Process register data from exception first (before updating state)
      const registerData: Record<string, string> = {};

      // Extract register fields from the exception object based on architecture
      const registerFields = isX86_64
        ? [
            // x86_64 registers
            "rax",
            "rbx",
            "rcx",
            "rdx",
            "rsi",
            "rdi",
            "rbp",
            "rsp",
            "r8",
            "r9",
            "r10",
            "r11",
            "r12",
            "r13",
            "r14",
            "r15",
            "rip",
            "rflags",
            "cs",
            "ss",
            "ds",
            "es",
            "fs",
            "gs",
          ]
        : [
            // ARM64 registers
            "x0",
            "x1",
            "x2",
            "x3",
            "x4",
            "x5",
            "x6",
            "x7",
            "x8",
            "x9",
            "x10",
            "x11",
            "x12",
            "x13",
            "x14",
            "x15",
            "x16",
            "x17",
            "x18",
            "x19",
            "x20",
            "x21",
            "x22",
            "x23",
            "x24",
            "x25",
            "x26",
            "x27",
            "x28",
            "x29",
            "lr",
            "fp",
            "sp",
            "pc",
            "cpsr",
          ];

      registerFields.forEach((field) => {
        const value = (exception as any)[field];
        if (value !== undefined && value !== null) {
          if (typeof value === "number") {
            registerData[field.toUpperCase()] =
              `0x${value.toString(16).padStart(16, "0")}`;
          } else if (typeof value === "string") {
            registerData[field.toUpperCase()] = value;
          }
        }
      });

      console.log(
        "[REGISTER DEBUG] MainApp: Extracted register data from exception:",
        registerData
      );

      // Update all debug state atomically through Tauri in a single batch
      // This includes register data to avoid multiple round-trips
      systemActions.updateDebugState(
        true, // isInBreakState
        exception.thread_id || undefined, // currentThreadId
        address, // currentBreakAddress
        Object.keys(registerData).length > 0 ? registerData : undefined // registerData in same batch
      );
    },
    [systemActions, uiActions]
  );

  // NOTE: onBreakpointHit prop is no longer used for processing - useBreakpointHandler handles all breakpoints
  // The prop may still be passed for legacy compatibility but is not processed here to avoid duplicates

  // Use global breakpoint handler for breakpoint processing
  const breakpointHandler = useCallback(
    (exception: any) => {
      handleGlobalBreakpointHit(exception);
    },
    [handleGlobalBreakpointHit]
  );

  useBreakpointHandler(breakpointHandler);

  // Handle breakpoint hit from DebuggerContent - just address string
  const handleBreakpointHit = useCallback((_address: string) => {
    // This is called from DebuggerContent and just provides the address
    // The main processing is already done by handleGlobalBreakpointHit
  }, []);

  // Watchpoint exception windows state (use ref for immediate tracking)
  const watchpointWindowsRef = React.useRef<Set<string>>(new Set());
  // Track closed watchpoint windows to prevent re-opening
  const closedWatchpointWindowsRef = React.useRef<Set<string>>(new Set());

  // Create new window for watchpoint exception monitoring
  const createWatchpointWindow = useCallback(
    async (watchpoint: WatchpointInfo) => {
      try {
        const windowLabel = `watchpoint_${watchpoint.id}`;

        // Check if window already exists (check Ref for immediate status)
        if (watchpointWindowsRef.current.has(windowLabel)) {
          console.log(
            "Window already exists for watchpoint (ref check):",
            windowLabel
          );
          return;
        }

        // Add to ref immediately to prevent race conditions
        watchpointWindowsRef.current.add(windowLabel);

        console.log("Creating watchpoint window:", windowLabel);
        console.log("Watchpoint data:", watchpoint);

        // **IMPORTANT: Save watchpoint state to Tauri state BEFORE creating window**
        console.log(
          "Saving watchpoint to Tauri state before window creation..."
        );

        // First, ensure the watchpoint is saved to the system state
        const watchpointForState = {
          id: watchpoint.id,
          address: watchpoint.address,
          size: watchpoint.size,
          accessType: watchpoint.accessType,
          hitCount: watchpoint.hitCount || 0,
          createdAt: watchpoint.createdAt.toISOString(),
          description: watchpoint.description,
        };

        // Add watchpoint to system state immediately
        systemActions.addWatchpoint(watchpointForState);
        console.log("Watchpoint saved to system state:", watchpointForState);

        // Wait for state to be persisted (allow React state updates to complete)
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Verify the watchpoint is in the state before proceeding
        const currentWatchpoints = watchpoints;
        const isWatchpointSaved = currentWatchpoints.some(
          (w) => w.id === watchpoint.id
        );
        if (!isWatchpointSaved) {
          console.warn(
            "Watchpoint not found in state after save, proceeding anyway..."
          );
        } else {
          console.log(
            "Watchpoint confirmed in state, proceeding with window creation"
          );
        }

        // Determine the base URL based on environment
        // In development: use localhost:1420 (Vite dev server)
        // In production: use tauri://localhost (bundled assets)
        const isDev = import.meta.env.DEV;
        const baseUrl = isDev ? "http://localhost:1420" : "tauri://localhost";

        const window = new WebviewWindow(windowLabel, {
          url: `${baseUrl}/#/watchpoint-exception/${watchpoint.id}`,
          title: `Watchpoint Exception Monitor`,
          width: 1000,
          height: 600,
          minWidth: 800,
          minHeight: 400,
          resizable: true,
          maximized: false,
          decorations: true,
          alwaysOnTop: true, // Make window always on top for initial visibility
          skipTaskbar: false,
          center: true,
          focus: true,
          visible: true,
          // Add additional properties for debugging
          acceptFirstMouse: true,
          titleBarStyle: "visible",
          shadow: true,
        });

        console.log("Window created successfully:", windowLabel);

        // Wait for window to be fully loaded
        await window.once("tauri://window-created", () => {
          console.log("Window fully created event received:", windowLabel);
        });

        // Show the window explicitly
        try {
          await window.show();
          console.log("Window show() called successfully:", windowLabel);
        } catch (showError) {
          console.error("Failed to show window:", showError);
        }

        // Focus the window
        try {
          await window.setFocus();
          console.log("Window focus set successfully:", windowLabel);

          // Disable always on top after showing the window
          setTimeout(async () => {
            try {
              await window.setAlwaysOnTop(false);
              console.log("Always on top disabled for:", windowLabel);
            } catch (alwaysOnTopError) {
              console.error(
                "Failed to disable always on top:",
                alwaysOnTopError
              );
            }
          }, 2000); // Wait 2 seconds before disabling always on top
        } catch (focusError) {
          console.error("Failed to focus window:", focusError);
        }

        // Listen for window close event
        window.once("tauri://close-requested", async () => {
          console.log("Window close requested:", windowLabel);

          try {
            // Remove from tracking first
            watchpointWindowsRef.current.delete(windowLabel);
            // Add to closed windows to prevent re-opening
            closedWatchpointWindowsRef.current.add(windowLabel);

            // **IMPORTANT: Remove from Tauri state when window closes**
            console.log("Removing watchpoint from Tauri state:", watchpoint.id);
            systemActions.removeWatchpoint(watchpoint.id);

            // Remove watchpoint from server
            try {
              console.log(
                "Removing watchpoint from server:",
                watchpoint.address
              );
              const apiClient = getApiClient();
              const addressNum = parseInt(watchpoint.address, 16);
              await apiClient.removeWatchpoint({ address: addressNum });
              console.log("Watchpoint removed from server successfully");
            } catch (error) {
              console.error("Failed to remove watchpoint from server:", error);
            }

            // Close the window immediately
            await window.close();
          } catch (error) {
            console.error("Error during window close process:", error);
          }
        });

        // Listen for additional window events for debugging
        window.once("tauri://destroyed", () => {
          console.log("Window destroyed:", windowLabel);
        });
      } catch (error) {
        console.error("Failed to create watchpoint window:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        console.error("Error details:", {
          message: errorMessage,
          stack: errorStack,
          watchpoint: watchpoint,
        });

        // **IMPORTANT: Clean up Tauri state if window creation failed**
        console.log(
          "Cleaning up watchpoint from Tauri state due to window creation failure"
        );
        systemActions.removeWatchpoint(watchpoint.id);

        // Remove from tracking if creation failed
        const windowLabel = `watchpoint_${watchpoint.id}`;
        watchpointWindowsRef.current.delete(windowLabel);
      }
    },
    [systemActions, watchpoints] // Remove watchpointWindows from dependencies, use ref instead
  );

  // Watchpoint handlers
  const handleSetWatchpoint = useCallback(
    async (
      address: string,
      size: WatchpointSize,
      accessType: WatchpointAccessType,
      description?: string
    ): Promise<boolean> => {
      try {
        // **STEP 0: Check watchpoint limit BEFORE calling API**
        const currentWatchpoints = watchpoints || [];
        const targetOs = system.serverInfo?.target_os;
        const MAX_WATCHPOINTS_ANDROID = 1;

        if (
          (targetOs === "android" || targetOs === "linux") &&
          currentWatchpoints.length >= MAX_WATCHPOINTS_ANDROID
        ) {
          setSnackbar({
            open: true,
            message: `Watchpoint limit reached: Currently limited to ${MAX_WATCHPOINTS_ANDROID} watchpoint(s) for ${targetOs} due to a stability issue under investigation. Please remove the existing watchpoint first.`,
            severity: "warning",
          });
          return false;
        }

        const apiClient = getApiClient();

        // Convert hex address to number for API call
        const addressNum = parseInt(address, 16);

        const response = await apiClient.setWatchpoint({
          address: addressNum,
          size,
          _type: accessType,
        });

        if (response.success && response.watchpoint_id) {
          // **IMPORTANT: Prepare watchpoint data for Tauri state BEFORE window creation**
          console.log(
            "Preparing watchpoint for Tauri state before window creation..."
          );

          // Create watchpoint objects for both system state and window creation
          const watchpointForState = {
            id: response.watchpoint_id,
            address: address, // Keep as string for consistency with types
            size,
            accessType: accessType,
            hitCount: 0,
            createdAt: new Date().toISOString(), // Convert to string for system state
            description,
          };

          const watchpointForWindow: WatchpointInfo = {
            id: response.watchpoint_id,
            address: address,
            size,
            accessType: accessType,
            hitCount: 0,
            createdAt: new Date(), // Keep as Date object for window creation
            description,
          };

          // **STEP 1: Add watchpoint to Tauri state FIRST**
          console.log("Adding watchpoint to Tauri state:", watchpointForState);
          const addResult =
            await systemActions.addWatchpoint(watchpointForState);

          if (!addResult.success && addResult.error) {
            setSnackbar({
              open: true,
              message: addResult.error,
              severity: "warning",
            });
            return false;
          }

          // **STEP 2: Wait for state to be persisted**
          await new Promise((resolve) => setTimeout(resolve, 100));

          // **STEP 3: Create window with watchpoint info**
          console.log("Creating watchpoint window with saved state...");
          await createWatchpointWindow(watchpointForWindow);

          return true;
        }
        return false;
      } catch (error) {
        console.error(`Failed to set watchpoint at ${address}:`, error);
        setSnackbar({
          open: true,
          message: `Failed to set watchpoint: ${error}`,
          severity: "error",
        });
        return false;
      }
    },
    [
      createWatchpointWindow,
      systemActions,
      watchpoints,
      system.serverInfo?.target_os,
    ]
  );

  const handleRemoveWatchpoint = useCallback(
    async (address: string): Promise<boolean> => {
      try {
        // Convert hex address to number for API call
        const addressNum = parseInt(address, 16);

        const apiClient = getApiClient();
        const response = await apiClient.removeWatchpoint({
          address: addressNum,
        });

        if (response.success) {
          // Remove from state (compare addresses as strings)
          const watchpointToRemove = watchpoints.find(
            (w) => w.address === address
          );
          if (watchpointToRemove) {
            console.log(
              "[WATCHPOINT] Removing watchpoint from state:",
              watchpointToRemove
            );
            systemActions.removeWatchpoint(watchpointToRemove.id);
          } else {
            console.warn(
              "[WATCHPOINT] Watchpoint not found in state for address:",
              address
            );
          }
          return true;
        }
        return false;
      } catch (error) {
        console.error(`Failed to remove watchpoint at ${address}:`, error);
        return false;
      }
    },
    [watchpoints, systemActions]
  );

  // Handle history selection with execution (for search icon)
  const handleExecuteHistorySearch = useCallback(
    async (item: ScanHistoryItem) => {
      // First, select the history item to update settings (same as clicking on history)
      handleSelectHistory(item);

      // Create a new settings object with the history item's settings
      // Ensure all settings from history are applied including permissions, ranges, alignment
      const newSettings: ScanSettings = {
        // Start with current base settings
        ...scanSettings,
        // Apply all settings from the history item
        ...item.scanSettings,
        // Explicitly set the core search parameters
        valueType: item.valueType,
        scanType: item.scanType,
        value: item.value,
      };

      // Update settings immediately
      updateFullScanSettings(newSettings);
      updateScanSettings(newSettings);

      // Wait briefly for state to settle
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Execute scan using the updated settings from global store
      await performFirstScan();
    },
    [
      handleSelectHistory,
      scanSettings,
      updateFullScanSettings,
      updateScanSettings,
      performFirstScan,
    ]
  );

  // Memory read handler using API client
  const handleMemoryRead = useCallback(
    async (address: string, size: number): Promise<ArrayBuffer> => {
      try {
        const apiClient = getApiClient();
        return await apiClient.readMemory(address, size);
      } catch (error) {
        console.error(`Failed to read memory at ${address}:`, error);
        throw error;
      }
    },
    []
  );

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <AppGrid
        sidebarWidth={
          currentMode === "debugger"
            ? showDebuggerSidebar
              ? debuggerSidebarWidth
              : 0
            : currentMode === "scanner"
              ? scannerSidebarWidth
              : currentMode === "home"
                ? sidebarWidth
                : 0
        }
        showRegisters={isInBreakState && currentMode === "debugger"}
        registerWidth={registerWidth}
        data-sidebar-grid
      >
        {/* Header */}
        <Header
          currentMode={currentMode}
          debuggerConnected={debuggerConnected}
          debuggerState={debuggerConnected ? "connected" : "disconnected"}
          serverConnected={serverConnected}
          serverInfo={serverInfo}
          attachedProcess={attachedProcess}
          attachedAppInfo={attachedAppInfo}
          spawnSuspended={spawnSuspended}
          isInBreakState={isInBreakState}
          onModeChange={(mode) => {
            // Update mode using UI actions
            uiActions.setCurrentMode(mode);
            // Also call legacy handler for compatibility
            handleModeChange(mode);
          }}
          onLogoClick={() => {
            // Navigate to Home top page
            uiActions.setCurrentMode("home");
            handleModeChange("home");
            setHomeSubPage("home");
          }}
          onResumeApp={() => {
            // Clear spawnSuspended flag when app is resumed
            systemActions.updateField("spawnSuspended", false);
            console.log("App resumed, spawnSuspended flag cleared");
          }}
          showLogsTab={isDevelopment}
          showNetworkTab={isDevelopment}
          showStateTab={isDevelopment}
        />

        {/* Toolbar Area */}
        <ToolbarArea>
          {currentMode === "debugger" && (
            <DebuggerToolbar
              debuggerConnected={debuggerConnected}
              debuggerState={
                isInBreakState
                  ? "debugging"
                  : attachedProcess
                    ? "attached"
                    : "idle"
              }
              visible={showToolbar}
              showRegisters={showRegisters}
              showSidebar={showDebuggerSidebar}
              isInBreakState={isInBreakState}
              currentThreadId={currentThreadId}
              onToggleRegisters={handleToggleRegisters}
              onToggleSidebar={handleToggleDebuggerSidebar}
              onBreakStateChange={(isBreaking: boolean) => {
                const stackTrace = new Error().stack;
                console.log(
                  `[MAINAPP] DebuggerToolbar onBreakStateChange: ${isBreaking}`
                );
                console.log(
                  `[MAINAPP] DebuggerToolbar call from:`,
                  stackTrace?.split("\n")[2]?.trim()
                );
                systemActions.updateDebugState(
                  isBreaking,
                  currentThreadId || undefined,
                  isBreaking ? currentBreakAddress || undefined : undefined
                );
              }}
              attachedProcess={
                attachedProcess
                  ? {
                      pid: attachedProcess.pid,
                      name: attachedProcess.processname || "Unknown Process",
                    }
                  : undefined
              }
              attachedModules={attachedModules} // Pass attached modules for library+offset parsing
              connectionHost={connectionHost || undefined}
              connectionPort={connectionPort || undefined}
              targetOs={serverInfo?.target_os}
              breakpointInputValue={breakpointInputValue}
              onBreakpointInputChange={updateBreakpointInputValue}
              isSoftwareBreakpoint={isSoftwareBreakpoint}
              onBreakpointTypeChange={setIsSoftwareBreakpoint}
              onLastActionChange={setLastDebugAction}
              onGoToAddress={(address) => {
                // Navigate to address in assembly view
                console.log("Navigate to address:", address);
                // Directly update assembly address
                updateAssemblyAddress(address);
              }}
              onSetBreakpoint={async (address, isSoftware) => {
                try {
                  const apiClient = getApiClient();
                  const addressNum = parseInt(address.replace("0x", ""), 16);

                  if (isNaN(addressNum)) {
                    console.error("Invalid address format:", address);
                    return;
                  }

                  console.log(
                    "TOOLBAR: Setting breakpoint at:",
                    address,
                    "software:",
                    isSoftware
                  );
                  const response = await apiClient.setBreakpoint({
                    address: addressNum,
                    hit_count: 0,
                    is_software: isSoftware ?? false,
                  });

                  if (response.success) {
                    console.log("Breakpoint set successfully at:", address);
                    // Add to active breakpoints list with type info
                    addActiveBreakpoint(address, isSoftware ?? false);
                  } else {
                    console.error(
                      "Failed to set breakpoint:",
                      response.message
                    );
                  }
                } catch (error) {
                  console.error("Error setting breakpoint:", error);
                }
              }}
              onRemoveBreakpoint={async (address) => {
                try {
                  const apiClient = getApiClient();
                  const addressNum = parseInt(address.replace("0x", ""), 16);

                  if (isNaN(addressNum)) {
                    console.error("Invalid address format:", address);
                    return;
                  }

                  console.log("TOOLBAR: Removing breakpoint at:", address);
                  const response = await apiClient.removeBreakpoint({
                    address: addressNum,
                  });

                  if (response.success) {
                    console.log("Breakpoint removed successfully at:", address);
                    // Remove from active breakpoints list
                    removeActiveBreakpoint(address);
                  } else {
                    console.error(
                      "Failed to remove breakpoint:",
                      response.message
                    );
                  }
                } catch (error) {
                  console.error("Error removing breakpoint:", error);
                }
              }}
              onRemoveBreakpoints={async (addresses) => {
                try {
                  const apiClient = getApiClient();
                  for (const address of addresses) {
                    const addressNum = parseInt(address.replace("0x", ""), 16);
                    if (!isNaN(addressNum)) {
                      const response = await apiClient.removeBreakpoint({
                        address: addressNum,
                      });
                      if (response.success) {
                        removeActiveBreakpoint(address);
                      }
                    }
                  }
                  console.log(`Bulk removed ${addresses.length} breakpoints`);
                } catch (error) {
                  console.error("Error bulk removing breakpoints:", error);
                }
              }}
              breakpoints={activeBreakpoints}
              softwareBreakpoints={softwareBreakpoints ?? []}
              onSwitchThread={(threadId, exception) => {
                console.log(
                  `[MAINAPP] Switching to thread ${threadId}`,
                  exception
                );

                // Update the current thread ID
                systemActions.updateDebugState(
                  true, // Stay in break state
                  threadId, // New thread ID
                  exception.address || undefined
                );

                // Update register data from the exception
                if (exception) {
                  const registerData: Record<string, string> = {};

                  // Detect architecture based on available registers
                  const isX86_64 =
                    (exception as any).rax !== undefined ||
                    (exception as any).rip !== undefined;

                  const registerFields = isX86_64
                    ? [
                        // x86_64 registers
                        "rax",
                        "rbx",
                        "rcx",
                        "rdx",
                        "rsi",
                        "rdi",
                        "rbp",
                        "rsp",
                        "r8",
                        "r9",
                        "r10",
                        "r11",
                        "r12",
                        "r13",
                        "r14",
                        "r15",
                        "rip",
                        "rflags",
                        "cs",
                        "ss",
                        "ds",
                        "es",
                        "fs",
                        "gs",
                      ]
                    : [
                        // ARM64 registers
                        "x0",
                        "x1",
                        "x2",
                        "x3",
                        "x4",
                        "x5",
                        "x6",
                        "x7",
                        "x8",
                        "x9",
                        "x10",
                        "x11",
                        "x12",
                        "x13",
                        "x14",
                        "x15",
                        "x16",
                        "x17",
                        "x18",
                        "x19",
                        "x20",
                        "x21",
                        "x22",
                        "x23",
                        "x24",
                        "x25",
                        "x26",
                        "x27",
                        "x28",
                        "x29",
                        "lr",
                        "fp",
                        "sp",
                        "pc",
                        "cpsr",
                      ];

                  registerFields.forEach((field) => {
                    const value = (exception as any)[field];
                    if (value !== undefined && value !== null) {
                      if (typeof value === "number") {
                        registerData[field.toUpperCase()] =
                          `0x${value.toString(16).padStart(16, "0")}`;
                      } else if (typeof value === "string") {
                        registerData[field.toUpperCase()] = value;
                      }
                    }
                  });

                  if (Object.keys(registerData).length > 0) {
                    systemActions.updateDebugState(
                      true,
                      threadId,
                      exception.address,
                      registerData
                    );
                  }
                }

                // Navigate assembly view to the exception address
                if (exception.address && exception.address !== "unknown") {
                  const address = exception.address.startsWith("0x")
                    ? exception.address
                    : `0x${exception.address}`;
                  updateAssemblyAddress(address);
                }

                console.log(`[MAINAPP] Thread switch complete to ${threadId}`);
              }}
            />
          )}
          {currentMode === "scanner" && (
            <ScannerToolbar
              visible={showToolbar}
              onFirstScan={performFirstScan}
            />
          )}
        </ToolbarArea>

        {/* Main Content Area */}
        {currentMode === "home" ? (
          <>
            {/* Home Page with Sidebar */}
            <HomeSidebar
              currentSubPage={homeSubPage}
              onSubPageChange={setHomeSubPage}
              unreadNewsCount={unreadNewsCount}
            />
            {homeSubPage === "help" ? (
              <HelpContent />
            ) : homeSubPage === "news" ? (
              <NewsContent onUnreadCountChange={setUnreadNewsCount} />
            ) : homeSubPage === "documentation" ? (
              <DocumentationContent />
            ) : homeSubPage === "about" ? (
              <AboutContent />
            ) : homeSubPage === "settings" ? (
              <SettingsContent />
            ) : (
              <HomePage
                serverConnected={serverConnected}
                serverInfo={serverInfo}
                attachedProcess={attachedProcess}
                onModeChange={handleModeChange}
                onConnect={() => handleModeChange("server")}
                onAttachProcess={() => handleModeChange("server")}
                onAboutClick={() => setHomeSubPage("about")}
                onDetachProcess={() => {
                  // Clear process state (explicitly set to null)
                  systemActions.updateField("attachedProcess", null);
                  systemActions.updateField("attachedAppInfo", null);

                  // Clear debug state when detaching from process
                  systemActions.updateField("isInBreakState", false);
                  systemActions.updateField("currentThreadId", null);
                  systemActions.updateField("currentBreakAddress", null);
                  systemActions.updateField("currentRegisterData", {});

                  // Clear breakpoints and watchpoints when detaching from process
                  systemActions.updateField("activeBreakpoints", []);
                  systemActions.updateField("softwareBreakpoints", []);
                  systemActions.updateField("watchpoints", []);

                  // Clear modules
                  systemActions.updateField("attachedModules", []);

                  // Clear symbol cache
                  clearSymbolCache();

                  console.log(
                    "All debug state cleared due to process detach from HomePage"
                  );

                  handleModeChange("server");
                }}
                connectionHost={connectionHost || "localhost"}
                connectionPort={connectionPort || 8080}
                isConnecting={false}
              />
            )}
          </>
        ) : isDevelopment && currentMode === "state" ? (
          <>
            {/* Development State Monitor Mode Layout */}
            <StatePanel />
          </>
        ) : currentMode === "debugger" ? (
          <>
            {/* Debugger Mode Layout - With Optional Sidebar */}
            {showDebuggerSidebar && (
              <DebuggerSidebar
                activeFunction=""
                onFunctionClick={(functionName, functionAddress) => {
                  console.log(
                    `Function clicked: ${functionName} at ${functionAddress}`
                  );
                  if (functionAddress) {
                    updateAssemblyAddress(functionAddress);
                  }
                }}
                onModuleClick={(module) => {
                  console.log("Module clicked:", module);
                }}
              />
            )}
            <DebuggerContent
              serverInfo={serverInfo}
              onBreakpointInputSet={(address) => {
                // Only set input value, don't add to active breakpoints automatically
                updateBreakpointInputValue(address);
                console.log("Breakpoint input value set to:", address);
              }}
              onBreakpointHit={handleBreakpointHit}
              onRegisterDataUpdate={handleRegisterDataUpdate}
              setCurrentThreadId={(threadId: number | null) => {
                systemActions.updateDebugState(
                  isInBreakState,
                  threadId || undefined
                );
              }}
              currentBreakAddress={currentBreakAddress}
              onBreakStateChange={(isBreaking: boolean) => {
                const stackTrace = new Error().stack;
                console.log(
                  `[MAINAPP] DebuggerContent onBreakStateChange called with: ${isBreaking}`
                );
                console.log(
                  `[MAINAPP] Call from:`,
                  stackTrace?.split("\n")[2]?.trim()
                );
                console.log(
                  `[MAINAPP] Current isInBreakState before: ${isInBreakState}`
                );

                // Don't override break state if we just hit a breakpoint
                // Check if this is called shortly after a breakpoint hit
                const now = Date.now();
                const timeSinceLastBreakpoint =
                  now - (window as any).__lastBreakpointHitTime || 0;

                if (isBreaking === false && timeSinceLastBreakpoint < 1000) {
                  console.log(
                    `[MAINAPP] Ignoring onBreakStateChange(false) - recent breakpoint hit (${timeSinceLastBreakpoint}ms ago)`
                  );
                  return;
                }

                // Update debug state through Tauri instead of direct local state
                console.log(
                  `[MAINAPP] Updating debug state through Tauri: isInBreakState=${isBreaking}`
                );
                systemActions.updateDebugState(
                  isBreaking,
                  currentThreadId || undefined,
                  isBreaking ? currentBreakAddress || undefined : undefined
                );

                // Add a small delay to check if state actually updated
                setTimeout(() => {
                  console.log(
                    `[MAINAPP] isInBreakState after update (delayed check): ${isInBreakState}`
                  );
                }, 100);
              }}
              lastDebugAction={lastDebugAction}
              isInBreakState={isInBreakState}
              isSoftwareBreakpoint={isSoftwareBreakpoint}
              breakpointNotification={breakpointNotification}
              activeBreakpoints={activeBreakpoints}
              softwareBreakpoints={softwareBreakpoints ?? []}
              onAssemblyAddressChange={updateAssemblyAddress}
              onShowBreakpointNotification={showBreakpointNotification}
              onHideBreakpointNotification={hideBreakpointNotification}
              onAddActiveBreakpoint={addActiveBreakpoint}
              onRemoveActiveBreakpoint={removeActiveBreakpoint}
              registerData={currentRegisterData}
              currentThreadId={currentThreadId}
              memoryAddress={memoryAddress}
              onMemoryAddressChange={updateMemoryAddress}
              attachedModules={attachedModules}
              resolveFunctionName={resolveFunctionName}
            />
          </>
        ) : currentMode === "information" ? (
          <>
            {/* Information Mode Layout - Full width like server mode */}
            <InformationContent
              attachedModules={attachedModules}
              currentTab={informationCurrentTab}
              onTabChange={setInformationCurrentTab}
              nameFilter={modulesNameFilter}
              onNameFilterChange={setModulesNameFilter}
              sortField={modulesSortField as "baseAddress" | "size" | null}
              sortDirection={modulesSortDirection}
              onSortChange={handleModulesSortChange}
              serverInfo={serverInfo}
              onRefreshModules={async () => {
                if (attachedProcess) {
                  try {
                    const apiClient = getApiClient();
                    const response = await apiClient.enumerateModules();
                    if (response.data?.modules) {
                      console.log("Refreshed modules:", response.data.modules);
                      handleModulesUpdate(response.data.modules);
                    }
                  } catch (error) {
                    console.error("Failed to refresh modules:", error);
                  }
                }
              }}
            />
          </>
        ) : currentMode === "scanner" ? (
          <>
            {/* Scanner Mode Layout */}
            <ScannerSidebar
              memoryRegionsLoaded={memoryRegionsLoaded}
              onScanSettingsChange={handleScanSettingsChange}
              onFirstScan={performFirstScan}
              onNextScan={performNextScan}
              onNewScan={performNewScan}
              onClearScan={clearScan}
            />
            <ScannerContent
              scanResults={scanResults}
              isScanning={scannerState.isScanning}
              scanProgress={scannerState.scanProgress}
              totalResults={scannerState.totalResults}
              scannedBytes={scannerState.scannedBytes}
              totalBytes={scannerState.totalBytes}
              currentRegion={scannerState.currentRegion || undefined}
              currentScanId={scannerState.scanId || undefined}
              onResultEdit={handleResultEdit}
              onResultDelete={handleResultDelete}
              onResultBookmark={handleResultBookmark}
              onStopScan={stopScan}
              onMemoryRead={handleMemoryRead}
              bookmarks={bookmarks}
              onAddManualBookmark={addManualBookmark}
              onUpdateBookmark={updateBookmark}
              onRemoveBookmark={removeBookmark}
              isAddressBookmarked={isAddressBookmarked}
              attachedModules={attachedModules}
              onSetWatchpoint={handleSetWatchpoint}
              onRemoveWatchpoint={handleRemoveWatchpoint}
              scanHistory={globalScanHistory}
              onSelectHistory={handleSelectHistory}
              onRemoveHistoryItem={onRemoveHistoryItem}
              onClearHistory={onClearHistory}
              currentTab={scannerCurrentTab}
              onTabChange={setScannerCurrentTab}
              onExecuteHistorySearch={handleExecuteHistorySearch}
            />
          </>
        ) : currentMode === "tools" ? (
          <>
            {/* Tools Mode Layout */}
            <ToolsContent
              serverConnected={serverConnected}
              serverInfo={serverInfo}
            />
          </>
        ) : (
          <>
            {/* Server Mode Layout - spans full width */}
            <ServerContent onModulesUpdate={handleModulesUpdate} />
          </>
        )}

        {/* Register Panel - Only show in debugger mode when in break state */}
        {React.useMemo(() => {
          const shouldShow = isInBreakState && currentMode === "debugger";

          return shouldShow ? (
            <RegisterView
              open={isInBreakState}
              registerData={currentRegisterData}
              isInBreakState={isInBreakState}
              currentThreadId={currentThreadId}
              onWidthChange={setRegisterWidth}
            />
          ) : null;
        }, [
          isInBreakState,
          currentMode,
          currentRegisterData,
          currentThreadId,
          setRegisterWidth,
        ])}

        {/* Status Bar */}
        <StatusBarComponent
          currentMode={currentMode}
          debuggerConnected={debuggerConnected}
          serverConnected={serverConnected}
          connectionHost={connectionHost || undefined}
          connectionPort={connectionPort || undefined}
          lastHealthCheck={lastHealthCheck}
          attachedProcess={attachedProcess}
          attachedAppInfo={attachedAppInfo}
          currentBreakAddress={currentBreakAddress}
          isInBreakState={isInBreakState}
        />

        {/* Snackbar for notifications */}
        <Snackbar
          open={snackbar.open}
          autoHideDuration={6000}
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert
            onClose={() => setSnackbar({ ...snackbar, open: false })}
            severity={snackbar.severity}
            variant="filled"
            sx={{ width: "100%" }}
          >
            {snackbar.message}
          </Alert>
        </Snackbar>
      </AppGrid>
    </ThemeProvider>
  );
};

// Main App component wrapped with DebugLoggerProvider
// Main App component wrapped with providers
export const MainApp: React.FC = () => {
  return (
    <DebugLoggerProvider>
      <AppWithExceptionHandler />
    </DebugLoggerProvider>
  );
};

// Wrapper component to provide connection state to global exception handler
const AppWithExceptionHandler: React.FC = () => {
  // Use the new integrated state management (Tauri singleton)
  const { system, systemActions } = useAppState();

  const { serverConnected, debuggerConnected, attachedProcess, watchpoints } =
    system;

  // State bridge for breakpoint handling
  const [lastBreakpointException, setLastBreakpointException] =
    React.useState<any>(null);

  // Handle connection state changes from AppContent
  const handleConnectionStateChange = React.useCallback(
    (connected: boolean, debuggerConn: boolean, process?: ProcessInfo) => {
      // No longer need to update global store directly since we have the new state management
      console.log("Connection state changed:", {
        connected,
        debuggerConn,
        process,
      });
    },
    []
  );

  // Handle breakpoint state changes from AppContent
  const handleBreakpointStateChange = React.useCallback(
    (hasBreakpoints: boolean) => {
      console.log("[EXCEPTION HANDLER] Breakpoint state change:", {
        hasBreakpoints,
      });
      setHasActiveBreakpoints((prev) => {
        if (prev !== hasBreakpoints) {
          console.log("[EXCEPTION HANDLER] Updating hasActiveBreakpoints:", {
            from: prev,
            to: hasBreakpoints,
          });
          return hasBreakpoints;
        }
        return prev;
      });
    },
    []
  );

  // Calculate derived connection states
  const isConnected = serverConnected && debuggerConnected;
  const isProcessAttached = !!attachedProcess;

  // Handle breakpoint hit from global exception handler - moved here from AppContent
  const handleGlobalBreakpointHit = React.useCallback((exception: any) => {
    console.log("[GLOBAL BREAKPOINT] Breakpoint hit:", exception);
    // Set the exception data so AppContent can process it
    setLastBreakpointException(exception);
  }, []);

  // Handle script breakpoint events (from Lua scripts Debug.set_breakpoint/remove_breakpoint)
  const handleScriptBreakpoint = React.useCallback(
    (event: ScriptBreakpointEvent) => {
      const addressHex = `0x${event.address.toString(16)}`;
      console.log(
        `[AppWithExceptionHandler] Script breakpoint ${event.action}: ${addressHex}`,
        event
      );

      try {
        if (event.action === "set") {
          // Add breakpoint to UI state using React state management
          const isSoftware = event.bp_type === "soft";
          systemActions.addBreakpoint(addressHex, isSoftware);
          console.log(
            `[AppWithExceptionHandler] Added script breakpoint at ${addressHex} (${event.bp_type})`
          );
        } else if (event.action === "remove") {
          // Remove breakpoint from UI state using React state management
          systemActions.removeBreakpoint(addressHex);
          console.log(
            `[AppWithExceptionHandler] Removed script breakpoint at ${addressHex}`
          );
        }
      } catch (error) {
        console.error(
          "[AppWithExceptionHandler] Failed to update breakpoint:",
          error
        );
      }
    },
    [systemActions]
  );

  // Debug logging for connection state (reduced frequency)
  useEffect(() => {
    console.log("AppWithExceptionHandler: Connection state changed", {
      serverConnected,
      debuggerConnected,
      isConnected,
      attachedProcess: !!attachedProcess,
      isProcessAttached,
      timestamp: new Date().toISOString(),
    });
  }, [serverConnected, debuggerConnected, isConnected, isProcessAttached]);

  // Track active breakpoints dynamically
  const [hasActiveBreakpoints, setHasActiveBreakpoints] = React.useState(false);

  // Calculate hasActiveWatchpoints directly from system.watchpoints
  const hasActiveWatchpoints = (watchpoints?.length ?? 0) > 0;

  // Create options object that will be recreated when dependencies change
  const options = React.useMemo(
    () => ({
      autoStart: true, // 常に自動開始
      isConnected, // serverConnected && debuggerConnectedを使用
      isProcessAttached, // attachedProcessの存在をチェック
      hasActiveWatchpoints, // 動的に追跡
      hasActiveBreakpoints, // ハードウェアブレークポイントは常に監視（サーバー側で管理されているため）
      pollingInterval: 100, // シングルステップ検出を高速化
      enableWatchpoints: true,
      enableBreakpoints: true,
      onBreakpointHit: handleGlobalBreakpointHit,
      onScriptBreakpoint: handleScriptBreakpoint,
    }),
    [
      isConnected,
      isProcessAttached,
      hasActiveWatchpoints,
      hasActiveBreakpoints,
      handleGlobalBreakpointHit,
      handleScriptBreakpoint,
    ]
  );

  return (
    <GlobalExceptionHandlerProvider options={options}>
      <AppContent
        onConnectionStateChange={handleConnectionStateChange}
        onBreakpointHit={lastBreakpointException}
        onBreakpointStateChange={handleBreakpointStateChange}
      />
    </GlobalExceptionHandlerProvider>
  );
};
