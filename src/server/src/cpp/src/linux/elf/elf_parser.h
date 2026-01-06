/**
 * @file elf_parser.h
 * @brief ELF file parsing utilities for Linux/Android
 *
 * Provides functions for:
 * - ELF file detection and validation
 * - ELF header reading from file and memory
 * - Symbol table parsing (symtab, dynsym, PLT)
 *
 */

#ifndef ELF_PARSER_H
#define ELF_PARSER_H

#include <elf.h>
#include <sys/types.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../core/native_api.h"  // For ModuleInfo, SymbolInfo

/**
 * Check if a file is an ELF file
 */
bool is_elf(const char* filename);

/**
 * Check if a file is a 64-bit ELF file
 */
bool is_elf64(const char* filename);

/**
 * Read ELF header from process memory
 */
bool read_elf_header_from_memory(int pid, uintptr_t base_address, Elf64_Ehdr* elf_header);

/**
 * Read ELF header from file
 */
bool read_elf_header_from_file(const char* filename, Elf64_Ehdr* elf_header);

/**
 * Compare ELF headers between memory and file
 * Used to verify module base address matches file
 */
bool compare_elf_headers(int pid, uintptr_t base_address, const char* filename);

/**
 * Get .text section offset relative to ELF base
 * Used for module enumeration to find executable sections
 * @param filename Path to ELF file
 * @return Offset of .text section, or 0 if not found
 */
uintptr_t get_text_section_offset(const char* filename);

/**
 * Enumerate symbols from an ELF module
 * @param pid Process ID
 * @param module_base Base address of the module
 * @param count Output: number of symbols found
 * @return Array of SymbolInfo, caller must free
 */
extern "C" SymbolInfo* enum_symbols_native(int pid, uintptr_t module_base, size_t* count);

/**
 * Parse ELF symbols from file
 * @param elf_path Path to ELF file
 * @param module_base Base address in memory
 * @return Vector of SymbolInfo
 */
std::vector<SymbolInfo> parse_elf_symbols(const std::string& elf_path, uintptr_t module_base);

#endif  // ELF_PARSER_H
