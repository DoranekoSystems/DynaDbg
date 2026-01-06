use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExceptionData {
    pub exception_type: String, // "watchpoint", "breakpoint", "singlestep"
    pub address: String,
    pub instruction: Option<String>,
    pub timestamp: String,
    pub thread_id: Option<u64>,
    pub watchpoint_id: Option<String>,
    pub memory_address: Option<u64>,
    pub singlestep_mode: Option<u64>,
    pub registers: serde_json::Value,
    pub bytecode: Option<String>,
    pub opcode: Option<String>,
    pub pc: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEntryData {
    pub id: u32,
    pub address: String,
    pub instruction: String,
    pub opcode: String,
    pub operands: String,
    pub registers: serde_json::Value,
    pub depth: u32,
    pub is_call: bool,
    pub is_return: bool,
    pub function_name: Option<String>,
    pub timestamp: u64,
    pub library_expression: Option<String>,
    pub target_address: String, // trace session identifier
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceSession {
    pub target_address: String,
    pub total_count: u32,
    pub current_count: u32,
    pub is_active: bool,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracked_thread_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub processname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub git_hash: String,
    pub arch: String,
    pub pid: u32,
    pub mode: String,
    pub target_os: String,
    pub build_timestamp: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub pid: u32,
    pub icon: Option<String>,
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub modulename: String,
    pub base: u64,
    pub size: u64,
    pub path: Option<String>,
    pub is_64bit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchpointInfo {
    pub id: String,
    pub address: String,
    pub size: u32,
    #[serde(rename = "accessType")]
    pub access_type: WatchpointAccessType,
    #[serde(rename = "hitCount")]
    pub hit_count: u32,
    #[serde(rename = "createdAt")]
    pub created_at: String, // ISO 8601 timestamp
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchpointAccessType {
    #[serde(rename = "r")]
    Read,
    #[serde(rename = "w")]
    Write,
    #[serde(rename = "rw")]
    ReadWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    #[serde(rename = "serverConnected")]
    pub server_connected: bool,
    #[serde(rename = "debuggerConnected")]
    pub debugger_connected: bool,
    #[serde(rename = "connectionHost")]
    pub connection_host: Option<String>,
    #[serde(rename = "connectionPort")]
    pub connection_port: Option<u16>,
    
    #[serde(rename = "authToken")]
    pub auth_token: Option<String>,
    #[serde(rename = "serverSessionId")]
    pub server_session_id: Option<String>,
    
    #[serde(rename = "attachedProcess")]
    pub attached_process: Option<ProcessInfo>,
    #[serde(rename = "serverInfo")]
    pub server_info: Option<ServerInfo>,
    #[serde(rename = "attachedAppInfo")]
    pub attached_app_info: Option<AppInfo>,
    #[serde(rename = "attachedModules")]
    pub attached_modules: Vec<ModuleInfo>,
    
    #[serde(rename = "spawnSuspended")]
    pub spawn_suspended: bool,
    
    #[serde(rename = "isInBreakState")]
    pub is_in_break_state: bool,
    #[serde(rename = "currentThreadId")]
    pub current_thread_id: Option<u32>,
    #[serde(rename = "currentBreakAddress")]
    pub current_break_address: Option<String>,
    #[serde(rename = "currentRegisterData")]
    pub current_register_data: HashMap<String, String>,
    
    #[serde(rename = "activeBreakpoints")]
    pub active_breakpoints: Vec<String>,
    #[serde(rename = "softwareBreakpoints")]
    pub software_breakpoints: Vec<String>,
    pub watchpoints: Vec<WatchpointInfo>,
    
    #[serde(rename = "showRegisters")]
    pub show_registers: bool,
    #[serde(rename = "showToolbar")]
    pub show_toolbar: bool,
    #[serde(rename = "sidebarWidth")]
    pub sidebar_width: u32,
    
    #[serde(skip)]
    pub exception_store: Vec<ExceptionData>,
    
    #[serde(skip)]
    pub trace_store: Vec<TraceEntryData>,
    
    #[serde(skip)]
    pub active_trace_session: Option<TraceSession>,
    
    #[serde(rename = "lastUpdate")]
    pub last_update: u64,
    
    #[serde(skip)]
    pub graph_view_store: HashMap<String, GraphViewData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphViewData {
    pub address: String,
    pub function_name: String,
    pub instructions: String, // JSON string of instructions
    pub function_start_address: String,
    pub function_end_address: String,
    // Ghidra CFG mode fields (optional)
    #[serde(default)]
    pub library_path: String,
    #[serde(default)]
    pub function_offset: String,
    // dbgsrv URL for Z3 reachability analysis
    #[serde(default)]
    pub server_url: String,
    // Authentication token for dbgsrv
    #[serde(default)]
    pub auth_token: String,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            server_connected: false,
            debugger_connected: false,
            connection_host: None,
            connection_port: None,
            auth_token: None,
            server_session_id: None,
            attached_process: None,
            server_info: None,
            attached_app_info: None,
            attached_modules: Vec::new(),
            spawn_suspended: false,
            is_in_break_state: false,
            current_thread_id: None,
            current_break_address: None,
            current_register_data: HashMap::new(),
            active_breakpoints: Vec::new(),
            software_breakpoints: Vec::new(),
            watchpoints: Vec::new(),
            show_registers: false,
            show_toolbar: true,
            sidebar_width: 240,
            exception_store: Vec::new(),
            trace_store: Vec::new(),
            active_trace_session: None,
            graph_view_store: HashMap::new(),
            last_update: 0,
        }
    }
}

pub type AppStateType = Arc<Mutex<AppState>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateUpdateEvent {
    pub field: String,
    pub value: serde_json::Value,
    pub timestamp: u64,
}

impl AppState {
    pub fn current_timestamp() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    pub fn touch(&mut self) {
        self.last_update = Self::current_timestamp();
    }

    pub fn get_field_as_json(&self, field: &str) -> Option<serde_json::Value> {
        match field {
            "serverConnected" => Some(serde_json::json!(self.server_connected)),
            "debuggerConnected" => Some(serde_json::json!(self.debugger_connected)),
            "connectionHost" => Some(serde_json::json!(self.connection_host)),
            "connectionPort" => Some(serde_json::json!(self.connection_port)),
            "authToken" => Some(serde_json::json!(self.auth_token)),
            "serverSessionId" => Some(serde_json::json!(self.server_session_id)),
            "isInBreakState" => Some(serde_json::json!(self.is_in_break_state)),
            "currentThreadId" => Some(serde_json::json!(self.current_thread_id)),
            "currentBreakAddress" => Some(serde_json::json!(self.current_break_address)),
            "currentRegisterData" => serde_json::to_value(&self.current_register_data).ok(),
            "attachedProcess" => serde_json::to_value(&self.attached_process).ok(),
            "serverInfo" => serde_json::to_value(&self.server_info).ok(),
            "attachedAppInfo" => serde_json::to_value(&self.attached_app_info).ok(),
            "attachedModules" => serde_json::to_value(&self.attached_modules).ok(),
            "spawnSuspended" => Some(serde_json::json!(self.spawn_suspended)),
            "activeBreakpoints" => serde_json::to_value(&self.active_breakpoints).ok(),
            "softwareBreakpoints" => serde_json::to_value(&self.software_breakpoints).ok(),
            "watchpoints" => serde_json::to_value(&self.watchpoints).ok(),
            "showRegisters" => Some(serde_json::json!(self.show_registers)),
            "showToolbar" => Some(serde_json::json!(self.show_toolbar)),
            "sidebarWidth" => Some(serde_json::json!(self.sidebar_width)),
            _ => None,
        }
    }

    pub fn update_field(&mut self, field: &str, value: &serde_json::Value) -> Result<(), String> {
        match field {
            "serverConnected" => {
                if let Some(val) = value.as_bool() {
                    self.server_connected = val;
                }
            },
            "debuggerConnected" => {
                if let Some(val) = value.as_bool() {
                    self.debugger_connected = val;
                }
            },
            "connectionHost" => {
                self.connection_host = value.as_str().map(|s| s.to_string());
            },
            "connectionPort" => {
                if let Some(val) = value.as_u64() {
                    self.connection_port = Some(val as u16);
                } else if value.is_null() {
                    self.connection_port = None;
                }
            },
            "authToken" => {
                if value.is_null() {
                    self.auth_token = None;
                } else {
                    self.auth_token = value.as_str().map(|s| s.to_string());
                }
            },
            "serverSessionId" => {
                if value.is_null() {
                    self.server_session_id = None;
                } else {
                    self.server_session_id = value.as_str().map(|s| s.to_string());
                }
            },
            "isInBreakState" => {
                if let Some(val) = value.as_bool() {
                    self.is_in_break_state = val;
                }
            },
            "currentThreadId" => {
                if let Some(val) = value.as_u64() {
                    self.current_thread_id = Some(val as u32);
                } else if value.is_null() {
                    self.current_thread_id = None;
                }
            },
            "currentBreakAddress" => {
                self.current_break_address = value.as_str().map(|s| s.to_string());
            },
            "currentRegisterData" => {
                if let Ok(registers) = serde_json::from_value::<HashMap<String, String>>(value.clone()) {
                    self.current_register_data = registers;
                }
            },
            "attachedProcess" => {
                if value.is_null() {
                    self.attached_process = None;
                } else if let Ok(process) = serde_json::from_value::<ProcessInfo>(value.clone()) {
                    self.attached_process = Some(process);
                }
            },
            "serverInfo" => {
                if value.is_null() {
                    self.server_info = None;
                } else if let Ok(info) = serde_json::from_value::<ServerInfo>(value.clone()) {
                    self.server_info = Some(info);
                }
            },
            "attachedAppInfo" => {
                if value.is_null() {
                    self.attached_app_info = None;
                } else if let Ok(info) = serde_json::from_value::<AppInfo>(value.clone()) {
                    self.attached_app_info = Some(info);
                }
            },
            "attachedModules" => {
                if let Ok(modules) = serde_json::from_value::<Vec<ModuleInfo>>(value.clone()) {
                    self.attached_modules = modules;
                }
            },
            "spawnSuspended" => {
                if let Some(val) = value.as_bool() {
                    self.spawn_suspended = val;
                }
            },
            "activeBreakpoints" => {
                if let Ok(breakpoints) = serde_json::from_value::<Vec<String>>(value.clone()) {
                    self.active_breakpoints = breakpoints;
                }
            },
            "softwareBreakpoints" => {
                if let Ok(breakpoints) = serde_json::from_value::<Vec<String>>(value.clone()) {
                    self.software_breakpoints = breakpoints;
                }
            },
            "watchpoints" => {
                if let Ok(watchpoints) = serde_json::from_value::<Vec<WatchpointInfo>>(value.clone()) {
                    self.watchpoints = watchpoints;
                }
            },
            "showRegisters" => {
                if let Some(val) = value.as_bool() {
                    self.show_registers = val;
                }
            },
            "showToolbar" => {
                if let Some(val) = value.as_bool() {
                    self.show_toolbar = val;
                }
            },
            "sidebarWidth" => {
                if let Some(val) = value.as_u64() {
                    self.sidebar_width = val as u32;
                }
            },
            _ => {
                return Err(format!("Unknown state field: {}", field));
            }
        }
        
        self.touch();
        Ok(())
    }
}

#[tauri::command]
pub async fn get_app_state(state: tauri::State<'_, AppStateType>) -> Result<AppState, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(state_guard.clone())
}

#[tauri::command]
pub async fn update_app_state(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    updates: HashMap<String, serde_json::Value>
) -> Result<(), String> {
    let timestamp = AppState::current_timestamp();
    let mut changed_fields: Vec<(String, serde_json::Value)> = Vec::new();

    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        for (field, value) in &updates {
            // Check if the value actually changed before updating
            let current_value = state_guard.get_field_as_json(field);
            if current_value.as_ref() != Some(value) {
                if let Err(e) = state_guard.update_field(field, value) {
                    eprintln!("Failed to update field {}: {}", field, e);
                } else {
                    changed_fields.push((field.clone(), value.clone()));
                }
            }
        }
    }

    for (field, value) in changed_fields {
        let event = StateUpdateEvent {
            field: field.clone(),
            value: value.clone(),
            timestamp,
        };
        
        for window in app.webview_windows().values() {
            if let Err(e) = window.emit("state-updated", &event) {
                eprintln!("Failed to emit state update event to window: {}", e);
            }
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn update_single_state(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    field: String,
    value: serde_json::Value
) -> Result<(), String> {
    let mut updates = HashMap::new();
    updates.insert(field, value);
    update_app_state(app, state, updates).await
}

#[tauri::command]
pub async fn get_connection_state(state: tauri::State<'_, AppStateType>) -> Result<serde_json::Value, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(serde_json::json!({
        "serverConnected": state_guard.server_connected,
        "debuggerConnected": state_guard.debugger_connected,
        "connectionHost": state_guard.connection_host,
        "connectionPort": state_guard.connection_port,
        "isConnected": state_guard.server_connected && state_guard.debugger_connected
    }))
}

#[tauri::command]
pub async fn get_debug_state(state: tauri::State<'_, AppStateType>) -> Result<serde_json::Value, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(serde_json::json!({
        "isInBreakState": state_guard.is_in_break_state,
        "currentThreadId": state_guard.current_thread_id,
        "currentBreakAddress": state_guard.current_break_address,
        "currentRegisterData": state_guard.current_register_data,
        "activeBreakpoints": state_guard.active_breakpoints,
        "softwareBreakpoints": state_guard.software_breakpoints,
        "watchpoints": state_guard.watchpoints
    }))
}

