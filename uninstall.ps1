# Romva Resume Agent - stop it and remove the logon task.
# Keeps the settings, the sign-in and the ChatGPT Chrome profile; pass -Purge to delete them too.

param([switch]$Purge)

$taskName = 'Romva Resume Agent'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host 'Logon task removed.'
}

# The agent itself (node running src\agent.js from this folder).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*$here*agent.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped the agent (process $($_.ProcessId))." }

if ($Purge) {
  Remove-Item -Recurse -Force "$env:APPDATA\RomvaResumeAgent" -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\RomvaResumeAgent" -ErrorAction SilentlyContinue
  Write-Host 'Settings, sign-in and the ChatGPT profile deleted.'
}
