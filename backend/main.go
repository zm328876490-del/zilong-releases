package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
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
	ttsVoice        string // user-selected TTS voice name (short form)
	active          bool
	ttsCancel       chan struct{} // cancels the previous streaming TTS goroutine
	ttsCancelMu     sync.Mutex    // guards ttsCancel
	lastTtsTime     time.Time     // last time a TTS goroutine was started (for throttling)

	// offline ASR state
	offlineASR        bool
	offlineBuf        []int16
	offlineSpeed      float64 // playback speed during recording (for timestamp scaling)
	offlineSampleRate int     // actual AudioContext sample rate from frontend
}

// Subtitle is a single subtitle cue extracted from a video platform.
type Subtitle struct {
	Text          string             `json:"text"`
	Start         float64            `json:"start"`
	End           float64            `json:"end"`
	SkipTranslate bool               `json:"skipTranslate,omitempty"`
	Words         []asr.WordTimestamp `json:"words,omitempty"`
}

// Pending translations for async Google Translate via browser
type pendingItem struct {
	result chan string
	errCh  chan error
}

var pendingMu sync.Mutex
var pendingMap = make(map[string]*pendingItem)

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (c *Client) translateViaBrowser(text, from, to string) (string, error) {
	id := newID()
	ch := make(chan string, 1)
	errCh := make(chan error, 1)

	pendingMu.Lock()
	pendingMap[id] = &pendingItem{result: ch, errCh: errCh}
	pendingMu.Unlock()

	c.sendJSON(OutMsg{Type: "translate_request", ID: id, Text: text, TargetLang: to})

	select {
	case result := <-ch:
		return result, nil
	case err := <-errCh:
		return "", err
	case <-time.After(10 * time.Second):
		pendingMu.Lock()
		delete(pendingMap, id)
		pendingMu.Unlock()
		return "", fmt.Errorf("Google 翻译超时")
	}
}

// PreprocessResult is one pre-translated + pre-synthesized subtitle.
type PreprocessResult struct {
	Index       int                `json:"index"`
	Original    string             `json:"original"`
	Translation string             `json:"translation"`
	Audio       string             `json:"audio,omitempty"`
	Start       float64            `json:"start"`
	End         float64            `json:"end"`
	DurationMs  int                `json:"durationMs,omitempty"` // TTS audio duration (ms), for time-stretch sync
	Words       []asr.WordTimestamp `json:"words,omitempty"`     // per-word timestamps from whisper
}

type OutMsg struct {
	Type        string             `json:"type"`
	ID          string             `json:"id,omitempty"`        // translate_request correlation
	TargetLang  string             `json:"targetLang,omitempty"` // translate_request target
	Text        string             `json:"text,omitempty"`
	Original    string             `json:"original,omitempty"`
	Translation string             `json:"translation,omitempty"`
	Status      string             `json:"status,omitempty"`
	Message     string             `json:"message,omitempty"`
	Audio       string             `json:"audio,omitempty"`
	AudioMime   string             `json:"audioMime,omitempty"`
	SpeechRate  float64            `json:"speechRate,omitempty"`
	Duration    float64            `json:"duration,omitempty"`
	Speaker     string             `json:"speaker,omitempty"`
	Partial     bool               `json:"partial,omitempty"`
	Index       int                `json:"index,omitempty"`
	Items       []PreprocessResult `json:"items,omitempty"`
	Subs        []Subtitle         `json:"subs,omitempty"`
	Total       int                `json:"total,omitempty"`
	UtteranceId string             `json:"utteranceId,omitempty"` // ties audio_start/chunk/end to a specific utterance
	TtsPartial   bool               `json:"ttsPartial,omitempty"`   // true = fast partial TTS, false = final
}

type InMsg struct {
	Type        string     `json:"type"`
	ID          string     `json:"id,omitempty"`          // translate_response correlation
	SourceLang  string     `json:"sourceLang,omitempty"`
	TargetLang  string     `json:"targetLang,omitempty"`
	APIKey      string     `json:"apiKey,omitempty"`
	Region      string     `json:"region,omitempty"`
	Engine      string     `json:"engine,omitempty"`
	TTSVoice    string     `json:"ttsVoice,omitempty"`
	Translation string     `json:"translation,omitempty"` // translate_response result
	Error         string     `json:"error,omitempty"`       // translate_response error
	SkipTranslate bool       `json:"skipTranslate,omitempty"`
	Subs          []Subtitle `json:"subs,omitempty"`
	Text          string     `json:"text,omitempty"`
	SampleRate    int        `json:"sampleRate,omitempty"`
	Speed         float64    `json:"speed,omitempty"`
}

