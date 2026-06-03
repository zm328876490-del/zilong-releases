// background.js - Service Worker
// Handles messages from popup, relays between content scripts.

const DEFAULT_WS_URL = 'ws://localhost:29527/ws';

// Store active translation sessions per tab
const sessions = {};

// Active Ollama model downloads (runs in SW, survives popup close)
const _downloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    // ─── Popup / content script messages ────────────────────────────
    case 'getStatus':
      sendResponse({ status: sessions[tabId]?.status || 'idle' });
      break;

    case 'started':
      sessions[tabId] = { status: 'listening' };
      break;

    case 'stopped':
      if (sessions[tabId]) {
        sessions[tabId].status = 'stopped';
      }
      break;

    case 'statusUpdate':
      if (sessions[tabId]) {
        sessions[tabId].status = message.status;
      }
      break;

    // ─── Google translate: call from browser (uses system proxy) ─────
    case 'PAGE_GOOGLE_TRANSLATE':
      handlePageGoogleTranslate(message, sendResponse);
      return true; // async response

    // ─── Page translation: proxy fetch through SW to bypass page CSP ──
    case 'PAGE_FETCH_TRANSLATION':
      handlePageTranslateFetch(message, sendResponse);
      return true; // async response

    // ─── Ollama direct: single-prompt batch, bypasses Go backend ───────
    case 'PAGE_OLLAMA_TRANSLATE':
      handlePageOllamaTranslate(message, sendResponse);
      return true; // async response

    // ─── Ollama single-text translate (page translation, one by one) ──────
    case 'PAGE_OLLAMA_TRANSLATE_ONE':
      handlePageOllamaTranslateOne(message, sendResponse);
      return true;

    // ─── Ollama concurrent batch: all texts in one message, internal POOL ───
    case 'PAGE_OLLAMA_TRANSLATE_CONCURRENT':
      handlePageOllamaTranslateConcurrent(message, sendResponse);
      return true;

    // ─── Ollama model management (pull in SW, poll progress from popup) ──
    case 'OLLAMA_PULL_START':
      handleOllamaPullStart(message, sendResponse);
      return true;
    case 'OLLAMA_PULL_PROGRESS':
      sendResponse({ downloads: Object.fromEntries(_downloads) });
      break;
    case 'OLLAMA_DELETE':
      handleOllamaDelete(message, sendResponse);
      return true;

    case 'openAppPage':
      openExtensionPage(message.hash || '');
      break;

  }
});

// ─── Image Translation (right-click context menu) ──────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translateImage',
    title: '翻译图片文字',
    contexts: ['image'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translateImage') {
    handleImageTranslate(info.srcUrl, tab.id);
  }
});

async function handleImageTranslate(srcUrl, tabId) {
  try {
    notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '图片翻译中...' });

    const result = await chrome.storage.local.get('translationSettings');
    const settings = result.translationSettings || {};

    // Get base64 image data
    var base64;
    if (srcUrl.startsWith('blob:')) {
      base64 = await captureBlobInTab(tabId, srcUrl);
    } else if (srcUrl.startsWith('data:')) {
      var commaIdx = srcUrl.indexOf(',');
      base64 = commaIdx >= 0 ? srcUrl.substring(commaIdx + 1) : srcUrl;
    } else {
      var resp = await fetch(srcUrl);
      if (!resp.ok) { notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '图片下载失败' }); return; }
      var blob = await resp.blob();
      base64 = await blobToBase64(blob);
    }

    if (!base64) { notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '无法获取图片数据' }); return; }

    // Call Go backend OCR pipeline (OCR → translate → draw)
    notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: 'OCR 识别 + 翻译中...' });
    var apiResp = await fetch('http://localhost:29527/api/image-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64,
        targetLang: settings.targetLang || 'zh-Hans',
        engine: (function(e) { return (e === 'deepseek' || e === 'doubao' || e === 'qwen') ? 'openai' : e; })(settings.engine || 'microsoft'),
        ollamaUrl: (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, ''),
        ollamaModel: settings.ollamaModel || '',
        openaiUrl: (settings.openaiUrl || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
        openaiKey: settings.openaiKey || '',
        openaiModel: settings.openaiModel || 'deepseek-chat',
        deeplKey: settings.deeplKey || '',
      }),
    });

    if (!apiResp.ok) {
      var errText = ''; try { errText = await apiResp.text(); } catch (_) {}
      if (apiResp.status === 402) {
        notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: 'LICENSE_REQUIRED' });
      } else {
        notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '图片翻译失败: HTTP ' + apiResp.status + (errText ? ' ' + errText.slice(0, 100) : '') });
      }
      return;
    }

    var data = await apiResp.json();
    if (data.error) { notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '图片翻译失败: ' + data.error }); return; }

    notifyContent(tabId, {
      type: 'SHOW_IMAGE_RESULT',
      src: srcUrl,
      image: data.image || '',
      items: data.items || [],
    });
  } catch (e) {
    notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '图片翻译失败: ' + (e.message || '未知错误') });
  }
}

