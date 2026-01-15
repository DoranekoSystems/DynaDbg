// ============================================================================
// DynaDbg WASM Bridge - Content Script (Manifest V3)
// Injects the hook script into page context
// ============================================================================

(function() {
  'use strict';

  // Inject the main hook script into the page context
  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // Inject as early as possible
  injectScript();

  // ============================================================================
  // Message Bridge: Page Context <-> Background Service Worker
  // ============================================================================

  // Listen for messages from injected script (page context)
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.type) return;

    const data = event.data;

    switch (data.type) {
      case "DYNADBG_WASM_INIT":
        // Forward WASM init to background
        chrome.runtime.sendMessage({
          type: "DYNADBG_WASM_INIT",
          binary: data.binary,
          codeSize: data.codeSize,
          heapSize: data.heapSize,
          symbols: data.symbols,
          exports: data.exports
        });
        break;

      case "DYNADBG_HEAP_UPDATE":
        chrome.runtime.sendMessage({
          type: "DYNADBG_HEAP_UPDATE",
          heapSize: data.heapSize
        });
        break;

      case "DYNADBG_WEBGL_CONTEXT":
        chrome.runtime.sendMessage({
          type: "DYNADBG_WEBGL_CONTEXT",
          contextType: data.contextType
        });
        break;
    }
  });

  // ============================================================================
  // Handle requests from background service worker
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case "DYNADBG_READ_MEMORY":
        // Forward to page context and wait for response
        const readId = 'read_' + Date.now() + '_' + Math.random();
        
        const readHandler = function(event) {
          if (event.data && event.data.type === "DYNADBG_READ_RESPONSE" && event.data.id === readId) {
            window.removeEventListener('message', readHandler);
            sendResponse(event.data);
          }
        };
        window.addEventListener('message', readHandler);
        
        window.postMessage({
          type: "DYNADBG_READ_MEMORY",
          id: readId,
          address: message.address,
          size: message.size
        }, '*');
        
        // Timeout after 5 seconds
        setTimeout(() => {
          window.removeEventListener('message', readHandler);
        }, 5000);
        
        return true; // Keep channel open
        
      case "DYNADBG_WRITE_MEMORY":
        const writeId = 'write_' + Date.now() + '_' + Math.random();
        
        const writeHandler = function(event) {
          if (event.data && event.data.type === "DYNADBG_WRITE_RESPONSE" && event.data.id === writeId) {
            window.removeEventListener('message', writeHandler);
            sendResponse(event.data);
          }
        };
        window.addEventListener('message', writeHandler);
        
        window.postMessage({
          type: "DYNADBG_WRITE_MEMORY",
          id: writeId,
          address: message.address,
          data: message.data
        }, '*');
        
        setTimeout(() => {
          window.removeEventListener('message', writeHandler);
        }, 5000);
        
        return true;

      case "DYNADBG_TAKE_SNAPSHOT":
        const snapId = 'snap_' + Date.now() + '_' + Math.random();
        
        const snapHandler = function(event) {
          if (event.data && event.data.type === "DYNADBG_SNAPSHOT_RESPONSE" && event.data.id === snapId) {
            window.removeEventListener('message', snapHandler);
            sendResponse(event.data);
          }
        };
        window.addEventListener('message', snapHandler);
        
        window.postMessage({
          type: "DYNADBG_TAKE_SNAPSHOT",
          id: snapId
        }, '*');
        
        setTimeout(() => {
          window.removeEventListener('message', snapHandler);
        }, 10000);
        
        return true;
    }
  });

  console.log("[DynaDbg] Content script loaded");
})();
