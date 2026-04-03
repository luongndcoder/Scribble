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

# ── Step 1: Build Python sidecar (AV-optimized: no UPX, excludes, version info) ──
echo ""
echo "📦 Building Python sidecar..."
cd "$SIDECAR_DIR"

# Activate venv if exists, otherwise use system python3
if [ -f "$SIDECAR_DIR/.venv/bin/activate" ]; then
    source "$SIDECAR_DIR/.venv/bin/activate"
fi
PYTHON_CMD="${PYTHON_CMD:-python3}"

$PYTHON_CMD -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# ── onedir: copy entire directory to binaries + create launcher shim ──
SIDECAR_DIST="$SIDECAR_DIR/dist/scribble-sidecar"
if [ ! -d "$SIDECAR_DIST" ]; then
    echo "❌ onedir output not found at $SIDECAR_DIST"
    exit 1
fi

# Clean old sidecar files
rm -rf "$BINARIES_DIR"/scribble-sidecar-*
rm -rf "$BINARIES_DIR"/sidecar-dist

# ── Strip unnecessary files before compression ──
echo "🗑️  Stripping sidecar-dist..."
DIST_INT="$SIDECAR_DIST/_internal"
rm -rf "$DIST_INT/grpc_tools" 2>/dev/null || true
find "$DIST_INT" -name "tests" -type d -exec rm -rf {} + 2>/dev/null || true
find "$DIST_INT" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$DIST_INT" -name "*.pyc" -delete 2>/dev/null || true
find "$DIST_INT" -name "*.dist-info" -type d -exec rm -rf {} + 2>/dev/null || true

# ── Compress into tar.gz for small app bundle ──
echo "📦 Compressing sidecar-dist..."
STRIPPED_SIZE=$(du -sh "$SIDECAR_DIST" | cut -f1)
echo "   Uncompressed: $STRIPPED_SIZE"
tar -czf "$BINARIES_DIR/sidecar-dist.tar.gz" -C "$SIDECAR_DIR/dist" scribble-sidecar
COMPRESSED_SIZE=$(du -sh "$BINARIES_DIR/sidecar-dist.tar.gz" | cut -f1)
echo "   Compressed:   $COMPRESSED_SIZE"

# Clean raw directory — only ship compressed
rm -rf "$BINARIES_DIR/sidecar-dist"

# Create thin launcher script that Tauri can execute as externalBin
if [ "$PLATFORM" = "windows" ]; then
    SIDECAR_NAME="scribble-sidecar-x86_64-pc-windows-msvc.exe"
    # Windows: create batch launcher
    cat > "$BINARIES_DIR/$SIDECAR_NAME" << 'WINEOF'
@echo off
"%~dp0sidecar-dist\scribble-sidecar.exe" %*
WINEOF
elif [ "$PLATFORM" = "macos" ]; then
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
        SIDECAR_NAME="scribble-sidecar-aarch64-apple-darwin"
    else
        SIDECAR_NAME="scribble-sidecar-x86_64-apple-darwin"
    fi
    # macOS/Linux: create shell launcher that checks multiple locations
    cat > "$BINARIES_DIR/$SIDECAR_NAME" << 'SHEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
# Check: same dir (dev), then Resources (macOS .app bundle)
for candidate in \
    "$DIR/sidecar-dist/scribble-sidecar" \
    "$DIR/../Resources/sidecar-dist/scribble-sidecar"; do
    if [ -x "$candidate" ]; then
        exec "$candidate" "$@"
    fi
done
echo "[sidecar-launcher] ERROR: scribble-sidecar not found" >&2
exit 1
SHEOF
    chmod +x "$BINARIES_DIR/$SIDECAR_NAME"
elif [ "$PLATFORM" = "linux" ]; then
    SIDECAR_NAME="scribble-sidecar-x86_64-unknown-linux-gnu"
    cat > "$BINARIES_DIR/$SIDECAR_NAME" << 'SHEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
for candidate in \
    "$DIR/sidecar-dist/scribble-sidecar" \
    "$DIR/../Resources/sidecar-dist/scribble-sidecar"; do
    if [ -x "$candidate" ]; then
        exec "$candidate" "$@"
    fi
done
echo "[sidecar-launcher] ERROR: scribble-sidecar not found" >&2
exit 1
SHEOF
    chmod +x "$BINARIES_DIR/$SIDECAR_NAME"
fi
echo "✅ Sidecar built (onedir): $SIDECAR_NAME + sidecar-dist/"

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
