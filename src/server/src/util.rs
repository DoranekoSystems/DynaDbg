use crate::native_bridge;
use capstone::prelude::*;
use libc::{self, c_char};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::CString;
use std::num::ParseIntError;
use std::path::Path;
use std::slice;
use std::str;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileItem {
    item_type: String,
    name: String,
    size: Option<i64>,
    last_opened: Option<i64>,
    children: Option<Vec<FileItem>>,
}

pub fn read_memory_64(pid: i32, address: u64) -> Result<u64, String> {
    let mut buffer = [0u8; 8];
    native_bridge::read_process_memory(pid, address as *mut libc::c_void, 8, &mut buffer).map_err(
        |e| {
            format!(
                "Failed to read 64-bit memory at address {:#x}: {}",
                address, e
            )
        },
    )?;
    Ok(u64::from_le_bytes(buffer))
}

pub fn _read_memory_32(pid: i32, address: u32) -> Result<u32, String> {
    let mut buffer = [0u8; 4];
    native_bridge::read_process_memory(pid, address as *mut libc::c_void, 4, &mut buffer).map_err(
        |e| {
            format!(
                "Failed to read 32-bit memory at address {:#x}: {}",
                address, e
            )
        },
    )?;
    Ok(u32::from_le_bytes(buffer))
}

pub fn _evaluate_expression(expr: &str) -> Result<isize, String> {
    let re = Regex::new(r"(\d+)\s*([+\-*/])\s*(\d+)").unwrap();
    if let Some(caps) = re.captures(expr) {
        let a: isize = caps[1]
            .parse()
            .map_err(|_| "Invalid number in expression".to_string())?;
        let b: isize = caps[3]
            .parse()
            .map_err(|_| "Invalid number in expression".to_string())?;
        match &caps[2] {
            "+" => Ok(a + b),
            "-" => Ok(a - b),
            "*" => Ok(a * b),
            "/" => Ok(a / b),
            _ => Err("Unsupported operation".to_string()),
        }
    } else {
        expr.parse().map_err(|_| "Invalid expression".to_string())
    }
}

pub fn resolve_nested_address(
    pid: i32,
    nested_addr: &str,
    modules: &[serde_json::Value],
) -> Result<u64, String> {
    let re = Regex::new(r"(\[)|(\])|([^\[\]]+)").map_err(|e| format!("Regex error: {}", e))?;
    let mut stack = Vec::new();
    let mut current_expr = String::new();

    for cap in re.captures_iter(nested_addr) {
        if cap.get(1).is_some() {
            if !current_expr.is_empty() {
                stack.push(current_expr);
                current_expr = String::new();
            }
            current_expr.push('[');
        } else if cap.get(2).is_some() {
            if !current_expr.is_empty() {
                let inner_value = resolve_single_level_address(&current_expr, modules)?;
                let memory_value = read_memory_64(pid, inner_value)?;
                if let Some(mut prev_expr) = stack.pop() {
                    prev_expr.push_str(&format!("0x{:X}", memory_value));
                    current_expr = prev_expr;
                } else {
                    current_expr = format!("0x{:X}", memory_value);
                }
            }
            current_expr.push(']');
        } else if let Some(m) = cap.get(3) {
            current_expr.push_str(m.as_str());
        }
    }

    resolve_single_level_address(&current_expr, modules)
}

pub fn resolve_single_level_address(
    addr: &str,
    modules: &[serde_json::Value],
) -> Result<u64, String> {
    let resolved_addr = preemptive_module_resolution(addr, modules)?;

    let re = Regex::new(r"(?:([+\-*])?\s*)(0x[\da-fA-F]+|\d+)")
        .map_err(|e| format!("Regex error: {}", e))?;

    let mut current_address: u64 = 0;
    let mut first_item = true;

    for cap in re.captures_iter(&resolved_addr) {
        let op = cap.get(1).map(|m| m.as_str());
        let value_str = cap.get(2).unwrap().as_str();
        let value = parse_number(value_str)?;

        if first_item {
            current_address = value;
            first_item = false;
        } else if let Some(operator) = op {
            match operator {
                "+" => current_address = current_address.wrapping_add(value),
                "-" => current_address = current_address.wrapping_sub(value),
                "*" => current_address = current_address.wrapping_mul(value),
                _ => return Err(format!("Invalid operation: {}", operator)),
            }
        } else {
            return Err("Expected operator, but none found".to_string());
        }
    }

    if first_item {
        current_address = parse_number(&resolved_addr)?;
    }

    Ok(current_address)
}

