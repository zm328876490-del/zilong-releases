package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ai-translation/backend/asr"
	"ai-translation/backend/config"
	"ai-translation/backend/model"
	"ai-translation/backend/translate"
	"ai-translation/backend/tts"

	"github.com/gorilla/websocket"
)

var version = "dev"
var updateMu sync.Mutex
var updateStatus = "idle" // "idle" | "downloading" | "installing" | "failed"

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

const authAPI = "http://101.96.227.131/auth-server"

var (
	licensed    bool
	licenseJWT  string
	licensePlan string
)

var (
	licErrClients = make(map[*Client]bool)
	licErrMu     sync.Mutex
)

func licPath() string {
	return filepath.Join(filepath.Dir(os.Args[0]), "license.json")
}

func loadLicense() {
	data, err := os.ReadFile(licPath())
	if err != nil {
		return
	}
	var lic struct {
		JWT string `json:"jwt"`
	}
	if json.Unmarshal(data, &lic) != nil || lic.JWT == "" {
		return
	}
	validateJWT(lic.JWT)
}

func validateJWT(token string) bool {
	req, _ := http.NewRequest("GET", authAPI+"/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	var data struct {
		Plan string `json:"plan"`
	}
	json.NewDecoder(resp.Body).Decode(&data)
	if data.Plan != "premium" {
		return false
	}
	licenseJWT = token
	licensePlan = data.Plan
	licensed = true
	return true
}

func handleSetToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, `{"error":"POST required"}`, http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.Token == "" {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if !validateJWT(req.Token) {
		http.Error(w, `{"error":"需要专业版账号"}`, http.StatusForbidden)
		return
	}
	data, _ := json.Marshal(map[string]string{"jwt": req.Token})
	os.WriteFile(licPath(), data, 0644)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"ok": "licensed", "plan": licensePlan})
}

func handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, `{"error":"POST required"}`, http.StatusMethodNotAllowed)
		return
	}
	if !updateMu.TryLock() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "更新已在进行中", "status": updateStatus})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "updating",
		"message": "下载并安装更新中...",
	})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}

	go func() {
		defer updateMu.Unlock()
		defer func() { updateStatus = "idle" }()
		updateStatus = "downloading"
		installerURL := "https://github.com/zm328876490-del/zilong-releases/releases/latest/download/installer.exe"
		tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("ai-translation-update-%d.exe", time.Now().UnixNano()))
		if err := downloadFile(installerURL, tmpFile); err != nil {
			fmt.Printf("[update] download failed: %v\n", err)
			updateStatus = "failed"
			return
		}
		updateStatus = "installing"
		cmd := exec.Command(tmpFile)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: 0x00000200 | 0x00000008,
		}
		if err := cmd.Start(); err != nil {
			fmt.Printf("[update] launch installer failed: %v\n", err)
			updateStatus = "failed"
			return
		}
		fmt.Printf("[update] installer launched (PID %d), waiting for restart...\n", cmd.Process.Pid)
		cmd.Process.Release()
	}()
}

func handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": updateStatus})
}

func downloadFile(url, dest string) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		os.Remove(dest)
		return fmt.Errorf("download: %w", err)
	}
	return nil
}

func requireLicense(w http.ResponseWriter) bool {
	if licensed {
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(402)
	json.NewEncoder(w).Encode(map[string]string{"error": "需要专业版才能使用翻译功能，请在插件中登录专业版账号"})
	return false
}
func (c *Client) licErrOnce() {
	licErrMu.Lock()
	if licErrClients[c] {
		licErrMu.Unlock()
		return
	}
	licErrClients[c] = true
	licErrMu.Unlock()
	c.sendJSON(OutMsg{Type: "error", Message: "需要专业版才能使用翻译功能，请在插件中登录专业版账号"})
}

// Client represents a connected browser extension.
type Client struct {
	conn            *websocket.Conn
	mu              sync.Mutex
	audioBuf        *asr.AudioBuffer
	rollingBuf      *asr.RollingBuffer
	translator      *translate.Translator
	sourceLang      string
	targetLang      string
	ttsVoice        string // user-selected TTS voice name (short form)
	active          bool
	sessionId       string // current translation session (video-specific), echoed in all responses
	ttsCancel       chan struct{} // cancels the previous streaming TTS goroutine
	ttsCancelMu     sync.Mutex    // guards ttsCancel
	ttsSeq          chan struct{} // semaphore (cap 1): serializes final TTS generation
	lastTtsTime     time.Time     // last time a TTS goroutine was started (for throttling)

	// offline ASR state
	offlineASR        bool
	offlineBuf        []int16
	offlineSpeed      float64 // playback speed during recording (for timestamp scaling)
	offlineSampleRate int     // actual AudioContext sample rate from frontend

	// Gender stickiness — Edge TTS sounds jarring when voice flips mid-session
	// for the same speaker. Track the last *strong* detection and the count of
	// consecutive opposite-strong detections required to flip.
	genderMu          sync.Mutex
	stickyGender      string // last committed gender, "male" / "female" / ""
	flipPendingGender string // candidate new gender accumulating evidence
	flipPendingCount  int    // consecutive strong opposite detections
	// Lifetime strong-detection tally per gender. Used as a "dominant speaker"
	// guard — a brief flurry of opposite-strong detections can't flip the
	// voice unless its tally has grown to a meaningful fraction of the
	// current dominant gender's tally. See resolveStickyGender.
	maleStrongCount   int
	femaleStrongCount int
}

// flipConfirmCount is the number of consecutive strong opposite-gender
// detections required before flipping the sticky gender. 3 strong hits in a
// row resists one-off mis-detections (male speaker briefly excited above the
// female threshold) while still allowing genuine speaker changes — a real new
// speaker normally produces many more than 3 strong-confidence segments.
const flipConfirmCount = 3

// flipDominanceRatio: a candidate gender must have lifetime strong-detection
// count >= (current dominant count × this ratio) before a flip is allowed.
// 0.5 means "the challenger must be at least half as established as the
// incumbent". Combined with flipConfirmCount, this makes "occasional female
// segment in a male-dominated video" a no-op rather than a voice flip.
const flipDominanceRatio = 0.5

// Subtitle is a single subtitle cue extracted from a video platform.
type Subtitle struct {
	Text          string             `json:"text"`
	Start         float64            `json:"start"`
	End           float64            `json:"end"`
	SkipTranslate bool               `json:"skipTranslate,omitempty"`
	Words         []asr.WordTimestamp `json:"words,omitempty"`
	Gender        string             `json:"gender,omitempty"` // "male" / "female" / "" (unknown)
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
	DurationMs  int                `json:"durationMs,omitempty"` // TTS audio duration (ms)
	Words       []asr.WordTimestamp `json:"words,omitempty"`     // per-word timestamps from whisper
	Gender      string             `json:"gender,omitempty"`    // "male" / "female" / ""
}

type OutMsg struct {
	Type        string             `json:"type"`
	SessionID   string             `json:"sessionId,omitempty"`
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
	Ready       bool               `json:"ready,omitempty"` // first batch ready for early replay
	UtteranceId string             `json:"utteranceId,omitempty"` // ties audio_start/chunk/end to a specific utterance
	StartTime   float64            `json:"startTime,omitempty"`   // segment start (absolute video time)
	EndTime     float64            `json:"endTime,omitempty"`     // segment end (absolute video time)
	Words       []asr.WordTimestamp `json:"words,omitempty"`      // per-word timestamps
	TtsPartial   bool               `json:"ttsPartial,omitempty"`   // true = fast partial TTS, false = final
	Gender       string             `json:"gender,omitempty"`       // detected speaker gender: "male" / "female" / ""
}

type InMsg struct {
	Type        string     `json:"type"`
	SessionID   string     `json:"sessionId,omitempty"`
	ID          string     `json:"id,omitempty"`          // translate_response correlation
	SourceLang  string     `json:"sourceLang,omitempty"`
	TargetLang  string     `json:"targetLang,omitempty"`
	APIKey      string     `json:"apiKey,omitempty"`
	Region      string     `json:"region,omitempty"`
	Engine      string     `json:"engine,omitempty"`
	TTSVoice    string     `json:"ttsVoice,omitempty"`
	OllamaUrl   string     `json:"ollamaUrl,omitempty"`
	OllamaModel string     `json:"ollamaModel,omitempty"`
	OpenAIUrl   string     `json:"openaiUrl,omitempty"`
	OpenAIKey   string     `json:"openaiKey,omitempty"`
	OpenAIModel string     `json:"openaiModel,omitempty"`
	DeepLKey    string     `json:"deeplKey,omitempty"`
	Translation string     `json:"translation,omitempty"` // translate_response result
	Error         string     `json:"error,omitempty"`       // translate_response error
	Rolling       bool       `json:"rolling,omitempty"`
	SkipTranslate bool       `json:"skipTranslate,omitempty"`
	Subs          []Subtitle `json:"subs,omitempty"`
	Text          string     `json:"text,omitempty"`
	SampleRate    int        `json:"sampleRate,omitempty"`
	Speed         float64    `json:"speed,omitempty"`
}

func (c *Client) sendJSON(msg OutMsg) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if msg.SessionID == "" {
		msg.SessionID = c.sessionId
	}
	return c.conn.WriteJSON(msg)
}

