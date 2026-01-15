#include "debugger.h"

#include "../core/native_api.h"

// Global debugger instance
Debugger* g_debugger = nullptr;

// ============================================================================
// Debugger class implementation (Mock)
// ============================================================================

Debugger::Debugger(int pid) : pid_(pid), running_(false), debug_state_(DebugState::NotStarted)
{
    // Initialize watchpoint slots
    for (int i = 0; i < MAX_WATCHPOINTS; i++)
    {
        watchpoints_[i].used = false;
        watchpoints_[i].address = 0;
        watchpoints_[i].size = 0;
        watchpoints_[i].type = WatchpointType::WRITE;
    }

    // Initialize breakpoint slots
    for (int i = 0; i < MAX_BREAKPOINTS; i++)
    {
        breakpoints_[i].used = false;
        breakpoints_[i].address = 0;
        breakpoints_[i].hit_count = 0;
        breakpoints_[i].target_count = 0;
    }

    // Initialize software breakpoint slots
    for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
    {
        software_breakpoints_[i].used = false;
        software_breakpoints_[i].address = 0;
        software_breakpoints_[i].original_byte = 0;
        software_breakpoints_[i].hit_count = 0;
        software_breakpoints_[i].target_count = 0;
    }
}

Debugger::~Debugger()
{
    stop();
}

bool Debugger::initialize()
{
    // Mock: Just validate that PID exists
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid_);
    if (hProcess == NULL)
    {
        debug_log(LOG_ERROR, "[Mock] Failed to validate process %d. Error: %lu", pid_,
                  GetLastError());
        return false;
    }
    CloseHandle(hProcess);
    debug_log(LOG_INFO, "[Mock] Debugger initialized for process %d", pid_);
    return true;
}

void Debugger::run()
{
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = true;
    debug_state_ = DebugState::Running;
    debug_log(LOG_INFO, "[Mock] Debugger started for process %d", pid_);
}

void Debugger::stop()
{
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
    debug_state_ = DebugState::Stopped;
    debug_log(LOG_INFO, "[Mock] Debugger stopped for process %d", pid_);
}

bool Debugger::wait_for_attach(int timeout_ms)
{
    // Mock: Always succeeds immediately
    debug_log(LOG_INFO, "[Mock] Debugger attach completed for process %d", pid_);
    return true;
}

// ============================================================================
// Watchpoint operations (Mock)
// ============================================================================

int Debugger::find_free_watchpoint_slot()
{
    for (int i = 0; i < MAX_WATCHPOINTS; i++)
    {
        if (!watchpoints_[i].used) return i;
    }
    return -1;
}

int Debugger::find_watchpoint_index(uint64_t address)
{
    for (int i = 0; i < MAX_WATCHPOINTS; i++)
    {
        if (watchpoints_[i].used && watchpoints_[i].address == address) return i;
    }
    return -1;
}

int Debugger::set_watchpoint(uint64_t address, int size, WatchpointType type)
{
    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_free_watchpoint_slot();
    if (index < 0)
    {
        debug_log(LOG_ERROR, "[Mock] No free watchpoint slots available");
        return -1;
    }

    watchpoints_[index].used = true;
    watchpoints_[index].address = address;
    watchpoints_[index].size = size;
    watchpoints_[index].type = type;

    debug_log(LOG_INFO, "[Mock] Set watchpoint at 0x%llx (size=%d, type=%d, slot=%d)",
              (unsigned long long)address, size, (int)type, index);
    return index;
}

int Debugger::remove_watchpoint(uint64_t address)
{
    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_watchpoint_index(address);
    if (index < 0)
    {
        debug_log(LOG_WARN, "[Mock] Watchpoint not found at 0x%llx", (unsigned long long)address);
        return -1;
    }

    watchpoints_[index].used = false;
    watchpoints_[index].address = 0;
    debug_log(LOG_INFO, "[Mock] Removed watchpoint at 0x%llx (slot=%d)",
              (unsigned long long)address, index);
    return 0;
}

