import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useCallback, useRef } from "react";

export interface TauriExceptionData {
  exception_type: string; // "watchpoint", "breakpoint", "singlestep"
  address: string;
  instruction?: string;
  timestamp: string;
  thread_id?: number;
  watchpoint_id?: string;
  memory_address?: number;
  singlestep_mode?: number;
  registers: any;
  bytecode?: string;
  opcode?: string;
  pc?: number;
}

export interface TauriTraceEntryData {
  id: number;
  address: string;
  instruction: string;
  opcode: string;
  operands: string;
  registers: any;
  depth: number;
  is_call: boolean;
  is_return: boolean;
  function_name?: string;
  timestamp: number;
  library_expression?: string;
  target_address: string;
}

export interface TauriTraceSession {
  target_address: string;
  total_count: number;
  current_count: number;
  is_active: boolean;
  started_at: number;
  tracked_thread_id?: number;
}

/**
 * Tauriの共有例外ストアにアクセスするためのフック
 * 全ウィンドウ間で例外データを共有するために使用
 */
export const useTauriExceptionStore = () => {
  const [exceptions, setExceptions] = useState<TauriExceptionData[]>([]);
  const [isListening, setIsListening] = useState(false);

  const addExceptions = useCallback(
    async (newExceptions: TauriExceptionData[]) => {
      try {
        await invoke("add_exceptions", { exceptions: newExceptions });
      } catch (error) {
        console.error("Failed to add exceptions to Tauri store:", error);
      }
    },
    []
  );

  const getExceptions = useCallback(
    async (
      exceptionTypeFilter?: string[],
      limit?: number
    ): Promise<TauriExceptionData[]> => {
      try {
        const result = await invoke<TauriExceptionData[]>("get_exceptions", {
          exceptionTypeFilter,
          limit,
        });
        return result;
      } catch (error) {
        console.error("Failed to get exceptions from Tauri store:", error);
        return [];
      }
    },
    []
  );

  const getWatchpointExceptions = useCallback(
    async (
      watchpointId?: string,
      limit?: number
    ): Promise<TauriExceptionData[]> => {
      try {
        const result = await invoke<TauriExceptionData[]>(
          "get_watchpoint_exceptions",
          {
            watchpointId,
            limit,
          }
        );
        return result;
      } catch (error) {
        console.error(
          "Failed to get watchpoint exceptions from Tauri store:",
          error
        );
        return [];
      }
    },
    []
  );

  const clearExceptions = useCallback(async (exceptionType?: string) => {
    try {
      await invoke("clear_exceptions", { exceptionType });
    } catch (error) {
      console.error("Failed to clear exceptions from Tauri store:", error);
    }
  }, []);

  const clearWatchpointExceptions = useCallback(
    async (watchpointAddress: number, watchpointSize: number) => {
      try {
        await invoke("clear_watchpoint_exceptions", {
          watchpointAddress,
          watchpointSize,
        });
      } catch (error) {
        console.error(
          "Failed to clear watchpoint exceptions from Tauri store:",
          error
        );
      }
    },
    []
  );

  useEffect(() => {
    if (isListening) return;

    let unlistenAdded: (() => void) | undefined;
    let unlistenCleared: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        unlistenAdded = await listen<TauriExceptionData[]>(
          "exceptions-added",
          (event) => {
            //console.log("Exceptions added event received:", event.payload);
            setExceptions((prev) => [...prev, ...event.payload]);
          }
        );

        unlistenCleared = await listen("exceptions-cleared", () => {
          console.log("Exceptions cleared event received");
          setExceptions([]);
        });

        setIsListening(true);
      } catch (error) {
        console.error("Failed to setup Tauri exception listeners:", error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenAdded) unlistenAdded();
      if (unlistenCleared) unlistenCleared();
      setIsListening(false);
    };
  }, [isListening]);

  return {
    exceptions,
    addExceptions,
    getExceptions,
    getWatchpointExceptions,
    clearExceptions,
    clearWatchpointExceptions,
  };
};

/**
 * Tauriのトレースストアにアクセスするためのフック
 * Code Tracingウィンドウで使用
 */
