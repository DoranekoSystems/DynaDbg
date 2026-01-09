/**
 * @file debugger_internal.h
 * @brief Internal header for debugger implementation files (Darwin/macOS)
 *
 * This header provides common includes and declarations used across
 * the split debugger implementation files. Include this in all
 * debugger_*.mm files instead of individual headers.
 */

#ifndef DEBUGGER_INTERNAL_H
#define DEBUGGER_INTERNAL_H

#include <dlfcn.h>
#include <chrono>
#include <cstring>

#include "debugger.h"
#include "../../common/arm64_decoder.h"
#include "../../common/trace_file.h"
#include "../../common/exception_info.h"
#include "../../common/util.h"
#include "../core/native_api.h"

// =============================================================================
// Dynamic library build support
// =============================================================================

#ifdef DYNAMIC_LIB_BUILD
#define catch_exception_raise catch_exception_raise_dynamic
#define g_debugger g_debugger_dynamic
#endif

// =============================================================================
// Global declarations (defined in debugger_core.mm)
// =============================================================================

extern std::map<int, SignalConfig> g_signal_config;
extern std::mutex g_signal_config_mutex;

// =============================================================================
// Exception server declaration
// =============================================================================

extern "C"
{
    boolean_t exc_server(mach_msg_header_t* InHeadP, mach_msg_header_t* OutHeadP);
}

#endif  // DEBUGGER_INTERNAL_H
