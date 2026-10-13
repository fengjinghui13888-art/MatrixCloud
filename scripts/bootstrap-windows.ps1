param([switch]$SkipDockerStart)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -lt 5) { throw "需要 PowerShell 5.1 或更高版本" }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw "请先启用 WSL2" }
if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw "请安装 Docker Desktop 并启用 WSL2 集成" }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $SkipDockerStart) { docker compose -f (Join-Path $root "compose.dev.yaml") up -d --build }
docker compose -f (Join-Path $root "compose.dev.yaml") ps
Write-Output "矩阵云开发环境已准备：http://127.0.0.1:8080"
