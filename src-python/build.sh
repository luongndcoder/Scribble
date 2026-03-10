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

# Build
pyinstaller \
    --onefile \
    --name "$SIDECAR_NAME" \
    --add-data "models:models" \
    --hidden-import=onnxruntime \
    --hidden-import=uvicorn.logging \
    --hidden-import=uvicorn.protocols.http \
    --hidden-import=uvicorn.protocols.http.auto \
    --hidden-import=uvicorn.protocols.http.h11_impl \
    --hidden-import=uvicorn.protocols.websockets \
    --hidden-import=uvicorn.protocols.websockets.auto \
    --hidden-import=uvicorn.lifespan \
    --hidden-import=uvicorn.lifespan.on \
    --hidden-import=fastapi \
    --hidden-import=starlette \
    --hidden-import=starlette.responses \
    --hidden-import=starlette.background \
    --hidden-import=multipart \
    --hidden-import=multipart.multipart \
    --hidden-import=httpx \
    --hidden-import=groq \
    --hidden-import=openai \
    --hidden-import=docx \
    --hidden-import=riva \
    --hidden-import=riva.client \
    --hidden-import=grpcio \
    --hidden-import=grpcio_tools \
    --hidden-import=charset_normalizer \
    --collect-all riva \
    --noconfirm \
    main.py

# Copy to Tauri binaries
mkdir -p "$TARGET_DIR"
cp "$SCRIPT_DIR/dist/$SIDECAR_NAME" "$TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}"
chmod +x "$TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}"

echo "✅ Sidecar built: $TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}"
echo "📦 Size: $(du -h "$TARGET_DIR/${SIDECAR_NAME}-${TRIPLE}" | cut -f1)"
