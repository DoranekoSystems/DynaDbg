import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";

// Instruction data for graph view
export interface GraphViewInstruction {
  address: string;
  bytes: string;
  opcode: string;
  operands: string;
  detail?: string; // Module detail info (e.g., "libc.so@open64 + 0x10")
}

// Data passed to graph view window
export interface GraphViewData {
  address: string;
  functionName?: string;
  instructions: GraphViewInstruction[];
  functionStartAddress: string;
  functionEndAddress: string;
  // Ghidra CFG mode fields (optional)
  libraryPath?: string;
  functionOffset?: string; // Offset from image base (for Ghidra CFG)
  // dbgsrv URL for Z3 reachability analysis
  serverUrl?: string;
}

// Track opened graph view windows
const graphViewWindows = new Map<string, WebviewWindow>();

/**
 * Store graph view data in Tauri state for the new window to retrieve
 */
async function storeGraphViewData(data: GraphViewData): Promise<void> {
  try {
    await invoke("store_graph_view_data", {
      address: data.address,
      functionName: data.functionName || "",
      instructions: JSON.stringify(data.instructions),
      functionStartAddress: data.functionStartAddress,
      functionEndAddress: data.functionEndAddress,
      libraryPath: data.libraryPath || "",
      functionOffset: data.functionOffset || "",
      serverUrl: data.serverUrl || "",
    });
  } catch (error) {
    console.error("Failed to store graph view data:", error);
    throw error;
  }
}

/**
 * Open a new Graph View window as an independent Tauri window
 * @param data - Graph view data including instructions
 * @returns Promise<void>
 */
export async function openGraphViewWindow(data: GraphViewData): Promise<void> {
  const windowLabel = `graph-view-${data.address.replace(/0x/i, "").toLowerCase()}`;

  // Check if window already exists
  if (graphViewWindows.has(windowLabel)) {
    const existingWindow = graphViewWindows.get(windowLabel);
    if (existingWindow) {
      try {
        await existingWindow.setFocus();
        return;
      } catch {
        // Window might be closed, remove from map
        graphViewWindows.delete(windowLabel);
      }
    }
  }

  // Store data in Tauri state before opening window
  await storeGraphViewData(data);

  // Determine the base URL based on environment
  const isDev = import.meta.env.DEV;
  const baseUrl = isDev ? "http://localhost:1420" : "tauri://localhost";

  // Format title: "Graph View - module@function" (without offset)
  let title = `Graph View - ${data.address}`;
  if (data.functionName) {
    // Remove offset part if present (e.g., "libc.so@open64 + 0x10" -> "libc.so@open64")
    const plusIndex = data.functionName.indexOf(" + ");
    if (plusIndex > 0) {
      title = `Graph View - ${data.functionName.substring(0, plusIndex)}`;
    } else {
      title = `Graph View - ${data.functionName}`;
    }
  }

  const window = new WebviewWindow(windowLabel, {
    url: `${baseUrl}/#/graph-view?address=${encodeURIComponent(data.address)}`,
    title,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
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

  graphViewWindows.set(windowLabel, window);

  // Wait for window to be created
  await window.once("tauri://window-created", () => {
    console.log("Graph View window created:", windowLabel);
  });

  // Show and focus
  try {
    await window.show();
    await window.setFocus();
  } catch (error) {
    console.error("Failed to show/focus graph view window:", error);
  }

  // Clean up when window is closed
  window.once("tauri://close-requested", () => {
    graphViewWindows.delete(windowLabel);
    console.log("Graph View window closed:", windowLabel);
  });
}

/**
 * Close all graph view windows
 */
export async function closeAllGraphViewWindows(): Promise<void> {
  for (const [label, window] of graphViewWindows.entries()) {
    try {
      await window.close();
      graphViewWindows.delete(label);
    } catch (error) {
      console.error(`Failed to close window ${label}:`, error);
    }
  }
}
