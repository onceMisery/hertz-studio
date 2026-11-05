@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ui-preview.ps1" -Mode Browser
if errorlevel 1 pause
