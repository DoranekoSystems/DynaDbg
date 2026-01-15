// ============================================================================
// DynaDbg WASM Bridge - Background Service Worker (Manifest V3)
// ============================================================================

let ws = null;
let wsConnected = false;
let debugServerUrl = "ws://localhost:8765";
let activeTabId = null;
let reconnectTimer = null;
let keepAliveInterval = null;
let intentionalDisconnect = false; // Flag to prevent auto-reconnect on user disconnect
let autoReconnectEnabled = false; // Only reconnect if explicitly enabled

// State storage (in-memory, will be synced with chrome.storage)
let wasmState = {
  binaryBuffer: null,
  symbols: [],
  exports: [],
  heapSize: 0,
  codeSize: 0,
  hasBinary: false,
  memoryBuffer: null
};

// ============================================================================
// State Persistence (chrome.storage for MV3 service worker survival)
// ============================================================================

async function saveState() {
  try {
    await chrome.storage.session.set({
      wasmState: {
        // Don't store large binary in storage, just metadata
        symbols: wasmState.symbols,
        exports: wasmState.exports,
        heapSize: wasmState.heapSize,
        codeSize: wasmState.codeSize,
        hasBinary: wasmState.hasBinary
      },
      wsConnected: wsConnected,
      debugServerUrl: debugServerUrl,
      activeTabId: activeTabId
    });
  } catch (e) {
    console.error("[DynaDbg] Failed to save state:", e);
  }
}

async function loadState() {
  try {
    const result = await chrome.storage.session.get(['wasmState', 'wsConnected', 'debugServerUrl', 'activeTabId']);
    if (result.wasmState) {
      wasmState.symbols = result.wasmState.symbols || [];
      wasmState.exports = result.wasmState.exports || [];
      wasmState.heapSize = result.wasmState.heapSize || 0;
      wasmState.codeSize = result.wasmState.codeSize || 0;
      wasmState.hasBinary = result.wasmState.hasBinary || false;
    }
    if (result.debugServerUrl) {
      debugServerUrl = result.debugServerUrl;
    }
    if (result.activeTabId) {
      activeTabId = result.activeTabId;
    }
    // Do NOT auto-reconnect on service worker startup
    // User must explicitly click Connect button
    console.log("[DynaDbg] State loaded (no auto-connect)");
  } catch (e) {
    console.error("[DynaDbg] Failed to load state:", e);
  }
}

// Load state on service worker startup
loadState();

// ============================================================================
// WebSocket Connection Management
// ============================================================================

function startKeepAlive() {
  // Keep service worker alive while connected
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  keepAliveInterval = setInterval(() => {
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      // Send ping to keep connection alive
      console.log("[DynaDbg] Keep-alive ping");
    }
  }, 20000); // Every 20 seconds
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function connectToServer(url) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log("[DynaDbg] Already connected");
    return;
  }

  // Reset disconnect flag when connecting
  intentionalDisconnect = false;
  autoReconnectEnabled = true;

  // Close existing connection if any
  if (ws) {
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }

  debugServerUrl = url || debugServerUrl;
  console.log("[DynaDbg] Connecting to " + debugServerUrl);

  try {
    ws = new WebSocket(debugServerUrl);

    ws.onopen = function() {
      wsConnected = true;
      console.log("[DynaDbg] Connected to debug server");
      saveState();
      broadcastStatus({ connected: true });
      startKeepAlive();
      
      // Clear reconnect timer
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      // Send init signature if we have WASM data
      if (wasmState.hasBinary) {
        sendInitSignature();
      }
    };

    ws.onclose = function(event) {
      wsConnected = false;
      ws = null;
      console.log("[DynaDbg] Disconnected from debug server, code:", event.code, "intentional:", intentionalDisconnect);
      saveState();
      broadcastStatus({ connected: false });
      stopKeepAlive();
      
      // Only auto-reconnect if not intentional disconnect and auto-reconnect is enabled
      if (!intentionalDisconnect && autoReconnectEnabled && event.code !== 1000) {
        scheduleReconnect();
      }
    };

    ws.onerror = function(err) {
      console.error("[DynaDbg] WebSocket error:", err);
      wsConnected = false;
      saveState();
    };

    ws.onmessage = function(event) {
      handleServerMessage(event);
    };

  } catch (e) {
    console.error("[DynaDbg] Failed to connect:", e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!wsConnected) {
      console.log("[DynaDbg] Attempting reconnect...");
      connectToServer(debugServerUrl);
    }
  }, 3000);
}

