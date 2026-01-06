import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExceptionInfo } from "../types";
import { getApiClient } from "../lib/api";
import { useGlobalDebugLogger } from "./useGlobalDebugLogger";
import {
  useTauriExceptionStore,
  TauriExceptionData,
  TauriTraceEntryData,
} from "./useTauriExceptionStore";
import { encodeAddressToLibraryExpression } from "../utils/addressEncoder";
import { useAppState } from "./useAppState";

// Global trace entry counter for unique IDs
let globalTraceEntryId = 0;
let globalTraceDepth = 0;

export type ExceptionType =
  | "watchpoint"
  | "breakpoint"
  | "singlestep"
  | "signal"
  | "sigsegv"
  | "sigbus"
  | "sigfpe"
  | "sigill"
  | "sigabrt"
  | "sigtrap"
  | "unknown";

// Script breakpoint event (from Lua script Debug.set_breakpoint/remove_breakpoint)
export interface ScriptBreakpointEvent {
  event_type: "script_breakpoint";
  action: "set" | "remove";
  address: number;
  bp_type?: "soft" | "hard";
  has_callback?: boolean;
  timestamp: string;
}

// Global monitoring state (singleton)
class GlobalExceptionMonitoringState {
  private static instance: GlobalExceptionMonitoringState;

  public isGloballyMonitoring: boolean = false;
  public activeInstances: Set<string> = new Set();
  public mainInstanceId: string | null = null;
  public intervalId: number | null = null;

  public static getInstance(): GlobalExceptionMonitoringState {
    if (!GlobalExceptionMonitoringState.instance) {
      GlobalExceptionMonitoringState.instance =
        new GlobalExceptionMonitoringState();
    }
    return GlobalExceptionMonitoringState.instance;
  }

  public addInstance(instanceId: string): boolean {
    this.activeInstances.add(instanceId);

    if (!this.isGloballyMonitoring) {
      this.isGloballyMonitoring = true;
      this.mainInstanceId = instanceId;
      return true; // This instance becomes main
    }

    return false; // This instance becomes secondary
  }

  public removeInstance(instanceId: string): boolean {
    this.activeInstances.delete(instanceId);

    if (this.mainInstanceId === instanceId) {
      const remainingInstances = Array.from(this.activeInstances);
      if (remainingInstances.length > 0) {
        this.mainInstanceId = remainingInstances[0];
        return false; // Transferred to another instance
      } else {
        this.isGloballyMonitoring = false;
        this.mainInstanceId = null;
        if (this.intervalId) {
          window.clearInterval(this.intervalId);
          this.intervalId = null;
        }
        return true; // Last instance, stopped monitoring
      }
    }

    return false; // Was secondary instance
  }

  public setInterval(intervalId: number): void {
    this.intervalId = intervalId;
  }

