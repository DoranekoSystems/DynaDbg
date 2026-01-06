// MachOBridge.swift
// C-compatible wrapper for MachOKit functionality

import Foundation
import MachOKit

// MARK: - Logging bridge to Rust

// Rust logging function (implemented in Rust, called from Swift)
@_silgen_name("rust_log_from_swift")
func rust_log_from_swift(_ level: Int32, _ message: UnsafePointer<CChar>?)

func logInfo(_ message: String) {
    //message.withCString { ptr in
    //    rust_log_from_swift(0, ptr)  // 0 = INFO
    //}
}

func logWarn(_ message: String) {
    message.withCString { ptr in
        rust_log_from_swift(1, ptr)  // 1 = WARN
    }
}

func logError(_ message: String) {
    message.withCString { ptr in
        rust_log_from_swift(2, ptr)  // 2 = ERROR
    }
}

func logDebug(_ message: String) {
    message.withCString { ptr in
        rust_log_from_swift(3, ptr)  // 3 = DEBUG
    }
}

// MARK: - Internal result storage

// Symbol info structure with extended Mach-O metadata
struct SymbolInfo {
    var name: String
    var address: UInt64
    var size: UInt64         // Calculated from function starts (0 if unknown)
    var type: UInt8           // 0=UNDF, 1=ABS, 2=SECT, 3=PBUD, 4=INDR
    var isExternal: Bool      // N_EXT flag
    var isPrivateExternal: Bool // N_PEXT flag
    var isWeakDef: Bool       // N_WEAK_DEF
    var isWeakRef: Bool       // N_WEAK_REF
    var isThumbDef: Bool      // N_ARM_THUMB_DEF (ARM only)
    var sectionIndex: UInt8   // Section number (n_sect)
    var libraryOrdinal: Int32 // Library ordinal for imports (Int32 from MachOKit)
    var source: UInt8         // 0=symtab, 1=export_trie
}

final class MachOParseResultInternal {
    var success: Bool = false
    var errorMessage: String?
    var is64Bit: Bool = false
    var cpuType: Int32 = 0
    var cpuSubtype: Int32 = 0
    var fileType: Int32 = 0
    var ncmds: UInt32 = 0
    var symbols: [SymbolInfo] = []
    var segments: [(name: String, vmaddr: UInt64, vmsize: UInt64, fileoff: UInt64, filesize: UInt64, maxprot: Int32, initprot: Int32, nsects: UInt32)] = []
    var sections: [(sectname: String, segname: String, addr: UInt64, size: UInt64, offset: UInt32, flags: UInt32)] = []
}

// Global storage for results
private var resultStorage: [Int: MachOParseResultInternal] = [:]
private var resultCounter: Int = 0
private let storageLock = NSLock()

private func allocateResult() -> (OpaquePointer, MachOParseResultInternal) {
    storageLock.lock()
    defer { storageLock.unlock() }
    
    resultCounter += 1
    let result = MachOParseResultInternal()
    resultStorage[resultCounter] = result
    
    let ptr = OpaquePointer(bitPattern: resultCounter)!
    return (ptr, result)
}

private func getResult(_ ptr: OpaquePointer?) -> MachOParseResultInternal? {
    guard let ptr = ptr else { return nil }
    let id = Int(bitPattern: ptr)
    storageLock.lock()
    defer { storageLock.unlock() }
    return resultStorage[id]
}

private func freeResult(_ ptr: OpaquePointer?) {
    guard let ptr = ptr else { return }
    let id = Int(bitPattern: ptr)
    storageLock.lock()
    defer { storageLock.unlock() }
    resultStorage.removeValue(forKey: id)
}

// MARK: - String helpers

private func allocateCString(_ string: String) -> UnsafeMutablePointer<CChar> {
    let utf8 = string.utf8CString
    let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: utf8.count)
    for (i, char) in utf8.enumerated() {
        buffer[i] = char
    }
    return buffer
}

// MARK: - Dyld Shared Cache

private var loadedDyldCache: FullDyldCache?
// Cache for fast path-to-size lookup
private var dyldCacheModuleSizes: [String: UInt64] = [:]
private let dyldCacheLock = NSLock()

