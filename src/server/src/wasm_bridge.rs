//! WASM Bridge Module
//! 
//! This module provides a WebSocket server for browser WASM instances
//! to connect and handle memory read/write operations.
//! 
//! Inspired by Cetus (https://github.com/Qwokka/cetus), this module supports:
//! - Initial memory snapshot storage for comparison/analysis
//! - Symbol extraction from WASM instrumentation
//! - Multiple memory regions (live heap + initial snapshot)

#![allow(dead_code)]

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// Global WASM bridge instance
static WASM_BRIDGE: OnceLock<Arc<WasmBridge>> = OnceLock::new();

/// Request ID counter for tracking responses
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// WASM signature received from browser (64 bytes)
static WASM_SIGNATURE: OnceLock<RwLock<Option<Vec<u8>>>> = OnceLock::new();

/// WASM heap size received from browser
static WASM_HEAP_SIZE: AtomicUsize = AtomicUsize::new(0);

/// Base address where WASM signature was found in native process memory
static WASM_BASE_ADDRESS: AtomicUsize = AtomicUsize::new(0);

// ============================================================================
// Cetus-style Initial Snapshot and Symbol Storage
// ============================================================================

/// Initial memory snapshot taken at WASM instance initialization
/// This allows comparison between initial and current state (Cetus-style)
static WASM_INITIAL_SNAPSHOT: OnceLock<RwLock<Option<WasmMemorySnapshot>>> = OnceLock::new();

/// WASM symbols extracted from instrumentation (Cetus-style)
static WASM_SYMBOLS: OnceLock<RwLock<Vec<WasmSymbol>>> = OnceLock::new();

/// WASM module info for the instrumented module
static WASM_MODULE_INFO: OnceLock<RwLock<Option<WasmModuleInfo>>> = OnceLock::new();

/// Represents a memory snapshot of the WASM heap
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmMemorySnapshot {
    /// The snapshot data
    pub data: Vec<u8>,
    /// Size of the snapshot
    pub size: usize,
    /// Timestamp when snapshot was taken
    pub timestamp: u64,
    /// Description/label for this snapshot
    pub label: String,
}

/// WASM symbol information (from instrumentation like Cetus)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmSymbol {
    /// Function index in the WASM module
    pub index: u32,
    /// Symbol name (e.g., "_wp_config0", "_wp_read", "_wp_write")
    pub name: String,
    /// Symbol type (function, global, etc.)
    pub symbol_type: WasmSymbolType,
    /// Address/offset in the module
    pub address: usize,
    /// Size of the symbol (for functions, this is the code size)
    pub size: usize,
}

/// Types of WASM symbols
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WasmSymbolType {
    Function,
    Global,
    Table,
    Memory,
    Export,
    Import,
}

/// WASM module information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmModuleInfo {
    /// Module name/identifier
    pub name: String,
    /// Base address (always 0 for WASM linear memory)
    pub base: usize,
    /// Size of the module's linear memory
    pub size: usize,
    /// Size of the WASM binary (code region)
    pub code_size: usize,
    /// Whether the module has been instrumented
    pub instrumented: bool,
    /// Number of watchpoints configured
    pub watchpoint_count: usize,
    /// Whether the WASM binary has been captured
    pub has_binary: bool,
    /// Additional metadata
    pub metadata: HashMap<String, String>,
}

/// Memory region descriptor for WASM mode
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmMemoryRegion {
    /// Region name/identifier
    pub name: String,
    /// Start address
    pub start: usize,
    /// End address
    pub end: usize,
    /// Protection flags (e.g., "rw-")
    pub protection: String,
    /// Region type
    pub region_type: WasmRegionType,
}

/// Types of WASM memory regions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WasmRegionType {
    /// Live linear memory (heap)
    LinearMemory,
    /// Initial snapshot (frozen at initialization)
    InitialSnapshot,
    /// WASM binary code region
    CodeRegion,
}

/// Whether base address has been found
static WASM_BASE_FOUND: OnceLock<RwLock<bool>> = OnceLock::new();

/// WASM code region (binary) storage
static WASM_CODE_REGION: OnceLock<RwLock<Option<Vec<u8>>>> = OnceLock::new();

/// WASM code size received from browser
static WASM_CODE_SIZE: AtomicUsize = AtomicUsize::new(0);

/// Command sent to the WASM WebSocket client (browser)
#[derive(Serialize, Debug, Clone)]
struct WasmCommand {
    id: u64,
    command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<String>,
}

/// Response from WASM WebSocket client (browser)
#[derive(Deserialize, Debug)]
struct WasmResponse {
    id: Option<u64>,
    message: Option<serde_json::Value>,
    // Error field for failed operations
    error: Option<String>,
    // For init_signature message
    command: Option<String>,
    signature: Option<String>,
    heap_size: Option<usize>,
    // Cetus-style: symbols from instrumentation
    symbols: Option<serde_json::Value>,
    // Cetus-style: module info
    module_name: Option<String>,
    instrumented: Option<bool>,
    watchpoint_count: Option<usize>,
    // Cetus-style: code region info
    code_size: Option<usize>,
    has_binary: Option<bool>,
}

