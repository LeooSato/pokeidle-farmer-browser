@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install || pause
)
start "" "%~dp0node_modules\electron\dist\electron.exe" . 
exit