func (c *Client) onASRResult(text string, speechRate float64, duration float64, isPartial bool, speaker string, startTime float64, endTime float64, words []asr.WordTimestamp, segmentPCM []int16) {
	if !c.active {
		return
	}

	// Gender-aware voice selection (final results only — partials too short / unreliable).
	// For rolling mode, segmentPCM is the slice corresponding to this exact segment.
	// For VAD mode, segmentPCM is the whole utterance.
	//
	// Apply per-session stickiness so a single mis-detection on a borderline
	// segment can't flip the voice. See resolveStickyGender for the rules.
	gender := ""
	if !isPartial && len(segmentPCM) > 0 {
		snap, conf := DetectGenderConfidence(segmentPCM, 16000)
		gender = c.resolveStickyGender(snap, conf, startTime, endTime, text)
	}

	c.sendJSON(OutMsg{Type: "original", Text: text, Partial: isPartial, Speaker: speaker, Duration: duration, Gender: gender})

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
			UtteranceId: utterId,
			StartTime:   startTime,
			EndTime:     endTime,
			Words:       words,
			Gender:      gender,
		})
	}

	// Throttle TTS for partials: skip if TTS already running or started recently.
	// Finals always proceed (cancel current TTS first).
	if !isPartial {
		c.lastTtsTime = time.Now()
		// Queue final TTS via semaphore — serializes batch results from
		// RollingBuffer without cancelling each other.
		genderCopy := gender
		go func() {
			c.ttsSeq <- struct{}{}
			defer func() { <-c.ttsSeq }()
			c.generateAndSendTTS(translated, utterId, speechRate, false, nil, genderCopy)
		}()
		return
	}

	// Partials: throttled + cancel-based (real-time VAD path only)
	c.ttsCancelMu.Lock()
	ttsRunning := c.ttsCancel != nil
	c.ttsCancelMu.Unlock()

	if ttsRunning || time.Since(c.lastTtsTime) < 600*time.Millisecond {
		return
	}

	c.lastTtsTime = time.Now()

	c.ttsCancelMu.Lock()
	if c.ttsCancel != nil {
		close(c.ttsCancel)
	}
	c.ttsCancel = make(chan struct{})
	cancelCh := c.ttsCancel
	c.ttsCancelMu.Unlock()

	go c.generateAndSendTTS(translated, utterId, speechRate, true, cancelCh, gender)
}

