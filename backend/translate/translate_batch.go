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
	case "openai":
		return t.translateOpenAIBatchResults(texts, from, to)
	case "deepl":
		return t.translateDeepLBatch(texts, from, to)
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
	if t.engine == "openai" {
		return t.translateOpenAIBatch(w, texts, from, to)
	}
	// Non-llm engines: batch all at once, then write NDJSON
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
	warmBody := ollamaGenerateRequest{
		Model:   model,
		Prompt:  "hello",
		Stream:  false,
		Options: map[string]interface{}{"temperature": 0, "num_predict": 10},
	}
	b, _ := json.Marshal(warmBody)
	go func() {
		http.Post(url+"/api/generate", "application/json", bytes.NewReader(b))
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

	toName := ollamaLangName(to)
	toNative := ollamaNativeName(to)

	// Separate empty texts — they'll get empty results
	indexMap := make([]int, 0, len(texts)) // original index for each non-empty text
	payload := make([]string, 0, len(texts))
	for i, text := range texts {
		txt := strings.TrimSpace(text)
		if txt == "" {
			continue
		}
		indexMap = append(indexMap, i)
		payload = append(payload, txt)
	}
	if len(payload) == 0 {
		return nil
	}

	payloadJSON, _ := json.Marshal(payload)
	systemPrompt := "You are a professional web page translator. Translate each text in the JSON array below into " + toNative + " (" + toName + ").\n" +
		"\n" +
		"Rules:\n" +
		"· Proper nouns, brand names, trademarks, personal names: keep in original language\n" +
		"· URLs, email addresses, code, technical identifiers, version numbers: DO NOT translate\n" +
		"· Currency symbols and amounts: preserve formatting\n" +
		"· Short country/language codes in isolation (au, de, fr, nl, es, se, etc.): expand to full name in " + toNative + "\n" +
		"· UI labels and buttons: translate naturally, keep concise\n" +
		"· Numbers and dates: use " + toNative + " conventions when appropriate\n" +
		"· Do NOT include any reasoning, thinking, or analysis in your response\n" +
		"\n" +
		"Return ONLY a JSON string array of the same length and order. No markdown fences, no extra text."

	reqBody := ollamaGenerateRequest{
		Model:   t.ollamaModel,
		System:  systemPrompt,
		Prompt:  string(payloadJSON),
		Stream:  false,
		Options: map[string]interface{}{"temperature": 0, "num_predict": 2048, "enable_thinking": false},
	}

	var results []string
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Second)
		}
		bodyBytes, _ := json.Marshal(reqBody)
		resp, err := t.client.Post(
			t.ollamaUrl+"/api/generate",
			"application/json",
			strings.NewReader(string(bodyBytes)),
		)
		if err != nil {
			continue
		}
		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			continue
		}

		var genResp ollamaGenerateResponse
		if err := json.Unmarshal(respBody, &genResp); err != nil {
			continue
		}

		content := strings.TrimSpace(genResp.Response)
		content = stripThinking(content)
		// Strip markdown code fences if model wraps output
		content = strings.TrimPrefix(content, "```json")
		content = strings.TrimPrefix(content, "```")
		content = strings.TrimSuffix(content, "```")
		content = strings.TrimSpace(content)

		if err := json.Unmarshal([]byte(content), &results); err != nil {
			start := strings.Index(content, "[")
			end := strings.LastIndex(content, "]")
			if start >= 0 && end > start {
				if err2 := json.Unmarshal([]byte(content[start:end+1]), &results); err2 != nil {
					continue
				}
			} else {
				continue
			}
		}
		if len(results) > 0 {
			break
		}
	}

	// Map results back to original indices
	out := make([]string, len(texts))
	for ri, translated := range results {
		if ri < len(indexMap) {
			out[indexMap[ri]] = translated
		}
	}

	// Write NDJSON output
	for i, r := range out {
		if r == "" {
			continue
		}
		b, _ := json.Marshal(map[string]interface{}{"i": i, "t": r})
		w.Write(append(b, '\n'))
	}
	return nil
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

// ─── OpenAI-compatible batch ──────────────────────────────────────────────

var openaiWarmupOnce sync.Once

