@echo off
setlocal
cd /d "%~dp0"
echo STEM Local Processor - first-time setup
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.10-3.12 is required. Install it from https://www.python.org/downloads/windows/
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
  if errorlevel 1 (
    echo Could not create the Python environment.
    pause
    exit /b 1
  )
)
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
  echo Processor installation failed. Check your internet connection and available disk space.
  pause
  exit /b 1
)
echo.
echo STEM local processor is starting at http://127.0.0.1:8765
echo Keep this window open while separating audio in STEM.
python worker.py
pause