// resolveStickyGender turns a per-segment snapshot detection into a stable,
// per-session gender. Rules:
//
//  1. If we have no committed gender yet, take the first non-empty detection
//     (strong OR weak) and commit it. We need *something* to start with.
//  2. If the snapshot agrees with the committed gender → keep it, reset
//     any pending flip counter.
//  3. If the snapshot disagrees but is "weak" (in the 145–185 Hz ambiguous
//     band) → ignore it, keep committed. This is the main mis-flip case.
//  4. If the snapshot disagrees and is "strong" → it's a candidate flip.
//     Require flipConfirmCount consecutive strong opposite detections before
//     actually flipping. A real speaker change produces a run of opposites;
//     a single mis-detection does not.
//  5. Empty snapshot ("") → return committed (no change).
func (c *Client) resolveStickyGender(snap, conf string, startTime, endTime float64, text string) string {
	c.genderMu.Lock()
	defer c.genderMu.Unlock()

	// Update lifetime tally first — every strong detection (agreeing or not)
	// counts toward establishing the dominant speaker. Weak detections are
	// noise and never affect the tally.
	if conf == "strong" {
		if snap == "male" {
			c.maleStrongCount++
		} else if snap == "female" {
			c.femaleStrongCount++
		}
	}

	logCommit := func(reason string) {
	}

	// Rule 5: no detection — keep current sticky.
	if snap == "" {
		logCommit("no-pitch")
		return c.stickyGender
	}

	// Rule 1: bootstrap.
	if c.stickyGender == "" {
		c.stickyGender = snap
		c.flipPendingGender = ""
		c.flipPendingCount = 0
		logCommit("bootstrap")
		return c.stickyGender
	}

	// Rule 2: agrees → reset flip pending.
	if snap == c.stickyGender {
		c.flipPendingGender = ""
		c.flipPendingCount = 0
		logCommit("agree")
		return c.stickyGender
	}

	// Disagrees from here on.

	// Rule 3: weak disagreement → ignore.
	if conf != "strong" {
		logCommit("ignore-weak-flip")
		return c.stickyGender
	}

	// Rule 4: strong disagreement — accumulate consecutive evidence.
	if c.flipPendingGender == snap {
		c.flipPendingCount++
	} else {
		c.flipPendingGender = snap
		c.flipPendingCount = 1
	}

	// Rule 4a: even if consecutive evidence threshold is met, the challenger
	// must have a meaningful lifetime tally vs the incumbent. This blocks
	// "occasional 3 strong female segments inside a 50-segment male video"
	// from flipping the voice. A real new speaker will quickly accumulate
	// enough tally to satisfy this; a sporadic mis-detection or one-off
	// background voice will not.
	var dominantCount, challengerCount int
	if c.stickyGender == "male" {
		dominantCount = c.maleStrongCount
		challengerCount = c.femaleStrongCount
	} else {
		dominantCount = c.femaleStrongCount
		challengerCount = c.maleStrongCount
	}
	requiredCount := int(float64(dominantCount) * flipDominanceRatio)
	dominanceOK := challengerCount >= requiredCount

	if c.flipPendingCount >= flipConfirmCount && dominanceOK {
		c.stickyGender = snap
		c.flipPendingGender = ""
		c.flipPendingCount = 0
		return c.stickyGender
	}
	return c.stickyGender
}

func (c *Client) generateAndSendTTS(text, utterId string, speechRate float64, isPartial bool, cancel <-chan struct{}, gender string) {
	// Clear ttsCancel on exit so throttler knows TTS is done
	defer func() {
		c.ttsCancelMu.Lock()
		if c.ttsCancel == cancel {
			c.ttsCancel = nil
		}
		c.ttsCancelMu.Unlock()
	}()

	// Gender-aware voice when detected, otherwise fall back to user/default voice.
	// Keep both candidates so we can retry with the default if the gender voice
	// silently produces zero audio chunks (Edge TTS sometimes accepts a request
	// and closes the stream without emitting any audio — usually voice/lang
	// mismatch or upstream throttling).
	defaultVoice := tts.ResolveVoice(c.ttsVoice, c.targetLang)
	voice := defaultVoice
	if gender != "" {
		if v := tts.VoiceForLangAndGender(c.targetLang, gender); v != "" {
			voice = v
		}
	}
	if voice == "" {
		voice = defaultVoice
	}

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

	// trySynth runs one SynthesizeStream pass and returns
	// (sentBytes, err). If sentBytes == 0 and err == nil the upstream silently
	// produced nothing — caller decides whether to retry.
	trySynth := func(useVoice string) (int, error) {
		var firstChunkAt time.Time
		idx := 0
		batchSize := 1024
		var buf []byte
		sentBytes := 0
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
			sentBytes += len(buf)
			idx++
			buf = buf[:0]
		}
		err := tts.SynthesizeStream(text, useVoice, func(ch tts.AudioChunk) {
			if firstChunkAt.IsZero() && !ch.Final {
				firstChunkAt = time.Now()
			}
			select {
			case <-cancel:
				return
			default:
			}
			if ch.Final {
				flush(false)
				return
			}
			buf = append(buf, ch.Data...)
			if len(buf) >= batchSize {
				flush(false)
			}
		})
		return sentBytes, err
	}

	sentBytes, err := trySynth(voice)

	// Fallback: retry with default voice if the gender-aware voice produced
	// zero audio (and we actually had a different default to try). This is
	// what fixes "subtitle visible but no TTS sound": gender voice mismatched
	// the language or got rate-limited, Edge TTS closed with turn.end + 0
	// chunks, the user got silence.
	if err == nil && sentBytes == 0 && voice != defaultVoice && defaultVoice != "" {
		select {
		case <-cancel:
			return
		default:
		}
		sentBytes, err = trySynth(defaultVoice)
	}

	if err != nil {
	} else if sentBytes == 0 {
	} else if !isPartial {
	}

	// Always send audio_end so the frontend doesn't wait forever — even on
	// error, even on zero-bytes (which keeps subtitle visible but releases
	// the TTS queue slot).
	select {
	case <-cancel:
		return
	default:
	}
	c.sendJSON(OutMsg{Type: "audio_end", Original: text, UtteranceId: utterId, Index: -1, SpeechRate: speechRate})
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

	if maxVal < 50 {
		c.sendJSON(OutMsg{Type: "error", Message: "捕获音频静音，请检查站点是否允许音频捕获"})
		return
	}

	// Short audio (< 60s): use full-file whisper to avoid chunking overhead / errors
	var segs []asr.SubtitleSegment
	var err error
	audioDuration := float64(len(samples)) / float64(sampleRate)
	if audioDuration < 60 {
		segs, err = asr.ProcessOfflineFull(samples, whisperServerURL, c.sourceLang, sampleRate)
	} else {
		segs, err = asr.ProcessOfflineFullChunked(samples, whisperServerURL, c.sourceLang, sampleRate)
	}
	if err != nil {
		c.sendJSON(OutMsg{Type: "error", Message: fmt.Sprintf("离线 ASR 失败: %v", err)})
		return
	}
	if len(segs) == 0 {
		c.sendJSON(OutMsg{Type: "error", Message: "离线 ASR 未识别到字幕"})
		return
	}

	for i := range segs {
		if i < 5 {
		}
	}

	// Convert to Subtitle format, scaling timestamps to compensate for
	// accelerated playback during recording (e.g. 1.5x speed → multiply by 1.5).
	speed := c.offlineSpeed
	if speed <= 0 {
		speed = 1.0
	}
	// Collect pitch estimates for global consensus (avoid per-segment flip-flop)
	type segPitch struct {
		idx   int
		pitch float64
	}
	var pitches []segPitch
	for i, s := range segs {
		p := EstimatePitch(pcmSlice(samples, sampleRate, s.Start, s.End), sampleRate)
		if p > 0 {
			pitches = append(pitches, segPitch{idx: i, pitch: p})
		}
	}

	// Determine consensus gender: median pitch → male/female
	// If pitch variance is high (multi-speaker), keep per-segment decisions.
	consensusGender := ""
	if len(pitches) >= 2 {
		sort.Slice(pitches, func(i, j int) bool { return pitches[i].pitch < pitches[j].pitch })
		medianPitch := pitches[len(pitches)/2].pitch

		var sum, sumSq float64
		for _, sp := range pitches {
			sum += sp.pitch
			sumSq += sp.pitch * sp.pitch
		}
		mean := sum / float64(len(pitches))
		stdDev := math.Sqrt(sumSq/float64(len(pitches)) - mean*mean)

		if stdDev < 35 {
			consensusGender = classifyPitch(medianPitch)
		}
	} else if len(pitches) == 1 {
		consensusGender = classifyPitch(pitches[0].pitch)
	}

	subs := make([]Subtitle, len(segs))
	for i, s := range segs {
		words := make([]asr.WordTimestamp, len(s.Words))
		for j, w := range s.Words {
			words[j] = asr.WordTimestamp{Word: w.Word, Start: w.Start * speed, End: w.End * speed}
		}
		gender := consensusGender
		if gender == "" {
			gender = DetectGender(pcmSlice(samples, sampleRate, s.Start, s.End), sampleRate)
		}
		subs[i] = Subtitle{Text: s.Text, Start: s.Start * speed, End: s.End * speed, Words: words, Gender: gender}
	}
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

	go c.generateAndSendTTS(translated, newID(), 5.0, false, nil, "")
}

