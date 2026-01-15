/**
 * DynaDbg WASM Bridge
 * 
 * Cetus-style instrumentation support:
 * - WASM binary capture via WebAssembly API hooks
 * - Code region dump (not linear memory)
 * - Symbol extraction from exports/imports
 */

// Global signature for memory location
var wasmSignature = null;

// Cetus-style: Store captured WASM binary and symbols
var wasmBinaryBuffer = null;      // Original or instrumented WASM binary
var wasmSymbols = {};             // Extracted symbols { index: name }
var wasmExports = {};             // Export name -> function index mapping
var wasmImports = {};             // Import info
var wasmMemoryInstance = null;    // WebAssembly.Memory instance
var wasmModuleInstance = null;    // WebAssembly.Instance
var wasmModuleInfo = {
  name: "wasm_module",
  instrumented: false,
  watchpointCount: 0,
  codeSize: 0,
  memorySize: 0
};

// Store initial memory snapshot
var initialMemorySnapshot = null;

// ============================================================================
// Cetus-style: WebAssembly API Hooks
// ============================================================================

// Save original WebAssembly functions
var originalWebAssemblyInstantiate = WebAssembly.instantiate;
var originalWebAssemblyInstantiateStreaming = WebAssembly.instantiateStreaming;
var originalWebAssemblyCompile = WebAssembly.compile;
var originalWebAssemblyModule = WebAssembly.Module;

// Hook WebAssembly.instantiate
WebAssembly.instantiate = function(bufferSource, importObject) {
  // Capture the WASM binary
  if (bufferSource instanceof ArrayBuffer) {
    wasmBinaryBuffer = new Uint8Array(bufferSource.slice(0));
    wasmModuleInfo.codeSize = wasmBinaryBuffer.length;
  } else if (bufferSource instanceof Uint8Array) {
    wasmBinaryBuffer = new Uint8Array(bufferSource);
    wasmModuleInfo.codeSize = wasmBinaryBuffer.length;
  } else if (bufferSource instanceof WebAssembly.Module) {
    // Module already compiled
  }
  
  return originalWebAssemblyInstantiate(bufferSource, importObject).then(function(result) {
    var instance = result.instance || result;
    wasmModuleInstance = instance;
    
    // Extract exports as symbols
    extractSymbolsFromInstance(instance);
    
    // Try to get memory instance
    if (instance.exports && instance.exports.memory) {
      wasmMemoryInstance = instance.exports.memory;
      wasmModuleInfo.memorySize = wasmMemoryInstance.buffer.byteLength;
    }
    
    return result;
  });
};

// Hook WebAssembly.instantiateStreaming
WebAssembly.instantiateStreaming = function(source, importObject) {
  // Convert streaming to regular instantiate to capture binary
  return Promise.resolve(source)
    .then(function(response) {
      return response.arrayBuffer();
    })
    .then(function(buffer) {
      wasmBinaryBuffer = new Uint8Array(buffer.slice(0));
      wasmModuleInfo.codeSize = wasmBinaryBuffer.length;
      
      return originalWebAssemblyInstantiate(buffer, importObject);
    })
    .then(function(result) {
      var instance = result.instance || result;
      wasmModuleInstance = instance;
      
      extractSymbolsFromInstance(instance);
      
      if (instance.exports && instance.exports.memory) {
        wasmMemoryInstance = instance.exports.memory;
        wasmModuleInfo.memorySize = wasmMemoryInstance.buffer.byteLength;
      }
      
      return result;
    });
};

// Hook WebAssembly.compile
WebAssembly.compile = function(bufferSource) {
  if (bufferSource instanceof ArrayBuffer) {
    wasmBinaryBuffer = new Uint8Array(bufferSource.slice(0));
    wasmModuleInfo.codeSize = wasmBinaryBuffer.length;
  }
  
  return originalWebAssemblyCompile(bufferSource);
};

// Extract symbols from WebAssembly instance exports
function extractSymbolsFromInstance(instance) {
  if (!instance || !instance.exports) return;
  
  var funcIndex = 0;
  for (var name in instance.exports) {
    var exp = instance.exports[name];
    if (typeof exp === 'function') {
      wasmSymbols[funcIndex] = name;
      wasmExports[name] = {
        type: 'function',
        index: funcIndex
      };
      funcIndex++;
    } else if (exp instanceof WebAssembly.Memory) {
      wasmExports[name] = { type: 'memory' };
    } else if (exp instanceof WebAssembly.Table) {
      wasmExports[name] = { type: 'table' };
    } else if (exp instanceof WebAssembly.Global) {
      wasmExports[name] = { type: 'global' };
    }
  }
  
}

