package asr

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sampleRate     = 16000
	bitsPerSample  = 16
	numChannels    = 1
	silenceThresh  = 0.005 // RMS threshold for silence
	silenceTimeout = 300   // ms of silence before cutting
	minSpeechLen   = 100   // ms minimum speech segment length
	maxSpeechLen   = 3000  // ms maximum speech segment length (force cut)

	streamFlushInterval = 300 // ms between streaming partial ASR flushes
	streamMinWindow     = 500 // ms minimum speech before first streaming flush
)

// AudioBuffer accumulates PCM audio and detects speech segments.
type AudioBuffer struct {
	mu             sync.Mutex
	samples        []int16
	speechStart    int
	silenceFrames  int
	processedFrame int

	// whisper-server HTTP endpoint
	serverURL string
	language  string

	// onResult callback: text, speechRate (chars/sec), duration (sec), isPartial, speaker label
	onResult func(originalText string, speechRate float64, duration float64, isPartial bool, speaker string)

	// streaming state
	lastFlushSample   int
	lastStreamingText string
	streamingStop     chan struct{}
	speechActive      bool

	// speaker diarization (pause-based heuristic)
	speakerTurn    int
	lastSpeechTime time.Time
}

// NewAudioBuffer creates a new audio buffer.
func NewAudioBuffer(serverURL, language string, onResult func(string, float64, float64, bool, string)) *AudioBuffer {
	return &AudioBuffer{
		samples:    make([]int16, 0, sampleRate*10),
		speechStart: -1,
		serverURL:  serverURL,
		language:   language,
		onResult:   onResult,
	}
}

// Append adds PCM int16 samples to the buffer and runs VAD.
func (ab *AudioBuffer) Append(pcm []int16) {
	ab.mu.Lock()
	defer ab.mu.Unlock()

	ab.samples = append(ab.samples, pcm...)

	maxSamples := sampleRate * 60
	if len(ab.samples) > maxSamples {
		excess := len(ab.samples) - maxSamples
		ab.samples = ab.samples[excess:]
		if ab.speechStart >= 0 {
			ab.speechStart -= excess
			if ab.speechStart < 0 {
				ab.speechStart = -1
			}
		}
		if ab.processedFrame > excess/320 {
			ab.processedFrame -= excess / 320
		} else {
			ab.processedFrame = 0
		}
		if ab.lastFlushSample > excess {
			ab.lastFlushSample -= excess
		} else {
			ab.lastFlushSample = 0
		}
	}

	wasSpeechActive := ab.speechActive
	ab.runVAD()

	// Start/stop streaming ticker based on speech state
	if ab.speechActive && !wasSpeechActive {
		ab.startStreaming()
	} else if !ab.speechActive && wasSpeechActive {
		ab.stopStreaming()
	}
}

func (ab *AudioBuffer) runVAD() {
	frameSize := sampleRate * 20 / 1000
	totalFrames := len(ab.samples) / frameSize
	if totalFrames <= ab.processedFrame {
		return
	}

	maxSpeechFrames := sampleRate * maxSpeechLen / 1000 / frameSize
	silenceFramesThreshold := silenceTimeout / 20

	for i := ab.processedFrame; i < totalFrames; i++ {
		start := i * frameSize
		end := start + frameSize
		if end > len(ab.samples) {
			break
		}

		rms := calcRMS(ab.samples[start:end])

		if rms > silenceThresh {
			if ab.speechStart < 0 {
				ab.speechStart = start
				ab.lastFlushSample = start
			}
			ab.silenceFrames = 0
			ab.speechActive = true

			if ab.speechStart >= 0 {
				segFrames := i - (ab.speechStart / frameSize)
				if segFrames >= maxSpeechFrames {
					ab.cutSegment(start)
					ab.speechStart = -1
					ab.silenceFrames = 0
					ab.speechActive = false
				}
			}
		} else if ab.speechStart >= 0 {
			ab.silenceFrames++
			if ab.silenceFrames >= silenceFramesThreshold {
				cutEnd := start - (ab.silenceFrames-1)*frameSize
				ab.cutSegment(cutEnd)
				ab.speechStart = -1
				ab.silenceFrames = 0
				ab.speechActive = false
			}
		}
	}

	ab.processedFrame = totalFrames
}