// ============================================================================
// Hardware breakpoint operations (Mock)
// ============================================================================

int Debugger::find_free_breakpoint_slot()
{
    for (int i = 0; i < MAX_BREAKPOINTS; i++)
    {
        if (!breakpoints_[i].used) return i;
    }
    return -1;
}

int Debugger::find_breakpoint_index(uint64_t address)
{
    for (int i = 0; i < MAX_BREAKPOINTS; i++)
    {
        if (breakpoints_[i].used && breakpoints_[i].address == address) return i;
    }
    return -1;
}

int Debugger::set_breakpoint(uint64_t address, int hit_count, bool is_software)
{
    if (is_software)
    {
        return set_software_breakpoint(address, hit_count);
    }

    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_free_breakpoint_slot();
    if (index < 0)
    {
        debug_log(LOG_ERROR, "[Mock] No free hardware breakpoint slots available");
        return -1;
    }

    breakpoints_[index].used = true;
    breakpoints_[index].address = address;
    breakpoints_[index].hit_count = 0;
    breakpoints_[index].target_count = hit_count;

    debug_log(LOG_INFO, "[Mock] Set hardware breakpoint at 0x%llx (hit_count=%d, slot=%d)",
              (unsigned long long)address, hit_count, index);
    return index;
}

int Debugger::remove_breakpoint(uint64_t address)
{
    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_breakpoint_index(address);
    if (index < 0)
    {
        debug_log(LOG_WARN, "[Mock] Hardware breakpoint not found at 0x%llx",
                  (unsigned long long)address);
        return -1;
    }

    breakpoints_[index].used = false;
    breakpoints_[index].address = 0;
    debug_log(LOG_INFO, "[Mock] Removed hardware breakpoint at 0x%llx (slot=%d)",
              (unsigned long long)address, index);
    return 0;
}

// ============================================================================
// Software breakpoint operations (Mock)
// ============================================================================

int Debugger::find_free_software_breakpoint_slot()
{
    for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
    {
        if (!software_breakpoints_[i].used) return i;
    }
    return -1;
}

int Debugger::find_software_breakpoint_index(uint64_t address)
{
    for (int i = 0; i < MAX_SOFTWARE_BREAKPOINTS; i++)
    {
        if (software_breakpoints_[i].used && software_breakpoints_[i].address == address) return i;
    }
    return -1;
}

int Debugger::set_software_breakpoint(uint64_t address, int hit_count)
{
    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_free_software_breakpoint_slot();
    if (index < 0)
    {
        debug_log(LOG_ERROR, "[Mock] No free software breakpoint slots available");
        return -1;
    }

    software_breakpoints_[index].used = true;
    software_breakpoints_[index].address = address;
    software_breakpoints_[index].original_byte = 0xCC;  // Mock: pretend we saved INT3
    software_breakpoints_[index].hit_count = 0;
    software_breakpoints_[index].target_count = hit_count;

    debug_log(LOG_INFO, "[Mock] Set software breakpoint at 0x%llx (hit_count=%d, slot=%d)",
              (unsigned long long)address, hit_count, index);
    return index;
}

int Debugger::remove_software_breakpoint(uint64_t address)
{
    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_software_breakpoint_index(address);
    if (index < 0)
    {
        debug_log(LOG_WARN, "[Mock] Software breakpoint not found at 0x%llx",
                  (unsigned long long)address);
        return -1;
    }

    software_breakpoints_[index].used = false;
    software_breakpoints_[index].address = 0;
    debug_log(LOG_INFO, "[Mock] Removed software breakpoint at 0x%llx (slot=%d)",
              (unsigned long long)address, index);
    return 0;
}

