package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ai-translation/backend/asr"
	"ai-translation/backend/config"
	"ai-translation/backend/translate"
	"ai-translation/backend/tts"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Client represents a connected browser extension.
type Client struct {
	conn            *websocket.Conn
	mu              sync.Mutex
	audioBuf        *asr.AudioBuffer
	translator      *translate.Translator
	sourceLang      string
	targetLang      string
	active          bool
	audioChunkCount int // diagnostic counter
}

// Subtitle is a single subtitle cue extracted from a video platform.
type Subtitle struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// PreprocessResult is one pre-translated + pre-synthesized subtitle.
type PreprocessResult struct {
	Index       int     `json:"index"`
	Original    string  `json:"original"`
	Translation string  `json:"translation"`
	Audio       string  `json:"audio,omitempty"`
	Start       float64 `json:"start"`
	End         float64 `json:"end"`
}

type OutMsg struct {
	Type        string             `json:"type"`
	Text        string             `json:"text,omitempty"`
	Original    string             `json:"original,omitempty"`
	Translation string             `json:"translation,omitempty"`
	Status      string             `json:"status,omitempty"`
	Message     string             `json:"message,omitempty"`
	Audio       string             `json:"audio,omitempty"`
	AudioMime   string             `json:"audioMime,omitempty"`
	SpeechRate  float64            `json:"speechRate,omitempty"`
	Partial     bool               `json:"partial,omitempty"` // true for streaming ASR preview
	Index       int                `json:"index,omitempty"`   // audio chunk sequence number (-1 = end)
	Items       []PreprocessResult `json:"items,omitempty"`   // batch preprocess results
	Total       int                `json:"total,omitempty"`   // total subtitle count
}

type InMsg struct {
	Type        string     `json:"type"`
	SourceLang  string     `json:"sourceLang,omitempty"`
	TargetLang  string     `json:"targetLang,omitempty"`
	APIKey      string     `json:"apiKey,omitempty"`
	Region      string     `json:"region,omitempty"`
	BaiduAppID  string     `json:"baiduAppID,omitempty"`
	BaiduSecret string     `json:"baiduSecret,omitempty"`
	Subs        []Subtitle `json:"subs,omitempty"` // preprocess mode
	Text        string     `json:"text,omitempty"` // DOM subtitle text
}

func (c *Client) sendJSON(msg OutMsg) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(msg)
}

func (c *Client) onASRResult(text string, speechRate float64, isPartial bool) {
	if !c.active {
		return
	}
	c.sendJSON(OutMsg{Type: "original", Text: text, Partial: isPartial})

	// Partial results are streaming previews — don't translate or TTS yet
	if isPartial {
		return
	}

	if c.translator != nil && c.targetLang != "" {
		translated, err := c.translator.Translate(text, c.sourceLang, c.targetLang)
		if err != nil {
			log.Printf("translate error: %v", err)
			c.sendJSON(OutMsg{Type: "error", Message: fmt.Sprintf("Translation error: %v", err)})
			return
		}
		if translated != "" {
			c.sendJSON(OutMsg{
				Type:        "result",
				Original:    text,
				Translation: translated,
				SpeechRate:  speechRate,
			})

			// Generate TTS in background (doesn't block next ASR result)
			go c.generateAndSendTTS(translated, speechRate)
		}
	}
}

