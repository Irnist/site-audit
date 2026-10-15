@echo off
rem Double-click to open the Site Audit app. The small minimized window runs it and closes on its own afterwards.
cd /d "%~dp0"
where node >nul 2>nul || (echo Site Audit needs Node.js: https://nodejs.org & pause & exit /b 1)
if not exist node_modules\ (
  echo Installing Site Audit's parts, one time only...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
start "Site Audit" /min node app.mjs