// handlePreprocess runs concurrent translation + TTS synthesis for all subtitles
// and streams results back to the client.
func (c *Client) handlePreprocess(subs []Subtitle) {
	if c.translator == nil {
		c.sendJSON(OutMsg{Type: "preprocess_error", Message: "Not configured — send config first"})
		return
	}

	subs = splitSubtitlesIntoSentences(subs)
	if len(subs) == 0 {
		c.sendJSON(OutMsg{Type: "preprocess_error", Message: "No subtitles to process"})
		return
	}

	c.sendJSON(OutMsg{Type: "preprocess_start", Total: len(subs)})

	voice := tts.ResolveVoice(c.ttsVoice, c.targetLang) // fallback default
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

	// Phase 2: concurrent TTS with early replay
	// Collect indices that need TTS
	type ttsJob struct {
		idx         int
		translation string
	}
	var jobs []ttsJob
	for i, trans := range translated {
		if trans != "" {
			jobs = append(jobs, ttsJob{idx: i, translation: trans})
		}
	}
	total := len(jobs)
	if total == 0 {
		c.sendJSON(OutMsg{Type: "preprocess_complete"})
		return
	}

	// Decide early-replay batch size: ~10 items or 20% of total, whichever is larger
	firstBatchSize := 10
	if pct := total / 5; pct > firstBatchSize {
		firstBatchSize = pct
	}
	if firstBatchSize > total {
		firstBatchSize = total
	}

	ttsJobSem := make(chan struct{}, 3) // concurrent TTS limit
	var mu sync.Mutex
	var batch []PreprocessResult
	completed := 0
	firstBatchSent := false

	processJob := func(idx int, translation string) {
		defer wg.Done()
		ttsJobSem <- struct{}{}
		defer func() { <-ttsJobSem }()
		itemVoice := voice
			if subs[idx].Gender != "" {
				itemVoice = tts.VoiceForLangAndGender(c.targetLang, subs[idx].Gender)
			}
			audio, err := tts.Synthesize(translation, itemVoice)
		if err != nil {
			audio = ""
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
			Gender:      subs[idx].Gender,
		}
		mu.Lock()
		batch = append(batch, item)
		completed++
		// Send first batch immediately when it fills up
		if !firstBatchSent && len(batch) >= firstBatchSize {
			c.sendJSON(OutMsg{Type: "preprocess_result", Items: batch, Ready: true})
			batch = nil
			firstBatchSent = true
		} else if firstBatchSent && len(batch) >= 3 {
			c.sendJSON(OutMsg{Type: "preprocess_result", Items: batch})
			batch = nil
		} else if completed == total && len(batch) > 0 {
			// Don't send here, will send after wg.Wait()
		}
		mu.Unlock()
	}

	// Process first batch with priority (to send Ready ASAP)
	for i := 0; i < firstBatchSize && i < len(jobs); i++ {
		wg.Add(1)
		go processJob(jobs[i].idx, jobs[i].translation)
	}

	// Process remaining jobs
	for i := 0; i < len(jobs); i++ {
		if i < firstBatchSize {
			continue // already started
		}
		wg.Add(1)
		go processJob(jobs[i].idx, jobs[i].translation)
	}

	wg.Wait()

	// Send any remaining batch
	mu.Lock()
	if len(batch) > 0 {
		c.sendJSON(OutMsg{Type: "preprocess_result", Items: batch})
	}
	mu.Unlock()

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

// splitSubtitlesIntoSentences splits each subtitle with word timestamps into
// individual sentences. Subtitle without words stay as-is.
func splitSubtitlesIntoSentences(subs []Subtitle) []Subtitle {
	var out []Subtitle
	for _, sub := range subs {
		sentences := splitWordsToSentenceGroups(sub.Words)
		if len(sentences) <= 1 {
			out = append(out, sub)
			continue
		}
		for _, words := range sentences {
			text := joinWordsToText(words)
			if len(strings.TrimSpace(text)) < 2 {
				continue
			}
			out = append(out, Subtitle{
				Text:   text,
				Start:  words[0].Start,
				End:    words[len(words)-1].End,
				Words:  words,
				Gender: sub.Gender,
			})
		}
	}
	return out
}

// splitWordsToSentenceGroups splits words by sentence-ending punctuation.
// A sentence ends when a word's last character is one of: . ! ? 。！？
// Groups with fewer than 3 words are merged into the next group to avoid
// subtitle flicker from fragments like "Thank you."
func splitWordsToSentenceGroups(words []asr.WordTimestamp) [][]asr.WordTimestamp {
	if len(words) == 0 {
		return nil
	}
	var groups [][]asr.WordTimestamp
	var cur []asr.WordTimestamp
	for _, w := range words {
		cur = append(cur, w)
		if endsWithSentencePunct(w.Word) {
			groups = append(groups, cur)
			cur = nil
		}
	}
	if len(cur) > 0 {
		if len(groups) > 0 {
			groups[len(groups)-1] = append(groups[len(groups)-1], cur...)
		} else {
			groups = append(groups, cur)
		}
	}
	// Merge short fragments (< 3 words) into the next group
	if len(groups) > 1 {
		var merged [][]asr.WordTimestamp
		i := 0
		for i < len(groups) {
			g := groups[i]
			for len(g) < 3 && i+1 < len(groups) {
				i++
				g = append(g, groups[i]...)
			}
			merged = append(merged, g)
			i++
		}
		return merged
	}
	return groups
}

func endsWithSentencePunct(s string) bool {
	if s == "" {
		return false
	}
	return isSentenceEndPunct([]rune(s)[len([]rune(s))-1])
}

// joinWordsToText joins word tokens into a natural-language sentence.
func joinWordsToText(words []asr.WordTimestamp) string {
	if len(words) == 0 {
		return ""
	}
	var b strings.Builder
	for i, w := range words {
		if i > 0 && needsWordSpace(words[i-1].Word, w.Word) {
			b.WriteByte(' ')
		}
		b.WriteString(w.Word)
	}
	return b.String()
}

func needsWordSpace(prev, next string) bool {
	if prev == "" || next == "" {
		return false
	}
	prevRunes := []rune(prev)
	nextRunes := []rune(next)
	prevLast := prevRunes[len(prevRunes)-1]
	nextFirst := nextRunes[0]
	prevASCII := prevLast <= 127
	nextASCII := nextFirst <= 127
	// Space between two ASCII words (e.g. English), but not before/after CJK
	if prevASCII && nextASCII &&
		((prevLast >= 'a' && prevLast <= 'z') || (prevLast >= 'A' && prevLast <= 'Z')) &&
		((nextFirst >= 'a' && nextFirst <= 'z') || (nextFirst >= 'A' && nextFirst <= 'Z')) {
		return true
	}
	// Space after sentence-ending punctuation followed by an ASCII letter
	if isSentenceEndPunct(prevLast) &&
		((nextFirst >= 'a' && nextFirst <= 'z') || (nextFirst >= 'A' && nextFirst <= 'Z')) {
		return true
	}
	return false
}

func isSentenceEndPunct(r rune) bool {
	return r == '.' || r == '!' || r == '?' || r == '。' || r == '！' || r == '？'
}

// ─── WebSocket handler ────────────────────────────────────────────────

// whisperServerURL is set at startup after whisper-server is ready.
var whisperServerURL string

// llamaServerURL is set at startup after llama-server is ready.
var llamaServerURL string

// modelManager handles gguf model downloads and listing.
var modelManager *model.Manager

// ocrServerURL is kept for backward-compat; not used when calling ocr.py directly.
var ocrServerURL = "http://127.0.0.1:29529"

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
		ttsSeq:     make(chan struct{}, 6),
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

			if msg.SessionID != "" {
				client.sessionId = msg.SessionID
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
				if msg.Engine == "ollama" {
					client.translator.SetOllama(llamaServerURL, msg.OllamaModel)
				}
				if msg.Engine == "openai" {
					client.translator.SetOpenAI(msg.OpenAIUrl, msg.OpenAIKey, msg.OpenAIModel)
				}
				if msg.Engine == "deepl" {
					client.translator.SetDeepL(msg.DeepLKey, "")
				}
				if msg.Rolling {
					if client.rollingBuf == nil {
						client.rollingBuf = asr.NewRollingBuffer(
							whisperServerURL,
							client.sourceLang,
							client.onASRResult,
						)
					}
				} else {
					if client.audioBuf == nil {
						client.audioBuf = asr.NewAudioBuffer(
							whisperServerURL,
							client.sourceLang,
							client.onASRResult,
						)
					}
				}
				client.sendJSON(OutMsg{Type: "status", Status: "configured"})

			case "voice":
				if !licensed { client.licErrOnce(); continue }
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
				if !licensed { client.licErrOnce(); continue }
				go func() {
					// Translate warmup
					client.translator.Translate("hello", client.sourceLang, client.targetLang)
					// TTS warmup (fire-and-forget via Go-native Edge TTS)
					tts.Warmup(tts.ResolveVoice(client.ttsVoice, client.targetLang))
					client.sendJSON(OutMsg{Type: "status", Status: "ready"})
				}()

			case "start":
				if !licensed { client.licErrOnce(); continue }
				client.active = true
				if msg.Rolling {
					if client.rollingBuf == nil {
						client.rollingBuf = asr.NewRollingBuffer(
							whisperServerURL,
							client.sourceLang,
							client.onASRResult,
						)
					}
					client.rollingBuf.Start()
				}
				client.sendJSON(OutMsg{Type: "status", Status: "listening"})

			case "stop":
				if !licensed { client.licErrOnce(); continue }
				client.active = false
				if client.rollingBuf != nil {
					client.rollingBuf.Stop()
				}
				client.sendJSON(OutMsg{Type: "status", Status: "stopped"})

			case "flush_tail":
				if !licensed { client.licErrOnce(); continue }
				// Caller (extension) signals end-of-stream or source swap.
				// Force the rolling buffer to process any remaining
				// unprocessed audio immediately, ignoring the 2s threshold,
				// so the last < 2s tail (which would otherwise sit forever)
				// is transcribed and delivered.
				if client.rollingBuf != nil {
					client.rollingBuf.FlushTail()
				}

			case "session_split":
				if !licensed { client.licErrOnce(); continue }
				// Video looped or source changed. Flush the tail of the
				// previous session, then wipe the buffer so the next batch
				// starts on a fresh timeline. Without this, whisper merges
				// two consecutive plays into one mega-segment.
				// ResetSession internally waits for any in-flight batch.
				if client.rollingBuf != nil {
					client.rollingBuf.ResetSession()
				}

			case "subtitle":
				if !licensed { client.licErrOnce(); continue }
				go client.handleDOMSubtitle(msg.Text, msg.SkipTranslate)

			case "preprocess":
				if !licensed { client.licErrOnce(); continue }
				go client.handlePreprocess(msg.Subs)

			case "offline_asr_start":
				if !licensed { client.licErrOnce(); continue }
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
				if !licensed { client.licErrOnce(); continue }
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
			if len(data) < 8 {
				continue
			}
			videoTime := math.Float64frombits(binary.LittleEndian.Uint64(data[:8]))
			sampleCount := (len(data) - 8) / 2
			samples := make([]int16, sampleCount)
			for i := 0; i < sampleCount; i++ {
				samples[i] = int16(binary.LittleEndian.Uint16(data[8+i*2 : 8+(i+1)*2]))
			}

			if client.offlineASR {
				client.offlineBuf = append(client.offlineBuf, samples...)
				continue
			}

			if client.rollingBuf != nil {
				client.rollingBuf.Append(samples, videoTime)
				continue
			}
			if client.audioBuf == nil {
				continue
			}
			client.audioBuf.Append(samples, videoTime)
		}
	}
}

