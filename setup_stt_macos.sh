#!/bin/bash
# ─── Meeting Minutes: macOS Setup for Python STT Service ───
# Tested on macOS arm64 (Apple Silicon M1/M2/M3/M4) with Python 3.11+

set -e

cd "$(dirname "$0")"

echo "🔧 Setting up Python STT service for macOS..."
echo ""

# 1. Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not found. Install via: brew install python@3.11"
    exit 1
fi

echo "✅ Python: $(python3 --version)"

# 2. Check ffmpeg (needed by pydub for audio conversion)
if ! command -v ffmpeg &> /dev/null; then
    echo "⚠️  ffmpeg not found. Installing via Homebrew..."
    brew install ffmpeg
else
    echo "✅ ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
fi

# 3. Create virtual environment
if [ ! -d "venv" ]; then
    echo ""
    echo "📦 Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate
echo "✅ Virtual environment activated"

# 4. Upgrade pip
pip install --upgrade pip setuptools wheel > /dev/null 2>&1

# 5. Install PyTorch for macOS (CPU/MPS)
echo ""
echo "🔥 Installing PyTorch for macOS (MPS support)..."
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu 2>/dev/null || \
    pip install torch torchaudio

# 6. Install Cython and packaging (NeMo build dependencies)
echo ""
echo "📦 Installing build dependencies..."
pip install Cython packaging

# 7. Install NeMo toolkit (ASR only)
echo ""
echo "🤖 Installing NVIDIA NeMo toolkit (ASR)..."
pip install "nemo_toolkit[asr]"

# 8. Install other dependencies
echo ""
echo "📦 Installing Flask, pydub, soundfile..."
pip install flask flask-cors pydub soundfile

echo ""
echo "════════════════════════════════════════════════"
echo "✅ Setup complete!"
echo ""
echo "To start the STT service:"
echo "  source venv/bin/activate"
echo "  python stt_service.py"
echo ""
echo "First run will download the Parakeet model (~1.2GB)."
echo "The model will use MPS (Metal) on Apple Silicon if available."
echo "════════════════════════════════════════════════"
