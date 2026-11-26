@echo off
setlocal
cd /d "%~dp0"
title DiscordBouyomiBot installer

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。
  echo https://nodejs.org/ から Node.js 20 以上をインストールしてから、もう一度実行してください。
  echo.
  pause
  exit /b 1
)

echo [1/2] 必要なファイルをインストールしています(初回は数分かかります)...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/2] DiscordBouyomiBot.exe を作成しています...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo 完了しました。DiscordBouyomiBot.exe が、このフォルダに作成されました。
explorer "%~dp0."
exit /b 0

:fail
echo.
echo 失敗しました。上に出たエラーメッセージを確認してください。
pause
exit /b 1
