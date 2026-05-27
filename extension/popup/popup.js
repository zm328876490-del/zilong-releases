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
  const errorMsg = document.getElementById('errorMsg');
  const serviceStatus = document.getElementById('serviceStatus');
  const installBtn = document.getElementById('installBtn');

  // Header elements
  const headerAvatar = document.getElementById('headerAvatar');
  const headerLicText = document.getElementById('headerLicText');
  const licDot = document.querySelector('.lic-dot');
  const headerLogin = document.getElementById('headerLogin');
  const headerUpgrade = document.getElementById('headerUpgrade');
  const engineBadge = document.getElementById('engineBadge');

  // API key modal elements
  const apiKeyModal = document.getElementById('apiKeyModal');
  const apiKeyModalTitle = document.getElementById('apiKeyModalTitle');
  const apiUrlGroup = document.getElementById('apiUrlGroup');
  const apiUrlInput = document.getElementById('apiUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const apiModelGroup = document.getElementById('apiModelGroup');
  const apiModelInput = document.getElementById('apiModel');
  const apiKeyCancelBtn = document.getElementById('apiKeyCancel');
  const apiKeyConfirmBtn = document.getElementById('apiKeyConfirm');

  // OpenAI-compatible provider presets
  const OPENAI_PRESETS = {
    deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    doubao:  { url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
    qwen:    { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  };

  let pendingApiEngine = null; // which engine triggered the apiKeyModal

  const INSTALLER_URL = 'http://localhost:14532/api/download/installer';
  const LOCAL_HEALTH = 'http://localhost:29527/health';

  let isRunning = false;

  // ─── Settings persistence ─────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    wsUrl: 'ws://localhost:29527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    engine: 'microsoft',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5:7b',
    openaiUrl: 'https://api.deepseek.com/v1',
    openaiKey: '',
    openaiModel: 'deepseek-chat',
    deeplKey: '',
    subtitleEnabled: true,
    subtitleSize: 50,
    originalVolume: 30,
    ttsVolume: 100,
    pageGlobalEnabled: true,
    pageBilingual: false,
  };

  function isOpenAIEngine(engine) {
    return engine === 'deepseek' || engine === 'doubao' || engine === 'qwen';
  }

  function getBackendEngine(engine) {
    return isOpenAIEngine(engine) ? 'openai' : engine;
  }

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
    // New engine fields — restore from per-engine keys or defaults
    apiUrlInput.value = settings.openaiUrl || DEFAULT_SETTINGS.openaiUrl;
    apiKeyInput.value = settings.openaiKey || DEFAULT_SETTINGS.openaiKey;
    apiModelInput.value = settings.openaiModel || DEFAULT_SETTINGS.openaiModel;
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
      openaiUrl: apiUrlInput.value.trim() || DEFAULT_SETTINGS.openaiUrl,
      openaiKey: apiKeyInput.value.trim(),
      openaiModel: apiModelInput.value.trim() || DEFAULT_SETTINGS.openaiModel,
      deeplKey: apiKeyInput.value.trim(),
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
    // Status is shown via serviceStatus element in local service card
    const statusMap = {
      idle: '未连接',
      connected: '已连接后端',
      listening: '翻译中...',
      starting: '启动中...',
      error: '错误',
    };
    const label = text || statusMap[status] || status;
    if (status === 'listening' || status === 'connected') {
      serviceStatus.textContent = '本地服务: 运行中 ✅';
      serviceStatus.className = 'service-status running';
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
    var engine = translateEngineSelect.value;
    if (engine === 'ollama') {
      showOllamaModal();
    } else if (isOpenAIEngine(engine)) {
      showApiKeyModal(engine);
    } else if (engine === 'deepl') {
      showApiKeyModal(engine);
    } else {
      prevEngine = engine;
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

  // ─── API Key modal (for DeepL and OpenAI-compatible engines) ────────

  function showApiKeyModal(engine) {
    pendingApiEngine = engine;
    var isOpenAI = isOpenAIEngine(engine);
    if (isOpenAI) {
      apiKeyModalTitle.textContent = '🤖 ' + engine + ' API 设置';
      var preset = OPENAI_PRESETS[engine] || { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
      apiUrlInput.value = apiUrlInput.value || preset.url;
      apiModelInput.value = apiModelInput.value || preset.model;
      apiUrlGroup.style.display = '';
      apiModelGroup.style.display = '';
    } else {
      // DeepL
      apiKeyModalTitle.textContent = '🌐 DeepL API 设置';
      apiUrlGroup.style.display = 'none';
      apiModelGroup.style.display = 'none';
    }
    apiKeyModal.style.display = 'flex';
  }

  function hideApiKeyModal() {
    apiKeyModal.style.display = 'none';
    pendingApiEngine = null;
  }

  apiKeyConfirmBtn.addEventListener('click', function () {
    if (!pendingApiEngine) return;
    prevEngine = pendingApiEngine;
    hideApiKeyModal();
    saveSettings();
    syncPageLangEngine();
  });

  apiKeyCancelBtn.addEventListener('click', function () {
    translateEngineSelect.value = prevEngine;
    hideApiKeyModal();
  });

  apiKeyModal.addEventListener('click', function (e) {
    if (e.target === apiKeyModal) {
      translateEngineSelect.value = prevEngine;
      hideApiKeyModal();
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
    var engine = translateEngineSelect.value;
    chrome.storage.local.set({
      pageSourceLang: sourceLangSelect.value,
      pageTargetLang: targetLangSelect.value,
      pageEngine: engine,
      pageOllamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
      pageOllamaModel: ollamaModelInput.value.trim() || 'qwen2.5:7b',
      pageOpenAIUrl: apiUrlInput.value.trim() || DEFAULT_SETTINGS.openaiUrl,
      pageOpenAIKey: apiKeyInput.value.trim(),
      pageOpenAIModel: apiModelInput.value.trim() || DEFAULT_SETTINGS.openaiModel,
      pageDeepLKey: apiKeyInput.value.trim(),
    });
    pushPageMessage('PAGE_UPDATE_SETTINGS', {
      settings: {
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value,
        engine: engine,
        ollamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
        ollamaModel: ollamaModelInput.value.trim() || 'qwen2.5:7b',
        openaiUrl: apiUrlInput.value.trim() || DEFAULT_SETTINGS.openaiUrl,
        openaiKey: apiKeyInput.value.trim(),
        openaiModel: apiModelInput.value.trim() || DEFAULT_SETTINGS.openaiModel,
        deeplKey: apiKeyInput.value.trim(),
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

  // ─── Local Service ──────────────────────────────────────────────
  async function checkLocalService() {
    serviceStatus.textContent = '检测中...';
    serviceStatus.className = 'service-status checking';
    installBtn.style.display = 'none';
    try {
      var resp = await fetch(LOCAL_HEALTH);
      if (resp.ok) {
        serviceStatus.textContent = '本地服务: 运行中 ✅';
        serviceStatus.className = 'service-status running';
        return;
      }
    } catch (_) {}
    serviceStatus.textContent = '本地服务: 未安装';
    serviceStatus.className = 'service-status stopped';
    installBtn.style.display = '';
  }

  installBtn.addEventListener('click', function () {
    chrome.downloads.download({ url: INSTALLER_URL, filename: 'AI-Translation-Installer.exe', saveAs: true });
  });

  // ─── Engine badge ──────────────────────────────────────────────────
  engineBadge.addEventListener('change', function () {
    var engine = engineBadge.value;
    translateEngineSelect.value = engine;
    prevEngine = engine;
    if (engine === 'ollama') {
      showOllamaModal();
    } else if (isOpenAIEngine(engine) || engine === 'deepl') {
      showApiKeyModal(engine);
    } else {
      saveSettings();
      syncPageLangEngine();
    }
  });

  // ─── Login / Account links ──────────────────────────────────────────
  function openAppPage(hash) {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html' + (hash ? '#' + hash : '')) });
  }

  headerLogin.addEventListener('click', function () { openAppPage('login'); });
  headerUpgrade.addEventListener('click', function () {
    var isPremium = headerUpgrade.textContent === '管理';
    openAppPage(isPremium ? 'account' : 'buy');
  });
  headerAvatar.addEventListener('click', function () {
    var licText = headerLicText.textContent || '';
    openAppPage(licText.indexOf('已登录') !== -1 ? 'account' : 'login');
  });

  // Update header based on login state
  function updateHeaderFromToken(token, plan) {
    if (token) {
      headerLicText.textContent = (plan === 'premium' ? '高级版' : '体验版') + ' · 已登录';
      licDot.className = 'lic-dot active';
      headerAvatar.classList.remove('plan-trial');
      headerAvatar.classList.add(plan === 'premium' ? 'plan-pro' : 'plan-trial');
      headerLogin.style.display = 'none';
      headerUpgrade.textContent = plan === 'premium' ? '管理' : '升级';
    } else {
      headerLicText.textContent = '体验版 · 未登录';
      licDot.className = 'lic-dot anonymous';
      headerAvatar.classList.remove('plan-pro');
      headerAvatar.classList.add('plan-trial');
      headerLogin.style.display = '';
      headerUpgrade.textContent = '升级';
    }
  }

  // Check stored token on init
  async function checkLoginState() {
    var result = await chrome.storage.local.get(['authToken', 'userPlan']);
    var token = result.authToken;
    var plan = result.userPlan || 'trial';
    if (token) {
      // Validate token with server
      try {
        var resp = await fetch('http://localhost:14532/api/auth/me', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (resp.ok) {
          var data = await resp.json();
          updateHeaderFromToken(token, data.plan || plan);
          return;
        }
      } catch (_) {}
      // Token invalid, clear it
      await chrome.storage.local.remove(['authToken', 'userPlan']);
    }
    updateHeaderFromToken(null, 'trial');
  }

  // ─── Init ─────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    engineBadge.value = translateEngineSelect.value;
    checkLocalService();
    checkLoginState();

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
