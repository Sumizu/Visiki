@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Configure-MCP.ps1" -PackageRoot "%~dp0."
set "VISIKI_MCP_EXIT=%ERRORLEVEL%"
pause
exit /b %VISIKI_MCP_EXIT%