export const useTauriTraceStore = () => {
  const [traceEntries, setTraceEntries] = useState<TauriTraceEntryData[]>([]);
  const [traceSession, setTraceSession] = useState<TauriTraceSession | null>(
    null
  );
  const [isListening, setIsListening] = useState(false);

  const startTraceSession = useCallback(
    async (targetAddress: string, totalCount: number) => {
      try {
        await invoke("start_trace_session", { targetAddress, totalCount });
        setTraceEntries([]);
      } catch (error) {
        console.error("Failed to start trace session:", error);
        throw error;
      }
    },
    []
  );

  const addTraceEntry = useCallback(async (entry: TauriTraceEntryData) => {
    try {
      await invoke("add_trace_entry", { entry });
    } catch (error) {
      console.error("Failed to add trace entry:", error);
      throw error;
    }
  }, []);

  const getTraceEntries = useCallback(
    async (
      targetAddress?: string,
      limit?: number
    ): Promise<TauriTraceEntryData[]> => {
      try {
        const result = await invoke<TauriTraceEntryData[]>(
          "get_trace_entries",
          {
            targetAddress,
            limit,
          }
        );
        return result;
      } catch (error) {
        console.error("Failed to get trace entries:", error);
        return [];
      }
    },
    []
  );

  const getTraceSession =
    useCallback(async (): Promise<TauriTraceSession | null> => {
      try {
        const result = await invoke<TauriTraceSession | null>(
          "get_trace_session"
        );
        return result;
      } catch (error) {
        console.error("Failed to get trace session:", error);
        return null;
      }
    }, []);

  const stopTraceSession = useCallback(async () => {
    try {
      await invoke("stop_trace_session");
    } catch (error) {
      console.error("Failed to stop trace session:", error);
    }
  }, []);

  const setTrackedThread = useCallback(async (threadId: number) => {
    try {
      await invoke("set_trace_tracked_thread", { threadId });
      setTraceSession((prev) =>
        prev ? { ...prev, tracked_thread_id: threadId } : null
      );
    } catch (error) {
      console.error("Failed to set tracked thread:", error);
    }
  }, []);

  const clearTraceEntries = useCallback(async () => {
    try {
      await invoke("clear_trace_entries");
      setTraceEntries([]);
      setTraceSession(null);
    } catch (error) {
      console.error("Failed to clear trace entries:", error);
    }
  }, []);

  useEffect(() => {
    if (isListening) return;

    let unlistenEntryAdded: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let unlistenSessionStarted: (() => void) | undefined;
    let unlistenSessionComplete: (() => void) | undefined;
    let unlistenSessionStopped: (() => void) | undefined;
    let unlistenEntriesCleared: (() => void) | undefined;
    let unlistenThreadTracked: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        unlistenEntryAdded = await listen<TauriTraceEntryData>(
          "trace-entry-added",
          (event) => {
            console.log("Trace entry added:", event.payload);
            setTraceEntries((prev) => [...prev, event.payload]);
          }
        );

        unlistenProgress = await listen<{ current: number; total: number }>(
          "trace-progress",
          (event) => {
            setTraceSession((prev) =>
              prev
                ? {
                    ...prev,
                    current_count: event.payload.current,
                  }
                : null
            );
          }
        );

        unlistenSessionStarted = await listen<{
          targetAddress: string;
          totalCount: number;
        }>("trace-session-started", (event) => {
          console.log("Trace session started:", event.payload);
          setTraceSession({
            target_address: event.payload.targetAddress,
            total_count: event.payload.totalCount,
            current_count: 0,
            is_active: true,
            started_at: Date.now(),
            tracked_thread_id: undefined,
          });
          setTraceEntries([]);
        });

        unlistenSessionComplete = await listen<{ totalEntries: number }>(
          "trace-session-complete",
          (event) => {
            console.log("Trace session complete:", event.payload);
            setTraceSession((prev) =>
              prev ? { ...prev, is_active: false } : null
            );
          }
        );

        unlistenSessionStopped = await listen("trace-session-stopped", () => {
          console.log("Trace session stopped");
          setTraceSession((prev) =>
            prev ? { ...prev, is_active: false } : null
          );
        });

        unlistenThreadTracked = await listen<{ threadId: number }>(
          "trace-thread-tracked",
          (event) => {
            console.log("Trace thread tracked:", event.payload);
            setTraceSession((prev) =>
              prev
                ? { ...prev, tracked_thread_id: event.payload.threadId }
                : null
            );
          }
        );

        unlistenEntriesCleared = await listen("trace-entries-cleared", () => {
          console.log("Trace entries cleared");
          setTraceEntries([]);
          setTraceSession(null);
        });

        setIsListening(true);
      } catch (error) {
        console.error("Failed to setup trace listeners:", error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenEntryAdded) unlistenEntryAdded();
      if (unlistenProgress) unlistenProgress();
      if (unlistenSessionStarted) unlistenSessionStarted();
      if (unlistenSessionComplete) unlistenSessionComplete();
      if (unlistenSessionStopped) unlistenSessionStopped();
      if (unlistenThreadTracked) unlistenThreadTracked();
      if (unlistenEntriesCleared) unlistenEntriesCleared();
      setIsListening(false);
    };
  }, [isListening]);

  const hasLoadedInitialState = useRef(false);
  useEffect(() => {
    if (!isListening) return;
    // Only load once
    if (hasLoadedInitialState.current) return;
    hasLoadedInitialState.current = true;

    const loadInitialState = async () => {
      console.log("Loading initial trace state...");
      const session = await getTraceSession();
      console.log("Loaded trace session:", session);
      if (session) {
        setTraceSession(session);
        const entries = await getTraceEntries(undefined);
        console.log("Loaded trace entries:", entries.length);
        setTraceEntries(entries);
      }
    };
    loadInitialState();
  }, [isListening]); // Remove getTraceSession and getTraceEntries from deps - they are stable

  return {
    traceEntries,
    traceSession,
    startTraceSession,
    addTraceEntry,
    getTraceEntries,
    getTraceSession,
    stopTraceSession,
    setTrackedThread,
    clearTraceEntries,
  };
};
