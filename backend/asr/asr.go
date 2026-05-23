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
	// silenceTimeout: 900ms tolerates natural mid-sentence pauses
	// ("so... I think... it's actually a good idea") instead of slicing
	// one sentence into 2-3 fragments. Each fragment used to be sent to
	// the LLM separately, so translations read disconnected. Cost: +300ms
	// subtitle latency — invisible under the floating window's 6s buffer.
	silenceTimeout = 900 // ms of silence before cutting
	minSpeechLen   = 300 // ms minimum speech segment length
	// maxSpeechLen: 8s lets long-but-coherent English sentences stay in
	// one piece. Whisper handles 8s in ~60ms more than 5s — imperceptible.
	maxSpeechLen = 8000 // ms maximum speech segment length (force cut)

	streamFlushInterval = 300 // ms between streaming partial ASR flushes
	streamMinWindow     = 500 // ms minimum speech before first streaming flush
)

// chunkTimestamp records the video playback time when a chunk of audio samples was captured.
type chunkTimestamp struct {
	sampleOffset int     // sample index in the buffer where this chunk starts
	videoTime    float64 // video.currentTime at capture moment
}

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

	// onResult callback: text, speechRate (chars/sec), duration (sec), isPartial, speaker label, startTime (sec), endTime (sec), word timestamps, segment PCM (nil for partials)
	onResult func(originalText string, speechRate float64, duration float64, isPartial bool, speaker string, startTime float64, endTime float64, words []WordTimestamp, segmentPCM []int16)

	// streaming state
	lastFlushSample   int
	lastStreamingText string
	streamingStop     chan struct{}
	speechActive      bool

	// speaker diarization (pause-based heuristic)
	speakerTurn    int
	lastSpeechTime time.Time

	// video-anchored timestamps: each chunk records (sampleOffset, videoTime)
	chunkTimestamps []chunkTimestamp

	// Rolling context prompt (see RollingBuffer.lastFinalText for rationale).
	lastFinalText string
}

// NewAudioBuffer creates a new audio buffer.
func NewAudioBuffer(serverURL, language string, onResult func(string, float64, float64, bool, string, float64, float64, []WordTimestamp, []int16)) *AudioBuffer {
	return &AudioBuffer{
		samples:         make([]int16, 0, sampleRate*10),
		speechStart:     -1,
		serverURL:       serverURL,
		language:        language,
		onResult:        onResult,
		chunkTimestamps: make([]chunkTimestamp, 0, 256),
	}
}

