/**
 * @file native_api.cpp
 * @brief Native API implementations for Windows platform
 *
 * Implements process, module, thread, and symbol enumeration functions
 * using Windows APIs.
 *
 * Memory operations are in memory_io.cpp
 */

#include "native_api.h"

#include "../../common/dll_export.h"

// =============================================================================
// Logging Functions
// =============================================================================

NATIVE_API int debug_log(LogLevel level, const char* format, ...)
{
    va_list args;
    va_start(args, format);

    char tagged_format[256];
    _snprintf_s(tagged_format, sizeof(tagged_format), _TRUNCATE, "[NATIVE] %s", format);

    char buffer[1024];
    int result = _vsnprintf_s(buffer, sizeof(buffer), _TRUNCATE, tagged_format, args);

    if (result >= 0)
    {
        OutputDebugStringA(buffer);
        native_log(level, buffer);
    }

    va_end(args);
    return result;
}

// =============================================================================
// Process Functions
// =============================================================================

int get_pid_native()
{
    return GetCurrentProcessId();
}

ProcessInfo* enumerate_processes(size_t* count)
{
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot == INVALID_HANDLE_VALUE)
    {
        debug_log(LOG_ERROR, "Failed to create process snapshot. Error code: %lu", GetLastError());
        *count = 0;
        return nullptr;
    }

    PROCESSENTRY32W pe32;
    pe32.dwSize = sizeof(PROCESSENTRY32W);

    if (!Process32FirstW(hSnapshot, &pe32))
    {
        debug_log(LOG_ERROR, "Failed to get first process. Error code: %lu", GetLastError());
        CloseHandle(hSnapshot);
        *count = 0;
        return nullptr;
    }

    std::vector<ProcessInfo> processes;

    do
    {
        ProcessInfo info;
        info.pid = pe32.th32ProcessID;
        info.processname = new char[MAX_PATH];

        if (wcstombs(info.processname, pe32.szExeFile, MAX_PATH) == (size_t)-1)
        {
            debug_log(LOG_DEBUG, "Failed to convert process name for PID %lu", info.pid);
            strcpy(info.processname, "Unknown");
        }

        processes.push_back(info);
    } while (Process32NextW(hSnapshot, &pe32));

    CloseHandle(hSnapshot);

    ProcessInfo* retArray = new ProcessInfo[processes.size()];
    for (size_t i = 0; i < processes.size(); i++)
    {
        retArray[i] = processes[i];
    }

    *count = processes.size();
    return retArray;
}

bool suspend_process(int pid)
{
    HANDLE hThreadSnap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (hThreadSnap == INVALID_HANDLE_VALUE)
    {
        debug_log(LOG_ERROR, "Failed to create snapshot of threads for process %d. Error code: %lu",
                  pid, GetLastError());
        return false;
    }

    THREADENTRY32 te32;
    te32.dwSize = sizeof(THREADENTRY32);

    if (!Thread32First(hThreadSnap, &te32))
    {
        debug_log(LOG_ERROR, "Failed to get first thread for process %d. Error code: %lu", pid,
                  GetLastError());
        CloseHandle(hThreadSnap);
        return false;
    }

    bool suspended_any = false;
    do
    {
        if (te32.th32OwnerProcessID == pid)
        {
            HANDLE hThread = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te32.th32ThreadID);
            if (hThread == NULL)
            {
                debug_log(LOG_ERROR, "Failed to open thread %lu for process %d. Error code: %lu",
                          te32.th32ThreadID, pid, GetLastError());
                continue;
            }

            if (SuspendThread(hThread) == (DWORD)-1)
            {
                debug_log(LOG_ERROR, "Failed to suspend thread %lu for process %d. Error code: %lu",
                          te32.th32ThreadID, pid, GetLastError());
                CloseHandle(hThread);
                continue;
            }

            suspended_any = true;
            CloseHandle(hThread);
        }
    } while (Thread32Next(hThreadSnap, &te32));

    CloseHandle(hThreadSnap);

    if (suspended_any)
    {
        return true;
    }
    else
    {
        debug_log(LOG_ERROR, " No threads were suspended for process %d", pid);
        return false;
    }
}

