/**
 * @file elf_parser.cpp
 * @brief ELF file parsing utilities for Linux/Android
 */

#include "elf_parser.h"

#include <elf.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <fstream>
#include <sstream>
#include <vector>

#include "../core/memory_io.h"
#include "../core/native_api.h"  // For debug_log

static unsigned char ELF_MAGIC[] = {0x7F, 'E', 'L', 'F'};

bool is_elf64(const char* filename)
{
    int fd = open(filename, O_RDONLY);
    if (fd < 0)
    {
        return false;
    }

    unsigned char e_ident[EI_NIDENT];
    if (read(fd, e_ident, EI_NIDENT) != EI_NIDENT)
    {
        close(fd);
        return false;
    }

    close(fd);

    return (e_ident[EI_CLASS] == ELFCLASS64);
}

bool is_elf(const char* filename)
{
    int fd = open(filename, O_RDONLY);
    if (fd < 0)
    {
        return false;
    }

    unsigned char e_ident[EI_NIDENT];
    bool result = false;

    if (read(fd, e_ident, EI_NIDENT) == EI_NIDENT)
    {
        result = (memcmp(e_ident, ELF_MAGIC, 4) == 0);
    }

    close(fd);
    return result;
}

bool read_elf_header_from_memory(int pid, uintptr_t base_address, Elf64_Ehdr* elf_header)
{
    if (read_memory_native(pid, base_address, sizeof(Elf64_Ehdr),
                           reinterpret_cast<unsigned char*>(elf_header)) != sizeof(Elf64_Ehdr))
    {
        return false;
    }
    return true;
}

bool read_elf_header_from_file(const char* filename, Elf64_Ehdr* elf_header)
{
    int fd = open(filename, O_RDONLY);
    if (fd < 0)
    {
        return false;
    }

    if (read(fd, elf_header, sizeof(Elf64_Ehdr)) != sizeof(Elf64_Ehdr))
    {
        close(fd);
        return false;
    }

    close(fd);
    return true;
}

bool compare_elf_headers(int pid, uintptr_t base_address, const char* filename)
{
    Elf64_Ehdr mem_elf_header;
    Elf64_Ehdr file_elf_header;

    if (!read_elf_header_from_memory(pid, base_address, &mem_elf_header))
    {
        return false;
    }

    if (!read_elf_header_from_file(filename, &file_elf_header))
    {
        return false;
    }
    return memcmp(&mem_elf_header, &file_elf_header, sizeof(Elf64_Ehdr)) == 0;
}

/**
 * Get .text section offset relative to the ELF base (first LOAD segment's p_vaddr)
 * This is needed for PIE executables where vaddr is not the actual offset from load base
 * Returns 0 if .text section is not found
 */
