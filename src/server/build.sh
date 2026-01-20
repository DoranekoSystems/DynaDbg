#!/bin/bash

# Parse arguments
CPP_ONLY=false
SWIFT_ONLY=false
TARGET=""
TARGET_PLATFORM=""

# Set LOG_DEVELOP flag based on environment variable
if [ -n "$ENABLE_LOG_DEVELOP" ]; then
    BUILD_TIMESTAMP=$(date "+%Y-%m-%dT%H:%M:%S")
    LOG_DEVELOP_FLAG="-DENABLE_LOG_DEVELOP -DBUILD_TIMESTAMP='\"$BUILD_TIMESTAMP\"'"
    echo "Build timestamp: $BUILD_TIMESTAMP"
else
    LOG_DEVELOP_FLAG=""
fi

while [[ $# -gt 0 ]]; do
    case $1 in
        --cpp-only)
            CPP_ONLY=true
            shift
            ;;
        --swift-only)
            SWIFT_ONLY=true
            shift
            ;;
        --target)
            TARGET_PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Function to clone MachOKit if not present
# MachOKit is cloned to src/MachOKit (relative to repo root) because
# Package.swift references ../../../MachOKit from src/server/src/swift
ensure_machokit() {
    # From src/server, go up to repo root then to src/MachOKit
    MACHOKIT_DIR="../MachOKit"
    if [ ! -d "$MACHOKIT_DIR" ]; then
        echo "MachOKit not found at $MACHOKIT_DIR. Cloning from GitHub..."
        git clone --depth 1 https://github.com/p-x9/MachOKit.git "$MACHOKIT_DIR"
        if [ $? -ne 0 ]; then
            echo "Error: Failed to clone MachOKit"
            exit 1
        fi
        echo "MachOKit cloned successfully to $MACHOKIT_DIR"
    fi
}

# Function to build MachOKit for iOS
build_machokit_ios() {
    echo "Building MachOKit for iOS..."
    
    ensure_machokit
    MACHOKIT_DIR="../MachOKit"
    
    SDK_PATH=$(xcrun --sdk iphoneos --show-sdk-path)
    
    cd "$MACHOKIT_DIR"
    swift build -c release --sdk "$SDK_PATH" --triple arm64-apple-ios
    cd - > /dev/null
    
    echo "MachOKit build complete."
}

# Function to build MachOKit for macOS
build_machokit_mac() {
    echo "Building MachOKit for macOS..."
    
    ensure_machokit
    MACHOKIT_DIR="../MachOKit"
    
    cd "$MACHOKIT_DIR"
    swift build -c release
    cd - > /dev/null
    
    echo "MachOKit build complete."
}

# Function to build MachOBridge for iOS
build_macho_bridge_ios() {
    echo "Building MachOBridge for iOS..."
    
    BRIDGE_DIR="src/swift"
    if [ ! -d "$BRIDGE_DIR" ]; then
        echo "Error: MachOBridge directory not found at $BRIDGE_DIR"
        exit 1
    fi
    
    cd "$BRIDGE_DIR"
    xcodebuild -scheme MachOBridge \
        -configuration Release \
        -destination "generic/platform=iOS" \
        -sdk iphoneos \
        -derivedDataPath .build-xcode-ios \
        SKIP_INSTALL=NO \
        CODE_SIGN_IDENTITY="" \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGNING_ALLOWED=NO \
        build
    
    # Create static library from object files
    PRODUCTS_DIR=".build-xcode-ios/Build/Products/Release-iphoneos"
    if [ -d "$PRODUCTS_DIR" ]; then
        echo "Creating libMachOBridge.a..."
        cd "$PRODUCTS_DIR"
        ar -crs libMachOBridge.a MachOBridge.o MachOKit.o FileIO.o MachOKitC.o
        echo "Created libMachOBridge.a ($(ls -la libMachOBridge.a | awk '{print $5}') bytes)"
        cd - > /dev/null
    fi
    
    cd - > /dev/null
    
    echo "MachOBridge build complete."
}

