@echo off
title WaterOps Server
cd /d "%~dp0"
echo Starting WaterOps server...
echo Open your browser to http://localhost:3000
echo.
echo Press Ctrl+C to stop the server.
echo.
node server.js
pause
