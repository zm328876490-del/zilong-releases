package translate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Batch Translation (page translation) ──────────────────────────────

// TranslateBatch translates multiple texts for page translation.
// Returns results in the same order as input. Failed entries are empty strings.
func (t *Translator) TranslateBatch(texts []string, from, to string) ([]string, error) {
	if len(texts) == 0 {
		return nil, fmt.Errorf("empty texts")
	}

	switch t.engine {
	case "microsoft":
		return t.translateMicrosoftBatch(texts, to)
	case "google":
		return t.translateGoogleBatch(texts, from, to)
	default:
		results, err := t.translateMicrosoftBatch(texts, to)
		if err == nil {
			return results, nil
		}
		return t.translateGoogleBatch(texts, from, to)
	}
}

// TranslateBatchStream streams translations one-by-one as NDJSON lines.
// Each line: {"i":index,"t":"translation"}\n
func (t *Translator) TranslateBatchStream(w io.Writer, texts []string, from, to string) error {
	if len(texts) == 0 {
		return fmt.Errorf("empty texts")
	}
	if t.engine == "ollama" {
		return t.translateOllamaBatch(w, texts, from, to)
	}
	// Non-ollama engines: batch all at once, then write NDJSON
	results, err := t.TranslateBatch(texts, from, to)
	if err != nil {
		return err
	}
	for i, r := range results {
		if r == "" {
			continue
		}
		b, _ := json.Marshal(map[string]interface{}{"i": i, "t": r})
		w.Write(append(b, '\n'))
	}
	return nil
}

func (t *Translator) translateMicrosoftBatch(texts []string, to string) ([]string, error) {
	token, err := t.getMicrosoftToken()
	if err != nil {
		return nil, err
	}

	msTo := mapLangMicrosoft(to)
	apiURL := fmt.Sprintf(
		"https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=&to=%s",
		url.QueryEscape(msTo),
	)

	items := make([]map[string]string, len(texts))
	for i, text := range texts {
		items[i] = map[string]string{"Text": text}
	}
	bodyBytes, err := json.Marshal(items)
	if err != nil {
		return nil, err
	}

	var results []struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}

	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		req, err := http.NewRequest("POST", apiURL, strings.NewReader(string(bodyBytes)))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := t.client.Do(req)
		if err != nil {
			continue
		}
		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			if resp.StatusCode >= 500 {
				continue
			}
			return nil, fmt.Errorf("microsoft batch HTTP %d: %s", resp.StatusCode, string(respBody))
		}
		if err := json.Unmarshal(respBody, &results); err != nil {
			continue
		}
		break
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("microsoft batch: all retries exhausted")
	}

	out := make([]string, len(texts))
	for i, r := range results {
		if i < len(results) && len(r.Translations) > 0 {
			out[i] = r.Translations[0].Text
		}
	}
	return out, nil
}

var googleClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 3 * time.Second,
	},
	Timeout: 5 * time.Second,
}

func (t *Translator) translateGoogleBatch(texts []string, from, to string) ([]string, error) {
	fromLang := mapLangGoogle(from)
	toLang := mapLangGoogle(to)
	out := make([]string, len(texts))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 1)
	var failCount int32

	for i, text := range texts {
		if atomic.LoadInt32(&failCount) > int32(len(texts)/2) {
			break
		}
		wg.Add(1)
		go func(idx int, txt string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			time.Sleep(200 * time.Millisecond)

			apiURL := fmt.Sprintf(
				"https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=%s",
				fromLang, toLang, url.QueryEscape(txt),
			)

			var translated string
			for attempt := 0; attempt < 3; attempt++ {
				if attempt > 0 {
					time.Sleep(500 * time.Millisecond)
				}
				resp, err := googleClient.Get(apiURL)
				if err != nil {
					continue
				}
				body, err := io.ReadAll(resp.Body)
				resp.Body.Close()
				if err != nil {
					continue
				}
				if resp.StatusCode != http.StatusOK {
					continue
				}

				var result []interface{}
				if err := json.Unmarshal(body, &result); err != nil {
					continue
				}
				if len(result) == 0 {
					continue
				}
				first, ok := result[0].([]interface{})
				if !ok || len(first) == 0 {
					continue
				}
				entry, ok := first[0].([]interface{})
				if !ok || len(entry) == 0 {
					continue
				}
				t, ok := entry[0].(string)
				if !ok {
					continue
				}
				translated = strings.TrimSpace(t)
				break
			}
			if translated != "" {
				out[idx] = translated
			} else {
				atomic.AddInt32(&failCount, 1)
			}
		}(i, text)
	}
	wg.Wait()
	successCount := 0
	for _, v := range out {
		if v != "" {
			successCount++
		}
	}
	if failCount > 0 && successCount == 0 {
		return nil, fmt.Errorf("Google 翻译不可用（需代理访问），请切换到微软翻译引擎")
	}
	return out, nil
}

