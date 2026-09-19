@echo off
set "XHB=%TEMP%\XHarness-Browser-Bounds-20261012.ps1"
curl.exe --fail --silent --show-error http://10.0.2.2:18125/guest.ps1 --output "%XHB%"
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%XHB%"
if errorlevel 1 (echo BOUNDS_LAB_FAILED) else (echo BOUNDS_LAB_FINISHED)
