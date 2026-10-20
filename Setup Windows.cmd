@echo off
setlocal DisableDelayedExpansion
set "BROWSER_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "BROWSER_ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "BROWSER_ARCH=arm64"
set "BROWSER_NODE=%~dp0runtime\win-%BROWSER_ARCH%\node.exe"
if not exist "%BROWSER_NODE%" set "BROWSER_NODE=node"
"%BROWSER_NODE%" "%~dp0setup.mjs"
if errorlevel 1 (
 echo Check that Node.js 24 or newer is installed and available.
 pause
 exit /b 1
)
pause
