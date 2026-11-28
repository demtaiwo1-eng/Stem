@echo off
setlocal
cd /d "%~dp0"
echo STEM Local Processor - first-time setup
where py >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.11 or 3.12 from https://www.python.org/downloads/windows/
  echo Select Add Python to PATH during installation.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv 2>nul
  if errorlevel 1 py -3.11 -m venv .venv
  if errorlevel 1 (
    echo Python 3.11 or 3.12 is required.
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
