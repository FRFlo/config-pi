@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-extensions.ps1" %*
exit /b %errorlevel%
