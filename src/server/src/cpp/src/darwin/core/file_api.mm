#import "file_api.h"
#import <mach/mach.h>
#import <sys/sysctl.h>

@implementation DirectoryExplorer

+ (NSString *)exploreDirectory:(NSString *)path maxDepth:(int)maxDepth error:(NSError **)error
{
    @try
    {
        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSMutableString *result = [NSMutableString string];

        [self exploreDirectoryRecursive:path
                                  depth:0
                               maxDepth:maxDepth
                            fileManager:fileManager
                                 result:result
                                 indent:@""];

        return result;
    }
    @catch (NSException *exception)
    {
        if (error)
        {
            *error = [NSError
                errorWithDomain:@"DirectoryExplorerErrorDomain"
                           code:500
                       userInfo:@{
                           NSLocalizedDescriptionKey : [NSString
                               stringWithFormat:@"Exception occurred: %@", exception.reason]
                       }];
        }
        return nil;
    }
}

+ (void)exploreDirectoryRecursive:(NSString *)path
                            depth:(int)depth
                         maxDepth:(int)maxDepth
                      fileManager:(NSFileManager *)fileManager
                           result:(NSMutableString *)result
                           indent:(NSString *)indent
{
    if (depth > maxDepth) return;

    NSError *localError = nil;
    NSArray *contents = [fileManager contentsOfDirectoryAtPath:path error:&localError];

    if (localError)
    {
        [result appendFormat:@"%@error:%@\n", indent, localError.localizedDescription];
        return;
    }

    for (NSString *item in contents)
    {
        NSString *fullPath = [path stringByAppendingPathComponent:item];
        BOOL isDirectory;
        [fileManager fileExistsAtPath:fullPath isDirectory:&isDirectory];

        if (isDirectory)
        {
            [result appendFormat:@"%@dir:%@\n", indent, item];
            [self exploreDirectoryRecursive:fullPath
                                      depth:depth + 1
                                   maxDepth:maxDepth
                                fileManager:fileManager
                                     result:result
                                     indent:[indent stringByAppendingString:@"  "]];
        }
        else
        {
            NSDictionary *attributes = [fileManager attributesOfItemAtPath:fullPath error:nil];
            NSNumber *fileSize = attributes[NSFileSize];
            NSDate *lastOpenedDate = attributes[NSFileModificationDate];
            NSTimeInterval timestamp = [lastOpenedDate timeIntervalSince1970];

            [result appendFormat:@"%@file:%@,%lld,%lld\n", indent, item, [fileSize longLongValue],
                                 (long long)timestamp];
        }
    }
}

@end

@implementation FileReader

+ (NSData *)readFile:(NSString *)path error:(NSError **)error
{
    NSFileManager *fileManager = [NSFileManager defaultManager];

    if (![fileManager fileExistsAtPath:path])
    {
        if (error)
        {
            *error = [NSError errorWithDomain:@"FileReaderErrorDomain"
                                         code:404
                                     userInfo:@{NSLocalizedDescriptionKey : @"File not found"}];
        }
        return nil;
    }

    return [NSData dataWithContentsOfFile:path options:0 error:error];
}

@end

@implementation ProcessInfoRetriever

