@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  call SETUP.bat
  if errorlevel 1 (pause & exit /b 1)
)
if not exist "..\frontend\node_modules\vite\bin\vite.js" (
  call SETUP.bat
  if errorlevel 1 (pause & exit /b 1)
)
".venv\Scripts\python.exe" -X utf8 run.py all %*
if errorlevel 1 pause
