// background.js - Service Worker
// Handles messages from popup and relays between content scripts.
// Manages extension state across tabs.

const DEFAULT_WS_URL = 'ws://localhost:29527/ws';

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

  }
});


// Keep service worker alive when active
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'translation-keepalive') {
    port.onDisconnect.addListener(() => {
      // Extension disconnected, no action needed
    });
  }
});
