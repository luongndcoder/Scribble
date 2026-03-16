#!/bin/bash
# Build Python sidecar into a standalone binary using PyInstaller
# Run from src-python/ directory

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$SCRIPT_DIR/../src-tauri/binaries"

echo "🔧 Building VoiceScribe sidecar..."

# Activate venv
source "$SCRIPT_DIR/.venv/bin/activate"

# Install PyInstaller if not present
pip install pyinstaller -q

# Detect target triple
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
if [ "$ARCH" = "x86_64" ]; then ARCH="x86_64"; fi
if [ "$ARCH" = "arm64" ]; then ARCH="aarch64"; fi
if [ "$OS" = "darwin" ]; then TRIPLE="${ARCH}-apple-darwin"; fi
if [ "$OS" = "linux" ]; then TRIPLE="${ARCH}-unknown-linux-gnu"; fi

SIDECAR_NAME="scribble-sidecar"

# Build using spec file (AV-optimized: no UPX, excludes, version info)
pyinstaller scribble-sidecar.spec --noconfirm --clean

# Copy to Tauri binaries
mkdir -p "$TARGET_DIR"
cp "$SCRIPT_DIR/dist/$SIDECAR_NAME" "$TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}"
chmod +x "$TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}"

echo "✅ Sidecar built: $TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}"
echo "📦 Size: $(du -h "$TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}" | cut -f1)"
