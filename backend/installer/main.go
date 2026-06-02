package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// ─── DLL ──────────────────────────────────────────────────────────

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")

	pInitCommonControls = comctl32.NewProc("InitCommonControls")
	pGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	pRegisterClassExW   = user32.NewProc("RegisterClassExW")
	pCreateWindowExW    = user32.NewProc("CreateWindowExW")
	pDefWindowProcW     = user32.NewProc("DefWindowProcW")
	pShowWindow         = user32.NewProc("ShowWindow")
	pDestroyWindow      = user32.NewProc("DestroyWindow")
	pGetMessageW        = user32.NewProc("GetMessageW")
	pTranslateMessage   = user32.NewProc("TranslateMessage")
	pDispatchMessageW   = user32.NewProc("DispatchMessageW")
	pSendMessageW       = user32.NewProc("SendMessageW")
	pSetWindowTextW     = user32.NewProc("SetWindowTextW")
	pPostMessageW       = user32.NewProc("PostMessageW")
	pGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	pLoadCursorW        = user32.NewProc("LoadCursorW")
	pGetStockObject     = gdi32.NewProc("GetStockObject")
	pMessageBoxW        = user32.NewProc("MessageBoxW")
)

// ─── Constants ────────────────────────────────────────────────────

const (
	MB_OK           = 0x00000000
	MB_OKCANCEL     = 0x00000001
	MB_ICONINFO     = 0x00000040
	MB_ICONERROR    = 0x00000010
	MB_ICONQUESTION = 0x00000020
	IDOK            = 1

	WS_OVERLAPPED  = 0x00000000
	WS_CAPTION     = 0x00C00000
	WS_SYSMENU     = 0x00080000
	WS_VISIBLE     = 0x10000000
	WS_CHILD       = 0x40000000
	WS_MINIMIZEBOX = 0x00020000

	CS_HREDRAW = 0x0002
	CS_VREDRAW = 0x0001

	SM_CXSCREEN = 0
	SM_CYSCREEN = 1

	COLOR_BTNFACE  = 15
	IDC_ARROW      = 32512
	DEFAULT_GUI_FONT = 17

	PBM_SETRANGE32 = 0x0406
	PBM_SETPOS     = 0x0402

	WM_DESTROY    = 0x0002
	WM_USER       = 0x0400
	WM_UPDATE_UI  = 0x0401
	WM_WORKER_DONE = 0x0402

	SW_SHOW = 5
)

// ─── Structs ──────────────────────────────────────────────────────

type WNDCLASSEX struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     uintptr
	HIcon         uintptr
	HCursor       uintptr
	HbrBackground uintptr
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       uintptr
}

type MSG struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

// ─── Globals ──────────────────────────────────────────────────────

//go:embed embedded
var embeddedFiles embed.FS

const serviceExe = "translation-server.exe"

var version = "dev"

// Progress state, protected by progressMu (only worker writes, only main reads—but mutex for safety).
var (
	progressMu   sync.Mutex
	progressText string
	progressPct  int // 0-100
	progressDone bool
	progressErr  error
)

var (
	hwndMain  uintptr
	hwndBar   uintptr
	hwndLabel uintptr
)

// ─── Helpers ──────────────────────────────────────────────────────