func (c *Client) generateAndSendTTS(text string, speechRate float64) {
	voice := tts.VoiceForLang(c.targetLang)

	// Send audio_start first so the client can prepare MSE / playback
	c.sendJSON(OutMsg{
		Type:       "audio_start",
		Original:   text,
		SpeechRate: speechRate,
	})

	idx := 0
	batchSize := 3072 // buffer ~500ms of mp3 before sending to avoid SourceBuffer starvation
	var buf []byte
	flush := func(final bool) {
		if len(buf) == 0 && !final {
			return
		}
		c.sendJSON(OutMsg{
			Type:    "audio_chunk",
			Original: text,
			Audio:   base64.StdEncoding.EncodeToString(buf),
			Index:   idx,
		})
		idx++
		buf = buf[:0]
	}
	err := tts.SynthesizeStream(text, voice, func(ch tts.AudioChunk) {
		if ch.Final {
			flush(false)
			c.sendJSON(OutMsg{Type: "audio_end", Original: text, Index: -1, SpeechRate: speechRate})
		} else {
			buf = append(buf, ch.Data...)
			if len(buf) >= batchSize {
				flush(false)
			}
		}
	})
	if err != nil {
		log.Printf("tts error: %v", err)
		// Signal client that the TTS stream failed — triggers fallback or cleanup
		c.sendJSON(OutMsg{Type: "audio_end", Original: text, Index: -1, SpeechRate: speechRate})
	}
}

// ─── Preprocess (subtitle hijacking mode) ─────────────────────────────

// handleDOMSubtitle translates a single DOM-captured subtitle and generates TTS.
func (c *Client) handleDOMSubtitle(text string) {
	if c.translator == nil || c.targetLang == "" {
		return
	}
	translated, err := c.translator.Translate(text, c.sourceLang, c.targetLang)
	if err != nil {
		log.Printf("dom subtitle translate error: %v", err)
		c.sendJSON(OutMsg{Type: "error", Message: fmt.Sprintf("Translation error: %v", err)})
		return
	}
	if translated == "" {
		return
	}
	c.sendJSON(OutMsg{
		Type:        "result",
		Original:    text,
		Translation: translated,
	})
	go c.generateAndSendTTS(translated, 5.0)
}

