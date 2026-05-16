package asr

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
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
	silenceTimeout = 200   // ms of silence before cutting
	minSpeechLen   = 180   // ms minimum speech segment length
	maxSpeechLen   = 5000  // ms maximum speech segment length (force cut)

	streamFlushInterval = 800 // ms between streaming partial ASR flushes
	streamMinWindow     = 1500 // ms minimum speech before first streaming flush
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

	wavData, err := pcmToWav(samples)
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

// pcmToWav converts raw PCM int16 samples to a WAV byte slice.
func pcmToWav(samples []int16) ([]byte, error) {
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
