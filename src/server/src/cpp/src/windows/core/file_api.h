#ifndef WINDOWS_CORE_FILE_API_H
#define WINDOWS_CORE_FILE_API_H

#include <ShlObj.h>

#include <algorithm>
#include <iostream>
#include <sstream>
#include <string>

#include "native_api.h"

// Directory exploration
extern "C" const char* explore_directory(const char* path, int maxDepth);

// File reading
extern "C" const void* read_file(const char* path, size_t* size, char** error_message);

// Application information
extern "C" const char* get_application_info_native(DWORD pid);

#endif  // WINDOWS_CORE_FILE_API_H