# Function to build MachOBridge for macOS
build_macho_bridge_mac() {
    echo "Building MachOBridge for macOS..."
    
    BRIDGE_DIR="src/swift"
    if [ ! -d "$BRIDGE_DIR" ]; then
        echo "Error: MachOBridge directory not found at $BRIDGE_DIR"
        exit 1
    fi
    
    cd "$BRIDGE_DIR"
    xcodebuild -scheme MachOBridge \
        -configuration Release \
        -destination "generic/platform=macOS" \
        -sdk macosx \
        -derivedDataPath .build-xcode-macos \
        SKIP_INSTALL=NO \
        CODE_SIGN_IDENTITY="" \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGNING_ALLOWED=NO \
        build
    
    # Create static library from object files
    PRODUCTS_DIR=".build-xcode-macos/Build/Products/Release"
    if [ -d "$PRODUCTS_DIR" ]; then
        echo "Creating libMachOBridge.a..."
        cd "$PRODUCTS_DIR"
        ar -crs libMachOBridge.a MachOBridge.o MachOKit.o FileIO.o MachOKitC.o
        echo "Created libMachOBridge.a ($(ls -la libMachOBridge.a | awk '{print $5}') bytes)"
        cd - > /dev/null
    fi
    
    cd - > /dev/null
    
    echo "MachOBridge build complete."
}

# Function to build Swift components only for iOS
build_swift_ios() {
    echo "Building Swift components for iOS..."
    build_machokit_ios
    build_macho_bridge_ios
    echo "Swift build complete for iOS."
}

# Function to build Swift components only for macOS
build_swift_mac() {
    echo "Building Swift components for macOS..."
    build_machokit_mac
    build_macho_bridge_mac
    echo "Swift build complete for macOS."
}

# Function to build C++ only for iOS
build_cpp_ios() {
    echo "Building C++ only for iOS..."
    
    SDK_PATH=$(xcrun --sdk iphoneos --show-sdk-path)
    TARGET_CC=$(xcrun --sdk iphoneos --find clang)
    TARGET_CXX=$(xcrun --sdk iphoneos --find clang++)
    
    CPP_DIR="src/cpp/src"
    OUT_DIR="target/aarch64-apple-ios/debug"
    
    # Create output directory if it doesn't exist
    mkdir -p "$OUT_DIR"
    
    # Compile each .mm file
    OBJECTS=""
    for file in "$CPP_DIR/darwin/core/native_api.mm" "$CPP_DIR/darwin/core/file_api.mm" \
                "$CPP_DIR/darwin/debugger/debugger_core.mm" \
                "$CPP_DIR/darwin/debugger/debugger_breakpoint.mm" \
                "$CPP_DIR/darwin/debugger/debugger_watchpoint.mm" \
                "$CPP_DIR/darwin/debugger/debugger_exception.mm" \
                "$CPP_DIR/darwin/debugger/debugger_register.mm" \
                "$CPP_DIR/darwin/debugger/debugger_trace.mm" \
                "$CPP_DIR/darwin/debugger/debugger_native_api.mm" \
                "$CPP_DIR/common/util.cpp"; do
        if [ -f "$file" ]; then
            basename=$(basename "$file")
            objname="${basename%.*}.o"
            echo "Compiling $file..."
            $TARGET_CXX -c "$file" \
                -target arm64-apple-ios \
                -isysroot "$SDK_PATH" \
                -std=c++17 \
                -Wall \
                -g \
                -mios-version-min=10.0 \
                $LOG_DEVELOP_FLAG \
                -I"$CPP_DIR" \
                -o "$OUT_DIR/$objname"
            OBJECTS="$OBJECTS $OUT_DIR/$objname"
        fi
    done
    
    # Create static library
    echo "Creating libnative.a..."
    $(xcrun --sdk iphoneos --find ar) rcs "$OUT_DIR/libnative.a" $OBJECTS
    
    echo "C++ build complete. Library at: $OUT_DIR/libnative.a"
    
    # Now run cargo with minimal rebuild (touching only native bridge)
    echo "Running cargo build to link..."
    ENABLE_LOG_DEVELOP=1 \
        CARGO_TARGET_AARCH64_APPLE_IOS_LINKER=$(xcrun --sdk iphoneos --find clang) \
        TARGET_AR=$(xcrun --sdk iphoneos --find ar) \
        TARGET_CC=$TARGET_CC \
        TARGET_CXX=$TARGET_CXX \
        cargo build --target=aarch64-apple-ios
}

