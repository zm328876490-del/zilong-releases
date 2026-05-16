package translate

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Translator supports multiple backends. Priority: Microsoft (free Edge token) → Baidu → Google.
type Translator struct {
	msToken    string
	msTokenAt  time.Time
	msTokenMu  sync.Mutex
	baiduAppID  string
	baiduSecret string
	client      *http.Client
	cache       map[string]string
	cacheKeys   []string
	cacheMu     sync.RWMutex
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
		cache: make(map[string]string),
	}
}

func (t *Translator) SetBaiduCredentials(appID, secret string) {
	t.baiduAppID = appID
	t.baiduSecret = secret
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

	// Priority: Microsoft Edge (free) → Baidu (China) → Google
	result, err := t.translateMicrosoft(text, from, to)
	if err == nil {
		t.cachePut(cacheKey, result)
		return result, nil
	}

	if t.baiduAppID != "" {
		result, err := t.translateBaidu(text, from, to)
		if err == nil {
			t.cachePut(cacheKey, result)
			return result, nil
		}
	}

	result, err = t.translateGoogle(text, from, to)
	if err == nil {
		t.cachePut(cacheKey, result)
	}
	return result, err
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

// ─── Baidu Translate ────────────────────────────────────────────────────

func (t *Translator) translateBaidu(text, from, to string) (string, error) {
	if from == "auto" {
		from = "auto"
	}
	baiduTo := strings.Replace(to, "zh-Hans", "zh", 1)
	baiduTo = strings.Replace(baiduTo, "zh-Hant", "cht", 1)

	salt := strconv.Itoa(rand.Intn(1000000000))
	signStr := t.baiduAppID + text + salt + t.baiduSecret
	sign := md5Hex(signStr)

	apiURL := fmt.Sprintf(
		"https://fanyi-api.baidu.com/api/trans/vip/translate?q=%s&from=%s&to=%s&appid=%s&salt=%s&sign=%s",
		url.QueryEscape(text), from, baiduTo, t.baiduAppID, salt, sign,
	)

	resp, err := t.client.Get(apiURL)
	if err != nil {
		return "", fmt.Errorf("baidu request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result struct {
		ErrorCode string `json:"error_code"`
		ErrorMsg  string `json:"error_msg"`
		Trans     []struct {
			Src string `json:"src"`
			Dst string `json:"dst"`
		} `json:"trans_result"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("baidu parse: %w", err)
	}

	if result.ErrorCode != "" && result.ErrorCode != "0" {
		return "", fmt.Errorf("baidu error %s: %s", result.ErrorCode, result.ErrorMsg)
	}

	if len(result.Trans) == 0 {
		return "", fmt.Errorf("baidu returned empty translation")
	}

	return strings.TrimSpace(result.Trans[0].Dst), nil
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
		return "", fmt.Errorf("google request: %w", err)
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

func md5Hex(s string) string {
	h := md5.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}
