param([string]$StatePath = $(if ($env:DARK_FABRIC_HOME) { $env:DARK_FABRIC_HOME } else { Join-Path $PSScriptRoot '../.darkfabric' }))
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'service.js') stop --home ([IO.Path]::GetFullPath($StatePath))
if ($LASTEXITCODE -ne 0) { throw 'Shutdown is still pending; do not start another writer.' }