func (c *Client) sendJSON(msg OutMsg) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(msg)
}

func (c *Client) onASRResult(text string, speechRate float64, duration float64, isPartial bool, speaker string) {
	if !c.active {
		return
	}
	c.sendJSON(OutMsg{Type: "original", Text: text, Partial: isPartial, Speaker: speaker, Duration: duration})

	if c.translator == nil || c.targetLang == "" {
		return
	}

	translated, err := c.translator.Translate(text, c.sourceLang, c.targetLang)
	if err != nil {
		if !isPartial {
			c.sendJSON(OutMsg{Type: "error", Message: fmt.Sprintf("Translation error: %v", err)})
		}
		return
	}
	if translated == "" {
		return
	}

	utterId := newID()

	if !isPartial {
		c.sendJSON(OutMsg{
			Type:        "result",
			Original:    text,
			Translation: translated,
			SpeechRate:  speechRate,
			Duration:    duration,
			Speaker:     speaker,
		})
	}

	// Throttle TTS for partials: skip if TTS already running or started recently.
	// Finals always proceed (cancel current TTS first).
	c.ttsCancelMu.Lock()
	ttsRunning := c.ttsCancel != nil
	c.ttsCancelMu.Unlock()

	if isPartial && (ttsRunning || time.Since(c.lastTtsTime) < 600*time.Millisecond) {
		return
	}

	c.lastTtsTime = time.Now()

	// Cancel previous TTS goroutine before starting new one
	c.ttsCancelMu.Lock()
	if c.ttsCancel != nil {
		close(c.ttsCancel)
	}
	c.ttsCancel = make(chan struct{})
	cancelCh := c.ttsCancel
	c.ttsCancelMu.Unlock()

	go c.generateAndSendTTS(translated, utterId, speechRate, isPartial, cancelCh)
}

func (c *Client) generateAndSendTTS(text, utterId string, speechRate float64, isPartial bool, cancel <-chan struct{}) {
	// Clear ttsCancel on exit so throttler knows TTS is done
	defer func() {
		c.ttsCancelMu.Lock()
		if c.ttsCancel == cancel {
			c.ttsCancel = nil
		}
		c.ttsCancelMu.Unlock()
	}()

	voice := tts.ResolveVoice(c.ttsVoice, c.targetLang)

	// Check cancellation before sending audio_start
	select {
	case <-cancel:
		return
	default:
	}

	c.sendJSON(OutMsg{
		Type:        "audio_start",
		Original:    text,
		UtteranceId: utterId,
		SpeechRate:  speechRate,
		TtsPartial:  isPartial,
	})

	idx := 0
	batchSize := 1024 // buffer ~170ms of mp3 before sending (lower = less latency)
	var buf []byte
	flush := func(final bool) {
		if len(buf) == 0 && !final {
			return
		}
		select {
		case <-cancel:
			return
		default:
		}
		c.sendJSON(OutMsg{
			Type:        "audio_chunk",
			Original:    text,
			Audio:       base64.StdEncoding.EncodeToString(buf),
			Index:       idx,
			UtteranceId: utterId,
		})
		idx++
		buf = buf[:0]
	}
	err := tts.SynthesizeStream(text, voice, func(ch tts.AudioChunk) {
		// Check cancellation before processing each chunk
		select {
		case <-cancel:
			return
		default:
		}
		if ch.Final {
			flush(false)
			c.sendJSON(OutMsg{Type: "audio_end", Original: text, UtteranceId: utterId, Index: -1, SpeechRate: speechRate})
		} else {
			buf = append(buf, ch.Data...)
			if len(buf) >= batchSize {
				flush(false)
			}
		}
	})
	if err != nil {
		select {
		case <-cancel:
			return
		default:
		}
		c.sendJSON(OutMsg{Type: "audio_end", Original: text, UtteranceId: utterId, Index: -1, SpeechRate: speechRate})
	}
}

