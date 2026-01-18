use crate::native_bridge;
use libc;
use lz4_flex::compress_prepend_size;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Progress callback type for pointermap generation
pub type ProgressCallback = Arc<dyn Fn(&str, u64, u64, u64, u64) + Send + Sync>;

#[repr(C)]
struct ModuleEntry {
    entry_length: u32,
    entry_string: String,
    memory_size: i32,
    memory_address: u64,
}

// Make StaticData Send + Sync for parallel processing
#[derive(Clone, Copy)]
struct StaticData {
    module_index: u32,
    offset: u32,
}

// Helper function to find module for a given address using binary search
fn find_static_data(address: u64, modules: &[ModuleEntry]) -> Option<StaticData> {
    match modules.binary_search_by(|module| {
        if address < module.memory_address {
            std::cmp::Ordering::Greater
        } else if address >= module.memory_address + module.memory_size as u64 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    }) {
        Ok(idx) => Some(StaticData {
            module_index: idx as u32,
            offset: (address - modules[idx].memory_address) as u32,
        }),
        Err(_) => None,
    }
}

// Process memory read helper function
fn read_memory(pid: i32, address: usize, size: usize) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0u8; size];

    match native_bridge::read_process_memory(pid, address as *mut libc::c_void, size, &mut buffer) {
        Ok(bytes_read) => {
            if bytes_read <= 0 {
                Err(format!("Failed to read memory at 0x{:x}", address))
            } else {
                buffer.truncate(bytes_read as usize);
                Ok(buffer)
            }
        }
        Err(e) => Err(format!("Failed to read memory at 0x{:x}: {}", address, e)),
    }
}

/// Region info for parallel processing
#[derive(Clone)]
struct RegionInfo {
    start_address: usize,
    end_address: usize,
    size: u64,
}

pub fn generate_pointermap(pid: i32) -> Result<Vec<u8>, String> {
    generate_pointermap_with_progress(pid, None)
}