# Function to build C++ only for macOS
build_cpp_mac() {
    echo "Building C++ only for macOS..."
    
    CPP_DIR="src/cpp/src"
    OUT_DIR="target/aarch64-apple-darwin/debug"
    
    mkdir -p "$OUT_DIR"
    
    OBJECTS=""
    for file in "$CPP_DIR/darwin/core/native_api.mm" "$CPP_DIR/darwin/core/file_api.mm" \
                "$CPP_DIR/darwin/debugger/debugger_core.mm" \
                "$CPP_DIR/darwin/debugger/debugger_breakpoint.mm" \
                "$CPP_DIR/darwin/debugger/debugger_watchpoint.mm" \
                "$CPP_DIR/darwin/debugger/debugger_exception.mm" \
                "$CPP_DIR/darwin/debugger/debugger_register.mm" \
                "$CPP_DIR/darwin/debugger/debugger_trace.mm" \
                "$CPP_DIR/darwin/debugger/debugger_native_api.mm" \
                "$CPP_DIR/common/util.cpp"; do
        if [ -f "$file" ]; then
            basename=$(basename "$file")
            objname="${basename%.*}.o"
            echo "Compiling $file..."
            clang++ -c "$file" \
                -target arm64-apple-macos \
                -std=c++17 \
                -Wall \
                -g \
                -mmacosx-version-min=10.12 \
                $LOG_DEVELOP_FLAG \
                -I"$CPP_DIR" \
                -o "$OUT_DIR/$objname"
            OBJECTS="$OBJECTS $OUT_DIR/$objname"
        fi
    done
    
    echo "Creating libnative.a..."
    ar rcs "$OUT_DIR/libnative.a" $OBJECTS
    
    echo "C++ build complete. Library at: $OUT_DIR/libnative.a"
    
    echo "Running cargo build to link..."
    ENABLE_LOG_DEVELOP=1 cargo build --target=aarch64-apple-darwin
}

# Function to build C++ only for Android
build_cpp_android() {
    echo "Building C++ only for Android..."
    
    # Find the actual prebuilt directory (darwin-x86_64 or linux-x86_64)
    NDK_PREBUILT_DIR=$(ls -d "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/"*/ 2>/dev/null | head -1)
    if [ -z "$NDK_PREBUILT_DIR" ]; then
        echo "Error: Could not find NDK prebuilt directory"
        exit 1
    fi
    NDK_BIN_PATH="${NDK_PREBUILT_DIR}bin"
    TARGET=aarch64-linux-android
    TARGET_CC=$NDK_BIN_PATH/aarch64-linux-android33-clang
    TARGET_CXX=$NDK_BIN_PATH/aarch64-linux-android33-clang++
    TARGET_AR=$NDK_BIN_PATH/llvm-ar
    
    CPP_DIR="src/cpp/src"
    OUT_DIR="target/$TARGET/release"
    
    mkdir -p "$OUT_DIR"
    
    OBJECTS=""
    for file in "$CPP_DIR/linux/native_api.cpp" "$CPP_DIR/linux/file_api.cpp" "$CPP_DIR/linux/debugger.cpp" "$CPP_DIR/common/util.cpp"; do
        if [ -f "$file" ]; then
            basename=$(basename "$file")
            objname="${basename%.*}.o"
            echo "Compiling $file..."
            $TARGET_CXX -c "$file" \
                -target aarch64-linux-android33 \
                -std=c++17 \
                -Wall \
                -g \
                -DTARGET_IS_ANDROID \
                $LOG_DEVELOP_FLAG \
                -I"$CPP_DIR" \
                -o "$OUT_DIR/$objname"
            OBJECTS="$OBJECTS $OUT_DIR/$objname"
        fi
    done
    
    echo "Creating libnative.a..."
    $TARGET_AR rcs "$OUT_DIR/libnative.a" $OBJECTS
    
    echo "C++ build complete. Library at: $OUT_DIR/libnative.a"
    
    echo "Running cargo build to link..."
    ENABLE_LOG_DEVELOP=1 \
        CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK_BIN_PATH/aarch64-linux-android33-clang \
        TARGET_AR=$TARGET_AR \
        TARGET_CC=$TARGET_CC \
        TARGET_CXX=$TARGET_CXX \
        cargo build --target=$TARGET --release
}

