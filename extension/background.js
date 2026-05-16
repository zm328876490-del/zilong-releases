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
        func: fetchInMainSync,
        args: [message.url],
      }).then(results => {
        if (results && results[0] && results[0].result != null) {
          sendResponse({ ok: true, text: results[0].result });
        } else {
          sendResponse({ ok: false, error: 'no result', raw: JSON.stringify(results) });
        }
      }).catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
      return true; // keep channel open for async sendResponse

    // POST a URL in MAIN world (for InnerTube API calls)
    case 'postInMain':
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: postInMainSync,
        args: [message.url, message.body],
      }).then(results => {
        if (results && results[0] && results[0].result != null) {
          sendResponse({ ok: true, text: results[0].result });
        } else {
          sendResponse({ ok: false, error: 'no result', raw: JSON.stringify(results) });
        }
      }).catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
      return true;
  }
});

// Synchronous XHR executed in MAIN world (avoids CSP, uses page cookies)
function fetchInMainSync(url) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.withCredentials = true;
  try {
    xhr.send();
    return xhr.responseText;
  } catch (e) {
    return 'XHR_ERROR:' + e.message;
  }
}

function postInMainSync(url, body) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', url, false);
  xhr.withCredentials = true;
  xhr.setRequestHeader('Content-Type', 'application/json');
  try {
    xhr.send(body);
    return xhr.responseText;
  } catch (e) {
    return 'XHR_ERROR:' + e.message;
  }
}

// Keep service worker alive when active
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'translation-keepalive') {
    port.onDisconnect.addListener(() => {
      // Extension disconnected, no action needed
    });
  }
});
