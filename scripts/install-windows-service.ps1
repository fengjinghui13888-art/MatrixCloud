param([string]$Node = "")
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$task = "MatrixCloudLocalConnector"
$bundled = Join-Path $root "runtime\node\node.exe"
if ([string]::IsNullOrWhiteSpace($Node)) { $Node = if (Test-Path $bundled) { $bundled } else { "node" } }
if (-not (Test-Path $Node) -and $Node -ne "node") { throw "找不到 Node 运行时：$Node" }
$data = Join-Path $root "work\grey\local-connector"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$argumentLine = '"{0}" --data-dir "{1}" --port 47821' -f (Join-Path $root "local-connector\connector.mjs"), $data
$action = New-ScheduledTaskAction -Execute $Node -Argument $argumentLine -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Description "Matrix Cloud local connector" -Force | Out-Null
Write-Output "已设置登录时自动启动本机连接器：$task"
