@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\vite\bin\vite.js" (
  call pnpm install --frozen-lockfile
  if errorlevel 1 (pause & exit /b 1)
)
call pnpm dev
if errorlevel 1 pause
