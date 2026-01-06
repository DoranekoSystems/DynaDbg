import { useCallback } from "react";
import { useExceptionHandler, ProcessedException } from "./useExceptionHandler";

// Legacy interface for backward compatibility
export interface BreakpointException {
  address: string;
  instruction: string;
  timestamp: Date;
  thread_id?: number; // Thread ID from exception info
  context?: any; // Additional context information
  // Register values as individual fields (flattened from server processing)
  x0?: string | number;
  x1?: string | number;
  x2?: string | number;
  x3?: string | number;
  x4?: string | number;
  x5?: string | number;
  x6?: string | number;
  x7?: string | number;
  x8?: string | number;
  x9?: string | number;
  x10?: string | number;
  x11?: string | number;
  x12?: string | number;
  x13?: string | number;
  x14?: string | number;
  x15?: string | number;
  x16?: string | number;
  x17?: string | number;
  x18?: string | number;
  x19?: string | number;
  x20?: string | number;
  x21?: string | number;
  x22?: string | number;
  x23?: string | number;
  x24?: string | number;
  x25?: string | number;
  x26?: string | number;
  x27?: string | number;
  x28?: string | number;
  x29?: string | number;
  lr?: string | number;
  fp?: string | number;
  sp?: string | number;
  pc?: string | number;
  cpsr?: string | number;
}

export interface UseBreakpointExceptionHandlerOptions {
  pollingInterval?: number; // Default: 500ms
  onBreakpointHit?: (exception: BreakpointException) => void;
  onError?: (error: string) => void;
  autoStart?: boolean; // Auto-start monitoring when breakpoints are set
  // Connection and state checks (pass-through to useExceptionHandler)
  isConnected?: boolean; // Check if connected to server
  isProcessAttached?: boolean; // Check if process is attached
  hasActiveBreakpoints?: boolean; // Check if any breakpoints are set
}

// Convert ProcessedException to legacy BreakpointException format
const convertToLegacyFormat = (
  exception: ProcessedException
): BreakpointException => ({
  address: exception.address,
  instruction: exception.instruction,
  timestamp: exception.timestamp,
  context: exception.context,
  x0: exception.x0,
  x1: exception.x1,
  x2: exception.x2,
  x3: exception.x3,
  x4: exception.x4,
  x5: exception.x5,
  x6: exception.x6,
  x7: exception.x7,
  x8: exception.x8,
  x9: exception.x9,
  x10: exception.x10,
  x11: exception.x11,
  x12: exception.x12,
  x13: exception.x13,
  x14: exception.x14,
  x15: exception.x15,
  x16: exception.x16,
  x17: exception.x17,
  x18: exception.x18,
  x19: exception.x19,
  x20: exception.x20,
  x21: exception.x21,
  x22: exception.x22,
  x23: exception.x23,
  x24: exception.x24,
  x25: exception.x25,
  x26: exception.x26,
  x27: exception.x27,
  x28: exception.x28,
  x29: exception.x29,
  lr: exception.lr,
  fp: exception.fp,
  sp: exception.sp,
  pc: exception.pc,
  cpsr: exception.cpsr,
});

export const useBreakpointExceptionHandler = (
  options: UseBreakpointExceptionHandlerOptions = {}
) => {
  const {
    pollingInterval = 50,
    onBreakpointHit,
    onError,
    autoStart = true,
    isConnected = false,
    isProcessAttached = false,
    hasActiveBreakpoints = false,
  } = options;

  // Debug log
  console.log("[BREAKPOINT] useBreakpointExceptionHandler initialized with:", {
    pollingInterval,
    hasCallback: !!onBreakpointHit,
    autoStart,
  });

  // Convert callback to use legacy format
  const handleBreakpointHit = useCallback(
    (exception: ProcessedException) => {
      console.log("[BREAKPOINT] handleBreakpointHit called with:", exception);
      if (onBreakpointHit) {
        onBreakpointHit(convertToLegacyFormat(exception));
      }
    },
    [onBreakpointHit]
  );

  // Use the common exception handler with breakpoint-only configuration
  const exceptionHandlerConfig = {
    pollingInterval,
    onBreakpointHit: handleBreakpointHit,
    onError,
    autoStart,
    enableWatchpoints: false, // Only monitor breakpoints
    enableBreakpoints: true,
    isConnected,
    isProcessAttached,
    hasActiveBreakpoints,
  };

  console.log(
    "[BREAKPOINT] Passing config to useExceptionHandler:",
    exceptionHandlerConfig
  );

  const {
    isMonitoring,
    breakpointExceptions,
    lastCheckTime,
    error,
    startMonitoring,
    stopMonitoring,
    clearBreakpointExceptions,
    checkNow,
  } = useExceptionHandler(exceptionHandlerConfig);

  // Convert exceptions to legacy format
  const exceptions: BreakpointException[] = breakpointExceptions.map(
    convertToLegacyFormat
  );

  // Alias clearBreakpointExceptions as clearExceptions for backward compatibility
  const clearExceptions = clearBreakpointExceptions;

  return {
    // State
    isMonitoring,
    exceptions,
    lastCheckTime,
    error,

    // Actions
    startMonitoring,
    stopMonitoring,
    clearExceptions,
    checkNow,
  };
};