func runHidden(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

func runHiddenOutput(name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Output()
}

func msgBox(title, text string, flags int) int {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	ret, _, _ := pMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), uintptr(flags))
	return int(ret)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func countEmbeddedFiles() int {
	n := 0
	fs.WalkDir(embeddedFiles, "embedded", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func copyEmbedded(embeddedPath, dest string) error {
	src, err := embeddedFiles.Open(embeddedPath)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}

// ─── Progress window (main-thread only) ───────────────────────────

func windowProc(hwnd uintptr, msg uint32, wparam uintptr, lparam uintptr) uintptr {
	switch msg {
	case WM_UPDATE_UI:
		progressMu.Lock()
		text := progressText
		pct := progressPct
		progressMu.Unlock()

		labelPtr, _ := syscall.UTF16PtrFromString(text)
		pSetWindowTextW.Call(hwndLabel, uintptr(unsafe.Pointer(labelPtr)))
		pSendMessageW.Call(hwndBar, PBM_SETPOS, uintptr(pct), 0)
		return 0

	case WM_WORKER_DONE:
		pDestroyWindow.Call(hwnd)
		return 0

	case WM_DESTROY:
		// Post WM_QUIT to exit message loop
		pPostMessageW.Call(0, 0x0012 /*WM_QUIT*/, 0, 0)
		return 0
	}
	ret, _, _ := pDefWindowProcW.Call(hwnd, uintptr(msg), wparam, lparam)
	return ret
}

func createProgressWindow(title string, totalFiles int) bool {
	pInitCommonControls.Call()

	hInstance, _, _ := pGetModuleHandleW.Call(0)

	cb := syscall.NewCallback(windowProc)
	className, _ := syscall.UTF16PtrFromString("AI_ProgressWnd")
	var wc WNDCLASSEX
	wc.CbSize = uint32(unsafe.Sizeof(wc))
	wc.Style = CS_HREDRAW | CS_VREDRAW
	wc.LpfnWndProc = cb
	wc.HInstance = hInstance
	cursor, _, _ := pLoadCursorW.Call(0, uintptr(IDC_ARROW))
	wc.HCursor = cursor
	brush, _, _ := pGetStockObject.Call(uintptr(COLOR_BTNFACE + 1))
	wc.HbrBackground = brush
	wc.LpszClassName = className
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	screenW, _, _ := pGetSystemMetrics.Call(uintptr(SM_CXSCREEN))
	screenH, _, _ := pGetSystemMetrics.Call(uintptr(SM_CYSCREEN))
	winW := int32(420)
	winH := int32(120)
	x := (int32(screenW) - winW) / 2
	y := (int32(screenH) - winH) / 2

	titlePtr, _ := syscall.UTF16PtrFromString(title)
	hwndMain, _, _ = pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(titlePtr)),
		WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX|WS_VISIBLE,
		uintptr(x), uintptr(y), uintptr(winW), uintptr(winH),
		0, 0, hInstance, 0,
	)
	if hwndMain == 0 {
		return false
	}

	// Status label
	labelClass, _ := syscall.UTF16PtrFromString("STATIC")
	labelText, _ := syscall.UTF16PtrFromString("正在准备...")
	hwndLabel, _, _ = pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(labelClass)), uintptr(unsafe.Pointer(labelText)),
		WS_CHILD|WS_VISIBLE,
		uintptr(16), uintptr(12), uintptr(winW-32), uintptr(20),
		hwndMain, 0, hInstance, 0,
	)
	font, _, _ := pGetStockObject.Call(uintptr(DEFAULT_GUI_FONT))
	pSendMessageW.Call(hwndLabel, 0x0030 /*WM_SETFONT*/, font, 0)

	// Progress bar
	barClass, _ := syscall.UTF16PtrFromString("msctls_progress32")
	hwndBar, _, _ = pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(barClass)), 0,
		WS_CHILD|WS_VISIBLE,
		uintptr(16), uintptr(40), uintptr(winW-32), uintptr(24),
		hwndMain, 0, hInstance, 0,
	)
	pSendMessageW.Call(hwndBar, PBM_SETRANGE32, 0, uintptr(100))

	pShowWindow.Call(hwndMain, uintptr(SW_SHOW))
	return true
}

// ─── Send progress from worker goroutine ──────────────────────────

func sendProgress(text string, pct int) {
	progressMu.Lock()
	progressText = text
	progressPct = pct
	progressMu.Unlock()
	pPostMessageW.Call(hwndMain, WM_UPDATE_UI, 0, 0)
}

func sendDone(err error) {
	progressMu.Lock()
	progressDone = true
	progressErr = err
	progressMu.Unlock()
	pPostMessageW.Call(hwndMain, WM_WORKER_DONE, 0, 0)
}

// ─── Install worker (runs in background goroutine) ────────────────

