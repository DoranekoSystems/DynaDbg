extern crate cc;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Build MachOKit as a static library for the target platform
fn build_machokit(target_os: &str, target_arch: &str) -> Option<PathBuf> {
    let machokit_dir = Path::new("../MachOKit");
    
    if !machokit_dir.exists() {
        println!("cargo:warning=MachOKit directory not found at {:?}", machokit_dir);
        return None;
    }

    // Determine the build directory based on target
    let (swift_target, build_subdir) = match (target_os, target_arch) {
        ("macos", "aarch64") => ("arm64-apple-macosx", "arm64-apple-macosx"),
        ("macos", "x86_64") => ("x86_64-apple-macosx", "x86_64-apple-macosx"),
        ("ios", "aarch64") => ("arm64-apple-ios", "arm64-apple-ios"),
        _ => {
            println!("cargo:warning=Unsupported target for MachOKit: {}-{}", target_os, target_arch);
            return None;
        }
    };

    let release_dir = machokit_dir.join(".build-xcode").join(build_subdir).join("release");
    let static_lib = release_dir.join("libMachOKit.a");

    // Check if we need to rebuild
    let needs_rebuild = !static_lib.exists();

    if needs_rebuild {
        println!("cargo:warning=Building MachOKit for {} ({})...", target_os, target_arch);
        
        // Build MachOKit using Swift Package Manager
        let mut swift_build_cmd = Command::new("swift");
        swift_build_cmd
            .current_dir(machokit_dir)
            .args(&["build", "-c", "release"]);
        
        // For iOS, we need to specify the target and SDK
        if target_os == "ios" {
            // Get iOS SDK path
            if let Ok(sdk_output) = Command::new("xcrun")
                .args(&["--sdk", "iphoneos", "--show-sdk-path"])
                .output()
            {
                let sdk_path = String::from_utf8_lossy(&sdk_output.stdout).trim().to_string();
                swift_build_cmd.args(&["--sdk", &sdk_path, "--triple", swift_target]);
            } else {
                swift_build_cmd.args(&["--triple", swift_target]);
            }
        }
        
        let build_result = swift_build_cmd.output();
        
        match build_result {
            Ok(output) => {
                if !output.status.success() {
                    println!("cargo:warning=MachOKit build failed: {}", String::from_utf8_lossy(&output.stderr));
                    return None;
                }
                println!("cargo:warning=MachOKit build completed successfully");
            }
            Err(e) => {
                println!("cargo:warning=Failed to run swift build: {}", e);
                return None;
            }
        }

        // Create static library from object files
        let machokit_build_dir = release_dir.join("MachOKit.build");
        let machokitc_build_dir = release_dir.join("MachOKitC.build");
        let fileio_build_dir = release_dir.join("FileIO.build");

        if machokit_build_dir.exists() {
            // Collect all .o files
            let mut object_files: Vec<PathBuf> = Vec::new();
            
            for dir in &[&machokit_build_dir, &machokitc_build_dir, &fileio_build_dir] {
                if dir.exists() {
                    if let Ok(entries) = fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.extension().map_or(false, |ext| ext == "o") {
                                object_files.push(path);
                            }
                        }
                    }
                }
            }

            if !object_files.is_empty() {
                // Create static library using ar
                let mut ar_cmd = Command::new("ar");
                ar_cmd
                    .current_dir(&release_dir)
                    .arg("-crs")
                    .arg("libMachOKit.a");
                for obj in &object_files {
                    ar_cmd.arg(obj);
                }

                match ar_cmd.output() {
                    Ok(output) => {
                        if output.status.success() {
                            println!("cargo:warning=Created libMachOKit.a with {} object files", object_files.len());
                        } else {
                            println!("cargo:warning=Failed to create static library: {}", String::from_utf8_lossy(&output.stderr));
                            return None;
                        }
                    }
                    Err(e) => {
                        println!("cargo:warning=Failed to run ar: {}", e);
                        return None;
                    }
                }
            }
        }
    }

    if static_lib.exists() {
        Some(release_dir.canonicalize().unwrap_or(release_dir))
    } else {
        None
    }
}

