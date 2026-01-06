#include "file_api.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <fstream>
#include <iostream>
#include <sstream>

// Helper function to escape JSON strings (file-local utility)
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

void explore_directory_recursive(const char* path, int depth, int maxDepth,
                                 std::ostringstream& result, const std::string& indent = "")
{
    if (depth > maxDepth) return;

    DIR* dir = opendir(path);
    if (!dir)
    {
        result << indent << "Error: Failed to open directory " << path
               << ". Error: " << strerror(errno) << "\n";
        return;
    }

    struct dirent* entry;

    while ((entry = readdir(dir)) != nullptr)
    {
        std::string itemName = entry->d_name;

        if (itemName == "." || itemName == "..") continue;

        std::string fullPath = std::string(path) + "/" + itemName;

        // Use stat to properly handle symlinks and DT_UNKNOWN
        struct stat fileStat;
        bool isDirectory = false;
        bool statSuccess = (stat(fullPath.c_str(), &fileStat) == 0);

        if (statSuccess)
        {
            isDirectory = S_ISDIR(fileStat.st_mode);
        }
        else if (entry->d_type == DT_DIR)
        {
            // Fallback to d_type if stat fails
            isDirectory = true;
        }

        if (isDirectory)
        {
            result << indent << "dir:" << itemName << "\n";
            explore_directory_recursive(fullPath.c_str(), depth + 1, maxDepth, result,
                                        indent + "  ");
        }
        else if (statSuccess)
        {
            result << indent << "file:" << itemName << "," << fileStat.st_size << ","
                   << fileStat.st_mtime << "\n";
        }
    }

    closedir(dir);
}

const char* explore_directory(const char* path, int maxDepth)
{
    std::ostringstream result;
    explore_directory_recursive(path, 0, maxDepth, result);
    return strdup(result.str().c_str());
}

const void* read_file(const char* path, size_t* size, char** error_message)
{
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open())
    {
        std::ostringstream error;
        error << "Error: Could not open file " << path << ". Error: " << strerror(errno);
        *error_message = strdup(error.str().c_str());
        *size = 0;
        return nullptr;
    }

    std::streamsize fileSize = file.tellg();
    file.seekg(0, std::ios::beg);

    unsigned char* buffer = (unsigned char*)malloc(fileSize);
    if (!buffer)
    {
        std::ostringstream error;
        error << "Error: Memory allocation failed for file " << path;
        *error_message = strdup(error.str().c_str());
        *size = 0;
        return nullptr;
    }

    if (!file.read((char*)buffer, fileSize))
    {
        std::ostringstream error;
        error << "Error: Failed to read file " << path;
        *error_message = strdup(error.str().c_str());
        *size = 0;
        free(buffer);
        return nullptr;
    }

    *size = fileSize;
    return buffer;
}

const char* get_application_info_native(pid_t pid)
{
    char exe_path[64];
    snprintf(exe_path, sizeof(exe_path), "/proc/%d/exe", pid);

    char binary_path[PATH_MAX];
    ssize_t len = readlink(exe_path, binary_path, sizeof(binary_path) - 1);

    if (len == -1)
    {
        std::ostringstream error;
        error << "{\"error\":\"Failed to retrieve binary path for PID " << pid
              << ". Error: " << escape_json_string(std::string(strerror(errno))) << "\"}";
        return strdup(error.str().c_str());
    }

    binary_path[len] = '\0';

    std::ostringstream json;
    json << "{"
         << "\"BinaryPath\":\"" << escape_json_string(std::string(binary_path)) << "\"}";

    return strdup(json.str().c_str());
}
