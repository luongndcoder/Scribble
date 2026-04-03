# -*- mode: python ; coding: utf-8 -*-
import sys
from PyInstaller.utils.hooks import collect_all

datas = [
    ('models/voxceleb_CAM++.onnx', 'models'),
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
]
tmp_ret = collect_all('riva')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('soniox')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# ── Aggressive excludes ──
# These are transitive deps pulled in by collect_all('riva') and other packages.
# None of these are needed for the sidecar (FastAPI + STT).
excludes = [
    # Deep Learning frameworks (NOT needed — we use onnxruntime only)
    'torch', 'torchvision', 'torchaudio', 'torchtext',
    'tensorflow', 'tf2onnx', 'keras',
    'transformers', 'diffusers', 'accelerate', 'safetensors',
    'modelscope',

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