bool resume_process(int pid)
{
    HANDLE hThreadSnap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (hThreadSnap == INVALID_HANDLE_VALUE)
    {
        debug_log(LOG_ERROR, "Failed to create snapshot of threads for process %d. Error code: %lu",
                  pid, GetLastError());
        return false;
    }

    THREADENTRY32 te32;
    te32.dwSize = sizeof(THREADENTRY32);

    if (!Thread32First(hThreadSnap, &te32))
    {
        debug_log(LOG_ERROR, "Failed to get first thread for process %d. Error code: %lu", pid,
                  GetLastError());
        CloseHandle(hThreadSnap);
        return false;
    }

    bool resumed_any = false;
    do
    {
        if (te32.th32OwnerProcessID == pid)
        {
            HANDLE hThread = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te32.th32ThreadID);
            if (hThread == NULL)
            {
                debug_log(LOG_ERROR, "Failed to open thread %lu for process %d. Error code: %lu",
                          te32.th32ThreadID, pid, GetLastError());
                continue;
            }

            if (ResumeThread(hThread) == (DWORD)-1)
            {
                debug_log(LOG_ERROR, "Failed to resume thread %lu for process %d. Error code: %lu",
                          te32.th32ThreadID, pid, GetLastError());
                CloseHandle(hThread);
                continue;
            }

            resumed_any = true;
            CloseHandle(hThread);
        }
    } while (Thread32Next(hThreadSnap, &te32));

    CloseHandle(hThreadSnap);

    if (resumed_any)
    {
        return true;
    }
    else
    {
        debug_log(LOG_ERROR, "No threads were resumed for process %d", pid);
        return false;
    }
}

// =============================================================================
// Module Functions
// =============================================================================

static bool IsPE64Bit(HANDLE hProcess, LPVOID baseAddress)
{
    IMAGE_DOS_HEADER dosHeader;
    IMAGE_NT_HEADERS ntHeaders;

    if (!ReadProcessMemory(hProcess, baseAddress, &dosHeader, sizeof(dosHeader), nullptr))
    {
        return false;
    }

    if (dosHeader.e_magic != IMAGE_DOS_SIGNATURE)
    {
        return false;
    }

    if (!ReadProcessMemory(hProcess, (LPVOID)((DWORD_PTR)baseAddress + dosHeader.e_lfanew),
                           &ntHeaders, sizeof(ntHeaders), nullptr))
    {
        return false;
    }

    if (ntHeaders.Signature != IMAGE_NT_SIGNATURE)
    {
        return false;
    }

    return ntHeaders.FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64;
}

ModuleInfo* enumerate_modules(DWORD pid, size_t* count)
{
    std::vector<ModuleInfo> modules;
    HANDLE hModuleSnap = INVALID_HANDLE_VALUE;
    MODULEENTRY32 me32;

    hModuleSnap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (hModuleSnap == INVALID_HANDLE_VALUE)
    {
        *count = 0;
        return nullptr;
    }

    me32.dwSize = sizeof(MODULEENTRY32);

    if (!Module32First(hModuleSnap, &me32))
    {
        CloseHandle(hModuleSnap);
        *count = 0;
        return nullptr;
    }

    HANDLE hProcess = OpenProcess(PROCESS_VM_READ, FALSE, pid);
    if (hProcess == NULL)
    {
        CloseHandle(hModuleSnap);
        *count = 0;
        return nullptr;
    }

    do
    {
        ModuleInfo info;
        info.base = reinterpret_cast<uintptr_t>(me32.modBaseAddr);
        info.size = me32.modBaseSize;

        info.is_64bit = IsPE64Bit(hProcess, me32.modBaseAddr);

        // Use szExePath (full path) instead of szModule (name only)
        size_t pathLength = strlen(me32.szExePath) + 1;
        info.modulename = new char[pathLength];
        strcpy_s(info.modulename, pathLength, me32.szExePath);

        modules.push_back(info);
    } while (Module32Next(hModuleSnap, &me32));

    CloseHandle(hProcess);
    CloseHandle(hModuleSnap);

    *count = modules.size();
    ModuleInfo* result = new ModuleInfo[*count];
    std::copy(modules.begin(), modules.end(), result);

    return result;
}

// =============================================================================
// Symbol Functions
// =============================================================================

