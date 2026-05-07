@echo off
REM build-windows.bat — Build Scribble for Windows (onedir + tar.gz layout)
REM Prerequisites: Python 3.10+, Node.js 20+, pnpm, Rust + MSVC, ffmpeg, curl

setlocal enabledelayedexpansion

echo === Building Scribble for Windows ===
echo.

REM Step 1: Build Python sidecar (onedir mode)
echo [1/4] Building Python sidecar...
cd src-python
pip install -r requirements.txt || (echo ERROR: pip install failed & exit /b 1)

REM Download ONNX diarizer model if missing
if not exist models\voxceleb_CAM++.onnx (
    echo [1/4] Downloading ONNX diarizer model...
    curl -L -o models\voxceleb_CAM++.onnx "https://wespeaker-1256283475.cos.ap-shanghai.myqcloud.com/models/voxceleb/voxceleb_CAM++.onnx" || (echo ERROR: ONNX download failed & exit /b 1)
)

python -m PyInstaller scribble-sidecar.spec --noconfirm --clean || (echo ERROR: Sidecar build failed & exit /b 1)
cd ..
echo [OK] Sidecar built at src-python\dist\scribble-sidecar\

REM Step 2: Package sidecar into tar.gz + create launcher shim
echo.
echo [2/4] Packaging sidecar...
if not exist src-tauri\binaries mkdir src-tauri\binaries

REM Strip unnecessary files to reduce installer size
if exist src-python\dist\scribble-sidecar\_internal\grpc_tools rmdir /S /Q src-python\dist\scribble-sidecar\_internal\grpc_tools
for /d /r src-python\dist\scribble-sidecar\_internal %%d in (tests __pycache__) do if exist "%%d" rmdir /S /Q "%%d" 2>nul
for /d /r src-python\dist\scribble-sidecar\_internal %%d in (*.dist-info) do if exist "%%d" rmdir /S /Q "%%d" 2>nul

REM Compress sidecar folder (Windows 10+ has built-in bsdtar)
tar -czf src-tauri\binaries\sidecar-dist.tar.gz -C src-python\dist scribble-sidecar || (echo ERROR: tar compress failed & exit /b 1)

REM Create externalBin launcher shim (Tauri requires binary at this exact path).
REM Shim is never executed at runtime — Rust extracts tar.gz to %USERPROFILE%\.voicescribe\sidecar.
(
    echo @echo off
    echo "%%~dp0sidecar-dist\scribble-sidecar.exe" %%*
) > src-tauri\binaries\scribble-sidecar-x86_64-pc-windows-msvc.exe

echo [OK] Sidecar packaged

REM Step 3: Bundle ffmpeg
echo.
echo [3/4] Bundling ffmpeg...
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo WARN: ffmpeg not found in PATH — audio export may not work in built app
) else (
    for /f "delims=" %%i in ('where ffmpeg') do (
        copy /Y "%%i" src-tauri\binaries\ffmpeg.exe >nul
        goto :ffmpeg_done
    )
    :ffmpeg_done
    echo [OK] ffmpeg bundled
)

REM Step 4: Build Tauri NSIS installer
echo.
echo [4/4] Installing frontend deps + building Tauri...
call pnpm install || (echo ERROR: pnpm install failed & exit /b 1)
call npx tauri build -b nsis --target x86_64-pc-windows-msvc || (echo ERROR: Tauri build failed & exit /b 1)

echo.
echo === Build complete! ===
echo Installer: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\
dir src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*.exe

endlocal