// handlePreprocess runs concurrent translation + TTS synthesis for all subtitles
// and streams results back to the client.
func (c *Client) handlePreprocess(subs []Subtitle) {
	if c.translator == nil {
		c.sendJSON(OutMsg{Type: "preprocess_error", Message: "Not configured — send config first"})
		return
	}

	subs = mergeSubtitles(subs)
	if len(subs) == 0 {
		c.sendJSON(OutMsg{Type: "preprocess_error", Message: "No subtitles to process"})
		return
	}

	log.Printf("preprocess: %d subtitles, translating + synthesizing...", len(subs))
	c.sendJSON(OutMsg{Type: "preprocess_start", Total: len(subs)})

	voice := tts.VoiceForLang(c.targetLang)
	from := c.sourceLang
	to := c.targetLang

	// Phase 1: concurrent translation (5 workers)
	translated := make([]string, len(subs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)

	for i, sub := range subs {
		wg.Add(1)
		go func(idx int, text string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			result, err := c.translator.Translate(text, from, to)
			if err == nil && result != "" {
				translated[idx] = result
			}
		}(i, sub.Text)
	}
	wg.Wait()

	// Phase 2: concurrent TTS + streaming results back
	var mu sync.Mutex
	var batch []PreprocessResult
	completed := 0
	total := 0

	for i, trans := range translated {
		if trans == "" {
			continue
		}
		total++
		wg.Add(1)
		go func(idx int, translation string) {
			defer wg.Done()
			var audio string
			var err error
			audio, err = tts.Synthesize(translation, voice)
			if err != nil {
				log.Printf("preprocess tts error [%d]: %v", idx, err)
			}
			item := PreprocessResult{
				Index:       idx,
				Original:    subs[idx].Text,
				Translation: translation,
				Audio:       audio,
				Start:       subs[idx].Start,
				End:         subs[idx].End,
			}
			mu.Lock()
			batch = append(batch, item)
			completed++
			if len(batch) >= 3 || completed == total {
				c.sendJSON(OutMsg{Type: "preprocess_result", Items: batch})
				batch = nil
			}
			mu.Unlock()
		}(i, trans)
	}
	wg.Wait()

	if len(batch) > 0 {
		c.sendJSON(OutMsg{Type: "preprocess_result", Items: batch})
	}

	c.sendJSON(OutMsg{Type: "preprocess_complete"})
	log.Printf("preprocess complete: %d/%d subtitles synthesized", total, len(subs))
}

// mergeSubtitles deduplicates and merges adjacent subtitles with very short gaps.
func mergeSubtitles(subs []Subtitle) []Subtitle {
	if len(subs) <= 1 {
		return subs
	}
	var out []Subtitle
	cur := subs[0]
	for i := 1; i < len(subs); i++ {
		next := subs[i]
		if next.Start-cur.End < 0.3 && len(cur.Text)+len(next.Text) < 200 {
			cur.Text += " " + next.Text
			cur.End = next.End
		} else {
			if len(strings.TrimSpace(cur.Text)) >= 2 {
				out = append(out, cur)
			}
			cur = next
		}
	}
	if len(strings.TrimSpace(cur.Text)) >= 2 {
		out = append(out, cur)
	}
	return out
}

// ─── WebSocket handler ────────────────────────────────────────────────

// whisperServerURL is set at startup after whisper-server is ready.
var whisperServerURL string

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	defer conn.Close()

	client := &Client{
		conn:       conn,
		sourceLang: "auto",
		targetLang: "zh-Hans",
	}

	log.Printf("client connected from %s", r.RemoteAddr)

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			return
		}

		switch msgType {
		case websocket.TextMessage:
			var msg InMsg
			if err := json.Unmarshal(data, &msg); err != nil {
				log.Printf("json parse error: %v", err)
				continue
			}

			switch msg.Type {
			case "config":
				client.sourceLang = msg.SourceLang
				client.targetLang = msg.TargetLang
				client.translator = translate.New(msg.APIKey, msg.Region)
				if msg.BaiduAppID != "" {
					client.translator.SetBaiduCredentials(msg.BaiduAppID, msg.BaiduSecret)
				}
				client.audioBuf = asr.NewAudioBuffer(
					whisperServerURL,
					client.sourceLang,
					client.onASRResult,
				)
				client.sendJSON(OutMsg{Type: "status", Status: "configured"})
				log.Printf("client configured: %s → %s", client.sourceLang, client.targetLang)

			case "warmup":
				go func() {
					// Translate warmup
					client.translator.Translate("hello", client.sourceLang, client.targetLang)
					// TTS warmup (fire-and-forget via Go-native Edge TTS)
					tts.Warmup(tts.VoiceForLang(client.targetLang))
					client.sendJSON(OutMsg{Type: "status", Status: "ready"})
					log.Printf("warmup complete for %s → %s", client.sourceLang, client.targetLang)
				}()

			case "start":
				client.active = true
				client.sendJSON(OutMsg{Type: "status", Status: "listening"})

			case "stop":
				client.active = false
				client.sendJSON(OutMsg{Type: "status", Status: "stopped"})

			case "subtitle":
				go client.handleDOMSubtitle(msg.Text)

			case "preprocess":
				go client.handlePreprocess(msg.Subs)

			default:
				log.Printf("unknown message type: %s", msg.Type)
			}

		case websocket.BinaryMessage:
			if client.audioBuf == nil {
				continue
			}
			sampleCount := len(data) / 2
			samples := make([]int16, sampleCount)
			for i := 0; i < sampleCount; i++ {
				samples[i] = int16(binary.LittleEndian.Uint16(data[i*2 : (i+1)*2]))
			}

			// Diagnostic: log audio level every ~2 seconds
			client.audioChunkCount++
			if client.audioChunkCount%15 == 1 {
				var sum int
				for _, s := range samples {
					if s < 0 {
						sum -= int(s)
					} else {
						sum += int(s)
					}
				}
				avgLevel := float64(sum) / float64(sampleCount) / 32768.0
				log.Printf("audio chunk #%d: %d samples, avg level=%.4f",
					client.audioChunkCount, sampleCount, avgLevel)
			}

			client.audioBuf.Append(samples)
		}
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// startWhisperServer launches whisper-server as a persistent subprocess.
func startWhisperServer(cfg *config.Config) (*exec.Cmd, error) {
	if cfg.WhisperExe == "" || cfg.ModelPath == "" {
		return nil, fmt.Errorf("whisper-server or model not found")
	}

	// Locate whisper-server.exe (same directory as whisper-cli.exe)
	serverExe := ".\\whisper-server.exe"
	if _, err := os.Stat(serverExe); err != nil {
		dir := filepath.Dir(cfg.WhisperExe)
		serverExe = filepath.Join(dir, "whisper-server.exe")
		if _, err := os.Stat(serverExe); err != nil {
			return nil, fmt.Errorf("whisper-server.exe not found")
		}
	}

	whisperPort := cfg.WhisperPort()
	whisperServerURL = fmt.Sprintf("http://127.0.0.1:%s", whisperPort)

	args := []string{
		"-m", cfg.ModelPath,
		"-l", "auto",
		"--port", whisperPort,
		"--host", "127.0.0.1",
		"--no-timestamps",
	}

	log.Printf("Starting whisper-server: %s %v", serverExe, args)
	cmd := exec.Command(serverExe, args...)
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stdout

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start whisper-server: %w", err)
	}

	// Wait for it to be ready
	if err := waitForServer(whisperServerURL+"/inference", 15*time.Second); err != nil {
		cmd.Process.Kill()
		return nil, fmt.Errorf("whisper-server startup: %w", err)
	}

	log.Printf("whisper-server ready at %s (model loaded, ~0ms per-request overhead)", whisperServerURL)
	return cmd, nil
}

