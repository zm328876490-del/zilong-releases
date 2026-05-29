@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AI Translation - 一键打包脚本
echo ========================================

:: Step 1: Build backend (no console)
echo.
echo [1/5] 编译翻译后台（无窗口模式）...
if not exist .tmp mkdir .tmp
set GOTMPDIR=%CD%\.tmp
for /f "usebackq delims=" %%v in ("..\auth-server\VERSION") do set VER=%%v
go build -ldflags="-s -w -H windowsgui -X main.version=%VER%" -o translation-server.exe ./cmd/server/
if %errorlevel% neq 0 ( echo ERROR: 编译失败！ & pause & exit /b 1 )
echo       完成

:: Step 2: AES encrypt the garble'd binary (evade Defender)
echo.
echo [2/5] AES 加密（规避杀软误报）...
go run cmd/crypt/main.go < translation-server.exe > translation-server.exe.enc
if %errorlevel% neq 0 ( echo ERROR: 加密失败！ & pause & exit /b 1 )
echo       完成

:: Step 3: Prepare embedded files for installer
echo.
echo [3/5] 准备安装器嵌入文件...
if exist installer\embedded rmdir /s /q installer\embedded
mkdir installer\embedded
mkdir installer\embedded\models
mkdir installer\embedded\scripts

copy /y translation-server.exe.enc installer\embedded\translation-server.exe.enc >nul
copy /y whisper-server.exe installer\embedded\whisper-server.exe >nul
copy /y whisper.dll installer\embedded\whisper.dll >nul
copy /y SDL2.dll installer\embedded\SDL2.dll >nul
copy /y ggml.dll installer\embedded\ggml.dll >nul
copy /y ggml-base.dll installer\embedded\ggml-base.dll >nul
copy /y ggml-cpu.dll installer\embedded\ggml-cpu.dll >nul
copy /y llama-server.exe installer\embedded\llama-server.exe >nul
copy /y llama.dll installer\embedded\llama.dll >nul
copy /y llama-common.dll installer\embedded\llama-common.dll >nul
copy /y llama-server-impl.dll installer\embedded\llama-server-impl.dll >nul
copy /y models\ggml-tiny.bin installer\embedded\models\ggml-tiny.bin >nul
copy /y models\ggml-vad.bin installer\embedded\models\ggml-vad.bin >nul
xcopy /y /e scripts\* installer\embedded\scripts\ >nul 2>&1
echo       完成

:: Step 4: Build installer (no obfuscation)
echo.
echo [4/5] 编译安装程序...
cd installer
go build -ldflags="-s -w" -o installer.exe .
if %errorlevel% neq 0 ( echo ERROR: 安装程序编译失败！ & cd .. & pause & exit /b 1 )
cd ..
move installer\installer.exe installer.exe >nul
echo       完成

:: Step 5: Copy to auth-server
echo.
echo [5/5] 复制产物到 auth-server/ ...
copy /y installer.exe ..\auth-server\installer.exe >nul
echo       完成

:: Step 6: Package extension as zip
echo.
echo [6/6] 打包浏览器扩展...
powershell -Command "Compress-Archive -Path '%CD%\..\extension\*' -DestinationPath '%CD%\..\auth-server\extension.zip' -Force"
if %errorlevel% neq 0 ( echo ERROR: 打包扩展失败！ & pause & exit /b 1 )
echo       完成

:: Cleanup
rmdir /s /q installer\embedded
del installer.exe
del translation-server.exe.enc

:: Done
echo.
echo ========================================
echo   产物: auth-server\installer.exe
echo   产物: auth-server\extension.zip
echo   上传 auth-server\ 整个目录到服务器
echo   参考 auth-server\linux\deploy.txt
echo ========================================
pause
