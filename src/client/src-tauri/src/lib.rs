use serde::{Deserialize, Serialize};
use capstone::prelude::*;
use tauri::{Manager, PhysicalSize, Size};
use cpp_demangle::Symbol as CppSymbol;
use rustc_demangle::demangle as rustc_demangle;
use std::path::PathBuf;
use std::process::{Command, Child, Stdio};
use std::sync::{Mutex, RwLock};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use rusqlite::{Connection, params};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use wasmparser::{Parser, Payload, Operator};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt as UnixCommandExt;

// Windows flag to create process without a console window
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Configure a Command to hide the console window on Windows
#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

/// Configure a Command to detach from terminal on Unix
#[cfg(unix)]
fn hide_console_window(cmd: &mut Command) -> &mut Command {
    // Detach from controlling terminal by creating a new session
    // SAFETY: setsid() is async-signal-safe
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    // Also redirect stdin from /dev/null to prevent terminal interaction
    cmd.stdin(Stdio::null())
}

#[cfg(not(any(windows, unix)))]
fn hide_console_window(cmd: &mut Command) -> &mut Command {
    cmd
}

mod state;

// Global SQLite connection for Ghidra functions cache
static GHIDRA_DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| {
    Mutex::new(None)
});

// Global Ghidra server processes (project_path -> child process)
static GHIDRA_SERVERS: Lazy<Mutex<HashMap<String, Child>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

// Ghidra server port mapping (project_path -> port)
static GHIDRA_SERVER_PORTS: Lazy<Mutex<HashMap<String, u16>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

// Ghidra server logs (project_path -> log lines)
static GHIDRA_SERVER_LOGS: Lazy<Mutex<HashMap<String, Vec<String>>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

fn init_ghidra_db() -> Result<(), String> {
    let ghidra_dir = get_ghidra_projects_dir();
    std::fs::create_dir_all(&ghidra_dir).map_err(|e| e.to_string())?;
    
    let db_path = ghidra_dir.join("ghidra_cache.db");
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    
    // Create tables
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analyzed_modules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_os TEXT NOT NULL,
            module_name TEXT NOT NULL,
            module_path TEXT NOT NULL,
            local_path TEXT NOT NULL,
            project_path TEXT NOT NULL,
            analyzed_at INTEGER NOT NULL,
            UNIQUE(target_os, module_name)
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS module_functions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            size INTEGER NOT NULL,
            FOREIGN KEY(module_id) REFERENCES analyzed_modules(id) ON DELETE CASCADE
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_module_functions_module_id ON module_functions(module_id)",
        [],
    ).map_err(|e| e.to_string())?;
    
    // Simple JSON cache table for frontend compatibility
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ghidra_functions_cache (
            target_os TEXT NOT NULL,
            module_name TEXT NOT NULL,
            functions_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(target_os, module_name)
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    // Decompile cache table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ghidra_decompile_cache (
            target_os TEXT NOT NULL,
            module_name TEXT NOT NULL,
            function_address TEXT NOT NULL,
            function_name TEXT NOT NULL,
            decompiled_code TEXT NOT NULL,
            line_mapping_json TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(target_os, module_name, function_address)
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    // Xref cache table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ghidra_xref_cache (
            target_os TEXT NOT NULL,
            module_name TEXT NOT NULL,
            function_address TEXT NOT NULL,
            function_name TEXT NOT NULL,
            xrefs_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(target_os, module_name, function_address)
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    *GHIDRA_DB.lock().unwrap() = Some(conn);
    Ok(())
}

// Helper function to format ARM64 operands more clearly
fn format_arm64_operands(op_str: &str) -> String {
    // Basic formatting for ARM64 operands
    // Add spaces around commas for better readability
    let formatted = op_str.replace(",", ", ");
    
    // Handle common ARM64 addressing modes
    if formatted.contains("[") && formatted.contains("]") {
        // Memory addressing - keep as is but ensure proper spacing
        formatted
    } else if formatted.contains("#") {
        // Immediate values - ensure proper spacing
            formatted.replace("#", "#")
    } else {
        // Register operands - ensure proper spacing
        formatted
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DisassembleRequest {
    pub address: u64,
    pub size: usize,
    pub architecture: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DisassembleResponse {
    pub success: bool,
    pub disassembly: Option<String>,
    pub instructions_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryReadRequest {
    pub address: u64,
    pub size: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryReadResponse {
    pub success: bool,
    pub data: Option<Vec<u8>>,
    pub error: Option<String>,
}

// Ghidra integration structures
#[derive(Debug, Serialize, Deserialize)]
pub struct GhidraAnalysisStatus {
    pub library_path: String,
    pub analyzed: bool,
    pub project_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraTokenInfo {
    pub text: String,
    pub line: u32,
    pub col_start: u32,
    pub col_end: u32,
    pub token_type: String, // "function", "variable", "type", "field", "data", "unknown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_offset: Option<String>, // For function calls
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_name: Option<String>, // For function calls
    #[serde(skip_serializing_if = "Option::is_none")]
    pub var_name: Option<String>, // For variables
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>, // For variables/types
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_parameter: Option<bool>, // For variables
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GhidraDecompileResult {
    pub success: bool,
    #[serde(default)]
    pub function_name: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    pub decompiled_code: Option<String>,
    pub line_mapping: Option<std::collections::HashMap<String, String>>, // line number (as string) -> offset (hex string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<GhidraTokenInfo>>, // Token information for syntax highlighting
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraVariableInfo {
    pub name: String,
    pub data_type: String,
    pub storage: String,
    pub is_parameter: bool,
    pub size: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraCalledFunction {
    pub name: String,
    pub offset: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GhidraFunctionInfoResult {
    pub success: bool,
    pub function_name: Option<String>,
    pub function_offset: Option<String>,
    pub variables: Vec<GhidraVariableInfo>,
    pub called_functions: Vec<GhidraCalledFunction>,
    pub error: Option<String>,
}

// Memory filter structures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFilterRequest {
    pub addresses: Vec<u64>,           // List of addresses to filter
    pub old_values: Vec<Vec<u8>>,      // Previous values at those addresses (hex bytes)
    pub pattern: String,               // Hex-encoded pattern for comparison (min for range)
    pub pattern_max: Option<String>,   // Hex-encoded max pattern for range filter
    pub data_type: String,             // "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float", "double", "bytes", "string", "regex"
    pub filter_method: String,         // "exact", "range", "greater_or_equal", "less_than", "changed", "unchanged", "increased", "decreased"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFilterResult {
    pub address: u64,
    pub value: Vec<u8>,  // New value at the address
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFilterResponse {
    pub success: bool,
    pub results: Vec<MemoryFilterResult>,
    pub total_processed: usize,
    pub error: Option<String>,
}

// Global state to store server connection info
struct ServerConfig {
    host: String,
    port: u16,
    auth_token: Option<String>,
}

static SERVER_CONFIG: Lazy<RwLock<ServerConfig>> = Lazy::new(|| {
    RwLock::new(ServerConfig {
        host: String::new(),
        port: 3030,
        auth_token: None,
    })
});

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn set_server_connection(host: String, port: u16) -> Result<(), String> {
    let mut config = SERVER_CONFIG.write().map_err(|e| e.to_string())?;
    config.host = host;
    config.port = port;
    Ok(())
}

#[tauri::command]
fn set_auth_token(token: Option<String>) -> Result<(), String> {
    let mut config = SERVER_CONFIG.write().map_err(|e| e.to_string())?;
    config.auth_token = token;
    Ok(())
}

/// Helper function to read memory from server
async fn read_memory_from_server(host: &str, port: u16, address: u64, size: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::new();
    let url = format!("http://{}:{}/api/memory/read?address={}&size={}", host, port, address, size);
    
    let response = client.get(&url).send().await
        .map_err(|e| format!("Network error: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Server error: {}", response.status()));
    }
    
    let bytes = response.bytes().await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    Ok(bytes.to_vec())
}

/// Compare two values based on data type and filter method
fn compare_values(
    new_val: &[u8],
    old_val: &[u8],
    pattern: &[u8],
    pattern_max: Option<&[u8]>,
    data_type: &str,
    filter_method: &str,
) -> bool {
    match filter_method {
        "exact" => new_val == pattern,
        "range" => {
            let max_bytes = match pattern_max {
                Some(b) => b,
                None => return false,
            };
            match data_type {
                "int8" => {
                    if new_val.is_empty() || pattern.is_empty() || max_bytes.is_empty() { return false; }
                    let val = new_val[0] as i8;
                    let min = pattern[0] as i8;
                    let max = max_bytes[0] as i8;
                    val >= min && val <= max
                }
                "uint8" => {
                    if new_val.is_empty() || pattern.is_empty() || max_bytes.is_empty() { return false; }
                    new_val[0] >= pattern[0] && new_val[0] <= max_bytes[0]
                }
                "int16" => {
                    if new_val.len() < 2 || pattern.len() < 2 || max_bytes.len() < 2 { return false; }
                    let val = i16::from_le_bytes([new_val[0], new_val[1]]);
                    let min = i16::from_le_bytes([pattern[0], pattern[1]]);
                    let max = i16::from_le_bytes([max_bytes[0], max_bytes[1]]);
                    val >= min && val <= max
                }
                "uint16" => {
                    if new_val.len() < 2 || pattern.len() < 2 || max_bytes.len() < 2 { return false; }
                    let val = u16::from_le_bytes([new_val[0], new_val[1]]);
                    let min = u16::from_le_bytes([pattern[0], pattern[1]]);
                    let max = u16::from_le_bytes([max_bytes[0], max_bytes[1]]);
                    val >= min && val <= max
                }
                "int32" => {
                    if new_val.len() < 4 || pattern.len() < 4 || max_bytes.len() < 4 { return false; }
                    let val = i32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let min = i32::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3]]);
                    let max = i32::from_le_bytes([max_bytes[0], max_bytes[1], max_bytes[2], max_bytes[3]]);
                    val >= min && val <= max
                }
                "uint32" => {
                    if new_val.len() < 4 || pattern.len() < 4 || max_bytes.len() < 4 { return false; }
                    let val = u32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let min = u32::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3]]);
                    let max = u32::from_le_bytes([max_bytes[0], max_bytes[1], max_bytes[2], max_bytes[3]]);
                    val >= min && val <= max
                }
                "int64" => {
                    if new_val.len() < 8 || pattern.len() < 8 || max_bytes.len() < 8 { return false; }
                    let val = i64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let min = i64::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3], pattern[4], pattern[5], pattern[6], pattern[7]]);
                    let max = i64::from_le_bytes([max_bytes[0], max_bytes[1], max_bytes[2], max_bytes[3], max_bytes[4], max_bytes[5], max_bytes[6], max_bytes[7]]);
                    val >= min && val <= max
                }
                "uint64" => {
                    if new_val.len() < 8 || pattern.len() < 8 || max_bytes.len() < 8 { return false; }
                    let val = u64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let min = u64::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3], pattern[4], pattern[5], pattern[6], pattern[7]]);
                    let max = u64::from_le_bytes([max_bytes[0], max_bytes[1], max_bytes[2], max_bytes[3], max_bytes[4], max_bytes[5], max_bytes[6], max_bytes[7]]);
                    val >= min && val <= max
                }
                "float" => {
                    if new_val.len() < 4 || pattern.len() < 4 || max_bytes.len() < 4 { return false; }
                    let val = f32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let min = f32::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3]]);
                    let max = f32::from_le_bytes([max_bytes[0], max_bytes[1], max_bytes[2], max_bytes[3]]);
                    !val.is_nan() && val >= min && val <= max
                }
                "double" => {
                    if new_val.len() < 8 || pattern.len() < 8 || max_bytes.len() < 8 { return false; }
                    let val = f64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let min = f64::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3], pattern[4], pattern[5], pattern[6], pattern[7]]);
                    let max = f64::from_le_bytes([max_bytes[0], max_bytes[1], max_bytes[2], max_bytes[3], max_bytes[4], max_bytes[5], max_bytes[6], max_bytes[7]]);
                    !val.is_nan() && val >= min && val <= max
                }
                _ => false,
            }
        }
        "greater_or_equal" | "less_than" => {
            let is_gte = filter_method == "greater_or_equal";
            match data_type {
                "int8" => {
                    if new_val.is_empty() || pattern.is_empty() { return false; }
                    let val = new_val[0] as i8;
                    let cmp = pattern[0] as i8;
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "uint8" => {
                    if new_val.is_empty() || pattern.is_empty() { return false; }
                    if is_gte { new_val[0] >= pattern[0] } else { new_val[0] < pattern[0] }
                }
                "int16" => {
                    if new_val.len() < 2 || pattern.len() < 2 { return false; }
                    let val = i16::from_le_bytes([new_val[0], new_val[1]]);
                    let cmp = i16::from_le_bytes([pattern[0], pattern[1]]);
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "uint16" => {
                    if new_val.len() < 2 || pattern.len() < 2 { return false; }
                    let val = u16::from_le_bytes([new_val[0], new_val[1]]);
                    let cmp = u16::from_le_bytes([pattern[0], pattern[1]]);
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "int32" => {
                    if new_val.len() < 4 || pattern.len() < 4 { return false; }
                    let val = i32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let cmp = i32::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3]]);
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "uint32" => {
                    if new_val.len() < 4 || pattern.len() < 4 { return false; }
                    let val = u32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let cmp = u32::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3]]);
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "int64" => {
                    if new_val.len() < 8 || pattern.len() < 8 { return false; }
                    let val = i64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let cmp = i64::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3], pattern[4], pattern[5], pattern[6], pattern[7]]);
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "uint64" => {
                    if new_val.len() < 8 || pattern.len() < 8 { return false; }
                    let val = u64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let cmp = u64::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3], pattern[4], pattern[5], pattern[6], pattern[7]]);
                    if is_gte { val >= cmp } else { val < cmp }
                }
                "float" => {
                    if new_val.len() < 4 || pattern.len() < 4 { return false; }
                    let val = f32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let cmp = f32::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3]]);
                    !val.is_nan() && if is_gte { val >= cmp } else { val < cmp }
                }
                "double" => {
                    if new_val.len() < 8 || pattern.len() < 8 { return false; }
                    let val = f64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let cmp = f64::from_le_bytes([pattern[0], pattern[1], pattern[2], pattern[3], pattern[4], pattern[5], pattern[6], pattern[7]]);
                    !val.is_nan() && if is_gte { val >= cmp } else { val < cmp }
                }
                _ => false,
            }
        }
        "changed" => new_val != old_val,
        "unchanged" => new_val == old_val,
        "increased" => {
            match data_type {
                "int8" => {
                    if new_val.is_empty() || old_val.is_empty() { return false; }
                    (new_val[0] as i8) > (old_val[0] as i8)
                }
                "uint8" => {
                    if new_val.is_empty() || old_val.is_empty() { return false; }
                    new_val[0] > old_val[0]
                }
                "int16" => {
                    if new_val.len() < 2 || old_val.len() < 2 { return false; }
                    i16::from_le_bytes([new_val[0], new_val[1]]) > i16::from_le_bytes([old_val[0], old_val[1]])
                }
                "uint16" => {
                    if new_val.len() < 2 || old_val.len() < 2 { return false; }
                    u16::from_le_bytes([new_val[0], new_val[1]]) > u16::from_le_bytes([old_val[0], old_val[1]])
                }
                "int32" => {
                    if new_val.len() < 4 || old_val.len() < 4 { return false; }
                    i32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]) > i32::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3]])
                }
                "uint32" => {
                    if new_val.len() < 4 || old_val.len() < 4 { return false; }
                    u32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]) > u32::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3]])
                }
                "int64" => {
                    if new_val.len() < 8 || old_val.len() < 8 { return false; }
                    i64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]) > 
                    i64::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3], old_val[4], old_val[5], old_val[6], old_val[7]])
                }
                "uint64" => {
                    if new_val.len() < 8 || old_val.len() < 8 { return false; }
                    u64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]) > 
                    u64::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3], old_val[4], old_val[5], old_val[6], old_val[7]])
                }
                "float" => {
                    if new_val.len() < 4 || old_val.len() < 4 { return false; }
                    let n = f32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let o = f32::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3]]);
                    !n.is_nan() && !o.is_nan() && n > o
                }
                "double" => {
                    if new_val.len() < 8 || old_val.len() < 8 { return false; }
                    let n = f64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let o = f64::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3], old_val[4], old_val[5], old_val[6], old_val[7]]);
                    !n.is_nan() && !o.is_nan() && n > o
                }
                _ => false,
            }
        }
        "decreased" => {
            match data_type {
                "int8" => {
                    if new_val.is_empty() || old_val.is_empty() { return false; }
                    (new_val[0] as i8) < (old_val[0] as i8)
                }
                "uint8" => {
                    if new_val.is_empty() || old_val.is_empty() { return false; }
                    new_val[0] < old_val[0]
                }
                "int16" => {
                    if new_val.len() < 2 || old_val.len() < 2 { return false; }
                    i16::from_le_bytes([new_val[0], new_val[1]]) < i16::from_le_bytes([old_val[0], old_val[1]])
                }
                "uint16" => {
                    if new_val.len() < 2 || old_val.len() < 2 { return false; }
                    u16::from_le_bytes([new_val[0], new_val[1]]) < u16::from_le_bytes([old_val[0], old_val[1]])
                }
                "int32" => {
                    if new_val.len() < 4 || old_val.len() < 4 { return false; }
                    i32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]) < i32::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3]])
                }
                "uint32" => {
                    if new_val.len() < 4 || old_val.len() < 4 { return false; }
                    u32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]) < u32::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3]])
                }
                "int64" => {
                    if new_val.len() < 8 || old_val.len() < 8 { return false; }
                    i64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]) < 
                    i64::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3], old_val[4], old_val[5], old_val[6], old_val[7]])
                }
                "uint64" => {
                    if new_val.len() < 8 || old_val.len() < 8 { return false; }
                    u64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]) < 
                    u64::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3], old_val[4], old_val[5], old_val[6], old_val[7]])
                }
                "float" => {
                    if new_val.len() < 4 || old_val.len() < 4 { return false; }
                    let n = f32::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3]]);
                    let o = f32::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3]]);
                    !n.is_nan() && !o.is_nan() && n < o
                }
                "double" => {
                    if new_val.len() < 8 || old_val.len() < 8 { return false; }
                    let n = f64::from_le_bytes([new_val[0], new_val[1], new_val[2], new_val[3], new_val[4], new_val[5], new_val[6], new_val[7]]);
                    let o = f64::from_le_bytes([old_val[0], old_val[1], old_val[2], old_val[3], old_val[4], old_val[5], old_val[6], old_val[7]]);
                    !n.is_nan() && !o.is_nan() && n < o
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// Get data size for a given data type
fn get_data_size(data_type: &str) -> usize {
    match data_type {
        "int8" | "uint8" => 1,
        "int16" | "uint16" => 2,
        "int32" | "uint32" | "float" => 4,
        "int64" | "uint64" | "double" => 8,
        _ => 1,
    }
}

/// Native memory filter command - filters addresses locally using network memory reads
/// Optimizes by reading contiguous memory regions in bulk when there are many addresses
#[tauri::command]
async fn filter_memory_native(request: MemoryFilterRequest) -> Result<MemoryFilterResponse, String> {
    let (host, port) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port)
    };
    
    if host.is_empty() {
        return Ok(MemoryFilterResponse {
            success: false,
            results: vec![],
            total_processed: 0,
            error: Some("No server connection configured".to_string()),
        });
    }

    let data_size = get_data_size(&request.data_type);
    let pattern_bytes = hex::decode(&request.pattern).unwrap_or_default();
    let pattern_max_bytes = request.pattern_max.as_ref()
        .and_then(|p| hex::decode(p).ok());

    let addresses = &request.addresses;
    let old_values = &request.old_values;
    
    if addresses.is_empty() {
        return Ok(MemoryFilterResponse {
            success: true,
            results: vec![],
            total_processed: 0,
            error: None,
        });
    }

    let mut results: Vec<MemoryFilterResult> = Vec::new();
    
    // Optimization threshold: if more than 100 addresses and they span less than 1MB, read entire range
    const BULK_READ_THRESHOLD: usize = 100;
    const MAX_BULK_READ_SIZE: u64 = 1024 * 1024; // 1MB max for bulk read
    
    let min_addr = *addresses.iter().min().unwrap();
    let max_addr = *addresses.iter().max().unwrap();
    let addr_range = max_addr - min_addr + data_size as u64;
    
    if addresses.len() >= BULK_READ_THRESHOLD && addr_range <= MAX_BULK_READ_SIZE {
        // Bulk read: read the entire min-max range at once
        match read_memory_from_server(&host, port, min_addr, addr_range as usize).await {
            Ok(bulk_data) => {
                for (i, &addr) in addresses.iter().enumerate() {
                    let offset = (addr - min_addr) as usize;
                    if offset + data_size <= bulk_data.len() {
                        let new_val = &bulk_data[offset..offset + data_size];
                        let old_val = if i < old_values.len() { &old_values[i] } else { &[] as &[u8] };
                        
                        if compare_values(
                            new_val,
                            old_val,
                            &pattern_bytes,
                            pattern_max_bytes.as_deref(),
                            &request.data_type,
                            &request.filter_method,
                        ) {
                            results.push(MemoryFilterResult {
                                address: addr,
                                value: new_val.to_vec(),
                            });
                        }
                    }
                }
            }
            Err(e) => {
                return Ok(MemoryFilterResponse {
                    success: false,
                    results: vec![],
                    total_processed: 0,
                    error: Some(format!("Bulk memory read failed: {}", e)),
                });
            }
        }
    } else {
        // For fewer addresses or very scattered addresses, group into contiguous chunks
        // and read each chunk separately
        const CHUNK_GAP_THRESHOLD: u64 = 4096; // If gap is more than 4KB, start a new chunk
        const MAX_CHUNK_SIZE: usize = 65536; // Max 64KB per chunk
        
        // Sort addresses with their original indices
        let mut addr_indices: Vec<(u64, usize)> = addresses.iter().enumerate()
            .map(|(i, &a)| (a, i))
            .collect();
        addr_indices.sort_by_key(|&(a, _)| a);
        
        // Group into chunks
        let mut chunks: Vec<(u64, usize, Vec<(u64, usize)>)> = Vec::new(); // (start_addr, size, [(addr, original_idx)])
        
        for (addr, orig_idx) in addr_indices {
            if chunks.is_empty() {
                chunks.push((addr, data_size, vec![(addr, orig_idx)]));
            } else {
                let last = chunks.last_mut().unwrap();
                let gap = addr.saturating_sub(last.0 + last.1 as u64);
                let new_size = (addr - last.0) as usize + data_size;
                
                if gap <= CHUNK_GAP_THRESHOLD && new_size <= MAX_CHUNK_SIZE {
                    // Extend current chunk
                    last.1 = new_size;
                    last.2.push((addr, orig_idx));
                } else {
                    // Start new chunk
                    chunks.push((addr, data_size, vec![(addr, orig_idx)]));
                }
            }
        }
        
        // Read and process each chunk
        for (chunk_start, chunk_size, chunk_addrs) in chunks {
            match read_memory_from_server(&host, port, chunk_start, chunk_size).await {
                Ok(chunk_data) => {
                    for (addr, orig_idx) in chunk_addrs {
                        let offset = (addr - chunk_start) as usize;
                        if offset + data_size <= chunk_data.len() {
                            let new_val = &chunk_data[offset..offset + data_size];
                            let old_val = if orig_idx < old_values.len() { &old_values[orig_idx] } else { &[] as &[u8] };
                            
                            if compare_values(
                                new_val,
                                old_val,
                                &pattern_bytes,
                                pattern_max_bytes.as_deref(),
                                &request.data_type,
                                &request.filter_method,
                            ) {
                                results.push(MemoryFilterResult {
                                    address: addr,
                                    value: new_val.to_vec(),
                                });
                            }
                        }
                    }
                }
                Err(_) => {
                    // Skip this chunk on error, continue with others
                    continue;
                }
            }
        }
    }

    Ok(MemoryFilterResponse {
        success: true,
        results,
        total_processed: addresses.len(),
        error: None,
    })
}

