@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_node
echo Installing the dependencies pinned in package-lock.json.
echo This needs Internet access. No administrator rights are required.
call npm ci
if errorlevel 1 goto failed
if exist "node_modules\electron\dist\electron.exe" goto ready
node "node_modules\electron\install.js"
if errorlevel 1 goto failed
:ready
echo.
echo Ready. Double-click "Start ArtStation Archiver.bat" to launch.
pause
exit /b 0

:missing_node
echo Install Node.js LTS from https://nodejs.org/ with the npm option.
echo Then run this setup again. The program itself does not need Codex.
pause
exit /b 1

:failed
echo.
echo Setup did not finish. Check the error above and try again.
pause
exit /b 1
