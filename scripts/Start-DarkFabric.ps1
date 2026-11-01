param([string]$StatePath = $(if ($env:DARK_FABRIC_HOME) { $env:DARK_FABRIC_HOME } else { Join-Path $PSScriptRoot '../.darkfabric' }), [switch]$RespectStop)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'service.js'), 'start', '--home', [IO.Path]::GetFullPath($StatePath))
if ($RespectStop) { $arguments += '--respect-stop' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Dark Fabric did not start; see the diagnostics above.' }
