@echo off
REM build-windows.bat — Build Scribble for Windows
REM Prerequisites: Python 3.10+, Node.js 20+, Rust, pnpm

echo === Building Scribble for Windows ===
echo.

REM Step 1: Build Python sidecar
echo [1/3] Building Python sidecar...
cd src-python
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean
if errorlevel 1 (
    echo ERROR: Sidecar build failed
    exit /b 1
)
copy /Y dist\scribble-sidecar.exe ..\src-tauri\binaries\scribble-sidecar-x86_64-pc-windows-msvc.exe
cd ..
echo [OK] Sidecar built

REM Step 2: Install frontend deps
echo.
echo [2/3] Installing frontend dependencies...
call pnpm install

REM Step 3: Build Tauri
echo.
echo [3/3] Building Tauri NSIS installer...
call npx tauri build -b nsis
if errorlevel 1 (
    echo ERROR: Tauri build failed
    exit /b 1
)

echo.
echo === Build complete! ===
echo Output: src-tauri\target\release\bundle\nsis\
dir src-tauri\target\release\bundle\nsis\*.exe