/// Response data types
#[derive(Debug)]
pub enum WasmResponseData {
    HeapSize(usize),
    Memory(Vec<u8>),
    WriteResult(bool),
    Error(String),
}

/// Pending request waiting for response
struct PendingRequest {
    response_tx: oneshot::Sender<WasmResponseData>,
}

/// WASM Bridge WebSocket Server
pub struct WasmBridge {
    /// Channel to send commands to connected browser client
    command_tx: mpsc::Sender<WasmCommand>,
    /// Pending requests waiting for responses
    pending_requests: Arc<RwLock<HashMap<u64, PendingRequest>>>,
    /// Whether a browser client is connected
    connected: Arc<RwLock<bool>>,
}

impl WasmBridge {
    /// Create a new WASM bridge and start the WebSocket server
    pub async fn new(port: u16) -> Result<Arc<Self>, String> {
        let addr = format!("0.0.0.0:{}", port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind WebSocket server: {}", e))?;
        
        log::info!("WASM Bridge WebSocket server listening on {}", addr);
        
        let (command_tx, command_rx) = mpsc::channel::<WasmCommand>(100);
        let pending_requests: Arc<RwLock<HashMap<u64, PendingRequest>>> = 
            Arc::new(RwLock::new(HashMap::new()));
        let connected = Arc::new(RwLock::new(false));
        
        let bridge = Arc::new(Self {
            command_tx,
            pending_requests: pending_requests.clone(),
            connected: connected.clone(),
        });
        
        // Spawn the WebSocket server task
        let pending_clone = pending_requests.clone();
        let connected_clone = connected.clone();
        tokio::spawn(async move {
            Self::run_server(listener, command_rx, pending_clone, connected_clone).await;
        });
        
        Ok(bridge)
    }

    /// Run the WebSocket server
    async fn run_server(
        listener: TcpListener,
        mut command_rx: mpsc::Receiver<WasmCommand>,
        pending_requests: Arc<RwLock<HashMap<u64, PendingRequest>>>,
        connected: Arc<RwLock<bool>>,
    ) {
        // We only handle one browser connection at a time
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    log::info!("WASM Bridge: Browser connected from {}", addr);
                    *connected.write().await = true;
                    
                    // Handle the connection
                    Self::handle_connection(
                        stream, 
                        &mut command_rx, 
                        pending_requests.clone(),
                    ).await;
                    
                    *connected.write().await = false;
                    log::info!("WASM Bridge: Browser disconnected");
                }
                Err(e) => {
                    log::error!("WASM Bridge: Failed to accept connection: {}", e);
                }
            }
        }
    }
    
    /// Handle a single WebSocket connection from a browser
    async fn handle_connection(
        stream: TcpStream,
        command_rx: &mut mpsc::Receiver<WasmCommand>,
        pending_requests: Arc<RwLock<HashMap<u64, PendingRequest>>>,
    ) {
        let ws_stream = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                log::error!("WASM Bridge: WebSocket handshake failed: {}", e);
                return;
            }
        };
        
        let (mut write, mut read) = ws_stream.split();
        
        loop {
            tokio::select! {
                // Handle incoming messages from browser
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            // Try to parse as JSON
                            if let Ok(response) = serde_json::from_str::<WasmResponse>(&text) {
                                // Check if this is an init_signature message
                                if let Some(cmd) = &response.command {
                                    if cmd == "init_signature" {
                                        if let Some(sig_hex) = &response.signature {
                                            if let Ok(sig_bytes) = hex::decode(sig_hex) {
                                                set_wasm_signature(sig_bytes);
                                                if let Some(heap_size) = response.heap_size {
                                                    WASM_HEAP_SIZE.store(heap_size, Ordering::SeqCst);
                                                }
                                            }
                                        }
                                        
                                        // Cetus-style: Process symbols from instrumentation
                                        if let Some(symbols) = &response.symbols {
                                            if let Err(e) = add_symbols_from_json(symbols) {
                                                log::warn!("WASM Bridge: Failed to parse symbols: {}", e);
                                            }
                                        }
                                        
                                        // Cetus-style: Store code size
                                        if let Some(code_size) = response.code_size {
                                            WASM_CODE_SIZE.store(code_size, Ordering::SeqCst);
                                        }
                                        
                                        // Cetus-style: Set module info
                                        let heap_size = response.heap_size.unwrap_or(0);
                                        let code_size = response.code_size.unwrap_or(0);
                                        let module_info = WasmModuleInfo {
                                            name: response.module_name.clone().unwrap_or_else(|| "wasm".to_string()),
                                            base: 0,
                                            size: heap_size,
                                            code_size,
                                            instrumented: response.instrumented.unwrap_or(true),
                                            watchpoint_count: response.watchpoint_count.unwrap_or(0),
                                            has_binary: response.has_binary.unwrap_or(code_size > 0),
                                            metadata: HashMap::new(),
                                        };
                                        set_wasm_module_info(module_info);
                                        
                                        continue;
                                    }
                                }
                                
                                // Regular response with id
                                if let Some(id) = response.id {
                                    let mut pending = pending_requests.write().await;
                                    if let Some(req) = pending.remove(&id) {
                                        // Check for error field first
                                        if let Some(ref error) = response.error {
                                            let _ = req.response_tx.send(WasmResponseData::Error(error.clone()));
                                        } else {
                                            let data = match &response.message {
                                                Some(serde_json::Value::Number(n)) => {
                                                    WasmResponseData::HeapSize(n.as_u64().unwrap_or(0) as usize)
                                                }
                                                Some(serde_json::Value::Bool(b)) => {
                                                    if *b {
                                                        WasmResponseData::WriteResult(true)
                                                    } else {
                                                        WasmResponseData::Error("Operation failed".to_string())
                                                    }
                                                }
                                                _ => WasmResponseData::Error("Unexpected response format".to_string()),
                                            };
                                            let _ = req.response_tx.send(data);
                                        }
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Binary(data))) => {
                            // Binary memory read response - find the oldest pending read request
                            let mut pending = pending_requests.write().await;
                            // Get the smallest ID (oldest request)
                            if let Some(&id) = pending.keys().min() {
                                if let Some(req) = pending.remove(&id) {
                                    let _ = req.response_tx.send(WasmResponseData::Memory(data));
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            return;
                        }
                        Some(Err(e)) => {
                            log::error!("WASM Bridge: WebSocket error: {}", e);
                            return;
                        }
                        _ => {}
                    }
                }
                
                // Handle outgoing commands to browser
                cmd = command_rx.recv() => {
                    match cmd {
                        Some(cmd) => {
                            let json_cmd = serde_json::to_string(&cmd).unwrap();
                            if let Err(e) = write.send(Message::Text(json_cmd)).await {
                                log::error!("WASM Bridge: Failed to send command: {}", e);
                                return;
                            }
                        }
                        None => {
                            return;
                        }
                    }
                }
            }
        }
    }

    /// Send a command and wait for response
    async fn send_command(&self, cmd: WasmCommand) -> Result<WasmResponseData, String> {
        // Check if browser is connected
        if !*self.connected.read().await {
            return Err("No browser connected".to_string());
        }
        
        let id = cmd.id;
        let (response_tx, response_rx) = oneshot::channel();
        
        // Register pending request
        {
            let mut pending = self.pending_requests.write().await;
            pending.insert(id, PendingRequest { response_tx });
        }
        
        // Send command
        self.command_tx
            .send(cmd)
            .await
            .map_err(|e| format!("Failed to send command: {}", e))?;
        
        // Wait for response with timeout
        match tokio::time::timeout(tokio::time::Duration::from_secs(10), response_rx).await {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(_)) => {
                // Remove pending request on error
                self.pending_requests.write().await.remove(&id);
                Err("Response channel closed".to_string())
            }
            Err(_) => {
                // Remove pending request on timeout
                self.pending_requests.write().await.remove(&id);
                Err("Timeout waiting for response".to_string())
            }
        }
    }

    /// Get the heap size from the WASM instance
    pub async fn get_heap_size(&self) -> Result<usize, String> {
        let cmd = WasmCommand {
            id: REQUEST_ID.fetch_add(1, Ordering::SeqCst),
            command: "get_heap_size".to_string(),
            address: None,
            size: None,
            bytes: None,
        };
        
        match self.send_command(cmd).await? {
            WasmResponseData::HeapSize(size) => Ok(size),
            WasmResponseData::Error(e) => Err(e),
            _ => Err("Unexpected response type".to_string()),
        }
    }

    /// Read memory from the WASM instance
    pub async fn read_memory(&self, address: usize, size: usize) -> Result<Vec<u8>, String> {
        let cmd = WasmCommand {
            id: REQUEST_ID.fetch_add(1, Ordering::SeqCst),
            command: "read_memory".to_string(),
            address: Some(address),
            size: Some(size),
            bytes: None,
        };
        
        match self.send_command(cmd).await? {
            WasmResponseData::Memory(data) => Ok(data),
            WasmResponseData::Error(e) => Err(e),
            _ => Err("Unexpected response type".to_string()),
        }
    }

    /// Write memory to the WASM instance
    pub async fn write_memory(&self, address: usize, data: &[u8]) -> Result<bool, String> {
        let hex_bytes = hex::encode(data);
        let cmd = WasmCommand {
            id: REQUEST_ID.fetch_add(1, Ordering::SeqCst),
            command: "write_memory".to_string(),
            address: Some(address),
            size: None,
            bytes: Some(hex_bytes),
        };
        
        match self.send_command(cmd).await? {
            WasmResponseData::WriteResult(success) => Ok(success),
            WasmResponseData::Error(e) => Err(e),
            _ => Err("Unexpected response type".to_string()),
        }
    }

    /// Read code (WASM binary) from the browser
    /// Offset is relative to the start of the WASM binary
    pub async fn read_code(&self, offset: usize, size: usize) -> Result<Vec<u8>, String> {
        let cmd = WasmCommand {
            id: REQUEST_ID.fetch_add(1, Ordering::SeqCst),
            command: "read_code".to_string(),
            address: Some(offset),
            size: Some(size),
            bytes: None,
        };
        
        match self.send_command(cmd).await? {
            WasmResponseData::Memory(data) => Ok(data),
            WasmResponseData::Error(e) => Err(e),
            _ => Err("Unexpected response type".to_string()),
        }
    }

    /// Check if a browser client is connected
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }
}