func doInstall(targetDir string, totalFiles int) {
	// Step 1: Kill old processes
	sendProgress("正在停止旧服务...", 0)
	runHidden("taskkill", "/f", "/im", serviceExe)
	runHidden("taskkill", "/f", "/im", "whisper-server.exe")
		runHidden("taskkill", "/f", "/im", "python.exe")
	time.Sleep(1000 * time.Millisecond)

	// Wait for processes to exit (max 10s), update label during wait
	procs := []string{serviceExe, "whisper-server.exe"}
	for i := 0; i < 50; i++ {
		allGone := true
		for _, name := range procs {
			out, _ := runHiddenOutput("tasklist", "/fi", "imagename eq "+name, "/fo", "csv")
			if strings.Contains(string(out), name) {
				allGone = false
				break
			}
		}
		if allGone {
			break
		}
		if i%5 == 0 {
			sendProgress("正在等待旧服务退出...", 0)
		}
		time.Sleep(200 * time.Millisecond)
	}
	time.Sleep(500 * time.Millisecond)

	// Step 2: Extract files (5% → 90%)
	os.MkdirAll(targetDir, 0755)

	fileIdx := 0
	err := fs.WalkDir(embeddedFiles, "embedded", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relPath := strings.TrimPrefix(path, "embedded/")
		if relPath == "" {
			return nil
		}
		dest := filepath.Join(targetDir, filepath.FromSlash(relPath))
		if d.IsDir() {
			return os.MkdirAll(dest, 0755)
		}
		os.MkdirAll(filepath.Dir(dest), 0755)
		if copyErr := copyEmbedded(path, dest); copyErr != nil {
			return copyErr
		}
		fileIdx++
		pct := 5 + fileIdx*55/totalFiles
		sendProgress("正在安装: "+relPath, pct)
		return nil
	})
	if err != nil {
		sendDone(err)
		return
	}

	// Step 3: Ensure Ollama is installed (60% → 90%)
	if !isOllamaInstalled() {
		sendProgress("正在准备下载 Ollama...", 60)
		installerPath := filepath.Join(targetDir, "OllamaSetup.exe")
		if err := downloadOllama(installerPath); err != nil {
			sendDone(fmt.Errorf("下载 Ollama 失败: %w", err))
			return
		}
		sendProgress("正在安装 Ollama (可能需要几分钟)...", 85)
		if err := installOllamaSilent(installerPath); err != nil {
			sendDone(fmt.Errorf("安装 Ollama 失败: %w", err))
			return
		}
		os.Remove(installerPath)
		sendProgress("Ollama 安装完成", 90)
	} else {
		sendProgress("Ollama 已安装", 90)
	}

	// Step 4: Registry (90% → 95%)
	sendProgress("正在注册系统...", 92)

	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`,
		registry.SET_VALUE)
	if err == nil {
		k.SetStringValue("AI-Translation", filepath.Join(targetDir, serviceExe))
		k.Close()
	}

	uk, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Uninstall`,
		registry.SET_VALUE)
	if err == nil {
		key, _, err := registry.CreateKey(uk, "AI-Translation", registry.SET_VALUE)
		if err == nil {
			key.SetStringValue("DisplayName", "AI Translation")
			key.SetStringValue("UninstallString", filepath.Join(targetDir, "uninstall.exe"))
			key.SetStringValue("DisplayVersion", version)
			key.SetStringValue("Publisher", "AI Translation")
			key.SetDWordValue("NoModify", 1)
			key.SetDWordValue("NoRepair", 1)
			key.Close()
		}
		uk.Close()
	}

	// Step 5: Launch service + verify (95% → 100%)
	sendProgress("正在启动服务...", 95)
	cmd := exec.Command(filepath.Join(targetDir, serviceExe))
	cmd.Dir = targetDir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Start()

	// Poll /health until the service is ready
	healthURL := "http://127.0.0.1:29527/health"
	for i := 0; i < 40; i++ {
		time.Sleep(500 * time.Millisecond)
		resp, err := http.Get(healthURL)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				sendProgress("安装完成", 100)
				sendDone(nil)
				return
			}
		}
		if i%4 == 0 {
			sendProgress("正在等待服务就绪...", 97)
		}
	}
	sendDone(fmt.Errorf("服务启动超时，请检查 %s 是否运行", serviceExe))
}

// ─── Ollama on-demand install ──────────────────────────────────────

