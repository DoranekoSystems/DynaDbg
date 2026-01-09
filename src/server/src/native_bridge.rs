#![allow(dead_code)]

use libc::{self, c_char, c_int, c_void};
use libloading::{Library, Symbol};
use serde_json::json;
use std::ffi::{CStr, CString};
use std::io::{BufRead, BufReader, Error};
use std::sync::OnceLock;

#[cfg(any(target_os = "macos", target_os = "ios"))]
use crate::macho_bridge;

// Exception types matching C++ enum
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExceptionType {
    Unknown = 0,
    Breakpoint = 1,
    Watchpoint = 2,
    SingleStep = 3,
    Signal = 4,
    Sigsegv = 5,
    Sigbus = 6,
    Sigfpe = 7,
    Sigill = 8,
    Sigabrt = 9,
    Sigtrap = 10,
}

impl ExceptionType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "breakpoint" => ExceptionType::Breakpoint,
            "watchpoint" => ExceptionType::Watchpoint,
            "singlestep" => ExceptionType::SingleStep,
            "signal" => ExceptionType::Signal,
            "sigsegv" | "segfault" => ExceptionType::Sigsegv,
            "sigbus" => ExceptionType::Sigbus,
            "sigfpe" => ExceptionType::Sigfpe,
            "sigill" => ExceptionType::Sigill,
            "sigabrt" => ExceptionType::Sigabrt,
            "sigtrap" => ExceptionType::Sigtrap,
            _ => ExceptionType::Unknown,
        }
    }

    pub fn to_str(&self) -> &'static str {
        match self {
            ExceptionType::Breakpoint => "breakpoint",
            ExceptionType::Watchpoint => "watchpoint",
            ExceptionType::SingleStep => "singlestep",
            ExceptionType::Signal => "signal",
            ExceptionType::Sigsegv => "sigsegv",
            ExceptionType::Sigbus => "sigbus",
            ExceptionType::Sigfpe => "sigfpe",
            ExceptionType::Sigill => "sigill",
            ExceptionType::Sigabrt => "sigabrt",
            ExceptionType::Sigtrap => "sigtrap",
            ExceptionType::Unknown => "unknown",
        }
    }
}

