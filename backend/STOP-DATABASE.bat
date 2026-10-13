@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Please stop the backend before stopping PostgreSQL.
".venv\Scripts\python.exe" -X utf8 tools\local_postgres.py stop
if errorlevel 1 pause
