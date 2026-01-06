import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface SystemConnectionState {
  serverConnected: boolean;
  debuggerConnected: boolean;
  connectionHost?: string;
  connectionPort?: number;
  authToken?: string;
  serverSessionId?: string;
}

export interface SystemProcessState {
  attachedProcess?: {
    pid: number;
    processname: string;
  };
  serverInfo?: {
    git_hash: string;
    arch: string;
    pid: number;
    mode: string;
    target_os: string;
    build_timestamp?: number;
  };
  attachedAppInfo?: {
    name: string;
    pid: number;
    icon?: string;
    arch?: string;
    bundleIdentifier?: string;
  };
  spawnSuspended?: boolean;
  attachedModules: Array<{
    modulename: string;
    base: number;
    size: number;
    path?: string;
    is_64bit?: boolean;
  }>;
}

export interface SystemDebugState {
  isInBreakState: boolean;
  currentThreadId?: number;
  currentBreakAddress?: string;
  currentRegisterData: Record<string, string>;
  activeBreakpoints: string[];
  softwareBreakpoints: string[]; // Track which addresses are software breakpoints
  watchpoints: Array<{
    id: string;
    address: string;
    size: number;
    accessType: string;
    hitCount: number;
    createdAt: string;
    description?: string;
  }>;
}

export interface TauriSystemState
  extends SystemConnectionState,
    SystemProcessState,
    SystemDebugState {
  lastUpdate: number;
}

interface StateUpdateEvent {
  field: string;
  value: any;
  timestamp: number;
}

/**
 * Tauriのシステム状態管理フック
 * 接続状態、プロセス状態、デバッグ状態など、複数ウィンドウ間で共有すべき状態のみ管理
 */