SymbolInfo* enumerate_symbols(int pid, uintptr_t module_base, size_t* count)
{
    // Symbol enumeration using Windows Sym** API
    std::vector<SymbolInfo> symbols;
    *count = 0;

    HANDLE hProcess = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
    if (hProcess == NULL)
    {
        debug_log(LOG_ERROR, "Failed to open process %d for symbol enumeration. Error: %lu", pid,
                  GetLastError());
        return nullptr;
    }

    // Initialize symbol handler
    if (!SymInitialize(hProcess, NULL, FALSE))
    {
        debug_log(LOG_ERROR, "SymInitialize failed for process %d. Error: %lu", pid,
                  GetLastError());
        CloseHandle(hProcess);
        return nullptr;
    }

    // Set symbol options for better compatibility
    DWORD options = SymGetOptions();
    options |= SYMOPT_DEBUG | SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES |
               SYMOPT_INCLUDE_32BIT_MODULES;
    options &= ~SYMOPT_NO_PUBLICS;  // Make sure we can load public symbols
    SymSetOptions(options);

    // Get module information first
    char modulePath[MAX_PATH] = {0};
    char moduleName[MAX_PATH] = {0};
    DWORD moduleSize = 0;

    if (GetModuleFileNameExA(hProcess, (HMODULE)module_base, modulePath, MAX_PATH) > 0)
    {
        // Extract module name from path
        const char* lastSlash = strrchr(modulePath, '\\');
        if (lastSlash)
        {
            strcpy_s(moduleName, MAX_PATH, lastSlash + 1);
        }
        else
        {
            strcpy_s(moduleName, MAX_PATH, modulePath);
        }
    }

    // Get module size
    MODULEINFO modInfo;
    if (GetModuleInformation(hProcess, (HMODULE)module_base, &modInfo, sizeof(modInfo)))
    {
        moduleSize = modInfo.SizeOfImage;
    }

    // Load module symbols - try multiple approaches
    DWORD64 baseAddress = 0;

    // Method 1: Load with full path and name
    if (strlen(modulePath) > 0)
    {
        baseAddress =
            SymLoadModule64(hProcess, NULL, modulePath, moduleName, module_base, moduleSize);
        if (baseAddress != 0)
        {
            debug_log(LOG_DEBUG, "SymLoadModule64 succeeded with path for module %s", moduleName);
        }
    }

    // Method 2: Load without path if method 1 failed
    if (baseAddress == 0)
    {
        baseAddress = SymLoadModule64(hProcess, NULL, NULL, moduleName, module_base, moduleSize);
        if (baseAddress != 0)
        {
            debug_log(LOG_DEBUG, "SymLoadModule64 succeeded without path for module %s",
                      moduleName);
        }
    }

    // Method 3: Load with just base address if both failed
    if (baseAddress == 0)
    {
        baseAddress = SymLoadModule64(hProcess, NULL, NULL, NULL, module_base, moduleSize);
        if (baseAddress != 0)
        {
            debug_log(LOG_DEBUG, "SymLoadModule64 succeeded with base address only");
        }
    }

    if (baseAddress == 0)
    {
        DWORD error = GetLastError();
        debug_log(LOG_ERROR, "All SymLoadModule64 attempts failed for module at 0x%p. Error: %lu",
                  (void*)module_base, error);
        SymCleanup(hProcess);
        CloseHandle(hProcess);
        return nullptr;
    }

    // Structure for enumeration callback
    struct EnumContext
    {
        std::vector<SymbolInfo>* symbols;
        HANDLE hProcess;
    };

    EnumContext context = {&symbols, hProcess};

    // Callback function for symbol enumeration
    auto enumSymbolsCallback = [](PSYMBOL_INFO pSymInfo, ULONG SymbolSize,
                                  PVOID UserContext) -> BOOL
    {
        EnumContext* ctx = static_cast<EnumContext*>(UserContext);

        // Skip symbols without names or invalid addresses
        if (pSymInfo->NameLen == 0 || pSymInfo->Address == 0) return TRUE;

        SymbolInfo info;
        memset(&info, 0, sizeof(SymbolInfo));  // Initialize all fields to zero

        info.address = pSymInfo->Address;
        info.size = pSymInfo->Size;
        info.module_base = pSymInfo->ModBase;
        info.line_number = 0;  // Default value

        // Copy symbol name safely
        if (pSymInfo->NameLen > 0 && pSymInfo->Name)
        {
            size_t nameLength = pSymInfo->NameLen + 1;
            info.name = new (std::nothrow) char[nameLength];
            if (info.name)
            {
                strcpy_s(info.name, nameLength, pSymInfo->Name);
            }
            else
            {
                return TRUE;  // Skip this symbol if memory allocation failed
            }
        }
        else
        {
            return TRUE;  // Skip symbols without names
        }

        // Determine symbol type safely using numeric values (SymTag enums)
        const char* symbolType = "Other";
        switch (pSymInfo->Tag)
        {
            case 5:  // SymTagFunction
                symbolType = "Function";
                break;
            case 7:  // SymTagData
                symbolType = "Variable";
                break;
            case 10:  // SymTagPublicSymbol
                symbolType = "Public";
                break;
            case 16:  // SymTagThunk
                symbolType = "Thunk";
                break;
            case 17:  // SymTagLabel
                symbolType = "Label";
                break;
            default:
                // Use symbol flags to make better guesses
                if (pSymInfo->Flags & SYMFLAG_FUNCTION)
                {
                    symbolType = "Function";
                }
                else if (pSymInfo->Flags & SYMFLAG_PUBLIC_CODE)
                {
                    symbolType = "Public";
                }
                else
                {
                    symbolType = "Other";
                }
                break;
        }
        size_t typeLength = strlen(symbolType) + 1;
        info.type = new (std::nothrow) char[typeLength];
        if (info.type)
        {
            strcpy_s(info.type, typeLength, symbolType);
        }
        else
        {
            delete[] info.name;
            return TRUE;  // Skip if allocation failed
        }

        // Determine scope safely
        const char* scope = "Global";  // Default to Global
        if (pSymInfo->Flags & SYMFLAG_LOCAL)
        {
            scope = "Local";
        }
        else if (pSymInfo->Flags & SYMFLAG_PARAMETER)
        {
            scope = "Parameter";
        }
        else if (pSymInfo->Flags & SYMFLAG_EXPORT)
        {
            scope = "Export";
        }
        size_t scopeLength = strlen(scope) + 1;
        info.scope = new (std::nothrow) char[scopeLength];
        if (info.scope)
        {
            strcpy_s(info.scope, scopeLength, scope);
        }
        else
        {
            delete[] info.name;
            delete[] info.type;
            return TRUE;  // Skip if allocation failed
        }

        // Initialize file_name to empty string by default
        info.file_name = new (std::nothrow) char[1];
        if (info.file_name)
        {
            info.file_name[0] = '\0';
        }
        else
        {
            delete[] info.name;
            delete[] info.type;
            delete[] info.scope;
            return TRUE;  // Skip if allocation failed
        }

        // Try to get source file and line information (optional, may fail)
        try
        {
            DWORD displacement;
            IMAGEHLP_LINE64 line;
            line.SizeOfStruct = sizeof(IMAGEHLP_LINE64);

            if (SymGetLineFromAddr64(ctx->hProcess, pSymInfo->Address, &displacement, &line) &&
                line.FileName)
            {
                // Extract just filename from full path
                const char* fileName = strrchr(line.FileName, '\\');
                fileName = fileName ? fileName + 1 : line.FileName;

                if (strlen(fileName) > 0)
                {
                    delete[] info.file_name;  // Delete the empty string we allocated above

                    size_t fileNameLength = strlen(fileName) + 1;
                    info.file_name = new (std::nothrow) char[fileNameLength];
                    if (info.file_name)
                    {
                        strcpy_s(info.file_name, fileNameLength, fileName);
                        info.line_number = line.LineNumber;
                    }
                    else
                    {
                        // Fallback to empty string
                        info.file_name = new char[1];
                        info.file_name[0] = '\0';
                    }
                }
            }
        }
        catch (...)
        {
            // Ignore any exceptions from line info retrieval
            debug_log(LOG_DEBUG, "Exception while getting line info for symbol %s", pSymInfo->Name);
        }

        ctx->symbols->push_back(info);

        return TRUE;  // Continue enumeration
    };

    // Enumerate symbols
    if (!SymEnumSymbols(hProcess, baseAddress, "*", enumSymbolsCallback, &context))
    {
        DWORD error = GetLastError();
        debug_log(LOG_ERROR, "SymEnumSymbols failed for module at 0x%p. Error: %lu",
                  (void*)module_base, error);

        // Try different pattern
        if (!SymEnumSymbols(hProcess, baseAddress, NULL, enumSymbolsCallback, &context))
        {
            debug_log(LOG_ERROR, "SymEnumSymbols with NULL pattern also failed. Error: %lu",
                      GetLastError());
        }
    }

    // Cleanup
    SymUnloadModule64(hProcess, baseAddress);
    SymCleanup(hProcess);
    CloseHandle(hProcess);

    *count = symbols.size();
    if (*count == 0)
    {
        debug_log(LOG_INFO, "No symbols found for module at 0x%p", (void*)module_base);
        return nullptr;
    }

    SymbolInfo* result = new SymbolInfo[*count];
    std::copy(symbols.begin(), symbols.end(), result);

    debug_log(LOG_INFO, "Enumerated %zu symbols from module at 0x%p using Sym** API", *count,
              (void*)module_base);
    return result;
}