// Append adds PCM int16 samples to the buffer and runs VAD.
// videoTime is the video's currentTime when these samples were captured.
func (ab *AudioBuffer) Append(pcm []int16, videoTime float64) {
	ab.mu.Lock()
	defer ab.mu.Unlock()

	ab.chunkTimestamps = append(ab.chunkTimestamps, chunkTimestamp{
		sampleOffset: len(ab.samples),
		videoTime:    videoTime,
	})

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
		// Trim chunkTimestamps that are entirely before the new buffer start
		cut := 0
		for _, ct := range ab.chunkTimestamps {
			if ct.sampleOffset < excess {
				cut++
			} else {
				break
			}
		}
		if cut > 0 {
			ab.chunkTimestamps = ab.chunkTimestamps[cut:]
			for i := range ab.chunkTimestamps {
				ab.chunkTimestamps[i].sampleOffset -= excess
			}
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


	go ab.processSegment(segment, segDur, false, speaker, ab.speechStart, endSample) // final result
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
	go ab.processSegment(segment, segDur, true, "", ab.speechStart, currentPos) // partial result
}

// sampleToVideoTime converts a sample index to the corresponding video playback time.
// It finds the most recent chunk timestamp at or before sampleIdx and interpolates.
func (ab *AudioBuffer) sampleToVideoTime(sampleIdx int) float64 {
	ab.mu.Lock()
	defer ab.mu.Unlock()

	for i := len(ab.chunkTimestamps) - 1; i >= 0; i-- {
		ct := ab.chunkTimestamps[i]
		if ct.sampleOffset <= sampleIdx {
			offsetSec := float64(sampleIdx-ct.sampleOffset) / sampleRate
			return ct.videoTime + offsetSec
		}
	}
	// Fallback: no chunk timestamp (should not normally happen)
	return float64(sampleIdx) / sampleRate
}

// ─── Whisper-server communication ────────────────────────────────────

// processSegment sends a speech segment to whisper-server via HTTP.
func (ab *AudioBuffer) processSegment(samples []int16, segDur float64, isPartial bool, speaker string, startSample int, endSample int) {
	if ab.serverURL == "" {
		return
	}

	wavData, err := pcmToWav(samples, sampleRate)
	if err != nil {
		return
	}

	var text string
	var words []WordTimestamp

	if isPartial {
		text, err = ab.callWhisperServer(wavData)
	} else {
		// Final result: use verbose_json for word-level timestamps
		text, words, err = ab.callWhisperServerWithWords(wavData)
	}
	if err != nil {
		return
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return
	}

	if isPartial {
		if text == ab.lastStreamingText {
			return
		}
		ab.lastStreamingText = text
	}

	if ab.onResult != nil {
		charCount := len([]rune(text))
		speechRate := float64(charCount) / segDur
		startTime := ab.sampleToVideoTime(startSample)
		endTime := ab.sampleToVideoTime(endSample)
			// Offset word timestamps from segment-relative to absolute video timeline
			for i := range words {
				words[i].Start += startTime
				words[i].End += startTime
			}
			// For final results pass the segment PCM so main can do gender detection.
			// For partials, gender detection is meaningless — pass nil.
			var segPCM []int16
			if !isPartial {
				segPCM = samples
				// Remember the last final transcript as prompt for the
				// next whisper request — improves cross-batch continuity
				// at zero extra inference cost.
				ab.mu.Lock()
				ab.lastFinalText = text
				ab.mu.Unlock()
			}
			ab.onResult(text, speechRate, segDur, isPartial, speaker, startTime, endTime, words, segPCM)
	}
}

// writeWhisperRequest writes the multipart body shared by all whisper-server
// callers. Centralizes the accuracy-tuning fields so any future tweak only
// needs to land here:
//
//	temperature=0           — greedy decoding, deterministic & reduces drift
//	no_speech_thold=0.6     — stricter silence gate, fewer "Thank you" hallucinations
//	temperature_inc=0.2     — only fall back to sampling if greedy fails
//	prompt=<lastFinalText>  — gives whisper the previous segment as context so
//	                          proper nouns, names, and ongoing sentences stay
//	                          coherent across batch boundaries. Zero extra
//	                          inference cost — whisper.cpp natively consumes it.
//	                          Capped at ~200 chars to stay inside whisper's
//	                          224-token prompt window.
func writeWhisperRequest(writer *multipart.Writer, wavData []byte, language, responseFormat, prompt string, wantWords bool) error {
	part, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return fmt.Errorf("form file: %w", err)
	}
	if _, err := part.Write(wavData); err != nil {
		return fmt.Errorf("write wav: %w", err)
	}
	writer.WriteField("language", language)
	writer.WriteField("response_format", responseFormat)
	writer.WriteField("temperature", "0")
	writer.WriteField("temperature_inc", "0.2")
	writer.WriteField("no_speech_thold", "0.6")
	if wantWords {
		writer.WriteField("timestamps", "1")
		writer.WriteField("word_timestamps", "1")
	}
	if prompt != "" {
		// whisper's prompt window is ~224 tokens; cap text length to stay
		// safely under that even on CJK (worst-case ~1 char per token).
		if len(prompt) > 200 {
			r := []rune(prompt)
			if len(r) > 100 {
				prompt = string(r[len(r)-100:])
			}
		}
		writer.WriteField("prompt", prompt)
	}
	return writer.Close()
}

