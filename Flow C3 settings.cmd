@echo off
rem The C3 channel's own Flow connector: its own Chrome profile (a separate Google sign-in), Chrome port, Studio port
rem and video folder, so C3 never touches the C5 account or videos. Used by the other "C3" files in this folder.
set FLOW_MCP_NAME=C3
set FLOW_MCP_HOME=%USERPROFILE%\.flow-mcp-c3
set FLOW_MCP_CDP_PORT=9334
set FLOW_MCP_PORT=8788
set FLOW_MCP_OUTPUT=%USERPROFILE%\youtube-studio\c3-videos
set FLOW_MCP_OTHER_HOME=%USERPROFILE%\.flow-mcp
