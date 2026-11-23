@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" goto missing
set "ELECTRON_RUN_AS_NODE="
start "" "%CD%\node_modules\electron\dist\electron.exe" "%CD%"
exit /b 0

:missing
echo Electron is not installed in this project folder.
echo Run "Setup ArtStation Archiver.bat" once, then try again.
pause
exit /b 1