#[tauri::command]
pub async fn add_exceptions(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    exceptions: Vec<ExceptionData>
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        state_guard.exception_store.extend(exceptions.clone());
        state_guard.touch();
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("exceptions-added", &exceptions) {
            eprintln!("Failed to emit exceptions-added event to window: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn get_exceptions(
    state: tauri::State<'_, AppStateType>,
    exception_type_filter: Option<Vec<String>>,
    limit: Option<usize>
) -> Result<Vec<ExceptionData>, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    
    let mut exceptions: Vec<ExceptionData> = state_guard.exception_store.clone();
    
    if let Some(types) = exception_type_filter {
        exceptions.retain(|ex| types.contains(&ex.exception_type));
    }
    
    if let Some(limit_count) = limit {
        let start = exceptions.len().saturating_sub(limit_count);
        exceptions = exceptions[start..].to_vec();
    }
    
    Ok(exceptions)
}

#[tauri::command]
pub async fn get_watchpoint_exceptions(
    state: tauri::State<'_, AppStateType>,
    watchpoint_id: Option<String>,
    limit: Option<usize>
) -> Result<Vec<ExceptionData>, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    
    let mut exceptions: Vec<ExceptionData> = state_guard.exception_store
        .iter()
        .filter(|ex| ex.exception_type == "watchpoint")
        .cloned()
        .collect();
    
    if let Some(id) = watchpoint_id {
        exceptions.retain(|ex| ex.watchpoint_id.as_ref() == Some(&id));
    }
    
    if let Some(limit_count) = limit {
        let start = exceptions.len().saturating_sub(limit_count);
        exceptions = exceptions[start..].to_vec();
    }
    
    Ok(exceptions)
}

