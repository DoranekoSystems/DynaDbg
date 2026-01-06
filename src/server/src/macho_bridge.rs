// macho_bridge.rs
// Rust FFI bindings for MachOKit Swift library

use libc::{c_char, c_void};
use std::ffi::{CStr, CString};
use std::path::Path;

// Logging callback from Swift
#[no_mangle]
pub extern "C" fn rust_log_from_swift(level: i32, message: *const c_char) {
    if message.is_null() {
        return;
    }
    let msg = unsafe {
        match CStr::from_ptr(message).to_str() {
            Ok(s) => s,
            Err(_) => return,
        }
    };
    match level {
        0 => log::info!("[MachOBridge] {}", msg),
        1 => log::warn!("[MachOBridge] {}", msg),
        2 => log::error!("[MachOBridge] {}", msg),
        3 => log::debug!("[MachOBridge] {}", msg),
        _ => log::info!("[MachOBridge] {}", msg),
    }
}

/// Symbol type from MachO
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MachOSymbolType {
    Undefined = 0,
    Absolute = 1,
    Section = 2,
    Indirect = 3,
}

/// C-compatible MachO symbol structure
#[repr(C)]
#[derive(Debug)]
pub struct CMachOSymbol {
    pub name: *const c_char,
    pub address: u64,
    pub size: u64,
    pub symbol_type: u8,
}

/// C-compatible MachO section structure
#[repr(C)]
#[derive(Debug)]
pub struct CMachOSection {
    pub sectname: *const c_char,
    pub segname: *const c_char,
    pub addr: u64,
    pub size: u64,
    pub offset: u32,
    pub flags: u32,
}

/// C-compatible MachO segment structure
#[repr(C)]
#[derive(Debug)]
pub struct CMachOSegment {
    pub segname: *const c_char,
    pub vmaddr: u64,
    pub vmsize: u64,
    pub fileoff: u64,
    pub filesize: u64,
    pub maxprot: i32,
    pub initprot: i32,
    pub nsects: u32,
}

/// C-compatible MachO parse result structure
#[repr(C)]
pub struct CMachOParseResult {
    pub success: bool,
    pub error_message: *const c_char,
    pub is_64bit: bool,
    pub cpu_type: i32,
    pub cpu_subtype: i32,
    pub file_type: u32,
    pub ncmds: u32,
    pub symbols: *mut CMachOSymbol,
    pub symbol_count: u64,
    pub segments: *mut CMachOSegment,
    pub segment_count: u64,
    pub sections: *mut CMachOSection,
    pub section_count: u64,
}

// Opaque pointer type for Swift results
type MachoResultPtr = *mut c_void;