// =============================================================================
// Initialization
// =============================================================================

int native_init(int mode)
{
    return 1;
}

// =============================================================================
// Thread Functions
// =============================================================================

// Function pointer type for GetThreadDescription (Windows 10 1607+)
typedef HRESULT(WINAPI* GetThreadDescriptionFunc)(HANDLE hThread, PWSTR* ppszThreadDescription);

// Get thread description using GetThreadDescription API (Windows 10 1607+)
static bool GetThreadName(HANDLE hThread, char* nameBuf, size_t bufSize)
{
    static GetThreadDescriptionFunc pGetThreadDescription = nullptr;
    static bool initialized = false;

    if (!initialized)
    {
        HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
        if (hKernel32)
        {
            pGetThreadDescription =
                (GetThreadDescriptionFunc)GetProcAddress(hKernel32, "GetThreadDescription");
        }
        initialized = true;
    }

    if (pGetThreadDescription)
    {
        PWSTR pszThreadName = nullptr;
        HRESULT hr = pGetThreadDescription(hThread, &pszThreadName);
        if (SUCCEEDED(hr) && pszThreadName && pszThreadName[0] != L'\0')
        {
            // Convert wide string to narrow string
            int len = WideCharToMultiByte(CP_UTF8, 0, pszThreadName, -1, nameBuf, (int)bufSize,
                                          NULL, NULL);
            LocalFree(pszThreadName);
            if (len > 0)
            {
                return true;
            }
        }
        if (pszThreadName)
        {
            LocalFree(pszThreadName);
        }
    }

    return false;
}

