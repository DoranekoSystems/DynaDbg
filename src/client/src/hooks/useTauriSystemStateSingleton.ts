import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  TauriSystemState,
  SystemProcessState,
  SystemDebugState,
} from "./useTauriSystemState";

class TauriSystemStateSingleton {
  private static instance: TauriSystemStateSingleton;
  private state: TauriSystemState | null = null;
  private listeners = new Set<(state: TauriSystemState | null) => void>();
  private isLoading = true;
  private error: string | null = null;
  private isInitialized = false;
  private unlisten: (() => void) | null = null;

  private constructor() {}

  static getInstance(): TauriSystemStateSingleton {
    if (!TauriSystemStateSingleton.instance) {
      TauriSystemStateSingleton.instance = new TauriSystemStateSingleton();
    }
    return TauriSystemStateSingleton.instance;
  }

  addListener(listener: (state: TauriSystemState | null) => void) {
    this.listeners.add(listener);

    if (this.state) {
      listener(this.state);
    }

    if (!this.isInitialized) {
      this.initialize();
    }

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size === 0) {
        this.cleanup();
      }
    };
  }

  private async initialize() {
    if (this.isInitialized) return;

    this.isInitialized = true;
    console.log("[TauriSystemStateSingleton] Initializing...");

    try {
      await this.loadState();

      await this.setupEventListener();
    } catch (error) {
      console.error("[TauriSystemStateSingleton] Failed to initialize:", error);
      this.error = error instanceof Error ? error.message : "Unknown error";
      this.isLoading = false;
      this.notifyListeners();
    }
  }

  private async loadState() {
    try {
      this.isLoading = true;
      this.error = null;
      const tauriState = await invoke<TauriSystemState>("get_app_state");
      this.state = tauriState;
      this.isLoading = false;
      this.notifyListeners();
      console.log("[TauriSystemStateSingleton] State loaded successfully");
    } catch (err) {
      console.error("[TauriSystemStateSingleton] Failed to load state:", err);
      this.error = err instanceof Error ? err.message : "Unknown error";
      this.isLoading = false;
      this.notifyListeners();
    }
  }

  private async setupEventListener() {
    try {
      if (this.unlisten) {
        console.warn(
          "[TauriSystemStateSingleton] Event listener already set up"
        );
        return;
      }

      this.unlisten = await listen<{
        field: string;
        value: any;
        timestamp: number;
      }>("state-updated", (event) => {
        const { field, value, timestamp } = event.payload;

        // Skip if value is the same as current (debounce duplicate updates)
        if (this.state) {
          const currentValue = (this.state as any)[field];
          // Deep equality check for objects, strict equality for primitives
          const isSameValue =
            typeof value === "object" && value !== null
              ? JSON.stringify(currentValue) === JSON.stringify(value)
              : currentValue === value;

          if (isSameValue) {
            // Skip duplicate update
            return;
          }
        }

        console.log("[TauriSystemStateSingleton] State updated:", {
          field,
          value,
          timestamp,
          listenerCount: this.listeners.size,
        });

        if (this.state) {
          this.state = {
            ...this.state,
            [field]: value,
            lastUpdate: timestamp,
          };
          this.notifyListeners();
        }
      });

      console.log(
        "[TauriSystemStateSingleton] Event listener set up successfully"
      );
    } catch (error) {
      console.error(
        "[TauriSystemStateSingleton] Failed to setup event listener:",
        error
      );
    }
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => {
      try {
        listener(this.state);
      } catch (error) {
        console.error(
          "[TauriSystemStateSingleton] Error notifying listener:",
          error
        );
      }
    });
  }

  private cleanup() {
    console.log("[TauriSystemStateSingleton] Cleaning up...");
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.isInitialized = false;
  }

  async updateField(field: string, value: any) {
    try {
      await invoke("update_single_state", { field, value });
    } catch (err) {
      console.error(
        `[TauriSystemStateSingleton] Failed to update field ${field}:`,
        err
      );
      throw err;
    }
  }

  async updateState(updates: Record<string, any>) {
    try {
      await invoke("update_app_state", { updates });
    } catch (err) {
      console.error("[TauriSystemStateSingleton] Failed to update state:", err);
      throw err;
    }
  }

  getCurrentState() {
    return {
      state: this.state,
      isLoading: this.isLoading,
      error: this.error,
    };
  }
}

export const useTauriSystemStateSingleton = () => {
  const [state, setState] = useState<TauriSystemState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const singleton = useRef(TauriSystemStateSingleton.getInstance());

  useEffect(() => {
    const updateLocalState = (newState: TauriSystemState | null) => {
      setState(newState);
      const currentState = singleton.current.getCurrentState();
      setIsLoading(currentState.isLoading);
      setError(currentState.error);
    };

    const cleanup = singleton.current.addListener(updateLocalState);

    return cleanup;
  }, []);

  const updateField = useCallback(async (field: string, value: any) => {
    return singleton.current.updateField(field, value);
  }, []);

  const updateState = useCallback(async (updates: Record<string, any>) => {
    return singleton.current.updateState(updates);
  }, []);

  const loadState = useCallback(async () => {
    console.log(
      "[useTauriSystemStateSingleton] Manual loadState called (handled by singleton)"
    );
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
      const currentState = singleton.current.getCurrentState().state;
      if (currentState) {
        // Track software breakpoints FIRST to avoid red flash on UI
        if (isSoftware) {
          const newSoftwareBreakpoints = [
            ...(currentState.softwareBreakpoints || []),
          ];
          if (!newSoftwareBreakpoints.includes(address)) {
            newSoftwareBreakpoints.push(address);
            await updateField("softwareBreakpoints", newSoftwareBreakpoints);
          }
        }
        // Then add to active breakpoints
        const newBreakpoints = [...(currentState.activeBreakpoints || [])];
        if (!newBreakpoints.includes(address)) {
          newBreakpoints.push(address);
          await updateField("activeBreakpoints", newBreakpoints);
        }
      }
    },
    [updateField]
  );

  const removeBreakpoint = useCallback(
    async (address: string) => {
      const currentState = singleton.current.getCurrentState().state;
      if (currentState) {
        const newBreakpoints = (currentState.activeBreakpoints || []).filter(
          (bp) => bp !== address
        );
        await updateField("activeBreakpoints", newBreakpoints);
        // Also remove from software breakpoints if present
        const newSoftwareBreakpoints = (
          currentState.softwareBreakpoints || []
        ).filter((bp) => bp !== address);
        await updateField("softwareBreakpoints", newSoftwareBreakpoints);
      }
    },
    [updateField]
  );

  const MAX_WATCHPOINTS_ANDROID = 1;

  const addWatchpoint = useCallback(
    async (
      watchpoint: SystemDebugState["watchpoints"][0]
    ): Promise<{ success: boolean; error?: string }> => {
      const currentState = singleton.current.getCurrentState().state;
      if (currentState) {
        const currentWatchpoints = currentState.watchpoints || [];
        const targetOs = currentState.serverInfo?.target_os;

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
    [updateField]
  );

  const removeWatchpoint = useCallback(
    async (watchpointId: string) => {
      const currentState = singleton.current.getCurrentState().state;
      if (currentState) {
        const newWatchpoints = (currentState.watchpoints || []).filter(
          (w) => w.id !== watchpointId
        );
        await updateField("watchpoints", newWatchpoints);
      }
    },
    [updateField]
  );

  const updateModules = useCallback(
    async (modules: SystemProcessState["attachedModules"]) => {
      await updateField("attachedModules", modules);
    },
    [updateField]
  );

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