uintptr_t get_text_section_offset(const char* filename)
{
    int fd = open(filename, O_RDONLY);
    if (fd < 0)
    {
        return 0;
    }

    struct stat st;
    if (fstat(fd, &st) < 0)
    {
        close(fd);
        return 0;
    }

    void* mapped = mmap(nullptr, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (mapped == MAP_FAILED)
    {
        close(fd);
        return 0;
    }

    Elf64_Ehdr* ehdr = (Elf64_Ehdr*)mapped;
    if (memcmp(ehdr->e_ident, ELFMAG, SELFMAG) != 0)
    {
        munmap(mapped, st.st_size);
        close(fd);
        return 0;
    }

    bool is_64bit = (ehdr->e_ident[EI_CLASS] == ELFCLASS64);
    uintptr_t text_vaddr = 0;
    uintptr_t base_vaddr = 0;

    if (is_64bit)
    {
        Elf64_Phdr* phdrs = (Elf64_Phdr*)((char*)mapped + ehdr->e_phoff);
        for (int i = 0; i < ehdr->e_phnum; i++)
        {
            if (phdrs[i].p_type == PT_LOAD)
            {
                base_vaddr = phdrs[i].p_vaddr;
                break;
            }
        }

        Elf64_Shdr* shdrs = (Elf64_Shdr*)((char*)mapped + ehdr->e_shoff);
        Elf64_Shdr* shstrtab = &shdrs[ehdr->e_shstrndx];
        char* shstrtab_data = (char*)mapped + shstrtab->sh_offset;

        for (int i = 0; i < ehdr->e_shnum; i++)
        {
            char* section_name = shstrtab_data + shdrs[i].sh_name;
            if (strcmp(section_name, ".text") == 0)
            {
                text_vaddr = shdrs[i].sh_addr;
                break;
            }
        }
    }
    else
    {
        Elf32_Ehdr* ehdr32 = (Elf32_Ehdr*)mapped;

        Elf32_Phdr* phdrs = (Elf32_Phdr*)((char*)mapped + ehdr32->e_phoff);
        for (int i = 0; i < ehdr32->e_phnum; i++)
        {
            if (phdrs[i].p_type == PT_LOAD)
            {
                base_vaddr = phdrs[i].p_vaddr;
                break;
            }
        }

        Elf32_Shdr* shdrs = (Elf32_Shdr*)((char*)mapped + ehdr32->e_shoff);
        Elf32_Shdr* shstrtab = &shdrs[ehdr32->e_shstrndx];
        char* shstrtab_data = (char*)mapped + shstrtab->sh_offset;

        for (int i = 0; i < ehdr32->e_shnum; i++)
        {
            char* section_name = shstrtab_data + shdrs[i].sh_name;
            if (strcmp(section_name, ".text") == 0)
            {
                text_vaddr = shdrs[i].sh_addr;
                break;
            }
        }
    }

    munmap(mapped, st.st_size);
    close(fd);

    if (text_vaddr == 0)
    {
        return 0;
    }
    return text_vaddr - base_vaddr;
}

// Note: get_module_path has been moved to native_api.cpp

std::vector<SymbolInfo> parse_elf_symbols(const std::string& elf_path, uintptr_t module_base)
{
    std::vector<SymbolInfo> symbols;

    int fd = open(elf_path.c_str(), O_RDONLY);
    if (fd < 0)
    {
        debug_log(LOG_ERROR, "Failed to open ELF file: %s", elf_path.c_str());
        return symbols;
    }

    struct stat st;
    if (fstat(fd, &st) < 0)
    {
        debug_log(LOG_ERROR, "Failed to stat ELF file: %s", elf_path.c_str());
        close(fd);
        return symbols;
    }

    void* mapped = mmap(nullptr, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (mapped == MAP_FAILED)
    {
        debug_log(LOG_ERROR, "Failed to mmap ELF file: %s", elf_path.c_str());
        close(fd);
        return symbols;
    }

    Elf64_Ehdr* ehdr = (Elf64_Ehdr*)mapped;
    if (memcmp(ehdr->e_ident, ELFMAG, SELFMAG) != 0)
    {
        debug_log(LOG_ERROR, "Invalid ELF magic in file: %s", elf_path.c_str());
        munmap(mapped, st.st_size);
        close(fd);
        return symbols;
    }

    bool is_64bit = (ehdr->e_ident[EI_CLASS] == ELFCLASS64);

    if (is_64bit)
    {
        // Boundary checks
        if (ehdr->e_shoff == 0 || ehdr->e_shnum == 0 ||
            ehdr->e_shoff + ehdr->e_shnum * sizeof(Elf64_Shdr) > (size_t)st.st_size)
        {
            debug_log(LOG_ERROR, "Invalid section header in file: %s", elf_path.c_str());
            munmap(mapped, st.st_size);
            close(fd);
            return symbols;
        }

        if (ehdr->e_shstrndx >= ehdr->e_shnum)
        {
            debug_log(LOG_ERROR, "Invalid section string table index in file: %s",
                      elf_path.c_str());
            munmap(mapped, st.st_size);
            close(fd);
            return symbols;
        }

        Elf64_Shdr* shdrs = (Elf64_Shdr*)((char*)mapped + ehdr->e_shoff);
        Elf64_Shdr* shstrtab = &shdrs[ehdr->e_shstrndx];

        if (shstrtab->sh_offset + shstrtab->sh_size > (size_t)st.st_size)
        {
            debug_log(LOG_ERROR, "Invalid string table in file: %s", elf_path.c_str());
            munmap(mapped, st.st_size);
            close(fd);
            return symbols;
        }

        char* shstrtab_data = (char*)mapped + shstrtab->sh_offset;

        Elf64_Shdr* symtab = nullptr;
        Elf64_Shdr* strtab = nullptr;
        Elf64_Shdr* dynsym = nullptr;
        Elf64_Shdr* dynstr = nullptr;
        Elf64_Shdr* rela_plt = nullptr;
        Elf64_Shdr* plt_section = nullptr;

        for (int i = 0; i < ehdr->e_shnum; i++)
        {
            if (shdrs[i].sh_name >= shstrtab->sh_size) continue;
            char* section_name = shstrtab_data + shdrs[i].sh_name;

            if (strcmp(section_name, ".symtab") == 0)
                symtab = &shdrs[i];
            else if (strcmp(section_name, ".strtab") == 0)
                strtab = &shdrs[i];
            else if (strcmp(section_name, ".dynsym") == 0)
                dynsym = &shdrs[i];
            else if (strcmp(section_name, ".dynstr") == 0)
                dynstr = &shdrs[i];
            else if (strcmp(section_name, ".rela.plt") == 0 ||
                     strcmp(section_name, ".rel.plt") == 0)
                rela_plt = &shdrs[i];
            else if (strcmp(section_name, ".plt") == 0)
                plt_section = &shdrs[i];
        }

        if (!symtab)
        {
            symtab = dynsym;
            strtab = dynstr;
        }

        if (symtab && strtab)
        {
            if (symtab->sh_offset + symtab->sh_size > (size_t)st.st_size ||
                strtab->sh_offset + strtab->sh_size > (size_t)st.st_size)
            {
                debug_log(LOG_ERROR, "Invalid symbol/string table bounds in file: %s",
                          elf_path.c_str());
                munmap(mapped, st.st_size);
                close(fd);
                return symbols;
            }

            Elf64_Sym* syms = (Elf64_Sym*)((char*)mapped + symtab->sh_offset);
            char* strtab_data = (char*)mapped + strtab->sh_offset;
            int sym_count = symtab->sh_size / sizeof(Elf64_Sym);

            for (int i = 0; i < sym_count; i++)
            {
                Elf64_Sym* sym = &syms[i];

                if (sym->st_shndx == SHN_UNDEF) continue;
                if (sym->st_name == 0) continue;
                if (sym->st_name >= strtab->sh_size) continue;

                char* name = strtab_data + sym->st_name;
                if (strlen(name) == 0) continue;

                SymbolInfo symbol_info;
                symbol_info.address = module_base + sym->st_value;
                symbol_info.name = strdup(name);
                symbol_info.size = sym->st_size;
                symbol_info.module_base = module_base;
                symbol_info.file_name = strdup(elf_path.c_str());
                symbol_info.line_number = 0;

                int sym_type = ELF64_ST_TYPE(sym->st_info);
                switch (sym_type)
                {
                    case STT_FUNC:
                    case STT_GNU_IFUNC:
                        symbol_info.type = strdup("Function");
                        break;
                    case STT_OBJECT:
                        symbol_info.type = strdup("Variable");
                        break;
                    case STT_SECTION:
                        symbol_info.type = strdup("Section");
                        break;
                    case STT_FILE:
                        symbol_info.type = strdup("File");
                        break;
                    default:
                        symbol_info.type = strdup("Unknown");
                        break;
                }

                int sym_bind = ELF64_ST_BIND(sym->st_info);
                switch (sym_bind)
                {
                    case STB_GLOBAL:
                        symbol_info.scope = strdup("Global");
                        break;
                    case STB_LOCAL:
                        symbol_info.scope = strdup("Local");
                        break;
                    case STB_WEAK:
                        symbol_info.scope = strdup("Weak");
                        break;
                    default:
                        symbol_info.scope = strdup("Unknown");
                        break;
                }

                symbols.push_back(symbol_info);
            }
        }

        // Parse PLT entries
        if (rela_plt && dynsym && dynstr && plt_section)
        {
            Elf64_Sym* dynsyms = (Elf64_Sym*)((char*)mapped + dynsym->sh_offset);
            char* dynstr_data = (char*)mapped + dynstr->sh_offset;

            uintptr_t plt_base = plt_section->sh_addr;
            size_t plt_entry_size = 16;

            bool is_arm64 = (ehdr->e_machine == EM_AARCH64);
            size_t plt_header_size = is_arm64 ? 32 : 16;

            bool is_rela = (rela_plt->sh_type == SHT_RELA);

            if (is_rela)
            {
                Elf64_Rela* relas = (Elf64_Rela*)((char*)mapped + rela_plt->sh_offset);
                int rela_count = rela_plt->sh_size / sizeof(Elf64_Rela);

                for (int i = 0; i < rela_count; i++)
                {
                    Elf64_Rela* rela = &relas[i];
                    int sym_idx = ELF64_R_SYM(rela->r_info);

                    if (sym_idx == 0) continue;

                    Elf64_Sym* sym = &dynsyms[sym_idx];
                    if (sym->st_name == 0) continue;

                    char* name = dynstr_data + sym->st_name;
                    if (strlen(name) == 0) continue;

                    uintptr_t plt_entry_addr = plt_base + plt_header_size + i * plt_entry_size;

                    SymbolInfo symbol_info;
                    symbol_info.address = module_base + plt_entry_addr;

                    std::string plt_name = std::string(name) + "@plt";
                    symbol_info.name = strdup(plt_name.c_str());
                    symbol_info.size = plt_entry_size;
                    symbol_info.module_base = module_base;
                    symbol_info.file_name = strdup(elf_path.c_str());
                    symbol_info.line_number = 0;
                    symbol_info.type = strdup("Function");
                    symbol_info.scope = strdup("PLT");

                    symbols.push_back(symbol_info);
                }
            }
            else
            {
                Elf64_Rel* rels = (Elf64_Rel*)((char*)mapped + rela_plt->sh_offset);
                int rel_count = rela_plt->sh_size / sizeof(Elf64_Rel);

                for (int i = 0; i < rel_count; i++)
                {
                    Elf64_Rel* rel = &rels[i];
                    int sym_idx = ELF64_R_SYM(rel->r_info);

                    if (sym_idx == 0) continue;

                    Elf64_Sym* sym = &dynsyms[sym_idx];
                    if (sym->st_name == 0) continue;

                    char* name = dynstr_data + sym->st_name;
                    if (strlen(name) == 0) continue;

                    uintptr_t plt_entry_addr = plt_base + plt_header_size + i * plt_entry_size;

                    SymbolInfo symbol_info;
                    symbol_info.address = module_base + plt_entry_addr;

                    std::string plt_name = std::string(name) + "@plt";
                    symbol_info.name = strdup(plt_name.c_str());
                    symbol_info.size = plt_entry_size;
                    symbol_info.module_base = module_base;
                    symbol_info.file_name = strdup(elf_path.c_str());
                    symbol_info.line_number = 0;
                    symbol_info.type = strdup("Function");
                    symbol_info.scope = strdup("PLT");

                    symbols.push_back(symbol_info);
                }
            }
        }
    }
    else
    {
        // 32-bit ELF parsing
        Elf32_Ehdr* ehdr32 = (Elf32_Ehdr*)mapped;
        Elf32_Shdr* shdrs = (Elf32_Shdr*)((char*)mapped + ehdr32->e_shoff);
        Elf32_Shdr* shstrtab = &shdrs[ehdr32->e_shstrndx];
        char* shstrtab_data = (char*)mapped + shstrtab->sh_offset;

        Elf32_Shdr* symtab = nullptr;
        Elf32_Shdr* strtab = nullptr;
        Elf32_Shdr* dynsym = nullptr;
        Elf32_Shdr* dynstr = nullptr;
        Elf32_Shdr* rel_plt = nullptr;
        Elf32_Shdr* plt_section = nullptr;

        for (int i = 0; i < ehdr32->e_shnum; i++)
        {
            char* section_name = shstrtab_data + shdrs[i].sh_name;

            if (strcmp(section_name, ".symtab") == 0)
                symtab = &shdrs[i];
            else if (strcmp(section_name, ".strtab") == 0)
                strtab = &shdrs[i];
            else if (strcmp(section_name, ".dynsym") == 0)
                dynsym = &shdrs[i];
            else if (strcmp(section_name, ".dynstr") == 0)
                dynstr = &shdrs[i];
            else if (strcmp(section_name, ".rel.plt") == 0 ||
                     strcmp(section_name, ".rela.plt") == 0)
                rel_plt = &shdrs[i];
            else if (strcmp(section_name, ".plt") == 0)
                plt_section = &shdrs[i];
        }

        if (!symtab)
        {
            symtab = dynsym;
            strtab = dynstr;
        }

        if (symtab && strtab)
        {
            Elf32_Sym* syms = (Elf32_Sym*)((char*)mapped + symtab->sh_offset);
            char* strtab_data = (char*)mapped + strtab->sh_offset;
            int sym_count = symtab->sh_size / sizeof(Elf32_Sym);

            for (int i = 0; i < sym_count; i++)
            {
                Elf32_Sym* sym = &syms[i];

                if (sym->st_shndx == SHN_UNDEF) continue;
                if (sym->st_name == 0) continue;

                char* name = strtab_data + sym->st_name;
                if (strlen(name) == 0) continue;

                SymbolInfo symbol_info;
                symbol_info.address = module_base + sym->st_value;
                symbol_info.name = strdup(name);
                symbol_info.size = sym->st_size;
                symbol_info.module_base = module_base;
                symbol_info.file_name = strdup(elf_path.c_str());
                symbol_info.line_number = 0;

                int sym_type = ELF32_ST_TYPE(sym->st_info);
                switch (sym_type)
                {
                    case STT_FUNC:
                    case STT_GNU_IFUNC:
                        symbol_info.type = strdup("Function");
                        break;
                    case STT_OBJECT:
                        symbol_info.type = strdup("Variable");
                        break;
                    case STT_SECTION:
                        symbol_info.type = strdup("Section");
                        break;
                    case STT_FILE:
                        symbol_info.type = strdup("File");
                        break;
                    default:
                        symbol_info.type = strdup("Unknown");
                        break;
                }

                int sym_bind = ELF32_ST_BIND(sym->st_info);
                switch (sym_bind)
                {
                    case STB_GLOBAL:
                        symbol_info.scope = strdup("Global");
                        break;
                    case STB_LOCAL:
                        symbol_info.scope = strdup("Local");
                        break;
                    case STB_WEAK:
                        symbol_info.scope = strdup("Weak");
                        break;
                    default:
                        symbol_info.scope = strdup("Unknown");
                        break;
                }

                symbols.push_back(symbol_info);
            }
        }

        // Parse PLT entries for 32-bit
        if (rel_plt && dynsym && dynstr && plt_section)
        {
            Elf32_Sym* dynsyms = (Elf32_Sym*)((char*)mapped + dynsym->sh_offset);
            char* dynstr_data = (char*)mapped + dynstr->sh_offset;

            uintptr_t plt_base = plt_section->sh_addr;
            size_t plt_entry_size = 16;

            bool is_arm = (ehdr32->e_machine == EM_ARM);
            size_t plt_header_size = is_arm ? 20 : 16;

            bool is_rela = (rel_plt->sh_type == SHT_RELA);

            if (is_rela)
            {
                Elf32_Rela* relas = (Elf32_Rela*)((char*)mapped + rel_plt->sh_offset);
                int rela_count = rel_plt->sh_size / sizeof(Elf32_Rela);

                for (int i = 0; i < rela_count; i++)
                {
                    Elf32_Rela* rela = &relas[i];
                    int sym_idx = ELF32_R_SYM(rela->r_info);

                    if (sym_idx == 0) continue;

                    Elf32_Sym* sym = &dynsyms[sym_idx];
                    if (sym->st_name == 0) continue;

                    char* name = dynstr_data + sym->st_name;
                    if (strlen(name) == 0) continue;

                    uintptr_t plt_entry_addr = plt_base + plt_header_size + i * plt_entry_size;

                    SymbolInfo symbol_info;
                    symbol_info.address = module_base + plt_entry_addr;

                    std::string plt_name = std::string(name) + "@plt";
                    symbol_info.name = strdup(plt_name.c_str());
                    symbol_info.size = plt_entry_size;
                    symbol_info.module_base = module_base;
                    symbol_info.file_name = strdup(elf_path.c_str());
                    symbol_info.line_number = 0;
                    symbol_info.type = strdup("Function");
                    symbol_info.scope = strdup("PLT");

                    symbols.push_back(symbol_info);
                }
            }
            else
            {
                Elf32_Rel* rels = (Elf32_Rel*)((char*)mapped + rel_plt->sh_offset);
                int rel_count = rel_plt->sh_size / sizeof(Elf32_Rel);

                for (int i = 0; i < rel_count; i++)
                {
                    Elf32_Rel* rel = &rels[i];
                    int sym_idx = ELF32_R_SYM(rel->r_info);

                    if (sym_idx == 0) continue;

                    Elf32_Sym* sym = &dynsyms[sym_idx];
                    if (sym->st_name == 0) continue;

                    char* name = dynstr_data + sym->st_name;
                    if (strlen(name) == 0) continue;

                    uintptr_t plt_entry_addr = plt_base + plt_header_size + i * plt_entry_size;

                    SymbolInfo symbol_info;
                    symbol_info.address = module_base + plt_entry_addr;

                    std::string plt_name = std::string(name) + "@plt";
                    symbol_info.name = strdup(plt_name.c_str());
                    symbol_info.size = plt_entry_size;
                    symbol_info.module_base = module_base;
                    symbol_info.file_name = strdup(elf_path.c_str());
                    symbol_info.line_number = 0;
                    symbol_info.type = strdup("Function");
                    symbol_info.scope = strdup("PLT");

                    symbols.push_back(symbol_info);
                }
            }
        }
    }

    munmap(mapped, st.st_size);
    close(fd);

    return symbols;
}

extern "C" SymbolInfo* enum_symbols_native(int pid, uintptr_t module_base, size_t* count)
{
    *count = 0;

    std::string module_path = get_module_path(pid, module_base);
    if (module_path.empty())
    {
        debug_log(LOG_ERROR, "Failed to find module path for base address 0x%lx in pid %d",
                  module_base, pid);
        return nullptr;
    }

    std::vector<SymbolInfo> symbols = parse_elf_symbols(module_path, module_base);

    if (symbols.empty())
    {
        return nullptr;
    }

    SymbolInfo* result = (SymbolInfo*)malloc(symbols.size() * sizeof(SymbolInfo));
    if (!result)
    {
        debug_log(LOG_ERROR, "Failed to allocate memory for symbols array");
        return nullptr;
    }

    for (size_t i = 0; i < symbols.size(); i++)
    {
        result[i] = symbols[i];
    }

    *count = symbols.size();

    return result;
}
