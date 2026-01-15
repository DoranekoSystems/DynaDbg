/**
 * @file memory_io.cpp
 * @brief Memory read/write operations for process memory access (Windows)
 */

#include "memory_io.h"

#include "native_api.h"

// =============================================================================
// Memory Read/Write Functions
// =============================================================================

SSIZE_T read_memory_native(int pid, uintptr_t address, size_t size, unsigned char* buffer)
{
    return read_memory_native_with_method(pid, address, size, buffer, 0);
}

SSIZE_T read_memory_native_with_method(int pid, uintptr_t address, size_t size,
                                       unsigned char* buffer, int mode)
{
    // Windows does not use mode parameter, always uses ReadProcessMemory
    HANDLE processHandle = OpenProcess(PROCESS_VM_READ, FALSE, pid);
    if (processHandle == NULL)
    {
        debug_log(LOG_ERROR, "Failed to open process %d for reading. Error code: %lu", pid,
                  GetLastError());
        return -1;
    }

    SIZE_T bytesRead;
    if (ReadProcessMemory(processHandle, (LPCVOID)address, buffer, size, &bytesRead))
    {
        CloseHandle(processHandle);
        return (SSIZE_T)bytesRead;
    }
    else
    {
        DWORD error = GetLastError();
        CloseHandle(processHandle);
        debug_log(LOG_DEBUG,
                  "Failed to read memory from process %d at address 0x%p. Error code: %lu", pid,
                  (void*)address, error);
        return -1;
    }
}

SSIZE_T write_memory_native(int pid, void* address, size_t size, unsigned char* buffer)
{
    HANDLE processHandle = OpenProcess(
        PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION, FALSE, pid);
    if (processHandle == NULL)
    {
        debug_log(LOG_ERROR, "Failed to open process %d for writing. Error code: %lu", pid,
                  GetLastError());
        return -1;
    }

    DWORD oldProtect;
    if (!VirtualProtectEx(processHandle, address, size, PAGE_EXECUTE_READWRITE, &oldProtect))
    {
        DWORD error = GetLastError();
        debug_log(LOG_ERROR,
                  "VirtualProtectEx failed for process %d at address 0x%p. Error code: %lu", pid,
                  address, error);
        CloseHandle(processHandle);
        return -1;
    }

    SIZE_T bytesWritten;
    if (!WriteProcessMemory(processHandle, address, buffer, size, &bytesWritten))
    {
        DWORD error = GetLastError();
        debug_log(LOG_ERROR,
                  "WriteProcessMemory failed for process %d at address 0x%p. Error code: %lu", pid,
                  address, error);
        VirtualProtectEx(processHandle, address, size, oldProtect, &oldProtect);
        CloseHandle(processHandle);
        return -1;
    }

    DWORD tempProtect;
    if (!VirtualProtectEx(processHandle, address, size, oldProtect, &tempProtect))
    {
        debug_log(LOG_ERROR,
                  "Failed to restore memory protection for process %d at address 0x%p. Error "
                  "code: %lu",
                  pid, address, GetLastError());
    }

    CloseHandle(processHandle);
    return bytesWritten;
}
