import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ScanResult,
  ScanSettings,
  ScanValueType,
  ScanType,
  ScannerState,
  FilterRequest,
  BookmarkItem,
  ScanHistoryItem,
} from "../types/index";
import { getApiClient } from "../lib/api";
import { useAppState } from "./useAppState";
import { normalizeAddressString } from "../utils/addressEncoder";

export interface MemoryRegion {
  start_address: string;
  end_address: string;
  size: number;
  protection: string;
  module_name?: string;
  selected?: boolean;
}

interface MemoryScanRequest {
  pattern: string;
  pattern_max?: string; // For range search: pattern is min, pattern_max is max
  address_ranges: [number, number][];
  find_type: string;
  data_type: string;
  scan_id: string;
  align: number;
  return_as_json: boolean;
  do_suspend: boolean;
}

const defaultScanSettings: ScanSettings = {
  valueType: "int32",
  scanType: "exact",
  value: "",
  valueMax: "", // For range search
  startAddress: "0x0",
  endAddress: "0x7FFFFFFFFFFF",
  scanMode: "manual",
  selectedRegions: [],
  alignment: 4,
  writable: true,
  executable: false,
  readable: true,
  doSuspend: false,
  searchMode: "normal",
  yaraRule: "",
};

// Generate unique scan ID
const generateScanId = () =>
  `scan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Map frontend types to backend types
const mapToBackendDataType = (valueType: ScanValueType): string => {
  const mapping: Record<ScanValueType, string> = {
    int8: "int8",
    uint8: "uint8",
    int16: "int16",
    uint16: "uint16",
    int32: "int32",
    uint32: "uint32",
    int64: "int64",
    uint64: "uint64",
    float: "float",
    double: "double",
    string: "string",
    bytes: "bytes",
    regex: "regex",
    ptr: "ptr",
  };
  return mapping[valueType] || "int32";
};

const mapToBackendFindType = (scanType: ScanType): string => {
  const mapping: Record<string, string> = {
    exact: "exact",
    bigger: "bigger",
    smaller: "smaller",
    range: "range",
    greater_or_equal: "greater_or_equal",
    less_than: "less_than",
    unknown: "unknown",
    changed: "changed",
    unchanged: "unchanged",
    increased: "increased",
    decreased: "decreased",
  };
  return mapping[scanType] || "exact";
};

// Convert hex bytes to human-readable value based on data type
const convertHexBytesToValue = (
  hexValue: string,
  valueType: ScanValueType,
  maxLength?: number // For any type, limit to search pattern length
): string => {
  try {
    // Remove any whitespace and ensure it's a clean hex string
    let cleanHex = hexValue.replace(/\s/g, "");

    // If maxLength is specified, limit the hex string length
    if (maxLength) {
      const maxHexChars = maxLength * 2; // Each byte = 2 hex chars
      cleanHex = cleanHex.substring(0, maxHexChars);
    }

    // Convert hex string to bytes
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
    }

    // Create DataView for proper endianness handling
    const buffer = new ArrayBuffer(bytes.length);
    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);
    uint8View.set(bytes);

    switch (valueType) {
      case "int8": {
        if (bytes.length >= 1) {
          return view.getInt8(0).toString();
        }
        break;
      }
      case "uint8": {
        if (bytes.length >= 1) {
          return view.getUint8(0).toString();
        }
        break;
      }
      case "int16": {
        if (bytes.length >= 2) {
          return view.getInt16(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "uint16": {
        if (bytes.length >= 2) {
          return view.getUint16(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "int32": {
        if (bytes.length >= 4) {
          return view.getInt32(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "uint32": {
        if (bytes.length >= 4) {
          return view.getUint32(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "int64": {
        if (bytes.length >= 8) {
          return view.getBigInt64(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "uint64": {
        if (bytes.length >= 8) {
          return view.getBigUint64(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "float": {
        if (bytes.length >= 4) {
          return view.getFloat32(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "double": {
        if (bytes.length >= 8) {
          return view.getFloat64(0, true).toString(); // true = little-endian
        }
        break;
      }
      case "string": {
        // Convert hex bytes back to UTF-8 string
        try {
          const decoder = new TextDecoder("utf-8");
          return decoder.decode(uint8View);
        } catch (error) {
          return `0x${cleanHex.toUpperCase()}`;
        }
      }
      case "regex": {
        // For regex, display the matched bytes as UTF-8 string
        try {
          const decoder = new TextDecoder("utf-8", { fatal: false });
          return decoder.decode(uint8View);
        } catch (error) {
          // Fallback to hex display if decoding fails
          const hexPairs = cleanHex.match(/.{1,2}/g) || [];
          return hexPairs.map((pair) => pair.toUpperCase()).join(" ");
        }
      }
      case "bytes":
      default:
        // For bytes, return as space-separated hex bytes for better readability
        const hexPairs = cleanHex.match(/.{1,2}/g) || [];
        return hexPairs.map((pair) => pair.toUpperCase()).join(" ");
    }

    // Fallback: return as hex string
    return `0x${cleanHex.toUpperCase()}`;
  } catch (error) {
    console.error("Failed to convert hex bytes to value:", error);
    return hexValue; // Return original on error
  }
};

const convertValueToHexBytes = (
  value: string,
  valueType: ScanValueType,
  inputFormat: "dec" | "hex" = "dec"
): string => {
  const buffer = new ArrayBuffer(16); // Max size for any type
  const view = new DataView(buffer);

  // Helper function to parse integer value based on input format
  const parseIntValue = (val: string): number => {
    const trimmed = val.trim();
    if (inputFormat === "hex") {
      // Parse as hex, remove 0x prefix if present
      return parseInt(trimmed.replace(/^0x/i, ""), 16);
    }
    return parseInt(trimmed, 10);
  };

  // Helper function to parse BigInt value based on input format
  const parseBigIntValue = (val: string): bigint => {
    const trimmed = val.trim();
    if (inputFormat === "hex") {
      // Parse as hex, remove 0x prefix if present
      const hexStr = trimmed.replace(/^0x/i, "");
      return BigInt("0x" + hexStr);
    }
    return BigInt(trimmed);
  };

  try {
    switch (valueType) {
      case "int8": {
        const val = parseIntValue(value);
        view.setInt8(0, val);
        return Array.from(new Uint8Array(buffer, 0, 1))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "uint8": {
        const val = parseIntValue(value);
        view.setUint8(0, val);
        return Array.from(new Uint8Array(buffer, 0, 1))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "int16": {
        const val = parseIntValue(value);
        view.setInt16(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 2))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "uint16": {
        const val = parseIntValue(value);
        view.setUint16(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 2))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "int32": {
        const val = parseIntValue(value);
        view.setInt32(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "uint32": {
        const val = parseIntValue(value);
        view.setUint32(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "int64": {
        const val = parseBigIntValue(value);
        view.setBigInt64(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 8))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "uint64": {
        const val = parseBigIntValue(value);
        view.setBigUint64(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 8))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "float": {
        const val = parseFloat(value);
        view.setFloat32(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "double": {
        const val = parseFloat(value);
        view.setFloat64(0, val, true); // true = little-endian
        return Array.from(new Uint8Array(buffer, 0, 8))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "string": {
        // Convert string to UTF-8 bytes
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(value);
        return Array.from(utf8Bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      case "regex": {
        // For regex, return the pattern as-is (backend handles regex directly)
        return value;
      }
      case "bytes":
      default:
        // For bytes, handle space-separated hex bytes like "f2 f2" or "FF 00 12 34"
        // Also handle continuous hex like "f2f2" or with 0x prefix
        let cleanValue = value.replace(/^0x/i, "").trim();

        // If contains spaces, treat as space-separated bytes
        if (cleanValue.includes(" ")) {
          // Split by whitespace and filter out empty strings
          const byteStrings = cleanValue
            .split(/\s+/)
            .filter((s) => s.length > 0);
          const validBytes: string[] = [];

          for (const byteStr of byteStrings) {
            if (byteStr === "??" || byteStr === "??") {
              // Wildcard byte - for now, treat as 00 (this should be handled by server)
              validBytes.push("00");
            } else if (/^[0-9a-fA-F]{1,2}$/.test(byteStr)) {
              // Valid hex byte (1 or 2 digits)
              validBytes.push(byteStr.padStart(2, "0").toLowerCase());
            }
          }
          return validBytes.join("");
        } else {
          // Continuous hex string - just clean and validate
          cleanValue = cleanValue.replace(/[^0-9a-fA-F]/g, "");
          return cleanValue.toLowerCase();
        }
    }
  } catch (error) {
    console.error("Failed to convert value to hex bytes:", error);
    // Fallback: treat as hex string
    return value.replace(/^0x/, "").replace(/\s/g, "");
  }
};

export const useScannerState = () => {
  // Use new app state system
  const { ui, uiActions } = useAppState();

  // Get values from global state
  const scanResults = ui.scannerState.scanResults;
  const scanHistory = ui.scanHistory;
  const bookmarks = ui.bookmarks;

  // Local state for scanner-specific functionality
  const [scannerState, setScannerState] = useState<ScannerState>({
    isScanning: false,
    scanResults: [],
    scanHistory: [],
    currentScanIndex: -1,
    totalResults: 0,
    scanSettings: defaultScanSettings,
    scanId: generateScanId(),
    scanProgress: 0,
    scannedBytes: 0,
    totalBytes: 0,
    currentRegion: undefined,
    searchPatternLength: undefined,
    errorMessage: undefined,
  });

  const [memoryRegions] = useState<MemoryRegion[]>([]);
  const [memoryRegionsLoaded] = useState(true); // Always true for manual mode
  const [isSettingsLocked, setIsSettingsLocked] = useState(false); // Lock settings after first scan
  const progressIntervalRef = useRef<number | null>(null);

  const apiClient = getApiClient();

  // Sync scanner state with global UI state
  useEffect(() => {
    setScannerState((prev) => ({
      ...prev,
      scanResults: ui.scannerState.scanResults,
      totalResults: ui.scannerState.totalResults,
      isScanning: ui.scannerState.isScanning,
      scanProgress: ui.scannerState.scanProgress,
      scanSettings: {
        ...ui.scannerState.scanSettings,
        valueType: ui.scannerState.scanSettings.valueType as ScanValueType,
        scanType: ui.scannerState.scanSettings.scanType as ScanType,
        scanMode: ui.scannerState.scanSettings.scanMode as "manual" | "regions",
        searchMode: (ui.scannerState.scanSettings as any).searchMode || "normal",
        yaraRule: (ui.scannerState.scanSettings as any).yaraRule || "",
      },
    }));
  }, [ui.scannerState]);

  // Function to start filter progress polling
  const startFilterProgressPolling = useCallback(
    (filterId: string) => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }

      console.log(`Starting filter progress polling for filter: ${filterId}`);

      progressIntervalRef.current = setInterval(async () => {
        try {
          console.log(`Polling filter progress for filter: ${filterId}`);
          const response = await apiClient.getFilterProgress(filterId);
          console.log(`Filter progress response:`, response);

          if (response.success && response.data) {
            const progress = response.data;
            setScannerState((prev) => ({
              ...prev,
              scanProgress: progress.progress_percentage,
              scannedBytes: progress.processed_results,
              totalBytes: progress.total_results,
              currentRegion: progress.current_region,
              isScanning: progress.is_filtering,
            }));

            // Update global state
            uiActions.updateScannerState({
              scanProgress: progress.progress_percentage,
              isScanning: progress.is_filtering,
            });

            // If filter is complete, fetch results and stop polling
            if (!progress.is_filtering && progressIntervalRef.current) {
              console.log(
                `Filter completed, fetching results for scan: ${scannerState.scanId}`
              );
              clearInterval(progressIntervalRef.current);
              progressIntervalRef.current = null;

              try {
                // Fetch filter results using the original scan ID
                const resultsResponse = await apiClient.getFilterResults(
                  scannerState.scanId
                );
                console.log(`Filter results response:`, resultsResponse);

                if (resultsResponse.success && resultsResponse.data) {
                  const resultsData = resultsResponse.data;

                  // Get current state for pattern length
                  setScannerState((prev) => {
                    const results: ScanResult[] =
                      resultsData.matched_addresses.map(
                        (item: { address: number; value: string }) => {
                          return {
                            address: `0x${item.address.toString(16)}`,
                            value: convertHexBytesToValue(
                              item.value,
                              prev.scanSettings.valueType,
                              prev.searchPatternLength
                            ),
                            type: prev.scanSettings.valueType,
                            description: "Filter result",
                          };
                        }
                      );

                    // Update global state
                    uiActions.setScanResults(results);
                    uiActions.updateScannerState({
                      scanResults: results,
                      totalResults: resultsData.found,
                      scanProgress: 100,
                      isScanning: false,
                    });

                    const newHistory = [...prev.scanHistory, results];
                    return {
                      ...prev,
                      isScanning: false,
                      scanResults: results,
                      scanHistory: newHistory,
                      currentScanIndex: newHistory.length - 1,
                      totalResults: resultsData.found,
                      scanProgress: 100,
                    };
                  });
                }
              } catch (error) {
                console.error("Failed to fetch filter results:", error);
                setScannerState((prev) => ({
                  ...prev,
                  isScanning: false,
                  scanProgress: 100,
                }));
                uiActions.updateScannerState({ isScanning: false });
              }
            }
          }
        } catch (error) {
          console.error("Failed to get filter progress:", error);
        }
      }, 100); // Poll every 100ms
    },
    [apiClient, scannerState.scanId, uiActions]
  );

  // Function to perform unknown scan using server-side streaming API
  const performUnknownScanStreaming = useCallback(
    async (
      addressRanges: [number, number][],
      alignment: number,
      dataType: string,
      scanId: string,
      doSuspend: boolean
    ) => {
      console.log(`Starting server-side unknown scan streaming for: ${scanId}`);

      // Calculate data size from data type
      const dataSize = (() => {
        switch (dataType) {
          case "int8":
          case "uint8":
            return 1;
          case "int16":
          case "uint16":
            return 2;
          case "int32":
          case "uint32":
          case "float":
            return 4;
          case "int64":
          case "uint64":
          case "double":
            return 8;
          default:
            return 4;
        }
      })();

      // Initialize local file for storing chunks
      const filePath = await invoke<string>("init_unknown_scan_file", {
        scanId,
        alignment,
        dataSize,
      });
      console.log(`Created unknown scan file: ${filePath}`);

      // Start server-side scan
      const startResponse = await apiClient.unknownScanStart({
        address_ranges: addressRanges,
        alignment,
        data_type: dataType,
        scan_id: scanId,
        do_suspend: doSuspend,
      });

      if (!startResponse.success) {
        throw new Error(startResponse.error || "Failed to start unknown scan");
      }

      console.log(`Server unknown scan started:`, startResponse);

      // Update initial state
      setScannerState((prev) => ({
        ...prev,
        totalBytes: startResponse.total_bytes,
      }));

      // Stream chunks from server and save to local file
      let chunkCount = 0;
      let isComplete = false;

      while (!isComplete) {
        try {
          const streamResponse = await apiClient.unknownScanStream(scanId);

          // Process received chunks
          for (const chunk of streamResponse.chunks) {
            // compressed_data is already a number array from JSON serialization
            // Just convert to Uint8Array
            const bytes = new Uint8Array(chunk.compressed_data);

            // Append to local file
            await invoke("append_unknown_scan_chunk", {
              scanId,
              offset: chunk.start_address,
              compressedData: Array.from(bytes),
            });
            chunkCount++;
          }

          // Update progress
          setScannerState((prev) => ({
            ...prev,
            scanProgress:
              (streamResponse.processed_bytes / streamResponse.total_bytes) *
              100,
            scannedBytes: streamResponse.processed_bytes,
            totalBytes: streamResponse.total_bytes,
            isScanning: streamResponse.is_scanning,
          }));

          uiActions.updateScannerState({
            scanProgress:
              (streamResponse.processed_bytes / streamResponse.total_bytes) *
              100,
            isScanning: streamResponse.is_scanning,
          });

          // Check if complete
          isComplete =
            !streamResponse.is_scanning && streamResponse.chunks.length === 0;

          // Small delay to prevent tight loop when no chunks available
          if (
            streamResponse.chunks.length === 0 &&
            streamResponse.is_scanning
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          console.error("Error streaming unknown scan:", error);
          // Try to stop the scan gracefully
          try {
            await apiClient.unknownScanStop(scanId);
          } catch {}
          throw error;
        }
      }

      // Finalize the file
      await invoke("finalize_unknown_scan_file", { scanId, chunkCount });

      console.log(`Unknown scan completed: ${chunkCount} chunks saved`);

      // Get file info for display
      const fileInfo = await invoke<{
        path: string;
        size: number;
        chunk_count: number;
      }>("get_unknown_scan_file_info", { scanId });
      console.log(`Unknown scan file info:`, fileInfo);

      // Update state to show completion
      setScannerState((prev) => ({
        ...prev,
        isScanning: false,
        scanProgress: 100,
        unknownScanId: scanId,
        // Store total result count approximation (actual counting would need decompression)
        totalResults: chunkCount > 0 ? -1 : 0, // -1 indicates unknown but has data
      }));

      uiActions.updateScannerState({
        isScanning: false,
        scanProgress: 100,
      });

      // Lock settings after scan
      setIsSettingsLocked(true);

      return chunkCount;
    },
    [apiClient, uiActions]
  );

  // Function to start unknown scan progress polling
  const startUnknownScanProgressPolling = useCallback(
    (
      scanId: string,
      onComplete: (scanId: string, totalAddresses: number) => void
    ) => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }

      console.log(`Starting unknown scan progress polling for: ${scanId}`);

      progressIntervalRef.current = setInterval(async () => {
        try {
          const progress = await apiClient.getUnknownScanProgress(scanId);
          console.log(`Unknown scan progress:`, progress);

          setScannerState((prev) => ({
            ...prev,
            scanProgress: progress.progress_percentage,
            scannedBytes: progress.processed_bytes,
            totalBytes: progress.total_bytes,
            currentRegion: progress.current_region || undefined,
            isScanning: progress.is_scanning,
          }));

          // Update global state
          uiActions.updateScannerState({
            scanProgress: progress.progress_percentage,
            isScanning: progress.is_scanning,
          });

          // If scan is complete, stop polling and load results
          if (!progress.is_scanning && progressIntervalRef.current) {
            console.log(
              `Unknown scan completed: ${progress.found_count} addresses found`
            );
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;

            onComplete(scanId, progress.found_count);
          }
        } catch (error) {
          console.error("Failed to get unknown scan progress:", error);
        }
      }, 100); // Poll every 100ms
    },
    [apiClient, uiActions]
  );

  // Function to start progress polling
  const startProgressPolling = useCallback(
    (scanId: string) => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }

      console.log(`Starting progress polling for scan: ${scanId}`);

      progressIntervalRef.current = setInterval(async () => {
        try {
          console.log(`Polling progress for scan: ${scanId}`);
          const response = await apiClient.getScanProgress(scanId);
          console.log(`Progress response:`, response);

          if (response.success && response.data) {
            const progress = response.data;
            setScannerState((prev) => ({
              ...prev,
              scanProgress: progress.progress_percentage,
              scannedBytes: progress.scanned_bytes,
              totalBytes: progress.total_bytes,
              currentRegion: progress.current_region,
              isScanning: progress.is_scanning,
            }));

            // Update global state
            uiActions.updateScannerState({
              scanProgress: progress.progress_percentage,
              isScanning: progress.is_scanning,
            });

            // If scan is complete, fetch results and stop polling
            if (!progress.is_scanning && progressIntervalRef.current) {
              console.log(`Scan completed, fetching results for: ${scanId}`);
              clearInterval(progressIntervalRef.current);
              progressIntervalRef.current = null;

              try {
                // Fetch scan results
                const resultsResponse = await apiClient.getScanResults(scanId);
                console.log(`Scan results response:`, resultsResponse);

                if (resultsResponse.success && resultsResponse.data) {
                  const resultsData = resultsResponse.data;
                  console.log(`Scan results data:`, {
                    found: resultsData.found,
                    matchedAddressesLength: resultsData.matched_addresses?.length,
                    matchedAddresses: resultsData.matched_addresses?.slice(0, 5), // First 5 for debug
                  });

                  // Get current state for pattern length
                  setScannerState((prev) => {
                    const isYaraMode = (prev.scanSettings as any).searchMode === "yara";
                    
                    const results: ScanResult[] =
                      resultsData.matched_addresses.map(
                        (item: { address: number; value: string }) => {
                          if (isYaraMode) {
                            // YARA results: value format is "rule::pattern|hex_data"
                            let displayValue = item.value;
                            let description = "YARA match";
                            
                            try {
                              // Parse the new format: rule::pattern|hex_data
                              const pipeIdx = item.value.indexOf('|');
                              if (pipeIdx > 0) {
                                // Extract rule info (before |)
                                description = item.value.slice(0, pipeIdx);
                                
                                // Extract matched data hex (after |)
                                const hexData = item.value.slice(pipeIdx + 1);
                                const bytes = hexData.match(/.{1,2}/g) || [];
                                const chars = bytes.map(b => parseInt(b, 16));
                                
                                // Check if printable ASCII
                                const isPrintable = chars.every(c => c >= 32 && c < 127);
                                if (isPrintable && chars.length > 0) {
                                  displayValue = chars.map(c => String.fromCharCode(c)).join('');
                                } else {
                                  // Keep as hex with spaces
                                  displayValue = chars.map(c => c.toString(16).padStart(2, '0')).join(' ');
                                }
                              }
                            } catch {
                              // Keep original value if parsing fails
                            }
                            
                            return {
                              address: `0x${item.address.toString(16)}`,
                              value: displayValue,
                              type: "string" as ScanValueType,
                              description,
                            };
                          } else {
                            return {
                              address: `0x${item.address.toString(16)}`,
                              value: convertHexBytesToValue(
                                item.value,
                                prev.scanSettings.valueType,
                                prev.searchPatternLength
                              ),
                              type: prev.scanSettings.valueType,
                              description: "Scan result",
                            };
                          }
                        }
                      );
                    
                    console.log(`Processed scan results:`, {
                      resultsLength: results.length,
                      firstFive: results.slice(0, 5),
                    });

                    // Update global state
                    uiActions.setScanResults(results);
                    uiActions.updateScannerState({
                      scanResults: results,
                      totalResults: resultsData.found,
                      scanProgress: 100,
                      isScanning: false,
                    });

                    const newHistory =
                      prev.currentScanIndex === -1
                        ? [results]
                        : [...prev.scanHistory, results];
                    return {
                      ...prev,
                      isScanning: false,
                      scanResults: results,
                      scanHistory: newHistory,
                      currentScanIndex: newHistory.length - 1,
                      totalResults: resultsData.found,
                      scanProgress: 100,
                    };
                  });

                  // Lock settings after first successful scan
                  setIsSettingsLocked(true);
                }
              } catch (error) {
                console.error("Failed to fetch scan results:", error);
                setScannerState((prev) => ({
                  ...prev,
                  isScanning: false,
                  scanProgress: 100,
                }));
                uiActions.updateScannerState({ isScanning: false });
              }
            }
          }
        } catch (error) {
          console.error("Failed to get scan progress:", error);
        }
      }, 100); // Poll every 100ms
    },
    [apiClient, uiActions]
  );

  // Function to stop progress polling
  const stopProgressPolling = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, []);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      stopProgressPolling();
    };
  }, [stopProgressPolling]);

  const updateScanSettings = useCallback(
    (settings: ScanSettings) => {
      // Update both local state and global store
      setScannerState((prev) => ({
        ...prev,
        scanSettings: settings,
      }));
      uiActions.setScanSettings(settings);
      return true;
    },
    [uiActions]
  );

  // Perform pointer scan using Tauri command
  const performPointerScan = useCallback(
    async (currentSettings: ScanSettings) => {
      console.log("Starting pointer scan...");

      setScannerState((prev) => ({
        ...prev,
        isScanning: true,
        scanProgress: 0,
      }));

      uiActions.updateScannerState({
        isScanning: true,
        scanProgress: 0,
      });

      try {
        const { invoke } = await import("@tauri-apps/api/core");

        // Prepare files with target addresses
        const files = (currentSettings.ptrMapFilePaths || []).map(
          (f: { path: string; name: string; targetAddress?: string }) => ({
            path: f.path,
            targetAddress: f.targetAddress || "",
          })
        );

        if (files.length < 2) {
          throw new Error("At least 2 PointerMap files are required");
        }

        // Check all files have target addresses
        for (const file of files) {
          if (!file.targetAddress) {
            throw new Error(
              "All PointerMap files must have a target address set"
            );
          }
        }

        // Update progress: Loading files
        uiActions.updateScannerState({ 
          scanProgress: 10,
          currentRegion: "Loading PointerMap files..."
        });

        console.log("Calling run_pointer_scan with:", {
          files,
          maxDepth: currentSettings.ptrMaxDepth || 5,
          maxOffset: currentSettings.ptrMaxOffset || 4096,
        });

        // Set up event listener for PTR scan progress
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<{
          nodesProcessed: number;
          chainsFound: number;
          fileIndex: number;
          totalFiles: number;
          phase?: string;
        }>("ptr-scan-progress", (event) => {
          const { nodesProcessed, chainsFound, fileIndex, totalFiles, phase } = event.payload;
          
          let progressText: string;
          let progressPercent: number;
          
          switch (phase) {
            case "loading":
              progressText = `Loading file ${fileIndex + 1}/${totalFiles}...`;
              progressPercent = 10 + Math.floor((fileIndex / totalFiles) * 10);
              break;
            case "decompressing":
              progressText = "Decompressing files...";
              progressPercent = 25;
              break;
            case "scanning":
              progressText = `File ${fileIndex + 1}/${totalFiles}: Nodes: ${nodesProcessed.toLocaleString()} / Chains: ${chainsFound.toLocaleString()}`;
              progressPercent = 30 + Math.floor((fileIndex / totalFiles) * 50);
              break;
            case "complete":
              progressText = `Completed: ${chainsFound.toLocaleString()} chains found`;
              progressPercent = 80;
              break;
            default:
              progressText = `File ${fileIndex + 1}/${totalFiles}: Nodes: ${nodesProcessed.toLocaleString()} / Chains: ${chainsFound.toLocaleString()}`;
              progressPercent = 30 + Math.floor((fileIndex / totalFiles) * 50);
          }
          
          uiActions.updateScannerState({
            scanProgress: progressPercent,
            currentRegion: progressText
          });
        });

        // Update progress: Scanning
        uiActions.updateScannerState({ 
          scanProgress: 30,
          currentRegion: "Scanning for pointer chains..."
        });

        const results = await invoke<
          Array<{
            chain: Array<{ module?: string; offset: number }>;
            finalAddress: string;
          }>
        >("run_pointer_scan", {
          files,
          maxDepth: currentSettings.ptrMaxDepth || 5,
          maxOffset: currentSettings.ptrMaxOffset || 4096,
        });

        // Stop listening for progress events
        unlisten();

        // Update progress: Processing results
        uiActions.updateScannerState({ 
          scanProgress: 80,
          currentRegion: "Processing results..."
        });

        console.log(`Pointer scan found ${results.length} results`);

        // Convert pointer scan results to scan results format
        // Format: baseaddress | offset0 | offset1 | ...
        const scanResults: ScanResult[] = results.map((result, index) => {
          // Build chain parts: first is base (module+offset), rest are offsets
          const chainParts: string[] = [];
          
          // Helper to extract filename from path
          const getFileName = (path: string): string => {
            const parts = path.split(/[\\/]/);
            return parts[parts.length - 1] || path;
          };
          
          for (let i = 0; i < result.chain.length; i++) {
            const step = result.chain[i];
            if (i === 0 && step.module) {
              // Base address: module filename + offset (lowercase hex)
              const moduleName = getFileName(step.module);
              chainParts.push(`${moduleName}+0x${step.offset.toString(16)}`);
            } else {
              // Offset (lowercase hex)
              const offsetStr = step.offset >= 0
                ? `0x${step.offset.toString(16)}`
                : `-0x${Math.abs(step.offset).toString(16)}`;
              chainParts.push(offsetStr);
            }
          }
          
          const chainStr = chainParts.join(" | ");

          return {
            address: result.finalAddress,
            value: chainStr,
            previousValue: "",
            moduleName: result.chain[0]?.module || "",
            type: "ptr" as ScanValueType,
            index: index,
          };
        });

        // Update state with results
        setScannerState((prev) => ({
          ...prev,
          scanResults,
          totalResults: scanResults.length,
          isScanning: false,
          scanProgress: 100,
        }));

        uiActions.updateScannerState({
          isScanning: false,
          scanProgress: 100,
          scanResults,
          totalResults: scanResults.length,
        });

        console.log("Pointer scan complete");
      } catch (error) {
        console.error("Pointer scan failed:", error);
        setScannerState((prev) => ({
          ...prev,
          isScanning: false,
          scanProgress: 0,
        }));
        uiActions.updateScannerState({
          isScanning: false,
          scanProgress: 0,
        });
      }
    },
    [uiActions]
  );

  const performFirstScan = useCallback(async () => {
    const currentScanId = scannerState.scanId;
    console.log(`Starting first scan with ID: ${currentScanId}`);

    // Get current settings from global store to ensure we have the latest
    const currentSettings = ui.scannerState.scanSettings as ScanSettings;

    // Handle PTR mode (pointer scan)
    if (currentSettings.searchMode === "ptr") {
      await performPointerScan(currentSettings);
      return;
    }

    setScannerState((prev) => ({
      ...prev,
      isScanning: true,
      scanProgress: 0,
      scannedBytes: 0,
      totalBytes: 0,
      currentRegion: undefined,
    }));

    // Update global state
    uiActions.updateScannerState({
      isScanning: true,
      scanProgress: 0,
    });

    try {
      // Convert frontend types to backend types using current settings
      const backendDataType = mapToBackendDataType(
        currentSettings.valueType as ScanValueType
      );
      const backendFindType = mapToBackendFindType(
        currentSettings.scanType as ScanType
      );

      // Get valid memory regions within the specified range
      const startAddr = parseInt(currentSettings.startAddress || "0x0", 16);
      const endAddr = parseInt(
        currentSettings.endAddress || "0x7FFFFFFFFFFF",
        16
      );

      console.log(
        `Getting memory regions in range: 0x${startAddr.toString(16)} - 0x${endAddr.toString(16)}`
      );

      // Get all memory regions
      const memoryMapResponse = await apiClient.enumerateRegions();

      // Filter regions based on address range and permissions
      const validRegions = memoryMapResponse.regions.filter(
        (region: MemoryRegion) => {
          const regionStart = parseInt(region.start_address, 16);
          const regionEnd = parseInt(region.end_address, 16);

          // Check if region overlaps with our target range
          const overlaps = regionStart < endAddr && regionEnd > startAddr;
          if (!overlaps) return false;

          // Check permissions based on protection string (e.g., "rwx", "r--", "rw-")
          const protection = region.protection.toLowerCase();

          if (currentSettings.readable && !protection.includes("r"))
            return false;
          if (currentSettings.writable && !protection.includes("w"))
            return false;
          if (currentSettings.executable && !protection.includes("x"))
            return false;

          return true;
        }
      );

      // Convert valid regions to address ranges
      const addressRanges: [number, number][] = validRegions.map(
        (region: MemoryRegion) => {
          const regionStart = parseInt(region.start_address, 16);
          const regionEnd = parseInt(region.end_address, 16);

          // Clamp to our target range
          const clampedStart = Math.max(regionStart, startAddr);
          const clampedEnd = Math.min(regionEnd, endAddr);

          return [clampedStart, clampedEnd];
        }
      );

      console.log(
        `Found ${validRegions.length} valid memory regions:`,
        addressRanges
          .map(
            ([start, end]) => `0x${start.toString(16)}-0x${end.toString(16)}`
          )
          .join(", ")
      );

      if (addressRanges.length === 0) {
        throw new Error(
          "No valid memory regions found in the specified range with the selected permissions"
        );
      }

      // YARA scan mode - use YARA API with progress polling
      if ((currentSettings as any).searchMode === "yara") {
        const yaraRule = (currentSettings as any).yaraRule || "";
        if (!yaraRule.trim()) {
          throw new Error("YARA rule is required for YARA scan mode");
        }

        console.log(`Starting YARA scan with rule:`, yaraRule);

        const yaraRequest = {
          rule: yaraRule,
          address_ranges: addressRanges,
          scan_id: currentScanId,
          align: currentSettings.alignment,
          do_suspend: currentSettings.doSuspend,
        };

        const yaraResponse = await apiClient.yaraScan(yaraRequest);
        console.log(`YARA scan response:`, yaraResponse);

        if (!yaraResponse.success) {
          throw new Error(yaraResponse.message || "YARA scan failed");
        }

        // Start progress polling - YARA scan runs in background like normal scan
        startProgressPolling(currentScanId);
        return; // Exit early - results will be fetched via progress polling
      }

      // Convert the search value to hex bytes based on data type
      const pattern = convertValueToHexBytes(
        currentSettings.value,
        currentSettings.valueType as ScanValueType,
        currentSettings.valueInputFormat || "dec"
      );

      // For range search, also convert the max value
      const patternMax =
        currentSettings.scanType === "range" &&
        (currentSettings as ScanSettings).valueMax
          ? convertValueToHexBytes(
              (currentSettings as ScanSettings).valueMax!,
              currentSettings.valueType as ScanValueType,
              currentSettings.valueInputFormat || "dec"
            )
          : undefined;

      // Calculate the pattern length for proper result display based on data type
      const patternLength = (() => {
        switch (currentSettings.valueType as ScanValueType) {
          case "int8":
          case "uint8":
            return 1;
          case "int16":
          case "uint16":
            return 2;
          case "int32":
          case "uint32":
          case "float":
            return 4;
          case "int64":
          case "uint64":
          case "double":
            return 8;
          case "bytes":
            return pattern.length / 2; // Each pair of hex chars = 1 byte
          case "string":
            return pattern.length / 2; // String length in bytes
          default:
            return undefined;
        }
      })();

      console.log(`Pattern length calculation:`, {
        valueType: currentSettings.valueType,
        pattern,
        patternLength,
        searchValue: currentSettings.value,
      });

      console.log(
        `Converting search value "${currentSettings.value}" (${currentSettings.valueType}) to hex pattern: ${pattern}`
      );

      // Store pattern length for result display
      setScannerState((prev) => ({
        ...prev,
        searchPatternLength: patternLength,
      }));

      // For unknown scan, use server-side streaming API
      if (currentSettings.scanType === "unknown") {
        try {
          await performUnknownScanStreaming(
            addressRanges,
            currentSettings.alignment,
            currentSettings.valueType as string,
            currentScanId,
            currentSettings.doSuspend
          );
          return; // Exit early for unknown scan
        } catch (error) {
          console.error("Unknown scan streaming failed:", error);
          throw error;
        }
      }

      // Build scan request - normal scan types
      const scanRequest: MemoryScanRequest = {
        pattern: pattern,
        ...(patternMax ? { pattern_max: patternMax } : {}),
        address_ranges: addressRanges,
        find_type: backendFindType,
        data_type: backendDataType,
        scan_id: currentScanId,
        align: currentSettings.alignment,
        return_as_json: false, // Don't return results immediately
        do_suspend: currentSettings.doSuspend,
      };

      console.log(`Sending scan request:`, scanRequest);

      // Start the scan (which now returns immediately)
      const response = await apiClient.memoryScan(scanRequest);
      console.log(`Scan started response:`, response);

      // Add to scan history after successful scan start
      const needsValue = ["exact", "bigger", "smaller", "range"].includes(
        currentSettings.scanType
      );
      if (needsValue && currentSettings.value.trim()) {
        // Generate a simple description without redundant type info
        const description = "";
        const newItem: ScanHistoryItem = {
          id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          valueType: currentSettings.valueType as ScanValueType,
          scanType: currentSettings.scanType as ScanType,
          value: currentSettings.value,
          description,
          timestamp: new Date(),
          scanSettings: {
            startAddress: currentSettings.startAddress,
            endAddress: currentSettings.endAddress,
            scanMode: currentSettings.scanMode as "manual" | "regions",
            selectedRegions: currentSettings.selectedRegions,
            alignment: currentSettings.alignment,
            writable: currentSettings.writable,
            executable: currentSettings.executable,
            readable: currentSettings.readable,
            doSuspend: currentSettings.doSuspend,
            searchMode: (currentSettings as any).searchMode || "normal",
            yaraRule: (currentSettings as any).yaraRule || "",
          },
        };
        uiActions.addScanHistory(newItem);
      }

      // Start progress polling to monitor the scan
      startProgressPolling(currentScanId);
    } catch (error) {
      console.error("Scan failed:", error);
      setScannerState((prev) => ({
        ...prev,
        isScanning: false,
        scanProgress: 0,
        errorMessage:
          error instanceof Error ? error.message : "Scan failed: Unknown error",
      }));
      uiActions.updateScannerState({ isScanning: false });
      stopProgressPolling();

      // Check if it's a connection-related error
      if (error instanceof Error) {
        if (
          error.message.includes("Authentication failed") ||
          error.message.includes("Server access denied") ||
          error.message.includes("Network error") ||
          error.message.includes("Connection refused")
        ) {
          console.warn("Connection error during scan:", error.message);
        }
      }
    }
  }, [
    scannerState.scanId,
    apiClient,
    startProgressPolling,
    startUnknownScanProgressPolling,
    stopProgressPolling,
    performUnknownScanStreaming,
    ui.scannerState.scanSettings,
    uiActions,
  ]);

  const performNextScan = useCallback(async () => {
    if (scannerState.scanResults.length === 0) return;

    // Allow comparison-based scan types after any scan (not just first)
    const comparisonTypes = ["changed", "unchanged", "increased", "decreased"];
    if (
      comparisonTypes.includes(scannerState.scanSettings.scanType) &&
      scannerState.scanHistory.length === 0
    ) {
      console.error(
        "Comparison-based scan types require at least one previous scan"
      );
      return;
    }

    const currentScanId = scannerState.scanId;
    console.log(`Starting next scan with ID: ${currentScanId}`);

    setScannerState((prev) => ({
      ...prev,
      isScanning: true,
      scanProgress: 0,
      scannedBytes: 0,
      totalBytes: 0,
      currentRegion: undefined,
    }));

    uiActions.updateScannerState({ isScanning: true, scanProgress: 0 });

    try {
      const backendDataType = mapToBackendDataType(
        scannerState.scanSettings.valueType
      );
      const backendFilterMethod = mapToBackendFindType(
        scannerState.scanSettings.scanType
      );

      // Define comparison types that don't require value input
      const comparisonTypes = [
        "changed",
        "unchanged",
        "increased",
        "decreased",
        "greater_than",
        "less_than",
      ];

      // Convert the search value to hex bytes based on data type
      // For comparison types, use empty pattern
      const pattern = comparisonTypes.includes(
        scannerState.scanSettings.scanType
      )
        ? ""
        : convertValueToHexBytes(
            scannerState.scanSettings.value,
            scannerState.scanSettings.valueType,
            scannerState.scanSettings.valueInputFormat || "dec"
          );

      // For range filter, also convert the max value
      const patternMax =
        scannerState.scanSettings.scanType === "range" &&
        scannerState.scanSettings.valueMax
          ? convertValueToHexBytes(
              scannerState.scanSettings.valueMax,
              scannerState.scanSettings.valueType,
              scannerState.scanSettings.valueInputFormat || "dec"
            )
          : undefined;

      console.log(
        `Filter: Converting search value "${scannerState.scanSettings.value}" (${scannerState.scanSettings.scanType}) to hex pattern: ${pattern}`
      );

      // If we have unknown scan results stored in temp files, use native filter
      if (scannerState.unknownScanId) {
        console.log(`Using native filter for unknown scan results`);

        // Get current addresses from scan results
        const addresses = scannerState.scanResults.map((r) =>
          parseInt(r.address, 16)
        );

        // For comparison types, we need previous values as byte arrays
        const oldValues = comparisonTypes.includes(
          scannerState.scanSettings.scanType
        )
          ? scannerState.scanResults.map((r) => {
              // Convert the current value to hex bytes, then to byte array
              const hexBytes = convertValueToHexBytes(
                String(r.value),
                scannerState.scanSettings.valueType,
                scannerState.scanSettings.valueInputFormat || "dec"
              );
              // Convert hex string to byte array
              const bytes: number[] = [];
              for (let i = 0; i < hexBytes.length; i += 2) {
                bytes.push(parseInt(hexBytes.substr(i, 2), 16));
              }
              return bytes;
            })
          : scannerState.scanResults.map(() => [] as number[]);

        const nativeFilterResponse = await apiClient.filterMemoryNative({
          addresses,
          old_values: oldValues,
          pattern: pattern || "",
          pattern_max: patternMax,
          filter_method: backendFilterMethod,
          data_type: backendDataType,
        });

        if (nativeFilterResponse.success) {
          const results: ScanResult[] = nativeFilterResponse.results.map(
            (item) => {
              const hexValue = item.value
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
              return {
                address: `0x${item.address.toString(16)}`,
                value: convertHexBytesToValue(
                  hexValue,
                  scannerState.scanSettings.valueType,
                  scannerState.searchPatternLength
                ),
                type: scannerState.scanSettings.valueType,
                description: "Filter result",
              };
            }
          );

          const newHistory = [...scannerState.scanHistory, results];

          setScannerState((prev) => ({
            ...prev,
            isScanning: false,
            scanResults: results,
            scanHistory: newHistory,
            currentScanIndex: newHistory.length - 1,
            totalResults: results.length,
            scanProgress: 100,
          }));

          uiActions.setScanResults(results);
          uiActions.updateScannerState({
            scanResults: results,
            totalResults: results.length,
            scanProgress: 100,
            isScanning: false,
          });

          console.log(`Native filter completed: ${results.length} results`);
          return;
        } else {
          throw new Error(nativeFilterResponse.error || "Native filter failed");
        }
      }

      const filterRequest: FilterRequest = {
        pattern: pattern,
        ...(patternMax ? { pattern_max: patternMax } : {}),
        data_type: backendDataType,
        scan_id: currentScanId,
        filter_method: backendFilterMethod,
        return_as_json: false, // Don't return results immediately
        do_suspend: scannerState.scanSettings.doSuspend,
      };

      console.log(`Sending filter request:`, filterRequest);

      // Start the filter (which now returns immediately)
      const response = await apiClient.memoryFilter(filterRequest);
      console.log(`Filter started response:`, response);

      // Start filter progress polling to monitor the filter using filter_id from response
      if (response.success && response.filter_id) {
        startFilterProgressPolling(response.filter_id);
      } else {
        throw new Error("Failed to start filter: " + response.message);
      }
    } catch (error) {
      console.error("Next scan failed:", error);
      setScannerState((prev) => ({
        ...prev,
        isScanning: false,
        scanProgress: 0,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Filter failed: Unknown error",
      }));
      uiActions.updateScannerState({ isScanning: false });
      stopProgressPolling();

      // Check if it's a connection-related error
      if (error instanceof Error) {
        if (
          error.message.includes("Authentication failed") ||
          error.message.includes("Server access denied") ||
          error.message.includes("Network error") ||
          error.message.includes("Connection refused")
        ) {
          console.warn("Connection error during filter:", error.message);
        }
      }
    }
  }, [
    scannerState.scanResults,
    scannerState.scanHistory,
    scannerState.scanSettings,
    scannerState.scanId,
    scannerState.unknownScanId,
    scannerState.searchPatternLength,
    apiClient,
    startFilterProgressPolling,
    stopProgressPolling,
    uiActions,
  ]);

  // Native filter function - processes filter locally using Tauri with network memory reads
  // This is more efficient for smaller result sets and provides immediate feedback
  const performNativeFilter = useCallback(async () => {
    if (scannerState.scanResults.length === 0) return;

    const comparisonTypes = ["changed", "unchanged", "increased", "decreased"];
    if (
      comparisonTypes.includes(scannerState.scanSettings.scanType) &&
      scannerState.scanHistory.length === 0
    ) {
      console.error(
        "Comparison-based scan types require at least one previous scan"
      );
      return;
    }

    setScannerState((prev) => ({
      ...prev,
      isScanning: true,
      scanProgress: 0,
      scannedBytes: 0,
      totalBytes: prev.scanResults.length,
      currentRegion: "Native filter processing...",
    }));

    uiActions.updateScannerState({ isScanning: true, scanProgress: 0 });

    try {
      const backendDataType = mapToBackendDataType(
        scannerState.scanSettings.valueType
      );
      const backendFilterMethod = mapToBackendFindType(
        scannerState.scanSettings.scanType
      );

      // Prepare addresses and old values from current scan results
      const addresses: number[] = [];
      const oldValues: number[][] = [];

      for (const result of scannerState.scanResults) {
        // Parse address
        const addr = parseInt(result.address.replace("0x", ""), 16);
        if (!isNaN(addr)) {
          addresses.push(addr);
          // Convert old value to byte array
          const oldHex = convertValueToHexBytes(
            String(result.value),
            scannerState.scanSettings.valueType,
            scannerState.scanSettings.valueInputFormat || "dec"
          );
          const bytes: number[] = [];
          for (let i = 0; i < oldHex.length; i += 2) {
            bytes.push(parseInt(oldHex.substr(i, 2), 16));
          }
          oldValues.push(bytes);
        }
      }

      // Convert pattern to hex
      const noValueTypes = ["changed", "unchanged", "increased", "decreased"];
      const pattern = noValueTypes.includes(scannerState.scanSettings.scanType)
        ? ""
        : convertValueToHexBytes(
            scannerState.scanSettings.value,
            scannerState.scanSettings.valueType,
            scannerState.scanSettings.valueInputFormat || "dec"
          );

      const patternMax =
        scannerState.scanSettings.scanType === "range" &&
        scannerState.scanSettings.valueMax
          ? convertValueToHexBytes(
              scannerState.scanSettings.valueMax,
              scannerState.scanSettings.valueType,
              scannerState.scanSettings.valueInputFormat || "dec"
            )
          : undefined;

      console.log(
        `Native filter: ${addresses.length} addresses, method: ${backendFilterMethod}`
      );

      const response = await apiClient.filterMemoryNative({
        addresses,
        old_values: oldValues,
        pattern,
        pattern_max: patternMax,
        data_type: backendDataType,
        filter_method: backendFilterMethod,
      });

      if (response.success) {
        const results: ScanResult[] = response.results.map((item) => {
          // Convert byte array to hex string for value conversion
          const hexValue = item.value
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          return {
            address: `0x${item.address.toString(16)}`,
            value: convertHexBytesToValue(
              hexValue,
              scannerState.scanSettings.valueType,
              scannerState.searchPatternLength
            ),
            type: scannerState.scanSettings.valueType,
            description: "Native filter result",
          };
        });

        const newHistory = [...scannerState.scanHistory, results];

        setScannerState((prev) => ({
          ...prev,
          isScanning: false,
          scanResults: results,
          scanHistory: newHistory,
          currentScanIndex: newHistory.length - 1,
          totalResults: results.length,
          scanProgress: 100,
          currentRegion: undefined,
        }));

        uiActions.setScanResults(results);
        uiActions.updateScannerState({
          scanResults: results,
          totalResults: results.length,
          scanProgress: 100,
          isScanning: false,
        });
      } else {
        throw new Error(response.error || "Native filter failed");
      }
    } catch (error) {
      console.error("Native filter failed:", error);
      setScannerState((prev) => ({
        ...prev,
        isScanning: false,
        scanProgress: 0,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Native filter failed: Unknown error",
      }));
      uiActions.updateScannerState({ isScanning: false });
    }
  }, [
    scannerState.scanResults,
    scannerState.scanHistory,
    scannerState.scanSettings,
    scannerState.searchPatternLength,
    apiClient,
    uiActions,
  ]);

  // Native lookup function - refreshes values for all current results using Tauri
  const performNativeLookup = useCallback(async () => {
    if (scannerState.scanResults.length === 0) return;

    setScannerState((prev) => ({
      ...prev,
      currentRegion: "Refreshing values...",
    }));

    try {
      const addresses: number[] = scannerState.scanResults.map((result) =>
        parseInt(result.address.replace("0x", ""), 16)
      );

      const backendDataType = mapToBackendDataType(
        scannerState.scanSettings.valueType
      );

      const response = await apiClient.lookupMemoryNative(
        addresses,
        backendDataType
      );

      if (response.success) {
        // Create a map of address -> new value for quick lookup
        const valueMap = new Map<string, string>();
        for (const item of response.results) {
          const hexValue = item.value
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const convertedValue = convertHexBytesToValue(
            hexValue,
            scannerState.scanSettings.valueType,
            scannerState.searchPatternLength
          );
          valueMap.set(
            `0x${item.address.toString(16)}`,
            String(convertedValue)
          );
        }

        // Update results with new values
        const updatedResults = scannerState.scanResults.map((result) => ({
          ...result,
          value: valueMap.get(result.address) ?? result.value,
        }));

        setScannerState((prev) => ({
          ...prev,
          scanResults: updatedResults,
          currentRegion: undefined,
        }));

        uiActions.setScanResults(updatedResults);
      } else {
        console.error("Native lookup failed:", response.error);
      }
    } catch (error) {
      console.error("Native lookup error:", error);
      setScannerState((prev) => ({
        ...prev,
        currentRegion: undefined,
      }));
    }
  }, [
    scannerState.scanResults,
    scannerState.scanSettings.valueType,
    scannerState.searchPatternLength,
    apiClient,
    uiActions,
  ]);

  const performNewScan = useCallback(() => {
    const newScanId = generateScanId();
    // Stop any existing progress polling
    stopProgressPolling();

    // Clear unknown scan temp files if any
    if (scannerState.unknownScanId) {
      apiClient.clearUnknownScan(scannerState.unknownScanId).catch((e) => {
        console.warn("Failed to clear unknown scan temp files:", e);
      });
    }

    // Unlock settings for new scan
    setIsSettingsLocked(false);

    setScannerState((prev) => ({
      ...prev,
      scanResults: [],
      scanHistory: [],
      currentScanIndex: -1,
      totalResults: 0,
      scanId: newScanId,
      scanProgress: 0,
      scannedBytes: 0,
      totalBytes: 0,
      currentRegion: undefined,
      searchPatternLength: undefined, // Reset pattern length
      scanSettings: defaultScanSettings, // Reset to default settings
      unknownScanId: undefined, // Clear unknown scan ID
      unknownScanTempDir: undefined, // Clear unknown scan temp dir
    }));

    // Update global state
    uiActions.clearScanResults();
    uiActions.updateScannerState({
      scanProgress: 0,
      isScanning: false,
    });
  }, [stopProgressPolling, uiActions, scannerState.unknownScanId, apiClient]);

  const handleResultEdit = useCallback(
    async (
      address: string,
      newValue: string,
      valueType: ScanValueType,
      inputFormat: "dec" | "hex" = "dec"
    ) => {
      try {
        // Convert the new value to hex bytes based on data type and input format
        const hexBytes = convertValueToHexBytes(
          newValue,
          valueType,
          inputFormat
        );

        // Convert hex string to ArrayBuffer
        const bytes = new Uint8Array(hexBytes.length / 2);
        for (let i = 0; i < hexBytes.length; i += 2) {
          bytes[i / 2] = parseInt(hexBytes.substr(i, 2), 16);
        }
        const buffer = bytes.buffer;

        // Write to memory
        await apiClient.writeMemory(address, buffer);

        // Update the local state with the new value
        setScannerState((prev) => ({
          ...prev,
          scanResults: prev.scanResults.map((result) =>
            result.address === address ? { ...result, value: newValue } : result
          ),
        }));

        // Update global state
        const updatedResults = scanResults.map((result) =>
          result.address === address ? { ...result, value: newValue } : result
        );
        uiActions.setScanResults(updatedResults);

        console.log(
          `Successfully wrote value "${newValue}" to address ${address}`
        );
      } catch (error) {
        console.error(`Failed to write value to address ${address}:`, error);
        throw error;
      }
    },
    [apiClient, scanResults, uiActions]
  );

  const handleResultDelete = useCallback(
    (address: string) => {
      setScannerState((prev) => ({
        ...prev,
        scanResults: prev.scanResults.filter(
          (result) => result.address !== address
        ),
        totalResults: prev.totalResults - 1,
      }));

      // Update global state
      const updatedResults = scanResults.filter(
        (result) => result.address !== address
      );
      uiActions.setScanResults(updatedResults);
      uiActions.updateScannerState({
        totalResults: updatedResults.length,
      });
    },
    [scanResults, uiActions]
  );

  const handleResultBookmark = useCallback(
    (address: string, bookmarked: boolean) => {
      if (bookmarked) {
        // Add to bookmarks
        const existingResult = scannerState.scanResults.find(
          (r) => r.address === address
        );
        if (existingResult) {
          const newBookmark: BookmarkItem = {
            id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            address,
            value: existingResult.value.toString(),
            type: existingResult.type,
            description:
              existingResult.description || `Bookmarked from scan results`,
            createdAt: new Date(),
            tags: [],
          };

          // Check if already bookmarked
          if (!bookmarks.some((b) => b.address === address)) {
            uiActions.addBookmark(newBookmark);
            console.log(`Added bookmark for address: ${address}`);
          }
        }
      } else {
        // Remove from bookmarks
        const bookmark = bookmarks.find((b) => b.address === address);
        if (bookmark) {
          uiActions.removeBookmark(bookmark.id);
          console.log(`Removed bookmark for address: ${address}`);
        }
      }
    },
    [scannerState.scanResults, bookmarks, uiActions]
  );

  // Function to add manual bookmark by address
  const addManualBookmark = useCallback(
    async (
      address: string,
      valueType: ScanValueType,
      description?: string,
      libraryExpression?: string,
      size?: number,
      displayFormat?: "dec" | "hex",
      ptrValueType?: Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">
    ) => {
      try {
        console.log("[addManualBookmark] Called with:", {
          address,
          valueType,
          description,
          libraryExpression,
          size,
          displayFormat,
          ptrValueType,
        });

        // For PTR type, the address is a pointer expression like [[base]+0x8]+0x10
        // Don't normalize it as a hex address
        const addressTrimmed = address.trim();
        
        if (valueType === "ptr") {
          // PTR type: keep the pointer expression as-is
          // Just store it directly without trying to parse as hex
          const newBookmark: BookmarkItem = {
            id: `bookmark-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            address: addressTrimmed,
            value: "(pointer chain)",
            type: valueType,
            ptrValueType: ptrValueType || "int32",
            description: description || "Pointer chain",
            displayFormat: displayFormat,
            createdAt: new Date(),
            tags: [],
          };
          
          if (!bookmarks.some((b) => b.address === addressTrimmed)) {
            uiActions.addBookmark(newBookmark);
            console.log("[addManualBookmark] PTR bookmark added:", newBookmark);
            return true;
          } else {
            console.warn("[addManualBookmark] PTR address already bookmarked:", addressTrimmed);
            return false;
          }
        }

        // Normalize address to proper hex format
        let normalizedAddress = address.trim();

        // If address doesn't start with 0x, assume it's decimal and convert to hex
        if (!/^0x/i.test(normalizedAddress)) {
          const decimalValue = parseInt(normalizedAddress, 10);
          if (!isNaN(decimalValue)) {
            normalizedAddress = `0x${decimalValue.toString(16).toUpperCase()}`;
          } else {
            throw new Error("Invalid address format");
          }
        } else {
          // If already hex, ensure proper format (0x prefix, uppercase)
          normalizedAddress = "0x" + normalizedAddress.slice(2).toUpperCase();
        }

        console.log(
          "[addManualBookmark] Normalized address:",
          normalizedAddress
        );

        // Try to read current value from memory
        // Use empty string as default for string type, "0" for others
        let currentValue = valueType === "string" ? "" : "0";
        try {
          // Calculate read size based on value type
          const readSize =
            valueType === "int8" || valueType === "uint8"
              ? 1
              : valueType === "int16" || valueType === "uint16"
                ? 2
                : valueType === "int32" ||
                    valueType === "uint32" ||
                    valueType === "float"
                  ? 4
                  : valueType === "int64" ||
                      valueType === "uint64" ||
                      valueType === "double"
                    ? 8
                    : valueType === "string"
                      ? size || 64 // Use provided size or default 64 for strings
                      : valueType === "bytes"
                        ? size || 4 // Use provided size or default 4 for bytes
                        : 4;

          const buffer = await apiClient.readMemory(
            normalizedAddress,
            readSize
          );
          // Convert buffer to value based on type
          const view = new DataView(buffer);

          switch (valueType) {
            case "int8":
              currentValue = view.getInt8(0).toString();
              break;
            case "uint8":
              currentValue = view.getUint8(0).toString();
              break;
            case "int16":
              currentValue = view.getInt16(0, true).toString();
              break;
            case "uint16":
              currentValue = view.getUint16(0, true).toString();
              break;
            case "int32":
              currentValue = view.getInt32(0, true).toString();
              break;
            case "uint32":
              currentValue = view.getUint32(0, true).toString();
              break;
            case "int64":
              currentValue = view.getBigInt64(0, true).toString();
              break;
            case "uint64":
              currentValue = view.getBigUint64(0, true).toString();
              break;
            case "float":
              currentValue = view.getFloat32(0, true).toString();
              break;
            case "double":
              currentValue = view.getFloat64(0, true).toString();
              break;
            case "string": {
              // Read as ASCII string (1 byte per character)
              const uint8Array = new Uint8Array(buffer);
              let str = "";
              for (let i = 0; i < uint8Array.length; i++) {
                const byte = uint8Array[i];
                if (byte === 0) break; // Stop at null terminator
                // Only include printable ASCII characters
                if (byte >= 32 && byte <= 126) {
                  str += String.fromCharCode(byte);
                }
                // Non-printable characters are ignored
              }
              currentValue = str;
              break;
            }
            case "bytes": {
              // Read as hex bytes (space-separated)
              currentValue = Array.from(new Uint8Array(buffer))
                .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                .join(" ");
              break;
            }
            default:
              currentValue = "0";
          }
        } catch (error) {
          console.warn(
            `Could not read memory at ${normalizedAddress}, using default value`
          );
        }

        const newBookmark: BookmarkItem = {
          id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          address: normalizedAddress,
          libraryExpression: libraryExpression, // Save library+offset expression if provided
          value: currentValue,
          type: valueType,
          size:
            valueType === "string" || valueType === "bytes" ? size : undefined, // Save size for string/bytes
          description: description || `Manual bookmark`,
          createdAt: new Date(),
          tags: [],
        };

        console.log("[addManualBookmark] Creating bookmark:", newBookmark);
        console.log(
          "[addManualBookmark] Current bookmarks count:",
          bookmarks.length
        );

        // Check if already bookmarked
        if (!bookmarks.some((b) => b.address === normalizedAddress)) {
          console.log(
            "[addManualBookmark] Address not already bookmarked, adding..."
          );
          uiActions.addBookmark(newBookmark);
          console.log("[addManualBookmark] Bookmark added successfully");
        } else {
          console.warn(
            "[addManualBookmark] Address already bookmarked:",
            normalizedAddress
          );
          return false;
        }

        console.log(
          `[addManualBookmark] Added manual bookmark for address: ${normalizedAddress}`
        );
        return true;
      } catch (error) {
        console.error(
          `[addManualBookmark] Failed to add manual bookmark for ${address}:`,
          error
        );
        return false;
      }
    },
    [apiClient, bookmarks, uiActions]
  );

  // Function to remove bookmark by ID
  const removeBookmark = useCallback(
    (bookmarkId: string) => {
      uiActions.removeBookmark(bookmarkId);
    },
    [uiActions]
  );

  // Function to update bookmark
  const updateBookmark = useCallback(
    (bookmarkId: string, updates: Partial<BookmarkItem>) => {
      // Find existing bookmark and update it
      const existingBookmark = bookmarks.find((b) => b.id === bookmarkId);
      if (existingBookmark) {
        const updatedBookmark = { ...existingBookmark, ...updates };
        // For simplicity, we'll remove and re-add
        uiActions.removeBookmark(bookmarkId);
        uiActions.addBookmark(updatedBookmark);
      }
    },
    [bookmarks, uiActions]
  );

  // Function to update bookmark addresses when modules are reloaded
  const updateBookmarkAddressesFromModules = useCallback(
    (modules: any[]) => {
      if (!modules || modules.length === 0) {
        return;
      }

      // Update bookmarks that have library expressions
      bookmarks.forEach((bookmark) => {
        if (bookmark.libraryExpression) {
          const newAddress = normalizeAddressString(
            bookmark.libraryExpression,
            modules
          );

          if (newAddress && newAddress !== bookmark.address) {
            console.log(
              `Updating bookmark ${bookmark.id}: ${bookmark.libraryExpression} from ${bookmark.address} to ${newAddress}`
            );
            updateBookmark(bookmark.id, { address: newAddress });
          }
        }
      });
    },
    [bookmarks, updateBookmark]
  );

  // Check if address is bookmarked
  const isAddressBookmarked = useCallback(
    (address: string) => {
      return bookmarks.some((b) => b.address === address);
    },
    [bookmarks]
  );

  const handleResultWatch = useCallback((address: string, watched: boolean) => {
    // TODO: Implement watch functionality
    console.log(
      `${watched ? "Added" : "Removed"} watch for address: ${address}`
    );
  }, []);

  // Stop current scan
  const stopScan = useCallback(async () => {
    try {
      console.log(`Stopping scan: ${scannerState.scanId}`);
      
      // Get current settings from global store
      const currentSettings = ui.scannerState.scanSettings as ScanSettings;
      
      // For pointer scan mode, use Tauri command to cancel
      if (currentSettings.searchMode === "ptr") {
        try {
          await invoke("cancel_pointer_scan");
          console.log("Pointer scan cancelled");
        } catch (error) {
          console.error("Failed to cancel pointer scan:", error);
        }
        setScannerState((prev) => ({
          ...prev,
          isScanning: false,
          scanProgress: 0,
        }));
        uiActions.updateScannerState({ isScanning: false });
        return;
      }
      
      const response = await apiClient.stopScan(scannerState.scanId);

      if (response.success) {
        setScannerState((prev) => ({
          ...prev,
          isScanning: false,
          scanProgress: 0,
          scannedBytes: 0,
          currentRegion: undefined,
        }));
        uiActions.updateScannerState({ isScanning: false });
        console.log("Scan stopped successfully");
      } else {
        console.error("Failed to stop scan:", response.message);
      }
    } catch (error) {
      console.error("Error stopping scan:", error);
    }
  }, [apiClient, scannerState.scanId, uiActions]);

  // Clear current scan data
  const clearScan = useCallback(async () => {
    try {
      console.log(`Clearing scan: ${scannerState.scanId}`);
      const response = await apiClient.clearScan(scannerState.scanId);

      if (response.success) {
        setScannerState((prev) => ({
          ...prev,
          scanResults: [],
          totalResults: 0,
          scanHistory: [],
          scanProgress: 0,
          scannedBytes: 0,
          totalBytes: 0,
          currentRegion: undefined,
          scanId: generateScanId(), // Generate new scan ID
        }));

        uiActions.clearScanResults();
        uiActions.updateScannerState({
          scanProgress: 0,
          isScanning: false,
        });

        console.log("Scan cleared successfully");
      } else {
        console.error("Failed to clear scan:", response.message);
      }
    } catch (error) {
      console.error("Error clearing scan:", error);
    }
  }, [apiClient, scannerState.scanId, uiActions]);

  // Function to handle history selection
  const handleSelectHistory = useCallback(
    (item: ScanHistoryItem) => {
      const newSettings: ScanSettings = {
        ...scannerState.scanSettings,
        ...item.scanSettings,
        valueType: item.valueType,
        scanType: item.scanType,
        value: item.value,
      };

      // Update both local state and global store
      setScannerState((prev) => ({
        ...prev,
        scanSettings: newSettings,
      }));

      // Also update global store
      uiActions.setScanSettings(newSettings);
    },
    [scannerState.scanSettings, uiActions]
  );

  return {
    scannerState,
    memoryRegions,
    memoryRegionsLoaded,
    isSettingsLocked,
    updateScanSettings,
    performFirstScan,
    performNextScan,
    performNewScan,
    performNativeFilter,
    performNativeLookup,
    handleResultEdit,
    handleResultDelete,
    handleResultBookmark,
    handleResultWatch,
    stopScan,
    clearScan,
    canNextScan:
      scannerState.scanHistory.length > 0 &&
      scannerState.scanResults.length > 0 &&
      !scannerState.isScanning,
    // Bookmark management
    bookmarks,
    addManualBookmark,
    removeBookmark,
    updateBookmark,
    updateBookmarkAddressesFromModules,
    isAddressBookmarked,
    // History management
    scanHistory: scanHistory,
    onSelectHistory: handleSelectHistory,
    onRemoveHistoryItem: (id: string) => {
      // Find the index of the item to remove
      const index = scanHistory.findIndex((item) => item.id === id);
      if (index >= 0) {
        uiActions.removeScanHistory(index);
      }
    },
    onClearHistory: () => uiActions.clearScanHistory(),
  };
};
