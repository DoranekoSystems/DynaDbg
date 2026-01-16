#![allow(dead_code)]
#[allow(non_snake_case)]

use bytes::Bytes;
use byteorder::{ByteOrder, LittleEndian};
use chrono;
use hex;
use lazy_static::lazy_static;
use libc::{self, c_char, c_int, c_void};
use lz4_flex::block::compress_prepend_size;

use memchr::memmem;
use percent_encoding::percent_decode_str;
use rayon::prelude::*;
use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;

use log::{debug, error, info, trace, warn};

use std::collections::VecDeque;
use std::env;
use std::ffi::CStr;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::io::Write;
use std::io::{BufReader, BufWriter};
use std::mem::size_of;
use std::panic;
use std::path::{Path, PathBuf};
use std::process;
use std::slice;
use std::str;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::RwLock;
use std::sync::{Arc, Mutex};
use warp::hyper::Body;
use warp::{http::Response, http::StatusCode, Filter, Rejection, Reply};

use crate::native_bridge::{self, ExceptionType};
use crate::request;
use crate::util;
use crate::wasm_bridge;

// Unified API response structures
#[derive(Serialize)]
struct ApiResponse<T> {
    success: bool,
    data: Option<T>,
    message: Option<String>,
}

impl<T> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            message: None,
        }
    }
    
    fn success_with_message(data: T, message: String) -> Self {
        Self {
            success: true,
            data: Some(data),
            message: Some(message),
        }
    }
    
    fn error(message: String) -> Self {
        Self {
            success: false,
            data: None,
            message: Some(message),
        }
    }
}

#[derive(Serialize)]
struct SimpleResponse {
    success: bool,
    message: String,
}

impl SimpleResponse {
    fn success(message: String) -> Self {
        Self {
            success: true,
            message,
        }
    }
    
    fn error(message: String) -> Self {
        Self {
            success: false,
            message,
        }
    }
}

lazy_static! {
    static ref GLOBAL_POSITIONS: RwLock<HashMap<String, Vec<(usize, String)>>> =
        RwLock::new(HashMap::new());
    static ref GLOBAL_MEMORY: RwLock<HashMap<String, Vec<(usize, Vec<u8>, usize, Vec<u8>, usize, bool)>>> =
        RwLock::new(HashMap::new());
    static ref GLOBAL_SCAN_OPTION: RwLock<HashMap<String, request::MemoryScanRequest>> =
        RwLock::new(HashMap::new());
    static ref GLOBAL_SCAN_PROGRESS: RwLock<HashMap<String, request::ScanProgressResponse>> =
        RwLock::new(HashMap::new());
    static ref GLOBAL_FILTER_PROGRESS: RwLock<HashMap<String, request::FilterProgressResponse>> =
        RwLock::new(HashMap::new());
    static ref JSON_QUEUE: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    static ref GLOBAL_PROCESS_STATE: RwLock<bool> = RwLock::new(false);
    static ref SCAN_STOP_FLAGS: RwLock<HashMap<String, Arc<Mutex<bool>>>> = RwLock::new(HashMap::new());
}

/// Push a message to the JSON queue for UI consumption
pub fn push_to_json_queue(message: String) {
    let mut queue = JSON_QUEUE.lock().unwrap();
    queue.push_back(message);
}

#[no_mangle]
pub extern "C" fn native_log(level: c_int, message: *const c_char) {
    let log_message = unsafe { CStr::from_ptr(message).to_string_lossy().into_owned() };

    match level {
        1 => error!("{}", log_message),  // LOG_ERROR = 1
        2 => warn!("{}", log_message),   // LOG_WARN = 2
        3 => info!("{}", log_message),   // LOG_INFO = 3
        4 => debug!("{}", log_message),  // LOG_DEBUG = 4
        5 => trace!("{}", log_message),  // LOG_TRACE = 5
        _ => info!("{}", log_message),   // default
    }
}

#[derive(Serialize)]
struct ExceptionInfo {
    exception_type: String,
    thread_id: u64,
    memory_address: Option<u64>,
    singlestep_mode: Option<u64>,
    is_trace: bool,
    registers: Value,
    instruction: Option<String>,
    timestamp: String,
}

// Architecture constants
pub const ARCH_UNKNOWN: u64 = 0;
pub const ARCH_ARM64: u64 = 1;
pub const ARCH_X86_64: u64 = 2;

// ARM64 registers structure
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Arm64Registers {
    pub x: [u64; 30],
    pub lr: u64,
    pub sp: u64,
    pub pc: u64,
    pub cpsr: u64,
    pub fp: u64,
}

// x86_64 registers structure
#[repr(C)]
#[derive(Clone, Copy)]
pub struct X86_64Registers {
    pub rax: u64,
    pub rbx: u64,
    pub rcx: u64,
    pub rdx: u64,
    pub rsi: u64,
    pub rdi: u64,
    pub rbp: u64,
    pub rsp: u64,
    pub r8: u64,
    pub r9: u64,
    pub r10: u64,
    pub r11: u64,
    pub r12: u64,
    pub r13: u64,
    pub r14: u64,
    pub r15: u64,
    pub rip: u64,
    pub rflags: u64,
    pub cs: u64,
    pub ss: u64,
    pub ds: u64,
    pub es: u64,
    pub fs: u64,
    pub gs: u64,
    pub fs_base: u64,
    pub gs_base: u64,
}

// Union for architecture-specific registers
#[repr(C)]
#[derive(Clone, Copy)]
pub union RegistersUnion {
    pub arm64: Arm64Registers,
    pub x86_64: X86_64Registers,
}

// Architecture-independent exception info structure
// Must match C++ NativeExceptionInfo in exception_info.h
#[repr(C)]
pub struct NativeExceptionInfo {
    pub architecture: u64,
    pub regs: RegistersUnion,
    pub exception_type: u64,
    pub thread_id: u64,
    pub memory_address: u64,
    pub singlestep_mode: u64,
    pub is_trace: u64,
}

#[no_mangle]
pub extern "C" fn send_exception_info(info_ptr: *const NativeExceptionInfo, pid: i32) -> bool {
    if info_ptr.is_null() {
        error!("Received null pointer for exception info");
        return false;
    }

    let info = unsafe { &*info_ptr };

    // Convert exception type
    let exception_type = match info.exception_type {
        1 => ExceptionType::Breakpoint,
        2 => ExceptionType::Watchpoint,
        3 => ExceptionType::SingleStep,
        4 => ExceptionType::Signal,
        5 => ExceptionType::Sigsegv,
        6 => ExceptionType::Sigbus,
        7 => ExceptionType::Sigfpe,
        8 => ExceptionType::Sigill,
        9 => ExceptionType::Sigabrt,
        10 => ExceptionType::Sigtrap,
        _ => ExceptionType::Unknown,
    };

    let exception_type_str = exception_type.to_str();
    let thread_id = info.thread_id;
    
    // Extract single step mode
    let singlestep_mode = if info.exception_type == 3 {
        Some(info.singlestep_mode)
    } else {
        None
    };
    
    // Extract memory address for watchpoint and signal exceptions
    let memory_address = if info.exception_type == 2 || info.exception_type >= 4 {
        Some(info.memory_address)
    } else {
        None
    };

    // Build registers map - architecture specific
    let mut registers_map = serde_json::Map::new();
    
    // Determine PC address based on architecture field from C++
    let pc_address = if info.architecture == ARCH_ARM64 {
        let arm64 = unsafe { info.regs.arm64 };
        for (i, val) in arm64.x.iter().enumerate() {
            registers_map.insert(format!("x{}", i), json!(val));
        }
        registers_map.insert("lr".to_string(), json!(arm64.lr));
        registers_map.insert("fp".to_string(), json!(arm64.fp));
        registers_map.insert("sp".to_string(), json!(arm64.sp));
        registers_map.insert("pc".to_string(), json!(arm64.pc));
        registers_map.insert("cpsr".to_string(), json!(arm64.cpsr));
        arm64.pc
    } else if info.architecture == ARCH_X86_64 {
        let x86_64 = unsafe { info.regs.x86_64 };
        registers_map.insert("rax".to_string(), json!(x86_64.rax));
        registers_map.insert("rbx".to_string(), json!(x86_64.rbx));
        registers_map.insert("rcx".to_string(), json!(x86_64.rcx));
        registers_map.insert("rdx".to_string(), json!(x86_64.rdx));
        registers_map.insert("rsi".to_string(), json!(x86_64.rsi));
        registers_map.insert("rdi".to_string(), json!(x86_64.rdi));
        registers_map.insert("rbp".to_string(), json!(x86_64.rbp));
        registers_map.insert("rsp".to_string(), json!(x86_64.rsp));
        registers_map.insert("r8".to_string(), json!(x86_64.r8));
        registers_map.insert("r9".to_string(), json!(x86_64.r9));
        registers_map.insert("r10".to_string(), json!(x86_64.r10));
        registers_map.insert("r11".to_string(), json!(x86_64.r11));
        registers_map.insert("r12".to_string(), json!(x86_64.r12));
        registers_map.insert("r13".to_string(), json!(x86_64.r13));
        registers_map.insert("r14".to_string(), json!(x86_64.r14));
        registers_map.insert("r15".to_string(), json!(x86_64.r15));
        registers_map.insert("rip".to_string(), json!(x86_64.rip));
        // Add 'pc' alias for x86_64 to ensure frontend compatibility
        registers_map.insert("pc".to_string(), json!(x86_64.rip));
        registers_map.insert("rflags".to_string(), json!(x86_64.rflags));
        registers_map.insert("cs".to_string(), json!(x86_64.cs));
        registers_map.insert("ss".to_string(), json!(x86_64.ss));
        registers_map.insert("ds".to_string(), json!(x86_64.ds));
        registers_map.insert("es".to_string(), json!(x86_64.es));
        registers_map.insert("fs".to_string(), json!(x86_64.fs));
        registers_map.insert("gs".to_string(), json!(x86_64.gs));
        x86_64.rip
    } else {
        error!("Unknown architecture: {}", info.architecture);
        return false;
    };
    
    // Create pure registers value for ExceptionInfo
    let registers_value = Value::Object(registers_map.clone());


    // Determine buffer size based on architecture
    // For x86_64 watchpoints, we need to look backwards to find the instruction that caused the access
    let instruction = {
        let is_x86_64_watchpoint = info.architecture == ARCH_X86_64 && info.exception_type == 2;
        
        if is_x86_64_watchpoint {
            // x86_64 watchpoint: RIP points to the NEXT instruction after the one that triggered
            // We need to scan backwards to find the instruction that ends at RIP
            let scan_size: u64 = 16; // x86_64 max instruction length is 15 bytes
            let scan_start = pc_address.saturating_sub(scan_size);
            let mut buffer = vec![0u8; (pc_address - scan_start) as usize + 15];
            
            match native_bridge::read_process_memory_with_method(
                pid,
                scan_start as *mut libc::c_void,
                buffer.len(),
                &mut buffer,
                1,
            ) {
                Ok(_) => {
                    // Find the instruction that ends at pc_address
                    // Try disassembling from different offsets to find one that ends at RIP
                    // Scan from furthest back (longest possible instruction) to avoid matching suffixes like "00 00"
                    let mut found_instruction: Option<String> = None;
                    
                    for offset in 0..scan_size as usize {
                        let try_addr = scan_start + offset as u64;
                        let sub_buffer = &buffer[offset..];
                        
                        let disasm = util::disassemble_internal(
                            sub_buffer.as_ptr(),
                            sub_buffer.len().min(15),
                            try_addr,
                            "x86_64"
                        );
                        
                        // Parse the disassembly to get instruction length
                        // Format: "0xADDRESS|BYTECODE|OPCODE"
                        if let Some(first_line) = disasm.lines().next() {
                            let parts: Vec<&str> = first_line.split('|').collect();
                            if parts.len() >= 2 {
                                let bytecode = parts[1].trim();
                                // Count bytes (each byte is 2 hex chars)
                                let byte_count = bytecode.replace(" ", "").len() / 2;
                                let instr_end = try_addr + byte_count as u64;
                                
                                if instr_end == pc_address {
                                    // Found the instruction that ends at RIP
                                    // Since we scan from furthest back, this is the longest instruction ending at RIP
                                    found_instruction = Some(disasm);
                                    break;
                                }
                            }
                        }
                    }
                    
                    found_instruction.or_else(|| {
                        // Fallback: just show the instruction at RIP (next instruction)
                        Some(util::disassemble_internal(
                            buffer[(pc_address - scan_start) as usize..].as_ptr(),
                            15,
                            pc_address,
                            "x86_64"
                        ))
                    })
                }
                Err(e) => {
                    warn!("Failed to read memory for disassembly: {}", e);
                    None
                }
            }
        } else {
            // Normal case: disassemble at PC
            let buffer_size = if info.architecture == ARCH_ARM64 { 4 } else { 15 };
            let mut buffer = vec![0u8; buffer_size];
            
            match native_bridge::read_process_memory_with_method(
                pid,
                pc_address as *mut libc::c_void,
                buffer.len(),
                &mut buffer,
                1,
            ) {
                Ok(_) => {
                    let arch = if info.architecture == ARCH_ARM64 {
                        "arm64"
                    } else {
                        "x86_64"
                    };
                    Some(util::disassemble_internal(buffer.as_ptr(), buffer.len(), pc_address, arch))
                }
                Err(e) => {
                    warn!("Failed to read memory for disassembly: {}", e);
                    None
                }
            }
        }
    };

    // Create structured exception info with pure registers
    let exception_info = ExceptionInfo {
        exception_type: exception_type_str.to_string(),
        thread_id,
        memory_address,
        singlestep_mode,
        is_trace: info.is_trace != 0,
        registers: registers_value,
        instruction: instruction.clone(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    // Add extra fields to registers map for backward compatibility (flat structure)
    registers_map.insert("exception_type".to_string(), json!(info.exception_type));
    registers_map.insert("thread_id".to_string(), json!(info.thread_id));
    registers_map.insert("is_trace".to_string(), json!(info.is_trace != 0));
    
    // Add address field as hex string for frontend compatibility
    // This is the PC address where the exception occurred
    registers_map.insert("address".to_string(), json!(format!("0x{:016x}", pc_address)));
    
    if let Some(addr) = memory_address {
         registers_map.insert("memory".to_string(), json!(addr));
         // For watchpoints, also add memory_address as number for frontend filtering
         registers_map.insert("memory_address".to_string(), json!(addr));
    }
    if let Some(mode) = singlestep_mode {
         registers_map.insert("singlestep_mode".to_string(), json!(mode));
    }
    if let Some(ref instr) = instruction {
        registers_map.insert("instruction".to_string(), json!(instr));
    }
    
    // Add breakpoint address explicitly for UI to recognize BP hits
    if info.exception_type == 1 {
        registers_map.insert("breakpoint_address".to_string(), json!(pc_address));
    }
    
    // Add structured info
    registers_map.insert("exception_info".to_string(), serde_json::to_value(&exception_info).unwrap_or(Value::Null));

    // Always notify UI for all exceptions (lua_engine removed)
    let should_notify = true;

    if should_notify {
        let mut queue = JSON_QUEUE.lock().unwrap();
        queue.push_back(Value::Object(registers_map.clone()).to_string());
        drop(queue);
    }
    
    // Return whether to notify UI (true = break, false = silent continue)
    should_notify
}

/// Void version of send_exception_info for DLL callback (C++ expects void)
#[no_mangle]
pub unsafe extern "C" fn send_exception_info_void(info_ptr: *const NativeExceptionInfo, pid: i32) {
    let _ = send_exception_info(info_ptr, pid);
}

pub fn with_state(
    state: Arc<Mutex<Option<i32>>>,
) -> impl Filter<Extract = (Arc<Mutex<Option<i32>>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || state.clone())
}

// Auth middleware - simplified (no authentication required)
pub fn with_auth() -> impl Filter<Extract = (), Error = std::convert::Infallible> + Clone {
    warp::any()
}

pub async fn handle_auth_rejection(err: warp::Rejection) -> Result<warp::reply::Json, warp::Rejection> {
    Err(err)
}

pub async fn verify_client_handler(
    _verification_request: request::ClientVerificationRequest,
) -> Result<impl Reply, Rejection> {
    // Authentication disabled - always succeed
    let response = request::ClientVerificationResponse {
        success: true,
        message: "Client verification skipped (auth disabled)".to_string(),
        server_info: None,
        access_token: None,
    };
    Ok(warp::reply::json(&response))
}

const MAX_RESULTS: usize = 100_000;

pub async fn get_exception_info_handler(
    exception_type_filter: Option<String>,
    singlestep_mode_filter: Option<String>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut queue = JSON_QUEUE.lock().unwrap();

    // Parse all exceptions from queue and separate into matched and unmatched
    let all_exceptions: Vec<Value> = queue
        .drain(..)
        .filter_map(|json_str| serde_json::from_str(&json_str).ok())
        .collect();
    
    let mut matched_exceptions = Vec::new();
    let mut unmatched_exceptions = Vec::new();

    // If no filters are specified, return all exceptions
    if exception_type_filter.is_none() && singlestep_mode_filter.is_none() {
        // Return in the expected API response format
        let response = ApiResponse::success(json!({
            "exceptions": all_exceptions
        }));
        return Ok(warp::reply::json(&response));
    }

    // Process each exception and check against filters
    for (idx, exception) in all_exceptions.into_iter().enumerate() {
        let mut matches_filters = true;

        // Check if this is a special event type that always passes filters
        // (script_breakpoint, script_output events from Lua scripts)
        let event_type = exception.get("event_type").and_then(|v| v.as_str());
        let is_script_event = matches!(event_type, Some("script_breakpoint") | Some("script_output"));
        
        if is_script_event {
            // Script events always pass through filters
            debug!("[Exception {}] Script event type {:?}, bypassing filters", idx, event_type);
            matched_exceptions.push(exception);
            continue;
        }

        // Debug log for each exception being processed
        debug!("[Exception {}] Processing: type_from_info={:?}, type_from_top={:?}, singlestep_mode_top={:?}, singlestep_mode_info={:?}, singlestep_mode_regs={:?}", 
            idx,
            exception.get("exception_info").and_then(|info| info.get("exception_type")),
            exception.get("exception_type"),
            exception.get("singlestep_mode"),
            exception.get("exception_info").and_then(|info| info.get("singlestep_mode")),
            exception.get("registers").and_then(|regs| regs.get("singlestep_mode"))
        );

        // Apply exception type filter if specified
        if let Some(ref filter_type) = exception_type_filter {
            let filter_types: Vec<String> = filter_type
                .split(',')
                .map(|s| s.trim().to_lowercase())
                .collect();

            let type_matches = {
                // First try to get from exception_info
                let from_exception_info = exception.get("exception_info")
                    .and_then(|info| info.get("exception_type"))
                    .and_then(|exc_type| exc_type.as_str())
                    .map(|exc_type_str| {
                        let exc_type_lower = exc_type_str.to_lowercase();
                        filter_types.iter().any(|filter| {
                            match filter.as_str() {
                                "breakpoint" => exc_type_lower == "breakpoint",
                                "watchpoint" => exc_type_lower == "watchpoint",
                                "single_step" => exc_type_lower == "single_step" || exc_type_lower == "singlestep",
                                "signal" => exc_type_lower == "signal",
                                "sigsegv" => exc_type_lower == "sigsegv",
                                "sigbus" => exc_type_lower == "sigbus",
                                "sigfpe" => exc_type_lower == "sigfpe",
                                "sigill" => exc_type_lower == "sigill",
                                "sigabrt" => exc_type_lower == "sigabrt",
                                "sigtrap" => exc_type_lower == "sigtrap",
                                _ => false,
                            }
                        })
                    });

                // If not found in exception_info, try from top-level exception_type (enum value)
                let from_top_level = exception.get("exception_type")
                    .and_then(|exc_type| exc_type.as_u64())
                    .map(|type_value| {
                        filter_types.iter().any(|filter| {
                            match filter.as_str() {
                                "breakpoint" => type_value == 1,  // ExceptionType::Breakpoint
                                "watchpoint" => type_value == 2,  // ExceptionType::Watchpoint
                                "single_step" => type_value == 3, // ExceptionType::SingleStep
                                "signal" => type_value == 4,      // ExceptionType::Signal
                                "sigsegv" => type_value == 5,     // ExceptionType::Sigsegv
                                "sigbus" => type_value == 6,      // ExceptionType::Sigbus
                                "sigfpe" => type_value == 7,      // ExceptionType::Sigfpe
                                "sigill" => type_value == 8,      // ExceptionType::Sigill
                                "sigabrt" => type_value == 9,     // ExceptionType::Sigabrt
                                "sigtrap" => type_value == 10,    // ExceptionType::Sigtrap
                                _ => false,
                            }
                        })
                    });

                // Return true if either source matches
                from_exception_info.unwrap_or(false) || from_top_level.unwrap_or(false)
            };

            if !type_matches {
                matches_filters = false;
            }
        }

        // Apply singlestep_mode filter if specified AND only for single_step exceptions
        if matches_filters {
            if let Some(ref singlestep_mode) = singlestep_mode_filter {
                // Check if this is a single_step exception before applying singlestep_mode filter
                let is_single_step_exception = {
                    // Check from exception_info first
                    let from_exception_info = exception.get("exception_info")
                        .and_then(|info| info.get("exception_type"))
                        .and_then(|exc_type| exc_type.as_str())
                        .map(|exc_type_str| {
                            let exc_type_lower = exc_type_str.to_lowercase();
                            exc_type_lower == "single_step" || exc_type_lower == "singlestep"
                        });

                    // Check from top-level exception_type (enum value)
                    let from_top_level = exception.get("exception_type")
                        .and_then(|exc_type| exc_type.as_u64())
                        .map(|type_value| type_value == 3); // ExceptionType::SingleStep

                    from_exception_info.unwrap_or(false) || from_top_level.unwrap_or(false)
                };

                // Only apply singlestep_mode filter for single_step exceptions
                // For breakpoint/watchpoint, the singlestep_mode filter is ignored and they pass through
                if is_single_step_exception {
                    let filter_modes: Vec<u64> = singlestep_mode
                        .split(',')
                        .filter_map(|s| {
                            let trimmed = s.trim();
                            // Support both decimal and hexadecimal formats
                            if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
                                u64::from_str_radix(&trimmed[2..], 16).ok()
                            } else {
                                trimmed.parse::<u64>().ok()
                            }
                        })
                        .collect();

                    if !filter_modes.is_empty() {
                        // Try to get singlestep_mode from multiple sources
                        let singlestep_mode_value = exception.get("singlestep_mode")
                            .and_then(|v| {
                                // Handle both u64 and string values
                                v.as_u64().or_else(|| {
                                    v.as_str().and_then(|s| {
                                        let trimmed = s.trim();
                                        if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
                                            u64::from_str_radix(&trimmed[2..], 16).ok()
                                        } else {
                                            trimmed.parse::<u64>().ok()
                                        }
                                    })
                                })
                            })
                            .or_else(|| {
                                // Try from exception_info
                                exception.get("exception_info")
                                    .and_then(|info| info.get("singlestep_mode"))
                                    .and_then(|v| {
                                        v.as_u64().or_else(|| {
                                            v.as_str().and_then(|s| {
                                                let trimmed = s.trim();
                                                if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
                                                    u64::from_str_radix(&trimmed[2..], 16).ok()
                                                } else {
                                                    trimmed.parse::<u64>().ok()
                                                }
                                            })
                                        })
                                    })
                            })
                            .or_else(|| {
                                // Try from registers.singlestep_mode
                                exception.get("registers")
                                    .and_then(|regs| regs.get("singlestep_mode"))
                                    .and_then(|v| {
                                        v.as_u64().or_else(|| {
                                            v.as_str().and_then(|s| {
                                                let trimmed = s.trim();
                                                if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
                                                    u64::from_str_radix(&trimmed[2..], 16).ok()
                                                } else {
                                                    trimmed.parse::<u64>().ok()
                                                }
                                            })
                                        })
                                    })
                            });

                        let mode_matches = if let Some(mode_value) = singlestep_mode_value {
                            let matches = filter_modes.contains(&mode_value);
                            debug!("Singlestep mode filter applied to single_step exception: value={}, filter_modes={:?}, matches={}", 
                                   mode_value, filter_modes, matches);
                            matches
                        } else {
                            debug!("No singlestep_mode value found in single_step exception");
                            false
                        };

                        if !mode_matches {
                            matches_filters = false;
                        }
                    }
                } else {
                    // For non-single_step exceptions (breakpoint, watchpoint), 
                    // singlestep_mode filter is ignored - they continue to match
                    debug!("[Exception {}] Non-single_step exception, singlestep_mode filter ignored", idx);
                }
            }
        }

        // Separate matched and unmatched exceptions
        if matches_filters {
            matched_exceptions.push(exception);
        } else {
            unmatched_exceptions.push(exception);
        }
    }

    debug!("Filter results: {} matched, {} unmatched", 
           matched_exceptions.len(), unmatched_exceptions.len());

    // Put unmatched exceptions back into the queue
    for exception in unmatched_exceptions {
        queue.push_back(exception.to_string());
    }

    debug!("Returning {} matched exceptions", matched_exceptions.len());

    // Return only the matched exceptions in the expected API response format
    let response = ApiResponse::success(json!({
        "exceptions": matched_exceptions
    }));

    Ok(warp::reply::json(&response))
}

