param([string]$Node = "")
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bundled = Join-Path $root "runtime\node\node.exe"
if ([string]::IsNullOrWhiteSpace($Node)) { $Node = if (Test-Path $bundled) { $bundled } else { "node" } }
& $Node (Join-Path $root "scripts\preflight.mjs") $args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
