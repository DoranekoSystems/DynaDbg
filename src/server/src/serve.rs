use bytes::Bytes;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use warp::Filter;

use crate::api;
use crate::logger;
use crate::native_bridge;
use crate::request;
use crate::wasm_bridge;

pub async fn serve(mode: i32, host: IpAddr, port: u16) {
    // Initialize WASM bridge if in WASM mode
    if wasm_bridge::is_wasm_mode() {
        if let Err(e) = wasm_bridge::init_wasm_bridge().await {
            log::error!("Failed to initialize WASM bridge: {}", e);
        }
    }

    let pid_state = Arc::new(Mutex::new(None));

    let cors = warp::cors()
        .allow_any_origin()
        .allow_headers(vec!["*", "Content-Type", "Authorization"])
        .allow_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS"]);

    // API Routes with /api prefix
    let api = warp::path("api");

    // CORS Preflight handler
    let cors_preflight = api
        .and(warp::options())
        .map(|| {
            warp::reply::with_status("", warp::http::StatusCode::OK)
        });

    // Server Info Routes
    let server_info = api
        .and(warp::path!("server" / "info"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(api::server_info_handler);

    // Process Routes
    let enum_process = api
        .and(warp::path!("processes"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move { api::enumerate_process_handler().await });

    let get_process_icon = api
        .and(warp::path!("processes" / i32 / "icon"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|pid| async move { api::get_process_icon_handler(pid).await });

    let enum_module = api
        .and(warp::path!("modules"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move { api::enumerate_modules_handler(pid_state).await });

    let enum_threads = api
        .and(warp::path!("threads"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move { api::enumerate_threads_handler(pid_state).await });

    let enum_symbols = api
        .and(warp::path!("modules" / usize / "symbols"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|module_base, pid_state| async move { 
            api::enumerate_symbols_handler(module_base, pid_state).await 
        });

    let open_process = api
        .and(warp::path!("processes" / i32 / "attach"))
        .and(warp::post())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid, pid_state| async move {
            let open_process = request::OpenProcessRequest { pid };
            api::open_process_handler(pid_state, open_process).await
        });

    let change_process_state = api
        .and(warp::path!("process" / "state"))
        .and(warp::put())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|state_request, pid_state| async move {
            api::change_process_state_handler(pid_state, state_request).await
        });

    let get_process_info = api
        .and(warp::path!("process" / "info"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move { api::get_app_info_handler(pid_state).await });
    // Memory Operation Routes
    let read_memory = api
        .and(warp::path!("memory" / "read"))
        .and(warp::get())
        .and(warp::query::<request::ReadMemoryRequest>())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|read_memory_request, pid_state| async move {
            api::read_memory_handler(pid_state, read_memory_request).await
        });

    let write_memory = api
        .and(warp::path!("memory" / "write"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|write_memory, pid_state| async move {
            api::write_memory_handler(pid_state, write_memory).await
        });

    let enum_regions = api
        .and(warp::path!("memory" / "regions"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and(warp::query::<api::EnumerateRegionsQuery>())
        .and_then(|pid_state, query: api::EnumerateRegionsQuery| async move { 
            api::enumerate_regions_handler(pid_state, query.include_file_path.unwrap_or(false)).await 
        });

    // Memory Analysis Routes
    let memory_scan = api
        .and(warp::path!("memory" / "scan"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|scan_request, pid_state| async move {
            api::memory_scan_handler(pid_state, scan_request).await
        });

    let yara_scan = api
        .and(warp::path!("memory" / "yara"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|scan_request, pid_state| async move {
            api::yara_scan_handler(pid_state, scan_request).await
        });

    let memory_filter = api
        .and(warp::path!("memory" / "filter"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|filter_request, pid_state| async move {
            api::memory_filter_handler(pid_state, filter_request).await
        });

    let get_scan_progress = api
        .and(warp::path!("memory" / "scan" / "progress"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(|scan_progress_request| async move {
            api::get_scan_progress_handler(scan_progress_request).await
        });

    let get_filter_progress = api
        .and(warp::path!("memory" / "filter" / "progress"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(|filter_progress_request| async move {
            api::get_filter_progress_handler(filter_progress_request).await
        });

    let get_scan_results = api
        .and(warp::path!("memory" / "scan" / "results"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(|scan_results_request| async move {
            api::get_scan_results_handler(scan_results_request).await
        });

    let get_filter_results = api
        .and(warp::path!("memory" / "filter" / "results"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(|filter_results_request| async move {
            api::get_scan_results_handler(filter_results_request).await
        });

    let stop_scan = api
        .and(warp::path!("memory" / "scan" / "stop"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(|stop_scan_request| async move {
            api::stop_scan_handler(stop_scan_request).await
        });

    let clear_scan = api
        .and(warp::path!("memory" / "scan" / "clear"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|clear_scan_request, pid_state| async move {
            api::clear_scan_handler(pid_state, clear_scan_request).await
        });

    let disassemble = api
        .and(warp::path!("memory" / "disassemble"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|disasm_request, pid_state| async move {
            api::disassemble_handler(disasm_request, pid_state).await
        });

    // Pointer Map Routes
    let generate_pointermap = api
        .and(warp::path!("memory" / "pointermap"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move {
            api::generate_pointermap_handler(pid_state).await
        });

    let start_pointermap = api
        .and(warp::path!("memory" / "pointermap" / "start"))
        .and(warp::post())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move {
            api::start_pointermap_handler(pid_state).await
        });

    let pointermap_progress = api
        .and(warp::path!("memory" / "pointermap" / "progress"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|progress_request| async move {
            api::pointermap_progress_handler(progress_request).await
        });

    let pointermap_download = api
        .and(warp::path!("memory" / "pointermap" / "download"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|progress_request| async move {
            api::pointermap_download_handler(progress_request).await
        });

    // Debug Routes
    let set_watchpoint = api
        .and(warp::path!("debug" / "watchpoint"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|set_watchpoint_request, pid_state| async move {
            api::set_watchpoint_handler(pid_state, set_watchpoint_request).await
        });

    let remove_watchpoint = api
        .and(warp::path!("debug" / "watchpoint"))
        .and(warp::delete())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|remove_watchpoint_request, pid_state| async move {
            api::remove_watchpoint_handler(pid_state, remove_watchpoint_request).await
        });

    let list_watchpoints = api
        .and(warp::path!("debug" / "watchpoints"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move {
            let request = request::ListWatchPointsRequest {};
            api::list_watchpoints_handler(pid_state, request).await
        });

    let set_breakpoint = api
        .and(warp::path!("debug" / "breakpoint"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|set_breakpoint_request, pid_state| async move {
            api::set_breakpoint_handler(pid_state, set_breakpoint_request).await
        });

    let remove_breakpoint = api
        .and(warp::path!("debug" / "breakpoint"))
        .and(warp::delete())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|remove_breakpoint_request, pid_state| async move {
            api::remove_breakpoint_handler(pid_state, remove_breakpoint_request).await
        });

    // Get software breakpoint original bytes
    let get_software_bp_bytes = api
        .and(warp::path!("debug" / "breakpoint" / "software" / usize))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|address: usize| async move {
            api::get_software_breakpoint_bytes_handler(address).await
        });

    // Signal configuration routes (catch/pass behavior)
    let get_signal_configs = api
        .and(warp::path!("debug" / "signals"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move {
            api::get_signal_configs_handler().await
        });

    let set_signal_config = api
        .and(warp::path!("debug" / "signals"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::set_signal_config_handler(request).await
        });

    let set_all_signal_configs = api
        .and(warp::path!("debug" / "signals" / "all"))
        .and(warp::put())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::set_all_signal_configs_handler(request).await
        });

    let remove_signal_config = api
        .and(warp::path!("debug" / "signals" / "remove"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::remove_signal_config_handler(request).await
        });

    // Trace status and download routes
    let get_trace_status = api
        .and(warp::path!("debug" / "trace" / "status"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move {
            api::get_trace_status_handler().await
        });

    let download_trace_file = api
        .and(warp::path!("debug" / "trace" / "file" / "download"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move {
            api::download_trace_file_handler().await
        });

    // New break state control routes
    let continue_execution = api
        .and(warp::path!("debug" / "continue"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|continue_request, pid_state| async move {
            api::continue_execution_handler(pid_state, continue_request).await
        });

    let single_step = api
        .and(warp::path!("debug" / "step"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|step_request, pid_state| async move {
            api::single_step_handler(pid_state, step_request).await
        });

    let read_register = api
        .and(warp::path!("debug" / "register" / "read"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|read_request, pid_state| async move {
            api::read_register_handler(pid_state, read_request).await
        });

    let write_register = api
        .and(warp::path!("debug" / "register" / "write"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|write_request, pid_state| async move {
            api::write_register_handler(pid_state, write_request).await
        });

    let debug_state = api
        .and(warp::path!("debug" / "state"))
        .and(warp::get())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|pid_state| async move {
            let debug_state_request = request::DebugStateRequest {};
            api::debug_state_handler(pid_state, debug_state_request).await
        });

    // Auth Routes
    // クライアント検証エンドポイント
    let verify_client = api
        .and(warp::path!("auth" / "verify"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(|verification_request| async move {
            api::verify_client_handler(verification_request).await
        });

    // トークン無効化エンドポイント (simplified - auth disabled)
    let logout = api
        .and(warp::path!("auth" / "logout"))
        .and(warp::post())
        .and(api::with_auth())
        .and_then(|| async move {
            let response = serde_json::json!({
                "success": true,
                "message": "Logout successful (auth disabled)"
            });
            Ok::<_, warp::Rejection>(warp::reply::json(&response))
        });

    // Utility Routes
    let resolve_addr = api
        .and(warp::path!("memory" / "resolve"))
        .and(warp::get())
        .and(warp::query::<request::ResolveAddrRequest>())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|resolve_addr_request, pid_state| async move {
            api::resolve_addr_handler(pid_state, resolve_addr_request).await
        });

    let explore_directory = api
        .and(warp::path!("utils" / "directory"))
        .and(warp::get())
        .and(warp::query::<request::ExploreDirectoryRequest>())
        .and(api::with_auth())
        .and_then(|explore_directory_request| async move {
            api::explore_directory_handler(explore_directory_request).await
        });

    let read_file = api
        .and(warp::path!("utils" / "file"))
        .and(warp::get())
        .and(warp::query::<request::ReadFileRequest>())
        .and(api::with_auth())
        .and_then(|read_file_request| async move { 
            api::read_file_handler(read_file_request).await 
        });

    let upload_file = api
        .and(warp::path!("utils" / "file"))
        .and(warp::post())
        .and(warp::query::<request::UploadFileRequest>())
        .and(warp::body::bytes())
        .and(api::with_auth())
        .and_then(|upload_request: request::UploadFileRequest, body: Bytes| async move {
            api::upload_file_handler(upload_request.path, body).await
        });

    // WASM binary dump for Ghidra analysis
    let wasm_dump = api
        .and(warp::path!("wasm" / "dump"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move {
            api::wasm_dump_handler().await
        });

    // WASM module info
    let wasm_info = api
        .and(warp::path!("wasm" / "info"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move {
            api::wasm_info_handler().await
        });

    let get_exception_info = api
        .and(warp::path!("debug" / "exception"))
        .and(warp::get())
        .and(warp::query::<std::collections::HashMap<String, String>>()
            .or(warp::any().map(|| std::collections::HashMap::new()))
            .unify())
        .and(api::with_auth())
        .and_then(|query_params: std::collections::HashMap<String, String>| async move { 
            let exception_type_filter = query_params.get("exception_type").cloned();
            let singlestep_mode_filter = query_params.get("singlestep_mode").cloned();
            api::get_exception_info_handler(exception_type_filter, singlestep_mode_filter).await 
        });

    // Execute general-purpose script (async)
    let execute_script = api
        .and(warp::path!("script" / "execute"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|script_request: request::ExecuteScriptRequest, pid_state| async move {
            api::execute_script_handler(pid_state, script_request).await
        });

    // Get script execution status
    let script_status = api
        .and(warp::path!("script" / "status" / String))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|job_id: String| async move {
            api::script_status_handler(job_id).await
        });

    // Cancel script execution
    let script_cancel = api
        .and(warp::path!("script" / String))
        .and(warp::delete())
        .and(api::with_auth())
        .and_then(|job_id: String| async move {
            api::script_cancel_handler(job_id).await
        });

    // Disable script session (removes all script-owned breakpoints)
    let script_disable = api
        .and(warp::path!("script" / "disable"))
        .and(warp::post())
        .and(api::with_auth())
        .and_then(|| async move {
            api::script_disable_handler().await
        });

    // List installed apps
    let get_installed_apps = api
        .and(warp::path!("apps"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|| async move {
            api::get_installed_apps_handler().await
        });

    // Get app icon
    let get_app_icon = api
        .and(warp::path!("apps" / "icon"))
        .and(warp::get())
        .and(warp::query::<request::GetAppIconRequest>())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::get_app_icon_handler(request).await
        });

    // Spawn app via FBSSystemService
    let spawn_app = api
        .and(warp::path!("apps" / "spawn"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|request, pid_state| async move {
            api::spawn_app_handler(pid_state, request).await
        });

    // Spawn process via fork/exec (Linux)
    let spawn_process = api
        .and(warp::path!("process" / "spawn"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|request, pid_state| async move {
            api::spawn_process_handler(pid_state, request).await
        });

    // Spawn process with PTY (Linux)
    let spawn_process_pty = api
        .and(warp::path!("process" / "spawn-pty"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|request, pid_state| async move {
            api::spawn_process_with_pty_handler(pid_state, request).await
        });

    // PTY read
    let pty_read = api
        .and(warp::path!("pty" / i32 / "read"))
        .and(warp::get())
        .and(api::with_auth())
        .and_then(|pty_fd| async move {
            api::pty_read_handler(pty_fd).await
        });

    // PTY write
    let pty_write = api
        .and(warp::path!("pty" / "write"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::pty_write_handler(request).await
        });

    // PTY resize
    let pty_resize = api
        .and(warp::path!("pty" / "resize"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::pty_resize_handler(request).await
        });

    // PTY close
    let pty_close = api
        .and(warp::path!("pty" / i32 / "close"))
        .and(warp::post())
        .and(api::with_auth())
        .and_then(|pty_fd| async move {
            api::pty_close_handler(pty_fd).await
        });

    // Terminate app
    let terminate_app = api
        .and(warp::path!("apps" / "terminate"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::terminate_app_handler(request).await
        });

    // Resume suspended app
    let resume_app = api
        .and(warp::path!("apps" / "resume"))
        .and(warp::post())
        .and(warp::body::json())
        .and(api::with_auth())
        .and(api::with_state(pid_state.clone()))
        .and_then(|request, pid_state| async move {
            api::resume_app_handler(pid_state, request).await
        });

    // Check app running status
    let get_app_running_status = api
        .and(warp::path!("apps" / "status"))
        .and(warp::get())
        .and(warp::query::<request::AppRunningStatusRequest>())
        .and(api::with_auth())
        .and_then(|request| async move {
            api::get_app_running_status_handler(request).await
        });

    // Combine all routes - grouped with boxed() to reduce type nesting depth
    
    // Group 1: Basic routes
    let basic_routes = cors_preflight
        .or(server_info)
        .or(enum_process)
        .or(get_process_icon)
        .or(enum_module)
        .or(enum_threads)
        .or(enum_symbols)
        .or(open_process)
        .or(change_process_state)
        .or(get_process_info)
        .boxed();
    
    // Group 2: Memory routes
    let memory_routes = read_memory
        .or(write_memory)
        .or(enum_regions)
        .or(yara_scan)
        .or(memory_scan)
        .or(memory_filter)
        .or(get_scan_progress)
        .or(get_filter_progress)
        .or(get_scan_results)
        .or(get_filter_results)
        .or(stop_scan)
        .or(clear_scan)
        .or(disassemble)
        .or(generate_pointermap)
        .or(start_pointermap)
        .or(pointermap_progress)
        .or(pointermap_download)
        .or(resolve_addr)
        .boxed();
    
    // Group 3: Debug routes
    let debug_routes = set_watchpoint
        .or(remove_watchpoint)
        .or(list_watchpoints)
        .or(set_breakpoint)
        .or(remove_breakpoint)
        .or(get_software_bp_bytes)
        .or(get_signal_configs)
        .or(set_signal_config)
        .or(set_all_signal_configs)
        .or(remove_signal_config)
        .or(get_trace_status)
        .or(download_trace_file)
        .or(continue_execution)
        .or(single_step)
        .or(read_register)
        .or(write_register)
        .or(debug_state)
        .or(get_exception_info)
        .boxed();
    
    // Group 4: Utility routes
    let utility_routes = explore_directory
        .or(read_file)
        .or(upload_file)
        .or(wasm_dump)
        .or(wasm_info)
        .or(execute_script)
        .or(script_status)
        .or(script_disable)
        .or(script_cancel)
        .boxed();
    
    // Group 5: App management routes
    let app_routes = get_installed_apps
        .or(get_app_icon)
        .or(spawn_app)
        .or(spawn_process)
        .or(spawn_process_pty)
        .or(pty_read)
        .or(pty_write)
        .or(pty_resize)
        .or(pty_close)
        .or(terminate_app)
        .or(resume_app)
        .or(get_app_running_status)
        .boxed();
    
    // Group 6: Auth routes
    let auth_routes = verify_client
        .or(logout)
        .boxed();
    
    // Combine all groups
    let routes = basic_routes
        .or(memory_routes)
        .or(debug_routes)
        .or(utility_routes)
        .or(app_routes)
        .or(auth_routes)
        .with(cors)
        .with(warp::log::custom(logger::http_log))
        .recover(api::handle_auth_rejection);

    native_bridge::native_api_init(mode);
    
    // Initialize MachOKit parser for symbol enumeration (macOS/iOS only)
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if let Err(e) = crate::macho_bridge::init_macho_parser() {
            log::warn!("Failed to initialize Symbol parser: {}", e);
        } else {
            // log::info!("MachOKit parser initialized successfully");
        }
    }
    
    warp::serve(routes).run((host, port)).await;
}
