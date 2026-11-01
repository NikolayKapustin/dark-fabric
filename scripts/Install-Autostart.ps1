param([string]$StatePath = (Join-Path $PSScriptRoot '../.darkfabric'))
$ErrorActionPreference = 'Stop'
$startScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-DarkFabric.ps1'))
$state = [IO.Path]::GetFullPath($StatePath)
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startScript + '" -StatePath "' + $state + '" -RespectStop'
$taskName = 'Dark Fabric'
try {
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Resume the local Dark Fabric supervisor after user logon.' -Force | Out-Null
    Write-Output 'Installed Windows Task Scheduler logon trigger: Dark Fabric'
} catch {
    # A per-user Startup shortcut requires no elevation and works when task creation is restricted.
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startup 'Dark Fabric.lnk'
    $shellObject = New-Object -ComObject WScript.Shell
    $shortcut = $shellObject.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = $arguments
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Output "Task Scheduler unavailable; installed per-user startup shortcut: $shortcutPath"
}
