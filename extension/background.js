// background.js - Service Worker
// Handles messages from popup, relays between content scripts.

const DEFAULT_WS_URL = 'ws://localhost:29527/ws';

// Store active translation sessions per tab
const sessions = {};

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
        engine: settings.engine || 'microsoft',
        ollamaUrl: (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, ''),
        ollamaModel: settings.ollamaModel || 'qwen2.5:7b',
      }),
    });

    if (!apiResp.ok) {
      var errText = ''; try { errText = await apiResp.text(); } catch (_) {}
      notifyContent(tabId, { type: 'SHOW_IMAGE_STATUS', srcUrl: srcUrl, text: '图片翻译失败: HTTP ' + apiResp.status + (errText ? ' ' + errText.slice(0, 100) : '') });
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
