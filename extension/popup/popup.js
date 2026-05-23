// popup.js - Extension popup control panel

(function () {
  'use strict';

  // ─── DOM elements ────────────────────────────────────────────────
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const translateEngineSelect = document.getElementById('translateEngine');
  const ollamaFields = document.getElementById('ollamaFields');
  const ollamaUrlInput = document.getElementById('ollamaUrl');
  const ollamaModelInput = document.getElementById('ollamaModel');
  const ttsVoiceSelect = document.getElementById('ttsVoice');
  const subtitleToggle = document.getElementById('subtitleToggle');
  const subtitleSizeSlider = document.getElementById('subtitleSize');
  const subtitleSizeVal = document.getElementById('subtitleSizeVal');
  const originalVolumeSlider = document.getElementById('originalVolume');
  const originalVolumeVal = document.getElementById('originalVolumeVal');
  const originalVolumeNote = document.getElementById('originalVolumeNote');
  const subtitleSizeNote = document.getElementById('subtitleSizeNote');
  const ttsVolumeSlider = document.getElementById('ttsVolume');
  const ttsVolumeVal = document.getElementById('ttsVolumeVal');
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleIcon = document.getElementById('toggleIcon');
  const toggleText = document.getElementById('toggleText');
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
    ttsVoice: 'default',
    subtitleEnabled: true,
    subtitleSize: 50,
    originalVolume: 30,
    ttsVolume: 100,
  };

  // Language-specific TTS voices. "default" resolves to VoiceForLang(targetLang) on backend.
  const VOICE_MAP = {
    'zh-Hans': [
      { value: 'default', label: '默认女声 (晓晓)' },
      { value: 'xiaoxiao', label: '晓晓 (女·温柔)' },
      { value: 'yunxi', label: '云希 (男)' },
      { value: 'xiaoyi', label: '晓伊 (女·活泼)' },
      { value: 'yunyang', label: '云扬 (男·新闻)' },
    ],
    en: [
      { value: 'default', label: 'Default (Jenny)' },
      { value: 'jenny', label: 'Jenny (Female)' },
      { value: 'guy', label: 'Guy (Male)' },
      { value: 'aria', label: 'Aria (Female)' },
    ],
    ja: [
      { value: 'default', label: 'デフォルト (Nanami)' },
      { value: 'nanami', label: 'Nanami (Female)' },
      { value: 'keita', label: 'Keita (Male)' },
    ],
    ko: [
      { value: 'default', label: '기본 (SunHi)' },
      { value: 'sunhi', label: 'SunHi (Female)' },
      { value: 'injoon', label: 'InJoon (Male)' },
    ],
    fr: [
      { value: 'default', label: 'Défaut (Denise)' },
      { value: 'denise', label: 'Denise (Female)' },
      { value: 'henri', label: 'Henri (Male)' },
    ],
    de: [
      { value: 'default', label: 'Standard (Katja)' },
      { value: 'katja', label: 'Katja (Female)' },
      { value: 'conrad', label: 'Conrad (Male)' },
    ],
    es: [
      { value: 'default', label: 'Predeterminado (Elvira)' },
      { value: 'elvira', label: 'Elvira (Female)' },
      { value: 'alvaro', label: 'Álvaro (Male)' },
    ],
    pt: [
      { value: 'default', label: 'Padrão (Francisca)' },
      { value: 'francisca', label: 'Francisca (Female)' },
      { value: 'antonio', label: 'Antônio (Male)' },
    ],
    ru: [
      { value: 'default', label: 'По умолчанию (Svetlana)' },
      { value: 'svetlana', label: 'Svetlana (Female)' },
      { value: 'dmitry', label: 'Dmitry (Male)' },
    ],
    th: [
      { value: 'default', label: 'ค่าเริ่มต้น (Premwadee)' },
      { value: 'premwadee', label: 'Premwadee (Female)' },
      { value: 'niwat', label: 'Niwat (Male)' },
    ],
    vi: [
      { value: 'default', label: 'Mặc định (HoaiMy)' },
      { value: 'hoaimy', label: 'HoaiMy (Female)' },
      { value: 'namminh', label: 'NamMinh (Male)' },
    ],
  };

  function populateTTSVoices(lang) {
    const voices = VOICE_MAP[lang] || VOICE_MAP['en'];
    const prev = ttsVoiceSelect.value;
    ttsVoiceSelect.innerHTML = '';
    voices.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      ttsVoiceSelect.appendChild(opt);
    });
    // Restore previous value if still valid, otherwise fall to first (default)
    var found = voices.some(function (v) { return v.value === prev; });
    ttsVoiceSelect.value = found ? prev : voices[0].value;
  }

  function onTargetLangChange() {
    populateTTSVoices(targetLangSelect.value);
    saveSettings();
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get('translationSettings');
    const settings = result.translationSettings || DEFAULT_SETTINGS;
    const targetLang = settings.targetLang || DEFAULT_SETTINGS.targetLang;
    sourceLangSelect.value = settings.sourceLang || DEFAULT_SETTINGS.sourceLang;
    targetLangSelect.value = targetLang;
    translateEngineSelect.value = settings.engine || DEFAULT_SETTINGS.engine;
    ollamaUrlInput.value = settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl;
    ollamaModelInput.value = settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel;
    updateEngineFields();
    populateTTSVoices(targetLang);
    ttsVoiceSelect.value = settings.ttsVoice || 'default';
    subtitleToggle.checked = settings.subtitleEnabled !== false;
    subtitleSizeSlider.value = settings.subtitleSize || 50;
    subtitleSizeVal.textContent = subtitleSizeSlider.value + '%';
    originalVolumeSlider.value = settings.originalVolume || 30;
    originalVolumeVal.textContent = originalVolumeSlider.value + '%';
    ttsVolumeSlider.value = settings.ttsVolume || 100;
    ttsVolumeVal.textContent = ttsVolumeSlider.value + '%';
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
      ttsVoice: ttsVoiceSelect.value,
      subtitleEnabled: subtitleToggle.checked,
      subtitleSize: parseInt(subtitleSizeSlider.value, 10),
      originalVolume: parseInt(originalVolumeSlider.value, 10),
      ttsVolume: parseInt(ttsVolumeSlider.value, 10),
    };
    await chrome.storage.local.set({ translationSettings: settings });

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

  // ─── Button actions ───────────────────────────────────────────────
  async function sendWithRetry(tabId, message, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (e) {
        console.warn('[popup] sendMessage attempt ' + (i + 1) + '/' + maxRetries + ' failed:', e.message);
        if (i < maxRetries - 1) {
          // Content script might not be loaded yet, inject and wait
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content.js'],
            });
            console.log('[popup] injected content.js');
          } catch (injectErr) {
            console.warn('[popup] executeScript failed:', injectErr.message);
            // If injection fails, try pinging background to wake SW
            try { await chrome.runtime.sendMessage({ type: 'ping' }); } catch (_) {}
          }
          await new Promise((r) => setTimeout(r, 500));
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
      // Check if the error is a connection error with the tab
      if (err.message && err.message.indexOf('Receiving end does not exist') !== -1) {
        showError('无法连接：请刷新视频页面后重试（按 F5 刷新当前页面，然后重新点击翻译）');
      } else {
        showError('无法连接: ' + err.message + '。请刷新页面后重试。');
      }
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

  // Target language change: rebuild TTS voices first, then save
  targetLangSelect.addEventListener('change', onTargetLangChange);

  // Engine change: show/hide engine-specific fields, then save
  translateEngineSelect.addEventListener('change', function () {
    updateEngineFields();
    saveSettings();
  });

  // Auto-save on input change
  [sourceLangSelect, ttsVoiceSelect].forEach(
    (el) => {
      el.addEventListener('change', saveSettings);
      el.addEventListener('input', saveSettings);
    }
  );

  [ollamaUrlInput, ollamaModelInput].forEach(function (el) {
    el.addEventListener('change', saveSettings);
    el.addEventListener('input', saveSettings);
  });

  function updateEngineFields() {
    var engine = translateEngineSelect.value;
    ollamaFields.style.display = (engine === 'ollama') ? '' : 'none';
  }

  // Subtitle toggle: save and push immediately
  subtitleToggle.addEventListener('change', function () {
    saveSettings();
    pushDisplaySettings();
  });

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
  // While the floating popup window is up, the source <video> is muted
  // (see floating-window.js). The "原声音量" slider therefore controls
  // nothing — disable it so the UI does not lie to the user.
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
        // Sync slider disabled states with floating mode.
        setSubtitleSizeDisabled(!!(response && response.floatingMode));
        setOriginalVolumeDisabled(!!(response && response.floatingMode));
      }
    } catch (e) {
      // Content script not injected yet, that's fine
    }
  }

  init();
})();
