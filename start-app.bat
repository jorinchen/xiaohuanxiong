@echo off
chcp 65001 >nul
title 小浣熊移动内核桌面浏览器
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

if not exist "node_modules\electron" (
  echo First run: installing dependencies, please wait...
  call npm.cmd install --loglevel=error
)

call npm.cmd start
if errorlevel 1 (
  echo 小浣熊移动内核桌面浏览器 failed to start. See the message above.
  pause
)
