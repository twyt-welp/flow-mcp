@echo off
rem Double-click once, with Claude closed: adds the "flow-c3" connector to Claude's settings (backed up first).
cd /d "%~dp0"
node scripts\add-c3-connector.mjs
pause
