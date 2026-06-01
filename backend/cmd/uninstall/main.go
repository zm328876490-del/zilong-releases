package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

func main() {
	fmt.Println("========================================")
	fmt.Println("  AI Translation - 卸载")
	fmt.Println("========================================")
	fmt.Println()

	// Step 1: Kill all related processes
	fmt.Print("正在停止服务...")
	exec.Command("taskkill", "/f", "/im", "translation-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "whisper-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "llama-server.exe").Run()
	exec.Command("taskkill", "/f", "/im", "python.exe").Run()
	fmt.Println(" 完成")

	// Step 2: Remove auto-start registry
	fmt.Print("正在清理注册表...")
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`,
		registry.SET_VALUE)
	if err == nil {
		k.DeleteValue("AI-Translation")
		k.Close()
	}
	// Remove uninstall registry
	uk, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Uninstall`,
		registry.SET_VALUE)
	if err == nil {
		registry.DeleteKey(uk, "AI-Translation")
		uk.Close()
	}
	fmt.Println(" 完成")

	// Step 3: Remove install directory
	exePath, _ := os.Executable()
	installDir := filepath.Dir(exePath)
	fmt.Print("正在删除文件...")
	os.RemoveAll(installDir)
	fmt.Println(" 完成")

	fmt.Println()
	fmt.Println("========================================")
	fmt.Println("  卸载完成！")
	fmt.Println("========================================")
	fmt.Scanln()
}