/// Native lookup command - reads current values for a list of addresses
#[tauri::command]
async fn lookup_memory_native(addresses: Vec<u64>, data_type: String) -> Result<MemoryFilterResponse, String> {
    let (host, port) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port)
    };
    
    if host.is_empty() {
        return Ok(MemoryFilterResponse {
            success: false,
            results: vec![],
            total_processed: 0,
            error: Some("No server connection configured".to_string()),
        });
    }

    if addresses.is_empty() {
        return Ok(MemoryFilterResponse {
            success: true,
            results: vec![],
            total_processed: 0,
            error: None,
        });
    }

    let data_size = get_data_size(&data_type);
    let mut results: Vec<MemoryFilterResult> = Vec::new();
    
    // Use same chunking strategy as filter
    const BULK_READ_THRESHOLD: usize = 100;
    const MAX_BULK_READ_SIZE: u64 = 1024 * 1024;
    
    let min_addr = *addresses.iter().min().unwrap();
    let max_addr = *addresses.iter().max().unwrap();
    let addr_range = max_addr - min_addr + data_size as u64;
    
    if addresses.len() >= BULK_READ_THRESHOLD && addr_range <= MAX_BULK_READ_SIZE {
        match read_memory_from_server(&host, port, min_addr, addr_range as usize).await {
            Ok(bulk_data) => {
                for &addr in &addresses {
                    let offset = (addr - min_addr) as usize;
                    if offset + data_size <= bulk_data.len() {
                        results.push(MemoryFilterResult {
                            address: addr,
                            value: bulk_data[offset..offset + data_size].to_vec(),
                        });
                    }
                }
            }
            Err(e) => {
                return Ok(MemoryFilterResponse {
                    success: false,
                    results: vec![],
                    total_processed: 0,
                    error: Some(format!("Bulk memory read failed: {}", e)),
                });
            }
        }
    } else {
        const CHUNK_GAP_THRESHOLD: u64 = 4096;
        const MAX_CHUNK_SIZE: usize = 65536;
        
        let mut addr_indices: Vec<(u64, usize)> = addresses.iter().enumerate()
            .map(|(i, &a)| (a, i))
            .collect();
        addr_indices.sort_by_key(|&(a, _)| a);
        
        let mut chunks: Vec<(u64, usize, Vec<u64>)> = Vec::new();
        
        for (addr, _) in addr_indices {
            if chunks.is_empty() {
                chunks.push((addr, data_size, vec![addr]));
            } else {
                let last = chunks.last_mut().unwrap();
                let gap = addr.saturating_sub(last.0 + last.1 as u64);
                let new_size = (addr - last.0) as usize + data_size;
                
                if gap <= CHUNK_GAP_THRESHOLD && new_size <= MAX_CHUNK_SIZE {
                    last.1 = new_size;
                    last.2.push(addr);
                } else {
                    chunks.push((addr, data_size, vec![addr]));
                }
            }
        }
        
        for (chunk_start, chunk_size, chunk_addrs) in chunks {
            match read_memory_from_server(&host, port, chunk_start, chunk_size).await {
                Ok(chunk_data) => {
                    for addr in chunk_addrs {
                        let offset = (addr - chunk_start) as usize;
                        if offset + data_size <= chunk_data.len() {
                            results.push(MemoryFilterResult {
                                address: addr,
                                value: chunk_data[offset..offset + data_size].to_vec(),
                            });
                        }
                    }
                }
                Err(_) => continue,
            }
        }
    }

    Ok(MemoryFilterResponse {
        success: true,
        results,
        total_processed: addresses.len(),
        error: None,
    })
}

/// Unknown scan request structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnknownScanRequest {
    pub address_ranges: Vec<(u64, u64)>,  // [(start, end), ...]
    pub data_type: String,                 // "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float", "double"
    pub alignment: usize,                  // Alignment for scanning
    pub scan_id: String,                   // Unique scan ID for temp file storage
}

/// Unknown scan progress structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnknownScanProgress {
    pub scan_id: String,
    pub progress_percentage: f64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub found_count: u64,
    pub is_scanning: bool,
    pub current_region: Option<String>,
}

/// Unknown scan response - returns scan metadata (results stored in temp files)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnknownScanResponse {
    pub success: bool,
    pub scan_id: String,
    pub total_addresses: usize,
    pub temp_dir: String,
    pub error: Option<String>,
}

/// Unknown scan result for lookup
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnknownScanLookupResponse {
    pub success: bool,
    pub results: Vec<MemoryFilterResult>,
    pub total_count: usize,
    pub error: Option<String>,
}

// Global storage for unknown scan progress
static UNKNOWN_SCAN_PROGRESS: Lazy<RwLock<HashMap<String, UnknownScanProgress>>> = Lazy::new(|| {
    RwLock::new(HashMap::new())
});

/// Get temp directory for unknown scan data
fn get_unknown_scan_temp_dir(scan_id: &str) -> PathBuf {
    let temp_dir = std::env::temp_dir();
    temp_dir.join("dynadbg_unknown_scan").join(scan_id)
}

/// Native unknown scan command - scans memory ranges and saves to temp files
/// Progress can be queried via get_unknown_scan_progress
#[tauri::command]
async fn unknown_scan_native(request: UnknownScanRequest) -> Result<UnknownScanResponse, String> {
    let (host, port) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port)
    };
    
    if host.is_empty() {
        return Ok(UnknownScanResponse {
            success: false,
            scan_id: request.scan_id.clone(),
            total_addresses: 0,
            temp_dir: String::new(),
            error: Some("No server connection configured".to_string()),
        });
    }

    let data_size = get_data_size(&request.data_type);
    let alignment = if request.alignment > 0 { request.alignment } else { data_size };
    let scan_id = request.scan_id.clone();
    
    // Calculate total bytes to scan for progress
    let total_bytes: u64 = request.address_ranges.iter()
        .map(|(start, end)| end - start)
        .sum();
    
    // Create temp directory
    let temp_dir = get_unknown_scan_temp_dir(&scan_id);
    if let Err(e) = std::fs::create_dir_all(&temp_dir) {
        return Ok(UnknownScanResponse {
            success: false,
            scan_id,
            total_addresses: 0,
            temp_dir: String::new(),
            error: Some(format!("Failed to create temp directory: {}", e)),
        });
    }
    
    // Initialize progress
    {
        let mut progress_map = UNKNOWN_SCAN_PROGRESS.write().unwrap();
        progress_map.insert(scan_id.clone(), UnknownScanProgress {
            scan_id: scan_id.clone(),
            progress_percentage: 0.0,
            processed_bytes: 0,
            total_bytes,
            found_count: 0,
            is_scanning: true,
            current_region: Some("Starting scan...".to_string()),
        });
    }
    
    // Maximum chunk size for reading (4MB per read for efficiency)
    const MAX_READ_CHUNK: usize = 4 * 1024 * 1024;
    // Maximum sub-region size (64MB) - split large regions to avoid memory issues
    const MAX_SUB_REGION: u64 = 64 * 1024 * 1024;
    // Number of parallel reads
    const PARALLEL_READS: usize = 8;
    
    let total_found = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let processed_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let success_reads = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let failed_reads = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    
    // Split large regions into smaller sub-regions (max 64MB each)
    let mut sub_regions: Vec<(u64, u64)> = Vec::new();
    for (range_start, range_end) in &request.address_ranges {
        let mut current = *range_start;
        while current < *range_end {
            let sub_end = (current + MAX_SUB_REGION).min(*range_end);
            sub_regions.push((current, sub_end));
            current = sub_end;
        }
    }
    
    eprintln!("[Unknown Scan] Starting scan: {} original regions -> {} sub-regions (max {}MB each), total_bytes: {}", 
        request.address_ranges.len(), sub_regions.len(), MAX_SUB_REGION / 1024 / 1024, total_bytes);
    
    let total_sub_regions = sub_regions.len();
    
    // Process sub-regions in parallel (up to 4 at a time)
    let sub_region_chunks: Vec<_> = sub_regions.iter().enumerate().collect::<Vec<_>>()
        .chunks(4).map(|c| c.to_vec()).collect();
    
    for sub_region_batch in sub_region_chunks {
        let mut region_tasks = Vec::new();
        
        for (_sub_region_index, (range_start, range_end)) in sub_region_batch {
            let host = host.clone();
            let scan_id = scan_id.clone();
            let temp_dir = temp_dir.clone();
            let total_found = total_found.clone();
            let processed_bytes = processed_bytes.clone();
            let success_reads = success_reads.clone();
            let failed_reads = failed_reads.clone();
            let range_start = *range_start;
            let range_end = *range_end;
            let _total_sub_regions = total_sub_regions;
            
            let task = tokio::spawn(async move {
                let mut current_addr = range_start;
                
                // Align start address
                if current_addr % alignment as u64 != 0 {
                    current_addr = (current_addr / alignment as u64 + 1) * alignment as u64;
                }
                
                // Create file for this sub-region
                let region_file_path = temp_dir.join(format!("region_{:016x}_{:016x}.bin", range_start, range_end));
                let mut region_file = match std::fs::File::create(&region_file_path) {
                    Ok(f) => std::io::BufWriter::with_capacity(1024 * 1024, f), // 1MB buffer
                    Err(e) => {
                        eprintln!("[Unknown Scan] Failed to create region file: {}", e);
                        return (0u64, 0u64);
                    }
                };
                
                // Write header: data_size (4 bytes) + alignment (4 bytes) + start_addr (8 bytes)
                use std::io::Write;
                let _ = region_file.write_all(&(data_size as u32).to_le_bytes());
                let _ = region_file.write_all(&(alignment as u32).to_le_bytes());
                let _ = region_file.write_all(&range_start.to_le_bytes());
                
                let mut all_addresses: Vec<u64> = Vec::new();
                let mut all_data: Vec<u8> = Vec::new();
                
                // Split sub-region into chunks for parallel reading
                let region_size = (range_end - current_addr) as usize;
                let mut chunks_to_read: Vec<(u64, usize)> = Vec::new();
                
                let mut chunk_start = current_addr;
                while chunk_start < range_end {
                    let remaining = (range_end - chunk_start) as usize;
                    let chunk_size = remaining.min(MAX_READ_CHUNK);
                    chunks_to_read.push((chunk_start, chunk_size));
                    chunk_start += chunk_size as u64;
                }
                
                // Process chunks in parallel batches
                for chunk_batch in chunks_to_read.chunks(PARALLEL_READS) {
                    let mut read_tasks = Vec::new();
                    
                    for (addr, size) in chunk_batch.iter().cloned() {
                        let host = host.clone();
                        let read_task = tokio::spawn(async move {
                            // Add timeout to prevent hanging on unresponsive regions
                            match tokio::time::timeout(
                                std::time::Duration::from_secs(2),
                                read_memory_from_server(&host, port, addr, size)
                            ).await {
                                Ok(Ok(data)) => Some((addr, data)),
                                Ok(Err(_)) => None,
                                Err(_) => None, // Timeout
                            }
                        });
                        read_tasks.push((addr, size, read_task));
                    }
                    
                    // Collect results and maintain order
                    let mut results: Vec<(u64, Option<Vec<u8>>, usize)> = Vec::new();
                    for (addr, size, task) in read_tasks {
                        match task.await {
                            Ok(result) => results.push((addr, result.map(|(_, d)| d), size)),
                            Err(_) => results.push((addr, None, size)),
                        }
                    }
                    
                    // Sort by address to maintain order
                    results.sort_by_key(|(addr, _, _)| *addr);
                    
                    for (addr, data_opt, chunk_size) in results {
                        if let Some(chunk_data) = data_opt {
                            success_reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            
                            // Extract values at aligned positions
                            let mut offset: usize = 0;
                            while offset + data_size <= chunk_data.len() {
                                let value_addr = addr + offset as u64;
                                all_addresses.push(value_addr);
                                all_data.extend_from_slice(&chunk_data[offset..offset + data_size]);
                                offset += alignment;
                            }
                        } else {
                            failed_reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        
                        // Update progress after each chunk
                        processed_bytes.fetch_add(chunk_size as u64, std::sync::atomic::Ordering::Relaxed);
                        let current_processed = processed_bytes.load(std::sync::atomic::Ordering::Relaxed);
                        let progress = if total_bytes > 0 {
                            (current_processed as f64 / total_bytes as f64) * 100.0
                        } else {
                            0.0
                        };
                        
                        if let Ok(mut progress_map) = UNKNOWN_SCAN_PROGRESS.write() {
                            if let Some(p) = progress_map.get_mut(&scan_id) {
                                p.progress_percentage = progress;
                                p.processed_bytes = current_processed;
                                p.found_count = total_found.load(std::sync::atomic::Ordering::Relaxed) + all_addresses.len() as u64;
                            }
                        }
                    }
                }
                
                let region_found = all_addresses.len() as u64;
                
                // Compress and write region data using lz4
                if !all_data.is_empty() {
                    // Write number of addresses
                    let _ = region_file.write_all(&(all_addresses.len() as u64).to_le_bytes());
                    
                    // Write addresses (compressed)
                    let addr_bytes: Vec<u8> = all_addresses.iter()
                        .flat_map(|a| a.to_le_bytes())
                        .collect();
                    let compressed_addrs = lz4_flex::compress_prepend_size(&addr_bytes);
                    let _ = region_file.write_all(&(compressed_addrs.len() as u64).to_le_bytes());
                    let _ = region_file.write_all(&compressed_addrs);
                    
                    // Write values (compressed)
                    let compressed_data = lz4_flex::compress_prepend_size(&all_data);
                    let _ = region_file.write_all(&(compressed_data.len() as u64).to_le_bytes());
                    let _ = region_file.write_all(&compressed_data);
                }
                
                let _ = region_file.flush();
                
                (region_found, region_size as u64)
            });
            
            region_tasks.push(task);
        }
        
        // Wait for all region tasks in this batch
        for task in region_tasks {
            if let Ok((found, _)) = task.await {
                total_found.fetch_add(found, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
    
    let final_found = total_found.load(std::sync::atomic::Ordering::Relaxed);
    let final_success = success_reads.load(std::sync::atomic::Ordering::Relaxed);
    let final_failed = failed_reads.load(std::sync::atomic::Ordering::Relaxed);
    
    eprintln!("[Unknown Scan] Completed: total_found={}, success_reads={}, failed_reads={}, temp_dir={}", 
        final_found, final_success, final_failed, temp_dir.display());
    
    // Mark scan as complete
    {
        let mut progress_map = UNKNOWN_SCAN_PROGRESS.write().unwrap();
        if let Some(p) = progress_map.get_mut(&scan_id) {
            p.progress_percentage = 100.0;
            p.processed_bytes = total_bytes;
            p.found_count = final_found;
            p.is_scanning = false;
            p.current_region = None;
        }
    }

    Ok(UnknownScanResponse {
        success: true,
        scan_id: scan_id.clone(),
        total_addresses: final_found as usize,
        temp_dir: temp_dir.to_string_lossy().to_string(),
        error: None,
    })
}

/// Initialize unknown scan progress (call before starting scan to prevent race condition)
#[tauri::command]
fn init_unknown_scan_progress(scan_id: String, total_bytes: u64) -> Result<(), String> {
    let mut progress_map = UNKNOWN_SCAN_PROGRESS.write().unwrap();
    progress_map.insert(scan_id.clone(), UnknownScanProgress {
        scan_id,
        progress_percentage: 0.0,
        processed_bytes: 0,
        total_bytes,
        found_count: 0,
        is_scanning: true,
        current_region: Some("Initializing...".to_string()),
    });
    Ok(())
}

/// Get unknown scan progress
#[tauri::command]
fn get_unknown_scan_progress(scan_id: String) -> Result<UnknownScanProgress, String> {
    let progress_map = UNKNOWN_SCAN_PROGRESS.read().unwrap();
    if let Some(progress) = progress_map.get(&scan_id) {
        Ok(progress.clone())
    } else {
        // Return is_scanning: true when not found - scan might be starting
        Ok(UnknownScanProgress {
            scan_id,
            progress_percentage: 0.0,
            processed_bytes: 0,
            total_bytes: 0,
            found_count: 0,
            is_scanning: true,
            current_region: Some("Waiting for scan to start...".to_string()),
        })
    }
}

/// Load unknown scan results from temp files (for display/lookup)
#[tauri::command]
#[allow(unused_assignments)]
async fn load_unknown_scan_results(scan_id: String, offset: usize, limit: usize) -> Result<UnknownScanLookupResponse, String> {
    let temp_dir = get_unknown_scan_temp_dir(&scan_id);
    
    if !temp_dir.exists() {
        return Ok(UnknownScanLookupResponse {
            success: false,
            results: vec![],
            total_count: 0,
            error: Some("Scan data not found".to_string()),
        });
    }
    
    let mut all_results: Vec<MemoryFilterResult> = Vec::new();
    let mut total_count: usize = 0;
    
    // Read all region files
    let entries = match std::fs::read_dir(&temp_dir) {
        Ok(e) => e,
        Err(e) => return Ok(UnknownScanLookupResponse {
            success: false,
            results: vec![],
            total_count: 0,
            error: Some(format!("Failed to read temp directory: {}", e)),
        }),
    };
    
    let mut files: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    files.sort_by_key(|e| e.path());
    
    for entry in files {
        let path = entry.path();
        if !path.extension().map_or(false, |e| e == "bin") {
            continue;
        }
        
        let file_data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        
        if file_data.len() < 28 {
            continue;
        }
        
        let mut pos = 0;
        
        // Read header
        let _data_size = u32::from_le_bytes([file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3]]) as usize;
        pos += 4;
        let _alignment = u32::from_le_bytes([file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3]]) as usize;
        pos += 4;
        let _start_addr = u64::from_le_bytes([
            file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3],
            file_data[pos+4], file_data[pos+5], file_data[pos+6], file_data[pos+7]
        ]);
        pos += 8;
        
        // Read number of addresses
        let addr_count = u64::from_le_bytes([
            file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3],
            file_data[pos+4], file_data[pos+5], file_data[pos+6], file_data[pos+7]
        ]) as usize;
        pos += 8;
        
        total_count += addr_count;
        
        // Skip if we haven't reached offset yet
        if total_count <= offset {
            // Skip compressed data
            let compressed_addr_len = u64::from_le_bytes([
                file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3],
                file_data[pos+4], file_data[pos+5], file_data[pos+6], file_data[pos+7]
            ]) as usize;
            pos += 8 + compressed_addr_len;
            
            let compressed_data_len = u64::from_le_bytes([
                file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3],
                file_data[pos+4], file_data[pos+5], file_data[pos+6], file_data[pos+7]
            ]) as usize;
            pos += 8 + compressed_data_len;
            continue;
        }
        
        // Read compressed addresses
        let compressed_addr_len = u64::from_le_bytes([
            file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3],
            file_data[pos+4], file_data[pos+5], file_data[pos+6], file_data[pos+7]
        ]) as usize;
        pos += 8;
        
        let compressed_addrs = &file_data[pos..pos + compressed_addr_len];
        pos += compressed_addr_len;
        
        let addr_bytes = match lz4_flex::decompress_size_prepended(compressed_addrs) {
            Ok(d) => d,
            Err(_) => continue,
        };
        
        // Read compressed values
        let compressed_data_len = u64::from_le_bytes([
            file_data[pos], file_data[pos+1], file_data[pos+2], file_data[pos+3],
            file_data[pos+4], file_data[pos+5], file_data[pos+6], file_data[pos+7]
        ]) as usize;
        pos += 8;
        
        let compressed_values = &file_data[pos..pos + compressed_data_len];
        
        let value_bytes = match lz4_flex::decompress_size_prepended(compressed_values) {
            Ok(d) => d,
            Err(_) => continue,
        };
        
        // Parse addresses and values
        let data_size = _data_size;
        let start_idx = if total_count - addr_count <= offset { offset - (total_count - addr_count) } else { 0 };
        let end_idx = (start_idx + limit - all_results.len()).min(addr_count);
        
        for i in start_idx..end_idx {
            if all_results.len() >= limit {
                break;
            }
            
            let addr_offset = i * 8;
            if addr_offset + 8 <= addr_bytes.len() {
                let addr = u64::from_le_bytes([
                    addr_bytes[addr_offset], addr_bytes[addr_offset+1],
                    addr_bytes[addr_offset+2], addr_bytes[addr_offset+3],
                    addr_bytes[addr_offset+4], addr_bytes[addr_offset+5],
                    addr_bytes[addr_offset+6], addr_bytes[addr_offset+7],
                ]);
                
                let val_offset = i * data_size;
                if val_offset + data_size <= value_bytes.len() {
                    all_results.push(MemoryFilterResult {
                        address: addr,
                        value: value_bytes[val_offset..val_offset + data_size].to_vec(),
                    });
                }
            }
        }
        
        if all_results.len() >= limit {
            break;
        }
    }
    
    Ok(UnknownScanLookupResponse {
        success: true,
        results: all_results,
        total_count,
        error: None,
    })
}

/// Clear unknown scan temp files
#[tauri::command]
fn clear_unknown_scan(scan_id: String) -> Result<bool, String> {
    let temp_dir = get_unknown_scan_temp_dir(&scan_id);
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    
    // Remove progress entry
    if let Ok(mut progress_map) = UNKNOWN_SCAN_PROGRESS.write() {
        progress_map.remove(&scan_id);
    }
    
    Ok(true)
}

/// Get the unknown scan data file path
fn get_unknown_scan_data_file(scan_id: &str) -> PathBuf {
    std::env::temp_dir()
        .join("dynadbg_unknown_scan")
        .join(format!("{}.bin", scan_id))
}

/// Initialize unknown scan streaming file (creates fresh file)
#[tauri::command]
fn init_unknown_scan_file(scan_id: String, alignment: u32, data_size: u32) -> Result<String, String> {
    let file_path = get_unknown_scan_data_file(&scan_id);
    
    // Ensure parent directory exists
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    
    // Create file with header: alignment (4 bytes) + data_size (4 bytes) + chunk_count (8 bytes)
    let header = [
        alignment.to_le_bytes().as_slice(),
        data_size.to_le_bytes().as_slice(),
        0u64.to_le_bytes().as_slice(),  // chunk_count placeholder
    ].concat();
    
    std::fs::write(&file_path, &header).map_err(|e| format!("Failed to create file: {}", e))?;
    
    Ok(file_path.to_string_lossy().to_string())
}

/// Append a compressed chunk to the unknown scan file
/// Each chunk format: offset (8 bytes) + compressed_len (8 bytes) + compressed_data
#[tauri::command]
fn append_unknown_scan_chunk(
    scan_id: String,
    offset: u64,
    compressed_data: Vec<u8>
) -> Result<bool, String> {
    use std::io::Write;
    
    let file_path = get_unknown_scan_data_file(&scan_id);
    
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    // Write: offset (8 bytes) + compressed_len (8 bytes) + compressed_data
    file.write_all(&offset.to_le_bytes()).map_err(|e| format!("Write offset failed: {}", e))?;
    file.write_all(&(compressed_data.len() as u64).to_le_bytes()).map_err(|e| format!("Write len failed: {}", e))?;
    file.write_all(&compressed_data).map_err(|e| format!("Write data failed: {}", e))?;
    
    Ok(true)
}

/// Update the chunk count in file header
#[tauri::command]
fn finalize_unknown_scan_file(scan_id: String, chunk_count: u64) -> Result<bool, String> {
    use std::io::{Seek, SeekFrom, Write};
    
    let file_path = get_unknown_scan_data_file(&scan_id);
    
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    // Write chunk_count at offset 8 (after alignment + data_size)
    file.seek(SeekFrom::Start(8)).map_err(|e| format!("Seek failed: {}", e))?;
    file.write_all(&chunk_count.to_le_bytes()).map_err(|e| format!("Write chunk count failed: {}", e))?;
    
    Ok(true)
}

