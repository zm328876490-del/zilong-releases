package config

import (
	"os"
	"path/filepath"
	"runtime"
)

type Config struct {
	Port         string
	WhisperExe   string // path to whisper-cli.exe (whisper-server.exe is derived from this)
	ModelPath    string
	ModelDir     string
	VadModelPath string // path to ggml-vad.bin (Silero VAD model for whisper)
	OllamaUrl    string
	OllamaModel  string
}

// WhisperPort returns the port for whisper-server (different from our WS port).
func (c *Config) WhisperPort() string {
	return "23321"
}

func Load() *Config {
	cfg := &Config{
		Port:        "29527",
		ModelDir:    filepath.Join("..", "models"),
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

	exeName := "whisper-cli"
	if runtime.GOOS == "windows" {
		exeName = "whisper-cli.exe"
	}

	// Look for whisper-cli in common locations
	candidates := []string{
		filepath.Join(".", exeName),
		filepath.Join("..", "whisper.cpp", "build", "bin", "Release", exeName),
		filepath.Join("..", "whisper.cpp", "build", "bin", exeName),
		filepath.Join("..", "whisper.cpp", exeName),
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
