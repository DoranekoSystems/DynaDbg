import { useState, useCallback, useEffect } from "react";
import {
  ScanHistoryItem,
  ScanSettings,
  ScanValueType,
  ScanType,
} from "../types/index";

const SCAN_HISTORY_KEY = "scanner-history";
const MAX_HISTORY_ITEMS = 10;

export const useScanHistory = () => {
  // Initialize history from localStorage
  const [history, setHistory] = useState<ScanHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem(SCAN_HISTORY_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch (error) {
      console.error("Failed to load scan history from localStorage:", error);
      return [];
    }
  });

  // Save history to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(SCAN_HISTORY_KEY, JSON.stringify(history));
    } catch (error) {
      console.error("Failed to save scan history to localStorage:", error);
    }
  }, [history]);

  // Add a new scan to history
  const addToHistory = useCallback((scanSettings: ScanSettings) => {
    // Only add to history if it's a first scan with a value
    const needsValue = ["exact", "bigger", "smaller", "range"].includes(
      scanSettings.scanType
    );
    if (!needsValue || !scanSettings.value.trim()) {
      return;
    }

    const description = generateDescription(scanSettings);

    const newItem: ScanHistoryItem = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      valueType: scanSettings.valueType,
      scanType: scanSettings.scanType,
      value: scanSettings.value,
      description,
      timestamp: new Date(),
      scanSettings: {
        startAddress: scanSettings.startAddress,
        endAddress: scanSettings.endAddress,
        scanMode: scanSettings.scanMode,
        selectedRegions: scanSettings.selectedRegions,
        alignment: scanSettings.alignment,
        writable: scanSettings.writable,
        executable: scanSettings.executable,
        readable: scanSettings.readable,
        doSuspend: scanSettings.doSuspend,
      },
    };

    setHistory((prev) => {
      // Check if this exact search already exists
      const existingIndex = prev.findIndex(
        (item) =>
          item.valueType === newItem.valueType &&
          item.scanType === newItem.scanType &&
          item.value === newItem.value
      );

      let newHistory;
      if (existingIndex !== -1) {
        // If exists, remove it and add to front (move to top)
        newHistory = [
          newItem,
          ...prev.filter((_, index) => index !== existingIndex),
        ];
      } else {
        // If new, add to front
        newHistory = [newItem, ...prev];
      }

      // Keep only the latest MAX_HISTORY_ITEMS
      return newHistory.slice(0, MAX_HISTORY_ITEMS);
    });
  }, []);

  // Generate description from scan settings
  const generateDescription = (scanSettings: ScanSettings): string => {
    const typeDisplayName = getValueTypeDisplayName(scanSettings.valueType);
    const scanTypeDisplayName = getScanTypeDisplayName(scanSettings.scanType);

    let baseDesc = `${typeDisplayName} - ${scanTypeDisplayName}`;

    if (scanSettings.value.trim()) {
      // Truncate long values
      const displayValue =
        scanSettings.value.length > 20
          ? `${scanSettings.value.substring(0, 20)}...`
          : scanSettings.value;
      baseDesc += `: ${displayValue}`;
    }

    return baseDesc;
  };

  // Get display name for value type
  const getValueTypeDisplayName = (valueType: ScanValueType): string => {
    const displayNames: Record<ScanValueType, string> = {
      int8: "Int8",
      uint8: "UInt8",
      int16: "Int16",
      uint16: "UInt16",
      int32: "Int32",
      uint32: "UInt32",
      int64: "Int64",
      uint64: "UInt64",
      float: "Float",
      double: "Double",
      string: "String",
      bytes: "Bytes",
      regex: "Regex",
    };
    return displayNames[valueType] || valueType;
  };

  // Get display name for scan type
  const getScanTypeDisplayName = (scanType: ScanType): string => {
    const displayNames: Record<ScanType, string> = {
      exact: "Exact Value",
      bigger: "Bigger than",
      smaller: "Smaller than",
      range: "Value between",
      changed: "Changed value",
      unchanged: "Unchanged value",
      increased: "Increased value",
      decreased: "Decreased value",
      unknown: "Unknown value",
      greater_or_equal: "Greater or equal",
      less_than: "Less than",
    };
    return displayNames[scanType] || scanType;
  };

  // Clear all history
  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  // Remove specific history item
  const removeHistoryItem = useCallback((id: string) => {
    setHistory((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // Get history item by id
  const getHistoryItem = useCallback(
    (id: string) => {
      return history.find((item) => item.id === id);
    },
    [history]
  );

  return {
    history,
    addToHistory,
    clearHistory,
    removeHistoryItem,
    getHistoryItem,
  };
};
