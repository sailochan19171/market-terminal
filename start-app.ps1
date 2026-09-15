# Starts the Market Terminal: the Next.js web app, which also runs the background data jobs
# (data worker, company refreshes and the weekday 19:30 update) in a child process.
#
# Registered to run at logon:
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#       -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\Home\bse-pipeline\start-app.ps1" `
#       -WorkingDirectory "C:\Users\Home\bse-pipeline"
#   Register-ScheduledTask -TaskName "Market Terminal - web app" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn)
#
# Open http://localhost:3000. Job log: data\logs\jobs.log. Set MARKET_JOBS=off to run the site without jobs.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root "frontend"
$logs = Join-Path $root "data\logs"
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

# Already serving? Nothing to do.
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 0 }

Set-Location $app
if (-not (Test-Path (Join-Path $app ".next\BUILD_ID"))) {
    & npm run build *>> (Join-Path $logs "web-build.log")
}
& npx next start -p 3000 *>> (Join-Path $logs "web.log")
