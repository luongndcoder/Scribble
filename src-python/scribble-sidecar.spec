# -*- mode: python ; coding: utf-8 -*-
import sys
import platform
from PyInstaller.utils.hooks import collect_all

datas = [
    ('models/voxceleb_CAM++.onnx', 'models'),
    # Local/offline STT (Tier C) — bundled Vietnamese sherpa-onnx model.
    # model_registry._bundled_base() reads <_MEIPASS>/models/local/<model_id>.
    (
        'models/local/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09',
        'models/local/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09',
    ),
]
binaries = []
hiddenimports = [
    'uvicorn.logging',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'fastapi',
    'starlette',
    'starlette.responses',
    'starlette.background',
    'multipart',
    'multipart.multipart',
    'httpx',
    'groq',
    'openai',
    'docx',
    'riva',
    'riva.client',
    'grpcio',
    'charset_normalizer',
    'websockets',
    'onnxruntime',
    'onnxruntime.capi',
    'onnxruntime.capi._pybind_state',
    'sherpa_onnx',
]
tmp_ret = collect_all('riva')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('onnxruntime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('soniox')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# Soniox SDK uses `from websockets.sync.client import connect` for realtime
# STT. Plain `hiddenimports=['websockets']` only pulled the speedups C ext —
# the .py submodules (sync/, client/, etc.) were dropped, causing realtime
# Soniox to fail with ModuleNotFoundError silent-caught by main.py. The
# Soniox file-upload path didn't hit this (uses httpx, not websockets).
tmp_ret = collect_all('websockets')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# certifi ships the CA bundle (cacert.pem) that httpx/requests use by
# default. The stdlib `ssl` module DOESN'T auto-load it — without an
# explicit SSL_CERT_FILE env (set at the top of main.py), websockets.sync
# fails CERTIFICATE_VERIFY_FAILED on TLS handshake to wss://stt-rt.soniox.com.
tmp_ret = collect_all('certifi')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# imageio-ffmpeg bundles a static ffmpeg binary in its wheel. collect_all
# pulls the binary file in as `datas`; at runtime find_ffmpeg() calls
# imageio_ffmpeg.get_ffmpeg_exe() to resolve the absolute path inside the
# PyInstaller _MEIPASS / dist directory. Zero manual setup — no more
# "brew install ffmpeg" prerequisite for end users.
tmp_ret = collect_all('imageio_ffmpeg')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# sherpa-onnx (local Tier C STT) ships native .dylib/.so/.dll + its own bundled
# onnxruntime. collect_all pulls the native libs so PyInstaller doesn't drop them.
tmp_ret = collect_all('sherpa_onnx')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# Local Tier A STT — nemotron via MLX, macOS Apple Silicon ONLY. mlx-audio loads
# its stt model classes dynamically (importlib), so collect_all grabs all
# submodules (incl. nemotron_asr) + mlx native Metal libs (.dylib/.metallib).
# Guarded so Windows/Linux builds (no mlx wheel) skip it cleanly.
if sys.platform == 'darwin' and platform.machine() == 'arm64':
    # transformers/tokenizers/safetensors: nemotron tokenizer + weight loading
    # (tokenizer-only, no torch). regex: transformers lazy-imports it.
    for _pkg in ('mlx', 'mlx_audio', 'huggingface_hub',
                 'transformers', 'tokenizers', 'safetensors', 'regex'):
        tmp_ret = collect_all(_pkg)
        datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# ── Aggressive excludes ──
# These are transitive deps pulled in by collect_all('riva') and other packages.
# None of these are needed for the sidecar (FastAPI + STT).
excludes = [
    # Deep Learning frameworks (NOT needed — we use onnxruntime only)
    'torch', 'torchvision', 'torchaudio', 'torchtext',
    'tensorflow', 'tf2onnx', 'keras',
    'diffusers', 'accelerate',
    'modelscope',
    # NOTE: 'transformers' + 'safetensors' are NOT excluded — mlx-audio's
    # nemotron_asr (Tier A) needs them for tokenizer + weight loading. They run
    # tokenizer-only without torch (torch stays excluded). Only collected on
    # macOS arm64 (see collect_all block below); absent on Win/Linux builds.

    # LangChain / LLM frameworks (NOT needed — we call API directly)
    'langchain', 'langchain_community', 'langchain_core', 'langchain_text_splitters',
    'langsmith', 'langgraph',

    # AWS / Cloud SDKs
    'botocore', 'boto3', 'aiobotocore', 's3transfer',

    # Data science (NOT needed)
    'pandas', 'pyarrow', 'datasets', 'sklearn', 'scikit-learn',
    'sympy', 'numba', 'llvmlite',
    'matplotlib', 'PIL', 'pillow', 'cv2', 'opencv',
    'networkx', 'nltk', 'spacy',

    # Jupyter / IPython
    'IPython', 'ipykernel', 'ipywidgets', 'jupyter', 'jupyter_client',
    'jupyter_core', 'notebook', 'nbformat', 'nbconvert',
    'jedi', 'parso', 'traitlets',

    # ML experiment tracking
    'wandb', 'tensorboard', 'mlflow',
    'fontTools',

    # Database / ORM (NOT needed)
    'sqlalchemy', 'alembic',

    # gRPC tools (build-time only)
    'grpcio_tools', 'grpc_tools',

    # Other unnecessary
    'tkinter', '_tkinter', 'turtle',
    'doctest',
    'xmlrpc', 'ftplib', 'imaplib', 'smtplib', 'poplib', 'nntplib',
    'test', 'tests',
    'setuptools', 'pip', 'wheel', 'pkg_resources',
    'pygments',
    'pytz',
    'googleapiclient', 'google_auth_httplib2',
    'anthropic',
]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# ── onedir mode: no temp extraction on launch = instant startup ──
exe = EXE(
    pyz,
    a.scripts,
    [],               # binaries/datas go into COLLECT, not EXE
    exclude_binaries=True,
    name='scribble-sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version='version_info.txt' if sys.platform == 'win32' else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='scribble-sidecar',
)
