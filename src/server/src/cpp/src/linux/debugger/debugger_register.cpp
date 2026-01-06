/**
 * @file debugger_register.cpp
 * @brief Register read/write and debug state Debugger class member functions
 *
 * This file contains the implementation of register access and debug state
 * management for the Linux debugger. It includes extensive register mapping
 * for both ARM64 and x86_64 architectures.
 *
 * Functions included:
 *   - read_register: Public API for reading a register value
 *   - read_register_internal: Internal implementation of register read
 *   - write_register: Public API for writing a register value
 *   - write_register_internal: Internal implementation of register write
 *   - resume_all_user_stopped_threads: Public API to resume user-stopped threads
 *   - resume_all_user_stopped_threads_internal: Internal implementation of resume
 */

#include "debugger_internal.h"

// =============================================================================
// Register Read Operations
// =============================================================================

int Debugger::read_register(pid_t thread_id, const std::string& reg_name, uint64_t* value)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::ReadRegister);
    request->thread_id = thread_id;
    request->reg_name = reg_name;
    request->reg_value_ptr = value;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::read_register_internal(pid_t thread_id, const std::string& reg_name, uint64_t* value)
{
    if (!value || attached_threads_.count(thread_id) == 0)
    {
        debug_log(LOG_ERROR,
                  "read_register_internal: invalid params - value=%p, thread_id=%d, attached=%d",
                  value, thread_id, attached_threads_.count(thread_id));
        return -1;
    }

    debug_log(LOG_DEBUG, "read_register_internal: thread_id=%d, reg_name=%s", thread_id,
              reg_name.c_str());

#if defined(__aarch64__)
    struct iovec iov;
    struct user_pt_regs regs;
    iov.iov_base = &regs;
    iov.iov_len = sizeof(regs);
    if (PTRACE_CALL(DYNA_PTRACE_GETREGSET, thread_id, NT_PRSTATUS, &iov) == -1)
#elif defined(__x86_64__)
    struct user_regs_struct regs;
    if (PTRACE_CALL(PTRACE_GETREGS, thread_id, nullptr, &regs) == -1)
#endif
    {
        debug_log(LOG_ERROR, "Failed to get registers for thread %d: %s", thread_id,
                  strerror(errno));
        return -1;
    }

#if defined(__aarch64__)
    // ARM64 register mapping
    if (reg_name == "x0")
        *value = regs.regs[0];
    else if (reg_name == "x1")
        *value = regs.regs[1];
    else if (reg_name == "x2")
        *value = regs.regs[2];
    else if (reg_name == "x3")
        *value = regs.regs[3];
    else if (reg_name == "x4")
        *value = regs.regs[4];
    else if (reg_name == "x5")
        *value = regs.regs[5];
    else if (reg_name == "x6")
        *value = regs.regs[6];
    else if (reg_name == "x7")
        *value = regs.regs[7];
    else if (reg_name == "x8")
        *value = regs.regs[8];
    else if (reg_name == "x9")
        *value = regs.regs[9];
    else if (reg_name == "x10")
        *value = regs.regs[10];
    else if (reg_name == "x11")
        *value = regs.regs[11];
    else if (reg_name == "x12")
        *value = regs.regs[12];
    else if (reg_name == "x13")
        *value = regs.regs[13];
    else if (reg_name == "x14")
        *value = regs.regs[14];
    else if (reg_name == "x15")
        *value = regs.regs[15];
    else if (reg_name == "x16")
        *value = regs.regs[16];
    else if (reg_name == "x17")
        *value = regs.regs[17];
    else if (reg_name == "x18")
        *value = regs.regs[18];
    else if (reg_name == "x19")
        *value = regs.regs[19];
    else if (reg_name == "x20")
        *value = regs.regs[20];
    else if (reg_name == "x21")
        *value = regs.regs[21];
    else if (reg_name == "x22")
        *value = regs.regs[22];
    else if (reg_name == "x23")
        *value = regs.regs[23];
    else if (reg_name == "x24")
        *value = regs.regs[24];
    else if (reg_name == "x25")
        *value = regs.regs[25];
    else if (reg_name == "x26")
        *value = regs.regs[26];
    else if (reg_name == "x27")
        *value = regs.regs[27];
    else if (reg_name == "x28")
        *value = regs.regs[28];
    else if (reg_name == "x29")
        *value = regs.regs[29];
    else if (reg_name == "x30")
        *value = regs.regs[30];
    else if (reg_name == "sp")
        *value = regs.sp;
    else if (reg_name == "pc")
        *value = regs.pc;
    else if (reg_name == "pstate")
        *value = regs.pstate;
    else
    {
        debug_log(LOG_ERROR, "Unknown register: %s", reg_name.c_str());
        return -1;
    }
#elif defined(__x86_64__)
    // x86_64 register mapping
    if (reg_name == "rax")
        *value = regs.rax;
    else if (reg_name == "rbx")
        *value = regs.rbx;
    else if (reg_name == "rcx")
        *value = regs.rcx;
    else if (reg_name == "rdx")
        *value = regs.rdx;
    else if (reg_name == "rsi")
        *value = regs.rsi;
    else if (reg_name == "rdi")
        *value = regs.rdi;
    else if (reg_name == "rbp")
        *value = regs.rbp;
    else if (reg_name == "rsp")
        *value = regs.rsp;
    else if (reg_name == "r8")
        *value = regs.r8;
    else if (reg_name == "r9")
        *value = regs.r9;
    else if (reg_name == "r10")
        *value = regs.r10;
    else if (reg_name == "r11")
        *value = regs.r11;
    else if (reg_name == "r12")
        *value = regs.r12;
    else if (reg_name == "r13")
        *value = regs.r13;
    else if (reg_name == "r14")
        *value = regs.r14;
    else if (reg_name == "r15")
        *value = regs.r15;
    else if (reg_name == "rip")
        *value = regs.rip;
    else if (reg_name == "rflags" || reg_name == "eflags")
        *value = regs.eflags;
    else if (reg_name == "cs")
        *value = regs.cs;
    else if (reg_name == "ss")
        *value = regs.ss;
    else if (reg_name == "ds")
        *value = regs.ds;
    else if (reg_name == "es")
        *value = regs.es;
    else if (reg_name == "fs")
        *value = regs.fs;
    else if (reg_name == "gs")
        *value = regs.gs;
    else if (reg_name == "fs_base")
        *value = regs.fs_base;
    else if (reg_name == "gs_base")
        *value = regs.gs_base;
    else
    {
        debug_log(LOG_ERROR, "Unknown register: %s", reg_name.c_str());
        return -1;
    }
#endif

    return 0;
}

