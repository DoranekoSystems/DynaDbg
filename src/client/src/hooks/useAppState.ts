import { useEffect, useMemo } from "react";
import { useTauriSystemStateSingleton } from "./useTauriSystemStateSingleton";
import { useUIStore } from "../stores/uiStore";

let isUIStateInitialized = false;

/**
 * Hook for managing UI store and Tauri system state
 */
export const useAppState = () => {
  const tauriSystem = useTauriSystemStateSingleton();

  const uiState = useUIStore();
  const uiActions = useUIStore((state) => state.actions);

  useEffect(() => {
    if (isUIStateInitialized) {
      return;
    }

    const restoreUIState = () => {
      try {
        const savedDebuggerState = localStorage.getItem("debugger-ui-state");
        if (savedDebuggerState) {
          const debuggerState = JSON.parse(savedDebuggerState);
          const { gotoAddress, ...stateToRestore } = debuggerState;
          uiActions.updateDebuggerState(stateToRestore);
        }

        const defaultScannerSettings = {
          valueType: "int32",
          scanType: "exact",
          value: "",
          startAddress: "0x0",
          endAddress: "0x7FFFFFFFFFFF",
          scanMode: "manual",
          selectedRegions: [],
          alignment: 4,
          writable: true,
          executable: false,
          readable: true,
          doSuspend: false,
        };
        uiActions.setScanSettings(defaultScannerSettings);

        const savedInformationState = localStorage.getItem(
          "information-ui-state"
        );
        if (savedInformationState) {
          const informationState = JSON.parse(savedInformationState);
          uiActions.updateInformationState(informationState);
        }

        const savedScanHistory = localStorage.getItem("scan-history");
        if (savedScanHistory) {
          const scanHistory = JSON.parse(savedScanHistory);
          uiActions.setScanHistory(scanHistory);
        }

        const savedBookmarks = localStorage.getItem("bookmarks");
        if (savedBookmarks) {
          const bookmarks = JSON.parse(savedBookmarks);
          uiActions.setBookmarks(bookmarks);
        }

        console.log("[AppState] UI state restored from localStorage");

        isUIStateInitialized = true;
      } catch (error) {
        console.error(
          "[AppState] Error restoring UI state from localStorage:",
          error
        );
        isUIStateInitialized = true;
      }
    };

    restoreUIState();
  }, [uiActions]);

  return {
    system: {
      serverConnected: tauriSystem.state?.serverConnected ?? false,
      debuggerConnected: tauriSystem.state?.debuggerConnected ?? false,
      connectionHost: tauriSystem.state?.connectionHost,
      connectionPort: tauriSystem.state?.connectionPort,
      isConnected: tauriSystem.isConnected,

      attachedProcess: tauriSystem.state?.attachedProcess,
      serverInfo: tauriSystem.state?.serverInfo,
      attachedAppInfo: tauriSystem.state?.attachedAppInfo,
      attachedModules: tauriSystem.state?.attachedModules ?? [],
      hasAttachedProcess: tauriSystem.hasAttachedProcess,
      spawnSuspended: tauriSystem.state?.spawnSuspended ?? false,

      isInBreakState: tauriSystem.state?.isInBreakState ?? false,
      currentThreadId: tauriSystem.state?.currentThreadId,
      currentBreakAddress: tauriSystem.state?.currentBreakAddress,
      currentRegisterData: tauriSystem.state?.currentRegisterData ?? {},
      activeBreakpoints: tauriSystem.state?.activeBreakpoints ?? [],
      softwareBreakpoints: tauriSystem.state?.softwareBreakpoints ?? [],
      watchpoints: tauriSystem.state?.watchpoints ?? [],

      lastUpdate: tauriSystem.state?.lastUpdate ?? 0,
      isLoading: tauriSystem.isLoading,
      error: tauriSystem.error,
    },

    ui: {
      currentMode: uiState.currentMode,
      sidebarWidth: uiState.sidebarWidth,
      debuggerSidebarWidth: uiState.debuggerSidebarWidth,
      scannerSidebarWidth: uiState.scannerSidebarWidth,
      showRegisters: uiState.showRegisters,
      showToolbar: uiState.showToolbar,

      debuggerState: uiState.debuggerState,

      debuggerSidebarCache: uiState.debuggerSidebarCache,

      scannerState: uiState.scannerState,
      scanHistory: uiState.scanHistory,
      bookmarks: uiState.bookmarks,

      informationState: uiState.informationState,

      lastUpdate: uiState.lastUpdate,
    },

    systemActions: useMemo(
      () => ({
        updateConnectionState: tauriSystem.updateConnectionState,
        updateProcessState: tauriSystem.updateProcessState,
        updateDebugState: tauriSystem.updateDebugState,
        addBreakpoint: tauriSystem.addBreakpoint,
        removeBreakpoint: tauriSystem.removeBreakpoint,
        addWatchpoint: tauriSystem.addWatchpoint,
        removeWatchpoint: tauriSystem.removeWatchpoint,
        updateModules: tauriSystem.updateModules,
        updateField: tauriSystem.updateField,
        updateState: tauriSystem.updateState,
      }),
      [
        tauriSystem.updateConnectionState,
        tauriSystem.updateProcessState,
        tauriSystem.updateDebugState,
        tauriSystem.addBreakpoint,
        tauriSystem.removeBreakpoint,
        tauriSystem.addWatchpoint,
        tauriSystem.removeWatchpoint,
        tauriSystem.updateModules,
        tauriSystem.updateField,
        tauriSystem.updateState,
      ]
    ),

    uiActions,

    refresh: tauriSystem.loadState,
  };
};

export const useConnectionOnly = () => {
  const { system } = useAppState();
  return {
    serverConnected: system.serverConnected,
    debuggerConnected: system.debuggerConnected,
    isConnected: system.isConnected,
    connectionHost: system.connectionHost,
    connectionPort: system.connectionPort,
  };
};

export const useDebugOnly = () => {
  const { system } = useAppState();
  return {
    isInBreakState: system.isInBreakState,
    currentThreadId: system.currentThreadId,
    currentBreakAddress: system.currentBreakAddress,
    currentRegisterData: system.currentRegisterData,
    activeBreakpoints: system.activeBreakpoints,
    watchpoints: system.watchpoints,
  };
};

export const useUIOnly = () => {
  const { ui, uiActions } = useAppState();
  return { ui, uiActions };
};