+ (NSDictionary *)getProcessInfo:(pid_t)pid
{
    NSMutableDictionary *info = [NSMutableDictionary dictionary];

    pid_t currentPid = getpid();
    debug_log(LOG_DEBUG, "Current PID: %d, Target PID: %d", currentPid, pid);

    if (pid == currentPid)
    {
        // debug_log("Fetching info for current process.");

        NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
        info[@"BundlePath"] = bundlePath;
        debug_log(LOG_DEBUG, "Bundle path: %s", [bundlePath UTF8String]);

        NSArray *documentPaths =
            NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
        NSString *documentDirectory = [documentPaths firstObject];
        info[@"DocumentDirectory"] = documentDirectory;
        debug_log(LOG_DEBUG, "Document directory: %s", [documentDirectory UTF8String]);

        NSArray *libraryPaths =
            NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES);
        NSString *libraryDirectory = [libraryPaths firstObject];
        info[@"LibraryDirectory"] = libraryDirectory;
        debug_log(LOG_DEBUG, "Library directory: %s", [libraryDirectory UTF8String]);

        NSArray *cachesPaths =
            NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
        NSString *cachesDirectory = [cachesPaths firstObject];
        info[@"CachesDirectory"] = cachesDirectory;
        debug_log(LOG_DEBUG, "Caches directory: %s", [cachesDirectory UTF8String]);
    }
    else
    {
        debug_log(LOG_DEBUG, "Fetching info for external process with PID: %d", pid);

        char pathbuf[PROC_PIDPATHINFO_MAXSIZE];
        int ret = proc_pidpath(pid, pathbuf, sizeof(pathbuf));

        if (ret > 0)
        {
            NSString *executablePath = [NSString stringWithUTF8String:pathbuf];
            if (executablePath != nil && executablePath.length > 0)
            {
                NSString *bundlePath = [executablePath stringByDeletingLastPathComponent];
                if ([bundlePath hasSuffix:@".app"])
                {
                    info[@"BundlePath"] = bundlePath;
                    debug_log(LOG_DEBUG, "External bundle path: %s", [bundlePath UTF8String]);

                    NSString *bundleIdentifier = [self bundleIdentifierForPath:bundlePath];
                    if (bundleIdentifier != nil)
                    {
                        debug_log(LOG_DEBUG, "Bundle Identifier: %s",
                                  [bundleIdentifier UTF8String]);

                        NSString *containerPath = @"/var/mobile/Containers/Data/Application";
                        NSArray *containerDirectories =
                            [[NSFileManager defaultManager] contentsOfDirectoryAtPath:containerPath
                                                                                error:nil];
                        // debug_log("Container directories: %@", containerDirectories);

                        for (NSString *directory in containerDirectories)
                        {
                            NSString *fullPath =
                                [containerPath stringByAppendingPathComponent:directory];
                            NSString *metadataPath = [fullPath
                                stringByAppendingPathComponent:
                                    @".com.apple.mobile_container_manager.metadata.plist"];
                            // debug_log("Checking metadata path: %s", [metadataPath UTF8String]);

                            NSDictionary *metadata =
                                [NSDictionary dictionaryWithContentsOfFile:metadataPath];
                            // debug_log("Metadata: %@", metadata);

                            if ([metadata[@"MCMMetadataIdentifier"]
                                    isEqualToString:bundleIdentifier])
                            {
                                info[@"DocumentDirectory"] =
                                    [fullPath stringByAppendingPathComponent:@"Documents"];
                                info[@"LibraryDirectory"] =
                                    [fullPath stringByAppendingPathComponent:@"Library"];
                                info[@"CachesDirectory"] =
                                    [fullPath stringByAppendingPathComponent:@"Library/Caches"];
                                debug_log(LOG_DEBUG, "Matched container directory: %s",
                                          [fullPath UTF8String]);
                                break;
                            }
                        }
                    }
                    else
                    {
                        debug_log(LOG_ERROR, "Failed to retrieve bundle identifier for path: %s",
                                  [bundlePath UTF8String]);
                    }
                }
                else
                {
                    debug_log(LOG_ERROR, "Unexpected path format: %s", [bundlePath UTF8String]);
                }
            }
            else
            {
                debug_log(LOG_ERROR, "Failed to convert path to NSString or empty string.");
            }
        }
        else
        {
            info[@"Error"] = @"Failed to retrieve bundle path.";
            debug_log(LOG_ERROR,
                      "Failed to retrieve bundle path for PID: %d, proc_pidpath returned: %d", pid,
                      ret);
        }
    }

    return info;
}