// ─── Page Translation HTTP endpoint ─────────────────────────────────────

type translatePageReq struct {
	Texts       []string `json:"texts"`
	From        string   `json:"from"`
	To          string   `json:"to"`
	Engine      string   `json:"engine"`
	OllamaUrl   string   `json:"ollamaUrl,omitempty"`
	OllamaModel string   `json:"ollamaModel,omitempty"`
	OpenAIUrl   string   `json:"openaiUrl,omitempty"`
	OpenAIKey   string   `json:"openaiKey,omitempty"`
	OpenAIModel string   `json:"openaiModel,omitempty"`
	DeepLKey    string   `json:"deeplKey,omitempty"`
}

type translatePageResp struct {
	Results []string `json:"results"`
}

func handleTranslatePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, `{"error":"POST required"}`, http.StatusMethodNotAllowed)
		return
	}

	var req translatePageReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"bad request: %s"}`, err.Error()), http.StatusBadRequest)
		return
	}

	if len(req.Texts) == 0 || req.To == "" {
		http.Error(w, `{"error":"texts and to are required"}`, http.StatusBadRequest)
		return
	}

	tr := translate.New("", "")
	tr.SetEngine(req.Engine)
	if req.Engine == "ollama" {
		tr.SetOllama(req.OllamaUrl, req.OllamaModel)
	}
	if req.Engine == "openai" {
		tr.SetOpenAI(req.OpenAIUrl, req.OpenAIKey, req.OpenAIModel)
	}
	if req.Engine == "deepl" {
		tr.SetDeepL(req.DeepLKey, "")
	}

	if req.Engine == "ollama" || req.Engine == "openai" {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, `{"error":"streaming not supported"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		if err := tr.TranslateBatchStream(w, req.Texts, req.From, req.To); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadGateway)
			return
		}
		flusher.Flush()
		return
	}

	results, err := tr.TranslateBatch(req.Texts, req.From, req.To)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(translatePageResp{Results: results})
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
	if cfg.VadModelPath != "" {
		args = append(args, "--vad", "-vm", cfg.VadModelPath)
	}

	cmd := exec.Command(serverExe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
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

// ─── PID file helpers (survive parent restart) ─────────────────────────

func pidFilePath(name string) string {
	return filepath.Join(filepath.Dir(os.Args[0]), name+".pid")
}

func savePIDFile(name string, pid int) {
	os.WriteFile(pidFilePath(name), []byte(fmt.Sprintf("%d", pid)), 0644)
}

func killPIDFile(name string) {
	data, err := os.ReadFile(pidFilePath(name))
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		os.Remove(pidFilePath(name))
		return
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		os.Remove(pidFilePath(name))
		return
	}
	proc.Kill()
	// Wait a moment for the port to free up
	time.Sleep(500 * time.Millisecond)
	os.Remove(pidFilePath(name))
}