  public clearInterval(): void {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export interface ProcessedException {
  address: string;
  instruction: string;
  timestamp: Date;
  type: ExceptionType;
  watchpointId?: string; // Only for watchpoint exceptions
  thread_id?: number; // Thread ID from exception info
  memory_address?: number; // Memory address for watchpoint exceptions
  singlestep_mode?: number; // Single step mode for singlestep exceptions
  is_trace?: boolean; // True if this is a trace exception (hit_count > 0)
  context?: any;
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
  // x86_64 registers
  rax?: string | number;
  rbx?: string | number;
  rcx?: string | number;
  rdx?: string | number;
  rsi?: string | number;
  rdi?: string | number;
  rbp?: string | number;
  rsp?: string | number;
  r8?: string | number;
  r9?: string | number;
  r10?: string | number;
  r11?: string | number;
  r12?: string | number;
  r13?: string | number;
  r14?: string | number;
  r15?: string | number;
  rip?: string | number;
  rflags?: string | number;
  cs?: string | number;
  ss?: string | number;
  ds?: string | number;
  es?: string | number;
  fs?: string | number;
  gs?: string | number;
}

export interface UseExceptionHandlerOptions {
  pollingInterval?: number; // Default: 500ms
  onWatchpointHit?: (exception: ProcessedException) => void;
  onBreakpointHit?: (exception: ProcessedException) => void;
  onSignalHit?: (exception: ProcessedException) => void; // Signal exception callback
  onScriptBreakpoint?: (event: ScriptBreakpointEvent) => void; // Script breakpoint set/remove callback
  onError?: (error: string) => void;
  autoStart?: boolean; // Auto-start monitoring when component mounts
  enableWatchpoints?: boolean; // Enable watchpoint monitoring
  enableBreakpoints?: boolean; // Enable breakpoint monitoring
  enableSignals?: boolean; // Enable signal monitoring
  // Connection and state checks
  isConnected?: boolean; // Check if connected to server
  isProcessAttached?: boolean; // Check if process is attached
  hasActiveWatchpoints?: boolean; // Check if any watchpoints are set
  hasActiveBreakpoints?: boolean; // Check if any breakpoints are set
}

// Global initialization flag
let globalInitialized = false;

export const useExceptionHandler = (
  options: UseExceptionHandlerOptions = {}
) => {
  const {
    pollingInterval = 50,
    onWatchpointHit,
    onBreakpointHit,
    onSignalHit,
    onScriptBreakpoint,
    onError,
    autoStart = true,
    enableWatchpoints = true,
    enableBreakpoints = true,
    enableSignals = true,
    isConnected = false,
    isProcessAttached = false,
    hasActiveWatchpoints = false,
    hasActiveBreakpoints = false,
  } = options;

  const { addLog } = useGlobalDebugLogger();

  // Get attached modules for library expression encoding
  const { system } = useAppState();
  const attachedModulesFromContext = system.attachedModules || [];

  // Also fetch from Tauri state as fallback
  const [tauriAttachedModules, setTauriAttachedModules] = useState<any[]>([]);
  useEffect(() => {
    const fetchModules = async () => {
      try {
        const state = (await invoke("get_app_state")) as any;
        if (state?.attached_modules && state.attached_modules.length > 0) {
          setTauriAttachedModules(
            state.attached_modules.map((m: any) => ({
              modulename: m.modulename,
              base: typeof m.base === "string" ? parseInt(m.base, 16) : m.base,
              size: typeof m.size === "string" ? parseInt(m.size, 16) : m.size,
              path: m.path,
            }))
          );
        }
      } catch (err) {
        console.error("Failed to fetch attached modules from Tauri:", err);
      }
    };
    fetchModules();
    // Refresh periodically
    const interval = setInterval(fetchModules, 2000);
    return () => clearInterval(interval);
  }, []);

  // Use context modules first, fallback to Tauri modules
  const attachedModules =
    attachedModulesFromContext.length > 0
      ? attachedModulesFromContext
      : tauriAttachedModules;

  // Get global monitoring state
  const globalState = GlobalExceptionMonitoringState.getInstance();

  // Only initialize once per hook instance, not on every re-render
  const hookInstanceId = useRef(Math.random().toString(36).substr(2, 9));

  useEffect(() => {
    // Only log initialization once globally across all instances
    if (
      !globalInitialized &&
      autoStart &&
      (enableWatchpoints || enableBreakpoints)
    ) {
      // Debug: Log stack trace to identify the caller
      console.trace("useExceptionHandler: First instance initialization");
      addLog(
        "DEBUG",
        "EXCEPTION",
        `Exception handler [${hookInstanceId.current}] initialized (FIRST INSTANCE)`,
        {
          enableWatchpoints,
          enableBreakpoints,
          autoStart,
          pollingInterval,
          hasWatchpointCallback: !!onWatchpointHit,
          hasBreakpointCallback: !!onBreakpointHit,
          isConnected,
          isProcessAttached,
          hasActiveWatchpoints,
          hasActiveBreakpoints,
          willAutoStart:
            autoStart &&
            isConnected &&
            isProcessAttached &&
            (enableWatchpoints || enableBreakpoints),
        }
      );
      globalInitialized = true;
    } else if (autoStart && (enableWatchpoints || enableBreakpoints)) {
      // Debug: Log stack trace to identify the caller
      console.trace("useExceptionHandler: Additional instance initialization");
      addLog(
        "DEBUG",
        "EXCEPTION",
        `Exception handler [${hookInstanceId.current}] initialized (ADDITIONAL INSTANCE - will not log details)`
      );
    }
  }, []); // Empty dependency array to run only once per instance mount

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [watchpointExceptions, setWatchpointExceptions] = useState<
    ProcessedException[]
  >([]);
  const [breakpointExceptions, setBreakpointExceptions] = useState<
    ProcessedException[]
  >([]);
  const [signalExceptions, setSignalExceptions] = useState<
    ProcessedException[]
  >([]);
  const [allExceptions, setAllExceptions] = useState<ProcessedException[]>([]);
  const [lastCheckTime, setLastCheckTime] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<number | null>(null);
  const isMonitoringRef = useRef<boolean>(false);
  const isPollingRef = useRef<boolean>(false);

  const { addExceptions: addExceptionsToTauriStore } = useTauriExceptionStore();

  // Process raw exception data into typed exceptions
  const processExceptions = useCallback(
    (
      rawExceptions: ExceptionInfo[]
    ): {
      watchpoints: ProcessedException[];
      breakpoints: ProcessedException[];
      signals: ProcessedException[];
      all: ProcessedException[];
    } => {
      const processedExceptions: ProcessedException[] = rawExceptions.map(
        (exception) => {
          // Handle different address formats
          let address = "unknown";

          if (exception.address) {
            address = exception.address;
          } else if ((exception as any).pc) {
            // If PC is provided as a separate field, use it as address
            const pc = (exception as any).pc;
            address =
              typeof pc === "number"
                ? `0x${pc.toString(16).padStart(16, "0").toUpperCase()}`
                : pc.toString();
          }

          // Ensure address starts with 0x
          if (
            address !== "unknown" &&
            !address.startsWith("0x") &&
            !address.startsWith("0X")
          ) {
            // If it's a valid hex number, add 0x prefix
            if (/^[0-9A-Fa-f]+$/.test(address)) {
              address = `0x${address}`;
            }
          }

          // Determine exception type based on exception_type field first, then fallback to instruction content
          let exceptionType: ExceptionType;
          if (
            exception.exception_type !== undefined &&
            exception.exception_type !== null
          ) {
            // Use the exception_type from C++ send_exception_info (matches Rust enum)
            // Handle both string and numeric values
            // Rust/C++ enum values: Breakpoint=1, Watchpoint=2, SingleStep=3
            switch (exception.exception_type) {
              case "breakpoint":
              case 1: // ExceptionType::Breakpoint
                exceptionType = "breakpoint";
                break;
              case "watchpoint":
              case 2: // ExceptionType::Watchpoint
                exceptionType = "watchpoint";
                break;
              case "singlestep":
              case 3: // ExceptionType::SingleStep
                exceptionType = "singlestep";
                break;
              case "signal":
              case 4: // ExceptionType::Signal
                exceptionType = "signal";
                break;
              case "sigsegv":
              case 5: // ExceptionType::Sigsegv
                exceptionType = "sigsegv";
                break;
              case "sigbus":
              case 6: // ExceptionType::Sigbus
                exceptionType = "sigbus";
                break;
              case "sigfpe":
              case 7: // ExceptionType::Sigfpe
                exceptionType = "sigfpe";
                break;
              case "sigill":
              case 8: // ExceptionType::Sigill
                exceptionType = "sigill";
                break;
              case "sigabrt":
              case 9: // ExceptionType::Sigabrt
                exceptionType = "sigabrt";
                break;
              case "sigtrap":
              case 10: // ExceptionType::Sigtrap
                exceptionType = "sigtrap";
                break;
              default:
                addLog(
                  "WARN",
                  "EXCEPTION",
                  `Unknown exception_type: ${exception.exception_type}`,
                  {
                    address,
                    exception_type: exception.exception_type,
                    instruction: exception.instruction,
                    typeOfExceptionType: typeof exception.exception_type,
                  }
                );
                exceptionType = "unknown";
                break;
            }
          } else {
            // Fallback to old logic for backward compatibility
            // Also check instruction content to detect single step
            if (exception.watchpointId) {
              exceptionType = "watchpoint";
            } else if (
              exception.instruction &&
              exception.instruction !== "unknown | unknown" &&
              !exception.instruction.includes("__METADATA__")
            ) {
              // If we have a proper instruction, it's likely a single step completion
              exceptionType = "singlestep";
            } else {
              // Otherwise, assume it's a breakpoint
              exceptionType = "breakpoint";
            }
          }

          // Log exception processing details with more context
          addLog("INFO", "EXCEPTION", "Processing exception:", {
            index: rawExceptions.indexOf(exception),
            address,
            hasWatchpointId: !!exception.watchpointId,
            watchpointId: exception.watchpointId,
            exception_type: exception.exception_type,
            exception_type_typeof: typeof exception.exception_type,
            detectedType: exceptionType,
            thread_id: exception.thread_id,
            instruction: exception.instruction,
            bytecode: exception.bytecode,
            opcode: exception.opcode,
            hasInstruction: !!exception.instruction,
            instructionContainsMetadata:
              exception.instruction?.includes("__METADATA__"),
          });

          // Parse instruction to extract bytecode and opcode
          // Format from server: "0xADDRESS|BYTECODE|OPCODE\n__METADATA__..."
          let bytecode = "unknown";
          let opcode = "unknown";

          if (
            exception.instruction &&
            exception.instruction !== "unknown | unknown"
          ) {
            // Split by newline first to remove metadata
            const instructionLines = exception.instruction.split("\n");
            const mainInstruction = instructionLines[0]; // Get first line before metadata

            // instruction format: "0xADDRESS|BYTECODE|OPCODE"
            const parts = mainInstruction.split("|");
            if (parts.length >= 3) {
              // Format: address | bytecode | opcode
              bytecode = parts[1].trim();
              opcode = parts[2].trim();
            } else if (parts.length === 2) {
              // Legacy format: bytecode | opcode
              bytecode = parts[0].trim();
              opcode = parts[1].trim();
            } else if (parts.length === 1) {
              // If it's a single instruction without separator, use it as opcode
              opcode = parts[0].trim();
            }
          }

          return {
            address,
            instruction:
              exception.instruction ||
              `${exception.bytecode || "unknown"} | ${exception.opcode || "unknown"}`,
            timestamp: exception.timestamp
              ? new Date(exception.timestamp)
              : new Date(),
            type: exceptionType,
            watchpointId: exception.watchpointId,
            thread_id: exception.thread_id, // Include thread_id from exception info
            // Extract memory_address from various sources
            memory_address:
              (exception as any).memory_address ||
              (exception as any).exception_info?.memory_address ||
              (exception as any).registers?.memory ||
              (exception as any).memory,
            // Extract singlestep_mode
            singlestep_mode:
              (exception as any).singlestep_mode ||
              (exception as any).exception_info?.singlestep_mode ||
              (exception as any).registers?.singlestep_mode,
            // Extract is_trace flag
            is_trace:
              (exception as any).is_trace ||
              (exception as any).exception_info?.is_trace ||
              false,
            // Copy register fields directly from exception (first priority)
            // ARM64 registers
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
            // x86_64 registers
            rax: (exception as any).rax,
            rbx: (exception as any).rbx,
            rcx: (exception as any).rcx,
            rdx: (exception as any).rdx,
            rsi: (exception as any).rsi,
            rdi: (exception as any).rdi,
            rbp: (exception as any).rbp,
            rsp: (exception as any).rsp,
            r8: (exception as any).r8,
            r9: (exception as any).r9,
            r10: (exception as any).r10,
            r11: (exception as any).r11,
            r12: (exception as any).r12,
            r13: (exception as any).r13,
            r14: (exception as any).r14,
            r15: (exception as any).r15,
            rip: (exception as any).rip,
            rflags: (exception as any).rflags,
            cs: (exception as any).cs,
            ss: (exception as any).ss,
            ds: (exception as any).ds,
            es: (exception as any).es,
            fs: (exception as any).fs,
            gs: (exception as any).gs,
            context: {
              index: exception.index || 0,
              count: exception.count || 1,
              bytecode: bytecode,
              opcode: opcode,
              pc: exception.pc,
              // Include the full exception object as fallback for register extraction
              rawException: exception,
            },
          };
        }
      );

      // Separate watchpoint, breakpoint, singlestep, and signal exceptions
      const watchpoints = processedExceptions.filter(
        (ex) => ex.type === "watchpoint"
      );
      const breakpoints = processedExceptions.filter(
        (ex) => ex.type === "breakpoint" || ex.type === "singlestep"
      );
      const signals = processedExceptions.filter(
        (ex) =>
          ex.type === "signal" ||
          ex.type === "sigsegv" ||
          ex.type === "sigbus" ||
          ex.type === "sigfpe" ||
          ex.type === "sigill" ||
          ex.type === "sigabrt" ||
          ex.type === "sigtrap"
      );
      return {
        watchpoints,
        breakpoints,
        signals,
        all: processedExceptions,
      };
    },
    []
  );

  // Fetch and check for new exceptions
  const checkForExceptions = useCallback(async () => {
    // Prevent concurrent polling - if already polling, skip this cycle
    if (isPollingRef.current) {
      return;
    }
    isPollingRef.current = true;

    const pollStartTime = performance.now();

    try {
      // Check preconditions before fetching exceptions
      if (!isConnected) {
        return;
      }

      if (!isProcessAttached) {
        return;
      }

      // Determine which exception types to monitor
      const exceptionTypesToMonitor: string[] = [];
      if (enableBreakpoints) {
        exceptionTypesToMonitor.push("breakpoint", "single_step");
      }
      if (enableWatchpoints) {
        exceptionTypesToMonitor.push("watchpoint");
      }
      if (enableSignals) {
        exceptionTypesToMonitor.push(
          "signal",
          "sigsegv",
          "sigbus",
          "sigfpe",
          "sigill",
          "sigabrt",
          "sigtrap"
        );
      }

      // If no exception types are enabled, skip checking
      if (exceptionTypesToMonitor.length === 0) {
        return;
      }

      const apiClient = getApiClient();
      // Fetch exceptions based on enabled types
      // For single_step, fetch Breakpoint mode (2), UserStep mode (3), and SoftwareBreakpoint mode (4)
      const apiStartTime = performance.now();
      const response = await apiClient.getExceptionInfo(
        exceptionTypesToMonitor,
        enableBreakpoints ? [2, 3, 4] : undefined // SingleStepMode::Breakpoint (2), UserStep (3), SoftwareBreakpoint (4)
      );
      const apiEndTime = performance.now();

      if (response.success && response.exceptions.length > 0) {
        console.log(
          `[POLLING] Found ${response.exceptions.length} exceptions, API took ${(apiEndTime - apiStartTime).toFixed(2)}ms, total poll time: ${(apiEndTime - pollStartTime).toFixed(2)}ms`
        );
      }

      if (response.success) {
        // Check for script breakpoint events first (from Lua Debug.set_breakpoint/remove_breakpoint)
        const scriptBpEvents = response.exceptions.filter(
          (ex: any) => ex.event_type === "script_breakpoint"
        );

        // Check for script output events (from print() in callbacks)
        const scriptOutputEvents = response.exceptions.filter(
          (ex: any) => ex.event_type === "script_output"
        );

        const regularExceptions = response.exceptions.filter(
          (ex: any) =>
            ex.event_type !== "script_breakpoint" &&
            ex.event_type !== "script_output"
        );

        // Handle script output events (print from callbacks)
        if (scriptOutputEvents.length > 0) {
          scriptOutputEvents.forEach((event: any) => {
            addLog("INFO", "SCRIPT", `[Callback] ${event.message}`, {
              source: event.source,
              timestamp: event.timestamp,
            });
            // Dispatch custom event for ScriptEditor to receive
            window.dispatchEvent(
              new CustomEvent("script-callback-output", {
                detail: { message: event.message, source: event.source },
              })
            );
          });
        }

        // Handle script breakpoint events
        if (scriptBpEvents.length > 0 && onScriptBreakpoint) {
          scriptBpEvents.forEach((event: any) => {
            addLog(
              "INFO",
              "SCRIPT",
              `Script breakpoint ${event.action}: 0x${event.address.toString(16)}`,
              {
                action: event.action,
                address: event.address,
                bp_type: event.bp_type,
                has_callback: event.has_callback,
              }
            );
            onScriptBreakpoint(event as ScriptBreakpointEvent);
          });
        }

        if (regularExceptions.length > 0) {
          addLog(
            "INFO",
            "EXCEPTION",
            `Raw exceptions received (${regularExceptions.length})`,
            regularExceptions.map((ex: any, index: number) => ({
              index,
              address: ex.address,
              timestamp: ex.timestamp,
              watchpointId: ex.watchpointId,
              bytecode: ex.bytecode,
              opcode: ex.opcode,
              instruction: ex.instruction,
              exception_type: ex.exception_type,
              thread_id: ex.thread_id,
              pc: ex.pc,
              lr: ex.lr,
              sp: ex.sp,
              fullException: ex,
            }))
          );
        }
        // Debug: Log even when no exceptions (to confirm polling is working)
        // Uncomment to debug: addLog("DEBUG", "EXCEPTION", "Polling check - no exceptions");

        const { watchpoints, breakpoints, signals, all } =
          processExceptions(regularExceptions);

        // Log processing configuration
        if (
          breakpoints.length > 0 ||
          watchpoints.length > 0 ||
          signals.length > 0
        ) {
          addLog("DEBUG", "EXCEPTION", "Processing configuration check:", {
            watchpoints: watchpoints.length,
            breakpoints: breakpoints.length,
            signals: signals.length,
            total: all.length,
            enabledWatchpoints: enableWatchpoints,
            enabledBreakpoints: enableBreakpoints,
          });
        }

        if (breakpoints.length > 0) {
          addLog("INFO", "EXCEPTION", "Processed exceptions:", {
            watchpoints: watchpoints.length,
            breakpoints: breakpoints.length,
            total: all.length,
            enabledWatchpoints: enableWatchpoints,
            enabledBreakpoints: enableBreakpoints,
          });
        }

        // Check for watchpoint exceptions - process ALL watchpoints every time
        if (enableWatchpoints && watchpoints.length > 0) {
          addLog(
            "INFO",
            "EXCEPTION",
            `Processing ALL watchpoint exceptions (${watchpoints.length})`,
            watchpoints
          );

          setWatchpointExceptions(watchpoints);

          // Process ALL watchpoint exceptions every time (no filtering)
          watchpoints.forEach((exception) => {
            addLog(
              "WARN",
              "EXCEPTION",
              `Watchpoint hit at ${exception.address} for watchpoint ${exception.watchpointId}: ${exception.instruction}`
            );

            if (onWatchpointHit) {
              onWatchpointHit(exception);
            }
          });
        }

        // Check for breakpoint exceptions - process ALL breakpoints every time
        // Filter out trace exceptions (is_trace=true) from breakpoint callback notifications
        const nonTraceBreakpoints = breakpoints.filter((ex) => !ex.is_trace);
        const traceBreakpoints = breakpoints.filter((ex) => ex.is_trace);

        if (enableBreakpoints && nonTraceBreakpoints.length > 0) {
          addLog(
            "INFO",
            "EXCEPTION",
            `Processing breakpoint exceptions (${nonTraceBreakpoints.length} non-trace, ${traceBreakpoints.length} trace)`,
            nonTraceBreakpoints
          );
          addLog("DEBUG", "EXCEPTION", "Breakpoint processing enabled check:", {
            enableBreakpoints,
            breakpointsLength: breakpoints.length,
            nonTraceCount: nonTraceBreakpoints.length,
            traceCount: traceBreakpoints.length,
            willProcess: enableBreakpoints && nonTraceBreakpoints.length > 0,
            hasCallback: !!onBreakpointHit,
          });

          setBreakpointExceptions(nonTraceBreakpoints);

          // Process only non-trace breakpoint exceptions (trace exceptions are handled separately)
          nonTraceBreakpoints.forEach((exception) => {
            const exceptionTypeLabel =
              exception.type === "singlestep" ? "Single step" : "Breakpoint";
            addLog(
              "WARN",
              "EXCEPTION",
              `${exceptionTypeLabel} hit at ${exception.address}: ${exception.instruction}`
            );

            // Determine if this is a single step or breakpoint for logging
            if (exception.type === "singlestep") {
              addLog(
                "DEBUG",
                "EXCEPTION",
                "Detected as single step completion",
                {
                  address: exception.address,
                  instruction: exception.instruction,
                  thread_id: exception.thread_id,
                }
              );
            } else {
              addLog("DEBUG", "EXCEPTION", "Detected as breakpoint hit", {
                address: exception.address,
                instruction: exception.instruction,
                thread_id: exception.thread_id,
              });
            }

            if (onBreakpointHit) {
              addLog(
                "DEBUG",
                "EXCEPTION",
                `Calling onBreakpointHit callback for ${exceptionTypeLabel.toLowerCase()}`
              );
              onBreakpointHit(exception);
            } else {
              addLog(
                "DEBUG",
                "EXCEPTION",
                "No onBreakpointHit callback available"
              );
            }
          });
        } else if (traceBreakpoints.length > 0) {
          addLog(
            "DEBUG",
            "EXCEPTION",
            `Skipping ${traceBreakpoints.length} trace exceptions from breakpoint callback`
          );
        }

        // Check for signal exceptions
        if (enableSignals && signals.length > 0) {
          addLog(
            "WARN",
            "EXCEPTION",
            `Processing signal exceptions (${signals.length})`,
            signals.map((s) => ({
              type: s.type,
              address: s.address,
              thread_id: s.thread_id,
            }))
          );

          setSignalExceptions(signals);

          signals.forEach((exception) => {
            const signalName = exception.type.toUpperCase();
            addLog(
              "ERROR",
              "EXCEPTION",
              `${signalName} at ${exception.address}: ${exception.instruction}`,
              {
                thread_id: exception.thread_id,
                memory_address: exception.memory_address,
              }
            );

            if (onSignalHit) {
              onSignalHit(exception);
            }
          });
        }

        // Update all exceptions
        setAllExceptions(all);
        setLastCheckTime(new Date());
        setError(null);

        if (all.length > 0) {
          const tauriExceptions: TauriExceptionData[] = all.map((ex) => ({
            exception_type: ex.type,
            address: ex.address,
            instruction: ex.instruction,
            timestamp: ex.timestamp.toISOString(),
            thread_id: ex.thread_id,
            watchpoint_id: ex.watchpointId,
            memory_address: ex.memory_address,
            singlestep_mode: ex.singlestep_mode,
            registers: ex.context?.rawException || {},
            bytecode: ex.context?.bytecode,
            opcode: ex.context?.opcode,
            pc: ex.context?.pc,
          }));

          addLog("DEBUG", "EXCEPTION", "Saving exceptions to Tauri store:", {
            count: tauriExceptions.length,
            types: tauriExceptions.map((e) => e.exception_type),
            watchpoints: tauriExceptions.filter(
              (e) => e.exception_type === "watchpoint"
            ).length,
            breakpoints: tauriExceptions.filter(
              (e) => e.exception_type === "breakpoint"
            ).length,
          });

          addExceptionsToTauriStore(tauriExceptions).catch((error) => {
            console.error("Failed to save exceptions to Tauri store:", error);
            addLog(
              "ERROR",
              "EXCEPTION",
              "Failed to save to Tauri store:",
              error
            );
          });

          // Debug: Log all singlestep exceptions to see what we're getting
          const allSinglesteps = all.filter((ex) => ex.type === "singlestep");
          if (allSinglesteps.length > 0) {
            addLog(
              "DEBUG",
              "TRACING",
              `All singlestep exceptions (${allSinglesteps.length}):`,
              allSinglesteps.map((ex) => ({
                address: ex.address,
                type: ex.type,
                singlestep_mode: ex.singlestep_mode,
                instruction: ex.instruction,
              }))
            );
          }

          // Process singlestep exceptions for code tracing
          // singlestep_mode values:
          //   2 = Breakpoint (hardware breakpoint single step)
          //   4 = SoftwareBreakpoint (software breakpoint single step)
          // Also include singlestep exceptions with undefined mode (fallback)
          // AND include breakpoint exceptions (first hit in trace mode)
          let traceExceptions = all
            .filter(
              (ex) =>
                (ex.type === "singlestep" &&
                  (ex.singlestep_mode === 2 ||
                    ex.singlestep_mode === 4 ||
                    ex.singlestep_mode === undefined)) ||
                ex.type === "breakpoint" // Include breakpoint hits (first trace entry)
            )
            // Sort by timestamp to ensure correct order
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          if (traceExceptions.length > 0) {
            // Get trace session to check tracked_thread_id
            let traceSession: any = null;
            try {
              traceSession = await invoke("get_trace_session");
            } catch (err) {
              // No active trace session
            }

            // If we have a trace session
            if (traceSession && traceSession.is_active) {
              if (
                traceSession.tracked_thread_id === undefined ||
                traceSession.tracked_thread_id === null
              ) {
                const firstBreakpoint = traceExceptions.find(
                  (ex) => ex.type === "breakpoint" && ex.thread_id !== undefined
                );
                if (
                  firstBreakpoint &&
                  firstBreakpoint.thread_id !== undefined
                ) {
                  addLog(
                    "INFO",
                    "TRACING",
                    `Setting tracked thread to ${firstBreakpoint.thread_id} (first breakpoint hit)`
                  );
                  try {
                    await invoke("set_trace_tracked_thread", {
                      threadId: firstBreakpoint.thread_id,
                    });
                    // Update local reference
                    traceSession.tracked_thread_id = firstBreakpoint.thread_id;
                  } catch (err) {
                    addLog(
                      "ERROR",
                      "TRACING",
                      `Failed to set tracked thread: ${err}`
                    );
                  }
                }
              }

              if (
                traceSession.tracked_thread_id !== undefined &&
                traceSession.tracked_thread_id !== null
              ) {
                const trackedThreadId = traceSession.tracked_thread_id;
                const beforeCount = traceExceptions.length;
                traceExceptions = traceExceptions.filter(
                  (ex) => ex.thread_id === trackedThreadId
                );
                const afterCount = traceExceptions.length;
                if (beforeCount !== afterCount) {
                  addLog(
                    "DEBUG",
                    "TRACING",
                    `Filtered trace exceptions: ${beforeCount} -> ${afterCount} (tracked thread: ${trackedThreadId})`
                  );
                }
              }
            }

            addLog(
              "INFO",
              "TRACING",
              `Processing ${traceExceptions.length} trace exceptions (batch)`
            );

            // Debug: Log attachedModules status
            if (attachedModules.length === 0) {
              addLog(
                "WARN",
                "TRACING",
                "No attached modules available for library expression encoding"
              );
            } else {
              addLog(
                "DEBUG",
                "TRACING",
                `Using ${attachedModules.length} modules for library encoding`,
                attachedModules.map((m: any) => ({
                  name: m.modulename,
                  base: m.base,
                }))
              );
            }

            // Build all trace entries first, then send as batch
            const traceEntries: TauriTraceEntryData[] = [];

            for (const ex of traceExceptions) {
              const pcNum =
                typeof ex.pc === "number"
                  ? ex.pc
                  : typeof ex.pc === "string"
                    ? parseInt(ex.pc, 16)
                    : parseInt(ex.address.replace(/^0x/i, ""), 16);

              // Parse instruction to get opcode and operands
              let opcode = ex.context?.opcode || "unknown";
              let operands = "";

              if (ex.instruction && ex.instruction !== "unknown | unknown") {
                const parts = ex.instruction.split("|");
                if (parts.length >= 3) {
                  const opcodeAndOperands = parts[2].trim().split("\n")[0];
                  const match = opcodeAndOperands.match(/^(\S+)\s*(.*)?$/);
                  if (match) {
                    opcode = match[1];
                    operands = match[2] || "";
                  }
                }
              }

              // Determine call/return based on opcode (ARM64)
              const opcodeUpper = opcode.toUpperCase();
              const isCall =
                opcodeUpper.startsWith("BL") &&
                !["BLT", "BLE", "BLS"].includes(opcodeUpper);
              const isReturn = opcodeUpper.startsWith("RET");

              // Update depth
              if (isReturn && globalTraceDepth > 0) globalTraceDepth--;
              const entryDepth = globalTraceDepth;
              if (isCall) globalTraceDepth++;

              // Build register map
              const registers: Record<string, string> = {};
              for (let i = 0; i <= 29; i++) {
                const regName = `x${i}`;
                const val = (ex as any)[regName];
                if (val !== undefined) {
                  registers[regName] =
                    typeof val === "number"
                      ? `0x${val.toString(16)}`
                      : String(val);
                }
              }
              ["lr", "fp", "sp", "pc", "cpsr"].forEach((regName) => {
                const val = (ex as any)[regName];
                if (val !== undefined) {
                  registers[regName] =
                    typeof val === "number"
                      ? `0x${val.toString(16)}`
                      : String(val);
                }
              });

              const traceEntry: TauriTraceEntryData = {
                id: ++globalTraceEntryId, // Will be reassigned by backend
                address: ex.address,
                instruction: ex.instruction,
                opcode: opcode,
                operands: operands,
                registers: registers,
                depth: entryDepth,
                is_call: isCall,
                is_return: isReturn,
                function_name: undefined,
                timestamp: ex.timestamp.getTime(), // Use exception timestamp for dedup
                library_expression:
                  encodeAddressToLibraryExpression(
                    pcNum,
                    attachedModules,
                    true
                  ) || undefined,
                target_address: "", // Will be determined by active session
              };

              traceEntries.push(traceEntry);
            }

            // Send all entries as a single batch
            if (traceEntries.length > 0) {
              invoke("add_trace_entries_batch", {
                entries: traceEntries,
              }).catch((err) => {
                console.error("Failed to add trace entries batch:", err);
              });
            }
          }
        }
      } else {
        const errorMsg = response.message || "Failed to fetch exceptions";
        addLog("ERROR", "EXCEPTION", "Failed to fetch exceptions:", errorMsg);
        setError(errorMsg);
        if (onError) {
          onError(errorMsg);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      addLog("ERROR", "EXCEPTION", "Exception check failed:", {
        error: errorMsg,
        fullError: error,
      });
      setError(errorMsg);
      if (onError) {
        onError(errorMsg);
      }
    } finally {
      // Always reset polling flag when done
      isPollingRef.current = false;
    }
  }, [
    processExceptions,
    enableWatchpoints,
    enableBreakpoints,
    enableSignals,
    onWatchpointHit,
    onBreakpointHit,
    onSignalHit,
    onError,
    isConnected,
    isProcessAttached,
    hasActiveWatchpoints,
    hasActiveBreakpoints,
  ]);

  // Start monitoring
  const startMonitoring = useCallback(() => {
    if (isMonitoring) {
      // Don't log if already monitoring to reduce noise
      return;
    }

    const isMainInstance = globalState.addInstance(hookInstanceId.current);

    if (!isMainInstance) {
      addLog(
        "DEBUG",
        "EXCEPTION",
        `[${hookInstanceId.current}] Monitoring already active by instance ${globalState.mainInstanceId}, joining as secondary`
      );
      setIsMonitoring(true);
      isMonitoringRef.current = true;
      return;
    }

    // This instance becomes the main monitoring instance
    addLog(
      "INFO",
      "EXCEPTION",
      `[${hookInstanceId.current}] Starting exception monitoring (main instance)`,
      {
        watchpoints: enableWatchpoints,
        breakpoints: enableBreakpoints,
        pollingInterval,
      }
    );
    setIsMonitoring(true);
    isMonitoringRef.current = true;

    // Clear any existing interval
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
    }

    // Start polling
    intervalRef.current = window.setInterval(() => {
      checkForExceptions();
    }, pollingInterval);

    // Store interval in global state
    globalState.setInterval(intervalRef.current);

    addLog(
      "INFO",
      "EXCEPTION",
      `[${hookInstanceId.current}] Exception monitoring started with interval ${pollingInterval}ms`,
      {
        intervalId: intervalRef.current,
      }
    );

    // Initial check
    checkForExceptions();
  }, [
    isMonitoring,
    checkForExceptions,
    pollingInterval,
    enableWatchpoints,
    enableBreakpoints,
    globalState,
  ]);

  // Stop monitoring
  const stopMonitoring = useCallback(() => {
    if (!isMonitoring) {
      // Don't log if not monitoring to reduce noise
      return;
    }

    const wasLastInstance = globalState.removeInstance(hookInstanceId.current);

    if (wasLastInstance) {
      addLog(
        "INFO",
        "EXCEPTION",
        `[${hookInstanceId.current}] Stopping exception monitoring (last instance)`
      );
    } else if (globalState.mainInstanceId === hookInstanceId.current) {
      addLog(
        "INFO",
        "EXCEPTION",
        `[${hookInstanceId.current}] Transferring monitoring control to another instance`
      );
    } else {
      addLog(
        "DEBUG",
        "EXCEPTION",
        `[${hookInstanceId.current}] Stopping secondary monitoring instance`
      );
    }

    setIsMonitoring(false);
    isMonitoringRef.current = false;

    // Clear local interval reference
    if (intervalRef.current) {
      intervalRef.current = null;
    }
  }, [isMonitoring, globalState]);

  // Clear exceptions
  const clearExceptions = useCallback(() => {
    setWatchpointExceptions([]);
    setBreakpointExceptions([]);
    setAllExceptions([]);
    setError(null);
  }, []);

  // Clear specific exception types
  const clearWatchpointExceptions = useCallback(() => {
    setWatchpointExceptions([]);
    // Update all exceptions by removing watchpoint exceptions
    setAllExceptions((prev) => prev.filter((ex) => ex.type !== "watchpoint"));
  }, []);

  const clearBreakpointExceptions = useCallback(() => {
    setBreakpointExceptions([]);
    // Update all exceptions by removing breakpoint exceptions
    setAllExceptions((prev) => prev.filter((ex) => ex.type !== "breakpoint"));
  }, []);

  // Manual check (useful for immediate checking after setting watchpoint/breakpoint)
  const checkNow = useCallback(() => {
    checkForExceptions();
  }, [checkForExceptions]);

  // Auto-start monitoring when component mounts if autoStart is true
  useEffect(() => {
    // Only auto-start if we have the necessary conditions
    // Note: For breakpoints, we always monitor when enableBreakpoints is true
    // because breakpoints are managed server-side and can be hit at any time
    // (e.g., trace breakpoints set via startTraceSession)
    const shouldAutoStart =
      autoStart &&
      isConnected &&
      isProcessAttached &&
      ((enableWatchpoints && hasActiveWatchpoints) || enableBreakpoints); // Always monitor for breakpoints when enabled

    const currentlyMonitoring = isMonitoringRef.current;

    // Only log when actually starting or stopping monitoring, not on every condition check
    if (shouldAutoStart && !currentlyMonitoring) {
      addLog(
        "INFO",
        "EXCEPTION",
        `[${hookInstanceId.current}] Auto-starting monitoring`,
        {
          autoStart,
          isConnected,
          isProcessAttached,
          enableWatchpoints,
          enableBreakpoints,
          hasActiveWatchpoints,
          hasActiveBreakpoints,
        }
      );
      startMonitoring();
    } else if (!shouldAutoStart && currentlyMonitoring) {
      addLog(
        "INFO",
        "EXCEPTION",
        `[${hookInstanceId.current}] Auto-stopping monitoring - conditions not met`,
        {
          autoStart,
          isConnected,
          isProcessAttached,
          enableWatchpoints,
          enableBreakpoints,
        }
      );
      stopMonitoring();
    }
  }, [
    autoStart,
    enableWatchpoints,
    enableBreakpoints,
    isConnected,
    isProcessAttached,
    hasActiveWatchpoints,
    hasActiveBreakpoints,
    startMonitoring,
    stopMonitoring,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Only cleanup if we were actually monitoring
      if (intervalRef.current) {
        addLog(
          "DEBUG",
          "EXCEPTION",
          `[${hookInstanceId.current}] Component unmount: stopping monitoring`
        );

        // Remove from global state
        globalState.removeInstance(hookInstanceId.current);

        // Clear interval
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  return {
    // State
    isMonitoring,
    watchpointExceptions,
    breakpointExceptions,
    signalExceptions,
    allExceptions,
    lastCheckTime,
    error,

    // Actions
    startMonitoring,
    stopMonitoring,
    clearExceptions,
    clearWatchpointExceptions,
    clearBreakpointExceptions,
    checkNow,
  };
};