// callWhisperServer sends WAV data to the whisper-server HTTP API.
func (ab *AudioBuffer) callWhisperServer(wavData []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writeWhisperRequest(writer, wavData, ab.language, "json", ab.lastFinalText, false); err != nil {
		return "", err
	}

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

// callWhisperServerWithWords sends WAV data to whisper-server with verbose_json
// output and returns the full text plus word-level timestamps.
func (ab *AudioBuffer) callWhisperServerWithWords(wavData []byte) (string, []WordTimestamp, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writeWhisperRequest(writer, wavData, ab.language, "verbose_json", ab.lastFinalText, true); err != nil {
		return "", nil, err
	}

	url := ab.serverURL + "/inference"
	req, err := http.NewRequest("POST", url, &body)
	if err != nil {
		return "", nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("server error %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Text     string `json:"text"`
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
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", nil, fmt.Errorf("parse verbose_json: %w", err)
	}

	fullText := strings.TrimSpace(result.Text)
	var words []WordTimestamp
	for _, seg := range result.Segments {
		for _, w := range seg.Words {
			wText := strings.TrimSpace(w.Word)
			if wText != "" {
				words = append(words, WordTimestamp{Word: wText, Start: w.Start, End: w.End})
			}
		}
	}
	return fullText, words, nil
}

// ─── Rolling-buffer batch ASR (VAD bypass, whisper-native segmentation) ──

// RollingBuffer accumulates audio and periodically sends the full buffer to
// whisper as a single WAV. Whisper handles its own segmentation, producing
// more accurate sentence boundaries than energy-based VAD.
// Designed for floating-window mode where the 5s delay provides room for batching.
type RollingBuffer struct {
	mu              sync.Mutex
	samples         []int16
	chunkTimestamps []chunkTimestamp
	serverURL       string
	language        string
	onResult        func(string, float64, float64, bool, string, float64, float64, []WordTimestamp, []int16)

	lastEmittedEnd    float64
	lastEmittedSample int
	processing        bool
	started           bool
	stopCh            chan struct{}

	// Rolling context prompt: the last final segment text, fed back to
	// whisper as `prompt` for the next batch. Helps with proper nouns,
	// continuation of long sentences, and reduces hallucination — at zero
	// extra inference cost (whisper.cpp natively accepts a prompt).
	lastFinalText string
}

func NewRollingBuffer(serverURL, language string, onResult func(string, float64, float64, bool, string, float64, float64, []WordTimestamp, []int16)) *RollingBuffer {
	return &RollingBuffer{
		samples:         make([]int16, 0, sampleRate*60),
		chunkTimestamps: make([]chunkTimestamp, 0, 256),
		serverURL:       serverURL,
		language:        language,
		onResult:        onResult,
	}
}

func (rb *RollingBuffer) Append(samples []int16, videoTime float64) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.chunkTimestamps = append(rb.chunkTimestamps, chunkTimestamp{
		sampleOffset: len(rb.samples),
		videoTime:    videoTime,
	})
	rb.samples = append(rb.samples, samples...)

	maxSamples := sampleRate * 60
	if len(rb.samples) > maxSamples {
		excess := len(rb.samples) - maxSamples
		rb.samples = rb.samples[excess:]
		rb.lastEmittedSample -= excess
		if rb.lastEmittedSample < 0 {
			rb.lastEmittedSample = 0
		}
		cut := 0
		for _, ct := range rb.chunkTimestamps {
			if ct.sampleOffset < excess {
				cut++
			} else {
				break
			}
		}
		if cut > 0 {
			rb.chunkTimestamps = rb.chunkTimestamps[cut:]
			for i := range rb.chunkTimestamps {
				rb.chunkTimestamps[i].sampleOffset -= excess
			}
		}
	}
}

func (rb *RollingBuffer) Start() {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if rb.started {
		return
	}
	rb.started = true
	rb.samples = rb.samples[:0]
	rb.chunkTimestamps = rb.chunkTimestamps[:0]
	rb.lastEmittedEnd = 0
	rb.lastEmittedSample = 0
	rb.stopCh = make(chan struct{})
	go rb.loop()
}

func (rb *RollingBuffer) Stop() {
	rb.mu.Lock()
	if !rb.started {
		rb.mu.Unlock()
		return
	}
	rb.started = false
	rb.mu.Unlock()
	close(rb.stopCh)
}

func (rb *RollingBuffer) loop() {
	// Check every 1s: fire processBatch as soon as 2s of new unprocessed
	// audio has accumulated. Much faster than a fixed 4s ticker — a 10s
	// video gets 4-5 batches instead of 2-3.
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	// Initial check: audio may have been buffered before start (pcmBuffer flush)
	rb.checkAndProcess()

	for {
		select {
		case <-rb.stopCh:
			rb.processBatch()
			return
		case <-ticker.C:
			rb.checkAndProcess()
		}
	}
}

func (rb *RollingBuffer) checkAndProcess() {
	rb.mu.Lock()
	if rb.processing {
		rb.mu.Unlock()
		return
	}
	unprocessed := len(rb.samples) - rb.lastEmittedSample
	if unprocessed >= sampleRate*2 {
		rb.mu.Unlock()
		rb.processBatch()
	} else {
		rb.mu.Unlock()
	}
}

// ResetSession is called when the client signals that the audio source has
// fundamentally changed (video looped, switched to next video, etc).
// It first flushes any pending tail to capture the last words of the
// previous segment, then wipes the buffer & cursors so the next Append()
// starts a fresh timeline from videoTime=0. Without this, a TikTok loop
// would have its 2nd play appended to the 1st, causing whisper to return
// a single 30s segment for two consecutive 14.5s plays.
func (rb *RollingBuffer) ResetSession() {
	// Step 1: flush whatever is pending (last < 2s of previous session).
	// This runs processBatch synchronously and returns when whisper has
	// returned segments AND onResult has been invoked.
	rb.FlushTail()

	// Step 2: wait for any in-flight processBatch (started by the ticker
	// loop) to finish — otherwise we'd clear the buffer while whisper is
	// still transcribing the tail, and those segments would be lost.
	for i := 0; i < 30; i++ { // up to 3s
		rb.mu.Lock()
		busy := rb.processing
		rb.mu.Unlock()
		if !busy {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Step 3: wipe state.
	rb.mu.Lock()
	rb.samples = rb.samples[:0]
	rb.chunkTimestamps = rb.chunkTimestamps[:0]
	rb.lastEmittedEnd = 0
	rb.lastEmittedSample = 0
	rb.mu.Unlock()
}

// FlushTail forces processBatch to run even if < 2s of unprocessed audio
// remains. Called by the extension on video-ended or source-swap so the
// final tail (which would otherwise sit forever below the 2s threshold)
// gets transcribed. Safe to call repeatedly.
func (rb *RollingBuffer) FlushTail() {
	rb.mu.Lock()
	if rb.processing || !rb.started {
		rb.mu.Unlock()
		return
	}
	// Even a tiny tail (e.g. 300ms) is worth sending — whisper handles
	// short clips, and the alternative is silently dropping it.
	unprocessed := len(rb.samples) - rb.lastEmittedSample
	if unprocessed < sampleRate/4 { // < 250ms = noise, skip
		rb.mu.Unlock()
		return
	}
	rb.mu.Unlock()
	rb.processBatch()
}

func (rb *RollingBuffer) processBatch() {
	rb.mu.Lock()
	if rb.processing {
		rb.mu.Unlock()
		return
	}
	// Allow tail-flush: as long as ANY new audio exists past lastEmittedSample,
	// proceed. The old `len(samples) < 2s` guard caused the final < 2s of every
	// video to be silently dropped.
	if len(rb.samples) == 0 || rb.lastEmittedSample >= len(rb.samples) {
		rb.mu.Unlock()
		return
	}
	rb.processing = true

	// Slice from last emitted position, with 1s overlap so whisper has
	// context at the boundary. This avoids re-processing the entire buffer.
	startSample := rb.lastEmittedSample
	overlap := sampleRate * 1 // 1s overlap
	startSample -= overlap
	if startSample < 0 {
		startSample = 0
	}
	if startSample >= len(rb.samples) {
		// lastEmittedSample has drifted past the buffer (e.g. buffer was
		// trimmed). Reset and reprocess from the beginning.
		log.Printf("[rolling] startSample %d >= buffer len %d, resetting cursor",
			startSample, len(rb.samples))
		rb.lastEmittedSample = 0
		rb.lastEmittedEnd = 0
		startSample = 0
	}

	// HARD CAP: never send more than 8s of audio to whisper in one batch.
	// Without this, video loops or long silent gaps cause whisper to
	// receive 20-30s of audio and return a single huge segment that
	// blocks subtitle granularity (one 30s subtitle line for a TikTok loop).
	const maxBatchSamples = sampleRate * 8
	endSample := len(rb.samples)
	if endSample-startSample > maxBatchSamples {
		endSample = startSample + maxBatchSamples
	}

	slice := rb.samples[startSample:endSample]
	samples := make([]int16, len(slice))
	copy(samples, slice)
	sliceEndSample := endSample // remember where we cut so processBatch can advance cursor correctly even on dedup

	timestamps := make([]chunkTimestamp, len(rb.chunkTimestamps))
	copy(timestamps, rb.chunkTimestamps)
	lastEnd := rb.lastEmittedEnd
	rb.mu.Unlock()

	defer func() {
		rb.mu.Lock()
		rb.processing = false
		rb.mu.Unlock()
	}()

	// Video time at the start of our sliced audio
	baseVideoTime := sampleToVideoTimeFrom(
		float64(startSample)/float64(sampleRate),
		timestamps,
		sampleRate,
	)

	segs, err := ProcessOfflineFull(samples, rb.serverURL, rb.language, sampleRate)
	if err != nil {
		log.Printf("[rolling] whisper batch failed: %v", err)
		return
	}

	// (verbose batch log removed; use the [stats] lines in main.go for timing)

	maxSegEnd := 0.0 // audio-relative end of the last emitted segment

	for _, seg := range segs {
		// Segment times from whisper are relative to the start of the
		// sent audio; add baseVideoTime to get absolute video times.
		absStart := baseVideoTime + seg.Start
		absEnd := baseVideoTime + seg.End

		// Drop fully-overlapped segs (entirely before lastEnd).
		if absEnd <= lastEnd {
			continue
		}

		// Convert ALL word times to absolute video time first.
		for i := range seg.Words {
			seg.Words[i].Start = baseVideoTime + seg.Words[i].Start
			seg.Words[i].End = baseVideoTime + seg.Words[i].End
		}

		// CRITICAL: trim overlap with previously-emitted audio.
		// Without this, the 1s overlap fed to whisper for context
		// makes the FIRST words of each batch repeat the LAST words
		// of the previous batch — the user hears "下一句读到上一句的词"
		// and sees duplicate subtitles.
		if absStart < lastEnd {
			if len(seg.Words) > 0 {
				// Precise: keep words whose MIDPOINT is past lastEnd.
				keptWords := seg.Words[:0]
				for _, w := range seg.Words {
					mid := (w.Start + w.End) / 2
					if mid > lastEnd {
						keptWords = append(keptWords, w)
					}
				}
				if len(keptWords) == 0 {
					// Whole segment was overlap repetition — drop it.
					continue
				}
				seg.Words = keptWords
				absStart = keptWords[0].Start
				absEnd = keptWords[len(keptWords)-1].End
				var sb strings.Builder
				for i, w := range keptWords {
					if i > 0 {
						sb.WriteByte(' ')
					}
					sb.WriteString(w.Word)
				}
				seg.Text = sb.String()
			} else {
				// No word-level data: if the seg starts > 0.5s before
				// lastEnd, it's mostly overlap repetition — drop it.
				// Otherwise emit but anchor start to lastEnd.
				if lastEnd-absStart > 0.5 {
					continue
				}
				absStart = lastEnd
			}
		}

		// Trim leading whitespace introduced by word joining.
		seg.Text = strings.TrimSpace(seg.Text)
		if seg.Text == "" {
			continue
		}

		charCount := len([]rune(seg.Text))
		dur := absEnd - absStart
		if dur <= 0 {
			dur = 0.5
		}
		speechRate := float64(charCount) / dur

		// Slice the segment's PCM out of the batch so main can do gender detection.
		// seg.Start/seg.End are relative to the start of the audio sent to whisper.
		segStartIdx := int(seg.Start * float64(sampleRate))
		segEndIdx := int(seg.End * float64(sampleRate))
		if segStartIdx < 0 {
			segStartIdx = 0
		}
		if segEndIdx > len(samples) {
			segEndIdx = len(samples)
		}
		var segPCM []int16
		if segEndIdx > segStartIdx {
			segPCM = samples[segStartIdx:segEndIdx]
		}

		// Remember the most recent final segment so the NEXT whisper call
		// gets it as `prompt`. Greatly improves continuity across batches
		// (proper nouns, mid-sentence continuations).
		rb.mu.Lock()
		rb.lastFinalText = seg.Text
		rb.mu.Unlock()

		rb.onResult(seg.Text, speechRate, dur, false, "", absStart, absEnd, seg.Words, segPCM)

		if absEnd > lastEnd {
			lastEnd = absEnd
		}
		if seg.End > maxSegEnd {
			maxSegEnd = seg.End
		}
	}

	rb.mu.Lock()
	if lastEnd > rb.lastEmittedEnd {
		rb.lastEmittedEnd = lastEnd
		// Advance the sample cursor to the end of the last emitted segment,
		// so the next batch starts from where this segment ended (minus overlap).
		rb.lastEmittedSample = startSample + int(maxSegEnd*float64(sampleRate))
	} else {
		// Whisper returned 0 new segments (silence / noise / dedup'd). If we
		// don't advance the cursor, the next tick re-processes the SAME
		// audio forever, blocking new audio from ever being emitted. Advance
		// past the slice we JUST sent (not the whole buffer — we may have
		// capped the batch), keeping 1s of overlap for boundary context.
		newCursor := sliceEndSample - sampleRate
		if newCursor > rb.lastEmittedSample {
			rb.lastEmittedSample = newCursor
		}
	}
	rb.mu.Unlock()
}

// sampleToVideoTimeFrom converts an audio-relative time (seconds) to absolute
// video playback time using the chunk timestamp map.
func sampleToVideoTimeFrom(audioSec float64, timestamps []chunkTimestamp, sr int) float64 {
	sampleIdx := int(audioSec * float64(sr))
	for i := len(timestamps) - 1; i >= 0; i-- {
		ct := timestamps[i]
		if ct.sampleOffset <= sampleIdx {
			offsetSec := float64(sampleIdx-ct.sampleOffset) / float64(sr)
			return ct.videoTime + offsetSec
		}
	}
	return audioSec
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
	_ = preview
	return parseVerboseJSON(text)
}

// callWhisperServerVerbose sends WAV data and requests verbose_json (with timestamps).
func callWhisperServerVerbose(wavData []byte, serverURL, language string) (string, error) {
	// Offline batch path (no rolling context — entire file goes in one call).
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	if err := writeWhisperRequest(writer, wavData, language, "verbose_json", "", true); err != nil {
		return "", err
	}

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
	_ = skipped
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