/// Get unknown scan file info
#[tauri::command]
fn get_unknown_scan_file_info(scan_id: String) -> Result<serde_json::Value, String> {
    let file_path = get_unknown_scan_data_file(&scan_id);
    
    if !file_path.exists() {
        return Err("File not found".to_string());
    }
    
    let metadata = std::fs::metadata(&file_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;
    
    // Read header
    let file_data = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    if file_data.len() < 16 {
        return Err("Invalid file header".to_string());
    }
    
    let alignment = u32::from_le_bytes([file_data[0], file_data[1], file_data[2], file_data[3]]);
    let data_size = u32::from_le_bytes([file_data[4], file_data[5], file_data[6], file_data[7]]);
    let chunk_count = u64::from_le_bytes([
        file_data[8], file_data[9], file_data[10], file_data[11],
        file_data[12], file_data[13], file_data[14], file_data[15]
    ]);
    
    Ok(serde_json::json!({
        "path": file_path.to_string_lossy(),
        "size": metadata.len(),
        "alignment": alignment,
        "data_size": data_size,
        "chunk_count": chunk_count,
    }))
}

#[tauri::command]
async fn read_memory(address: u64, size: usize) -> Result<MemoryReadResponse, String> {
    let (host, port) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port)
    };
    
    if host.is_empty() {
        return Ok(MemoryReadResponse {
            success: false,
            data: None,
            error: Some("No server connection configured".to_string()),
        });
    }

    let client = reqwest::Client::new();
    let url = format!("http://{}:{}/api/memory/read", host, port);
    
    let request_body = serde_json::json!({
        "address": address,
        "size": size
    });

    match client.post(&url).json(&request_body).send().await {
        Ok(response) => {
            if response.status().is_success() {
                match response.json::<serde_json::Value>().await {
                    Ok(json_response) => {
                        if let Some(data_str) = json_response.get("data").and_then(|v| v.as_str()) {
                            // Convert hex string to bytes
                            let hex_clean = data_str.replace(" ", "").replace("\n", "");
                            let mut bytes = Vec::new();
                            
                            // Parse hex string in pairs
                            for chunk in hex_clean.chars().collect::<Vec<char>>().chunks(2) {
                                if chunk.len() == 2 {
                                    let hex_str: String = chunk.iter().collect();
                                    if let Ok(byte) = u8::from_str_radix(&hex_str, 16) {
                                        bytes.push(byte);
                                    }
                                }
                            }
                            
                            Ok(MemoryReadResponse {
                                success: true,
                                data: Some(bytes),
                                error: None,
                            })
                        } else {
                            Ok(MemoryReadResponse {
                                success: false,
                                data: None,
                                error: Some("Invalid response format - no data field".to_string()),
                            })
                        }
                    }
                    Err(e) => Ok(MemoryReadResponse {
                        success: false,
                        data: None,
                        error: Some(format!("Failed to parse response: {}", e)),
                    })
                }
            } else {
                Ok(MemoryReadResponse {
                    success: false,
                    data: None,
                    error: Some(format!("Server error: {}", response.status())),
                })
            }
        }
        Err(e) => Ok(MemoryReadResponse {
            success: false,
            data: None,
            error: Some(format!("Network error: {}", e)),
        })
    }
}

/// WASM opcode to mnemonic mapping (basic opcodes)
fn wasm_opcode_to_string(opcode: u8) -> (&'static str, usize) {
    // Returns (mnemonic, instruction_length including opcode)
    match opcode {
        // Control instructions
        0x00 => ("unreachable", 1),
        0x01 => ("nop", 1),
        0x02 => ("block", 2),      // + blocktype
        0x03 => ("loop", 2),       // + blocktype
        0x04 => ("if", 2),         // + blocktype
        0x05 => ("else", 1),
        0x0B => ("end", 1),
        0x0C => ("br", 2),         // + labelidx
        0x0D => ("br_if", 2),      // + labelidx
        0x0E => ("br_table", 2),   // variable, simplified
        0x0F => ("return", 1),
        0x10 => ("call", 5),       // + funcidx (leb128)
        0x11 => ("call_indirect", 6), // + typeidx + tableidx
        
        // Parametric instructions
        0x1A => ("drop", 1),
        0x1B => ("select", 1),
        0x1C => ("select", 2),     // typed select
        
        // Variable instructions
        0x20 => ("local.get", 2),
        0x21 => ("local.set", 2),
        0x22 => ("local.tee", 2),
        0x23 => ("global.get", 2),
        0x24 => ("global.set", 2),
        
        // Table instructions
        0x25 => ("table.get", 2),
        0x26 => ("table.set", 2),
        
        // Memory instructions
        0x28 => ("i32.load", 3),
        0x29 => ("i64.load", 3),
        0x2A => ("f32.load", 3),
        0x2B => ("f64.load", 3),
        0x2C => ("i32.load8_s", 3),
        0x2D => ("i32.load8_u", 3),
        0x2E => ("i32.load16_s", 3),
        0x2F => ("i32.load16_u", 3),
        0x30 => ("i64.load8_s", 3),
        0x31 => ("i64.load8_u", 3),
        0x32 => ("i64.load16_s", 3),
        0x33 => ("i64.load16_u", 3),
        0x34 => ("i64.load32_s", 3),
        0x35 => ("i64.load32_u", 3),
        0x36 => ("i32.store", 3),
        0x37 => ("i64.store", 3),
        0x38 => ("f32.store", 3),
        0x39 => ("f64.store", 3),
        0x3A => ("i32.store8", 3),
        0x3B => ("i32.store16", 3),
        0x3C => ("i64.store8", 3),
        0x3D => ("i64.store16", 3),
        0x3E => ("i64.store32", 3),
        0x3F => ("memory.size", 2),
        0x40 => ("memory.grow", 2),
        
        // Numeric instructions - constants
        0x41 => ("i32.const", 5),   // + i32 leb128
        0x42 => ("i64.const", 9),   // + i64 leb128
        0x43 => ("f32.const", 5),   // + f32
        0x44 => ("f64.const", 9),   // + f64
        
        // Numeric instructions - comparison
        0x45 => ("i32.eqz", 1),
        0x46 => ("i32.eq", 1),
        0x47 => ("i32.ne", 1),
        0x48 => ("i32.lt_s", 1),
        0x49 => ("i32.lt_u", 1),
        0x4A => ("i32.gt_s", 1),
        0x4B => ("i32.gt_u", 1),
        0x4C => ("i32.le_s", 1),
        0x4D => ("i32.le_u", 1),
        0x4E => ("i32.ge_s", 1),
        0x4F => ("i32.ge_u", 1),
        
        0x50 => ("i64.eqz", 1),
        0x51 => ("i64.eq", 1),
        0x52 => ("i64.ne", 1),
        0x53 => ("i64.lt_s", 1),
        0x54 => ("i64.lt_u", 1),
        0x55 => ("i64.gt_s", 1),
        0x56 => ("i64.gt_u", 1),
        0x57 => ("i64.le_s", 1),
        0x58 => ("i64.le_u", 1),
        0x59 => ("i64.ge_s", 1),
        0x5A => ("i64.ge_u", 1),
        
        0x5B => ("f32.eq", 1),
        0x5C => ("f32.ne", 1),
        0x5D => ("f32.lt", 1),
        0x5E => ("f32.gt", 1),
        0x5F => ("f32.le", 1),
        0x60 => ("f32.ge", 1),
        
        0x61 => ("f64.eq", 1),
        0x62 => ("f64.ne", 1),
        0x63 => ("f64.lt", 1),
        0x64 => ("f64.gt", 1),
        0x65 => ("f64.le", 1),
        0x66 => ("f64.ge", 1),
        
        // Numeric instructions - arithmetic
        0x67 => ("i32.clz", 1),
        0x68 => ("i32.ctz", 1),
        0x69 => ("i32.popcnt", 1),
        0x6A => ("i32.add", 1),
        0x6B => ("i32.sub", 1),
        0x6C => ("i32.mul", 1),
        0x6D => ("i32.div_s", 1),
        0x6E => ("i32.div_u", 1),
        0x6F => ("i32.rem_s", 1),
        0x70 => ("i32.rem_u", 1),
        0x71 => ("i32.and", 1),
        0x72 => ("i32.or", 1),
        0x73 => ("i32.xor", 1),
        0x74 => ("i32.shl", 1),
        0x75 => ("i32.shr_s", 1),
        0x76 => ("i32.shr_u", 1),
        0x77 => ("i32.rotl", 1),
        0x78 => ("i32.rotr", 1),
        
        0x79 => ("i64.clz", 1),
        0x7A => ("i64.ctz", 1),
        0x7B => ("i64.popcnt", 1),
        0x7C => ("i64.add", 1),
        0x7D => ("i64.sub", 1),
        0x7E => ("i64.mul", 1),
        0x7F => ("i64.div_s", 1),
        0x80 => ("i64.div_u", 1),
        0x81 => ("i64.rem_s", 1),
        0x82 => ("i64.rem_u", 1),
        0x83 => ("i64.and", 1),
        0x84 => ("i64.or", 1),
        0x85 => ("i64.xor", 1),
        0x86 => ("i64.shl", 1),
        0x87 => ("i64.shr_s", 1),
        0x88 => ("i64.shr_u", 1),
        0x89 => ("i64.rotl", 1),
        0x8A => ("i64.rotr", 1),
        
        // Float operations
        0x8B => ("f32.abs", 1),
        0x8C => ("f32.neg", 1),
        0x8D => ("f32.ceil", 1),
        0x8E => ("f32.floor", 1),
        0x8F => ("f32.trunc", 1),
        0x90 => ("f32.nearest", 1),
        0x91 => ("f32.sqrt", 1),
        0x92 => ("f32.add", 1),
        0x93 => ("f32.sub", 1),
        0x94 => ("f32.mul", 1),
        0x95 => ("f32.div", 1),
        0x96 => ("f32.min", 1),
        0x97 => ("f32.max", 1),
        0x98 => ("f32.copysign", 1),
        
        0x99 => ("f64.abs", 1),
        0x9A => ("f64.neg", 1),
        0x9B => ("f64.ceil", 1),
        0x9C => ("f64.floor", 1),
        0x9D => ("f64.trunc", 1),
        0x9E => ("f64.nearest", 1),
        0x9F => ("f64.sqrt", 1),
        0xA0 => ("f64.add", 1),
        0xA1 => ("f64.sub", 1),
        0xA2 => ("f64.mul", 1),
        0xA3 => ("f64.div", 1),
        0xA4 => ("f64.min", 1),
        0xA5 => ("f64.max", 1),
        0xA6 => ("f64.copysign", 1),
        
        // Conversions
        0xA7 => ("i32.wrap_i64", 1),
        0xA8 => ("i32.trunc_f32_s", 1),
        0xA9 => ("i32.trunc_f32_u", 1),
        0xAA => ("i32.trunc_f64_s", 1),
        0xAB => ("i32.trunc_f64_u", 1),
        0xAC => ("i64.extend_i32_s", 1),
        0xAD => ("i64.extend_i32_u", 1),
        0xAE => ("i64.trunc_f32_s", 1),
        0xAF => ("i64.trunc_f32_u", 1),
        0xB0 => ("i64.trunc_f64_s", 1),
        0xB1 => ("i64.trunc_f64_u", 1),
        0xB2 => ("f32.convert_i32_s", 1),
        0xB3 => ("f32.convert_i32_u", 1),
        0xB4 => ("f32.convert_i64_s", 1),
        0xB5 => ("f32.convert_i64_u", 1),
        0xB6 => ("f32.demote_f64", 1),
        0xB7 => ("f64.convert_i32_s", 1),
        0xB8 => ("f64.convert_i32_u", 1),
        0xB9 => ("f64.convert_i64_s", 1),
        0xBA => ("f64.convert_i64_u", 1),
        0xBB => ("f64.promote_f32", 1),
        0xBC => ("i32.reinterpret_f32", 1),
        0xBD => ("i64.reinterpret_f64", 1),
        0xBE => ("f32.reinterpret_i32", 1),
        0xBF => ("f64.reinterpret_i64", 1),
        
        // Sign extension
        0xC0 => ("i32.extend8_s", 1),
        0xC1 => ("i32.extend16_s", 1),
        0xC2 => ("i64.extend8_s", 1),
        0xC3 => ("i64.extend16_s", 1),
        0xC4 => ("i64.extend32_s", 1),
        
        // Multi-byte opcodes (FC prefix)
        0xFC => ("(FC prefix)", 2),
        // Multi-byte opcodes (FD prefix - SIMD)
        0xFD => ("(FD simd)", 2),
        
        _ => ("unknown", 1),
    }
}

/// Read unsigned LEB128 from bytes, returns (value, bytes_consumed)
fn read_uleb128(data: &[u8], offset: usize) -> (u64, usize) {
    let mut result: u64 = 0;
    let mut shift = 0;
    let mut idx = 0;
    
    while offset + idx < data.len() {
        let byte = data[offset + idx];
        result |= ((byte & 0x7f) as u64) << shift;
        idx += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            break;
        }
    }
    
    (result, idx)
}

/// Read signed LEB128 from bytes
fn read_sleb128(data: &[u8], offset: usize) -> (i64, usize) {
    let mut result: i64 = 0;
    let mut shift = 0;
    let mut idx = 0;
    let mut byte = 0u8;
    
    while offset + idx < data.len() {
        byte = data[offset + idx];
        result |= ((byte & 0x7f) as i64) << shift;
        shift += 7;
        idx += 1;
        if byte & 0x80 == 0 {
            break;
        }
        if shift >= 64 {
            break;
        }
    }
    
    // Sign extend if needed
    if shift < 64 && (byte & 0x40) != 0 {
        result |= !0i64 << shift;
    }
    
    (result, idx)
}