func removePIDFile(name string) {
	os.Remove(pidFilePath(name))
}

// portIsFree returns true if nothing is listening on addr.
func portIsFree(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return true
	}
	conn.Close()
	return false
}

// ─── llama-server lifecycle ─────────────────────────────────────────────

// startLlamaServer launches llama-server as a persistent subprocess with an
// OpenAI-compatible API on /v1/chat/completions. Requires at least one gguf
// model installed under cfg.ModelDir.
func startLlamaServer(cfg *config.Config) (*exec.Cmd, error) {
	if cfg.LlamaServerExe == "" {
		return nil, fmt.Errorf("llama-server.exe not found")
	}

	modelPath := ""
	if cfg.LlamaModel != "" {
		p := filepath.Join(cfg.ModelDir, cfg.LlamaModel+".gguf")
		if _, err := os.Stat(p); err == nil {
			modelPath = p
		}
	}
	if modelPath == "" {
		models, _ := modelManager.List()
		if len(models) > 0 {
			modelPath = models[0].Path
		}
	}
	if modelPath == "" {
		return nil, fmt.Errorf("no gguf model installed, download one first")
	}

	llamaPort := cfg.LlamaPort()
	addr := fmt.Sprintf("127.0.0.1:%s", llamaPort)
	llamaURL := fmt.Sprintf("http://%s", addr)

	// ── Pre-flight: kill any stale process from a previous run ──────
	killPIDFile("llama-server")

	// If port is still occupied, check whether it is a healthy
	// llama-server we can reuse (e.g. started manually or from an
	// older instance we couldn't kill).
	if !portIsFree(addr) {
		if resp, err := httpGet(llamaURL + "/health"); err == nil {
			resp.Body.Close()
			llamaServerURL = llamaURL
			fmt.Println("[main] llama-server: reusing existing instance on", addr)
			return nil, nil // caller must handle nil cmd
		}
		// Port busy but not a healthy llama-server — bail.
		return nil, fmt.Errorf("port %s is in use by another process", llamaPort)
	}

	// ── Build args — try GPU first, fall back to CPU ───────────────
	baseArgs := []string{
		"-m", modelPath,
		"--port", llamaPort,
		"--host", "127.0.0.1",
		"-c", "4096",
		"-b", "512",
		"-t", "4",
	}
	gpuArgs := append(baseArgs, "-ngl", "99")

	var cmd *exec.Cmd
	var err error

	startAndWait := func(args []string, timeout time.Duration) error {
		cmd = exec.Command(cfg.LlamaServerExe, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		cmd.Stderr = os.Stderr
		cmd.Stdout = os.Stdout
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start llama-server: %w", err)
		}
		if err := waitForServer(llamaURL+"/health", timeout); err != nil {
			cmd.Process.Kill()
			return err
		}
		return nil
	}

	fmt.Println("[main] llama-server: starting with GPU (", modelPath, ")...")
	if err = startAndWait(gpuArgs, 15*time.Second); err != nil {
		fmt.Println("[main] llama-server: GPU failed (", err, "), retrying CPU only...")
		if err2 := startAndWait(baseArgs, 30*time.Second); err2 != nil {
			return nil, fmt.Errorf("llama-server startup: GPU=%w CPU=%w", err, err2)
		}
	}

	llamaServerURL = llamaURL

	// Persist PID so the next restart can kill this process.
	savePIDFile("llama-server", cmd.Process.Pid)
	fmt.Printf("[main] llama-server: ready on %s (PID %d)\n", llamaURL, cmd.Process.Pid)

	return cmd, nil
}