// Build the size cache when loading dyld cache
private func buildModuleSizeCache() {
    guard let cache = loadedDyldCache else { return }
    
    dyldCacheLock.lock()
    defer { dyldCacheLock.unlock() }
    
    dyldCacheModuleSizes.removeAll()
    
    for machO in cache.machOFiles() {
        let size = calculateModuleSizeFromFile(machO: machO)
        if size > 0 {
            dyldCacheModuleSizes[machO.imagePath] = size
        }
    }
    
    logInfo("Built module size cache with \(dyldCacheModuleSizes.count) entries")
}

@_cdecl("macho_load_dyld_cache")
public func macho_load_dyld_cache(_ path: UnsafePointer<CChar>?) -> Bool {
    guard let path = path else { return false }
    let pathString = String(cString: path)
    
    do {
        let url = URL(fileURLWithPath: pathString)
        loadedDyldCache = try FullDyldCache(url: url)
        buildModuleSizeCache()
        return true
    } catch {
        logError("Failed to load dyld cache: \(error)")
        return false
    }
}

@_cdecl("macho_load_system_dyld_cache")
public func macho_load_system_dyld_cache() -> Bool {
    // Method 1: Use dyld_shared_cache_file_path() API to get the current process's cache path
    // This is the most reliable method as it returns the actual cache being used by dyld
#if canImport(Darwin)
    if let pathPtr = dyld_shared_cache_file_path() {
        let path = String(cString: pathPtr)
        logInfo("dyld_shared_cache_file_path() returned: \(path)")
        
        let url = URL(fileURLWithPath: path)
        let exists = FileManager.default.fileExists(atPath: path)
        logInfo("File exists at path: \(exists)")
        
        if exists {
            do {
                loadedDyldCache = try FullDyldCache(url: url)
                logInfo("Successfully loaded dyld cache from: \(path)")
                buildModuleSizeCache()
                return true
            } catch {
                logError("Failed to load dyld cache from \(path): \(error)")
            }
        } else {
            // Check if the file is accessible
            let readable = FileManager.default.isReadableFile(atPath: path)
            logInfo("File readable: \(readable)")
            
            // Try to list parent directory
            let parentDir = url.deletingLastPathComponent().path
            if let contents = try? FileManager.default.contentsOfDirectory(atPath: parentDir) {
                logInfo("Parent directory contents: \(contents.prefix(10))")
            } else {
                logWarn("Cannot list parent directory: \(parentDir)")
            }
        }
    } else {
        logWarn("dyld_shared_cache_file_path() returned nil")
    }
#else
    logWarn("Darwin not available, skipping dyld API")
#endif
    
    logInfo("Falling back to path search...")
    
    // Method 2: Fallback to searching known paths
    // Standard paths + Jailbreak paths (dopamine, unc0ver, checkra1n, etc.)
    // Note: iOS 15+ uses split cache files in com.apple.dyld directory
    let cachePaths = [
        // iOS 15+ split cache (main file without extension)
        "/private/preboot/Cryptexes/OS/System/Library/Caches/com.apple.dyld/dyld_shared_cache_arm64e",
        "/private/preboot/Cryptexes/OS/System/Library/Caches/com.apple.dyld/dyld_shared_cache_arm64",
        // DriverKit cache
        "/private/preboot/Cryptexes/OS/System/DriverKit/System/Library/dyld/dyld_shared_cache_arm64e",
        "/private/preboot/Cryptexes/OS/System/DriverKit/System/Library/dyld/dyld_shared_cache_arm64",
        // Standard iOS/macOS paths
        "/System/Library/dyld/dyld_shared_cache_arm64e",
        "/System/Library/dyld/dyld_shared_cache_arm64",
        "/System/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e",
        "/System/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64",
        "/var/db/dyld/dyld_shared_cache_arm64e",
        "/var/db/dyld/dyld_shared_cache_arm64",
        // Legacy iOS paths
        "/private/preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e",
        "/private/preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64",
        // Jailbreak paths (dopamine, etc.)
        "/var/jb/System/Library/dyld/dyld_shared_cache_arm64e",
        "/var/jb/System/Library/dyld/dyld_shared_cache_arm64",
        // Legacy jailbreak paths
        "/var/LIB/dyld/dyld_shared_cache_arm64e",
        "/var/LIB/dyld/dyld_shared_cache_arm64",
    ]
    
    // Try each path
    for cachePath in cachePaths {
        let exists = FileManager.default.fileExists(atPath: cachePath)
        if !exists {
            continue
        }
        
        logInfo("Found cache at: \(cachePath)")
        let url = URL(fileURLWithPath: cachePath)
        do {
            loadedDyldCache = try FullDyldCache(url: url)
            logInfo("Successfully loaded dyld cache from: \(cachePath)")
            buildModuleSizeCache()
            return true
        } catch {
            logError("Failed to load \(cachePath): \(error)")
            continue
        }
    }
    
    // Try to find cache in /private/preboot for rootless jailbreaks
    let prebootPath = "/private/preboot"
    if FileManager.default.fileExists(atPath: prebootPath) {
        logInfo("Searching in /private/preboot for dyld cache...")
        if let prebootContents = try? FileManager.default.contentsOfDirectory(atPath: prebootPath) {
            for uuid in prebootContents {
                let possiblePaths = [
                    "\(prebootPath)/\(uuid)/procursus/System/Library/dyld/dyld_shared_cache_arm64e",
                    "\(prebootPath)/\(uuid)/procursus/System/Library/dyld/dyld_shared_cache_arm64",
                    "\(prebootPath)/\(uuid)/System/Library/dyld/dyld_shared_cache_arm64e",
                    "\(prebootPath)/\(uuid)/System/Library/dyld/dyld_shared_cache_arm64",
                    "\(prebootPath)/\(uuid)/System/Library/Caches/com.apple.dyld/dyld_shared_cache_arm64e",
                    "\(prebootPath)/\(uuid)/System/Library/Caches/com.apple.dyld/dyld_shared_cache_arm64",
                ]
                
                for path in possiblePaths {
                    if FileManager.default.fileExists(atPath: path) {
                        logInfo("Found cache at: \(path)")
                        let url = URL(fileURLWithPath: path)
                        do {
                            loadedDyldCache = try FullDyldCache(url: url)
                            logInfo("Successfully loaded dyld cache from: \(path)")
                            buildModuleSizeCache()
                            return true
                        } catch {
                            logError("Failed to load \(path): \(error)")
                            continue
                        }
                    }
                }
            }
        }
    }
    
    logError("Could not find or access any dyld cache file")
    return false
}