function notifyContent(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function openExtensionPage(hash) {
  var url = chrome.runtime.getURL('app.html' + (hash ? '#' + hash : ''));
  chrome.tabs.query({ url: chrome.runtime.getURL('app.html*') }, function (tabs) {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true, url: url });
    } else {
      chrome.tabs.create({ url: url });
    }
  });
}

function blobToBase64(blob) {
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onloadend = function () {
      var dataUrl = reader.result;
      if (typeof dataUrl === 'string') {
        var idx = dataUrl.indexOf(',');
        resolve(idx >= 0 ? dataUrl.substring(idx + 1) : null);
      } else { resolve(null); }
    };
    reader.onerror = function () { resolve(null); };
    reader.readAsDataURL(blob);
  });
}

async function captureBlobInTab(tabId, srcUrl) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_BLOB_IMAGE', srcUrl: srcUrl }, function (resp) {
      resolve(resp ? resp.base64 || null : null);
    });
    setTimeout(function () { resolve(null); }, 5000);
  });
}

// ─── Keepalive ────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'translation-keepalive') {
    port.onDisconnect.addListener(() => {
      // Client disconnected, no action needed
    });
    port.onMessage.addListener((msg) => {
      // Heartbeat pings — just acknowledge connection is alive
    });
  }
});

// ─── Page translation fetch proxy ───────────────────────────────────────

async function handlePageTranslateFetch(message, sendResponse) {
  try {
    const resp = await fetch(message.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.body),
    });
    if (!resp.ok) {
      sendResponse({ ok: false, status: resp.status, results: null });
      return;
    }
    const data = await resp.json();
    sendResponse({ ok: true, status: resp.status, results: data.results || null });
  } catch (e) {
    sendResponse({ ok: false, status: 0, results: null, error: e.message });
  }
}

// ─── Ollama direct batch: single prompt with JSON array → single inference ──

function ollamaLangName(lang) {
  const m = { 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', 'zh': 'Chinese',
    'en': 'English', 'ja': 'Japanese', 'ko': 'Korean',
    'fr': 'French', 'de': 'German', 'es': 'Spanish',
    'pt': 'Portuguese', 'ru': 'Russian', 'th': 'Thai', 'vi': 'Vietnamese' };
  return m[lang] || lang;
}

// Strip <think>, <Thinking>, <response> blocks that thinking models (qwen3, deepseek-r1)
// may emit via /api/generate. Also drops preamble lines like "Okay, let me..."
function stripThinkingTags(raw) {
  let s = raw;
  // Remove XML-style thinking blocks (handles unclosed tags too)
  const tags = ['think', 'Thinking', 'THINK', 'response'];
  for (const tag of tags) {
    const open = '<' + tag + '>';
    const close = '</' + tag + '>';
    while (s.includes(open)) {
      const start = s.indexOf(open);
      const end = s.indexOf(close, start + open.length);
      if (end < 0) {
        s = s.substring(0, start);
        break;
      }
      s = s.substring(0, start) + s.substring(end + close.length);
    }
  }
  // Remove preamble lines
  const lines = s.split('\n');
  const clean = [];
  const preambles = ['okay', 'first', 'let me', 'i need', 'i\'ll', 'here', 'the translation', 'sure', 'certainly', 'of course'];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    let skip = false;
    for (const p of preambles) {
      if (lower.startsWith(p)) { skip = true; break; }
    }
    if (!skip) clean.push(trimmed);
  }
  if (clean.length > 0) return clean.join('\n');
  // Fallback: last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim();
  }
  return s;
}