func (ab *AudioBuffer) cutSegment(endSample int) {
	segLen := endSample - ab.speechStart
	minSamples := sampleRate * minSpeechLen / 1000
	if segLen < minSamples {
		return
	}
	segment := make([]int16, segLen)
	copy(segment, ab.samples[ab.speechStart:endSample])

	segDur := float64(segLen) / sampleRate

	// Speaker diarization: if gap since last speech > 1.5s, assume new speaker
	now := time.Now()
	if !ab.lastSpeechTime.IsZero() && now.Sub(ab.lastSpeechTime) > 1500*time.Millisecond {
		ab.speakerTurn++
	}
	ab.lastSpeechTime = now
	speaker := string(rune('A' + ab.speakerTurn%26))


	go ab.processSegment(segment, segDur, false, speaker) // final result
}

func calcRMS(samples []int16) float64 {
	if len(samples) == 0 {
		return 0
	}
	var sum float64
	for _, s := range samples {
		val := float64(s) / 32768.0
		sum += val * val
	}
	return math.Sqrt(sum / float64(len(samples)))
}

// ─── Streaming partial ASR ───────────────────────────────────────────

func (ab *AudioBuffer) startStreaming() {
	if ab.streamingStop != nil {
		return
	}
	ab.streamingStop = make(chan struct{})
	go ab.streamingLoop(ab.streamingStop)
}

func (ab *AudioBuffer) stopStreaming() {
	if ab.streamingStop != nil {
		close(ab.streamingStop)
		ab.streamingStop = nil
	}
	ab.lastStreamingText = ""
	ab.lastFlushSample = 0
}

func (ab *AudioBuffer) streamingLoop(stop chan struct{}) {
	ticker := time.NewTicker(time.Duration(streamFlushInterval) * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			ab.flushStreamingChunk()
		}
	}
}

func (ab *AudioBuffer) flushStreamingChunk() {
	ab.mu.Lock()
	if ab.speechStart < 0 {
		ab.mu.Unlock()
		return
	}

	currentPos := len(ab.samples)
	startSample := ab.lastFlushSample
	if startSample < ab.speechStart {
		startSample = ab.speechStart
	}

	minSamples := sampleRate * streamMinWindow / 1000
	if currentPos-startSample < minSamples {
		ab.mu.Unlock()
		return
	}

	segLen := currentPos - ab.speechStart
	segment := make([]int16, segLen)
	copy(segment, ab.samples[ab.speechStart:currentPos])

	ab.lastFlushSample = currentPos
	ab.mu.Unlock()

	segDur := float64(segLen) / sampleRate
	go ab.processSegment(segment, segDur, true, "") // partial result (no speaker)
}

// ─── Whisper-server communication ────────────────────────────────────

// processSegment sends a speech segment to whisper-server via HTTP.
func (ab *AudioBuffer) processSegment(samples []int16, segDur float64, isPartial bool, speaker string) {
	if ab.serverURL == "" {
		return
	}

	wavData, err := pcmToWav(samples, sampleRate)
	if err != nil {
		return
	}

	text, err := ab.callWhisperServer(wavData)
	if err != nil {
		return
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return
	}

	if isPartial {
		// Deduplicate: only send if text differs from last streaming result
		if text == ab.lastStreamingText {
			return
		}
		ab.lastStreamingText = text
	} else {
	}

	if ab.onResult != nil {
		charCount := len([]rune(text))
		speechRate := float64(charCount) / segDur
		ab.onResult(text, speechRate, segDur, isPartial, speaker)
	}
}

// callWhisperServer sends WAV data to the whisper-server HTTP API.
func (ab *AudioBuffer) callWhisperServer(wavData []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return "", fmt.Errorf("form file: %w", err)
	}
	part.Write(wavData)

	writer.WriteField("language", ab.language)
	writer.WriteField("response_format", "json")
	writer.Close()

	url := ab.serverURL + "/inference"
	req, err := http.NewRequest("POST", url, &body)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server error %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}

	return result.Text, nil
}

// ─── Offline full-file ASR ────────────────────────────────────────────

// WordTimestamp is a single word with start/end time from whisper.
type WordTimestamp struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// SubtitleSegment is a single subtitle cue with timestamps returned from offline ASR.
type SubtitleSegment struct {
	Text  string          `json:"text"`
	Start float64         `json:"start"`
	End   float64         `json:"end"`
	Words []WordTimestamp `json:"words,omitempty"`
}

