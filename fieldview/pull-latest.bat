@echo off
title Water Ops Viewer - Pull Latest
cd /d "%~dp0\.."
echo ========================================
echo   Water Ops Viewer - Pull Latest
echo ========================================
echo.

for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
echo Current branch: %BRANCH%
echo.

echo Fetching latest changes...
git pull origin %BRANCH%
echo.

echo Checking dependencies...
cd water-ops-viewer
npm install
echo.

echo ========================================
echo   Up to date! Run start-server.bat to start.
echo ========================================
echo.
pause
