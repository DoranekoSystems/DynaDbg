# Makefile for building libdbgsrv_native.dylib standalone (Darwin/macOS)
# Usage:
#   make                    # Build for native macOS (arm64)
#   make ARCH=arm64         # Build for arm64
#   make ARCH=x86_64        # Build for x86_64
#   make clean              # Clean build artifacts

# Output
LIB_NAME = libdbgsrv_native.dylib
BUILD_DIR = build

# Detect architecture if not specified
ifndef ARCH
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
ARCH = x86_64
else ifeq ($(UNAME_M),arm64)
ARCH = arm64
else
ARCH = $(UNAME_M)
endif
endif

# Compiler settings
CXX ?= clang++
CC ?= clang

# Common flags
COMMON_CXXFLAGS = -std=c++17 -fPIC -Wall -Wextra
COMMON_CFLAGS = -fPIC -Wall -Wextra
COMMON_LDFLAGS = -dynamiclib -fPIC

# Architecture-specific flags
ifeq ($(ARCH),arm64)
    ARCH_FLAGS = -arch arm64
else ifeq ($(ARCH),x86_64)
    ARCH_FLAGS = -arch x86_64
endif

# Platform-specific settings
PLATFORM_CXXFLAGS = -DDYNAMIC_LIB_BUILD
PLATFORM_LDFLAGS = -lpthread -ldl -framework Foundation -framework CoreServices

# Debug/Release
ifdef DEBUG
    OPT_FLAGS = -g -O0 -DDEBUG -DENABLE_LOG_DEVELOP -DVERBOSE_LOGGING
else
    OPT_FLAGS = -O2 -DNDEBUG
endif

# Final flags
CXXFLAGS = $(COMMON_CXXFLAGS) $(ARCH_FLAGS) $(PLATFORM_CXXFLAGS) $(OPT_FLAGS)
CFLAGS = $(COMMON_CFLAGS) $(ARCH_FLAGS) $(OPT_FLAGS)
LDFLAGS = $(COMMON_LDFLAGS) $(ARCH_FLAGS) $(PLATFORM_LDFLAGS)

# Include paths
INCLUDES = -I. -I../common -I..

# Source files
CORE_SOURCES = \
    core/native_api.mm \
    core/file_api.mm \
    core/memory_io.mm \
    core/process_api.mm

DEBUGGER_SOURCES = \
    debugger/debugger_core.mm \
    debugger/debugger_breakpoint.mm \
    debugger/debugger_watchpoint.mm \
    debugger/debugger_exception.mm \
    debugger/debugger_register.mm \
    debugger/debugger_trace.mm \
    debugger/debugger_native_api.mm

COMMON_SOURCES = \
    ../common/util.cpp \
    ../common/trace_file.cpp \
    ../common/arm64_decoder.cpp

ALL_SOURCES = $(CORE_SOURCES) $(DEBUGGER_SOURCES) $(COMMON_SOURCES)

# Object files (handle both .mm and .cpp)
OBJECTS = $(patsubst %.mm,$(BUILD_DIR)/%.o,$(patsubst %.cpp,$(BUILD_DIR)/%.o,$(ALL_SOURCES)))

# Default target
all: $(BUILD_DIR)/$(LIB_NAME)

# Create build directories
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)/core
	mkdir -p $(BUILD_DIR)/debugger
	mkdir -p $(BUILD_DIR)/../common

# Compile Objective-C++ sources (.mm)
$(BUILD_DIR)/%.o: %.mm | $(BUILD_DIR)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c $< -o $@

# Compile C++ sources (.cpp)
$(BUILD_DIR)/%.o: %.cpp | $(BUILD_DIR)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c $< -o $@

# Link shared library
$(BUILD_DIR)/$(LIB_NAME): $(OBJECTS)
	$(CXX) $(LDFLAGS) -o $@ $^
	@echo ""
	@echo "Built: $(BUILD_DIR)/$(LIB_NAME)"
	@echo "Architecture: $(ARCH)"
	@echo "Target: darwin"

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
	@echo "  TARGET:   darwin"
	@echo "  CXX:      $(CXX)"
	@echo "  CXXFLAGS: $(CXXFLAGS)"
	@echo "  LDFLAGS:  $(LDFLAGS)"
	@echo ""
	@echo "Sources:"
	@for src in $(ALL_SOURCES); do echo "  $$src"; done

.PHONY: all clean install info
