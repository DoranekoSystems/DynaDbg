#ifndef DLL_EXPORT_H
#define DLL_EXPORT_H

// DLL export/import macros for Windows
#ifdef _WIN32
#ifdef NATIVE_DLL_EXPORT
#define NATIVE_API __declspec(dllexport)
#elif defined(NATIVE_DLL_IMPORT)
#define NATIVE_API __declspec(dllimport)
#else
#define NATIVE_API  // Static linking
#endif
#else
#define NATIVE_API
#endif

#endif  // DLL_EXPORT_H
