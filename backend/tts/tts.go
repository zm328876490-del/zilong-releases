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
	"log"
	"math"
	"net/http"
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

// VoiceForLang returns the Edge TTS voice name for a given language code.
func VoiceForLang(lang string) string {
	m := map[string]string{
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
	if v, ok := m[lang]; ok {
		return v
	}
	return "zh-CN-XiaoxiaoNeural"
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
	log.Printf("[TTS] sending config + ssml, url=%s", wsURL)
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
				log.Printf("[TTS] first binary chunk: headerLen=%d audioLen=%d", headerLen, len(audioData))
			}
			chunkCount++
			onChunk(AudioChunk{Data: audioData})

		case websocket.TextMessage:
			headers, body := parseHeadersAndBody(data)
			path := headers["Path"]
			if path != "turn.end" && chunkCount == 0 {
				log.Printf("[TTS] text msg path=%q headers=%v body_preview=%s", path, headers, string(body[:min(len(body), 120)]))
			}

			switch path {
			case "turn.end":
				log.Printf("[TTS] done, chunks=%d", chunkCount)
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

// Warmup performs a fire-and-forget warmup call.
func Warmup(voice string) {
	go func() {
		if _, err := Synthesize("ready", voice); err != nil {
			log.Printf("[TTS] warmup failed (non-fatal): %v", err)
		}
	}()
}

func init() {
	log.Printf("[TTS] Go-native Edge TTS ready (no Python relay)")
}
