/**
 * @file debugger_trace.mm
 * @brief Trace file output and memory cache related Debugger class member functions (Darwin/macOS)
 *
 * This file contains the implementation of trace file output and full memory cache
 * functionality for the Darwin debugger.
 *
 * Functions included:
 *   - enable_trace_file_output: Enable trace file recording
 *   - disable_trace_file_output: Disable and close trace file
 *   - get_trace_file_entry_count: Get number of recorded trace entries
 *   - enable_full_memory_cache: Enable memory dump and access logging
 *   - disable_full_memory_cache: Disable and close memory cache files
 *   - dump_all_memory_regions: Dump all readable memory regions to file
 */

#include "debugger_internal.h"

// =============================================================================
// Trace File Output
// =============================================================================

void Debugger::enable_trace_file_output(const std::string& filepath)
{
    std::lock_guard<std::mutex> lock(trace_file_mutex_);

    // Close existing file if open
    if (trace_file_writer_)
    {
        trace_file_writer_->close();
        trace_file_writer_.reset();
    }

    // Reset trace ended flag when starting new trace
    trace_session_ended_by_end_address_ = false;

    trace_file_path_ = filepath;
    trace_file_writer_ = std::make_unique<TraceFileWriter>();

    if (trace_file_writer_->open(filepath, TRACE_ARCH_ARM64))
    {
        trace_file_enabled_ = true;
        // debug_log_develop(LOG_INFO, "Trace file output enabled: %s", filepath.c_str());
    }
    else
    {
        debug_log(LOG_ERROR, "Failed to open trace file: %s", filepath.c_str());
        trace_file_writer_.reset();
        trace_file_enabled_ = false;
    }
}

void Debugger::disable_trace_file_output()
{
    std::lock_guard<std::mutex> lock(trace_file_mutex_);

    if (trace_file_writer_)
    {
        trace_file_writer_->close();
        // debug_log_develop(LOG_INFO, "Trace file closed: %s (entries: %u)",
        // trace_file_path_.c_str(),
        //                   trace_file_writer_->get_entry_count());
        trace_file_writer_.reset();
    }

    trace_file_enabled_ = false;
}

uint32_t Debugger::get_trace_file_entry_count() const
{
    std::lock_guard<std::mutex> lock(trace_file_mutex_);
    if (trace_file_writer_)
    {
        return trace_file_writer_->get_entry_count();
    }
    return 0;
}

bool Debugger::is_trace_file_output_enabled() const
{
    std::lock_guard<std::mutex> lock(trace_file_mutex_);
    return trace_file_enabled_;
}

const std::string& Debugger::get_trace_file_path() const
{
    std::lock_guard<std::mutex> lock(trace_file_mutex_);
    return trace_file_path_;
}

bool Debugger::is_trace_ended_by_end_address() const
{
    return trace_session_ended_by_end_address_;
}

void Debugger::reset_trace_ended_flag()
{
    trace_session_ended_by_end_address_ = false;
}

// =============================================================================
// Script Trace Control
// =============================================================================

void Debugger::request_script_trace_stop(bool notify_ui)
{
    script_trace_stop_requested_.store(true);
    script_trace_stop_with_ui_notification_.store(notify_ui);
}

void Debugger::clear_script_trace_stop_request()
{
    script_trace_stop_requested_.store(false);
    script_trace_stop_with_ui_notification_.store(false);
}

bool Debugger::is_script_trace_stop_requested() const
{
    return script_trace_stop_requested_.load();
}

// =============================================================================
// Full Memory Cache
// =============================================================================

void Debugger::enable_full_memory_cache(const std::string& dump_filepath,
                                        const std::string& log_filepath)
{
    std::lock_guard<std::mutex> lock(memory_cache_mutex_);

    // Close existing files if open
    if (memory_dump_writer_)
    {
        memory_dump_writer_->close();
        memory_dump_writer_.reset();
    }
    if (memory_access_log_writer_)
    {
        memory_access_log_writer_->close();
        memory_access_log_writer_.reset();
    }

    memory_dump_path_ = dump_filepath;
    memory_access_log_path_ = log_filepath;

    // Open memory access log writer
    memory_access_log_writer_ = std::make_unique<MemoryAccessLogWriter>();
    if (!memory_access_log_writer_->open(log_filepath))
    {
        debug_log(LOG_ERROR, "Failed to open memory access log: %s", log_filepath.c_str());
        memory_access_log_writer_.reset();
        full_memory_cache_enabled_ = false;
        return;
    }

    full_memory_cache_enabled_ = true;
    // debug_log_develop(LOG_INFO, "Full memory cache enabled: dump=%s, log=%s",
    // dump_filepath.c_str(),
    //                   log_filepath.c_str());
}

