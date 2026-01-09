#ifndef DEBUGGER_H
#define DEBUGGER_H

#include <mach/mach.h>
#include <mach/mach_error.h>
#include <mach/mach_traps.h>
#include <mach/task.h>
#include <mach/thread_act.h>
#include <mach/vm_map.h>
#include <unistd.h>

#include <array>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "arch_defs.h"
#include "debugger_types.h"
#include "../../common/exception_info.h"
#include "../../common/trace_file.h"
#include "../../common/util.h"
#include "../core/native_api.h"

#define EXCEPTION_DEFAULT_BEHAVIOR 0x0

#ifdef DYNAMIC_LIB_BUILD
#define Debugger DebuggerDynamic

// Function pointer types for dynamically loaded functions
// Returns true if execution should auto-continue, false to enter break state
typedef bool (*send_exception_info_func_t)(const NativeExceptionInfo*, pid_t);

// Global function pointers (to be resolved at runtime)
extern send_exception_info_func_t g_send_exception_info;

// Initialization function to resolve function pointers
extern "C" void init_dynamic_functions();
#endif

class Debugger
{
public:
    Debugger(pid_t pid);
    ~Debugger();
    bool initialize();
    void run();
    kern_return_t set_watchpoint(mach_vm_address_t address, int size, WatchpointType type);
    kern_return_t remove_watchpoint(mach_vm_address_t address);
    kern_return_t set_breakpoint(mach_vm_address_t address, int hit_count, bool is_software = false,
                                 mach_vm_address_t end_address = 0);
    kern_return_t remove_breakpoint(mach_vm_address_t address);

    // Internal breakpoint methods
    kern_return_t set_hardware_breakpoint(mach_vm_address_t address, int hit_count,
                                          mach_vm_address_t end_address = 0);
    kern_return_t set_software_breakpoint(mach_vm_address_t address, int hit_count);
    kern_return_t remove_software_breakpoint(mach_vm_address_t address);

    // Software breakpoint original instruction query
    bool get_software_breakpoint_original_bytes(uint64_t address, uint8_t* out_bytes,
                                                size_t* out_size);

    // Trace file output mode
    void enable_trace_file_output(const std::string& filepath);
    void disable_trace_file_output();
    bool is_trace_file_output_enabled() const;
    const std::string& get_trace_file_path() const;
    uint32_t get_trace_file_entry_count() const;
    bool is_trace_ended_by_end_address() const;
    void reset_trace_ended_flag();

    // Script-initiated trace stop request
    void request_script_trace_stop(bool notify_ui = false);
    void clear_script_trace_stop_request();
    bool is_script_trace_stop_requested() const;
    bool should_notify_ui_on_stop() const
    {
        return script_trace_stop_with_ui_notification_.load();
    }

    // Full memory cache mode
    void enable_full_memory_cache(const std::string& dump_filepath,
                                  const std::string& log_filepath);
    void disable_full_memory_cache();
    bool is_full_memory_cache_enabled() const;
    bool dump_all_memory_regions();

    kern_return_t handle_exception(mach_port_t exception_port, mach_port_t thread, mach_port_t task,
                                   exception_type_t exception, mach_exception_data_t code,
                                   mach_msg_type_number_t code_count);

    // New API methods for break state control
    kern_return_t continue_execution(mach_port_t thread_id);
    kern_return_t single_step(mach_port_t thread_id);
    kern_return_t read_register(mach_port_t thread_id, const std::string& reg_name,
                                uint64_t* value);
    kern_return_t write_register(mach_port_t thread_id, const std::string& reg_name,
                                 uint64_t value);
    DebugState get_debug_state() const;
    bool is_in_break_state() const;

private:
    // Per-watchpoint/breakpoint synchronization (from debugger_types.h)
    std::array<WatchpointSync, MAX_WATCHPOINTS> watchpoint_sync_;
    std::array<BreakpointSync, MAX_BREAKPOINTS> breakpoint_sync_;
    std::mutex thread_states_mutex_;                  // Protects thread_states_
    mutable std::mutex watchpoint_data_mutex_;        // Protects watchpoint-related data
    mutable std::mutex breakpoint_data_mutex_;        // Protects breakpoint-related data

    // Trace file output
    bool trace_file_enabled_ = false;
    bool trace_session_ended_by_end_address_ =
        false;  // Flag to indicate trace ended due to end_address
    std::string trace_file_path_;
    std::unique_ptr<TraceFileWriter> trace_file_writer_;
    mutable std::mutex trace_file_mutex_;