ThreadInfo* enumerate_threads(int pid, size_t* count)
{
    *count = 0;

    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (hSnapshot == INVALID_HANDLE_VALUE)
    {
        debug_log(LOG_ERROR, "Failed to create thread snapshot. Error code: %lu", GetLastError());
        return nullptr;
    }

    std::vector<ThreadInfo> threads;

    THREADENTRY32 te32;
    te32.dwSize = sizeof(THREADENTRY32);

    if (!Thread32First(hSnapshot, &te32))
    {
        debug_log(LOG_ERROR, "Failed to get first thread. Error code: %lu", GetLastError());
        CloseHandle(hSnapshot);
        return nullptr;
    }

    do
    {
        if (te32.th32OwnerProcessID == (DWORD)pid)
        {
            ThreadInfo info = {0};
            info.thread_id = te32.th32ThreadID;
            info.state = 1;  // Default to running
            info.suspend_count = 0;

            // Try to get thread context for PC/SP/FP
            HANDLE hThread =
                OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION | THREAD_SUSPEND_RESUME,
                           FALSE, te32.th32ThreadID);
            if (hThread != NULL)
            {
                // Suspend thread temporarily to get context
                DWORD suspendCount = SuspendThread(hThread);
                if (suspendCount != (DWORD)-1)
                {
                    if (suspendCount > 0)
                    {
                        debug_log(LOG_INFO,
                                  "enumerate_threads: Thread %lu was already suspended (count=%lu)",
                                  te32.th32ThreadID, suspendCount);
                    }
                    info.suspend_count = suspendCount;

                    CONTEXT ctx;
                    ctx.ContextFlags = CONTEXT_FULL;
                    if (GetThreadContext(hThread, &ctx))
                    {
#ifdef _WIN64
                        info.pc = ctx.Rip;
                        info.sp = ctx.Rsp;
                        info.fp = ctx.Rbp;
#else
                        info.pc = ctx.Eip;
                        info.sp = ctx.Esp;
                        info.fp = ctx.Ebp;
#endif
                    }

                    // Resume thread
                    ResumeThread(hThread);
                }

                // Try to get thread description (Windows 10 1607+)
                char threadName[256];
                if (GetThreadName(hThread, threadName, sizeof(threadName)))
                {
                    info.name = new char[strlen(threadName) + 1];
                    strcpy(info.name, threadName);
                }
                else
                {
                    // Fallback to generic name
                    char nameBuf[64];
                    snprintf(nameBuf, sizeof(nameBuf), "Thread %lu", te32.th32ThreadID);
                    info.name = new char[strlen(nameBuf) + 1];
                    strcpy(info.name, nameBuf);
                }

                CloseHandle(hThread);
            }
            else
            {
                // Could not open thread, use generic name
                char nameBuf[64];
                snprintf(nameBuf, sizeof(nameBuf), "Thread %lu", te32.th32ThreadID);
                info.name = new char[strlen(nameBuf) + 1];
                strcpy(info.name, nameBuf);
            }

            threads.push_back(info);
        }
    } while (Thread32Next(hSnapshot, &te32));

    CloseHandle(hSnapshot);

    if (threads.empty())
    {
        return nullptr;
    }

    *count = threads.size();
    ThreadInfo* result = new ThreadInfo[*count];
    std::copy(threads.begin(), threads.end(), result);

    debug_log(LOG_INFO, "Successfully enumerated %zu threads for pid %d", *count, pid);
    return result;
}

void free_thread_info(ThreadInfo* threads, size_t count)
{
    if (threads)
    {
        for (size_t i = 0; i < count; i++)
        {
            if (threads[i].name)
            {
                delete[] threads[i].name;
            }
        }
        delete[] threads;
    }
}

// =============================================================================
// Debugger Control Stub Implementations
// Note: continue_execution_native, single_step_native, is_in_break_state_native
// are implemented in debugger/debugger.cpp
// =============================================================================

int read_register_native(uintptr_t thread_id, const char* reg_name, uint64_t* value)
{
    // Stub implementation - not yet implemented for Windows
    debug_log(LOG_WARN,
              "read_register_native not implemented for Windows (thread_id: %llu, reg: %s)",
              (unsigned long long)thread_id, reg_name ? reg_name : "null");
    if (value) *value = 0;
    return -1;  // Return error
}

