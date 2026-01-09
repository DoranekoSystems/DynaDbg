/**
 * @file debugger_native_api.mm
 * @brief Native C API wrapper functions for Debugger class (Darwin/macOS)
 *
 * This file contains the extern "C" wrapper functions that expose the Debugger
 * class functionality to the Rust layer. These are the entry points for the
 * native bridge.
 *
 * Functions included:
 *   - debugger_new: Create and initialize new debugger instance
 *   - set_watchpoint_native, remove_watchpoint_native
 *   - set_breakpoint_native, remove_breakpoint_native
 *   - get_software_breakpoint_original_bytes_native
 *   - continue_execution_native, single_step_native
 *   - read_register_native, write_register_native
 *   - is_in_break_state_native
 *   - Trace file output APIs
 *   - Full memory cache APIs
 *   - Signal configuration APIs
 *   - Script trace control APIs
 */

#include "debugger_internal.h"

extern "C"
{
    bool debugger_new(pid_t pid)
    {
#ifdef DYNAMIC_LIB_BUILD
        // Initialize dynamic functions before creating debugger
        init_dynamic_functions();
#endif

        if (g_debugger == nullptr)
        {
            g_debugger = new Debugger(pid);
            if (g_debugger->initialize())
            {
                std::thread([&]() { g_debugger->run(); }).detach();
                return true;
            }
            else
            {
                delete g_debugger;
                g_debugger = nullptr;
                return false;
            }
        }
        return true;
    }

    kern_return_t set_watchpoint_native(mach_vm_address_t address, int size, WatchpointType type)
    {
        if (g_debugger)
        {
            return g_debugger->set_watchpoint(address, size, type);
        }
        return KERN_FAILURE;
    }

    kern_return_t remove_watchpoint_native(mach_vm_address_t address)
    {
        if (g_debugger)
        {
            return g_debugger->remove_watchpoint(address);
        }
        return KERN_FAILURE;
    }

    kern_return_t set_breakpoint_native(mach_vm_address_t address, int hit_count, bool is_software,
                                        mach_vm_address_t end_address)
    {
        if (g_debugger)
        {
            return g_debugger->set_breakpoint(address, hit_count, is_software, end_address);
        }
        return KERN_FAILURE;
    }

    kern_return_t remove_breakpoint_native(mach_vm_address_t address)
    {
        if (g_debugger)
        {
            return g_debugger->remove_breakpoint(address);
        }
        return KERN_FAILURE;
    }

    // Get original instruction bytes for software breakpoint
    bool get_software_breakpoint_original_bytes_native(uint64_t address, uint8_t* out_bytes,
                                                       size_t* out_size)
    {
        if (g_debugger)
        {
            return g_debugger->get_software_breakpoint_original_bytes(address, out_bytes, out_size);
        }
        return false;
    }

    // New break state control APIs
    kern_return_t continue_execution_native(mach_port_t thread_id)
    {
        if (g_debugger)
        {
            return g_debugger->continue_execution(thread_id);
        }
        return KERN_FAILURE;
    }

    kern_return_t single_step_native(mach_port_t thread_id)
    {
        if (g_debugger)
        {
            return g_debugger->single_step(thread_id);
        }
        return KERN_FAILURE;
    }

    kern_return_t read_register_native(mach_port_t thread_id, const char* reg_name, uint64_t* value)
    {
        if (g_debugger && reg_name && value)
        {
            std::string reg_str(reg_name);
            return g_debugger->read_register(thread_id, reg_str, value);
        }
        return KERN_FAILURE;
    }

    kern_return_t write_register_native(mach_port_t thread_id, const char* reg_name, uint64_t value)
    {
        if (g_debugger && reg_name)
        {
            std::string reg_str(reg_name);
            return g_debugger->write_register(thread_id, reg_str, value);
        }
        return KERN_FAILURE;
    }

    bool is_in_break_state_native()
    {
        if (g_debugger)
        {
            return g_debugger->is_in_break_state();
        }
        return false;
    }

    // Trace file output APIs
    void enable_trace_file_output_native(const char* filepath)
    {
        if (g_debugger && filepath)
        {
            g_debugger->enable_trace_file_output(std::string(filepath));
        }
    }

    void disable_trace_file_output_native()
    {
        if (g_debugger)
        {
            g_debugger->disable_trace_file_output();
        }
    }

    bool is_trace_file_output_enabled_native()
    {
        if (g_debugger)
        {
            return g_debugger->is_trace_file_output_enabled();
        }
        return false;
    }

    const char* get_trace_file_path_native()
    {
        static std::string cached_path;
        if (g_debugger)
        {
            cached_path = g_debugger->get_trace_file_path();
            return cached_path.c_str();
        }
        return "";
    }

    uint32_t get_trace_file_entry_count_native()
    {
        if (g_debugger)
        {
            return g_debugger->get_trace_file_entry_count();
        }
        return 0;
    }

    bool is_trace_ended_by_end_address_native()
    {
        if (g_debugger)
        {
            return g_debugger->is_trace_ended_by_end_address();
        }
        return false;
    }

    void reset_trace_ended_flag_native()
    {
        if (g_debugger)
        {
            g_debugger->reset_trace_ended_flag();
        }
    }

    // Full memory cache APIs
    void enable_full_memory_cache_native(const char* dump_filepath, const char* log_filepath)
    {
        if (g_debugger && dump_filepath && log_filepath)
        {
            g_debugger->enable_full_memory_cache(std::string(dump_filepath),
                                                 std::string(log_filepath));
        }
    }

    void disable_full_memory_cache_native()
    {
        if (g_debugger)
        {
            g_debugger->disable_full_memory_cache();
        }
    }

    bool is_full_memory_cache_enabled_native()
    {
        if (g_debugger)
        {
            return g_debugger->is_full_memory_cache_enabled();
        }
        return false;
    }

    bool dump_all_memory_regions_native()
    {
        if (g_debugger)
        {
            return g_debugger->dump_all_memory_regions();
        }
        return false;
    }

    // Signal configuration APIs (catch/pass behavior)
    // These use global state so settings persist even when debugger is not attached

    // Set signal configuration (catch/pass)
    void set_signal_config_native(int signal, bool catch_signal, bool pass_signal)
    {
        SignalConfig config(catch_signal, pass_signal);
        {
            std::lock_guard<std::mutex> lock(g_signal_config_mutex);
            g_signal_config[signal] = config;
        }
        // debug_log(LOG_INFO, "Set signal %d config: catch=%d, pass=%d (stored globally)", signal,
        //          catch_signal, pass_signal);
    }

    // Get signal configuration (catch/pass)
    void get_signal_config_native(int signal, bool* catch_signal, bool* pass_signal)
    {
        std::lock_guard<std::mutex> lock(g_signal_config_mutex);
        auto it = g_signal_config.find(signal);
        if (it != g_signal_config.end())
        {
            if (catch_signal) *catch_signal = it->second.catch_signal;
            if (pass_signal) *pass_signal = it->second.pass_signal;
        }
        else
        {
            // Default: don't catch, don't pass (suppress signal, like GDB)
            if (catch_signal) *catch_signal = false;
            if (pass_signal) *pass_signal = false;
        }
    }

    // Get all signal configurations
    // Returns number of configured signals, fills arrays with signal/catch/pass values
    size_t get_all_signal_configs_native(int* signals, bool* catch_signals, bool* pass_signals,
                                         size_t max_count)
    {
        std::lock_guard<std::mutex> lock(g_signal_config_mutex);
        size_t count = 0;
        for (const auto& pair : g_signal_config)
        {
            if (count >= max_count) break;
            if (signals) signals[count] = pair.first;
            if (catch_signals) catch_signals[count] = pair.second.catch_signal;
            if (pass_signals) pass_signals[count] = pair.second.pass_signal;
            ++count;
        }
        return count;
    }

    // Remove signal configuration (reset to default)
    void remove_signal_config_native(int signal)
    {
        {
            std::lock_guard<std::mutex> lock(g_signal_config_mutex);
            g_signal_config.erase(signal);
        }
        debug_log(LOG_INFO, "Removed signal %d config", signal);
    }

    // Script trace control APIs
    void request_script_trace_stop_native(bool notify_ui)
    {
        if (g_debugger)
        {
            g_debugger->request_script_trace_stop(notify_ui);
            debug_log(LOG_INFO, "Script trace stop requested (notify_ui=%d)", notify_ui);
        }
    }

    void clear_script_trace_stop_request_native()
    {
        if (g_debugger)
        {
            g_debugger->clear_script_trace_stop_request();
        }
    }

    bool is_script_trace_stop_requested_native()
    {
        if (g_debugger)
        {
            return g_debugger->is_script_trace_stop_requested();
        }
        return false;
    }
}
