package model

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"ai-translation/backend/hardware"
)

// PreparePhase represents the current stage of environment preparation.
type PreparePhase string

const (
	PhaseCheckOllama    PreparePhase = "checking_ollama"
	PhaseDownloadOllama PreparePhase = "downloading_ollama"
	PhaseInstallOllama  PreparePhase = "installing_ollama"
	PhaseStartOllama    PreparePhase = "starting_ollama"
	PhasePullingModel   PreparePhase = "pulling_model"
	PhaseLoadingModel   PreparePhase = "loading_model"
	PhaseReady          PreparePhase = "ready"
	PhaseError          PreparePhase = "error"
)

// PrepareState holds the current state of environment preparation.
type PrepareState struct {
	Phase      PreparePhase `json:"phase"`
	Model      string       `json:"model"`
	Progress   int          `json:"progress"`
	Downloaded string       `json:"downloaded"`
	Total      string       `json:"total"`
	ETA        string       `json:"eta"`
	Message    string       `json:"message"`
	Error      string       `json:"error,omitempty"`
	GPUModel   string       `json:"gpuModel,omitempty"`
	VRAMMB     int          `json:"vramMB,omitempty"`
}

// PrepareManager handles async preparation of the local translation environment.
// It downloads Ollama (if not installed), pulls the default model, and warms it up.
type PrepareManager struct {
	hw     hardware.Info
	state  PrepareState
	mu     sync.RWMutex
	notify chan struct{}
	once   sync.Once
}

// ollama download source URLs in priority order.
var ollamaDownloadURLs = []string{
	"https://ollama.com/download/OllamaSetup.exe",
	"https://ghproxy.com/https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe",
	"https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe",
}

// NewPrepareManager creates a new PrepareManager backed by hardware info.
func NewPrepareManager(hw hardware.Info) *PrepareManager {
	return &PrepareManager{
		hw:     hw,
		notify: make(chan struct{}, 1),
		state: PrepareState{
			Phase:   PhaseCheckOllama,
			Model:   hw.DefaultModel,
			Message: "正在检测运行环境...",
		},
	}
}

// Start begins the async preparation process. Safe to call multiple times —
// only the first call takes effect.
func (pm *PrepareManager) Start() {
	pm.once.Do(func() {
		go pm.run()
	})
}

// RestartOllama attempts to restart the Ollama service. Used by the health-check
// loop when it detects ollama has gone down.
func (pm *PrepareManager) RestartOllama() {
	go func() {
		if !pm.isOllamaInstalled() {
			return
		}
		pm.setState(PrepareState{Phase: PhaseStartOllama, Model: pm.hw.DefaultModel, Message: "正在启动运行环境..."})
		if err := pm.startOllama(); err != nil {
			pm.setState(PrepareState{Phase: PhaseError, Model: pm.hw.DefaultModel, Message: "运行环境启动失败", Error: err.Error()})
			return
		}
		// Back to ready — model is already pulled
		pm.setState(PrepareState{Phase: PhaseReady, Model: pm.hw.DefaultModel, Message: "本地翻译就绪"})
	}()
}

// State returns a copy of the current preparation state.
func (pm *PrepareManager) State() PrepareState {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	s := pm.state
	s.GPUModel = pm.hw.GPUModel
	s.VRAMMB = pm.hw.VRAMMB
	return s
}

// NotifyCh returns a channel that receives a signal when state changes.
func (pm *PrepareManager) NotifyCh() <-chan struct{} {
	return pm.notify
}

// ─── Internal ────────────────────────────────────────────────────────────────

func (pm *PrepareManager) setState(s PrepareState) {
	pm.mu.Lock()
	pm.state = s
	pm.mu.Unlock()
	// Non-blocking notify
	select {
	case pm.notify <- struct{}{}:
	default:
	}
}