func httpGet(url string) (*http.Response, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	return client.Get(url)
}

// ─── Model Management API ─────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func handleModelList(w http.ResponseWriter, r *http.Request) {
	models, err := modelManager.List()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if models == nil {
		models = []model.ModelInfo{}
	}
	writeJSON(w, http.StatusOK, models)
}

func handleModelDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var req struct {
		Name     string `json:"name"`
		URL      string `json:"url"`
		Filename string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.Name == "" || req.URL == "" || req.Filename == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, url, filename required"})
		return
	}
	id, err := modelManager.StartDownload(req.Name, req.URL, req.Filename)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func handleModelDownloadStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	job := modelManager.Job(id)
	if job == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func handleModelDownloads(w http.ResponseWriter, r *http.Request) {
	jobs := modelManager.Jobs()
	writeJSON(w, http.StatusOK, jobs)
}

func handleModelDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	if err := modelManager.Delete(req.Name); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// startOCRServer launches the EasyOCR Python HTTP server as a persistent
// subprocess so the model is loaded once and reused across requests.
func startOCRServer() (*exec.Cmd, error) {
	python := findPython()
	scriptPath := filepath.Join(".", "scripts", "ocr_server.py")

	cmd := exec.Command(python, scriptPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Stderr = os.Stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ocr server stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start OCR server: %w", err)
	}

	deadline := time.Now().Add(120 * time.Second)
	buf := make([]byte, 4096)
	var lineBuf []byte
	for time.Now().Before(deadline) {
		n, readErr := stdout.Read(buf)
		if n > 0 {
			lineBuf = append(lineBuf, buf[:n]...)
			for {
				idx := indexByte(lineBuf, '\n')
				if idx < 0 {
					break
				}
				line := lineBuf[:idx]
				lineBuf = lineBuf[idx+1:]

				var evt map[string]interface{}
				if json.Unmarshal(line, &evt) == nil {
					if evt["event"] == "ready" {
						port := 29529
						if p, ok := evt["port"].(float64); ok {
							port = int(p)
						}
						ocrServerURL = fmt.Sprintf("http://127.0.0.1:%d", port)
						go func() { io.Copy(io.Discard, stdout) }()
						return cmd, nil
					}
				}
			}
		}
		if readErr != nil {
			cmd.Process.Kill()
			return nil, fmt.Errorf("OCR server exited early: %w", readErr)
		}
		time.Sleep(100 * time.Millisecond)
	}

	cmd.Process.Kill()
	return nil, fmt.Errorf("OCR server startup timeout")
}

func indexByte(data []byte, c byte) int {
	for i, b := range data {
		if b == c {
			return i
		}
	}
	return -1
}

// ─── Image Translation (OCR + translate + draw) ─────────────────────
// Uses Windows built-in OCR (no model), existing translation engine,
// and System.Drawing to render translated text back onto the image.

type imageTranslateReq struct {
	Image       string `json:"image"`
	TargetLang  string `json:"targetLang"`
	Engine      string `json:"engine"`
	OllamaUrl   string `json:"ollamaUrl,omitempty"`
	OllamaModel string `json:"ollamaModel,omitempty"`
	OpenAIUrl   string `json:"openaiUrl,omitempty"`
	OpenAIKey   string `json:"openaiKey,omitempty"`
	OpenAIModel string `json:"openaiModel,omitempty"`
	DeepLKey    string `json:"deeplKey,omitempty"`
}