// ProcessOfflineFull takes a complete PCM buffer, sends it as one WAV to
// whisper-server with verbose_json output, and returns timestamped segments.
func ProcessOfflineFull(samples []int16, serverURL, language string, sampleRate int) ([]SubtitleSegment, error) {
	if serverURL == "" {
		return nil, fmt.Errorf("no whisper server URL")
	}
	if len(samples) == 0 {
		return nil, fmt.Errorf("empty audio")
	}
	if sampleRate <= 0 {
		sampleRate = 48000
	}

	wavData, err := pcmToWav(samples, sampleRate)
	if err != nil {
		return nil, fmt.Errorf("wav encode: %w", err)
	}

	text, err := callWhisperServerVerbose(wavData, serverURL, language)
	if err != nil {
		return nil, fmt.Errorf("whisper: %w", err)
	}

	// Log first 300 chars of raw whisper response for debugging
	preview := text
	if len(preview) > 300 {
		preview = preview[:300]
	}
	log.Printf("[verbose-json] raw response preview: %s", preview)

	return parseVerboseJSON(text)
}

// callWhisperServerVerbose sends WAV data and requests verbose_json (with timestamps).
func callWhisperServerVerbose(wavData []byte, serverURL, language string) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return "", fmt.Errorf("form file: %w", err)
	}
	part.Write(wavData)

	writer.WriteField("language", language)
	writer.WriteField("response_format", "verbose_json")
	writer.WriteField("timestamps", "1")
	writer.WriteField("word_timestamps", "1")
	writer.Close()

	url := serverURL + "/inference"
	req, err := http.NewRequest("POST", url, &body)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server error %d: %s", resp.StatusCode, string(respBody))
	}

	return string(respBody), nil
}

