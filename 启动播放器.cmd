@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-hertz.ps1" -Mode Desktop
if errorlevel 1 pause
