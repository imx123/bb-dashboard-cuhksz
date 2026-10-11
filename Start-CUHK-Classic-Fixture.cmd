@echo off
setlocal DisableDelayedExpansion
call "%~dp0Start-CUHK-Classic.cmd" --fixture
exit /b %errorlevel%