pub fn generate_pointermap_with_progress(
    pid: i32,
    progress_callback: Option<ProgressCallback>,
) -> Result<Vec<u8>, String> {
    let progress_callback = progress_callback.map(Arc::new);

    let report_progress =
        |phase: &str, regions_done: u64, total_regions: u64, bytes_done: u64, total_bytes: u64| {
            if let Some(ref cb) = progress_callback {
                cb(phase, regions_done, total_regions, bytes_done, total_bytes);
            }
        };

    report_progress("Initializing", 0, 0, 0, 0);

    // Get memory regions
    let regions = native_bridge::enum_regions(pid)?;

    report_progress("Analyzing regions", 0, regions.len() as u64, 0, 0);

    // Helper function to check if a region should be skipped (iOS only)
    #[cfg(target_os = "ios")]
    fn should_skip_region(file_path: &str) -> bool {
        file_path.contains("dyld_shared_cache")
            || file_path.contains(".sqlite-shm")
            || file_path.contains(".db-shm")
            || file_path.contains("analyticsd")
            || file_path.contains("/usr/share/")
            || file_path.contains("/System/Library/Fonts")
            || file_path.contains("AppleKeyStore")
    }

    #[cfg(not(target_os = "ios"))]
    fn should_skip_region(_file_path: &str) -> bool {
        false
    }

    // Pre-filter and collect valid regions
    let mut valid_regions: Vec<RegionInfo> = Vec::new();
    let mut min_valid_addr = u64::MAX;
    let mut max_valid_addr: u64 = 0;

    for region in &regions {
        let start =
            u64::from_str_radix(region["start_address"].as_str().unwrap_or("0"), 16).unwrap_or(0);
        let end =
            u64::from_str_radix(region["end_address"].as_str().unwrap_or("0"), 16).unwrap_or(0);
        let protection = region["protection"].as_str().unwrap_or("");
        let file_path = region["file_path"].as_str().unwrap_or("");

        #[cfg(any(target_os = "ios", target_os = "macos"))]
        let is_valid = protection.contains('r');
        #[cfg(not(any(target_os = "ios", target_os = "macos")))]
        let is_valid = protection.contains('r') && protection.contains('p');

        if !is_valid || should_skip_region(file_path) {
            continue;
        }

        min_valid_addr = min_valid_addr.min(start);
        max_valid_addr = max_valid_addr.max(end);

        valid_regions.push(RegionInfo {
            start_address: start as usize,
            end_address: end as usize,
            size: end - start,
        });
    }

    let total_bytes_to_scan: u64 = valid_regions.iter().map(|r| r.size).sum();
    let valid_region_count = valid_regions.len() as u64;

    // Get modules
    let modules: Arc<Vec<ModuleEntry>> = Arc::new(match native_bridge::enum_modules(pid) {
        Ok(modules) => {
            let mut module_entries = Vec::new();
            for module in modules {
                let name = module["modulename"].as_str().unwrap_or("");
                let base = module["base"].as_u64().unwrap_or(0);
                let size: i32 = module["size"].as_i64().unwrap_or(0) as i32;
                module_entries.push(ModuleEntry {
                    entry_length: name.len() as u32,
                    entry_string: name.to_string(),
                    memory_size: size,
                    memory_address: base,
                });
            }
            module_entries
        }
        Err(e) => return Err(format!("Failed to enumerate modules: {}", e)),
    });

    report_progress(
        "Scanning memory",
        0,
        valid_region_count,
        0,
        total_bytes_to_scan,
    );

    // Atomic counters for progress tracking
    let processed_bytes = Arc::new(AtomicU64::new(0));
    let processed_regions = Arc::new(AtomicU64::new(0));

    // Use rayon for parallel processing if available, otherwise use threads
    let num_threads = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(4)
        .min(8); // Cap at 8 threads

    // Split regions into chunks for parallel processing
    let chunk_size = (valid_regions.len() + num_threads - 1) / num_threads;
    let region_chunks: Vec<Vec<RegionInfo>> = valid_regions
        .into_iter()
        .collect::<Vec<_>>()
        .chunks(chunk_size.max(1))
        .map(|c| c.to_vec())
        .collect();

    // Process regions in parallel using threads
    let handles: Vec<_> = region_chunks
        .into_iter()
        .map(|chunk| {
            let modules = Arc::clone(&modules);
            let processed_bytes = Arc::clone(&processed_bytes);
            let processed_regions = Arc::clone(&processed_regions);

            std::thread::spawn(move || {
                let mut local_map: HashMap<u64, Vec<(u64, Option<StaticData>)>> = HashMap::new();

                for region in chunk {
                    const CHUNK_SIZE: usize = 1024 * 1024 * 32; // 32MB chunks for better throughput
                    let mut current_address = region.start_address;

                    while current_address < region.end_address {
                        let chunk_end = (current_address + CHUNK_SIZE).min(region.end_address);
                        let chunk_size = chunk_end - current_address;

                        if chunk_size < 8 {
                            current_address = chunk_end;
                            continue;
                        }

                        if let Ok(memory) = read_memory(pid, current_address, chunk_size) {
                            // Process 8-byte aligned addresses only
                            let aligned_start = (current_address + 7) & !7;
                            let offset = aligned_start.saturating_sub(current_address);

                            // Use unsafe for faster memory access
                            let mem_slice = &memory[offset..];
                            let ptr_count = mem_slice.len() / 8;

                            for i in 0..ptr_count {
                                let idx = i * 8;
                                // Safe: we've verified bounds above
                                let value =
                                    u64::from_le_bytes(mem_slice[idx..idx + 8].try_into().unwrap());

                                // Quick range check first (most values will fail this)
                                if value >= min_valid_addr
                                    && value < max_valid_addr
                                    && value & 3 == 0
                                {
                                    let source_address = (aligned_start + idx) as u64;
                                    let static_data = find_static_data(source_address, &modules);
                                    local_map
                                        .entry(value)
                                        .or_insert_with(Vec::new)
                                        .push((source_address, static_data));
                                }
                            }

                            processed_bytes.fetch_add(memory.len() as u64, Ordering::Relaxed);
                        }

                        current_address = chunk_end;
                    }

                    processed_regions.fetch_add(1, Ordering::Relaxed);
                }

                local_map
            })
        })
        .collect();

    // Progress reporting thread
    let progress_callback_clone = progress_callback.clone();
    let processed_bytes_clone = Arc::clone(&processed_bytes);
    let processed_regions_clone = Arc::clone(&processed_regions);

    let progress_thread = std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let bytes = processed_bytes_clone.load(Ordering::Relaxed);
        let regions = processed_regions_clone.load(Ordering::Relaxed);

        if let Some(ref cb) = progress_callback_clone {
            cb(
                "Scanning memory",
                regions,
                valid_region_count,
                bytes,
                total_bytes_to_scan,
            );
        }

        if regions >= valid_region_count {
            break;
        }
    });

    // Merge results from all threads
    let mut pointer_map: HashMap<u64, Vec<(u64, Option<StaticData>)>> = HashMap::new();
    for handle in handles {
        let local_map = handle.join().unwrap();
        for (key, mut values) in local_map {
            pointer_map
                .entry(key)
                .or_insert_with(Vec::new)
                .append(&mut values);
        }
    }

    // Wait for progress thread to finish
    let _ = progress_thread.join();

    let final_bytes = processed_bytes.load(Ordering::Relaxed);
    let final_regions = processed_regions.load(Ordering::Relaxed);

    report_progress(
        "Building output",
        final_regions,
        valid_region_count,
        final_bytes,
        total_bytes_to_scan,
    );

    // Pre-allocate output buffer based on estimated size
    let estimated_size = 1024 + modules.len() * 64 + pointer_map.len() * 32;
    let mut uncompressed = Vec::with_capacity(estimated_size);

    // Write header: DynaDbg PointerMap format
    uncompressed.extend_from_slice(b"DPTR");
    uncompressed.extend_from_slice(&1u32.to_le_bytes());

    // Write modules
    uncompressed.extend_from_slice(&(modules.len() as u32).to_le_bytes());
    for module in modules.iter() {
        uncompressed.extend_from_slice(&module.entry_length.to_le_bytes());
        uncompressed.extend_from_slice(module.entry_string.as_bytes());
        uncompressed.extend_from_slice(&module.memory_address.to_le_bytes());
        uncompressed.extend_from_slice(&module.memory_size.to_le_bytes());
    }

    // Convert HashMap into a sorted Vec
    let mut sorted_entries: Vec<_> = pointer_map.into_iter().collect();
    sorted_entries.sort_unstable_by_key(|&(address, _)| address);

    // Total unique target addresses
    uncompressed.extend_from_slice(&(sorted_entries.len() as u64).to_le_bytes());

    // Total pointer count
    let total_count: u64 = sorted_entries.iter().map(|(_, v)| v.len() as u64).sum();
    uncompressed.extend_from_slice(&total_count.to_le_bytes());

    // Write all pointer entries
    for (target_value, mut pointers) in sorted_entries {
        pointers.sort_unstable_by_key(|(address, _)| *address);

        uncompressed.extend_from_slice(&target_value.to_le_bytes());
        uncompressed.extend_from_slice(&(pointers.len() as u32).to_le_bytes());

        for (address, static_data) in pointers {
            uncompressed.extend_from_slice(&address.to_le_bytes());

            match static_data {
                Some(data) => {
                    uncompressed.push(1);
                    uncompressed.extend_from_slice(&data.module_index.to_le_bytes());
                    uncompressed.extend_from_slice(&data.offset.to_le_bytes());
                }
                None => {
                    uncompressed.push(0);
                }
            }
        }
    }

    report_progress(
        "Compressing",
        final_regions,
        valid_region_count,
        final_bytes,
        total_bytes_to_scan,
    );

    let compressed = compress_prepend_size(&uncompressed);

    report_progress(
        "Complete",
        final_regions,
        valid_region_count,
        final_bytes,
        total_bytes_to_scan,
    );

    Ok(compressed)
}