// ============================================================================
// Utility Functions
// ============================================================================

function hexStringToBytes(hexString) {
  var bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Generate a 64-byte random signature
function generateSignature() {
  var signature = new Uint8Array(64);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(signature);
  } else {
    for (var i = 0; i < 64; i++) {
      signature[i] = Math.floor(Math.random() * 256);
    }
  }
  return signature;
}

// Convert bytes to hex string
function bytesToHex(bytes) {
  return Array.from(bytes, function(byte) {
    return ('0' + (byte & 0xff).toString(16)).slice(-2);
  }).join('');
}

// Get the HEAP8 buffer - supports various WebAssembly environments
function getHeap8() {
  // Unity WebGL via gameInstance (Unity 5.6+)
  if (typeof gameInstance !== 'undefined' && gameInstance.Module && gameInstance.Module.HEAP8) {
    return gameInstance.Module.HEAP8;
  }
  // Unity WebGL via unityInstance (newer Unity versions)
  if (typeof unityInstance !== 'undefined' && unityInstance.Module && unityInstance.Module.HEAP8) {
    return unityInstance.Module.HEAP8;
  }
  // Direct Module access (Emscripten)
  if (typeof Module !== 'undefined' && Module.HEAP8) {
    return Module.HEAP8;
  }
  // Emscripten standalone global
  if (typeof HEAP8 !== 'undefined') {
    return HEAP8;
  }
  // Window global (legacy)
  if (typeof window !== 'undefined' && window.HEAP8) {
    return window.HEAP8;
  }
  return null;
}

// Wait for HEAP8 to become available
function waitForHeap8(callback, maxAttempts = 100, interval = 100) {
  var attempts = 0;
  var checkInterval = setInterval(function() {
    attempts++;
    var heap8 = getHeap8();
    if (heap8) {
      clearInterval(checkInterval);
      callback(heap8);
    } else if (attempts >= maxAttempts) {
      clearInterval(checkInterval);
      console.error("HEAP8 not found after " + maxAttempts + " attempts. WebAssembly may not be loaded.");
    }
  }, interval);
}

function overwriteHeapBuffer(byteData, offset) {
  var heap8 = getHeap8();
  if (!heap8) {
    console.error("HEAP8 not found");
    return false;
  }
  var heapView = new Uint8Array(heap8.buffer);
  var sourceArray =
    byteData instanceof Uint8Array ? byteData : new Uint8Array(byteData);
  heapView.set(sourceArray, offset);
  return true;
}

function toHexString(byteArray) {
  return Array.from(byteArray, function (byte) {
    return ("0" + (byte & 0xff).toString(16)).slice(-2);
  }).join("");
}

// Cetus-style: Take initial memory snapshot (linear memory)
function takeInitialSnapshot() {
  var heap8 = getHeap8();
  if (!heap8) {
    console.error("Cannot take snapshot: HEAP8 not available");
    return null;
  }
  
  // Copy the entire heap
  initialMemorySnapshot = new Uint8Array(heap8.buffer.slice(0));
  return initialMemorySnapshot;
}

