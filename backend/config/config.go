package config

import (
	"os"
	"path/filepath"
	"runtime"
)

type Config struct {
	Port           string
	WhisperExe     string // path to whisper-cli.exe (whisper-server.exe is derived from this)
	ModelPath      string
	ModelDir       string
	VadModelPath   string // path to ggml-vad.bin (Silero VAD model for whisper)
	OllamaUrl      string
	OllamaModel    string
	OpenAIUrl      string
	OpenAIKey      string
	OpenAIModel    string
	DeepLKey       string
}

// WhisperPort returns the port for whisper-server (different from our WS port).
func (c *Config) WhisperPort() string {
	return "23321"
}

// exeDir returns the directory containing the running executable.
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func Load() *Config {
	ed := exeDir()
	cfg := &Config{
		Port:        "29527",
		ModelDir:    filepath.Join(ed, "models"),
		OllamaUrl:   "http://localhost:11434",
		OllamaModel: "qwen2.5:7b",
	}

	if p := os.Getenv("PORT"); p != "" {
		cfg.Port = p
	}
	if u := os.Getenv("OLLAMA_URL"); u != "" {
		cfg.OllamaUrl = u
	}
	if m := os.Getenv("OLLAMA_MODEL"); m != "" {
		cfg.OllamaModel = m
	}
	if u := os.Getenv("OPENAI_URL"); u != "" {
		cfg.OpenAIUrl = u
	}
	if k := os.Getenv("OPENAI_KEY"); k != "" {
		cfg.OpenAIKey = k
	}
	if m := os.Getenv("OPENAI_MODEL"); m != "" {
		cfg.OpenAIModel = m
	}
	if k := os.Getenv("DEEPL_KEY"); k != "" {
		cfg.DeepLKey = k
	}
	exeName := "whisper-cli"
	if runtime.GOOS == "windows" {
		exeName = "whisper-cli.exe"
	}

	// Look for whisper-cli in common locations
	candidates := []string{
		filepath.Join(ed, "whisper-server.exe"),
		filepath.Join(ed, exeName),
		filepath.Join(ed, "..", "whisper.cpp", "build", "bin", "Release", exeName),
		filepath.Join(ed, "..", "whisper.cpp", "build", "bin", exeName),
		filepath.Join(ed, "..", "whisper.cpp", exeName),
	}
	if envExe := os.Getenv("WHISPER_EXE"); envExe != "" {
		candidates = append([]string{envExe}, candidates...)
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			cfg.WhisperExe = c
			break
		}
	}

	// Model candidates
	modelCandidates := []string{
		filepath.Join(cfg.ModelDir, "ggml-tiny.bin"),
		filepath.Join(cfg.ModelDir, "ggml-tiny.gguf"),
		filepath.Join(cfg.ModelDir, "ggml-tiny.en.bin"),
	}
	if envModel := os.Getenv("WHISPER_MODEL"); envModel != "" {
		modelCandidates = append([]string{envModel}, modelCandidates...)
	}
	for _, c := range modelCandidates {
		if _, err := os.Stat(c); err == nil {
			cfg.ModelPath = c
			break
		}
	}

	// VAD model candidates
	vadCandidates := []string{
		filepath.Join(cfg.ModelDir, "ggml-vad.bin"),
	}
	if envVad := os.Getenv("WHISPER_VAD_MODEL"); envVad != "" {
		vadCandidates = append([]string{envVad}, vadCandidates...)
	}
	for _, c := range vadCandidates {
		if _, err := os.Stat(c); err == nil {
			cfg.VadModelPath = c
			break
		}
	}

	return cfg
}
