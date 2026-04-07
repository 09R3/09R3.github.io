@echo off
title Water Ops Viewer
cd /d "%~dp0"
echo Starting Water Ops Viewer...
echo Open your browser to http://localhost:3000
echo.
echo Press Ctrl+C to stop the server.
echo.
node server.js
pause
