@echo off
rem Checks Node.js, Python and FFmpeg without installing anything.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -CheckOnly
pause
