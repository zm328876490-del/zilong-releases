// popup.js - Extension popup control panel

(function () {
  'use strict';

  // ─── DOM elements ────────────────────────────────────────────────
  const wsUrlInput = document.getElementById('wsUrl');
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const baiduAppIDInput = document.getElementById('baiduAppID');
  const baiduSecretInput = document.getElementById('baiduSecret');
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleIcon = document.getElementById('toggleIcon');
  const toggleText = document.getElementById('toggleText');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const errorMsg = document.getElementById('errorMsg');

  let isRunning = false;

  // ─── Settings persistence ─────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    wsUrl: 'ws://localhost:9527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    baiduAppID: '',
    baiduSecret: '',
  };

  async function loadSettings() {
    const result = await chrome.storage.local.get('translationSettings');
    const settings = result.translationSettings || DEFAULT_SETTINGS;
    wsUrlInput.value = settings.wsUrl || DEFAULT_SETTINGS.wsUrl;
    sourceLangSelect.value = settings.sourceLang || DEFAULT_SETTINGS.sourceLang;
    targetLangSelect.value = settings.targetLang || DEFAULT_SETTINGS.targetLang;
    baiduAppIDInput.value = settings.baiduAppID || '';
    baiduSecretInput.value = settings.baiduSecret || '';
    return settings;
  }

  async function saveSettings() {
    const settings = {
      wsUrl: wsUrlInput.value.trim(),
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      baiduAppID: baiduAppIDInput.value.trim(),
      baiduSecret: baiduSecretInput.value.trim(),
    };
    await chrome.storage.local.set({ translationSettings: settings });
    return settings;
  }

  // ─── Status ───────────────────────────────────────────────────────
  function setStatus(status, text) {
    statusIndicator.className = 'status-' + status;
    statusText.textContent = text;

    const statusMap = {
      idle: '未连接',
      connected: '已连接后端',
      listening: '翻译中...',
      starting: '启动中...',
      error: '错误',
    };
    if (!text) {
      statusText.textContent = statusMap[status] || status;
    }
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
    setTimeout(() => {
      errorMsg.style.display = 'none';
    }, 5000);
  }

  // ─── Button actions ───────────────────────────────────────────────
  async function sendWithRetry(tabId, message, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (e) {
        if (i < maxRetries - 1) {
          // Content script might not be loaded yet, inject and wait
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content.js'],
            });
          } catch (injectErr) {
            // Might already be injected via manifest
          }
          await new Promise((r) => setTimeout(r, 300));
        } else {
          throw e;
        }
      }
    }
  }

  async function startTranslation() {
    const settings = await saveSettings();

    setStatus('starting');
    toggleBtn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        showError('无法获取当前标签页');
        return;
      }

      // Restricted URLs (chrome://, edge://, etc.)
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') ||
          tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://'))) {
        showError('此页面不支持翻译（系统页面）');
        return;
      }

      const response = await sendWithRetry(tab.id, {
        type: 'start',
        settings: settings,
      });

      if (response && response.success) {
        isRunning = true;
        updateButtonState();
        setStatus('listening');
      } else {
        showError('启动失败，请刷新页面后重试');
        setStatus('error', '启动失败');
      }
    } catch (err) {
      console.error('启动翻译失败:', err);
      showError('无法连接: ' + err.message + '。请刷新页面后重试。');
      setStatus('error', '启动失败');
    } finally {
      toggleBtn.disabled = false;
    }
  }

  async function stopTranslation() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { type: 'stop' }).catch(() => {});
      }
    } catch (e) {
      // ignore
    }

    isRunning = false;
    updateButtonState();
    setStatus('idle');
  }

  function updateButtonState() {
    if (isRunning) {
      toggleBtn.className = 'btn-stop';
      toggleIcon.textContent = '■';
      toggleText.textContent = '停止翻译';
    } else {
      toggleBtn.className = 'btn-start';
      toggleIcon.textContent = '▶';
      toggleText.textContent = '开始翻译';
    }
  }

  // ─── Event listeners ──────────────────────────────────────────────
  toggleBtn.addEventListener('click', () => {
    if (isRunning) {
      stopTranslation();
    } else {
      startTranslation();
    }
  });

  // Auto-save on input change
  [wsUrlInput, sourceLangSelect, targetLangSelect, baiduAppIDInput, baiduSecretInput].forEach(
    (el) => {
      el.addEventListener('change', saveSettings);
      el.addEventListener('input', saveSettings);
    }
  );

  // ─── Listen for status updates from content script ────────────────
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'statusUpdate':
        setStatus(message.status, message.message);
        if (message.status === 'error') {
          showError(message.message);
        }
        break;
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();

    // Check current status from the active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' });
        if (response && response.isRunning) {
          isRunning = true;
          updateButtonState();
          setStatus('listening');
        }
      }
    } catch (e) {
      // Content script not injected yet, that's fine
    }
  }

  init();
})();
