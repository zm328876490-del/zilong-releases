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
for /f "usebackq delims=" %%v in ("..\auth-server\VERSION") do set VER=%%v
go build -ldflags="-s -w -H windowsgui -X main.version=%VER%" -o translation-server.exe ./cmd/server/
if %errorlevel% neq 0 ( echo ERROR: 编译失败！ & pause & exit /b 1 )
echo       完成

:: Step 2: Prepare embedded files for installer
echo.
echo [2/4] 准备安装器嵌入文件...
if exist installer\embedded rmdir /s /q installer\embedded
mkdir installer\embedded
mkdir installer\embedded\models
mkdir installer\embedded\scripts

copy /y translation-server.exe installer\embedded\translation-server.exe >nul
:: whisper.cpp
copy /y whisper-server.exe installer\embedded\whisper-server.exe >nul
copy /y whisper.dll installer\embedded\whisper.dll >nul
copy /y SDL2.dll installer\embedded\SDL2.dll >nul
:: llama.cpp Vulkan
copy /y llama-server.exe installer\embedded\llama-server.exe >nul
copy /y llama.dll installer\embedded\llama.dll >nul
copy /y llama-common.dll installer\embedded\llama-common.dll >nul
copy /y llama-server-impl.dll installer\embedded\llama-server-impl.dll >nul
:: ggml core
copy /y ggml.dll installer\embedded\ggml.dll >nul
copy /y ggml-base.dll installer\embedded\ggml-base.dll >nul
copy /y ggml-vulkan.dll installer\embedded\ggml-vulkan.dll >nul
copy /y ggml-rpc.dll installer\embedded\ggml-rpc.dll >nul
copy /y libomp140.x86_64.dll installer\embedded\libomp140.x86_64.dll >nul
:: ggml CPU backends (for broad CPU compatibility)
for %%f in (ggml-cpu-*.dll) do copy /y "%%f" installer\embedded\ >nul
copy /y models\ggml-tiny.bin installer\embedded\models\ggml-tiny.bin >nul
copy /y models\ggml-vad.bin installer\embedded\models\ggml-vad.bin >nul
xcopy /y /e scripts\* installer\embedded\scripts\ >nul 2>&1
echo       完成

:: Step 3: Build installer
echo.
echo [3/4] 编译安装程序...
cd installer
go build -ldflags="-s -w" -o installer.exe .
if %errorlevel% neq 0 ( echo ERROR: 安装程序编译失败！ & cd .. & pause & exit /b 1 )
cd ..
move installer\installer.exe installer.exe >nul
echo       完成

:: Step 4: Copy to auth-server
echo.
echo [4/4] 复制产物到 auth-server/ ...
copy /y installer.exe ..\auth-server\installer.exe >nul
echo       完成

:: Step 5: Package extension as zip
echo.
echo [5/5] 打包浏览器扩展...
powershell -Command "Compress-Archive -Path '%CD%\..\extension\*' -DestinationPath '%CD%\..\auth-server\extension-v%VER%.zip' -Force"
if %errorlevel% neq 0 ( echo ERROR: 打包扩展失败！ & pause & exit /b 1 )
echo       完成

:: Cleanup
rmdir /s /q installer\embedded
del installer.exe

:: Done
echo.
echo ========================================
echo   产物: auth-server\installer.exe
echo   产物: auth-server\extension-v%VER%.zip
echo   上传 auth-server\ 整个目录到服务器
echo   参考 auth-server\linux\deploy.txt
echo ========================================
pause
