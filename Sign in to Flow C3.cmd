@echo off
rem Double-click once to sign the C3 Flow window in to the C3 Google account (not the C5 one).
cd /d "%~dp0"
call "Flow C3 settings.cmd"
if not exist dist call npm run build
node dist\login.js
pause
