$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
Push-Location $taskProject
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.14 or 24.x is required.' }
    node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<14)||major>=25)process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.14 or 24.x is required.' }
    if (-not (Test-Path -LiteralPath 'node_modules/tsx/dist/cli.mjs')) { throw 'Install project dependencies with pnpm 11.25.0 first.' }

    $env:HOST = '127.0.0.1'
    $env:PORT = '4174'
    $env:PUBLIC_ORIGIN = 'http://127.0.0.1:4174'
    $env:CUSTOMER_PUBLIC_ORIGIN = $env:PUBLIC_ORIGIN
    $env:MATRIX_CLOUD_URL = $env:PUBLIC_ORIGIN
    $env:DATA_DIR = './work/local-dev'
    foreach ($taskVariable in @('DATABASE_URL','DATABASE_URL_FILE','SYNC_DATA_DIR','DIST_DIR','LOCAL_CONNECTOR_URL','LOCAL_CONNECTOR_TOKEN','MCP_SERVICE_TOKEN','STUDIO_TOKEN','TLS_CERT','TLS_KEY','DEPLOYMENT_HOLD_FILE','PLATFORM_ADMIN_USERNAME')) {
        Remove-Item -LiteralPath ('Env:' + $taskVariable) -ErrorAction SilentlyContinue
    }

    $taskListener = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskListener) {
        $taskServer = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $taskListener.OwningProcess)
        $taskParent = if ($taskServer) { Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $taskServer.ParentProcessId) }
        $taskScriptPattern = [regex]::Escape((Join-Path $taskProject 'scripts\start-local-dev.ps1')) + '(?:"|\s|$)'
        if (-not $taskServer -or $taskServer.CommandLine -notmatch '--import tsx server/grey\.ts(?:"|\s|$)' -or -not $taskParent -or $taskParent.CommandLine -notmatch $taskScriptPattern) {
            throw 'Port 4174 belongs to another instance. The existing process was preserved.'
        }
        node -e "fetch('http://127.0.0.1:4174/api/health',{signal:AbortSignal.timeout(2000)}).then(async r=>{const h=await r.json();if(!r.ok||h.ok!==true||h.mode!=='grey'||h.storage!=='sqlite'||h.demo!==false)process.exitCode=1;}).catch(()=>{process.exitCode=1;})"
        if ($LASTEXITCODE -ne 0) { throw 'The local instance is not healthy. Check work/local-dev/server.stderr.log.' }
        Write-Output 'Local development is already running: http://127.0.0.1:4174'
        return
    }

    node node_modules/typescript/bin/tsc -b
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    node node_modules/vite/bin/vite.js build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    Write-Output 'Local development: http://127.0.0.1:4174 (SQLite, work/local-dev). Press Ctrl+C to stop.'
    node --import tsx server/grey.ts
    if ($LASTEXITCODE -ne 0) { throw 'Local server failed.' }
} finally {
    Pop-Location
}