@_cdecl("macho_unload_dyld_cache")
public func macho_unload_dyld_cache() {
    loadedDyldCache = nil
}

// MARK: - Parse MachO File

@_cdecl("macho_parse_file")
public func macho_parse_file(_ path: UnsafePointer<CChar>?) -> OpaquePointer? {
    let (ptr, result) = allocateResult()
    
    guard let path = path else {
        result.success = false
        result.errorMessage = "Invalid path"
        return ptr
    }
    
    let pathString = String(cString: path)
    
    do {
        let url = URL(fileURLWithPath: pathString)
        let machO = try MachOFile(url: url)
        
        result.success = true
        result.is64Bit = machO.is64Bit
        result.cpuType = machO.header.cpuType?.rawValue ?? 0
        result.cpuSubtype = machO.header.cpuSubType?.rawValue ?? 0
        result.fileType = machO.header.fileType?.rawValue ?? 0
        result.ncmds = machO.header.ncmds
        
        // Parse symbols
        parseSymbols(from: machO, into: result)
        
        // Calculate function sizes from LC_FUNCTION_STARTS
        calculateFunctionSizes(from: machO, into: result)
        
        // Parse segments and sections
        parseSegments(from: machO, into: result)
        
    } catch {
        result.success = false
        result.errorMessage = "Failed to parse: \(error)"
    }
    
    return ptr
}

