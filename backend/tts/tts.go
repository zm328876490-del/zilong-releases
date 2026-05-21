package tts

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	edgeBaseURL   = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"
	trustedToken  = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
	chromiumVer   = "143.0.3650.75"
	secMSVersion  = "1-" + chromiumVer
	winEpoch      = 11644473600 // seconds between 1601 and 1970
)

var ttsSem = make(chan struct{}, 3)

// AudioChunk is a piece of synthesized audio from the streaming TTS pipeline.
type AudioChunk struct {
	Data  []byte
	Final bool
}

var (
	cache     = make(map[string]string)
	cacheKeys []string
	cacheMu   sync.RWMutex
)

const ttsCacheMax = 200

// VoiceForLang returns the Edge TTS voice name for a given language code (default female).
func VoiceForLang(lang string) string {
	return VoiceForLangAndGender(lang, "female")
}

// VoiceForLangAndGender returns the Edge TTS voice for a given language and gender.
func VoiceForLangAndGender(lang, gender string) string {
	if gender == "male" {
		if v, ok := maleVoices[lang]; ok {
			return v
		}
	}
	// female or unknown → use female voice map
	if v, ok := femaleVoices[lang]; ok {
		return v
	}
	return "zh-CN-XiaoxiaoNeural"
}

var femaleVoices = map[string]string{
	"zh-Hans": "zh-CN-XiaoxiaoNeural",
	"zh-Hant": "zh-TW-HsiaoChenNeural",
	"zh":      "zh-CN-XiaoxiaoNeural",
	"en":      "en-US-JennyNeural",
	"ja":      "ja-JP-NanamiNeural",
	"ko":      "ko-KR-SunHiNeural",
	"fr":      "fr-FR-DeniseNeural",
	"de":      "de-DE-KatjaNeural",
	"es":      "es-ES-ElviraNeural",
	"pt":      "pt-BR-FranciscaNeural",
	"ru":      "ru-RU-SvetlanaNeural",
	"ar":      "ar-SA-ZariyahNeural",
	"th":      "th-TH-PremwadeeNeural",
	"vi":      "vi-VN-HoaiMyNeural",
}

var maleVoices = map[string]string{
	"zh-Hans": "zh-CN-YunyangNeural",
	"zh-Hant": "zh-TW-YunJheNeural",
	"zh":      "zh-CN-YunyangNeural",
	"en":      "en-US-GuyNeural",
	"ja":      "ja-JP-KeitaNeural",
	"ko":      "ko-KR-InJoonNeural",
	"fr":      "fr-FR-HenriNeural",
	"de":      "de-DE-ConradNeural",
	"es":      "es-ES-AlvaroNeural",
	"pt":      "pt-BR-AntonioNeural",
	"ru":      "ru-RU-DmitryNeural",
	"ar":      "ar-SA-HamedNeural",
	"th":      "th-TH-NiwatNeural",
	"vi":      "vi-VN-NamMinhNeural",
}

// voiceShortNames maps frontend short voice names to Edge TTS voice names.
var voiceShortNames = map[string]string{
	"default":   "",
	"xiaoxiao":  "zh-CN-XiaoxiaoNeural",
	"yunxi":     "zh-CN-YunxiNeural",
	"xiaoyi":    "zh-CN-XiaoyiNeural",
	"yunyang":   "zh-CN-YunyangNeural",
	"jenny":     "en-US-JennyNeural",
	"guy":       "en-US-GuyNeural",
	"aria":      "en-US-AriaNeural",
	"nanami":    "ja-JP-NanamiNeural",
	"keita":     "ja-JP-KeitaNeural",
	"sunhi":     "ko-KR-SunHiNeural",
	"injoon":    "ko-KR-InJoonNeural",
	"denise":    "fr-FR-DeniseNeural",
	"henri":     "fr-FR-HenriNeural",
	"katja":     "de-DE-KatjaNeural",
	"conrad":    "de-DE-ConradNeural",
	"elvira":    "es-ES-ElviraNeural",
	"alvaro":    "es-ES-AlvaroNeural",
	"francisca": "pt-BR-FranciscaNeural",
	"antonio":   "pt-BR-AntonioNeural",
	"svetlana":  "ru-RU-SvetlanaNeural",
	"dmitry":    "ru-RU-DmitryNeural",
	"premwadee": "th-TH-PremwadeeNeural",
	"niwat":     "th-TH-NiwatNeural",
	"hoaimy":    "vi-VN-HoaiMyNeural",
	"namminh":   "vi-VN-NamMinhNeural",
}