func waitForServer(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for whisper-server")
}

// handleFetchSubtitles fetches a YouTube timedtext URL server-side,
// parses the XML, and returns [{text, start, end}, ...] as JSON.
func handleFetchSubtitles(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		http.Error(w, `{"error":"missing url param"}`, http.StatusBadRequest)
		return
	}

	resp, err := http.Get(url)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"fetch: %s"}`, err.Error()), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"read: %s"}`, err.Error()), http.StatusBadGateway)
		return
	}

	subs := parseTimedTextXML(string(body))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(subs)
}

// parseTimedTextXML parses YouTube's XML timedtext format.
func parseTimedTextXML(raw string) []Subtitle {
	re := regexp.MustCompile(`<text start="([\d.]+)" dur="([\d.]+)">([^<]*)</text>`)
	matches := re.FindAllStringSubmatch(raw, -1)
	var subs []Subtitle
	for _, m := range matches {
		if len(m) < 4 {
			continue
		}
		start, _ := strconv.ParseFloat(m[1], 64)
		dur, _ := strconv.ParseFloat(m[2], 64)
		text := html.UnescapeString(m[3])
		text = strings.TrimSpace(text)
		if len([]rune(text)) >= 2 {
			subs = append(subs, Subtitle{Text: text, Start: start, End: start + dur})
		}
	}
	return subs
}

func main() {
	cfg := config.Load()

	// Start whisper-server (keeps model warm)
	whisperCmd, err := startWhisperServer(cfg)
	if err != nil {
		log.Printf("⚠ ASR unavailable: %v", err)
		log.Printf("  The extension will still connect but ASR won't work.")
		log.Printf("  Make sure whisper-server.exe and model are in place.")
	} else {
		defer whisperCmd.Process.Kill()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWebSocket)

	mux.HandleFunc("/fetch-subtitles", handleFetchSubtitles)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		status := map[string]interface{}{
			"status":     "ok",
			"whisperExe": cfg.WhisperExe,
			"modelPath":  cfg.ModelPath,
			"asrServer":  whisperServerURL,
		}
		json.NewEncoder(w).Encode(status)
	})

	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Printf("=== AI Translation Backend ===")
	log.Printf("WebSocket: ws://localhost%s/ws", addr)
	log.Printf("Health:    http://localhost%s/health", addr)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		if whisperCmd != nil {
			whisperCmd.Process.Kill()
		}
		os.Exit(0)
	}()

	handler := corsMiddleware(mux)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
