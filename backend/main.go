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
	"math"
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
}

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

func (c *Client) onASRResult(text string, speechRate float64, duration float64, isPartial bool, speaker string, startTime float64, endTime float64, words []asr.WordTimestamp) {
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
			UtteranceId: utterId,
			StartTime:   startTime,
			EndTime:     endTime,
			Words:       words,
		})
	}

	// Throttle TTS for partials: skip if TTS already running or started recently.
	// Finals always proceed (cancel current TTS first).
	if !isPartial {
		c.lastTtsTime = time.Now()
		// Queue final TTS via semaphore — serializes batch results from
		// RollingBuffer without cancelling each other.
		go func() {
			c.ttsSeq <- struct{}{}
			defer func() { <-c.ttsSeq }()
			c.generateAndSendTTS(translated, utterId, speechRate, false, nil)
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

	go c.generateAndSendTTS(translated, utterId, speechRate, true, cancelCh)
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

	subs = splitSubtitlesIntoSentences(subs)
	if len(subs) == 0 {
		c.sendJSON(OutMsg{Type: "preprocess_error", Message: "No subtitles to process"})
		return
	}

	log.Printf("[preprocess] %d subtitles", len(subs))
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

	transCount := total
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
		ttsSeq:     make(chan struct{}, 1),
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
				client.active = false
				if client.rollingBuf != nil {
					client.rollingBuf.Stop()
				}
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
