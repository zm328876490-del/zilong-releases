package translate

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ctxPair is an original→translated pair stored for context injection.
type ctxPair struct{ original, translated string }

// Translator supports multiple backends. Engine can be set to "microsoft", "google", or "ollama".
type Translator struct {
	engine      string // "microsoft", "google", or "ollama"; empty = auto
	asyncFn     func(text, from, to string) (string, error)
	ollamaUrl   string
	ollamaModel string
	msToken     string
	msTokenAt   time.Time
	msTokenMu   sync.Mutex
	client      *http.Client
	cache       map[string]string
	cacheKeys   []string
	cacheMu     sync.RWMutex
	// Rolling context window for ollama subtitle translation
	ctxRing  []ctxPair
	ctxIdx   int
	ctxCount int
	ctxMu    sync.Mutex
}

const translateCacheMax = 500

func New(apiKey, region string) *Translator {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          20,
		MaxIdleConnsPerHost:   6,
		MaxConnsPerHost:       10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &Translator{
		client: &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
		},
		cache:   make(map[string]string),
		ctxRing: make([]ctxPair, 6),
	}
}

func (t *Translator) SetEngine(engine string) {
	t.engine = engine
}

func (t *Translator) SetAsyncFn(fn func(text, from, to string) (string, error)) {
	t.asyncFn = fn
}

func (t *Translator) SetOllama(url, model string) {
	t.ollamaUrl = strings.TrimRight(url, "/")
	t.ollamaModel = model
}

func (t *Translator) Engine() string {
	return t.engine
}

func (t *Translator) Translate(text, from, to string) (string, error) {
	if text == "" {
		return "", nil
	}

	cacheKey := from + "|" + to + "|" + text
	t.cacheMu.RLock()
	if cached, ok := t.cache[cacheKey]; ok {
		t.cacheMu.RUnlock()
		return cached, nil
	}
	t.cacheMu.RUnlock()

	// Engine selection: "microsoft" | "google" | "" (auto = microsoft first, then google)
	switch t.engine {
	case "microsoft":
		result, err := t.translateMicrosoft(text, from, to)
		if err == nil {
			t.cachePut(cacheKey, result)
		}
		return result, err
case "google":
		if t.asyncFn != nil {
			result, err := t.asyncFn(text, from, to)
			if err == nil {
				t.cachePut(cacheKey, result)
			}
			return result, err
		}
		result, err := t.translateGoogle(text, from, to)
		if err == nil {
			t.cachePut(cacheKey, result)
		}
		return result, err
	case "ollama":
		result, err := t.translateOllama(text, from, to)
		if err == nil {
			t.cachePut(cacheKey, result)
		}
		return result, err
	default:
		// Auto: Microsoft first, then Google fallback
		result, err := t.translateMicrosoft(text, from, to)
		if err == nil {
			t.cachePut(cacheKey, result)
			return result, nil
		}
		result, err = t.translateGoogle(text, from, to)
		if err == nil {
			t.cachePut(cacheKey, result)
		}
		return result, err
	}
}

func (t *Translator) cachePut(key, value string) {
	t.cacheMu.Lock()
	t.cache[key] = value
	t.cacheKeys = append(t.cacheKeys, key)
	if len(t.cacheKeys) > translateCacheMax {
		oldest := t.cacheKeys[0]
		t.cacheKeys = t.cacheKeys[1:]
		delete(t.cache, oldest)
	}
	t.cacheMu.Unlock()
}

// ─── Microsoft Edge Translate (free, no API key via Edge token) ─────────

