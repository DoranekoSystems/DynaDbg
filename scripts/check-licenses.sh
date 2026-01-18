#!/bin/bash
# License check script for DynaDbg
# This script checks both Rust (cargo) and Node.js (npm) dependencies for license compliance

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "DynaDbg License Compliance Check"
echo "=========================================="
echo ""

# Track overall status
OVERALL_STATUS=0

# Check if cargo-deny is installed
check_cargo_deny() {
    if ! command -v cargo-deny &> /dev/null; then
        echo -e "${YELLOW}cargo-deny is not installed. Installing...${NC}"
        cargo install cargo-deny
    fi
}

# Check if license-checker is installed
check_license_checker() {
    if ! command -v license-checker &> /dev/null; then
        echo -e "${YELLOW}license-checker is not installed. Installing globally...${NC}"
        npm install -g license-checker
    fi
}

# Run cargo-deny for Rust dependencies
check_rust_licenses() {
    echo -e "${GREEN}[1/3] Checking Rust dependencies (Tauri backend)...${NC}"
    echo ""
    
    TAURI_DIR="$PROJECT_ROOT/src/client/src-tauri"
    
    if [ -f "$TAURI_DIR/Cargo.toml" ]; then
        cd "$TAURI_DIR"
        
        if [ -f "deny.toml" ]; then
            echo "Running cargo-deny check licenses..."
            if cargo deny check licenses 2>&1; then
                echo -e "${GREEN}✓ Rust license check passed${NC}"
            else
                echo -e "${RED}✗ Rust license check failed${NC}"
                OVERALL_STATUS=1
            fi
        else
            echo -e "${YELLOW}⚠ deny.toml not found in $TAURI_DIR${NC}"
        fi
        
        cd "$PROJECT_ROOT"
    else
        echo -e "${YELLOW}⚠ No Cargo.toml found in $TAURI_DIR${NC}"
    fi
    
    echo ""
}

# Run cargo-deny for server
check_server_licenses() {
    echo -e "${GREEN}[2/3] Checking Rust dependencies (Server)...${NC}"
    echo ""
    
    SERVER_DIR="$PROJECT_ROOT/src/server"
    
    if [ -f "$SERVER_DIR/Cargo.toml" ]; then
        cd "$SERVER_DIR"
        
        if [ -f "deny.toml" ]; then
            echo "Running cargo-deny check licenses..."
            if cargo deny check licenses 2>&1; then
                echo -e "${GREEN}✓ Server license check passed${NC}"
            else
                echo -e "${RED}✗ Server license check failed${NC}"
                OVERALL_STATUS=1
            fi
        else
            echo -e "${YELLOW}⚠ deny.toml not found in $SERVER_DIR (using default settings)${NC}"
            # Copy deny.toml from tauri if it exists
            if [ -f "$PROJECT_ROOT/src/client/src-tauri/deny.toml" ]; then
                cp "$PROJECT_ROOT/src/client/src-tauri/deny.toml" "$SERVER_DIR/deny.toml"
                echo "Copied deny.toml from tauri..."
                if cargo deny check licenses 2>&1; then
                    echo -e "${GREEN}✓ Server license check passed${NC}"
                else
                    echo -e "${RED}✗ Server license check failed${NC}"
                    OVERALL_STATUS=1
                fi
            fi
        fi
        
        cd "$PROJECT_ROOT"
    else
        echo -e "${YELLOW}⚠ No Cargo.toml found in $SERVER_DIR${NC}"
    fi
    
    echo ""
}

