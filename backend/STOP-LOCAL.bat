@echo off
setlocal
cd /d "%~dp0"
set "MATRIX_PY=%~dp0.venv\Scripts\python.exe"
if not exist "%MATRIX_PY%" set "MATRIX_PY=%~dp0..\.venv\Scripts\python.exe"
"%MATRIX_PY%" -X utf8 tools\local_workbench.py --stop
