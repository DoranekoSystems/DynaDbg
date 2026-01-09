/**
 * @file process_api.mm
 * @brief Process spawning and management API implementation for Darwin/iOS
 *
 * This file provides process lifecycle management for iOS using FrontBoardServices.
 * macOS stubs are provided for compatibility.
 */

#include "process_api.h"
#include "native_api.h"

#import <Foundation/Foundation.h>
#import <mach/mach.h>
#import <mach/mach_error.h>
#import <signal.h>
#import <unistd.h>

#if TARGET_OS_IPHONE || TARGET_OS_IOS

#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

// Watchdog assertion type (from BackBoardServices)
typedef void* BKSWatchdogAssertionRef;

// Function pointer types for watchdog
typedef BKSWatchdogAssertionRef (*BKSWatchdogAssertionCreateForPIDFunc)(CFAllocatorRef, pid_t);
typedef void (*BKSWatchdogAssertionRenewFunc)(BKSWatchdogAssertionRef);
typedef CFTimeInterval (*BKSWatchdogAssertionGetRenewalIntervalFunc)(BKSWatchdogAssertionRef);

// SpringBoard API structure for dynamically loaded symbols
typedef struct
{
    void* fbsHandle;
    void* bbsHandle;

    // Classes
    Class FBSSystemService;

    // FBS constants (loaded via dlsym)
    NSString* FBSOpenApplicationOptionKeyUnlockDevice;
    NSString* FBSOpenApplicationOptionKeyDebuggingOptions;
    NSString* FBSDebugOptionKeyArguments;
    NSString* FBSDebugOptionKeyEnvironment;
    NSString* FBSDebugOptionKeyStandardOutPath;
    NSString* FBSDebugOptionKeyStandardErrorPath;
    NSString* FBSDebugOptionKeyDisableASLR;

    // Watchdog functions (loaded via dlsym from BBS)
    BKSWatchdogAssertionCreateForPIDFunc BKSWatchdogAssertionCreateForPID;
    BKSWatchdogAssertionRenewFunc BKSWatchdogAssertionRenew;
    BKSWatchdogAssertionGetRenewalIntervalFunc BKSWatchdogAssertionGetRenewalInterval;
} SpringBoardAPI;

static SpringBoardAPI* g_processSpringboardAPI = NULL;