#[cfg_attr(target_os = "android", link(name = "c++_shared", kind = "dylib"))]
#[cfg_attr(target_os = "android", link(name = "c++abi", kind = "dylib"))]
#[link(name = "native", kind = "static")]
extern "C" {
    #[link_name = "get_pid_native"]
    pub fn get_pid_native_static() -> i32;
    #[link_name = "enumerate_processes"]
    pub fn enumerate_processes_static(count: *mut usize) -> *mut ProcessInfo;
    #[link_name = "enumerate_modules"]
    pub fn enumerate_modules_static(pid: i32, count: *mut usize) -> *mut ModuleInfo;
    #[link_name = "enumerate_regions_to_buffer"]
    pub fn enumerate_regions_to_buffer_static(
        pid: i32,
        buffer: *mut u8,
        buffer_size: usize,
        include_filenames: bool,
    );
    #[link_name = "enumerate_regions"]
    pub fn enumerate_regions_static(
        pid: i32,
        count: *mut usize,
        include_filenames: bool,
    ) -> *mut RegionInfo;
    #[link_name = "free_region_info"]
    pub fn free_region_info_static(regions: *mut RegionInfo, count: usize);
    #[link_name = "read_memory_native"]
    pub fn read_memory_native_static(
        pid: libc::c_int,
        address: libc::uintptr_t,
        size: libc::size_t,
        buffer: *mut u8,
    ) -> libc::ssize_t;
    #[link_name = "read_memory_native_with_method"]
    pub fn read_memory_native_with_method_static(
        pid: libc::c_int,
        address: libc::uintptr_t,
        size: libc::size_t,
        buffer: *mut u8,
        mode: libc::c_int,
    ) -> libc::ssize_t;
    #[link_name = "write_memory_native"]
    pub fn write_memory_native_static(
        pid: i32,
        address: libc::uintptr_t,
        size: libc::size_t,
        buffer: *const u8,
    ) -> libc::ssize_t;
    #[link_name = "suspend_process"]
    pub fn suspend_process_static(pid: i32) -> bool;
    #[link_name = "resume_process"]
    pub fn resume_process_static(pid: i32) -> bool;
    #[link_name = "native_init"]
    pub fn native_init_static(mode: i32) -> libc::c_int;
    #[link_name = "explore_directory"]
    pub fn explore_directory_static(path: *const c_char, max_depth: i32) -> *mut libc::c_char;
    #[link_name = "read_file"]
    pub fn read_file_static(
        path: *const c_char,
        size: *mut usize,
        error_message: *mut *mut c_char,
    ) -> *const c_void;
    #[link_name = "get_application_info_native"]
    pub fn get_application_info_native_static(pid: c_int) -> *const c_char;
    #[link_name = "debugger_new"]
    pub fn debugger_new_static(pid: c_int) -> bool;
    #[link_name = "set_watchpoint_native"]
    pub fn set_watchpoint_native_static(
        address: libc::uintptr_t,
        size: libc::size_t,
        _type: libc::c_int,
    ) -> libc::c_int;
    #[link_name = "remove_watchpoint_native"]
    pub fn remove_watchpoint_native_static(address: libc::uintptr_t) -> libc::c_int;
    #[link_name = "set_breakpoint_native"]
    pub fn set_breakpoint_native_static(address: usize, hit_count: i32, is_software: bool) -> i32;
    #[link_name = "remove_breakpoint_native"]
    pub fn remove_breakpoint_native_static(address: usize) -> i32;
    #[link_name = "get_software_breakpoint_original_bytes_native"]
    pub fn get_software_breakpoint_original_bytes_native_static(
        address: usize,
        out_bytes: *mut u8,
        out_size: *mut usize,
    ) -> bool;
    #[link_name = "get_process_icon_native"]
    pub fn get_process_icon_native_static(pid: i32, size: *mut usize) -> *const u8;
    #[link_name = "enumerate_symbols"]
    pub fn enum_symbols_native_static(
        pid: i32,
        module_base: usize,
        count: *mut usize,
    ) -> *mut SymbolInfo;
    #[link_name = "continue_execution_native"]
    pub fn continue_execution_native_static(thread_id: libc::uintptr_t) -> libc::c_int;
    #[link_name = "single_step_native"]
    pub fn single_step_native_static(thread_id: libc::uintptr_t) -> libc::c_int;
    #[link_name = "read_register_native"]
    pub fn read_register_native_static(
        thread_id: libc::uintptr_t,
        reg_name: *const c_char,
        value: *mut u64,
    ) -> libc::c_int;
    #[link_name = "write_register_native"]
    pub fn write_register_native_static(
        thread_id: libc::uintptr_t,
        reg_name: *const c_char,
        value: u64,
    ) -> libc::c_int;
    #[link_name = "is_in_break_state_native"]
    pub fn is_in_break_state_native_static() -> bool;
    #[link_name = "enable_trace_file_output_native"]
    pub fn enable_trace_file_output_native_static(filepath: *const c_char);
    #[link_name = "disable_trace_file_output_native"]
    pub fn disable_trace_file_output_native_static();
    #[link_name = "is_trace_file_output_enabled_native"]
    pub fn is_trace_file_output_enabled_native_static() -> bool;
    #[link_name = "get_trace_file_path_native"]
    pub fn get_trace_file_path_native_static() -> *const c_char;
    #[link_name = "get_trace_file_entry_count_native"]
    pub fn get_trace_file_entry_count_native_static() -> u32;
    #[link_name = "is_trace_ended_by_end_address_native"]
    pub fn is_trace_ended_by_end_address_native_static() -> bool;
    #[link_name = "reset_trace_ended_flag_native"]
    pub fn reset_trace_ended_flag_native_static();
    #[link_name = "request_script_trace_stop_native"]
    pub fn request_script_trace_stop_native_static(notify_ui: bool);
    #[link_name = "clear_script_trace_stop_request_native"]
    pub fn clear_script_trace_stop_request_native_static();
    #[link_name = "is_script_trace_stop_requested_native"]
    pub fn is_script_trace_stop_requested_native_static() -> bool;
    #[link_name = "enable_full_memory_cache_native"]
    pub fn enable_full_memory_cache_native_static(
        dump_filepath: *const c_char,
        log_filepath: *const c_char,
    );
    #[link_name = "disable_full_memory_cache_native"]
    pub fn disable_full_memory_cache_native_static();
    #[link_name = "is_full_memory_cache_enabled_native"]
    pub fn is_full_memory_cache_enabled_native_static() -> bool;
    #[link_name = "dump_all_memory_regions_native"]
    pub fn dump_all_memory_regions_native_static() -> bool;
    #[link_name = "get_installed_apps_native"]
    pub fn get_installed_apps_native_static() -> *const c_char;
    #[link_name = "get_app_icon_native"]
    pub fn get_app_icon_native_static(
        bundle_identifier: *const c_char,
        size: *mut usize,
    ) -> *const u8;
    #[link_name = "spawn_app_native"]
    pub fn spawn_app_native_static(
        bundle_identifier: *const c_char,
        suspended: c_int,
    ) -> *const c_char;
    #[link_name = "terminate_app_native"]
    pub fn terminate_app_native_static(pid: c_int) -> c_int;
    #[link_name = "resume_app_native"]
    pub fn resume_app_native_static(pid: c_int) -> *const c_char;
    #[link_name = "enumerate_threads"]
    pub fn enumerate_threads_static(pid: i32, count: *mut usize) -> *mut ThreadInfo;
    #[link_name = "free_thread_info"]
    pub fn free_thread_info_static(threads: *mut ThreadInfo, count: usize);
    #[link_name = "get_app_running_status_native"]
    pub fn get_app_running_status_native_static(bundle_identifier: *const c_char) -> *const c_char;
    #[link_name = "spawn_process_native"]
    pub fn spawn_process_native_static(
        executable_path: *const c_char,
        args: *const *const c_char,
        arg_count: c_int,
        out_pid: *mut i32,
    ) -> c_int;
    #[link_name = "spawn_process_with_pty"]
    pub fn spawn_process_with_pty_static(
        executable_path: *const c_char,
        args: *const *const c_char,
        arg_count: c_int,
        out_pid: *mut i32,
        out_pty_fd: *mut c_int,
    ) -> c_int;
    #[link_name = "read_pty"]
    pub fn read_pty_static(pty_fd: c_int, buffer: *mut c_char, buffer_size: usize) -> isize;
    #[link_name = "write_pty"]
    pub fn write_pty_static(pty_fd: c_int, data: *const c_char, data_len: usize) -> isize;
    #[link_name = "close_pty"]
    pub fn close_pty_static(pty_fd: c_int);
    #[link_name = "set_pty_size"]
    pub fn set_pty_size_static(pty_fd: c_int, rows: c_int, cols: c_int) -> c_int;
    // Signal configuration (catch/pass behavior)
    #[link_name = "set_signal_config_native"]
    pub fn set_signal_config_native_static(signal: c_int, catch_signal: bool, pass_signal: bool);
    #[link_name = "get_signal_config_native"]
    pub fn get_signal_config_native_static(
        signal: c_int,
        catch_signal: *mut bool,
        pass_signal: *mut bool,
    );
    #[link_name = "get_all_signal_configs_native"]
    pub fn get_all_signal_configs_native_static(
        signals: *mut c_int,
        catch_signals: *mut bool,
        pass_signals: *mut bool,
        max_count: usize,
    ) -> usize;
    #[link_name = "remove_signal_config_native"]
    pub fn remove_signal_config_native_static(signal: c_int);
}

