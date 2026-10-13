@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
".venv\Scripts\python.exe" -X utf8 tools\local_postgres.py start
if errorlevel 1 pause
