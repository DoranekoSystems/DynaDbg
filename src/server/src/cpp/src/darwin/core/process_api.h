/**
 * @file process_api.h
 * @brief Process spawning and management API for Darwin/iOS
 *
 * This header provides process lifecycle management:
 * - App spawning (via FrontBoardServices on iOS)
 * - Process termination
 * - Process resume
 * - Running status queries
 *
 * Note: These APIs are primarily for iOS. macOS stubs are provided
 * for compatibility.
 */

#ifndef DARWIN_PROCESS_API_H
#define DARWIN_PROCESS_API_H

#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Spawn an application by bundle identifier
 * @param bundle_identifier The app's bundle identifier (e.g., "com.example.app")
 * @param suspended If non-zero, spawn the app in suspended state
 * @return JSON string with result: {"success":true,"pid":1234} or {"success":false,"error":"..."}
 *         Caller must free the returned string.
 */
const char* spawn_app_native(const char* bundle_identifier, int suspended);

/**
 * Terminate a process by PID
 * @param pid Process ID to terminate
 * @return 1 on success, 0 on failure
 */
int terminate_app_native(int pid);

/**
 * Resume a suspended process
 * @param pid Process ID to resume
 * @return JSON string with result: {"success":true,"pid":1234,"resumed":true} or error
 *         Caller must free the returned string.
 */
const char* resume_app_native(int pid);

/**
 * Get running status of an app by bundle identifier
 * @param bundle_identifier The app's bundle identifier
 * @return JSON string: {"success":true,"bundleIdentifier":"...","running":true/false,"pid":1234}
 *         Caller must free the returned string.
 */
const char* get_app_running_status_native(const char* bundle_identifier);

#ifdef __cplusplus
}
#endif

#ifdef __OBJC__

/**
 * Objective-C interface for app spawning
 */
@interface AppSpawner : NSObject

/**
 * Spawn an application
 * @param bundleIdentifier The app's bundle identifier
 * @param suspended Whether to spawn in suspended state
 * @return Dictionary with "success", "pid" or "error" keys
 */
+ (NSDictionary*)spawnApp:(NSString*)bundleIdentifier suspended:(BOOL)suspended;

/**
 * Terminate an application
 * @param bundleIdentifier The app's bundle identifier
 * @return YES on success, NO on failure
 */
+ (BOOL)terminateApp:(NSString*)bundleIdentifier;

@end

#endif  // __OBJC__

#endif  // DARWIN_PROCESS_API_H
