import React, { createContext, useContext, ReactNode } from "react";
import { useTauriSystemState } from "../hooks/useTauriSystemState";
import type {
  TauriSystemState,
  SystemConnectionState,
  SystemProcessState,
  SystemDebugState,
} from "../hooks/useTauriSystemState";

interface TauriSystemStateContextValue {
  state: TauriSystemState | null;
  isLoading: boolean;
  error: string | null;

  loadState: () => Promise<void>;
  updateField: (field: string, value: any) => Promise<void>;
  updateState: (updates: Record<string, any>) => Promise<void>;

  updateConnectionState: (
    serverConnected: boolean,
    debuggerConnected: boolean,
    host?: string,
    port?: number
  ) => Promise<void>;
  updateProcessState: (
    attachedProcess?: SystemProcessState["attachedProcess"],
    attachedAppInfo?: SystemProcessState["attachedAppInfo"],
    serverInfo?: SystemProcessState["serverInfo"]
  ) => Promise<void>;
  updateDebugState: (
    isInBreakState?: boolean,
    currentThreadId?: number,
    currentBreakAddress?: string,
    registerData?: Record<string, string>
  ) => Promise<void>;
  addBreakpoint: (address: string, isSoftware?: boolean) => Promise<void>;
  removeBreakpoint: (address: string) => Promise<void>;
  addWatchpoint: (
    watchpoint: SystemDebugState["watchpoints"][0]
  ) => Promise<{ success: boolean; error?: string }>;
  removeWatchpoint: (watchpointId: string) => Promise<void>;
  updateModules: (
    modules: SystemProcessState["attachedModules"]
  ) => Promise<void>;

  isConnected: boolean | undefined;
  hasAttachedProcess: boolean;
  isInBreakState: boolean;
}

const TauriSystemStateContext =
  createContext<TauriSystemStateContextValue | null>(null);

interface TauriSystemStateProviderProps {
  children: ReactNode;
}

export const TauriSystemStateProvider: React.FC<
  TauriSystemStateProviderProps
> = ({ children }) => {
  const systemState = useTauriSystemState();

  return (
    <TauriSystemStateContext.Provider value={systemState}>
      {children}
    </TauriSystemStateContext.Provider>
  );
};

export const useTauriSystemStateContext = (): TauriSystemStateContextValue => {
  const context = useContext(TauriSystemStateContext);
  if (!context) {
    throw new Error(
      "useTauriSystemStateContext must be used within a TauriSystemStateProvider"
    );
  }
  return context;
};

export const useConnectionStateContext = () => {
  const { state, isLoading, isConnected } = useTauriSystemStateContext();

  return {
    connectionState: state
      ? ({
          serverConnected: state.serverConnected,
          debuggerConnected: state.debuggerConnected,
          connectionHost: state.connectionHost,
          connectionPort: state.connectionPort,
          authToken: state.authToken,
          serverSessionId: state.serverSessionId,
        } as SystemConnectionState)
      : null,
    isLoading,
    isConnected,
  };
};

export const useDebugStateContext = () => {
  const { state, isLoading, isInBreakState } = useTauriSystemStateContext();

  return {
    debugState: state
      ? ({
          isInBreakState: state.isInBreakState,
          currentThreadId: state.currentThreadId,
          currentBreakAddress: state.currentBreakAddress,
          currentRegisterData: state.currentRegisterData,
          activeBreakpoints: state.activeBreakpoints,
          watchpoints: state.watchpoints,
        } as SystemDebugState)
      : null,
    isLoading,
    isInBreakState,
    hasActiveBreakpoints: (state?.activeBreakpoints?.length ?? 0) > 0,
    hasActiveWatchpoints: (state?.watchpoints?.length ?? 0) > 0,
  };
};

export const useProcessStateContext = () => {
  const { state, isLoading, hasAttachedProcess } = useTauriSystemStateContext();

  return {
    processState: state
      ? ({
          attachedProcess: state.attachedProcess,
          serverInfo: state.serverInfo,
          attachedAppInfo: state.attachedAppInfo,
          attachedModules: state.attachedModules,
        } as SystemProcessState)
      : null,
    isLoading,
    hasAttachedProcess,
  };
};