// Helper macro to load FBS constant from framework
#define LOAD_FBS_CONSTANT(api, name)                                     \
    do                                                                   \
    {                                                                    \
        NSString** ptr = (NSString**)dlsym((api)->fbsHandle, #name);     \
        if (ptr != NULL)                                                 \
        {                                                                \
            (api)->name = *ptr;                                          \
        }                                                                \
        else                                                             \
        {                                                                \
            debug_log(LOG_WARN, "Failed to load FBS constant: " #name);  \
        }                                                                \
    } while (0)

static SpringBoardAPI* getProcessSpringBoardAPI(void)
{
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      g_processSpringboardAPI = (SpringBoardAPI*)calloc(1, sizeof(SpringBoardAPI));
      if (!g_processSpringboardAPI) return;

      // Load FrontBoardServices framework
      g_processSpringboardAPI->fbsHandle = dlopen(
          "/System/Library/PrivateFrameworks/FrontBoardServices.framework/FrontBoardServices",
          RTLD_NOW | RTLD_GLOBAL);

      if (!g_processSpringboardAPI->fbsHandle)
      {
          debug_log(LOG_ERROR, "Failed to load FrontBoardServices framework");
          free(g_processSpringboardAPI);
          g_processSpringboardAPI = NULL;
          return;
      }

      // Load BackBoardServices framework (optional)
      g_processSpringboardAPI->bbsHandle =
          dlopen("/System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices",
                 RTLD_NOW | RTLD_GLOBAL);

      // Load FBSSystemService class
      g_processSpringboardAPI->FBSSystemService = NSClassFromString(@"FBSSystemService");
      if (!g_processSpringboardAPI->FBSSystemService)
      {
          debug_log(LOG_ERROR, "FBSSystemService class not found");
      }

      // Load FBS constants dynamically
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSOpenApplicationOptionKeyUnlockDevice);
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSOpenApplicationOptionKeyDebuggingOptions);
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSDebugOptionKeyArguments);
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSDebugOptionKeyEnvironment);
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSDebugOptionKeyStandardOutPath);
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSDebugOptionKeyStandardErrorPath);
      LOAD_FBS_CONSTANT(g_processSpringboardAPI, FBSDebugOptionKeyDisableASLR);

      // Load watchdog functions from BackBoardServices
      if (g_processSpringboardAPI->bbsHandle)
      {
          g_processSpringboardAPI->BKSWatchdogAssertionCreateForPID =
              (BKSWatchdogAssertionCreateForPIDFunc)dlsym(g_processSpringboardAPI->bbsHandle,
                                                          "BKSWatchdogAssertionCreateForPID");
          g_processSpringboardAPI->BKSWatchdogAssertionRenew =
              (BKSWatchdogAssertionRenewFunc)dlsym(g_processSpringboardAPI->bbsHandle,
                                                   "BKSWatchdogAssertionRenew");
          g_processSpringboardAPI->BKSWatchdogAssertionGetRenewalInterval =
              (BKSWatchdogAssertionGetRenewalIntervalFunc)dlsym(
                  g_processSpringboardAPI->bbsHandle, "BKSWatchdogAssertionGetRenewalInterval");

          if (g_processSpringboardAPI->BKSWatchdogAssertionCreateForPID)
          {
              debug_log(LOG_INFO, "Watchdog assertion functions loaded successfully");
          }
          else
          {
              debug_log(LOG_WARN, "Failed to load watchdog assertion functions");
          }
      }

      debug_log(LOG_INFO, "Process SpringBoard API initialized successfully");
    });

    return g_processSpringboardAPI;
}

// Kill application before spawn
static void killApplicationBeforeSpawn(id systemService, NSString* bundleIdentifier)
{
    SEL pidSelector = @selector(pidForApplication:);

    if (![systemService respondsToSelector:pidSelector]) return;

    pid_t existingPid = (pid_t)((NSInteger(*)(id, SEL, NSString*))objc_msgSend)(
        systemService, pidSelector, bundleIdentifier);

    if (existingPid > 0)
    {
        debug_log(LOG_INFO, "Terminating existing instance of %s (PID: %d)",
                  [bundleIdentifier UTF8String], existingPid);

        // Use kill() to terminate the process
        if (kill(existingPid, SIGKILL) == 0)
        {
            // Wait for process to terminate
            for (int i = 0; i < 30; i++)  // 3 seconds max
            {
                usleep(100000);  // 100ms
                pid_t pid = (pid_t)((NSInteger(*)(id, SEL, NSString*))objc_msgSend)(
                    systemService, pidSelector, bundleIdentifier);
                if (pid <= 0)
                {
                    debug_log(LOG_INFO, "Application terminated successfully");
                    break;
                }
            }
        }
        else
        {
            debug_log(LOG_WARN, "Failed to kill process %d: %s", existingPid, strerror(errno));
        }
    }
}

@implementation AppSpawner

