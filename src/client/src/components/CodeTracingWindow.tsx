import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { getApiClient } from "../lib/api";

// Trace entry representing a single instruction execution
export interface TraceEntry {
  id: number;
  address: string;
  instruction: string;
  opcode: string;
  operands: string;
  registers: Record<string, string>;
  depth: number;
  isCall: boolean;
  isReturn: boolean;
  functionName?: string;
  timestamp?: number;
  libraryExpression?: string; // Address resolved to library+offset
}

// Track opened code tracing windows
const codeTracingWindows = new Map<string, WebviewWindow>();

/**
 * Start a trace session in Tauri store and set breakpoint on server
 * This should be called from main window before opening the tracing window
 * @param address - The target address to trace (hex string)
 * @param count - Number of instructions to trace (max count)
 * @param traceToFile - If true, trace to server file instead of UI
 * @param endAddress - Optional end address (hex string) - trace stops when PC reaches this
 * @param fullMemoryCache - If true, dump initial memory and log all memory accesses during trace
 * @returns Promise<{ success: boolean; traceFilePath?: string }> - success status and file path if tracing to file
 */
export async function startTraceSession(
  address: string,
  count: number,
  traceToFile: boolean = false,
  endAddress?: string,
  fullMemoryCache: boolean = false
): Promise<{ success: boolean; traceFilePath?: string }> {
  try {
    // Start trace session in Tauri store (only if not tracing to file)
    if (!traceToFile) {
      await invoke("start_trace_session", {
        targetAddress: address,
        totalCount: count,
      });
    }

    // Set breakpoint with hit_count for tracing mode
    const apiClient = getApiClient();
    const addressNum = parseInt(address.replace(/^0x/i, ""), 16);

    if (isNaN(addressNum)) {
      console.error("Invalid address for tracing:", address);
      return { success: false };
    }

    // Parse end address if provided
    let endAddressNum: number | undefined;
    if (endAddress && endAddress.trim()) {
      endAddressNum = parseInt(endAddress.replace(/^0x/i, ""), 16);
      if (isNaN(endAddressNum)) {
        console.error("Invalid end address for tracing:", endAddress);
        endAddressNum = undefined;
      }
    }

    console.log(
      `[DEBUG] setBreakpoint request: address=0x${addressNum.toString(16)}, hit_count=${count}, end_address=${endAddressNum ? "0x" + endAddressNum.toString(16) : "undefined"}`
    );

    const response = await apiClient.setBreakpoint({
      address: addressNum,
      hit_count: count,
      trace_to_file: traceToFile,
      end_address: endAddressNum,
      full_memory_cache: fullMemoryCache,
    });

    if (!response.success) {
      console.error("Failed to set tracing breakpoint:", response.message);
      // Stop the session since breakpoint failed
      if (!traceToFile) {
        await invoke("stop_trace_session");
      }
      return { success: false };
    }

    console.log(
      `Trace session started for ${address} with ${count} hits (toFile: ${traceToFile})`
    );
    return {
      success: true,
      traceFilePath: response.trace_file_path,
    };
  } catch (error) {
    console.error("Failed to start trace session:", error);
    return { success: false };
  }
}

/**
 * Stop the active trace session
 */
export async function stopTraceSession(): Promise<void> {
  try {
    await invoke("stop_trace_session");
  } catch (error) {
    console.error("Failed to stop trace session:", error);
  }
}

/**
 * Open a new Code Tracing window as an independent Tauri window
 * @param address - The target address to trace (hex string)
 * @param count - Number of instructions to trace
 * @param loadFromFile - If true, open in file loading mode (download from server)
 * @param localFilePath - If provided, load trace from this local file path
 * @returns Promise<void>
 */
export async function openCodeTracingWindow(
  address: string,
  count: number = 100,
  loadFromFile: boolean = false,
  localFilePath: string | null = null
): Promise<void> {
  // Use unique label for file loading mode to allow multiple trace windows
  const windowLabel = localFilePath
    ? `code-tracing-file-${Date.now()}`
    : `code-tracing-${address.replace(/0x/i, "").toLowerCase()}`;

  // Check if window already exists
  if (codeTracingWindows.has(windowLabel)) {
    const existingWindow = codeTracingWindows.get(windowLabel);
    if (existingWindow) {
      try {
        await existingWindow.setFocus();
        return;
      } catch {
        // Window might be closed, remove from map
        codeTracingWindows.delete(windowLabel);
      }
    }
  }

  // Determine the base URL based on environment
  const isDev = import.meta.env.DEV;
  const baseUrl = isDev ? "http://localhost:1420" : "tauri://localhost";

  const loadFromFileParam = loadFromFile ? "&loadFromFile=true" : "";
  const localFileParam = localFilePath
    ? `&localFilePath=${encodeURIComponent(localFilePath)}`
    : "";
  const window = new WebviewWindow(windowLabel, {
    url: `${baseUrl}/#/code-tracing?address=${encodeURIComponent(address)}&count=${count}${loadFromFileParam}${localFileParam}`,
    title: localFilePath
      ? `Code Tracing - ${localFilePath.split("/").pop() || "File"}`
      : loadFromFile
        ? `Code Tracing - Download`
        : `Code Tracing - ${address}`,
    width: 1200,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    maximized: false,
    decorations: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    center: true,
    focus: true,
    visible: true,
    acceptFirstMouse: true,
    titleBarStyle: "visible",
    shadow: true,
  });

  codeTracingWindows.set(windowLabel, window);

  // Wait for window to be created
  await window.once("tauri://window-created", () => {
    console.log("Code Tracing window created:", windowLabel);
  });

  // Show and focus
  try {
    await window.show();
    await window.setFocus();
  } catch (error) {
    console.error("Failed to show/focus code tracing window:", error);
  }

  // Clean up when window is closed
  window.once("tauri://close-requested", () => {
    codeTracingWindows.delete(windowLabel);
    console.log("Code Tracing window closed:", windowLabel);
  });
}

/**
 * Close all code tracing windows
 */
export async function closeAllCodeTracingWindows(): Promise<void> {
  for (const [label, window] of codeTracingWindows.entries()) {
    try {
      await window.close();
      codeTracingWindows.delete(label);
    } catch (error) {
      console.error(`Failed to close window ${label}:`, error);
    }
  }
}

// Re-export TraceEntry for convenience
export type { TraceEntry as CodeTracingEntry };