/// Get WASM instruction info: (mnemonic, total_bytes, operand_string, is_branch, branch_target_offset)
fn decode_wasm_instruction(data: &[u8], offset: usize, _base_address: u64) -> (String, usize, String, bool, Option<u64>) {
    if offset >= data.len() {
        return ("".to_string(), 0, "".to_string(), false, None);
    }
    
    let opcode = data[offset];
    let mut consumed = 1usize;
    let mut operand = String::new();
    let mut is_branch = false;
    let mut branch_target: Option<u64> = None;
    
    let mnemonic = match opcode {
        // Control instructions
        0x00 => "unreachable",
        0x01 => "nop",
        0x02 => { // block
            if offset + 1 < data.len() {
                let blocktype = data[offset + 1] as i8;
                consumed += 1;
                operand = match blocktype {
                    0x40 => "".to_string(),
                    t => format!("{:02x}", t as u8),
                };
            }
            "block"
        }
        0x03 => { // loop
            if offset + 1 < data.len() {
                let blocktype = data[offset + 1] as i8;
                consumed += 1;
                operand = match blocktype {
                    0x40 => "".to_string(),
                    t => format!("{:02x}", t as u8),
                };
            }
            "loop"
        }
        0x04 => { // if
            if offset + 1 < data.len() {
                consumed += 1;
            }
            "if"
        }
        0x05 => "else",
        0x0B => "end",
        0x0C => { // br
            let (labelidx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", labelidx);
            is_branch = true;
            "br"
        }
        0x0D => { // br_if
            let (labelidx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", labelidx);
            is_branch = true;
            "br_if"
        }
        0x0E => { // br_table
            let (count, len1) = read_uleb128(data, offset + 1);
            consumed += len1;
            let mut labels = Vec::new();
            for _ in 0..=count {
                let (label, len) = read_uleb128(data, offset + consumed);
                labels.push(label);
                consumed += len;
            }
            operand = labels.iter().map(|l| l.to_string()).collect::<Vec<_>>().join(" ");
            is_branch = true;
            "br_table"
        }
        0x0F => "return",
        0x10 => { // call
            let (funcidx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("func[{}]", funcidx);
            is_branch = true;
            branch_target = Some(funcidx); // Function index as target
            "call"
        }
        0x11 => { // call_indirect
            let (typeidx, len1) = read_uleb128(data, offset + 1);
            consumed += len1;
            let (tableidx, len2) = read_uleb128(data, offset + 1 + len1);
            consumed += len2;
            operand = format!("type[{}] table[{}]", typeidx, tableidx);
            "call_indirect"
        }
        
        // Parametric
        0x1A => "drop",
        0x1B => "select",
        
        // Variable instructions
        0x20 => { // local.get
            let (idx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", idx);
            "local.get"
        }
        0x21 => { // local.set
            let (idx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", idx);
            "local.set"
        }
        0x22 => { // local.tee
            let (idx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", idx);
            "local.tee"
        }
        0x23 => { // global.get
            let (idx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", idx);
            "global.get"
        }
        0x24 => { // global.set
            let (idx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", idx);
            "global.set"
        }
        
        // Memory load/store
        0x28..=0x3E => {
            let (align, len1) = read_uleb128(data, offset + 1);
            consumed += len1;
            let (mem_offset, len2) = read_uleb128(data, offset + 1 + len1);
            consumed += len2;
            operand = format!("align={} offset={}", align, mem_offset);
            match opcode {
                0x28 => "i32.load",
                0x29 => "i64.load",
                0x2A => "f32.load",
                0x2B => "f64.load",
                0x2C => "i32.load8_s",
                0x2D => "i32.load8_u",
                0x2E => "i32.load16_s",
                0x2F => "i32.load16_u",
                0x30 => "i64.load8_s",
                0x31 => "i64.load8_u",
                0x32 => "i64.load16_s",
                0x33 => "i64.load16_u",
                0x34 => "i64.load32_s",
                0x35 => "i64.load32_u",
                0x36 => "i32.store",
                0x37 => "i64.store",
                0x38 => "f32.store",
                0x39 => "f64.store",
                0x3A => "i32.store8",
                0x3B => "i32.store16",
                0x3C => "i64.store8",
                0x3D => "i64.store16",
                0x3E => "i64.store32",
                _ => "memory_op",
            }
        }
        0x3F => { // memory.size
            let (memidx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", memidx);
            "memory.size"
        }
        0x40 => { // memory.grow
            let (memidx, len) = read_uleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", memidx);
            "memory.grow"
        }
        
        // Constants
        0x41 => { // i32.const
            let (val, len) = read_sleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", val as i32);
            "i32.const"
        }
        0x42 => { // i64.const
            let (val, len) = read_sleb128(data, offset + 1);
            consumed += len;
            operand = format!("{}", val);
            "i64.const"
        }
        0x43 => { // f32.const
            if offset + 5 <= data.len() {
                let bytes = [data[offset+1], data[offset+2], data[offset+3], data[offset+4]];
                let val = f32::from_le_bytes(bytes);
                operand = format!("{}", val);
                consumed += 4;
            }
            "f32.const"
        }
        0x44 => { // f64.const
            if offset + 9 <= data.len() {
                let bytes = [data[offset+1], data[offset+2], data[offset+3], data[offset+4],
                             data[offset+5], data[offset+6], data[offset+7], data[offset+8]];
                let val = f64::from_le_bytes(bytes);
                operand = format!("{}", val);
                consumed += 8;
            }
            "f64.const"
        }
        
        // Comparison i32
        0x45 => "i32.eqz",
        0x46 => "i32.eq",
        0x47 => "i32.ne",
        0x48 => "i32.lt_s",
        0x49 => "i32.lt_u",
        0x4A => "i32.gt_s",
        0x4B => "i32.gt_u",
        0x4C => "i32.le_s",
        0x4D => "i32.le_u",
        0x4E => "i32.ge_s",
        0x4F => "i32.ge_u",
        
        // Comparison i64
        0x50 => "i64.eqz",
        0x51 => "i64.eq",
        0x52 => "i64.ne",
        0x53 => "i64.lt_s",
        0x54 => "i64.lt_u",
        0x55 => "i64.gt_s",
        0x56 => "i64.gt_u",
        0x57 => "i64.le_s",
        0x58 => "i64.le_u",
        0x59 => "i64.ge_s",
        0x5A => "i64.ge_u",
        
        // Comparison f32
        0x5B => "f32.eq",
        0x5C => "f32.ne",
        0x5D => "f32.lt",
        0x5E => "f32.gt",
        0x5F => "f32.le",
        0x60 => "f32.ge",
        
        // Comparison f64
        0x61 => "f64.eq",
        0x62 => "f64.ne",
        0x63 => "f64.lt",
        0x64 => "f64.gt",
        0x65 => "f64.le",
        0x66 => "f64.ge",
        
        // Numeric i32
        0x67 => "i32.clz",
        0x68 => "i32.ctz",
        0x69 => "i32.popcnt",
        0x6A => "i32.add",
        0x6B => "i32.sub",
        0x6C => "i32.mul",
        0x6D => "i32.div_s",
        0x6E => "i32.div_u",
        0x6F => "i32.rem_s",
        0x70 => "i32.rem_u",
        0x71 => "i32.and",
        0x72 => "i32.or",
        0x73 => "i32.xor",
        0x74 => "i32.shl",
        0x75 => "i32.shr_s",
        0x76 => "i32.shr_u",
        0x77 => "i32.rotl",
        0x78 => "i32.rotr",
        
        // Numeric i64
        0x79 => "i64.clz",
        0x7A => "i64.ctz",
        0x7B => "i64.popcnt",
        0x7C => "i64.add",
        0x7D => "i64.sub",
        0x7E => "i64.mul",
        0x7F => "i64.div_s",
        0x80 => "i64.div_u",
        0x81 => "i64.rem_s",
        0x82 => "i64.rem_u",
        0x83 => "i64.and",
        0x84 => "i64.or",
        0x85 => "i64.xor",
        0x86 => "i64.shl",
        0x87 => "i64.shr_s",
        0x88 => "i64.shr_u",
        0x89 => "i64.rotl",
        0x8A => "i64.rotr",
        
        // Numeric f32
        0x8B => "f32.abs",
        0x8C => "f32.neg",
        0x8D => "f32.ceil",
        0x8E => "f32.floor",
        0x8F => "f32.trunc",
        0x90 => "f32.nearest",
        0x91 => "f32.sqrt",
        0x92 => "f32.add",
        0x93 => "f32.sub",
        0x94 => "f32.mul",
        0x95 => "f32.div",
        0x96 => "f32.min",
        0x97 => "f32.max",
        0x98 => "f32.copysign",
        
        // Numeric f64
        0x99 => "f64.abs",
        0x9A => "f64.neg",
        0x9B => "f64.ceil",
        0x9C => "f64.floor",
        0x9D => "f64.trunc",
        0x9E => "f64.nearest",
        0x9F => "f64.sqrt",
        0xA0 => "f64.add",
        0xA1 => "f64.sub",
        0xA2 => "f64.mul",
        0xA3 => "f64.div",
        0xA4 => "f64.min",
        0xA5 => "f64.max",
        0xA6 => "f64.copysign",
        
        // Conversions
        0xA7 => "i32.wrap_i64",
        0xA8 => "i32.trunc_f32_s",
        0xA9 => "i32.trunc_f32_u",
        0xAA => "i32.trunc_f64_s",
        0xAB => "i32.trunc_f64_u",
        0xAC => "i64.extend_i32_s",
        0xAD => "i64.extend_i32_u",
        0xAE => "i64.trunc_f32_s",
        0xAF => "i64.trunc_f32_u",
        0xB0 => "i64.trunc_f64_s",
        0xB1 => "i64.trunc_f64_u",
        0xB2 => "f32.convert_i32_s",
        0xB3 => "f32.convert_i32_u",
        0xB4 => "f32.convert_i64_s",
        0xB5 => "f32.convert_i64_u",
        0xB6 => "f32.demote_f64",
        0xB7 => "f64.convert_i32_s",
        0xB8 => "f64.convert_i32_u",
        0xB9 => "f64.convert_i64_s",
        0xBA => "f64.convert_i64_u",
        0xBB => "f64.promote_f32",
        0xBC => "i32.reinterpret_f32",
        0xBD => "i64.reinterpret_f64",
        0xBE => "f32.reinterpret_i32",
        0xBF => "f64.reinterpret_i64",
        
        // Sign extension
        0xC0 => "i32.extend8_s",
        0xC1 => "i32.extend16_s",
        0xC2 => "i64.extend8_s",
        0xC3 => "i64.extend16_s",
        0xC4 => "i64.extend32_s",
        
        // FC prefix (extended instructions)
        0xFC => {
            if offset + 1 < data.len() {
                let (subop, len) = read_uleb128(data, offset + 1);
                consumed += len;
                match subop {
                    0 => "i32.trunc_sat_f32_s",
                    1 => "i32.trunc_sat_f32_u",
                    2 => "i32.trunc_sat_f64_s",
                    3 => "i32.trunc_sat_f64_u",
                    4 => "i64.trunc_sat_f32_s",
                    5 => "i64.trunc_sat_f32_u",
                    6 => "i64.trunc_sat_f64_s",
                    7 => "i64.trunc_sat_f64_u",
                    8 => { // memory.init
                        let (dataidx, len1) = read_uleb128(data, offset + consumed);
                        consumed += len1;
                        let (memidx, len2) = read_uleb128(data, offset + consumed);
                        consumed += len2;
                        operand = format!("data[{}] mem[{}]", dataidx, memidx);
                        "memory.init"
                    }
                    9 => { // data.drop
                        let (dataidx, len1) = read_uleb128(data, offset + consumed);
                        consumed += len1;
                        operand = format!("{}", dataidx);
                        "data.drop"
                    }
                    10 => { // memory.copy
                        let (dst, len1) = read_uleb128(data, offset + consumed);
                        consumed += len1;
                        let (src, len2) = read_uleb128(data, offset + consumed);
                        consumed += len2;
                        operand = format!("dst={} src={}", dst, src);
                        "memory.copy"
                    }
                    11 => { // memory.fill
                        let (memidx, len1) = read_uleb128(data, offset + consumed);
                        consumed += len1;
                        operand = format!("{}", memidx);
                        "memory.fill"
                    }
                    _ => "fc_unknown",
                }
            } else {
                "fc_prefix"
            }
        }
        
        // FD prefix (SIMD)
        0xFD => {
            if offset + 1 < data.len() {
                let (subop, len) = read_uleb128(data, offset + 1);
                consumed += len;
                operand = format!("{}", subop);
            }
            "simd"
        }
        
        _ => "unknown",
    };
    
    (mnemonic.to_string(), consumed, operand, is_branch, branch_target)
}

/// Disassemble WASM bytecode with detailed output
fn disassemble_wasm(memory_data: &[u8], base_address: u64) -> DisassembleResponse {
    let mut lines = Vec::new();
    let mut offset: usize = 0;
    let max_instructions = 500;
    
    while offset < memory_data.len() && lines.len() < max_instructions {
        let (mnemonic, consumed, operand, is_branch, _branch_target) = 
            decode_wasm_instruction(memory_data, offset, base_address);
        
        if consumed == 0 {
            break;
        }
        
        let current_address = base_address + offset as u64;
        let end_offset = std::cmp::min(offset + consumed, memory_data.len());
        
        // Format bytes (max 8 shown)
        let bytes_display = memory_data[offset..end_offset]
            .iter()
            .take(8)
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<_>>()
            .join(" ");
        let bytes_suffix = if consumed > 8 { ".." } else { "" };
        
        // Format branch arrow hint
        let branch_hint = if is_branch { " <-" } else { "" };
        
        // Format: address|bytes|mnemonic operand (pipe-separated for parser)
        // Only add space before operand if operand is not empty
        let instruction_text = if operand.is_empty() {
            format!("{}{}", mnemonic, branch_hint)
        } else {
            format!("{} {}{}", mnemonic, operand, branch_hint)
        };
        
        let line = format!(
            "0x{:08x}|{}{}|{}",
            current_address,
            bytes_display,
            bytes_suffix,
            instruction_text
        );
        lines.push(line);
        
        offset += consumed;
    }
    
    DisassembleResponse {
        success: true,
        disassembly: Some(lines.join("\n")),
        instructions_count: lines.len(),
        error: None,
    }
}

// ============================================================================
// WASM File Analysis with wasmparser
// ============================================================================

/// WASM module directory for saved .wasm files
fn get_wasm_modules_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DynaDbg")
        .join("wasm_modules")
}

/// WASM function info from wasmparser analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmFunctionInfo {
    pub index: u32,
    pub name: Option<String>,
    pub code_offset: u32,      // Offset within the Code section
    pub code_size: u32,        // Size of function body
    pub local_count: u32,      // Number of locals
    pub param_count: u32,      // Number of parameters (from type)
    pub result_count: u32,     // Number of results (from type)
    pub instructions: Vec<WasmInstructionInfo>,
}

/// WASM instruction info with structured details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmInstructionInfo {
    pub offset: u32,           // Byte offset within function
    pub bytes: Vec<u8>,        // Raw instruction bytes
    pub mnemonic: String,      // Instruction name
    pub operands: String,      // Formatted operands
    pub is_branch: bool,       // Is this a branch/control flow instruction
    pub depth_change: i32,     // Block nesting change (+1 for block/loop/if, -1 for end)
}

/// WASM module analysis result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmModuleAnalysis {
    pub file_path: String,
    pub functions: Vec<WasmFunctionInfo>,
    pub import_count: u32,
    pub export_count: u32,
    pub memory_count: u32,
    pub table_count: u32,
    pub global_count: u32,
}

/// Save WASM binary data to a .wasm file for Ghidra analysis
#[tauri::command]
async fn save_wasm_binary(
    binary_data: Vec<u8>,
    module_name: String,
    project_name: Option<String>,
) -> Result<String, String> {
    // Save to ghidra_projects/libraries/{project_name}/ directory (same as native libraries)
    // This ensures consistency with how native libraries are stored
    let ghidra_dir = get_ghidra_projects_dir();
    let libs_dir = if let Some(ref proj_name) = project_name {
        ghidra_dir.join("libraries").join(proj_name)
    } else {
        ghidra_dir.join("libraries")
    };
    std::fs::create_dir_all(&libs_dir).map_err(|e| format!("Failed to create libraries directory: {}", e))?;
    
    // Sanitize module name for filename
    let safe_name = module_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect::<String>();
    
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    let filename = format!("{}_{}.wasm", safe_name, timestamp);
    let file_path = libs_dir.join(&filename);
    
    // Write the WASM binary
    std::fs::write(&file_path, &binary_data)
        .map_err(|e| format!("Failed to write WASM file: {}", e))?;
    
    let path_str = file_path.to_string_lossy().to_string();
    println!("[WASM] Saved WASM binary to: {} ({} bytes)", path_str, binary_data.len());
    
    Ok(path_str)
}

/// Get saved WASM files list
#[tauri::command]
async fn list_wasm_files() -> Result<Vec<String>, String> {
    let wasm_dir = get_wasm_modules_dir();
    
    if !wasm_dir.exists() {
        return Ok(Vec::new());
    }
    
    let entries = std::fs::read_dir(&wasm_dir)
        .map_err(|e| format!("Failed to read WASM directory: {}", e))?;
    
    let mut files = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().map(|e| e == "wasm").unwrap_or(false) {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    
    files.sort();
    Ok(files)
}

/// Format a wasmparser Operator to mnemonic and operands
fn format_wasm_operator(op: &Operator) -> (String, String, bool, i32) {
    use Operator::*;
    
    match op {
        // Control flow
        Unreachable => ("unreachable".into(), "".into(), false, 0),
        Nop => ("nop".into(), "".into(), false, 0),
        Block { blockty } => ("block".into(), format!("{:?}", blockty), false, 1),
        Loop { blockty } => ("loop".into(), format!("{:?}", blockty), true, 1),
        If { blockty } => ("if".into(), format!("{:?}", blockty), true, 1),
        Else => ("else".into(), "".into(), false, 0),
        End => ("end".into(), "".into(), false, -1),
        Br { relative_depth } => ("br".into(), format!("{}", relative_depth), true, 0),
        BrIf { relative_depth } => ("br_if".into(), format!("{}", relative_depth), true, 0),
        BrTable { targets } => ("br_table".into(), format!("{} targets", targets.len()), true, 0),
        Return => ("return".into(), "".into(), true, 0),
        Call { function_index } => ("call".into(), format!("func[{}]", function_index), true, 0),
        CallIndirect { type_index, table_index } => 
            ("call_indirect".into(), format!("type[{}] table[{}]", type_index, table_index), true, 0),
        
        // Parametric
        Drop => ("drop".into(), "".into(), false, 0),
        Select => ("select".into(), "".into(), false, 0),
        
        // Variable access
        LocalGet { local_index } => ("local.get".into(), format!("{}", local_index), false, 0),
        LocalSet { local_index } => ("local.set".into(), format!("{}", local_index), false, 0),
        LocalTee { local_index } => ("local.tee".into(), format!("{}", local_index), false, 0),
        GlobalGet { global_index } => ("global.get".into(), format!("{}", global_index), false, 0),
        GlobalSet { global_index } => ("global.set".into(), format!("{}", global_index), false, 0),
        
        // Memory operations
        I32Load { memarg } => ("i32.load".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        I64Load { memarg } => ("i64.load".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        F32Load { memarg } => ("f32.load".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        F64Load { memarg } => ("f64.load".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        I32Load8S { memarg } => ("i32.load8_s".into(), format!("offset={}", memarg.offset), false, 0),
        I32Load8U { memarg } => ("i32.load8_u".into(), format!("offset={}", memarg.offset), false, 0),
        I32Load16S { memarg } => ("i32.load16_s".into(), format!("offset={}", memarg.offset), false, 0),
        I32Load16U { memarg } => ("i32.load16_u".into(), format!("offset={}", memarg.offset), false, 0),
        I64Load8S { memarg } => ("i64.load8_s".into(), format!("offset={}", memarg.offset), false, 0),
        I64Load8U { memarg } => ("i64.load8_u".into(), format!("offset={}", memarg.offset), false, 0),
        I64Load16S { memarg } => ("i64.load16_s".into(), format!("offset={}", memarg.offset), false, 0),
        I64Load16U { memarg } => ("i64.load16_u".into(), format!("offset={}", memarg.offset), false, 0),
        I64Load32S { memarg } => ("i64.load32_s".into(), format!("offset={}", memarg.offset), false, 0),
        I64Load32U { memarg } => ("i64.load32_u".into(), format!("offset={}", memarg.offset), false, 0),
        I32Store { memarg } => ("i32.store".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        I64Store { memarg } => ("i64.store".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        F32Store { memarg } => ("f32.store".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        F64Store { memarg } => ("f64.store".into(), format!("offset={} align={}", memarg.offset, memarg.align), false, 0),
        I32Store8 { memarg } => ("i32.store8".into(), format!("offset={}", memarg.offset), false, 0),
        I32Store16 { memarg } => ("i32.store16".into(), format!("offset={}", memarg.offset), false, 0),
        I64Store8 { memarg } => ("i64.store8".into(), format!("offset={}", memarg.offset), false, 0),
        I64Store16 { memarg } => ("i64.store16".into(), format!("offset={}", memarg.offset), false, 0),
        I64Store32 { memarg } => ("i64.store32".into(), format!("offset={}", memarg.offset), false, 0),
        MemorySize { mem, .. } => ("memory.size".into(), format!("{}", mem), false, 0),
        MemoryGrow { mem, .. } => ("memory.grow".into(), format!("{}", mem), false, 0),
        
        // Constants
        I32Const { value } => ("i32.const".into(), format!("{}", value), false, 0),
        I64Const { value } => ("i64.const".into(), format!("{}", value), false, 0),
        F32Const { value } => ("f32.const".into(), format!("{:?}", value), false, 0),
        F64Const { value } => ("f64.const".into(), format!("{:?}", value), false, 0),
        
        // Comparison
        I32Eqz => ("i32.eqz".into(), "".into(), false, 0),
        I32Eq => ("i32.eq".into(), "".into(), false, 0),
        I32Ne => ("i32.ne".into(), "".into(), false, 0),
        I32LtS => ("i32.lt_s".into(), "".into(), false, 0),
        I32LtU => ("i32.lt_u".into(), "".into(), false, 0),
        I32GtS => ("i32.gt_s".into(), "".into(), false, 0),
        I32GtU => ("i32.gt_u".into(), "".into(), false, 0),
        I32LeS => ("i32.le_s".into(), "".into(), false, 0),
        I32LeU => ("i32.le_u".into(), "".into(), false, 0),
        I32GeS => ("i32.ge_s".into(), "".into(), false, 0),
        I32GeU => ("i32.ge_u".into(), "".into(), false, 0),
        I64Eqz => ("i64.eqz".into(), "".into(), false, 0),
        I64Eq => ("i64.eq".into(), "".into(), false, 0),
        I64Ne => ("i64.ne".into(), "".into(), false, 0),
        I64LtS => ("i64.lt_s".into(), "".into(), false, 0),
        I64LtU => ("i64.lt_u".into(), "".into(), false, 0),
        I64GtS => ("i64.gt_s".into(), "".into(), false, 0),
        I64GtU => ("i64.gt_u".into(), "".into(), false, 0),
        I64LeS => ("i64.le_s".into(), "".into(), false, 0),
        I64LeU => ("i64.le_u".into(), "".into(), false, 0),
        I64GeS => ("i64.ge_s".into(), "".into(), false, 0),
        I64GeU => ("i64.ge_u".into(), "".into(), false, 0),
        F32Eq => ("f32.eq".into(), "".into(), false, 0),
        F32Ne => ("f32.ne".into(), "".into(), false, 0),
        F32Lt => ("f32.lt".into(), "".into(), false, 0),
        F32Gt => ("f32.gt".into(), "".into(), false, 0),
        F32Le => ("f32.le".into(), "".into(), false, 0),
        F32Ge => ("f32.ge".into(), "".into(), false, 0),
        F64Eq => ("f64.eq".into(), "".into(), false, 0),
        F64Ne => ("f64.ne".into(), "".into(), false, 0),
        F64Lt => ("f64.lt".into(), "".into(), false, 0),
        F64Gt => ("f64.gt".into(), "".into(), false, 0),
        F64Le => ("f64.le".into(), "".into(), false, 0),
        F64Ge => ("f64.ge".into(), "".into(), false, 0),
        
        // Arithmetic
        I32Clz => ("i32.clz".into(), "".into(), false, 0),
        I32Ctz => ("i32.ctz".into(), "".into(), false, 0),
        I32Popcnt => ("i32.popcnt".into(), "".into(), false, 0),
        I32Add => ("i32.add".into(), "".into(), false, 0),
        I32Sub => ("i32.sub".into(), "".into(), false, 0),
        I32Mul => ("i32.mul".into(), "".into(), false, 0),
        I32DivS => ("i32.div_s".into(), "".into(), false, 0),
        I32DivU => ("i32.div_u".into(), "".into(), false, 0),
        I32RemS => ("i32.rem_s".into(), "".into(), false, 0),
        I32RemU => ("i32.rem_u".into(), "".into(), false, 0),
        I32And => ("i32.and".into(), "".into(), false, 0),
        I32Or => ("i32.or".into(), "".into(), false, 0),
        I32Xor => ("i32.xor".into(), "".into(), false, 0),
        I32Shl => ("i32.shl".into(), "".into(), false, 0),
        I32ShrS => ("i32.shr_s".into(), "".into(), false, 0),
        I32ShrU => ("i32.shr_u".into(), "".into(), false, 0),
        I32Rotl => ("i32.rotl".into(), "".into(), false, 0),
        I32Rotr => ("i32.rotr".into(), "".into(), false, 0),
        I64Clz => ("i64.clz".into(), "".into(), false, 0),
        I64Ctz => ("i64.ctz".into(), "".into(), false, 0),
        I64Popcnt => ("i64.popcnt".into(), "".into(), false, 0),
        I64Add => ("i64.add".into(), "".into(), false, 0),
        I64Sub => ("i64.sub".into(), "".into(), false, 0),
        I64Mul => ("i64.mul".into(), "".into(), false, 0),
        I64DivS => ("i64.div_s".into(), "".into(), false, 0),
        I64DivU => ("i64.div_u".into(), "".into(), false, 0),
        I64RemS => ("i64.rem_s".into(), "".into(), false, 0),
        I64RemU => ("i64.rem_u".into(), "".into(), false, 0),
        I64And => ("i64.and".into(), "".into(), false, 0),
        I64Or => ("i64.or".into(), "".into(), false, 0),
        I64Xor => ("i64.xor".into(), "".into(), false, 0),
        I64Shl => ("i64.shl".into(), "".into(), false, 0),
        I64ShrS => ("i64.shr_s".into(), "".into(), false, 0),
        I64ShrU => ("i64.shr_u".into(), "".into(), false, 0),
        I64Rotl => ("i64.rotl".into(), "".into(), false, 0),
        I64Rotr => ("i64.rotr".into(), "".into(), false, 0),
        F32Abs => ("f32.abs".into(), "".into(), false, 0),
        F32Neg => ("f32.neg".into(), "".into(), false, 0),
        F32Ceil => ("f32.ceil".into(), "".into(), false, 0),
        F32Floor => ("f32.floor".into(), "".into(), false, 0),
        F32Trunc => ("f32.trunc".into(), "".into(), false, 0),
        F32Nearest => ("f32.nearest".into(), "".into(), false, 0),
        F32Sqrt => ("f32.sqrt".into(), "".into(), false, 0),
        F32Add => ("f32.add".into(), "".into(), false, 0),
        F32Sub => ("f32.sub".into(), "".into(), false, 0),
        F32Mul => ("f32.mul".into(), "".into(), false, 0),
        F32Div => ("f32.div".into(), "".into(), false, 0),
        F32Min => ("f32.min".into(), "".into(), false, 0),
        F32Max => ("f32.max".into(), "".into(), false, 0),
        F32Copysign => ("f32.copysign".into(), "".into(), false, 0),
        F64Abs => ("f64.abs".into(), "".into(), false, 0),
        F64Neg => ("f64.neg".into(), "".into(), false, 0),
        F64Ceil => ("f64.ceil".into(), "".into(), false, 0),
        F64Floor => ("f64.floor".into(), "".into(), false, 0),
        F64Trunc => ("f64.trunc".into(), "".into(), false, 0),
        F64Nearest => ("f64.nearest".into(), "".into(), false, 0),
        F64Sqrt => ("f64.sqrt".into(), "".into(), false, 0),
        F64Add => ("f64.add".into(), "".into(), false, 0),
        F64Sub => ("f64.sub".into(), "".into(), false, 0),
        F64Mul => ("f64.mul".into(), "".into(), false, 0),
        F64Div => ("f64.div".into(), "".into(), false, 0),
        F64Min => ("f64.min".into(), "".into(), false, 0),
        F64Max => ("f64.max".into(), "".into(), false, 0),
        F64Copysign => ("f64.copysign".into(), "".into(), false, 0),
        
        // Conversions
        I32WrapI64 => ("i32.wrap_i64".into(), "".into(), false, 0),
        I32TruncF32S => ("i32.trunc_f32_s".into(), "".into(), false, 0),
        I32TruncF32U => ("i32.trunc_f32_u".into(), "".into(), false, 0),
        I32TruncF64S => ("i32.trunc_f64_s".into(), "".into(), false, 0),
        I32TruncF64U => ("i32.trunc_f64_u".into(), "".into(), false, 0),
        I64ExtendI32S => ("i64.extend_i32_s".into(), "".into(), false, 0),
        I64ExtendI32U => ("i64.extend_i32_u".into(), "".into(), false, 0),
        I64TruncF32S => ("i64.trunc_f32_s".into(), "".into(), false, 0),
        I64TruncF32U => ("i64.trunc_f32_u".into(), "".into(), false, 0),
        I64TruncF64S => ("i64.trunc_f64_s".into(), "".into(), false, 0),
        I64TruncF64U => ("i64.trunc_f64_u".into(), "".into(), false, 0),
        F32ConvertI32S => ("f32.convert_i32_s".into(), "".into(), false, 0),
        F32ConvertI32U => ("f32.convert_i32_u".into(), "".into(), false, 0),
        F32ConvertI64S => ("f32.convert_i64_s".into(), "".into(), false, 0),
        F32ConvertI64U => ("f32.convert_i64_u".into(), "".into(), false, 0),
        F32DemoteF64 => ("f32.demote_f64".into(), "".into(), false, 0),
        F64ConvertI32S => ("f64.convert_i32_s".into(), "".into(), false, 0),
        F64ConvertI32U => ("f64.convert_i32_u".into(), "".into(), false, 0),
        F64ConvertI64S => ("f64.convert_i64_s".into(), "".into(), false, 0),
        F64ConvertI64U => ("f64.convert_i64_u".into(), "".into(), false, 0),
        F64PromoteF32 => ("f64.promote_f32".into(), "".into(), false, 0),
        I32ReinterpretF32 => ("i32.reinterpret_f32".into(), "".into(), false, 0),
        I64ReinterpretF64 => ("i64.reinterpret_f64".into(), "".into(), false, 0),
        F32ReinterpretI32 => ("f32.reinterpret_i32".into(), "".into(), false, 0),
        F64ReinterpretI64 => ("f64.reinterpret_i64".into(), "".into(), false, 0),
        
        // Sign extension
        I32Extend8S => ("i32.extend8_s".into(), "".into(), false, 0),
        I32Extend16S => ("i32.extend16_s".into(), "".into(), false, 0),
        I64Extend8S => ("i64.extend8_s".into(), "".into(), false, 0),
        I64Extend16S => ("i64.extend16_s".into(), "".into(), false, 0),
        I64Extend32S => ("i64.extend32_s".into(), "".into(), false, 0),
        
        // Reference types
        RefNull { hty } => ("ref.null".into(), format!("{:?}", hty), false, 0),
        RefIsNull => ("ref.is_null".into(), "".into(), false, 0),
        RefFunc { function_index } => ("ref.func".into(), format!("{}", function_index), false, 0),
        
        // Catch-all for other instructions
        _ => ("unknown".into(), format!("{:?}", op), false, 0),
    }
}

/// Analyze WASM binary using wasmparser for structured disassembly
#[tauri::command]
async fn analyze_wasm_binary(
    binary_data: Vec<u8>,
    _base_address: u64,
) -> Result<WasmModuleAnalysis, String> {
    let parser = Parser::new(0);
    let mut functions: Vec<WasmFunctionInfo> = Vec::new();
    let mut import_count = 0u32;
    let mut export_count = 0u32;
    let mut memory_count = 0u32;
    let mut table_count = 0u32;
    let mut global_count = 0u32;
    let mut type_section_types: Vec<(u32, u32)> = Vec::new(); // (params, results)
    let mut function_type_indices: Vec<u32> = Vec::new();
    let mut func_index = 0u32;
    
    for payload in parser.parse_all(&binary_data) {
        match payload {
            Ok(Payload::TypeSection(reader)) => {
                for ty in reader.into_iter_err_on_gc_types() {
                    match ty {
                        Ok(ft) => {
                            type_section_types.push((
                                ft.params().len() as u32,
                                ft.results().len() as u32,
                            ));
                        }
                        Err(_) => {}
                    }
                }
            }
            Ok(Payload::ImportSection(reader)) => {
                for import in reader {
                    if let Ok(imp) = import {
                        import_count += 1;
                        if matches!(imp.ty, wasmparser::TypeRef::Func(_)) {
                            func_index += 1;
                        }
                    }
                }
            }
            Ok(Payload::FunctionSection(reader)) => {
                for func_type in reader {
                    if let Ok(type_idx) = func_type {
                        function_type_indices.push(type_idx);
                    }
                }
            }
            Ok(Payload::TableSection(reader)) => {
                table_count = reader.count();
            }
            Ok(Payload::MemorySection(reader)) => {
                memory_count = reader.count();
            }
            Ok(Payload::GlobalSection(reader)) => {
                global_count = reader.count();
            }
            Ok(Payload::ExportSection(reader)) => {
                export_count = reader.count();
            }
            Ok(Payload::CodeSectionEntry(body)) => {
                let code_offset = body.range().start as u32;
                let code_size = body.range().len() as u32;
                
                // Get type info
                let local_func_idx = (func_index - import_count) as usize;
                let (param_count, result_count) = if local_func_idx < function_type_indices.len() {
                    let type_idx = function_type_indices[local_func_idx] as usize;
                    if type_idx < type_section_types.len() {
                        type_section_types[type_idx]
                    } else {
                        (0, 0)
                    }
                } else {
                    (0, 0)
                };
                
                // Count locals
                let mut local_count = 0u32;
                if let Ok(locals_reader) = body.get_locals_reader() {
                    for local in locals_reader {
                        if let Ok((count, _)) = local {
                            local_count += count;
                        }
                    }
                }
                
                // Parse instructions
                let mut instructions = Vec::new();
                if let Ok(ops_reader) = body.get_operators_reader() {
                    let mut reader = ops_reader;
                    let base_offset = body.range().start;
                    
                    while !reader.eof() {
                        let pos_before = reader.original_position();
                        match reader.read() {
                            Ok(op) => {
                                let pos_after = reader.original_position();
                                let _instr_size = pos_after - pos_before;
                                let instr_offset = pos_before - base_offset;
                                
                                // Get raw bytes
                                let bytes = if pos_before < binary_data.len() && pos_after <= binary_data.len() {
                                    binary_data[pos_before..pos_after].to_vec()
                                } else {
                                    vec![]
                                };
                                
                                let (mnemonic, operands, is_branch, depth_change) = format_wasm_operator(&op);
                                
                                instructions.push(WasmInstructionInfo {
                                    offset: instr_offset as u32,
                                    bytes,
                                    mnemonic,
                                    operands,
                                    is_branch,
                                    depth_change,
                                });
                            }
                            Err(_) => break,
                        }
                    }
                }
                
                functions.push(WasmFunctionInfo {
                    index: func_index,
                    name: None, // Will be filled from name section if available
                    code_offset,
                    code_size,
                    local_count,
                    param_count,
                    result_count,
                    instructions,
                });
                
                func_index += 1;
            }
            Ok(Payload::CustomSection(reader)) => {
                if reader.name() == "name" {
                    // Parse name section for function names
                    // This is optional and may not be present
                }
            }
            _ => {}
        }
    }
    
    Ok(WasmModuleAnalysis {
        file_path: String::new(),
        functions,
        import_count,
        export_count,
        memory_count,
        table_count,
        global_count,
    })
}

/// Disassemble a specific WASM function with wasmparser-based analysis
#[tauri::command]
async fn disassemble_wasm_function(
    binary_data: Vec<u8>,
    function_offset: u32,
    function_size: u32,
    base_address: u64,
) -> Result<DisassembleResponse, String> {
    // Validate offset and size
    if function_offset as usize >= binary_data.len() {
        return Err("Function offset out of bounds".to_string());
    }
    
    let end_offset = std::cmp::min(
        function_offset as usize + function_size as usize,
        binary_data.len()
    );
    
    let function_bytes = &binary_data[function_offset as usize..end_offset];
    
    // Try to parse as function body
    let mut lines = Vec::new();
    let mut offset = 0usize;
    let mut block_depth = 0i32;
    
    // Skip locals encoding if present (for raw function bodies)
    // First, read local count as LEB128
    let (local_groups, consumed) = read_uleb128(function_bytes, 0);
    offset += consumed;
    
    // Skip local declarations
    for _ in 0..local_groups {
        let (_count, c1) = read_uleb128(function_bytes, offset);
        offset += c1;
        if offset < function_bytes.len() {
            offset += 1; // Skip type byte
        }
    }
    
    // Now decode instructions
    while offset < function_bytes.len() && lines.len() < 500 {
        let (mnemonic, consumed, operand, is_branch, _) = 
            decode_wasm_instruction(function_bytes, offset, base_address);
        
        if consumed == 0 {
            break;
        }
        
        // Track block depth for indentation
        let indent = if mnemonic == "end" || mnemonic == "else" {
            block_depth = (block_depth - 1).max(0);
            "  ".repeat(block_depth as usize)
        } else {
            let indent = "  ".repeat(block_depth as usize);
            if mnemonic == "block" || mnemonic == "loop" || mnemonic == "if" {
                block_depth += 1;
            }
            indent
        };
        
        let current_address = base_address + (function_offset as u64) + (offset as u64);
        let end_off = std::cmp::min(offset + consumed, function_bytes.len());
        
        let bytes_display = function_bytes[offset..end_off]
            .iter()
            .take(8)
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<_>>()
            .join(" ");
        let bytes_suffix = if consumed > 8 { ".." } else { "" };
        let branch_hint = if is_branch { " <-" } else { "" };
        
        // Only add space before operand if operand is not empty
        let instruction_text = if operand.is_empty() {
            format!("{}{}{}", indent, mnemonic, branch_hint)
        } else {
            format!("{}{} {}{}", indent, mnemonic, operand, branch_hint)
        };
        
        let line = format!(
            "0x{:08x}|{}{}|{}",
            current_address,
            bytes_display,
            bytes_suffix,
            instruction_text
        );
        lines.push(line);
        
        offset += consumed;
        
        // Stop at function end
        if mnemonic == "end" && block_depth == 0 {
            break;
        }
    }
    
    Ok(DisassembleResponse {
        success: true,
        disassembly: Some(lines.join("\n")),
        instructions_count: lines.len(),
        error: None,
    })
}

/// Open WASM modules directory in file explorer
#[tauri::command]
async fn open_wasm_modules_directory() -> Result<String, String> {
    let wasm_dir = get_wasm_modules_dir();
    std::fs::create_dir_all(&wasm_dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&wasm_dir)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&wasm_dir)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&wasm_dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    
    Ok(wasm_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn disassemble_memory_direct(
    memory_data: Vec<u8>,
    address: u64,
    architecture: String,
) -> Result<DisassembleResponse, String> {
    // Determine instruction size for the architecture (used for fallback on invalid bytes)
    let instruction_size: usize = match architecture.as_str() {
        "arm64" | "aarch64" | "arm" => 4,
        "x86" | "x86_64" => 1, // x86 is variable length, use 1 for fallback
        "wasm32" | "wasm" => 1, // WASM is variable length
        _ => 4,
    };

    // Handle WASM architecture specially (no Capstone support)
    if architecture == "wasm32" || architecture == "wasm" {
        return Ok(disassemble_wasm(&memory_data, address));
    }

    // Create capstone engine with proper architecture support
    let cs = match architecture.as_str() {
        "x86" => Capstone::new()
            .x86()
            .mode(arch::x86::ArchMode::Mode32)
            .detail(true)
            .build(),
        "x86_64" => Capstone::new()
            .x86()
            .mode(arch::x86::ArchMode::Mode64)
            .detail(true)
            .build(),
        "arm" => Capstone::new()
            .arm()
            .mode(arch::arm::ArchMode::Arm)
            .detail(true)
            .build(),
        "arm64" | "aarch64" => {
            // ARM64 architecture with proper settings for iOS/macOS
            let cs_builder = Capstone::new()
                .arm64()
                .mode(arch::arm64::ArchMode::Arm)
                .detail(true);
            
            // Enable extra details for ARM64
            cs_builder.build()
        },
        _ => {
            // Default to x86_64, but log the unsupported architecture
            eprintln!("Warning: Unsupported architecture '{}', defaulting to x86_64", architecture);
            Capstone::new()
                .x86()
                .mode(arch::x86::ArchMode::Mode64)
                .detail(true)
                .build()
        },
    };
    
    let cs = match cs {
        Ok(cs) => cs,
        Err(e) => {
            return Ok(DisassembleResponse {
                success: false,
                disassembly: None,
                instructions_count: 0,
                error: Some(format!("Failed to create disassembler: {}", e)),
            });
        }
    };

    // Disassemble the memory with fallback for unrecognized bytes
    let mut disassembly_lines = Vec::new();
    let mut offset: usize = 0;

    while offset < memory_data.len() {
        // Try to disassemble from current offset
        let slice = &memory_data[offset..];
        let current_address = address + offset as u64;

        match cs.disasm_count(slice, current_address, 1) {
            Ok(instructions) if instructions.len() > 0 => {
                // Successfully disassembled one instruction
                let insn = &instructions.as_ref()[0];
                let address_str = format!("0x{:x}", insn.address());
                let bytes = insn.bytes().iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(" ");
                let mnemonic = insn.mnemonic().unwrap_or("???");
                let op_str = insn.op_str().unwrap_or("");
                
                // Enhanced formatting for ARM64
                let formatted_operands = if !op_str.is_empty() {
                    match architecture.as_str() {
                        "arm64" | "aarch64" => {
                            // Format ARM64 operands more clearly
                            format_arm64_operands(op_str)
                        },
                        _ => op_str.to_string(),
                    }
                } else {
                    String::new()
                };
                
                // Format: address|bytes|mnemonic operands
                let line = format!("{}|{}|{} {}", address_str, bytes, mnemonic, formatted_operands);
                disassembly_lines.push(line);
                
                // Move offset by the instruction size
                offset += insn.bytes().len();
            }
            _ => {
                // Failed to disassemble - create a placeholder entry for undecodable bytes
                let bytes_to_show = std::cmp::min(instruction_size, memory_data.len() - offset);
                let bytes_str = memory_data[offset..offset + bytes_to_show]
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(" ");
                
                let address_str = format!("0x{:x}", current_address);
                // Show as "???" with .byte pseudo-instruction style, or just "???" for cleaner display
                let line = format!("{}|{}|??? ", address_str, bytes_str);
                disassembly_lines.push(line);
                
                // Move by instruction_size for fixed-width architectures, or 1 byte for variable-width
                offset += bytes_to_show;
            }
        }
    }

    if disassembly_lines.is_empty() {
        // No instructions could be parsed at all - return error
        Ok(DisassembleResponse {
            success: false,
            disassembly: None,
            instructions_count: 0,
            error: Some("No data to disassemble".to_string()),
        })
    } else {
        Ok(DisassembleResponse {
            success: true,
            disassembly: Some(disassembly_lines.join("\n")),
            instructions_count: disassembly_lines.len(),
            error: None,
        })
    }
}

#[tauri::command]
async fn disassemble_memory(request: DisassembleRequest) -> Result<DisassembleResponse, String> {
    // First, read memory from the server
    let memory_response = read_memory(request.address, request.size).await?;
    
    if !memory_response.success {
        return Ok(DisassembleResponse {
            success: false,
            disassembly: None,
            instructions_count: 0,
            error: memory_response.error,
        });
    }

    let memory_data = match memory_response.data {
        Some(data) => data,
        None => {
            return Ok(DisassembleResponse {
                success: false,
                disassembly: None,
                instructions_count: 0,
                error: Some("No memory data received".to_string()),
            });
        }
    };

    // Create capstone engine with proper architecture support
    let cs = match request.architecture.as_str() {
        "x86" => Capstone::new()
            .x86()
            .mode(arch::x86::ArchMode::Mode32)
            .detail(true)
            .build(),
        "x86_64" => Capstone::new()
            .x86()
            .mode(arch::x86::ArchMode::Mode64)
            .detail(true)
            .build(),
        "arm" => Capstone::new()
            .arm()
            .mode(arch::arm::ArchMode::Arm)
            .detail(true)
            .build(),
        "arm64" | "aarch64" => {
            // ARM64 architecture with proper settings for iOS/macOS
            let cs_builder = Capstone::new()
                .arm64()
                .mode(arch::arm64::ArchMode::Arm)
                .detail(true);
            
            // Enable extra details for ARM64
            cs_builder.build()
        },
        _ => {
            // Default to x86_64, but log the unsupported architecture
            eprintln!("Warning: Unsupported architecture '{}', defaulting to x86_64", request.architecture);
            Capstone::new()
                .x86()
                .mode(arch::x86::ArchMode::Mode64)
                .detail(true)
                .build()
        },
    };
    
    let cs = match cs
    {
        Ok(cs) => cs,
        Err(e) => {
            return Ok(DisassembleResponse {
                success: false,
                disassembly: None,
                instructions_count: 0,
                error: Some(format!("Failed to create disassembler: {}", e)),
            });
        }
    };

    // Disassemble the memory
    let instructions_result = cs.disasm_all(&memory_data, request.address);
    match instructions_result {
        Ok(instructions) => {
            let mut disassembly_lines = Vec::new();
            
            for insn in instructions.iter() {
                let address = format!("0x{:x}", insn.address());
                let bytes = insn.bytes().iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(" ");
                let mnemonic = insn.mnemonic().unwrap_or("???");
                let op_str = insn.op_str().unwrap_or("");
                
                // Enhanced formatting for ARM64
                let formatted_operands = if !op_str.is_empty() {
                    match request.architecture.as_str() {
                        "arm64" | "aarch64" => {
                            // Format ARM64 operands more clearly
                            format_arm64_operands(op_str)
                        },
                        _ => op_str.to_string(),
                    }
                } else {
                    String::new()
                };
                
                // Format: address|bytes|mnemonic operands
                let line = format!("{}|{}|{} {}", address, bytes, mnemonic, formatted_operands);
                disassembly_lines.push(line);
            }

            Ok(DisassembleResponse {
                success: true,
                disassembly: Some(disassembly_lines.join("\n")),
                instructions_count: disassembly_lines.len(),
                error: None,
            })
        }
        Err(e) => Ok(DisassembleResponse {
            success: false,
            disassembly: None,
            instructions_count: 0,
            error: Some(format!("Disassembly failed: {}", e)),
        })
    }
}

/// Demangle a list of symbol names (C++ and Rust)
#[tauri::command]
fn demangle_symbols(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .map(|name| {
            // Try C++ demangling first
            if let Ok(symbol) = CppSymbol::new(&name) {
                if let Ok(demangled) = symbol.demangle(&cpp_demangle::DemangleOptions::default()) {
                    return demangled;
                }
            }
            // Try Rust demangling
            let demangled = rustc_demangle(&name).to_string();
            if demangled != name {
                return demangled;
            }
            // Return original if no demangling possible
            name
        })
        .collect()
}

/// Get the Ghidra projects directory for storing analysis data
fn get_ghidra_projects_dir() -> PathBuf {
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DynaDbg")
        .join("ghidra_projects");
    data_dir
}

/// Download a library file from the server and save it locally
#[tauri::command]
async fn download_library_file(library_path: String, project_name: Option<String>) -> Result<String, String> {
    let (host, port, auth_token) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port, config.auth_token.clone())
    };
    
    if host.is_empty() {
        return Err("No server connection configured".to_string());
    }

    let client = reqwest::Client::new();
    let encoded_path = urlencoding::encode(&library_path);
    let url = format!("http://{}:{}/api/utils/file?path={}", host, port, encoded_path);
    
    let mut request_builder = client.get(&url);
    if let Some(token) = auth_token {
        request_builder = request_builder.header("Authorization", format!("Bearer {}", token));
    }
    
    let response = request_builder
        .send()
        .await
        .map_err(|e| format!("Failed to fetch library: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Server returned error: {}", response.status()));
    }
    
    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    // Create local directory for libraries with optional project name subdirectory
    let ghidra_dir = get_ghidra_projects_dir();
    let libs_dir = if let Some(ref proj_name) = project_name {
        ghidra_dir.join("libraries").join(proj_name)
    } else {
        ghidra_dir.join("libraries")
    };
    fs::create_dir_all(&libs_dir)
        .await
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    
    // Extract filename from path
    let filename = PathBuf::from(&library_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown_library".to_string());
    
    let local_path = libs_dir.join(&filename);
    
    let mut file = fs::File::create(&local_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
    file.write_all(&bytes)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    
    Ok(local_path.to_string_lossy().to_string())
}

/// Download any file from the server and save it to the user's downloads folder
#[tauri::command]
async fn download_server_file(remote_path: String) -> Result<String, String> {
    let (host, port, auth_token) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port, config.auth_token.clone())
    };
    
    if host.is_empty() {
        return Err("No server connection configured".to_string());
    }

    let client = reqwest::Client::new();
    let encoded_path = urlencoding::encode(&remote_path);
    let url = format!("http://{}:{}/api/utils/file?path={}", host, port, encoded_path);
    
    let mut request_builder = client.get(&url);
    if let Some(token) = auth_token {
        request_builder = request_builder.header("Authorization", format!("Bearer {}", token));
    }
    
    let response = request_builder
        .send()
        .await
        .map_err(|e| format!("Failed to fetch file: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Server returned error: {}", response.status()));
    }
    
    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    // Create downloads directory in app data
    let downloads_dir = dirs::download_dir()
        .ok_or_else(|| "Could not find downloads directory".to_string())?
        .join("DynaDbg");
    
    fs::create_dir_all(&downloads_dir)
        .await
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    
    // Extract filename from path
    let filename = PathBuf::from(&remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "downloaded_file".to_string());
    
    let local_path = downloads_dir.join(&filename);
    
    // Handle duplicate filenames
    let final_path = if local_path.exists() {
        let stem = local_path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let ext = local_path.extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        downloads_dir.join(format!("{}_{}{}", stem, timestamp, ext))
    } else {
        local_path
    };
    
    let mut file = fs::File::create(&final_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
    file.write_all(&bytes)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    
    Ok(final_path.to_string_lossy().to_string())
}

/// Upload a file from host to server
#[tauri::command]
async fn upload_file_to_server(local_path: String, remote_path: String) -> Result<String, String> {
    let (host, port) = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        (config.host.clone(), config.port)
    };
    
    if host.is_empty() {
        return Err("No server connection configured".to_string());
    }

    // Read local file
    let file_contents = fs::read(&local_path)
        .await
        .map_err(|e| format!("Failed to read local file: {}", e))?;

    let auth_token = {
        let config = SERVER_CONFIG.read().map_err(|e| e.to_string())?;
        config.auth_token.clone()
    };

    let client = reqwest::Client::new();
    let encoded_path = urlencoding::encode(&remote_path);
    let url = format!("http://{}:{}/api/utils/file?path={}", host, port, encoded_path);
    
    let mut request_builder = client.post(&url)
        .body(file_contents);
    
    if let Some(token) = auth_token {
        request_builder = request_builder.header("Authorization", format!("Bearer {}", token));
    }
    
    let response = request_builder
        .send()
        .await
        .map_err(|e| format!("Failed to upload file: {}", e))?;
    
    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Server returned error: {}", error_text));
    }
    
    Ok(remote_path)
}

/// Analyze a library file with Ghidra headless
#[tauri::command]
async fn analyze_with_ghidra(
    local_library_path: String,
    ghidra_path: String,
    project_name: Option<String>,
) -> Result<GhidraAnalysisStatus, String> {
    let library_path = PathBuf::from(&local_library_path);
    if !library_path.exists() {
        return Ok(GhidraAnalysisStatus {
            library_path: local_library_path,
            analyzed: false,
            project_path: None,
            error: Some("Library file not found".to_string()),
        });
    }
    
    let library_name = library_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    
    // Create project directory with optional project name subdirectory
    let ghidra_dir = get_ghidra_projects_dir();
    let project_dir = if let Some(ref proj_name) = project_name {
        ghidra_dir.join(proj_name).join(&library_name)
    } else {
        ghidra_dir.join(&library_name)
    };
    fs::create_dir_all(&project_dir)
        .await
        .map_err(|e| format!("Failed to create project directory: {}", e))?;
    
    // Build headless analyzer path
    let ghidra_base = PathBuf::from(&ghidra_path);
    let analyzer_path = if cfg!(windows) {
        ghidra_base.join("support").join("analyzeHeadless.bat")
    } else {
        ghidra_base.join("support").join("analyzeHeadless")
    };
    
    if !analyzer_path.exists() {
        return Ok(GhidraAnalysisStatus {
            library_path: local_library_path,
            analyzed: false,
            project_path: None,
            error: Some(format!("Ghidra analyzeHeadless not found at: {}", analyzer_path.display())),
        });
    }
    
    // Run Ghidra headless analysis
    let output = hide_console_window(&mut Command::new(&analyzer_path))
        .arg(project_dir.to_string_lossy().to_string())
        .arg(&library_name)
        .arg("-import")
        .arg(&local_library_path)
        .arg("-overwrite")
        .arg("-analysisTimeoutPerFile")
        .arg("300")  // 5 minutes timeout
        .output()
        .map_err(|e| format!("Failed to run Ghidra: {}", e))?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    if !output.status.success() {
        return Ok(GhidraAnalysisStatus {
            library_path: local_library_path,
            analyzed: false,
            project_path: Some(project_dir.to_string_lossy().to_string()),
            error: Some(format!("Ghidra analysis failed: {}\n{}", stdout, stderr)),
        });
    }
    
    Ok(GhidraAnalysisStatus {
        library_path: local_library_path,
        analyzed: true,
        project_path: Some(project_dir.to_string_lossy().to_string()),
        error: None,
    })
}

/// Decompile a function using Ghidra
#[tauri::command]
async fn ghidra_decompile(
    project_path: String,
    library_name: String,
    function_address: String,
    ghidra_path: String,
) -> Result<GhidraDecompileResult, String> {
    let ghidra_base = PathBuf::from(&ghidra_path);
    let analyzer_path = if cfg!(windows) {
        ghidra_base.join("support").join("analyzeHeadless.bat")
    } else {
        ghidra_base.join("support").join("analyzeHeadless")
    };
    
    if !analyzer_path.exists() {
        return Ok(GhidraDecompileResult {
            success: false,
            function_name: None,
            address: Some(function_address.clone()),
            decompiled_code: None,
            error: Some("Ghidra analyzeHeadless not found".to_string()),
            line_mapping: None,
            tokens: None,
        });
    }
    
    // Create a temporary script to decompile the function
    let ghidra_dir = get_ghidra_projects_dir();
    let script_path = ghidra_dir.join("decompile_function.py");
    let output_path = ghidra_dir.join("decompile_output.txt");
    
    // Ghidra Python script for decompilation with line-to-address mapping
    // The function_address is an offset from module base. We need to add Ghidra's image base.
    let script_content = format!(r#"#@runtime Jython
# @category DynaDbg
# @description Decompile function at offset with line-to-address mapping

from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor
from java.util import ArrayList

def get_line_address_mapping(clang_tokens, image_base):
    """Extract address mapping for each line from Clang tokens using flatten()"""
    line_addresses = {{}}
    
    try:
        # Use flatten() to get all tokens as a flat list
        token_list = ArrayList()
        clang_tokens.flatten(token_list)
        
        for token in token_list:
            try:
                min_addr = token.getMinAddress()
                if min_addr is not None:
                    line_parent = token.getLineParent()
                    if line_parent is not None:
                        # ClangLine has getLineNumber() method
                        line_number = line_parent.getLineNumber()
                        if line_number is not None and line_number > 0:
                            offset = min_addr.getOffset() - image_base.getOffset()
                            if line_number not in line_addresses or offset < line_addresses[line_number]:
                                line_addresses[line_number] = offset
            except Exception as e:
                continue
    except Exception as e:
        print("DEBUG: Error in get_line_address_mapping: " + str(e))
    
    return line_addresses

def decompile_at_offset(offset_str):
    decompiler = DecompInterface()
    decompiler.openProgram(currentProgram)
    
    # Get Ghidra's image base address
    image_base = currentProgram.getImageBase()
    print("DEBUG: Image base = " + str(image_base))
    
    # Parse offset
    offset_str = offset_str.strip()
    if offset_str.startswith("0x"):
        offset_str = offset_str[2:]
    
    try:
        offset = int(offset_str, 16)
    except:
        return "Error: Invalid offset format: " + offset_str
    
    # Calculate actual address = image_base + offset
    addr = image_base.add(offset)
    print("DEBUG: Offset = 0x" + format(offset, 'x'))
    print("DEBUG: Calculated address = " + str(addr))
    
    if addr is None:
        return "Error: Could not calculate address"
    
    func = getFunctionContaining(addr)
    if func is None:
        # Try to get function exactly at address
        func = getFunctionAt(addr)
    
    if func is None:
        return "Error: No function found at address " + str(addr) + " (offset 0x" + format(offset, 'x') + ")"
    
    print("DEBUG: Found function: " + func.getName())
    
    monitor = ConsoleTaskMonitor()
    results = decompiler.decompileFunction(func, 60, monitor)
    
    if results and results.decompileCompleted():
        decomp = results.getDecompiledFunction()
        if decomp:
            code = decomp.getC()
            
            # Get line-to-address mapping from ClangTokenGroup
            clang_tokens = results.getCCodeMarkup()
            line_mapping = {{}}
            if clang_tokens:
                line_mapping = get_line_address_mapping(clang_tokens, image_base)
            
            # Format line mapping as JSON-like string
            mapping_str = ";".join(["{{}}:0x{{:x}}".format(ln, addr) for ln, addr in sorted(line_mapping.items())])
            
            return "FUNCTION_NAME:" + func.getName() + "\nLINE_MAPPING:" + mapping_str + "\n" + code
    
    return "Error: Decompilation failed"

# Get offset from script arguments
offset = "{}"
result = decompile_at_offset(offset)

# Write output to file
with open(r"{}", "w") as f:
    f.write(result)
"#, function_address, output_path.to_string_lossy().replace("\\", "\\\\"));
    
    fs::write(&script_path, &script_content)
        .await
        .map_err(|e| format!("Failed to write decompile script: {}", e))?;
    
    // Clean library name (without extension)
    // Ghidra stores imported programs with file_stem (no extension) as the program name
    let clean_lib_name = PathBuf::from(&library_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(library_name.clone());
    
    // Run Ghidra with the decompile script
    // Use clean_lib_name (without extension) for -process option
    // Ghidra stores imported programs without file extensions
    let output = hide_console_window(&mut Command::new(&analyzer_path))
        .arg(&project_path)
        .arg(&clean_lib_name)
        .arg("-process")
        .arg(&clean_lib_name)
        .arg("-noanalysis")
        .arg("-postScript")
        .arg(script_path.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("Failed to run Ghidra: {}", e))?;
    
    // Log Ghidra output for debugging
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    println!("[GHIDRA] stdout: {}", stdout);
    println!("[GHIDRA] stderr: {}", stderr);
    println!("[GHIDRA] exit status: {:?}", output.status);

    if !output.status.success() {
        return Ok(GhidraDecompileResult {
            success: false,
            function_name: None,
            address: Some(function_address),
            decompiled_code: None,
            line_mapping: None,
            tokens: None,
            error: Some(format!("Ghidra process failed (exit code {:?}): \nStdout: {}\nStderr: {}", output.status.code(), stdout, stderr)),
        });
    }
    
    // Read the output file
    let decompiled = match fs::read_to_string(&output_path).await {
        Ok(content) => content,
        Err(e) => {
            // If we couldn't read the file, include Ghidra's output in error
            let error_msg = format!(
                "Error: Could not read decompilation output ({}). \nStdout: {}\nStderr: {}",
                e,
                stdout.chars().take(1000).collect::<String>(),
                stderr.chars().take(1000).collect::<String>()
            );
            return Ok(GhidraDecompileResult {
                success: false,
                function_name: None,
                address: Some(function_address),
                decompiled_code: None,
                line_mapping: None,
                tokens: None,
                error: Some(error_msg),
            });
        }
    };
    
    // Clean up
    let _ = fs::remove_file(&script_path).await;
    let _ = fs::remove_file(&output_path).await;
    
    // Parse result
    if decompiled.starts_with("Error:") {
        return Ok(GhidraDecompileResult {
            success: false,
            function_name: None,
            address: Some(function_address),
            decompiled_code: None,
            line_mapping: None,
            tokens: None,
            error: Some(decompiled),
        });
    }
    
    // Extract function name and line mapping from result
    let mut function_name = String::new();
    let mut line_mapping: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut code_lines: Vec<&str> = Vec::new();
    let mut in_code = false;
    
    for line in decompiled.lines() {
        if line.starts_with("FUNCTION_NAME:") {
            function_name = line.replace("FUNCTION_NAME:", "");
        } else if line.starts_with("LINE_MAPPING:") {
            // Parse line mapping: "1:0x100;2:0x104;3:0x108"
            let mapping_str = line.replace("LINE_MAPPING:", "");
            for pair in mapping_str.split(';') {
                if let Some((line_num_str, addr_str)) = pair.split_once(':') {
                    line_mapping.insert(line_num_str.to_string(), addr_str.to_string());
                }
            }
            in_code = true; // Code starts after LINE_MAPPING
        } else if in_code || (!line.starts_with("FUNCTION_NAME:") && !line.starts_with("LINE_MAPPING:")) {
            in_code = true;
            code_lines.push(line);
        }
    }
    
    let code = code_lines.join("\n");
    
    if !output.status.success() && code.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(GhidraDecompileResult {
            success: false,
            function_name: if function_name.is_empty() { None } else { Some(function_name) },
            address: Some(function_address),
            decompiled_code: None,
            line_mapping: None,
            tokens: None,
            error: Some(format!("Ghidra decompilation process failed: {}", stderr)),
        });
    }
    
    // NOTE: Do NOT format the code with clang-format because it changes line numbers
    // and breaks the line-to-address mapping from Ghidra.
    // If you want to enable formatting, you would need to also remap line numbers.
    // let formatted_code = format_cpp_code(&code).await.unwrap_or(code);
    let formatted_code = code;
    
    Ok(GhidraDecompileResult {
        success: true,
        function_name: if function_name.is_empty() { None } else { Some(function_name) },
        address: Some(function_address),
        decompiled_code: Some(formatted_code),
        line_mapping: if line_mapping.is_empty() { None } else { Some(line_mapping) },
        tokens: None,
        error: None,
    })
}

// ============================================================================
// Ghidra Server Mode - HTTP server running inside Ghidra for fast operations
// ============================================================================

/// Generate the Ghidra HTTP server script
fn generate_ghidra_server_script(port: u16) -> String {
    format!(r#"#@runtime Jython
# @category DynaDbg
# @description HTTP Server for fast Ghidra operations

from ghidra.app.decompiler import DecompInterface, DecompileOptions
from ghidra.program.model.block import BasicBlockModel
from ghidra.program.model.symbol import RefType
from ghidra.util.task import ConsoleTaskMonitor
from java.util import ArrayList
import BaseHTTPServer
import urlparse
import json
import threading
import codecs

# Global decompiler instance (reused)
decompiler = None

def init_decompiler():
    global decompiler
    if decompiler is None:
        decompiler = DecompInterface()
        # Set decompiler options to prevent line wrapping
        opts = DecompileOptions()
        opts.setMaxWidth(300)  # Increase max line width to prevent mid-line breaks
        decompiler.setOptions(opts)
        decompiler.openProgram(currentProgram)
    return decompiler

def get_line_address_mapping(clang_tokens, image_base):
    line_addresses = {{}}
    try:
        token_list = ArrayList()
        clang_tokens.flatten(token_list)
        for token in token_list:
            try:
                min_addr = token.getMinAddress()
                if min_addr is not None:
                    line_parent = token.getLineParent()
                    if line_parent is not None:
                        line_number = line_parent.getLineNumber()
                        if line_number is not None and line_number > 0:
                            offset = min_addr.getOffset() - image_base.getOffset()
                            if line_number not in line_addresses or offset < line_addresses[line_number]:
                                line_addresses[line_number] = offset
            except:
                continue
    except:
        pass
    return line_addresses

def get_token_info(clang_tokens, image_base, high_func):
    """Extract detailed token information from decompiled code"""
    from ghidra.app.decompiler import ClangFuncNameToken, ClangVariableToken, ClangTypeToken, ClangFieldToken
    
    tokens_info = []
    try:
        token_list = ArrayList()
        clang_tokens.flatten(token_list)
        
        for token in token_list:
            try:
                token_text = token.toString()
                if not token_text or len(token_text.strip()) == 0:
                    continue
                
                line_parent = token.getLineParent()
                if line_parent is None:
                    continue
                    
                line_number = line_parent.getLineNumber()
                if line_number is None or line_number <= 0:
                    continue
                
                # Get column position (character offset within the line)
                col_start = 0
                col_end = 0
                try:
                    # Calculate column by finding token position in line
                    line_text = ""
                    siblings = []
                    for i in range(line_parent.numChildren()):
                        child = line_parent.Child(i)
                        if child:
                            siblings.append(child)
                    
                    char_pos = 0
                    for sibling in siblings:
                        sib_text = sibling.toString() if sibling else ""
                        if sibling == token:
                            col_start = char_pos
                            col_end = char_pos + len(token_text)
                            break
                        char_pos += len(sib_text)
                except:
                    pass
                
                token_info = {{
                    "text": token_text,
                    "line": line_number,
                    "col_start": col_start,
                    "col_end": col_end,
                    "token_type": "unknown"
                }}
                
                # Determine token type
                if isinstance(token, ClangFuncNameToken):
                    token_info["token_type"] = "function"
                    # Get function address if available
                    try:
                        pcode_op = token.getPcodeOp()
                        if pcode_op:
                            called_addr = pcode_op.getInput(0)
                            if called_addr:
                                addr = called_addr.getAddress()
                                if addr:
                                    called_func = getFunctionAt(addr)
                                    if called_func:
                                        func_offset = addr.getOffset() - image_base.getOffset()
                                        if func_offset >= 0:
                                            token_info["target_offset"] = "0x{{:x}}".format(func_offset)
                                            token_info["target_name"] = called_func.getName()
                    except:
                        pass
                        
                elif isinstance(token, ClangVariableToken):
                    token_info["token_type"] = "variable"
                    try:
                        high_var = token.getHighVariable()
                        if high_var:
                            token_info["var_name"] = high_var.getName()
                            dt = high_var.getDataType()
                            if dt:
                                token_info["data_type"] = dt.getName()
                            sym = high_var.getSymbol()
                            if sym:
                                token_info["is_parameter"] = sym.isParameter()
                    except:
                        pass
                        
                elif isinstance(token, ClangTypeToken):
                    token_info["token_type"] = "type"
                    
                elif isinstance(token, ClangFieldToken):
                    token_info["token_type"] = "field"
                
                # Only add meaningful tokens
                if token_info["token_type"] != "unknown" or token_text.startswith("FUN_") or token_text.startswith("DAT_"):
                    if token_text.startswith("FUN_"):
                        token_info["token_type"] = "function"
                    elif token_text.startswith("DAT_"):
                        token_info["token_type"] = "data"
                    tokens_info.append(token_info)
                    
            except:
                continue
    except:
        pass
    
    return tokens_info

def decompile_function(offset_str):
    dec = init_decompiler()
    image_base = currentProgram.getImageBase()
    
    offset_str = offset_str.strip()
    if offset_str.startswith("0x"):
        offset_str = offset_str[2:]
    
    try:
        offset = int(offset_str, 16)
    except:
        return {{"success": False, "error": "Invalid offset format"}}
    
    addr = image_base.add(offset)
    func = getFunctionContaining(addr)
    if func is None:
        func = getFunctionAt(addr)
    
    if func is None:
        return {{"success": False, "error": "No function found at offset 0x" + format(offset, 'x')}}
    
    monitor = ConsoleTaskMonitor()
    results = dec.decompileFunction(func, 60, monitor)
    
    if results and results.decompileCompleted():
        decomp = results.getDecompiledFunction()
        high_func = results.getHighFunction()
        if decomp:
            code = decomp.getC()
            clang_tokens = results.getCCodeMarkup()
            line_mapping = {{}}
            tokens_info = []
            if clang_tokens:
                line_mapping = get_line_address_mapping(clang_tokens, image_base)
                tokens_info = get_token_info(clang_tokens, image_base, high_func)
            
            return {{
                "success": True,
                "function_name": func.getName(),
                "address": "0x" + format(offset, 'x'),
                "decompiled_code": code,
                "line_mapping": dict((str(k), "0x{{:x}}".format(v)) for k, v in line_mapping.items()),
                "tokens": tokens_info,
                "error": None
            }}
    
    return {{"success": False, "error": "Decompilation failed"}}

def get_data_items():
    """Get all defined data items (strings, variables, constants) from the program"""
    image_base = currentProgram.getImageBase()
    listing = currentProgram.getListing()
    data_type_mgr = currentProgram.getDataTypeManager()
    
    data_items = []
    max_items = 5000  # Limit to prevent overload
    
    # Iterate through all defined data in the program
    data_iter = listing.getDefinedData(True)
    count = 0
    
    while data_iter.hasNext() and count < max_items:
        data = data_iter.next()
        try:
            addr = data.getAddress()
            data_offset = addr.getOffset() - image_base.getOffset()
            
            # Skip negative offsets (external references)
            if data_offset < 0:
                continue
            
            data_type = data.getDataType()
            type_name = data_type.getName() if data_type else "undefined"
            size = data.getLength()
            
            # Get the data value as string representation
            value_str = None
            try:
                value = data.getValue()
                if value is not None:
                    if isinstance(value, str):
                        # Truncate long strings
                        value_str = value[:100] + "..." if len(value) > 100 else value
                    else:
                        value_str = str(value)[:100]
            except:
                pass
            
            # Get label/name if exists
            symbol = data.getPrimarySymbol()
            name = symbol.getName() if symbol else None
            
            # Categorize the data type
            category = "other"
            type_lower = type_name.lower()
            if "string" in type_lower or "char" in type_lower and data.hasStringValue():
                category = "string"
            elif "pointer" in type_lower or "ptr" in type_lower:
                category = "pointer"
            elif type_lower in ["byte", "word", "dword", "qword", "int", "uint", "long", "ulong", "short", "ushort"]:
                category = "integer"
            elif "float" in type_lower or "double" in type_lower:
                category = "float"
            elif "struct" in type_lower or data_type.toString().startswith("struct"):
                category = "struct"
            elif "array" in type_lower or "[" in type_name:
                category = "array"
            
            data_items.append({{
                "address": "0x{{:x}}".format(data_offset),
                "name": name,
                "type": type_name,
                "category": category,
                "size": size,
                "value": value_str
            }})
            count += 1
        except:
            continue
    
    return {{
        "success": True,
        "data": data_items,
        "total": count,
        "truncated": count >= max_items,
        "error": None
    }}

def get_xrefs(offset_str):
    image_base = currentProgram.getImageBase()
    listing = currentProgram.getListing()
    
    offset_str = offset_str.strip()
    if offset_str.startswith("0x"):
        offset_str = offset_str[2:]
    
    try:
        offset = int(offset_str, 16)
    except:
        return {{"success": False, "error": "Invalid offset format"}}
    
    addr = image_base.add(offset)
    func = getFunctionContaining(addr)
    if func is None:
        func = getFunctionAt(addr)
    
    if func is None:
        return {{"success": False, "error": "No function found at offset"}}
    
    xrefs = []
    refs = getReferencesTo(func.getEntryPoint())
    for ref in refs:
        from_addr = ref.getFromAddress()
        from_offset = from_addr.getOffset() - image_base.getOffset()
        if from_offset < 0:
            continue
        from_func = getFunctionContaining(from_addr)
        # Get the instruction at the reference address
        instruction = listing.getInstructionAt(from_addr)
        instr_str = None
        if instruction:
            instr_str = instruction.toString()
        # Calculate offset within the function (from_addr - function_entry)
        func_offset = None
        if from_func:
            func_entry_offset = from_func.getEntryPoint().getOffset() - image_base.getOffset()
            func_offset = from_offset - func_entry_offset
        xrefs.append({{
            "from_address": "0x{{:x}}".format(from_offset),
            "from_function": from_func.getName() if from_func else None,
            "from_function_offset": "0x{{:x}}".format(func_offset) if func_offset is not None else None,
            "ref_type": ref.getReferenceType().getName(),
            "instruction": instr_str
        }})
    
    return {{
        "success": True,
        "target_function": func.getName(),
        "target_address": "0x{{:x}}".format(offset),
        "xrefs": xrefs,
        "error": None
    }}

def get_function_info(offset_str):
    """Get detailed function info including variables and called functions"""
    dec = init_decompiler()
    image_base = currentProgram.getImageBase()
    listing = currentProgram.getListing()
    
    offset_str = offset_str.strip()
    if offset_str.startswith("0x"):
        offset_str = offset_str[2:]
    
    try:
        offset = int(offset_str, 16)
    except:
        return {{"success": False, "error": "Invalid offset format", "variables": [], "called_functions": []}}
    
    addr = image_base.add(offset)
    func = getFunctionContaining(addr)
    if func is None:
        func = getFunctionAt(addr)
    
    if func is None:
        return {{"success": False, "error": "No function found at offset", "variables": [], "called_functions": []}}
    
    monitor = ConsoleTaskMonitor()
    results = dec.decompileFunction(func, 60, monitor)
    
    variables = []
    called_functions = []
    
    if results and results.decompileCompleted():
        high_func = results.getHighFunction()
        if high_func:
            # Get local variables from high function
            local_sym = high_func.getLocalSymbolMap()
            if local_sym:
                for sym in local_sym.getSymbols():
                    var_info = {{
                        "name": sym.getName(),
                        "data_type": str(sym.getDataType()) if sym.getDataType() else "unknown",
                        "storage": str(sym.getStorage()) if sym.getStorage() else "unknown",
                        "is_parameter": sym.isParameter(),
                        "size": sym.getSize()
                    }}
                    variables.append(var_info)
    
    # Get called functions by scanning references from the function body
    func_body = func.getBody()
    ref_mgr = currentProgram.getReferenceManager()
    seen_funcs = set()
    
    addr_iter = func_body.getAddresses(True)
    while addr_iter.hasNext():
        from_addr = addr_iter.next()
        refs = ref_mgr.getReferencesFrom(from_addr)
        for ref in refs:
            if ref.getReferenceType().isCall():
                to_addr = ref.getToAddress()
                to_func = getFunctionAt(to_addr)
                if to_func and to_func.getName() not in seen_funcs:
                    seen_funcs.add(to_func.getName())
                    to_offset = to_func.getEntryPoint().getOffset() - image_base.getOffset()
                    if to_offset >= 0:
                        called_functions.append({{
                            "name": to_func.getName(),
                            "offset": "0x{{:x}}".format(to_offset)
                        }})
    
    func_offset = func.getEntryPoint().getOffset() - image_base.getOffset()
    
    return {{
        "success": True,
        "function_name": func.getName(),
        "function_offset": "0x{{:x}}".format(func_offset),
        "variables": variables,
        "called_functions": called_functions,
        "error": None
    }}

def get_cfg(offset_str):
    """Get Control Flow Graph (CFG) for a function using Ghidra's BasicBlockModel"""
    image_base = currentProgram.getImageBase()
    listing = currentProgram.getListing()
    monitor = ConsoleTaskMonitor()
    
    offset_str = offset_str.strip()
    if offset_str.startswith("0x"):
        offset_str = offset_str[2:]
    
    try:
        offset = int(offset_str, 16)
    except:
        return {{"success": False, "error": "Invalid offset format", "blocks": [], "edges": []}}
    
    addr = image_base.add(offset)
    func = getFunctionContaining(addr)
    if func is None:
        func = getFunctionAt(addr)
    
    if func is None:
        return {{"success": False, "error": "No function found at offset", "blocks": [], "edges": []}}
    
    # Use BasicBlockModel for CFG analysis
    block_model = BasicBlockModel(currentProgram)
    func_body = func.getBody()
    
    blocks = []
    edges = []
    block_id_map = {{}}  # address -> block_id
    
    # Get all basic blocks in the function
    block_iterator = block_model.getCodeBlocksContaining(func_body, monitor)
    block_index = 0
    
    while block_iterator.hasNext():
        block = block_iterator.next()
        block_start = block.getFirstStartAddress()
        block_end_range = block.getMaxAddress()
        
        # Calculate offsets
        start_offset = block_start.getOffset() - image_base.getOffset()
        end_offset = block_end_range.getOffset() - image_base.getOffset()
        
        # Get instructions in this block
        instructions = []
        addr_set = block.getAddresses(True)
        while addr_set.hasNext():
            instr_addr = addr_set.next()
            instruction = listing.getInstructionAt(instr_addr)
            if instruction:
                instr_offset = instr_addr.getOffset() - image_base.getOffset()
                # Get instruction bytes as hex string
                instr_bytes = instruction.getBytes()
                bytes_hex = "".join("{:02x}".format(b & 0xff) for b in instr_bytes)
                
                instructions.append({{
                    "address": "0x{{:x}}".format(instr_offset),
                    "bytes": bytes_hex,
                    "opcode": instruction.getMnemonicString(),
                    "operands": ", ".join(str(op) for op in instruction.getOpObjects(0) + instruction.getOpObjects(1) if op is not None) or str(instruction.getDefaultOperandRepresentation(0) or "")
                }})
        
        # Sort instructions by address
        instructions.sort(key=lambda x: int(x["address"], 16))
        
        block_id = "block_0x{{:x}}".format(start_offset)
        block_id_map[block_start] = block_id
        
        # Determine if this is entry/exit block
        is_entry = (block_start == func.getEntryPoint())
        
        # Check if this block ends with a return instruction
        is_exit = False
        if instructions:
            last_opcode = instructions[-1]["opcode"].lower()
            if last_opcode in ["ret", "retn", "retf"]:
                is_exit = True
        
        blocks.append({{
            "id": block_id,
            "startAddress": "0x{{:x}}".format(start_offset),
            "endAddress": "0x{{:x}}".format(end_offset),
            "instructions": instructions,
            "successors": [],
            "predecessors": [],
            "isEntry": is_entry,
            "isExit": is_exit
        }})
        block_index += 1
    
    # Build edges using block destinations
    block_iterator = block_model.getCodeBlocksContaining(func_body, monitor)
    
    while block_iterator.hasNext():
        block = block_iterator.next()
        block_start = block.getFirstStartAddress()
        from_block_id = block_id_map.get(block_start)
        
        if from_block_id is None:
            continue
        
        # Get successors
        dest_iter = block.getDestinations(monitor)
        while dest_iter.hasNext():
            dest_ref = dest_iter.next()
            dest_addr = dest_ref.getDestinationAddress()
            dest_block = dest_ref.getDestinationBlock()
            
            if dest_block is None:
                continue
                
            dest_block_start = dest_block.getFirstStartAddress()
            to_block_id = block_id_map.get(dest_block_start)
            
            if to_block_id is None:
                continue
            
            # Determine edge type based on flow type
            flow_type = dest_ref.getFlowType()
            if flow_type.isConditional():
                # Check if this is the fall-through or jump target
                block_max = block.getMaxAddress()
                next_addr = block_max.add(1)
                if dest_addr == next_addr or dest_block_start == next_addr:
                    edge_type = "conditional-false"
                else:
                    edge_type = "conditional-true"
            elif flow_type.isUnConditional():
                edge_type = "unconditional"
            else:
                edge_type = "normal"
            
            edges.append({{
                "from": from_block_id,
                "to": to_block_id,
                "type": edge_type
            }})
            
            # Update successors/predecessors in blocks
            for b in blocks:
                if b["id"] == from_block_id and to_block_id not in b["successors"]:
                    b["successors"].append(to_block_id)
                if b["id"] == to_block_id and from_block_id not in b["predecessors"]:
                    b["predecessors"].append(from_block_id)
    
    # Mark blocks with no successors as exit blocks
    for b in blocks:
        if not b["successors"]:
            b["isExit"] = True
    
    func_offset_val = func.getEntryPoint().getOffset() - image_base.getOffset()
    
    return {{
        "success": True,
        "function_name": func.getName(),
        "function_offset": "0x{{:x}}".format(func_offset_val),
        "blocks": blocks,
        "edges": edges,
        "error": None
    }}

def analyze_reachability(func_offset_str, current_block_str, registers_json):
    """Analyze block reachability from current block with given register values"""
    image_base = currentProgram.getImageBase()
    listing = currentProgram.getListing()
    monitor = ConsoleTaskMonitor()
    
    # Parse function offset
    func_offset_str = func_offset_str.strip()
    if func_offset_str.startswith("0x"):
        func_offset_str = func_offset_str[2:]
    
    try:
        func_offset = int(func_offset_str, 16)
    except:
        return {{"success": False, "error": "Invalid function offset format", "blocks": []}}
    
    # Parse current block offset  
    current_block_str = current_block_str.strip()
    if current_block_str.startswith("0x"):
        current_block_str = current_block_str[2:]
    
    try:
        current_block_offset = int(current_block_str, 16)
    except:
        return {{"success": False, "error": "Invalid current block offset format", "blocks": []}}
    
    # Parse register values
    registers = {{}}
    if registers_json:
        try:
            registers = json.loads(registers_json)
        except:
            pass
    
    # Get function
    func_addr = image_base.add(func_offset)
    func = getFunctionContaining(func_addr)
    if func is None:
        func = getFunctionAt(func_addr)
    
    if func is None:
        return {{"success": False, "error": "No function found at offset", "blocks": []}}
    
    # Build CFG
    block_model = BasicBlockModel(currentProgram)
    func_body = func.getBody()
    
    # Collect all blocks
    block_map = {{}}  # address -> block
    block_info = {{}}  # address -> info dict
    
    block_iterator = block_model.getCodeBlocksContaining(func_body, monitor)
    while block_iterator.hasNext():
        block = block_iterator.next()
        block_start = block.getFirstStartAddress()
        start_offset = block_start.getOffset() - image_base.getOffset()
        end_offset = block.getMaxAddress().getOffset() - image_base.getOffset()
        
        block_id = "block_0x{{:x}}".format(start_offset)
        block_map[block_start] = block
        block_info[block_start] = {{
            "blockId": block_id,
            "startAddress": "0x{{:x}}".format(start_offset),
            "endAddress": "0x{{:x}}".format(end_offset),
            "status": "unknown",
            "condition": ""
        }}
    
    # Find current block
    current_addr = image_base.add(current_block_offset)
    current_block = None
    current_block_start = None
    
    for block_start, block in block_map.items():
        if block.contains(current_addr):
            current_block = block
            current_block_start = block_start
            break
    
    if current_block is None:
        # Try exact match
        if current_addr in block_map:
            current_block = block_map[current_addr]
            current_block_start = current_addr
    
    if current_block is None:
        return {{"success": False, "error": "Current block not found", "blocks": []}}
    
    # Mark current block
    block_info[current_block_start]["status"] = "current"
    
    # BFS to find reachable blocks
    from java.util import LinkedList, HashSet
    
    queue = LinkedList()
    visited = HashSet()
    queue.add(current_block_start)
    visited.add(current_block_start)
    
    while not queue.isEmpty():
        block_addr = queue.poll()
        block = block_map.get(block_addr)
        
        if block is None:
            continue
        
        # Get last instruction to determine branch type
        block_max = block.getMaxAddress()
        last_instr = listing.getInstructionAt(block_max)
        
        # Get successors
        dest_iter = block.getDestinations(monitor)
        successors = []
        
        while dest_iter.hasNext():
            dest_ref = dest_iter.next()
            dest_block = dest_ref.getDestinationBlock()
            
            if dest_block is None:
                continue
                
            dest_start = dest_block.getFirstStartAddress()
            if dest_start not in block_map:
                continue
                
            flow_type = dest_ref.getFlowType()
            successors.append((dest_start, flow_type, dest_ref.getDestinationAddress()))
        
        # Analyze reachability based on branch condition and registers
        is_conditional = last_instr is not None and any(ft.isConditional() for _, ft, _ in successors)
        
        if is_conditional and last_instr is not None:
            mnemonic = last_instr.getMnemonicString().lower()
            
            # Try to evaluate condition based on register values
            condition_result = evaluate_branch_condition(mnemonic, last_instr, registers)
            
            for dest_start, flow_type, dest_addr in successors:
                if visited.contains(dest_start):
                    continue
                
                info = block_info[dest_start]
                
                if condition_result is None:
                    # Can't determine - mark as conditional
                    info["status"] = "conditional"
                    info["condition"] = mnemonic
                    visited.add(dest_start)
                    queue.add(dest_start)
                elif condition_result == True:
                    # Branch taken
                    if flow_type.isConditional():
                        # Check if this is the taken path
                        block_max_next = block_max.add(1)
                        if dest_addr == block_max_next or dest_start == block_max_next:
                            # Fall-through - not taken
                            info["status"] = "unreachable"
                            info["condition"] = "branch taken, fall-through skipped"
                        else:
                            # Jump target - taken
                            info["status"] = "reachable"
                            info["condition"] = mnemonic + " taken"
                            visited.add(dest_start)
                            queue.add(dest_start)
                    else:
                        info["status"] = "reachable"
                        visited.add(dest_start)
                        queue.add(dest_start)
                else:
                    # Branch not taken
                    if flow_type.isConditional():
                        block_max_next = block_max.add(1)
                        if dest_addr == block_max_next or dest_start == block_max_next:
                            # Fall-through - taken
                            info["status"] = "reachable"
                            info["condition"] = mnemonic + " not taken"
                            visited.add(dest_start)
                            queue.add(dest_start)
                        else:
                            # Jump target - not taken
                            info["status"] = "unreachable"
                            info["condition"] = "branch not taken"
                    else:
                        info["status"] = "reachable"
                        visited.add(dest_start)
                        queue.add(dest_start)
        else:
            # Unconditional - all successors are reachable
            for dest_start, flow_type, _ in successors:
                if visited.contains(dest_start):
                    continue
                    
                block_info[dest_start]["status"] = "reachable"
                visited.add(dest_start)
                queue.add(dest_start)
    
    # Mark unvisited blocks as unreachable
    for block_start, info in block_info.items():
        if info["status"] == "unknown":
            info["status"] = "unreachable"
    
    func_offset_val = func.getEntryPoint().getOffset() - image_base.getOffset()
    
    return {{
        "success": True,
        "functionName": func.getName(),
        "functionOffset": "0x{{:x}}".format(func_offset_val),
        "currentBlock": "0x{{:x}}".format(current_block_offset),
        "blocks": list(block_info.values()),
        "error": None
    }}

def evaluate_branch_condition(mnemonic, instr, registers):
    """Evaluate branch condition based on register values. Returns True/False/None."""
    # Get operands
    ops = []
    for i in range(instr.getNumOperands()):
        op_objs = instr.getOpObjects(i)
        if op_objs:
            ops.extend([str(o).lower() for o in op_objs])
    
    # cbz/cbnz - compare register with zero
    if mnemonic == "cbz" and ops:
        reg_name = ops[0]
        if reg_name in registers:
            try:
                val = int(registers[reg_name], 16) if isinstance(registers[reg_name], str) else registers[reg_name]
                return val == 0
            except:
                pass
        return None
    
    if mnemonic == "cbnz" and ops:
        reg_name = ops[0]
        if reg_name in registers:
            try:
                val = int(registers[reg_name], 16) if isinstance(registers[reg_name], str) else registers[reg_name]
                return val != 0
            except:
                pass
        return None
    
    # tbz/tbnz - test bit and branch
    if mnemonic == "tbz" and len(ops) >= 2:
        reg_name = ops[0]
        try:
            bit_num = int(ops[1])
            if reg_name in registers:
                val = int(registers[reg_name], 16) if isinstance(registers[reg_name], str) else registers[reg_name]
                return (val >> bit_num) & 1 == 0
        except:
            pass
        return None
    
    if mnemonic == "tbnz" and len(ops) >= 2:
        reg_name = ops[0]
        try:
            bit_num = int(ops[1])
            if reg_name in registers:
                val = int(registers[reg_name], 16) if isinstance(registers[reg_name], str) else registers[reg_name]
                return (val >> bit_num) & 1 != 0
        except:
            pass
        return None
    
    # For flag-based conditions (b.eq, b.ne, etc.), we'd need NZCV flags
    # Return None to indicate we can't determine
    return None

class GhidraHandler(BaseHTTPServer.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress logging
    
    def do_GET(self):
        parsed = urlparse.urlparse(self.path)
        params = urlparse.parse_qs(parsed.query)
        
        if parsed.path == "/decompile":
            offset = params.get("offset", [""])[0]
            result = decompile_function(offset)
        elif parsed.path == "/xrefs":
            offset = params.get("offset", [""])[0]
            result = get_xrefs(offset)
        elif parsed.path == "/function_info":
            offset = params.get("offset", [""])[0]
            result = get_function_info(offset)
        elif parsed.path == "/cfg":
            offset = params.get("offset", [""])[0]
            result = get_cfg(offset)
        elif parsed.path == "/reachability":
            func_offset = params.get("func_offset", [""])[0]
            current_block = params.get("current_block", [""])[0]
            registers = params.get("registers", ["{{}}"])[0]
            result = analyze_reachability(func_offset, current_block, registers)
        elif parsed.path == "/data":
            result = get_data_items()
        elif parsed.path == "/ping":
            result = {{"status": "ok", "program": currentProgram.getName()}}
        elif parsed.path == "/info":
            image_base = currentProgram.getImageBase()
            funcs = []
            func_mgr = currentProgram.getFunctionManager()
            for func in func_mgr.getFunctions(True):
                func_offset = func.getEntryPoint().getOffset() - image_base.getOffset()
                if func_offset >= 0:
                    funcs.append({{"name": func.getName(), "offset": "0x{{:x}}".format(func_offset)}})
            result = {{
                "status": "ok",
                "program": currentProgram.getName(),
                "image_base": "0x{{:x}}".format(image_base.getOffset()),
                "functions": funcs
            }}
        elif parsed.path == "/shutdown":
            result = {{"status": "shutting_down"}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result))
            threading.Thread(target=self.server.shutdown).start()
            return
        else:
            result = {{"error": "Unknown endpoint"}}
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result))

print("Starting Ghidra HTTP Server on port {0}...")
server = BaseHTTPServer.HTTPServer(("127.0.0.1", {0}), GhidraHandler)
print("Ghidra Server ready on http://127.0.0.1:{0}")
print("GHIDRA_SERVER_READY")
server.serve_forever()
"#, port)
}

/// Start Ghidra server for a project
#[tauri::command]
async fn start_ghidra_server(
    project_path: String,
    library_name: String,
    ghidra_path: String,
    port: u16,
) -> Result<bool, String> {
    // Check if server is already running
    {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        if ports.contains_key(&project_path) {
            return Ok(true); // Already running
        }
    }
    
    let ghidra_base = PathBuf::from(&ghidra_path);
    let analyzer_path = if cfg!(windows) {
        ghidra_base.join("support").join("analyzeHeadless.bat")
    } else {
        ghidra_base.join("support").join("analyzeHeadless")
    };
    
    if !analyzer_path.exists() {
        return Err("Ghidra analyzeHeadless not found".to_string());
    }
    
    // Generate and save the server script
    let ghidra_dir = get_ghidra_projects_dir();
    let script_path = ghidra_dir.join("ghidra_server.py");
    let script_content = generate_ghidra_server_script(port);
    
    fs::write(&script_path, &script_content)
        .await
        .map_err(|e| format!("Failed to write server script: {}", e))?;
    
    // Clean library name (without extension)
    // Ghidra stores imported programs with file_stem (no extension) as the program name
    let clean_lib_name = PathBuf::from(&library_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(library_name.clone());
    
    // Start Ghidra with the server script (non-blocking)
    // Use clean_lib_name (without extension) for -process option
    // Ghidra stores imported programs without file extensions
    let mut child = hide_console_window(&mut Command::new(&analyzer_path))
        .arg(&project_path)
        .arg(&clean_lib_name)
        .arg("-process")
        .arg(&clean_lib_name)
        .arg("-noanalysis")
        .arg("-postScript")
        .arg(script_path.to_string_lossy().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start Ghidra server: {}", e))?;
    
    // Spawn threads to consume stdout/stderr to prevent blocking
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let project_path_clone = project_path.clone();
    
    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let mut logs = GHIDRA_SERVER_LOGS.lock().unwrap();
                    logs.entry(project_path_clone.clone())
                        .or_insert_with(Vec::new)
                        .push(format!("[stdout] {}", line));
                }
            }
        });
    }
    
    let project_path_clone2 = project_path.clone();
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let mut logs = GHIDRA_SERVER_LOGS.lock().unwrap();
                    logs.entry(project_path_clone2.clone())
                        .or_insert_with(Vec::new)
                        .push(format!("[stderr] {}", line));
                }
            }
        });
    }
    
    // Store the process and port
    {
        let mut servers = GHIDRA_SERVERS.lock().map_err(|e| e.to_string())?;
        servers.insert(project_path.clone(), child);
    }
    {
        let mut ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.insert(project_path.clone(), port);
    }
    {
        let mut logs = GHIDRA_SERVER_LOGS.lock().map_err(|e| e.to_string())?;
        logs.insert(project_path, Vec::new());
    }
    
    Ok(true)
}

/// Stop Ghidra server for a project
#[tauri::command]
async fn stop_ghidra_server(project_path: String) -> Result<bool, String> {
    // Try to send shutdown request first
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    if let Some(port) = port {
        let _ = reqwest::get(&format!("http://127.0.0.1:{}/shutdown", port)).await;
    }
    
    // Kill the process
    {
        let mut servers = GHIDRA_SERVERS.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = servers.remove(&project_path) {
            let _ = child.kill();
        }
    }
    {
        let mut ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.remove(&project_path);
    }
    {
        let mut logs = GHIDRA_SERVER_LOGS.lock().map_err(|e| e.to_string())?;
        logs.remove(&project_path);
    }
    
    Ok(true)
}

/// Check if Ghidra server is running
#[tauri::command]
async fn check_ghidra_server(project_path: String) -> Result<Option<u16>, String> {
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    if let Some(port) = port {
        // Ping the server to check if it's responsive
        match reqwest::get(&format!("http://127.0.0.1:{}/ping", port)).await {
            Ok(resp) if resp.status().is_success() => Ok(Some(port)),
            _ => {
                // Server not responding yet, but don't kill it - it might still be starting
                // Just return None to indicate it's not ready
                Ok(None)
            }
        }
    } else {
        Ok(None)
    }
}

/// Get Ghidra server logs for debugging
#[tauri::command]
async fn get_ghidra_server_logs(project_path: String) -> Result<Vec<String>, String> {
    let logs = GHIDRA_SERVER_LOGS.lock().map_err(|e| e.to_string())?;
    Ok(logs.get(&project_path).cloned().unwrap_or_default())
}

/// Fast decompile using running Ghidra server
#[tauri::command]
async fn ghidra_server_decompile(
    project_path: String,
    function_address: String,
) -> Result<GhidraDecompileResult, String> {
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    let port = port.ok_or("Ghidra server not running for this project")?;
    
    let url = format!("http://127.0.0.1:{}/decompile?offset={}", port, function_address);
    
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to connect to Ghidra server: {}", e))?;
    
    // First get the raw text to see what we're receiving
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to get response text: {}", e))?;
    
    // Try to parse the JSON with better error handling
    let result: GhidraDecompileResult = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse response: {}. Response was: {}", e, text.chars().take(500).collect::<String>()))?;
    
    Ok(result)
}

/// Fast xrefs using running Ghidra server
#[tauri::command]
async fn ghidra_server_xrefs(
    project_path: String,
    function_address: String,
) -> Result<GhidraXrefsResult, String> {
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    let port = port.ok_or("Ghidra server not running for this project")?;
    
    let url = format!("http://127.0.0.1:{}/xrefs?offset={}", port, function_address);
    
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to connect to Ghidra server: {}", e))?;
    
    // First get the raw text to see what we're receiving
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to get response text: {}", e))?;
    
    // Try to parse the JSON with better error handling
    let result: GhidraXrefsResult = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse response: {}. Response was: {}", e, text.chars().take(500).collect::<String>()))?;
    
    Ok(result)
}

/// Fast function info using running Ghidra server
#[tauri::command]
async fn ghidra_server_function_info(
    project_path: String,
    function_address: String,
) -> Result<GhidraFunctionInfoResult, String> {
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    let port = port.ok_or("Ghidra server not running for this project")?;
    
    let url = format!("http://127.0.0.1:{}/function_info?offset={}", port, function_address);
    
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to connect to Ghidra server: {}", e))?;
    
    let result: GhidraFunctionInfoResult = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    Ok(result)
}

// ============================================================================
// Ghidra CFG (Control Flow Graph) types and commands
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraCfgInstruction {
    pub address: String,
    pub bytes: String,
    pub opcode: String,
    pub operands: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraCfgBlock {
    pub id: String,
    #[serde(rename = "startAddress")]
    pub start_address: String,
    #[serde(rename = "endAddress")]
    pub end_address: String,
    pub instructions: Vec<GhidraCfgInstruction>,
    pub successors: Vec<String>,
    pub predecessors: Vec<String>,
    #[serde(rename = "isEntry")]
    pub is_entry: bool,
    #[serde(rename = "isExit")]
    pub is_exit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraCfgEdge {
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraCfgResult {
    pub success: bool,
    pub function_name: Option<String>,
    pub function_offset: Option<String>,
    pub blocks: Vec<GhidraCfgBlock>,
    pub edges: Vec<GhidraCfgEdge>,
    pub error: Option<String>,
}

/// Get CFG (Control Flow Graph) using running Ghidra server
#[tauri::command]
async fn ghidra_server_cfg(
    project_path: String,
    function_address: String,
) -> Result<GhidraCfgResult, String> {
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    let port = port.ok_or("Ghidra server not running for this project")?;
    
    let url = format!("http://127.0.0.1:{}/cfg?offset={}", port, function_address);
    
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to connect to Ghidra server: {}", e))?;
    
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to get response text: {}", e))?;
    
    let result: GhidraCfgResult = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse CFG response: {}. Response was: {}", e, text.chars().take(500).collect::<String>()))?;
    
    Ok(result)
}

/// Ghidra Data item from analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraDataItem {
    pub address: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub data_type: String,
    pub category: String,  // "string", "pointer", "integer", "float", "struct", "array", "other"
    pub size: i64,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhidraDataResult {
    pub success: bool,
    pub data: Vec<GhidraDataItem>,
    pub total: i64,
    pub truncated: bool,
    pub error: Option<String>,
}

/// Get Data items (strings, variables, constants) using running Ghidra server
#[tauri::command]
async fn ghidra_server_data(
    project_path: String,
) -> Result<GhidraDataResult, String> {
    let port = {
        let ports = GHIDRA_SERVER_PORTS.lock().map_err(|e| e.to_string())?;
        ports.get(&project_path).copied()
    };
    
    let port = port.ok_or("Ghidra server not running for this project")?;
    
    let url = format!("http://127.0.0.1:{}/data", port);
    
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to connect to Ghidra server: {}", e))?;
    
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to get response text: {}", e))?;
    
    let result: GhidraDataResult = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Data response: {}. Response was: {}", e, text.chars().take(500).collect::<String>()))?;
    
    Ok(result)
}

// ============================================================================
// Block Reachability Analysis with Z3
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockReachability {
    #[serde(rename = "blockId")]
    pub block_id: String,
    #[serde(rename = "startAddress")]
    pub start_address: String,
    #[serde(rename = "endAddress")]
    pub end_address: String,
    pub status: String,  // "current", "reachable", "unreachable", "conditional", "unknown"
    #[serde(default)]
    pub condition: String,  // Human-readable condition description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probability: Option<f64>,  // For conditional blocks (0.0 - 1.0)
    #[serde(rename = "pathConditions", skip_serializing_if = "Option::is_none")]
    pub path_conditions: Option<Vec<String>>,  // Path conditions to reach this block
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReachabilityResult {
    pub success: bool,
    #[serde(rename = "functionName")]
    pub function_name: Option<String>,
    #[serde(rename = "functionOffset")]
    pub function_offset: Option<String>,
    #[serde(rename = "currentBlock")]
    pub current_block: Option<String>,
    pub blocks: Vec<BlockReachability>,
    pub error: Option<String>,
}

/// Analyze block reachability using Z3 (via Ghidra headless Java script)
#[tauri::command]
async fn ghidra_analyze_reachability(
    project_path: String,
    library_name: String,
    function_offset: String,
    current_block_offset: String,
    dbgsrv_url: String, // URL of dbgsrv for memory access
    auth_token: String, // Authentication token for dbgsrv API
    ghidra_path: String,
    registers_json: String, // JSON string of register values from UI (e.g., {"x0": "0x1234", "x1": "0x5678", ...})
    library_base_address: String, // Base address of the library in memory (e.g., "0x71d7d93000")
) -> Result<ReachabilityResult, String> {
    let ghidra_base = PathBuf::from(&ghidra_path);
    let analyzer_path = if cfg!(windows) {
        ghidra_base.join("support").join("analyzeHeadless.bat")
    } else {
        ghidra_base.join("support").join("analyzeHeadless")
    };
    
    if !analyzer_path.exists() {
        return Ok(ReachabilityResult {
            success: false,
            function_name: None,
            function_offset: None,
            current_block: None,
            blocks: vec![],
            error: Some(format!("Ghidra analyzeHeadless not found at: {:?}", analyzer_path)),
        });
    }
    
    // Get script path from the application's scripts directory
    let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("ReachabilityAnalysis.java");
    
    if !script_path.exists() {
        return Ok(ReachabilityResult {
            success: false,
            function_name: None,
            function_offset: None,
            current_block: None,
            blocks: vec![],
            error: Some(format!("ReachabilityAnalysis.java script not found at: {:?}", script_path)),
        });
    }
    
    // Clean library name for Ghidra project (stem without extension)
    // Ghidra stores imported programs with file_stem (no extension) as the program name
    let clean_lib_name = PathBuf::from(&library_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(library_name.clone());
    
    // Run Ghidra headless with the Z3 reachability script
    // Format: analyzeHeadless <project> <name> -process <file> -noanalysis 
    //         -scriptPath <dir> -preScript <script> <arg1> <arg2> <arg3>
    // Each argument must be a separate command-line argument
    // Use clean_lib_name (without extension) for -process option
    let script_name = script_path.file_name().unwrap().to_string_lossy().to_string();
    let script_dir = script_path.parent().unwrap_or(&script_path).to_string_lossy().to_string();
    
    let output = hide_console_window(&mut Command::new(&analyzer_path))
        .arg(&project_path)
        .arg(&clean_lib_name)
        .arg("-process")
        .arg(&clean_lib_name)
        .arg("-noanalysis")
        .arg("-readOnly")
        .arg("-scriptPath")
        .arg(&script_dir)
        .arg("-preScript")
        .arg(&script_name)
        .arg(&function_offset)
        .arg(&current_block_offset)
        .arg(&dbgsrv_url)
        .arg(&auth_token)
        .arg(&registers_json)
        .arg(&library_base_address)
        .output()
        .map_err(|e| format!("Failed to run Ghidra: {}", e))?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    // Parse result from stdout - look for REACHABILITY_RESULT: marker
    for line in stdout.lines() {
        if line.starts_with("REACHABILITY_RESULT:") {
            let json_str = line.trim_start_matches("REACHABILITY_RESULT:");
            // Extract only the JSON part (from first '{' to last '}')
            // Ghidra may append extra text like "(GhidraScript)" after the JSON
            let json_str = if let (Some(start), Some(end)) = (json_str.find('{'), json_str.rfind('}')) {
                &json_str[start..=end]
            } else {
                json_str
            };
            match serde_json::from_str::<ReachabilityResult>(json_str) {
                Ok(result) => return Ok(result),
                Err(e) => {
                    return Ok(ReachabilityResult {
                        success: false,
                        function_name: None,
                        function_offset: None,
                        current_block: None,
                        blocks: vec![],
                        error: Some(format!("Failed to parse result: {}. JSON: {}", e, json_str)),
                    });
                }
            }
        }
    }
    
    // No result found - return debug info with more context
    Ok(ReachabilityResult {
        success: false,
        function_name: None,
        function_offset: None,
        current_block: None,
        blocks: vec![],
        error: Some(format!(
            "No reachability result found. stdout: {}, stderr: {}",
            stdout.chars().take(3000).collect::<String>(),
            stderr.chars().take(1500).collect::<String>()
        )),
    })
}

// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct XrefEntry {
    from_address: String,
    from_function: Option<String>,
    #[serde(default)]
    from_function_offset: Option<String>,
    ref_type: String,
    #[serde(default)]
    instruction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GhidraXrefsResult {
    success: bool,
    target_function: String,
    target_address: String,
    xrefs: Vec<XrefEntry>,
    error: Option<String>,
}

/// Get cross-references (xrefs) to a function using Ghidra
#[tauri::command]
async fn ghidra_get_xrefs(
    project_path: String,
    library_name: String,
    function_address: String,
    ghidra_path: String,
) -> Result<GhidraXrefsResult, String> {
    let ghidra_base = PathBuf::from(&ghidra_path);
    let analyzer_path = if cfg!(windows) {
        ghidra_base.join("support").join("analyzeHeadless.bat")
    } else {
        ghidra_base.join("support").join("analyzeHeadless")
    };
    
    if !analyzer_path.exists() {
        return Ok(GhidraXrefsResult {
            success: false,
            target_function: String::new(),
            target_address: function_address.clone(),
            xrefs: vec![],
            error: Some("Ghidra analyzeHeadless not found".to_string()),
        });
    }
    
    let ghidra_dir = get_ghidra_projects_dir();
    let script_path = ghidra_dir.join("get_xrefs.py");
    let output_path = ghidra_dir.join("xrefs_output.txt");
    
    // Ghidra Python script to get xrefs
    let script_content = format!(r#"#@runtime Jython
# @category DynaDbg
# @description Get cross-references to a function at offset

def get_xrefs_at_offset(offset_str):
    image_base = currentProgram.getImageBase()
    
    offset_str = offset_str.strip()
    if offset_str.startswith("0x"):
        offset_str = offset_str[2:]
    
    try:
        offset = int(offset_str, 16)
    except:
        return "Error: Invalid offset format: " + offset_str
    
    addr = image_base.add(offset)
    
    func = getFunctionContaining(addr)
    if func is None:
        func = getFunctionAt(addr)
    
    if func is None:
        return "Error: No function found at address " + str(addr)
    
    func_name = func.getName()
    func_entry = func.getEntryPoint()
    func_offset = func_entry.getOffset() - image_base.getOffset()
    
    result = "TARGET_FUNCTION:" + func_name + "\n"
    result += "TARGET_ADDRESS:0x{{:x}}\n".format(func_offset)
    result += "XREFS:\n"
    
    # Get references TO this function
    ref_manager = currentProgram.getReferenceManager()
    refs = ref_manager.getReferencesTo(func_entry)
    
    xref_count = 0
    for ref in refs:
        if xref_count >= 100:  # Limit to 100 xrefs
            break
        from_addr = ref.getFromAddress()
        from_offset = from_addr.getOffset() - image_base.getOffset()
        ref_type = str(ref.getReferenceType())
        
        # Skip external references (negative offsets or special addresses)
        if from_offset < 0:
            continue
        
        # Get function containing the reference
        from_func = getFunctionContaining(from_addr)
        from_func_name = from_func.getName() if from_func else "unknown"
        
        # Calculate offset within the function
        from_func_offset = "unknown"
        if from_func:
            func_entry_offset = from_func.getEntryPoint().getOffset() - image_base.getOffset()
            from_func_offset = "0x{{:x}}".format(from_offset - func_entry_offset)
        
        result += "0x{{:x}}|{{}}|{{}}||{{}}\n".format(from_offset, from_func_name, ref_type, from_func_offset)
        xref_count += 1
    
    return result

offset = "{}"
result = get_xrefs_at_offset(offset)

with open(r"{}", "w") as f:
    f.write(result)
"#, function_address, output_path.to_string_lossy().replace("\\", "\\\\"));
    
    fs::write(&script_path, &script_content)
        .await
        .map_err(|e| format!("Failed to write xref script: {}", e))?;
    
    // Clean library name (without extension)
    // Ghidra stores imported programs with file_stem (no extension) as the program name
    let clean_lib_name = PathBuf::from(&library_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(library_name.clone());
    
    // Use clean_lib_name (without extension) for -process option
    // Ghidra stores imported programs without file extensions
    let output = hide_console_window(&mut Command::new(&analyzer_path))
        .arg(&project_path)
        .arg(&clean_lib_name)
        .arg("-process")
        .arg(&clean_lib_name)
        .arg("-noanalysis")
        .arg("-postScript")
        .arg(script_path.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("Failed to run Ghidra: {}", e))?;
    
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(GhidraXrefsResult {
            success: false,
            target_function: String::new(),
            target_address: function_address,
            xrefs: vec![],
            error: Some(format!("Ghidra process failed (exit code {:?}): \nStdout: {}\nStderr: {}", output.status.code(), stdout, stderr)),
        });
    }

    let xref_output = match fs::read_to_string(&output_path).await {
        Ok(content) => content,
        Err(e) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Ok(GhidraXrefsResult {
                success: false,
                target_function: String::new(),
                target_address: function_address,
                xrefs: vec![],
                error: Some(format!("Could not read xref output: {}. \nStdout: {}\nStderr: {}", e, stdout, stderr)),
            });
        }
    };
    
    let _ = fs::remove_file(&script_path).await;
    let _ = fs::remove_file(&output_path).await;
    
    if xref_output.starts_with("Error:") {
        return Ok(GhidraXrefsResult {
            success: false,
            target_function: String::new(),
            target_address: function_address,
            xrefs: vec![],
            error: Some(xref_output),
        });
    }
    
    let mut target_function = String::new();
    let mut target_address = String::new();
    let mut xrefs: Vec<XrefEntry> = vec![];
    let mut in_xrefs = false;
    
    for line in xref_output.lines() {
        if line.starts_with("TARGET_FUNCTION:") {
            target_function = line.replace("TARGET_FUNCTION:", "");
        } else if line.starts_with("TARGET_ADDRESS:") {
            target_address = line.replace("TARGET_ADDRESS:", "");
        } else if line.starts_with("XREFS:") {
            in_xrefs = true;
        } else if in_xrefs && !line.is_empty() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 3 {
                xrefs.push(XrefEntry {
                    from_address: parts[0].to_string(),
                    from_function: if parts[1] == "unknown" { None } else { Some(parts[1].to_string()) },
                    from_function_offset: if parts.len() >= 5 && parts[4] != "unknown" { Some(parts[4].to_string()) } else { None },
                    ref_type: parts[2].to_string(),
                    instruction: if parts.len() >= 4 { Some(parts[3].to_string()) } else { None },
                });
            }
        }
    }
    
    Ok(GhidraXrefsResult {
        success: true,
        target_function,
        target_address,
        xrefs,
        error: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GhidraFunctionEntry {
    name: String,
    address: String, // offset from image base as hex string
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GhidraFunctionListResult {
    success: bool,
    functions: Vec<GhidraFunctionEntry>,
    error: Option<String>,
}

/// Get all functions from an analyzed library using Ghidra
#[tauri::command]
async fn ghidra_get_functions(
    project_path: String,
    library_name: String,
    ghidra_path: String,
) -> Result<GhidraFunctionListResult, String> {
    let ghidra_base = PathBuf::from(&ghidra_path);
    let analyzer_path = if cfg!(windows) {
        ghidra_base.join("support").join("analyzeHeadless.bat")
    } else {
        ghidra_base.join("support").join("analyzeHeadless")
    };
    
    if !analyzer_path.exists() {
        return Ok(GhidraFunctionListResult {
            success: false,
            functions: vec![],
            error: Some("Ghidra analyzeHeadless not found".to_string()),
        });
    }
    
    let ghidra_dir = get_ghidra_projects_dir();
    let script_path = ghidra_dir.join("get_functions.py");
    let output_path = ghidra_dir.join("functions_output.txt");
    
    // Ghidra Python script to get all functions
    let script_content = format!(r#"#@runtime Jython
# @category DynaDbg
# @description Get all functions from the program

def get_all_functions():
    image_base = currentProgram.getImageBase()
    func_manager = currentProgram.getFunctionManager()
    
    result = "FUNCTIONS:\n"
    
    for func in func_manager.getFunctions(True):  # True = forward iteration
        func_name = func.getName()
        entry_point = func.getEntryPoint()
        offset = entry_point.getOffset() - image_base.getOffset()
        body = func.getBody()
        size = body.getNumAddresses() if body else 0
        
        # Format: name|offset|size
        result += "{{}}|0x{{:x}}|{{}}\n".format(func_name, offset, size)
    
    return result

result = get_all_functions()

import codecs
with codecs.open(r"{}", "w", "utf-8") as f:
    f.write(result)
"#, output_path.to_string_lossy().replace("\\", "\\\\"));
    
    fs::write(&script_path, &script_content)
        .await
        .map_err(|e| format!("Failed to write functions script: {}", e))?;
    
    // Clean library name (without extension)
    // Ghidra stores imported programs with file_stem (no extension) as the program name
    let clean_lib_name = PathBuf::from(&library_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(library_name.clone());
    
    // Use clean_lib_name (without extension) for -process option
    // Ghidra stores imported programs without file extensions
    let output = hide_console_window(&mut Command::new(&analyzer_path))
        .arg(&project_path)
        .arg(&clean_lib_name)
        .arg("-process")
        .arg(&clean_lib_name)
        .arg("-noanalysis")
        .arg("-postScript")
        .arg(script_path.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("Failed to run Ghidra: {}", e))?;
    
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(GhidraFunctionListResult {
            success: false,
            functions: vec![],
            error: Some(format!("Ghidra process failed (exit code {:?}): \nStdout: {}\nStderr: {}", output.status.code(), stdout, stderr)),
        });
    }

    let func_output = match fs::read_to_string(&output_path).await {
        Ok(content) => content,
        Err(e) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Ok(GhidraFunctionListResult {
                success: false,
                functions: vec![],
                error: Some(format!("Could not read functions output: {}. \nStdout: {}\nStderr: {}", e, stdout, stderr)),
            });
        }
    };
    
    let _ = fs::remove_file(&script_path).await;
    let _ = fs::remove_file(&output_path).await;
    
    let mut functions: Vec<GhidraFunctionEntry> = vec![];
    let mut in_functions = false;
    
    for line in func_output.lines() {
        if line.starts_with("FUNCTIONS:") {
            in_functions = true;
        } else if in_functions && !line.is_empty() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 3 {
                functions.push(GhidraFunctionEntry {
                    name: parts[0].to_string(),
                    address: parts[1].to_string(),
                    size: parts[2].parse().unwrap_or(0),
                });
            }
        }
    }
    
    Ok(GhidraFunctionListResult {
        success: true,
        functions,
        error: None,
    })
}

/// Save analyzed module and its functions to SQLite database
#[tauri::command]
fn save_ghidra_functions_to_db(
    target_os: String,
    module_name: String,
    module_path: String,
    local_path: String,
    project_path: String,
    functions: Vec<GhidraFunctionEntry>,
) -> Result<bool, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    let analyzed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    
    // Insert or replace the module record
    conn.execute(
        "INSERT OR REPLACE INTO analyzed_modules (target_os, module_name, module_path, local_path, project_path, analyzed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![target_os, module_name, module_path, local_path, project_path, analyzed_at],
    ).map_err(|e| e.to_string())?;
    
    // Get the module ID
    let module_id: i64 = conn.query_row(
        "SELECT id FROM analyzed_modules WHERE target_os = ?1 AND module_name = ?2",
        params![target_os, module_name],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    
    // Delete existing functions for this module
    conn.execute(
        "DELETE FROM module_functions WHERE module_id = ?1",
        params![module_id],
    ).map_err(|e| e.to_string())?;
    
    // Insert all functions
    for func in &functions {
        conn.execute(
            "INSERT INTO module_functions (module_id, name, address, size) VALUES (?1, ?2, ?3, ?4)",
            params![module_id, func.name, func.address, func.size],
        ).map_err(|e| e.to_string())?;
    }
    
    Ok(true)
}

/// Get functions from SQLite database for a module
#[tauri::command]
fn get_ghidra_functions_from_db(
    target_os: String,
    module_name: String,
) -> Result<GhidraFunctionListResult, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    // Get the module ID
    let module_id: Result<i64, _> = conn.query_row(
        "SELECT id FROM analyzed_modules WHERE target_os = ?1 AND module_name = ?2",
        params![target_os, module_name],
        |row| row.get(0),
    );
    
    let module_id = match module_id {
        Ok(id) => id,
        Err(_) => {
            return Ok(GhidraFunctionListResult {
                success: false,
                functions: vec![],
                error: Some("Module not found in database".to_string()),
            });
        }
    };
    
    // Get all functions for this module
    let mut stmt = conn.prepare(
        "SELECT name, address, size FROM module_functions WHERE module_id = ?1"
    ).map_err(|e| e.to_string())?;
    
    let functions: Vec<GhidraFunctionEntry> = stmt.query_map(params![module_id], |row| {
        Ok(GhidraFunctionEntry {
            name: row.get(0)?,
            address: row.get(1)?,
            size: row.get(2)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    
    Ok(GhidraFunctionListResult {
        success: true,
        functions,
        error: None,
    })
}

/// Check if a module is analyzed in the database
#[tauri::command]
fn is_module_analyzed_in_db(
    target_os: String,
    module_name: String,
) -> Result<bool, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM analyzed_modules WHERE target_os = ?1 AND module_name = ?2",
        params![target_os, module_name],
        |row| row.get(0),
    ).unwrap_or(0);
    
    Ok(count > 0)
}

/// Get module info from database
#[tauri::command]
fn get_module_info_from_db(
    target_os: String,
    module_name: String,
) -> Result<Option<AnalyzedModuleInfo>, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    let result = conn.query_row(
        "SELECT module_path, local_path, project_path, analyzed_at FROM analyzed_modules WHERE target_os = ?1 AND module_name = ?2",
        params![target_os, module_name],
        |row| {
            Ok(AnalyzedModuleInfo {
                module_path: row.get(0)?,
                local_path: row.get(1)?,
                project_path: row.get(2)?,
                analyzed_at: row.get(3)?,
            })
        },
    );
    
    match result {
        Ok(info) => Ok(Some(info)),
        Err(_) => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnalyzedModuleInfo {
    module_path: String,
    local_path: String,
    project_path: String,
    analyzed_at: i64,
}

/// Simple save functions to SQLite (JSON string version for frontend compatibility)
#[tauri::command]
fn save_ghidra_functions(
    target_os: String,
    module_name: String,
    functions_json: String,
) -> Result<bool, String> {
    let _functions: Vec<GhidraFunctionEntry> = serde_json::from_str(&functions_json)
        .map_err(|e| format!("Failed to parse functions JSON: {}", e))?;
    
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    // Use simple key-value style storage with JSON
    conn.execute(
        "INSERT OR REPLACE INTO ghidra_functions_cache (target_os, module_name, functions_json, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))",
        params![target_os, module_name, functions_json],
    ).map_err(|e| e.to_string())?;
    
    Ok(true)
}

/// Simple get functions from SQLite (JSON string version for frontend compatibility)
#[tauri::command]
fn get_ghidra_functions(
    target_os: String,
    module_name: String,
) -> Result<Option<String>, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    let result: Result<String, _> = conn.query_row(
        "SELECT functions_json FROM ghidra_functions_cache WHERE target_os = ?1 AND module_name = ?2",
        params![target_os, module_name],
        |row| row.get(0),
    );
    
    match result {
        Ok(json) => Ok(Some(json)),
        Err(_) => Ok(None),
    }
}

/// Save decompiled code to SQLite cache
#[tauri::command]
fn save_decompile_cache(
    target_os: String,
    module_name: String,
    function_address: String,
    function_name: String,
    decompiled_code: String,
    line_mapping_json: Option<String>,
) -> Result<bool, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    conn.execute(
        "INSERT OR REPLACE INTO ghidra_decompile_cache 
         (target_os, module_name, function_address, function_name, decompiled_code, line_mapping_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
        params![target_os, module_name, function_address, function_name, decompiled_code, line_mapping_json],
    ).map_err(|e| e.to_string())?;
    
    Ok(true)
}

/// Get decompiled code from SQLite cache
#[tauri::command]
fn get_decompile_cache(
    target_os: String,
    module_name: String,
    function_address: String,
) -> Result<Option<GhidraDecompileResult>, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    let result = conn.query_row(
        "SELECT function_name, decompiled_code, line_mapping_json FROM ghidra_decompile_cache 
         WHERE target_os = ?1 AND module_name = ?2 AND function_address = ?3",
        params![target_os, module_name, function_address],
        |row| {
            let function_name: String = row.get(0)?;
            let decompiled_code: String = row.get(1)?;
            let line_mapping_json: Option<String> = row.get(2)?;
            
            let line_mapping: Option<std::collections::HashMap<String, String>> = line_mapping_json
                .and_then(|json| serde_json::from_str(&json).ok());
            
            Ok(GhidraDecompileResult {
                success: true,
                function_name: if function_name.is_empty() { None } else { Some(function_name) },
                address: Some(function_address.clone()),
                decompiled_code: Some(decompiled_code),
                line_mapping,
                tokens: None,
                error: None,
            })
        },
    );
    
    match result {
        Ok(r) => Ok(Some(r)),
        Err(_) => Ok(None),
    }
}

/// Save xrefs to SQLite cache
#[tauri::command]
fn save_xref_cache(
    target_os: String,
    module_name: String,
    function_address: String,
    function_name: String,
    xrefs_json: String,
) -> Result<bool, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    conn.execute(
        "INSERT OR REPLACE INTO ghidra_xref_cache 
         (target_os, module_name, function_address, function_name, xrefs_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
        params![target_os, module_name, function_address, function_name, xrefs_json],
    ).map_err(|e| e.to_string())?;
    
    Ok(true)
}

/// Get xrefs from SQLite cache
#[tauri::command]
fn get_xref_cache(
    target_os: String,
    module_name: String,
    function_address: String,
) -> Result<Option<GhidraXrefsResult>, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    let result = conn.query_row(
        "SELECT function_name, xrefs_json FROM ghidra_xref_cache 
         WHERE target_os = ?1 AND module_name = ?2 AND function_address = ?3",
        params![target_os, module_name, function_address],
        |row| {
            let function_name: String = row.get(0)?;
            let xrefs_json: String = row.get(1)?;
            
            let xrefs: Vec<XrefEntry> = serde_json::from_str(&xrefs_json).unwrap_or_default();
            
            Ok(GhidraXrefsResult {
                success: true,
                target_function: function_name,
                target_address: function_address.clone(),
                xrefs,
                error: None,
            })
        },
    );
    
    match result {
        Ok(r) => Ok(Some(r)),
        Err(_) => Ok(None),
    }
}

/// Clear all Ghidra cache from SQLite database
#[tauri::command]
fn clear_ghidra_cache() -> Result<bool, String> {
    let db_guard = GHIDRA_DB.lock().map_err(|e| e.to_string())?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;
    
    // Clear all cache tables
    conn.execute("DELETE FROM ghidra_functions_cache", [])
        .map_err(|e| format!("Failed to clear functions cache: {}", e))?;
    
    conn.execute("DELETE FROM ghidra_decompile_cache", [])
        .map_err(|e| format!("Failed to clear decompile cache: {}", e))?;
    
    conn.execute("DELETE FROM ghidra_xref_cache", [])
        .map_err(|e| format!("Failed to clear xref cache: {}", e))?;
    
    conn.execute("DELETE FROM analyzed_modules", [])
        .map_err(|e| format!("Failed to clear analyzed modules: {}", e))?;
    
    conn.execute("DELETE FROM module_functions", [])
        .map_err(|e| format!("Failed to clear module functions: {}", e))?;
    
    // VACUUM to reclaim space
    conn.execute("VACUUM", [])
        .map_err(|e| format!("Failed to vacuum database: {}", e))?;
    
    Ok(true)
}

/// Format C/C++ code using clang-format if available, otherwise use simple Rust formatter
#[allow(dead_code)]
async fn format_cpp_code(code: &str) -> Option<String> {
    // First try clang-format
    if let Some(formatted) = try_clang_format(code).await {
        return Some(formatted);
    }
    
    // Fall back to simple Rust-based formatter
    Some(simple_cpp_format(code))
}

/// Try to format using clang-format binary
#[allow(dead_code)]
async fn try_clang_format(code: &str) -> Option<String> {
    // Try to find clang-format
    let clang_format = if cfg!(windows) {
        // Try common Windows paths
        let paths = vec![
            "clang-format",
            "clang-format.exe",
            "C:\\Program Files\\LLVM\\bin\\clang-format.exe",
            "C:\\Program Files (x86)\\LLVM\\bin\\clang-format.exe",
        ];
        paths.into_iter().find(|p| {
            hide_console_window(&mut Command::new(p))
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }).map(|s| s.to_string())
    } else {
        // Unix - just try clang-format in PATH
        if hide_console_window(&mut Command::new("clang-format"))
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            Some("clang-format".to_string())
        } else {
            None
        }
    };
    
    let clang_format = clang_format?;
    
    // Create a temp file with the code
    let ghidra_dir = get_ghidra_projects_dir();
    let temp_file = ghidra_dir.join("temp_format.c");
    
    if let Err(_) = fs::write(&temp_file, code).await {
        return None;
    }
    
    // Run clang-format
    let output = hide_console_window(&mut Command::new(&clang_format))
        .arg("-style={BasedOnStyle: LLVM, IndentWidth: 2, ColumnLimit: 100}")
        .arg(&temp_file)
        .output()
        .ok()?;
    
    // Clean up temp file
    let _ = fs::remove_file(&temp_file).await;
    
    if output.status.success() {
        String::from_utf8(output.stdout).ok()
    } else {
        None
    }
}

/// Simple C/C++ formatter implemented in pure Rust
/// Handles basic indentation and brace formatting
#[allow(dead_code)]
fn simple_cpp_format(code: &str) -> String {
    let mut result = String::new();
    let mut indent_level: i32 = 0;
    let indent_str = "  "; // 2 spaces
    
    for line in code.lines() {
        let trimmed = line.trim();
        
        // Skip empty lines but preserve them
        if trimmed.is_empty() {
            result.push('\n');
            continue;
        }
        
        // Decrease indent before closing braces
        if trimmed.starts_with('}') || trimmed.starts_with(')') {
            indent_level = (indent_level - 1).max(0);
        }
        
        // Add indentation
        for _ in 0..indent_level {
            result.push_str(indent_str);
        }
        
        // Add the trimmed line
        result.push_str(trimmed);
        result.push('\n');
        
        // Increase indent after opening braces
        if trimmed.ends_with('{') {
            indent_level += 1;
        }
        
        // Handle single-line cases like "} else {"
        if trimmed.contains('{') && !trimmed.ends_with('{') && !trimmed.starts_with("//") {
            // Count braces
            let opens = trimmed.matches('{').count() as i32;
            let closes = trimmed.matches('}').count() as i32;
            indent_level = (indent_level + opens - closes).max(0);
        }
    }
    
    result
}

/// Check if a library has been analyzed with Ghidra
#[tauri::command]
async fn check_ghidra_analysis(library_name: String) -> Result<GhidraAnalysisStatus, String> {
    let clean_name = PathBuf::from(&library_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(library_name.clone());
    
    let ghidra_dir = get_ghidra_projects_dir();
    let project_dir = ghidra_dir.join(&clean_name);
    let gpr_file = project_dir.join(format!("{}.gpr", clean_name));
    
    if gpr_file.exists() {
        Ok(GhidraAnalysisStatus {
            library_path: library_name,
            analyzed: true,
            project_path: Some(project_dir.to_string_lossy().to_string()),
            error: None,
        })
    } else {
        Ok(GhidraAnalysisStatus {
            library_path: library_name,
            analyzed: false,
            project_path: None,
            error: None,
        })
    }
}

/// Check if a path exists on the local filesystem
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Read a local text file from the host OS filesystem
#[tauri::command]
async fn read_local_text_file(file_path: String) -> Result<String, String> {
    use tokio::fs::read_to_string;
    
    read_to_string(&file_path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", file_path, e))
}

/// Open a folder selection dialog and return the selected path
#[tauri::command]
async fn select_folder_dialog(title: String) -> Result<Option<String>, String> {
    use rfd::AsyncFileDialog;
    
    let dialog = AsyncFileDialog::new()
        .set_title(&title);
    
    let folder = dialog.pick_folder().await;
    
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state::AppStateType::new(std::sync::Mutex::new(state::AppState::default())))
        .manage(state::DebuggerSidebarCacheType::new(std::sync::Mutex::new(state::DebuggerSidebarCache::default())))
        .invoke_handler(tauri::generate_handler![
            greet,
            set_server_connection,
            set_auth_token,
            read_memory,
            filter_memory_native,
            lookup_memory_native,
            unknown_scan_native,
            init_unknown_scan_progress,
            get_unknown_scan_progress,
            load_unknown_scan_results,
            clear_unknown_scan,
            init_unknown_scan_file,
            append_unknown_scan_chunk,
            finalize_unknown_scan_file,
            get_unknown_scan_file_info,
            disassemble_memory,
            disassemble_memory_direct,
            demangle_symbols,
            state::get_app_state,
            state::update_app_state,
            state::update_single_state,
            state::get_connection_state,
            state::get_debug_state,
            state::add_exceptions,
            state::get_exceptions,
            state::get_watchpoint_exceptions,
            state::clear_exceptions,
            state::clear_watchpoint_exceptions,
            // Trace session commands
            state::start_trace_session,
            state::add_trace_entry,
            state::add_trace_entries_batch,
            state::get_trace_entries,
            state::get_trace_session,
            state::stop_trace_session,
            state::set_trace_tracked_thread,
            state::clear_trace_entries,
            // Graph view commands
            state::store_graph_view_data,
            state::get_graph_view_data,
            state::clear_graph_view_data,
            // Trace file commands
            state::open_trace_file_dialog,
            state::read_trace_file,
            // DebuggerSidebar cache commands
            state::get_sidebar_cache,
            state::set_sidebar_modules,
            state::set_sidebar_symbols,
            state::set_sidebar_ghidra_functions,
            state::set_sidebar_ghidra_data,
            state::clear_sidebar_cache,
            // Ghidra integration commands
            download_library_file,
            download_server_file,
            upload_file_to_server,
            analyze_with_ghidra,
            ghidra_decompile,
            ghidra_get_xrefs,
            ghidra_get_functions,
            check_ghidra_analysis,
            path_exists,
            // Ghidra SQLite database commands
            save_ghidra_functions_to_db,
            get_ghidra_functions_from_db,
            is_module_analyzed_in_db,
            get_module_info_from_db,
            save_ghidra_functions,
            get_ghidra_functions,
            save_decompile_cache,
            get_decompile_cache,
            save_xref_cache,
            get_xref_cache,
            clear_ghidra_cache,
            // Ghidra server mode commands
            start_ghidra_server,
            stop_ghidra_server,
            check_ghidra_server,
            get_ghidra_server_logs,
            ghidra_server_decompile,
            ghidra_server_xrefs,
            ghidra_server_function_info,
            ghidra_server_cfg,
            ghidra_server_data,
            ghidra_analyze_reachability,
            read_local_text_file,
            select_folder_dialog,
            // WASM analysis commands
            save_wasm_binary,
            list_wasm_files,
            analyze_wasm_binary,
            disassemble_wasm_function,
            open_wasm_modules_directory
        ])
        .setup(|app| {
            if let Err(e) = init_ghidra_db() {
                eprintln!("Failed to initialize Ghidra database: {e}");
            }
            
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(monitor_opt) = window.current_monitor() {
                    if let Some(monitor) = monitor_opt {
                        let screen = monitor.size();
                        let mut target_w: u32 = 1400;
                        let mut target_h: u32 = 1000;
                        let margin_w: u32 = 40;
                        let margin_h: u32 = 80;

                        if screen.width < target_w + margin_w {
                            target_w = (screen.width.saturating_sub(margin_w)).max(1024);
                        }
                        if screen.height < target_h + margin_h {
                            target_h = (screen.height.saturating_sub(margin_h)).max(680);
                        }

                        if let Err(e) = window.set_size(Size::Physical(PhysicalSize { width: target_w, height: target_h })) {
                            eprintln!("Failed to set dynamic window size: {e}");
                        } else {
                            let _ = window.center();
                        }
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