// Dynamic library loader
static DYNAMIC_LIB: OnceLock<Option<Library>> = OnceLock::new();

// Type definitions for callback setters
type NativeLogFn = extern "C" fn(i32, *const c_char);
// On Linux, send_exception_info returns bool (true = break, false = continue)
// We pass send_exception_info (bool return) but C++ stores it as function pointer
type SendExceptionInfoFn = extern "C" fn(*const crate::api::NativeExceptionInfo, i32) -> bool;
type SetNativeLogCallbackFn = unsafe extern "C" fn(NativeLogFn);
type SetSendExceptionInfoCallbackFn = unsafe extern "C" fn(SendExceptionInfoFn);

/// Initialize dynamic library loading
/// Returns true if dynamic library was loaded successfully
pub fn init_dynamic_library() -> bool {
    DYNAMIC_LIB
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let lib_name = "libdbgsrv_native.dylib";

            #[cfg(target_os = "ios")]
            let lib_name = "libdbgsrv_native.dylib";

            #[cfg(target_os = "linux")]
            let lib_name = "libdbgsrv_native.so";

            #[cfg(target_os = "android")]
            let lib_name = "libdbgsrv_native.so";

            #[cfg(target_os = "windows")]
            let lib_name = "libdbgsrv_native.dll";

            // Try loading from executable's directory first
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let lib_path = exe_dir.join(lib_name);
                    log::info!("Trying to load dynamic library from: {:?}", lib_path);
                    if let Ok(lib) = unsafe { Library::new(&lib_path) } {
                        log::info!("Successfully loaded dynamic library from executable directory");
                        // Set callback functions
                        setup_dll_callbacks(&lib);
                        return Some(lib);
                    } else {
                        log::warn!("Failed to load from {:?}", lib_path);
                    }
                }
            }

            // Fall back to system library search path
            log::info!(
                "Trying to load dynamic library from system path: {}",
                lib_name
            );
            match unsafe { Library::new(lib_name) } {
                Ok(lib) => {
                    log::info!("Successfully loaded dynamic library from system path");
                    // Set callback functions
                    setup_dll_callbacks(&lib);
                    Some(lib)
                }
                Err(e) => {
                    log::warn!("Failed to load dynamic library: {}", e);
                    None
                }
            }
        })
        .is_some()
}

/// Set up callbacks from DLL to Rust
fn setup_dll_callbacks(lib: &Library) {
    // Set native_log callback
    match unsafe { lib.get::<SetNativeLogCallbackFn>(b"set_native_log_callback") } {
        Ok(set_log_cb) => {
            log::info!("Setting native_log callback");
            unsafe {
                set_log_cb(crate::api::native_log);
            }
        }
        Err(e) => {
            log::warn!("set_native_log_callback not found: {}", e);
        }
    }

    // Set send_exception_info callback
    match unsafe { lib.get::<SetSendExceptionInfoCallbackFn>(b"set_send_exception_info_callback") }
    {
        Ok(set_exc_cb) => {
            log::info!("Setting send_exception_info callback");
            unsafe {
                set_exc_cb(crate::api::send_exception_info);
            }
        }
        Err(e) => {
            log::warn!("set_send_exception_info_callback not found: {}", e);
        }
    }
}

/// Check if dynamic library is available
pub fn has_dynamic_library() -> bool {
    DYNAMIC_LIB.get().and_then(|opt| opt.as_ref()).is_some()
}

// Macro to create wrapper functions that try dynamic library first, then fall back to static
macro_rules! wrap_native_fn {
    ($fn_name:ident() -> $ret:ty) => {
        pub unsafe fn $fn_name() -> $ret {
            if let Some(Some(lib)) = DYNAMIC_LIB.get() {
                if let Ok(func) = lib.get::<Symbol<unsafe extern "C" fn() -> $ret>>(stringify!($fn_name).as_bytes()) {
                    return func();
                }
            }
            paste::paste! {
                [<$fn_name _static>]()
            }
        }
    };

    ($fn_name:ident($($arg:ident: $typ:ty),*) -> $ret:ty) => {
        pub unsafe fn $fn_name($($arg: $typ),*) -> $ret {
            if let Some(Some(lib)) = DYNAMIC_LIB.get() {
                if let Ok(func) = lib.get::<Symbol<unsafe extern "C" fn($($typ),*) -> $ret>>(stringify!($fn_name).as_bytes()) {
                    return func($($arg),*);
                }
            }
            paste::paste! {
                [<$fn_name _static>]($($arg),*)
            }
        }
    };
}

