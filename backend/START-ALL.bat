@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "MATRIX_PY=%~dp0.venv\Scripts\python.exe"
if not exist "%MATRIX_PY%" set "MATRIX_PY=%~dp0..\.venv\Scripts\python.exe"
if not exist "%MATRIX_PY%" (
  echo 请先运行 backend\SETUP.bat 配置 Python 环境。
  pause
  exit /b 1
)
"%MATRIX_PY%" -X utf8 tools\local_workbench.py %*
if errorlevel 1 pause