export const useTauriSystemState = () => {
  const [state, setState] = useState<TauriSystemState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const tauriState = await invoke<TauriSystemState>("get_app_state");
      setState(tauriState);
    } catch (err) {
      console.error("Failed to load Tauri system state:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateField = useCallback(async (field: string, value: any) => {
    try {
      await invoke("update_single_state", { field, value });
    } catch (err) {
      console.error(`Failed to update field ${field}:`, err);
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  const updateState = useCallback(async (updates: Record<string, any>) => {
    try {
      await invoke("update_app_state", { updates });
    } catch (err) {
      console.error("Failed to update Tauri state:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  const updateConnectionState = useCallback(
    async (
      serverConnected: boolean,
      debuggerConnected: boolean,
      host?: string,
      port?: number
    ) => {
      const updates: Record<string, any> = {
        serverConnected,
        debuggerConnected,
      };
      if (host !== undefined) updates.connectionHost = host;
      if (port !== undefined) updates.connectionPort = port;

      await updateState(updates);
    },
    [updateState]
  );

  const updateProcessState = useCallback(
    async (
      attachedProcess?: SystemProcessState["attachedProcess"],
      attachedAppInfo?: SystemProcessState["attachedAppInfo"],
      serverInfo?: SystemProcessState["serverInfo"]
    ) => {
      const updates: Record<string, any> = {};
      if (attachedProcess !== undefined)
        updates.attachedProcess = attachedProcess;
      if (attachedAppInfo !== undefined)
        updates.attachedAppInfo = attachedAppInfo;
      if (serverInfo !== undefined) updates.serverInfo = serverInfo;

      await updateState(updates);
    },
    [updateState]
  );

  const updateDebugState = useCallback(
    async (
      isInBreakState?: boolean,
      currentThreadId?: number,
      currentBreakAddress?: string,
      registerData?: Record<string, string>
    ) => {
      const updates: Record<string, any> = {};
      if (isInBreakState !== undefined) updates.isInBreakState = isInBreakState;
      if (currentThreadId !== undefined)
        updates.currentThreadId = currentThreadId;
      if (currentBreakAddress !== undefined)
        updates.currentBreakAddress = currentBreakAddress;
      if (registerData !== undefined)
        updates.currentRegisterData = registerData;

      await updateState(updates);
    },
    [updateState]
  );

  const addBreakpoint = useCallback(
    async (address: string, isSoftware: boolean = false) => {
      if (state) {
        // Track software breakpoints FIRST to avoid red flash on UI
        if (isSoftware) {
          const newSoftwareBreakpoints = [...(state.softwareBreakpoints || [])];
          if (!newSoftwareBreakpoints.includes(address)) {
            newSoftwareBreakpoints.push(address);
            await updateField("softwareBreakpoints", newSoftwareBreakpoints);
          }
        }
        // Then add to active breakpoints
        const newBreakpoints = [...(state.activeBreakpoints || [])];
        if (!newBreakpoints.includes(address)) {
          newBreakpoints.push(address);
          await updateField("activeBreakpoints", newBreakpoints);
        }
      }
    },
    [state, updateField]
  );

  const removeBreakpoint = useCallback(
    async (address: string) => {
      if (state) {
        const newBreakpoints = (state.activeBreakpoints || []).filter(
          (bp) => bp !== address
        );
        await updateField("activeBreakpoints", newBreakpoints);
        // Also remove from software breakpoints if present
        const newSoftwareBreakpoints = (state.softwareBreakpoints || []).filter(
          (bp) => bp !== address
        );
        await updateField("softwareBreakpoints", newSoftwareBreakpoints);
      }
    },
    [state, updateField]
  );

  const MAX_WATCHPOINTS_ANDROID = 1;

  const addWatchpoint = useCallback(
    async (
      watchpoint: SystemDebugState["watchpoints"][0]
    ): Promise<{ success: boolean; error?: string }> => {
      if (state) {
        const currentWatchpoints = state.watchpoints || [];
        const targetOs = state.serverInfo?.target_os;

        if (
          (targetOs === "android" || targetOs === "linux") &&
          currentWatchpoints.length >= MAX_WATCHPOINTS_ANDROID
        ) {
          return {
            success: false,
            error: `Watchpoint limit reached: Maximum ${MAX_WATCHPOINTS_ANDROID} watchpoint(s) allowed for ${targetOs}. Please remove an existing watchpoint first.`,
          };
        }

        const newWatchpoints = [...currentWatchpoints];
        const existingIndex = newWatchpoints.findIndex(
          (w) => w.id === watchpoint.id
        );
        if (existingIndex === -1) {
          newWatchpoints.push(watchpoint);
          await updateField("watchpoints", newWatchpoints);
        }
        return { success: true };
      }
      return { success: false, error: "State not available" };
    },
    [state, updateField]
  );

  const removeWatchpoint = useCallback(
    async (watchpointId: string) => {
      if (state) {
        const newWatchpoints = (state.watchpoints || []).filter(
          (w) => w.id !== watchpointId
        );
        await updateField("watchpoints", newWatchpoints);
      }
    },
    [state, updateField]
  );

  const updateModules = useCallback(
    async (modules: SystemProcessState["attachedModules"]) => {
      await updateField("attachedModules", modules);
    },
    [updateField]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<StateUpdateEvent>("state-updated", (event) => {
          const { field, value, timestamp } = event.payload;
          console.log("[TauriSystemState] State updated:", {
            field,
            value,
            timestamp,
            source: "useTauriSystemState hook",
            hookId: Math.random().toString(36).substr(2, 9),
          });

          setState((currentState) => {
            if (!currentState) return currentState;

            return {
              ...currentState,
              [field]: value,
              lastUpdate: timestamp,
            };
          });
        });
      } catch (error) {
        console.error("Failed to setup state update listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    loadState();
  }, []);

  return {
    state,
    isLoading,
    error,

    loadState,
    updateField,
    updateState,

    updateConnectionState,
    updateProcessState,
    updateDebugState,
    addBreakpoint,
    removeBreakpoint,
    addWatchpoint,
    removeWatchpoint,
    updateModules,

    isConnected: state?.serverConnected && state?.debuggerConnected,
    hasAttachedProcess: !!state?.attachedProcess,
    isInBreakState: state?.isInBreakState ?? false,
  };
};

/**
 * 接続状態のみを監視する軽量フック
 */
export const useConnectionState = () => {
  const [connectionState, setConnectionState] =
    useState<SystemConnectionState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadConnectionState = async () => {
      try {
        const state = await invoke<SystemConnectionState>(
          "get_connection_state"
        );
        setConnectionState(state);
      } catch (err) {
        console.error("Failed to load connection state:", err);
      } finally {
        setIsLoading(false);
      }
    };

    loadConnectionState();

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<StateUpdateEvent>("state-updated", (event) => {
          const { field, value } = event.payload;
          if (
            [
              "serverConnected",
              "debuggerConnected",
              "connectionHost",
              "connectionPort",
            ].includes(field)
          ) {
            setConnectionState((current) =>
              current ? { ...current, [field]: value } : current
            );
          }
        });
      } catch (error) {
        console.error("Failed to setup connection state listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  return {
    connectionState,
    isLoading,
    isConnected:
      connectionState?.serverConnected && connectionState?.debuggerConnected,
  };
};

/**
 * デバッグ状態のみを監視する軽量フック
 */
export const useDebugState = () => {
  const [debugState, setDebugState] = useState<SystemDebugState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadDebugState = async () => {
      try {
        const state = await invoke<SystemDebugState>("get_debug_state");
        setDebugState(state);
      } catch (err) {
        console.error("Failed to load debug state:", err);
      } finally {
        setIsLoading(false);
      }
    };

    loadDebugState();

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<StateUpdateEvent>("state-updated", (event) => {
          const { field, value } = event.payload;
          if (
            [
              "isInBreakState",
              "currentThreadId",
              "currentBreakAddress",
              "currentRegisterData",
              "activeBreakpoints",
              "watchpoints",
            ].includes(field)
          ) {
            setDebugState((current) =>
              current ? { ...current, [field]: value } : current
            );
          }
        });
      } catch (error) {
        console.error("Failed to setup debug state listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  return {
    debugState,
    isLoading,
    isInBreakState: debugState?.isInBreakState ?? false,
    hasActiveBreakpoints: (debugState?.activeBreakpoints?.length ?? 0) > 0,
    hasActiveWatchpoints: (debugState?.watchpoints?.length ?? 0) > 0,
  };
};