type ocrWord struct {
	Text string `json:"text"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

type imageTranslateItem struct {
	Original    string `json:"original"`
	Translated  string `json:"translated"`
	X           int    `json:"x"`
	Y           int    `json:"y"`
	W           int    `json:"w"`
	H           int    `json:"h"`
}

type imageTranslateResp struct {
	Image string                `json:"image,omitempty"`
	Items []imageTranslateItem  `json:"items,omitempty"`
	Error string                `json:"error,omitempty"`
}

func handleImageTranslate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, `{"error":"POST required"}`, http.StatusMethodNotAllowed)
		return
	}
	if !requireLicense(w) {
		return
	}

	var req imageTranslateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"bad request: %s"}`, err.Error()), http.StatusBadRequest)
		return
	}

	if req.Image == "" {
		http.Error(w, `{"error":"image is required"}`, http.StatusBadRequest)
		return
	}

	// Write base64 image to temp file
	imgData, err := base64.StdEncoding.DecodeString(req.Image)
	if err != nil {
		http.Error(w, `{"error":"invalid base64"}`, http.StatusBadRequest)
		return
	}

	tmpDir := os.TempDir()
	inPath := filepath.Join(tmpDir, fmt.Sprintf("ocr_in_%d.png", time.Now().UnixNano()))
	defer os.Remove(inPath)

	if err := os.WriteFile(inPath, imgData, 0644); err != nil {
		writeImageError(w, "写入临时文件失败: "+err.Error())
		return
	}

	// Step 1: OCR
	ocrWords, err := runOCR(inPath)
	if err != nil {
		writeImageError(w, "OCR 识别失败: "+err.Error())
		return
	}
	if len(ocrWords) == 0 {
		writeImageError(w, "图片中未识别到文字")
		return
	}

	// Step 2: Translate each word
	targetLang := req.TargetLang
	if targetLang == "" {
		targetLang = "zh-Hans"
	}
	ollamaUrl := strings.TrimRight(req.OllamaUrl, "/")
	ollamaModel := req.OllamaModel
	if ollamaModel == "" {
		ollamaModel = "qwen2.5:7b"
	}
	openaiUrl := strings.TrimRight(req.OpenAIUrl, "/")
	openaiModel := req.OpenAIModel

	tr := translate.New("", "")
	tr.SetEngine(req.Engine)
	if req.Engine == "ollama" {
		tr.SetOllama(ollamaUrl, ollamaModel)
	}
	if req.Engine == "openai" {
		tr.SetOpenAI(openaiUrl, req.OpenAIKey, openaiModel)
	}
	if req.Engine == "deepl" {
		tr.SetDeepL(req.DeepLKey, "")
	}

	var items []imageTranslateItem
	for _, w := range ocrWords {
		if len(strings.TrimSpace(w.Text)) < 2 {
			continue
		}
		translated, err := tr.TranslateImage(w.Text, "auto", targetLang)
		if err != nil || translated == "" {
			translated = w.Text
		}
		items = append(items, imageTranslateItem{
			Original:   w.Text,
			Translated: translated,
			X:          w.X,
			Y:          w.Y,
			W:          w.W,
			H:          w.H,
		})
	}

	if len(items) == 0 {
		writeImageError(w, "无有效文字可翻译")
		return
	}

		// Step 3: Return items (browser renders via canvas overlay)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(imageTranslateResp{Items: items})
}

func writeImageError(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(imageTranslateResp{Error: msg})
}

// runOCR calls Python ocr.py as a one-shot subprocess.
// Model is cached on disk; first call is slow (~10s), subsequent calls ~2s.
func runOCR(imagePath string) ([]ocrWord, error) {
	python := findPython()
	scriptPath := filepath.Join(".", "scripts", "ocr.py")

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, python, scriptPath, imagePath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("OCR 超时，请重试")
		}
		return nil, fmt.Errorf("OCR 执行失败: %w", err)
	}

	var words []ocrWord
	if err := json.Unmarshal(out, &words); err != nil {
		return nil, fmt.Errorf("parse OCR JSON: %w", err)
	}
	return words, nil
}

// findPython returns a working python command.
func findPython() string {
	// Check known install paths first (Windows App Execution Alias
	// "python.exe" in WindowsApps is a store stub, not a real interpreter).
	candidates := []string{
		`C:\Users\mingz\AppData\Local\Programs\Python\Python310\python.exe`,
		"py", // Python Launcher for Windows
		"python3",
		"python",
	}
	for _, name := range candidates {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, name, "--version")
		if err := cmd.Run(); err == nil {
			cancel()
			return name
		}
		cancel()
	}
	return "python"
}

// handleFetchSubtitles fetches a YouTube timedtext URL server-side,
// parses the XML, and returns [{text, start, end}, ...] as JSON.
func handleFetchSubtitles(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		http.Error(w, `{"error":"missing url param"}`, http.StatusBadRequest)
		return
	}
	if !requireLicense(w) {
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

	loadLicense()

	modelManager = model.NewManager(cfg.ModelDir)

	// Start whisper-server (keeps model warm)
	whisperCmd, err := startWhisperServer(cfg)
	if err != nil {
		fmt.Println("[main] whisper-server:", err)
	} else {
		defer whisperCmd.Process.Kill()
	}
		// Health-check whisper-server every 10s, restart if it crashes
		go func() {
			for {
				time.Sleep(10 * time.Second)
				if whisperServerURL == "" {
					continue
				}
				resp, err := httpGet(whisperServerURL + "/inference")
				if err == nil {
					resp.Body.Close()
					continue
				}
				fmt.Println("[main] whisper-server: lost, restarting...")
				cmd, err := startWhisperServer(cfg)
				if err != nil {
					fmt.Println("[main] whisper-server restart:", err)
					continue
				}
				whisperCmd = cmd
			}
		}()

	// Start llama-server (local LLM, OpenAI-compatible API)
	llamaCmd, err := startLlamaServer(cfg)
	if err != nil {
		fmt.Println("[main] llama-server:", err)
	}
	modelManager.SetOnChange(func() {
		if llamaCmd != nil {
			llamaCmd.Process.Kill()
		}
		killPIDFile("llama-server")
		cmd, err := startLlamaServer(cfg)
		if err != nil {
			fmt.Println("[main] llama-server restart:", err)
			return
		}
		llamaCmd = cmd
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/set-token", handleSetToken)
	mux.HandleFunc("/ws", handleWebSocket)
	mux.HandleFunc("/translate/page", handleTranslatePage)
	mux.HandleFunc("/api/image-translate", handleImageTranslate)
	mux.HandleFunc("/fetch-subtitles", handleFetchSubtitles)
	mux.HandleFunc("/update", handleUpdate)
	mux.HandleFunc("/update/status", handleUpdateStatus)
	mux.HandleFunc("/model/list", handleModelList)
	mux.HandleFunc("/model/download", handleModelDownload)
	mux.HandleFunc("/model/download/status", handleModelDownloadStatus)
	mux.HandleFunc("/model/downloads", handleModelDownloads)
	mux.HandleFunc("/model/delete", handleModelDelete)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		status := map[string]interface{}{
			"status":   "ok",
			"version":  version,
			"licensed": licensed,
			"plan":     licensePlan,
			"whisperExe": cfg.WhisperExe,
			"modelPath":  cfg.ModelPath,
			"asrServer":  whisperServerURL,
			"llamaServer": llamaServerURL,
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
		if llamaCmd != nil {
			llamaCmd.Process.Kill()
		} else {
			// We may have reused an existing server; try cleaning up by PID file.
			killPIDFile("llama-server")
		}
		removePIDFile("llama-server")
		removePIDFile("whisper-server")
		os.Exit(0)
	}()

	handler := corsMiddleware(mux)
	fmt.Printf("backend started on %s\n", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		fmt.Printf("server exit: %v\n", err)
	}
}