/// Build MachOBridge Swift wrapper using xcodebuild
fn build_macho_bridge(target_os: &str, target_arch: &str) -> Option<PathBuf> {
    let bridge_dir = Path::new("src/swift");
    
    if !bridge_dir.exists() {
        println!("cargo:warning=MachOBridge directory not found at {:?}", bridge_dir);
        return None;
    }

    // Determine destination, SDK, and paths based on target
    // Use separate build directories for each platform to avoid conflicts
    let (destination, sdk, derived_data_suffix, products_subpath) = match (target_os, target_arch) {
        ("macos", "aarch64") | ("macos", "x86_64") => {
            ("generic/platform=macOS", "macosx", "macos", "Build/Products/Release")
        }
        ("ios", "aarch64") => {
            ("generic/platform=iOS", "iphoneos", "ios", "Build/Products/Release-iphoneos")
        }
        _ => {
            println!("cargo:warning=Unsupported target for MachOBridge: {}-{}", target_os, target_arch);
            return None;
        }
    };

    let derived_data_dir = format!(".build-xcode-{}", derived_data_suffix);
    let build_xcode_dir = bridge_dir.join(&derived_data_dir);
    let products_dir = build_xcode_dir.join(products_subpath);
    let static_lib = products_dir.join("libMachOBridge.a");

    // Check if library already exists and has reasonable size (> 1MB) - skip build if valid
    if static_lib.exists() {
        if let Ok(metadata) = fs::metadata(&static_lib) {
            if metadata.len() > 1_000_000 {
                println!("cargo:warning=Using existing libMachOBridge.a at {} ({} bytes)", 
                         static_lib.display(), metadata.len());
                return Some(products_dir.canonicalize().unwrap_or(products_dir));
            } else {
                println!("cargo:warning=Existing libMachOBridge.a is too small ({} bytes), rebuilding...", 
                         metadata.len());
            }
        }
    }

    println!("cargo:warning=Building MachOBridge for {} ({}) using xcodebuild...", target_os, target_arch);
    
    // Build using xcodebuild with code signing disabled for CI environments
    let xcodebuild_args: Vec<String> = vec![
        "-scheme".to_string(), "MachOBridge".to_string(),
        "-configuration".to_string(), "Release".to_string(),
        "-destination".to_string(), destination.to_string(),
        "-sdk".to_string(), sdk.to_string(),
        "-derivedDataPath".to_string(), derived_data_dir.clone(),
        "SKIP_INSTALL=NO".to_string(),
        // Disable code signing for CI builds
        "CODE_SIGN_IDENTITY=".to_string(),
        "CODE_SIGNING_REQUIRED=NO".to_string(),
        "CODE_SIGNING_ALLOWED=NO".to_string(),
        "build".to_string(),
    ];
    
    let build_result = Command::new("xcodebuild")
        .current_dir(bridge_dir)
        .args(&xcodebuild_args)
        .output();
    
    match build_result {
        Ok(output) => {
            if !output.status.success() {
                println!("cargo:warning=MachOBridge xcodebuild failed: {}", String::from_utf8_lossy(&output.stderr));
                println!("cargo:warning=stdout: {}", String::from_utf8_lossy(&output.stdout));
                return None;
            }
            println!("cargo:warning=MachOBridge xcodebuild completed successfully");
        }
        Err(e) => {
            println!("cargo:warning=Failed to run xcodebuild for MachOBridge: {}", e);
            return None;
        }
    }

    // xcodebuild generates .o files in Products dir - we need to create static library manually
    // Convert to absolute paths
    let abs_products_dir = bridge_dir.canonicalize()
        .unwrap_or_else(|_| bridge_dir.to_path_buf())
        .join(&derived_data_dir)
        .join(products_subpath);
    let abs_static_lib = abs_products_dir.join("libMachOBridge.a");
    
    // Collect .o files from Products directory (MachOBridge.o, MachOKit.o, FileIO.o, MachOKitC.o)
    let object_files: Vec<PathBuf> = ["MachOBridge.o", "MachOKit.o", "FileIO.o", "MachOKitC.o"]
        .iter()
        .map(|name| abs_products_dir.join(name))
        .filter(|p| p.exists())
        .collect();
    
    if object_files.is_empty() {
        println!("cargo:warning=No object files found in {:?}", abs_products_dir);
        return None;
    }
    
    println!("cargo:warning=Found {} object files to archive: {:?}", object_files.len(), 
             object_files.iter().map(|p| p.file_name().unwrap_or_default()).collect::<Vec<_>>());
    
    // Remove existing library if present (may have wrong permissions)
    if abs_static_lib.exists() {
        let _ = fs::remove_file(&abs_static_lib);
    }
    
    // Create the static library using ar
    let mut ar_cmd = Command::new("ar");
    ar_cmd
        .arg("-crs")
        .arg(&abs_static_lib);
    
    for obj in &object_files {
        ar_cmd.arg(obj);
    }
    
    match ar_cmd.output() {
        Ok(output) => {
            if output.status.success() {
                println!("cargo:warning=Created libMachOBridge.a with {} object files", object_files.len());
            } else {
                println!("cargo:warning=Failed to create libMachOBridge.a: {}", String::from_utf8_lossy(&output.stderr));
                return None;
            }
        }
        Err(e) => {
            println!("cargo:warning=Failed to run ar: {}", e);
            return None;
        }
    }

    if abs_static_lib.exists() {
        println!("cargo:warning=libMachOBridge.a created at {}", abs_static_lib.display());
        return Some(abs_products_dir);
    }
    
    None
}

