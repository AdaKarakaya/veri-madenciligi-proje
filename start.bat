@echo off
title Load Trading Bot
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed: get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules\@anthropic-ai\sdk (
  echo Installing Borsa Yardimcisi's library once...
  call npm install --no-audit --no-fund
)
node src\index.js --open
pause
