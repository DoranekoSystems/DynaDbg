import { useState, useCallback } from "react";

export interface DebuggerContentState {
  assemblyAddress: string;
  breakpointNotification: {
    open: boolean;
    message: string;
  };
  gotoAddress: string;
  breakpointInputValue: string;
  activeBreakpoints: string[];
  memoryAddress: string; // Add memory address state
}

export const useDebuggerContentState = () => {
  // Assembly view address state
  const [assemblyAddress, setAssemblyAddress] = useState("0x0");

  // Notification state for breakpoint hits
  const [breakpointNotification, setBreakpointNotification] = useState<{
    open: boolean;
    message: string;
  }>({ open: false, message: "" });

  // Goto address state
  const [gotoAddress, setGotoAddress] = useState("");

  // Breakpoint input value state
  const [breakpointInputValue, setBreakpointInputValue] = useState<string>("");

  // Active breakpoints state
  const [activeBreakpoints, setActiveBreakpoints] = useState<string[]>([]);

  // Memory address state
  const [memoryAddress, setMemoryAddress] = useState("0x0");

  const updateAssemblyAddress = useCallback((address: string) => {
    setAssemblyAddress(address);
  }, []);

  const showBreakpointNotification = useCallback((message: string) => {
    setBreakpointNotification({ open: true, message });
  }, []);

  const hideBreakpointNotification = useCallback(() => {
    setBreakpointNotification((prev) => ({ ...prev, open: false }));
  }, []);

  const updateGotoAddress = useCallback((address: string) => {
    setGotoAddress(address);
  }, []);

  const updateBreakpointInputValue = useCallback((value: string) => {
    setBreakpointInputValue(value);
  }, []);

  const addActiveBreakpoint = useCallback((address: string) => {
    setActiveBreakpoints((prev) => {
      if (!prev.includes(address)) {
        return [...prev, address];
      }
      return prev;
    });
  }, []);

  const removeActiveBreakpoint = useCallback((address: string) => {
    setActiveBreakpoints((prev) => prev.filter((bp) => bp !== address));
  }, []);

  const clearActiveBreakpoints = useCallback(() => {
    setActiveBreakpoints([]);
  }, []);

  const updateMemoryAddress = useCallback((address: string) => {
    setMemoryAddress(address);
  }, []);

  return {
    // State
    assemblyAddress,
    breakpointNotification,
    gotoAddress,
    breakpointInputValue,
    activeBreakpoints,
    memoryAddress,

    // Actions
    updateAssemblyAddress,
    showBreakpointNotification,
    hideBreakpointNotification,
    updateGotoAddress,
    updateBreakpointInputValue,
    addActiveBreakpoint,
    removeActiveBreakpoint,
    clearActiveBreakpoints,
    updateMemoryAddress,
    setAssemblyAddress,
    setBreakpointNotification,
    setMemoryAddress,
  };
};