+ (NSString *)bundleIdentifierForPath:(NSString *)bundlePath
{
    // debug_log("Fetching bundle identifier for path: %s", [bundlePath UTF8String]);
    NSString *infoPlistPath = [bundlePath stringByAppendingPathComponent:@"Info.plist"];

    if ([[NSFileManager defaultManager] fileExistsAtPath:infoPlistPath])
    {
        NSDictionary *infoPlist = [NSDictionary dictionaryWithContentsOfFile:infoPlistPath];
        if (infoPlist != nil)
        {
            // debug_log("Info.plist contents: %@", infoPlist);
            return infoPlist[@"CFBundleIdentifier"];
        }
        else
        {
            debug_log(LOG_ERROR, "Failed to read Info.plist contents at path: %s",
                      [infoPlistPath UTF8String]);
        }
    }
    else
    {
        debug_log(LOG_ERROR, "Info.plist does not exist at path: %s", [infoPlistPath UTF8String]);
    }

    return nil;
}

@end

const char *explore_directory(const char *path, int maxDepth)
{
    @autoreleasepool
    {
        NSString *nsPath = [NSString stringWithUTF8String:path];
        NSError *error = nil;
        NSString *result = [DirectoryExplorer exploreDirectory:nsPath
                                                      maxDepth:maxDepth
                                                         error:&error];

        if (error)
        {
            NSString *errorString =
                [NSString stringWithFormat:@"Error: %@", [error localizedDescription]];
            return strdup([errorString UTF8String]);
        }

        return result ? strdup([result UTF8String]) : strdup("No results");
    }
}

const void *read_file(const char *path, size_t *size, char **error_message)
{
    @autoreleasepool
    {
        NSError *error = nil;
        NSString *nsPath = [NSString stringWithUTF8String:path];
        NSData *result = [FileReader readFile:nsPath error:&error];

        if (error)
        {
            NSString *errorString =
                [NSString stringWithFormat:@"Error: %@", [error localizedDescription]];
            *error_message = strdup([errorString UTF8String]);
            *size = 0;
            return NULL;
        }

        if (result)
        {
            *size = [result length];
            void *buffer = malloc(*size);
            memcpy(buffer, [result bytes], *size);
            return buffer;
        }
        else
        {
            *error_message = strdup("No content");
            *size = 0;
            return NULL;
        }
    }
}

const char *get_application_info_native(pid_t pid)
{
    @autoreleasepool
    {
        NSDictionary *info = [ProcessInfoRetriever getProcessInfo:pid];

        if (![NSJSONSerialization isValidJSONObject:info])
        {
            debug_log(LOG_ERROR, "info dictionary contains non-serializable objects");
            return strdup("Error: info dictionary contains non-serializable objects");
        }

        NSError *error = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:info options:0 error:&error];

        if (error)
        {
            NSString *errorString =
                [NSString stringWithFormat:@"Error: %@", [error localizedDescription]];
            return strdup([errorString UTF8String]);
        }

        NSString *jsonString = [[NSString alloc] initWithData:jsonData
                                                     encoding:NSUTF8StringEncoding];
        if (jsonString != nil)
        {
            return strdup([jsonString UTF8String]);
        }

        return strdup("Failed to generate JSON string");
    }
}

@implementation InstalledAppRetriever

+ (NSArray<NSDictionary *> *)getInstalledApps
{
    NSMutableArray<NSDictionary *> *apps = [NSMutableArray array];

    // iOS/tvOS Applications directory
    NSString *applicationsPath = @"/var/containers/Bundle/Application";
    NSFileManager *fileManager = [NSFileManager defaultManager];

    // Check if the directory exists
    if (![fileManager fileExistsAtPath:applicationsPath])
    {
        // Fallback for macOS or different iOS configurations
        applicationsPath = @"/Applications";
    }

    NSError *error = nil;
    NSArray *appContainers = [fileManager contentsOfDirectoryAtPath:applicationsPath error:&error];

    if (error)
    {
        debug_log(LOG_ERROR, "Failed to read applications directory: %s",
                  [[error localizedDescription] UTF8String]);
        return apps;
    }

    for (NSString *container in appContainers)
    {
        NSString *containerPath = [applicationsPath stringByAppendingPathComponent:container];
        BOOL isDirectory;

        if ([fileManager fileExistsAtPath:containerPath isDirectory:&isDirectory] && isDirectory)
        {
            // Find .app bundle inside the container
            NSArray *contents = [fileManager contentsOfDirectoryAtPath:containerPath error:nil];

            for (NSString *item in contents)
            {
                if ([item hasSuffix:@".app"])
                {
                    NSString *appPath = [containerPath stringByAppendingPathComponent:item];
                    NSDictionary *appInfo = [self getAppInfoFromPath:appPath];

                    if (appInfo)
                    {
                        [apps addObject:appInfo];
                    }
                }
            }
        }
        // Also handle direct .app bundles (for macOS)
        else if ([container hasSuffix:@".app"])
        {
            NSString *appPath = [applicationsPath stringByAppendingPathComponent:container];
            NSDictionary *appInfo = [self getAppInfoFromPath:appPath];

            if (appInfo)
            {
                [apps addObject:appInfo];
            }
        }
    }

    return apps;
}

