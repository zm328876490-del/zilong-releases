// background.js - Service Worker
// Handles messages from popup, relays between content scripts.
// Manages extension state across tabs and offscreen document lifecycle.

const DEFAULT_WS_URL = 'ws://localhost:29527/ws';

// Store active translation sessions per tab
const sessions = {};

// Offscreen document state
let offscreenCreating = false;
let offscreenReady = false;

// Pending results from offscreen that couldn't be delivered to content script
// keyed by sessionId → { items, timestamp }
const pendingOffscreenResults = {};

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

    // ─── Offscreen recording: content → background ──────────────────
    case 'startOffscreen':
      handleStartOffscreen(message, tabId);
      sendResponse({ success: true });
      break;

    case 'stopOffscreen':
      handleStopOffscreen(message, tabId);
      sendResponse({ success: true });
      break;

    case 'getPendingOffscreenResult':
      // Content script asks: any pending results for this session?
      var pending = pendingOffscreenResults[message.sessionId];
      if (pending) {
        sendResponse({ found: true, items: pending.items });
        delete pendingOffscreenResults[message.sessionId];
      } else {
        sendResponse({ found: false });
      }
      break;

    // ─── Offscreen → background: status & results ───────────────────
    case 'offscreenStatus':
      // Forward to content script
      forwardToContent(message, message.sessionId);
      break;

    case 'offscreenResult':
      // Offscreen processing complete — forward results to content script
      forwardToContent({ type: 'offscreenComplete', items: message.items, sessionId: message.sessionId }, message.sessionId);
      // Also save as pending in case content script is gone (tab refresh)
      pendingOffscreenResults[message.sessionId] = {
        items: message.items,
        timestamp: Date.now(),
      };
      // Close offscreen document (it will self-close, but ensure)
      closeOffscreenDocument();
      break;

    case 'offscreenError':
      // Forward error to content script
      forwardToContent({ type: 'offscreenError', message: message.message, sessionId: message.sessionId }, message.sessionId);
      closeOffscreenDocument();
      break;
  }
});

// ─── Offscreen document management ────────────────────────────────────

async function ensureOffscreenDocument() {
  if (offscreenReady) return true;
  if (offscreenCreating) {
    // Wait for in-progress creation
    for (let i = 0; i < 50; i++) {
      if (offscreenReady) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return offscreenReady;
  }

  // Check if one already exists
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    const existing = clients.find(c => c.url.endsWith('offscreen.html'));
    if (existing) {
      offscreenReady = true;
      return true;
    }
  } catch (_) {}

  offscreenCreating = true;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Background video audio capture for AI translation processing',
    });
    offscreenReady = true;
    return true;
  } catch (e) {
    console.error('Failed to create offscreen document:', e);
    offscreenReady = false;
    return false;
  } finally {
    offscreenCreating = false;
  }
}

function closeOffscreenDocument() {
  offscreenReady = false;
  chrome.offscreen.closeDocument().catch(() => {});
}

async function handleStartOffscreen(message, tabId) {
  const ok = await ensureOffscreenDocument();
  if (!ok) {
    // Notify content script that offscreen failed
    forwardToTab(tabId, {
      type: 'offscreenError',
      message: '无法创建后台处理文档',
      sessionId: message.sessionId,
    });
    return;
  }

  // Send recording request to offscreen document
  try {
    chrome.runtime.sendMessage({
      type: 'startRecording',
      videoUrl: message.videoUrl,
      settings: message.settings,
      sessionId: message.sessionId,
    }).catch(() => {});
  } catch (_) {}

  // Track session
  sessions[tabId] = {
    status: 'offscreen_recording',
    sessionId: message.sessionId,
  };
}

async function handleStopOffscreen(message, tabId) {
  try {
    chrome.runtime.sendMessage({
      type: 'stopRecording',
      sessionId: message.sessionId,
    }).catch(() => {});
  } catch (_) {}

  closeOffscreenDocument();

  delete pendingOffscreenResults[message.sessionId];

  if (sessions[tabId]) {
    sessions[tabId].status = 'stopped';
  }
}

// ─── Message forwarding ───────────────────────────────────────────────

async function forwardToContent(message, sessionId) {
  if (!sessionId) return;

  // Find the tab with this session
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      // Try to send; the content script filters by sessionId
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_) {
        // Tab might not have content script loaded
      }
    }
  } catch (_) {}
}

async function forwardToTab(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // Tab might be gone
  }
}

// ─── Keepalive ────────────────────────────────────────────────────────

// Accept keep-alive connections from content script and offscreen doc
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'translation-keepalive' || port.name === 'offscreen-keepalive') {
    port.onDisconnect.addListener(() => {
      // Client disconnected, no action needed
    });
    port.onMessage.addListener((msg) => {
      // Heartbeat pings — just acknowledge connection is alive
    });
  }
});

// ─── Periodic cleanup of stale pending results ────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(pendingOffscreenResults)) {
    if (now - pendingOffscreenResults[key].timestamp > 3600000) {
      delete pendingOffscreenResults[key];
    }
  }
}, 600000); // every 10 minutes