// =============================================================================
// Register Write Operations
// =============================================================================

int Debugger::write_register(pid_t thread_id, const std::string& reg_name, uint64_t value)
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::WriteRegister);
    request->thread_id = thread_id;
    request->reg_name = reg_name;
    request->reg_value = value;

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::write_register_internal(pid_t thread_id, const std::string& reg_name, uint64_t value)
{
    if (attached_threads_.count(thread_id) == 0)
    {
        return -1;
    }

#if defined(__aarch64__)
    struct iovec iov;
    struct user_pt_regs regs;
    iov.iov_base = &regs;
    iov.iov_len = sizeof(regs);
    if (PTRACE_CALL(DYNA_PTRACE_GETREGSET, thread_id, NT_PRSTATUS, &iov) == -1)
#elif defined(__x86_64__)
    struct user_regs_struct regs;
    if (PTRACE_CALL(PTRACE_GETREGS, thread_id, nullptr, &regs) == -1)
#endif
    {
        debug_log(LOG_ERROR, "Failed to get registers for thread %d", thread_id);
        return -1;
    }

#if defined(__aarch64__)
    // ARM64 register mapping
    if (reg_name == "x0")
        regs.regs[0] = value;
    else if (reg_name == "x1")
        regs.regs[1] = value;
    else if (reg_name == "x2")
        regs.regs[2] = value;
    else if (reg_name == "x3")
        regs.regs[3] = value;
    else if (reg_name == "x4")
        regs.regs[4] = value;
    else if (reg_name == "x5")
        regs.regs[5] = value;
    else if (reg_name == "x6")
        regs.regs[6] = value;
    else if (reg_name == "x7")
        regs.regs[7] = value;
    else if (reg_name == "x8")
        regs.regs[8] = value;
    else if (reg_name == "x9")
        regs.regs[9] = value;
    else if (reg_name == "x10")
        regs.regs[10] = value;
    else if (reg_name == "x11")
        regs.regs[11] = value;
    else if (reg_name == "x12")
        regs.regs[12] = value;
    else if (reg_name == "x13")
        regs.regs[13] = value;
    else if (reg_name == "x14")
        regs.regs[14] = value;
    else if (reg_name == "x15")
        regs.regs[15] = value;
    else if (reg_name == "x16")
        regs.regs[16] = value;
    else if (reg_name == "x17")
        regs.regs[17] = value;
    else if (reg_name == "x18")
        regs.regs[18] = value;
    else if (reg_name == "x19")
        regs.regs[19] = value;
    else if (reg_name == "x20")
        regs.regs[20] = value;
    else if (reg_name == "x21")
        regs.regs[21] = value;
    else if (reg_name == "x22")
        regs.regs[22] = value;
    else if (reg_name == "x23")
        regs.regs[23] = value;
    else if (reg_name == "x24")
        regs.regs[24] = value;
    else if (reg_name == "x25")
        regs.regs[25] = value;
    else if (reg_name == "x26")
        regs.regs[26] = value;
    else if (reg_name == "x27")
        regs.regs[27] = value;
    else if (reg_name == "x28")
        regs.regs[28] = value;
    else if (reg_name == "x29")
        regs.regs[29] = value;
    else if (reg_name == "x30")
        regs.regs[30] = value;
    else if (reg_name == "sp")
        regs.sp = value;
    else if (reg_name == "pc")
        regs.pc = value;
    else if (reg_name == "pstate")
        regs.pstate = value;
    else
    {
        debug_log(LOG_ERROR, "Unknown register: %s", reg_name.c_str());
        return -1;
    }
#elif defined(__x86_64__)
    // x86_64 register mapping
    if (reg_name == "rax")
        regs.rax = value;
    else if (reg_name == "rbx")
        regs.rbx = value;
    else if (reg_name == "rcx")
        regs.rcx = value;
    else if (reg_name == "rdx")
        regs.rdx = value;
    else if (reg_name == "rsi")
        regs.rsi = value;
    else if (reg_name == "rdi")
        regs.rdi = value;
    else if (reg_name == "rbp")
        regs.rbp = value;
    else if (reg_name == "rsp")
        regs.rsp = value;
    else if (reg_name == "r8")
        regs.r8 = value;
    else if (reg_name == "r9")
        regs.r9 = value;
    else if (reg_name == "r10")
        regs.r10 = value;
    else if (reg_name == "r11")
        regs.r11 = value;
    else if (reg_name == "r12")
        regs.r12 = value;
    else if (reg_name == "r13")
        regs.r13 = value;
    else if (reg_name == "r14")
        regs.r14 = value;
    else if (reg_name == "r15")
        regs.r15 = value;
    else if (reg_name == "rip")
        regs.rip = value;
    else if (reg_name == "rflags" || reg_name == "eflags")
        regs.eflags = value;
    else if (reg_name == "cs")
        regs.cs = value;
    else if (reg_name == "ss")
        regs.ss = value;
    else if (reg_name == "ds")
        regs.ds = value;
    else if (reg_name == "es")
        regs.es = value;
    else if (reg_name == "fs")
        regs.fs = value;
    else if (reg_name == "gs")
        regs.gs = value;
    else if (reg_name == "fs_base")
        regs.fs_base = value;
    else if (reg_name == "gs_base")
        regs.gs_base = value;
    else
    {
        debug_log(LOG_ERROR, "Unknown register: %s", reg_name.c_str());
        return -1;
    }
#endif

#if defined(__aarch64__)
    if (PTRACE_CALL(DYNA_PTRACE_SETREGSET, thread_id, NT_PRSTATUS, &iov) == -1)
#elif defined(__x86_64__)
    if (PTRACE_CALL(PTRACE_SETREGS, thread_id, nullptr, &regs) == -1)
#endif
    {
        debug_log(LOG_ERROR, "Failed to set registers for thread %d", thread_id);
        return -1;
    }

    return 0;
}