# Function to build C++ only for Linux x86_64
build_cpp_linux_x86_64() {
    echo "Building C++ only for Linux x86_64..."
    
    CPP_DIR="src/cpp/src"
    OUT_DIR="target/x86_64-unknown-linux-gnu/debug"
    
    mkdir -p "$OUT_DIR"
    
    OBJECTS=""
    for file in "$CPP_DIR/linux/native_api.cpp" "$CPP_DIR/linux/file_api.cpp" "$CPP_DIR/linux/debugger.cpp" "$CPP_DIR/common/util.cpp"; do
        if [ -f "$file" ]; then
            basename=$(basename "$file")
            objname="${basename%.*}.o"
            echo "Compiling $file..."
            g++ -c "$file" \
                -std=c++17 \
                -Wall \
                -g \
                -fPIC \
                $LOG_DEVELOP_FLAG \
                -I"$CPP_DIR" \
                -o "$OUT_DIR/$objname"
            OBJECTS="$OBJECTS $OUT_DIR/$objname"
        fi
    done
    
    echo "Creating libnative.a..."
    ar rcs "$OUT_DIR/libnative.a" $OBJECTS
    
    echo "C++ build complete. Library at: $OUT_DIR/libnative.a"
    
    echo "Running cargo build to link..."
    ENABLE_LOG_DEVELOP=1 cargo build --target=x86_64-unknown-linux-gnu
}

# Function to build C++ only for Linux aarch64
build_cpp_linux_aarch64() {
    echo "Building C++ only for Linux aarch64..."
    
    CPP_DIR="src/cpp/src"
    OUT_DIR="target/aarch64-unknown-linux-gnu/debug"
    
    mkdir -p "$OUT_DIR"
    
    OBJECTS=""
    for file in "$CPP_DIR/linux/native_api.cpp" "$CPP_DIR/linux/file_api.cpp" "$CPP_DIR/linux/debugger.cpp" "$CPP_DIR/common/util.cpp"; do
        if [ -f "$file" ]; then
            basename=$(basename "$file")
            objname="${basename%.*}.o"
            echo "Compiling $file..."
            g++ -c "$file" \
                -std=c++17 \
                -Wall \
                -g \
                -fPIC \
                $LOG_DEVELOP_FLAG \
                -I"$CPP_DIR" \
                -o "$OUT_DIR/$objname"
            OBJECTS="$OBJECTS $OUT_DIR/$objname"
        fi
    done
    
    echo "Creating libnative.a..."
    ar rcs "$OUT_DIR/libnative.a" $OBJECTS
    
    echo "C++ build complete. Library at: $OUT_DIR/libnative.a"
    
    echo "Running cargo build to link..."
    ENABLE_LOG_DEVELOP=1 cargo build --target=aarch64-unknown-linux-gnu
}

