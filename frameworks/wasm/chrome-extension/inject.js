// ============================================================================
// DynaDbg WASM Bridge - Injected Script (Page Context)
// Hooks WebAssembly, WebGL, and other browser APIs
// ============================================================================

(function() {
  'use strict';

  // ============================================================================
  // State Storage
  // ============================================================================

  const dynaDbgState = {
    wasmBinaryBuffer: null,
    wasmMemory: null,
    wasmInstance: null,
    wasmExports: {},
    wasmSymbols: [],
    webglContexts: [],
    webgl2Contexts: []
  };

  // Make state accessible for debugging
  window.__dynaDbgState = dynaDbgState;

  // ============================================================================
  // Utility Functions
  // ============================================================================

  function extractSymbolsFromInstance(instance, binary) {
    const symbols = [];
    const exports = instance.exports;
    
    // Try to parse WASM binary to get function info (offset, size) and export mappings
    let parseResult = { functions: [], exportFuncIndices: {}, importFuncCount: 0 };
    if (binary) {
      try {
        parseResult = parseWasmBinary(binary);
      } catch (e) {
        console.warn("[DynaDbg] Failed to parse WASM binary:", e);
      }
    }
    
    const { functions, exportFuncIndices, importFuncCount } = parseResult;

    for (const name in exports) {
      const exp = exports[name];
      let type = "unknown";
      let address = 0;
      let size = 0;

      if (typeof exp === "function") {
        type = "function";
        
        // Get actual function index from export section
        const funcIndex = exportFuncIndices[name];
        if (funcIndex !== undefined) {
          // Code section only contains internal functions (not imports)
          const codeIndex = funcIndex - importFuncCount;
          if (codeIndex >= 0 && codeIndex < functions.length) {
            const funcInfo = functions[codeIndex];
            address = funcInfo.codeOffset;
            size = funcInfo.codeSize;
          }
        }
      } else if (exp instanceof WebAssembly.Memory) {
        type = "memory";
        dynaDbgState.wasmMemory = exp;
      } else if (exp instanceof WebAssembly.Table) {
        type = "table";
      } else if (exp instanceof WebAssembly.Global) {
        type = "global";
        try {
          address = exp.value;
        } catch (e) {}
      }

      symbols.push({
        name: name,
        type: type,
        address: address,
        size: size
      });

      dynaDbgState.wasmExports[name] = exp;
    }

    return symbols;
  }
  
  // Parse WASM binary to extract function info, imports, and exports
  function parseWasmBinary(binary) {
    const functions = []; // Code section function bodies
    const exportFuncIndices = {}; // name -> funcIndex
    let importFuncCount = 0;
    
    const bytes = new Uint8Array(binary);
    let offset = 0;
    
    // WASM magic number and version (8 bytes)
    if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6D) {
      console.warn("[DynaDbg] Not a valid WASM binary");
      return { functions, exportFuncIndices, importFuncCount };
    }
    offset = 8;
    
    // Parse sections
    while (offset < bytes.length) {
      const sectionId = bytes[offset++];
      const [sectionSize, sizeLen] = readLEB128(bytes, offset);
      offset += sizeLen;
      const sectionEnd = offset + sectionSize;
      
      if (sectionId === 2) { // Import section
        const [numImports, numLen] = readLEB128(bytes, offset);
        let importOffset = offset + numLen;
        
        for (let i = 0; i < numImports; i++) {
          // Skip module name
          const [modLen, modLenSize] = readLEB128(bytes, importOffset);
          importOffset += modLenSize + modLen;
          
          // Skip field name
          const [fieldLen, fieldLenSize] = readLEB128(bytes, importOffset);
          importOffset += fieldLenSize + fieldLen;
          
          // Import kind
          const importKind = bytes[importOffset++];
          if (importKind === 0) { // Function import
            importFuncCount++;
            // Skip type index
            const [typeIdx, typeLen] = readLEB128(bytes, importOffset);
            importOffset += typeLen;
          } else if (importKind === 1) { // Table
            importOffset++; // elemtype
            const [limitsFlag] = readLEB128(bytes, importOffset);
            importOffset++;
            const [min, minLen] = readLEB128(bytes, importOffset);
            importOffset += minLen;
            if (limitsFlag === 1) {
              const [max, maxLen] = readLEB128(bytes, importOffset);
              importOffset += maxLen;
            }
          } else if (importKind === 2) { // Memory
            const [limitsFlag] = readLEB128(bytes, importOffset);
            importOffset++;
            const [min, minLen] = readLEB128(bytes, importOffset);
            importOffset += minLen;
            if (limitsFlag === 1) {
              const [max, maxLen] = readLEB128(bytes, importOffset);
              importOffset += maxLen;
            }
          } else if (importKind === 3) { // Global
            importOffset += 2; // type + mutability
          }
        }
        offset = sectionEnd;
        
      } else if (sectionId === 7) { // Export section
        const [numExports, numLen] = readLEB128(bytes, offset);
        let exportOffset = offset + numLen;
        
        for (let i = 0; i < numExports; i++) {
          // Read name
          const [nameLen, nameLenSize] = readLEB128(bytes, exportOffset);
          exportOffset += nameLenSize;
          const nameBytes = bytes.slice(exportOffset, exportOffset + nameLen);
          const name = new TextDecoder().decode(nameBytes);
          exportOffset += nameLen;
          
          // Export kind and index
          const exportKind = bytes[exportOffset++];
          const [exportIndex, indexLen] = readLEB128(bytes, exportOffset);
          exportOffset += indexLen;
          
          if (exportKind === 0) { // Function export
            exportFuncIndices[name] = exportIndex;
          }
        }
        offset = sectionEnd;
        
      } else if (sectionId === 10) { // Code section
        const [numFuncs, numLen] = readLEB128(bytes, offset);
        offset += numLen;
        
        for (let i = 0; i < numFuncs; i++) {
          const funcStart = offset;
          const [funcSize, funcSizeLen] = readLEB128(bytes, offset);
          const bodyStart = offset + funcSizeLen; // Start of local decls + code
          
          // Skip local variable declarations to find actual instruction start
          let localOffset = bodyStart;
          const [numLocalGroups, numLocalLen] = readLEB128(bytes, localOffset);
          localOffset += numLocalLen;
          
          // Skip each local group (count + type)
          for (let j = 0; j < numLocalGroups; j++) {
            const [localCount, countLen] = readLEB128(bytes, localOffset);
            localOffset += countLen;
            localOffset += 1; // Skip type byte
          }
          
          // localOffset now points to the first actual instruction
          const instructionOffset = localOffset;
          const instructionSize = funcSize - (instructionOffset - bodyStart);
          
          functions.push({
            offset: funcStart,
            size: funcSize + funcSizeLen,
            codeOffset: instructionOffset, // Points to first instruction
            codeSize: instructionSize,
            bodyOffset: bodyStart,
            bodySize: funcSize
          });
          
          offset += funcSizeLen + funcSize;
        }
        // Don't break here - continue parsing other sections
        offset = sectionEnd;
        
      } else {
        offset = sectionEnd;
      }
    }
    
    return { functions, exportFuncIndices, importFuncCount };
  }
  
  // Read unsigned LEB128 encoded integer
  function readLEB128(bytes, offset) {
    let result = 0;
    let shift = 0;
    let len = 0;
    let byte;
    
    do {
      byte = bytes[offset + len];
      result |= (byte & 0x7F) << shift;
      shift += 7;
      len++;
    } while (byte & 0x80);
    
    return [result, len];
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  function getHeapSize() {
    if (dynaDbgState.wasmMemory) {
      return dynaDbgState.wasmMemory.buffer.byteLength;
    }
    return 0;
  }

  function notifyWasmInit(binary, instance) {
    const symbols = extractSymbolsFromInstance(instance, binary);
    dynaDbgState.wasmSymbols = symbols;
    dynaDbgState.wasmInstance = instance;

    const heapSize = getHeapSize();
    const codeSize = binary ? binary.byteLength : 0;

    // Send to content script
    window.postMessage({
      type: "DYNADBG_WASM_INIT",
      binary: binary ? Array.from(new Uint8Array(binary)) : null,
      codeSize: codeSize,
      heapSize: heapSize,
      symbols: symbols,
      exports: Object.keys(dynaDbgState.wasmExports)
    }, '*');
  }

  // ============================================================================
  // WebAssembly Hooks
  // ============================================================================

  const originalInstantiate = WebAssembly.instantiate;
  const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
  const originalCompile = WebAssembly.compile;
  const originalCompileStreaming = WebAssembly.compileStreaming;

  WebAssembly.instantiate = async function(bufferSource, importObject) {
    // Check if Memory is provided via importObject
    if (importObject) {
      for (const moduleName in importObject) {
        const module = importObject[moduleName];
        for (const name in module) {
          if (module[name] instanceof WebAssembly.Memory) {
            dynaDbgState.wasmMemory = module[name];
          }
        }
      }
    }

    let binary = null;

    if (bufferSource instanceof ArrayBuffer) {
      binary = bufferSource.slice(0);
      dynaDbgState.wasmBinaryBuffer = new Uint8Array(binary);
    } else if (bufferSource instanceof WebAssembly.Module) {
      // Module already compiled, no binary access
    } else if (ArrayBuffer.isView(bufferSource)) {
      binary = bufferSource.buffer.slice(
        bufferSource.byteOffset,
        bufferSource.byteOffset + bufferSource.byteLength
      );
      dynaDbgState.wasmBinaryBuffer = new Uint8Array(binary);
    }

    const result = await originalInstantiate.call(this, bufferSource, importObject);
    
    const instance = result.instance || result;
    notifyWasmInit(binary, instance);

    return result;
  };

  WebAssembly.instantiateStreaming = async function(source, importObject) {
    // Check if Memory is provided via importObject
    if (importObject) {
      for (const moduleName in importObject) {
        const module = importObject[moduleName];
        for (const name in module) {
          if (module[name] instanceof WebAssembly.Memory) {
            dynaDbgState.wasmMemory = module[name];
          }
        }
      }
    }

    try {
      // Clone the response to read the binary
      const response = await source;
      const clonedResponse = response.clone();
      const binary = await clonedResponse.arrayBuffer();
      
      dynaDbgState.wasmBinaryBuffer = new Uint8Array(binary.slice(0));

      const result = await originalInstantiateStreaming.call(this, source, importObject);
      
      notifyWasmInit(binary, result.instance);
      
      return result;
    } catch (e) {
      console.error("[DynaDbg] instantiateStreaming hook error:", e);
      return originalInstantiateStreaming.call(this, source, importObject);
    }
  };

  WebAssembly.compile = async function(bufferSource) {
    let binary = null;

    if (bufferSource instanceof ArrayBuffer) {
      binary = bufferSource.slice(0);
      dynaDbgState.wasmBinaryBuffer = new Uint8Array(binary);
    } else if (ArrayBuffer.isView(bufferSource)) {
      binary = bufferSource.buffer.slice(
        bufferSource.byteOffset,
        bufferSource.byteOffset + bufferSource.byteLength
      );
      dynaDbgState.wasmBinaryBuffer = new Uint8Array(binary);
    }

    return originalCompile.call(this, bufferSource);
  };

  WebAssembly.compileStreaming = async function(source) {
    try {
      const response = await source;
      const clonedResponse = response.clone();
      const binary = await clonedResponse.arrayBuffer();
      
      dynaDbgState.wasmBinaryBuffer = new Uint8Array(binary.slice(0));

      return originalCompileStreaming.call(this, source);
    } catch (e) {
      console.error("[DynaDbg] compileStreaming hook error:", e);
      return originalCompileStreaming.call(this, source);
    }
  };

  // ============================================================================
  // WebGL Hooks
  // ============================================================================

  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.getContext = function(contextType, contextAttributes) {
    const context = originalGetContext.call(this, contextType, contextAttributes);

    if (context) {
      if (contextType === 'webgl' || contextType === 'experimental-webgl') {
        dynaDbgState.webglContexts.push({
          canvas: this,
          context: context,
          type: 'webgl'
        });
        hookWebGLContext(context, 'webgl');
        
        window.postMessage({
          type: "DYNADBG_WEBGL_CONTEXT",
          contextType: 'webgl'
        }, '*');
      } else if (contextType === 'webgl2') {
        dynaDbgState.webgl2Contexts.push({
          canvas: this,
          context: context,
          type: 'webgl2'
        });
        hookWebGLContext(context, 'webgl2');
        
        window.postMessage({
          type: "DYNADBG_WEBGL_CONTEXT",
          contextType: 'webgl2'
        }, '*');
      }
    }

    return context;
  };

  function hookWebGLContext(gl, type) {
    // Hook shader compilation for debugging
    const originalShaderSource = gl.shaderSource;
    const originalCompileShader = gl.compileShader;
    const originalCreateProgram = gl.createProgram;
    const originalLinkProgram = gl.linkProgram;
    const originalDrawArrays = gl.drawArrays;
    const originalDrawElements = gl.drawElements;

    gl.shaderSource = function(shader, source) {
      shader.__dynaDbgSource = source;
      return originalShaderSource.call(this, shader, source);
    };

    gl.compileShader = function(shader) {
      const result = originalCompileShader.call(this, shader);
      if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
        console.warn("[DynaDbg] Shader compilation failed:", this.getShaderInfoLog(shader));
      }
      return result;
    };

    gl.createProgram = function() {
      const program = originalCreateProgram.call(this);
      program.__dynaDbgId = 'prog_' + Date.now();
      return program;
    };

    gl.linkProgram = function(program) {
      const result = originalLinkProgram.call(this, program);
      if (!this.getProgramParameter(program, this.LINK_STATUS)) {
        console.warn("[DynaDbg] Program linking failed:", this.getProgramInfoLog(program));
      }
      return result;
    };

    // Track draw calls (optional, can be verbose)
    let drawCallCount = 0;
    gl.drawArrays = function(mode, first, count) {
      drawCallCount++;
      return originalDrawArrays.call(this, mode, first, count);
    };

    gl.drawElements = function(mode, count, type, offset) {
      drawCallCount++;
      return originalDrawElements.call(this, mode, count, type, offset);
    };

    // Expose draw call counter
    gl.__dynaDbgGetDrawCallCount = () => drawCallCount;
    gl.__dynaDbgResetDrawCallCount = () => { drawCallCount = 0; };
  }

  // ============================================================================
  // OffscreenCanvas Support (for Workers)
  // ============================================================================

  if (typeof OffscreenCanvas !== 'undefined') {
    const originalOffscreenGetContext = OffscreenCanvas.prototype.getContext;

    OffscreenCanvas.prototype.getContext = function(contextType, contextAttributes) {
      const context = originalOffscreenGetContext.call(this, contextType, contextAttributes);

      if (context && (contextType === 'webgl' || contextType === 'webgl2')) {
        hookWebGLContext(context, contextType);
      }

      return context;
    };
  }

  // ============================================================================
  // Memory Operations (called from content script)
  // ============================================================================

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.type) return;

    const data = event.data;

    switch (data.type) {
      case "DYNADBG_READ_MEMORY":
        handleReadMemory(data);
        break;

      case "DYNADBG_WRITE_MEMORY":
        handleWriteMemory(data);
        break;

      case "DYNADBG_TAKE_SNAPSHOT":
        handleTakeSnapshot(data);
        break;
    }
  });

  function handleReadMemory(data) {
    try {
      if (!dynaDbgState.wasmMemory) {
        window.postMessage({
          type: "DYNADBG_READ_RESPONSE",
          id: data.id,
          success: false,
          error: "No WASM memory available"
        }, '*');
        return;
      }

      const buffer = dynaDbgState.wasmMemory.buffer;
      const addr = data.address || 0;
      const size = Math.min(data.size || 256, buffer.byteLength - addr);

      if (addr < 0 || addr >= buffer.byteLength) {
        window.postMessage({
          type: "DYNADBG_READ_RESPONSE",
          id: data.id,
          success: false,
          error: "Address out of bounds"
        }, '*');
        return;
      }

      const view = new Uint8Array(buffer, addr, size);
      const copy = Array.from(view);

      window.postMessage({
        type: "DYNADBG_READ_RESPONSE",
        id: data.id,
        success: true,
        data: copy
      }, '*');
    } catch (e) {
      window.postMessage({
        type: "DYNADBG_READ_RESPONSE",
        id: data.id,
        success: false,
        error: e.message
      }, '*');
    }
  }

  function handleWriteMemory(data) {
    try {
      if (!dynaDbgState.wasmMemory) {
        window.postMessage({
          type: "DYNADBG_WRITE_RESPONSE",
          id: data.id,
          success: false,
          error: "No WASM memory available"
        }, '*');
        return;
      }

      const buffer = dynaDbgState.wasmMemory.buffer;
      const addr = data.address || 0;
      const bytes = data.data || [];

      if (addr < 0 || addr + bytes.length > buffer.byteLength) {
        window.postMessage({
          type: "DYNADBG_WRITE_RESPONSE",
          id: data.id,
          success: false,
          error: "Address out of bounds"
        }, '*');
        return;
      }

      const view = new Uint8Array(buffer, addr, bytes.length);
      view.set(bytes);

      window.postMessage({
        type: "DYNADBG_WRITE_RESPONSE",
        id: data.id,
        success: true
      }, '*');
    } catch (e) {
      window.postMessage({
        type: "DYNADBG_WRITE_RESPONSE",
        id: data.id,
        success: false,
        error: e.message
      }, '*');
    }
  }

  function handleTakeSnapshot(data) {
    try {
      if (!dynaDbgState.wasmMemory) {
        window.postMessage({
          type: "DYNADBG_SNAPSHOT_RESPONSE",
          id: data.id,
          success: false,
          error: "No WASM memory available"
        }, '*');
        return;
      }

      const buffer = dynaDbgState.wasmMemory.buffer;
      const copy = Array.from(new Uint8Array(buffer));

      window.postMessage({
        type: "DYNADBG_SNAPSHOT_RESPONSE",
        id: data.id,
        success: true,
        data: copy
      }, '*');
    } catch (e) {
      window.postMessage({
        type: "DYNADBG_SNAPSHOT_RESPONSE",
        id: data.id,
        success: false,
        error: e.message
      }, '*');
    }
  }

  // ============================================================================
  // Memory Growth Detection
  // ============================================================================

  // Periodically check for memory growth
  let lastHeapSize = 0;
  setInterval(() => {
    const currentSize = getHeapSize();
    if (currentSize !== lastHeapSize && currentSize > 0) {
      lastHeapSize = currentSize;
      window.postMessage({
        type: "DYNADBG_HEAP_UPDATE",
        heapSize: currentSize
      }, '*');
    }
  }, 1000);

})();
