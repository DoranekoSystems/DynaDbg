// ============================================================================
// DynaDbg WASM Bridge - Popup Script
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
  const serverUrlInput = document.getElementById('serverUrl');
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const statusConnection = document.getElementById('statusConnection');
  const statusBinary = document.getElementById('statusBinary');
  const statusCodeSize = document.getElementById('statusCodeSize');
  const statusHeapSize = document.getElementById('statusHeapSize');
  const statusSymbols = document.getElementById('statusSymbols');

  let lastStatus = null;

  // Load saved settings
  chrome.storage.local.get(['serverUrl'], (result) => {
    if (result.serverUrl) {
      serverUrlInput.value = result.serverUrl;
    }
  });

  // Update status display
  function updateStatus(status) {
    if (!status) return;
    
    // Only update if status actually changed (prevent flickering)
    const statusKey = JSON.stringify(status);
    if (lastStatus === statusKey) return;
    lastStatus = statusKey;

    if (status.connected) {
      statusConnection.innerHTML = '<span class="indicator indicator-on"></span>Connected';
      statusConnection.className = 'status-value status-connected';
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
    } else {
      statusConnection.innerHTML = '<span class="indicator indicator-off"></span>Disconnected';
      statusConnection.className = 'status-value status-disconnected';
      btnConnect.disabled = false;
      btnDisconnect.disabled = true;
    }

    if (status.hasBinary) {
      statusBinary.textContent = 'Captured';
      statusBinary.className = 'status-value status-connected';
    } else {
      statusBinary.textContent = 'Not Captured';
      statusBinary.className = 'status-value status-disconnected';
    }

    statusCodeSize.textContent = formatBytes(status.codeSize || 0);
    statusHeapSize.textContent = formatBytes(status.heapSize || 0);
    statusSymbols.textContent = (status.symbolCount || 0).toString();
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 bytes';
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // Get current status
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: 'DYNADBG_GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log("[DynaDbg] Status check error:", chrome.runtime.lastError);
        return;
      }
      if (response) {
        updateStatus(response);
      }
    });
  }

  // Connect button
  btnConnect.addEventListener('click', () => {
    const url = serverUrlInput.value.trim();
    if (url) {
      btnConnect.disabled = true;
      btnConnect.textContent = 'Connecting...';
      chrome.storage.local.set({ serverUrl: url });
      chrome.runtime.sendMessage({ type: 'DYNADBG_CONNECT', url: url }, () => {
        setTimeout(() => {
          btnConnect.textContent = 'Connect';
          refreshStatus();
        }, 1000);
      });
    }
  });

  // Disconnect button
  btnDisconnect.addEventListener('click', () => {
    btnDisconnect.disabled = true;
    chrome.runtime.sendMessage({ type: 'DYNADBG_DISCONNECT' }, () => {
      setTimeout(() => {
        btnDisconnect.disabled = false;
        refreshStatus();
      }, 500);
    });
  });

  // Listen for status updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'DYNADBG_STATUS') {
      updateStatus(message);
    }
  });

  // Initial status refresh
  refreshStatus();

  // Periodic refresh
  setInterval(refreshStatus, 2000);
});