/// Check if WASM mode is enabled
pub fn is_wasm_mode() -> bool {
    std::env::var("DBGSRV_RUNNING_MODE")
        .map(|v| v == "wasm")
        .unwrap_or(false)
}

/// Get the WASM WebSocket port from environment
pub fn get_wasm_ws_port() -> u16 {
    std::env::var("DBGSRV_WASM_WS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8765)
}

/// Initialize the global WASM bridge (call this at startup if in WASM mode)
pub async fn init_wasm_bridge() -> Result<(), String> {
    if !is_wasm_mode() {
        return Ok(());
    }
    
    let port = get_wasm_ws_port();
    let bridge = WasmBridge::new(port).await?;
    
    WASM_BRIDGE
        .set(bridge)
        .map_err(|_| "WASM bridge already initialized".to_string())?;
    
    log::info!("WASM bridge initialized on port {}", port);
    Ok(())
}

/// Get the global WASM bridge instance
pub fn get_wasm_bridge() -> Option<Arc<WasmBridge>> {
    WASM_BRIDGE.get().cloned()
}

/// Async memory read for WASM - handles all region types (heap, code, snapshot)
pub async fn read_wasm_memory_async(address: usize, size: usize) -> Result<Vec<u8>, String> {
    if address >= SNAPSHOT_REGION_BASE {
        // Reading from snapshot region (>= 0x80000000)
        let snapshot_offset = address - SNAPSHOT_REGION_BASE;
        read_initial_snapshot(snapshot_offset, size)
    } else if address >= CODE_REGION_BASE {
        // Reading from code region (0x40000000 - 0x80000000)
        let code_offset = address - CODE_REGION_BASE;
        if let Some(bridge) = get_wasm_bridge() {
            bridge.read_code(code_offset, size).await
        } else {
            Err("WASM bridge not initialized".to_string())
        }
    } else {
        // Reading from live heap (0x0 - 0x40000000)
        if let Some(bridge) = get_wasm_bridge() {
            bridge.read_memory(address, size).await
        } else {
            Err("WASM bridge not initialized".to_string())
        }
    }
}

/// Async wrapper for writing WASM memory
pub async fn write_wasm_memory_async(address: usize, data: &[u8]) -> Result<bool, String> {
    if let Some(bridge) = get_wasm_bridge() {
        bridge.write_memory(address, data).await
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

/// Async wrapper for getting WASM heap size
pub async fn get_wasm_heap_size_async() -> Result<usize, String> {
    if let Some(bridge) = get_wasm_bridge() {
        bridge.get_heap_size().await
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

/// Synchronous wrapper for reading WASM memory (blocking)
/// Uses current tokio runtime handle - works from async context or main thread
pub fn read_wasm_memory_sync(address: usize, size: usize) -> Result<Vec<u8>, String> {
    if let Some(bridge) = get_wasm_bridge() {
        // Use tokio's Handle to run async code from sync context
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "No tokio runtime available".to_string())?;
        
        // Use spawn_blocking to avoid blocking the async runtime
        std::thread::scope(|s| {
            s.spawn(|| {
                handle.block_on(async {
                    bridge.read_memory(address, size).await
                })
            }).join().unwrap()
        })
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

/// Synchronous wrapper for reading WASM memory with explicit handle
/// Use this version when calling from rayon/thread pool where tokio runtime is not available
pub fn read_wasm_memory_sync_with_handle(
    address: usize, 
    size: usize, 
    handle: &tokio::runtime::Handle
) -> Result<Vec<u8>, String> {
    if let Some(bridge) = get_wasm_bridge() {
        std::thread::scope(|s| {
            s.spawn(|| {
                handle.block_on(async {
                    bridge.read_memory(address, size).await
                })
            }).join().unwrap()
        })
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

/// Synchronous wrapper for reading WASM code (binary) region (blocking)
pub fn read_wasm_code_sync(offset: usize, size: usize) -> Result<Vec<u8>, String> {
    if let Some(bridge) = get_wasm_bridge() {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "No tokio runtime available".to_string())?;
        
        std::thread::scope(|s| {
            s.spawn(|| {
                handle.block_on(async {
                    bridge.read_code(offset, size).await
                })
            }).join().unwrap()
        })
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

/// Synchronous wrapper for writing WASM memory (blocking)
pub fn write_wasm_memory_sync(address: usize, data: &[u8]) -> Result<bool, String> {
    if let Some(bridge) = get_wasm_bridge() {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "No tokio runtime available".to_string())?;
        
        let data = data.to_vec();
        std::thread::scope(|s| {
            s.spawn(|| {
                handle.block_on(async {
                    bridge.write_memory(address, &data).await
                })
            }).join().unwrap()
        })
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

/// Get WASM heap size synchronously
pub fn get_wasm_heap_size_sync() -> Result<usize, String> {
    if let Some(bridge) = get_wasm_bridge() {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "No tokio runtime available".to_string())?;
        
        std::thread::scope(|s| {
            s.spawn(|| {
                handle.block_on(async {
                    bridge.get_heap_size().await
                })
            }).join().unwrap()
        })
    } else {
        Err("WASM bridge not initialized".to_string())
    }
}

// ============================================================================
// Signature and Base Address Management
// ============================================================================

fn get_signature_lock() -> &'static RwLock<Option<Vec<u8>>> {
    WASM_SIGNATURE.get_or_init(|| RwLock::new(None))
}

fn get_base_found_lock() -> &'static RwLock<bool> {
    WASM_BASE_FOUND.get_or_init(|| RwLock::new(false))
}

/// Store the WASM signature received from browser
pub fn set_wasm_signature(signature: Vec<u8>) {
    let lock = get_signature_lock();
    if let Ok(mut guard) = lock.try_write() {
        *guard = Some(signature);
    }
}

/// Get the stored WASM signature
pub fn get_wasm_signature() -> Option<Vec<u8>> {
    let lock = get_signature_lock();
    if let Ok(guard) = lock.try_read() {
        guard.clone()
    } else {
        None
    }
}

/// Check if WASM signature is available
pub fn has_wasm_signature() -> bool {
    get_wasm_signature().is_some()
}

/// Get the cached WASM heap size
pub fn get_cached_wasm_heap_size() -> usize {
    WASM_HEAP_SIZE.load(Ordering::SeqCst)
}

/// Set the WASM base address (where signature was found in native memory)
pub fn set_wasm_base_address(address: usize) {
    WASM_BASE_ADDRESS.store(address, Ordering::SeqCst);
    if let Ok(mut guard) = get_base_found_lock().try_write() {
        *guard = true;
    }
}

/// Get the WASM base address
pub fn get_wasm_base_address() -> usize {
    WASM_BASE_ADDRESS.load(Ordering::SeqCst)
}

/// Check if WASM base address has been found
pub fn is_wasm_base_found() -> bool {
    if let Ok(guard) = get_base_found_lock().try_read() {
        *guard
    } else {
        false
    }
}

/// Clear the WASM base address (for reattaching)
pub fn clear_wasm_base_address() {
    WASM_BASE_ADDRESS.store(0, Ordering::SeqCst);
    if let Ok(mut guard) = get_base_found_lock().try_write() {
        *guard = false;
    }
}

/// Convert a WASM virtual address to native process address
/// In WASM mode, address 0 in WASM corresponds to base_address in native memory
pub fn wasm_to_native_address(wasm_address: usize) -> usize {
    if is_wasm_mode() && is_wasm_base_found() {
        get_wasm_base_address() + wasm_address
    } else {
        wasm_address
    }
}

/// Convert a native process address to WASM virtual address
pub fn native_to_wasm_address(native_address: usize) -> usize {
    if is_wasm_mode() && is_wasm_base_found() {
        let base = get_wasm_base_address();
        if native_address >= base {
            native_address - base
        } else {
            native_address
        }
    } else {
        native_address
    }
}

// ============================================================================
// Cetus-style Initial Snapshot Management
// ============================================================================

fn get_snapshot_lock() -> &'static RwLock<Option<WasmMemorySnapshot>> {
    WASM_INITIAL_SNAPSHOT.get_or_init(|| RwLock::new(None))
}

fn get_symbols_lock() -> &'static RwLock<Vec<WasmSymbol>> {
    WASM_SYMBOLS.get_or_init(|| RwLock::new(Vec::new()))
}

fn get_module_info_lock() -> &'static RwLock<Option<WasmModuleInfo>> {
    WASM_MODULE_INFO.get_or_init(|| RwLock::new(None))
}

/// Take a snapshot of the current WASM memory and store it as the initial state
/// This is called at WASM instance initialization (Cetus-style)
pub async fn take_initial_snapshot(label: Option<String>) -> Result<(), String> {
    let bridge = get_wasm_bridge()
        .ok_or_else(|| "WASM bridge not initialized".to_string())?;
    
    let heap_size = bridge.get_heap_size().await?;
    
    if heap_size == 0 {
        return Err("Heap size is 0, cannot take snapshot".to_string());
    }
    
    let data = bridge.read_memory(0, heap_size).await?;
    
    let snapshot = WasmMemorySnapshot {
        data,
        size: heap_size,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        label: label.unwrap_or_else(|| "initial".to_string()),
    };
    
    if let Ok(mut guard) = get_snapshot_lock().try_write() {
        *guard = Some(snapshot);
        Ok(())
    } else {
        Err("Failed to acquire snapshot lock".to_string())
    }
}

/// Take a snapshot synchronously (blocking)
pub fn take_initial_snapshot_sync(label: Option<String>) -> Result<(), String> {
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| "No tokio runtime available".to_string())?;
    
    std::thread::scope(|s| {
        s.spawn(|| {
            handle.block_on(async {
                take_initial_snapshot(label).await
            })
        }).join().unwrap()
    })
}

/// Check if an initial snapshot exists
pub fn has_initial_snapshot() -> bool {
    if let Ok(guard) = get_snapshot_lock().try_read() {
        guard.is_some()
    } else {
        false
    }
}

/// Get the initial snapshot size
pub fn get_initial_snapshot_size() -> Option<usize> {
    if let Ok(guard) = get_snapshot_lock().try_read() {
        guard.as_ref().map(|s| s.size)
    } else {
        None
    }
}

/// Read from the initial snapshot (for comparison with current state)
pub fn read_initial_snapshot(address: usize, size: usize) -> Result<Vec<u8>, String> {
    let guard = get_snapshot_lock()
        .try_read()
        .map_err(|_| "Failed to acquire snapshot lock".to_string())?;
    
    let snapshot = guard.as_ref()
        .ok_or_else(|| "No initial snapshot available".to_string())?;
    
    if address + size > snapshot.size {
        return Err(format!(
            "Read out of bounds: address={}, size={}, snapshot_size={}",
            address, size, snapshot.size
        ));
    }
    
    Ok(snapshot.data[address..address + size].to_vec())
}

/// Clear the initial snapshot
pub fn clear_initial_snapshot() {
    if let Ok(mut guard) = get_snapshot_lock().try_write() {
        *guard = None;
    }
}

/// Get snapshot metadata
pub fn get_snapshot_info() -> Option<(usize, u64, String)> {
    if let Ok(guard) = get_snapshot_lock().try_read() {
        guard.as_ref().map(|s| (s.size, s.timestamp, s.label.clone()))
    } else {
        None
    }
}

// ============================================================================
// Cetus-style Symbol Management
// ============================================================================

/// Add a symbol from WASM instrumentation
pub fn add_wasm_symbol(symbol: WasmSymbol) {
    if let Ok(mut guard) = get_symbols_lock().try_write() {
        // Avoid duplicates
        if !guard.iter().any(|s| s.index == symbol.index && s.name == symbol.name) {
            guard.push(symbol);
        }
    }
}

/// Add symbols received from browser (JSON format from Cetus-style instrumentation)
/// Supports both array format (from Chrome extension) and object format (from legacy)
pub fn add_symbols_from_json(symbols_json: &serde_json::Value) -> Result<usize, String> {
    let mut count = 0;
    
    // Try array format first (Chrome extension style)
    if let Some(symbols_array) = symbols_json.as_array() {
        for (idx, symbol_value) in symbols_array.iter().enumerate() {
            if let Some(obj) = symbol_value.as_object() {
                let name = obj.get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let sym_type = obj.get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let address = obj.get("address")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(idx as u64) as usize;
                let size = obj.get("size")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                
                // Convert type string to enum (case-insensitive)
                let sym_type_lower = sym_type.to_lowercase();
                let symbol_type = match sym_type_lower.as_str() {
                    "function" => WasmSymbolType::Function,
                    "memory" => WasmSymbolType::Memory,
                    "table" => WasmSymbolType::Table,
                    "global" => WasmSymbolType::Global,
                    _ => WasmSymbolType::Export,
                };
                
                let symbol = WasmSymbol {
                    index: idx as u32,
                    name: name.to_string(),
                    symbol_type,
                    address,
                    size,
                };
                
                add_wasm_symbol(symbol);
                count += 1;
            }
        }
        
        return Ok(count);
    }
    
    // Try object format (legacy Cetus style: {"0": "funcName", "1": "funcName2", ...})
    if let Some(symbols_obj) = symbols_json.as_object() {
        for (index_str, name_value) in symbols_obj {
            let index: u32 = index_str.parse()
                .map_err(|_| format!("Invalid symbol index: {}", index_str))?;
            
            let name = name_value.as_str()
                .ok_or_else(|| format!("Symbol name must be a string: {}", name_value))?;
            
            let symbol = WasmSymbol {
                index,
                name: name.to_string(),
                symbol_type: if name.starts_with("_wp_") {
                    WasmSymbolType::Function
                } else {
                    WasmSymbolType::Export
                },
                address: index as usize,
                size: 0,
            };
            
            add_wasm_symbol(symbol);
            count += 1;
        }
        
        return Ok(count);
    }
    
    Err("Symbols must be a JSON array or object".to_string())
}

/// Get all WASM symbols
pub fn get_wasm_symbols() -> Vec<WasmSymbol> {
    if let Ok(guard) = get_symbols_lock().try_read() {
        guard.clone()
    } else {
        Vec::new()
    }
}

/// Get symbols as JSON for API response (compatible with native symbol format)
/// Only returns function symbols (belonging to wasm_code module)
/// Other symbol types (like globals) are not returned as they don't have meaningful addresses
pub fn get_wasm_symbols_json() -> Vec<serde_json::Value> {
    get_wasm_symbols()
        .into_iter()
        .filter(|s| s.symbol_type == WasmSymbolType::Function) // Only function symbols for wasm_code
        .map(|s| {
            // Function symbols get CODE_REGION_BASE offset
            let adjusted_address = CODE_REGION_BASE + s.address;
            serde_json::json!({
                "index": s.index,
                "name": s.name,
                "type": format!("{:?}", s.symbol_type),
                "address": format!("0x{:x}", adjusted_address),
                "size": s.size,
                // Add module_base for frontend compatibility (SymbolInfo interface)
                "module_base": format!("0x{:x}", CODE_REGION_BASE),
                "module_name": "wasm_code",
                "scope": "global",
            })
        })
        .collect()
}

/// Find symbol by name
pub fn find_symbol_by_name(name: &str) -> Option<WasmSymbol> {
    if let Ok(guard) = get_symbols_lock().try_read() {
        guard.iter().find(|s| s.name == name).cloned()
    } else {
        None
    }
}

/// Find symbol by function index
pub fn find_symbol_by_index(index: u32) -> Option<WasmSymbol> {
    if let Ok(guard) = get_symbols_lock().try_read() {
        guard.iter().find(|s| s.index == index).cloned()
    } else {
        None
    }
}

/// Clear all symbols
pub fn clear_wasm_symbols() {
    if let Ok(mut guard) = get_symbols_lock().try_write() {
        guard.clear();
    }
}

// ============================================================================
// Cetus-style Module Management
// ============================================================================

/// Set WASM module information
pub fn set_wasm_module_info(info: WasmModuleInfo) {
    if let Ok(mut guard) = get_module_info_lock().try_write() {
        *guard = Some(info);
    }
}

/// Get WASM module information
pub fn get_wasm_module_info() -> Option<WasmModuleInfo> {
    if let Ok(guard) = get_module_info_lock().try_read() {
        guard.clone()
    } else {
        None
    }
}

/// Get WASM modules as JSON for API response (compatible with enum_modules)
pub fn get_wasm_modules_json() -> Vec<serde_json::Value> {
    let heap_size = get_cached_wasm_heap_size();
    let code_size = WASM_CODE_SIZE.load(Ordering::SeqCst);
    
    let mut modules = vec![];
    
    // Add the main WASM module (heap region at base 0)
    if let Some(info) = get_wasm_module_info() {
        modules.push(serde_json::json!({
            "base": info.base,
            "size": info.size,
            "code_size": info.code_size,
            "is_64bit": false,
            "name": "wasm_heap",
            "modulename": "wasm_heap",
            "path": "wasm_heap",
            "instrumented": info.instrumented,
            "watchpoint_count": info.watchpoint_count,
            "has_binary": info.has_binary,
            "metadata": info.metadata,
        }));
    } else {
        // Default WASM module if no info set
        modules.push(serde_json::json!({
            "base": 0,
            "size": heap_size,
            "code_size": code_size,
            "is_64bit": false,
            "name": "wasm_heap",
            "modulename": "wasm_heap",
            "path": "wasm_heap",
            "instrumented": false,
            "watchpoint_count": 0,
            "has_binary": code_size > 0,
        }));
    }
    
    // Add the WASM code region as a separate module (for disassembly/symbol lookup)
    // This allows address-to-symbol resolution for CODE_REGION_BASE addresses
    if code_size > 0 {
        modules.push(serde_json::json!({
            "base": CODE_REGION_BASE,
            "size": code_size,
            "is_64bit": false,
            "name": "wasm_code",
            "modulename": "wasm_code",
            "path": "wasm_code",
            "instrumented": false,
            "watchpoint_count": 0,
            "has_binary": true,
        }));
    }
    
    modules
}

/// Clear module info
pub fn clear_wasm_module_info() {
    if let Ok(mut guard) = get_module_info_lock().try_write() {
        *guard = None;
    }
}

// ============================================================================
// Cetus-style Region Enumeration (returns multiple regions)
// ============================================================================

/// Virtual base address for the code region
pub const CODE_REGION_BASE: usize = 0x40000000; // 1GB offset for code region

/// Enumerate WASM memory regions
/// Returns multiple regions:
/// 1. Live linear memory (heap) - current state
/// 2. WASM code region (binary) - if captured
/// 3. Initial snapshot (if available) - frozen initial state
pub fn enum_wasm_regions() -> Vec<WasmMemoryRegion> {
    let heap_size = get_cached_wasm_heap_size();
    let code_size = WASM_CODE_SIZE.load(Ordering::SeqCst);
    let mut regions = vec![];
    
    // Region 1: Live linear memory
    regions.push(WasmMemoryRegion {
        name: "wasm_heap".to_string(),
        start: 0,
        end: heap_size,
        protection: "rw-".to_string(),
        region_type: WasmRegionType::LinearMemory,
    });
    
    // Region 2: WASM code region (if binary was captured)
    if code_size > 0 {
        regions.push(WasmMemoryRegion {
            name: "wasm_code".to_string(),
            start: CODE_REGION_BASE,
            end: CODE_REGION_BASE + code_size,
            protection: "r-x".to_string(), // Read + execute (code)
            region_type: WasmRegionType::CodeRegion,
        });
    }
    
    // Region 3: Initial snapshot (if available)
    if let Some(snapshot_size) = get_initial_snapshot_size() {
        // Snapshot is stored at a virtual offset (e.g., after heap)
        // This allows addressing both regions distinctly
        let snapshot_base = SNAPSHOT_REGION_BASE;
        regions.push(WasmMemoryRegion {
            name: "wasm_initial_snapshot".to_string(),
            start: snapshot_base,
            end: snapshot_base + snapshot_size,
            protection: "r--".to_string(), // Read-only snapshot
            region_type: WasmRegionType::InitialSnapshot,
        });
    }
    
    regions
}

/// Get regions as JSON for API response
pub fn get_wasm_regions_json() -> Vec<serde_json::Value> {
    enum_wasm_regions()
        .into_iter()
        .map(|r| serde_json::json!({
            "start_address": format!("{:x}", r.start),
            "end_address": format!("{:x}", r.end),
            "protection": r.protection,
            "file_path": r.name,
            "region_type": format!("{:?}", r.region_type),
        }))
        .collect()
}

/// Virtual base address for the initial snapshot region
pub const SNAPSHOT_REGION_BASE: usize = 0x80000000;

/// Read memory from either live heap, code region, or snapshot based on address
pub fn read_wasm_virtual_memory(address: usize, size: usize) -> Result<Vec<u8>, String> {
    if address >= SNAPSHOT_REGION_BASE {
        // Reading from snapshot region (>= 0x80000000)
        let snapshot_offset = address - SNAPSHOT_REGION_BASE;
        read_initial_snapshot(snapshot_offset, size)
    } else if address >= CODE_REGION_BASE {
        // Reading from code region (0x40000000 - 0x80000000)
        let code_offset = address - CODE_REGION_BASE;
        read_wasm_code_sync(code_offset, size)
    } else {
        // Reading from live heap (0x0 - 0x40000000)
        read_wasm_memory_sync(address, size)
    }
}

/// Check if an address is in the snapshot region
pub fn is_snapshot_address(address: usize) -> bool {
    address >= SNAPSHOT_REGION_BASE
}

/// Check if an address is in the code region
pub fn is_code_address(address: usize) -> bool {
    address >= CODE_REGION_BASE && address < SNAPSHOT_REGION_BASE
}

/// Convert snapshot address to linear memory address
pub fn snapshot_to_linear_address(address: usize) -> usize {
    if address >= SNAPSHOT_REGION_BASE {
        address - SNAPSHOT_REGION_BASE
    } else {
        address
    }
}

// ============================================================================
// Cleanup / Reset Functions
// ============================================================================

/// Clear all Cetus-style state (snapshot, symbols, module info)
pub fn clear_all_wasm_state() {
    clear_initial_snapshot();
    clear_wasm_symbols();
    clear_wasm_module_info();
    clear_wasm_base_address();
}

// ============================================================================
// WASM Binary Dump for Ghidra Analysis
// ============================================================================

/// Dump the entire WASM binary for Ghidra/external analysis
/// Returns the complete WASM module binary (with magic number and all sections)
pub async fn dump_wasm_binary() -> Result<Vec<u8>, String> {
    let code_size = WASM_CODE_SIZE.load(Ordering::SeqCst);
    
    if code_size == 0 {
        return Err("No WASM binary captured (code_size is 0)".to_string());
    }
    
    // Read the entire code region from Chrome extension
    let bridge = get_wasm_bridge().ok_or("WASM bridge not initialized")?;
    let binary = bridge.read_code(0, code_size).await?;
    
    // Verify it's a valid WASM binary (magic number: \0asm)
    if binary.len() < 8 {
        return Err(format!("WASM binary too small: {} bytes", binary.len()));
    }
    
    if &binary[0..4] != b"\0asm" {
        log::warn!("WASM binary doesn't start with magic number, first 4 bytes: {:02x?}", &binary[0..4]);
    }
    
    Ok(binary)
}

/// Get WASM code size for dump
pub fn get_wasm_code_size() -> usize {
    WASM_CODE_SIZE.load(Ordering::SeqCst)
}