// Wrapper functions for all native calls
wrap_native_fn!(get_pid_native() -> i32);
wrap_native_fn!(enumerate_processes(count: *mut usize) -> *mut ProcessInfo);
wrap_native_fn!(enumerate_modules(pid: i32, count: *mut usize) -> *mut ModuleInfo);
wrap_native_fn!(enumerate_regions_to_buffer(pid: i32, buffer: *mut u8, buffer_size: usize, include_filenames: bool) -> ());
wrap_native_fn!(enumerate_regions(pid: i32, count: *mut usize, include_filenames: bool) -> *mut RegionInfo);
wrap_native_fn!(free_region_info(regions: *mut RegionInfo, count: usize) -> ());
wrap_native_fn!(read_memory_native(pid: libc::c_int, address: libc::uintptr_t, size: libc::size_t, buffer: *mut u8) -> libc::ssize_t);
wrap_native_fn!(read_memory_native_with_method(pid: libc::c_int, address: libc::uintptr_t, size: libc::size_t, buffer: *mut u8, mode: libc::c_int) -> libc::ssize_t);
wrap_native_fn!(write_memory_native(pid: i32, address: libc::uintptr_t, size: libc::size_t, buffer: *const u8) -> libc::ssize_t);
wrap_native_fn!(suspend_process(pid: i32) -> bool);
wrap_native_fn!(resume_process(pid: i32) -> bool);
wrap_native_fn!(native_init(mode: i32) -> libc::c_int);
wrap_native_fn!(explore_directory(path: *const c_char, max_depth: i32) -> *mut libc::c_char);
wrap_native_fn!(read_file(path: *const c_char, size: *mut usize, error_message: *mut *mut c_char) -> *const c_void);
wrap_native_fn!(get_application_info_native(pid: c_int) -> *const c_char);
wrap_native_fn!(debugger_new(pid: c_int) -> bool);
wrap_native_fn!(set_watchpoint_native(address: libc::uintptr_t, size: libc::size_t, _type: libc::c_int) -> libc::c_int);
wrap_native_fn!(remove_watchpoint_native(address: libc::uintptr_t) -> libc::c_int);
wrap_native_fn!(set_breakpoint_native(address: usize, hit_count: i32, is_software: bool) -> i32);
wrap_native_fn!(remove_breakpoint_native(address: usize) -> i32);
wrap_native_fn!(get_software_breakpoint_original_bytes_native(address: usize, out_bytes: *mut u8, out_size: *mut usize) -> bool);
wrap_native_fn!(get_process_icon_native(pid: i32, size: *mut usize) -> *const u8);
wrap_native_fn!(enum_symbols_native(pid: i32, module_base: usize, count: *mut usize) -> *mut SymbolInfo);
wrap_native_fn!(continue_execution_native(thread_id: libc::uintptr_t) -> libc::c_int);
wrap_native_fn!(single_step_native(thread_id: libc::uintptr_t) -> libc::c_int);
wrap_native_fn!(read_register_native(thread_id: libc::uintptr_t, reg_name: *const c_char, value: *mut u64) -> libc::c_int);
wrap_native_fn!(write_register_native(thread_id: libc::uintptr_t, reg_name: *const c_char, value: u64) -> libc::c_int);
wrap_native_fn!(is_in_break_state_native() -> bool);
wrap_native_fn!(enable_trace_file_output_native(filepath: *const c_char) -> ());
wrap_native_fn!(disable_trace_file_output_native() -> ());
wrap_native_fn!(is_trace_file_output_enabled_native() -> bool);
wrap_native_fn!(get_trace_file_path_native() -> *const c_char);
wrap_native_fn!(get_trace_file_entry_count_native() -> u32);
wrap_native_fn!(is_trace_ended_by_end_address_native() -> bool);
wrap_native_fn!(reset_trace_ended_flag_native() -> ());
wrap_native_fn!(request_script_trace_stop_native(notify_ui: bool) -> ());
wrap_native_fn!(clear_script_trace_stop_request_native() -> ());
wrap_native_fn!(is_script_trace_stop_requested_native() -> bool);
wrap_native_fn!(enable_full_memory_cache_native(dump_filepath: *const c_char, log_filepath: *const c_char) -> ());
wrap_native_fn!(disable_full_memory_cache_native() -> ());
wrap_native_fn!(is_full_memory_cache_enabled_native() -> bool);
wrap_native_fn!(dump_all_memory_regions_native() -> bool);
wrap_native_fn!(get_installed_apps_native() -> *const c_char);
wrap_native_fn!(get_app_icon_native(bundle_identifier: *const c_char, size: *mut usize) -> *const u8);
wrap_native_fn!(spawn_app_native(bundle_identifier: *const c_char, suspended: c_int) -> *const c_char);
wrap_native_fn!(terminate_app_native(pid: c_int) -> c_int);
wrap_native_fn!(resume_app_native(pid: c_int) -> *const c_char);
wrap_native_fn!(enumerate_threads(pid: i32, count: *mut usize) -> *mut ThreadInfo);
wrap_native_fn!(free_thread_info(threads: *mut ThreadInfo, count: usize) -> ());
wrap_native_fn!(get_app_running_status_native(bundle_identifier: *const c_char) -> *const c_char);
wrap_native_fn!(spawn_process_native(executable_path: *const c_char, args: *const *const c_char, arg_count: c_int, out_pid: *mut i32) -> c_int);
wrap_native_fn!(spawn_process_with_pty(executable_path: *const c_char, args: *const *const c_char, arg_count: c_int, out_pid: *mut i32, out_pty_fd: *mut c_int) -> c_int);
wrap_native_fn!(read_pty(pty_fd: c_int, buffer: *mut c_char, buffer_size: usize) -> isize);
wrap_native_fn!(write_pty(pty_fd: c_int, data: *const c_char, data_len: usize) -> isize);
wrap_native_fn!(close_pty(pty_fd: c_int) -> ());
wrap_native_fn!(set_pty_size(pty_fd: c_int, rows: c_int, cols: c_int) -> c_int);
// Signal configuration (catch/pass behavior)
wrap_native_fn!(set_signal_config_native(signal: c_int, catch_signal: bool, pass_signal: bool) -> ());
wrap_native_fn!(get_signal_config_native(signal: c_int, catch_signal: *mut bool, pass_signal: *mut bool) -> ());
wrap_native_fn!(get_all_signal_configs_native(signals: *mut c_int, catch_signals: *mut bool, pass_signals: *mut bool, max_count: usize) -> usize);
wrap_native_fn!(remove_signal_config_native(signal: c_int) -> ());

#[repr(C)]
pub struct ProcessInfo {
    pub pid: i32,
    pub processname: *mut c_char,
}

#[repr(C)]
pub struct ModuleInfo {
    pub base: usize,
    pub size: usize,
    pub is_64bit: bool,
    pub modulename: *mut c_char,
}

#[repr(C)]
pub struct SymbolInfo {
    pub address: usize,
    pub name: *mut c_char,
    pub size: usize,
    pub symbol_type: *mut c_char,
    pub scope: *mut c_char,
    pub module_base: usize,
    pub file_name: *mut c_char,
    pub line_number: i32,
}