@_cdecl("macho_parse_from_dyld_cache")
public func macho_parse_from_dyld_cache(_ imagePath: UnsafePointer<CChar>?) -> OpaquePointer? {
    let (ptr, result) = allocateResult()
    
    guard let imagePath = imagePath else {
        result.success = false
        result.errorMessage = "Invalid image path"
        return ptr
    }
    
    guard let cache = loadedDyldCache else {
        result.success = false
        result.errorMessage = "Dyld cache not loaded"
        return ptr
    }
    
    let imagePathString = String(cString: imagePath)
    
    // Find MachO file matching the path
    var foundMachO: MachOFile? = nil
    for machO in cache.machOFiles() {
        if machO.imagePath == imagePathString {
            foundMachO = machO
            break
        }
    }
    
    guard let machO = foundMachO else {
        result.success = false
        result.errorMessage = "Image not found in cache: \(imagePathString)"
        return ptr
    }
    
    result.success = true
    result.is64Bit = machO.is64Bit
    result.cpuType = machO.header.cpuType?.rawValue ?? 0
    result.cpuSubtype = machO.header.cpuSubType?.rawValue ?? 0
    result.fileType = machO.header.fileType?.rawValue ?? 0
    result.ncmds = machO.header.ncmds
    
    // Parse symbols
    parseSymbols(from: machO, into: result)
    
    // Calculate function sizes from LC_FUNCTION_STARTS
    calculateFunctionSizes(from: machO, into: result)
    
    // Parse segments and sections
    parseSegments(from: machO, into: result)
    
    return ptr
}

// MARK: - Parse helpers

private func parseSymbols(from machO: MachOFile, into result: MachOParseResultInternal) {
    // Track already-added symbols to avoid duplicates
    var addedSymbols = Set<String>()
    
    // Get exported symbols from export trie (these have limited metadata)
    let exportedSymbols = machO.exportedSymbols
    for symbol in exportedSymbols {
        let addr = UInt64(symbol.offset ?? 0)
        let key = "\(symbol.name)_\(addr)"
        guard !addedSymbols.contains(key) else { continue }
        addedSymbols.insert(key)
        
        let info = SymbolInfo(
            name: symbol.name,
            address: addr,
            size: 0,  // Will be calculated from function starts
            type: 2,  // SECT (exported symbols are always defined)
            isExternal: true,
            isPrivateExternal: false,
            isWeakDef: false,
            isWeakRef: false,
            isThumbDef: false,
            sectionIndex: 0,
            libraryOrdinal: 0,
            source: 1  // export_trie
        )
        result.symbols.append(info)
    }
    
    // Get symbols from symbol table (64-bit)
    if machO.is64Bit {
        if let symbolsSeq = machO.symbols64 {
            for symbol in symbolsSeq {
                let key = "\(symbol.name)_\(symbol.offset)"
                guard !addedSymbols.contains(key) else { continue }
                addedSymbols.insert(key)
                
                let info = extractSymbolInfo(from: symbol)
                result.symbols.append(info)
            }
        }
    } else {
        // 32-bit symbols
        let symbolsSeq = machO.symbols
        for symbol in symbolsSeq {
            let key = "\(symbol.name)_\(symbol.offset)"
            guard !addedSymbols.contains(key) else { continue }
            addedSymbols.insert(key)
            
            let info = extractSymbolInfo(from: symbol)
            result.symbols.append(info)
        }
    }
}

private func extractSymbolInfo<T: SymbolProtocol>(from symbol: T) -> SymbolInfo {
    var symbolType: UInt8 = 0
    var isExternal = false
    var isPrivateExternal = false
    var isWeakDef = false
    var isWeakRef = false
    var isThumbDef = false
    var sectionIndex: UInt8 = 0
    var libraryOrdinal: Int32 = 0
    
    // Get type from nlist flags
    if let flags = symbol.nlist.flags {
        if let type = flags.type {
            switch type {
            case .undf: symbolType = 0
            case .abs: symbolType = 1
            case .sect: symbolType = 2
            case .pbud: symbolType = 3
            case .indr: symbolType = 4
            }
        }
        
        // Check N_EXT (external symbol)
        isExternal = flags.contains(.ext)
        // Check N_PEXT (private external symbol)
        isPrivateExternal = flags.contains(.pext)
    }
    
    // Get section index
    if let sectNum = symbol.nlist.sectionNumber {
        sectionIndex = UInt8(sectNum)
    }
    
    // Get description flags
    if let desc = symbol.nlist.symbolDescription {
        isWeakDef = desc.contains(.weak_def)
        isWeakRef = desc.contains(.weak_ref)
        isThumbDef = desc.contains(.arm_thumb_def)
        libraryOrdinal = desc.libraryOrdinal
    }
    
    return SymbolInfo(
        name: symbol.name,
        address: UInt64(symbol.offset),
        size: 0,  // Will be calculated from function starts
        type: symbolType,
        isExternal: isExternal,
        isPrivateExternal: isPrivateExternal,
        isWeakDef: isWeakDef,
        isWeakRef: isWeakRef,
        isThumbDef: isThumbDef,
        sectionIndex: sectionIndex,
        libraryOrdinal: libraryOrdinal,
        source: 0  // symtab
    )
}