async function handlePageOllamaTranslate(message, sendResponse) {
  try {
    const texts = message.texts || [];
    if (texts.length === 0) { sendResponse({ ok: true, results: [] }); return; }

    const url = (message.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    let model = message.ollamaModel || '';
    if (!model) { model = await getDefaultModel(url); }
    if (!model) { sendResponse({ ok: false, results: null }); return; }

    const toName = ollamaLangName(message.to || 'zh-Hans');
    const langNative = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'zh': '中文',
      'en': 'English', 'ja': '日本語', 'ko': '한국어',
      'fr': 'Français', 'de': 'Deutsch', 'es': 'Español',
      'pt': 'Português', 'ru': 'Русский', 'th': 'ไทย', 'vi': 'Tiếng Việt' };
    const toNative = langNative[message.to] || toName;
    const payload = [];
    const payloadTexts = [];
    for (let i = 0; i < texts.length; i++) {
      const t = (texts[i] || '').trim();
      if (t) { payload.push({ text: t, idx: i }); payloadTexts.push(t); }
    }
    const payloadJSON = JSON.stringify(payloadTexts);

    const systemPrompt =
      'You are a professional web page translator. Translate each text in the JSON array below into ' + toNative + ' (' + toName + ').\n' +
      '\n' +
      'Rules:\n' +
      '· Proper nouns, brand names, trademarks, personal names: keep in original language\n' +
      '· URLs, email addresses, code, technical identifiers, version numbers: DO NOT translate\n' +
      '· Currency symbols and amounts: preserve formatting (e.g. "S$ 19.90" stays "S$ 19.90")\n' +
      '· Short country/language codes in isolation (au, de, fr, nl, es, se, etc.): expand to full name in ' + toNative + '\n' +
      '· UI labels and buttons: translate naturally, keep concise\n' +
      '· Numbers and dates: use ' + toNative + ' conventions when appropriate\n' +
      '· Do NOT include any reasoning, thinking, or analysis in your response\n' +
      '\n' +
      'Return ONLY a JSON string array of the same length and order. No markdown fences, no extra text.';

    const resp = await fetch(url + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        system: systemPrompt,
        prompt: payloadJSON,
        stream: false,
        options: { temperature: 0, num_predict: 2048, enable_thinking: false },
      }),
    });

    if (!resp.ok) {
      sendResponse({ ok: false, status: resp.status, results: null });
      return;
    }

    const data = await resp.json();
    let content = (data.response || '[]').trim();
    content = stripThinkingTags(content);

    // Parse JSON array from model response (strip markdown fences if present)
    let raw = content.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    let translated = [];
    try { translated = JSON.parse(raw); } catch (_) {
      // Try to extract JSON array with bracket matching
      const start = raw.indexOf('['), end = raw.lastIndexOf(']');
      if (start >= 0 && end > start) {
        try { translated = JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
      }
    }

    const results = new Array(texts.length).fill('');
    for (let i = 0; i < Math.min(payload.length, translated.length); i++) {
      results[payload[i].idx] = translated[i] || '';
    }

    sendResponse({ ok: true, results: results });
  } catch (e) {
    sendResponse({ ok: false, status: 0, results: null, error: e.message });
  }
}

// ─── Cached default model (fetched from Go backend on first use) ──────────
let _cachedDefaultModel = null;
let _cachedDefaultModelAt = 0;

