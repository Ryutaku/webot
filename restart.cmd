@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-webot.ps1"
set "EXIT_CODE=%errorlevel%"
if /I not "%~1"=="nopause" pause
exit /b %EXIT_CODE%
