import { useCallback } from "react";
import { useAppState } from "./useAppState";
import type {
  ScanResult,
  ScanValueType,
  BookmarkItem,
  ScanHistoryItem,
  ScanSettings,
} from "../types/index";
import { getApiClient } from "../lib/api";

/**
 * Scanner state management using new app state system
 */
export const useScannerGlobalState = () => {
  const { ui, uiActions } = useAppState();
  const scannerState = ui.scannerState;
  const scanResults = scannerState.scanResults;
  const scanHistory = ui.scanHistory;
  const bookmarks = ui.bookmarks;
  const scanSettings = scannerState.scanSettings;

  const apiClient = getApiClient();

  // Scan results management
  const setScanResults = useCallback(
    (results: ScanResult[]) => {
      uiActions.setScanResults(results);
    },
    [uiActions]
  );

  const clearScanResults = useCallback(() => {
    uiActions.clearScanResults();
  }, [uiActions]);

  // Scanner state management
  const updateScannerState = useCallback(
    (updates: Partial<typeof scannerState>) => {
      uiActions.updateScannerState(updates);
    },
    [uiActions]
  );

  // Scan settings management
  const setScanSettings = useCallback(
    (settings: ScanSettings) => {
      uiActions.setScanSettings(settings);
    },
    [uiActions]
  );

  const updateScanSettings = useCallback(
    (updates: Partial<ScanSettings>) => {
      uiActions.updateScanSettings(updates);
    },
    [uiActions]
  );

  // Full settings update function for compatibility with components that expect complete settings
  const updateFullScanSettings = useCallback(
    (settings: ScanSettings) => {
      uiActions.setScanSettings(settings);
      return true;
    },
    [uiActions]
  );

  // Bookmarks management
  const addBookmark = useCallback(
    (bookmark: BookmarkItem) => {
      uiActions.addBookmark(bookmark);
    },
    [uiActions]
  );

  const removeBookmark = useCallback(
    (bookmarkId: string) => {
      uiActions.removeBookmark(bookmarkId);
    },
    [uiActions]
  );

  const updateBookmark = useCallback(
    (bookmarkId: string, updates: Partial<BookmarkItem>) => {
      uiActions.updateBookmark(bookmarkId, updates);
    },
    [uiActions]
  );

  const isAddressBookmarked = useCallback(
    (address: string) => {
      return bookmarks.some((b) => b.address === address);
    },
    [bookmarks]
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
        console.log("[useScannerGlobalState] addManualBookmark called with:", {
          address,
          valueType,
          description,
          libraryExpression,
          size,
          displayFormat,
          ptrValueType,
        });

        // For PTR type, the address is a pointer expression like [[base]+0x8]+0x10
        // Skip normalization and use as-is
        let normalizedAddress = address.trim();
        const isPtrType = valueType === "ptr";

        if (!isPtrType) {
          // Normalize address to proper hex format
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
        }

        // Try to read current value from memory
        let currentValue = valueType === "string" ? "" : "0";
        
        if (isPtrType) {
          // For PTR type, resolve the pointer chain and read the value at the final address
          try {
            const resolveResult = await apiClient.resolveAddress(normalizedAddress);
            if (resolveResult.success && resolveResult.data?.address) {
              const resolvedAddr = `0x${resolveResult.data.address.toString(16).toUpperCase()}`;
              // Always read 8 bytes for PTR type, mask based on ptrValueType for display
              const buffer = await apiClient.readMemory(resolvedAddr, 8);
              const view = new DataView(buffer);
              const fullValue = view.getBigUint64(0, true);
              
              // Mask based on ptrValueType for display
              const effectiveType = ptrValueType || "int32";
              let maskedValue: bigint;
              switch (effectiveType) {
                case "int8":
                case "uint8":
                  maskedValue = fullValue & 0xFFn;
                  break;
                case "int16":
                case "uint16":
                  maskedValue = fullValue & 0xFFFFn;
                  break;
                case "int32":
                case "uint32":
                case "float":
                  maskedValue = fullValue & 0xFFFFFFFFn;
                  break;
                default:
                  maskedValue = fullValue;
              }
              currentValue = maskedValue.toString();
            } else {
              currentValue = "N/A";
            }
          } catch (error) {
            console.warn(`Could not resolve pointer chain: ${normalizedAddress}`);
            currentValue = "N/A";
          }
        } else {
          try {
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
                        ? size || 64
                        : valueType === "bytes"
                          ? size || 4
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
                const uint8Array = new Uint8Array(buffer);
                let str = "";
                for (let i = 0; i < uint8Array.length; i++) {
                  const byte = uint8Array[i];
                  if (byte === 0) break;
                  if (byte >= 32 && byte <= 126) {
                    str += String.fromCharCode(byte);
                  }
                }
                currentValue = str;
                break;
              }
              case "bytes": {
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
        }

        const newBookmark: BookmarkItem = {
          id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          address: normalizedAddress,
          libraryExpression: libraryExpression, // Save library+offset expression if provided
          value: currentValue,
          type: valueType,
          ptrValueType: valueType === "ptr" ? (ptrValueType || "int32") : undefined,
          size:
            valueType === "string" || valueType === "bytes" ? size : undefined,
          description: description || `Manual bookmark`,
          displayFormat: displayFormat,
          createdAt: new Date(),
          tags: [],
        };

        console.log("[useScannerGlobalState] Creating bookmark:", newBookmark);

        // Check if already bookmarked
        if (isAddressBookmarked(normalizedAddress)) {
          console.warn(
            "[useScannerGlobalState] Address already bookmarked:",
            normalizedAddress
          );
          return false;
        }

        addBookmark(newBookmark);
        console.log(
          `[useScannerGlobalState] Added manual bookmark for address: ${normalizedAddress}`
        );
        return true;
      } catch (error) {
        console.error(
          `[useScannerGlobalState] Failed to add manual bookmark for ${address}:`,
          error
        );
        return false;
      }
    },
    [apiClient, isAddressBookmarked, addBookmark]
  );

  // History management
  const addScanHistory = useCallback(
    (item: ScanHistoryItem) => {
      uiActions.addScanHistory(item);
    },
    [uiActions]
  );

  const clearScanHistory = useCallback(() => {
    uiActions.clearScanHistory();
  }, [uiActions]);

  const removeHistoryItem = useCallback(
    (id: string) => {
      const index = scanHistory.findIndex((item: any) => item.id === id);
      if (index !== -1) {
        uiActions.removeScanHistory(index);
      }
    },
    [uiActions, scanHistory]
  );

  // Function to handle result bookmark toggle
  const handleResultBookmark = useCallback(
    (address: string, bookmarked: boolean) => {
      if (bookmarked) {
        // Add to bookmarks
        const existingResult = scanResults.find((r) => r.address === address);
        if (existingResult) {
          const newBookmark: BookmarkItem = {
            id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            address,
            value: existingResult.value.toString(),
            type: existingResult.type,
            description:
              existingResult.description || "Bookmarked from scan results",
            displayFormat: scanSettings?.valueInputFormat || "dec",
            createdAt: new Date(),
            tags: [],
          };

          // Check if already bookmarked
          if (!isAddressBookmarked(address)) {
            addBookmark(newBookmark);
            console.log(`Added bookmark for address: ${address}`);
          }
        }
      } else {
        // Remove from bookmarks
        const bookmark = bookmarks.find((b) => b.address === address);
        if (bookmark) {
          removeBookmark(bookmark.id);
          console.log(`Removed bookmark for address: ${address}`);
        }
      }
    },
    [
      scanResults,
      bookmarks,
      scanSettings?.valueInputFormat,
      isAddressBookmarked,
      addBookmark,
      removeBookmark,
    ]
  );

  return {
    // State
    scannerState,
    scanResults,
    scanHistory,
    bookmarks,
    scanSettings,

    // Scanner state actions
    updateScannerState,
    setScanResults,
    clearScanResults,

    // Scan settings actions
    setScanSettings,
    updateScanSettings,
    updateFullScanSettings,

    // Bookmark actions
    addBookmark,
    removeBookmark,
    updateBookmark,
    addManualBookmark,
    isAddressBookmarked,
    handleResultBookmark,

    // History actions
    addScanHistory,
    clearScanHistory,
    removeHistoryItem,
  };
};