// parseVerboseJSON parses whisper.cpp verbose_json output and extracts segments.
func parseVerboseJSON(raw string) ([]SubtitleSegment, error) {
	var result struct {
		Segments []struct {
			Text  string  `json:"text"`
			Start float64 `json:"start"`
			End   float64 `json:"end"`
			Words []struct {
				Word  string  `json:"word"`
				Start float64 `json:"start"`
				End   float64 `json:"end"`
			} `json:"words"`
		} `json:"segments"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("parse verbose_json: %w", err)
	}

	log.Printf("[verbose-json] raw segments count: %d", len(result.Segments))

	var segs []SubtitleSegment
	skipped := 0
	for _, s := range result.Segments {
		text := strings.TrimSpace(s.Text)
		// Only skip clearly non-speech: blank audio, music, applause
		if text == "" || text == "[BLANK_AUDIO]" || text == "[MUSIC]" || text == "[APPLAUSE]" ||
			strings.Contains(text, "[BLANK_AUDIO]") {
			skipped++
			continue
		}
		if len([]rune(text)) >= 2 {
			seg := SubtitleSegment{Text: text, Start: s.Start, End: s.End}
			for _, w := range s.Words {
				wText := strings.TrimSpace(w.Word)
				if wText != "" {
					seg.Words = append(seg.Words, WordTimestamp{Word: wText, Start: w.Start, End: w.End})
				}
			}
			segs = append(segs, seg)
		} else {
			skipped++
		}
	}
	log.Printf("[verbose-json] parsed: %d segments kept, %d skipped", len(segs), skipped)
	return segs, nil
}

// ─── Chunked offline ASR (long audio) ──────────────────────────────────

const (
	chunkWindowSec = 30 // seconds per whisper window
	chunkOverlap   = 5  // seconds overlap between adjacent windows
	chunkMaxConcur = 2  // max parallel whisper calls
)

// ProcessOfflineFullChunked splits a long PCM buffer into overlapping windows,
// processes each with whisper, and merges the results with deduplication.
func ProcessOfflineFullChunked(samples []int16, serverURL, language string, sampleRate int) ([]SubtitleSegment, error) {
	if serverURL == "" {
		return nil, fmt.Errorf("no whisper server URL")
	}
	if len(samples) == 0 {
		return nil, fmt.Errorf("empty audio")
	}
	if sampleRate <= 0 {
		sampleRate = 48000
	}

	totalSec := float64(len(samples)) / float64(sampleRate)
	log.Printf("[chunked-asr] total duration: %.1fs, splitting into %ds windows with %ds overlap",
		totalSec, chunkWindowSec, chunkOverlap)

	// Short audio — use single-shot
	if totalSec <= float64(chunkWindowSec+chunkOverlap) {
		return ProcessOfflineFull(samples, serverURL, language, sampleRate)
	}

	windowSamples := sampleRate * chunkWindowSec
	stepSamples := sampleRate * (chunkWindowSec - chunkOverlap)

	// Build window boundaries
	type window struct {
		idx       int
		start     int
		end       int
		timeStart float64 // offset in original audio timeline (seconds)
	}
	var windows []window
	for start := 0; ; start += stepSamples {
		end := start + windowSamples
		if end > len(samples) {
			end = len(samples)
		}
		windows = append(windows, window{
			idx:       len(windows),
			start:     start,
			end:       end,
			timeStart: float64(start) / float64(sampleRate),
		})
		if end >= len(samples) {
			break
		}
	}
	log.Printf("[chunked-asr] %d windows to process", len(windows))

	// Process windows (limited concurrency)
	type result struct {
		idx  int
		segs []SubtitleSegment
		err  error
	}
	results := make([]result, len(windows))
	sem := make(chan struct{}, chunkMaxConcur)
	var wg sync.WaitGroup

	for i, w := range windows {
		wg.Add(1)
		go func(wi window, idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			chunk := make([]int16, wi.end-wi.start)
			copy(chunk, samples[wi.start:wi.end])
			segs, err := ProcessOfflineFull(chunk, serverURL, language, sampleRate)
			// Shift timestamps to original timeline
			for s := range segs {
				segs[s].Start += wi.timeStart
				segs[s].End += wi.timeStart
				for w := range segs[s].Words {
					segs[s].Words[w].Start += wi.timeStart
					segs[s].Words[w].End += wi.timeStart
				}
			}
			results[idx] = result{idx: idx, segs: segs, err: err}
			if err != nil {
				log.Printf("[chunked-asr] window %d/%d error: %v", idx+1, len(windows), err)
			} else {
				log.Printf("[chunked-asr] window %d/%d done: %d segments", idx+1, len(windows), len(segs))
			}
		}(w, i)
	}
	wg.Wait()

	// Merge results with deduplication
	var allSegs []SubtitleSegment
	for _, r := range results {
		if r.err != nil {
			continue // skip failed windows, keep partial results
		}
		for _, seg := range r.segs {
			// Check overlap with last merged segment
			if len(allSegs) > 0 {
				last := &allSegs[len(allSegs)-1]
				overlapStart := last.End - float64(chunkOverlap)
				if overlapStart < 0 {
					overlapStart = 0
				}
				// If this segment starts within the overlap zone of the last segment,
				// and their texts are similar, skip it (dedup)
				if seg.Start < last.End && seg.Start >= overlapStart {
					if isSimilarText(seg.Text, last.Text) {
						// Extend last segment if this one ends later
						if seg.End > last.End {
							last.End = seg.End
							last.Text = seg.Text
							last.Words = seg.Words
						}
						continue
					}
				}
			}
			allSegs = append(allSegs, seg)
		}
	}

	log.Printf("[chunked-asr] merged: %d total segments from %d windows", len(allSegs), len(windows))
	return allSegs, nil
}

// isSimilarText checks if two strings are similar enough to be considered
// duplicate across overlapping windows. Uses simple edit-distance heuristic.
func isSimilarText(a, b string) bool {
	if a == b {
		return true
	}
	// Normalize: lowercase, trim whitespace
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == b {
		return true
	}
	// Check if one contains the other (common in overlapping windows)
	if len(a) > 0 && len(b) > 0 {
		if strings.Contains(a, b) || strings.Contains(b, a) {
			return true
		}
	}
	// Check character overlap ratio
	ra := []rune(a)
	rb := []rune(b)
	if len(ra) == 0 || len(rb) == 0 {
		return false
	}
	common := 0
	for _, ca := range ra {
		for _, cb := range rb {
			if ca == cb {
				common++
				break
			}
		}
	}
	ratio := float64(common) / float64(len(ra))
	if float64(common)/float64(len(rb)) > ratio {
		ratio = float64(common) / float64(len(rb))
	}
	return ratio > 0.7
}

// pcmToWav converts raw PCM int16 samples to a WAV byte slice.
func pcmToWav(samples []int16, sampleRate int) ([]byte, error) {
	var buf bytes.Buffer

	dataSize := len(samples) * 2
	fileSize := 36 + dataSize

	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(fileSize))
	buf.WriteString("WAVE")
	buf.WriteString("fmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(numChannels))
	binary.Write(&buf, binary.LittleEndian, uint32(sampleRate))
	byteRate := sampleRate * numChannels * bitsPerSample / 8
	binary.Write(&buf, binary.LittleEndian, uint32(byteRate))
	blockAlign := numChannels * bitsPerSample / 8
	binary.Write(&buf, binary.LittleEndian, uint16(blockAlign))
	binary.Write(&buf, binary.LittleEndian, uint16(bitsPerSample))
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(dataSize))
	for _, s := range samples {
		binary.Write(&buf, binary.LittleEndian, s)
	}

	return buf.Bytes(), nil
}
