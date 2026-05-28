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

:: Server URL (first argument or default)
set SERVER_URL=%1
if "%SERVER_URL%"=="" set SERVER_URL=http://127.0.0.1

:: Step 3: Build installer bootstrapper
echo.
echo [3/4] 编译安装程序（下载地址: %SERVER_URL%/api/download/dist）...
cd installer
go build -ldflags "-X main.downloadURL=%SERVER_URL%/api/download/dist" -o installer.exe .
if %errorlevel% neq 0 ( echo ERROR: 安装程序编译失败！ & cd .. & pause & exit /b 1 )
cd ..
move installer\installer.exe release\installer.exe >nul
echo       完成

:: Step 4: Copy to auth-server
echo.
echo [4/4] 复制产物到 auth-server/ ...
copy /y release\dist.zip ..\auth-server\dist.zip >nul
copy /y release\installer.exe ..\auth-server\installer.exe >nul
echo       完成

:: Done
echo.
echo ========================================
echo   服务器部署:
echo       上传 auth-server\ 整个目录到 /home/project/auth-server/
echo       参考 auth-server\linux\deploy.txt
echo ========================================
pause