fn preemptive_module_resolution(
    addr: &str,
    modules: &[serde_json::Value],
) -> Result<String, String> {
    let mut resolved = String::from(addr);
    for module in modules {
        if let (Some(name), Some(base)) = (module["modulename"].as_str(), module["base"].as_u64()) {
            let path = Path::new(name);
            if let Some(file_name) = path.file_name() {
                let file_name_str = file_name.to_string_lossy();
                let escaped_name = regex::escape(&file_name_str);
                let re = Regex::new(&format!(r"\b{}\b", escaped_name))
                    .map_err(|e| format!("Regex error: {}", e))?;

                resolved = re
                    .replace_all(&resolved, |caps: &regex::Captures| {
                        let matched = caps.get(0).unwrap().as_str();
                        if resolved[caps.get(0).unwrap().end()..].starts_with('.') {
                            matched.to_string()
                        } else {
                            format!("0x{:X}", base)
                        }
                    })
                    .to_string();
            }
        }
    }
    Ok(resolved)
}

fn parse_number(s: &str) -> Result<u64, String> {
    let s = s.trim();
    if s.starts_with("0x") {
        u64::from_str_radix(&s[2..], 16)
    } else {
        s.parse::<u64>()
    }
    .map_err(|e: ParseIntError| format!("Invalid number '{}': {}", s, e))
}

pub fn resolve_symbolic_address(
    pid: i32,
    symbolic_addr: &str,
    modules: &[serde_json::Value],
) -> Result<usize, String> {
    let resolved = resolve_nested_address(pid, symbolic_addr, modules)?;
    Ok(resolved as usize)
}
pub fn parse_directory_structure(raw_data: &str) -> Vec<FileItem> {
    let mut root_items = Vec::new();
    let mut stack: Vec<*mut FileItem> = Vec::new();

    for line in raw_data.lines() {
        let indent = line.chars().take_while(|&c| c == ' ').count() / 2;
        let content = line.trim_start();

        if let Some((item_type, rest)) = content.split_once(':') {
            let new_item = match item_type {
                "dir" => FileItem {
                    item_type: "directory".to_string(),
                    name: rest.to_string(),
                    size: None,
                    last_opened: None,
                    children: None,
                },
                "file" => {
                    let parts: Vec<&str> = rest.split(',').collect();
                    if parts.len() == 3 {
                        FileItem {
                            item_type: "file".to_string(),
                            name: parts[0].to_string(),
                            size: parts[1].parse().ok(),
                            last_opened: parts[2].parse().ok(),
                            children: None,
                        }
                    } else {
                        continue;
                    }
                }
                _ => continue,
            };

            while stack.len() > indent {
                stack.pop();
            }

            if stack.is_empty() {
                root_items.push(new_item);

                if item_type == "dir" {
                    let last_ptr = root_items.last_mut().unwrap() as *mut FileItem;
                    stack.push(last_ptr);
                }
            } else {
                unsafe {
                    let parent = stack.last_mut().unwrap();
                    if let Some(children) = &mut (**parent).children {
                        children.push(new_item);
                    } else {
                        (**parent).children = Some(vec![new_item]);
                    }

                    if item_type == "dir" {
                        let last_ptr = (**parent).children.as_mut().unwrap().last_mut().unwrap()
                            as *mut FileItem;
                        stack.push(last_ptr);
                    }
                }
            }
        }
    }

    root_items
}

