@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AI Translation - 一键打包脚本
echo ========================================

:: Step 1: Build backend (no console)
echo.
echo [1/5] 编译翻译后台（无窗口模式）...
cd backend
go build -ldflags "-H windowsgui" -o translation-server.exe .
if %errorlevel% neq 0 ( echo ERROR: 编译失败！ & pause & exit /b 1 )
cd ..
echo       完成

:: Step 2: Prepare dist files
echo.
echo [2/5] 准备 dist 文件...
if exist dist rmdir /s /q dist
mkdir dist\models dist\scripts
copy backend\translation-server.exe  dist\  >nul
copy backend\whisper-server.exe       dist\  >nul
copy backend\whisper.dll              dist\  >nul
copy backend\SDL2.dll                 dist\  >nul
copy backend\ggml.dll                 dist\  >nul
copy backend\ggml-base.dll            dist\  >nul
copy backend\ggml-cpu.dll             dist\  >nul
copy models\ggml-tiny.bin             dist\models\  >nul
copy models\ggml-vad.bin              dist\models\  >nul
copy backend\scripts\ocr_server.py    dist\scripts\  >nul
echo       完成

:: Step 3: Package into dist.zip
echo.
echo [3/5] 打包 dist.zip（供安装程序下载）...
if exist release rmdir /s /q release
mkdir release
powershell -Command "Compress-Archive -Path 'dist\*' -DestinationPath 'release\dist.zip' -Force"
echo       完成

:: Step 4: Build installer bootstrapper
echo.
echo [4/5] 编译安装程序...
cd installer
go build -o installer.exe .
if %errorlevel% neq 0 ( echo ERROR: 安装程序编译失败！ & cd .. & pause & exit /b 1 )
cd ..
move installer\installer.exe release\installer.exe >nul
echo       完成

:: Step 5: Done
echo.
echo ========================================
echo   发布文件: release\
echo ========================================
dir /s release
echo.
echo       installer.exe  (~7MB)   - 给用户（引导下载）
echo       dist.zip       (~87MB)  - 放服务器供下载
echo.
echo   部署:
echo       1. 把 dist.zip 放到 auth-server 同目录
echo       2. 把 installer.exe 放到网站上供用户下载
echo ========================================
pause
