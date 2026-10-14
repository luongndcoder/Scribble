#!/bin/bash
# fetch-build-deps.sh — stage everything `tauri build` bundles but git does not
# hold, for the Rust-native app (no Python sidecar):
#
#   1. Streaming Zipformer-30M (Vietnamese, fp16) from HuggingFace (hynt).
#      tokens.txt is generated from bpe.model and is NOT on HF, so it lives
#      in git next to where the ONNX files land.
#   2. A static ffmpeg as the Tauri sidecar `binaries/scribble-ffmpeg-<triple>`
#      (upload normalize/VAD + audio export). Named scribble-ffmpeg so the
#      Linux .deb does not clash with a system /usr/bin/ffmpeg.
#
# The speaker model (src-tauri/models/speaker_embedding_resnet34.onnx) is
# converted in-house and committed to git — only checked here.
#
# Every download is pinned by sha256. Re-runs skip files already verified.
#
# Usage: scripts/fetch-build-deps.sh [target-triple]   (default: rustc host)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# fetch <url> <dest> <sha256>
fetch() {
    local url="$1" dest="$2" want="$3"
    if [ -f "$dest" ] && [ "$(sha256 "$dest")" = "$want" ]; then
        echo "   ✓ $(basename "$dest") (cached)"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    curl -fsSL --retry 3 -o "$dest.part" "$url"
    local got
    got="$(sha256 "$dest.part")"
    if [ "$got" != "$want" ]; then
        rm -f "$dest.part"
        echo "❌ sha256 mismatch for $url" >&2
        echo "   want $want" >&2
        echo "   got  $got" >&2
        exit 1
    fi
    mv "$dest.part" "$dest"
    echo "   ✓ $(basename "$dest")"
}

# ── 1. Streaming STT model ──
echo "📥 Streaming STT model (Zipformer-30M vi)"
HF="https://huggingface.co/hynt/Zipformer-30M-RNNT-Streaming-6000h/resolve/main"
ZDIR="$ROOT/src-tauri/resources/models/local/sherpa-onnx-zipformer-vi-streaming-30M"
fetch "$HF/encoder-epoch-31-avg-11-chunk-32-left-128.fp16.onnx" "$ZDIR/encoder.fp16.onnx" \
    49577079b22ace4ade7a994743279ce9128c92803dd04b5e7ead809a30107358
fetch "$HF/decoder-epoch-31-avg-11-chunk-16-left-128.fp16.onnx" "$ZDIR/decoder.fp16.onnx" \
    12274189a3ef638905e0d966a4f1ab090c96447f165190c4aa6b8053ac49b014
fetch "$HF/joiner-epoch-31-avg-11-chunk-16-left-128.fp16.onnx" "$ZDIR/joiner.fp16.onnx" \
    54f469ec6841deca336e33808514640be9bc1cb222dedfda312cdb2155ae37df
for f in "$ZDIR/tokens.txt" "$ROOT/src-tauri/models/speaker_embedding_resnet34.onnx"; do
    if [ ! -f "$f" ]; then
        echo "❌ Missing $f (committed to git — check your checkout)" >&2
        exit 1
    fi
done
echo "   ✓ tokens.txt, speaker_embedding_resnet34.onnx (git)"

# ── 2. Static ffmpeg sidecar ──
# eugeneware/ffmpeg-static release b6.1.1 (static ffmpeg 6.x, GPL build).
echo "📥 ffmpeg sidecar for $TRIPLE"
FF="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
EXT=""
case "$TRIPLE" in
    aarch64-apple-darwin)
        ASSET=ffmpeg-darwin-arm64.gz
        SHA=8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa ;;
    x86_64-unknown-linux-gnu)
        ASSET=ffmpeg-linux-x64.gz
        SHA=bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa ;;
    x86_64-pc-windows-msvc)
        ASSET=ffmpeg-win32-x64.gz
        SHA=8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77
        EXT=".exe" ;;
    *)
        echo "❌ No pinned ffmpeg build for $TRIPLE" >&2
        exit 1 ;;
esac
BIN_DIR="$ROOT/src-tauri/binaries"
GZ="$BIN_DIR/.cache/$ASSET"
fetch "$FF/$ASSET" "$GZ" "$SHA"
OUT="$BIN_DIR/scribble-ffmpeg-$TRIPLE$EXT"
gunzip -c "$GZ" > "$OUT"
chmod +x "$OUT"
echo "   ✓ $(basename "$OUT")"