+ (NSDictionary *)getAppInfoFromPath:(NSString *)appPath
{
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *infoPlistPath = [appPath stringByAppendingPathComponent:@"Info.plist"];

    if (![fileManager fileExistsAtPath:infoPlistPath])
    {
        return nil;
    }

    NSDictionary *infoPlist = [NSDictionary dictionaryWithContentsOfFile:infoPlistPath];

    if (!infoPlist)
    {
        return nil;
    }

    NSString *bundleIdentifier = infoPlist[@"CFBundleIdentifier"];
    NSString *displayName = infoPlist[@"CFBundleDisplayName"] ?: infoPlist[@"CFBundleName"];
    NSString *bundleVersion =
        infoPlist[@"CFBundleShortVersionString"] ?: infoPlist[@"CFBundleVersion"];
    NSString *executableName = infoPlist[@"CFBundleExecutable"];
    NSString *minimumOSVersion = infoPlist[@"MinimumOSVersion"];

    if (!bundleIdentifier)
    {
        return nil;
    }

    NSMutableDictionary *appInfo = [NSMutableDictionary dictionary];
    appInfo[@"bundleIdentifier"] = bundleIdentifier;
    appInfo[@"displayName"] = displayName ?: @"Unknown";
    appInfo[@"bundleVersion"] = bundleVersion ?: @"Unknown";
    appInfo[@"bundlePath"] = appPath;

    if (executableName)
    {
        appInfo[@"executableName"] = executableName;
        appInfo[@"executablePath"] = [appPath stringByAppendingPathComponent:executableName];
    }

    if (minimumOSVersion)
    {
        appInfo[@"minimumOSVersion"] = minimumOSVersion;
    }

    // Get data container path for FBS launch
    NSString *containerPath = [self getDataContainerForBundleIdentifier:bundleIdentifier];
    if (containerPath)
    {
        appInfo[@"dataContainerPath"] = containerPath;
    }

    // Get icon file name
    NSArray *iconFiles = infoPlist[@"CFBundleIconFiles"];
    if (!iconFiles)
    {
        NSDictionary *icons = infoPlist[@"CFBundleIcons"];
        if (icons)
        {
            NSDictionary *primaryIcon = icons[@"CFBundlePrimaryIcon"];
            if (primaryIcon)
            {
                iconFiles = primaryIcon[@"CFBundleIconFiles"];
            }
        }
    }

    if (iconFiles && iconFiles.count > 0)
    {
        // Get the largest icon
        appInfo[@"iconFile"] = [iconFiles lastObject];
    }

    return appInfo;
}

+ (NSString *)getDataContainerForBundleIdentifier:(NSString *)bundleIdentifier
{
    NSString *containerPath = @"/var/mobile/Containers/Data/Application";
    NSFileManager *fileManager = [NSFileManager defaultManager];

    if (![fileManager fileExistsAtPath:containerPath])
    {
        return nil;
    }

    NSArray *containerDirectories = [fileManager contentsOfDirectoryAtPath:containerPath error:nil];

    for (NSString *directory in containerDirectories)
    {
        NSString *fullPath = [containerPath stringByAppendingPathComponent:directory];
        NSString *metadataPath = [fullPath
            stringByAppendingPathComponent:@".com.apple.mobile_container_manager.metadata.plist"];

        NSDictionary *metadata = [NSDictionary dictionaryWithContentsOfFile:metadataPath];

        if ([metadata[@"MCMMetadataIdentifier"] isEqualToString:bundleIdentifier])
        {
            return fullPath;
        }
    }

    return nil;
}

