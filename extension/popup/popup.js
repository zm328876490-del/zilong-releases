// popup.js - Extension popup control panel

(function () {
  'use strict';

  // ─── DOM elements ────────────────────────────────────────────────
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const translateEngineSelect = document.getElementById('translateEngine');
  let prevEngine = translateEngineSelect.value;
  const ollamaModal = document.getElementById('ollamaModal');
  const ollamaUrlInput = document.getElementById('ollamaUrl');
  const ollamaModelInput = document.getElementById('ollamaModel');
  const ollamaCancelBtn = document.getElementById('ollamaCancel');
  const ollamaConfirmBtn = document.getElementById('ollamaConfirm');
  const subtitleToggle = document.getElementById('subtitleToggle');
  const subtitleSizeSection = document.getElementById('subtitleSizeSection');
  const subtitleSizeSlider = document.getElementById('subtitleSize');
  const subtitleSizeVal = document.getElementById('subtitleSizeVal');
  const originalVolumeSlider = document.getElementById('originalVolume');
  const originalVolumeVal = document.getElementById('originalVolumeVal');
  const originalVolumeNote = document.getElementById('originalVolumeNote');
  const subtitleSizeNote = document.getElementById('subtitleSizeNote');
  const ttsVolumeSlider = document.getElementById('ttsVolume');
  const ttsVolumeVal = document.getElementById('ttsVolumeVal');
  const toggleGlobal = document.getElementById('toggleGlobal');
  const toggleBilingualPage = document.getElementById('toggleBilingualPage');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const errorMsg = document.getElementById('errorMsg');

  let isRunning = false;

  // ─── Settings persistence ─────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    wsUrl: 'ws://localhost:29527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    engine: 'microsoft',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5:7b',
    subtitleEnabled: true,
    subtitleSize: 50,
    originalVolume: 30,
    ttsVolume: 100,
    pageGlobalEnabled: true,
    pageBilingual: false,
  };

  async function loadSettings() {
    const result = await chrome.storage.local.get(['translationSettings', 'pageBilingual']);
    const settings = result.translationSettings || DEFAULT_SETTINGS;
    // pageBilingual may be stored at top level by the toggle handler.
    if (result.pageBilingual !== undefined) {
      settings.pageBilingual = result.pageBilingual;
    }
    const targetLang = settings.targetLang || DEFAULT_SETTINGS.targetLang;
    sourceLangSelect.value = settings.sourceLang || DEFAULT_SETTINGS.sourceLang;
    targetLangSelect.value = targetLang;
    translateEngineSelect.value = settings.engine || DEFAULT_SETTINGS.engine;
    ollamaUrlInput.value = settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl;
    ollamaModelInput.value = settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel;
    prevEngine = settings.engine || DEFAULT_SETTINGS.engine;
    subtitleToggle.checked = settings.subtitleEnabled !== false;
    updateSubtitleSizeVisibility();
    subtitleSizeSlider.value = settings.subtitleSize || 50;
    subtitleSizeVal.textContent = subtitleSizeSlider.value + '%';
    originalVolumeSlider.value = settings.originalVolume || 30;
    originalVolumeVal.textContent = originalVolumeSlider.value + '%';
    ttsVolumeSlider.value = settings.ttsVolume || 100;
    ttsVolumeVal.textContent = ttsVolumeSlider.value + '%';
    toggleGlobal.checked = settings.pageGlobalEnabled !== false;
    toggleBilingualPage.checked = settings.pageBilingual === true;
    return settings;
  }

  async function saveSettings() {
    const settings = {
      wsUrl: DEFAULT_SETTINGS.wsUrl,
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      engine: translateEngineSelect.value,
      ollamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
      ollamaModel: ollamaModelInput.value.trim() || 'qwen2.5:7b',
      subtitleEnabled: subtitleToggle.checked,
      subtitleSize: parseInt(subtitleSizeSlider.value, 10),
      originalVolume: parseInt(originalVolumeSlider.value, 10),
      ttsVolume: parseInt(ttsVolumeSlider.value, 10),
      pageGlobalEnabled: toggleGlobal.checked,
      pageBilingual: toggleBilingualPage.checked,
    };
    await chrome.storage.local.set({ translationSettings: settings, pageBilingual: settings.pageBilingual });

    // Push to active tab immediately for real-time effect
    if (isRunning) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'updateSettings',
            settings: settings,
          }).catch(() => {});
        }
      } catch (_) {}
    }

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

  // ─── Event listeners ──────────────────────────────────────────────
  targetLangSelect.addEventListener('change', function () {
    saveSettings();
    syncPageLangEngine();
  });

  translateEngineSelect.addEventListener('change', function () {
    if (translateEngineSelect.value === 'ollama') {
      showOllamaModal();
    } else {
      prevEngine = translateEngineSelect.value;
      saveSettings();
      syncPageLangEngine();
    }
  });

  [sourceLangSelect].forEach(
    function (el) {
      el.addEventListener('change', function () { saveSettings(); syncPageLangEngine(); });
      el.addEventListener('input', saveSettings);
    }
  );

  [ollamaUrlInput, ollamaModelInput].forEach(function (el) {
    el.addEventListener('change', saveSettings);
    el.addEventListener('input', saveSettings);
  });

  function showOllamaModal() {
    ollamaModal.style.display = 'flex';
  }

  function hideOllamaModal() {
    ollamaModal.style.display = 'none';
  }

  ollamaConfirmBtn.addEventListener('click', function () {
    prevEngine = 'ollama';
    hideOllamaModal();
    saveSettings();
    syncPageLangEngine();
  });

  ollamaCancelBtn.addEventListener('click', function () {
    translateEngineSelect.value = prevEngine;
    hideOllamaModal();
  });

  ollamaModal.addEventListener('click', function (e) {
    if (e.target === ollamaModal) {
      translateEngineSelect.value = prevEngine;
      hideOllamaModal();
    }
  });

  subtitleToggle.addEventListener('change', function () {
    updateSubtitleSizeVisibility();
    saveSettings();
    pushDisplaySettings();
  });

  // Page translation toggles
  toggleGlobal.addEventListener('change', function () {
    var enabled = toggleGlobal.checked;
    chrome.storage.local.set({ pageGlobalEnabled: enabled });
    pushPageMessage('PAGE_TRANSLATE_TOGGLE', { enabled: enabled });
  });

  toggleBilingualPage.addEventListener('change', function () {
    var enabled = toggleBilingualPage.checked;
    chrome.storage.local.set({ pageBilingual: enabled });
    pushPageMessage('PAGE_UPDATE_BILINGUAL', { enabled: enabled });
  });

  function updateSubtitleSizeVisibility() {
    subtitleSizeSection.style.display = subtitleToggle.checked ? '' : 'none';
  }

  // Sliders: update label + save
  subtitleSizeSlider.addEventListener('input', function () {
    subtitleSizeVal.textContent = subtitleSizeSlider.value + '%';
    saveSettings();
    pushDisplaySettings();
  });

  originalVolumeSlider.addEventListener('input', function () {
    originalVolumeVal.textContent = originalVolumeSlider.value + '%';
    saveSettings();
    pushDisplaySettings();
  });

  ttsVolumeSlider.addEventListener('input', function () {
    ttsVolumeVal.textContent = ttsVolumeSlider.value + '%';
    saveSettings();
    pushDisplaySettings();
  });

  // Push page translation settings to content script
  async function pushPageMessage(type, data) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, Object.assign({ type: type }, data)).catch(function () {});
      }
    } catch (_) {}
  }

  // Sync language/engine changes to page translation settings
  async function syncPageLangEngine() {
    chrome.storage.local.set({
      pageSourceLang: sourceLangSelect.value,
      pageTargetLang: targetLangSelect.value,
      pageEngine: translateEngineSelect.value,
      pageOllamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
      pageOllamaModel: ollamaModelInput.value.trim() || 'qwen2.5:7b',
    });
    pushPageMessage('PAGE_UPDATE_SETTINGS', {
      settings: {
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value,
        engine: translateEngineSelect.value,
        ollamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
        ollamaModel: ollamaModelInput.value.trim() || 'qwen2.5:7b',
      },
    });
  }

  // Push display-related settings to content script in real-time
  async function pushDisplaySettings() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'updateDisplaySettings',
          settings: {
            subtitleEnabled: subtitleToggle.checked,
            subtitleSize: parseInt(subtitleSizeSlider.value, 10),
            originalVolume: parseInt(originalVolumeSlider.value, 10),
            ttsVolume: parseInt(ttsVolumeSlider.value, 10),
          },
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // ─── Floating-mode slider gating ──────────────────────────────────
  function setSubtitleSizeDisabled(disabled) {
    subtitleSizeSlider.disabled = !!disabled;
    subtitleSizeSlider.style.opacity = disabled ? '0.4' : '1';
    if (subtitleSizeNote) subtitleSizeNote.style.display = disabled ? 'block' : 'none';
  }

  function setOriginalVolumeDisabled(disabled) {
    originalVolumeSlider.disabled = !!disabled;
    originalVolumeSlider.style.opacity = disabled ? '0.4' : '1';
    if (originalVolumeNote) originalVolumeNote.style.display = disabled ? 'block' : 'none';
  }

  // ─── Listen for status updates from content script ────────────────
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'statusUpdate':
        setStatus(message.status, message.message);
        if (message.status === 'error') {
          showError(message.message);
        }
        break;
      case 'floatingModeChanged':
        setSubtitleSizeDisabled(!!message.floating);
        setOriginalVolumeDisabled(!!message.floating);
        break;
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();

    // Sync separate keys for page-translate.js (which reads them individually)
    chrome.storage.local.set({
      pageBilingual: toggleBilingualPage.checked,
      pageGlobalEnabled: toggleGlobal.checked,
    });

    // Check current status from the active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' });
        if (response && response.isRunning) {
          isRunning = true;
          setStatus('listening');
        }
        setSubtitleSizeDisabled(!!(response && response.floatingMode));
        setOriginalVolumeDisabled(!!(response && response.floatingMode));
      }
    } catch (e) {
      // Content script not injected yet, that's fine
    }
  }

  init();
})();