/// Calculate function sizes from LC_FUNCTION_STARTS
/// This uses the difference between consecutive function start addresses
private func calculateFunctionSizes(from machO: MachOFile, into result: MachOParseResultInternal) {
    guard let functionStarts = machO.functionStarts else {
        return
    }
    
    // Collect all function start offsets and sort them
    let offsets = Array(functionStarts).map { $0.offset }.sorted()
    guard !offsets.isEmpty else { return }
    
    // Build a dictionary of offset -> size
    var sizeMap: [UInt64: UInt64] = [:]
    for i in 0..<offsets.count - 1 {
        let currentOffset = UInt64(offsets[i])
        let nextOffset = UInt64(offsets[i + 1])
        sizeMap[currentOffset] = nextOffset - currentOffset
    }
    
    // For the last function, we can't determine size from function starts alone
    // Leave it as 0 (unknown)
    
    // Update symbol sizes
    for i in 0..<result.symbols.count {
        let addr = result.symbols[i].address
        if let size = sizeMap[addr] {
            result.symbols[i].size = size
        }
    }
}

private func parseSegments(from machO: MachOFile, into result: MachOParseResultInternal) {
    for cmd in machO.loadCommands {
        switch cmd {
        case .segment(let segment):
            result.segments.append((
                name: segment.segmentName,
                vmaddr: UInt64(segment.vmaddr),
                vmsize: UInt64(segment.vmsize),
                fileoff: UInt64(segment.fileoff),
                filesize: UInt64(segment.filesize),
                maxprot: segment.maxprot,
                initprot: segment.initprot,
                nsects: segment.nsects
            ))
            
            for section in segment.sections(in: machO) {
                result.sections.append((
                    sectname: section.sectionName,
                    segname: section.segmentName,
                    addr: UInt64(section.address),
                    size: UInt64(section.size),
                    offset: UInt32(section.offset),
                    flags: section.flags.rawValue
                ))
            }
            
        case .segment64(let segment):
            result.segments.append((
                name: segment.segmentName,
                vmaddr: segment.vmaddr,
                vmsize: segment.vmsize,
                fileoff: segment.fileoff,
                filesize: segment.filesize,
                maxprot: segment.maxprot,
                initprot: segment.initprot,
                nsects: segment.nsects
            ))
            
            for section in segment.sections(in: machO) {
                result.sections.append((
                    sectname: section.sectionName,
                    segname: section.segmentName,
                    addr: UInt64(section.address),
                    size: UInt64(section.size),
                    offset: UInt32(section.offset),
                    flags: section.flags.rawValue
                ))
            }
            
        default:
            break
        }
    }
}

// MARK: - Result accessors

@_cdecl("macho_result_success")
public func macho_result_success(_ result: OpaquePointer?) -> Bool {
    return getResult(result)?.success ?? false
}

@_cdecl("macho_result_error_message")
public func macho_result_error_message(_ result: OpaquePointer?) -> UnsafeMutablePointer<CChar>? {
    guard let msg = getResult(result)?.errorMessage else { return nil }
    return allocateCString(msg)
}

@_cdecl("macho_result_is_64bit")
public func macho_result_is_64bit(_ result: OpaquePointer?) -> Bool {
    return getResult(result)?.is64Bit ?? false
}

@_cdecl("macho_result_cpu_type")
public func macho_result_cpu_type(_ result: OpaquePointer?) -> Int32 {
    return getResult(result)?.cpuType ?? 0
}

@_cdecl("macho_result_cpu_subtype")
public func macho_result_cpu_subtype(_ result: OpaquePointer?) -> Int32 {
    return getResult(result)?.cpuSubtype ?? 0
}

@_cdecl("macho_result_file_type")
public func macho_result_file_type(_ result: OpaquePointer?) -> Int32 {
    return getResult(result)?.fileType ?? 0
}

