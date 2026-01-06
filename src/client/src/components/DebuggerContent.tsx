import React, { useCallback, useEffect, useState, useRef } from "react";
import { Box, Alert, Snackbar } from "@mui/material";
import { MainContent } from "../utils/constants";
import { ServerInfo, getApiClient } from "../lib/api";
import { ExceptionInfo } from "../types";
import { AssemblyView } from "./AssemblyView";
import { MemoryView } from "./MemoryView";
import { DecompileView } from "./DecompileView";
import { Resizer } from "./Resizer";
import { useGlobalDebugLogger } from "../hooks/useGlobalDebugLogger";
import { useGlobalExceptionHandler } from "../hooks/useGlobalExceptionHandler";
import { useResizable } from "../hooks/useResizable";
import { ProcessedException } from "../hooks/useExceptionHandler";
import { GhidraTokenInfo } from "../hooks/useGhidraAnalysis";

interface DebuggerContentProps {
  serverInfo?: ServerInfo;
  onBreakpointInputSet?: (address: string) => void;
  onBreakpointHit?: (address: string) => void;
  onRegisterDataUpdate?: (registerData: Record<string, string>) => void;
  setCurrentThreadId?: (threadId: number | null) => void; // Set current active thread ID
  setLastException?: (exception: ExceptionInfo | null) => void; // Set last exception info
  currentBreakAddress?: string | null; // Add break address prop
  onBreakStateChange?: (isBreaking: boolean) => void; // Add break state change callback
  lastDebugAction?: "continue" | "single_step" | "breakpoint" | null; // Add last action tracking
  isInBreakState?: boolean; // Add break state prop
  isSoftwareBreakpoint?: boolean; // Whether to set software breakpoints (from toolbar toggle)
  // Add debugger content state props
  breakpointNotification?: {
    open: boolean;
    message: string;
  };
  activeBreakpoints?: string[];
  softwareBreakpoints?: string[]; // Track which breakpoints are software
  onAssemblyAddressChange?: (address: string) => void;
  onShowBreakpointNotification?: (message: string) => void;
  onHideBreakpointNotification?: () => void;
  onAddActiveBreakpoint?: (address: string, isSoftware?: boolean) => void;
  onRemoveActiveBreakpoint?: (address: string) => void;
  registerData?: Record<string, string>;
  currentThreadId?: number | null;
  memoryAddress?: string; // Add memory address prop
  onMemoryAddressChange?: (address: string) => void; // Add callback for memory address change
  // Module information for address detail display
  attachedModules?: any[]; // ModuleInfo array from useDebuggerState
  // Function name resolution for stack view
  resolveFunctionName?: (libraryPath: string, offset: number) => string | null;
}

