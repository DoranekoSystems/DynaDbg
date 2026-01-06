#include "trace_file.h"

#include <chrono>
#include <cstring>

// TraceFileWriter implementation

TraceFileWriter::TraceFileWriter() : entry_count_(0), architecture_(TRACE_ARCH_ARM64) {}

TraceFileWriter::~TraceFileWriter()
{
    if (file_.is_open())
    {
        close();
    }
}

bool TraceFileWriter::open(const std::string& filepath, uint32_t architecture)
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (file_.is_open())
    {
        file_.close();
    }

    filepath_ = filepath;
    architecture_ = architecture;
    entry_count_ = 0;

    file_.open(filepath, std::ios::binary | std::ios::out | std::ios::trunc);
    if (!file_.is_open())
    {
        return false;
    }

    // Write initial header with entry_count = 0
    TraceFileHeader header;
    memset(&header, 0, sizeof(header));
    memcpy(header.magic, TRACE_FILE_MAGIC, 8);
    header.version = TRACE_FILE_VERSION;
    header.entry_count = 0;
    header.architecture = architecture;

    file_.write(reinterpret_cast<const char*>(&header), sizeof(header));
    file_.flush();

    return file_.good();
}

bool TraceFileWriter::write_entry(const TraceEntryArm64& entry)
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (!file_.is_open())
    {
        return false;
    }

    file_.write(reinterpret_cast<const char*>(&entry), sizeof(entry));
    if (!file_.good())
    {
        return false;
    }

    entry_count_++;
    return true;
}

bool TraceFileWriter::close()
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (!file_.is_open())
    {
        return false;
    }

    // Seek back to header and update entry count
    file_.seekp(0, std::ios::beg);

    TraceFileHeader header;
    memset(&header, 0, sizeof(header));
    memcpy(header.magic, TRACE_FILE_MAGIC, 8);
    header.version = TRACE_FILE_VERSION;
    header.entry_count = entry_count_;
    header.architecture = architecture_;

    file_.write(reinterpret_cast<const char*>(&header), sizeof(header));
    file_.close();

    return true;
}

// TraceFileReader implementation

TraceFileReader::TraceFileReader()
{
    memset(&header_, 0, sizeof(header_));
}

TraceFileReader::~TraceFileReader()
{
    close();
}

bool TraceFileReader::open(const std::string& filepath)
{
    close();

    file_.open(filepath, std::ios::binary | std::ios::in);
    if (!file_.is_open())
    {
        return false;
    }

    // Read and validate header
    if (!read_header(header_))
    {
        file_.close();
        return false;
    }

    // Validate magic
    if (memcmp(header_.magic, TRACE_FILE_MAGIC, 8) != 0)
    {
        file_.close();
        return false;
    }

    // Validate version
    if (header_.version != TRACE_FILE_VERSION)
    {
        file_.close();
        return false;
    }

    return true;
}

bool TraceFileReader::read_header(TraceFileHeader& header)
{
    if (!file_.is_open())
    {
        return false;
    }

    file_.seekg(0, std::ios::beg);
    file_.read(reinterpret_cast<char*>(&header), sizeof(header));

    return file_.good();
}

bool TraceFileReader::read_entry(uint32_t index, TraceEntryArm64& entry)
{
    if (!file_.is_open() || index >= header_.entry_count)
    {
        return false;
    }

    // Calculate entry offset (header + index * entry_size)
    std::streamoff offset =
        sizeof(TraceFileHeader) + static_cast<std::streamoff>(index) * TRACE_ENTRY_SIZE;
    file_.seekg(offset, std::ios::beg);
    file_.read(reinterpret_cast<char*>(&entry), sizeof(entry));

    return file_.good();
}

void TraceFileReader::close()
{
    if (file_.is_open())
    {
        file_.close();
    }
    memset(&header_, 0, sizeof(header_));
}

// MemoryDumpWriter implementation

MemoryDumpWriter::MemoryDumpWriter() : region_count_(0), total_size_(0) {}

MemoryDumpWriter::~MemoryDumpWriter()
{
    if (file_.is_open())
    {
        close();
    }
}