// ─── Offline ASR ─────────────────────────────────────────────────────

func (c *Client) processOfflineASR(samples []int16, sampleRate int) {
	// Validate PCM: check for non-zero samples
	var maxVal, sumAbs int64
	nonZero := 0
	for _, s := range samples {
		abs := int64(s)
		if abs < 0 {
			abs = -abs
		}
		sumAbs += abs
		if abs > maxVal {
			maxVal = abs
		}
		if abs > 10 {
			nonZero++
		}
	}
	log.Printf("[offline-asr] PCM stats: samples=%d max=%d avg_abs=%d nonZero=%d/%d",
		len(samples), maxVal, sumAbs/int64(len(samples)), nonZero, len(samples))

	if maxVal < 50 {
		c.sendJSON(OutMsg{Type: "error", Message: "捕获音频静音，请检查站点是否允许音频捕获"})
		return
	}

	segs, err := asr.ProcessOfflineFull(samples, whisperServerURL, c.sourceLang, sampleRate)
	if err != nil {
		c.sendJSON(OutMsg{Type: "error", Message: fmt.Sprintf("离线 ASR 失败: %v", err)})
		return
	}
	if len(segs) == 0 {
		c.sendJSON(OutMsg{Type: "error", Message: "离线 ASR 未识别到字幕"})
		return
	}

	log.Printf("[offline-asr] whisper returned %d segments", len(segs))
	for i, s := range segs {
		if i < 5 {
			log.Printf("[offline-asr]   seg[%d]: [%.1f-%.1f] %q", i, s.Start, s.End, s.Text)
		}
	}

	// Convert to Subtitle format, scaling timestamps to compensate for
	// accelerated playback during recording (e.g. 1.5x speed → multiply by 1.5).
	speed := c.offlineSpeed
	if speed <= 0 {
		speed = 1.0
	}
	subs := make([]Subtitle, len(segs))
	for i, s := range segs {
		// Scale word timestamps too
		words := make([]asr.WordTimestamp, len(s.Words))
		for j, w := range s.Words {
			words[j] = asr.WordTimestamp{Word: w.Word, Start: w.Start * speed, End: w.End * speed}
		}
		subs[i] = Subtitle{Text: s.Text, Start: s.Start * speed, End: s.End * speed, Words: words}
	}
	log.Printf("[offline-asr] speed=%.1fx, sending %d subs to frontend", speed, len(subs))
	c.sendJSON(OutMsg{Type: "offline_asr_result", Subs: subs})
}

// ─── Preprocess (subtitle hijacking mode) ─────────────────────────────

