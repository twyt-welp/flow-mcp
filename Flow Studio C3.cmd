@echo off
rem Double-click to start the C3 Flow Studio (http://127.0.0.1:8788). Close this window to stop it.
cd /d "%~dp0"
call "Flow C3 settings.cmd"
if not exist dist call npm run build
node dist\studio.js
pause