#[tauri::command]
pub async fn clear_exceptions(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    exception_type: Option<String>
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        if let Some(exc_type) = exception_type {
            state_guard.exception_store.retain(|ex| ex.exception_type != exc_type);
        } else {
            state_guard.exception_store.clear();
        }
        
        state_guard.touch();
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("exceptions-cleared", &serde_json::json!({})) {
            eprintln!("Failed to emit exceptions-cleared event to window: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn clear_watchpoint_exceptions(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    watchpoint_address: u64,
    watchpoint_size: u64,
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        state_guard.exception_store.retain(|ex| {
            if ex.exception_type != "watchpoint" {
                return true;
            }
            
            if let Some(memory_addr) = ex.memory_address {
                !(memory_addr >= watchpoint_address && memory_addr < watchpoint_address + watchpoint_size)
            } else {
                true
            }
        });
        
        state_guard.touch();
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("watchpoint-exceptions-cleared", &serde_json::json!({
            "address": watchpoint_address,
            "size": watchpoint_size
        })) {
            eprintln!("Failed to emit watchpoint-exceptions-cleared event to window: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn start_trace_session(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    target_address: String,
    total_count: u32,
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        state_guard.trace_store.clear();
        state_guard.active_trace_session = Some(TraceSession {
            target_address: target_address.clone(),
            total_count,
            current_count: 0,
            is_active: true,
            started_at: AppState::current_timestamp(),
            tracked_thread_id: None,
        });
        
        state_guard.touch();
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("trace-session-started", &serde_json::json!({
            "targetAddress": target_address,
            "totalCount": total_count
        })) {
            eprintln!("Failed to emit trace-session-started event to window: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn add_trace_entry(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    mut entry: TraceEntryData,
) -> Result<(), String> {
    let session_complete;
    let current_count;
    let total_count;
    let was_duplicate;
    
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        {
            let session = state_guard.active_trace_session.as_ref()
                .ok_or("No active trace session")?;
            
            if !session.is_active {
                return Err("Trace session is not active".to_string());
            }
        }
        
        let already_exists = state_guard.trace_store.iter().any(|existing| {
            existing.address == entry.address && existing.timestamp == entry.timestamp
        });
        
        if already_exists {
            was_duplicate = true;
            current_count = state_guard.active_trace_session.as_ref()
                .map(|s| s.current_count)
                .unwrap_or(0);
            total_count = state_guard.active_trace_session.as_ref()
                .map(|s| s.total_count)
                .unwrap_or(0);
            session_complete = false;
        } else {
            was_duplicate = false;
            
            if let Some(session) = state_guard.active_trace_session.as_mut() {
                session.current_count += 1;
                
                current_count = session.current_count;
                total_count = session.total_count;
                
                entry.id = current_count;
                
                session_complete = session.current_count >= session.total_count;
                if session_complete {
                    session.is_active = false;
                }
            } else {
                return Err("No active trace session".to_string());
            }
            
            state_guard.trace_store.push(entry.clone());
            
            state_guard.touch();
        }
    }
    
    if was_duplicate {
        return Ok(());
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("trace-entry-added", &entry) {
            eprintln!("Failed to emit trace-entry-added event to window: {}", e);
        }
        
        if let Err(e) = window.emit("trace-progress", &serde_json::json!({
            "current": current_count,
            "total": total_count
        })) {
            eprintln!("Failed to emit trace-progress event to window: {}", e);
        }
    }
    
    if session_complete {
        for window in app.webview_windows().values() {
            if let Err(e) = window.emit("trace-session-complete", &serde_json::json!({
                "totalEntries": current_count
            })) {
                eprintln!("Failed to emit trace-session-complete event to window: {}", e);
            }
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn add_trace_entries_batch(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    entries: Vec<TraceEntryData>,
) -> Result<(), String> {
    let session_complete;
    let current_count;
    let total_count;
    let added_entries: Vec<TraceEntryData>;
    
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        {
            let session = state_guard.active_trace_session.as_ref()
                .ok_or("No active trace session")?;
            
            if !session.is_active {
                return Err("Trace session is not active".to_string());
            }
        }
        let existing_keys: std::collections::HashSet<(String, u64)> = state_guard
            .trace_store
            .iter()
            .map(|e| (e.address.clone(), e.timestamp))
            .collect();
        
        let mut new_entries: Vec<TraceEntryData> = entries
            .into_iter()
            .filter(|e| !existing_keys.contains(&(e.address.clone(), e.timestamp)))
            .collect();
        
        if new_entries.is_empty() {
            current_count = state_guard.active_trace_session.as_ref()
                .map(|s| s.current_count)
                .unwrap_or(0);
            total_count = state_guard.active_trace_session.as_ref()
                .map(|s| s.total_count)
                .unwrap_or(0);
            session_complete = false;
            added_entries = Vec::new();
        } else {
            if let Some(session) = state_guard.active_trace_session.as_mut() {
                for entry in &mut new_entries {
                    session.current_count += 1;
                    entry.id = session.current_count;
                }
                
                current_count = session.current_count;
                total_count = session.total_count;
                
                session_complete = session.current_count >= session.total_count;
                if session_complete {
                    session.is_active = false;
                }
            } else {
                return Err("No active trace session".to_string());
            }
            
            state_guard.trace_store.extend(new_entries.clone());
            added_entries = new_entries;
            
            state_guard.touch();
        }
    }
    
    if !added_entries.is_empty() {
        for window in app.webview_windows().values() {
            if let Err(e) = window.emit("trace-entries-added", &added_entries) {
                eprintln!("Failed to emit trace-entries-added event to window: {}", e);
            }
            
            if let Err(e) = window.emit("trace-progress", &serde_json::json!({
                "current": current_count,
                "total": total_count
            })) {
                eprintln!("Failed to emit trace-progress event to window: {}", e);
            }
        }
    }
    
    if session_complete {
        for window in app.webview_windows().values() {
            if let Err(e) = window.emit("trace-session-complete", &serde_json::json!({
                "totalEntries": current_count
            })) {
                eprintln!("Failed to emit trace-session-complete event to window: {}", e);
            }
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn get_trace_entries(
    state: tauri::State<'_, AppStateType>,
    target_address: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<TraceEntryData>, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    
    let mut entries: Vec<TraceEntryData> = state_guard.trace_store.clone();
    
    if let Some(addr) = target_address {
        entries.retain(|e| e.target_address == addr);
    }
    
    if let Some(limit_count) = limit {
        let start = entries.len().saturating_sub(limit_count);
        entries = entries[start..].to_vec();
    }
    
    Ok(entries)
}

#[tauri::command]
pub async fn get_trace_session(
    state: tauri::State<'_, AppStateType>,
) -> Result<Option<TraceSession>, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    Ok(state_guard.active_trace_session.clone())
}

#[tauri::command]
pub async fn stop_trace_session(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        if let Some(session) = state_guard.active_trace_session.as_mut() {
            session.is_active = false;
        }
        
        state_guard.touch();
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("trace-session-stopped", &serde_json::json!({})) {
            eprintln!("Failed to emit trace-session-stopped event to window: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn set_trace_tracked_thread(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
    thread_id: u64,
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        
        if let Some(session) = state_guard.active_trace_session.as_mut() {
            if session.tracked_thread_id.is_none() {
                session.tracked_thread_id = Some(thread_id);
                state_guard.touch();
                
                for window in app.webview_windows().values() {
                    if let Err(e) = window.emit("trace-thread-tracked", &serde_json::json!({
                        "threadId": thread_id
                    })) {
                        eprintln!("Failed to emit trace-thread-tracked event: {}", e);
                    }
                }
            }
        } else {
            return Err("No active trace session".to_string());
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn clear_trace_entries(
    app: AppHandle,
    state: tauri::State<'_, AppStateType>,
) -> Result<(), String> {
    {
        let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        state_guard.trace_store.clear();
        state_guard.active_trace_session = None;
        state_guard.touch();
    }
    
    for window in app.webview_windows().values() {
        if let Err(e) = window.emit("trace-entries-cleared", &serde_json::json!({})) {
            eprintln!("Failed to emit trace-entries-cleared event to window: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn store_graph_view_data(
    state: tauri::State<'_, AppStateType>,
    address: String,
    function_name: String,
    instructions: String,
    function_start_address: String,
    function_end_address: String,
    library_path: Option<String>,
    function_offset: Option<String>,
    server_url: Option<String>,
    auth_token: Option<String>,
) -> Result<(), String> {
    let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    
    let data = GraphViewData {
        address: address.clone(),
        function_name,
        instructions,
        function_start_address,
        function_end_address,
        library_path: library_path.unwrap_or_default(),
        function_offset: function_offset.unwrap_or_default(),
        server_url: server_url.unwrap_or_default(),
        auth_token: auth_token.unwrap_or_default(),
    };
    
    state_guard.graph_view_store.insert(address, data);
    state_guard.touch();
    
    Ok(())
}

#[tauri::command]
pub async fn get_graph_view_data(
    state: tauri::State<'_, AppStateType>,
    address: String,
) -> Result<Option<GraphViewData>, String> {
    let state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    
    Ok(state_guard.graph_view_store.get(&address).cloned())
}

#[tauri::command]
pub async fn clear_graph_view_data(
    state: tauri::State<'_, AppStateType>,
    address: Option<String>,
) -> Result<(), String> {
    let mut state_guard = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    
    if let Some(addr) = address {
        state_guard.graph_view_store.remove(&addr);
    } else {
        state_guard.graph_view_store.clear();
    }
    
    state_guard.touch();
    Ok(())
}

#[tauri::command]
pub fn open_trace_file_dialog() -> Result<Option<String>, String> {
    use rfd::FileDialog;
    
    let file = FileDialog::new()
        .add_filter("DynaDbg Trace", &["dyntrace", "bin"])
        .add_filter("All Files", &["*"])
        .set_title("Select Trace File")
        .pick_file();
    
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn read_trace_file(path: String) -> Result<String, String> {
    use std::fs;
    use base64::{Engine as _, engine::general_purpose};
    
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file {}: {}", path, e))?;
    Ok(general_purpose::STANDARD.encode(&bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedModuleInfo {
    pub modulename: String,
    pub base: u64,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_64bit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedSymbolInfo {
    pub address: String,
    pub name: String,
    pub size: u64,
    pub symbol_type: String,
    pub scope: String,
    pub module_base: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_external: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_private_external: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_weak_def: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_weak_ref: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_thumb: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_ordinal: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedGhidraFunction {
    pub name: String,
    pub address: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedGhidraDataItem {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub data_type: String,
    pub category: String, // "string" | "pointer" | "integer" | "float" | "struct" | "array" | "other"
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DebuggerSidebarCache {
    pub modules: Vec<CachedModuleInfo>,
    pub symbols: Vec<CachedSymbolInfo>,
    pub ghidra_functions: Vec<CachedGhidraFunction>,
    pub ghidra_data_items: Vec<CachedGhidraDataItem>,
    pub cached_process_pid: Option<u32>,
    pub cached_module_path: Option<String>,
    pub last_update: u64,
}

pub type DebuggerSidebarCacheType = Arc<Mutex<DebuggerSidebarCache>>;

#[tauri::command]
pub async fn get_sidebar_cache(
    cache: tauri::State<'_, DebuggerSidebarCacheType>,
) -> Result<DebuggerSidebarCache, String> {
    let cache_guard = cache.lock().map_err(|e| format!("Failed to lock cache: {}", e))?;
    Ok(cache_guard.clone())
}

#[tauri::command]
pub async fn set_sidebar_modules(
    cache: tauri::State<'_, DebuggerSidebarCacheType>,
    modules: Vec<CachedModuleInfo>,
    process_pid: u32,
) -> Result<(), String> {
    let mut cache_guard = cache.lock().map_err(|e| format!("Failed to lock cache: {}", e))?;
    cache_guard.modules = modules;
    cache_guard.cached_process_pid = Some(process_pid);
    cache_guard.last_update = AppState::current_timestamp();
    Ok(())
}

#[tauri::command]
pub async fn set_sidebar_symbols(
    cache: tauri::State<'_, DebuggerSidebarCacheType>,
    symbols: Vec<CachedSymbolInfo>,
    module_path: String,
) -> Result<(), String> {
    let mut cache_guard = cache.lock().map_err(|e| format!("Failed to lock cache: {}", e))?;
    cache_guard.symbols = symbols;
    cache_guard.cached_module_path = Some(module_path);
    cache_guard.last_update = AppState::current_timestamp();
    Ok(())
}

#[tauri::command]
pub async fn set_sidebar_ghidra_functions(
    cache: tauri::State<'_, DebuggerSidebarCacheType>,
    functions: Vec<CachedGhidraFunction>,
    module_path: String,
) -> Result<(), String> {
    let mut cache_guard = cache.lock().map_err(|e| format!("Failed to lock cache: {}", e))?;
    cache_guard.ghidra_functions = functions;
    cache_guard.cached_module_path = Some(module_path);
    cache_guard.last_update = AppState::current_timestamp();
    Ok(())
}

#[tauri::command]
pub async fn set_sidebar_ghidra_data(
    cache: tauri::State<'_, DebuggerSidebarCacheType>,
    data_items: Vec<CachedGhidraDataItem>,
    module_path: String,
) -> Result<(), String> {
    let mut cache_guard = cache.lock().map_err(|e| format!("Failed to lock cache: {}", e))?;
    cache_guard.ghidra_data_items = data_items;
    cache_guard.cached_module_path = Some(module_path);
    cache_guard.last_update = AppState::current_timestamp();
    Ok(())
}

#[tauri::command]
pub async fn clear_sidebar_cache(
    cache: tauri::State<'_, DebuggerSidebarCacheType>,
) -> Result<(), String> {
    let mut cache_guard = cache.lock().map_err(|e| format!("Failed to lock cache: {}", e))?;
    *cache_guard = DebuggerSidebarCache::default();
    Ok(())
}