bool Debugger::get_software_breakpoint_original_bytes(uint64_t address, uint8_t* out_bytes,
                                                      size_t* out_size)
{
    std::lock_guard<std::mutex> lock(mutex_);

    int index = find_software_breakpoint_index(address);
    if (index < 0)
    {
        debug_log(LOG_WARN, "[Mock] Software breakpoint not found at 0x%llx for original bytes",
                  (unsigned long long)address);
        return false;
    }

    if (out_bytes && out_size)
    {
        out_bytes[0] = software_breakpoints_[index].original_byte;
        *out_size = 1;
    }

    debug_log(LOG_DEBUG, "[Mock] Retrieved original bytes for software breakpoint at 0x%llx",
              (unsigned long long)address);
    return true;
}

// ============================================================================
// Debug control (Mock)
// ============================================================================

int Debugger::continue_execution(DWORD thread_id)
{
    std::lock_guard<std::mutex> lock(mutex_);
    debug_state_ = DebugState::Running;
    debug_log(LOG_INFO, "[Mock] Continue execution for thread %lu", thread_id);
    return 0;
}

int Debugger::single_step(DWORD thread_id)
{
    std::lock_guard<std::mutex> lock(mutex_);
    debug_state_ = DebugState::SingleStepping;
    debug_log(LOG_INFO, "[Mock] Single step for thread %lu", thread_id);
    return 0;
}

bool Debugger::is_in_break_state() const
{
    DebugState state = debug_state_.load();
    return state == DebugState::BreakpointHit || state == DebugState::WatchpointHit;
}

// ============================================================================
// C API implementations for Rust FFI
// ============================================================================

extern "C" int continue_execution_native(uintptr_t thread_id)
{
    if (g_debugger)
    {
        return g_debugger->continue_execution((DWORD)thread_id);
    }
    debug_log(LOG_WARN, "[Mock] continue_execution_native: No debugger attached");
    return -1;
}

extern "C" int single_step_native(uintptr_t thread_id)
{
    if (g_debugger)
    {
        return g_debugger->single_step((DWORD)thread_id);
    }
    debug_log(LOG_WARN, "[Mock] single_step_native: No debugger attached");
    return -1;
}

extern "C" bool is_in_break_state_native()
{
    if (g_debugger)
    {
        return g_debugger->is_in_break_state();
    }
    return false;
}

extern "C" int set_watchpoint_native(int pid, uint64_t address, int size, int type)
{
    if (g_debugger && g_debugger->get_pid() == pid)
    {
        return g_debugger->set_watchpoint(address, size, static_cast<WatchpointType>(type));
    }
    debug_log(LOG_WARN, "[Mock] set_watchpoint_native: Debugger not attached to pid %d", pid);
    return -1;
}

extern "C" int remove_watchpoint_native(int pid, uint64_t address)
{
    if (g_debugger && g_debugger->get_pid() == pid)
    {
        return g_debugger->remove_watchpoint(address);
    }
    debug_log(LOG_WARN, "[Mock] remove_watchpoint_native: Debugger not attached to pid %d", pid);
    return -1;
}

extern "C" int set_breakpoint_native(int pid, uint64_t address, int hit_count)
{
    if (g_debugger && g_debugger->get_pid() == pid)
    {
        return g_debugger->set_breakpoint(address, hit_count, false);
    }
    debug_log(LOG_WARN, "[Mock] set_breakpoint_native: Debugger not attached to pid %d", pid);
    return -1;
}

extern "C" int remove_breakpoint_native(int pid, uint64_t address)
{
    if (g_debugger && g_debugger->get_pid() == pid)
    {
        return g_debugger->remove_breakpoint(address);
    }
    debug_log(LOG_WARN, "[Mock] remove_breakpoint_native: Debugger not attached to pid %d", pid);
    return -1;
}

extern "C" int set_software_breakpoint_native(int pid, uint64_t address, int hit_count)
{
    if (g_debugger && g_debugger->get_pid() == pid)
    {
        return g_debugger->set_software_breakpoint(address, hit_count);
    }
    debug_log(LOG_WARN, "[Mock] set_software_breakpoint_native: Debugger not attached to pid %d",
              pid);
    return -1;
}