    // Full memory cache
    bool full_memory_cache_enabled_ = false;
    bool memory_dump_completed_ = false;  // Flag to track if initial dump is done
    std::string memory_dump_path_;
    std::string memory_access_log_path_;
    std::unique_ptr<MemoryDumpWriter> memory_dump_writer_;
    std::unique_ptr<MemoryAccessLogWriter> memory_access_log_writer_;
    mutable std::mutex memory_cache_mutex_;

    // Hardware limits defined in debugger_types.h
    pid_t pid_;
    mach_port_t task_port_;
    mach_port_t exception_port_;
    std::vector<bool> watchpoint_used;
    std::vector<mach_vm_address_t> watchpoint_addresses;
    std::vector<int> watchpoint_sizes;
    std::vector<bool> breakpoint_used;
    std::vector<mach_vm_address_t> breakpoint_addresses;
    std::vector<int> breakpoint_hit_counts;
    std::vector<int> breakpoint_target_counts;
    std::vector<mach_vm_address_t>
        breakpoint_end_addresses;  // Optional end address to stop tracing

    // Software breakpoint data (stores original instruction bytes)
    std::vector<bool> software_breakpoint_used;
    std::vector<uint64_t> software_breakpoint_addresses;
    std::vector<uint8_t> software_breakpoint_original_bytes;  // Original instruction bytes (4 bytes
                                                              // per bp for ARM64)
    mutable std::mutex software_breakpoint_mutex_;

    // Tracing mode: track the first thread that hits the breakpoint
    // Only this thread will be single-stepped for tracing
    std::atomic<mach_port_t> tracked_trace_thread_{MACH_PORT_NULL};

    // Script-initiated trace stop request
    std::atomic<bool> script_trace_stop_requested_{false};
    std::atomic<bool> script_trace_stop_with_ui_notification_{false};

    // ThreadState and SingleStepMode defined in debugger_types.h
    std::map<mach_port_t, ThreadState> thread_states_;
    DebugState debug_state_ = DebugState::Running;
    mach_port_t current_thread = MACH_PORT_NULL;

    kern_return_t handle_single_step(mach_port_t thread, arm_debug_state64_t& debug_state,
                                     arm_thread_state64_t& thread_state,
                                     arm_exception_state64_t& exception_state);
    kern_return_t complete_watchpoint_single_step(mach_port_t thread,
                                                  arm_debug_state64_t& debug_state,
                                                  arm_thread_state64_t& thread_state,
                                                  arm_exception_state64_t& exception_state);
    kern_return_t continue_breakpoint_single_step(mach_port_t thread,
                                                  arm_debug_state64_t& debug_state,
                                                  arm_thread_state64_t& thread_state,
                                                  arm_exception_state64_t& exception_state);
    kern_return_t handle_watchpoint_hit(mach_port_t thread, arm_debug_state64_t& debug_state,
                                        arm_thread_state64_t& thread_state,
                                        arm_exception_state64_t& exception_state,
                                        int watchpoint_index);
    kern_return_t handle_breakpoint_hit(mach_port_t thread, arm_debug_state64_t& debug_state,
                                        arm_thread_state64_t& thread_state,
                                        arm_exception_state64_t& exception_state,
                                        int breakpoint_index);
    int find_free_watchpoint();
    int find_watchpoint_index(mach_vm_address_t address);
    int find_free_breakpoint();
    int find_breakpoint_index(mach_vm_address_t address);
    int get_available_watchpoints(mach_port_t thread);
    kern_return_t set_watchpoint_on_thread(mach_port_t thread, mach_vm_address_t address, int size,
                                           WatchpointType type, int index);
    kern_return_t clear_watchpoint_on_thread(thread_t thread, int index);
    kern_return_t remove_watchpoint_by_index(int index);
    static std::string kern_return_to_string(kern_return_t kr);
};

#ifdef DYNAMIC_LIB_BUILD
#define g_debugger g_debugger_dynamic

// Export non-mangled C function wrapper for handle_exception
extern "C" kern_return_t handle_exception_dynamic(Debugger* debugger, mach_port_t exception_port,
                                                  mach_port_t thread, mach_port_t task,
                                                  exception_type_t exception,
                                                  mach_exception_data_t code,
                                                  mach_msg_type_number_t code_count);
#endif

// Global pointer to the Debugger instance
extern "C" Debugger* g_debugger;

#endif  // DEBUGGER_H