function connectWebSocket() {
  var ws = new WebSocket("ws://localhost:8765");

  ws.onopen = function () {
    // Take initial snapshot on connection
    if (!initialMemorySnapshot) {
      takeInitialSnapshot();
    }
    
    // Send signature and Cetus-style info to server on connection
    if (wasmSignature) {
      var initMessage = {
        command: "init_signature",
        signature: bytesToHex(wasmSignature),
        heap_size: getHeap8() ? getHeap8().length : 0,
        // Cetus-style: Include symbols and module info
        symbols: wasmSymbols,
        module_name: wasmModuleInfo.name,
        instrumented: wasmModuleInfo.instrumented,
        watchpoint_count: wasmModuleInfo.watchpointCount,
        // Code region info
        code_size: wasmModuleInfo.codeSize,
        has_binary: wasmBinaryBuffer !== null
      };
      ws.send(JSON.stringify(initMessage));
    }
  };

  ws.onmessage = function (event) {
    var data = JSON.parse(event.data);
    var heap8 = getHeap8();
    
    if (data.command == "get_heap_size") {
      ws.send(
        JSON.stringify({
          id: data.id,
          message: heap8 ? heap8.length : 0,
        })
      );
    } else if (data.command == "get_signature") {
      ws.send(
        JSON.stringify({
          id: data.id,
          signature: wasmSignature ? bytesToHex(wasmSignature) : null,
        })
      );
    } else if (data.command == "read_memory") {
      // Read from linear memory (heap)
      if (!heap8) {
        ws.send(JSON.stringify({ id: data.id, message: false, error: "HEAP8 not available" }));
        return;
      }
      var originalBuffer = heap8.buffer;
      if (data.address + data.size <= originalBuffer.byteLength) {
        var slicedBuffer = originalBuffer.slice(data.address, data.address + data.size);
        ws.send(slicedBuffer);
      } else {
        ws.send(JSON.stringify({ id: data.id, message: false }));
      }
    } else if (data.command == "write_memory") {
      var byteData = hexStringToBytes(data.bytes);
      var success = overwriteHeapBuffer(byteData, data.address);
      ws.send(JSON.stringify({ id: data.id, message: success }));
      
    // ============ Cetus-style: Code region commands ============
    } else if (data.command == "get_code_size") {
      // Return WASM binary size
      ws.send(JSON.stringify({
        id: data.id,
        message: wasmBinaryBuffer ? wasmBinaryBuffer.length : 0
      }));
    } else if (data.command == "read_code") {
      // Read from WASM binary (code region)
      if (!wasmBinaryBuffer) {
        ws.send(JSON.stringify({ id: data.id, message: false, error: "WASM binary not captured" }));
        return;
      }
      var addr = data.address || 0;
      var size = data.size || wasmBinaryBuffer.length;
      if (addr + size <= wasmBinaryBuffer.length) {
        var slicedBuffer = wasmBinaryBuffer.buffer.slice(addr, addr + size);
        ws.send(slicedBuffer);
      } else {
        ws.send(JSON.stringify({ id: data.id, message: false }));
      }
    } else if (data.command == "dump_code") {
      // Dump entire WASM binary
      if (!wasmBinaryBuffer) {
        ws.send(JSON.stringify({ id: data.id, message: false, error: "WASM binary not captured" }));
        return;
      }
      ws.send(wasmBinaryBuffer.buffer);
    } else if (data.command == "get_symbols") {
      // Return all symbols
      ws.send(JSON.stringify({
        id: data.id,
        symbols: wasmSymbols,
        exports: wasmExports
      }));
    } else if (data.command == "get_module_info") {
      // Return module info
      ws.send(JSON.stringify({
        id: data.id,
        module_info: wasmModuleInfo,
        has_binary: wasmBinaryBuffer !== null,
        has_snapshot: initialMemorySnapshot !== null
      }));
    } else if (data.command == "read_snapshot") {
      // Read from initial memory snapshot
      if (!initialMemorySnapshot) {
        ws.send(JSON.stringify({ id: data.id, message: false, error: "No snapshot available" }));
        return;
      }
      var addr = data.address || 0;
      var size = data.size || initialMemorySnapshot.length;
      if (addr + size <= initialMemorySnapshot.length) {
        var slicedBuffer = initialMemorySnapshot.buffer.slice(addr, addr + size);
        ws.send(slicedBuffer);
      } else {
        ws.send(JSON.stringify({ id: data.id, message: false }));
      }
    } else if (data.command == "take_snapshot") {
      // Take a new snapshot
      takeInitialSnapshot();
      ws.send(JSON.stringify({
        id: data.id,
        message: true,
        size: initialMemorySnapshot ? initialMemorySnapshot.length : 0
      }));
    }
  };

  ws.onerror = function (event) {
    console.error("[DynaDbg] WebSocket error:", event);
  };
  
  ws.onclose = function (event) {
    setTimeout(connectWebSocket, 3000);
  };
}

function main() {
  // Wait for HEAP8 to be available before connecting
  waitForHeap8(function(heap8) {
    // Generate and write signature to address 0
    wasmSignature = generateSignature();
    var heapView = new Uint8Array(heap8.buffer);
    heapView.set(wasmSignature, 0);
    
    // Connect to WebSocket server
    connectWebSocket();
  });
}

main();