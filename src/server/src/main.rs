#![recursion_limit = "2048"]

use ctor::ctor;

use clap::{Arg, Command};
use std::env;
use std::net::IpAddr;

mod allocator;
mod api;
mod logger;
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod macho_bridge;
mod native_bridge;
mod request;
mod serve;
mod util;
mod wasm_bridge;

#[ctor]
fn init() {
    env::set_var("RUST_BACKTRACE", "full");
}

#[tokio::main]
async fn main() {
    std::env::set_var("DBGSRV_RUNNING_MODE", "normal");

    let matches = Command::new("dynadbg")
        .version("0.0.3")
        .about("Dynamic analysis tool")
        .arg(
            Arg::new("port")
                .short('p')
                .long("port")
                .num_args(1)
                .value_name("PORT")
                .help("Sets the port number to listen on"),
        )
        .arg(
            Arg::new("host")
                .short('H')
                .long("host")
                .num_args(1)
                .value_name("HOST")
                .help("Sets the host to listen on"),
        )
        .arg(
            Arg::new("log-file")
                .short('l')
                .long("log-file")
                .num_args(1)
                .value_name("FILE")
                .help("Sets the log file path (appends to existing file)"),
        )
        .arg(
            Arg::new("wasm")
                .long("wasm")
                .num_args(0)
                .help("Enable WASM mode for browser-based WebAssembly debugging"),
        )
        .arg(
            Arg::new("wasm-ws-port")
                .long("wasm-ws-port")
                .num_args(1)
                .value_name("PORT")
                .default_value("8765")
                .help("WebSocket port for WASM memory bridge (default: 8765)"),
        )
        .get_matches();

    let port: u16 = matches
        .get_one("port")
        .map(|s: &String| s.parse().expect("Valid port number"))
        .unwrap_or(3030);

    let host: IpAddr = matches
        .get_one("host")
        .map(|s: &String| s.parse().expect("Valid IP address"))
        .unwrap_or_else(|| "0.0.0.0".parse().unwrap());

    let log_file: Option<String> = matches
        .get_one("log-file")
        .map(|s: &String| s.to_string());

    let wasm_mode = matches.get_flag("wasm");
    let wasm_ws_port: u16 = matches
        .get_one::<String>("wasm-ws-port")
        .and_then(|s| s.parse().ok())
        .unwrap_or(8765);

    // Set running mode based on --wasm flag
    if wasm_mode {
        std::env::set_var("DBGSRV_RUNNING_MODE", "wasm");
        std::env::set_var("DBGSRV_WASM_WS_PORT", wasm_ws_port.to_string());
        println!("WASM mode enabled. WebSocket server will listen on port {}", wasm_ws_port);
    }

    println!(
        "DynaDbg server has started listening on host {} and port {}.",
        host, port
    );

    logger::init_log(log_file.as_deref());

    // Initialize WASM bridge if in WASM mode
    if wasm_mode {
        if let Err(e) = wasm_bridge::init_wasm_bridge().await {
            log::error!("Failed to initialize WASM bridge: {}", e);
            eprintln!("Failed to initialize WASM bridge: {}", e);
            return;
        }
    }

    // Lua engine is lightweight and doesn't need pre-initialization

    // Try to initialize dynamic library, fall back to static if not available
    // Currently only enabled in debug builds during development
    #[cfg(debug_assertions)]
    if native_bridge::init_dynamic_library() {
        log::info!("Dynamic library loaded successfully");
    }

    serve::serve(0, host, port).await;
}
