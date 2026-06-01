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

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
	MB_OK           = 0x00000000
	MB_OKCANCEL     = 0x00000001
	MB_ICONINFO     = 0x00000040
	MB_ICONERROR    = 0x00000010
	MB_ICONQUESTION = 0x00000020
	IDOK            = 1
)

//go:embed embedded
var embeddedFiles embed.FS

const serviceExe = "translation-server.exe"

var version = "dev"

func msgBox(title, text string, flags int) int {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	ret, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), uintptr(flags))
	return int(ret)
}

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

	// Step 1: Kill all related processes
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
		err = extractEmbedded(targetDir)
		if err == nil {
			break
		}
		time.Sleep(1000 * time.Millisecond)
	}
	if err != nil {
		msgBox("AI Translation", "安装失败：解压错误\n"+err.Error(), MB_OK|MB_ICONERROR)
		os.Exit(1)
	}

	// Step 3: Register auto-start
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`,
		registry.SET_VALUE)
	if err == nil {
		k.SetStringValue("AI-Translation", filepath.Join(targetDir, serviceExe))
		k.Close()
	}

	// Step 3.5: Register uninstall info
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
	cmd := exec.Command(filepath.Join(targetDir, serviceExe))
	cmd.Dir = targetDir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000,
		HideWindow:    true,
	}
	cmd.Start()

	// Done
	if installed {
		msgBox("AI Translation", "更新完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
	} else {
		msgBox("AI Translation", "安装完成！服务已在后台运行。", MB_OK|MB_ICONINFO)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

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
