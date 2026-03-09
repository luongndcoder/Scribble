# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all
import os

datas = []
binaries = []
hiddenimports = [
    'uvicorn.logging', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan', 'uvicorn.lifespan.on',
    'fastapi', 'starlette', 'starlette.responses', 'starlette.background',
    'multipart', 'multipart.multipart', 'httpx', 'groq', 'openai', 'docx',
    'onnxruntime', 'onnxruntime.capi', 'scipy', 'scipy.signal',
    'riva', 'riva.client', 'grpcio', 'grpcio_tools', 'charset_normalizer',
    # Windows-specific
    'multiprocessing', 'multiprocessing.popen_spawn_win32',
    'encodings', 'encodings.utf_8', 'encodings.ascii',
    'pkg_resources', 'pkg_resources.extern',
]

# Bundle ONNX model
datas += [('models', 'models')]

# Collect riva client protos
tmp_ret = collect_all('riva')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['torch', 'torchaudio', 'wespeaker', 's3prl', 'tensorflow',
              'keras', 'matplotlib', 'PIL', 'cv2', 'pandas', 'sklearn',
              'pytest', 'IPython', 'notebook', 'jupyter'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='scribble-sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