int write_register_native(uintptr_t thread_id, const char* reg_name, uint64_t value)
{
    // Stub implementation - not yet implemented for Windows
    debug_log(
        LOG_WARN,
        "write_register_native not implemented for Windows (thread_id: %llu, reg: %s, value: %llu)",
        (unsigned long long)thread_id, reg_name ? reg_name : "null", (unsigned long long)value);
    return -1;  // Return error
}

// =============================================================================
// Process Icon
// =============================================================================

const unsigned char* get_process_icon_native(int pid, size_t* size)
{
    *size = 0;

    // Get process handle
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!hProcess)
    {
        debug_log(LOG_ERROR, "Failed to open process %d for icon extraction. Error: %lu", pid,
                  GetLastError());
        return nullptr;
    }

    // Get process executable path
    WCHAR szProcessPath[MAX_PATH];
    DWORD dwSize = MAX_PATH;
    if (!QueryFullProcessImageNameW(hProcess, 0, szProcessPath, &dwSize))
    {
        debug_log(LOG_ERROR, "Failed to get process path for PID %d. Error: %lu", pid,
                  GetLastError());
        CloseHandle(hProcess);
        return nullptr;
    }
    CloseHandle(hProcess);

    // Extract icon from executable
    HICON hIcon = ExtractIconW(GetModuleHandle(nullptr), szProcessPath, 0);
    if (!hIcon || hIcon == (HICON)1)
    {
        debug_log(LOG_DEBUG, "No icon found for process %d", pid);
        return nullptr;
    }

    // Get icon info
    ICONINFO iconInfo;
    if (!GetIconInfo(hIcon, &iconInfo))
    {
        debug_log(LOG_ERROR, "Failed to get icon info for PID %d. Error: %lu", pid, GetLastError());
        DestroyIcon(hIcon);
        return nullptr;
    }

    // Create memory DC and select bitmap
    HDC hdc = GetDC(nullptr);
    HDC memDC = CreateCompatibleDC(hdc);

    // Get bitmap info
    BITMAP bmp;
    GetObject(iconInfo.hbmColor, sizeof(BITMAP), &bmp);

    // Create DIB section for PNG conversion
    BITMAPINFOHEADER bi = {0};
    bi.biSize = sizeof(BITMAPINFOHEADER);
    bi.biWidth = bmp.bmWidth;
    bi.biHeight = -bmp.bmHeight;  // Top-down DIB
    bi.biPlanes = 1;
    bi.biBitCount = 32;
    bi.biCompression = BI_RGB;

    void* pBits;
    HBITMAP hDIB = CreateDIBSection(memDC, (BITMAPINFO*)&bi, DIB_RGB_COLORS, &pBits, nullptr, 0);
    if (!hDIB)
    {
        debug_log(LOG_ERROR, "Failed to create DIB section for PID %d", pid);
        DeleteDC(memDC);
        ReleaseDC(nullptr, hdc);
        DeleteObject(iconInfo.hbmColor);
        DeleteObject(iconInfo.hbmMask);
        DestroyIcon(hIcon);
        return nullptr;
    }

    // Select DIB and draw icon
    HBITMAP oldBmp = (HBITMAP)SelectObject(memDC, hDIB);
    DrawIconEx(memDC, 0, 0, hIcon, bmp.bmWidth, bmp.bmHeight, 0, nullptr, DI_NORMAL);

    // Create a simple PNG-like header (for simplicity, we'll return raw RGBA data)
    // In a real implementation, you'd want to use a proper PNG encoder
    int imageSize = bmp.bmWidth * bmp.bmHeight * 4;
    unsigned char* iconData = new unsigned char[imageSize];

    // Copy bitmap data
    memcpy(iconData, pBits, imageSize);

    // Convert BGRA to RGBA
    for (int i = 0; i < imageSize; i += 4)
    {
        std::swap(iconData[i], iconData[i + 2]);  // Swap B and R
    }

    *size = imageSize;

    // Cleanup
    SelectObject(memDC, oldBmp);
    DeleteObject(hDIB);
    DeleteDC(memDC);
    ReleaseDC(nullptr, hdc);
    DeleteObject(iconInfo.hbmColor);
    DeleteObject(iconInfo.hbmMask);
    DestroyIcon(hIcon);

    debug_log(LOG_DEBUG, "Successfully extracted icon for PID %d, size: %zu bytes", pid, *size);
    return iconData;
}

// =============================================================================
// Trace File Output Functions (Stub implementations for Windows)
// These are implemented in Darwin but need stubs for Windows builds
// =============================================================================

extern "C" void enable_trace_file_output_native(const char* filepath)
{
    (void)filepath;
    debug_log(LOG_WARN, "enable_trace_file_output_native: Not implemented for this platform");
}

extern "C" void disable_trace_file_output_native()
{
    debug_log(LOG_WARN, "disable_trace_file_output_native: Not implemented for this platform");
}