func warmupOpenAI(url, key, model string) {
	warmBody := ollamaChatRequest{
		Model:       model,
		Messages:    []ollamaChatMessage{{Role: "user", Content: "hello"}},
		Stream:      false,
		Temperature: 0,
	}
	b, _ := json.Marshal(warmBody)
	req, _ := http.NewRequest("POST", url+"/v1/chat/completions", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	go func() {
		http.DefaultClient.Do(req)
	}()
}

func (t *Translator) translateOpenAIBatch(w io.Writer, texts []string, from, to string) error {
	openaiWarmupOnce.Do(func() { warmupOpenAI(t.openaiUrl, t.openaiKey, t.openaiModel) })

	if t.openaiUrl == "" {
		return fmt.Errorf("OpenAI URL not configured")
	}
	if t.openaiKey == "" {
		return fmt.Errorf("OpenAI API key not configured")
	}
	if t.openaiModel == "" {
		return fmt.Errorf("OpenAI model not configured")
	}

	toNative := langNameForOllama(to)
	toEng := ollamaLangName(to)

	indexMap := make([]int, 0, len(texts))
	payload := make([]string, 0, len(texts))
	for i, text := range texts {
		txt := strings.TrimSpace(text)
		if txt == "" {
			continue
		}
		indexMap = append(indexMap, i)
		payload = append(payload, txt)
	}
	if len(payload) == 0 {
		return nil
	}

	payloadJSON, _ := json.Marshal(payload)
	systemPrompt := fmt.Sprintf(
		"You are a professional web page translator. Translate each text in the JSON array below into %s (%s).\n\n"+
			"Rules:\n"+
			"· Proper nouns, brand names, trademarks, personal names: keep in original language\n"+
			"· URLs, email addresses, code, technical identifiers, version numbers: DO NOT translate\n"+
			"· Currency symbols and amounts: preserve formatting\n"+
			"· Short country/language codes in isolation (au, de, fr, nl, es, se, etc.): expand to full name in %s\n"+
			"· UI labels and buttons: translate naturally, keep concise\n"+
			"· Numbers and dates: use %s conventions when appropriate\n"+
			"· Do NOT add explanations, notes, or commentary to translations\n\n"+
			"Return ONLY a JSON string array of the same length and order. No markdown fences, no extra text.",
		toNative, toEng, toNative, toNative,
	)

	reqBody := ollamaChatRequest{
		Model: t.openaiModel,
		Messages: []ollamaChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: string(payloadJSON)},
		},
		Stream:      false,
		Temperature: 0,
	}

	var results []string
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Second)
		}
		bodyBytes, _ := json.Marshal(reqBody)
		req, _ := http.NewRequest("POST", t.openaiUrl+"/v1/chat/completions", strings.NewReader(string(bodyBytes)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+t.openaiKey)

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
			continue
		}

		var chatResp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(respBody, &chatResp); err != nil || len(chatResp.Choices) == 0 {
			continue
		}

		content := strings.TrimSpace(chatResp.Choices[0].Message.Content)
		content = strings.TrimPrefix(content, "```json")
		content = strings.TrimPrefix(content, "```")
		content = strings.TrimSuffix(content, "```")
		content = strings.TrimSpace(content)

		if err := json.Unmarshal([]byte(content), &results); err != nil {
			start := strings.Index(content, "[")
			end := strings.LastIndex(content, "]")
			if start >= 0 && end > start {
				if err2 := json.Unmarshal([]byte(content[start:end+1]), &results); err2 != nil {
					continue
				}
			} else {
				continue
			}
		}
		if len(results) > 0 {
			break
		}
	}

	out := make([]string, len(texts))
	for ri, translated := range results {
		if ri < len(indexMap) {
			out[indexMap[ri]] = translated
		}
	}

	for i, r := range out {
		if r == "" {
			continue
		}
		b, _ := json.Marshal(map[string]interface{}{"i": i, "t": r})
		w.Write(append(b, '\n'))
	}
	return nil
}

