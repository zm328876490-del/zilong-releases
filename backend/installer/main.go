package main

import (
	"embed"
	"fmt"
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
	user32              = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW     = user32.NewProc("MessageBoxW")
	MB_OKCANCEL         = 0x00000001
	MB_ICONQUESTION     = 0x00000020
	IDOK                = 1
)

//go:embed embedded
var embeddedFiles embed.FS

const serviceExe = "translation-server.exe"

var version = "dev"

func main() {
	fmt.Println("========================================")
	fmt.Println("  AI Translation - 一键安装")
	fmt.Println("========================================")
	fmt.Println()

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("APPDATA"), "..", "Local")
	}
	targetDir := filepath.Join(localAppData, "AI-Translation")

	// Detect install type and ask user
	installed := fileExists(filepath.Join(targetDir, serviceExe))
	var title, msg string
	if installed {
		title = "AI Translation - 更新"
		msg = "已检测到旧版本，是否更新？"
	} else {
		title = "AI Translation - 安装"
		msg = "即将安装 AI Translation，是否继续？"
	}
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	msgPtr, _ := syscall.UTF16PtrFromString(msg)
	ret, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(msgPtr)), uintptr(unsafe.Pointer(titlePtr)), uintptr(MB_OKCANCEL|MB_ICONQUESTION))
	if int(ret) != IDOK {
		os.Exit(0)
	}

	// Step 1: Kill all related processes and wait for them to exit
	exec.Command("taskkill", "/f", "/im", serviceExe).Run()
	exec.Command("taskkill", "/f", "/im", "whisper-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "llama-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "python.exe").Run()
	time.Sleep(1000 * time.Millisecond)

	// Poll until translation-server.exe is truly gone (max 10s)
	for i := 0; i < 50; i++ {
		out, _ := exec.Command("tasklist", "/fi", "imagename eq "+serviceExe, "/fo", "csv").Output()
		if !strings.Contains(string(out), serviceExe) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Step 2: Extract embedded files
	fmt.Print("正在解压...")
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
		fmt.Println(" 失败!")
		fmt.Println("解压错误:", err)
		fmt.Scanln()
		os.Exit(1)
	}
	fmt.Println(" 完成!")

	// Step 3: Register auto-start
	fmt.Print("正在注册开机自启...")
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`,
		registry.SET_VALUE)
	if err == nil {
		k.SetStringValue("AI-Translation", filepath.Join(targetDir, serviceExe))
		k.Close()
		fmt.Println(" 完成!")
	} else {
		fmt.Println(" 跳过")
	}
		// Step 3.5: Register uninstall info (Control Panel → Programs and Features)
		fmt.Print("正在注册卸载信息...")
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
			fmt.Println(" 完成!")
		} else {
			fmt.Println(" 跳过")
		}

	// Step 4: Launch service
	fmt.Print("正在启动服务...")
	cmd := exec.Command(filepath.Join(targetDir, serviceExe))
	cmd.Dir = targetDir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000,
		HideWindow:    true,
	}
	cmd.Start()
	fmt.Println(" 完成!")

	fmt.Println()
	fmt.Println("========================================")
	if installed {
		fmt.Println("  更新完成！服务已在后台运行。")
	} else {
		fmt.Println("  安装完成！服务已在后台运行。")
	}
	fmt.Println("  可以关闭此窗口。")
	fmt.Println("========================================")
	time.Sleep(3 * time.Second)
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
