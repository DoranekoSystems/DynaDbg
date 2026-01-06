#ifndef TRACE_FILE_H
#define TRACE_FILE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <fstream>
#include <mutex>
#include <string>

#ifdef __cplusplus
extern "C"
{
#endif

// Magic number for trace file identification
#define TRACE_FILE_MAGIC "DYNATRC\0"
#define TRACE_FILE_VERSION 1
#define TRACE_ARCH_ARM64 1
#define TRACE_ARCH_X86_64 2

// Memory dump size for each register (x0-x5)
#define TRACE_MEMORY_DUMP_SIZE 256
#define TRACE_MEMORY_REG_COUNT 6

// Instruction buffer size (null-terminated)
#define TRACE_INSTRUCTION_SIZE 64

    // File header structure (32 bytes)
    typedef struct __attribute__((packed))
    {
        char magic[8];          // "DYNATRC\0"
        uint32_t version;       // File format version
        uint32_t entry_count;   // Number of trace entries
        uint32_t architecture;  // 1 = ARM64, 2 = x86_64
        uint32_t reserved[3];   // Reserved for future use
    } TraceFileHeader;

    // ARM64 trace entry structure (fixed size for efficient reading)
    // Total size: 1920 bytes (aligned)
    typedef struct __attribute__((packed))
    {
        uint64_t timestamp;                        // Microseconds since epoch (8 bytes)
        uint64_t pc;                               // Program counter (8 bytes)
        uint64_t x[30];                            // x0-x29 registers (240 bytes)
        uint64_t lr;                               // Link register (8 bytes)
        uint64_t sp;                               // Stack pointer (8 bytes)
        uint64_t cpsr;                             // CPSR flags (8 bytes)
        uint32_t instruction_length;               // Instruction string length (4 bytes)
        char instruction[TRACE_INSTRUCTION_SIZE];  // Instruction string (64 bytes)
        uint8_t memory[TRACE_MEMORY_REG_COUNT]
                      [TRACE_MEMORY_DUMP_SIZE];  // Memory at x0-x5 (1536 bytes)
        uint8_t padding[36];                     // Padding to 1920 bytes
    } TraceEntryArm64;

#define TRACE_ENTRY_SIZE 1920

    // Memory access entry for full memory cache feature
    // Records memory read/write operations during trace
    typedef struct __attribute__((packed))
    {
        uint32_t entry_index;  // Index of the trace entry this belongs to (4 bytes)
        uint64_t address;      // Memory address accessed (8 bytes)
        uint32_t size;         // Size of data in bytes (4 bytes)
        uint8_t is_write;      // 1 if write, 0 if read (1 byte)
        uint8_t reserved[3];   // Padding (3 bytes)
        // Followed by 'size' bytes of data
    } MemoryAccessHeader;

#define MEMORY_ACCESS_HEADER_SIZE 20

    // Memory region header for initial memory dump
    typedef struct __attribute__((packed))
    {
        uint64_t address;     // Region start address (8 bytes)
        uint64_t size;        // Region size in bytes (8 bytes)
        uint32_t protection;  // Memory protection flags (4 bytes)
        uint32_t reserved;    // Reserved (4 bytes)
        // Followed by 'size' bytes of memory data
    } MemoryRegionHeader;

#define MEMORY_REGION_HEADER_SIZE 24

    // Memory dump file header
    typedef struct __attribute__((packed))
    {
        char magic[8];          // "DYNAMEM\0"
        uint32_t version;       // File format version
        uint32_t region_count;  // Number of memory regions
        uint64_t total_size;    // Total memory size
        uint32_t reserved[2];   // Reserved for future use
    } MemoryDumpHeader;

#define MEMORY_DUMP_MAGIC "DYNAMEM\0"
#define MEMORY_DUMP_HEADER_SIZE 32

    // Memory access log file header
    typedef struct __attribute__((packed))
    {
        char magic[8];          // "DYNALOG\0"
        uint32_t version;       // File format version
        uint32_t access_count;  // Number of memory accesses
        uint32_t reserved[4];   // Reserved for future use
    } MemoryAccessLogHeader;

#define MEMORY_ACCESS_LOG_MAGIC "DYNALOG\0"
#define MEMORY_ACCESS_LOG_HEADER_SIZE 32

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus

// C++ Trace file writer class
class TraceFileWriter
{
public:
    TraceFileWriter();
    ~TraceFileWriter();

    // Open a new trace file for writing
    bool open(const std::string& filepath, uint32_t architecture);

    // Write a single trace entry
    bool write_entry(const TraceEntryArm64& entry);

    // Close the file and finalize header
    bool close();

    // Get the current file path
    const std::string& get_filepath() const
    {
        return filepath_;
    }

    // Get the number of entries written
    uint32_t get_entry_count() const
    {
        return entry_count_;
    }

    // Check if file is open
    bool is_open() const
    {
        return file_.is_open();
    }

private:
    std::ofstream file_;
    std::string filepath_;
    uint32_t entry_count_;
    uint32_t architecture_;
    std::mutex write_mutex_;
};

// C++ Trace file reader class
class TraceFileReader
{
public:
    TraceFileReader();
    ~TraceFileReader();

    // Open a trace file for reading
    bool open(const std::string& filepath);

    // Read the header
    bool read_header(TraceFileHeader& header);

    // Read a specific entry by index
    bool read_entry(uint32_t index, TraceEntryArm64& entry);

    // Get the number of entries
    uint32_t get_entry_count() const
    {
        return header_.entry_count;
    }

    // Get the architecture
    uint32_t get_architecture() const
    {
        return header_.architecture;
    }

    // Close the file
    void close();

    // Check if file is open
    bool is_open() const
    {
        return file_.is_open();
    }

private:
    std::ifstream file_;
    TraceFileHeader header_;
};

// C++ Memory dump writer class - writes initial memory snapshot
class MemoryDumpWriter
{
public:
    MemoryDumpWriter();
    ~MemoryDumpWriter();

    // Open a new memory dump file for writing
    bool open(const std::string& filepath);

    // Write a memory region
    bool write_region(uint64_t address, uint64_t size, uint32_t protection, const uint8_t* data);

    // Close the file and finalize header
    bool close();

    // Get the current file path
    const std::string& get_filepath() const
    {
        return filepath_;
    }

    // Get the number of regions written
    uint32_t get_region_count() const
    {
        return region_count_;
    }

    // Check if file is open
    bool is_open() const
    {
        return file_.is_open();
    }

private:
    std::ofstream file_;
    std::string filepath_;
    uint32_t region_count_;
    uint64_t total_size_;
    std::mutex write_mutex_;
};

// C++ Memory access log writer class - logs memory accesses during trace
class MemoryAccessLogWriter
{
public:
    MemoryAccessLogWriter();
    ~MemoryAccessLogWriter();

    // Open a new memory access log file for writing
    bool open(const std::string& filepath);

    // Write a memory access entry
    bool write_access(uint32_t entry_index, uint64_t address, uint32_t size, bool is_write,
                      const uint8_t* data);

    // Close the file and finalize header
    bool close();

    // Get the current file path
    const std::string& get_filepath() const
    {
        return filepath_;
    }

    // Get the number of accesses written
    uint32_t get_access_count() const
    {
        return access_count_;
    }

    // Check if file is open
    bool is_open() const
    {
        return file_.is_open();
    }

private:
    std::ofstream file_;
    std::string filepath_;
    uint32_t access_count_;
    std::mutex write_mutex_;
};

#endif  // __cplusplus

#endif  // TRACE_FILE_H
