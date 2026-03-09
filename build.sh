#!/bin/bash
# build.sh — Cross-platform build script for Scribble
# Usage:
#   ./build.sh           # Build for current platform
#   ./build.sh macos     # Build macOS DMG
#   ./build.sh windows   # Build Windows NSIS installer (requires Windows or cross-compile)

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$ROOT/src-python"
BINARIES_DIR="$ROOT/src-tauri/binaries"

PLATFORM="${1:-auto}"
if [ "$PLATFORM" = "auto" ]; then
    case "$(uname -s)" in
        Darwin*) PLATFORM="macos" ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
        Linux*) PLATFORM="linux" ;;
    esac
fi

echo "🔨 Building Scribble for: $PLATFORM"

# ── Step 1: Build Python sidecar ──
echo ""
echo "📦 Building Python sidecar..."
cd "$SIDECAR_DIR"

if [ "$PLATFORM" = "windows" ]; then
    SIDECAR_NAME="scribble-sidecar-x86_64-pc-windows-msvc.exe"
    python -m PyInstaller scribble-sidecar.spec --noconfirm --clean
    cp dist/scribble-sidecar.exe "$BINARIES_DIR/$SIDECAR_NAME"
elif [ "$PLATFORM" = "macos" ]; then
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
        SIDECAR_NAME="scribble-sidecar-aarch64-apple-darwin"
    else
        SIDECAR_NAME="scribble-sidecar-x86_64-apple-darwin"
    fi
    python -m PyInstaller scribble-sidecar.spec --noconfirm --clean
    cp dist/scribble-sidecar "$BINARIES_DIR/$SIDECAR_NAME"
elif [ "$PLATFORM" = "linux" ]; then
    SIDECAR_NAME="scribble-sidecar-x86_64-unknown-linux-gnu"
    python -m PyInstaller scribble-sidecar.spec --noconfirm --clean
    cp dist/scribble-sidecar "$BINARIES_DIR/$SIDECAR_NAME"
fi
echo "✅ Sidecar built: $SIDECAR_NAME"

# ── Step 2: Build Tauri app ──
echo ""
echo "🏗️  Building Tauri app..."
cd "$ROOT"

if [ "$PLATFORM" = "macos" ]; then
    npx tauri build -b dmg --verbose
elif [ "$PLATFORM" = "windows" ]; then
    npx tauri build -b nsis --verbose
elif [ "$PLATFORM" = "linux" ]; then
    npx tauri build -b deb --verbose
fi

echo ""
echo "🎉 Build complete!"
echo "   Output: src-tauri/target/release/bundle/"
