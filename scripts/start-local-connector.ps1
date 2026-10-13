param(
  [string]$Node = "",
  [ValidateRange(1, 65535)][int]$Port = 47821,
  [string]$DataDir = ""
)
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$connector = Join-Path $root "local-connector\connector.mjs"
if (-not (Test-Path -LiteralPath $connector -PathType Leaf)) { throw "连接器文件缺失，请恢复完整项目。" }

function Test-ConnectorData([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
  if (Test-Path -LiteralPath (Join-Path $Directory "cloud-device.json") -PathType Leaf) { return $true }
  foreach ($accountDirectory in @(Get-ChildItem -LiteralPath $Directory -Directory)) {
    if ((Test-Path -LiteralPath (Join-Path $accountDirectory.FullName "session.json") -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $accountDirectory.FullName "chrome-profile") -PathType Container)) { return $true }
  }
  return $false
}
function Normalize-Directory([string]$Directory) {
  return [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@('\', '/'))
}
function Quote-ProcessArgument([string]$Value) {
  return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}

$userDirectory = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($userDirectory)) { $userDirectory = [Environment]::GetFolderPath("UserProfile") }
$userData = Join-Path $userDirectory ".matrix-cloud"
$legacyData = Join-Path $root "work\grey\local-connector"
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = if (Test-ConnectorData $userData) { $userData }
    elseif ((Test-ConnectorData $legacyData) -or (Test-Path -LiteralPath (Join-Path $legacyData "connector-token") -PathType Leaf)) { $legacyData }
    else { $userData }
}
$data = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
$bundled = Join-Path $root "runtime\node\node.exe"
if ([string]::IsNullOrWhiteSpace($Node)) { $Node = if (Test-Path -LiteralPath $bundled -PathType Leaf) { $bundled } else { "node" } }
$runtime = Get-Command $Node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $runtime) { throw "找不到 Node 运行时。请安装项目要求的 Node，或用 -Node 指定已有运行时。" }
$Node = $runtime.Source

function Get-PortOwner {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') } | Select-Object -First 1
}
function Get-ConnectorHealth {
  try {
    $value = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 1
    if ($value.ok -eq $true -and $value.connector -eq 'matrix-cloud-local' -and
        $value.version -eq 4 -and $value.capabilities -contains 'reconnect') { return $value }
  } catch { }
  return $null
}
function Test-SameConnector($Listener) {
  $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($Listener.OwningProcess)"
  if (-not $running -or $running.ExecutablePath -ne $Node -or -not $running.CommandLine) { return $false }
  $scriptPattern = '(?:^|\s)(?:"' + [regex]::Escape($connector) + '"|' + [regex]::Escape($connector) + ')(?=\s|$)'
  if (-not [regex]::IsMatch($running.CommandLine, $scriptPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $false }
  $directoryArgument = [regex]::Match($running.CommandLine, '(?:^|\s)--data-dir\s+(?:"([^"]+)"|(\S+))')
  $runningData = if ($directoryArgument.Success) {
    if ($directoryArgument.Groups[1].Success) { $directoryArgument.Groups[1].Value } else { $directoryArgument.Groups[2].Value }
  } else { $userData }
  return (Normalize-Directory $runningData) -eq (Normalize-Directory $data)
}

$listener = Get-PortOwner
if ($listener) {
  if ((Get-ConnectorHealth) -and (Test-SameConnector $listener)) {
    Write-Output "本机连接器已在运行：http://127.0.0.1:$Port"
    Write-Output "数据目录：$data"
    exit 0
  }
  throw "端口 $Port 已被其他实例占用，未停止现有进程。请使用原数据目录或另选 -Port。"
}

New-Item -ItemType Directory -Force -Path $data | Out-Null
$logDirectory = Join-Path $data "logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$logName = "connector-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff")
$stdout = Join-Path $logDirectory ($logName + ".stdout.log")
$stderr = Join-Path $logDirectory ($logName + ".stderr.log")
$argumentLine = (Quote-ProcessArgument $connector) + ' --data-dir ' + (Quote-ProcessArgument $data) + ' --port ' + $Port
$child = Start-Process -FilePath $Node -ArgumentList $argumentLine -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  $child.Refresh()
  if ($child.HasExited) { throw "连接器启动失败，请查看本机日志：$stderr" }
  if (Get-ConnectorHealth) {
    $owner = Get-PortOwner
    if ($owner -and $owner.OwningProcess -eq $child.Id) {
      Write-Output "本机连接器已启动：http://127.0.0.1:$Port"
      Write-Output "数据目录：$data"
      Write-Output "本机日志：$logDirectory"
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
}
# This is the process created by this attempt; never stop a different port owner.
if (-not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
throw "连接器未通过健康检查，请查看本机日志：$stderr"