async function getDefaultModel(ollamaUrl) {
  // Return cached value if fresh (within 5 minutes)
  if (_cachedDefaultModel && (Date.now() - _cachedDefaultModelAt) < 300000) {
    return _cachedDefaultModel;
  }
  const baseUrl = (ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const resp = await fetch(baseUrl + '/v1/models', { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      const models = data.data || [];
      if (models.length > 0) {
        _cachedDefaultModel = (models[0].id || '').replace(/\.gguf$/i, '');
        _cachedDefaultModelAt = Date.now();
        return _cachedDefaultModel;
      }
    }
  } catch (_) {}
  return '';
}

// ─── Ollama single-text translate (page translation, one-by-one) ──────────
async function handlePageOllamaTranslateOne(message, sendResponse) {
  try {
    const text = (message.text || '').trim();
    if (!text) { sendResponse({ ok: true, translation: '' }); return; }

    const url = (message.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    let model = message.ollamaModel || '';
    if (!model) {
      model = await getDefaultModel(url);
    }
    if (!model) {
      console.error('[ollama-translate] no model available (ollamaModel=%s, getDefaultModel returned empty)', message.ollamaModel);
      sendResponse({ ok: false, translation: '' });
      return;
    }
    const toName = ollamaLangName(message.to || 'zh-Hans');
    const langNative = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'zh': '中文',
      'en': 'English', 'ja': '日本語', 'ko': '한국어',
      'fr': 'Français', 'de': 'Deutsch', 'es': 'Español',
      'pt': 'Português', 'ru': 'Русский', 'th': 'ไทย', 'vi': 'Tiếng Việt' };
    const toNative = langNative[message.to] || toName;

    const systemPrompt =
      'You are a professional web page translator. Translate the user input into ' + toNative + ' (' + toName + ').\n' +
      'Proper nouns, brands, URLs, code, currency amounts, version numbers: keep in original form.\n' +
      'Short isolated codes (au, de, fr, nl, etc.): expand to full name in ' + toNative + '.\n' +
      'UI labels and buttons: translate naturally, keep concise.\n' +
      'Output only the translation, one line, no explanation, no quotes.';

    const apiUrl = url + '/api/generate';
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        system: systemPrompt,
        prompt: text,
        stream: false,
        options: { temperature: 0.1, num_predict: 1024 },
      }),
    });

    if (!resp.ok) {
      console.error('[ollama-translate] API error: %s %s', resp.status, resp.statusText);
      try { console.error('[ollama-translate] body:', await resp.text()); } catch (_) {}
      sendResponse({ ok: false, translation: '' });
      return;
    }

    const data = await resp.json();
    const rawResponse = (data.response || '').trim();
    const translation = stripThinkingTags(rawResponse);
    if (!translation || translation.toLowerCase() === text.toLowerCase()) {
      console.warn('[ollama-translate] model returned identity (untranslated), treating as failure');
      sendResponse({ ok: false, translation: '', reqId: message.reqId });
      return;
    }
    sendResponse({ ok: true, translation: translation, reqId: message.reqId });
  } catch (e) {
    console.error('[ollama-translate] exception:', e.message || e);
    sendResponse({ ok: false, translation: '' });
  }
}

// ─── Ollama concurrent batch: all texts in one message, internal POOL ──────
async function handlePageOllamaTranslateConcurrent(message, sendResponse) {
  try {
    const texts = message.texts || [];
    if (texts.length === 0) { sendResponse({ ok: true, results: [] }); return; }

    const url = (message.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    let model = message.ollamaModel || '';
    if (!model) { model = await getDefaultModel(url); }
    if (!model) { sendResponse({ ok: false, results: null }); return; }

    const toName = ollamaLangName(message.to || 'zh-Hans');
    const langNative = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'zh': '中文',
      'en': 'English', 'ja': '日本語', 'ko': '한국어',
      'fr': 'Français', 'de': 'Deutsch', 'es': 'Español',
      'pt': 'Português', 'ru': 'Русский', 'th': 'ไทย', 'vi': 'Tiếng Việt' };
    const toNative = langNative[message.to] || toName;

    const systemPrompt =
      'You are a professional web page translator. Translate the user input into ' + toNative + ' (' + toName + ').\n' +
      'Proper nouns, brands, URLs, code, currency amounts, version numbers: keep in original form.\n' +
      'Short isolated codes (au, de, fr, nl, etc.): expand to full name in ' + toNative + '.\n' +
      'UI labels and buttons: translate naturally, keep concise.\n' +
      'Output only the translation, one line. Do not include any reasoning, thinking, or explanation.';

    const results = new Array(texts.length).fill('');
    const POOL = 3;
    let pi = 0;

    async function worker() {
      while (pi < texts.length) {
        const i = pi++;
        const text = (texts[i] || '').trim();
        if (!text) continue;
        try {
          const resp = await fetch(url + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model,
              system: systemPrompt,
              prompt: text,
              stream: false,
              options: { temperature: 0.1, num_predict: 1024, enable_thinking: false },
            }),
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          const raw = (data.response || '').trim();
          const translation = stripThinkingTags(raw);
          if (translation && translation.toLowerCase() !== text.toLowerCase()) {
            results[i] = translation;
          }
        } catch (_) {}
      }
    }

    const workers = [];
    for (let w = 0; w < POOL; w++) workers.push(worker());
    await Promise.all(workers);
    sendResponse({ ok: true, results: results });
  } catch (e) {
    sendResponse({ ok: false, results: null, error: e.message });
  }
}

