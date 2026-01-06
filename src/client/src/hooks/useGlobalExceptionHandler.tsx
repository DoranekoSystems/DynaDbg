import React, { createContext, useContext, useMemo } from "react";
import {
  useExceptionHandler,
  UseExceptionHandlerOptions,
  ProcessedException,
  ScriptBreakpointEvent,
} from "./useExceptionHandler";
import { useAppState } from "./useAppState";

interface GlobalExceptionHandlerContextType {
  // State
  isMonitoring: boolean;
  watchpointExceptions: ProcessedException[];
  breakpointExceptions: ProcessedException[];
  signalExceptions: ProcessedException[];
  allExceptions: ProcessedException[];
  lastCheckTime: Date | null;
  error: string | null;

  // Current thread exception (for thread switching back to current thread)
  currentThreadException: ProcessedException | null;

  // All stopped threads map (threadId -> exception)
  allStoppedThreads: Map<number, ProcessedException>;

  // Queued exceptions (from other threads while in break state)
  queuedBreakpointExceptions: ProcessedException[];
  queuedWatchpointExceptions: ProcessedException[];

  // Actions
  startMonitoring: () => void;
  stopMonitoring: () => void;
  clearExceptions: () => void;
  clearWatchpointExceptions: () => void;
  clearBreakpointExceptions: () => void;
  clearQueuedExceptions: () => void;
  clearAllStoppedThreads: () => void;
  processQueuedExceptions: () => void;
  checkNow: () => void;

  // Event handlers registration
  registerWatchpointHandler: (
    handler: (exception: ProcessedException) => void
  ) => void;
  unregisterWatchpointHandler: (
    handler: (exception: ProcessedException) => void
  ) => void;
  registerBreakpointHandler: (
    handler: (exception: ProcessedException) => void
  ) => void;
  unregisterBreakpointHandler: (
    handler: (exception: ProcessedException) => void
  ) => void;
  registerSignalHandler: (
    handler: (exception: ProcessedException) => void
  ) => void;
  unregisterSignalHandler: (
    handler: (exception: ProcessedException) => void
  ) => void;
  // Script breakpoint event handlers (from Lua scripts)
  registerScriptBreakpointHandler: (
    handler: (event: ScriptBreakpointEvent) => void
  ) => void;
  unregisterScriptBreakpointHandler: (
    handler: (event: ScriptBreakpointEvent) => void
  ) => void;
}

const GlobalExceptionHandlerContext =
  createContext<GlobalExceptionHandlerContextType | null>(null);

interface GlobalExceptionHandlerProviderProps {
  children: React.ReactNode;
  options?: UseExceptionHandlerOptions;
}

export const GlobalExceptionHandlerProvider: React.FC<
  GlobalExceptionHandlerProviderProps