#[derive(Serialize)]
struct ServerInfo {
    git_hash: String,
    target_os: String,
    arch: String,
    pid: u32,
    mode: String,
}

pub async fn server_info_handler() -> Result<impl warp::Reply, warp::Rejection> {
    let git_hash = env!("GIT_HASH");
    let target_os = env!("TARGET_OS");

    // In WASM mode, report wasm32 as the architecture
    let arch = if wasm_bridge::is_wasm_mode() {
        "wasm32"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "arm") {
        "arm"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "unknown"
    };

    let pid = process::id();

    let server_info = ServerInfo {
        git_hash: git_hash.to_string(),
        target_os: target_os.to_string(),
        arch: arch.to_string(),
        pid: pid,
        mode: std::env::var("DBGSRV_RUNNING_MODE").unwrap_or_else(|_| "unknown".to_string()),
    };

    Ok(warp::reply::json(&server_info))
}

pub async fn open_process_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    open_process: request::OpenProcessRequest,
) -> Result<Box<dyn warp::Reply>, warp::Rejection> {
    // Set the pid first with the lock, then release it before any async operations
    let wasm_mode_active;
    let attached_pid;
    {
        match pid_state.lock() {
            Ok(mut pid) => {
                *pid = Some(open_process.pid);
                attached_pid = open_process.pid;
                wasm_mode_active = wasm_bridge::is_wasm_mode();
            }
            Err(_) => {
                let response = SimpleResponse::error("Failed to acquire process state lock".to_string());
                return Ok(Box::new(warp::reply::with_status(
                    warp::reply::json(&response),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )));
            }
        }
    } // Lock is released here
    
    // In WASM mode, we don't need signature scan - just use WebSocket for memory access
    if wasm_mode_active {
        log::info!("WASM mode: Process attached (PID {} is virtual, using WebSocket bridge)", attached_pid);
        
        // No signature scan needed - memory access goes through WebSocket
        // Initial snapshot can be taken later via explicit API call if needed
        
        let response = SimpleResponse::success(
            "WASM process attached successfully via WebSocket bridge".to_string()
        );
        return Ok(Box::new(warp::reply::json(&response)));
    }
    
    let response = SimpleResponse::success("Process attached successfully".to_string());
    Ok(Box::new(warp::reply::json(&response)))
}

/// Scan process memory to find the WASM signature
fn scan_for_wasm_signature(pid: i32, signature: &[u8]) -> Result<usize, String> {
    if signature.len() != 64 {
        return Err(format!("Invalid signature length: {} (expected 64)", signature.len()));
    }
    
    // Get memory regions
    let mut count: usize = 0;
    let region_info_ptr = unsafe { 
        native_bridge::enumerate_regions(pid, &mut count, false) 
    };
    
    if region_info_ptr.is_null() || count == 0 {
        return Err("Failed to enumerate memory regions".to_string());
    }
    
    let regions = unsafe { std::slice::from_raw_parts(region_info_ptr, count) };
    let mut found_address: Option<usize> = None;
    
    // Scan each readable region
    for region in regions {
        // Check if region is readable (protection & 1 = read)
        if region.protection & 1 == 0 {
            continue;
        }
        
        let region_size = region.end - region.start;
        
        // Skip very large regions to avoid excessive memory usage
        // WASM heap is typically a few MB to a few hundred MB
        if region_size > 1024 * 1024 * 1024 {
            continue;
        }
        
        // Skip very small regions
        if region_size < 64 {
            continue;
        }
        
        // Read region memory
        let mut buffer = vec![0u8; region_size];
        let result = unsafe {
            native_bridge::read_memory_native(
                pid,
                region.start as libc::uintptr_t,
                region_size,
                buffer.as_mut_ptr(),
            )
        };
        
        if result < 0 {
            continue;
        }
        
        // Search for signature in buffer
        if let Some(offset) = find_signature_in_buffer(&buffer, signature) {
            found_address = Some(region.start + offset);
            log::info!(
                "Found WASM signature at 0x{:x} (region 0x{:x}-0x{:x}, offset 0x{:x})",
                region.start + offset, region.start, region.end, offset
            );
            break;
        }
    }
    
    // Free region info
    unsafe { native_bridge::free_region_info(region_info_ptr, count) };
    
    found_address.ok_or_else(|| "WASM signature not found in process memory".to_string())
}

/// Find signature bytes in a buffer
fn find_signature_in_buffer(buffer: &[u8], signature: &[u8]) -> Option<usize> {
    if buffer.len() < signature.len() {
        return None;
    }
    
    // Use memchr for efficient searching
    let first_byte = signature[0];
    let mut search_start = 0;
    
    while search_start + signature.len() <= buffer.len() {
        // Find next occurrence of first byte
        if let Some(pos) = memchr::memchr(first_byte, &buffer[search_start..]) {
            let abs_pos = search_start + pos;
            if abs_pos + signature.len() <= buffer.len() {
                // Check if full signature matches
                if &buffer[abs_pos..abs_pos + signature.len()] == signature {
                    return Some(abs_pos);
                }
            }
            search_start = abs_pos + 1;
        } else {
            break;
        }
    }
    
    None
}