// ResolveVoice returns the Edge TTS voice name from a user-selected short name.
// Falls back to the language default if voice is empty or "default".
func ResolveVoice(voice, lang string) string {
	if voice != "" && voice != "default" {
		if v, ok := voiceShortNames[voice]; ok && v != "" {
			return v
		}
	}
	return VoiceForLang(lang)
}

// SynthesizeStream connects to Edge TTS via WebSocket and calls onChunk for
// each received audio chunk.
func SynthesizeStream(text, voice string, onChunk func(AudioChunk)) error {
	ttsSem <- struct{}{}
	defer func() { <-ttsSem }()

	// Build URL with dynamic query parameters (matches edge_tts Python library)
	connID := uuidHex()
	secGEC := generateSecMSGEC()
	wsURL := fmt.Sprintf("wss://%s/edge/v1?TrustedClientToken=%s&ConnectionId=%s&Sec-MS-GEC=%s&Sec-MS-GEC-Version=%s",
		edgeBaseURL, trustedToken, connID, secGEC, secMSVersion)

	// Headers matching edge_tts WSS_HEADERS + DRM headers
	headers := http.Header{}
	headers.Set("Accept-Encoding", "gzip, deflate, br, zstd")
	headers.Set("Accept-Language", "en-US,en;q=0.9")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Pragma", "no-cache")
	headers.Set("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
	headers.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
	headers.Set("Cookie", "muid="+randomHex(32)+";")

	dialer := websocket.Dialer{
		HandshakeTimeout:     10 * time.Second,
		TLSClientConfig:      &tls.Config{MinVersion: tls.VersionTLS12},
		EnableCompression:    true,
	}
	conn, resp, err := dialer.Dial(wsURL, headers)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("edge tts connect (HTTP %d): %w", resp.StatusCode, err)
		}
		return fmt.Errorf("edge tts connect: %w", err)
	}
	defer conn.Close()

	timestamp := dateToString()

	// 1. Send BOTH speech.config AND SSML (matching edge_tts: send_command_request + send_ssml_request)
	//    The server expects both before it starts responding.
	configJSON := `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
	configMsg := fmt.Sprintf("X-Timestamp:%s\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n%s", timestamp, configJSON)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(configMsg)); err != nil {
		return fmt.Errorf("send config: %w", err)
	}

	lang := langFromVoice(voice)
	esc := escapeXML(text)
	ssml := fmt.Sprintf(
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='%s'><voice name='%s'><prosody pitch='+0Hz' rate='+20%%' volume='+0%%'>%s</prosody></voice></speak>`,
		lang, voice, esc,
	)
	ssmlReqID := uuidHex()
	ssmlMsg := fmt.Sprintf("X-RequestId:%s\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:%sZ\r\nPath:ssml\r\n\r\n%s", ssmlReqID, timestamp, ssml)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(ssmlMsg)); err != nil {
		return fmt.Errorf("send ssml: %w", err)
	}

	chunkCount := 0
	deadline := time.Now().Add(15 * time.Second)
	conn.SetReadDeadline(deadline)

	// 2. Read all responses: skip metadata, process binary audio, stop at turn.end
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return nil
			}
			return fmt.Errorf("read: %w", err)
		}

		switch msgType {
		case websocket.BinaryMessage:
			if len(data) < 2 {
				continue
			}
			headerLen := int(binary.BigEndian.Uint16(data[:2]))
			if headerLen+2 > len(data) {
				continue
			}
			audioData := data[headerLen+2:]
			if len(audioData) == 0 {
				continue
			}
			if chunkCount == 0 {
			}
			chunkCount++
			onChunk(AudioChunk{Data: audioData})

		case websocket.TextMessage:
			headers, body := parseHeadersAndBody(data)
			path := headers["Path"]
			if path != "turn.end" && chunkCount == 0 {
			}

			switch path {
			case "turn.end":
				onChunk(AudioChunk{Final: true})
				return nil

			case "turn.start", "response", "audio.metadata":
				// Metadata — skip

			default:
				if len(body) > 0 {
					var meta map[string]interface{}
					if json.Unmarshal(body, &meta) == nil {
						if meta["type"] == "audio" {
							if audioB64, ok := meta["data"].(string); ok {
								decoded, _ := base64.StdEncoding.DecodeString(audioB64)
								if len(decoded) > 0 {
									chunkCount++
									onChunk(AudioChunk{Data: decoded})
								}
							}
						}
					}
				}
			}
		}
	}
}

