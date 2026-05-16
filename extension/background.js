// background.js - Service Worker
// Handles messages from popup and relays between content scripts.
// Manages extension state across tabs.

const DEFAULT_WS_URL = 'ws://localhost:9527/ws';

// Store active translation sessions per tab
const sessions = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  switch (message.type) {
    case 'getStatus':
      sendResponse({ status: sessions[tabId]?.status || 'idle' });
      break;

    case 'started':
      sessions[tabId] = { status: 'listening' };
      break;

    case 'stopped':
      sessions[tabId] = { status: 'stopped' };
      break;

    case 'statusUpdate':
      if (sessions[tabId]) {
        sessions[tabId].status = message.status;
      }
      break;

    // Fetch a URL in MAIN world (bypasses CSP/cookie/credential issues)
    case 'fetchInMain':
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: fetchInMain,
        args: [message.url],
      }).then(results => {
        if (results && results[0] && results[0].result) {
          sendResponse({ ok: true, text: results[0].result });
        } else {
          sendResponse({ ok: false, error: 'no result' });
        }
      }).catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
      return true; // keep channel open for async sendResponse
  }
});

// This function is serialized and executed in MAIN world
function fetchInMain(url) {
  return fetch(url, { credentials: 'include' })
    .then(r => r.text())
    .catch(e => 'FETCH_ERROR:' + e.message);
}

// Keep service worker alive when active
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'translation-keepalive') {
    port.onDisconnect.addListener(() => {
      // Extension disconnected, no action needed
    });
  }
});