const ollamaDownloadURL = "https://ollama.com/download/OllamaSetup.exe"

func isOllamaInstalled() bool {
	// Check common locations
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("APPDATA"), "..", "Local")
	}
	paths := []string{
		filepath.Join(localAppData, "Programs", "Ollama", "ollama.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Ollama", "ollama.exe"),
		filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local", "Programs", "Ollama", "ollama.exe"),
	}
	for _, p := range paths {
		if fileExists(p) {
			return true
		}
	}
	// Also try PATH
	_, err := exec.LookPath("ollama.exe")
	if err == nil {
		return true
	}
	_, err = exec.LookPath("ollama")
	return err == nil
}

func downloadOllama(dest string) error {
	sendProgress("正在下载 Ollama (连接中...)", 0)

	resp, err := http.Get(ollamaDownloadURL)
	if err != nil {
		return fmt.Errorf("下载 Ollama 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载 Ollama 失败: HTTP %d", resp.StatusCode)
	}

	totalSize := resp.ContentLength
	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("创建文件失败: %w", err)
	}
	defer f.Close()

	buf := make([]byte, 32*1024)
	var downloaded int64
	for {
		nr, readErr := resp.Body.Read(buf)
		if nr > 0 {
			nw, writeErr := f.Write(buf[0:nr])
			if writeErr != nil {
				return fmt.Errorf("写入文件失败: %w", writeErr)
			}
			if nw != nr {
				return fmt.Errorf("写入不完整")
			}
			downloaded += int64(nw)
			if totalSize > 0 {
				pct := int(downloaded * 100 / totalSize)
				mbDownloaded := float64(downloaded) / (1024 * 1024)
				mbTotal := float64(totalSize) / (1024 * 1024)
				sendProgress(fmt.Sprintf("正在下载 Ollama (%.0f / %.0f MB)", mbDownloaded, mbTotal), pct)
			} else {
				mbDownloaded := float64(downloaded) / (1024 * 1024)
				sendProgress(fmt.Sprintf("正在下载 Ollama (%.0f MB)", mbDownloaded), 50)
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return fmt.Errorf("下载中断: %w", readErr)
		}
	}
	return nil
}

func installOllamaSilent(installerPath string) error {
	cmd := exec.Command(installerPath, "/S")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

// ─── Main ─────────────────────────────────────────────────────────

func main() {
	runtime.LockOSThread()

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("APPDATA"), "..", "Local")
	}
	targetDir := filepath.Join(localAppData, "AI-Translation")

	installed := fileExists(filepath.Join(targetDir, serviceExe))
	var title, msg string
	if installed {
		title = "AI Translation - 更新"
		msg = "已检测到旧版本，是否更新？"
	} else {
		title = "AI Translation - 安装"
		msg = "即将安装 AI Translation，是否继续？"
	}
	if msgBox(title, msg, MB_OKCANCEL|MB_ICONQUESTION) != IDOK {
		os.Exit(0)
	}

	totalFiles := countEmbeddedFiles()
	if !createProgressWindow("AI Translation - 安装中...", totalFiles) {
		// Fallback: window creation failed, run without UI
		doInstall(targetDir, totalFiles)
		progressMu.Lock()
		err := progressErr
		progressMu.Unlock()
		if err != nil {
			msgBox("AI Translation", "安装失败："+err.Error(), MB_OK|MB_ICONERROR)
		} else if installed {
			msgBox("AI Translation", "更新完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
		} else {
			msgBox("AI Translation", "安装完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
		}
		os.Exit(0)
	}

	// Start install in background goroutine
	go doInstall(targetDir, totalFiles)

	// Message loop (main thread)
	var m MSG
	for {
		ret, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if ret == 0 || int32(ret) == -1 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}

	// Worker finished, window destroyed, check result
	progressMu.Lock()
	err := progressErr
	progressMu.Unlock()

	if err != nil {
		msgBox("AI Translation", "安装失败："+err.Error(), MB_OK|MB_ICONERROR)
	} else if installed {
		msgBox("AI Translation", "更新完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
	} else {
		msgBox("AI Translation", "安装完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
	}
}
