@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if not defined CUHK_LMS_HOME set "CUHK_LMS_HOME=%~dp0.cuhk-data"
set "LMS_HOME=%CUHK_LMS_HOME%"
set "LMS_UPDATE_CHECK=0"
if /I "%~1"=="--fixture" (set "CUHK_CLASSIC_MODE=offline-fixture") else (set "CUHK_CLASSIC_MODE=live")
if not exist "%~dp0node_modules\electron\dist\electron.exe" goto missing_electron
call npm.cmd run build
if errorlevel 1 goto failed
if not exist "%~dp0dist\src\dashboard\app.js" goto missing_build
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "NODE_PATH="
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --dashboard
exit /b %errorlevel%
:missing_electron
echo Electron is missing. Run npm.cmd ci first.
exit /b 1
:missing_build
echo The Dashboard build did not produce dist\src\dashboard\app.js.
exit /b 1
:failed
echo The TypeScript build failed.
exit /b 1