// FFI declarations for MachOKit Swift bridge
#[cfg(any(target_os = "macos", target_os = "ios"))]
extern "C" {
    // Cache management
    fn macho_load_dyld_cache(path: *const c_char) -> bool;
    fn macho_load_system_dyld_cache() -> bool;
    fn macho_unload_dyld_cache();
    
    // Parse functions (return opaque pointer)
    fn macho_parse_file(path: *const c_char) -> MachoResultPtr;
    fn macho_parse_from_dyld_cache(image_path: *const c_char) -> MachoResultPtr;
    
    // Result accessors
    fn macho_result_success(result: MachoResultPtr) -> bool;
    fn macho_result_error_message(result: MachoResultPtr) -> *mut c_char;
    fn macho_result_is_64bit(result: MachoResultPtr) -> bool;
    fn macho_result_cpu_type(result: MachoResultPtr) -> i32;
    fn macho_result_cpu_subtype(result: MachoResultPtr) -> i32;
    fn macho_result_file_type(result: MachoResultPtr) -> i32;
    fn macho_result_ncmds(result: MachoResultPtr) -> u32;
    
    // Symbol accessors
    fn macho_result_symbol_count(result: MachoResultPtr) -> u64;
    fn macho_result_symbol_name(result: MachoResultPtr, index: u64) -> *mut c_char;
    fn macho_result_symbol_address(result: MachoResultPtr, index: u64) -> u64;
    fn macho_result_symbol_size(result: MachoResultPtr, index: u64) -> u64;
    fn macho_result_symbol_type(result: MachoResultPtr, index: u64) -> u8;
    fn macho_result_symbol_is_external(result: MachoResultPtr, index: u64) -> bool;
    fn macho_result_symbol_is_private_external(result: MachoResultPtr, index: u64) -> bool;
    fn macho_result_symbol_is_weak_def(result: MachoResultPtr, index: u64) -> bool;
    fn macho_result_symbol_is_weak_ref(result: MachoResultPtr, index: u64) -> bool;
    fn macho_result_symbol_is_thumb(result: MachoResultPtr, index: u64) -> bool;
    fn macho_result_symbol_section_index(result: MachoResultPtr, index: u64) -> u8;
    fn macho_result_symbol_library_ordinal(result: MachoResultPtr, index: u64) -> i32;
    fn macho_result_symbol_source(result: MachoResultPtr, index: u64) -> u8;
    
    // Segment accessors
    fn macho_result_segment_count(result: MachoResultPtr) -> u64;
    fn macho_result_segment_name(result: MachoResultPtr, index: u64) -> *mut c_char;
    fn macho_result_segment_vmaddr(result: MachoResultPtr, index: u64) -> u64;
    fn macho_result_segment_vmsize(result: MachoResultPtr, index: u64) -> u64;
    
    // Section accessors
    fn macho_result_section_count(result: MachoResultPtr) -> u64;
    fn macho_result_section_name(result: MachoResultPtr, index: u64) -> *mut c_char;
    fn macho_result_section_segname(result: MachoResultPtr, index: u64) -> *mut c_char;
    fn macho_result_section_addr(result: MachoResultPtr, index: u64) -> u64;
    fn macho_result_section_size(result: MachoResultPtr, index: u64) -> u64;
    
    // Free functions
    fn macho_free_result(result: MachoResultPtr);
    fn macho_get_dyld_cache_image_count() -> u64;
    fn macho_get_dyld_cache_image_path(index: u64) -> *mut c_char;
    fn macho_free_string(s: *mut c_char);
    
    // Module size functions
    fn macho_get_module_size_by_name(name: *const c_char) -> u64;
    fn macho_get_module_size_by_address(address: u64) -> u64;
    fn macho_get_module_size_from_cache(image_path: *const c_char) -> u64;
    
    // Loaded image enumeration (for current process)
    fn macho_get_loaded_image_count() -> u32;
    fn macho_get_loaded_image_path(index: u32) -> *mut c_char;
    fn macho_get_loaded_image_base(index: u32) -> u64;
    fn macho_get_loaded_image_size(index: u32) -> u64;
    fn macho_get_loaded_image_slide(index: u32) -> i64;
}

/// Symbol source - where the symbol was found
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MachOSymbolSource {
    SymbolTable = 0,
    ExportTrie = 1,
}

/// Rust-friendly MachO symbol with extended metadata
#[derive(Debug, Clone)]
pub struct MachOSymbol {
    pub name: String,
    pub address: u64,
    pub size: u64,
    pub symbol_type: MachOSymbolType,
    pub is_external: bool,
    pub is_private_external: bool,
    pub is_weak_def: bool,
    pub is_weak_ref: bool,
    pub is_thumb: bool,
    pub section_index: u8,
    pub library_ordinal: i32,
    pub source: MachOSymbolSource,
}

/// Rust-friendly MachO section
#[derive(Debug, Clone)]
pub struct MachOSection {
    pub sectname: String,
    pub segname: String,
    pub addr: u64,
    pub size: u64,
    pub offset: u32,
    pub flags: u32,
}

/// Rust-friendly MachO segment
#[derive(Debug, Clone)]
pub struct MachOSegment {
    pub segname: String,
    pub vmaddr: u64,
    pub vmsize: u64,
    pub fileoff: u64,
    pub filesize: u64,
    pub maxprot: i32,
    pub initprot: i32,
    pub nsects: u32,
}

/// MachO parse result
#[derive(Debug, Clone)]
pub struct MachOParseResult {
    pub is_64bit: bool,
    pub cpu_type: i32,
    pub cpu_subtype: i32,
    pub file_type: u32,
    pub ncmds: u32,
    pub symbols: Vec<MachOSymbol>,
    pub segments: Vec<MachOSegment>,
    pub sections: Vec<MachOSection>,
}

/// Check if a path is a system library (in dyld shared cache)
pub fn is_system_library(path: &str) -> bool {
    let system_prefixes = [
        "/System/Library/",
        "/usr/lib/",
        "/System/Cryptexes/",
        "/System/iOSSupport/",
    ];
    
    system_prefixes.iter().any(|prefix| path.starts_with(prefix))
}

