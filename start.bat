@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul

set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>&1
if errorlevel 1 (
  echo.
  echo لم نجد Node.js بالنسخة المطلوبة ^(22 أو أحدث^).
  echo نزّل نسخة Windows Binary ^(.zip^) من https://nodejs.org/en/download
  echo ثم فك الضغط وأعد تسمية المجلد إلى node وضعه داخل هذا المجلد بجانب start.bat
  echo.
  pause
  exit /b 1
)

echo التطبيق يعمل على http://localhost:3000  ^(أغلق هذه النافذة لإيقافه^)
start "" http://localhost:3000
"%NODE_EXE%" --disable-warning=ExperimentalWarning server.js
pause