function disconnectFromServer() {
  console.log("[DynaDbg] Disconnecting from server (user initiated)");
  intentionalDisconnect = true;
  autoReconnectEnabled = false;
  stopKeepAlive();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close(1000, "User disconnect"); // Code 1000 = normal closure
    } catch (e) {
      console.error("[DynaDbg] Error closing WebSocket:", e);
    }
    ws = null;
  }
  wsConnected = false;
  saveState();
  broadcastStatus({ connected: false });
}

// ============================================================================
// Server Message Handling
// ============================================================================

async function handleServerMessage(event) {
  try {
    const data = JSON.parse(event.data);
    console.log("[DynaDbg] Received command:", data.command);

    switch (data.command) {
      case "get_heap_size":
        handleGetHeapSize(data);
        break;

      case "read_memory":
        await handleReadMemory(data);
        break;

      case "write_memory":
        await handleWriteMemory(data);
        break;

      case "get_code_size":
        handleGetCodeSize(data);
        break;

      case "read_code":
        handleReadCode(data);
        break;

      case "dump_code":
        handleDumpCode(data);
        break;

      case "get_symbols":
        handleGetSymbols(data);
        break;

      case "take_snapshot":
        await handleTakeSnapshot(data);
        break;

      case "read_snapshot":
        handleReadSnapshot(data);
        break;

      default:
        console.warn("[DynaDbg] Unknown command:", data.command);
        ws.send(JSON.stringify({ id: data.id, message: false, error: "Unknown command" }));
    }
  } catch (e) {
    console.error("[DynaDbg] Error handling message:", e);
  }
}

function handleGetHeapSize(data) {
  ws.send(JSON.stringify({
    id: data.id,
    message: wasmState.heapSize
  }));
}

async function handleReadMemory(data) {
  const addr = data.address || 0;
  const size = data.size || 256;

  // Request memory from content script
  const response = await sendToContentScript({
    type: "DYNADBG_READ_MEMORY",
    address: addr,
    size: size
  });

  if (response && response.success) {
    const buffer = new Uint8Array(response.data);
    ws.send(buffer.buffer);
  } else {
    ws.send(JSON.stringify({ id: data.id, message: false, error: response?.error || "Read failed" }));
  }
}

async function handleWriteMemory(data) {
  const addr = data.address || 0;
  const hexBytes = data.bytes || "";
  
  // Convert hex string to byte array
  const bytes = [];
  for (let i = 0; i < hexBytes.length; i += 2) {
    bytes.push(parseInt(hexBytes.substr(i, 2), 16));
  }

  const response = await sendToContentScript({
    type: "DYNADBG_WRITE_MEMORY",
    address: addr,
    data: bytes
  });

  ws.send(JSON.stringify({
    id: data.id,
    message: response?.success || false
  }));
}

function handleGetCodeSize(data) {
  ws.send(JSON.stringify({
    id: data.id,
    message: wasmState.codeSize
  }));
}

function handleReadCode(data) {
  if (!wasmState.binaryBuffer) {
    ws.send(JSON.stringify({ id: data.id, message: false, error: "WASM binary not captured" }));
    return;
  }

  const bufferLength = wasmState.binaryBuffer.byteLength;
  const addr = data.address || 0;
  const size = data.size || bufferLength;
  
  console.log("[DynaDbg] read_code: addr=", addr, "size=", size, "bufferLength=", bufferLength);
  
  if (addr + size <= bufferLength) {
    const view = new Uint8Array(wasmState.binaryBuffer, addr, size);
    ws.send(view);
  } else {
    ws.send(JSON.stringify({ id: data.id, message: false, error: `Out of bounds: addr=${addr} size=${size} bufLen=${bufferLength}` }));
  }
}

function handleDumpCode(data) {
  if (!wasmState.binaryBuffer) {
    ws.send(JSON.stringify({ id: data.id, message: false, error: "WASM binary not captured" }));
    return;
  }

  console.log("[DynaDbg] Sending WASM binary dump:", wasmState.binaryBuffer.byteLength, "bytes");
  const view = new Uint8Array(wasmState.binaryBuffer);
  ws.send(view);
}

function handleGetSymbols(data) {
  ws.send(JSON.stringify({
    id: data.id,
    symbols: wasmState.symbols,
    exports: wasmState.exports
  }));
}

async function handleTakeSnapshot(data) {
  const response = await sendToContentScript({
    type: "DYNADBG_TAKE_SNAPSHOT"
  });

  if (response && response.success) {
    wasmState.memoryBuffer = new Uint8Array(response.data);
    ws.send(JSON.stringify({
      id: data.id,
      message: true,
      size: wasmState.memoryBuffer.length
    }));
  } else {
    ws.send(JSON.stringify({ id: data.id, message: false }));
  }
}