func (pm *PrepareManager) run() {
	model := pm.hw.DefaultModel

	// Step 1: Check Ollama
	pm.setState(PrepareState{Phase: PhaseCheckOllama, Model: model, Message: "正在检测运行环境..."})

	if !pm.isOllamaInstalled() {
		// Step 2: Download Ollama
		pm.setState(PrepareState{Phase: PhaseDownloadOllama, Model: model, Message: "正在下载运行环境..."})
		installerPath, err := pm.downloadOllama()
		if err != nil {
			pm.setState(PrepareState{Phase: PhaseError, Model: model, Message: "运行环境下载失败，请检查网络后重试", Error: err.Error()})
			return
		}
		defer os.Remove(installerPath)

		// Step 3: Install Ollama
		pm.setState(PrepareState{Phase: PhaseInstallOllama, Model: model, Message: "正在安装运行环境..."})
		if err := pm.installOllama(installerPath); err != nil {
			pm.setState(PrepareState{Phase: PhaseError, Model: model, Message: "运行环境安装失败", Error: err.Error()})
			return
		}
	}

	// Step 4: Set OLLAMA_ORIGINS
	pm.ensureOllamaOrigins()

	// Step 5: Start Ollama
	pm.setState(PrepareState{Phase: PhaseStartOllama, Model: model, Message: "正在启动运行环境..."})
	if err := pm.startOllama(); err != nil {
		pm.setState(PrepareState{Phase: PhaseError, Model: model, Message: "运行环境启动失败", Error: err.Error()})
		return
	}

	// Step 6: Pull model (if not already present)
	if !pm.modelExists(model) {
		pm.setState(PrepareState{Phase: PhasePullingModel, Model: model, Message: "正在下载翻译模型...", Progress: 0})
		if err := pm.pullModel(model); err != nil {
			pm.setState(PrepareState{Phase: PhaseError, Model: model, Message: "模型下载失败", Error: err.Error()})
			return
		}
	}

	// Step 7: Warmup
	pm.setState(PrepareState{Phase: PhaseLoadingModel, Model: model, Message: "正在加载翻译模型..."})
	pm.warmupModel(model)

	pm.setState(PrepareState{Phase: PhaseReady, Model: model, Message: "本地翻译就绪", Progress: 100})
}

// ─── Ollama detection and installation ──────────────────────────────────────

func (pm *PrepareManager) isOllamaInstalled() bool {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("APPDATA"), "..", "Local")
	}
	paths := []string{
		filepath.Join(localAppData, "Programs", "Ollama", "ollama.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Ollama", "ollama.exe"),
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	_, err := exec.LookPath("ollama.exe")
	if err != nil {
		_, err = exec.LookPath("ollama")
	}
	return err == nil
}

func (pm *PrepareManager) downloadOllama() (string, error) {
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("OllamaSetup-%d.exe", time.Now().UnixNano()))

	var lastErr error
	for _, url := range ollamaDownloadURLs {
		fmt.Printf("[prepare] trying download: %s\n", url)
		err := pm.downloadFile(url, tmpFile)
		if err == nil {
			return tmpFile, nil
		}
		lastErr = err
		fmt.Printf("[prepare] download failed: %v\n", err)
	}
	return "", fmt.Errorf("所有下载源均失败: %w", lastErr)
}

func (pm *PrepareManager) downloadFile(url, dest string) error {
	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	defer f.Close()

	totalSize := resp.ContentLength
	buf := make([]byte, 32*1024)
	var downloaded int64
	var lastUpdate time.Time

	for {
		nr, readErr := resp.Body.Read(buf)
		if nr > 0 {
			nw, writeErr := f.Write(buf[:nr])
			if writeErr != nil {
				return fmt.Errorf("write: %w", writeErr)
			}
			if nw != nr {
				return fmt.Errorf("write incomplete")
			}
			downloaded += int64(nw)
			// Throttle updates to 300ms
			if totalSize > 0 && time.Since(lastUpdate) > 300*time.Millisecond {
				lastUpdate = time.Now()
				pct := int(downloaded * 100 / totalSize)
				pm.setState(PrepareState{
					Phase:      PhaseDownloadOllama,
					Model:      pm.hw.DefaultModel,
					Progress:   pct,
					Downloaded: formatBytes(downloaded),
					Total:      formatBytes(totalSize),
					Message:    "正在下载运行环境...",
				})
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return fmt.Errorf("download interrupted: %w", readErr)
		}
	}
	return nil
}

func (pm *PrepareManager) installOllama(installerPath string) error {
	cmd := exec.Command(installerPath, "/VERYSILENT", "/NORESTART")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ollama installer: %w", err)
	}
	return nil
}

// ─── Ollama service management ──────────────────────────────────────────────

func (pm *PrepareManager) ensureOllamaOrigins() {
	key := `HKCU\Environment`
	val, err := registryGetString(key, "OLLAMA_ORIGINS")
	if err != nil || val != "*" {
		cmd := exec.Command("setx", "OLLAMA_ORIGINS", "*")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Run(); err != nil {
			fmt.Println("[prepare] warn: failed to set OLLAMA_ORIGINS=*:", err)
		} else {
			fmt.Println("[prepare] OLLAMA_ORIGINS=* set")
			// Restart Ollama so the new env var takes effect
			exec.Command("taskkill", "/f", "/im", "ollama.exe").Run()
			time.Sleep(2 * time.Second)
		}
	}
}

