package main

import (
	"embed"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// ─── DLL / Proc ─────────────────────────────────────────────────

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")

	pInitCommonControls = comctl32.NewProc("InitCommonControls")
	pGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	pRegisterClassExW   = user32.NewProc("RegisterClassExW")
	pCreateWindowExW    = user32.NewProc("CreateWindowExW")
	pDefWindowProcW     = user32.NewProc("DefWindowProcW")
	pShowWindow         = user32.NewProc("ShowWindow")
	pDestroyWindow      = user32.NewProc("DestroyWindow")
	pPeekMessageW       = user32.NewProc("PeekMessageW")
	pDispatchMessageW   = user32.NewProc("DispatchMessageW")
	pTranslateMessage   = user32.NewProc("TranslateMessage")
	pSendMessageW       = user32.NewProc("SendMessageW")
	pSetWindowTextW     = user32.NewProc("SetWindowTextW")
	pGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	pLoadCursorW        = user32.NewProc("LoadCursorW")
	pGetStockObject     = user32.NewProc("GetStockObject")
	pMessageBoxW        = user32.NewProc("MessageBoxW")
)

// ─── Constants ──────────────────────────────────────────────────

const (
	MB_OK           = 0x00000000
	MB_OKCANCEL     = 0x00000001
	MB_ICONINFO     = 0x00000040
	MB_ICONERROR    = 0x00000010
	MB_ICONQUESTION = 0x00000020
	IDOK            = 1
	IDCANCEL        = 2

	// Window styles
	WS_OVERLAPPED  = 0x00000000
	WS_CAPTION     = 0x00C00000
	WS_SYSMENU     = 0x00080000
	WS_VISIBLE     = 0x10000000
	WS_CHILD       = 0x40000000
	WS_MINIMIZEBOX = 0x00020000

	// Class styles
	CS_HREDRAW = 0x0002
	CS_VREDRAW = 0x0001

	// System metrics
	SM_CXSCREEN = 0
	SM_CYSCREEN = 1

	// Stock objects
	COLOR_BTNFACE  = 15
	IDC_ARROW      = 32512
	DEFAULT_GUI_FONT = 17

	// Progress bar messages
	PBM_SETRANGE32 = 0x0406
	PBM_SETPOS     = 0x0402

	// Window messages
	WM_DESTROY = 0x0002
	WM_CTLCOLORSTATIC = 0x0138

	SW_SHOW = 5

	CW_USEDEFAULT = 0x80000000
)

// ─── Structs ────────────────────────────────────────────────────

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

type POINT struct{ X, Y int32 }

type MSG struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      POINT
}

// ─── Globals ────────────────────────────────────────────────────

//go:embed embedded
var embeddedFiles embed.FS

const serviceExe = "translation-server.exe"

var version = "dev"

// Progress window handles
var (
	hwndBar   uintptr
	hwndLabel uintptr
	barTotal  int
	barStep   int
)

// ─── Helpers ────────────────────────────────────────────────────

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

func pumpMessages() {
	var msg MSG
	for {
		ret, _, _ := pPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1) // PM_REMOVE
		if ret == 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

func countEmbeddedFiles() int {
	count := 0
	fs.WalkDir(embeddedFiles, "embedded", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			count++
		}
		return nil
	})
	return count
}

// ─── Progress Window ────────────────────────────────────────────

func windowProc(hwnd uintptr, msg uint32, wparam uintptr, lparam uintptr) uintptr {
	switch msg {
	case WM_CTLCOLORSTATIC:
		// Return hollow brush for transparent label background
		brush, _, _ := pGetStockObject.Call(uintptr(5)) // NULL_BRUSH
		return brush
	case WM_DESTROY:
		return 0
	}
	ret, _, _ := pDefWindowProcW.Call(hwnd, uintptr(msg), wparam, lparam)
	return ret
}

