--------------初始化--------------
1. 安装 Go 1.21+（https://go.dev/dl/）
2. 安装 rsrc 图标工具（编译前执行一次即可）
go install github.com/akavel/rsrc@latest

3. 在 backend 目录安装依赖
cd D:\project\ai-translation\backend
go mod download
cd installer
go mod download
cd ..


--------------运行--------------
cd D:\project\ai-translation\backend

:: 开发模式（带控制台窗口，可看日志）
go run -ldflags="-X main.version=dev" ./cmd/server/

:: 生产模式（无控制台窗口）
go build -ldflags="-s -w -H windowsgui -X main.version=dev" -o translation-server.exe ./cmd/server/
.\translation-server.exe

启动后服务监听 http://localhost:29527
- 健康检查: http://localhost:29527/health
- 本地 LLM: http://127.0.0.1:23323 (llama-server 自动启动)
- 语音识别: http://127.0.0.1:23321 (whisper-server 自动启动)

首次启动会自动下载 llama.cpp 运行库（ggml-*.dll）到 backend 目录。


--------------打包--------------
打包输出：auth-server\installer.exe（安装器，含图标）
         auth-server\extension.zip（浏览器扩展）

执行打包脚本（推荐）：
cd D:\project\ai-translation\backend
.\build.bat

或手动执行：

:: 1. 编译后端（带版本号）
set VER=<从 auth-server\VERSION 读取>
go build -ldflags="-s -w -H windowsgui -X main.version=%VER%" -o translation-server.exe ./cmd/server/

:: 2. 生成图标资源（首次需执行）
cd cmd\server
rsrc -ico ..\..\..\extension\icons\icon.ico -o rsrc.syso
cd ..\installer
rsrc -ico ..\..\..\extension\icons\icon.ico -o rsrc.syso
cd ..\..

:: 3. 准备嵌入文件
mkdir installer\embedded\models installer\embedded\scripts
copy translation-server.exe installer\embedded\
copy whisper-server.exe whisper.dll SDL2.dll installer\embedded\
copy llama-server.exe llama*.dll ggml*.dll libomp140*.dll installer\embedded\
copy ggml-cpu-*.dll installer\embedded\
copy models\ggml-tiny.bin models\ggml-vad.bin installer\embedded\models\
xcopy scripts installer\embedded\scripts /E /Y

:: 4. 编译安装器
cd installer
go build -ldflags="-s -w" -o installer.exe .
cd ..

:: 5. 打包扩展
powershell -Command "Compress-Archive -Path '..\extension\*' -DestinationPath '..\auth-server\extension.zip' -Force"

:: 6. 复制产物
copy installer.exe ..\auth-server\installer.exe

产物：
- auth-server\installer.exe — 一键安装包（含图标，184MB）
- auth-server\extension.zip — Chrome 扩展（365KB）


--------------说明--------------
- installer.exe 安装到 %LOCALAPPDATA%\AI-Translation，注册开机自启
- 模型文件（.gguf）存放在 backend\models\，按需下载
- 配置文件保存在 exe 同目录
- 本地 LLM 端口：23323
- 后端 API 端口：29527
- 语音识别端口：23321
- 浏览器扩展在 chrome://extensions 开发者模式加载 extension 目录
