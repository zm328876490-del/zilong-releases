@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AI Translation - 一键打包脚本
echo ========================================

for /f "usebackq delims=" %%v in ("..\auth-server\VERSION") do set VER=%%v

:: Step 1: Build backend (no console)
echo.
echo [1/7] 编译翻译后台（无窗口模式）...
if not exist .tmp mkdir .tmp
set GOTMPDIR=%CD%\.tmp
go build -ldflags="-s -w -H windowsgui -X main.version=%VER%" -o translation-server.exe ./cmd/server/
if %errorlevel% neq 0 ( echo ERROR: 编译失败！ & pause & exit /b 1 )
echo       完成

:: Step 2: Build uninstaller
echo.
echo [2/7] 编译卸载程序...
go build -ldflags="-s -w -H windowsgui" -o uninstall.exe ./cmd/uninstall/
if %errorlevel% neq 0 ( echo ERROR: 卸载程序编译失败！ & pause & exit /b 1 )
echo       完成

:: Step 3: Prepare embedded files for installer
echo.
echo [3/7] 准备安装器嵌入文件...
if exist installer\embedded rmdir /s /q installer\embedded
mkdir installer\embedded
mkdir installer\embedded\models
mkdir installer\embedded\scripts

copy /y translation-server.exe installer\embedded\translation-server.exe >nul
copy /y uninstall.exe installer\embedded\uninstall.exe >nul
:: whisper.cpp
copy /y whisper-server.exe installer\embedded\whisper-server.exe >nul
copy /y whisper.dll installer\embedded\whisper.dll >nul
copy /y SDL2.dll installer\embedded\SDL2.dll >nul
:: llama.cpp Vulkan
copy /y llama.dll installer\embedded\llama.dll >nul
copy /y llama-common.dll installer\embedded\llama-common.dll >nul
:: ggml core
copy /y ggml.dll installer\embedded\ggml.dll >nul
copy /y ggml-base.dll installer\embedded\ggml-base.dll >nul
copy /y ggml-vulkan.dll installer\embedded\ggml-vulkan.dll >nul
copy /y ggml-rpc.dll installer\embedded\ggml-rpc.dll >nul
:: ggml CPU backends (for broad CPU compatibility)
for %%f in (ggml-cpu-*.dll) do copy /y "%%f" installer\embedded\ >nul
	copy /y libomp140.x86_64.dll installer\embedded\libomp140.x86_64.dll >nul
	:: OllamaSetup.exe 改为安装时按需下载，不再打包
copy /y models\ggml-tiny.bin installer\embedded\models\ggml-tiny.bin >nul
copy /y models\ggml-vad.bin installer\embedded\models\ggml-vad.bin >nul
xcopy /y /e scripts\* installer\embedded\scripts\ >nul 2>&1
echo       完成

:: Copy icon for installer
copy /y ..\extension\icons\icon.ico installer\icon.ico >nul

:: Step 4: Update version in versioninfo.json
echo.
echo [4/7] 更新安装器版本信息...

echo.
echo [5/7] 生成 Windows 资源文件...
cd installer
goversioninfo versioninfo.json
echo       完成

:: Step 6: Build installer
echo.
echo [6/7] 编译安装程序...
go build -ldflags="-s -w -H windowsgui -X main.version=%VER%" -o installer.exe .
cd ..
move installer\installer.exe installer.exe >nul
echo       完成

:: Step 7: Package extension as zip
echo.
echo [7/7] 打包浏览器扩展...
powershell -Command "Compress-Archive -Path '%CD%\..\extension\*' -DestinationPath '%CD%\extension.zip' -Force"
echo       完成

:: Cleanup
rmdir /s /q installer\embedded
del uninstall.exe

:: Done
echo.
echo ========================================
echo   已生成 installer.exe + extension.zip
echo   上传至 GitHub Release 后自动清理
echo ========================================
pause