function handleReadSnapshot(data) {
  if (!wasmState.memoryBuffer) {
    ws.send(JSON.stringify({ id: data.id, message: false, error: "No snapshot" }));
    return;
  }

  const offset = data.address || 0;
  const size = data.size || wasmState.memoryBuffer.length;

  if (offset + size <= wasmState.memoryBuffer.length) {
    const sliced = wasmState.memoryBuffer.slice(offset, offset + size);
    ws.send(sliced.buffer);
  } else {
    ws.send(JSON.stringify({ id: data.id, message: false }));
  }
}

// ============================================================================
// Init Signature (Cetus-style)
// ============================================================================

function sendInitSignature() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Generate signature from first 256 bytes of heap
  const signatureHex = wasmState.binaryBuffer 
    ? Array.from(new Uint8Array(wasmState.binaryBuffer.slice(0, 256)))
        .map(b => b.toString(16).padStart(2, '0')).join('')
    : "";

  const initMessage = {
    command: "init_signature",
    signature: signatureHex,
    heap_size: wasmState.heapSize,
    code_size: wasmState.codeSize,
    has_binary: wasmState.hasBinary,
    symbols: wasmState.symbols,
    module_name: "wasm_module",
    instrumented: true,
    watchpoint_count: 0
  };

  ws.send(JSON.stringify(initMessage));
  console.log("[DynaDbg] Sent init signature");
}

// ============================================================================
// Content Script Communication
// ============================================================================

function sendToContentScript(message) {
  return new Promise((resolve) => {
    if (!activeTabId) {
      resolve({ success: false, error: "No active tab" });
      return;
    }

    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[DynaDbg] Content script error:", chrome.runtime.lastError);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: "DYNADBG_STATUS", ...status }).catch(() => {});
}

// ============================================================================
// Message Listeners
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[DynaDbg] Background received:", message.type);

  switch (message.type) {
    case "DYNADBG_WASM_INIT":
      // WASM instance captured from page
      wasmState.binaryBuffer = message.binary ? new Uint8Array(message.binary).buffer : null;
      wasmState.codeSize = message.codeSize || 0;
      wasmState.heapSize = message.heapSize || 0;
      wasmState.hasBinary = !!message.binary && message.binary.length > 0;
      wasmState.symbols = message.symbols || [];
      wasmState.exports = message.exports || [];
      activeTabId = sender.tab?.id;
      
      console.log("[DynaDbg] WASM captured - Code:", wasmState.codeSize, "Heap:", wasmState.heapSize, "hasBinary:", wasmState.hasBinary);
      
      // Save state to survive service worker restart
      saveState();
      
      if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
        sendInitSignature();
      }
      sendResponse({ success: true });
      break;

    case "DYNADBG_HEAP_UPDATE":
      wasmState.heapSize = message.heapSize;
      saveState();
      sendResponse({ success: true });
      break;

    case "DYNADBG_CONNECT":
      chrome.storage.local.set({ serverUrl: message.url, autoConnect: true });
      connectToServer(message.url);
      sendResponse({ success: true });
      break;

    case "DYNADBG_DISCONNECT":
      chrome.storage.local.set({ autoConnect: false });
      disconnectFromServer();
      sendResponse({ success: true });
      break;

    case "DYNADBG_GET_STATUS":
      // Check actual WebSocket state
      const isActuallyConnected = ws && ws.readyState === WebSocket.OPEN;
      sendResponse({
        connected: isActuallyConnected,
        hasBinary: wasmState.hasBinary,
        codeSize: wasmState.codeSize,
        heapSize: wasmState.heapSize,
        symbolCount: wasmState.symbols.length
      });
      break;

    case "DYNADBG_WEBGL_CONTEXT":
      // WebGL context created
      console.log("[DynaDbg] WebGL context captured:", message.contextType);
      activeTabId = sender.tab?.id;
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false, error: "Unknown message type" });
  }

  return true; // Keep channel open for async response
});

// ============================================================================
// Extension Lifecycle
// ============================================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log("[DynaDbg] Extension installed");
  chrome.storage.local.set({ autoConnect: false, serverUrl: "ws://localhost:8765" });
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[DynaDbg] Extension started");
  loadState();
});

// Tab activation tracking
chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;
  saveState();
});

// Keep service worker alive when connected
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log("[DynaDbg] Keep-alive alarm");
    // Check if we should reconnect
    chrome.storage.local.get(['autoConnect', 'serverUrl'], (result) => {
      if (result.autoConnect && (!ws || ws.readyState !== WebSocket.OPEN)) {
        connectToServer(result.serverUrl);
      }
    });
  }
});

// Set up keep-alive alarm
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 }); // Every 30 seconds