+ (NSDictionary*)spawnApp:(NSString*)bundleIdentifier suspended:(BOOL)suspended
{
    NSMutableDictionary* result = [NSMutableDictionary dictionary];

    @try
    {
        SpringBoardAPI* api = getProcessSpringBoardAPI();
        if (!api)
        {
            result[@"success"] = @NO;
            result[@"error"] = @"Failed to initialize SpringBoard API";
            return result;
        }

        if (!api->FBSSystemService)
        {
            result[@"success"] = @NO;
            result[@"error"] = @"FBSSystemService class not found";
            return result;
        }

        id systemService = [api->FBSSystemService sharedService];
        if (!systemService)
        {
            result[@"success"] = @NO;
            result[@"error"] = @"Failed to get FBSSystemService shared instance";
            return result;
        }

        // Kill existing instance first
        killApplicationBeforeSpawn(systemService, bundleIdentifier);

        // Build debug options dictionary
        NSMutableDictionary* debugOptions = [NSMutableDictionary dictionary];

        if (suspended && api->FBSDebugOptionKeyDisableASLR)
        {
            // Use FBSDebugOptionKeyDisableASLR as debug option
            // This triggers the debug path in SpringBoard
            debugOptions[api->FBSDebugOptionKeyDisableASLR] = @YES;
        }

        // Build the main options dictionary
        NSMutableDictionary* openOptions = [NSMutableDictionary dictionary];

        // Set unlock device option
        if (api->FBSOpenApplicationOptionKeyUnlockDevice)
        {
            openOptions[api->FBSOpenApplicationOptionKeyUnlockDevice] = @YES;
        }

        // Set debugging options
        if (debugOptions.count > 0 && api->FBSOpenApplicationOptionKeyDebuggingOptions)
        {
            openOptions[api->FBSOpenApplicationOptionKeyDebuggingOptions] = debugOptions;
        }

        debug_log(LOG_INFO, "Spawning app: %s (suspended: %d)", [bundleIdentifier UTF8String],
                  suspended);
        debug_log(LOG_DEBUG, "Options: %s", [[openOptions description] UTF8String]);

        // Create client port (critical for proper FBS communication)
        SEL createClientPortSelector = @selector(createClientPort);
        SEL cleanupClientPortSelector = @selector(cleanupClientPort:);

        mach_port_t clientPort = MACH_PORT_NULL;

        if ([systemService respondsToSelector:createClientPortSelector])
        {
            clientPort = (mach_port_t)((NSInteger(*)(id, SEL))objc_msgSend)(
                systemService, createClientPortSelector);
            debug_log(LOG_DEBUG, "Created client port: %d", clientPort);
        }
        else
        {
            debug_log(LOG_WARN, "createClientPort not available, trying without it");
        }

        // Use dispatch semaphore for synchronous operation
        __block NSError* launchError = nil;
        __block BOOL launchCompleted = NO;
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

        // Result callback block
        void (^resultCallback)(NSError*) = ^(NSError* error) {
          launchError = error;
          launchCompleted = YES;
          dispatch_semaphore_signal(semaphore);
        };

        // Try openApplication:options:clientPort:withResult: first (4 argument version)
        SEL openWithClientPortSelector = @selector(openApplication:options:clientPort:withResult:);
        SEL openWithoutClientPortSelector = @selector(openApplication:options:withResult:);
        SEL pidSelector = @selector(pidForApplication:);

        // For suspended spawn, we need to start monitoring for PID immediately
        // and suspend the task as soon as we get it
        __block pid_t suspendedPid = 0;
        __block BOOL pidSuspended = NO;
        __block BOOL stopMonitoring = NO;

        dispatch_queue_t monitorQueue = NULL;

        if (suspended && [systemService respondsToSelector:pidSelector])
        {
            // Start PID monitoring in background BEFORE launching
            monitorQueue =
                dispatch_queue_create("com.dynadbg.pid_monitor", DISPATCH_QUEUE_SERIAL);

            dispatch_async(monitorQueue, ^{
              debug_log(LOG_DEBUG, "Starting PID monitor for suspended spawn");

              // Poll for PID at high frequency
              for (int i = 0; i < 500 && !stopMonitoring; i++)  // 5 seconds max
              {
                  pid_t pid = (pid_t)((NSInteger(*)(id, SEL, NSString*))objc_msgSend)(
                      systemService, pidSelector, bundleIdentifier);

                  if (pid > 0)
                  {
                      debug_log(LOG_DEBUG, "Monitor found PID: %d at iteration %d", pid, i);

                      // Immediately try to suspend
                      mach_port_t task = MACH_PORT_NULL;
                      kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);

                      if (kr == KERN_SUCCESS && task != MACH_PORT_NULL)
                      {
                          // Suspend the task
                          kr = task_suspend(task);
                          if (kr == KERN_SUCCESS)
                          {
                              debug_log(LOG_INFO, "Task suspended successfully for PID: %d", pid);
                              suspendedPid = pid;
                              pidSuspended = YES;

                              // Create watchdog assertion to prevent iOS from killing
                              // the suspended app
                              if (api->BKSWatchdogAssertionCreateForPID)
                              {
                                  BKSWatchdogAssertionRef watchdog =
                                      api->BKSWatchdogAssertionCreateForPID(kCFAllocatorDefault,
                                                                            pid);
                                  if (watchdog)
                                  {
                                      debug_log(LOG_INFO,
                                                "Watchdog assertion created for PID: %d", pid);
                                      // Renew the assertion immediately
                                      if (api->BKSWatchdogAssertionRenew)
                                      {
                                          api->BKSWatchdogAssertionRenew(watchdog);
                                      }
                                      // Note: We intentionally don't release the watchdog here
                                      // It will be released when the process is resumed or
                                      // terminated
                                  }
                                  else
                                  {
                                      debug_log(LOG_WARN,
                                                "Failed to create watchdog assertion");
                                  }
                              }
                          }
                          else
                          {
                              debug_log(LOG_WARN, "Failed to suspend task: %s",
                                        mach_error_string(kr));
                          }
                          mach_port_deallocate(mach_task_self(), task);
                      }
                      break;
                  }
                  usleep(10000);  // 10ms polling interval
              }
            });
        }

        // Try launching with client port first
        BOOL launched = NO;
        if (clientPort != MACH_PORT_NULL &&
            [systemService respondsToSelector:openWithClientPortSelector])
        {
            ((void (*)(id, SEL, NSString*, NSDictionary*, mach_port_t,
                       void (^)(NSError*)))objc_msgSend)(systemService, openWithClientPortSelector,
                                                         bundleIdentifier, openOptions, clientPort,
                                                         resultCallback);
            launched = YES;
        }
        else if ([systemService respondsToSelector:openWithoutClientPortSelector])
        {
            ((void (*)(id, SEL, NSString*, NSDictionary*, void (^)(NSError*)))objc_msgSend)(
                systemService, openWithoutClientPortSelector, bundleIdentifier, openOptions,
                resultCallback);
            launched = YES;
        }

        if (!launched)
        {
            stopMonitoring = YES;
            result[@"success"] = @NO;
            result[@"error"] = @"No suitable openApplication method found";
            return result;
        }

        // Wait for launch completion with timeout
        dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC);
        dispatch_semaphore_wait(semaphore, timeout);

        // Stop the monitoring thread
        stopMonitoring = YES;

        // Cleanup client port
        if (clientPort != MACH_PORT_NULL &&
            [systemService respondsToSelector:cleanupClientPortSelector])
        {
            ((void (*)(id, SEL, mach_port_t))objc_msgSend)(systemService, cleanupClientPortSelector,
                                                          clientPort);
        }

        if (!launchCompleted)
        {
            result[@"success"] = @NO;
            result[@"error"] = @"Launch timeout";
            return result;
        }

        if (launchError)
        {
            result[@"success"] = @NO;
            result[@"error"] = [launchError localizedDescription];
            return result;
        }

        // Get final PID
        pid_t finalPid = 0;
        if (suspended && pidSuspended)
        {
            finalPid = suspendedPid;
        }
        else if ([systemService respondsToSelector:pidSelector])
        {
            // Wait a bit for the app to fully launch
            usleep(100000);  // 100ms
            finalPid = (pid_t)((NSInteger(*)(id, SEL, NSString*))objc_msgSend)(
                systemService, pidSelector, bundleIdentifier);
        }

        result[@"success"] = @YES;
        result[@"pid"] = @(finalPid);
        result[@"suspended"] = @(suspended && pidSuspended);

        debug_log(LOG_INFO, "App spawned successfully: PID=%d, suspended=%d", finalPid,
                  suspended && pidSuspended);
    }
    @catch (NSException* exception)
    {
        debug_log(LOG_ERROR, "Exception during app spawn: %s", [[exception reason] UTF8String]);
        result[@"success"] = @NO;
        result[@"error"] = [exception reason];
    }

    return result;
}