void Debugger::disable_full_memory_cache()
{
    std::lock_guard<std::mutex> lock(memory_cache_mutex_);

    if (memory_dump_writer_)
    {
        memory_dump_writer_->close();
        // debug_log_develop(LOG_INFO, "Memory dump closed: %s (regions: %u)",
        //                   memory_dump_path_.c_str(), memory_dump_writer_->get_region_count());
        memory_dump_writer_.reset();
    }

    if (memory_access_log_writer_)
    {
        memory_access_log_writer_->close();
        // debug_log_develop(LOG_INFO, "Memory access log closed: %s (accesses: %u)",
        //                   memory_access_log_path_.c_str(),
        //                   memory_access_log_writer_->get_access_count());
        memory_access_log_writer_.reset();
    }

    full_memory_cache_enabled_ = false;
    memory_dump_completed_ = false;
}

bool Debugger::is_full_memory_cache_enabled() const
{
    std::lock_guard<std::mutex> lock(memory_cache_mutex_);
    return full_memory_cache_enabled_;
}

bool Debugger::dump_all_memory_regions()
{
    std::lock_guard<std::mutex> lock(memory_cache_mutex_);

    if (memory_dump_path_.empty())
    {
        debug_log(LOG_ERROR, "Memory dump path not set");
        return false;
    }

    // Create memory dump writer
    memory_dump_writer_ = std::make_unique<MemoryDumpWriter>();
    if (!memory_dump_writer_->open(memory_dump_path_))
    {
        debug_log(LOG_ERROR, "Failed to open memory dump file: %s", memory_dump_path_.c_str());
        memory_dump_writer_.reset();
        return false;
    }

    // debug_log_develop(LOG_INFO, "Starting memory region dump to: %s", memory_dump_path_.c_str());

    // Enumerate and dump all memory regions
    vm_address_t address = 0;
    vm_size_t size = 0;
    natural_t depth = 0;
    vm_region_submap_info_data_64_t info;
    mach_msg_type_number_t info_count;
    uint32_t regions_dumped = 0;
    uint64_t total_bytes = 0;

    while (true)
    {
        info_count = VM_REGION_SUBMAP_INFO_COUNT_64;
        kern_return_t kr = vm_region_recurse_64(task_port_, &address, &size, &depth,
                                                (vm_region_recurse_info_t)&info, &info_count);

        if (kr != KERN_SUCCESS)
        {
            break;  // End of regions
        }

        if (info.is_submap)
        {
            depth++;
            continue;
        }

        // Only dump readable regions
        if ((info.protection & VM_PROT_READ) != 0)
        {
            // Allocate buffer for region data
            std::vector<uint8_t> buffer(size);
            mach_vm_size_t bytes_read = 0;

            kr = mach_vm_read_overwrite(task_port_, address, size, (mach_vm_address_t)buffer.data(),
                                        &bytes_read);

            if (kr == KERN_SUCCESS && bytes_read > 0)
            {
                if (memory_dump_writer_->write_region(address, bytes_read, info.protection,
                                                      buffer.data()))
                {
                    regions_dumped++;
                    total_bytes += bytes_read;
                    // debug_log_develop(LOG_DEBUG, "Dumped region: 0x%llx - 0x%llx (%llu bytes)",
                    //                   address, address + bytes_read, bytes_read);
                }
            }
            else
            {
                // debug_log_develop(LOG_DEBUG, "Failed to read region 0x%llx: %s", address,
                //                   mach_error_string(kr));
            }
        }

        address += size;
    }

    memory_dump_writer_->close();
    // debug_log_develop(LOG_INFO, "Memory dump complete: %u regions, %llu bytes", regions_dumped,
    //                   total_bytes);

    return true;
}
