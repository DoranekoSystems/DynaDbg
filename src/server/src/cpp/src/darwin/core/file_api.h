#ifndef FILEAPI_H
#define FILEAPI_H

#import <Foundation/Foundation.h>
#include "native_api.h"

#ifdef DYNAMIC_LIB_BUILD
#define DirectoryExplorer DirectoryExplorer_Dynamic
#define FileReader FileReader_Dynamic
#define ProcessInfoRetriever ProcessInfoRetriever_Dynamic
#define InstalledAppRetriever InstalledAppRetriever_Dynamic
#define AppIconRetriever AppIconRetriever_Dynamic
#endif

// =============================================================================
// File/Directory Operations
// =============================================================================

@interface DirectoryExplorer : NSObject

+ (NSString *)exploreDirectory:(NSString *)path maxDepth:(int)maxDepth error:(NSError **)error;

@end

@interface FileReader : NSObject

+ (NSData *)readFile:(NSString *)path error:(NSError **)error;

@end

// =============================================================================
// Application Information Retrieval
// =============================================================================

@interface ProcessInfoRetriever : NSObject

+ (NSDictionary *)getProcessInfo:(pid_t)pid;

@end

@interface InstalledAppRetriever : NSObject

+ (NSArray<NSDictionary *> *)getInstalledApps;
+ (NSDictionary *)getAppInfoFromPath:(NSString *)appPath;
+ (NSString *)getDataContainerForBundleIdentifier:(NSString *)bundleIdentifier;

@end

@interface AppIconRetriever : NSObject

+ (NSData *)getIconForApp:(NSString *)bundleIdentifier;
+ (NSData *)getIconFromAppPath:(NSString *)appPath;
+ (NSString *)findAppPathForBundleIdentifier:(NSString *)bundleIdentifier;

@end

// =============================================================================
// proc_pidpath declaration
// =============================================================================

#define PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN)
#define PROC_ALL_PIDS 1
#define PROC_PIDTBSDINFO 3
#define PROC_PIDTASKINFO 4

// =============================================================================
// C API Exports - File/Directory Operations
// =============================================================================

extern "C" const char *explore_directory(const char *path, int maxDepth);
extern "C" const void *read_file(const char *path, size_t *size, char **error_message);

// =============================================================================
// C API Exports - Application Information
// =============================================================================

extern "C" const char *get_application_info_native(pid_t pid);
extern "C" const char *get_installed_apps_native(void);
extern "C" const void *get_app_icon_native(const char *bundle_identifier, size_t *size);

// =============================================================================
// Process Management APIs are in process_api.h
// =============================================================================

#endif