// translateOpenAIBatchResults translates a batch and returns a slice (for HTTP endpoint).
func (t *Translator) translateOpenAIBatchResults(texts []string, from, to string) ([]string, error) {
	if t.openaiUrl == "" {
		return nil, fmt.Errorf("OpenAI URL not configured")
	}
	if t.openaiKey == "" {
		return nil, fmt.Errorf("OpenAI API key not configured")
	}
	if t.openaiModel == "" {
		return nil, fmt.Errorf("OpenAI model not configured")
	}

	toNative := langNameForOllama(to)
	toEng := ollamaLangName(to)

	indexMap := make([]int, 0, len(texts))
	payload := make([]string, 0, len(texts))
	for i, text := range texts {
		txt := strings.TrimSpace(text)
		if txt == "" {
			continue
		}
		indexMap = append(indexMap, i)
		payload = append(payload, txt)
	}
	if len(payload) == 0 {
		return make([]string, len(texts)), nil
	}

	payloadJSON, _ := json.Marshal(payload)
	systemPrompt := fmt.Sprintf(
		"You are a professional web page translator. Translate each text in the JSON array below into %s (%s).\n\n"+
			"Rules:\n"+
			"· Proper nouns, brand names, trademarks, personal names: keep in original language\n"+
			"· URLs, email addresses, code, technical identifiers, version numbers: DO NOT translate\n"+
			"· Currency symbols and amounts: preserve formatting\n"+
			"· Short country/language codes in isolation (au, de, fr, nl, es, se, etc.): expand to full name in %s\n"+
			"· UI labels and buttons: translate naturally, keep concise\n"+
			"· Numbers and dates: use %s conventions when appropriate\n"+
			"· Do NOT add explanations, notes, or commentary to translations\n\n"+
			"Return ONLY a JSON string array of the same length and order. No markdown fences, no extra text.",
		toNative, toEng, toNative, toNative,
	)

	reqBody := ollamaChatRequest{
		Model: t.openaiModel,
		Messages: []ollamaChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: string(payloadJSON)},
		},
		Stream:      false,
		Temperature: 0,
	}

	var results []string
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Second)
		}
		bodyBytes, _ := json.Marshal(reqBody)
		req, _ := http.NewRequest("POST", t.openaiUrl+"/v1/chat/completions", strings.NewReader(string(bodyBytes)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+t.openaiKey)

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
			continue
		}

		var chatResp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(respBody, &chatResp); err != nil || len(chatResp.Choices) == 0 {
			continue
		}

		content := strings.TrimSpace(chatResp.Choices[0].Message.Content)
		content = strings.TrimPrefix(content, "```json")
		content = strings.TrimPrefix(content, "```")
		content = strings.TrimSuffix(content, "```")
		content = strings.TrimSpace(content)

		if err := json.Unmarshal([]byte(content), &results); err != nil {
			start := strings.Index(content, "[")
			end := strings.LastIndex(content, "]")
			if start >= 0 && end > start {
				if err2 := json.Unmarshal([]byte(content[start:end+1]), &results); err2 != nil {
					continue
				}
			} else {
				continue
			}
		}
		if len(results) > 0 {
			break
		}
	}

	out := make([]string, len(texts))
	for ri, translated := range results {
		if ri < len(indexMap) {
			out[indexMap[ri]] = translated
		}
	}
	return out, nil
}

// ─── DeepL batch ──────────────────────────────────────────────────────────

func (t *Translator) translateDeepLBatch(texts []string, from, to string) ([]string, error) {
	if t.deeplKey == "" {
		return nil, fmt.Errorf("DeepL API key not configured")
	}

	toLang := mapLangDeepL(to)
	form := url.Values{}
	for _, text := range texts {
		form.Add("text", text)
	}
	form.Set("target_lang", toLang)
	if from != "" && from != "auto" {
		form.Set("source_lang", mapLangDeepL(from))
	}

	endpoint := t.deeplUrl + "/v2/translate"
	var result struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}

	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		req, _ := http.NewRequest("POST", endpoint, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Authorization", "DeepL-Auth-Key "+t.deeplKey)

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
			return nil, fmt.Errorf("deepl batch HTTP %d: %s", resp.StatusCode, string(respBody))
		}
		if err := json.Unmarshal(respBody, &result); err != nil {
			continue
		}
		break
	}

	out := make([]string, len(texts))
	for i, r := range result.Translations {
		if i < len(texts) {
			out[i] = strings.TrimSpace(r.Text)
		}
	}
	return out, nil
}