func createProgressWindow(title string, total int) {
	barTotal = total
	barStep = 0

	pInitCommonControls.Call()

	hInstance, _, _ := pGetModuleHandleW.Call(0)

	// Register window class
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

	// Screen dimensions
	screenW, _, _ := pGetSystemMetrics.Call(uintptr(SM_CXSCREEN))
	screenH, _, _ := pGetSystemMetrics.Call(uintptr(SM_CYSCREEN))
	winW := int32(420)
	winH := int32(130)
	x := (int32(screenW) - winW) / 2
	y := (int32(screenH) - winH) / 2

	// Create window
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	hwnd, _, _ := pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(titlePtr)),
		WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX|WS_VISIBLE,
		uintptr(x), uintptr(y), uintptr(winW), uintptr(winH),
		0, 0, hInstance, 0,
	)

	// Create status label
	labelClass, _ := syscall.UTF16PtrFromString("STATIC")
	labelText, _ := syscall.UTF16PtrFromString("正在准备...")
	hwndLabel, _, _ = pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(labelClass)), uintptr(unsafe.Pointer(labelText)),
		WS_CHILD|WS_VISIBLE,
		uintptr(20), uintptr(15), uintptr(winW-40), uintptr(20),
		hwnd, 0, hInstance, 0,
	)

	// Set label font
	font, _, _ := pGetStockObject.Call(uintptr(DEFAULT_GUI_FONT))
	pSendMessageW.Call(hwndLabel, 0x0030 /*WM_SETFONT*/, font, 0)

	// Create progress bar
	barClass, _ := syscall.UTF16PtrFromString("msctls_progress32")
	hwndBar, _, _ = pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(barClass)), 0,
		WS_CHILD|WS_VISIBLE,
		uintptr(20), uintptr(45), uintptr(winW-40), uintptr(24),
		hwnd, 0, hInstance, 0,
	)

	// Set range
	pSendMessageW.Call(hwndBar, PBM_SETRANGE32, 0, uintptr(total))

	pShowWindow.Call(hwnd, uintptr(SW_SHOW))
	pumpMessages()
}

func updateProgress(text string) {
	barStep++
	if barStep > barTotal {
		barStep = barTotal
	}
	pos := barStep * 100 / barTotal

	labelPtr, _ := syscall.UTF16PtrFromString(text)
	pSetWindowTextW.Call(hwndLabel, uintptr(unsafe.Pointer(labelPtr)))
	pSendMessageW.Call(hwndBar, PBM_SETPOS, uintptr(pos), 0)
	pumpMessages()
}

func destroyProgressWindow() {
	if hwndLabel != 0 {
		pDestroyWindow.Call(hwndLabel)
		hwndLabel = 0
	}
	if hwndBar != 0 {
		pDestroyWindow.Call(hwndBar)
		hwndBar = 0
	}
}

// ─── Extract ────────────────────────────────────────────────────

func extractEmbedded(targetDir string) error {
	return fs.WalkDir(embeddedFiles, "embedded", func(path string, d fs.DirEntry, err error) error {
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
		return copyEmbedded(path, dest)
	})
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

// ─── Main ───────────────────────────────────────────────────────

func main() {
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

	// Count total steps: kill(1) + files(N) + registry(1) + launch(1)
	totalSteps := 1 + countEmbeddedFiles() + 1 + 1
	createProgressWindow("AI Translation - 安装中...", totalSteps)

	// Step 1: Kill all related processes
	updateProgress("正在停止旧服务...")
	exec.Command("taskkill", "/f", "/im", serviceExe).Run()
	exec.Command("taskkill", "/f", "/im", "whisper-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "llama-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "python.exe").Run()
	time.Sleep(1000 * time.Millisecond)

	for i := 0; i < 50; i++ {
		out, _ := exec.Command("tasklist", "/fi", "imagename eq "+serviceExe, "/fo", "csv").Output()
		if !strings.Contains(string(out), serviceExe) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Step 2: Extract embedded files
	os.MkdirAll(targetDir, 0755)
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		err = extractEmbeddedWithProgress(targetDir)
		if err == nil {
			break
		}
		time.Sleep(1000 * time.Millisecond)
	}
	if err != nil {
		destroyProgressWindow()
		msgBox("AI Translation", "安装失败：解压错误\n"+err.Error(), MB_OK|MB_ICONERROR)
		os.Exit(1)
	}

	// Step 3: Register auto-start + uninstall
	updateProgress("正在注册系统...")
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

	// Step 4: Launch service
	updateProgress("正在启动服务...")
	cmd := exec.Command(filepath.Join(targetDir, serviceExe))
	cmd.Dir = targetDir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000,
		HideWindow:    true,
	}
	cmd.Start()

	destroyProgressWindow()

	if installed {
		msgBox("AI Translation", "更新完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
	} else {
		msgBox("AI Translation", "安装完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
	}
}

// extractEmbeddedWithProgress extracts files and updates progress for each file.
func extractEmbeddedWithProgress(targetDir string) error {
	return fs.WalkDir(embeddedFiles, "embedded", func(path string, d fs.DirEntry, err error) error {
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
		updateProgress("正在安装: " + relPath)
		return copyEmbedded(path, dest)
	})
}