+ (BOOL)terminateApp:(NSString*)bundleIdentifier
{
    @try
    {
        SpringBoardAPI* api = getProcessSpringBoardAPI();
        if (!api || !api->FBSSystemService)
        {
            return NO;
        }

        id systemService = [api->FBSSystemService sharedService];
        if (!systemService)
        {
            return NO;
        }

        SEL terminateSelector =
            @selector(terminateApplication:forReason:andReport:withDescription:);
        if ([systemService respondsToSelector:terminateSelector])
        {
            // FBProcessKillReasonUser = 1
            ((void (*)(id, SEL, NSString*, int, BOOL, NSString*))objc_msgSend)(
                systemService, terminateSelector, bundleIdentifier, 1, NO, @"DynaDbg termination");

            debug_log(LOG_INFO, "Terminated app: %s", [bundleIdentifier UTF8String]);
            return YES;
        }
        else
        {
            debug_log(LOG_ERROR, "terminateApplication method not available");
            return NO;
        }
    }
    @catch (NSException* exception)
    {
        debug_log(LOG_ERROR, "Exception during app terminate: %s",
                  [[exception reason] UTF8String]);
        return NO;
    }
}

@end

const char* spawn_app_native(const char* bundle_identifier, int suspended)
{
    @autoreleasepool
    {
        if (bundle_identifier == NULL)
        {
            return strdup("{\"success\":false,\"error\":\"Bundle identifier is null\"}");
        }

        NSString* bundleId = [NSString stringWithUTF8String:bundle_identifier];
        NSDictionary* result = [AppSpawner spawnApp:bundleId suspended:(suspended != 0)];

        if (![NSJSONSerialization isValidJSONObject:result])
        {
            debug_log(LOG_ERROR, "Spawn result is not serializable");
            return strdup("{\"success\":false,\"error\":\"Result not serializable\"}");
        }

        NSError* error = nil;
        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];

        if (error)
        {
            debug_log(LOG_ERROR, "JSON serialization error: %s",
                      [[error localizedDescription] UTF8String]);
            return strdup("{\"success\":false,\"error\":\"JSON serialization failed\"}");
        }

        NSString* jsonString = [[NSString alloc] initWithData:jsonData
                                                     encoding:NSUTF8StringEncoding];
        if (jsonString != nil)
        {
            return strdup([jsonString UTF8String]);
        }

        return strdup("{\"success\":false,\"error\":\"Failed to create JSON string\"}");
    }
}

