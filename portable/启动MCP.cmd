@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0runtime\electron\electron.exe" "%~dp0app\mcp\server.cjs" --endpoint-file "%~dp0app\.demo-data\agent-endpoint.json"
exit /b %ERRORLEVEL%
