# Romva Resume Agent - install for the current Windows user.
#
#   1. installs the agent's one dependency (puppeteer-core)
#   2. runs setup: the Romva token, save folder, ChatGPT sign-in
#   3. registers a logon task, so the agent starts by itself (hidden) at every sign-in
#   4. starts it now
#
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again.' -ForegroundColor Red
  exit 1
}
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) {
  Write-Host "Node.js 20 or newer is needed (found $(node --version))." -ForegroundColor Red
  exit 1
}

Write-Host 'Installing...'
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
node src/setup.js
if ($LASTEXITCODE -ne 0) { exit 1 }

$taskName = 'Romva Resume Agent'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$here\run-hidden.vbs`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Makes Resumes and cover letters for romva.space with ChatGPT, in the background.' -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host ''
Write-Host "Installed. The agent runs now and starts by itself at every sign-in." -ForegroundColor Green
Write-Host "Log: $env:APPDATA\RomvaResumeAgent\agent.log"
Write-Host "Stop and remove: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1"