#[repr(C)]
pub struct ThreadInfo {
    pub thread_id: u64,
    pub name: *mut c_char,
    pub pc: u64,
    pub sp: u64,
    pub fp: u64,
    pub state: i32,
    pub suspend_count: i32,
}

/// Memory region information structure
/// Used for structured region enumeration
#[repr(C)]
pub struct RegionInfo {
    pub start: usize,
    pub end: usize,
    pub protection: u32, // PROT_READ=1, PROT_WRITE=2, PROT_EXEC=4
    pub pathname: *mut c_char,
}

pub fn read_process_memory(
    pid: i32,
    address: *mut libc::c_void,
    size: usize,
    buffer: &mut [u8],
) -> Result<isize, Error> {
    let result =
        unsafe { read_memory_native(pid, address as libc::uintptr_t, size, buffer.as_mut_ptr()) };
    if result >= 0 {
        Ok(result as isize)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn read_process_memory_with_method(
    pid: i32,
    address: *mut libc::c_void,
    size: usize,
    buffer: &mut [u8],
    mode: i32,
) -> Result<isize, Error> {
    let result = unsafe {
        read_memory_native_with_method(
            pid,
            address as libc::uintptr_t,
            size,
            buffer.as_mut_ptr(),
            mode,
        )
    };
    if result >= 0 {
        Ok(result as isize)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn write_process_memory(
    pid: i32,
    address: *mut libc::c_void,
    size: usize,
    buffer: &[u8],
) -> Result<isize, Error> {
    let result =
        unsafe { write_memory_native(pid, address as libc::uintptr_t, size, buffer.as_ptr()) };
    if result >= 0 {
        Ok(result as isize)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn set_watchpoint(pid: i32, address: usize, size: usize, type_: i32) -> Result<i32, Error> {
    let result: bool = unsafe { debugger_new(pid) };

    if !result {
        return Err(Error::new(
            std::io::ErrorKind::Other,
            "Failed to create debugger instance",
        ));
    }
    let result = unsafe { set_watchpoint_native(address, size, type_) };
    if result == 0 {
        Ok(result as i32)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn remove_watchpoint(address: usize) -> Result<i32, Error> {
    let result = unsafe { remove_watchpoint_native(address) };
    if result == 0 {
        Ok(result as i32)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn set_breakpoint(
    pid: i32,
    address: usize,
    hit_count: i32,
    is_software: bool,
) -> Result<i32, Error> {
    let result: bool = unsafe { debugger_new(pid) };
    if !result {
        return Err(Error::new(
            std::io::ErrorKind::Other,
            "Failed to create debugger instance",
        ));
    }
    let result = unsafe { set_breakpoint_native(address, hit_count, is_software) };
    if result == 0 {
        Ok(result)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn remove_breakpoint(address: usize) -> Result<i32, Error> {
    let result = unsafe { remove_breakpoint_native(address) };
    if result == 0 {
        Ok(result)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn get_software_breakpoint_original_bytes(address: usize) -> Option<Vec<u8>> {
    let mut bytes = [0u8; 4];
    let mut size: usize = 0;
    let result = unsafe {
        get_software_breakpoint_original_bytes_native(address, bytes.as_mut_ptr(), &mut size)
    };
    if result && size > 0 {
        Some(bytes[..size].to_vec())
    } else {
        None
    }
}

pub fn native_api_init(mode: i32) {
    unsafe { native_init(mode) };
}

pub fn enum_modules(pid: i32) -> Result<Vec<serde_json::Value>, String> {
    let mut count: usize = 0;
    let module_info_ptr = unsafe { enumerate_modules(pid, &mut count) };

    if module_info_ptr.is_null() {
        return Err("Failed to enumerate modules".to_string());
    }

    let module_info_slice = unsafe { std::slice::from_raw_parts(module_info_ptr, count) };

    let mut modules = Vec::new();

    for info in module_info_slice {
        let module_name = unsafe {
            CStr::from_ptr(info.modulename)
                .to_string_lossy()
                .into_owned()
        };

        modules.push(json!({
            "base": info.base,
            "size": info.size,
            "is_64bit": info.is_64bit,
            "modulename": module_name
        }));

        unsafe { libc::free(info.modulename as *mut libc::c_void) };
    }

    unsafe { libc::free(module_info_ptr as *mut libc::c_void) };

    Ok(modules)
}

/// Get module path for a given base address by looking up the module list
fn get_module_path_for_base(pid: i32, module_base: usize) -> Option<String> {
    let mut count: usize = 0;
    let module_info_ptr = unsafe { enumerate_modules(pid, &mut count) };

    if module_info_ptr.is_null() || count == 0 {
        return None;
    }

    let module_info_slice = unsafe { std::slice::from_raw_parts(module_info_ptr, count) };
    let mut result = None;

    for info in module_info_slice {
        if info.base == module_base {
            let module_name = unsafe {
                CStr::from_ptr(info.modulename)
                    .to_string_lossy()
                    .into_owned()
            };
            result = Some(module_name);
        }
        // Free the module name regardless
        unsafe { libc::free(info.modulename as *mut libc::c_void) };
    }

    unsafe { libc::free(module_info_ptr as *mut libc::c_void) };

    result
}

/// Enumerate symbols using MachOKit (macOS/iOS only)
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn enum_symbols_machokit(pid: i32, module_base: usize) -> Result<Vec<serde_json::Value>, String> {
    // Get the module path for this base address
    let module_path = get_module_path_for_base(pid, module_base)
        .ok_or_else(|| "Could not find module path for base address".to_string())?;

    log::debug!("MachOKit: Trying to parse module at path: {}", module_path);

    // Check if we can parse this module with MachOKit
    if !macho_bridge::can_parse_module(&module_path) {
        return Err(format!(
            "Cannot parse module with MachOKit: {}",
            module_path
        ));
    }

    log::debug!(
        "MachOKit: can_parse_module returned true for {}",
        module_path
    );

    // Get symbols from MachOKit
    let rebased_symbols = match macho_bridge::get_module_symbols(&module_path, module_base) {
        Ok(syms) => {
            log::debug!(
                "MachOKit: Successfully got {} symbols for {}",
                syms.len(),
                module_path
            );
            syms
        }
        Err(e) => {
            log::debug!(
                "MachOKit: get_module_symbols failed for {}: {}",
                module_path,
                e
            );
            return Err(e);
        }
    };

    // Convert to JSON format
    let symbols: Vec<serde_json::Value> = rebased_symbols
        .into_iter()
        .map(|sym| {
            json!({
                "address": format!("0x{:X}", sym.address),
                "name": sym.name,
                "size": sym.size,
                "type": sym.symbol_type,
                "scope": sym.scope,
                "module_base": format!("0x{:X}", sym.module_base),
                "file_name": "",
                "line_number": 0,
                // Mach-O specific metadata
                "is_external": sym.is_external,
                "is_weak_def": sym.is_weak_def,
                "is_thumb": sym.is_thumb,
                "source": sym.source
            })
        })
        .collect();

    if symbols.is_empty() {
        Err("No symbols found via MachOKit".to_string())
    } else {
        Ok(symbols)
    }
}

/// Enumerate symbols using native C++ implementation (fallback)
fn enum_symbols_native_impl(
    pid: i32,
    module_base: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let mut count: usize = 0;
    let symbol_info_ptr = unsafe { enum_symbols_native(pid, module_base, &mut count) };

    if symbol_info_ptr.is_null() {
        return Err("Failed to enumerate symbols".to_string());
    }

    let symbol_info_slice = unsafe { std::slice::from_raw_parts(symbol_info_ptr, count) };

    let mut symbols = Vec::new();

    for info in symbol_info_slice {
        let symbol_name = unsafe { CStr::from_ptr(info.name).to_string_lossy().into_owned() };

        let symbol_type = unsafe {
            CStr::from_ptr(info.symbol_type)
                .to_string_lossy()
                .into_owned()
        };

        let scope = unsafe { CStr::from_ptr(info.scope).to_string_lossy().into_owned() };

        let file_name = unsafe {
            if info.file_name.is_null() || *info.file_name == 0 {
                String::new()
            } else {
                CStr::from_ptr(info.file_name)
                    .to_string_lossy()
                    .into_owned()
            }
        };

        symbols.push(json!({
            "address": format!("0x{:X}", info.address),
            "name": symbol_name,
            "size": info.size,
            "type": symbol_type,
            "scope": scope,
            "module_base": format!("0x{:X}", info.module_base),
            "file_name": file_name,
            "line_number": info.line_number
        }));

        // Free allocated memory
        unsafe {
            libc::free(info.name as *mut libc::c_void);
            libc::free(info.symbol_type as *mut libc::c_void);
            libc::free(info.scope as *mut libc::c_void);
            if !info.file_name.is_null() {
                libc::free(info.file_name as *mut libc::c_void);
            }
        };
    }

    unsafe { libc::free(symbol_info_ptr as *mut libc::c_void) };

    Ok(symbols)
}

/// Main entry point for symbol enumeration
/// Tries MachOKit first on macOS/iOS, falls back to native implementation
pub fn enum_symbols(pid: i32, module_base: usize) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // Try MachOKit first for better symbol coverage (especially for dyld cache)
        match enum_symbols_machokit(pid, module_base) {
            Ok(symbols) => {
                log::debug!(
                    "Successfully enumerated {} symbols via MachOKit for module at 0x{:X}",
                    symbols.len(),
                    module_base
                );
                return Ok(symbols);
            }
            Err(e) => {
                log::debug!(
                    "MachOKit symbol enumeration failed, falling back to native: {}",
                    e
                );
                // Fall through to native implementation
            }
        }
    }

    // Fallback to native C++ implementation
    enum_symbols_native_impl(pid, module_base)
}

pub fn enum_threads(pid: i32) -> Result<Vec<serde_json::Value>, String> {
    let mut count: usize = 0;
    let thread_info_ptr = unsafe { enumerate_threads(pid, &mut count) };

    if thread_info_ptr.is_null() {
        return Err("Failed to enumerate threads".to_string());
    }

    let thread_info_slice = unsafe { std::slice::from_raw_parts(thread_info_ptr, count) };

    let mut threads = Vec::new();

    for info in thread_info_slice {
        let thread_name = unsafe {
            if info.name.is_null() {
                String::from("Unknown")
            } else {
                CStr::from_ptr(info.name).to_string_lossy().into_owned()
            }
        };

        let state_str = match info.state {
            1 => "Running",
            2 => "Stopped",
            3 => "Waiting",
            4 => "Uninterruptible",
            5 => "Halted",
            _ => "Unknown",
        };

        threads.push(json!({
            "thread_id": info.thread_id,
            "name": thread_name,
            "pc": format!("0x{:X}", info.pc),
            "sp": format!("0x{:X}", info.sp),
            "fp": format!("0x{:X}", info.fp),
            "state": state_str,
            "suspend_count": info.suspend_count
        }));
    }

    // Free allocated memory using the native free function
    unsafe { free_thread_info(thread_info_ptr, count) };

    Ok(threads)
}

pub fn enum_regions(pid: i32) -> Result<Vec<serde_json::Value>, String> {
    enum_regions_with_filenames(pid, true)
}

pub fn enum_regions_fast(pid: i32) -> Result<Vec<serde_json::Value>, String> {
    enum_regions_with_filenames(pid, false)
}

pub fn enum_regions_with_filenames(
    pid: i32,
    include_filenames: bool,
) -> Result<Vec<serde_json::Value>, String> {
    let mut buffer = vec![0u8; 4 * 1024 * 1024]; // 4MB buffer for large /proc/pid/maps on Android

    unsafe {
        enumerate_regions_to_buffer(pid, buffer.as_mut_ptr(), buffer.len(), include_filenames)
    };

    let buffer_cstring = unsafe { CString::from_vec_unchecked(buffer) };
    let buffer_string = match buffer_cstring.into_string() {
        Ok(s) => s,
        Err(_) => return Err("Failed to convert buffer to string".to_string()),
    };

    let buffer_reader = BufReader::new(buffer_string.as_bytes());
    let mut regions = Vec::new();

    for line in buffer_reader.lines() {
        if let Ok(line) = line {
            let parts: Vec<&str> = line.split_whitespace().collect();

            if parts.len() >= 5 {
                let addresses: Vec<&str> = parts[0].split('-').collect();
                if addresses.len() == 2 {
                    let region = json!({
                        "start_address": addresses[0],
                        "end_address": addresses[1],
                        "protection": parts[1],
                        "file_path": if parts.len() > 5 {
                            parts[5..].join(" ")
                        } else {
                            "".to_string()
                        }
                    });
                    regions.push(region);
                }
            }
        }
    }

    if regions.is_empty() {
        Err("No regions found".to_string())
    } else {
        Ok(regions)
    }
}

pub fn get_application_info(pid: i32) -> Result<String, Error> {
    let result = unsafe {
        let raw_ptr = get_application_info_native(pid as c_int);
        if raw_ptr.is_null() {
            return Err(Error::new(
                std::io::ErrorKind::Other,
                "Failed to get application info",
            ));
        }

        let c_str = CStr::from_ptr(raw_ptr);
        let result_str = c_str.to_str().unwrap_or("Invalid UTF-8").to_owned();
        libc::free(raw_ptr as *mut libc::c_void);

        result_str
    };

    Ok(result)
}

pub fn get_process_icon(pid: i32) -> Result<Vec<u8>, Error> {
    let mut size: usize = 0;

    let result = unsafe {
        let raw_ptr = get_process_icon_native(pid, &mut size as *mut usize);
        if raw_ptr.is_null() || size == 0 {
            return Err(Error::new(
                std::io::ErrorKind::Other,
                "Failed to get process icon",
            ));
        }

        let icon_data = std::slice::from_raw_parts(raw_ptr, size).to_vec();
        libc::free(raw_ptr as *mut libc::c_void);

        icon_data
    };

    Ok(result)
}

// New break state control functions
pub fn continue_execution(thread_id: libc::uintptr_t) -> Result<(), Error> {
    let result = unsafe { continue_execution_native(thread_id) };
    if result == 0 {
        Ok(())
    } else {
        // Convert Mach kernel return to appropriate error
        Err(Error::new(
            std::io::ErrorKind::Other,
            format!("Continue execution failed with kernel return: {}", result),
        ))
    }
}

pub fn single_step(thread_id: libc::uintptr_t) -> Result<(), Error> {
    let result = unsafe { single_step_native(thread_id) };
    if result == 0 {
        Ok(())
    } else {
        // Convert Mach kernel return to appropriate error
        Err(Error::new(
            std::io::ErrorKind::Other,
            format!("Single step failed with kernel return: {}", result),
        ))
    }
}

pub fn read_register(thread_id: libc::uintptr_t, reg_name: &str) -> Result<u64, Error> {
    let c_reg_name = CString::new(reg_name).unwrap();
    let mut value: u64 = 0;
    let result = unsafe { read_register_native(thread_id, c_reg_name.as_ptr(), &mut value) };
    if result == 0 {
        Ok(value)
    } else {
        Err(Error::last_os_error())
    }
}

pub fn write_register(thread_id: libc::uintptr_t, reg_name: &str, value: u64) -> Result<(), Error> {
    let c_reg_name = CString::new(reg_name).unwrap();
    let result = unsafe { write_register_native(thread_id, c_reg_name.as_ptr(), value) };
    if result == 0 {
        Ok(())
    } else {
        Err(Error::last_os_error())
    }
}

pub fn is_in_break_state() -> bool {
    unsafe { is_in_break_state_native() }
}

// Signal configuration functions (catch/pass behavior)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SignalConfig {
    pub catch_signal: bool,
    pub pass_signal: bool,
}

impl Default for SignalConfig {
    fn default() -> Self {
        // Default: catch=false (don't stop), pass=false (suppress signal, like GDB)
        SignalConfig {
            catch_signal: false,
            pass_signal: false,
        }
    }
}

pub fn set_signal_config(signal: i32, config: SignalConfig) {
    unsafe { set_signal_config_native(signal, config.catch_signal, config.pass_signal) }
}

pub fn get_signal_config(signal: i32) -> SignalConfig {
    let mut catch_signal = false;
    let mut pass_signal = false; // Default: don't pass (like GDB)
    unsafe { get_signal_config_native(signal, &mut catch_signal, &mut pass_signal) }
    SignalConfig {
        catch_signal,
        pass_signal,
    }
}

pub fn get_all_signal_configs() -> Vec<(i32, SignalConfig)> {
    let mut signals = vec![0i32; 32];
    let mut catch_signals = vec![false; 32];
    let mut pass_signals = vec![false; 32];
    let count = unsafe {
        get_all_signal_configs_native(
            signals.as_mut_ptr(),
            catch_signals.as_mut_ptr(),
            pass_signals.as_mut_ptr(),
            32,
        )
    };
    (0..count)
        .map(|i| {
            (
                signals[i],
                SignalConfig {
                    catch_signal: catch_signals[i],
                    pass_signal: pass_signals[i],
                },
            )
        })
        .collect()
}

pub fn remove_signal_config(signal: i32) {
    unsafe { remove_signal_config_native(signal) }
}

// Trace file output functions
pub fn enable_trace_file_output(filepath: &str) {
    if let Ok(c_filepath) = CString::new(filepath) {
        unsafe { enable_trace_file_output_native(c_filepath.as_ptr()) }
    }
}

pub fn disable_trace_file_output() {
    unsafe { disable_trace_file_output_native() }
}

pub fn is_trace_file_output_enabled() -> bool {
    unsafe { is_trace_file_output_enabled_native() }
}

pub fn get_trace_file_path() -> String {
    unsafe {
        let raw_ptr = get_trace_file_path_native();
        if raw_ptr.is_null() {
            return String::new();
        }
        let c_str = CStr::from_ptr(raw_ptr);
        c_str.to_str().unwrap_or("").to_owned()
    }
}

pub fn get_trace_file_entry_count() -> u32 {
    unsafe { get_trace_file_entry_count_native() }
}

pub fn is_trace_ended_by_end_address() -> bool {
    unsafe { is_trace_ended_by_end_address_native() }
}

pub fn reset_trace_ended_flag() {
    unsafe { reset_trace_ended_flag_native() }
}

// Script trace control functions
pub fn request_script_trace_stop(notify_ui: bool) {
    unsafe { request_script_trace_stop_native(notify_ui) }
}

pub fn clear_script_trace_stop_request() {
    unsafe { clear_script_trace_stop_request_native() }
}

pub fn is_script_trace_stop_requested() -> bool {
    unsafe { is_script_trace_stop_requested_native() }
}

// Full memory cache functions
pub fn enable_full_memory_cache(dump_filepath: &str, log_filepath: &str) {
    if let (Ok(c_dump_path), Ok(c_log_path)) =
        (CString::new(dump_filepath), CString::new(log_filepath))
    {
        unsafe { enable_full_memory_cache_native(c_dump_path.as_ptr(), c_log_path.as_ptr()) }
    }
}

pub fn disable_full_memory_cache() {
    unsafe { disable_full_memory_cache_native() }
}

pub fn is_full_memory_cache_enabled() -> bool {
    unsafe { is_full_memory_cache_enabled_native() }
}

pub fn dump_all_memory_regions() -> bool {
    unsafe { dump_all_memory_regions_native() }
}

pub fn get_installed_apps() -> Result<String, Error> {
    let result = unsafe {
        let raw_ptr = get_installed_apps_native();
        if raw_ptr.is_null() {
            return Err(Error::new(
                std::io::ErrorKind::Other,
                "Failed to get installed apps",
            ));
        }

        let c_str = CStr::from_ptr(raw_ptr);
        let result_str = c_str.to_str().unwrap_or("[]").to_owned();
        libc::free(raw_ptr as *mut libc::c_void);

        result_str
    };

    Ok(result)
}

pub fn get_app_icon(bundle_identifier: &str) -> Result<Vec<u8>, Error> {
    let c_bundle_id = CString::new(bundle_identifier).map_err(|_| {
        Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid bundle identifier",
        )
    })?;
    let mut size: usize = 0;

    let result = unsafe {
        let raw_ptr = get_app_icon_native(c_bundle_id.as_ptr(), &mut size as *mut usize);
        if raw_ptr.is_null() || size == 0 {
            return Err(Error::new(
                std::io::ErrorKind::NotFound,
                "Failed to get app icon",
            ));
        }

        let icon_data = std::slice::from_raw_parts(raw_ptr, size).to_vec();
        libc::free(raw_ptr as *mut libc::c_void);

        icon_data
    };

    Ok(result)
}

pub fn spawn_app(bundle_identifier: &str, suspended: bool) -> Result<String, Error> {
    let c_bundle_id = CString::new(bundle_identifier).map_err(|_| {
        Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid bundle identifier",
        )
    })?;

    let result = unsafe {
        let raw_ptr = spawn_app_native(c_bundle_id.as_ptr(), if suspended { 1 } else { 0 });
        if raw_ptr.is_null() {
            return Err(Error::new(std::io::ErrorKind::Other, "Failed to spawn app"));
        }

        let c_str = CStr::from_ptr(raw_ptr);
        let result_str = c_str
            .to_str()
            .unwrap_or("{\"success\":false,\"error\":\"Invalid UTF-8\"}")
            .to_owned();
        libc::free(raw_ptr as *mut libc::c_void);

        result_str
    };

    Ok(result)
}

pub fn terminate_app(pid: i32) -> Result<bool, Error> {
    let result = unsafe { terminate_app_native(pid) };

    Ok(result != 0)
}

pub fn resume_app(pid: i32) -> Result<String, Error> {
    let result = unsafe {
        let raw_ptr = resume_app_native(pid);
        if raw_ptr.is_null() {
            return Err(Error::new(
                std::io::ErrorKind::Other,
                "Failed to resume app",
            ));
        }

        let c_str = CStr::from_ptr(raw_ptr);
        let result_str = c_str
            .to_str()
            .unwrap_or("{\"success\":false,\"error\":\"Invalid UTF-8\"}")
            .to_owned();
        libc::free(raw_ptr as *mut libc::c_void);

        result_str
    };

    Ok(result)
}

pub fn get_app_running_status(bundle_identifier: &str) -> Result<String, Error> {
    let c_bundle_id = CString::new(bundle_identifier).map_err(|_| {
        Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid bundle identifier",
        )
    })?;

    let result = unsafe {
        let raw_ptr = get_app_running_status_native(c_bundle_id.as_ptr());
        if raw_ptr.is_null() {
            return Err(Error::new(
                std::io::ErrorKind::Other,
                "Failed to get app running status",
            ));
        }

        let c_str = CStr::from_ptr(raw_ptr);
        let result_str = c_str
            .to_str()
            .unwrap_or("{\"running\":false,\"pid\":0}")
            .to_owned();
        libc::free(raw_ptr as *mut libc::c_void);

        result_str
    };

    Ok(result)
}