func (pm *PrepareManager) startOllama() error {
	if pm.isOllamaRunning() {
		fmt.Println("[prepare] ollama is already running")
		return nil
	}

	ollamaPath := pm.findOllamaExe()
	if ollamaPath == "" {
		return fmt.Errorf("ollama.exe not found after installation")
	}

	cmd := exec.Command(ollamaPath)
	cmd.Dir = filepath.Dir(ollamaPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start ollama: %w", err)
	}
	fmt.Println("[prepare] ollama started")

	// Wait for it to be ready
	for i := 0; i < 60; i++ {
		time.Sleep(500 * time.Millisecond)
		if pm.isOllamaRunning() {
			return nil
		}
	}
	return fmt.Errorf("ollama startup timeout")
}

func (pm *PrepareManager) isOllamaRunning() bool {
	resp, err := httpGet("http://127.0.0.1:11434/api/tags")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

func (pm *PrepareManager) findOllamaExe() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("APPDATA"), "..", "Local")
	}
	path := filepath.Join(localAppData, "Programs", "Ollama", "ollama.exe")
	if _, err := os.Stat(path); err == nil {
		return path
	}
	if p, err := exec.LookPath("ollama.exe"); err == nil {
		return p
	}
	if p, err := exec.LookPath("ollama"); err == nil {
		return p
	}
	return ""
}

// ─── Model management ───────────────────────────────────────────────────────

func (pm *PrepareManager) modelExists(modelName string) bool {
	resp, err := httpGet("http://127.0.0.1:11434/api/tags")
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var data struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if json.Unmarshal(body, &data) != nil {
		return false
	}
	// Match against "modelName:latest" or bare "modelName"
	for _, m := range data.Models {
		if m.Name == modelName || m.Name == modelName+":latest" {
			return true
		}
	}
	return false
}

// pullModel runs `ollama pull` via HTTP streaming API and parses progress.
func (pm *PrepareManager) pullModel(modelName string) error {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"name":   modelName,
		"stream": true,
	})

	req, _ := http.NewRequest("POST", "http://127.0.0.1:11434/api/pull", strings.NewReader(string(reqBody)))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("pull request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pull HTTP %d: %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var total, completed int64
	var startTime = time.Now()

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var evt struct {
			Status    string `json:"status"`
			Total     int64  `json:"total"`
			Completed int64  `json:"completed"`
			Error     string `json:"error"`
		}
		if json.Unmarshal([]byte(line), &evt) != nil {
			continue
		}

		if evt.Error != "" {
			return fmt.Errorf("pull error: %s", evt.Error)
		}

		switch {
		case evt.Status == "success":
			return nil
		case evt.Total > 0 && evt.Completed >= 0:
			total = evt.Total
			completed = evt.Completed
			pct := int(completed * 100 / total)
			eta := ""
			if pct > 0 && pct < 100 {
				elapsed := time.Since(startTime)
				estimated := elapsed * 100 / time.Duration(pct)
				eta = (estimated - elapsed).Truncate(time.Second).String()
			}
			pm.setState(PrepareState{
				Phase:      PhasePullingModel,
				Model:      modelName,
				Progress:   pct,
				Downloaded: formatBytes(completed),
				Total:      formatBytes(total),
				ETA:        eta,
				Message:    "正在下载翻译模型...",
			})
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("pull stream: %w", err)
	}
	// If we got here without "success", check if model appeared
	if pm.modelExists(modelName) {
		return nil
	}
	return fmt.Errorf("pull completed but model not found")
}

func (pm *PrepareManager) warmupModel(modelName string) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"model":  modelName,
		"prompt": "hi",
		"stream": false,
		"options": map[string]interface{}{
			"num_predict": 1,
		},
	})
	req, _ := http.NewRequest("POST", "http://127.0.0.1:11434/api/generate", strings.NewReader(string(reqBody)))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[prepare] warmup failed: %v\n", err)
		return
	}
	defer resp.Body.Close()
	fmt.Println("[prepare] model warmup complete")
}

// ─── Helpers ────────────────────────────────────────────────────────────────

func registryGetString(key, name string) (string, error) {
	cmd := exec.Command("reg", "query", key, "/v", name)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) >= 3 && strings.EqualFold(parts[0], name) {
			return parts[len(parts)-1], nil
		}
	}
	return "", fmt.Errorf("not found")
}

func httpGet(url string) (*http.Response, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	return client.Get(url)
}

func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for n1 := n / unit; n1 >= unit; n1 /= unit {
		div *= unit
		exp++
	}
	switch exp {
	case 0:
		return fmt.Sprintf("%.0fKB", float64(n)/float64(div))
	case 1:
		return fmt.Sprintf("%.0fMB", float64(n)/float64(div))
	case 2:
		return fmt.Sprintf("%.1fGB", float64(n)/float64(div))
	default:
		return fmt.Sprintf("%d", n)
	}
}