// handleDOMSubtitle translates a single DOM-captured subtitle and generates TTS.
func (c *Client) handleDOMSubtitle(text string, skipTranslate bool) {
	if c.translator == nil || c.targetLang == "" {
		return
	}
	var translated string
	var err error
	if skipTranslate {
		translated = text
	} else {
		translated, err = c.translator.Translate(text, c.sourceLang, c.targetLang)
		if err != nil {
			c.sendJSON(OutMsg{Type: "error", Message: fmt.Sprintf("Translation error: %v", err)})
			return
		}
	}
	if translated == "" {
		return
	}
	c.sendJSON(OutMsg{
		Type:        "result",
		Original:    text,
		Translation: translated,
	})

	go c.generateAndSendTTS(translated, newID(), 5.0, false, nil)
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

	log.Printf("[preprocess] %d subtitles after merge", len(subs))
	c.sendJSON(OutMsg{Type: "preprocess_start", Total: len(subs)})

	voice := tts.ResolveVoice(c.ttsVoice, c.targetLang)
	from := c.sourceLang
	to := c.targetLang

	// Phase 1: concurrent translation (5 workers)
	translated := make([]string, len(subs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)

	for i, sub := range subs {
		if sub.SkipTranslate {
			translated[i] = sub.Text
			continue
		}
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
			}
			item := PreprocessResult{
				Index:       idx,
				Original:    subs[idx].Text,
				Translation: translation,
				Audio:       audio,
				Start:       subs[idx].Start,
				End:         subs[idx].End,
				DurationMs:  tts.EstimateMP3DurationFromBase64(audio),
				Words:       subs[idx].Words,
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

	transCount := 0
	for _, t := range translated {
		if t != "" {
			transCount++
		}
	}
	log.Printf("[preprocess] done: %d subtitles, %d translated, %d items with audio/TTS", len(subs), transCount, total)
	c.sendJSON(OutMsg{Type: "preprocess_complete"})
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
		return
	}
	defer conn.Close()

	client := &Client{
		conn:       conn,
		sourceLang: "auto",
		targetLang: "zh-Hans",
	}


	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
			}
			return
		}

		switch msgType {
		case websocket.TextMessage:
			var msg InMsg
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}

			switch msg.Type {
			case "config":
				client.sourceLang = msg.SourceLang
				client.targetLang = msg.TargetLang
				client.ttsVoice = msg.TTSVoice
				if client.translator == nil {
					client.translator = translate.New(msg.APIKey, msg.Region)
				}
				client.translator.SetEngine(msg.Engine)
				if msg.Engine == "google" {
					client.translator.SetAsyncFn(client.translateViaBrowser)
				}
				if client.audioBuf == nil {
					client.audioBuf = asr.NewAudioBuffer(
					whisperServerURL,
					client.sourceLang,
					client.onASRResult,
				)
				}
				client.sendJSON(OutMsg{Type: "status", Status: "configured"})

			case "voice":
				if msg.TTSVoice != "" {
					client.ttsVoice = msg.TTSVoice
				}

			case "translate_response":
				pendingMu.Lock()
				pi, ok := pendingMap[msg.ID]
				delete(pendingMap, msg.ID)
				pendingMu.Unlock()
				if ok {
					if msg.Error != "" {
						pi.errCh <- fmt.Errorf("Google 翻译失败: %s", msg.Error)
					} else {
						pi.result <- msg.Translation
					}
				}

			case "warmup":
				go func() {
					// Translate warmup
					client.translator.Translate("hello", client.sourceLang, client.targetLang)
					// TTS warmup (fire-and-forget via Go-native Edge TTS)
					tts.Warmup(tts.ResolveVoice(client.ttsVoice, client.targetLang))
					client.sendJSON(OutMsg{Type: "status", Status: "ready"})
				}()

			case "start":
				client.active = true
				client.sendJSON(OutMsg{Type: "status", Status: "listening"})

			case "stop":
				client.active = false
				client.sendJSON(OutMsg{Type: "status", Status: "stopped"})

			case "subtitle":
				go client.handleDOMSubtitle(msg.Text, msg.SkipTranslate)

			case "preprocess":
				go client.handlePreprocess(msg.Subs)

			case "offline_asr_start":
				client.offlineASR = true
				client.offlineBuf = make([]int16, 0, 16000*3600) // up to 1hr
				if msg.Speed > 0 {
					client.offlineSpeed = msg.Speed
				} else {
					client.offlineSpeed = 1.0
				}
				client.offlineSampleRate = msg.SampleRate
				if client.offlineSampleRate <= 0 {
					client.offlineSampleRate = 48000
				}
				client.sendJSON(OutMsg{Type: "status", Status: "offline_recording"})

			case "offline_asr_end":
				if !client.offlineASR {
					continue
				}
				if len(client.offlineBuf) == 0 {
					client.offlineASR = false
					client.sendJSON(OutMsg{Type: "error", Message: "未收到音频数据，请检查页面音频权限"})
					continue
				}
				client.offlineASR = false
				client.sendJSON(OutMsg{Type: "status", Status: "offline_asr_processing"})
				go client.processOfflineASR(client.offlineBuf, client.offlineSampleRate)
				client.offlineBuf = nil

			default:
			}

		case websocket.BinaryMessage:
			sampleCount := len(data) / 2
			samples := make([]int16, sampleCount)
			for i := 0; i < sampleCount; i++ {
				samples[i] = int16(binary.LittleEndian.Uint16(data[i*2 : (i+1)*2]))
			}

			if client.offlineASR {
				client.offlineBuf = append(client.offlineBuf, samples...)
				continue
			}

			if client.audioBuf == nil {
				continue
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
	}

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

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
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
