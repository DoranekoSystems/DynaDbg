/**
 * @file debugger_native_api.cpp
 * @brief Native C API for debugger functionality
 *
 * This file contains the extern "C" API functions that expose the Debugger
 * class functionality to Rust and other C-compatible languages.
 *
 * Functions:
 * - debugger_new: Create and initialize debugger for a PID
 * - set_watchpoint_native: Set a hardware watchpoint
 * - remove_watchpoint_native: Remove a watchpoint
 * - set_breakpoint_native: Set a breakpoint (hardware or software)
 * - remove_breakpoint_native: Remove a breakpoint
 * - get_software_breakpoint_original_bytes_native: Get original instruction bytes
 * - continue_execution_native: Resume thread execution
 * - single_step_native: Single step a thread
 * - read_register_native: Read a register value
 * - write_register_native: Write a register value
 * - is_in_break_state_native: Check if debugger is at a breakpoint
 * - is_debugger_attached_native: Check if debugger is attached
 * - read_memory_debugger_native: Read process memory
 * - Signal configuration APIs: set/get/remove signal catch/pass behavior
 */

#include "debugger_internal.h"

extern "C"
{
    bool debugger_new(pid_t pid)
    {
        // If debugger already exists for the same PID and is running, reuse it
        if (g_debugger != nullptr)
        {
            if (g_debugger->get_pid() == pid && g_debugger->is_running())
            {
                return true;
            }
            // Different PID or not running - delete old debugger
            delete g_debugger;
            g_debugger = nullptr;
        }

        g_debugger = new Debugger(pid);

        // Sync global signal settings to new debugger instance
        {
            std::lock_guard<std::mutex> lock(g_signal_config_mutex);
            if (!g_signal_config.empty())
            {
                g_debugger->set_all_signal_configs(g_signal_config);
                debug_log(LOG_INFO, "Synced %zu signal configs to new debugger instance",
                          g_signal_config.size());
            }
        }

        if (g_debugger->initialize())
        {
            g_debugger->run();
            return true;
        }
        else
        {
            delete g_debugger;
            g_debugger = nullptr;
            return false;
        }
    }

    int set_watchpoint_native(uint64_t address, int size, WatchpointType type)
    {
        if (g_debugger)
        {
            return g_debugger->set_watchpoint(address, size, type);
        }
        return -1;
    }

    int remove_watchpoint_native(uint64_t address)
    {
        if (g_debugger)
        {
            return g_debugger->remove_watchpoint(address);
        }
        return -1;
    }

    int set_breakpoint_native(uint64_t address, int hit_count, bool is_software)
    {
        if (g_debugger)
        {
            return g_debugger->set_breakpoint(address, hit_count, is_software);
        }
        return -1;
    }

    int remove_breakpoint_native(uint64_t address)
    {
        if (g_debugger)
        {
            return g_debugger->remove_breakpoint(address);
        }
        return -1;
    }

    bool get_software_breakpoint_original_bytes_native(uint64_t address, uint8_t* out_bytes,
                                                       size_t* out_size)
    {
        if (g_debugger)
        {
            return g_debugger->get_software_breakpoint_original_bytes(address, out_bytes, out_size);
        }
        return false;
    }

    int continue_execution_native(pid_t thread_id)
    {
        if (g_debugger)
        {
            return g_debugger->continue_execution(thread_id);
        }
        return -1;
    }

    int single_step_native(pid_t thread_id)
    {
        if (g_debugger)
        {
            return g_debugger->single_step(thread_id);
        }
        return -1;
    }

    int read_register_native(pid_t thread_id, const char* reg_name, uint64_t* value)
    {
        if (g_debugger && reg_name && value)
        {
            std::string reg_str(reg_name);
            return g_debugger->read_register(thread_id, reg_str, value);
        }
        return -1;
    }

    int write_register_native(pid_t thread_id, const char* reg_name, uint64_t value)
    {
        if (g_debugger && reg_name)
        {
            std::string reg_str(reg_name);
            return g_debugger->write_register(thread_id, reg_str, value);
        }
        return -1;
    }

    bool is_in_break_state_native()
    {
        if (g_debugger)
        {
            return g_debugger->is_in_break_state();
        }
        return false;
    }

    bool is_debugger_attached_native()
    {
        return g_debugger != nullptr;
    }

    ssize_t read_memory_debugger_native(uint64_t address, size_t size, unsigned char* buffer)
    {
        if (g_debugger && buffer && size > 0)
        {
            return g_debugger->read_memory(address, size, buffer);
        }
        return -1;
    }

    // ==========================================================================
    // Signal configuration APIs (catch/pass behavior)
    // ==========================================================================

    void set_signal_config_native(int signal, bool catch_signal, bool pass_signal)
    {
        SignalConfig config(catch_signal, pass_signal);
        {
            std::lock_guard<std::mutex> lock(g_signal_config_mutex);
            g_signal_config[signal] = config;
        }
        if (g_debugger)
        {
            g_debugger->set_signal_config(signal, config);
            debug_log(LOG_INFO, "Set signal %d config: catch=%d, pass=%d (g_debugger updated)",
                      signal, catch_signal, pass_signal);
        }
        else
        {
            debug_log(LOG_INFO, "Set signal %d config: catch=%d, pass=%d (stored globally)", signal,
                      catch_signal, pass_signal);
        }
    }

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
            if (catch_signal) *catch_signal = false;
            if (pass_signal) *pass_signal = false;
        }
    }

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

    void remove_signal_config_native(int signal)
    {
        {
            std::lock_guard<std::mutex> lock(g_signal_config_mutex);
            g_signal_config.erase(signal);
        }
        if (g_debugger)
        {
            g_debugger->remove_signal_config(signal);
        }
        debug_log(LOG_INFO, "Removed signal %d config", signal);
    }
}
