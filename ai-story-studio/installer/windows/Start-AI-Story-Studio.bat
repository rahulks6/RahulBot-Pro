@echo off
rem Starts AI Story Studio and opens it in your browser. Close this window to stop the app;
rem the app terminates any cloud GPU it started (and re-checks for leftovers on the next start).
setlocal
cd /d "%~dp0..\.."
if not exist "dist\src\web\server.js" (
  echo The app is not built yet. Run installer\windows\Install-AI-Story-Studio.bat first.
  pause
  exit /b 1
)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3000/'"
call npm start
pause