# Run license-checker for npm dependencies
check_npm_licenses() {
    echo -e "${GREEN}[3/3] Checking npm dependencies (Frontend)...${NC}"
    echo ""
    
    CLIENT_DIR="$PROJECT_ROOT/src/client"
    
    if [ -f "$CLIENT_DIR/package.json" ]; then
        cd "$CLIENT_DIR"
        
        # Ensure node_modules exists
        if [ ! -d "node_modules" ]; then
            echo "Installing npm dependencies first..."
            npm install
        fi
        
        echo "Running license-checker..."
        
        # Define allowed licenses (non-copyleft licenses only)
        # Note: Our project is GPL-3.0, but we only allow non-copyleft dependencies
        ALLOWED_LICENSES="MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense;CC-BY-3.0;CC-BY-4.0;Python-2.0;BlueOak-1.0.0;MPL-2.0"
        
        # Exclude our own package (it's GPL-3.0 which is intentional)
        EXCLUDE_PACKAGES="dyna-dbg@0.1.0"
        
        # Run license-checker with allowed licenses, excluding our own package
        if license-checker --production --onlyAllow "$ALLOWED_LICENSES" --excludePackages "$EXCLUDE_PACKAGES" --summary 2>&1; then
            echo -e "${GREEN}✓ npm license check passed${NC}"
        else
            echo -e "${RED}✗ npm license check failed${NC}"
            echo ""
            echo "Packages with non-compliant licenses:"
            license-checker --production --onlyAllow "$ALLOWED_LICENSES" 2>&1 || true
            OVERALL_STATUS=1
        fi
        
        cd "$PROJECT_ROOT"
    else
        echo -e "${YELLOW}⚠ No package.json found in $CLIENT_DIR${NC}"
    fi
    
    echo ""
}

# Generate license report
generate_report() {
    echo -e "${GREEN}Generating license report...${NC}"
    echo ""
    
    REPORT_DIR="$PROJECT_ROOT/license-report"
    mkdir -p "$REPORT_DIR"
    
    # Generate npm license report
    CLIENT_DIR="$PROJECT_ROOT/src/client"
    if [ -f "$CLIENT_DIR/package.json" ] && [ -d "$CLIENT_DIR/node_modules" ]; then
        cd "$CLIENT_DIR"
        license-checker --production --json > "$REPORT_DIR/npm-licenses.json" 2>/dev/null || true
        license-checker --production --csv > "$REPORT_DIR/npm-licenses.csv" 2>/dev/null || true
        echo "  - npm licenses: $REPORT_DIR/npm-licenses.json"
        cd "$PROJECT_ROOT"
    fi
    
    # Generate cargo license report (if cargo-license is available)
    if command -v cargo-license &> /dev/null; then
        TAURI_DIR="$PROJECT_ROOT/src/client/src-tauri"
        if [ -f "$TAURI_DIR/Cargo.toml" ]; then
            cd "$TAURI_DIR"
            cargo license --json > "$REPORT_DIR/cargo-tauri-licenses.json" 2>/dev/null || true
            echo "  - Tauri licenses: $REPORT_DIR/cargo-tauri-licenses.json"
            cd "$PROJECT_ROOT"
        fi
        
        SERVER_DIR="$PROJECT_ROOT/src/server"
        if [ -f "$SERVER_DIR/Cargo.toml" ]; then
            cd "$SERVER_DIR"
            cargo license --json > "$REPORT_DIR/cargo-server-licenses.json" 2>/dev/null || true
            echo "  - Server licenses: $REPORT_DIR/cargo-server-licenses.json"
            cd "$PROJECT_ROOT"
        fi
    else
        echo -e "${YELLOW}  ⚠ cargo-license not installed (run: cargo install cargo-license)${NC}"
    fi
    
    echo ""
}

# Main execution
main() {
    check_cargo_deny
    check_license_checker
    
    echo ""
    
    check_rust_licenses
    check_server_licenses
    check_npm_licenses
    
    if [ "$1" == "--report" ]; then
        generate_report
    fi
    
    echo "=========================================="
    if [ $OVERALL_STATUS -eq 0 ]; then
        echo -e "${GREEN}All license checks passed!${NC}"
    else
        echo -e "${RED}Some license checks failed!${NC}"
        echo "Please review the packages with non-compliant licenses."
    fi
    echo "=========================================="
    
    exit $OVERALL_STATUS
}

# Show help
if [ "$1" == "--help" ] || [ "$1" == "-h" ]; then
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --report    Generate detailed license reports"
    echo "  --help, -h  Show this help message"
    echo ""
    echo "Allowed licenses:"
    echo "  MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,"
    echo "  CC0-1.0, Unlicense, Zlib, MPL-2.0, etc."
    echo ""
    echo "Denied licenses (copyleft):"
    echo "  GPL-2.0, GPL-3.0, LGPL-2.0, LGPL-2.1, LGPL-3.0, AGPL-3.0, etc."
    exit 0
fi

main "$@"