@_cdecl("macho_result_ncmds")
public func macho_result_ncmds(_ result: OpaquePointer?) -> UInt32 {
    return getResult(result)?.ncmds ?? 0
}

@_cdecl("macho_result_symbol_count")
public func macho_result_symbol_count(_ result: OpaquePointer?) -> UInt64 {
    return UInt64(getResult(result)?.symbols.count ?? 0)
}

@_cdecl("macho_result_symbol_name")
public func macho_result_symbol_name(_ result: OpaquePointer?, _ index: UInt64) -> UnsafeMutablePointer<CChar>? {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return nil }
    return allocateCString(symbols[Int(index)].name)
}

@_cdecl("macho_result_symbol_address")
public func macho_result_symbol_address(_ result: OpaquePointer?, _ index: UInt64) -> UInt64 {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return 0 }
    return symbols[Int(index)].address
}

@_cdecl("macho_result_symbol_size")
public func macho_result_symbol_size(_ result: OpaquePointer?, _ index: UInt64) -> UInt64 {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return 0 }
    return symbols[Int(index)].size
}

@_cdecl("macho_result_symbol_type")
public func macho_result_symbol_type(_ result: OpaquePointer?, _ index: UInt64) -> UInt8 {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return 0 }
    return symbols[Int(index)].type
}

@_cdecl("macho_result_symbol_is_external")
public func macho_result_symbol_is_external(_ result: OpaquePointer?, _ index: UInt64) -> Bool {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return false }
    return symbols[Int(index)].isExternal
}

@_cdecl("macho_result_symbol_is_private_external")
public func macho_result_symbol_is_private_external(_ result: OpaquePointer?, _ index: UInt64) -> Bool {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return false }
    return symbols[Int(index)].isPrivateExternal
}

@_cdecl("macho_result_symbol_is_weak_def")
public func macho_result_symbol_is_weak_def(_ result: OpaquePointer?, _ index: UInt64) -> Bool {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return false }
    return symbols[Int(index)].isWeakDef
}

@_cdecl("macho_result_symbol_is_weak_ref")
public func macho_result_symbol_is_weak_ref(_ result: OpaquePointer?, _ index: UInt64) -> Bool {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return false }
    return symbols[Int(index)].isWeakRef
}

@_cdecl("macho_result_symbol_is_thumb")
public func macho_result_symbol_is_thumb(_ result: OpaquePointer?, _ index: UInt64) -> Bool {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return false }
    return symbols[Int(index)].isThumbDef
}

@_cdecl("macho_result_symbol_section_index")
public func macho_result_symbol_section_index(_ result: OpaquePointer?, _ index: UInt64) -> UInt8 {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return 0 }
    return symbols[Int(index)].sectionIndex
}

@_cdecl("macho_result_symbol_library_ordinal")
public func macho_result_symbol_library_ordinal(_ result: OpaquePointer?, _ index: UInt64) -> Int32 {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return 0 }
    return symbols[Int(index)].libraryOrdinal
}

@_cdecl("macho_result_symbol_source")
public func macho_result_symbol_source(_ result: OpaquePointer?, _ index: UInt64) -> UInt8 {
    guard let symbols = getResult(result)?.symbols,
          Int(index) < symbols.count else { return 0 }
    return symbols[Int(index)].source
}

@_cdecl("macho_result_segment_count")
public func macho_result_segment_count(_ result: OpaquePointer?) -> UInt64 {
    return UInt64(getResult(result)?.segments.count ?? 0)
}

@_cdecl("macho_result_segment_name")
public func macho_result_segment_name(_ result: OpaquePointer?, _ index: UInt64) -> UnsafeMutablePointer<CChar>? {
    guard let segments = getResult(result)?.segments,
          Int(index) < segments.count else { return nil }
    return allocateCString(segments[Int(index)].name)
}

@_cdecl("macho_result_segment_vmaddr")
public func macho_result_segment_vmaddr(_ result: OpaquePointer?, _ index: UInt64) -> UInt64 {
    guard let segments = getResult(result)?.segments,
          Int(index) < segments.count else { return 0 }
    return segments[Int(index)].vmaddr
}

@_cdecl("macho_result_segment_vmsize")
public func macho_result_segment_vmsize(_ result: OpaquePointer?, _ index: UInt64) -> UInt64 {
    guard let segments = getResult(result)?.segments,
          Int(index) < segments.count else { return 0 }
    return segments[Int(index)].vmsize
}

