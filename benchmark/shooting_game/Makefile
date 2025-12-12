# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║           Stellar Defender - TUI Shooting Game Makefile                   ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

CXX := g++
CXXFLAGS := -std=c++17 -Wall -Wextra
LDFLAGS := -pthread -lncurses

# Debug build (default) - for DynaDbg testing
DEBUG_FLAGS := -g3 -O0

# Release build
RELEASE_FLAGS := -O2 -DNDEBUG

TARGET := shooting_game
SRC := shooting_game.cpp

.PHONY: all clean debug release run help

# Default target: debug build
all: debug

# Debug build (recommended for DynaDbg)
debug: CXXFLAGS += $(DEBUG_FLAGS)
debug: $(TARGET)
	@echo ""
	@echo "╔═══════════════════════════════════════════════════════════════╗"
	@echo "║  Debug build complete: $(TARGET)                              ║"
	@echo "║  Run with: ./$(TARGET) or make run                            ║"
	@echo "╚═══════════════════════════════════════════════════════════════╝"

# Release build
release: CXXFLAGS += $(RELEASE_FLAGS)
release: $(TARGET)
	@echo ""
	@echo "╔═══════════════════════════════════════════════════════════════╗"
	@echo "║  Release build complete: $(TARGET)                            ║"
	@echo "╚═══════════════════════════════════════════════════════════════╝"

# Link
$(TARGET): $(SRC)
	@echo "Compiling $(SRC)..."
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDFLAGS)

# Run the game
run: $(TARGET)
	./$(TARGET)

# Clean build artifacts
clean:
	rm -f $(TARGET)
	@echo "Cleaned."

# Help
help:
	@echo "Stellar Defender - Build Targets:"
	@echo ""
	@echo "  make          - Build debug version (default)"
	@echo "  make debug    - Build with debug symbols (-g3 -O0)"
	@echo "  make release  - Build optimized release version"
	@echo "  make run      - Build and run the game"
	@echo "  make clean    - Remove built files"
	@echo "  make help     - Show this help"
	@echo ""
	@echo "Prerequisites:"
	@echo "  - g++ with C++17 support"
	@echo "  - ncurses library (libncurses-dev)"
	@echo "  - pthread support"