pub async fn resolve_addr_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    resolve_addr: request::ResolveAddrRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    match pid_state.lock() {
        Ok(pid) => {
            if let Some(pid) = *pid {
                match native_bridge::enum_modules(pid) {
                    Ok(modules) => {
                        match util::resolve_symbolic_address(pid, &resolve_addr.query, &modules) {
                            Ok(resolved_address) => {
                                let response = ApiResponse::success(json!({ "address": resolved_address }));
                                Ok(warp::reply::json(&response))
                            }
                            Err(e) => {
                                let response = ApiResponse::<Value>::error(format!("Failed to resolve address: {}", e));
                                Ok(warp::reply::json(&response))
                            }
                        }
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to enumerate modules: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            } else {
                let response = ApiResponse::<Value>::error("Process not attached".to_string());
                Ok(warp::reply::json(&response))
            }
        }
        Err(_) => {
            let response = ApiResponse::<Value>::error("Failed to acquire process state lock".to_string());
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn read_memory_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    read_memory: request::ReadMemoryRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    // In WASM mode, all memory access goes through WebSocket bridge
    if wasm_bridge::is_wasm_mode() {
        // Use async read for all WASM memory (heap, code region, or snapshot)
        match wasm_bridge::read_wasm_memory_async(read_memory.address, read_memory.size).await {
            Ok(buffer) => {
                let response = Response::builder()
                    .header("Content-Type", "application/octet-stream")
                    .body(hyper::Body::from(buffer))
                    .unwrap();
                return Ok(response);
            }
            Err(e) => {
                log::error!("WASM read_memory failed: {}", e);
                let empty_buffer = Vec::new();
                let response = Response::builder()
                    .header("Content-Type", "application/octet-stream")
                    .body(hyper::Body::from(empty_buffer))
                    .unwrap();
                return Ok(response);
            }
        }
    }

    match pid_state.lock() {
        Ok(pid) => {
            if let Some(pid) = *pid {
                let mut buffer: Vec<u8> = vec![0; read_memory.size];
                let nread = if read_memory.use_ptrace {
                    native_bridge::read_process_memory_with_method(
                        pid,
                        read_memory.address as *mut libc::c_void,
                        read_memory.size,
                        &mut buffer,
                        1, // mode 1 = /proc/pid/mem
                    )
                } else {
                    native_bridge::read_process_memory(
                        pid,
                        read_memory.address as *mut libc::c_void,
                        read_memory.size,
                        &mut buffer,
                    )
                };
                match nread {
                    Ok(_) => {
                        let response = Response::builder()
                            .header("Content-Type", "application/octet-stream")
                            .body(hyper::Body::from(buffer))
                            .unwrap();
                        return Ok(response);
                    }
                    Err(_) => {
                        let empty_buffer = Vec::new();
                        let response = Response::builder()
                            .header("Content-Type", "application/octet-stream")
                            .body(hyper::Body::from(empty_buffer))
                            .unwrap();
                        return Ok(response);
                    }
                }
            } else {
                let response = Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(hyper::Body::from("Process not attached"))
                    .unwrap();
                Ok(response)
            }
        }
        Err(_) => {
            let response = Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(hyper::Body::from("Failed to acquire process state lock"))
                .unwrap();
            Ok(response)
        }
    }
}

pub async fn read_memory_multiple_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    read_memory_requests: Vec<request::ReadMemoryRequest>,
) -> Result<impl warp::Reply, warp::Rejection> {
    // In WASM mode, use async WebSocket bridge
    if wasm_bridge::is_wasm_mode() {
        let mut compressed_buffers: Vec<Vec<u8>> = Vec::new();
        
        for request in &read_memory_requests {
            match wasm_bridge::read_wasm_memory_async(request.address, request.size).await {
                Ok(buffer) => {
                    let compressed_buffer = compress_prepend_size(&buffer);
                    let mut result_buffer = Vec::with_capacity(8 + compressed_buffer.len());
                    let compressed_buffer_size: u32 = compressed_buffer.len() as u32;
                    result_buffer.extend_from_slice(&1u32.to_le_bytes());
                    result_buffer.extend_from_slice(&compressed_buffer_size.to_le_bytes());
                    result_buffer.extend_from_slice(&compressed_buffer);
                    compressed_buffers.push(result_buffer);
                }
                Err(_) => {
                    let mut result_buffer = Vec::with_capacity(4);
                    result_buffer.extend_from_slice(&0u32.to_le_bytes());
                    compressed_buffers.push(result_buffer);
                }
            }
        }
        
        let mut concatenated_buffer = Vec::new();
        for buffer in compressed_buffers {
            concatenated_buffer.extend(buffer);
        }
        
        let response = Response::builder()
            .header("Content-Type", "application/octet-stream")
            .body(hyper::Body::from(concatenated_buffer))
            .unwrap();
        return Ok(response);
    }

    let pid = pid_state.lock().unwrap();
    if let Some(pid) = *pid {
        let compressed_buffers: Vec<Vec<u8>> = read_memory_requests
            .par_iter()
            .map(|request| {
                let mut buffer: Vec<u8> = vec![0; request.size];
                let nread = native_bridge::read_process_memory(
                    pid,
                    request.address as *mut libc::c_void,
                    request.size,
                    &mut buffer,
                );
                match nread {
                    Ok(_) => {
                        let compressed_buffer = compress_prepend_size(&buffer);
                        let mut result_buffer = Vec::with_capacity(8 + compressed_buffer.len());
                        let compresed_buffer_size: u32 = compressed_buffer.len() as u32;
                        result_buffer.extend_from_slice(&1u32.to_le_bytes());
                        result_buffer.extend_from_slice(&compresed_buffer_size.to_le_bytes());
                        result_buffer.extend_from_slice(&compressed_buffer);
                        result_buffer
                    }
                    Err(_) => {
                        let mut result_buffer = Vec::with_capacity(4);
                        result_buffer.extend_from_slice(&0u32.to_le_bytes());
                        result_buffer
                    }
                }
            })
            .collect();

        let mut concatenated_buffer = Vec::new();
        for buffer in compressed_buffers {
            concatenated_buffer.extend(buffer);
        }

        let response = Response::builder()
            .header("Content-Type", "application/octet-stream")
            .body(hyper::Body::from(concatenated_buffer))
            .unwrap();
        Ok(response)
    } else {
        let response = Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(hyper::Body::from("Pid not set"))
            .unwrap();
        Ok(response)
    }
}

pub async fn write_memory_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    write_memory: request::WriteMemoryRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    // In WASM mode, use async WebSocket bridge
    if wasm_bridge::is_wasm_mode() {
        match wasm_bridge::write_wasm_memory_async(write_memory.address, &write_memory.buffer).await {
            Ok(success) => {
                if success {
                    let response = Response::builder()
                        .header("Content-Type", "application/json")
                        .body(hyper::Body::from(r#"{"success":true,"message":"Memory successfully written"}"#))
                        .unwrap();
                    return Ok(response);
                } else {
                    let response = Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .header("Content-Type", "application/json")
                        .body(hyper::Body::from(r#"{"success":false,"error":"WASM memory write failed"}"#))
                        .unwrap();
                    return Ok(response);
                }
            }
            Err(e) => {
                log::error!("WASM write_memory failed: {}", e);
                let response = Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header("Content-Type", "application/json")
                    .body(hyper::Body::from(format!(r#"{{"success":false,"error":"{}"}}"#, e)))
                    .unwrap();
                return Ok(response);
            }
        }
    }

    let pid = pid_state.lock().unwrap();

    if let Some(pid) = *pid {
        let nwrite = native_bridge::write_process_memory(
            pid,
            write_memory.address as *mut libc::c_void,
            write_memory.buffer.len(),
            &write_memory.buffer,
        );
        match nwrite {
            Ok(_) => {
                let response = Response::builder()
                    .header("Content-Type", "application/json")
                    .body(hyper::Body::from(r#"{"success":true,"message":"Memory successfully written"}"#))
                    .unwrap();
                return Ok(response);
            }
            Err(_) => {
                let response = Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header("Content-Type", "application/json")
                    .body(hyper::Body::from(r#"{"success":false,"error":"WriteProcessMemory error"}"#))
                    .unwrap();
                return Ok(response);
            }
        };
    } else {
        let response = Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("Content-Type", "application/json")
            .body(hyper::Body::from(r#"{"success":false,"error":"Pid not set"}"#))
            .unwrap();
        Ok(response)
    }
}

pub async fn memory_scan_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    scan_request: request::MemoryScanRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();

    let mut is_suspend_success: bool = false;
    let do_suspend = scan_request.do_suspend;
    if let Some(pid) = *pid {
        if do_suspend {
            unsafe {
                is_suspend_success = native_bridge::suspend_process(pid);
            }
        }
        // Clear global_positions for the given scan_id
        {
            let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
            if let Some(positions) = global_positions.get_mut(&scan_request.scan_id) {
                positions.clear();
            }
            let mut global_memory = GLOBAL_MEMORY.write().unwrap();
            if let Some(memory) = global_memory.get_mut(&scan_request.scan_id) {
                memory.clear();
            } else {
            }
            let mut global_scan_option = GLOBAL_SCAN_OPTION.write().unwrap();
            global_scan_option.insert(scan_request.scan_id.clone(), scan_request.clone());
            
            // Initialize scan progress
            let total_bytes: u64 = scan_request.address_ranges.iter()
                .map(|(start, end)| (end - start) as u64)
                .sum();
            let mut global_scan_progress = GLOBAL_SCAN_PROGRESS.write().unwrap();
            global_scan_progress.insert(scan_request.scan_id.clone(), request::ScanProgressResponse {
                scan_id: scan_request.scan_id.clone(),
                progress_percentage: 0.0,
                scanned_bytes: 0,
                total_bytes,
                is_scanning: true,
                current_region: None,
            });
        }
        
        // Create stop flag for this scan
        let stop_flag = Arc::new(Mutex::new(false));
        {
            let mut scan_stop_flags = SCAN_STOP_FLAGS.write().unwrap();
            scan_stop_flags.insert(scan_request.scan_id.clone(), stop_flag.clone());
        }
        // dbgsrv-data-dir/Scan_xxx cleanup and create
        let mut scan_folder_path = PathBuf::from("");
        let mode =
            std::env::var("DBGSRV_RUNNING_MODE").unwrap_or_else(|_| "unknown".to_string());
        if mode == "embedded" {
            let cache_directory = util::get_cache_directory(pid);
            scan_folder_path = PathBuf::from(&cache_directory);
        }
        let sanitized_scan_id = scan_request.scan_id.trim().replace(" ", "_");
        scan_folder_path.push("dbgsrv-data-dir");
        scan_folder_path.push(&sanitized_scan_id);
        let scan_folder = Path::new(&scan_folder_path);

        if scan_folder.exists() {
            fs::remove_dir_all(&scan_folder).expect("Failed to remove directory");
        }
        fs::create_dir_all(&scan_folder_path).expect("Failed to create directory");

        let _is_number = match scan_request.data_type.as_str() {
            "int16" | "uint16" | "int32" | "uint32" | "float" | "int64" | "uint64" | "double" => {
                true
            }
            _ => false,
        };
        let found_count = Arc::new(AtomicUsize::new(0));
        let scanned_bytes = Arc::new(AtomicUsize::new(0));
        let total_bytes_to_scan: usize = scan_request.address_ranges.iter()
            .map(|(start, end)| end - start)
            .sum();
        let scan_align = scan_request.align;
        let is_error_occurred = Arc::new(Mutex::new(false));
        let error_message = Arc::new(Mutex::new(String::new()));

        // Start a background task to update progress
        let scan_id_progress = scan_request.scan_id.clone();
        let scanned_bytes_clone = Arc::clone(&scanned_bytes);
        let total_bytes_to_scan_clone = total_bytes_to_scan;
        let _progress_task = std::thread::spawn(move || {
            loop {
                let current_scanned = scanned_bytes_clone.load(Ordering::SeqCst);
                let progress_percentage = if total_bytes_to_scan_clone > 0 {
                    (current_scanned as f64 / total_bytes_to_scan_clone as f64) * 100.0
                } else {
                    0.0
                };

                // Update progress
                if let Ok(mut global_scan_progress) = GLOBAL_SCAN_PROGRESS.try_write() {
                    if let Some(progress) = global_scan_progress.get_mut(&scan_id_progress) {
                        progress.scanned_bytes = current_scanned as u64;
                        progress.progress_percentage = progress_percentage;
                    }
                }

                // Check if scan is complete
                if current_scanned >= total_bytes_to_scan_clone {
                    break;
                }

                // Sleep for 100ms before next update
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });

        // Get tokio handle for WASM mode (needed for rayon threads)
        let tokio_handle = if wasm_bridge::is_wasm_mode() {
            tokio::runtime::Handle::try_current().ok()
        } else {
            None
        };
        let tokio_handle = Arc::new(tokio_handle);

        // Start scanning in background thread
        let scan_request_clone = scan_request.clone();
        let scan_folder_path_clone = scan_folder_path.clone();
        let stop_flag_clone = stop_flag.clone();
        std::thread::spawn(move || {
            let tokio_handle_clone = Arc::clone(&tokio_handle);
            let thread_results: Vec<Vec<(usize, String)>> = scan_request_clone
                .address_ranges
                .par_iter()
                .enumerate()
                .flat_map(|(index, &(ref start_address, ref end_address))| {
                    let found_count = Arc::clone(&found_count);
                    let tokio_handle = Arc::clone(&tokio_handle_clone);
                    let size = end_address - start_address;
                    let chunk_size = 1024 * 1024 * 16; // 16MB
                    let num_chunks = (size + chunk_size - 1) / chunk_size;

                    (0..num_chunks)
                        .map(|i| {
                            // Check stop flag
                            if let Ok(should_stop) = stop_flag_clone.lock() {
                                if *should_stop {
                                    return vec![];
                                }
                            }
                            
                            let mut error_occurred = is_error_occurred.lock().unwrap();
                            let mut error_msg = error_message.lock().unwrap();

                            if *error_occurred == true {
                                return vec![];
                            }
                            let chunk_start = start_address + i * chunk_size;
                            let chunk_end = std::cmp::min(chunk_start + chunk_size, *end_address);
                            let chunk_size_actual = chunk_end - chunk_start;
                            let mut buffer: Vec<u8> = vec![0; chunk_size_actual];

                            let mut local_positions = vec![];
                            let mut local_values = vec![];

                            let nread = match native_bridge::read_process_memory_with_handle(
                                pid,
                                chunk_start as *mut libc::c_void,
                                chunk_size_actual,
                                &mut buffer,
                                tokio_handle.as_ref().as_ref(),
                            ) {
                                Ok(nread) => nread,
                                Err(_) => -1,
                            };

                            if nread != -1 {
                                if scan_request_clone.find_type == "exact" {
                                    if scan_request_clone.data_type == "regex" {
                                        let regex_pattern = &scan_request_clone.pattern;
                                        let re = match Regex::new(regex_pattern) {
                                            Ok(re) => re,
                                            Err(_) => return vec![],
                                        };

                                        for cap in re.captures_iter(&buffer) {
                                            let start = cap.get(0).unwrap().start();
                                            let absolute_address = chunk_start + start;
                                            if absolute_address % scan_align == 0 {
                                                let end = cap.get(0).unwrap().end();
                                                let value = hex::encode(&buffer[start..end]);
                                                local_positions.push(absolute_address);
                                                local_values.push(value);
                                                found_count.fetch_add(1, Ordering::SeqCst);
                                            }
                                        }
                                    } else {
                                        let search_bytes = match hex::decode(&scan_request_clone.pattern) {
                                            Ok(bytes) => bytes,
                                            Err(_) => {
                                                println!("Failed to decode hex pattern: {}", scan_request_clone.pattern);
                                                return vec![];
                                            }
                                        };

                                        for pos in memmem::find_iter(&buffer, &search_bytes) {
                                            let absolute_address = chunk_start + pos;
                                            if absolute_address % scan_align == 0 {
                                                // Get the actual bytes found at this position
                                                let value = hex::encode(&buffer[pos..pos + search_bytes.len()]);
                                                local_positions.push(absolute_address);
                                                local_values.push(value);
                                                found_count.fetch_add(1, Ordering::SeqCst);
                                            }
                                        }
                                    }
                                } else if scan_request_clone.find_type == "range" {
                                    // Range search: find values between min (pattern) and max (pattern_max)
                                    let data_type = scan_request_clone.data_type.as_str();
                                    let min_bytes = match hex::decode(&scan_request_clone.pattern) {
                                        Ok(bytes) => bytes,
                                        Err(_) => {
                                            println!("Failed to decode hex min pattern: {}", scan_request_clone.pattern);
                                            return vec![];
                                        }
                                    };
                                    let max_bytes = match &scan_request_clone.pattern_max {
                                        Some(max_pattern) => match hex::decode(max_pattern) {
                                            Ok(bytes) => bytes,
                                            Err(_) => {
                                                println!("Failed to decode hex max pattern: {}", max_pattern);
                                                return vec![];
                                            }
                                        },
                                        None => {
                                            println!("Range search requires pattern_max");
                                            return vec![];
                                        }
                                    };

                                    let type_size = match data_type {
                                        "int8" | "uint8" => 1,
                                        "int16" | "uint16" => 2,
                                        "int32" | "uint32" | "float" => 4,
                                        "int64" | "uint64" | "double" => 8,
                                        _ => return vec![],
                                    };

                                    for pos in (0..buffer.len().saturating_sub(type_size - 1)).step_by(scan_align) {
                                        let absolute_address = chunk_start + pos;
                                        let in_range = match data_type {
                                            "int8" => {
                                                let val = buffer[pos] as i8;
                                                let min = i8::from_le_bytes([min_bytes[0]]);
                                                let max = i8::from_le_bytes([max_bytes[0]]);
                                                val >= min && val <= max
                                            }
                                            "uint8" => {
                                                let val = buffer[pos];
                                                let min = min_bytes[0];
                                                let max = max_bytes[0];
                                                val >= min && val <= max
                                            }
                                            "int16" => {
                                                if pos + 2 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_i16(&buffer[pos..]);
                                                    let min = LittleEndian::read_i16(&min_bytes);
                                                    let max = LittleEndian::read_i16(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                            }
                                            "uint16" => {
                                                if pos + 2 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_u16(&buffer[pos..]);
                                                    let min = LittleEndian::read_u16(&min_bytes);
                                                    let max = LittleEndian::read_u16(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                            }
                                            "int32" => {
                                                if pos + 4 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_i32(&buffer[pos..]);
                                                    let min = LittleEndian::read_i32(&min_bytes);
                                                    let max = LittleEndian::read_i32(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                            }
                                            "uint32" => {
                                                if pos + 4 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_u32(&buffer[pos..]);
                                                    let min = LittleEndian::read_u32(&min_bytes);
                                                    let max = LittleEndian::read_u32(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                            }
                                            "int64" => {
                                                if pos + 8 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_i64(&buffer[pos..]);
                                                    let min = LittleEndian::read_i64(&min_bytes);
                                                    let max = LittleEndian::read_i64(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                            }
                                            "uint64" => {
                                                if pos + 8 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_u64(&buffer[pos..]);
                                                    let min = LittleEndian::read_u64(&min_bytes);
                                                    let max = LittleEndian::read_u64(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                            }
                                            "float" => {
                                                if pos + 4 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_f32(&buffer[pos..]);
                                                    let min = LittleEndian::read_f32(&min_bytes);
                                                    let max = LittleEndian::read_f32(&max_bytes);
                                                    !val.is_nan() && val >= min && val <= max
                                                }
                                            }
                                            "double" => {
                                                if pos + 8 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_f64(&buffer[pos..]);
                                                    let min = LittleEndian::read_f64(&min_bytes);
                                                    let max = LittleEndian::read_f64(&max_bytes);
                                                    !val.is_nan() && val >= min && val <= max
                                                }
                                            }
                                            _ => false,
                                        };

                                        if in_range {
                                            let value = hex::encode(&buffer[pos..pos + type_size]);
                                            local_positions.push(absolute_address);
                                            local_values.push(value);
                                            found_count.fetch_add(1, Ordering::SeqCst);
                                        }
                                    }
                                } else if scan_request_clone.find_type == "greater_or_equal" || scan_request_clone.find_type == "less_than" {
                                    // Greater than or equal / Less than search
                                    let data_type = scan_request_clone.data_type.as_str();
                                    let cmp_bytes = match hex::decode(&scan_request_clone.pattern) {
                                        Ok(bytes) => bytes,
                                        Err(_) => {
                                            println!("Failed to decode hex pattern: {}", scan_request_clone.pattern);
                                            return vec![];
                                        }
                                    };
                                    let is_greater_or_equal = scan_request_clone.find_type == "greater_or_equal";

                                    let type_size = match data_type {
                                        "int8" | "uint8" => 1,
                                        "int16" | "uint16" => 2,
                                        "int32" | "uint32" | "float" => 4,
                                        "int64" | "uint64" | "double" => 8,
                                        _ => return vec![],
                                    };

                                    for pos in (0..buffer.len().saturating_sub(type_size - 1)).step_by(scan_align) {
                                        let absolute_address = chunk_start + pos;
                                        let matches = match data_type {
                                            "int8" => {
                                                let val = buffer[pos] as i8;
                                                let cmp = i8::from_le_bytes([cmp_bytes[0]]);
                                                if is_greater_or_equal { val >= cmp } else { val < cmp }
                                            }
                                            "uint8" => {
                                                let val = buffer[pos];
                                                let cmp = cmp_bytes[0];
                                                if is_greater_or_equal { val >= cmp } else { val < cmp }
                                            }
                                            "int16" => {
                                                if pos + 2 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_i16(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_i16(&cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "uint16" => {
                                                if pos + 2 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_u16(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_u16(&cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "int32" => {
                                                if pos + 4 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_i32(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_i32(&cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "uint32" => {
                                                if pos + 4 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_u32(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_u32(&cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "int64" => {
                                                if pos + 8 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_i64(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_i64(&cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "uint64" => {
                                                if pos + 8 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_u64(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_u64(&cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "float" => {
                                                if pos + 4 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_f32(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_f32(&cmp_bytes);
                                                    !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            "double" => {
                                                if pos + 8 > buffer.len() { false } else {
                                                    let val = LittleEndian::read_f64(&buffer[pos..]);
                                                    let cmp = LittleEndian::read_f64(&cmp_bytes);
                                                    !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                            }
                                            _ => false,
                                        };

                                        if matches {
                                            let value = hex::encode(&buffer[pos..pos + type_size]);
                                            local_positions.push(absolute_address);
                                            local_values.push(value);
                                            found_count.fetch_add(1, Ordering::SeqCst);
                                        }
                                    }
                                } else if scan_request_clone.find_type == "unknown" {
                                    let alignment = match scan_request_clone.data_type.as_str() {
                                        "int16" | "uint16" => 2,
                                        "int32" | "uint32" | "float" => 4,
                                        "int64" | "uint64" | "double" => 8,
                                        _ => 1,
                                    };

                                    let mut file_path = scan_folder_path_clone.clone();
                                    file_path.push(format!("{}.dump", index));
                                    let file_exists = file_path.exists();

                                    let file = match OpenOptions::new()
                                        .create(true)
                                        .append(true)
                                        .open(file_path)
                                    {
                                        Ok(file) => file,
                                        Err(e) => {
                                            *error_occurred = true;
                                            *error_msg = format!("Failed to open file: {}", e);
                                            return vec![];
                                        }
                                    };

                                    let mut writer = BufWriter::new(file);

                                    if !file_exists {
                                        // status flag
                                        let zero_bytes = [0x00, 0x00, 0x00, 0x00];
                                        if let Err(e) = writer.write_all(&zero_bytes) {
                                            *error_occurred = true;
                                            *error_msg = format!("Failed to write 4 zero bytes: {}", e);
                                            return vec![];
                                        }
                                    }

                                    if let Err(e) = writer.write_all(&chunk_start.to_le_bytes()) {
                                        *error_occurred = true;
                                        *error_msg = format!("Failed to write chunk_start: {}", e);
                                        return vec![];
                                    }

                                    let compressed_buffer = lz4_flex::block::compress(&buffer);

                                    if let Err(e) = writer
                                        .write_all(&(compressed_buffer.len() as u64).to_le_bytes())
                                    {
                                        *error_occurred = true;
                                        *error_msg =
                                            format!("Failed to write compressed buffer length: {}", e);
                                        return vec![];
                                    }

                                    if let Err(e) =
                                        writer.write_all(&(buffer.len() as u64).to_le_bytes())
                                    {
                                        *error_occurred = true;
                                        *error_msg = format!(
                                            "Failed to write uncompressed buffer length: {}",
                                            e
                                        );
                                        return vec![];
                                    }

                                    if let Err(e) = writer.write_all(&compressed_buffer) {
                                        *error_occurred = true;
                                        *error_msg = format!("Failed to write buffer data: {}", e);
                                        return vec![];
                                    }

                                    if let Err(e) = writer.flush() {
                                        *error_occurred = true;
                                        *error_msg = format!("Failed to flush buffer: {}", e);
                                        return vec![];
                                    }
                                    found_count.fetch_add(buffer.len() / alignment, Ordering::SeqCst);
                                }
                                // Check if local_positions exceed MAX_RESULTS and insert into global_positions
                                if local_positions.len() > MAX_RESULTS {
                                    let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
                                    let combined: Vec<(usize, String)> = local_positions
                                        .into_iter()
                                        .zip(local_values.into_iter())
                                        .collect();
                                    if let Some(positions) =
                                        global_positions.get_mut(&scan_request_clone.scan_id)
                                    {
                                        positions.extend(combined);
                                    } else {
                                        global_positions.insert(scan_request_clone.scan_id.clone(), combined);
                                    }
                                    local_positions = vec![];
                                    local_values = vec![];
                                }
                            }

                            // Update progress for this chunk
                            let _bytes_processed = scanned_bytes.fetch_add(chunk_size_actual, Ordering::SeqCst) + chunk_size_actual;

                            let combined: Vec<(usize, String)> = local_positions
                                .into_iter()
                                .zip(local_values.into_iter())
                                .collect();
                            combined
                        })
                        .collect::<Vec<_>>()
                })
                .collect();
            
            let do_play = GLOBAL_PROCESS_STATE.write().unwrap();
            if do_suspend && is_suspend_success && *do_play {
                unsafe {
                    native_bridge::resume_process(pid);
                }
            }

            let flattened_results: Vec<(usize, String)> =
                thread_results.into_iter().flatten().collect();
            {
                let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
                if let Some(positions) = global_positions.get_mut(&scan_request_clone.scan_id) {
                    positions.extend(flattened_results);
                } else {
                    global_positions.insert(scan_request_clone.scan_id.clone(), flattened_results);
                }
            }
            // Update scan progress to completed
            {
                let mut global_scan_progress = GLOBAL_SCAN_PROGRESS.write().unwrap();
                if let Some(progress) = global_scan_progress.get_mut(&scan_request_clone.scan_id) {
                    progress.progress_percentage = 100.0;
                    progress.is_scanning = false;
                    progress.current_region = None;
                    progress.scanned_bytes = total_bytes_to_scan as u64;
                }
            }
            
            // Clean up stop flag
            {
                let mut scan_stop_flags = SCAN_STOP_FLAGS.write().unwrap();
                scan_stop_flags.remove(&scan_request_clone.scan_id);
            }
        });

        // Return immediately with scan started status
        let result = json!({
            "scan_id": scan_request.scan_id,
            "status": "started",
            "message": "Scan started in background. Use progress API to check status."
        });
        let result_string = result.to_string();
        let response = Response::builder()
            .header("Content-Type", "application/json")
            .body(hyper::Body::from(result_string))
            .unwrap();
        Ok(response)
    } else {
        let response = Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(hyper::Body::from("Pid not set"))
            .unwrap();
        Ok(response)
    }
}

macro_rules! compare_values {
    ($val:expr, $old_val:expr, $filter_method:expr) => {
        match $filter_method {
            "changed" => $val != $old_val,
            "unchanged" => $val == $old_val,
            "increased" => $val > $old_val,
            "decreased" => $val < $old_val,
            _ => false,
        }
    };
}

pub async fn memory_filter_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    filter_request: request::MemoryFilterRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = {
        let pid_guard = pid_state.lock().unwrap();
        *pid_guard
    };

    if let Some(_pid) = pid {
        let filter_id = format!("filter_{}", filter_request.scan_id);
        
        // Initialize filter progress
        {
            let mut global_filter_progress = GLOBAL_FILTER_PROGRESS.write().unwrap();
            global_filter_progress.insert(filter_id.clone(), request::FilterProgressResponse {
                filter_id: filter_id.clone(),
                progress_percentage: 0.0,
                processed_results: 0,
                total_results: 0,
                is_filtering: true,
                current_region: Some("Starting filter...".to_string()),
            });
        }

        // Start background filter processing
        let filter_request_clone = filter_request.clone();
        let pid_state_clone = pid_state.clone();
        let filter_id_clone = filter_id.clone();
        
        tokio::spawn(async move {
            if let Err(e) = perform_memory_filter_async(pid_state_clone, filter_request_clone, filter_id_clone.clone()).await {
                eprintln!("Filter error: {}", e);
                // Mark as completed with error
                let mut global_filter_progress = GLOBAL_FILTER_PROGRESS.write().unwrap();
                if let Some(progress) = global_filter_progress.get_mut(&filter_id_clone) {
                    progress.is_filtering = false;
                    progress.current_region = Some(format!("Error: {}", e));
                }
            }
        });

        // Return immediate response
        let response = json!({
            "success": true,
            "message": "Filter started",
            "filter_id": filter_id,
            "scan_id": filter_request.scan_id
        });
        
        let response = Response::builder()
            .header("Content-Type", "application/json")
            .status(StatusCode::ACCEPTED)
            .body(Body::from(response.to_string()))
            .unwrap();
        
        return Ok(response);
    }

    let response = Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .body(Body::from("No process attached"))
        .unwrap();
    Ok(response)
}

// Original filter logic moved to async function
async fn perform_memory_filter_async(
    pid_state: Arc<Mutex<Option<i32>>>,
    filter_request: request::MemoryFilterRequest,
    filter_id: String,
) -> Result<(), String> {
    let pid = {
        let pid_guard = pid_state.lock().unwrap();
        pid_guard.ok_or("No process attached")?
    };

    let mut is_suspend_success: bool = false;
    let do_suspend = filter_request.do_suspend;
    
    // Get the total number of items to process for progress calculation
    let total_items = {
        let global_positions = GLOBAL_POSITIONS.read().unwrap();
        if let Some(positions) = global_positions.get(&filter_request.scan_id) {
            positions.len()
        } else {
            // For unknown scan type, estimate from file sizes
            let mut scan_folder_path = PathBuf::from("");
            let mode = std::env::var("DBGSRV_RUNNING_MODE").unwrap_or_else(|_| "unknown".to_string());
            if mode == "embedded" {
                let cache_directory = util::get_cache_directory(pid);
                scan_folder_path = PathBuf::from(&cache_directory);
            }
            let sanitized_scan_id = filter_request.scan_id.trim().replace(" ", "_");
            scan_folder_path.push("dbgsrv-data-dir");
            scan_folder_path.push(&sanitized_scan_id);
            
            if let Ok(entries) = fs::read_dir(&scan_folder_path) {
                entries.count()
            } else {
                1 // Default minimum
            }
        }
    };

    // Update initial progress with total count
    {
        let mut global_filter_progress = GLOBAL_FILTER_PROGRESS.write().unwrap();
        if let Some(progress) = global_filter_progress.get_mut(&filter_id) {
            progress.total_results = total_items as u64;
            progress.current_region = Some("Initializing filter...".to_string());
        }
    }

        #[allow(unused_assignments)]
        let mut new_positions = Vec::new();
        let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
        let global_scan_option = GLOBAL_SCAN_OPTION.write().unwrap();
        let scan_option: request::MemoryScanRequest = global_scan_option
            .get(&filter_request.scan_id)
            .unwrap()
            .clone();
        let found_count = Arc::new(AtomicUsize::new(0));
        let processed_count = Arc::new(AtomicUsize::new(0)); // Track processed items
        let size = match filter_request.data_type.as_str() {
            "int16" | "uint16" => 2,
            "int32" | "uint32" | "float" => 4,
            "int64" | "uint64" | "double" => 8,
            "bytes" => {
                // For bytes type, use the actual pattern length
                match hex::decode(&filter_request.pattern) {
                    Ok(bytes) => bytes.len(),
                    Err(_) => 1, // Fallback to 1 if pattern is invalid
                }
            },
            _ => 1,
        };
        let is_error_occurred = Arc::new(Mutex::new(false));
        let error_message = Arc::new(Mutex::new(String::new()));

        let mut scan_folder_path = PathBuf::from("");
        let mode =
            std::env::var("DBGSRV_RUNNING_MODE").unwrap_or_else(|_| "unknown".to_string());
        if mode == "embedded" {
            let cache_directory = util::get_cache_directory(pid);
            scan_folder_path = PathBuf::from(&cache_directory);
        }
        let sanitized_scan_id = filter_request.scan_id.trim().replace(" ", "_");
        scan_folder_path.push("dbgsrv-data-dir");
        scan_folder_path.push(&sanitized_scan_id);

        // Start progress monitoring task
        let filter_id_progress = filter_id.clone();
        let processed_count_progress = Arc::clone(&processed_count);
        let total_items_progress = total_items;
        let _progress_task = std::thread::spawn(move || {
            loop {
                let current_processed = processed_count_progress.load(Ordering::SeqCst);
                let progress_percentage = if total_items_progress > 0 {
                    (current_processed as f64 / total_items_progress as f64) * 100.0
                } else {
                    0.0
                };

                // Update progress
                if let Ok(mut global_filter_progress) = GLOBAL_FILTER_PROGRESS.try_write() {
                    if let Some(progress) = global_filter_progress.get_mut(&filter_id_progress) {
                        progress.processed_results = current_processed as u64;
                        progress.progress_percentage = progress_percentage;
                        if current_processed >= total_items_progress {
                            break;
                        }
                    }
                }

                // Sleep for 50ms before next update
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        });

        // Get tokio handle for WASM mode (needed for rayon threads)
        let tokio_handle = if wasm_bridge::is_wasm_mode() {
            tokio::runtime::Handle::try_current().ok()
        } else {
            None
        };
        let tokio_handle = Arc::new(tokio_handle);

        // unknown search
        if scan_option.find_type == "unknown" {
            if do_suspend {
                unsafe {
                    is_suspend_success = native_bridge::suspend_process(pid);
                }
            }

            let paths = match fs::read_dir(&scan_folder_path) {
                Ok(entries) => entries
                    .filter_map(|entry| entry.ok().map(|e| e.path()))
                    .collect::<Vec<_>>(),
                Err(e) => {
                    let mut error_occurred = is_error_occurred.lock().unwrap();
                    let mut error_msg = error_message.lock().unwrap();
                    *error_occurred = true;
                    *error_msg = format!("Failed to read directory: {}", e);
                    vec![]
                }
            };

            let scan_align = scan_option.align;

            let mut exact_bytes: Vec<u8> = vec![];
            // Decode pattern for exact, range, greater_or_equal, and less_than filters
            if filter_request.filter_method.as_str() == "exact" 
                || filter_request.filter_method.as_str() == "range"
                || filter_request.filter_method.as_str() == "greater_or_equal"
                || filter_request.filter_method.as_str() == "less_than" {
                exact_bytes = match hex::decode(&filter_request.pattern) {
                    Ok(bytes) => bytes,
                    Err(_) => vec![],
                };
            }

            if !*is_error_occurred.lock().unwrap() {
                let tokio_handle_clone = Arc::clone(&tokio_handle);
                paths.par_iter().enumerate().for_each(|(_index, file_path)| {
                    let tokio_handle = Arc::clone(&tokio_handle_clone);
                    let mut error_occurred = is_error_occurred.lock().unwrap();
                    let mut error_msg = error_message.lock().unwrap();
                    if *error_occurred {
                        return;
                    }
                    
                    // Update progress
                    processed_count.fetch_add(1, Ordering::SeqCst);
                    
                    let mut serialized_data: Vec<u8> = Vec::new();
                    if let Ok(file) = File::open(file_path) {
                        let mut reader = BufReader::new(file);
                        let mut data_buffer: Vec<u8> = Vec::new();
                        if let Err(e) = reader.read_to_end(&mut data_buffer) {
                            *error_occurred = true;
                            *error_msg = format!("Failed to read file: {}", e);
                            return;
                        }
                        let status_flag: [u8; 4] = match data_buffer[0..4].try_into() {
                            Ok(flag) => flag,
                            Err(e) => {
                                *error_occurred = true;
                                *error_msg = format!("Invalid address format: {}", e);
                                return;
                            }
                        };
                        let mut offset = 4;
                        let usize_size = size_of::<usize>();
                        if status_flag == [0x00, 0x00, 0x00, 0x00] {
                            while offset + 3 * usize_size <= data_buffer.len() {
                                let address = usize::from_le_bytes(
                                    data_buffer[offset..offset + usize_size]
                                        .try_into()
                                        .expect("Invalid address format"),
                                );

                                offset += usize_size;

                                let compressed_data_size = usize::from_le_bytes(
                                    data_buffer[offset..offset + usize_size]
                                        .try_into()
                                        .expect("Invalid length format"),
                                );
                                offset += usize_size;

                                let uncompressed_data_size = usize::from_le_bytes(
                                    data_buffer[offset..offset + usize_size]
                                        .try_into()
                                        .expect("Invalid length format"),
                                );
                                offset += usize_size;

                                if offset + compressed_data_size <= data_buffer.len() {
                                    let compressed_data =
                                        &data_buffer[offset..offset + compressed_data_size];
                                    offset += compressed_data_size;
                                    let decompressed_data = match lz4_flex::block::decompress(
                                        &compressed_data,
                                        uncompressed_data_size,
                                    ) {
                                        Ok(data) => data,
                                        Err(e) => {
                                            *error_occurred = true;
                                            *error_msg =
                                                format!("Failed to decompress data: {}", e);
                                            return;
                                        }
                                    };

                                    let mut buffer: Vec<u8> =
                                        vec![0; (decompressed_data.len()) as usize];
                                    let _nread = match native_bridge::read_process_memory_with_handle(
                                        pid,
                                        address as *mut libc::c_void,
                                        decompressed_data.len(),
                                        &mut buffer,
                                        tokio_handle.as_ref().as_ref(),
                                    ) {
                                        Ok(nread) => nread,
                                        Err(_err) => -1,
                                    };

                                    if _nread == -1 {
                                        return;
                                    }
                                    for offset in (0..decompressed_data.len()).step_by(1) {
                                        if (address + offset) % scan_align != 0 {
                                            continue;
                                        }
                                        if offset + size > decompressed_data.len() {
                                            break;
                                        }
                                        let old_val = &decompressed_data[offset..offset + size];
                                        let new_val = &buffer[offset..offset + size];

                                        let mut pass_filter: bool = false;
                                        if filter_request.filter_method.as_str() == "exact" {
                                            if exact_bytes == new_val {
                                                pass_filter = true;
                                            }
                                        } else if filter_request.filter_method.as_str() == "range" {
                                            // Range filter: check if value is between min and max
                                            let min_bytes = &exact_bytes;
                                            let max_bytes = match &filter_request.pattern_max {
                                                Some(max_pattern) => match hex::decode(max_pattern) {
                                                    Ok(bytes) => bytes,
                                                    Err(_) => continue,
                                                },
                                                None => continue,
                                            };
                                            
                                            pass_filter = match filter_request.data_type.as_str() {
                                                "int8" => {
                                                    let val = new_val[0] as i8;
                                                    let min = i8::from_le_bytes([min_bytes[0]]);
                                                    let max = i8::from_le_bytes([max_bytes[0]]);
                                                    val >= min && val <= max
                                                }
                                                "uint8" => {
                                                    let val = new_val[0];
                                                    val >= min_bytes[0] && val <= max_bytes[0]
                                                }
                                                "int16" => {
                                                    let val = LittleEndian::read_i16(new_val);
                                                    let min = LittleEndian::read_i16(min_bytes);
                                                    let max = LittleEndian::read_i16(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                                "uint16" => {
                                                    let val = LittleEndian::read_u16(new_val);
                                                    let min = LittleEndian::read_u16(min_bytes);
                                                    let max = LittleEndian::read_u16(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                                "int32" => {
                                                    let val = LittleEndian::read_i32(new_val);
                                                    let min = LittleEndian::read_i32(min_bytes);
                                                    let max = LittleEndian::read_i32(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                                "uint32" => {
                                                    let val = LittleEndian::read_u32(new_val);
                                                    let min = LittleEndian::read_u32(min_bytes);
                                                    let max = LittleEndian::read_u32(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                                "int64" => {
                                                    let val = LittleEndian::read_i64(new_val);
                                                    let min = LittleEndian::read_i64(min_bytes);
                                                    let max = LittleEndian::read_i64(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                                "uint64" => {
                                                    let val = LittleEndian::read_u64(new_val);
                                                    let min = LittleEndian::read_u64(min_bytes);
                                                    let max = LittleEndian::read_u64(&max_bytes);
                                                    val >= min && val <= max
                                                }
                                                "float" => {
                                                    let val = LittleEndian::read_f32(new_val);
                                                    let min = LittleEndian::read_f32(min_bytes);
                                                    let max = LittleEndian::read_f32(&max_bytes);
                                                    !val.is_nan() && val >= min && val <= max
                                                }
                                                "double" => {
                                                    let val = LittleEndian::read_f64(new_val);
                                                    let min = LittleEndian::read_f64(min_bytes);
                                                    let max = LittleEndian::read_f64(&max_bytes);
                                                    !val.is_nan() && val >= min && val <= max
                                                }
                                                _ => false,
                                            };
                                        } else if filter_request.filter_method.as_str() == "greater_or_equal" || filter_request.filter_method.as_str() == "less_than" {
                                            // Greater than or equal / Less than filter
                                            let cmp_bytes = &exact_bytes;
                                            let is_greater_or_equal = filter_request.filter_method.as_str() == "greater_or_equal";
                                            
                                            pass_filter = match filter_request.data_type.as_str() {
                                                "int8" => {
                                                    let val = new_val[0] as i8;
                                                    let cmp = i8::from_le_bytes([cmp_bytes[0]]);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "uint8" => {
                                                    let val = new_val[0];
                                                    let cmp = cmp_bytes[0];
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "int16" => {
                                                    let val = LittleEndian::read_i16(new_val);
                                                    let cmp = LittleEndian::read_i16(cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "uint16" => {
                                                    let val = LittleEndian::read_u16(new_val);
                                                    let cmp = LittleEndian::read_u16(cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "int32" => {
                                                    let val = LittleEndian::read_i32(new_val);
                                                    let cmp = LittleEndian::read_i32(cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "uint32" => {
                                                    let val = LittleEndian::read_u32(new_val);
                                                    let cmp = LittleEndian::read_u32(cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "int64" => {
                                                    let val = LittleEndian::read_i64(new_val);
                                                    let cmp = LittleEndian::read_i64(cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "uint64" => {
                                                    let val = LittleEndian::read_u64(new_val);
                                                    let cmp = LittleEndian::read_u64(cmp_bytes);
                                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "float" => {
                                                    let val = LittleEndian::read_f32(new_val);
                                                    let cmp = LittleEndian::read_f32(cmp_bytes);
                                                    !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                "double" => {
                                                    let val = LittleEndian::read_f64(new_val);
                                                    let cmp = LittleEndian::read_f64(cmp_bytes);
                                                    !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                                }
                                                _ => false,
                                            };
                                        } else {
                                            pass_filter = match filter_request.data_type.as_str() {
                                                _ => compare_values!(
                                                    new_val,
                                                    old_val,
                                                    filter_request.filter_method.as_str()
                                                ),
                                            };
                                        }
                                        if pass_filter {
                                            serialized_data.extend_from_slice(
                                                &(address + offset).to_le_bytes(),
                                            );
                                            serialized_data.extend_from_slice(new_val);
                                            found_count.fetch_add(1, Ordering::SeqCst);
                                        }
                                    }
                                } else {
                                    break;
                                }
                            }
                        } else {
                            while offset + usize_size + size <= data_buffer.len() {
                                let address = match data_buffer.get(offset..offset + usize_size) {
                                    Some(slice) => usize::from_le_bytes(
                                        slice.try_into().expect("Invalid address format"),
                                    ),
                                    None => break,
                                };
                                offset += usize_size;

                                let old_val = &data_buffer[offset..offset + size];
                                offset += size;

                                let mut new_val_vec: Vec<u8> = vec![0; size];
                                let nread = match native_bridge::read_process_memory_with_handle(
                                    pid,
                                    address as *mut libc::c_void,
                                    size,
                                    &mut new_val_vec,
                                    tokio_handle.as_ref().as_ref(),
                                ) {
                                    Ok(nread) => nread,
                                    Err(_) => {
                                        continue;
                                    }
                                };

                                if nread != size as isize {
                                    println!("Incomplete read at address {:x}", address);
                                    continue;
                                }
                                let new_val: &[u8] = &new_val_vec;

                                let mut pass_filter: bool = false;
                                if filter_request.filter_method.as_str() == "exact" {
                                    if exact_bytes == new_val {
                                        pass_filter = true;
                                    }
                                } else if filter_request.filter_method.as_str() == "range" {
                                    // Range filter: check if value is between min and max
                                    let min_bytes = &exact_bytes;
                                    let max_bytes = match &filter_request.pattern_max {
                                        Some(max_pattern) => match hex::decode(max_pattern) {
                                            Ok(bytes) => bytes,
                                            Err(_) => continue,
                                        },
                                        None => continue,
                                    };
                                    
                                    pass_filter = match filter_request.data_type.as_str() {
                                        "int8" => {
                                            let val = new_val[0] as i8;
                                            let min = i8::from_le_bytes([min_bytes[0]]);
                                            let max = i8::from_le_bytes([max_bytes[0]]);
                                            val >= min && val <= max
                                        }
                                        "uint8" => {
                                            let val = new_val[0];
                                            val >= min_bytes[0] && val <= max_bytes[0]
                                        }
                                        "int16" => {
                                            let val = LittleEndian::read_i16(new_val);
                                            let min = LittleEndian::read_i16(min_bytes);
                                            let max = LittleEndian::read_i16(&max_bytes);
                                            val >= min && val <= max
                                        }
                                        "uint16" => {
                                            let val = LittleEndian::read_u16(new_val);
                                            let min = LittleEndian::read_u16(min_bytes);
                                            let max = LittleEndian::read_u16(&max_bytes);
                                            val >= min && val <= max
                                        }
                                        "int32" => {
                                            let val = LittleEndian::read_i32(new_val);
                                            let min = LittleEndian::read_i32(min_bytes);
                                            let max = LittleEndian::read_i32(&max_bytes);
                                            val >= min && val <= max
                                        }
                                        "uint32" => {
                                            let val = LittleEndian::read_u32(new_val);
                                            let min = LittleEndian::read_u32(min_bytes);
                                            let max = LittleEndian::read_u32(&max_bytes);
                                            val >= min && val <= max
                                        }
                                        "int64" => {
                                            let val = LittleEndian::read_i64(new_val);
                                            let min = LittleEndian::read_i64(min_bytes);
                                            let max = LittleEndian::read_i64(&max_bytes);
                                            val >= min && val <= max
                                        }
                                        "uint64" => {
                                            let val = LittleEndian::read_u64(new_val);
                                            let min = LittleEndian::read_u64(min_bytes);
                                            let max = LittleEndian::read_u64(&max_bytes);
                                            val >= min && val <= max
                                        }
                                        "float" => {
                                            let val = LittleEndian::read_f32(new_val);
                                            let min = LittleEndian::read_f32(min_bytes);
                                            let max = LittleEndian::read_f32(&max_bytes);
                                            !val.is_nan() && val >= min && val <= max
                                        }
                                        "double" => {
                                            let val = LittleEndian::read_f64(new_val);
                                            let min = LittleEndian::read_f64(min_bytes);
                                            let max = LittleEndian::read_f64(&max_bytes);
                                            !val.is_nan() && val >= min && val <= max
                                        }
                                        _ => false,
                                    };
                                } else if filter_request.filter_method.as_str() == "greater_or_equal" || filter_request.filter_method.as_str() == "less_than" {
                                    // Greater than or equal / Less than filter
                                    let cmp_bytes = &exact_bytes;
                                    let is_greater_or_equal = filter_request.filter_method.as_str() == "greater_or_equal";
                                    
                                    pass_filter = match filter_request.data_type.as_str() {
                                        "int8" => {
                                            let val = new_val[0] as i8;
                                            let cmp = i8::from_le_bytes([cmp_bytes[0]]);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "uint8" => {
                                            let val = new_val[0];
                                            let cmp = cmp_bytes[0];
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "int16" => {
                                            let val = LittleEndian::read_i16(new_val);
                                            let cmp = LittleEndian::read_i16(cmp_bytes);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "uint16" => {
                                            let val = LittleEndian::read_u16(new_val);
                                            let cmp = LittleEndian::read_u16(cmp_bytes);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "int32" => {
                                            let val = LittleEndian::read_i32(new_val);
                                            let cmp = LittleEndian::read_i32(cmp_bytes);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "uint32" => {
                                            let val = LittleEndian::read_u32(new_val);
                                            let cmp = LittleEndian::read_u32(cmp_bytes);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "int64" => {
                                            let val = LittleEndian::read_i64(new_val);
                                            let cmp = LittleEndian::read_i64(cmp_bytes);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "uint64" => {
                                            let val = LittleEndian::read_u64(new_val);
                                            let cmp = LittleEndian::read_u64(cmp_bytes);
                                            if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "float" => {
                                            let val = LittleEndian::read_f32(new_val);
                                            let cmp = LittleEndian::read_f32(cmp_bytes);
                                            !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        "double" => {
                                            let val = LittleEndian::read_f64(new_val);
                                            let cmp = LittleEndian::read_f64(cmp_bytes);
                                            !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                        }
                                        _ => false,
                                    };
                                } else {
                                    pass_filter = match filter_request.data_type.as_str() {
                                        _ => compare_values!(
                                            new_val,
                                            old_val,
                                            filter_request.filter_method.as_str()
                                        ),
                                    };
                                }

                                if pass_filter {
                                    serialized_data.extend_from_slice(&address.to_le_bytes());
                                    serialized_data.extend_from_slice(&new_val);
                                    found_count.fetch_add(1, Ordering::SeqCst);
                                }
                            }
                        }
                    }

                    // rewrite file
                    let mut file = match OpenOptions::new()
                        .write(true)
                        .truncate(true)
                        .open(file_path)
                    {
                        Ok(file) => file,
                        Err(e) => {
                            *error_occurred = true;
                            *error_msg = format!("Failed to open file for writing: {}", e);
                            return;
                        }
                    };

                    let number: u32 = 0x00000001;
                    if let Err(e) = file.write_all(&number.to_le_bytes()) {
                        *error_occurred = true;
                        *error_msg = format!("Failed to write status flag: {}", e);
                        return;
                    }

                    if let Err(e) = file.write_all(&serialized_data) {
                        *error_occurred = true;
                        *error_msg = format!("Failed to write data: {}", e);
                        return;
                    }
                });
            }

            new_positions = if found_count.load(Ordering::SeqCst) < 1_000_000 {
                let results: Vec<(usize, String)> = paths
                    .par_iter()
                    .flat_map(|file_path| {
                        let mut file = match File::open(file_path) {
                            Ok(file) => file,
                            Err(e) => {
                                eprintln!("Failed to open file {:?}: {}", file_path, e);
                                return Vec::new();
                            }
                        };

                        let mut flag = [0u8; 4];
                        if let Err(e) = file.read_exact(&mut flag) {
                            eprintln!("Failed to read flag from {:?}: {}", file_path, e);
                            return Vec::new();
                        }

                        if u32::from_le_bytes(flag) != 0x00000001 {
                            return Vec::new();
                        }

                        let mut data = Vec::new();
                        if let Err(e) = file.read_to_end(&mut data) {
                            eprintln!("Failed to read data from {:?}: {}", file_path, e);
                            return Vec::new();
                        }

                        let mut local_results = Vec::new();
                        let mut offset = 0;
                        while offset + std::mem::size_of::<usize>() + size <= data.len() {
                            let address = usize::from_le_bytes(
                                data[offset..offset + std::mem::size_of::<usize>()]
                                    .try_into()
                                    .unwrap(),
                            );
                            offset += std::mem::size_of::<usize>();
                            let value = hex::encode(&data[offset..offset + size]);
                            offset += size;
                            local_results.push((address, value));
                        }

                        local_results
                    })
                    .collect();
                results
            } else {
                Vec::new()
            };
            new_positions.par_sort_unstable_by_key(|&(address, _)| address);
        } else if let Some(positions) = global_positions.get(&filter_request.scan_id) {
            // For exact scan: use existing processed_count for consistency
            
            if do_suspend {
                unsafe {
                    is_suspend_success = native_bridge::suspend_process(pid);
                }
            }
            let tokio_handle_clone = Arc::clone(&tokio_handle);
            let results: Result<Vec<_>, _> = positions
                .par_iter()
                .enumerate()
                .map(|(_index, (address, value))| {
                    let tokio_handle = Arc::clone(&tokio_handle_clone);
                    // Calculate the correct size based on data type instead of pattern length
                    let size = match filter_request.data_type.as_str() {
                        "int8" | "uint8" => 1,
                        "int16" | "uint16" => 2,
                        "int32" | "uint32" | "float" => 4,
                        "int64" | "uint64" | "double" => 8,
                        "bytes" => hex::decode(&filter_request.pattern).map(|bytes| bytes.len()).unwrap_or(1),
                        _ => value.len() / 2, // For string, use the original value length
                    };
                    
                    let mut buffer: Vec<u8> = vec![0; size];
                    let _nread = match native_bridge::read_process_memory_with_handle(
                        pid,
                        *address as *mut libc::c_void,
                        size,
                        &mut buffer,
                        tokio_handle.as_ref().as_ref(),
                    ) {
                        Ok(nread) => nread,
                        Err(_err) => -1,
                    };

                    if _nread == -1 {
                        // Update progress count even for failed reads
                        processed_count.fetch_add(1, Ordering::Relaxed);
                        return Ok(None);
                    }

                    if filter_request.data_type == "regex" {
                        let regex_pattern = &filter_request.pattern;
                        let re = match Regex::new(regex_pattern) {
                            Ok(re) => re,
                            Err(_) => {
                                processed_count.fetch_add(1, Ordering::Relaxed);
                                return Ok(None);
                            }
                        };
                        if re.is_match(&buffer) {
                            found_count.fetch_add(1, Ordering::SeqCst);
                            processed_count.fetch_add(1, Ordering::Relaxed);
                            return Ok(Some((*address, hex::encode(&buffer))));
                        }
                        processed_count.fetch_add(1, Ordering::Relaxed);
                        return Ok(None);
                    } else {
                        if filter_request.filter_method == "exact" {
                            let result = hex::decode(&filter_request.pattern);
                            let bytes = match result {
                                Ok(bytes) => bytes,
                                Err(_) => {
                                    processed_count.fetch_add(1, Ordering::Relaxed);
                                    return Err("Invalid hex pattern".to_string());
                                }
                            };
                            if buffer == bytes {
                                found_count.fetch_add(1, Ordering::SeqCst);
                                processed_count.fetch_add(1, Ordering::Relaxed);
                                return Ok(Some((*address, hex::encode(&buffer))));
                            }
                            processed_count.fetch_add(1, Ordering::Relaxed);
                            return Ok(None);
                        } else if filter_request.filter_method == "range" {
                            // Range filter for non-unknown scans
                            let min_bytes = match hex::decode(&filter_request.pattern) {
                                Ok(bytes) => bytes,
                                Err(_) => {
                                    processed_count.fetch_add(1, Ordering::Relaxed);
                                    return Err("Invalid hex min pattern".to_string());
                                }
                            };
                            let max_bytes = match &filter_request.pattern_max {
                                Some(max_pattern) => match hex::decode(max_pattern) {
                                    Ok(bytes) => bytes,
                                    Err(_) => {
                                        processed_count.fetch_add(1, Ordering::Relaxed);
                                        return Err("Invalid hex max pattern".to_string());
                                    }
                                },
                                None => {
                                    processed_count.fetch_add(1, Ordering::Relaxed);
                                    return Err("Range filter requires pattern_max".to_string());
                                }
                            };
                            
                            let pass_filter = match filter_request.data_type.as_str() {
                                "int8" => {
                                    let val = buffer[0] as i8;
                                    let min = i8::from_le_bytes([min_bytes[0]]);
                                    let max = i8::from_le_bytes([max_bytes[0]]);
                                    val >= min && val <= max
                                }
                                "uint8" => {
                                    let val = buffer[0];
                                    val >= min_bytes[0] && val <= max_bytes[0]
                                }
                                "int16" => {
                                    let val = LittleEndian::read_i16(&buffer);
                                    let min = LittleEndian::read_i16(&min_bytes);
                                    let max = LittleEndian::read_i16(&max_bytes);
                                    val >= min && val <= max
                                }
                                "uint16" => {
                                    let val = LittleEndian::read_u16(&buffer);
                                    let min = LittleEndian::read_u16(&min_bytes);
                                    let max = LittleEndian::read_u16(&max_bytes);
                                    val >= min && val <= max
                                }
                                "int32" => {
                                    let val = LittleEndian::read_i32(&buffer);
                                    let min = LittleEndian::read_i32(&min_bytes);
                                    let max = LittleEndian::read_i32(&max_bytes);
                                    val >= min && val <= max
                                }
                                "uint32" => {
                                    let val = LittleEndian::read_u32(&buffer);
                                    let min = LittleEndian::read_u32(&min_bytes);
                                    let max = LittleEndian::read_u32(&max_bytes);
                                    val >= min && val <= max
                                }
                                "int64" => {
                                    let val = LittleEndian::read_i64(&buffer);
                                    let min = LittleEndian::read_i64(&min_bytes);
                                    let max = LittleEndian::read_i64(&max_bytes);
                                    val >= min && val <= max
                                }
                                "uint64" => {
                                    let val = LittleEndian::read_u64(&buffer);
                                    let min = LittleEndian::read_u64(&min_bytes);
                                    let max = LittleEndian::read_u64(&max_bytes);
                                    val >= min && val <= max
                                }
                                "float" => {
                                    let val = LittleEndian::read_f32(&buffer);
                                    let min = LittleEndian::read_f32(&min_bytes);
                                    let max = LittleEndian::read_f32(&max_bytes);
                                    !val.is_nan() && val >= min && val <= max
                                }
                                "double" => {
                                    let val = LittleEndian::read_f64(&buffer);
                                    let min = LittleEndian::read_f64(&min_bytes);
                                    let max = LittleEndian::read_f64(&max_bytes);
                                    !val.is_nan() && val >= min && val <= max
                                }
                                _ => false,
                            };
                            
                            if pass_filter {
                                found_count.fetch_add(1, Ordering::SeqCst);
                                processed_count.fetch_add(1, Ordering::Relaxed);
                                return Ok(Some((*address, hex::encode(&buffer))));
                            }
                            processed_count.fetch_add(1, Ordering::Relaxed);
                            return Ok(None);
                        } else if filter_request.filter_method == "greater_or_equal" || filter_request.filter_method == "less_than" {
                            // Greater than or equal / Less than filter for non-unknown scans
                            let cmp_bytes = match hex::decode(&filter_request.pattern) {
                                Ok(bytes) => bytes,
                                Err(_) => {
                                    processed_count.fetch_add(1, Ordering::Relaxed);
                                    return Err("Invalid hex pattern".to_string());
                                }
                            };
                            let is_greater_or_equal = filter_request.filter_method == "greater_or_equal";
                            
                            let pass_filter = match filter_request.data_type.as_str() {
                                "int8" => {
                                    let val = buffer[0] as i8;
                                    let cmp = i8::from_le_bytes([cmp_bytes[0]]);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "uint8" => {
                                    let val = buffer[0];
                                    let cmp = cmp_bytes[0];
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "int16" => {
                                    let val = LittleEndian::read_i16(&buffer);
                                    let cmp = LittleEndian::read_i16(&cmp_bytes);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "uint16" => {
                                    let val = LittleEndian::read_u16(&buffer);
                                    let cmp = LittleEndian::read_u16(&cmp_bytes);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "int32" => {
                                    let val = LittleEndian::read_i32(&buffer);
                                    let cmp = LittleEndian::read_i32(&cmp_bytes);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "uint32" => {
                                    let val = LittleEndian::read_u32(&buffer);
                                    let cmp = LittleEndian::read_u32(&cmp_bytes);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "int64" => {
                                    let val = LittleEndian::read_i64(&buffer);
                                    let cmp = LittleEndian::read_i64(&cmp_bytes);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "uint64" => {
                                    let val = LittleEndian::read_u64(&buffer);
                                    let cmp = LittleEndian::read_u64(&cmp_bytes);
                                    if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "float" => {
                                    let val = LittleEndian::read_f32(&buffer);
                                    let cmp = LittleEndian::read_f32(&cmp_bytes);
                                    !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                "double" => {
                                    let val = LittleEndian::read_f64(&buffer);
                                    let cmp = LittleEndian::read_f64(&cmp_bytes);
                                    !val.is_nan() && if is_greater_or_equal { val >= cmp } else { val < cmp }
                                }
                                _ => false,
                            };
                            
                            if pass_filter {
                                found_count.fetch_add(1, Ordering::SeqCst);
                                processed_count.fetch_add(1, Ordering::Relaxed);
                                return Ok(Some((*address, hex::encode(&buffer))));
                            }
                            processed_count.fetch_add(1, Ordering::Relaxed);
                            return Ok(None);
                        } else {
                            let result = hex::decode(&value);
                            let bytes = match result {
                                Ok(bytes) => bytes,
                                Err(_) => {
                                    return Err("Invalid hex pattern in stored value".to_string());
                                }
                            };
                            let pass_filter: bool;

                            pass_filter = match filter_request.data_type.as_str() {
                                "int8" => {
                                    let old_val = i8::from_le_bytes(bytes.try_into().unwrap());
                                    let val = i8::from_le_bytes(buffer.clone().try_into().unwrap());
                                    
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "uint8" => {
                                    let old_val = u8::from_le_bytes(bytes.try_into().unwrap());
                                    let val = u8::from_le_bytes(buffer.clone().try_into().unwrap());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "int16" => {
                                    let old_val = i16::from_le_bytes(bytes.try_into().unwrap());
                                    let val =
                                        i16::from_le_bytes(buffer.clone().try_into().unwrap());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "uint16" => {
                                    let old_val = u16::from_le_bytes(bytes.try_into().unwrap());
                                    let val =
                                        u16::from_le_bytes(buffer.clone().try_into().unwrap());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "int32" => {
                                    let old_val = i32::from_le_bytes(bytes.try_into().unwrap());
                                    let val =
                                        i32::from_le_bytes(buffer.clone().try_into().unwrap());
                                    
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "uint32" => {
                                    let old_val = u32::from_le_bytes(bytes.try_into().unwrap());
                                    let val =
                                        u32::from_le_bytes(buffer.clone().try_into().unwrap());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "int64" => {
                                    let old_val = i64::from_le_bytes(bytes.try_into().unwrap());
                                    let val =
                                        i64::from_le_bytes(buffer.clone().try_into().unwrap());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "uint64" => {
                                    let old_val = u64::from_le_bytes(bytes.try_into().unwrap());
                                    let val =
                                        u64::from_le_bytes(buffer.clone().try_into().unwrap());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "float" => {
                                    let old_val = LittleEndian::read_f32(&bytes);
                                    let val = LittleEndian::read_f32(&buffer.clone());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "double" => {
                                    let old_val = LittleEndian::read_f64(&bytes);
                                    let val = LittleEndian::read_f64(&buffer.clone());
                                    compare_values!(
                                        val,
                                        old_val,
                                        filter_request.filter_method.as_str()
                                    )
                                }
                                "utf-8" => {
                                    let old_val = str::from_utf8(&bytes).unwrap_or("");
                                    let val = str::from_utf8(&buffer).unwrap_or("");
                                    match filter_request.filter_method.as_str() {
                                        "changed" => val != old_val,
                                        "unchanged" => val == old_val,
                                        _ => false,
                                    }
                                }
                                "utf-16" => {
                                    let buffer_u16: Vec<u16> = buffer
                                        .clone()
                                        .chunks_exact(2)
                                        .map(|b| u16::from_ne_bytes([b[0], b[1]]))
                                        .collect();
                                    match filter_request.filter_method.as_str() {
                                        "changed" => {
                                            let old_value: Vec<u16> = hex::decode(&value)
                                                .unwrap()
                                                .chunks_exact(2)
                                                .map(|b| u16::from_ne_bytes([b[0], b[1]]))
                                                .collect();
                                            buffer_u16 != old_value
                                        }
                                        "unchanged" => {
                                            let old_value: Vec<u16> = hex::decode(&value)
                                                .unwrap()
                                                .chunks_exact(2)
                                                .map(|b| u16::from_ne_bytes([b[0], b[1]]))
                                                .collect();
                                            buffer_u16 == old_value
                                        }
                                        _ => false,
                                    }
                                }
                                "aob" => match filter_request.filter_method.as_str() {
                                    "changed" => buffer != bytes,
                                    "unchanged" => buffer == bytes,
                                    _ => false,
                                },
                                _ => false,
                            };

                            if pass_filter {
                                found_count.fetch_add(1, Ordering::SeqCst);
                                processed_count.fetch_add(1, Ordering::Relaxed);
                                return Ok(Some((*address, hex::encode(&buffer))));
                            }
                        }
                    }
                    
                    // Update progress count for items that don't pass filter
                    processed_count.fetch_add(1, Ordering::Relaxed);
                    
                    Ok(None)
                })
                .collect();

            match results {
                Ok(results) => {
                    new_positions = results.into_iter().filter_map(|x| x).collect();
                }
                Err(_) => {
                    let do_play = GLOBAL_PROCESS_STATE.write().unwrap();
                    if do_suspend && is_suspend_success && *do_play {
                        unsafe {
                            native_bridge::resume_process(pid);
                        }
                    }
                    return Err("Failed to process filter results".to_string());
                }
            }
        } else {
            return Err("Scan ID not found".to_string());
        }
        let do_play = GLOBAL_PROCESS_STATE.write().unwrap();
        if do_suspend && is_suspend_success && *do_play {
            unsafe {
                native_bridge::resume_process(pid);
            }
        }
        global_positions.insert(filter_request.scan_id.clone(), new_positions.clone());

        // Update filter progress to completed
        {
            let mut global_filter_progress = GLOBAL_FILTER_PROGRESS.write().unwrap();
            if let Some(progress) = global_filter_progress.get_mut(&filter_id) {
                progress.is_filtering = false;
                progress.progress_percentage = 100.0;
                progress.current_region = Some(format!("Filter completed. Found {} results", found_count.load(Ordering::SeqCst)));
            }
        }
        
        Ok(())
}

#[derive(Serialize)]
struct Region {
    start_address: String,
    end_address: String,
    protection: String,
    file_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EnumerateRegionsQuery {
    pub include_file_path: Option<bool>,
}

pub async fn enumerate_regions_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    include_file_path: bool,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Check if WASM mode is enabled
    if wasm_bridge::is_wasm_mode() {
        // In WASM mode, return regions using Cetus-style enumeration
        // This returns 2 regions if an initial snapshot exists:
        // 1. Live linear memory (heap)
        // 2. Initial snapshot (frozen at initialization)
        let regions = wasm_bridge::get_wasm_regions_json();
        let result = json!({ "regions": regions });
        let result_string = result.to_string();
        let response = Response::builder()
            .header("Content-Type", "application/json")
            .body(hyper::Body::from(result_string))
            .unwrap();
        return Ok(response);
    }

    let pid = pid_state.lock().unwrap();

    if let Some(pid) = *pid {
        let mut count: usize = 0;
        let region_info_ptr = unsafe { 
            native_bridge::enumerate_regions(pid, &mut count, include_file_path) 
        };

        let mut regions = Vec::new();

        if !region_info_ptr.is_null() && count > 0 {
            let region_info_slice = unsafe { std::slice::from_raw_parts(region_info_ptr, count) };

            for i in 0..count {
                let region_info = &region_info_slice[i];
                let file_path = if !region_info.pathname.is_null() {
                    Some(unsafe { CStr::from_ptr(region_info.pathname).to_string_lossy().into_owned() })
                } else {
                    None
                };

                let region = Region {
                    start_address: format!("{:x}", region_info.start),
                    end_address: format!("{:x}", region_info.end),
                    protection: format_protection(region_info.protection),
                    file_path,
                };
                regions.push(region);
            }

            // Free allocated memory
            unsafe { native_bridge::free_region_info(region_info_ptr, count) };
        }

        let result = json!({ "regions": regions });
        let result_string = result.to_string();
        let response = Response::builder()
            .header("Content-Type", "application/json")
            .body(hyper::Body::from(result_string))
            .unwrap();
        Ok(response)
    } else {
        let response = Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(hyper::Body::from("Pid not set"))
            .unwrap();
        Ok(response)
    }
}

/// Format protection bits to string (e.g., "rwx", "r-x", etc.)
fn format_protection(protection: u32) -> String {
    let mut prot = String::with_capacity(3);
    prot.push(if protection & 1 != 0 { 'r' } else { '-' });
    prot.push(if protection & 2 != 0 { 'w' } else { '-' });
    prot.push(if protection & 4 != 0 { 'x' } else { '-' });
    prot
}

pub async fn enumerate_process_handler() -> Result<impl Reply, Rejection> {
    let mut count: usize = 0;
    let process_info_ptr = unsafe { native_bridge::enumerate_processes(&mut count) };
    let process_info_slice = unsafe { std::slice::from_raw_parts(process_info_ptr, count) };

    let mut json_array = Vec::new();
    for i in 0..count {
        let process_name = unsafe {
            CStr::from_ptr(process_info_slice[i].processname)
                .to_string_lossy()
                .into_owned()
        };
        json_array.push(json!({
            "pid": process_info_slice[i].pid,
            "processname": process_name
        }));
        unsafe { libc::free(process_info_slice[i].processname as *mut libc::c_void) };
    }

    // for cdylib
    if count == 0 {
        let pid = unsafe { native_bridge::get_pid_native() };
        json_array.push(json!({
            "pid": pid,
            "processname": "self".to_string()
        }));
    } else {
        unsafe {
            libc::free(process_info_ptr as *mut libc::c_void);
        }
    }

    let json_response = warp::reply::json(&json_array);
    Ok(json_response)
}

pub async fn enumerate_modules_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Check if WASM mode is enabled - return WASM module info (Cetus-style)
    if wasm_bridge::is_wasm_mode() {
        let modules = wasm_bridge::get_wasm_modules_json();
        let response = ApiResponse::success(json!({ "modules": modules }));
        return Ok(warp::reply::json(&response));
    }

    match pid_state.lock() {
        Ok(pid) => {
            if let Some(pid) = *pid {
                match native_bridge::enum_modules(pid) {
                    Ok(modules) => {
                        let response = ApiResponse::success(json!({ "modules": modules }));
                        Ok(warp::reply::json(&response))
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to enumerate modules: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            } else {
                let response = ApiResponse::<Value>::error("Process not attached".to_string());
                Ok(warp::reply::json(&response))
            }
        }
        Err(_) => {
            let response = ApiResponse::<Value>::error("Failed to acquire process state lock".to_string());
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn enumerate_threads_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    // In WASM mode, return empty threads list (WASM has no native threads)
    if wasm_bridge::is_wasm_mode() {
        let response = ApiResponse::success(json!({ "threads": Vec::<serde_json::Value>::new() }));
        return Ok(warp::reply::json(&response));
    }

    match pid_state.lock() {
        Ok(pid) => {
            if let Some(pid) = *pid {
                match native_bridge::enum_threads(pid) {
                    Ok(threads) => {
                        let response = ApiResponse::success(json!({ "threads": threads }));
                        Ok(warp::reply::json(&response))
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to enumerate threads: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            } else {
                let response = ApiResponse::<Value>::error("Process not attached".to_string());
                Ok(warp::reply::json(&response))
            }
        }
        Err(_) => {
            let response = ApiResponse::<Value>::error("Failed to acquire process state lock".to_string());
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn enumerate_symbols_handler(
    module_base: usize,
    pid_state: Arc<Mutex<Option<i32>>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    // In WASM mode, return symbols from Cetus-style instrumentation
    if wasm_bridge::is_wasm_mode() {
        let symbols = wasm_bridge::get_wasm_symbols_json();
        let response = ApiResponse::success(json!({ "symbols": symbols }));
        return Ok(warp::reply::json(&response));
    }

    let pid = pid_state.lock().unwrap();
    if let Some(pid) = *pid {
        match native_bridge::enum_symbols(pid, module_base) {
            Ok(symbols) => {
                let response = ApiResponse::success(json!({ "symbols": symbols }));
                Ok(warp::reply::json(&response))
            }
            Err(error) => {
                // Instead of returning 500, return success with empty symbols and a message
                info!("No symbols found for module at 0x{:X}: {}", module_base, error);
                let response = ApiResponse::success_with_message(
                    json!({ "symbols": Vec::<serde_json::Value>::new() }),
                    format!("No symbols found: {}", error)
                );
                Ok(warp::reply::json(&response))
            }
        }
    } else {
        let response = ApiResponse::<Value>::error("No process attached".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn disassemble_handler(
    req: request::DisassembleRequest,
    state: Arc<Mutex<Option<i32>>>,
) -> Result<impl Reply, Rejection> {
    let pid = match state.lock().unwrap().as_ref() {
        Some(pid) => *pid,
        None => {
            return Ok(warp::reply::with_status(
                warp::reply::json(&json!({
                    "success": false,
                    "message": "No process is attached"
                })),
                warp::http::StatusCode::BAD_REQUEST,
            ));
        }
    };

    // Read memory from the specified address
    let mut buffer = vec![0u8; req.size];
    
    // Use /proc/pid/mem for Linux/Android systems during disassembly
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let read_result = native_bridge::read_process_memory_with_method(
        pid,
        req.address as *mut libc::c_void,
        req.size,
        &mut buffer,
        1, // mode 1 = /proc/pid/mem (no thread stop needed)
    );
    
    // Use regular memory reading for other platforms
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let read_result = native_bridge::read_process_memory(
        pid,
        req.address as *mut libc::c_void,
        req.size,
        &mut buffer,
    );

    match read_result {
        Ok(_) => {
            // Disassemble the read memory
            let disassembled = util::disassemble_internal(
                buffer.as_ptr(),
                buffer.len(),
                req.address,
                &req.architecture,
            );

            // Parse metadata from disassembly result
            let mut actual_size = req.size; // Default to requested size
            let mut clean_disassembly = String::new();
            
            for line in disassembled.lines() {
                if line.starts_with("__METADATA__|") {
                    // Parse metadata line: __METADATA__|actual_size:240|requested_size:256
                    if let Some(actual_part) = line.split('|').find(|s| s.starts_with("actual_size:")) {
                        if let Some(size_str) = actual_part.strip_prefix("actual_size:") {
                            if let Ok(size) = size_str.parse::<usize>() {
                                actual_size = size;
                            }
                        }
                    }
                } else {
                    // Regular instruction line
                    clean_disassembly.push_str(line);
                    clean_disassembly.push('\n');
                }
            }

            let response = json!({
                "success": true,
                "address": format!("0x{:x}", req.address),
                "size": actual_size,  // Return actual size, not requested size
                "requested_size": req.size,  // Also provide requested size for reference
                "architecture": req.architecture,
                "disassembly": clean_disassembly.trim_end()  // Remove trailing newline
            });

            Ok(warp::reply::with_status(
                warp::reply::json(&response),
                warp::http::StatusCode::OK,
            ))
        }
        Err(e) => {
            let response = json!({
                "success": false,
                "message": format!("Failed to read memory: {}", e)
            });

            Ok(warp::reply::with_status(
                warp::reply::json(&response),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

pub async fn explore_directory_handler(
    req: request::ExploreDirectoryRequest,
) -> Result<impl Reply, Rejection> {
    let decoded_path = percent_decode_str(&req.path)
        .decode_utf8_lossy()
        .into_owned();

    let c_path = match CString::new(decoded_path.clone()) {
        Ok(path) => path,
        Err(_) => {
            return Ok(warp::reply::with_status(
                warp::reply::json(&json!({
                    "error": "Invalid path: contains null byte",
                    "path": decoded_path,
                    "max_depth": req.max_depth
                })),
                warp::http::StatusCode::BAD_REQUEST,
            ))
        }
    };

    let result = panic::catch_unwind(|| unsafe {
        let result_ptr = native_bridge::explore_directory(c_path.as_ptr(), req.max_depth as c_int);
        if result_ptr.is_null() {
            return Err("Null pointer returned from explore_directory");
        }
        let result_str = CStr::from_ptr(result_ptr).to_string_lossy().into_owned();
        libc::free(result_ptr as *mut libc::c_void);
        Ok(result_str)
    });

    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            return Ok(warp::reply::with_status(
                warp::reply::json(&json!({
                    "error": err,
                    "path": decoded_path,
                    "max_depth": req.max_depth
                })),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
        Err(_) => {
            return Ok(warp::reply::with_status(
                warp::reply::json(&json!({
                    "error": "Process panicked during directory exploration",
                    "path": decoded_path,
                    "max_depth": req.max_depth
                })),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    };

    if result.starts_with("Error:") {
        return Ok(warp::reply::with_status(
            warp::reply::json(&json!({
                "error": result,
                "path": decoded_path,
                "max_depth": req.max_depth
            })),
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    match panic::catch_unwind(|| util::parse_directory_structure(&result)) {
        Ok(items) => Ok(warp::reply::with_status(
            warp::reply::json(&items),
            warp::http::StatusCode::OK,
        )),
        Err(_) => Ok(warp::reply::with_status(
            warp::reply::json(&json!({
                "error": "Process panicked during parsing of directory structure",
                "path": decoded_path,
                "max_depth": req.max_depth
            })),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

pub async fn read_file_handler(req: request::ReadFileRequest) -> Result<Response<Body>, Rejection> {
    let decoded_path = percent_decode_str(&req.path)
        .decode_utf8_lossy()
        .into_owned();

    let c_path = CString::new(decoded_path.clone()).unwrap();
    let mut size: usize = 0;
    let mut error_ptr: *mut c_char = std::ptr::null_mut();

    let data_ptr = unsafe {
        native_bridge::read_file(
            c_path.as_ptr(),
            &mut size as *mut usize,
            &mut error_ptr as *mut *mut c_char,
        )
    };

    if !error_ptr.is_null() {
        let error_message = unsafe { CStr::from_ptr(error_ptr).to_string_lossy().into_owned() };
        unsafe { libc::free(error_ptr as *mut c_void) };
        return Ok(Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from(error_message))
            .unwrap());
    }

    if data_ptr.is_null() || size == 0 {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("File not found or empty"))
            .unwrap());
    }

    let data = unsafe { slice::from_raw_parts(data_ptr as *const u8, size) }.to_vec();
    unsafe { libc::free(data_ptr as *mut c_void) };

    Ok(Response::builder()
        .header("Content-Type", "application/octet-stream")
        .body(Body::from(data))
        .unwrap())
}

pub async fn upload_file_handler(
    path: String,
    body: Bytes,
) -> Result<impl Reply, Rejection> {
    let decoded_path = percent_decode_str(&path)
        .decode_utf8_lossy()
        .into_owned();

    // Write file using std::fs
    match std::fs::write(&decoded_path, &body) {
        Ok(_) => {
            Ok(warp::reply::with_status(
                warp::reply::json(&json!({
                    "success": true,
                    "path": decoded_path,
                    "size": body.len()
                })),
                StatusCode::OK,
            ))
        }
        Err(e) => {
            Ok(warp::reply::with_status(
                warp::reply::json(&json!({
                    "success": false,
                    "error": format!("Failed to write file: {}", e),
                    "path": decoded_path
                })),
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

// ============================================================================
// Script Execution API (disabled - lua_engine removed)
// ============================================================================

pub async fn execute_script_handler(
    _pid_state: Arc<Mutex<Option<i32>>>,
    _script_request: request::ExecuteScriptRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Script execution disabled - lua_engine removed
    Ok(warp::reply::with_status(
        warp::reply::json(&request::ExecuteScriptResponse {
            success: false,
            job_id: String::new(),
            message: "Script execution is not available (lua_engine removed)".to_string(),
        }),
        StatusCode::NOT_IMPLEMENTED,
    ))
}

pub async fn script_status_handler(
    job_id: String,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Script execution disabled - lua_engine removed
    Ok(warp::reply::with_status(
        warp::reply::json(&request::ScriptStatusResponse {
            success: false,
            job_id,
            status: request::ScriptJobStatus::Failed,
            output: String::new(),
            error: Some("Script execution is not available (lua_engine removed)".to_string()),
            trace_callback_registered: false,
            files: Vec::new(),
        }),
        StatusCode::NOT_IMPLEMENTED,
    ))
}

pub async fn script_cancel_handler(
    job_id: String,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Script execution disabled - lua_engine removed
    Ok(warp::reply::with_status(
        warp::reply::json(&request::ScriptCancelResponse {
            success: false,
            message: format!("Script execution is not available (lua_engine removed). Job {} not found.", job_id),
        }),
        StatusCode::NOT_IMPLEMENTED,
    ))
}

/// Handler to disable the current script session
/// This removes all script-owned breakpoints and clears shared state
pub async fn script_disable_handler() -> Result<impl warp::Reply, warp::Rejection> {
    // Script execution disabled - lua_engine removed
    Ok(warp::reply::with_status(
        warp::reply::json(&request::ScriptDisableResponse {
            success: true,
            message: "Script execution is not available (lua_engine removed)".to_string(),
        }),
        StatusCode::OK,
    ))
}

pub async fn get_app_info_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
) -> Result<Box<dyn warp::Reply>, warp::Rejection> {
    match pid_state.lock() {
        Ok(pid) => {
            if let Some(pid) = *pid {
                let result = native_bridge::get_application_info(pid);
                match result {
                    Ok(message) => {
                        match serde_json::from_str::<Value>(&message) {
                            Ok(parsed_result) => {
                                let response = ApiResponse::success(parsed_result);
                                Ok(Box::new(warp::reply::json(&response)))
                            }
                            Err(e) => {
                                let response = ApiResponse::<Value>::error(format!("Failed to parse application info: {}", e));
                                Ok(Box::new(warp::reply::with_status(
                                    warp::reply::json(&response),
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                )))
                            }
                        }
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(e.to_string());
                        Ok(Box::new(warp::reply::with_status(
                            warp::reply::json(&response),
                            StatusCode::INTERNAL_SERVER_ERROR,
                        )))
                    }
                }
            } else {
                let response = ApiResponse::<Value>::error("Process not attached".to_string());
                Ok(Box::new(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::BAD_REQUEST,
                )))
            }
        }
        Err(_) => {
            let response = ApiResponse::<Value>::error("Failed to acquire process state lock".to_string());
            Ok(Box::new(warp::reply::with_status(
                warp::reply::json(&response),
                StatusCode::INTERNAL_SERVER_ERROR,
            )))
        }
    }
}

pub async fn set_watchpoint_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    watchpoint: request::SetWatchPointRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();

    if let Some(pid) = *pid {
        // Parse access type with enhanced support for combinations
        let _type = match watchpoint._type.to_lowercase().as_str() {
            "r" => 1,
            "w" => 2, 
            "rw" | "wr" => 3,
            "x" => 4,
            "rx" | "xr" => 5,
            "wx" | "xw" => 6,
            "rwx" | "wrx" | "xrw" | "xwr" | "rxw" | "wxr" => 7,
            "a" => 3, // backward compatibility - "a" means read/write access
            _ => {
                return Ok(warp::reply::with_status(
                    warp::reply::json(&request::SetWatchPointResponse {
                        success: false,
                        message: format!("Unknown access type '{}'. Valid types: r, w, rw, x, rx, wx, rwx, a", watchpoint._type),
                        watchpoint_id: None,
                    }),
                    StatusCode::BAD_REQUEST,
                ))
            }
        };

        // Validate watchpoint size - must be 1, 2, 4, or 8 bytes
        match watchpoint.size {
            1 | 2 | 4 | 8 => {}, // Valid sizes
            _ => {
                return Ok(warp::reply::with_status(
                    warp::reply::json(&request::SetWatchPointResponse {
                        success: false,
                        message: format!("Invalid watchpoint size {}. Valid sizes: 1, 2, 4, 8 bytes", watchpoint.size),
                        watchpoint_id: None,
                    }),
                    StatusCode::BAD_REQUEST,
                ))
            }
        }

        let result = native_bridge::set_watchpoint(pid, watchpoint.address, watchpoint.size, _type);

        let ret = match result {
            Ok(_) => {
                // Generate a unique watchpoint ID
                let watchpoint_id = format!("wp_{}_{}", watchpoint.address, chrono::Utc::now().timestamp_millis());
                Ok(warp::reply::with_status(
                    warp::reply::json(&request::SetWatchPointResponse {
                        success: true,
                        message: "Watchpoint set successfully".to_string(),
                        watchpoint_id: Some(watchpoint_id),
                    }),
                    StatusCode::OK,
                ))
            },
            Err(e) => Ok(warp::reply::with_status(
                warp::reply::json(&request::SetWatchPointResponse {
                    success: false,
                    message: format!("Failed to set watchpoint. Error: {}", e),
                    watchpoint_id: None,
                }),
                StatusCode::INTERNAL_SERVER_ERROR,
            )),
        };
        return ret;
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::SetWatchPointResponse {
                success: false,
                message: format!("Pid not set"),
                watchpoint_id: None,
            }),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn remove_watchpoint_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    watchpoint: request::RemoveWatchPointRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();

    if let Some(_pid) = *pid {
        let result = native_bridge::remove_watchpoint(watchpoint.address);

        let ret = match result {
            Ok(_) => Ok(warp::reply::with_status(
                warp::reply::json(&request::RemoveWatchPointResponse {
                    success: true,
                    message: "Remove Watchpoint set successfully".to_string(),
                }),
                StatusCode::OK,
            )),
            Err(e) => Ok(warp::reply::with_status(
                warp::reply::json(&request::RemoveWatchPointResponse {
                    success: false,
                    message: format!("Failed to remove watchpoint. Error: {}", e),
                }),
                StatusCode::INTERNAL_SERVER_ERROR,
            )),
        };
        return ret;
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::RemoveWatchPointResponse {
                success: false,
                message: format!("Pid not set"),
            }),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn list_watchpoints_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    _request: request::ListWatchPointsRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();

    if let Some(_pid) = *pid {
        // For now, return empty list as the underlying system doesn't support listing
        // In a real implementation, you would query the actual watchpoints from the debug system
        let watchpoints = Vec::new();
        
        Ok(warp::reply::with_status(
            warp::reply::json(&request::ListWatchPointsResponse {
                success: true,
                watchpoints,
                message: Some("Watchpoint listing not fully implemented".to_string()),
            }),
            StatusCode::OK,
        ))
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::ListWatchPointsResponse {
                success: false,
                watchpoints: Vec::new(),
                message: Some("Pid not set".to_string()),
            }),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn set_breakpoint_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    breakpoint: request::SetBreakPointRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();
    if let Some(pid) = *pid {
        // Handle trace file output if requested
        let trace_file_path = if breakpoint.trace_to_file {
            if let Some(ref path) = breakpoint.trace_file_path {
                // Enable trace file output
                native_bridge::enable_trace_file_output(path);
                Some(path.clone())
            } else {
                // Generate default path if not provided
                let default_path = format!("/tmp/dynadbg_trace_{}.bin", chrono::Utc::now().timestamp());
                native_bridge::enable_trace_file_output(&default_path);
                Some(default_path)
            }
        } else {
            // Disable trace file output if it was enabled
            native_bridge::disable_trace_file_output();
            None
        };

        // Handle full memory cache if requested
        // Note: Memory dump will be performed on first breakpoint hit in debugger.mm
        if breakpoint.full_memory_cache && breakpoint.trace_to_file {
            let base_path = trace_file_path.as_ref()
                .map(|p| p.trim_end_matches(".bin").to_string())
                .unwrap_or_else(|| format!("/tmp/dynadbg_trace_{}", chrono::Utc::now().timestamp()));
            
            let dump_path = format!("{}.memdump", base_path);
            let log_path = format!("{}.memlog", base_path);
            
            native_bridge::enable_full_memory_cache(&dump_path, &log_path);
        }

        

        let is_software = breakpoint.is_software.unwrap_or(false);
        let result = native_bridge::set_breakpoint(pid, breakpoint.address, breakpoint.hit_count, is_software);
        let ret = match result {
            Ok(_) => Ok(warp::reply::with_status(
                warp::reply::json(&request::SetBreakPointResponse {
                    success: true,
                    message: "Breakpoint set successfully".to_string(),
                    trace_file_path,
                }),
                StatusCode::OK,
            )),
            Err(e) => {
                // Disable trace file on error
                if breakpoint.trace_to_file {
                    native_bridge::disable_trace_file_output();
                }
                // Disable full memory cache on error
                if breakpoint.full_memory_cache {
                    native_bridge::disable_full_memory_cache();
                }
                Ok(warp::reply::with_status(
                    warp::reply::json(&request::SetBreakPointResponse {
                        success: false,
                        message: format!("Failed to set breakpoint. Error: {}", e),
                        trace_file_path: None,
                    }),
                    StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        };
        return ret;
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::SetBreakPointResponse {
                success: false,
                message: format!("Pid not set"),
                trace_file_path: None,
            }),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn remove_breakpoint_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    breakpoint: request::RemoveBreakPointRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();
    if let Some(_pid) = *pid {
        let result = native_bridge::remove_breakpoint(breakpoint.address);
        let ret = match result {
            Ok(_) => Ok(warp::reply::with_status(
                warp::reply::json(&request::RemoveBreakPointResponse {
                    success: true,
                    message: "Breakpoint removed successfully".to_string(),
                }),
                StatusCode::OK,
            )),
            Err(e) => Ok(warp::reply::with_status(
                warp::reply::json(&request::RemoveBreakPointResponse {
                    success: false,
                    message: format!("Failed to remove breakpoint. Error: {}", e),
                }),
                StatusCode::INTERNAL_SERVER_ERROR,
            )),
        };
        return ret;
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::RemoveBreakPointResponse {
                success: false,
                message: format!("Pid not set"),
            }),
            StatusCode::BAD_REQUEST,
        ))
    }
}

// Get original instruction bytes for a software breakpoint
pub async fn get_software_breakpoint_bytes_handler(
    address: usize,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Some(bytes) = native_bridge::get_software_breakpoint_original_bytes(address) {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::SoftwareBreakpointBytesResponse {
                success: true,
                address,
                original_bytes: bytes.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" "),
                size: bytes.len(),
                message: None,
            }),
            StatusCode::OK,
        ))
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::SoftwareBreakpointBytesResponse {
                success: false,
                address,
                original_bytes: String::new(),
                size: 0,
                message: Some("No software breakpoint found at this address".to_string()),
            }),
            StatusCode::NOT_FOUND,
        ))
    }
}

// Signal configuration handlers (catch/pass behavior)
pub async fn get_signal_configs_handler() -> Result<impl warp::Reply, warp::Rejection> {
    let configs = native_bridge::get_all_signal_configs();
    let config_list: Vec<request::SignalConfigEntry> = configs
        .iter()
        .map(|(signal, config)| request::SignalConfigEntry {
            signal: *signal,
            catch_signal: config.catch_signal,
            pass_signal: config.pass_signal,
        })
        .collect();
    Ok(warp::reply::with_status(
        warp::reply::json(&request::GetSignalConfigsResponse {
            success: true,
            configs: config_list,
        }),
        StatusCode::OK,
    ))
}

pub async fn set_signal_config_handler(
    request: request::SetSignalConfigRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let config = native_bridge::SignalConfig {
        catch_signal: request.catch_signal,
        pass_signal: request.pass_signal,
    };
    native_bridge::set_signal_config(request.signal, config);

    // Return updated configs list
    let configs = native_bridge::get_all_signal_configs();
    let config_entries: Vec<request::SignalConfigEntry> = configs
        .iter()
        .map(|(signal, cfg)| request::SignalConfigEntry {
            signal: *signal,
            catch_signal: cfg.catch_signal,
            pass_signal: cfg.pass_signal,
        })
        .collect();

    Ok(warp::reply::with_status(
        warp::reply::json(&request::GetSignalConfigsResponse {
            success: true,
            configs: config_entries,
        }),
        StatusCode::OK,
    ))
}

pub async fn set_all_signal_configs_handler(
    request: request::SetAllSignalConfigsRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    for entry in &request.configs {
        let config = native_bridge::SignalConfig {
            catch_signal: entry.catch_signal,
            pass_signal: entry.pass_signal,
        };
        native_bridge::set_signal_config(entry.signal, config);
    }

    // Return updated configs list
    let configs = native_bridge::get_all_signal_configs();
    let config_entries: Vec<request::SignalConfigEntry> = configs
        .iter()
        .map(|(signal, cfg)| request::SignalConfigEntry {
            signal: *signal,
            catch_signal: cfg.catch_signal,
            pass_signal: cfg.pass_signal,
        })
        .collect();

    Ok(warp::reply::with_status(
        warp::reply::json(&request::GetSignalConfigsResponse {
            success: true,
            configs: config_entries,
        }),
        StatusCode::OK,
    ))
}

pub async fn remove_signal_config_handler(
    request: request::RemoveSignalConfigRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    native_bridge::remove_signal_config(request.signal);

    // Return updated configs list
    let configs = native_bridge::get_all_signal_configs();
    let config_entries: Vec<request::SignalConfigEntry> = configs
        .iter()
        .map(|(signal, cfg)| request::SignalConfigEntry {
            signal: *signal,
            catch_signal: cfg.catch_signal,
            pass_signal: cfg.pass_signal,
        })
        .collect();

    Ok(warp::reply::with_status(
        warp::reply::json(&request::GetSignalConfigsResponse {
            success: true,
            configs: config_entries,
        }),
        StatusCode::OK,
    ))
}

// Trace status handler
pub async fn get_trace_status_handler() -> Result<impl warp::Reply, warp::Rejection> {
    let enabled = native_bridge::is_trace_file_output_enabled();
    let file_path = if enabled {
        let path = native_bridge::get_trace_file_path();
        if path.is_empty() { None } else { Some(path) }
    } else {
        None
    };
    let entry_count = native_bridge::get_trace_file_entry_count();
    let ended_by_end_address = native_bridge::is_trace_ended_by_end_address();
    
    Ok(warp::reply::with_status(
        warp::reply::json(&request::TraceStatusResponse {
            success: true,
            enabled,
            file_path,
            entry_count,
            ended_by_end_address,
            message: if ended_by_end_address {
                "Trace ended by reaching end address".to_string()
            } else if enabled { 
                format!("Trace file active with {} entries", entry_count) 
            } else { 
                "Trace file output disabled".to_string() 
            },
        }),
        StatusCode::OK,
    ))
}

// Trace file download handler
pub async fn download_trace_file_handler() -> Result<impl warp::Reply, warp::Rejection> {
    let enabled = native_bridge::is_trace_file_output_enabled();
    let file_path = native_bridge::get_trace_file_path();
    
    if file_path.is_empty() {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "application/json")
            .body(hyper::Body::from(r#"{"success":false,"message":"No trace file available"}"#))
            .unwrap());
    }
    
    // If still recording, close the file first
    if enabled {
        native_bridge::disable_trace_file_output();
    }
    
    // Read the file
    match std::fs::read(&file_path) {
        Ok(data) => {
            let filename = std::path::Path::new(&file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("trace.bin");
            
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Disposition", format!("attachment; filename=\"{}\"", filename))
                .header("X-Trace-Entry-Count", native_bridge::get_trace_file_entry_count().to_string())
                .body(hyper::Body::from(data))
                .unwrap())
        }
        Err(e) => {
            Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header("Content-Type", "application/json")
                .body(hyper::Body::from(format!(r#"{{"success":false,"message":"Failed to read trace file: {}"}}"#, e)))
                .unwrap())
        }
    }
}

pub async fn change_process_state_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    state_request: request::ChangeProcessStateRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();

    if let Some(_pid) = *pid {
        let result = if state_request.do_play {
            unsafe { native_bridge::resume_process(_pid) }
        } else {
            unsafe { native_bridge::suspend_process(_pid) }
        };

        let ret = match result {
            true => Ok(warp::reply::with_status(
                warp::reply::json(&request::ChangeProcessStateResponse {
                    success: true,
                    message: format!(
                        "Process {} successfully",
                        if state_request.do_play {
                            "resumed"
                        } else {
                            "suspend"
                        }
                    ),
                }),
                StatusCode::OK,
            )),
            false => Ok(warp::reply::with_status(
                warp::reply::json(&request::ChangeProcessStateResponse {
                    success: false,
                    message: format!("Failed to change process state. Error"),
                }),
                StatusCode::INTERNAL_SERVER_ERROR,
            )),
        };
        return ret;
    } else {
        Ok(warp::reply::with_status(
            warp::reply::json(&request::ChangeProcessStateResponse {
                success: false,
                message: "Pid not set".to_string(),
            }),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn get_process_icon_handler(
    _pid: i32,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "windows")]
    {
        
        match native_bridge::get_process_icon(_pid) {
            Ok(icon_data) => {
                let response = Response::builder()
                    .header("Content-Type", "image/png")
                    .header("Cache-Control", "public, max-age=3600")
                    .body(hyper::Body::from(icon_data))
                    .unwrap();
                Ok(response)
            }
            Err(_) => {
                // Return empty response for processes without icons
                let response = Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(hyper::Body::from("Icon not found"))
                    .unwrap();
                Ok(response)
            }
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        let response = Response::builder()
            .status(StatusCode::NOT_IMPLEMENTED)
            .body(hyper::Body::from("Icon extraction not supported on this platform"))
            .unwrap();
        Ok(response)
    }
}

pub async fn get_scan_progress_handler(
    scan_progress_request: request::ScanProgressRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let global_scan_progress = GLOBAL_SCAN_PROGRESS.read().unwrap();
    
    if let Some(progress) = global_scan_progress.get(&scan_progress_request.scan_id) {
        let response = ApiResponse::success(progress.clone());
        Ok(warp::reply::json(&response))
    } else {
        // Return default progress if scan_id not found
        let default_progress = request::ScanProgressResponse {
            scan_id: scan_progress_request.scan_id.clone(),
            progress_percentage: 0.0,
            scanned_bytes: 0,
            total_bytes: 0,
            is_scanning: false,
            current_region: None,
        };
        let response = ApiResponse::success(default_progress);
        Ok(warp::reply::json(&response))
    }
}

pub async fn get_filter_progress_handler(
    filter_progress_request: request::FilterProgressRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let global_filter_progress = GLOBAL_FILTER_PROGRESS.read().unwrap();
    
    if let Some(progress) = global_filter_progress.get(&filter_progress_request.filter_id) {
        let response = ApiResponse::success(progress.clone());
        Ok(warp::reply::json(&response))
    } else {
        // Return default progress if filter_id not found
        let default_progress = request::FilterProgressResponse {
            filter_id: filter_progress_request.filter_id.clone(),
            progress_percentage: 0.0,
            processed_results: 0,
            total_results: 0,
            is_filtering: false,
            current_region: Some("Filter not found or not started".to_string()),
        };
        let response = ApiResponse::success(default_progress);
        Ok(warp::reply::json(&response))
    }
}

pub async fn get_scan_results_handler(
    scan_results_request: request::ScanProgressRequest, // Reuse same request structure
) -> Result<impl warp::Reply, warp::Rejection> {
    // Check if scan is completed first
    let global_scan_progress = GLOBAL_SCAN_PROGRESS.read().unwrap();
    if let Some(progress) = global_scan_progress.get(&scan_results_request.scan_id) {
        if progress.is_scanning {
            let response = ApiResponse::<Value>::error("Scan is still in progress".to_string());
            return Ok(warp::reply::json(&response));
        }
    } else {
        let response = ApiResponse::<Value>::error("Scan ID not found".to_string());
        return Ok(warp::reply::json(&response));
    }
    
    // Get scan results
    let global_positions = GLOBAL_POSITIONS.read().unwrap();
    if let Some(positions) = global_positions.get(&scan_results_request.scan_id) {
        let limited_positions = &positions[..std::cmp::min(MAX_RESULTS, positions.len())];
        let total_count = positions.len();
        let is_rounded = limited_positions.len() != positions.len();
        
        let matched_addresses: Vec<serde_json::Value> = limited_positions
            .iter()
            .map(|(address, value)| {
                json!({
                    "address": address,
                    "value": value
                })
            })
            .collect();
            
        let result = json!({
            "matched_addresses": matched_addresses,
            "found": total_count,
            "is_rounded": is_rounded
        });
        
        let response = ApiResponse::success(result);
        Ok(warp::reply::json(&response))
    } else {
        let response = ApiResponse::<Value>::error("No results found for scan ID".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn stop_scan_handler(
    stop_request: request::ScanProgressRequest, // Reuse same request structure for scan_id
) -> Result<impl warp::Reply, warp::Rejection> {
    // Set stop flag for the scan
    let scan_stop_flags = SCAN_STOP_FLAGS.write().unwrap();
    if let Some(stop_flag) = scan_stop_flags.get(&stop_request.scan_id) {
        if let Ok(mut should_stop) = stop_flag.lock() {
            *should_stop = true;
        }
        
        // Update scan progress to stopped
        let mut global_scan_progress = GLOBAL_SCAN_PROGRESS.write().unwrap();
        if let Some(progress) = global_scan_progress.get_mut(&stop_request.scan_id) {
            progress.is_scanning = false;
            progress.current_region = Some("Scan stopped by user".to_string());
        }
        
        let response = ApiResponse::success(json!({
            "message": "Scan stop signal sent successfully",
            "scan_id": stop_request.scan_id
        }));
        Ok(warp::reply::json(&response))
    } else {
        let response = ApiResponse::<Value>::error("Scan ID not found or already completed".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn clear_scan_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    clear_request: request::ScanProgressRequest, // Reuse same request structure for scan_id
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = {
        let pid_guard = pid_state.lock().unwrap();
        *pid_guard
    };

    if let Some(pid) = pid {
        // Clear scan data from memory
        {
            let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
            global_positions.remove(&clear_request.scan_id);
            
            let mut global_memory = GLOBAL_MEMORY.write().unwrap();
            global_memory.remove(&clear_request.scan_id);
            
            let mut global_scan_option = GLOBAL_SCAN_OPTION.write().unwrap();
            global_scan_option.remove(&clear_request.scan_id);
            
            let mut global_scan_progress = GLOBAL_SCAN_PROGRESS.write().unwrap();
            global_scan_progress.remove(&clear_request.scan_id);
            
            let mut scan_stop_flags = SCAN_STOP_FLAGS.write().unwrap();
            scan_stop_flags.remove(&clear_request.scan_id);
        }
        
        // Clean up scan files on disk
        let mut scan_folder_path = PathBuf::from("");
        let mode = std::env::var("DBGSRV_RUNNING_MODE").unwrap_or_else(|_| "unknown".to_string());
        if mode == "embedded" {
            let cache_directory = util::get_cache_directory(pid);
            scan_folder_path = PathBuf::from(&cache_directory);
        }
        let sanitized_scan_id = clear_request.scan_id.trim().replace(" ", "_");
        scan_folder_path.push("dbgsrv-data-dir");
        scan_folder_path.push(&sanitized_scan_id);
        
        if scan_folder_path.exists() {
            match fs::remove_dir_all(&scan_folder_path) {
                Ok(_) => {
                    let response = ApiResponse::success(json!({
                        "message": "Scan data cleared successfully",
                        "scan_id": clear_request.scan_id
                    }));
                    Ok(warp::reply::json(&response))
                }
                Err(e) => {
                    let response = ApiResponse::<Value>::error(format!("Failed to remove scan directory: {}", e));
                    Ok(warp::reply::json(&response))
                }
            }
        } else {
            let response = ApiResponse::success(json!({
                "message": "Scan data cleared successfully (no files to remove)",
                "scan_id": clear_request.scan_id
            }));
            Ok(warp::reply::json(&response))
        }
    } else {
        let response = ApiResponse::<Value>::error("No process attached".to_string());
        Ok(warp::reply::json(&response))
    }
}

// New break state control handlers
pub async fn continue_execution_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    request: request::ContinueExecutionRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let _pid = pid_state.lock().unwrap();

    if let Some(_pid) = *_pid {
        // Build thread ID list (use thread_ids if present, otherwise thread_id)
        let thread_ids: Vec<u64> = if let Some(ids) = request.thread_ids {
            ids
        } else if let Some(id) = request.thread_id {
            vec![id]
        } else {
            let response = request::ContinueExecutionResponse {
                success: false,
                message: "No thread_id or thread_ids specified".to_string(),
                results: None,
            };
            return Ok(warp::reply::with_status(
                warp::reply::json(&response),
                StatusCode::BAD_REQUEST,
            ));
        };

        // Multiple threads
        if thread_ids.len() > 1 {
            let mut results: Vec<request::ThreadContinueResult> = Vec::new();
            let mut all_success = true;
            let mut success_count = 0;
            let mut fail_count = 0;

            for thread_id in &thread_ids {
                match native_bridge::continue_execution(*thread_id as libc::uintptr_t) {
                    Ok(_) => {
                        results.push(request::ThreadContinueResult {
                            thread_id: *thread_id,
                            success: true,
                            message: "Continued successfully".to_string(),
                        });
                        success_count += 1;
                    }
                    Err(e) => {
                        results.push(request::ThreadContinueResult {
                            thread_id: *thread_id,
                            success: false,
                            message: format!("Failed: {}", e),
                        });
                        all_success = false;
                        fail_count += 1;
                    }
                }
            }

            let response = request::ContinueExecutionResponse {
                success: all_success,
                message: format!(
                    "Continued {} threads ({} success, {} failed)",
                    thread_ids.len(),
                    success_count,
                    fail_count
                ),
                results: Some(results),
            };
            Ok(warp::reply::with_status(
                warp::reply::json(&response),
                if all_success { StatusCode::OK } else { StatusCode::PARTIAL_CONTENT },
            ))
        } else {
            // Single thread (backward compatibility)
            let thread_id = thread_ids[0];
            match native_bridge::continue_execution(thread_id as libc::uintptr_t) {
                Ok(_) => {
                    let response = request::ContinueExecutionResponse {
                        success: true,
                        message: format!("Execution continued successfully for thread {}", thread_id),
                        results: None,
                    };
                    Ok(warp::reply::with_status(
                        warp::reply::json(&response),
                        StatusCode::OK,
                    ))
                }
                Err(e) => {
                    let response = request::ContinueExecutionResponse {
                        success: false,
                        message: format!("Failed to continue execution for thread {}: {}", thread_id, e),
                        results: None,
                    };
                    Ok(warp::reply::with_status(
                        warp::reply::json(&response),
                        StatusCode::INTERNAL_SERVER_ERROR,
                    ))
                }
            }
        }
    } else {
        let response = request::ContinueExecutionResponse {
            success: false,
            message: "Process not attached".to_string(),
            results: None,
        };
        Ok(warp::reply::with_status(
            warp::reply::json(&response),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn single_step_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    request: request::SingleStepRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let _pid = pid_state.lock().unwrap();

    
    if let Some(_pid) = *_pid {
        match native_bridge::single_step(request.thread_id as libc::uintptr_t) {
            Ok(_) => {
                let response = request::SingleStepResponse {
                    success: true,
                    message: format!("Single step executed successfully for thread {}", request.thread_id),
                };
                Ok(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::OK,
                ))
            }
            Err(e) => {
                let response = request::SingleStepResponse {
                    success: false,
                    message: format!("Failed to execute single step for thread {}: {}", request.thread_id, e),
                };
                Ok(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
    } else {
        let response = request::SingleStepResponse {
            success: false,
            message: "Process not attached".to_string(),
        };
        Ok(warp::reply::with_status(
            warp::reply::json(&response),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn read_register_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    request: request::ReadRegisterRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let _pid = pid_state.lock().unwrap();

    if let Some(_pid) = *_pid {
        match native_bridge::read_register(request.thread_id as libc::uintptr_t, &request.register_name) {
            Ok(value) => {
                let response = request::ReadRegisterResponse {
                    success: true,
                    register_name: request.register_name.clone(),
                    value: Some(value),
                    message: format!("Register {} read successfully from thread {}", request.register_name, request.thread_id),
                };
                Ok(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::OK,
                ))
            }
            Err(e) => {
                let response = request::ReadRegisterResponse {
                    success: false,
                    register_name: request.register_name.clone(),
                    value: None,
                    message: format!("Failed to read register from thread {}: {}", request.thread_id, e),
                };
                Ok(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
    } else {
        let response = request::ReadRegisterResponse {
            success: false,
            register_name: request.register_name.clone(),
            value: None,
            message: "Process not attached".to_string(),
        };
        Ok(warp::reply::with_status(
            warp::reply::json(&response),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn write_register_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    request: request::WriteRegisterRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let _pid = pid_state.lock().unwrap();

    if let Some(_pid) = *_pid {
        match native_bridge::write_register(request.thread_id as libc::uintptr_t, &request.register_name, request.value) {
            Ok(_) => {
                let response = request::WriteRegisterResponse {
                    success: true,
                    message: format!("Register {} written successfully to thread {}", request.register_name, request.thread_id),
                };
                Ok(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::OK,
                ))
            }
            Err(e) => {
                let response = request::WriteRegisterResponse {
                    success: false,
                    message: format!("Failed to write register to thread {}: {}", request.thread_id, e),
                };
                Ok(warp::reply::with_status(
                    warp::reply::json(&response),
                    StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
    } else {
        let response = request::WriteRegisterResponse {
            success: false,
            message: "Process not attached".to_string(),
        };
        Ok(warp::reply::with_status(
            warp::reply::json(&response),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn debug_state_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    _request: request::DebugStateRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let _pid = pid_state.lock().unwrap();

    if let Some(_pid) = *_pid {
        let is_in_break_state = native_bridge::is_in_break_state();
        let response = request::DebugStateResponse {
            success: true,
            is_in_break_state,
            message: format!("Debug state: {}", 
                if is_in_break_state { "In break state" } else { "Running" }),
        };
        Ok(warp::reply::with_status(
            warp::reply::json(&response),
            StatusCode::OK,
        ))
    } else {
        let response = request::DebugStateResponse {
            success: false,
            is_in_break_state: false,
            message: "Process not attached".to_string(),
        };
        Ok(warp::reply::with_status(
            warp::reply::json(&response),
            StatusCode::BAD_REQUEST,
        ))
    }
}

pub async fn get_installed_apps_handler() -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        match native_bridge::get_installed_apps() {
            Ok(apps_json) => {
                // Parse JSON string to Value for proper response formatting
                match serde_json::from_str::<serde_json::Value>(&apps_json) {
                    Ok(apps) => {
                        let response = ApiResponse::success(json!({
                            "apps": apps
                        }));
                        Ok(warp::reply::json(&response))
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to parse apps JSON: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            }
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Failed to get installed apps: {}", e));
                Ok(warp::reply::json(&response))
            }
        }
    }
    
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let response = ApiResponse::<Value>::error("Installed apps listing not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn get_app_icon_handler(
    _request: request::GetAppIconRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        match native_bridge::get_app_icon(&_request.bundle_identifier) {
            Ok(icon_data) => {
                let response = Response::builder()
                    .header("Content-Type", "image/png")
                    .header("Cache-Control", "public, max-age=3600")
                    .body(hyper::Body::from(icon_data))
                    .unwrap();
                Ok(response)
            }
            Err(_) => {
                // Return empty response for apps without icons
                let response = Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(hyper::Body::from("Icon not found"))
                    .unwrap();
                Ok(response)
            }
        }
    }
    
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let response = Response::builder()
            .status(StatusCode::NOT_IMPLEMENTED)
            .body(hyper::Body::from("App icon extraction not supported on this platform"))
            .unwrap();
        Ok(response)
    }
}

// Spawn app via FBSSystemService (iOS/macOS)
pub async fn spawn_app_handler(
    _pid_state: Arc<Mutex<Option<i32>>>,
    _request: request::SpawnAppRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        match native_bridge::spawn_app(&_request.bundle_identifier, _request.suspended) {
            Ok(result_json) => {
                // Parse JSON string to Value for proper response formatting
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        // Auto-attach if spawn was successful and PID is valid
                        if let Some(success) = result.get("success").and_then(|v| v.as_bool()) {
                            if success {
                                if let Some(pid) = result.get("pid").and_then(|v| v.as_i64()) {
                                    if pid > 0 {
                                        // Auto-attach to the spawned process
                                        if let Ok(mut state) = pid_state.lock() {
                                            *state = Some(pid as i32);
                                            info!("Auto-attached to spawned process with PID: {}", pid);
                                        }
                                    }
                                }
                            }
                        }
                        
                        let response = ApiResponse::success(result);
                        Ok(warp::reply::json(&response))
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to parse spawn result: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            }
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Failed to spawn app: {}", e));
                Ok(warp::reply::json(&response))
            }
        }
    }
    
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let response = ApiResponse::<Value>::error("App spawn not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

// Spawn process via fork/exec (Linux)
pub async fn spawn_process_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    _request: request::SpawnProcessRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::path::Path;
        
        // Check if executable exists
        let path = Path::new(&_request.executable_path);
        if !path.exists() {
            let response = ApiResponse::<Value>::error(format!(
                "Executable not found: {}", _request.executable_path
            ));
            return Ok(warp::reply::json(&response));
        }
        
        // Use C++ native function for spawn
        let exe_cstr = match CString::new(_request.executable_path.as_str()) {
            Ok(s) => s,
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Invalid executable path: {}", e));
                return Ok(warp::reply::json(&response));
            }
        };
        
        // Convert args to CStrings
        let args_cstr: Vec<CString> = _request.args.iter()
            .filter_map(|s| CString::new(s.as_str()).ok())
            .collect();
        let args_ptrs: Vec<*const libc::c_char> = args_cstr.iter()
            .map(|s| s.as_ptr())
            .collect();
        
        let mut out_pid: libc::pid_t = 0;
        
        let result = unsafe {
            native_bridge::spawn_process_native(
                exe_cstr.as_ptr(),
                args_ptrs.as_ptr(),
                args_ptrs.len() as libc::c_int,
                &mut out_pid
            )
        };
        
        if result == 0 && out_pid > 0 {
            // Auto-attach to the spawned process
            if let Ok(mut state) = pid_state.lock() {
                *state = Some(out_pid);
                info!("Attached to spawned process with PID: {}", out_pid);
            }
            
            let response = ApiResponse::success(json!({
                "success": true,
                "pid": out_pid,
                "message": "Process spawned and stopped at entry point"
            }));
            Ok(warp::reply::json(&response))
        } else {
            let response = ApiResponse::<Value>::error(format!("Failed to spawn process, result: {}", result));
            Ok(warp::reply::json(&response))
        }
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        let response = ApiResponse::<Value>::error("Process spawn not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

// Spawn process with PTY (Linux)
pub async fn spawn_process_with_pty_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    _request: request::SpawnProcessWithPtyRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::path::Path;
        
        // Check if executable exists
        let path = Path::new(&_request.executable_path);
        if !path.exists() {
            let response = ApiResponse::<Value>::error(format!(
                "Executable not found: {}", _request.executable_path
            ));
            return Ok(warp::reply::json(&response));
        }
        
        let exe_cstr = match CString::new(_request.executable_path.as_str()) {
            Ok(s) => s,
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Invalid executable path: {}", e));
                return Ok(warp::reply::json(&response));
            }
        };
        
        let args_cstr: Vec<CString> = _request.args.iter()
            .filter_map(|s| CString::new(s.as_str()).ok())
            .collect();
        let args_ptrs: Vec<*const libc::c_char> = args_cstr.iter()
            .map(|s| s.as_ptr())
            .collect();
        
        let mut out_pid: i32 = 0;
        let mut out_pty_fd: libc::c_int = 0;
        
        let result = unsafe {
            native_bridge::spawn_process_with_pty(
                exe_cstr.as_ptr(),
                args_ptrs.as_ptr(),
                args_ptrs.len() as libc::c_int,
                &mut out_pid,
                &mut out_pty_fd
            )
        };
        
        if result == 0 && out_pid > 0 {
            if let Ok(mut state) = pid_state.lock() {
                *state = Some(out_pid);
                info!("Attached to PTY spawned process with PID: {}, PTY FD: {}", out_pid, out_pty_fd);
            }
            
            let response = ApiResponse::success(json!({
                "success": true,
                "pid": out_pid,
                "pty_fd": out_pty_fd,
                "message": "Process spawned with PTY and stopped at entry point"
            }));
            Ok(warp::reply::json(&response))
        } else {
            let response = ApiResponse::<Value>::error(format!("Failed to spawn process with PTY, result: {}", result));
            Ok(warp::reply::json(&response))
        }
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        let response = ApiResponse::<Value>::error("PTY spawn not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn pty_read_handler(
    _pty_fd: i32,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "linux")]
    {
        let mut buffer = vec![0u8; 4096];
        let bytes_read = unsafe {
            native_bridge::read_pty(
                _pty_fd,
                buffer.as_mut_ptr() as *mut libc::c_char,
                buffer.len()
            )
        };
        
        if bytes_read > 0 {
            buffer.truncate(bytes_read as usize);
            // Convert to base64 for safe JSON transport (handles binary/control chars)
            let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &buffer);
            let response = ApiResponse::success(json!({
                "data": encoded,
                "bytes": bytes_read
            }));
            Ok(warp::reply::json(&response))
        } else if bytes_read == 0 {
            // No data available
            let response = ApiResponse::success(json!({
                "data": "",
                "bytes": 0
            }));
            Ok(warp::reply::json(&response))
        } else {
            let response = ApiResponse::<Value>::error("Failed to read from PTY".to_string());
            Ok(warp::reply::json(&response))
        }
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        let response = ApiResponse::<Value>::error("PTY not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn pty_write_handler(
    _request: request::PtyWriteRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        
        let data = match CString::new(_request.data.as_str()) {
            Ok(s) => s,
            Err(_) => {
                // Handle null bytes - write raw bytes instead
                let bytes = _request.data.as_bytes();
                let bytes_written = unsafe {
                    native_bridge::write_pty(
                        _request.pty_fd,
                        bytes.as_ptr() as *const libc::c_char,
                        bytes.len()
                    )
                };
                
                if bytes_written >= 0 {
                    let response = ApiResponse::success(json!({
                        "bytes_written": bytes_written
                    }));
                    return Ok(warp::reply::json(&response));
                } else {
                    let response = ApiResponse::<Value>::error("Failed to write to PTY".to_string());
                    return Ok(warp::reply::json(&response));
                }
            }
        };
        
        let bytes_written = unsafe {
            native_bridge::write_pty(
                _request.pty_fd,
                data.as_ptr(),
                data.as_bytes().len()
            )
        };
        
        if bytes_written >= 0 {
            let response = ApiResponse::success(json!({
                "bytes_written": bytes_written
            }));
            Ok(warp::reply::json(&response))
        } else {
            let response = ApiResponse::<Value>::error("Failed to write to PTY".to_string());
            Ok(warp::reply::json(&response))
        }
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        let response = ApiResponse::<Value>::error("PTY not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn pty_resize_handler(
    _request: request::PtyResizeRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "linux")]
    {
        let result = unsafe {
            native_bridge::set_pty_size(_request.pty_fd, _request.rows, _request.cols)
        };
        
        if result == 0 {
            let response = ApiResponse::success(json!({
                "success": true
            }));
            Ok(warp::reply::json(&response))
        } else {
            let response = ApiResponse::<Value>::error("Failed to resize PTY".to_string());
            Ok(warp::reply::json(&response))
        }
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        let response = ApiResponse::<Value>::error("PTY not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn pty_close_handler(
    _pty_fd: i32,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(target_os = "linux")]
    {
        unsafe {
            native_bridge::close_pty(_pty_fd);
        }
        
        let response = ApiResponse::success(json!({
            "success": true
        }));
        Ok(warp::reply::json(&response))
    }
    
    #[cfg(not(target_os = "linux"))]
    {
        let response = ApiResponse::<Value>::error("PTY not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

pub async fn terminate_app_handler(
    _request: request::TerminateAppRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        match native_bridge::terminate_app(_request.pid) {
            Ok(success) => {
                let response = ApiResponse::success(json!({
                    "terminated": success,
                    "pid": _request.pid
                }));
                Ok(warp::reply::json(&response))
            }
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Failed to terminate app: {}", e));
                Ok(warp::reply::json(&response))
            }
        }
    }
    
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let response = ApiResponse::<Value>::error("App termination not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

// Resume suspended app (iOS/macOS)
pub async fn resume_app_handler(
    _pid_state: Arc<Mutex<Option<i32>>>,
    _request: request::ResumeAppRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        // Verify the PID matches the attached process
        let attached_pid = _pid_state.lock().unwrap();
        if let Some(current_pid) = *attached_pid {
            if current_pid != _request.pid {
                let response = ApiResponse::<Value>::error(format!(
                    "PID mismatch: requested {} but attached to {}",
                    _request.pid, current_pid
                ));
                return Ok(warp::reply::json(&response));
            }
        }
        drop(attached_pid);

        match native_bridge::resume_app(_request.pid) {
            Ok(result_json) => {
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        let response = ApiResponse::success(result);
                        Ok(warp::reply::json(&response))
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to parse resume result: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            }
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Failed to resume app: {}", e));
                Ok(warp::reply::json(&response))
            }
        }
    }
    
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let response = ApiResponse::<Value>::error("App resume not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

// Check app running status (iOS/macOS)
pub async fn get_app_running_status_handler(
    _request: request::AppRunningStatusRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        match native_bridge::get_app_running_status(&_request.bundle_identifier) {
            Ok(result_json) => {
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        let response = ApiResponse::success(result);
                        Ok(warp::reply::json(&response))
                    }
                    Err(e) => {
                        let response = ApiResponse::<Value>::error(format!("Failed to parse result: {}", e));
                        Ok(warp::reply::json(&response))
                    }
                }
            }
            Err(e) => {
                let response = ApiResponse::<Value>::error(format!("Failed to get app running status: {}", e));
                Ok(warp::reply::json(&response))
            }
        }
    }
    
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let response = ApiResponse::<Value>::error("App running status not supported on this platform".to_string());
        Ok(warp::reply::json(&response))
    }
}

// ============================================================================
// WASM Binary Dump Handlers
// ============================================================================

/// Dump entire WASM binary for Ghidra analysis
/// Returns raw binary data (application/octet-stream)
pub async fn wasm_dump_handler() -> Result<impl warp::Reply, warp::Rejection> {
    if !wasm_bridge::is_wasm_mode() {
        return Ok(Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"success":false,"error":"Not in WASM mode"}"#))
            .unwrap());
    }
    
    match wasm_bridge::dump_wasm_binary().await {
        Ok(binary) => {
            info!("WASM dump: returning {} bytes", binary.len());
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Disposition", "attachment; filename=\"module.wasm\"")
                .header("Content-Length", binary.len().to_string())
                .body(Body::from(binary))
                .unwrap())
        }
        Err(e) => {
            error!("WASM dump failed: {}", e);
            Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header("Content-Type", "application/json")
                .body(Body::from(format!(r#"{{"success":false,"error":"{}"}}"#, e)))
                .unwrap())
        }
    }
}

/// Get WASM module info
pub async fn wasm_info_handler() -> Result<impl warp::Reply, warp::Rejection> {
    if !wasm_bridge::is_wasm_mode() {
        let response = json!({
            "success": false,
            "error": "Not in WASM mode"
        });
        return Ok(warp::reply::json(&response));
    }
    
    let code_size = wasm_bridge::get_wasm_code_size();
    let module_info = wasm_bridge::get_wasm_module_info();
    
    let response = json!({
        "success": true,
        "module_info": module_info,
        "code_size": code_size,
        "has_binary": code_size > 0
    });
    
    Ok(warp::reply::json(&response))
}

/// YARA memory scan handler
/// Scans process memory using YARA rules with progress tracking
pub async fn yara_scan_handler(
    pid_state: Arc<Mutex<Option<i32>>>,
    scan_request: request::YaraScanRequest,
) -> Result<impl warp::Reply, warp::Rejection> {
    let pid = pid_state.lock().unwrap();

    let mut is_suspend_success: bool = false;
    let do_suspend = scan_request.do_suspend;
    
    if let Some(pid) = *pid {
        if do_suspend {
            unsafe {
                is_suspend_success = native_bridge::suspend_process(pid);
            }
        }

        // Compile YARA rules first to validate
        let mut compiler = yara_x::Compiler::new();
        if let Err(e) = compiler.add_source(scan_request.rule.as_str()) {
            if do_suspend && is_suspend_success {
                unsafe {
                    native_bridge::resume_process(pid);
                }
            }
            let response = request::YaraScanResponse {
                success: false,
                message: format!("YARA compilation error: {}", e),
                scan_id: scan_request.scan_id.clone(),
                matches: vec![],
                total_matches: 0,
                scanned_bytes: 0,
            };
            return Ok(warp::reply::json(&response));
        }

        // Initialize progress tracking
        let total_bytes: u64 = scan_request.address_ranges.iter()
            .map(|(start, end)| (end - start) as u64)
            .sum();
        
        {
            let mut global_scan_progress = GLOBAL_SCAN_PROGRESS.write().unwrap();
            global_scan_progress.insert(scan_request.scan_id.clone(), request::ScanProgressResponse {
                scan_id: scan_request.scan_id.clone(),
                progress_percentage: 0.0,
                scanned_bytes: 0,
                total_bytes,
                is_scanning: true,
                current_region: Some("YARA scan".to_string()),
            });
        }

        // Clear previous results
        {
            let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
            global_positions.insert(scan_request.scan_id.clone(), Vec::new());
            let mut global_memory = GLOBAL_MEMORY.write().unwrap();
            global_memory.insert(scan_request.scan_id.clone(), Vec::new());
        }

        // Create stop flag
        let stop_flag = Arc::new(Mutex::new(false));
        {
            let mut scan_stop_flags = SCAN_STOP_FLAGS.write().unwrap();
            scan_stop_flags.insert(scan_request.scan_id.clone(), stop_flag.clone());
        }

        let scan_id = scan_request.scan_id.clone();
        let address_ranges = scan_request.address_ranges.clone();
        let rule_source = scan_request.rule.clone();
        let align = scan_request.align;

        // Start background scan thread
        std::thread::spawn(move || {
            // Recompile rules in this thread
            let mut compiler = yara_x::Compiler::new();
            if compiler.add_source(rule_source.as_str()).is_err() {
                return;
            }
            let rules = compiler.build();
            let mut scanner = yara_x::Scanner::new(&rules);
            
            // Use the same types as GLOBAL_POSITIONS and GLOBAL_MEMORY
            let mut all_positions: Vec<(usize, String)> = Vec::new();
            let mut all_memory: Vec<(usize, Vec<u8>, usize, Vec<u8>, usize, bool)> = Vec::new();
            let mut scanned_bytes: u64 = 0;

            // Scan each memory region
            for (start_address, end_address) in &address_ranges {
                // Check stop flag
                if *stop_flag.lock().unwrap() {
                    break;
                }

                let size = end_address - start_address;
                if size == 0 {
                    continue;
                }

                // Read memory in chunks
                let chunk_size: usize = 16 * 1024 * 1024; // 16MB chunks
                let mut offset: usize = 0;

                while offset < size {
                    // Check stop flag
                    if *stop_flag.lock().unwrap() {
                        break;
                    }

                    let current_chunk_size = std::cmp::min(chunk_size, size - offset);
                    let current_address = start_address + offset;
                    
                    let mut buffer = vec![0u8; current_chunk_size];
                    let bytes_read = match native_bridge::read_process_memory(
                        pid,
                        current_address as *mut c_void,
                        current_chunk_size,
                        &mut buffer,
                    ) {
                        Ok(n) => n as usize,
                        Err(_) => 0,
                    };

                    if bytes_read > 0 {
                        buffer.truncate(bytes_read);
                        scanned_bytes += bytes_read as u64;

                        // Update progress
                        {
                            if let Ok(mut progress) = GLOBAL_SCAN_PROGRESS.write() {
                                if let Some(p) = progress.get_mut(&scan_id) {
                                    p.scanned_bytes = scanned_bytes;
                                    p.progress_percentage = (scanned_bytes as f64 / total_bytes as f64) * 100.0;
                                }
                            }
                        }

                        // Scan buffer with YARA
                        if let Ok(results) = scanner.scan(&buffer) {
                            for matched_rule in results.matching_rules() {
                                for pattern in matched_rule.patterns() {
                                    for m in pattern.matches() {
                                        let match_offset = m.range().start;
                                        let match_len = m.range().len();
                                        let match_address = current_address + match_offset;
                                        
                                        // Apply alignment filter
                                        if align > 1 && match_address % align != 0 {
                                            continue;
                                        }
                                        
                                        // Get matched data (exact match length)
                                        if match_offset + match_len <= buffer.len() {
                                            // Create hex string with rule info
                                            let matched_data = &buffer[match_offset..match_offset + match_len];
                                            let rule_info = format!("{}::{}", matched_rule.identifier(), pattern.identifier());
                                            let hex_value = format!("{}|{}", rule_info, hex::encode(matched_data));
                                            
                                            all_positions.push((match_address, hex_value.clone()));
                                            
                                            // For GLOBAL_MEMORY: (address, current_bytes, size, original_bytes, value_size, is_freeze)
                                            all_memory.push((
                                                match_address,
                                                matched_data.to_vec(),
                                                match_len,
                                                matched_data.to_vec(),
                                                match_len,
                                                false,
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    }

                    offset += current_chunk_size;
                }
            }

            // Resume process if suspended
            if do_suspend && is_suspend_success {
                unsafe {
                    native_bridge::resume_process(pid);
                }
            }

            // Store results
            {
                let mut global_positions = GLOBAL_POSITIONS.write().unwrap();
                global_positions.insert(scan_id.clone(), all_positions);
                let mut global_memory = GLOBAL_MEMORY.write().unwrap();
                global_memory.insert(scan_id.clone(), all_memory);
            }

            // Mark scan as complete
            {
                if let Ok(mut progress) = GLOBAL_SCAN_PROGRESS.write() {
                    if let Some(p) = progress.get_mut(&scan_id) {
                        p.scanned_bytes = scanned_bytes;
                        p.progress_percentage = 100.0;
                        p.is_scanning = false;
                    }
                }
            }
        });

        // Return immediately with scan started response
        let response = request::YaraScanResponse {
            success: true,
            message: "YARA scan started".to_string(),
            scan_id: scan_request.scan_id,
            matches: vec![],
            total_matches: 0,
            scanned_bytes: 0,
        };

        Ok(warp::reply::json(&response))
    } else {
        let response = request::YaraScanResponse {
            success: false,
            message: "No process attached".to_string(),
            scan_id: scan_request.scan_id,
            matches: vec![],
            total_matches: 0,
            scanned_bytes: 0,
        };
        Ok(warp::reply::json(&response))
    }
}
