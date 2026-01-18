use crate::native_bridge;
use libc;
use lz4_flex::compress_prepend_size;
use std::collections::HashMap;

#[repr(C)]
struct ModuleEntry {
    entry_length: u32,
    entry_string: String,
    memory_size: i32,
    memory_address: u64,
}

struct StaticData {
    module_index: u32,
    offset: u32,
}

struct PointerData {
    address: u64,
    static_data: Option<StaticData>,
}

// Helper function to find module for a given address using binary search
fn find_static_data(address: usize, modules: &[ModuleEntry]) -> Option<StaticData> {
    // First, sort modules by memory_address if not already sorted
    // In practice, modules should come pre-sorted from the OS
    let address = address as u64;

    // Binary search for the module containing the address
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

pub fn generate_pointermap(pid: i32) -> Result<Vec<u8>, String> {
    // Get memory regions and calculate valid address range
    let regions = native_bridge::enum_regions(pid)?;
    
    let (min_valid_addr, max_valid_addr) = {
        let mut min_addr = u64::MAX;
        let mut max_addr = 0;
        for region in &regions {
            let start = u64::from_str_radix(region["start_address"].as_str().unwrap_or("0"), 16)
                .unwrap_or(0);
            let end =
                u64::from_str_radix(region["end_address"].as_str().unwrap_or("0"), 16).unwrap_or(0);
            let protection = region["protection"].as_str().unwrap_or("");

            if !protection.contains('r') || !protection.contains('p') {
                continue;
            }
            min_addr = min_addr.min(start);
            max_addr = max_addr.max(end);
        }
        (min_addr, max_addr)
    };

    // Get modules
    let modules = match native_bridge::enum_modules(pid) {
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
    };

    let mut pointer_map: HashMap<u64, Vec<(u64, Option<StaticData>)>> = HashMap::new();

    // Process each memory region
    for region in regions {
        let start_address = u64::from_str_radix(region["start_address"].as_str().unwrap_or("0"), 16)
            .unwrap_or(0) as usize;
        let end_address = u64::from_str_radix(region["end_address"].as_str().unwrap_or("0"), 16)
            .unwrap_or(0) as usize;
        let protection = region["protection"].as_str().unwrap_or("");

        if !protection.contains('r') || !protection.contains('p') {
            continue;
        }
        const CHUNK_SIZE: usize = 1024 * 1024 * 16; // 16MB chunks
        let mut current_address = start_address;

        while current_address < end_address {
            let chunk_end = (current_address + CHUNK_SIZE).min(end_address);
            let chunk_size = chunk_end - current_address;

            if chunk_size < 8 {
                current_address = chunk_end;
                continue;
            }

            if let Ok(memory) = read_memory(pid, current_address, chunk_size) {
                let aligned_start = (current_address + 7) & !7;
                let offset = (aligned_start - current_address) as usize;

                for i in (offset..memory.len()).step_by(8) {
                    if i + 8 > memory.len() {
                        break;
                    }

                    let value = u64::from_le_bytes(memory[i..i + 8].try_into().unwrap());
                    if value >= min_valid_addr && value < max_valid_addr && value % 4 == 0 {
                        let source_address = current_address + i;
                        let static_data = find_static_data(source_address, &modules);
                        pointer_map
                            .entry(value)
                            .or_insert_with(Vec::new)
                            .push((source_address as u64, static_data));
                    }
                }
            }

            current_address = chunk_end;
        }
    }

    // Create uncompressed data first
    let mut uncompressed = Vec::new();

    // Write header: DynaDbg PointerMap format
    // Magic: "DPTR" (4 bytes)
    uncompressed.extend_from_slice(b"DPTR");
    // Version: 1 (4 bytes)
    uncompressed.extend_from_slice(&1u32.to_le_bytes());

    // Write modules
    uncompressed.extend_from_slice(&(modules.len() as u32).to_le_bytes());
    for module in &modules {
        uncompressed.extend_from_slice(&module.entry_length.to_le_bytes());
        uncompressed.extend_from_slice(module.entry_string.as_bytes());
        uncompressed.extend_from_slice(&module.memory_address.to_le_bytes());
        uncompressed.extend_from_slice(&module.memory_size.to_le_bytes());
    }

    // Convert HashMap into a sorted Vec
    let mut sorted_entries: Vec<_> = pointer_map.into_iter().collect();
    sorted_entries.sort_by_key(|&(address, _)| address);

    // Total unique target addresses
    uncompressed.extend_from_slice(&(sorted_entries.len() as u64).to_le_bytes());

    // Total pointer count (all pointers across all target values)
    let total_count: u64 = sorted_entries.iter().map(|(_, v)| v.len() as u64).sum();
    uncompressed.extend_from_slice(&total_count.to_le_bytes());

    // Write all pointer entries in sorted order
    for (target_value, mut pointers) in sorted_entries {
        // Sort pointers within each target by address
        pointers.sort_by_key(|(address, _)| *address);

        // Target value (address being pointed to)
        uncompressed.extend_from_slice(&target_value.to_le_bytes());
        // Number of pointers to this target
        uncompressed.extend_from_slice(&(pointers.len() as u32).to_le_bytes());

        // Write each pointer's data
        for (address, static_data) in pointers {
            // Pointer address
            uncompressed.extend_from_slice(&address.to_le_bytes());

            match static_data {
                Some(data) => {
                    uncompressed.push(1); // Has static data
                    uncompressed.extend_from_slice(&data.module_index.to_le_bytes());
                    uncompressed.extend_from_slice(&data.offset.to_le_bytes());
                }
                None => {
                    uncompressed.push(0); // No static data
                }
            }
        }
    }

    // Compress the data using LZ4
    let compressed = compress_prepend_size(&uncompressed);

    Ok(compressed)
}