int terminate_app_native(int pid)
{
    @autoreleasepool
    {
        if (pid <= 0)
        {
            return 0;
        }

        // Use kill() system call to terminate the process
        int result = kill(pid, SIGKILL);
        if (result == 0)
        {
            debug_log(LOG_INFO, "Successfully terminated process PID %d", pid);
            return 1;
        }
        else
        {
            debug_log(LOG_ERROR, "Failed to terminate process PID %d: %s", pid, strerror(errno));
            return 0;
        }
    }
}

// Resume a suspended process by PID
const char* resume_app_native(int pid)
{
    @autoreleasepool
    {
        if (pid <= 0)
        {
            return strdup("{\"success\":false,\"error\":\"Invalid PID\"}");
        }

        mach_port_t task = MACH_PORT_NULL;
        kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);

        if (kr != KERN_SUCCESS || task == MACH_PORT_NULL)
        {
            debug_log(LOG_ERROR, "Failed to get task for PID %d: %s", pid, mach_error_string(kr));
            char error_buf[256];
            snprintf(error_buf, sizeof(error_buf),
                     "{\"success\":false,\"error\":\"Failed to get task for PID: %s\"}",
                     mach_error_string(kr));
            return strdup(error_buf);
        }

        // Resume the task
        kr = task_resume(task);
        mach_port_deallocate(mach_task_self(), task);

        if (kr != KERN_SUCCESS)
        {
            debug_log(LOG_ERROR, "Failed to resume task for PID %d: %s", pid,
                      mach_error_string(kr));
            char error_buf[256];
            snprintf(error_buf, sizeof(error_buf),
                     "{\"success\":false,\"error\":\"Failed to resume task: %s\"}",
                     mach_error_string(kr));
            return strdup(error_buf);
        }

        debug_log(LOG_INFO, "Successfully resumed process PID %d", pid);

        char result_buf[128];
        snprintf(result_buf, sizeof(result_buf), "{\"success\":true,\"pid\":%d,\"resumed\":true}",
                 pid);
        return strdup(result_buf);
    }
}

