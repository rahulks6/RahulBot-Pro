@echo off
rem Double-click to run scripts\verify-worker-image.ps1 (execution policy bypassed for this run only).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-worker-image.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