> = ({ children, options = {} }) => {
  // Get break state and current thread from app state
  const { system } = useAppState();
  const isInBreakState = system.isInBreakState;
  const currentThreadId = system.currentThreadId;

  // All stopped thread exceptions map (threadId -> exception)
  const allStoppedThreadsRef = React.useRef<Map<number, ProcessedException>>(
    new Map()
  );
  const [allStoppedThreads, setAllStoppedThreads] = React.useState<
    Map<number, ProcessedException>
  >(new Map());

  // Current thread exception storage (for the currently active thread)
  const currentThreadExceptionRef = React.useRef<ProcessedException | null>(
    null
  );
  const [currentThreadException, setCurrentThreadException] =
    React.useState<ProcessedException | null>(null);

  // Queued exceptions storage (from other threads while in break state)
  const queuedBreakpointExceptionsRef = React.useRef<ProcessedException[]>([]);
  const queuedWatchpointExceptionsRef = React.useRef<ProcessedException[]>([]);
  const [queuedBreakpointExceptions, setQueuedBreakpointExceptions] =
    React.useState<ProcessedException[]>([]);
  const [queuedWatchpointExceptions, setQueuedWatchpointExceptions] =
    React.useState<ProcessedException[]>([]);

  // Refs to track current state for use in callbacks (avoid stale closure)
  const isInBreakStateRef = React.useRef(isInBreakState);
  const currentThreadIdRef = React.useRef(currentThreadId);

  // Keep refs in sync with state
  React.useEffect(() => {
    isInBreakStateRef.current = isInBreakState;
  }, [isInBreakState]);

  React.useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
  }, [currentThreadId]);

  // Handler registration storage
  const watchpointHandlers = React.useRef<
    Set<(exception: ProcessedException) => void>
  >(new Set());
  const breakpointHandlers = React.useRef<
    Set<(exception: ProcessedException) => void>
  >(new Set());
  const signalHandlers = React.useRef<
    Set<(exception: ProcessedException) => void>
  >(new Set());
  const scriptBreakpointHandlers = React.useRef<
    Set<(event: ScriptBreakpointEvent) => void>
  >(new Set());

  // Global exception handler - use passed options
  const exceptionHandler = useExceptionHandler({
    pollingInterval: options.pollingInterval ?? 100,
    enableWatchpoints: options.enableWatchpoints ?? true,
    enableBreakpoints: options.enableBreakpoints ?? true,
    autoStart: options.autoStart ?? true,
    isConnected: options.isConnected,
    isProcessAttached: options.isProcessAttached,
    hasActiveWatchpoints: options.hasActiveWatchpoints,
    hasActiveBreakpoints: options.hasActiveBreakpoints,
    onScriptBreakpoint: (event) => {
      // Call all registered script breakpoint handlers
      console.log(
        `[EXCEPTION_HANDLER] Script breakpoint event: ${event.action} at 0x${event.address.toString(16)}`
      );

      // Call the handler passed via options (from MainApp)
      if (options.onScriptBreakpoint) {
        try {
          options.onScriptBreakpoint(event);
        } catch (error) {
          console.error("Error in options.onScriptBreakpoint:", error);
        }
      }

      // Also call all registered handlers
      scriptBreakpointHandlers.current.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          console.error("Error in script breakpoint handler:", error);
        }
      });
    },
    onWatchpointHit: (exception) => {
      // Use refs to get current state (avoid stale closure)
      const inBreakState = isInBreakStateRef.current;
      const activeThreadId = currentThreadIdRef.current;

      // If not in break state, this is the first exception of a new break session
      // Clear old stopped threads to start fresh
      if (!inBreakState) {
        console.log(
          `[EXCEPTION_HANDLER] New break session (watchpoint) - clearing old stopped threads`
        );
        allStoppedThreadsRef.current.clear();
      }

      // Add to allStoppedThreads map if thread_id is available
      if (exception.thread_id !== undefined) {
        allStoppedThreadsRef.current.set(exception.thread_id, exception);
        setAllStoppedThreads(new Map(allStoppedThreadsRef.current));
        console.log(
          `[EXCEPTION_HANDLER] Added thread ${exception.thread_id} to allStoppedThreads (total: ${allStoppedThreadsRef.current.size})`
        );
      }

      // If in break state and exception is from a different thread, queue it (don't call handlers)
      if (
        inBreakState &&
        activeThreadId !== null &&
        activeThreadId !== undefined
      ) {
        if (
          exception.thread_id !== undefined &&
          exception.thread_id !== activeThreadId
        ) {
          console.log(
            `[EXCEPTION_HANDLER] Queuing watchpoint exception from thread ${exception.thread_id} (current: ${activeThreadId})`
          );
          queuedWatchpointExceptionsRef.current.push(exception);
          setQueuedWatchpointExceptions([
            ...queuedWatchpointExceptionsRef.current,
          ]);
          return;
        }
      }

      // First exception sets the break state immediately (for same-cycle processing)
      if (!inBreakState && exception.thread_id !== undefined) {
        console.log(
          `[EXCEPTION_HANDLER] First watchpoint exception - setting break state for thread ${exception.thread_id}`
        );
        isInBreakStateRef.current = true;
        currentThreadIdRef.current = exception.thread_id;
      }

      // Save current thread exception for thread switching
      currentThreadExceptionRef.current = exception;
      setCurrentThreadException(exception);

      // Call all registered watchpoint handlers
      watchpointHandlers.current.forEach((handler) => {
        try {
          handler(exception);
        } catch (error) {
          console.error("Error in watchpoint handler:", error);
        }
      });
    },
    onBreakpointHit: (exception) => {
      // Use refs to get current state (avoid stale closure)
      const inBreakState = isInBreakStateRef.current;
      const activeThreadId = currentThreadIdRef.current;

      // If not in break state, this is the first exception of a new break session
      // Clear old stopped threads to start fresh
      if (!inBreakState) {
        console.log(
          `[EXCEPTION_HANDLER] New break session (breakpoint) - clearing old stopped threads`
        );
        allStoppedThreadsRef.current.clear();
      }

      // Add to allStoppedThreads map if thread_id is available
      if (exception.thread_id !== undefined) {
        allStoppedThreadsRef.current.set(exception.thread_id, exception);
        setAllStoppedThreads(new Map(allStoppedThreadsRef.current));
        console.log(
          `[EXCEPTION_HANDLER] Added thread ${exception.thread_id} to allStoppedThreads (total: ${allStoppedThreadsRef.current.size})`
        );
      }

      // If in break state and exception is from a different thread, queue it (don't call handlers)
      if (
        inBreakState &&
        activeThreadId !== null &&
        activeThreadId !== undefined
      ) {
        if (
          exception.thread_id !== undefined &&
          exception.thread_id !== activeThreadId
        ) {
          console.log(
            `[EXCEPTION_HANDLER] Queuing breakpoint exception from thread ${exception.thread_id} (current: ${activeThreadId})`
          );
          queuedBreakpointExceptionsRef.current.push(exception);
          setQueuedBreakpointExceptions([
            ...queuedBreakpointExceptionsRef.current,
          ]);
          return;
        }
      }

      // First exception sets the break state immediately (for same-cycle processing)
      if (!inBreakState && exception.thread_id !== undefined) {
        console.log(
          `[EXCEPTION_HANDLER] First breakpoint exception - setting break state for thread ${exception.thread_id}`
        );
        isInBreakStateRef.current = true;
        currentThreadIdRef.current = exception.thread_id;
      }

      // Save current thread exception for thread switching
      currentThreadExceptionRef.current = exception;
      setCurrentThreadException(exception);

      // Call all registered breakpoint handlers
      breakpointHandlers.current.forEach((handler) => {
        try {
          handler(exception);
        } catch (error) {
          console.error("Error in breakpoint handler:", error);
        }
      });
    },
    enableSignals: options.enableSignals ?? true,
    onSignalHit: (exception) => {
      // Use refs to get current state (avoid stale closure)
      const inBreakState = isInBreakStateRef.current;

      // If not in break state, this is the first exception of a new break session
      // Clear old stopped threads to start fresh
      if (!inBreakState) {
        console.log(
          `[EXCEPTION_HANDLER] New break session (signal) - clearing old stopped threads`
        );
        allStoppedThreadsRef.current.clear();
      }

      // Add to allStoppedThreads map if thread_id is available
      if (exception.thread_id !== undefined) {
        allStoppedThreadsRef.current.set(exception.thread_id, exception);
        setAllStoppedThreads(new Map(allStoppedThreadsRef.current));
        console.log(
          `[EXCEPTION_HANDLER] Added thread ${exception.thread_id} to allStoppedThreads (signal: ${exception.type}, total: ${allStoppedThreadsRef.current.size})`
        );
      }

      // First exception sets the break state immediately
      if (!inBreakState && exception.thread_id !== undefined) {
        console.log(
          `[EXCEPTION_HANDLER] First signal exception (${exception.type}) - setting break state for thread ${exception.thread_id}`
        );
        isInBreakStateRef.current = true;
        currentThreadIdRef.current = exception.thread_id;
      }

      // Save current thread exception for thread switching
      currentThreadExceptionRef.current = exception;
      setCurrentThreadException(exception);

      // Call all registered signal handlers
      signalHandlers.current.forEach((handler) => {
        try {
          handler(exception);
        } catch (error) {
          console.error("Error in signal handler:", error);
        }
      });
    },
    // Note: Do NOT spread options here as it would override our callbacks
    // Other options like pollingInterval can be spread separately if needed
  });

  // Register the onBreakpointHit callback from options if provided
  React.useEffect(() => {
    console.log(
      "[EXCEPTION_HANDLER] useEffect for onBreakpointHit - options:",
      {
        hasOnBreakpointHit: !!options.onBreakpointHit,
        handlersCount: breakpointHandlers.current.size,
      }
    );
    if (options.onBreakpointHit) {
      console.log(
        "[EXCEPTION_HANDLER] Registering onBreakpointHit handler from options"
      );
      breakpointHandlers.current.add(options.onBreakpointHit);
      return () => {
        console.log("[BREAKPOINT HANDLER] Unregistering breakpoint handler");
        if (options.onBreakpointHit) {
          breakpointHandlers.current.delete(options.onBreakpointHit);
        }
      };
    }
  }, [options.onBreakpointHit]);

  // Register the onWatchpointHit callback from options if provided
  React.useEffect(() => {
    if (options.onWatchpointHit) {
      console.log(
        "[EXCEPTION_HANDLER] Registering onWatchpointHit handler from options"
      );
      watchpointHandlers.current.add(options.onWatchpointHit);
      return () => {
        if (options.onWatchpointHit) {
          watchpointHandlers.current.delete(options.onWatchpointHit);
        }
      };
    }
  }, [options.onWatchpointHit]);

  // Register the onSignalHit callback from options if provided
  React.useEffect(() => {
    if (options.onSignalHit) {
      console.log(
        "[EXCEPTION_HANDLER] Registering onSignalHit handler from options"
      );
      signalHandlers.current.add(options.onSignalHit);
      return () => {
        if (options.onSignalHit) {
          signalHandlers.current.delete(options.onSignalHit);
        }
      };
    }
  }, [options.onSignalHit]);

  // Handler registration functions
  const registerWatchpointHandler = React.useCallback(
    (handler: (exception: ProcessedException) => void) => {
      watchpointHandlers.current.add(handler);
    },
    []
  );

  const unregisterWatchpointHandler = React.useCallback(
    (handler: (exception: ProcessedException) => void) => {
      watchpointHandlers.current.delete(handler);
    },
    []
  );

  const registerBreakpointHandler = React.useCallback(
    (handler: (exception: ProcessedException) => void) => {
      breakpointHandlers.current.add(handler);
    },
    []
  );

  const unregisterBreakpointHandler = React.useCallback(
    (handler: (exception: ProcessedException) => void) => {
      breakpointHandlers.current.delete(handler);
    },
    []
  );

  const registerSignalHandler = React.useCallback(
    (handler: (exception: ProcessedException) => void) => {
      signalHandlers.current.add(handler);
    },
    []
  );

  const unregisterSignalHandler = React.useCallback(
    (handler: (exception: ProcessedException) => void) => {
      signalHandlers.current.delete(handler);
    },
    []
  );

  const registerScriptBreakpointHandler = React.useCallback(
    (handler: (event: ScriptBreakpointEvent) => void) => {
      scriptBreakpointHandlers.current.add(handler);
    },
    []
  );

  const unregisterScriptBreakpointHandler = React.useCallback(
    (handler: (event: ScriptBreakpointEvent) => void) => {
      scriptBreakpointHandlers.current.delete(handler);
    },
    []
  );

  // Clear queued exceptions
  const clearQueuedExceptions = React.useCallback(() => {
    queuedBreakpointExceptionsRef.current = [];
    queuedWatchpointExceptionsRef.current = [];
    setQueuedBreakpointExceptions([]);
    setQueuedWatchpointExceptions([]);
    console.log("[EXCEPTION_HANDLER] Cleared all queued exceptions");
  }, []);

  // Clear all stopped threads
  const clearAllStoppedThreads = React.useCallback(() => {
    allStoppedThreadsRef.current.clear();
    setAllStoppedThreads(new Map());
    currentThreadExceptionRef.current = null;
    setCurrentThreadException(null);
    // Reset break state refs
    isInBreakStateRef.current = false;
    currentThreadIdRef.current = undefined;
    clearQueuedExceptions();
    console.log(
      "[EXCEPTION_HANDLER] Cleared all stopped threads and reset break state"
    );
  }, [clearQueuedExceptions]);

  // Process queued exceptions (call handlers for all queued exceptions)
  const processQueuedExceptions = React.useCallback(() => {
    console.log(
      `[EXCEPTION_HANDLER] Processing ${queuedBreakpointExceptionsRef.current.length} queued breakpoint exceptions`
    );

    // Process queued breakpoint exceptions
    queuedBreakpointExceptionsRef.current.forEach((exception) => {
      breakpointHandlers.current.forEach((handler) => {
        try {
          handler(exception);
        } catch (error) {
          console.error(
            "Error in breakpoint handler for queued exception:",
            error
          );
        }
      });
    });

    // Process queued watchpoint exceptions
    queuedWatchpointExceptionsRef.current.forEach((exception) => {
      watchpointHandlers.current.forEach((handler) => {
        try {
          handler(exception);
        } catch (error) {
          console.error(
            "Error in watchpoint handler for queued exception:",
            error
          );
        }
      });
    });

    // Clear the queues after processing
    clearQueuedExceptions();
  }, [clearQueuedExceptions]);

  const contextValue = useMemo(
    () => ({
      // State from the exception handler
      isMonitoring: exceptionHandler.isMonitoring,
      watchpointExceptions: exceptionHandler.watchpointExceptions,
      breakpointExceptions: exceptionHandler.breakpointExceptions,
      signalExceptions: exceptionHandler.signalExceptions,
      allExceptions: exceptionHandler.allExceptions,
      lastCheckTime: exceptionHandler.lastCheckTime,
      error: exceptionHandler.error,

      // Current thread exception (for switching back)
      currentThreadException,

      // All stopped threads map
      allStoppedThreads,

      // Queued exceptions state
      queuedBreakpointExceptions,
      queuedWatchpointExceptions,

      // Actions from the exception handler
      startMonitoring: exceptionHandler.startMonitoring,
      stopMonitoring: exceptionHandler.stopMonitoring,
      clearExceptions: exceptionHandler.clearExceptions,
      clearWatchpointExceptions: exceptionHandler.clearWatchpointExceptions,
      clearBreakpointExceptions: exceptionHandler.clearBreakpointExceptions,
      clearQueuedExceptions,
      clearAllStoppedThreads,
      processQueuedExceptions,
      checkNow: exceptionHandler.checkNow,

      // Handler registration
      registerWatchpointHandler,
      unregisterWatchpointHandler,
      registerBreakpointHandler,
      unregisterBreakpointHandler,
      registerSignalHandler,
      unregisterSignalHandler,
      registerScriptBreakpointHandler,
      unregisterScriptBreakpointHandler,
    }),
    [
      exceptionHandler.isMonitoring,
      exceptionHandler.watchpointExceptions,
      exceptionHandler.breakpointExceptions,
      exceptionHandler.signalExceptions,
      exceptionHandler.allExceptions,
      exceptionHandler.lastCheckTime,
      exceptionHandler.error,
      currentThreadException,
      allStoppedThreads,
      queuedBreakpointExceptions,
      queuedWatchpointExceptions,
      exceptionHandler.startMonitoring,
      exceptionHandler.stopMonitoring,
      exceptionHandler.clearExceptions,
      exceptionHandler.clearWatchpointExceptions,
      exceptionHandler.clearBreakpointExceptions,
      clearQueuedExceptions,
      clearAllStoppedThreads,
      processQueuedExceptions,
      exceptionHandler.checkNow,
      registerWatchpointHandler,
      unregisterWatchpointHandler,
      registerBreakpointHandler,
      unregisterBreakpointHandler,
      registerSignalHandler,
      unregisterSignalHandler,
      registerScriptBreakpointHandler,
      unregisterScriptBreakpointHandler,
    ]
  );

  return (
    <GlobalExceptionHandlerContext.Provider value={contextValue}>
      {children}
    </GlobalExceptionHandlerContext.Provider>
  );
};