extern "C" int remove_software_breakpoint_native(int pid, uint64_t address)
{
    if (g_debugger && g_debugger->get_pid() == pid)
    {
        return g_debugger->remove_software_breakpoint(address);
    }
    debug_log(LOG_WARN,
              "[Mock] remove_software_breakpoint_native: Debugger not attached to pid %d", pid);
    return -1;
}

extern "C" bool get_software_breakpoint_original_bytes_native(uint64_t address, uint8_t* out_bytes,
                                                              size_t* out_size)
{
    if (g_debugger)
    {
        return g_debugger->get_software_breakpoint_original_bytes(address, out_bytes, out_size);
    }
    debug_log(LOG_WARN,
              "[Mock] get_software_breakpoint_original_bytes_native: No debugger attached");
    return false;
}

// ============================================================================
// Signal configuration (Mock - signals are Unix-specific)
// ============================================================================

extern "C" void set_signal_config_native(int signal, bool catch_signal, bool pass_signal)
{
    // Mock: Windows does not have Unix signals
    debug_log(LOG_DEBUG, "[Mock] set_signal_config_native: Signals not supported on Windows");
}

extern "C" void get_signal_config_native(int signal, bool* catch_signal, bool* pass_signal)
{
    // Mock: Windows does not have Unix signals
    if (catch_signal) *catch_signal = false;
    if (pass_signal) *pass_signal = false;
    debug_log(LOG_DEBUG, "[Mock] get_signal_config_native: Signals not supported on Windows");
}

extern "C" size_t get_all_signal_configs_native(int* signals, bool* catch_signals,
                                                bool* pass_signals, size_t max_count)
{
    // Mock: Windows does not have Unix signals
    debug_log(LOG_DEBUG, "[Mock] get_all_signal_configs_native: Signals not supported on Windows");
    return 0;
}

extern "C" void remove_signal_config_native(int signal)
{
    // Mock: Windows does not have Unix signals
    debug_log(LOG_DEBUG, "[Mock] remove_signal_config_native: Signals not supported on Windows");
}

// ============================================================================
// Debugger lifecycle
// ============================================================================

extern "C" bool debugger_new(int pid)
{
    if (g_debugger)
    {
        debug_log(LOG_WARN, "[Mock] Debugger already exists for pid %d", g_debugger->get_pid());
        // If same pid, return success
        if (g_debugger->get_pid() == pid)
        {
            return true;
        }
        // Different pid, clean up old debugger
        delete g_debugger;
        g_debugger = nullptr;
    }

    g_debugger = new Debugger(pid);
    if (!g_debugger->initialize())
    {
        delete g_debugger;
        g_debugger = nullptr;
        return false;
    }

    g_debugger->run();
    debug_log(LOG_INFO, "[Mock] Created debugger for pid %d", pid);
    return true;
}

extern "C" int attach_debugger_native(int pid)
{
    if (g_debugger)
    {
        debug_log(LOG_WARN, "[Mock] Debugger already attached to pid %d", g_debugger->get_pid());
        return -1;
    }

    g_debugger = new Debugger(pid);
    if (!g_debugger->initialize())
    {
        delete g_debugger;
        g_debugger = nullptr;
        return -1;
    }

    g_debugger->run();
    debug_log(LOG_INFO, "[Mock] Attached debugger to pid %d", pid);
    return 0;
}

extern "C" int detach_debugger_native(int pid)
{
    if (!g_debugger || g_debugger->get_pid() != pid)
    {
        debug_log(LOG_WARN, "[Mock] Debugger not attached to pid %d", pid);
        return -1;
    }

    g_debugger->stop();
    delete g_debugger;
    g_debugger = nullptr;
    debug_log(LOG_INFO, "[Mock] Detached debugger from pid %d", pid);
    return 0;
}

extern "C" bool is_debugger_attached_native(int pid)
{
    return g_debugger && g_debugger->get_pid() == pid && g_debugger->is_running();
}
