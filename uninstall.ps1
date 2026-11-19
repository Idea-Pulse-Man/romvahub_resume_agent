# Romva Resume Agent - stop it, close its window, and stop it starting with Windows.
# Keeps the settings, the token and the ChatGPT Chrome profile; pass -Purge to delete them too.

param([switch]$Purge)

# The window (gui\RomvaAgent.exe) and its start-with-Windows entry.
Get-Process RomvaAgent -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'RomvaResumeAgent' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'HKCU:\Software\RomvaResumeAgent' -ErrorAction SilentlyContinue
Write-Host 'Window closed; it no longer starts with Windows.'

# An old install's logon task.
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
  Write-Host 'Settings, token and the ChatGPT profile deleted.'
}
