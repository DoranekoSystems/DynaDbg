#include "file_api.h"

static std::string escape_json_string(const std::string& input)
{
    std::ostringstream escaped;
    for (char c : input)
    {
        switch (c)
        {
            case '"':
                escaped << "\\\"";
                break;
            case '\\':
                escaped << "\\\\";
                break;
            case '\b':
                escaped << "\\b";
                break;
            case '\f':
                escaped << "\\f";
                break;
            case '\n':
                escaped << "\\n";
                break;
            case '\r':
                escaped << "\\r";
                break;
            case '\t':
                escaped << "\\t";
                break;
            default:
                escaped << c;
                break;
        }
    }
    return escaped.str();
}

static std::string normalize_path(const std::string& path)
{
    std::string normalized = path;
    std::replace(normalized.begin(), normalized.end(), '/', '\\');
    if (normalized.back() == '\\')
    {
        normalized.pop_back();
    }
    return normalized;
}

static const char* explore_directory_recursive(const char* path, int maxDepth, int currentDepth = 0)
{
    if (maxDepth < 0 || currentDepth > maxDepth)
    {
        return strdup("");
    }

    std::string normalizedPath = normalize_path(path);
    std::string searchPath = normalizedPath + "\\*";

    WIN32_FIND_DATA findFileData;
    HANDLE hFind = FindFirstFile(searchPath.c_str(), &findFileData);

    if (hFind == INVALID_HANDLE_VALUE)
    {
        std::ostringstream error;
        error << "Error: Failed to open directory " << normalizedPath;
        debug_log(LOG_ERROR, "Failed to open directory %s. Error code: %lu", normalizedPath.c_str(),
                  GetLastError());
        return strdup(error.str().c_str());
    }

    std::ostringstream result;
    std::string indent(currentDepth * 2, ' ');

    do
    {
        const std::string itemName = findFileData.cFileName;
        if (itemName == "." || itemName == "..") continue;

        std::string fullPath = normalizedPath + "\\" + itemName;

        if (findFileData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        {
            result << indent << "dir:" << itemName << "\n";
            if (currentDepth < maxDepth)
            {
                const char* subDirContent =
                    explore_directory_recursive(fullPath.c_str(), maxDepth, currentDepth + 1);
                result << subDirContent;
                free((void*)subDirContent);
            }
        }
        else
        {
            LARGE_INTEGER fileSize;
            fileSize.LowPart = findFileData.nFileSizeLow;
            fileSize.HighPart = findFileData.nFileSizeHigh;

            FILETIME lastWriteTime = findFileData.ftLastWriteTime;
            ULARGE_INTEGER uli;
            uli.LowPart = lastWriteTime.dwLowDateTime;
            uli.HighPart = lastWriteTime.dwHighDateTime;
            long long timestamp = (uli.QuadPart / 10000000ULL) - 11644473600ULL;

            result << indent << "file:" << itemName << "," << fileSize.QuadPart << "," << timestamp
                   << "\n";
        }
    } while (FindNextFile(hFind, &findFileData) != 0);

    FindClose(hFind);
    return strdup(result.str().c_str());
}

const char* explore_directory(const char* path, int maxDepth)
{
    return explore_directory_recursive(path, maxDepth);
}

const void* read_file(const char* path, size_t* size, char** error_message)
{
    HANDLE hFile =
        CreateFile(path, GENERIC_READ, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE)
    {
        std::ostringstream error;
        error << "Error: Could not open file " << path;
        *error_message = strdup(error.str().c_str());
        debug_log(LOG_ERROR, "Failed to open file %s. Error code: %lu", path, GetLastError());
        *size = 0;
        return NULL;
    }

    LARGE_INTEGER fileSize;
    if (!GetFileSizeEx(hFile, &fileSize))
    {
        std::ostringstream error;
        error << "Error: Could not get file size for " << path;
        *error_message = strdup(error.str().c_str());
        debug_log(LOG_ERROR, "Failed to get file size for file %s. Error code: %lu", path,
                  GetLastError());
        CloseHandle(hFile);
        *size = 0;
        return NULL;
    }

    std::vector<char> buffer(fileSize.QuadPart);
    DWORD bytesRead;
    if (!ReadFile(hFile, buffer.data(), static_cast<DWORD>(fileSize.QuadPart), &bytesRead, NULL))
    {
        std::ostringstream error;
        error << "Error: Could not read file " << path;
        *error_message = strdup(error.str().c_str());
        debug_log(LOG_ERROR, "Failed to read file %s. Error code: %lu", path, GetLastError());
        CloseHandle(hFile);
        *size = 0;
        return NULL;
    }

    CloseHandle(hFile);
    *size = fileSize.QuadPart;
    void* data = malloc(*size);
    memcpy(data, buffer.data(), *size);
    return data;
}

const char* get_application_info_native(DWORD pid)
{
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (hProcess == NULL)
    {
        std::ostringstream error;
        error << "{\"error\":\"Failed to open process " << pid << "\"}";
        debug_log(LOG_ERROR, "Failed to open process %d for reading. Error code: %lu", pid,
                  GetLastError());
        return strdup(error.str().c_str());
    }

    char processPath[MAX_PATH];
    if (!GetModuleFileNameEx(hProcess, NULL, processPath, MAX_PATH))
    {
        std::ostringstream error;
        error << "{\"error\":\"Could not retrieve process path for PID " << pid << "\"}";
        debug_log(LOG_ERROR, "Failed to retrieve process path for PID %d. Error code: %lu", pid,
                  GetLastError());
        CloseHandle(hProcess);
        return strdup(error.str().c_str());
    }

    char appDataPath[MAX_PATH];
    if (FAILED(SHGetFolderPath(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, appDataPath)))
    {
        std::ostringstream error;
        error << "{\"error\":\"Could not retrieve AppData path\"}";
        debug_log(LOG_ERROR, "Failed to retrieve AppData path. Error code: %lu", GetLastError());
        CloseHandle(hProcess);
        return strdup(error.str().c_str());
    }

    CloseHandle(hProcess);

    std::ostringstream json;
    json << "{"
         << "\"BinaryPath\":\"" << escape_json_string(processPath) << "\"}";

    return strdup(json.str().c_str());
}
