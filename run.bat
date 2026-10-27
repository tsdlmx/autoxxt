@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没检测到 node，请先安装 Node.js 18+ : https://nodejs.org/
  pause
  exit /b 1
)

node src\index.js %*
echo.
pause