// =============================================================================
// Thread Resume Operations
// =============================================================================

int Debugger::resume_all_user_stopped_threads()
{
    // Create request and enqueue it to the debug thread
    auto request = std::make_shared<DebugRequest>(DebugCommand::ResumeUserStoppedThreads);

    enqueue_command(request);

    // Wait for the result
    std::unique_lock<std::mutex> lock(request->result_mutex);
    request->result_cv.wait(lock, [request] { return request->completed; });

    return request->result;
}

int Debugger::resume_all_user_stopped_threads_internal()
{
    std::lock_guard<std::mutex> lock(thread_states_mutex_);
    int resumed_count = 0;

    for (auto& [tid, state] : thread_states_)
    {
        if (state.stopped_by_user)
        {
            debug_log(LOG_INFO, "Resuming user-stopped thread %d", tid);

            // Resume the thread with PTRACE_CONT (must be called from debugger thread)
            if (PTRACE_CALL(PTRACE_CONT, tid, nullptr, nullptr) == -1)
            {
                debug_log(LOG_ERROR, "Failed to PTRACE_CONT thread %d: %s", tid, strerror(errno));
                // Continue trying other threads
            }
            else
            {
                state.stopped_by_user = false;
                state.is_stopped = false;
                resumed_count++;
            }
        }
    }

    debug_log(LOG_INFO, "Resumed %d user-stopped threads via PTRACE_CONT", resumed_count);
    return resumed_count;
}
