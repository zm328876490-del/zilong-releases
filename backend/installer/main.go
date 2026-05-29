package main

import (
	"crypto/aes"
	"crypto/cipher"
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

//go:embed embedded
var embeddedFiles embed.FS

const serviceExe = "translation-server.exe"

// AES-256 key — must match backend/cmd/crypt/main.go
var aesKey = [32]byte{
	0x8f, 0x2a, 0x4b, 0x6c, 0x9d, 0x1e, 0x3f, 0x5a,
	0x7b, 0x8d, 0x0e, 0x2f, 0x4a, 0x6c, 0x8e, 0x1a,
	0x2c, 0x4e, 0x6f, 0x8a, 0x0b, 0x2d, 0x4f, 0x6e,
	0x8a, 0x0c, 0x2e, 0x4a, 0x6e, 0x8a, 0x0b, 0x0c,
}

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

	// Step 1: Kill all related processes and wait for them to exit
	exec.Command("taskkill", "/f", "/im", serviceExe).Run()
	exec.Command("taskkill", "/f", "/im", "whisper-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "python.exe").Run()
	time.Sleep(500 * time.Millisecond)

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
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		fmt.Println(" 失败!")
		fmt.Println("解压错误:", err)
		fmt.Scanln()
		os.Exit(1)
	}
	fmt.Println(" 完成!")

	// Step 3: Set OLLAMA_ORIGINS so browser extension can call Ollama
	fmt.Print("正在配置 Ollama 跨域...")
	ek, err := registry.OpenKey(registry.CURRENT_USER,
		`Environment`,
		registry.SET_VALUE)
	if err == nil {
		ek.SetStringValue("OLLAMA_ORIGINS", "*")
		ek.Close()
		fmt.Println(" 完成!")
		// Broadcast env change so running processes pick it up
		syscall.NewLazyDLL("user32.dll").NewProc("SendMessageTimeoutW").Call(
			0xFFFF, 0x001A, 0, uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("Environment"))), 2, 5000, 0)
	} else {
		fmt.Println(" 跳过")
	}

	// Step 4: Register auto-start
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

	// Step 5: Launch service
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
	fmt.Println("  安装完成！服务已在后台运行。")
	fmt.Println("  可以关闭此窗口。")
	fmt.Println("========================================")
	time.Sleep(3 * time.Second)
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
		// Decrypt .enc files
		if strings.HasSuffix(relPath, ".enc") {
			return decryptTo(targetDir, path, strings.TrimSuffix(relPath, ".enc"))
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

func decryptTo(targetDir, embeddedPath, relName string) error {
	src, err := embeddedFiles.Open(embeddedPath)
	if err != nil {
		return err
	}
	defer src.Close()
	encBytes, err := io.ReadAll(src)
	if err != nil {
		return err
	}
	if len(encBytes) < 16 {
		return fmt.Errorf("encrypted file too short")
	}
	block, err := aes.NewCipher(aesKey[:])
	if err != nil {
		return err
	}
	nonce := encBytes[:16]
	ciphertext := encBytes[16:]
	stream := cipher.NewCTR(block, nonce)
	plain := make([]byte, len(ciphertext))
	stream.XORKeyStream(plain, ciphertext)

	dest := filepath.Join(targetDir, filepath.FromSlash(relName))
	os.MkdirAll(filepath.Dir(dest), 0755)
	return os.WriteFile(dest, plain, 0755)
}
