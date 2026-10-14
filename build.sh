#!/bin/bash
# build.sh — Cross-platform build script for Scribble
# Usage:
#   ./build.sh           # Build for current platform
#   ./build.sh macos     # Build macOS DMG
#   ./build.sh windows   # Build Windows NSIS installer (requires Windows or cross-compile)
#
# NOTE (2026-10-09): the backend is now a Rust axum server running INSIDE the
# Tauri process. The Python FastAPI sidecar was removed entirely, so this
# script no longer runs PyInstaller, strips a sidecar binary, or compresses a
# `sidecar-dist.tar.zst`. All that remains: build the frontend, build the Rust
# app, and bundle the offline models + ffmpeg sidecar (tauri.conf.json).

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

PLATFORM="${1:-auto}"
if [ "$PLATFORM" = "auto" ]; then
    case "$(uname -s)" in
        Darwin*) PLATFORM="macos" ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
        Linux*) PLATFORM="linux" ;;
    esac
fi

echo "🔨 Building Scribble for: $PLATFORM"

# ── Step 1: Stage the offline models + ffmpeg sidecar ──
# They ship inside the app, so a missing file would produce an app that
# cannot transcribe. Same script as CI; downloads are sha256-pinned and
# cached, so re-runs are instant.
echo ""
bash "$ROOT/scripts/fetch-build-deps.sh"

# ── Step 2: Frontend ──
echo ""
echo "🎨 Building frontend..."
cd "$ROOT"
npx vite build

# ── Step 3: Rust app (Tauri bundles the models per tauri.conf.json) ──
echo ""
echo "🦀 Building Tauri app..."
case "$PLATFORM" in
    macos)
        # Nemotron on the Apple GPU (MLX) needs Xcode's Metal Toolchain to
        # compile shaders at build time; without it, ship the ONNX path only.
        if xcrun metal --version >/dev/null 2>&1; then
            # mlx-sys writes the compiled shader library to MLX_RS_METAL_PATH;
            # pin it so the exact file matching this build can be published.
            export MLX_RS_METAL_PATH="$ROOT/src-tauri/target/mlx-metallib"
            mkdir -p "$MLX_RS_METAL_PATH"
            ( cd "$ROOT/src-tauri" && cargo build --release --features mlx --lib )
            if [ ! -f "$MLX_RS_METAL_PATH/mlx.metallib" ]; then
                echo "❌ mlx.metallib was not produced at $MLX_RS_METAL_PATH" >&2
                exit 1
            fi
            npx tauri build --bundles app,dmg --features mlx
            # The shaders (~174MB) are NOT bundled: users who pick Nemotron MLX
            # download them with the model from this version's GitHub Release.
            VERSION=$(grep -m1 '"version"' "$ROOT/src-tauri/tauri.conf.json" | sed -E 's/.*"([0-9.]+)".*/\1/')
            cp "$MLX_RS_METAL_PATH/mlx.metallib" "$ROOT/src-tauri/target/release/bundle/mlx.metallib"
            echo "📦 Upload the MLX shaders with the release:"
            echo "   gh release upload v$VERSION src-tauri/target/release/bundle/mlx.metallib --clobber"
        else
            echo "⚠️  Metal Toolchain missing — building without the MLX engine."
            echo "   Install: xcodebuild -downloadComponent MetalToolchain"
            npx tauri build --bundles app,dmg
        fi
        ;;
    windows) npx tauri build --bundles nsis ;;
    linux)   npx tauri build --bundles deb,appimage ;;
    *)       npx tauri build ;;
esac

echo ""
echo "✅ Build complete."
echo "   Artifacts: src-tauri/target/release/bundle/"