/// Setup MachOKit linking for macOS/iOS targets
fn setup_machokit_linking(target_os: &str, target_arch: &str) {
    let mut machokit_lib_path: Option<PathBuf> = None;
    let mut macho_bridge_lib_path: Option<PathBuf> = None;
    
    // Build MachOKit
    if let Some(lib_path) = build_machokit(target_os, target_arch) {
        machokit_lib_path = Some(lib_path.clone());
        println!("cargo:warning=MachOKit built at {}", lib_path.display());
    }
    
    // Build MachOBridge
    if let Some(bridge_lib_path) = build_macho_bridge(target_os, target_arch) {
        macho_bridge_lib_path = Some(bridge_lib_path.clone());
        println!("cargo:warning=MachOBridge built at {}", bridge_lib_path.display());
    }
    
    // Link Swift libraries directly using linker args for proper ordering
    // Order matters: MachOBridge depends on MachOKit
    if let Some(ref bridge_path) = macho_bridge_lib_path {
        let lib_file = bridge_path.join("libMachOBridge.a");
        if lib_file.exists() {
            // Use -force_load to ensure all symbols are included
            println!("cargo:rustc-link-arg=-force_load");
            println!("cargo:rustc-link-arg={}", lib_file.display());
            println!("cargo:warning=MachOBridge linked via -force_load: {}", lib_file.display());
        }
    }
    
    if let Some(ref machokit_path) = machokit_lib_path {
        let lib_file = machokit_path.join("libMachOKit.a");
        if lib_file.exists() {
            println!("cargo:rustc-link-arg=-force_load");
            println!("cargo:rustc-link-arg={}", lib_file.display());
            println!("cargo:warning=MachOKit linked via -force_load: {}", lib_file.display());
        }
    }
    
    // Swift runtime libraries needed for MachOKit/MachOBridge
    println!("cargo:rustc-link-arg=-Xlinker");
    println!("cargo:rustc-link-arg=-rpath");
    println!("cargo:rustc-link-arg=-Xlinker");
    println!("cargo:rustc-link-arg=/usr/lib/swift");
    
    // Get Swift library paths based on target
    let swift_platform = if target_os == "ios" { "iphoneos" } else { "macosx" };
    let sdk_name = if target_os == "ios" { "iphoneos" } else { "macosx" };
    
    // Link Swift standard library from SDK
    if let Ok(sdk_output) = Command::new("xcrun")
        .args(&["--sdk", sdk_name, "--show-sdk-path"])
        .output() {
        let sdk_path = String::from_utf8_lossy(&sdk_output.stdout).trim().to_string();
        let swift_lib_sdk = format!("{}/usr/lib/swift", sdk_path);
        println!("cargo:rustc-link-search=native={}", swift_lib_sdk);
    }
    
    // Get Swift toolchain library path and link static Swift runtime
    if let Ok(swift_lib_path) = Command::new("xcrun")
        .args(&["--toolchain", "default", "--find", "swift"])
        .output() {
        let swift_path = String::from_utf8_lossy(&swift_lib_path.stdout).trim().to_string();
        if let Some(parent) = Path::new(&swift_path).parent().and_then(|p| p.parent()) {
            let swift_lib = parent.join(format!("lib/swift/{}", swift_platform));
            if swift_lib.exists() {
                println!("cargo:rustc-link-search=native={}", swift_lib.display());
            }
            // Add static lib path for Swift runtime (only if libswiftCore.a exists)
            let swift_lib_static = parent.join(format!("lib/swift_static/{}", swift_platform));
            let swift_core_static = swift_lib_static.join("libswiftCore.a");
            if swift_core_static.exists() {
                println!("cargo:rustc-link-search=native={}", swift_lib_static.display());
                // Link Swift static runtime libraries
                println!("cargo:rustc-link-lib=static=swiftCore");
                println!("cargo:rustc-link-lib=static=swiftCompatibility50");
                println!("cargo:rustc-link-lib=static=swiftCompatibility51");
                println!("cargo:rustc-link-lib=static=swiftCompatibilityConcurrency");
                println!("cargo:rustc-link-lib=static=swift_Concurrency");
                println!("cargo:warning=Linked Swift static runtime from {}", swift_lib_static.display());
            } else {
                // Fall back to dynamic Swift runtime
                println!("cargo:warning=Swift static runtime not found, using dynamic linking");
            }
            
            // Also check clang lib for __chkstk_darwin
            let clang_lib = parent.join("lib/clang");
            if clang_lib.exists() {
                // Find the clang version directory
                if let Ok(entries) = fs::read_dir(&clang_lib) {
                    for entry in entries.flatten() {
                        let clang_rt_path = entry.path().join(format!("lib/darwin/libclang_rt.{}.a", swift_platform));
                        if clang_rt_path.exists() {
                            println!("cargo:rustc-link-arg={}", clang_rt_path.display());
                            println!("cargo:warning=Linked clang runtime: {}", clang_rt_path.display());
                            break;
                        }
                        // Also try ios.a format
                        let clang_rt_ios = entry.path().join("lib/darwin/libclang_rt.ios.a");
                        if clang_rt_ios.exists() {
                            println!("cargo:rustc-link-arg={}", clang_rt_ios.display());
                            println!("cargo:warning=Linked clang runtime: {}", clang_rt_ios.display());
                            break;
                        }
                    }
                }
            }
        }
    }
    
    // Link system libraries required by Swift
    println!("cargo:rustc-link-lib=c++");
}