extern "C" bool is_trace_file_output_enabled_native()
{
    debug_log(LOG_WARN, "is_trace_file_output_enabled_native: Not implemented for this platform");
    return false;
}

extern "C" const char* get_trace_file_path_native()
{
    debug_log(LOG_WARN, "get_trace_file_path_native: Not implemented for this platform");
    return "";
}

extern "C" uint32_t get_trace_file_entry_count_native()
{
    debug_log(LOG_WARN, "get_trace_file_entry_count_native: Not implemented for this platform");
    return 0;
}

extern "C" bool is_trace_ended_by_end_address_native()
{
    debug_log(LOG_WARN, "is_trace_ended_by_end_address_native: Not implemented for this platform");
    return false;
}

extern "C" void enable_full_memory_cache_native(const char* dump_filepath, const char* log_filepath)
{
    (void)dump_filepath;
    (void)log_filepath;
    debug_log(LOG_WARN, "enable_full_memory_cache_native: Not implemented for this platform");
}

extern "C" void disable_full_memory_cache_native()
{
    debug_log(LOG_WARN, "disable_full_memory_cache_native: Not implemented for this platform");
}

// =============================================================================
// Region Enumeration Helper Functions
// =============================================================================

static void setMemoryProtection(DWORD protect, DWORD type, char* permissions)
{
    permissions[0] = '-';
    permissions[1] = '-';
    permissions[2] = '-';
    permissions[3] = '-';

    switch (protect & 0xFF)
    {
        case PAGE_EXECUTE:
            permissions[2] = 'x';
            break;
        case PAGE_EXECUTE_READ:
            permissions[0] = 'r';
            permissions[2] = 'x';
            break;
        case PAGE_EXECUTE_READWRITE:
        case PAGE_EXECUTE_WRITECOPY:
            permissions[0] = 'r';
            permissions[1] = 'w';
            permissions[2] = 'x';
            break;
        case PAGE_NOACCESS:
            break;
        case PAGE_READONLY:
            permissions[0] = 'r';
            break;
        case PAGE_READWRITE:
        case PAGE_WRITECOPY:
            permissions[0] = 'r';
            permissions[1] = 'w';
            break;
    }

    if (type & MEM_PRIVATE || type & MEM_IMAGE)
    {
        permissions[3] = 'p';  // private
    }
    else if (type & MEM_MAPPED)
    {
        permissions[3] = 's';  // shared
    }
    else
    {
        permissions[3] = '-';
    }
}

// Convert device path (e.g., \Device\HarddiskVolume3\...) to drive letter path (e.g., C:\...)
static bool ConvertDevicePathToDriveLetter(const char* devicePath, char* drivePath,
                                           size_t drivePathSize)
{
    char drives[512];
    if (GetLogicalDriveStringsA(sizeof(drives) - 1, drives) == 0)
    {
        return false;
    }

    for (const char* drive = drives; *drive; drive += strlen(drive) + 1)
    {
        char driveLetter[3] = {drive[0], ':', '\0'};
        char deviceName[MAX_PATH];

        if (QueryDosDeviceA(driveLetter, deviceName, sizeof(deviceName)) > 0)
        {
            size_t deviceNameLen = strlen(deviceName);
            if (_strnicmp(devicePath, deviceName, deviceNameLen) == 0 &&
                devicePath[deviceNameLen] == '\\')
            {
                snprintf(drivePath, drivePathSize, "%s%s", driveLetter, devicePath + deviceNameLen);
                return true;
            }
        }
    }
    return false;
}

// Parse protection bits from Windows memory protection
static uint32_t parse_protection_bits(DWORD protect)
{
    uint32_t prot = 0;
    switch (protect & 0xFF)
    {
        case PAGE_READONLY:
            prot = 1;  // PROT_READ
            break;
        case PAGE_READWRITE:
        case PAGE_WRITECOPY:
            prot = 1 | 2;  // PROT_READ | PROT_WRITE
            break;
        case PAGE_EXECUTE:
            prot = 4;  // PROT_EXEC
            break;
        case PAGE_EXECUTE_READ:
            prot = 1 | 4;  // PROT_READ | PROT_EXEC
            break;
        case PAGE_EXECUTE_READWRITE:
        case PAGE_EXECUTE_WRITECOPY:
            prot = 1 | 2 | 4;  // PROT_READ | PROT_WRITE | PROT_EXEC
            break;
        default:
            prot = 0;
            break;
    }
    return prot;
}

// =============================================================================
// Region Enumeration Functions
// =============================================================================

