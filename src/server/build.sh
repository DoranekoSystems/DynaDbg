#!/bin/bash

# Parse arguments
CPP_ONLY=false
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
    for file in "$CPP_DIR/darwin/native_api.mm" "$CPP_DIR/darwin/file_api.mm" "$CPP_DIR/darwin/debugger.mm" "$CPP_DIR/common/util.cpp"; do
        if [ -f "$file" ]; then
            basename=$(basename "$file")
            objname="${basename%.*}.o"
            echo "Compiling $file..."
            sudo $TARGET_CXX -c "$file" \
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
    sudo $(xcrun --sdk iphoneos --find ar) rcs "$OUT_DIR/libnative.a" $OBJECTS
    
    echo "C++ build complete. Library at: $OUT_DIR/libnative.a"
    
    # Now run cargo with minimal rebuild (touching only native bridge)
    echo "Running cargo build to link..."
    sudo ENABLE_LOG_DEVELOP=1 \
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
    for file in "$CPP_DIR/darwin/native_api.mm" "$CPP_DIR/darwin/file_api.mm" "$CPP_DIR/darwin/debugger.mm" "$CPP_DIR/common/util.cpp"; do
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
    sudo ENABLE_LOG_DEVELOP=1 cargo build --target=aarch64-apple-darwin
}

# Function to build C++ only for Android
build_cpp_android() {
    echo "Building C++ only for Android..."
    
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
    sudo ENABLE_LOG_DEVELOP=1 \
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
    echo "Usage: ./build.sh --target <target> [--cpp-only]"
    echo "Available targets: android, ios, mac, linux, linux-x86_64, linux-aarch64"
    echo "Options:"
    echo "  --cpp-only    Build only C++ files and relink"
    exit 1
fi

case $TARGET_PLATFORM in
    android)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_android
        else
            # aarch64
            TARGET=aarch64-linux-android
            TARGET_CC=$NDK_BIN_PATH/aarch64-linux-android33-clang
            TARGET_CXX=$NDK_BIN_PATH/aarch64-linux-android33-clang++
            TARGET_AR=$NDK_BIN_PATH/llvm-ar
            TARGET_LINKER=$NDK_BIN_PATH/aarch64-linux-android33-clang

            sudo ENABLE_LOG_DEVELOP=1 \
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
        else
            TARGET=aarch64-apple-ios
            TARGET_CC=$(xcrun --sdk iphoneos --find clang)
            TARGET_CXX=$(xcrun --sdk iphoneos --find clang++)
            TARGET_AR=$(xcrun --sdk iphoneos --find ar)
            TARGET_LINKER=$(xcrun --sdk iphoneos --find clang)

            sudo ENABLE_LOG_DEVELOP=1 \
                    CARGO_TARGET_AARCH64_APPLE_IOS_LINKER=$TARGET_LINKER \
                    TARGET_AR=$TARGET_AR \
                    TARGET_CC=$TARGET_CC \
                    TARGET_CXX=$TARGET_CXX \
                    cargo build --target=$TARGET
        fi
        ;;
    mac)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_mac
        else
            TARGET=aarch64-apple-darwin
            sudo ENABLE_LOG_DEVELOP=1 cargo build --target=$TARGET
        fi
        ;;
    linux|linux-x86_64)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_linux_x86_64
        else
            TARGET=x86_64-unknown-linux-gnu
            ENABLE_LOG_DEVELOP=1 cargo build --target=$TARGET
        fi
        ;;
    linux-aarch64)
        if [ "$CPP_ONLY" = true ]; then
            build_cpp_linux_aarch64
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