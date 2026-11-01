param([string]$StatePath = (Join-Path $PSScriptRoot '../.darkfabric'))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$state = [IO.Path]::GetFullPath($StatePath)
if (-not (Test-Path -LiteralPath (Join-Path $state 'remote.json'))) { throw 'Remote connection is not configured.' }
$stopFile = Join-Path $state 'remote.stop'
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$supervisor = Join-Path $root 'scripts/supervisor.js'
$arguments = @(('"' + $supervisor + '"'), '--home', ('"' + $state + '"'), '--role', 'remote')
$process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
Write-Output "Dark Fabric remote supervisor started: PID $($process.Id)"