func (t *Translator) getMicrosoftToken() (string, error) {
	t.msTokenMu.Lock()
	defer t.msTokenMu.Unlock()

	if t.msToken != "" && time.Since(t.msTokenAt) < 8*time.Minute {
		return t.msToken, nil
	}

	resp, err := t.client.Get("https://edge.microsoft.com/translate/auth")
	if err != nil {
		return "", fmt.Errorf("ms token request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ms token HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("ms token read: %w", err)
	}

	t.msToken = strings.TrimSpace(string(body))
	t.msTokenAt = time.Now()
	return t.msToken, nil
}

func (t *Translator) translateMicrosoft(text, from, to string) (string, error) {
	token, err := t.getMicrosoftToken()
	if err != nil {
		return "", err
	}

	msTo := mapLangMicrosoft(to)
	apiURL := fmt.Sprintf(
		"https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=&to=%s",
		url.QueryEscape(msTo),
	)

	body, _ := json.Marshal([]map[string]string{{"Text": text}})
	req, _ := http.NewRequest("POST", apiURL, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := t.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("microsoft request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("microsoft HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var results []struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}
	if err := json.Unmarshal(respBody, &results); err != nil {
		return "", fmt.Errorf("microsoft parse: %w", err)
	}
	if len(results) == 0 || len(results[0].Translations) == 0 {
		return "", fmt.Errorf("microsoft empty result")
	}
	return results[0].Translations[0].Text, nil
}

func mapLangMicrosoft(lang string) string {
	m := map[string]string{
		"zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant", "zh": "zh-Hans",
		"en": "en", "ja": "ja", "ko": "ko", "fr": "fr", "de": "de",
		"es": "es", "pt": "pt", "ru": "ru", "ar": "ar", "th": "th", "vi": "vi",
	}
	if v, ok := m[lang]; ok {
		return v
	}
	return lang
}

// ─── Google Translate ──────────────────────────────────────────────────

func (t *Translator) translateGoogle(text, from, to string) (string, error) {
	fromLang := mapLangGoogle(from)
	toLang := mapLangGoogle(to)

	apiURL := fmt.Sprintf(
		"https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=%s",
		fromLang, toLang, url.QueryEscape(text),
	)

	resp, err := t.client.Get(apiURL)
	if err != nil {
		return "", fmt.Errorf("Google 翻译不可用（需代理访问）: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("google read: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("google HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result []interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("google parse: %w", err)
	}
	if len(result) == 0 {
		return "", fmt.Errorf("google empty")
	}

	first, ok := result[0].([]interface{})
	if !ok || len(first) == 0 {
		return "", fmt.Errorf("google unexpected format")
	}
	entry, ok := first[0].([]interface{})
	if !ok || len(entry) == 0 {
		return "", fmt.Errorf("google unexpected entry")
	}
	translated, ok := entry[0].(string)
	if !ok {
		return "", fmt.Errorf("google unexpected text")
	}
	return strings.TrimSpace(translated), nil
}

func mapLangGoogle(lang string) string {
	m := map[string]string{
		"auto": "auto", "zh-Hans": "zh-CN", "zh-Hant": "zh-TW", "zh": "zh-CN",
		"en": "en", "ja": "ja", "ko": "ko", "fr": "fr", "de": "de",
		"es": "es", "pt": "pt", "ru": "ru", "ar": "ar", "th": "th", "vi": "vi",
	}
	if v, ok := m[lang]; ok {
		return v
	}
	return lang
}

// ─── Ollama (local LLM via OpenAI-compatible /v1/chat/completions) ──────

type ollamaChatRequest struct {
	Model       string              `json:"model"`
	Messages    []ollamaChatMessage `json:"messages"`
	Stream      bool                `json:"stream"`
	Temperature float64             `json:"temperature"`
}

type ollamaChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ollamaChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

func buildOllamaPrompt(to string) string {
	langNames := map[string]string{
		"zh-Hans": "简体中文", "zh-Hant": "繁體中文", "zh": "中文",
		"en": "English", "ja": "日本語", "ko": "한국어",
		"fr": "Français", "de": "Deutsch", "es": "Español",
		"pt": "Português", "ru": "Русский", "ar": "العربية",
		"th": "ไทย", "vi": "Tiếng Việt",
	}
	toName := langNames[to]
	if toName == "" {
		toName = to
	}

	fillerByLang := map[string]string{
		"zh-Hans": "呀哦哈啦", "zh-Hant": "呀哦哈啦", "zh": "呀哦哈啦",
		"ja": "あの、ええと、まあ", "ko": "음, 그, 저, 뭐",
	}
	filler := fillerByLang[to]
	if filler == "" {
		filler = "无意义语气词堆砌"
	}

	// Chinese targets get few-shot examples tuned for English→Chinese localization.
	if to == "zh-Hans" || to == "zh-Hant" || to == "zh" {
		return fmt.Sprintf(`你是视频字幕本地化专家。将英文口语翻译为地道自然的%s字幕——不是机械翻译，而是让中文观众觉得这句话本来就是用中文说的。

翻译示例（注意风格，不只是意思对，更要像中文）：
  "I'm not sure about that."   → "不太好说。"
  "What the hell is going on?" → "怎么回事？"
  "That's a great idea!"       → "好主意！"
  "To be honest, I don't think so." → "说实话，我觉得不行。"
  "Come on, you gotta be kidding me." → "别闹，开玩笑的吧。"

本地化原则：
· 英文填充词（well, you know, I mean, like, basically, actually）直接省略，不翻译
· 英文习语用中文对应表达，不要字面直译（如 kidding→开玩笑，not sure→不好说）
· 英文长句拆成短句，中文不习惯一句话塞太多信息
· 感叹和语气通过标点和措辞自然体现，不要括号注释
· 品牌名、缩写、专有名词保留原文

禁止：加前缀废话、括号注释、过度口语化（%s）、标点装饰（~~！！）。
上文是已翻译的句子，用于理解人称和语境。只翻译最后一句，一行输出。`, toName, filler)
	}

	// Generic localization prompt for all other target languages.
	return fmt.Sprintf(`你是视频字幕本地化专家。将英文口语翻译为地道自然的%s字幕——不是机械翻译，而是让%s观众觉得这就是母语者说的话。

本地化原则：
· 英文填充词（well, you know, I mean, like, basically, actually）直接省略，不翻译
· 英文习语用%s的地道对应表达，不要字面直译
· 英文长句拆成短句，%s不习惯一句话塞太多信息
· 感叹和语气通过标点和措辞自然体现，不要括号注释
· 品牌名、缩写、专有名词保留原文

禁止：加前缀废话、括号注释、过度口语化（%s）、标点装饰。
上文是已翻译的句子，用于理解人称和语境。只翻译最后一句，一行输出。`, toName, toName, toName, toName, filler)
}

func (t *Translator) translateOllama(text, from, to string) (string, error) {
	if t.ollamaUrl == "" {
		return "", fmt.Errorf("ollama URL not configured")
	}
	if t.ollamaModel == "" {
		return "", fmt.Errorf("ollama model not configured")
	}

	log.Printf("[ollama] translating %d chars with model %s → %s", len(text), t.ollamaModel, to)
	if len(text) < 80 {
		log.Printf("[ollama]   text: %q", text)
	}

	systemPrompt := buildOllamaPrompt(to)

	// Build messages with context window (last 3 pairs)
	t.ctxMu.Lock()
	var messages []ollamaChatMessage
	messages = append(messages, ollamaChatMessage{Role: "system", Content: systemPrompt})
	// Append recent context as user/assistant pairs for continuity
	pairs := t.ctxPairsLocked()
	for _, p := range pairs {
		messages = append(messages,
			ollamaChatMessage{Role: "user", Content: p.original},
			ollamaChatMessage{Role: "assistant", Content: p.translated},
		)
	}
	t.ctxMu.Unlock()
	messages = append(messages, ollamaChatMessage{Role: "user", Content: text})

	reqBody := ollamaChatRequest{
		Model:       t.ollamaModel,
		Messages:    messages,
		Stream:      false,
		Temperature: 0.1,
	}

	bodyBytes, _ := json.Marshal(reqBody)
	endpoint := t.ollamaUrl + "/v1/chat/completions"

	req, _ := http.NewRequest("POST", endpoint, strings.NewReader(string(bodyBytes)))
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("ollama request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var chatResp ollamaChatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		return "", fmt.Errorf("ollama parse: %w", err)
	}
	if len(chatResp.Choices) == 0 {
		return "", fmt.Errorf("ollama empty response")
	}

	result := strings.TrimSpace(chatResp.Choices[0].Message.Content)
	result = strings.Trim(result, "\"'")
	log.Printf("[ollama] result: %q", result)

	// Store in context ring buffer for the next translation
	t.ctxMu.Lock()
	t.ctxRing[t.ctxIdx] = ctxPair{original: text, translated: result}
	t.ctxIdx = (t.ctxIdx + 1) % len(t.ctxRing)
	if t.ctxCount < len(t.ctxRing) {
		t.ctxCount++
	}
	t.ctxMu.Unlock()

	return result, nil
}

// ctxPairsLocked returns the last N context pairs in chronological order.
// Caller must hold t.ctxMu.
func (t *Translator) ctxPairsLocked() []ctxPair {
	if t.ctxCount == 0 {
		return nil
	}
	// Ring buffer: oldest is at ctxIdx - ctxCount, newest at ctxIdx - 1
	out := make([]ctxPair, 0, 3)
	maxPairs := 3
	start := t.ctxIdx - t.ctxCount
	if start < 0 {
		start += len(t.ctxRing)
	}
	// Take only the last maxPairs
	if t.ctxCount > maxPairs {
		skip := t.ctxCount - maxPairs
		start = (start + skip) % len(t.ctxRing)
	}
	for i := 0; i < maxPairs && i < t.ctxCount; i++ {
		idx := (start + i) % len(t.ctxRing)
		pair := t.ctxRing[idx]
		if pair.original != "" {
			out = append(out, pair)
		}
	}
	return out
}

