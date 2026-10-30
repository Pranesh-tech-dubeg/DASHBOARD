@echo off
cd /d "%~dp0"
echo ===================================================
echo   WasteWatch - Industrial IoT Smart Waste Platform
echo ===================================================
echo Starting local HTTP server on http://localhost:8080 ...

start /b "" python -m http.server 8080 >nul 2>&1
timeout /t 1 /nobreak >nul

set "URL=http://localhost:8080"

where chrome >nul 2>&1
if %errorlevel%==0 (
  start chrome "%URL%"
  goto :done
)

where msedge >nul 2>&1
if %errorlevel%==0 (
  start msedge "%URL%"
  goto :done
)

start "" "%URL%"

:done
echo Dashboard opened in browser at %URL%