@end

@implementation AppIconRetriever

+ (NSData *)getIconForApp:(NSString *)bundleIdentifier
{
    // Find app path from bundle identifier
    NSString *appPath = [self findAppPathForBundleIdentifier:bundleIdentifier];

    if (!appPath)
    {
        debug_log(LOG_ERROR, "App not found for bundle identifier: %s",
                  [bundleIdentifier UTF8String]);
        return nil;
    }

    return [self getIconFromAppPath:appPath];
}

+ (NSData *)getIconFromAppPath:(NSString *)appPath
{
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *infoPlistPath = [appPath stringByAppendingPathComponent:@"Info.plist"];

    NSDictionary *infoPlist = [NSDictionary dictionaryWithContentsOfFile:infoPlistPath];

    if (!infoPlist)
    {
        return nil;
    }

    // Get icon file names from Info.plist
    NSMutableArray *iconNames = [NSMutableArray array];

    // Try CFBundleIcons (iOS 5+)
    NSDictionary *icons = infoPlist[@"CFBundleIcons"];
    if (icons)
    {
        NSDictionary *primaryIcon = icons[@"CFBundlePrimaryIcon"];
        if (primaryIcon)
        {
            NSArray *iconFiles = primaryIcon[@"CFBundleIconFiles"];
            if (iconFiles)
            {
                [iconNames addObjectsFromArray:iconFiles];
            }
        }
    }

    // Try CFBundleIcons~ipad
    NSDictionary *iconsiPad = infoPlist[@"CFBundleIcons~ipad"];
    if (iconsiPad)
    {
        NSDictionary *primaryIcon = iconsiPad[@"CFBundlePrimaryIcon"];
        if (primaryIcon)
        {
            NSArray *iconFiles = primaryIcon[@"CFBundleIconFiles"];
            if (iconFiles)
            {
                [iconNames addObjectsFromArray:iconFiles];
            }
        }
    }

    // Try legacy CFBundleIconFiles
    NSArray *legacyIconFiles = infoPlist[@"CFBundleIconFiles"];
    if (legacyIconFiles)
    {
        [iconNames addObjectsFromArray:legacyIconFiles];
    }

    // Try CFBundleIconFile (single icon)
    NSString *singleIconFile = infoPlist[@"CFBundleIconFile"];
    if (singleIconFile)
    {
        [iconNames addObject:singleIconFile];
    }

    // Sort by size preference (larger icons first)
    NSArray *sizePreferences = @[ @"@3x", @"@2x", @"180", @"167", @"152", @"120", @"76", @"60" ];

    for (NSString *sizeSuffix in sizePreferences)
    {
        for (NSString *iconName in iconNames)
        {
            // Try with suffix
            NSArray *suffixes = @[
                [NSString stringWithFormat:@"%@%@", sizeSuffix, @".png"],
                [NSString stringWithFormat:@"%@", sizeSuffix], @".png", @""
            ];

            for (NSString *suffix in suffixes)
            {
                NSString *iconFileName = [iconName stringByAppendingString:suffix];
                NSString *iconPath = [appPath stringByAppendingPathComponent:iconFileName];

                if ([fileManager fileExistsAtPath:iconPath])
                {
                    NSData *iconData = [NSData dataWithContentsOfFile:iconPath];
                    if (iconData && iconData.length > 0)
                    {
                        debug_log(LOG_DEBUG, "Found icon at: %s", [iconPath UTF8String]);
                        return iconData;
                    }
                }
            }
        }
    }

    // Try default icon names
    NSArray *defaultIconNames = @[
        @"AppIcon60x60@3x.png", @"AppIcon60x60@2x.png", @"AppIcon76x76@2x.png", @"AppIcon.png",
        @"Icon.png", @"Icon@2x.png", @"Icon-60.png", @"Icon-60@2x.png", @"Icon-60@3x.png"
    ];

    for (NSString *defaultIconName in defaultIconNames)
    {
        NSString *iconPath = [appPath stringByAppendingPathComponent:defaultIconName];

        if ([fileManager fileExistsAtPath:iconPath])
        {
            NSData *iconData = [NSData dataWithContentsOfFile:iconPath];
            if (iconData && iconData.length > 0)
            {
                debug_log(LOG_DEBUG, "Found icon at default path: %s", [iconPath UTF8String]);
                return iconData;
            }
        }
    }

    debug_log(LOG_WARN, "No icon found for app: %s", [appPath UTF8String]);
    return nil;
}