var ollamaWarmupOnce sync.Once

func warmupOllama(url, model string) {
	warmBody := ollamaChatRequest{
		Model: model,
		Messages: []ollamaChatMessage{{Role: "user", Content: "hello"}},
		Stream:      false,
		Temperature: 0,
	}
	b, _ := json.Marshal(warmBody)
	go func() {
		http.Post(url+"/v1/chat/completions", "application/json", bytes.NewReader(b))
	}()
}

func (t *Translator) translateOllamaBatch(w io.Writer, texts []string, from, to string) error {
	ollamaWarmupOnce.Do(func() { warmupOllama(t.ollamaUrl, t.ollamaModel) })

	if t.ollamaUrl == "" {
		return fmt.Errorf("ollama URL not configured")
	}
	if t.ollamaModel == "" {
		return fmt.Errorf("ollama model not configured")
	}

	toName := langNameForOllama(to)
	client := t.client

	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 2)
	var failCount int32

	for i, text := range texts {
		if atomic.LoadInt32(&failCount) > int32(len(texts)/2) {
			break
		}
		txt := strings.TrimSpace(text)
		if txt == "" {
			continue
		}
		wg.Add(1)
		go func(idx int, src string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var result string
			var err error
			for attempt := 0; attempt < 3; attempt++ {
				if attempt > 0 {
					time.Sleep(time.Second)
				}
				result, err = translateOllamaSingle(src, toName, t.ollamaUrl, t.ollamaModel, client)
				if err == nil {
					break
				}
			}
			if err != nil {
				atomic.AddInt32(&failCount, 1)
				return
			}
			mu.Lock()
			b, _ := json.Marshal(map[string]interface{}{"i": idx, "t": result})
			w.Write(append(b, '\n'))
			mu.Unlock()
		}(i, txt)
	}
	wg.Wait()

	if atomic.LoadInt32(&failCount) > 0 {
		return nil // partial results acceptable
	}
	return nil
}

func translateOllamaSingle(text, toLang, ollamaUrl, model string, client *http.Client) (string, error) {
	systemPrompt := "将以下文本翻译为" + toLang + "。只返回译文，不要解释，不要前缀。"

	reqBody := ollamaChatRequest{
		Model: model,
		Messages: []ollamaChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: text},
		},
		Stream:      false,
		Temperature: 0,
	}

	bodyBytes, _ := json.Marshal(reqBody)
	endpoint := ollamaUrl + "/v1/chat/completions"

	resp, err := client.Post(endpoint, "application/json", strings.NewReader(string(bodyBytes)))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var chatResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		return "", err
	}
	if len(chatResp.Choices) == 0 {
		return "", nil
	}
	return strings.TrimSpace(chatResp.Choices[0].Message.Content), nil
}

func langNameForOllama(lang string) string {
	m := map[string]string{
		"zh-Hans": "简体中文", "zh-Hant": "繁體中文", "zh": "中文",
		"en": "English", "ja": "日本語", "ko": "한국어",
		"fr": "Français", "de": "Deutsch", "es": "Español",
		"pt": "Português", "ru": "Русский", "th": "ไทย", "vi": "Tiếng Việt",
	}
	if v, ok := m[lang]; ok {
		return v
	}
	return lang
}

