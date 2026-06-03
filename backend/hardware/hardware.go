package hardware

import (
	"encoding/csv"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// Info holds hardware detection results.
type Info struct {
	GPUModel     string // e.g. "NVIDIA GeForce RTX 4060"
	VRAMMB       int    // dedicated video memory in MB
	RAMMB        int    // system RAM in MB
	Tier         string // "light" / "standard" / "advanced"
	DefaultModel string // recommended ollama model name
}

type memoryStatusEx struct {
	dwLength                uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

// Detect probes the system hardware and returns a recommended configuration.
func Detect() Info {
	info := Info{}

	// ── System RAM ────────────────────────────────────────────────
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	globalMemoryStatusEx := kernel32.NewProc("GlobalMemoryStatusEx")

	var memStat memoryStatusEx
	memStat.dwLength = uint32(unsafe.Sizeof(memStat))
	ret, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&memStat)))
	if ret != 0 {
		info.RAMMB = int(memStat.ullTotalPhys / (1024 * 1024))
	}

	// ── GPU VRAM ──────────────────────────────────────────────────
	info.GPUModel, info.VRAMMB = detectVRAM()

	// ── Tier assignment ───────────────────────────────────────────
	// Decision tree based on GPU VRAM and system RAM.
	// No dedicated GPU → CPU inference, RAM is the only limit.
	// With GPU → VRAM determines model size, RAM acts as a hard floor.
	switch {
	case info.RAMMB < 4096:
		info.Tier = ""
		info.DefaultModel = ""
	case info.VRAMMB == 0:
		info.Tier = "light"
		info.DefaultModel = "qwen2.5:1.5b"
	case info.RAMMB < 8192:
		info.Tier = "light"
		info.DefaultModel = "qwen2.5:1.5b"
	case info.VRAMMB < 3072:
		info.Tier = "light"
		info.DefaultModel = "qwen2.5:1.5b"
	case info.VRAMMB < 6144 || info.RAMMB < 16384:
		info.Tier = "standard"
		info.DefaultModel = "qwen2.5:3b"
	default:
		info.Tier = "advanced"
		info.DefaultModel = "qwen2.5:3b"
	}

	return info
}

// detectVRAM returns GPU model name and dedicated VRAM in MB.
// Falls back through multiple detection methods.
func detectVRAM() (model string, vramMB int) {
	// Method 1: nvidia-smi (most accurate for NVIDIA)
	if m, v := detectNvidiaSMI(); v > 0 {
		return m, v
	}

	// Method 2: WMI Win32_VideoController (works for all GPU vendors)
	if m, v := detectWMI(); v > 0 {
		return m, v
	}

	return "", 0
}

func detectNvidiaSMI() (string, int) {
	// Query GPU name and memory
	cmd := exec.Command("nvidia-smi",
		"--query-gpu=name",
		"--format=csv,noheader",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	nameOut, err := cmd.Output()
	if err != nil {
		return "", 0
	}

	cmd2 := exec.Command("nvidia-smi",
		"--query-gpu=memory.total",
		"--format=csv,noheader,nounits",
	)
	cmd2.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	memOut, err := cmd2.Output()
	if err != nil {
		return "", 0
	}

	names := parseCSV(string(nameOut))
	mems := parseCSV(string(memOut))

	if len(mems) > 0 {
		if mb, err := strconv.Atoi(strings.TrimSpace(mems[0])); err == nil && mb > 0 {
			model := ""
			if len(names) > 0 {
				model = strings.TrimSpace(names[0])
			}
			return model, mb
		}
	}
	return "", 0
}

func detectWMI() (string, int) {
	cmd := exec.Command("wmic",
		"path", "win32_videocontroller",
		"get", "name,adapterram",
		"/format:csv",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return "", 0
	}

	lines := strings.Split(string(out), "\n")
	var totalBytes int64
	var modelNames []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// CSV format: Node,Name,AdapterRAM\r
		parts := strings.Split(line, ",")
		if len(parts) < 3 {
			continue
		}
		// Skip header
		if strings.EqualFold(strings.TrimSpace(parts[2]), "AdapterRAM") ||
			strings.EqualFold(strings.TrimSpace(parts[2]), "AdapterRam") {
			continue
		}
		name := strings.TrimSpace(parts[1])
		ramStr := strings.TrimSpace(parts[2])
		if bytes, err := strconv.ParseInt(ramStr, 10, 64); err == nil && bytes > 0 {
			totalBytes += bytes
			if name != "" {
				modelNames = append(modelNames, name)
			}
		}
	}

	if totalBytes > 0 {
		return strings.Join(modelNames, ", "), int(totalBytes / (1024 * 1024))
	}
	return "", 0
}

func parseCSV(raw string) []string {
	r := csv.NewReader(strings.NewReader(raw))
	var result []string
	for {
		record, err := r.Read()
		if err != nil {
			break
		}
		result = append(result, record...)
	}
	return result
}
