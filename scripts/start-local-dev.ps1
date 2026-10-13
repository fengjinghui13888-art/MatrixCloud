$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
Push-Location $taskProject
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.14 or 24.x is required.' }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm 11.25.0 is required.' }
    if (-not (Test-Path -LiteralPath 'backend/node_modules/tsx')) { throw 'Run pnpm install --frozen-lockfile first.' }
    $env:HOST = '127.0.0.1'
    $env:PORT = '4174'
    $env:PUBLIC_ORIGIN = 'http://127.0.0.1:5173'
    $env:CUSTOMER_PUBLIC_ORIGIN = $env:PUBLIC_ORIGIN
    $env:MATRIX_CLOUD_URL = $env:PUBLIC_ORIGIN
    $env:DATA_DIR = './work/local-dev'
    foreach ($taskVariable in @('DATABASE_URL','DATABASE_URL_FILE','SYNC_DATA_DIR','DIST_DIR','LOCAL_CONNECTOR_URL','LOCAL_CONNECTOR_TOKEN','MCP_SERVICE_TOKEN','STUDIO_TOKEN','TLS_CERT','TLS_KEY','DEPLOYMENT_HOLD_FILE','PLATFORM_ADMIN_USERNAME','TRUSTED_PROXY_IPS','TRUST_LOOPBACK_PROXY')) {
        Remove-Item -LiteralPath ('Env:' + $taskVariable) -ErrorAction SilentlyContinue
    }
    foreach ($taskPort in @(4174,5173)) {
        if (Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue) {
            throw ('Port ' + $taskPort + ' is occupied. The existing process was preserved.')
        }
    }
    pnpm typecheck
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
    Write-Output 'Frontend: http://127.0.0.1:5173; backend API: http://127.0.0.1:4174/api/health. Ctrl+C stops both.'
    pnpm dev
    if ($LASTEXITCODE -ne 0) { throw 'Local development failed.' }
} finally {
    Pop-Location
}