// Get running status and PID of an app by bundle identifier
const char* get_app_running_status_native(const char* bundle_identifier)
{
    @autoreleasepool
    {
        if (bundle_identifier == NULL)
        {
            return strdup("{\"success\":false,\"error\":\"Bundle identifier is null\"}");
        }

        NSString* bundleId = [NSString stringWithUTF8String:bundle_identifier];

        @try
        {
            SpringBoardAPI* api = getProcessSpringBoardAPI();
            if (!api || !api->FBSSystemService)
            {
                return strdup("{\"success\":false,\"error\":\"SpringBoard API not available\"}");
            }

            id systemService = [api->FBSSystemService sharedService];
            if (!systemService)
            {
                return strdup("{\"success\":false,\"error\":\"Failed to get FBSSystemService\"}");
            }

            SEL pidSelector = @selector(pidForApplication:);
            if (![systemService respondsToSelector:pidSelector])
            {
                return strdup(
                    "{\"success\":false,\"error\":\"pidForApplication method not available\"}");
            }

            pid_t pid = (pid_t)((NSInteger(*)(id, SEL, NSString*))objc_msgSend)(
                systemService, pidSelector, bundleId);

            BOOL isRunning = (pid > 0);

            debug_log(LOG_DEBUG, "App %s running status: %s (PID: %d)", [bundleId UTF8String],
                      isRunning ? "running" : "not running", pid);

            char result_buf[256];
            snprintf(result_buf, sizeof(result_buf),
                     "{\"success\":true,\"bundleIdentifier\":\"%s\",\"running\":%s,\"pid\":%d}",
                     bundle_identifier, isRunning ? "true" : "false", pid);
            return strdup(result_buf);
        }
        @catch (NSException* exception)
        {
            debug_log(LOG_ERROR, "Exception getting app status: %s",
                      [[exception reason] UTF8String]);
            char error_buf[512];
            snprintf(error_buf, sizeof(error_buf),
                     "{\"success\":false,\"error\":\"Exception: %s\"}",
                     [[exception reason] UTF8String]);
            return strdup(error_buf);
        }
    }
}

#else

// macOS stub implementations
const char* spawn_app_native(const char* bundle_identifier, int suspended)
{
    (void)bundle_identifier;
    (void)suspended;
    return strdup("{\"success\":false,\"error\":\"Spawn not supported on macOS\"}");
}

int terminate_app_native(int pid)
{
    (void)pid;
    return 0;
}

const char* resume_app_native(int pid)
{
    (void)pid;
    return strdup("{\"success\":false,\"error\":\"Resume not supported on macOS\"}");
}

const char* get_app_running_status_native(const char* bundle_identifier)
{
    (void)bundle_identifier;
    return strdup("{\"success\":false,\"error\":\"App status not supported on macOS\"}");
}

#endif  // TARGET_OS_IPHONE || TARGET_OS_IOS