async function handlePageGoogleTranslate(message, sendResponse) {
  try {
    const results = await handleGoogleTranslateBatch(message.texts, message.from, message.to);
    sendResponse({ ok: true, results: results });
  } catch (e) {
    sendResponse({ ok: false, status: 0, results: null, error: e.message });
  }
}

// ─── Google Translate from browser (respects system proxy) ───────────────
// Unlike the Go backend which makes direct HTTP connections (no proxy),
// the browser's fetch() goes through the system proxy, enabling Google
// Translate in regions where it would otherwise be blocked.

async function handleGoogleTranslateBatch(texts, fromLang, toLang) {
  const tl = mapGoogleLang(toLang);
  const base = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' + encodeURIComponent(tl);

  const BATCH = 10;
  const results = new Array(texts.length);

  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    let url = base;
    for (const t of batch) {
      url += '&q=' + encodeURIComponent(t || ' ');
    }

    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          const n = Math.min(batch.length, Array.isArray(data) ? data.length : 0);
          for (let i = 0; i < n; i++) {
            const raw = data[i];
            if (!Array.isArray(raw)) { results[start + i] = ''; continue; }
            results[start + i] = raw.map(seg => Array.isArray(seg) ? (seg[0] || '') : '').join('').trim() || '';
          }
          ok = true;
          break;
        }
        if (resp.status === 429) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
          continue;
        }
        break;
      } catch (_) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!ok) {
      for (let i = 0; i < batch.length; i++) {
        results[start + i] = '';
      }
    }
  }
  return results;
}

function mapGoogleLang(lang) {
  const m = { 'auto': 'auto', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'zh': 'zh-CN',
    'en': 'en', 'ja': 'ja', 'ko': 'ko', 'fr': 'fr', 'de': 'de',
    'es': 'es', 'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'th': 'th', 'vi': 'vi' };
  return m[lang] || lang;
}

// ─── Ollama model management ──────────────────────────────────────────

function handleOllamaPullStart(request, sendResponse) {
  const name = request.model;
  if (_downloads.has(name) && _downloads.get(name).status === 'pulling') {
    sendResponse({ ok: true, already: true });
    return;
  }
  _downloads.set(name, { status: 'pulling', completed: 0, total: 1, pct: 0 });
  sendResponse({ ok: true });

  // Run pull in background — NOT awaited, survives popup close
  _doPull(request.baseUrl, name);
}

async function _doPull(baseUrl, name) {
  try {
    const apiUrl = (baseUrl || 'http://localhost:11434').replace(/\/$/, '') + '/api/pull';
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, stream: true }),
    });
    if (resp.status === 403) {
      _downloads.set(name, { status: 'error', error: 'HTTP 403 — 请设置环境变量 OLLAMA_ORIGINS=* 后重启 Ollama' });
      return;
    }
    if (!resp.ok) {
      _downloads.set(name, { status: 'error', error: 'HTTP ' + resp.status });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      buf += decoder.decode(result.value || new Uint8Array(), { stream: !done });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.total && obj.completed !== undefined) {
            const pct = Math.round(obj.completed / obj.total * 100);
            _downloads.set(name, { status: 'pulling', completed: obj.completed, total: obj.total, pct: pct });
          }
          if (obj.status === 'success') {
            _downloads.set(name, { status: 'success', completed: 1, total: 1, pct: 100 });
            return;
          }
          if (obj.error) {
            _downloads.set(name, { status: 'error', error: obj.error });
            return;
          }
        } catch (_) { /* skip unparseable lines */ }
      }
    }
    _downloads.set(name, { status: 'error', error: '拉取未完成，请重试' });
  } catch (e) {
    _downloads.set(name, { status: 'error', error: e.message || '网络错误' });
  }
}

async function handleOllamaDelete(request, sendResponse) {
  try {
    const resp = await fetch((request.baseUrl || 'http://localhost:11434').replace(/\/$/, '') + '/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: request.model })
    });
    if (resp.status === 403) throw new Error('HTTP 403 — 请设置环境变量 OLLAMA_ORIGINS=* 后重启 Ollama');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}