+ (NSString *)findAppPathForBundleIdentifier:(NSString *)bundleIdentifier
{
    NSString *applicationsPath = @"/var/containers/Bundle/Application";
    NSFileManager *fileManager = [NSFileManager defaultManager];

    if (![fileManager fileExistsAtPath:applicationsPath])
    {
        applicationsPath = @"/Applications";
    }

    NSArray *appContainers = [fileManager contentsOfDirectoryAtPath:applicationsPath error:nil];

    for (NSString *container in appContainers)
    {
        NSString *containerPath = [applicationsPath stringByAppendingPathComponent:container];
        BOOL isDirectory;

        if ([fileManager fileExistsAtPath:containerPath isDirectory:&isDirectory] && isDirectory)
        {
            NSArray *contents = [fileManager contentsOfDirectoryAtPath:containerPath error:nil];

            for (NSString *item in contents)
            {
                if ([item hasSuffix:@".app"])
                {
                    NSString *appPath = [containerPath stringByAppendingPathComponent:item];
                    NSString *infoPlistPath =
                        [appPath stringByAppendingPathComponent:@"Info.plist"];
                    NSDictionary *infoPlist =
                        [NSDictionary dictionaryWithContentsOfFile:infoPlistPath];

                    if ([infoPlist[@"CFBundleIdentifier"] isEqualToString:bundleIdentifier])
                    {
                        return appPath;
                    }
                }
            }
        }
        else if ([container hasSuffix:@".app"])
        {
            NSString *appPath = [applicationsPath stringByAppendingPathComponent:container];
            NSString *infoPlistPath = [appPath stringByAppendingPathComponent:@"Info.plist"];
            NSDictionary *infoPlist = [NSDictionary dictionaryWithContentsOfFile:infoPlistPath];

            if ([infoPlist[@"CFBundleIdentifier"] isEqualToString:bundleIdentifier])
            {
                return appPath;
            }
        }
    }

    return nil;
}

@end

const char *get_installed_apps_native(void)
{
    @autoreleasepool
    {
        NSArray *apps = [InstalledAppRetriever getInstalledApps];

        if (![NSJSONSerialization isValidJSONObject:apps])
        {
            debug_log(LOG_ERROR, "Apps array contains non-serializable objects");
            return strdup("[]");
        }

        NSError *error = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:apps options:0 error:&error];

        if (error)
        {
            debug_log(LOG_ERROR, "JSON serialization error: %s",
                      [[error localizedDescription] UTF8String]);
            return strdup("[]");
        }

        NSString *jsonString = [[NSString alloc] initWithData:jsonData
                                                     encoding:NSUTF8StringEncoding];
        if (jsonString != nil)
        {
            return strdup([jsonString UTF8String]);
        }

        return strdup("[]");
    }
}

const void *get_app_icon_native(const char *bundle_identifier, size_t *size)
{
    @autoreleasepool
    {
        if (bundle_identifier == NULL || size == NULL)
        {
            *size = 0;
            return NULL;
        }

        NSString *bundleId = [NSString stringWithUTF8String:bundle_identifier];
        NSData *iconData = [AppIconRetriever getIconForApp:bundleId];

        if (iconData == nil || iconData.length == 0)
        {
            *size = 0;
            return NULL;
        }

        *size = [iconData length];
        void *buffer = malloc(*size);
        memcpy(buffer, [iconData bytes], *size);

        return buffer;
    }
}