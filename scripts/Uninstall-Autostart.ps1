$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName 'Dark Fabric' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'Dark Fabric' -Confirm:$false
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Dark Fabric.lnk'
if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
Write-Output 'Dark Fabric autostart removed. Use Stop-DarkFabric.ps1 to stop the current process.'
