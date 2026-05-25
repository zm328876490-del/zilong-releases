package translate

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
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
	case "ollama":
		return t.translateOllamaBatch(texts, from, to)
	default:
		results, err := t.translateMicrosoftBatch(texts, to)
		if err == nil {
			return results, nil
		}
		return t.translateGoogleBatch(texts, from, to)
	}
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
	body, err := json.Marshal(items)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", apiURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := t.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("microsoft batch request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("microsoft batch HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var results []struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}
	if err := json.Unmarshal(respBody, &results); err != nil {
		return nil, fmt.Errorf("microsoft batch parse: %w", err)
	}

	out := make([]string, len(texts))
	for i, r := range results {
		if i < len(results) && len(r.Translations) > 0 {
			out[i] = r.Translations[0].Text
		}
	}
	return out, nil
}

func (t *Translator) translateGoogleBatch(texts []string, from, to string) ([]string, error) {
	fromLang := mapLangGoogle(from)
	toLang := mapLangGoogle(to)
	out := make([]string, len(texts))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)

	for i, text := range texts {
		wg.Add(1)
		go func(idx int, txt string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			apiURL := fmt.Sprintf(
				"https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=%s",
				fromLang, toLang, url.QueryEscape(txt),
			)
			resp, err := t.client.Get(apiURL)
			if err != nil {
				return
			}
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return
			}
			if resp.StatusCode != http.StatusOK {
				return
			}

			var result []interface{}
			if err := json.Unmarshal(body, &result); err != nil {
				return
			}
			if len(result) == 0 {
				return
			}
			first, ok := result[0].([]interface{})
			if !ok || len(first) == 0 {
				return
			}
			entry, ok := first[0].([]interface{})
			if !ok || len(entry) == 0 {
				return
			}
			translated, ok := entry[0].(string)
			if !ok {
				return
			}
			out[idx] = strings.TrimSpace(translated)
		}(i, text)
	}
	wg.Wait()
	return out, nil
}

func (t *Translator) translateOllamaBatch(texts []string, from, to string) ([]string, error) {
	if t.ollamaUrl == "" {
		return nil, fmt.Errorf("ollama URL not configured")
	}
	if t.ollamaModel == "" {
		return nil, fmt.Errorf("ollama model not configured")
	}

	prompt := buildOllamaBatchPrompt(texts, from, to)

	reqBody := ollamaChatRequest{
		Model: t.ollamaModel,
		Messages: []ollamaChatMessage{
			{Role: "system", Content: prompt},
			{Role: "user", Content: "请翻译。"},
		},
		Stream:      false,
		Temperature: 0.1,
	}

	bodyBytes, _ := json.Marshal(reqBody)
	endpoint := t.ollamaUrl + "/v1/chat/completions"

	resp, err := t.client.Post(endpoint, "application/json", strings.NewReader(string(bodyBytes)))
	if err != nil {
		return nil, fmt.Errorf("ollama batch request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama batch HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var chatResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		return nil, fmt.Errorf("ollama batch parse: %w", err)
	}
	if len(chatResp.Choices) == 0 {
		return nil, fmt.Errorf("ollama batch empty response")
	}

	raw := strings.TrimSpace(chatResp.Choices[0].Message.Content)
	// Extract JSON array from response (model may wrap in ```json ... ```)
	if i := strings.Index(raw, "["); i >= 0 {
		raw = raw[i:]
		if j := strings.LastIndex(raw, "]"); j >= 0 {
			raw = raw[:j+1]
		}
	}

	type batchItem struct {
		ID          int    `json:"id"`
		Translation string `json:"translation"`
	}
	var items []batchItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil, fmt.Errorf("ollama batch json parse: %w\nraw: %s", err, raw)
	}

	out := make([]string, len(texts))
	for _, item := range items {
		if item.ID >= 0 && item.ID < len(out) {
			out[item.ID] = strings.TrimSpace(item.Translation)
		}
	}
	return out, nil
}

func buildOllamaBatchPrompt(texts []string, from, to string) string {
	langNames := map[string]string{
		"zh-Hans": "简体中文", "zh-Hant": "繁體中文", "zh": "中文",
		"en": "English", "ja": "日本語", "ko": "한국어",
		"fr": "Français", "de": "Deutsch", "es": "Español",
		"pt": "Português", "ru": "Русский", "th": "ไทย", "vi": "Tiếng Việt",
	}
	toName := langNames[to]
	if toName == "" {
		toName = to
	}
	fromName := langNames[from]
	if fromName == "" {
		fromName = "源语言"
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("你是网页 UI 文本翻译引擎。将以下%s文本准确翻译为%s。\n\n", fromName, toName))
	sb.WriteString("规则：\n")
	sb.WriteString("- 只翻译文本内容，保留占位符（%s, %d, {0}, {{name}} 等）不变\n")
	sb.WriteString("- 保留 HTML 实体（&amp;, &lt;, &quot; 等）不变\n")
	sb.WriteString("- 简短 UI 文本（按钮、标签）用简洁对应词\n")
	sb.WriteString("- 返回 JSON 数组，格式：")

	// Concrete JSON example matching the target language
	sb.WriteString(fmt.Sprintf(`[{"id":0,"translation":"%s"},{"id":1,"translation":"%s"}]`, exampleTranslation(to, 0), exampleTranslation(to, 1)))
	sb.WriteString("\n- 只返回 JSON，不要任何解释\n\n")
	sb.WriteString("待翻译文本：\n")

	for i, text := range texts {
		sb.WriteString(fmt.Sprintf("[%d] %s\n", i, text))
	}

	return sb.String()
}

func exampleTranslation(to string, idx int) string {
	examples := map[string][2]string{
		"zh-Hans": {"你好世界", "点击这里"},
		"zh-Hant": {"你好世界", "點擊這裡"},
		"zh":      {"你好世界", "点击这里"},
		"en":      {"Hello World", "Click here"},
		"ja":      {"こんにちは世界", "ここをクリック"},
		"ko":      {"안녕하세요 세계", "여기를 클릭"},
		"fr":      {"Bonjour le monde", "Cliquez ici"},
		"de":      {"Hallo Welt", "Hier klicken"},
		"es":      {"Hola mundo", "Haga clic aquí"},
		"pt":      {"Olá mundo", "Clique aqui"},
		"ru":      {"Привет мир", "Нажмите здесь"},
		"th":      {"สวัสดีชาวโลก", "คลิกที่นี่"},
		"vi":      {"Chào thế giới", "Nhấp vào đây"},
	}
	if e, ok := examples[to]; ok {
		return e[idx]
	}
	return examples["zh-Hans"][idx]
}
