#![recursion_limit = "256"]

use ctor::ctor;
use std::net::IpAddr;
use std::thread;

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
fn main() {
    thread::spawn(|| {
        let runtime = tokio::runtime::Runtime::new().unwrap();

        runtime.block_on(async {
            std::env::set_var("DBGSRV_RUNNING_MODE", "embedded");

            let host: IpAddr = "0.0.0.0".parse().unwrap();
            let port: u16 = 3030;
            
            logger::init_log(None);
            log::info!("memory_spy has started listening on host {} and port {}.", host, port);
            serve::serve(1, host, port).await;
        });
    });
}
