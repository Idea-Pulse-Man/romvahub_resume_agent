# Romva Resume Agent - install for the current Windows user.
#
#   1. installs the agent's one dependency (puppeteer-core)
#   2. builds the window (gui\RomvaAgent.exe, ~35 KB, with the C# compiler that comes with Windows)
#   3. makes the window start with Windows (in the tray); it runs the agent and restarts it if it stops
#   4. opens the window (stopped): "Change token..." (paste the Romva token), "Save folder...", then "Start"
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

# A window already open holds the .exe: close it (the agent itself keeps running; the new window picks it up).
Get-Process RomvaAgent -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
powershell -ExecutionPolicy Bypass -File "$here\gui\build.ps1"
if ($LASTEXITCODE -ne 0) { exit 1 }
$exe = Join-Path $here 'gui\RomvaAgent.exe'

# The old way (a hidden logon task) is replaced by the window starting with Windows.
if (Get-ScheduledTask -TaskName 'Romva Resume Agent' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'Romva Resume Agent' -Confirm:$false
  Write-Host 'Removed the old logon task.'
}
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'RomvaResumeAgent' -Value "`"$exe`" --tray"

Start-Process $exe
Write-Host ''
Write-Host 'Installed. The Romva Resume Agent window is open (and starts with Windows, in the tray).' -ForegroundColor Green
Write-Host 'In it: "Change token..." (paste your Romva token), "Save folder..." (where the Resumes go), then "Start".'
Write-Host 'Sign in to ChatGPT in the Chrome window it opens.'
Write-Host "Stop and remove: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1"
