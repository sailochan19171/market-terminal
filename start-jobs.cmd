@echo off
REM Market Terminal data jobs: the announcement watcher, the daily feeds, the orders reader and the publish
REM loops. Started at logon by the shortcut in the Startup folder, and restarted here if it ever exits.
REM
REM Run it by hand with:  start-jobs.cmd
setlocal
set ROOT=C:\Users\Home\bse-pipeline\frontend
set RUNNER=%ROOT%\src\server\jobs\runner.ts
set LOGDIR=%ROOT%\data\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

:loop
REM One runner at a time: if another copy is already going, wait rather than fight over the database.
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*jobs\runner.ts*' -and $_.ProcessId -ne $PID }) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  timeout /t 120 /nobreak >nul
  goto loop
)

echo [%date% %time%] starting the data jobs >> "%LOGDIR%\jobs-restarts.log"
cd /d "%ROOT%"
node --disable-warning=ExperimentalWarning --import tsx "%RUNNER%" >> "%LOGDIR%\jobs.log" 2>&1
echo [%date% %time%] the data jobs exited (code %errorlevel%); restarting in 60s >> "%LOGDIR%\jobs-restarts.log"
timeout /t 60 /nobreak >nul
goto loop