export const DebuggerContent: React.FC<DebuggerContentProps> = ({
  serverInfo,
  onBreakpointInputSet,
  onBreakpointHit,
  onRegisterDataUpdate: _onRegisterDataUpdate,
  setCurrentThreadId,
  setLastException,
  currentBreakAddress,
  onBreakStateChange,
  lastDebugAction: _lastDebugAction,
  isInBreakState = false,
  isSoftwareBreakpoint = false,
  // Debugger content state props
  breakpointNotification = { open: false, message: "" },
  activeBreakpoints = [],
  softwareBreakpoints = [],
  onAssemblyAddressChange,
  onHideBreakpointNotification,
  onAddActiveBreakpoint,
  onRemoveActiveBreakpoint,
  registerData = {},
  currentThreadId = null,
  onMemoryAddressChange,
  attachedModules = [],
  resolveFunctionName,
}) => {
  const { logInfo, addLog } = useGlobalDebugLogger();

  // Decompile view visibility state - temporarily hidden
  const [isDecompileVisible, setIsDecompileVisible] = useState(false);

  // Ghidra decompile result state
  const [ghidraDecompileResult, setGhidraDecompileResult] = useState<{
    libraryPath: string;
    address: string;
    functionName: string | null;
    code: string;
    moduleBase: number;
    lineMapping: Record<string, string> | null; // line number (as string) -> offset (hex string)
    tokens?: GhidraTokenInfo[] | null; // Token information from Ghidra
  } | null>(null);
  const [isGhidraLoading] = useState(false);
  const [ghidraError, setGhidraError] = useState<string | null>(null);

  // Scroll to line number in DecompileView (set from assembly click)
  const [decompileScrollToLine, setDecompileScrollToLine] = useState<
    number | null
  >(null);

  // Highlight address in AssemblyView (from DecompileView click - highlight only if visible, scroll if not)
  const [highlightAssemblyAddress, setHighlightAssemblyAddress] = useState<
    string | null
  >(null);

  // Container ref for resize calculations
  const containerRef = useRef<HTMLDivElement>(null);

  // Vertical resizer for Assembly/Decompile vs Memory split
  const assemblyMemorySplit = useResizable({
    storageKey: "debugger-assembly-memory-split",
    defaultSize: 50, // Default to 50% of height
    minSize: 20,
    maxSize: 80,
    orientation: "vertical",
    containerRef,
  });

  // Horizontal resizer for Assembly vs Decompile split (width)
  const assemblyDecompileSplit = useResizable({
    storageKey: "debugger-assembly-decompile-split",
    defaultSize: 60, // Default to 60% for Assembly
    minSize: 30,
    maxSize: 80,
    orientation: "horizontal",
    containerRef,
  });

  // Use global exception handler instead of creating a separate instance
  const {
    breakpointExceptions: exceptions,
    error: exceptionError,
    clearBreakpointExceptions: clearExceptions,
    registerBreakpointHandler: _registerBreakpointHandler,
    unregisterBreakpointHandler: _unregisterBreakpointHandler,
    registerSignalHandler,
    unregisterSignalHandler,
  } = useGlobalExceptionHandler();

  // NOTE: Breakpoint handler registration removed to avoid duplicate processing.
  // MainApp now handles all breakpoint/exception processing centrally via
  // handleGlobalBreakpointHit and systemActions.updateDebugState.
  // This prevents double processing of exceptions which was causing ~1 second UI lag.

  // Use refs to store callback functions to avoid re-registering signal handler
  const setCurrentThreadIdRef = useRef(setCurrentThreadId);
  const setLastExceptionRef = useRef(setLastException);
  const onBreakStateChangeRef = useRef(onBreakStateChange);
  const onBreakpointHitRef = useRef(onBreakpointHit);
  const addLogRef = useRef(addLog);

  // Keep refs updated
  useEffect(() => {
    setCurrentThreadIdRef.current = setCurrentThreadId;
    setLastExceptionRef.current = setLastException;
    onBreakStateChangeRef.current = onBreakStateChange;
    onBreakpointHitRef.current = onBreakpointHit;
    addLogRef.current = addLog;
  });

  // Register signal handler (SIGSEGV, SIGILL, etc.) - only once on mount
  useEffect(() => {
    console.log("[DEBUGGER_CONTENT] Registering signal handler (once)");

    const handleSignal = (exception: ProcessedException) => {
      console.log("[DEBUGGER_CONTENT] Signal handler called with:", exception);

      const signalName = exception.type.toUpperCase();
      const address = exception.address || "unknown";

      addLogRef.current(
        "WARN",
        "DEBUGGER_CONTENT",
        `Signal ${signalName} received at ${address} (thread: ${exception.thread_id})`
      );

      // Set current thread ID and exception info in debugger state
      if (setCurrentThreadIdRef.current && exception.thread_id !== undefined) {
        setCurrentThreadIdRef.current(exception.thread_id);
        logInfo(
          "DEBUGGER_CONTENT",
          `Set current thread ID to: ${exception.thread_id}`
        );
      }

      // Create ExceptionInfo object for state management
      if (setLastExceptionRef.current) {
        const exceptionInfo: ExceptionInfo = {
          index: exception.context?.index || 0,
          count: exception.context?.count || 1,
          address: exception.address,
          bytecode: exception.context?.bytecode || "unknown",
          opcode: exception.context?.opcode || "unknown",
          timestamp: exception.timestamp,
          thread_id: exception.thread_id,
          exception_type: exception.type, // Signal type (sigill, sigsegv, etc.)
          instruction: exception.instruction,
          // Copy register values - ARM64
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
          // Copy register values - x86_64
          rax: exception.rax,
          rbx: exception.rbx,
          rcx: exception.rcx,
          rdx: exception.rdx,
          rsi: exception.rsi,
          rdi: exception.rdi,
          rbp: exception.rbp,
          rsp: exception.rsp,
          r8: exception.r8,
          r9: exception.r9,
          r10: exception.r10,
          r11: exception.r11,
          r12: exception.r12,
          r13: exception.r13,
          r14: exception.r14,
          r15: exception.r15,
          rip: exception.rip,
          rflags: exception.rflags,
          cs: exception.cs,
          ss: exception.ss,
          ds: exception.ds,
          es: exception.es,
          fs: exception.fs,
          gs: exception.gs,
        };
        setLastExceptionRef.current(exceptionInfo);
        logInfo("DEBUGGER_CONTENT", "Set last exception info for signal");
      }

      // Set break state to pause UI
      if (onBreakStateChangeRef.current) {
        onBreakStateChangeRef.current(true);
        logInfo("DEBUGGER_CONTENT", "Set in break state for signal");
      }

      // Navigate to the signal address (same as breakpoint)
      if (onBreakpointHitRef.current) {
        const displayAddress = address.toLowerCase().startsWith("0x")
          ? address
          : `0x${address}`;
        onBreakpointHitRef.current(displayAddress);
        logInfo(
          "DEBUGGER_CONTENT",
          `onBreakpointHit called for signal at address: ${displayAddress}`
        );
      }
    };

    console.log("[DEBUGGER_CONTENT] About to register signal handler");
    registerSignalHandler(handleSignal);
    console.log("[DEBUGGER_CONTENT] Signal handler registered successfully");

    return () => {
      console.log("[DEBUGGER_CONTENT] Unregistering signal handler");
      unregisterSignalHandler(handleSignal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerSignalHandler, unregisterSignalHandler]); // Only re-register when handler functions change

  // Note: Monitoring is handled by GlobalExceptionHandlerProvider automatically
  // No need to manually start/stop monitoring here

  // Handle address change from memory view (memory view is now independent)
  const handleMemoryAddressChange = useCallback(
    (address: string) => {
      // Memory view address changes are now independent - no action needed
      addLog("INFO", "MEMORY", "Memory view address changed", {
        address,
      });

      // Call parent callback if provided
      if (onMemoryAddressChange) {
        onMemoryAddressChange(address);
      }
    },
    [onMemoryAddressChange, addLog]
  );

  // Handle breakpoint removal
  const handleBreakpointRemove = useCallback(
    async (address: string) => {
      try {
        const apiClient = getApiClient();
        const addressNum = parseInt(address.replace(/^0x/i, ""), 16);
        const response = await apiClient.removeBreakpoint({
          address: addressNum,
        });

        if (response.success) {
          addLog("INFO", "BREAKPOINT", `Breakpoint removed at ${address}`);
          // Remove from active breakpoints list
          if (onRemoveActiveBreakpoint) {
            onRemoveActiveBreakpoint(address);
          }
        } else {
          addLog(
            "ERROR",
            "BREAKPOINT",
            `Failed to remove breakpoint at ${address}: ${response.message}`
          );
        }
      } catch (error) {
        addLog(
          "ERROR",
          "BREAKPOINT",
          `Failed to remove breakpoint: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    },
    [onRemoveActiveBreakpoint, addLog]
  );

  // Handle breakpoint address setting
  const handleBreakpointSet = useCallback(
    async (address: string, isSoftware?: boolean) => {
      // Use passed isSoftware if provided, otherwise use the prop
      const useSoftware = isSoftware ?? isSoftwareBreakpoint;
      console.log(
        "[DebuggerContent] handleBreakpointSet:",
        address,
        "isSoftware:",
        useSoftware
      );
      try {
        const apiClient = getApiClient();
        const addressNum = parseInt(address.replace(/^0x/i, ""), 16);
        const response = await apiClient.setBreakpoint({
          address: addressNum,
          hit_count: 0,
          is_software: useSoftware,
        });

        if (response.success) {
          addLog(
            "INFO",
            "BREAKPOINT",
            `Breakpoint set at ${address} (${useSoftware ? "software" : "hardware"})`
          );
          // Update the input value
          if (onBreakpointInputSet) {
            onBreakpointInputSet(address);
          }
          // Add to active breakpoints list for exception monitoring
          if (onAddActiveBreakpoint) {
            onAddActiveBreakpoint(address, useSoftware);
          }
        } else {
          addLog(
            "ERROR",
            "BREAKPOINT",
            `Failed to set breakpoint at ${address}: ${response.message}`
          );
        }
      } catch (error) {
        addLog(
          "ERROR",
          "BREAKPOINT",
          `Failed to set breakpoint: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    },
    [onBreakpointInputSet, onAddActiveBreakpoint, addLog, isSoftwareBreakpoint]
  );

  // Handle decompile view toggle
  const handleDecompileToggle = useCallback(() => {
    setIsDecompileVisible((prev) => !prev);
    addLog(
      "INFO",
      "DECOMPILE",
      `Decompile view ${isDecompileVisible ? "hidden" : "shown"}`
    );
  }, [isDecompileVisible, addLog]);

  // Handle decompile line click - use line mapping to highlight assembly address
  // If address is visible, just highlight; if not visible, scroll to it
  const handleDecompileLineClick = useCallback(
    (lineNumber: number, lineText: string) => {
      console.log(
        "[DebuggerContent] Decompile line clicked:",
        lineNumber,
        lineText
      );

      if (!ghidraDecompileResult) {
        addLog("WARN", "DECOMPILE", "No decompile result available");
        return;
      }

      const { moduleBase, lineMapping } = ghidraDecompileResult;

      // First, try to use the line mapping from Ghidra
      const lineKey = String(lineNumber);
      if (lineMapping && lineMapping[lineKey]) {
        const offsetHex = lineMapping[lineKey];
        console.log(
          "[DebuggerContent] Found line mapping:",
          lineNumber,
          "->",
          offsetHex
        );

        // Parse the offset (it's already in hex format like "0x1234")
        const offset = parseInt(offsetHex.replace(/^0x/i, ""), 16);
        const absoluteAddress = moduleBase + offset;
        const hexAddress = `0x${absoluteAddress.toString(16)}`;

        console.log("[DebuggerContent] Highlighting address:", hexAddress);
        // Use highlightAssemblyAddress instead of direct navigation
        // AssemblyView will check if visible and only scroll if needed
        setHighlightAssemblyAddress(hexAddress);
        addLog(
          "INFO",
          "DECOMPILE",
          `Line ${lineNumber}: Highlight ${hexAddress} (from line mapping)`
        );
        return;
      }

      // Fallback: try to find nearest line with mapping
      if (lineMapping) {
        const mappedLines = Object.keys(lineMapping)
          .map(Number)
          .sort((a, b) => a - b);

        // Find the closest line number that is <= current line
        let nearestLine = mappedLines[0];
        for (const ln of mappedLines) {
          if (ln <= lineNumber) {
            nearestLine = ln;
          } else {
            break;
          }
        }

        const nearestLineKey = String(nearestLine);
        if (nearestLine && lineMapping[nearestLineKey]) {
          const offsetHex = lineMapping[nearestLineKey];
          console.log(
            "[DebuggerContent] Using nearest line mapping:",
            nearestLine,
            "->",
            offsetHex
          );

          const offset = parseInt(offsetHex.replace(/^0x/i, ""), 16);
          const absoluteAddress = moduleBase + offset;
          const hexAddress = `0x${absoluteAddress.toString(16)}`;

          // Use highlightAssemblyAddress instead of direct navigation
          setHighlightAssemblyAddress(hexAddress);
          addLog(
            "INFO",
            "DECOMPILE",
            `Line ${lineNumber}: Highlight ${hexAddress} (nearest mapping from line ${nearestLine})`
          );
          return;
        }
      }

      // Final fallback: look for hex address in the line text
      const hexMatch = lineText.match(/0x[0-9a-fA-F]+/);
      if (hexMatch) {
        const ghidraAddress = hexMatch[0];
        console.log(
          "[DebuggerContent] Found hex address in line:",
          ghidraAddress
        );

        const ghidraAddr = parseInt(ghidraAddress.replace(/^0x/i, ""), 16);
        const GHIDRA_IMAGE_BASE = 0x00100000;
        const offset = ghidraAddr - GHIDRA_IMAGE_BASE;
        const absoluteAddress = moduleBase + offset;
        const hexAddress = `0x${absoluteAddress.toString(16)}`;

        // Use highlightAssemblyAddress instead of direct navigation
        setHighlightAssemblyAddress(hexAddress);
        addLog(
          "INFO",
          "DECOMPILE",
          `Line ${lineNumber}: Highlight ${hexAddress} (from hex in text)`
        );
        return;
      }

      addLog(
        "INFO",
        "DECOMPILE",
        `Line ${lineNumber} clicked (no address mapping available)`
      );
    },
    [addLog, ghidraDecompileResult]
  );

  // Handle Ghidra decompile request from AssemblyView
  const handleDecompileRequest = useCallback(
    (
      libraryPath: string,
      address: string,
      functionName: string | null,
      decompiledCode: string,
      moduleBase: number,
      lineMapping: Record<string, string> | null,
      tokens?: GhidraTokenInfo[] | null
    ) => {
      console.log("[DebuggerContent] Received decompile result:", {
        libraryPath,
        address,
        functionName,
        codeLength: decompiledCode.length,
        moduleBase,
        moduleBaseHex: `0x${moduleBase.toString(16)}`,
        lineMappingCount: lineMapping ? Object.keys(lineMapping).length : 0,
        tokensCount: tokens ? tokens.length : 0,
      });
      setGhidraDecompileResult({
        libraryPath,
        address,
        functionName,
        code: decompiledCode,
        moduleBase,
        lineMapping,
        tokens,
      });
      // Auto-show decompile view when result is received
      setIsDecompileVisible(true);
      addLog("INFO", "GHIDRA", `Decompiled: ${functionName || address}`);
    },
    [addLog]
  );

  // Handle address click from DecompileView - navigate to that address in assembly
  const handleDecompileAddressClick = useCallback(
    (ghidraAddress: string) => {
      // Ghidra addresses start from 0x00100000 (image base)
      // We need to convert to module offset and then to absolute address using saved moduleBase
      console.log(
        "[DebuggerContent] Decompile address clicked:",
        ghidraAddress
      );
      console.log(
        "[DebuggerContent] ghidraDecompileResult:",
        ghidraDecompileResult
      );
      addLog("INFO", "DECOMPILE", `Address clicked: ${ghidraAddress}`);

      if (!ghidraDecompileResult) {
        console.warn("[DebuggerContent] No ghidraDecompileResult available");
        return;
      }

      // Extract the numeric value from the hex address
      const ghidraAddr = parseInt(ghidraAddress.replace(/^0x/i, ""), 16);
      console.log(
        "[DebuggerContent] Parsed ghidraAddr:",
        ghidraAddr,
        `(0x${ghidraAddr.toString(16)})`
      );

      // Ghidra uses 0x00100000 as default image base
      const GHIDRA_IMAGE_BASE = 0x00100000;
      const offset = ghidraAddr - GHIDRA_IMAGE_BASE;
      console.log(
        "[DebuggerContent] Offset from Ghidra image base:",
        offset,
        `(0x${offset.toString(16)})`
      );

      // Use the saved moduleBase from when decompilation was performed
      const moduleBase = ghidraDecompileResult.moduleBase;
      console.log(
        "[DebuggerContent] Using saved moduleBase:",
        moduleBase,
        `(0x${moduleBase.toString(16)})`
      );

      const absoluteAddress = moduleBase + offset;
      const hexAddress = `0x${absoluteAddress.toString(16)}`;
      console.log("[DebuggerContent] Calculated absolute address:", hexAddress);

      if (onAssemblyAddressChange) {
        onAssemblyAddressChange(hexAddress);
        addLog(
          "INFO",
          "DECOMPILE",
          `Navigated to ${hexAddress} (offset 0x${offset.toString(16)} from moduleBase 0x${moduleBase.toString(16)})`
        );
      }
    },
    [addLog, ghidraDecompileResult, onAssemblyAddressChange]
  );

  // Handle function click from DecompileView - decompile the clicked function
  const handleDecompileFunctionClick = useCallback(
    (functionOffset: string) => {
      console.log("[DebuggerContent] Function clicked:", functionOffset);

      if (!ghidraDecompileResult) {
        addLog(
          "WARN",
          "DECOMPILE",
          "No decompile result available to determine library"
        );
        return;
      }

      // Calculate absolute address from function offset and navigate
      const offset = parseInt(functionOffset.replace(/^0x/i, ""), 16);
      const absoluteAddress = ghidraDecompileResult.moduleBase + offset;
      const hexAddress = `0x${absoluteAddress.toString(16)}`;

      addLog(
        "INFO",
        "DECOMPILE",
        `Navigating to function at ${hexAddress} (offset ${functionOffset})`
      );

      if (onAssemblyAddressChange) {
        onAssemblyAddressChange(hexAddress);
      }
    },
    [addLog, ghidraDecompileResult, onAssemblyAddressChange]
  );

  // Handle assembly address change to scroll DecompileView to corresponding line
  const handleAssemblyToDecompileSync = useCallback(
    (absoluteAddress: string) => {
      if (!ghidraDecompileResult || !ghidraDecompileResult.lineMapping) {
        return;
      }

      const { moduleBase, lineMapping } = ghidraDecompileResult;

      // Convert absolute address to offset
      const absAddr = parseInt(absoluteAddress.replace(/^0x/i, ""), 16);
      const offset = absAddr - moduleBase;
      const offsetHex = `0x${offset.toString(16)}`;

      // Find the line number that maps to this offset
      // lineMapping is { lineNumber: offsetHex }
      // We need to reverse lookup: find line number where value matches offset
      let targetLine: number | null = null;
      let nearestLine: number | null = null;
      let nearestDistance = Infinity;

      for (const [lineStr, lineOffset] of Object.entries(lineMapping)) {
        const lineNum = parseInt(lineStr, 10);
        const mappedOffset = parseInt(lineOffset.replace(/^0x/i, ""), 16);

        if (mappedOffset === offset) {
          targetLine = lineNum;
          break;
        }

        // Track nearest line for fallback
        const distance = Math.abs(mappedOffset - offset);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestLine = lineNum;
        }
      }

      // Use exact match or nearest if within reasonable range (256 bytes)
      const lineToScroll =
        targetLine || (nearestDistance < 256 ? nearestLine : null);

      if (lineToScroll) {
        console.log(
          `[DebuggerContent] Scrolling DecompileView to line ${lineToScroll} for offset ${offsetHex}`
        );
        setDecompileScrollToLine(lineToScroll);
        // Clear after a short delay to allow re-triggering for same line
        setTimeout(() => setDecompileScrollToLine(null), 100);
      }
    },
    [ghidraDecompileResult]
  );

  // Handle AI enhancement
  const handleAIEnhance = useCallback(() => {
    addLog("INFO", "AI", "AI enhancement toggled for decompiled source");
  }, [addLog]);

  // Handle notification close
  const handleNotificationClose = useCallback(() => {
    if (onHideBreakpointNotification) {
      onHideBreakpointNotification();
    }
  }, [onHideBreakpointNotification]);

  return (
    <MainContent>
      <Box
        ref={containerRef}
        sx={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Exception monitoring error notification */}
        {exceptionError && (
          <Alert
            severity="warning"
            sx={{ mb: 1 }}
            onClose={() => {
              // Clear error (monitoring is handled globally)
              clearExceptions();
            }}
          >
            Breakpoint monitoring error: {exceptionError}
          </Alert>
        )}

        {/* Assembly and Decompile Views - Top Half */}
        <Box
          sx={{
            height: `${assemblyMemorySplit.size}%`,
            minHeight: 0, // Allow flex child to shrink below content size
            borderBottom: 1,
            borderColor: "divider",
            overflow: "hidden",
            display: "flex",
            flexDirection: "row",
          }}
        >
          {/* Assembly View - Left Side */}
          <Box
            sx={{
              width: isDecompileVisible
                ? `${assemblyDecompileSplit.size}%`
                : "100%",
              minWidth: 0,
              overflow: "hidden",
              transition: isDecompileVisible ? "none" : "width 0.3s ease",
            }}
          >
            <AssemblyView
              serverInfo={serverInfo}
              onBreakpointSet={handleBreakpointSet}
              onBreakpointRemove={handleBreakpointRemove}
              onBreakpointHit={onBreakpointHit}
              currentBreakAddress={currentBreakAddress}
              isInBreakState={isInBreakState}
              activeBreakpoints={activeBreakpoints}
              softwareBreakpoints={
                new Map(softwareBreakpoints.map((addr) => [addr, ""]))
              }
              isSoftwareBreakpoint={isSoftwareBreakpoint}
              attachedModules={attachedModules}
              registerData={registerData}
              isDecompileVisible={isDecompileVisible}
              onToggleDecompile={handleDecompileToggle}
              hasDecompileResult={!!ghidraDecompileResult}
              onDecompileRequest={handleDecompileRequest}
              onDecompileError={setGhidraError}
              onAssemblyAddressClicked={handleAssemblyToDecompileSync}
              highlightAddress={highlightAssemblyAddress}
              onHighlightComplete={() => setHighlightAssemblyAddress(null)}
            />
          </Box>

          {/* Horizontal Resizer between Assembly and Decompile */}
          {isDecompileVisible && (
            <Resizer
              orientation="vertical"
              onMouseDown={assemblyDecompileSplit.handleMouseDown}
              isResizing={assemblyDecompileSplit.isResizing}
            />
          )}

          {/* Decompile View - Right Side */}
          {isDecompileVisible && (
            <Box
              sx={{
                width: `${100 - assemblyDecompileSplit.size}%`,
                minWidth: 0,
                overflow: "hidden",
                border: "1px solid #3c3c3c",
                borderRadius: "2px",
              }}
            >
              <DecompileView
                isVisible={isDecompileVisible}
                onToggleVisibility={handleDecompileToggle}
                currentBreakAddress={currentBreakAddress}
                isInBreakState={isInBreakState}
                onLineClick={handleDecompileLineClick}
                onAIEnhance={handleAIEnhance}
                functionName={ghidraDecompileResult?.functionName || undefined}
                functionAddress={ghidraDecompileResult?.address}
                libraryName={
                  ghidraDecompileResult?.libraryPath
                    ? ghidraDecompileResult.libraryPath.split(/[/\\]/).pop()
                    : undefined
                }
                ghidraCode={ghidraDecompileResult?.code}
                isGhidraLoading={isGhidraLoading}
                ghidraError={ghidraError}
                onAddressClick={handleDecompileAddressClick}
                onFunctionClick={handleDecompileFunctionClick}
                scrollToLineNumber={decompileScrollToLine}
                lineMapping={ghidraDecompileResult?.lineMapping}
                moduleBase={ghidraDecompileResult?.moduleBase}
                tokens={ghidraDecompileResult?.tokens}
                activeBreakpoints={activeBreakpoints}
                onBreakpointSet={handleBreakpointSet}
                onBreakpointRemove={handleBreakpointRemove}
              />
            </Box>
          )}
        </Box>

        {/* Vertical Resizer */}
        <Resizer
          orientation="horizontal"
          onMouseDown={assemblyMemorySplit.handleMouseDown}
          isResizing={assemblyMemorySplit.isResizing}
        />

        {/* Memory View - Bottom Half */}
        <Box
          sx={{
            height: `${100 - assemblyMemorySplit.size}%`,
            minHeight: 0, // Allow flex child to shrink below content size
            overflow: "hidden",
          }}
        >
          <MemoryView
            serverInfo={serverInfo}
            onAddressChange={handleMemoryAddressChange}
            registerData={registerData}
            isInBreakState={isInBreakState}
            currentThreadId={currentThreadId}
            attachedModules={attachedModules}
            resolveFunctionName={resolveFunctionName}
          />
        </Box>
      </Box>

      {/* Breakpoint hit notification */}
      <Snackbar
        open={breakpointNotification.open}
        autoHideDuration={4000}
        onClose={handleNotificationClose}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          onClose={handleNotificationClose}
          severity="info"
          variant="filled"
          sx={{ width: "100%" }}
        >
          {breakpointNotification.message}
          {exceptions.length > 0 && (
            <Box component="span" sx={{ ml: 1, fontSize: "0.85em" }}>
              (Total: {exceptions.length} hits)
            </Box>
          )}
        </Alert>
      </Snackbar>
    </MainContent>
  );
};
