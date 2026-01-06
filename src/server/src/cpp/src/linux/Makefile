# Makefile for building libdbgsrv_native.so standalone
# Usage:
#   make                    # Build for native Linux (x86_64 or aarch64)
#   make ARCH=arm64         # Build for arm64
#   make ARCH=x86_64        # Build for x86_64
#   make TARGET=android     # Build for Android (requires NDK)
#   make clean              # Clean build artifacts

# Output
LIB_NAME = libdbgsrv_native.so
BUILD_DIR = build

# Detect architecture if not specified
ifndef ARCH
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
ARCH = x86_64
else ifeq ($(UNAME_M),aarch64)
ARCH = arm64
else
ARCH = $(UNAME_M)
endif
endif

# Compiler settings
CXX ?= g++
CC ?= gcc

# Common flags
COMMON_CXXFLAGS = -std=c++17 -fPIC -Wall -Wextra
COMMON_CFLAGS = -fPIC -Wall -Wextra
COMMON_LDFLAGS = -shared -fPIC

# Platform-specific settings
ifeq ($(TARGET),android)
    # Android NDK build
    ifndef NDK_HOME
        $(error NDK_HOME is not set. Please set it to your Android NDK path)
    endif
    
    ifeq ($(ARCH),arm64)
        TOOLCHAIN = $(NDK_HOME)/toolchains/llvm/prebuilt/linux-x86_64
        CXX = $(TOOLCHAIN)/bin/aarch64-linux-android30-clang++
        CC = $(TOOLCHAIN)/bin/aarch64-linux-android30-clang
        ARCH_FLAGS = -march=armv8-a
    else ifeq ($(ARCH),x86_64)
        TOOLCHAIN = $(NDK_HOME)/toolchains/llvm/prebuilt/linux-x86_64
        CXX = $(TOOLCHAIN)/bin/x86_64-linux-android30-clang++
        CC = $(TOOLCHAIN)/bin/x86_64-linux-android30-clang
        ARCH_FLAGS = -march=x86-64
    else
        $(error Unsupported Android architecture: $(ARCH))
    endif
    
    PLATFORM_CXXFLAGS = -DTARGET_IS_ANDROID -DDYNAMIC_LIB_BUILD
    PLATFORM_LDFLAGS = -llog
else
    # Native Linux build
    ifeq ($(ARCH),arm64)
        ARCH_FLAGS = -march=armv8-a
    else ifeq ($(ARCH),x86_64)
        ARCH_FLAGS = -march=x86-64
    endif
    
    PLATFORM_CXXFLAGS = -DDYNAMIC_LIB_BUILD
    PLATFORM_LDFLAGS = -lpthread -ldl
endif

# Debug/Release
ifdef DEBUG
    OPT_FLAGS = -g -O0 -DDEBUG -DDEBUG_MEMORY_ACCESS -DVERBOSE_LOGGING
else
    OPT_FLAGS = -O2 -DNDEBUG
endif

# Final flags
CXXFLAGS = $(COMMON_CXXFLAGS) $(ARCH_FLAGS) $(PLATFORM_CXXFLAGS) $(OPT_FLAGS)
CFLAGS = $(COMMON_CFLAGS) $(ARCH_FLAGS) $(OPT_FLAGS)
LDFLAGS = $(COMMON_LDFLAGS) $(PLATFORM_LDFLAGS)

# Include paths
INCLUDES = -I. -I../common -I..

# Source files
CORE_SOURCES = \
    core/native_api.cpp \
    core/file_api.cpp \
    core/memory_io.cpp \
    core/callback_stubs.cpp

DEBUGGER_SOURCES = \
    debugger/debugger_core.cpp \
    debugger/debugger_breakpoint.cpp \
    debugger/debugger_watchpoint.cpp \
    debugger/debugger_exception.cpp \
    debugger/debugger_register.cpp \
    debugger/debugger_thread.cpp \
    debugger/debugger_spawn.cpp \
    debugger/debugger_memory.cpp \
    debugger/debugger_native_api.cpp

ELF_SOURCES = \
    elf/elf_parser.cpp

PTY_SOURCES = \
    pty/pty_manager.cpp

COMMON_SOURCES = \
    ../common/util.cpp \
    ../common/trace_file.cpp \
    ../common/arm64_decoder.cpp

ALL_SOURCES = $(CORE_SOURCES) $(DEBUGGER_SOURCES) $(ELF_SOURCES) $(PTY_SOURCES) $(COMMON_SOURCES)

# Object files
OBJECTS = $(patsubst %.cpp,$(BUILD_DIR)/%.o,$(ALL_SOURCES))

# Default target
all: $(BUILD_DIR)/$(LIB_NAME)

# Create build directories
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)/core
	mkdir -p $(BUILD_DIR)/debugger
	mkdir -p $(BUILD_DIR)/elf
	mkdir -p $(BUILD_DIR)/pty
	mkdir -p $(BUILD_DIR)/../common

# Compile C++ sources
$(BUILD_DIR)/%.o: %.cpp | $(BUILD_DIR)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c $< -o $@

# Link shared library
$(BUILD_DIR)/$(LIB_NAME): $(OBJECTS)
	$(CXX) $(LDFLAGS) -o $@ $^
	@echo ""
	@echo "Built: $(BUILD_DIR)/$(LIB_NAME)"
	@echo "Architecture: $(ARCH)"
	@echo "Target: $(if $(TARGET),$(TARGET),linux)"

# Clean
clean:
	rm -rf $(BUILD_DIR)

# Install (optional)
install: $(BUILD_DIR)/$(LIB_NAME)
	install -D -m 755 $(BUILD_DIR)/$(LIB_NAME) $(DESTDIR)/usr/local/lib/$(LIB_NAME)

# Print configuration
info:
	@echo "Configuration:"
	@echo "  ARCH:     $(ARCH)"
	@echo "  TARGET:   $(if $(TARGET),$(TARGET),linux)"
	@echo "  CXX:      $(CXX)"
	@echo "  CXXFLAGS: $(CXXFLAGS)"
	@echo "  LDFLAGS:  $(LDFLAGS)"
	@echo ""
	@echo "Sources:"
	@for src in $(ALL_SOURCES); do echo "  $$src"; done

.PHONY: all clean install info
