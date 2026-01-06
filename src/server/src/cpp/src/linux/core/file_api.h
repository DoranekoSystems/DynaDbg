#ifndef FILE_API_H
#define FILE_API_H

#include <sys/types.h>  // For pid_t

#ifdef __cplusplus
extern "C"
{
#endif

    const char* explore_directory(const char* path, int maxDepth);
    const void* read_file(const char* path, size_t* size, char** error_message);
    const char* get_application_info_native(pid_t pid);

#ifdef __cplusplus
}
#endif

#endif