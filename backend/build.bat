@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AI Translation - 一键打包脚本
echo ========================================

:: Step 1: Build backend (no console)
echo.
echo [1/4] 编译翻译后台（无窗口模式）...
if not exist .tmp mkdir .tmp
set GOTMPDIR=%CD%\.tmp
garble -literals -tiny build -ldflags "-H windowsgui" -o translation-server.exe ./cmd/server/
if %errorlevel% neq 0 ( echo ERROR: 编译失败！ & pause & exit /b 1 )
echo       完成

:: Step 2: Package into dist.zip
echo.
echo [2/4] 打包 dist.zip（供安装程序下载）...
if exist release rmdir /s /q release
mkdir release
powershell -Command "Compress-Archive -Path 'translation-server.exe','whisper-server.exe','whisper.dll','SDL2.dll','ggml.dll','ggml-base.dll','ggml-cpu.dll','scripts','models\ggml-tiny.bin','models\ggml-vad.bin' -DestinationPath 'release\dist.zip' -Force"
echo       完成

:: Step 3: Build installer bootstrapper
echo.
echo [3/4] 编译安装程序...
cd installer
go build -o installer.exe .
if %errorlevel% neq 0 ( echo ERROR: 安装程序编译失败！ & cd .. & pause & exit /b 1 )
cd ..
move installer\installer.exe release\installer.exe >nul
echo       完成

:: Step 4: Done
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