@_cdecl("macho_result_section_count")
public func macho_result_section_count(_ result: OpaquePointer?) -> UInt64 {
    return UInt64(getResult(result)?.sections.count ?? 0)
}

@_cdecl("macho_result_section_name")
public func macho_result_section_name(_ result: OpaquePointer?, _ index: UInt64) -> UnsafeMutablePointer<CChar>? {
    guard let sections = getResult(result)?.sections,
          Int(index) < sections.count else { return nil }
    return allocateCString(sections[Int(index)].sectname)
}

@_cdecl("macho_result_section_segname")
public func macho_result_section_segname(_ result: OpaquePointer?, _ index: UInt64) -> UnsafeMutablePointer<CChar>? {
    guard let sections = getResult(result)?.sections,
          Int(index) < sections.count else { return nil }
    return allocateCString(sections[Int(index)].segname)
}

@_cdecl("macho_result_section_addr")
public func macho_result_section_addr(_ result: OpaquePointer?, _ index: UInt64) -> UInt64 {
    guard let sections = getResult(result)?.sections,
          Int(index) < sections.count else { return 0 }
    return sections[Int(index)].addr
}

@_cdecl("macho_result_section_size")
public func macho_result_section_size(_ result: OpaquePointer?, _ index: UInt64) -> UInt64 {
    guard let sections = getResult(result)?.sections,
          Int(index) < sections.count else { return 0 }
    return sections[Int(index)].size
}

// MARK: - Free functions

@_cdecl("macho_free_result")
public func macho_free_result(_ result: OpaquePointer?) {
    freeResult(result)
}

@_cdecl("macho_free_string")
public func macho_free_string(_ str: UnsafeMutablePointer<CChar>?) {
    str?.deallocate()
}

// MARK: - List dyld cache images

@_cdecl("macho_get_dyld_cache_image_count")
public func macho_get_dyld_cache_image_count() -> UInt64 {
    guard let cache = loadedDyldCache,
          let imageInfos = cache.imageInfos else { return 0 }
    return UInt64(imageInfos.count)
}

@_cdecl("macho_get_dyld_cache_image_path")
public func macho_get_dyld_cache_image_path(_ index: UInt64) -> UnsafeMutablePointer<CChar>? {
    guard let cache = loadedDyldCache,
          let imageInfos = cache.imageInfos else { return nil }
    
    var idx = 0
    for imageInfo in imageInfos {
        if idx == Int(index) {
            if let path = imageInfo.path(in: cache) {
                return allocateCString(path)
            }
            return nil
        }
        idx += 1
    }
    return nil
}

// MARK: - Module Size from dyld (for current process)

/// Get module size by name using dyld APIs (for current process only)
/// Returns the sum of all segment vmsizes
@_cdecl("macho_get_module_size_by_name")
public func macho_get_module_size_by_name(_ name: UnsafePointer<CChar>?) -> UInt64 {
#if canImport(Darwin)
    guard let name = name else { return 0 }
    let nameString = String(cString: name)
    
    // Try to find the MachOImage by name
    if let image = MachOImage(name: nameString) {
        return calculateModuleSize(image: image)
    }
    
    // Try exact path match
    let indices = 0..<_dyld_image_count()
    for index in indices {
        guard let pathC = _dyld_get_image_name(index) else { continue }
        let path = String(cString: pathC)
        
        if path == nameString || path.hasSuffix("/\(nameString)") {
            if let mh = _dyld_get_image_header(index) {
                let image = MachOImage(ptr: mh)
                return calculateModuleSize(image: image)
            }
        }
    }
    
    return 0
#else
    return 0
#endif
}

/// Get module size by base address using dyld APIs (for current process only)
/// Returns the sum of all segment vmsizes
@_cdecl("macho_get_module_size_by_address")
public func macho_get_module_size_by_address(_ address: UInt64) -> UInt64 {
#if canImport(Darwin)
    guard let header = UnsafeRawPointer(bitPattern: UInt(address)) else { return 0 }
    
    // Validate that this looks like a mach header
    let mh = header.assumingMemoryBound(to: mach_header.self)
    let magic = mh.pointee.magic
    guard magic == MH_MAGIC || magic == MH_MAGIC_64 else { return 0 }
    
    let image = MachOImage(ptr: mh)
    return calculateModuleSize(image: image)
#else
    return 0
#endif
}