export const useGlobalExceptionHandler =
  (): GlobalExceptionHandlerContextType => {
    const context = useContext(GlobalExceptionHandlerContext);
    if (!context) {
      throw new Error(
        "useGlobalExceptionHandler must be used within a GlobalExceptionHandlerProvider"
      );
    }
    return context;
  };

// Convenience hook for watchpoint handling
export const useWatchpointHandler = (
  handler?: (exception: ProcessedException) => void
) => {
  const {
    registerWatchpointHandler,
    unregisterWatchpointHandler,
    watchpointExceptions,
  } = useGlobalExceptionHandler();

  React.useEffect(() => {
    if (handler) {
      registerWatchpointHandler(handler);
      return () => {
        unregisterWatchpointHandler(handler);
      };
    }
  }, [handler, registerWatchpointHandler, unregisterWatchpointHandler]);

  return { watchpointExceptions };
};

// Convenience hook for breakpoint handling
export const useBreakpointHandler = (
  handler?: (exception: ProcessedException) => void
) => {
  const {
    registerBreakpointHandler,
    unregisterBreakpointHandler,
    breakpointExceptions,
  } = useGlobalExceptionHandler();

  const handlerRef = React.useRef(handler);
  const registeredRef = React.useRef(false);

  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    if (handler && !registeredRef.current) {
      console.log("[BREAKPOINT HANDLER] Registering breakpoint handler");
      registerBreakpointHandler(handler);
      registeredRef.current = true;
      return () => {
        console.log("[BREAKPOINT HANDLER] Unregistering breakpoint handler");
        unregisterBreakpointHandler(handler);
        registeredRef.current = false;
      };
    }
  }, [handler, registerBreakpointHandler, unregisterBreakpointHandler]);

  return { breakpointExceptions };
};