# Main logic
if [ -z "$TARGET_PLATFORM" ]; then
    echo "Usage: ./build.sh --target <target> [--cpp-only] [--swift-only]"
    echo "Available targets: android, ios, mac, linux, linux-x86_64, linux-aarch64"
    echo "Options:"
    echo "  --cpp-only    Build only C++ files and relink"
    echo "  --swift-only  Build only Swift/MachOKit components (iOS/macOS only)"
    exit 1
fi

case $TARGET_PLATFORM in
    android)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_android
        elif [ "$SWIFT_ONLY" = true ]; then
            echo "Swift components are not available for Android."
            exit 1
        else
            # aarch64
            # Find the actual prebuilt directory (darwin-x86_64 or linux-x86_64)
            NDK_PREBUILT_DIR=$(ls -d "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/"*/ 2>/dev/null | head -1)
            if [ -z "$NDK_PREBUILT_DIR" ]; then
                echo "Error: Could not find NDK prebuilt directory"
                exit 1
            fi
            NDK_BIN_PATH="${NDK_PREBUILT_DIR}bin"
            TARGET=aarch64-linux-android
            TARGET_CC=$NDK_BIN_PATH/aarch64-linux-android33-clang
            TARGET_CXX=$NDK_BIN_PATH/aarch64-linux-android33-clang++
            TARGET_AR=$NDK_BIN_PATH/llvm-ar
            TARGET_LINKER=$NDK_BIN_PATH/aarch64-linux-android33-clang

            ENABLE_LOG_DEVELOP=1 \
                 CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$TARGET_LINKER \
                 TARGET_AR=$TARGET_AR \
                 TARGET_CC=$TARGET_CC \
                 TARGET_CXX=$TARGET_CXX \
                 cargo build --target=$TARGET --release
        fi
        ;;
    ios)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_ios
        elif [ "$SWIFT_ONLY" = true ]; then
            build_swift_ios
        else
            # Build Swift components (MachOKit + MachOBridge) first
            build_swift_ios
            
            TARGET=aarch64-apple-ios
            TARGET_CC=$(xcrun --sdk iphoneos --find clang)
            TARGET_CXX=$(xcrun --sdk iphoneos --find clang++)
            TARGET_AR=$(xcrun --sdk iphoneos --find ar)
            TARGET_LINKER=$(xcrun --sdk iphoneos --find clang)

            ENABLE_LOG_DEVELOP=1 \
                    CARGO_TARGET_AARCH64_APPLE_IOS_LINKER=$TARGET_LINKER \
                    TARGET_AR=$TARGET_AR \
                    TARGET_CC=$TARGET_CC \
                    TARGET_CXX=$TARGET_CXX \
                    cargo build --target=$TARGET --release
        fi
        ;;
    mac)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_mac
        elif [ "$SWIFT_ONLY" = true ]; then
            build_swift_mac
        else
            # Build Swift components (MachOKit + MachOBridge) first
            build_swift_mac
            
            TARGET=aarch64-apple-darwin
            ENABLE_LOG_DEVELOP=1 cargo build --target=$TARGET
        fi
        ;;
    linux|linux-x86_64)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_linux_x86_64
        elif [ "$SWIFT_ONLY" = true ]; then
            echo "Swift components are not available for Linux."
            exit 1
        else
            TARGET=x86_64-unknown-linux-gnu
            ENABLE_LOG_DEVELOP=1 cargo build --target=$TARGET
        fi
        ;;
    linux-aarch64)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_linux_aarch64
        elif [ "$SWIFT_ONLY" = true ]; then
            echo "Swift components are not available for Linux."
            exit 1
        else
            TARGET=aarch64-unknown-linux-gnu
            ENABLE_LOG_DEVELOP=1 cargo build --target=$TARGET
        fi
        ;;
    *)
        echo "Unknown target: $TARGET_PLATFORM"
        exit 1
        ;;
esac