// Synthesize returns the complete audio as a single base64 string.
func Synthesize(text, voice string) (string, error) {
	cacheKey := voice + "|" + text

	cacheMu.RLock()
	if cached, ok := cache[cacheKey]; ok {
		cacheMu.RUnlock()
		return cached, nil
	}
	cacheMu.RUnlock()

	var allChunks []byte
	err := SynthesizeStream(text, voice, func(ch AudioChunk) {
		if !ch.Final {
			allChunks = append(allChunks, ch.Data...)
		}
	})
	if err != nil {
		return "", err
	}
	if len(allChunks) == 0 {
		return "", fmt.Errorf("tts empty output")
	}

	result := base64.StdEncoding.EncodeToString(allChunks)

	cacheMu.Lock()
	cache[cacheKey] = result
	cacheKeys = append(cacheKeys, cacheKey)
	if len(cacheKeys) > ttsCacheMax {
		delete(cache, cacheKeys[0])
		cacheKeys = cacheKeys[1:]
	}
	cacheMu.Unlock()

	return result, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────

// parseHeadersAndBody splits an Edge TTS message into headers and body.
// All Edge TTS text messages use HTTP-header-like format: Key:Value\r\n...\r\n\r\nBody
func parseHeadersAndBody(data []byte) (map[string]string, []byte) {
	headerEnd := bytes.Index(data, []byte("\r\n\r\n"))
	if headerEnd < 0 {
		return nil, data
	}
	headers := make(map[string]string)
	for _, line := range bytes.Split(data[:headerEnd], []byte("\r\n")) {
		parts := bytes.SplitN(line, []byte(":"), 2)
		if len(parts) == 2 {
			headers[string(parts[0])] = string(bytes.TrimSpace(parts[1]))
		}
	}
	return headers, data[headerEnd+4:]
}

func generateSecMSGEC() string {
	// Matches DRM.generate_sec_ms_gec() in edge_tts
	now := float64(time.Now().Unix()) + winEpoch
	now -= math.Mod(now, 300)       // round down to 5 min
	ticks := now * 1e9 / 100         // convert to 100-ns intervals
	str := fmt.Sprintf("%.0f%s", ticks, trustedToken)
	hash := sha256.Sum256([]byte(str))
	return strings.ToUpper(hex.EncodeToString(hash[:]))
}

func dateToString() string {
	return time.Now().UTC().Format("Mon Jan 02 2006 15:04:05") + " GMT+0000 (Coordinated Universal Time)"
}

func uuidHex() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func randomHex(n int) string {
	b := make([]byte, n/2)
	rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func langFromVoice(voice string) string {
	parts := strings.Split(voice, "-")
	if len(parts) >= 2 {
		return parts[0] + "-" + parts[1]
	}
	return "en-US"
}

func escapeXML(s string) string {
	var buf bytes.Buffer
	for _, r := range s {
		switch r {
		case '&':
			buf.WriteString("&amp;")
		case '<':
			buf.WriteString("&lt;")
		case '>':
			buf.WriteString("&gt;")
		case '"':
			buf.WriteString("&quot;")
		case '\'':
			buf.WriteString("&apos;")
		default:
			buf.WriteRune(r)
		}
	}
	return buf.String()
}

// SynthesizeStretched synthesizes TTS audio and stretches/compresses it
// to match the target duration (in seconds) using ffmpeg atempo.
// Returns base64-encoded MP3.
func SynthesizeStretched(text, voice string, targetDuration float64) (string, error) {
	// Get raw TTS audio first
	rawB64, err := Synthesize(text, voice)
	if err != nil {
		return "", err
	}

	rawMP3, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		return "", fmt.Errorf("decode tts: %w", err)
	}

	ttsDuration, err := mp3Duration(rawMP3)
	if err != nil || ttsDuration <= 0 {
		// Can't measure duration, return unstretched audio
		return rawB64, nil
	}

	ratio := targetDuration / ttsDuration

	// Only stretch if difference is significant (> 10%)
	if ratio > 0.9 && ratio < 1.1 {
		return rawB64, nil
	}

	// Clamp to atempo range (0.5 to 2.0); chain filters for extremes
	stretched, err := stretchMP3(rawMP3, ratio)
	if err != nil {
		return rawB64, nil
	}

	return base64.StdEncoding.EncodeToString(stretched), nil
}

// mp3Duration returns the duration of an MP3 file in seconds using ffprobe.
func mp3Duration(mp3 []byte) (float64, error) {
	tmpFile, err := os.CreateTemp("", "tts_*.mp3")
	if err != nil {
		return 0, err
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)
	if _, err := tmpFile.Write(mp3); err != nil {
		tmpFile.Close()
		return 0, err
	}
	tmpFile.Close()

	out, err := exec.Command("ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", tmpPath).Output()
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
}

// stretchMP3 stretches/compresses MP3 audio by the given ratio using ffmpeg atempo.
func stretchMP3(mp3 []byte, ratio float64) ([]byte, error) {
	tmpIn, err := os.CreateTemp("", "tts_in_*.mp3")
	if err != nil {
		return nil, err
	}
	tmpInPath := tmpIn.Name()
	defer os.Remove(tmpInPath)
	if _, err := tmpIn.Write(mp3); err != nil {
		tmpIn.Close()
		return nil, err
	}
	tmpIn.Close()

	tmpOutPath := filepath.Join(os.TempDir(), fmt.Sprintf("tts_out_%d.mp3", time.Now().UnixNano()))

	// Chain multiple atempo filters if ratio is outside [0.5, 2.0]
	filter := buildAtempoFilter(ratio)

	cmd := exec.Command("ffmpeg", "-y", "-v", "quiet", "-i", tmpInPath, "-filter:a", filter, "-c:a", "libmp3lame", "-b:a", "48k", tmpOutPath)
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg atempo: %w", err)
	}
	defer os.Remove(tmpOutPath)

	return os.ReadFile(tmpOutPath)
}

// buildAtempoFilter returns an ffmpeg atempo filter string for the given ratio.
// Chains multiple atempo filters for values outside [0.5, 2.0].
func buildAtempoFilter(ratio float64) string {
	if ratio >= 0.5 && ratio <= 2.0 {
		return fmt.Sprintf("atempo=%.4f", ratio)
	}
	// For extreme values, chain sqrt(ratio) twice
	mid := math.Sqrt(ratio)
	return fmt.Sprintf("atempo=%.4f,atempo=%.4f", mid, mid)
}

// Warmup performs a fire-and-forget warmup call.
// EstimateMP3DurationFromBase64 estimates the duration in milliseconds
// of a base64-encoded MP3 produced by Edge TTS (48kbps: audio-24khz-48kbitrate-mono-mp3).
func EstimateMP3DurationFromBase64(b64 string) int {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return 0
	}
	return len(raw) * 8 / 48
}

func Warmup(voice string) {
	go func() {
		if _, err := Synthesize("ready", voice); err != nil {
		}
	}()
}

func init() {
}