/// Get module size from dyld cache by path
@_cdecl("macho_get_module_size_from_cache")
public func macho_get_module_size_from_cache(_ imagePath: UnsafePointer<CChar>?) -> UInt64 {
    guard let imagePath = imagePath else { return 0 }
    guard loadedDyldCache != nil else { return 0 }
    
    let imagePathString = String(cString: imagePath)
    
    // O(1) lookup from pre-built dictionary
    return dyldCacheModuleSizes[imagePathString] ?? 0
}

#if canImport(Darwin)
private func calculateModuleSize(image: MachOImage) -> UInt64 {    
    var textSize: UInt64 = 0
    var dataSize: UInt64 = 0
    
    if image.is64Bit {
        for segment in image.segments64 {
            let name = segment.segmentName
            if name == "__TEXT" {
                textSize = segment.vmsize
            } else if name.hasPrefix("__DATA") {
                dataSize += segment.vmsize
            }
        }
    } else {
        for segment in image.segments32 {
            let name = segment.segmentName
            if name == "__TEXT" {
                textSize = UInt64(segment.vmsize)
            } else if name.hasPrefix("__DATA") {
                dataSize += UInt64(segment.vmsize)
            }
        }
    }
    
    if textSize > 0 {
        return textSize
    }
    
    // Fallback to data segments if no __TEXT
    return dataSize
}
#endif

private func calculateModuleSizeFromFile(machO: MachOFile) -> UInt64 {
    var textSize: UInt64 = 0
    var dataSize: UInt64 = 0
    
    for cmd in machO.loadCommands {
        switch cmd {
        case .segment(let segment):
            let name = segment.segmentName
            if name == "__TEXT" {
                textSize = UInt64(segment.vmsize)
            } else if name.hasPrefix("__DATA") {
                dataSize += UInt64(segment.vmsize)
            }
        case .segment64(let segment):
            let name = segment.segmentName
            if name == "__TEXT" {
                textSize = segment.vmsize
            } else if name.hasPrefix("__DATA") {
                dataSize += segment.vmsize
            }
        default:
            break
        }
    }
    
    if textSize > 0 {
        return textSize
    }
    
    // Fallback to data segments if no __TEXT
    return dataSize
}

// MARK: - Enumerate loaded images (for current process)

/// Get the count of loaded images using dyld APIs
@_cdecl("macho_get_loaded_image_count")
public func macho_get_loaded_image_count() -> UInt32 {
#if canImport(Darwin)
    return _dyld_image_count()
#else
    return 0
#endif
}

/// Get image path at index using dyld APIs
@_cdecl("macho_get_loaded_image_path")
public func macho_get_loaded_image_path(_ index: UInt32) -> UnsafeMutablePointer<CChar>? {
#if canImport(Darwin)
    guard let pathC = _dyld_get_image_name(index) else { return nil }
    let path = String(cString: pathC)
    return allocateCString(path)
#else
    return nil
#endif
}

/// Get image base address at index using dyld APIs
@_cdecl("macho_get_loaded_image_base")
public func macho_get_loaded_image_base(_ index: UInt32) -> UInt64 {
#if canImport(Darwin)
    guard let mh = _dyld_get_image_header(index) else { return 0 }
    return UInt64(UInt(bitPattern: mh))
#else
    return 0
#endif
}

/// Get image size at index using dyld APIs
@_cdecl("macho_get_loaded_image_size")
public func macho_get_loaded_image_size(_ index: UInt32) -> UInt64 {
#if canImport(Darwin)
    guard let mh = _dyld_get_image_header(index) else { return 0 }
    let image = MachOImage(ptr: mh)
    return calculateModuleSize(image: image)
#else
    return 0
#endif
}

/// Get image vmaddr slide at index using dyld APIs
@_cdecl("macho_get_loaded_image_slide")
public func macho_get_loaded_image_slide(_ index: UInt32) -> Int64 {
#if canImport(Darwin)
    return Int64(_dyld_get_image_vmaddr_slide(index))
#else
    return 0
#endif
}
