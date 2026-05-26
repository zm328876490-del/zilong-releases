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
