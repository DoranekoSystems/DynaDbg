#ifndef NATIVEAPI_H
#define NATIVEAPI_H

#include <mach/mach.h>
#include <mach/vm_map.h>
#include <mach/vm_region.h>
#include <sys/sysctl.h>

#include <string>
#include <vector>

enum LogLevel
{
    LOG_ERROR = 1,
    LOG_WARN = 2,
    LOG_INFO = 3,
    LOG_DEBUG = 4,
    LOG_TRACE = 5
};

enum ServerMode
{
    NORMAL,
    EMBEDDED,
};

// Exception types for debugger
enum ExceptionType
{
    EXCEPTION_UNKNOWN = 0,
    EXCEPTION_BREAKPOINT = 1,
    EXCEPTION_WATCHPOINT = 2,
    EXCEPTION_SINGLESTEP = 3,
};

typedef struct
{
    int pid;
    const char *processname;
} ProcessInfo;

typedef struct
{
    uintptr_t base;
    size_t size;
    bool is_64bit;
    char *modulename;
} ModuleInfo;

typedef struct
{
    uintptr_t address;
    char *name;
    size_t size;
    char *type;             // Function, Variable, etc.
    char *scope;            // Global, Local, etc.
    uintptr_t module_base;  // Base address of containing module
    char *file_name;        // Source file name (if available)
    int line_number;        // Line number (if available)
} SymbolInfo;

typedef struct
{
    uint64_t thread_id;  // Mach thread port / thread ID
    char *name;          // Thread name (if available)
    uint64_t pc;         // Program counter
    uint64_t sp;         // Stack pointer
    uint64_t fp;         // Frame pointer
    int state;           // Thread state (running, waiting, etc.)
    int suspend_count;   // Suspend count
} ThreadInfo;

typedef struct
{
    uintptr_t start;
    uintptr_t end;
    uint32_t protection;  // PROT_READ=1, PROT_WRITE=2, PROT_EXEC=4
    char *pathname;
} RegionInfo;

typedef struct
{
    int mode;
} ServerState;

extern ServerState global_server_state;

typedef int (*PROC_REGIONFILENAME)(int pid, uint64_t address, void *buffer, uint32_t buffersize);
extern PROC_REGIONFILENAME proc_regionfilename;
typedef int (*PROC_PIDPATH)(int pid, void *buffer, uint32_t buffersize);
extern PROC_PIDPATH proc_pidpath;

extern "C" kern_return_t mach_vm_read_overwrite(vm_map_t, mach_vm_address_t, mach_vm_size_t,
                                                mach_vm_address_t, mach_vm_size_t *);

extern "C" kern_return_t mach_vm_write(vm_map_t, mach_vm_address_t, vm_offset_t,
                                       mach_msg_type_number_t);

extern "C" kern_return_t mach_vm_protect(vm_map_t, mach_vm_address_t, mach_vm_size_t, boolean_t,
                                         vm_prot_t);

extern "C" kern_return_t mach_vm_region(vm_map_t, mach_vm_address_t *, mach_vm_size_t *,
                                        vm_region_flavor_t, vm_region_info_t,
                                        mach_msg_type_number_t *, mach_port_t *);

extern "C" int native_init(int mode);

extern "C" pid_t get_pid_native();

extern "C" ssize_t read_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                                      unsigned char *buffer);

extern "C" ssize_t read_memory_native_with_method(int pid, mach_vm_address_t address,
                                                  mach_vm_size_t size, unsigned char *buffer,
                                                  int mode);

extern "C" ssize_t write_memory_native(int pid, mach_vm_address_t address, mach_vm_size_t size,
                                       unsigned char *buffer);

extern "C" void enumerate_regions_to_buffer(pid_t pid, char *buffer, size_t buffer_size);
extern "C" void enumerate_regions_to_buffer_fast(pid_t pid, char *buffer, size_t buffer_size,
                                                 bool include_filenames);

extern "C" ProcessInfo *enumerate_processes(size_t *count);

extern "C" bool suspend_process(pid_t pid);

extern "C" bool resume_process(pid_t pid);

extern "C" ModuleInfo *enumerate_modules(pid_t pid, size_t *count);

extern "C" SymbolInfo *enumerate_symbols(int pid, uintptr_t module_base, size_t *count);

extern "C" ThreadInfo *enumerate_threads(pid_t pid, size_t *count);
extern "C" void free_thread_info(ThreadInfo *threads, size_t count);

extern "C" RegionInfo *enumerate_regions(pid_t pid, size_t *count);
extern "C" void free_region_info(RegionInfo *regions, size_t count);

int debug_log(LogLevel level, const char *format, ...);

// Development debug log function (compile-time option)
int _debug_log_develop_impl(const char *func, int line, LogLevel level, const char *format, ...);
#define debug_log_develop(level, format, ...) \
    _debug_log_develop_impl(__FUNCTION__, __LINE__, level, format, ##__VA_ARGS__)
#include "../../common/exception_info.h"

// Rust functions
extern "C" void native_log(int level, const char *message);
// Returns true if execution should auto-continue, false to enter break state
extern "C" bool send_exception_info(const NativeExceptionInfo *info, pid_t pid);
extern "C" void send_register_json(const char *register_json, pid_t pid);  // Backward compatibility
extern "C" char *disassemble(const uint8_t *bytecode, size_t length);
extern "C" char *disassemble_at_address(const uint8_t *bytecode, size_t length, uint64_t address);
extern "C" void free_string(char *s);

// MachOBridge functions (Swift)
extern "C" uint64_t macho_get_module_size_by_name(const char *name);
extern "C" uint64_t macho_get_module_size_by_address(uint64_t address);
extern "C" uint64_t macho_get_module_size_from_cache(const char *image_path);
extern "C" uint32_t macho_get_loaded_image_count();
extern "C" char *macho_get_loaded_image_path(uint32_t index);
extern "C" uint64_t macho_get_loaded_image_base(uint32_t index);
extern "C" uint64_t macho_get_loaded_image_size(uint32_t index);
extern "C" int64_t macho_get_loaded_image_slide(uint32_t index);
extern "C" void macho_free_string(char *s);

// Trace file output functions
extern "C" void enable_trace_file_output_native(const char *filepath);
extern "C" void disable_trace_file_output_native();
extern "C" bool is_trace_file_output_enabled_native();
extern "C" const char *get_trace_file_path_native();
extern "C" uint32_t get_trace_file_entry_count_native();

// Script trace control functions
extern "C" void request_script_trace_stop_native(bool notify_ui);
extern "C" void clear_script_trace_stop_request_native();
extern "C" bool is_script_trace_stop_requested_native();

#endif