/// Load the system dyld shared cache
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn load_system_dyld_cache() -> Result<(), String> {
    let success = unsafe { macho_load_system_dyld_cache() };
    if success {
        Ok(())
    } else {
        Err("Failed to load system dyld cache".to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn load_system_dyld_cache() -> Result<(), String> {
    Err("Dyld cache is only available on macOS/iOS".to_string())
}

/// Load a specific dyld cache file
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn load_dyld_cache(path: &str) -> Result<(), String> {
    let c_path = CString::new(path).map_err(|e| e.to_string())?;
    let success = unsafe { macho_load_dyld_cache(c_path.as_ptr()) };
    if success {
        Ok(())
    } else {
        Err(format!("Failed to load dyld cache from: {}", path))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn load_dyld_cache(_path: &str) -> Result<(), String> {
    Err("Dyld cache is only available on macOS/iOS".to_string())
}

/// Unload the currently loaded dyld cache
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn unload_dyld_cache() {
    unsafe { macho_unload_dyld_cache() };
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn unload_dyld_cache() {}

/// Get the number of images in the loaded dyld cache
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_dyld_cache_image_count() -> u64 {
    unsafe { macho_get_dyld_cache_image_count() }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_dyld_cache_image_count() -> u64 {
    0
}

/// Get the path of an image in the dyld cache by index
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_dyld_cache_image_path(index: u64) -> Option<String> {
    let ptr = unsafe { macho_get_dyld_cache_image_path(index) };
    if ptr.is_null() {
        return None;
    }
    
    let result = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    
    unsafe { macho_free_string(ptr) };
    
    Some(result)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_dyld_cache_image_path(_index: u64) -> Option<String> {
    None
}

// MARK: - Module Size Functions

/// Get module size by name (for current process only)
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_module_size_by_name(name: &str) -> u64 {
    let c_name = match CString::new(name) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    unsafe { macho_get_module_size_by_name(c_name.as_ptr()) }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_module_size_by_name(_name: &str) -> u64 {
    0
}

/// Get module size by base address (for current process only)
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_module_size_by_address(address: u64) -> u64 {
    unsafe { macho_get_module_size_by_address(address) }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_module_size_by_address(_address: u64) -> u64 {
    0
}

/// Get module size from dyld cache by path
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_module_size_from_cache(image_path: &str) -> u64 {
    let c_path = match CString::new(image_path) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    unsafe { macho_get_module_size_from_cache(c_path.as_ptr()) }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_module_size_from_cache(_image_path: &str) -> u64 {
    0
}

// MARK: - Loaded Image Enumeration (for current process)

/// Loaded image information
#[derive(Debug, Clone)]
pub struct LoadedImageInfo {
    pub path: String,
    pub base: u64,
    pub size: u64,
    pub slide: i64,
}

/// Get all loaded images in the current process
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_loaded_images() -> Vec<LoadedImageInfo> {
    let count = unsafe { macho_get_loaded_image_count() };
    let mut images = Vec::with_capacity(count as usize);
    
    for i in 0..count {
        let path_ptr = unsafe { macho_get_loaded_image_path(i) };
        let path = if path_ptr.is_null() {
            String::new()
        } else {
            let p = unsafe { CStr::from_ptr(path_ptr) }.to_string_lossy().into_owned();
            unsafe { macho_free_string(path_ptr) };
            p
        };
        
        let base = unsafe { macho_get_loaded_image_base(i) };
        let size = unsafe { macho_get_loaded_image_size(i) };
        let slide = unsafe { macho_get_loaded_image_slide(i) };
        
        images.push(LoadedImageInfo { path, base, size, slide });
    }
    
    images
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_loaded_images() -> Vec<LoadedImageInfo> {
    Vec::new()
}

/// Get the count of loaded images
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get_loaded_image_count() -> u32 {
    unsafe { macho_get_loaded_image_count() }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_loaded_image_count() -> u32 {
    0
}

/// List all images in the loaded dyld cache
pub fn list_dyld_cache_images() -> Vec<String> {
    let count = get_dyld_cache_image_count();
    (0..count)
        .filter_map(|i| get_dyld_cache_image_path(i))
        .collect()
}

/// Helper function to convert opaque result pointer to Rust result using accessor functions
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe fn convert_parse_result(result_ptr: MachoResultPtr) -> Result<MachOParseResult, String> {
    if result_ptr.is_null() {
        return Err("Null result from parser".to_string());
    }
    
    if !macho_result_success(result_ptr) {
        let error_ptr = macho_result_error_message(result_ptr);
        let error_msg = if error_ptr.is_null() {
            "Unknown error".to_string()
        } else {
            let msg = CStr::from_ptr(error_ptr).to_string_lossy().into_owned();
            macho_free_string(error_ptr);
            msg
        };
        macho_free_result(result_ptr);
        return Err(error_msg);
    }
    
    // Get basic info
    let is_64bit = macho_result_is_64bit(result_ptr);
    let cpu_type = macho_result_cpu_type(result_ptr);
    let cpu_subtype = macho_result_cpu_subtype(result_ptr);
    let file_type = macho_result_file_type(result_ptr) as u32;
    let ncmds = macho_result_ncmds(result_ptr);
    
    // Convert symbols
    let symbol_count = macho_result_symbol_count(result_ptr);
    let mut symbols = Vec::with_capacity(symbol_count as usize);
    for i in 0..symbol_count {
        let name_ptr = macho_result_symbol_name(result_ptr, i);
        let name = if name_ptr.is_null() {
            String::new()
        } else {
            let s = CStr::from_ptr(name_ptr).to_string_lossy().into_owned();
            macho_free_string(name_ptr);
            s
        };
        
        let address = macho_result_symbol_address(result_ptr, i);
        let size = macho_result_symbol_size(result_ptr, i);
        let sym_type = macho_result_symbol_type(result_ptr, i);
        let source = macho_result_symbol_source(result_ptr, i);
        
        symbols.push(MachOSymbol {
            name,
            address,
            size, // Calculated from LC_FUNCTION_STARTS
            symbol_type: match sym_type {
                0 => MachOSymbolType::Undefined,
                1 => MachOSymbolType::Absolute,
                2 => MachOSymbolType::Section,
                3 | 4 => MachOSymbolType::Indirect,
                _ => MachOSymbolType::Undefined,
            },
            is_external: macho_result_symbol_is_external(result_ptr, i),
            is_private_external: macho_result_symbol_is_private_external(result_ptr, i),
            is_weak_def: macho_result_symbol_is_weak_def(result_ptr, i),
            is_weak_ref: macho_result_symbol_is_weak_ref(result_ptr, i),
            is_thumb: macho_result_symbol_is_thumb(result_ptr, i),
            section_index: macho_result_symbol_section_index(result_ptr, i),
            library_ordinal: macho_result_symbol_library_ordinal(result_ptr, i),
            source: if source == 1 { MachOSymbolSource::ExportTrie } else { MachOSymbolSource::SymbolTable },
        });
    }
    
    // Convert segments
    let segment_count = macho_result_segment_count(result_ptr);
    let mut segments = Vec::with_capacity(segment_count as usize);
    for i in 0..segment_count {
        let name_ptr = macho_result_segment_name(result_ptr, i);
        let segname = if name_ptr.is_null() {
            String::new()
        } else {
            let s = CStr::from_ptr(name_ptr).to_string_lossy().into_owned();
            macho_free_string(name_ptr);
            s
        };
        
        segments.push(MachOSegment {
            segname,
            vmaddr: macho_result_segment_vmaddr(result_ptr, i),
            vmsize: macho_result_segment_vmsize(result_ptr, i),
            fileoff: 0,
            filesize: 0,
            maxprot: 0,
            initprot: 0,
            nsects: 0,
        });
    }
    
    // Convert sections
    let section_count = macho_result_section_count(result_ptr);
    let mut sections = Vec::with_capacity(section_count as usize);
    for i in 0..section_count {
        let sectname_ptr = macho_result_section_name(result_ptr, i);
        let sectname = if sectname_ptr.is_null() {
            String::new()
        } else {
            let s = CStr::from_ptr(sectname_ptr).to_string_lossy().into_owned();
            macho_free_string(sectname_ptr);
            s
        };
        
        let segname_ptr = macho_result_section_segname(result_ptr, i);
        let segname = if segname_ptr.is_null() {
            String::new()
        } else {
            let s = CStr::from_ptr(segname_ptr).to_string_lossy().into_owned();
            macho_free_string(segname_ptr);
            s
        };
        
        sections.push(MachOSection {
            sectname,
            segname,
            addr: macho_result_section_addr(result_ptr, i),
            size: macho_result_section_size(result_ptr, i),
            offset: 0,
            flags: 0,
        });
    }
    
    // Free the result
    macho_free_result(result_ptr);
    
    Ok(MachOParseResult {
        is_64bit,
        cpu_type,
        cpu_subtype,
        file_type,
        ncmds,
        symbols,
        segments,
        sections,
    })
}

/// Parse a MachO file from disk
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn parse_macho_file(path: &str) -> Result<MachOParseResult, String> {
    let c_path = CString::new(path).map_err(|e| e.to_string())?;
    let c_result = unsafe { macho_parse_file(c_path.as_ptr()) };
    unsafe { convert_parse_result(c_result) }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn parse_macho_file(_path: &str) -> Result<MachOParseResult, String> {
    Err("MachO parsing is only available on macOS/iOS".to_string())
}

/// Parse a MachO file from the loaded dyld cache
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn parse_macho_from_cache(image_path: &str) -> Result<MachOParseResult, String> {
    let c_path = CString::new(image_path).map_err(|e| e.to_string())?;
    let c_result = unsafe { macho_parse_from_dyld_cache(c_path.as_ptr()) };
    unsafe { convert_parse_result(c_result) }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn parse_macho_from_cache(_image_path: &str) -> Result<MachOParseResult, String> {
    Err("MachO parsing is only available on macOS/iOS".to_string())
}

/// Parse a MachO file, automatically using dyld cache for system libraries
pub fn parse_macho(path: &str) -> Result<MachOParseResult, String> {
    log::debug!("parse_macho: path={}, is_system_library={}", path, is_system_library(path));
    
    if is_system_library(path) {
        // Try to parse from dyld cache first
        log::debug!("parse_macho: Trying dyld cache for system library: {}", path);
        match parse_macho_from_cache(path) {
            Ok(result) => {
                log::debug!("parse_macho: Successfully parsed from dyld cache, symbols: {}", result.symbols.len());
                return Ok(result);
            }
            Err(e) => {
                log::debug!("parse_macho: Failed to parse from dyld cache: {}, falling back to file", e);
                // Fall back to file parsing if not in cache
            }
        }
    }
    
    // Parse from file
    log::debug!("parse_macho: Trying to parse from file: {}", path);
    parse_macho_file(path)
}

/// Initialize MachO parsing (load dyld cache if available)
pub fn init_macho_parser() -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // Try to load system dyld cache (ignore errors, file parsing will still work)
        match load_system_dyld_cache() {
            Ok(_) => (),
            Err(e) => log::warn!("Failed to load system dyld cache: {}", e),
        }
    }
    Ok(())
}

/// Cleanup MachO parser resources
pub fn cleanup_macho_parser() {
    unload_dyld_cache();
}

/// Symbol information for FFI (matches native SymbolInfo structure)
#[derive(Debug, Clone)]
pub struct RebasedSymbol {
    pub address: usize,
    pub name: String,
    pub size: usize,
    pub symbol_type: String,
    pub scope: String,
    pub module_base: usize,
    // Mach-O specific metadata
    pub is_external: bool,
    pub is_weak_def: bool,
    pub is_thumb: bool,
    pub source: String, // "symtab" or "export_trie"
}

/// Get symbols for a module path, rebased to the specified module base address
/// This is the main entry point for replacing enum_symbols_native
pub fn get_module_symbols(module_path: &str, module_base: usize) -> Result<Vec<RebasedSymbol>, String> {
    // Parse the MachO file (automatically uses dyld cache for system libraries)
    let parse_result = parse_macho(module_path)?;
    
    if parse_result.symbols.is_empty() {
        return Err(format!("No symbols found in {}", module_path));
    }
    
    log::debug!("get_module_symbols: module_path={}, module_base=0x{:X}", module_path, module_base);
    log::debug!("  segments: {:?}", parse_result.segments.iter().map(|s| format!("{}: 0x{:X}", s.segname, s.vmaddr)).collect::<Vec<_>>());
    
    // For MachOKit symbols, the address is the offset from the start of the image.
    // We need to add module_base to get the runtime address.
    // However, if vmaddr is non-zero (position-dependent code), we need to calculate the slide.
    
    // Find the __TEXT segment's vmaddr - this is the preferred load address
    let text_segment = parse_result.segments.iter()
        .find(|seg| seg.segname == "__TEXT")
        .or_else(|| parse_result.segments.first());
    
    let preferred_base = text_segment.map(|seg| seg.vmaddr).unwrap_or(0);
    
    log::debug!("  preferred_base=0x{:X}", preferred_base);
    
    // Convert and rebase symbols
    let mut rebased_symbols: Vec<RebasedSymbol> = parse_result.symbols
        .into_iter()
        .filter(|sym| {
            // Skip undefined symbols and symbols with no address
            sym.symbol_type != MachOSymbolType::Undefined && sym.address > 0
        })
        .map(|sym| {
            // Symbol address is either:
            // 1. A file offset (for symbols from export trie) - add module_base directly
            // 2. A preferred vmaddr (for symbols from nlist) - calculate slide
            
            let runtime_address = if sym.address < preferred_base || preferred_base == 0 {
                // Address is a file offset, add module_base directly
                module_base.saturating_add(sym.address as usize)
            } else {
                // Address is a preferred vmaddr, calculate slide and apply
                let slide = (module_base as i64) - (preferred_base as i64);
                if slide >= 0 {
                    sym.address.saturating_add(slide as u64) as usize
                } else {
                    sym.address.saturating_sub((-slide) as u64) as usize
                }
            };
            
            let symbol_type_str = match sym.symbol_type {
                MachOSymbolType::Absolute => "ABS",
                MachOSymbolType::Section => "SECT",
                MachOSymbolType::Indirect => "INDR",
                MachOSymbolType::Undefined => "UNDEF",
            };
            
            // Determine scope based on external flag or symbol name
            let scope = if sym.is_external {
                "Global"
            } else if sym.is_private_external {
                "Private"
            } else if sym.name.starts_with('_') {
                "Global"
            } else {
                "Local"
            };
            
            let source_str = match sym.source {
                MachOSymbolSource::ExportTrie => "export_trie",
                MachOSymbolSource::SymbolTable => "symtab",
            };
            
            RebasedSymbol {
                address: runtime_address,
                name: sym.name.clone(),
                size: sym.size as usize,
                symbol_type: symbol_type_str.to_string(),
                scope: scope.to_string(),
                module_base,
                is_external: sym.is_external,
                is_weak_def: sym.is_weak_def,
                is_thumb: sym.is_thumb,
                source: source_str.to_string(),
            }
        })
        .collect();
    
    // Sort symbols by address
    rebased_symbols.sort_by_key(|sym| sym.address);
    
    // Log first few symbols for debugging
    if !rebased_symbols.is_empty() {
        log::debug!("  First symbols:");
        for sym in rebased_symbols.iter().take(5) {
            log::debug!("    {} @ 0x{:X}", sym.name, sym.address);
        }
    }
    
    Ok(rebased_symbols)
}

/// Check if MachOKit parsing is available for the given module path
pub fn can_parse_module(module_path: &str) -> bool {
    if is_system_library(module_path) {
        // For system libraries, check if we can access via dyld cache
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            // Try to ensure cache is loaded
            let _ = load_system_dyld_cache();
            return true;
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            return false;
        }
    }
    
    // For non-system libraries, check if file exists
    std::path::Path::new(module_path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn test_parse_system_library() {
        init_macho_parser().unwrap();
        
        // Try to parse a system library
        let result = parse_macho("/usr/lib/libSystem.B.dylib");
        assert!(result.is_ok(), "Failed to parse libSystem: {:?}", result.err());
        
        let parsed = result.unwrap();
        assert!(parsed.is_64bit);
        assert!(!parsed.symbols.is_empty() || !parsed.segments.is_empty());
        
        cleanup_macho_parser();
    }
    
    #[test]
    fn test_is_system_library() {
        assert!(is_system_library("/System/Library/Frameworks/Foundation.framework/Foundation"));
        assert!(is_system_library("/usr/lib/libSystem.B.dylib"));
        assert!(!is_system_library("/Applications/MyApp.app/Contents/MacOS/MyApp"));
        assert!(!is_system_library("/Users/test/mylib.dylib"));
    }
}