fn main() {
    println!("cargo:rustc-link-search=native=/usr/local/lib");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".to_string());
    
    // Build and link MachOKit for macOS/iOS targets
    if target_os == "macos" || target_os == "ios" {
        setup_machokit_linking(&target_os, &target_arch);
    }


    let mut build = cc::Build::new();
    println!("cargo:rustc-env=TARGET_OS={}", target_os);
    
    // Set GIT_HASH
    let git_hash = std::process::Command::new("git")
        .args(&["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GIT_HASH={}", git_hash);

    if cfg!(windows) {
        println!("cargo:rustc-cfg=host_os=\"windows\"");
    }

    if target_os == "windows" {
        build.flag("/std:c++17").flag("/W4").flag("/Zi");
    } else {
        build.flag("-std=c++17").flag("-Wall").flag("-v").flag("-g");
    }

    // Check if LOG_DEVELOP should be enabled
    let enable_log_develop = std::env::var("ENABLE_LOG_DEVELOP").is_ok();
    if enable_log_develop {
        build.flag_if_supported("-DENABLE_LOG_DEVELOP");
        // Rustコード用のcfgフラグを設定
        println!("cargo:rustc-cfg=feature=\"ENABLE_LOG_DEVELOP\"");
    } 

    match target_os.as_str() {
        "windows" => {
            if build.get_compiler().is_like_msvc() {
                build.flag("/FS"); // Fixes the PDB write issue
                build.flag("/EHsc"); // Enables proper exception handling
            }
            // Link with Windows debug help library for symbol enumeration
            println!("cargo:rustc-link-lib=dbghelp");
            
            // Track source file changes for incremental builds
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/native_api.cpp");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/native_api.h");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/memory_io.cpp");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/memory_io.h");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/file_api.cpp");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/file_api.h");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/core/callback_stubs.cpp");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/debugger/debugger.cpp");
            println!("cargo:rerun-if-changed=src/cpp/src/windows/debugger/debugger.h");
            println!("cargo:rerun-if-changed=src/cpp/src/common/exception_info.h");
            
            build.file("src/cpp/src/windows/core/native_api.cpp");
            build.file("src/cpp/src/windows/core/memory_io.cpp");
            build.file("src/cpp/src/windows/core/file_api.cpp");
            build.file("src/cpp/src/windows/core/callback_stubs.cpp");
            build.file("src/cpp/src/windows/debugger/debugger.cpp");
        }
        "macos" => {
            println!("cargo:rustc-link-arg=-lc++");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=Foundation");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=AVFoundation");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=CoreMedia");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=BackgroundTasks");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=SystemConfiguration");

            // Set macOS deployment target
            build.flag("-mmacosx-version-min=10.12");

            build.file("src/cpp/src/darwin/core/native_api.mm");
            build.file("src/cpp/src/darwin/core/file_api.mm");
            build.file("src/cpp/src/darwin/core/memory_io.mm");
            build.file("src/cpp/src/darwin/core/process_api.mm");
            // Debugger (split into multiple files)
            build.file("src/cpp/src/darwin/debugger/debugger_core.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_breakpoint.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_watchpoint.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_exception.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_register.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_trace.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_native_api.mm");
            build.file("src/cpp/src/common/util.cpp");
            build.file("src/cpp/src/common/trace_file.cpp");
            build.file("src/cpp/src/common/arm64_decoder.cpp");
        }
        "ios" => {
            println!("cargo:rustc-link-arg=-lc++");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=Foundation");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=UIKit");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=AVFoundation");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=CoreMedia");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=BackgroundTasks");
            println!("cargo:rustc-link-arg=-framework");
            println!("cargo:rustc-link-arg=SystemConfiguration");

            // Set iOS deployment target to match Rust's target
            build.flag("-mios-version-min=10.0");

            build.file("src/cpp/src/darwin/core/native_api.mm");
            build.file("src/cpp/src/darwin/core/file_api.mm");
            build.file("src/cpp/src/darwin/core/memory_io.mm");
            build.file("src/cpp/src/darwin/core/process_api.mm");
            // Debugger (split into multiple files)
            build.file("src/cpp/src/darwin/debugger/debugger_core.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_breakpoint.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_watchpoint.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_exception.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_register.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_trace.mm");
            build.file("src/cpp/src/darwin/debugger/debugger_native_api.mm");
            build.file("src/cpp/src/common/util.cpp");
            build.file("src/cpp/src/common/trace_file.cpp");
            build.file("src/cpp/src/common/arm64_decoder.cpp");
        }


        "android" => {
            build.cpp_link_stdlib("c++");
            println!("cargo:rustc-link-lib=dylib=c++_shared");
            println!("cargo:rustc-link-lib=dylib=c++abi");
            println!("cargo:rustc-link-arg=-Wl,-rpath={}", "$ORIGIN");
            build.flag_if_supported("-DTARGET_IS_ANDROID");
            // Core
            build.file("src/cpp/src/linux/core/native_api.cpp");
            build.file("src/cpp/src/linux/core/file_api.cpp");
            build.file("src/cpp/src/linux/core/memory_io.cpp");
            build.file("src/cpp/src/linux/core/callback_stubs.cpp");
            build.file("src/cpp/src/linux/core/process_api.cpp");
            // Debugger (split into multiple files)
            build.file("src/cpp/src/linux/debugger/debugger_core.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_breakpoint.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_watchpoint.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_exception.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_register.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_thread.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_spawn.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_memory.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_native_api.cpp");
            // ELF
            build.file("src/cpp/src/linux/elf/elf_parser.cpp");
            // PTY
            build.file("src/cpp/src/linux/pty/pty_manager.cpp");
            // Common
            build.file("src/cpp/src/common/util.cpp");
        }

        "linux" => {
            build.cpp(true);
            println!("cargo:rustc-link-arg=-lstdc++");
            // Export symbols from executable so dynamic library can resolve them via dlsym
            println!("cargo:rustc-link-arg=-rdynamic");
            // Add debug symbols and additional debugging info
            build.flag("-DDEBUG_MEMORY_ACCESS");
            build.flag("-DVERBOSE_LOGGING");
            // Core
            build.file("src/cpp/src/linux/core/native_api.cpp");
            build.file("src/cpp/src/linux/core/file_api.cpp");
            build.file("src/cpp/src/linux/core/memory_io.cpp");
            build.file("src/cpp/src/linux/core/callback_stubs.cpp");
            build.file("src/cpp/src/linux/core/process_api.cpp");
            // Debugger (split into multiple files)
            build.file("src/cpp/src/linux/debugger/debugger_core.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_breakpoint.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_watchpoint.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_exception.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_register.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_thread.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_spawn.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_memory.cpp");
            build.file("src/cpp/src/linux/debugger/debugger_native_api.cpp");
            // ELF
            build.file("src/cpp/src/linux/elf/elf_parser.cpp");
            // PTY
            build.file("src/cpp/src/linux/pty/pty_manager.cpp");
            // Common
            build.file("src/cpp/src/common/util.cpp");
        }

        _ => {
            panic!("Unsupported target OS");
        }
    }

    build.compile("libnative.a");
}