void enumerate_regions_to_buffer(DWORD pid, char* buffer, size_t buffer_size,
                                 bool include_filenames)
{
    HANDLE processHandle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (processHandle == NULL)
    {
        debug_log(LOG_ERROR, "Failed to open process %lu. Error code: %lu", pid, GetLastError());
        snprintf(buffer, buffer_size, "Failed to open process\n");
        return;
    }

    MEMORY_BASIC_INFORMATION memInfo;
    unsigned char* addr = 0;
    size_t offset = 0;

    while (VirtualQueryEx(processHandle, addr, &memInfo, sizeof(memInfo)))
    {
        char permissions[5] = "----";
        if (memInfo.State == MEM_COMMIT)
        {
            setMemoryProtection(memInfo.Protect, memInfo.Type, permissions);
        }

        char mappedFileName[MAX_PATH] = {0};
        // Get file path for both MEM_MAPPED and MEM_IMAGE (DLLs/EXEs)
        if (include_filenames && (memInfo.Type == MEM_MAPPED || memInfo.Type == MEM_IMAGE))
        {
            char devicePath[MAX_PATH] = {0};
            if (GetMappedFileNameA(processHandle, addr, devicePath, sizeof(devicePath)))
            {
                // Convert device path to drive letter path
                if (!ConvertDevicePathToDriveLetter(devicePath, mappedFileName,
                                                    sizeof(mappedFileName)))
                {
                    // Fallback to device path if conversion fails
                    strncpy(mappedFileName, devicePath, sizeof(mappedFileName) - 1);
                }
            }
            // Silently ignore failures
        }

        char start_address[17], end_address[17];
        snprintf(start_address, sizeof(start_address), "%p", addr);
        snprintf(end_address, sizeof(end_address), "%p",
                 (unsigned char*)addr + memInfo.RegionSize - 1);

        int written = snprintf(buffer + offset, buffer_size - offset, "%s-%s %s %s _ _ %s\n",
                               start_address, end_address, permissions,
                               memInfo.State == MEM_COMMIT    ? "committed"
                               : memInfo.State == MEM_RESERVE ? "reserved"
                                                              : "free",
                               mappedFileName);

        if (written <= 0 || written >= buffer_size - offset)
        {
            debug_log(LOG_ERROR, "Buffer full or write error. Stopping enumeration.");
            break;
        }

        offset += written;
        addr = (unsigned char*)memInfo.BaseAddress + memInfo.RegionSize;
    }
    CloseHandle(processHandle);
}

RegionInfo* enumerate_regions(DWORD pid, size_t* count, bool include_filenames)
{
    *count = 0;

    HANDLE processHandle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (processHandle == NULL)
    {
        debug_log(LOG_ERROR, "Failed to open process %lu. Error code: %lu", pid, GetLastError());
        return nullptr;
    }

    std::vector<RegionInfo> regions;
    MEMORY_BASIC_INFORMATION memInfo;
    unsigned char* addr = 0;

    while (VirtualQueryEx(processHandle, addr, &memInfo, sizeof(memInfo)))
    {
        if (memInfo.State == MEM_COMMIT)
        {
            RegionInfo region;
            region.start = reinterpret_cast<uintptr_t>(memInfo.BaseAddress);
            region.end = reinterpret_cast<uintptr_t>(memInfo.BaseAddress) + memInfo.RegionSize;
            region.protection = parse_protection_bits(memInfo.Protect);
            region.pathname = nullptr;

            // Get file path for both MEM_MAPPED and MEM_IMAGE (DLLs/EXEs)
            if (include_filenames && (memInfo.Type == MEM_MAPPED || memInfo.Type == MEM_IMAGE))
            {
                char devicePath[MAX_PATH] = {0};
                char mappedFileName[MAX_PATH] = {0};
                if (GetMappedFileNameA(processHandle, addr, devicePath, sizeof(devicePath)))
                {
                    if (ConvertDevicePathToDriveLetter(devicePath, mappedFileName,
                                                       sizeof(mappedFileName)))
                    {
                        region.pathname = _strdup(mappedFileName);
                    }
                    else
                    {
                        region.pathname = _strdup(devicePath);
                    }
                }
            }

            regions.push_back(region);
        }

        addr = (unsigned char*)memInfo.BaseAddress + memInfo.RegionSize;
    }

    CloseHandle(processHandle);

    if (regions.empty())
    {
        return nullptr;
    }

    RegionInfo* result = static_cast<RegionInfo*>(malloc(regions.size() * sizeof(RegionInfo)));
    if (!result)
    {
        // Free pathnames on allocation failure
        for (auto& r : regions)
        {
            if (r.pathname) free(r.pathname);
        }
        return nullptr;
    }

    memcpy(result, regions.data(), regions.size() * sizeof(RegionInfo));
    *count = regions.size();
    return result;
}

void free_region_info(RegionInfo* regions, size_t count)
{
    if (!regions) return;
    for (size_t i = 0; i < count; i++)
    {
        if (regions[i].pathname)
        {
            free(regions[i].pathname);
        }
    }
    free(regions);
}
