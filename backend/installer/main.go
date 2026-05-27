package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows/registry"
)

// Override at build time: go build -ldflags "-X main.downloadURL=..."
var downloadURL = "http://localhost:14532/api/download/installer"

const serviceExe = "translation-server.exe"

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

	// Step 1: Kill existing process
	exec.Command("taskkill", "/f", "/im", serviceExe).Run()
	time.Sleep(300 * time.Millisecond)

	// Step 2: Download
	fmt.Print("正在下载后端服务...")
	resp, err := http.Get(downloadURL)
	if err != nil {
		fmt.Println(" 失败!")
		fmt.Println("无法连接服务器:", err)
		fmt.Scanln()
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		fmt.Println(" 失败!")
		fmt.Println("服务器返回错误:", resp.StatusCode)
		fmt.Scanln()
		os.Exit(1)
	}

	contentLength := resp.ContentLength
	var data []byte
	bar := &progressBar{total: contentLength, lastPrint: time.Now()}
	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			data = append(data, buf[:n]...)
			bar.update(int64(len(data)))
		}
		if err != nil {
			break
		}
	}
	fmt.Println(" 完成!")

	// Step 3: Extract
	fmt.Print("正在解压...")
	zipReader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		fmt.Println(" 失败!")
		fmt.Println("解压错误:", err)
		fmt.Scanln()
		os.Exit(1)
	}

	os.MkdirAll(targetDir, 0755)
	for _, f := range zipReader.File {
		dest := filepath.Join(targetDir, f.Name)
		if f.FileInfo().IsDir() {
			os.MkdirAll(dest, 0755)
			continue
		}
		os.MkdirAll(filepath.Dir(dest), 0755)

		rc, err := f.Open()
		if err != nil {
			continue
		}
		dst, err := os.Create(dest)
		if err != nil {
			rc.Close()
			continue
		}
		io.Copy(dst, rc)
		rc.Close()
		dst.Close()
	}
	fmt.Println(" 完成!")

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

type progressBar struct {
	total     int64
	drawn     int64
	lastPrint time.Time
}

func (p *progressBar) update(current int64) {
	now := time.Now()
	if now.Sub(p.lastPrint) < 200*time.Millisecond && current < p.total {
		return
	}
	p.lastPrint = now
	barWidth := 30
	filled := int(float64(current) / float64(p.total) * float64(barWidth))
	if filled > barWidth {
		filled = barWidth
	}
	fmt.Printf("\r正在下载后端服务... [")
	for i := 0; i < filled; i++ {
		fmt.Print("=")
	}
	for i := filled; i < barWidth; i++ {
		fmt.Print(" ")
	}
	pct := int64(0)
	if p.total > 0 {
		pct = current * 100 / p.total
	}
	fmt.Printf("] %d%% (%d/%d MB)", pct, current/(1024*1024), p.total/(1024*1024))
}