bool MemoryDumpWriter::open(const std::string& filepath)
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (file_.is_open())
    {
        file_.close();
    }

    filepath_ = filepath;
    region_count_ = 0;
    total_size_ = 0;

    file_.open(filepath, std::ios::binary | std::ios::out | std::ios::trunc);
    if (!file_.is_open())
    {
        return false;
    }

    // Write initial header with region_count = 0
    MemoryDumpHeader header;
    memset(&header, 0, sizeof(header));
    memcpy(header.magic, MEMORY_DUMP_MAGIC, 8);
    header.version = 1;
    header.region_count = 0;
    header.total_size = 0;

    file_.write(reinterpret_cast<const char*>(&header), sizeof(header));
    file_.flush();

    return file_.good();
}

bool MemoryDumpWriter::write_region(uint64_t address, uint64_t size, uint32_t protection,
                                    const uint8_t* data)
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (!file_.is_open() || !data)
    {
        return false;
    }

    // Write region header
    MemoryRegionHeader region_header;
    memset(&region_header, 0, sizeof(region_header));
    region_header.address = address;
    region_header.size = size;
    region_header.protection = protection;

    file_.write(reinterpret_cast<const char*>(&region_header), sizeof(region_header));
    if (!file_.good())
    {
        return false;
    }

    // Write region data
    file_.write(reinterpret_cast<const char*>(data), size);
    if (!file_.good())
    {
        return false;
    }

    region_count_++;
    total_size_ += size;
    return true;
}

bool MemoryDumpWriter::close()
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (!file_.is_open())
    {
        return false;
    }

    // Seek back to header and update counts
    file_.seekp(0, std::ios::beg);

    MemoryDumpHeader header;
    memset(&header, 0, sizeof(header));
    memcpy(header.magic, MEMORY_DUMP_MAGIC, 8);
    header.version = 1;
    header.region_count = region_count_;
    header.total_size = total_size_;

    file_.write(reinterpret_cast<const char*>(&header), sizeof(header));
    file_.close();

    return true;
}

// MemoryAccessLogWriter implementation

MemoryAccessLogWriter::MemoryAccessLogWriter() : access_count_(0) {}

MemoryAccessLogWriter::~MemoryAccessLogWriter()
{
    if (file_.is_open())
    {
        close();
    }
}

bool MemoryAccessLogWriter::open(const std::string& filepath)
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (file_.is_open())
    {
        file_.close();
    }

    filepath_ = filepath;
    access_count_ = 0;

    file_.open(filepath, std::ios::binary | std::ios::out | std::ios::trunc);
    if (!file_.is_open())
    {
        return false;
    }

    // Write initial header with access_count = 0
    MemoryAccessLogHeader header;
    memset(&header, 0, sizeof(header));
    memcpy(header.magic, MEMORY_ACCESS_LOG_MAGIC, 8);
    header.version = 1;
    header.access_count = 0;

    file_.write(reinterpret_cast<const char*>(&header), sizeof(header));
    file_.flush();

    return file_.good();
}

bool MemoryAccessLogWriter::write_access(uint32_t entry_index, uint64_t address, uint32_t size,
                                         bool is_write, const uint8_t* data)
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (!file_.is_open() || !data || size == 0)
    {
        return false;
    }

    // Write access header
    MemoryAccessHeader access_header;
    memset(&access_header, 0, sizeof(access_header));
    access_header.entry_index = entry_index;
    access_header.address = address;
    access_header.size = size;
    access_header.is_write = is_write ? 1 : 0;

    file_.write(reinterpret_cast<const char*>(&access_header), sizeof(access_header));
    if (!file_.good())
    {
        return false;
    }

    // Write access data
    file_.write(reinterpret_cast<const char*>(data), size);
    if (!file_.good())
    {
        return false;
    }

    access_count_++;
    return true;
}

bool MemoryAccessLogWriter::close()
{
    std::lock_guard<std::mutex> lock(write_mutex_);

    if (!file_.is_open())
    {
        return false;
    }

    // Seek back to header and update access count
    file_.seekp(0, std::ios::beg);

    MemoryAccessLogHeader header;
    memset(&header, 0, sizeof(header));
    memcpy(header.magic, MEMORY_ACCESS_LOG_MAGIC, 8);
    header.version = 1;
    header.access_count = access_count_;

    file_.write(reinterpret_cast<const char*>(&header), sizeof(header));
    file_.close();

    return true;
}