pub fn get_cache_directory(pid: i32) -> String {
    let result = native_bridge::get_application_info(pid);
    let parsed_result: Value = serde_json::from_str(&result.unwrap()).unwrap();
    let target_os = env!("TARGET_OS");
    if target_os == "ios" {
        parsed_result["CachesDirectory"]
            .to_string()
            .replace("\"", "")
    } else {
        "".to_string()
    }
}

/// Internal disassemble function for Rust code
pub fn disassemble_internal(bytecode: *const u8, length: usize, address: u64, arch: &str) -> String {
    let bytes = unsafe { slice::from_raw_parts(bytecode, length) };
    
    let cs = match arch {
        "x86_64" => {
            Capstone::new()
                .x86()
                .mode(arch::x86::ArchMode::Mode64)
                .detail(true)
                .build()
                .expect("Failed to create Capstone object for x86_64")
        },
        "arm64" | "aarch64" => {
            Capstone::new()
                .arm64()
                .mode(arch::arm64::ArchMode::Arm)
                .detail(true)
                .build()
                .expect("Failed to create Capstone object for ARM64")
        },
        _ => {
            return format!("Unsupported architecture: {}", arch);
        }
    };

    let instructions = match cs.disasm_all(bytes, address) {
        Ok(instructions) => instructions,
        Err(e) => return format!("Failed to disassemble: {}", e),
    };
    
    let mut result = String::new();
    let mut actual_bytes_covered = 0usize;

    for i in instructions.iter() {
        let mnemonic = i.mnemonic().unwrap_or("");
        let op_str = i.op_str().unwrap_or("");
        
        // Format the raw bytes as hex string
        let instruction_bytes = i.bytes();
        let bytes_hex = instruction_bytes.iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<String>>()
            .join(" ");
        
        // Track actual bytes covered by instructions
        actual_bytes_covered += instruction_bytes.len();
        
        // Format: address|bytes|mnemonic operands
        result.push_str(&format!("{:#x}|{}|{} {}\n", i.address(), bytes_hex, mnemonic, op_str));
    }

    // Add metadata about actual vs requested size at the end
    result.push_str(&format!("__METADATA__|actual_size:{}|requested_size:{}\n", actual_bytes_covered, length));

    result
}

/// FFI function to disassemble bytecode from C++ with a base address
/// This version takes the actual PC address for correct relative address calculation
/// Returns a C string that must be freed with free_string()
#[no_mangle]
pub extern "C" fn disassemble_at_address(bytecode: *const u8, length: usize, address: u64) -> *mut c_char {
    if bytecode.is_null() || length == 0 {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { slice::from_raw_parts(bytecode, length) };
    
    // Default to ARM64 for iOS/macOS
    let cs = match Capstone::new()
        .arm64()
        .mode(arch::arm64::ArchMode::Arm)
        .detail(true)
        .build()
    {
        Ok(cs) => cs,
        Err(_) => return std::ptr::null_mut(),
    };

    let instructions = match cs.disasm_all(bytes, address) {
        Ok(instructions) => instructions,
        Err(_) => return std::ptr::null_mut(),
    };

    // Get the first instruction's mnemonic and operands
    if let Some(instr) = instructions.iter().next() {
        let mnemonic = instr.mnemonic().unwrap_or("");
        let op_str = instr.op_str().unwrap_or("");
        let result = if op_str.is_empty() {
            mnemonic.to_string()
        } else {
            format!("{} {}", mnemonic, op_str)
        };
        
        match CString::new(result) {
            Ok(c_str) => c_str.into_raw(),
            Err(_) => std::ptr::null_mut(),
        }
    } else {
        std::ptr::null_mut()
    }
}

/// FFI function to disassemble bytecode from C++ (legacy, uses address 0)
/// Returns a C string that must be freed with free_string()
#[no_mangle]
pub extern "C" fn disassemble(bytecode: *const u8, length: usize) -> *mut c_char {
    disassemble_at_address(bytecode, length, 0)
}

/// FFI function to free a string allocated by Rust
#[no_mangle]
pub extern "C" fn free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            let _ = CString::from_raw(s);
        }
    }
}
