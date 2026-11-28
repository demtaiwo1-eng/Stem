@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   STEM - Free Local Audio Processor
echo ============================================
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or 3.12 is required.
  echo Install it from https://www.python.org/downloads/windows/
  echo Select "Add Python to PATH" during installation.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv 2>nul
  if errorlevel 1 py -3.11 -m venv .venv
  if errorlevel 1 (
    echo Could not create the STEM Python environment.
    pause
    exit /b 1
  )
)
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
echo Installing CPU-only PyTorch to avoid downloading unused GPU libraries...
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 (
  echo CPU PyTorch installation failed. Check your internet connection.
  pause
  exit /b 1
)
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo STEM processor installation failed. Check your internet connection and disk space.
  pause
  exit /b 1
)
echo.
echo Opening STEM in your browser...
start "" "https://demtaiwo1-eng.github.io/stem.github.io/"
echo.
echo STEM local processor is starting at http://127.0.0.1:8765
echo Keep this window open while separating audio in STEM.
echo Press Ctrl+C to stop the processor.
python worker.py
pause
