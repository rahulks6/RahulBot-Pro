@echo off
rem Double-click to run scripts\push-worker-image.ps1 (execution policy bypassed for this run only).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-worker-image.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
