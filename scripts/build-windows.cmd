@echo off
rem Runs build-windows.ps1 past the default execution policy. Arguments pass through:
rem   scripts\build-windows.cmd -SkipTests --bundles nsis
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
set "PICSEARCH_RC=%ERRORLEVEL%"
rem Double-clicked: keep the window open long enough to read the result.
echo %CMDCMDLINE% | findstr /i /c:" /c " >nul && pause
exit /b %PICSEARCH_RC%
