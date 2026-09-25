@echo off
rem AI Story Studio installer. Double-click this file.
rem Runs install.ps1 for this session only (the system execution policy is not changed).
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
if %RC% neq 0 (
  echo Installation did not finish. See installer\windows\install.log and docs\TROUBLESHOOTING_WINDOWS.md
) else (
  echo Done.
)
pause
exit /b %RC%
