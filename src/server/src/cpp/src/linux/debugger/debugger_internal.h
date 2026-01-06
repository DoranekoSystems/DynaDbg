/**
 * @file debugger_internal.h
 * @brief Internal header for debugger implementation files
 *
 * This header provides common includes and declarations used across
 * the split debugger implementation files. Include this in all
 * debugger_*.cpp files instead of individual headers.
 */

#ifndef DEBUGGER_INTERNAL_H
#define DEBUGGER_INTERNAL_H

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>

#include "debugger.h"
#ifndef TARGET_IS_ANDROID
#include <pty.h>
#endif
#include <signal.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#include <chrono>
#include <set>

#include "../../common/exception_info.h"
#include "../../common/util.h"
#include "../core/native_api.h"

// Helper macro to call send_exception_info
#define SEND_EXCEPTION_INFO(info_ptr, pid_val) send_exception_info(info_ptr, pid_val)

// =============================================================================
// Exception info population functions (defined in debugger_core.cpp)
// =============================================================================

#if defined(__aarch64__)
void populate_exception_info(NativeExceptionInfo& info, const struct user_pt_regs& regs,
                             ExceptionType exception_type, pid_t thread_id,
                             uint64_t memory_address = 0, uint64_t singlestep_mode = 0,
                             bool is_trace = false);
#elif defined(__x86_64__)
void populate_exception_info(NativeExceptionInfo& info, const struct user_regs_struct& regs,
                             ExceptionType exception_type, pid_t thread_id,
                             uint64_t memory_address = 0, uint64_t singlestep_mode = 0,
                             bool is_trace = false);
#endif

// =============================================================================
// Global declarations (defined in debugger_core.cpp)
// =============================================================================

extern std::map<int, SignalConfig> g_signal_config;
extern std::mutex g_signal_config_mutex;

// =============================================================================
// Memory helper functions (defined in debugger_core.cpp)
// =============================================================================

uint64_t read_memory_word(pid_t pid, uint64_t address);
int write_memory_word(pid_t pid, uint64_t address, uint64_t data);

// =============================================================================
// Thread helper functions (defined in debugger_thread.cpp)
// =============================================================================

bool is_thread_stopped(pid_t pid, pid_t tid);

#endif  // DEBUGGER_INTERNAL_H
