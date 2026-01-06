import { useCallback } from "react";
import { useExceptionHandler, ProcessedException } from "./useExceptionHandler";

// Legacy interface for backward compatibility
export interface WatchpointException {
  address: string;
  instruction: string;
  timestamp: Date;
  watchpointId: string;
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

export interface UseWatchpointExceptionHandlerOptions {
  pollingInterval?: number; // Default: 500ms
  onWatchpointHit?: (exception: WatchpointException) => void;
  onError?: (error: string) => void;
  autoStart?: boolean; // Auto-start monitoring when watchpoints are set
  // Connection and state checks (pass-through to useExceptionHandler)
  isConnected?: boolean; // Check if connected to server
  isProcessAttached?: boolean; // Check if process is attached
  hasActiveWatchpoints?: boolean; // Check if any watchpoints are set
}

// Convert ProcessedException to legacy WatchpointException format
const convertToLegacyFormat = (
  exception: ProcessedException
): WatchpointException => ({
  address: exception.address,
  instruction: exception.instruction,
  timestamp: exception.timestamp,
  watchpointId: exception.watchpointId!,
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

export const useWatchpointExceptionHandler = (
  options: UseWatchpointExceptionHandlerOptions = {}
) => {
  const {
    pollingInterval = 50,
    onWatchpointHit,
    onError,
    autoStart = true,
    isConnected = false,
    isProcessAttached = false,
    hasActiveWatchpoints = false,
  } = options;

  // Convert callback to use legacy format
  const handleWatchpointHit = useCallback(
    (exception: ProcessedException) => {
      if (onWatchpointHit) {
        onWatchpointHit(convertToLegacyFormat(exception));
      }
    },
    [onWatchpointHit]
  );

  // Use the common exception handler with watchpoint-only configuration
  const {
    isMonitoring,
    watchpointExceptions,
    lastCheckTime,
    error,
    startMonitoring,
    stopMonitoring,
    clearWatchpointExceptions,
    checkNow,
  } = useExceptionHandler({
    pollingInterval,
    onWatchpointHit: handleWatchpointHit,
    onError,
    autoStart,
    enableWatchpoints: true,
    enableBreakpoints: false, // Only monitor watchpoints
    isConnected,
    isProcessAttached,
    hasActiveWatchpoints,
  });

  // Convert exceptions to legacy format
  const exceptions: WatchpointException[] = watchpointExceptions.map(
    convertToLegacyFormat
  );

  // Alias clearWatchpointExceptions as clearExceptions for backward compatibility
  const clearExceptions = clearWatchpointExceptions;

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
