// popup.js - Extension popup control panel

(function () {
  'use strict';

  // ─── DOM elements ────────────────────────────────────────────────
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const translateEngineSelect = document.getElementById('translateEngine');
  let prevEngine = translateEngineSelect.value;
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
  const serviceHint = document.getElementById('serviceHint');

  // Model status elements
  const modelStatus = document.getElementById('modelStatus');
  const modelStatusIcon = document.getElementById('modelStatusIcon');
  const modelStatusText = document.getElementById('modelStatusText');
  const modelProgressWrap = document.getElementById('modelProgressWrap');
  const modelProgressBar = document.getElementById('modelProgressBar');
  const modelProgressFill = document.getElementById('modelProgressFill');
  const modelProgressDetail = document.getElementById('modelProgressDetail');
  const modelHardwareHint = document.getElementById('modelHardwareHint');

  // Model status brief (in service card)
  const modelStatusBrief = document.getElementById('modelStatusBrief');

  // Update progress elements
  const updateProgressWrap = document.getElementById('updateProgressWrap');
  const updateProgressFill = document.getElementById('updateProgressFill');
  const updateProgressDetail = document.getElementById('updateProgressDetail');

  // Local model modal
  const localModelModal = document.getElementById('localModelModal');
  const localModelCancel = document.getElementById('localModelCancel');
  const localModelConfirm = document.getElementById('localModelConfirm');

  // Header elements
  const headerAvatar = document.getElementById('headerAvatar');
  const headerLicText = document.getElementById('headerLicText');
  const licDot = document.querySelector('.lic-dot');
  const headerLogin = document.getElementById('headerLogin');
  const headerUpgrade = document.getElementById('headerUpgrade');
  // Custom engine dropdown
  const engineDropdown = document.getElementById('engineDropdown');
  const engineDropdownTrigger = document.getElementById('engineDropdownTrigger');
  const engineIcon = document.getElementById('engineIcon');
  const engineLabel = document.getElementById('engineLabel');
  let engineDropdownOpen = false;

  // Create panel at body level to avoid clipping
  var engineDropdownPanel = document.createElement('div');
  engineDropdownPanel.className = 'engine-dropdown-panel';
  engineDropdownPanel.id = 'engineDropdownPanel';
  engineDropdownPanel.style.display = 'none';
  document.body.appendChild(engineDropdownPanel);

  // Engine config with brand SVGs
  const ENGINE_CONFIG = {
    microsoft: {
      label: '微软',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><rect x="1.5" y="1.5" width="6.5" height="6.5" rx="1" fill="#F25022"/><rect x="10" y="1.5" width="6.5" height="6.5" rx="1" fill="#7FBA00"/><rect x="1.5" y="10" width="6.5" height="6.5" rx="1" fill="#00A4EF"/><rect x="10" y="10" width="6.5" height="6.5" rx="1" fill="#FFB900"/></svg>',
    },
    google: {
      label: 'Google',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><circle cx="9" cy="9" r="7" fill="none" stroke="#4285F4" stroke-width="1.3"/><path d="M9 2.5A6.5 6.5 0 0 0 2.8 7h2.3a4.3 4.3 0 0 1 7.5-1.8l-2 2h4.8V2.4l-1.7 1.7A6.5 6.5 0 0 0 9 2.5z" fill="#4285F4"/><text x="9" y="13.5" text-anchor="middle" font-size="8" font-weight="700" fill="#4285F4" font-family="Arial,sans-serif">G</text></svg>',
    },
    ollama: {
      label: '本地模型',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><ellipse cx="9" cy="13" rx="5" ry="2.5" fill="#1a1a1a"/><ellipse cx="9" cy="7" rx="3" ry="4" fill="#2d2d2d"/><ellipse cx="9" cy="6" rx="2" ry="2.5" fill="#3d3d3d"/><circle cx="7.5" cy="5.5" r="1" fill="#f5f5f5"/><circle cx="10.5" cy="5.5" r="1" fill="#f5f5f5"/><ellipse cx="8" cy="4" rx="1.5" ry="2" fill="#2d2d2d"/><ellipse cx="10" cy="4" rx="1.5" ry="2" fill="#2d2d2d"/></svg>',
    },
    deepseek: {
      label: 'DeepSeek',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><path d="M3 12 Q5 6 9 5 Q13 4 15 8 Q14 12 11 14 Q7 16 4 14z" fill="#4F6CF6"/><path d="M5 11 Q7 8 9 7 Q11 6 13 9 Q12 11 10 12 Q8 13 6 12z" fill="#6B8AFF"/></svg>',
    },
    doubao: {
      label: '豆包',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><polygon points="9,2 14,10 12,10 13,16 8,11 5,11 7,7 4,7" fill="#F53B00"/><polygon points="9,4 12,9 10,9 11,13 8,10 6,10 8,7 6,7" fill="#FF6B35"/></svg>',
    },
    qwen: {
      label: '通义千问',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><path d="M3 11 Q5 8 9 7 Q13 7 15 10 Q14 11 12 12 Q10 13 8 12 Q6 11 4 10z" fill="#6B4EFF"/><circle cx="7" cy="7" r="1.5" fill="#8B6FFF"/><circle cx="11" cy="7" r="1.5" fill="#8B6FFF"/></svg>',
    },
    deepl: {
      label: 'DeepL',
      svg: '<svg viewBox="0 0 18 18" width="16" height="16"><rect x="2" y="2" width="14" height="14" rx="3" fill="#0F2B46"/><text x="9" y="13.5" text-anchor="middle" font-size="9" font-weight="800" fill="white" font-family="Arial,sans-serif">D</text></svg>',
    },
  };

  function renderEngineDropdown(selectedEngine) {
    engineIcon.innerHTML = ENGINE_CONFIG[selectedEngine]?.svg || '';
    engineLabel.textContent = ENGINE_CONFIG[selectedEngine]?.label || selectedEngine;
    engineDropdownPanel.innerHTML = Object.keys(ENGINE_CONFIG).map(function (key) {
      var cfg = ENGINE_CONFIG[key];
      var active = key === selectedEngine ? ' active' : '';
      return '<div class="engine-option' + active + '" data-engine="' + key + '">' +
        '<span class="engine-icon">' + cfg.svg + '</span>' +
        '<span>' + cfg.label + '</span>' +
        '</div>';
    }).join('');
    // Wire click handlers
    engineDropdownPanel.querySelectorAll('.engine-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        var engine = opt.dataset.engine;
        selectEngine(engine);
        closeEngineDropdown();
      });
    });
  }

  function selectEngine(engine) {
    translateEngineSelect.value = engine;
    renderEngineDropdown(engine);
    if (isOpenAIEngine(engine) || engine === 'deepl') {
      showApiKeyModal(engine);
    } else if (engine === 'ollama') {
      showLocalModelModal();
    } else {
      prevEngine = engine;
      saveSettings();
      syncPageLangEngine();
    }
  }

  function toggleEngineDropdown() {
    engineDropdownOpen ? closeEngineDropdown() : openEngineDropdown();
  }

  function openEngineDropdown() {
    engineDropdownOpen = true;
    var rect = engineDropdownTrigger.getBoundingClientRect();
    engineDropdownPanel.style.top = (rect.bottom + 4) + 'px';
    engineDropdownPanel.style.right = (window.innerWidth - rect.right) + 'px';
    engineDropdownPanel.style.display = '';
    engineDropdown.classList.add('open');
    setTimeout(function () {
      document.addEventListener('click', onOutsideClick);
    }, 0);
  }

  function closeEngineDropdown() {
    engineDropdownOpen = false;
    engineDropdownPanel.style.display = 'none';
    engineDropdown.classList.remove('open');
    document.removeEventListener('click', onOutsideClick);
  }

  function onOutsideClick(e) {
    if (!engineDropdown.contains(e.target)) {
      closeEngineDropdown();
    }
  }

  engineDropdownTrigger.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleEngineDropdown();
  });

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

  const AUTH_API = 'http://101.96.227.131/auth-server';
  const LOCAL_BASE = 'http://localhost:29527';
  const LOCAL_HEALTH = LOCAL_BASE + '/health';

  let isRunning = false;

  // ─── Settings persistence ─────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    wsUrl: 'ws://localhost:29527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    engine: 'microsoft',
    ollamaUrl: 'http://127.0.0.1:11434',
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

    // New engine fields — restore from per-engine keys or defaults
    apiUrlInput.value = settings.openaiUrl || DEFAULT_SETTINGS.openaiUrl;
    apiKeyInput.value = settings.openaiKey || DEFAULT_SETTINGS.openaiKey;
    apiModelInput.value = settings.openaiModel || DEFAULT_SETTINGS.openaiModel;
    prevEngine = settings.engine || DEFAULT_SETTINGS.engine;
    // Migrate old empty ollamaModel to default
    if (!settings.ollamaModel) settings.ollamaModel = DEFAULT_SETTINGS.ollamaModel;
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
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen2.5:7b',
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
      serviceStatus.innerHTML = '<span class="status-dot"></span>本地服务';
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

  // Engine switching handled by custom dropdown via selectEngine()

  [sourceLangSelect].forEach(
    function (el) {
      el.addEventListener('change', function () { saveSettings(); syncPageLangEngine(); });
      el.addEventListener('input', saveSettings);
    }
  );

  // ─── API Key modal (for DeepL and OpenAI-compatible engines) ────────

  function showApiKeyModal(engine) {
    pendingApiEngine = engine;
    var isOpenAI = isOpenAIEngine(engine);
    var cfg = ENGINE_CONFIG[engine] || {};
    if (isOpenAI) {
      apiKeyModalTitle.innerHTML = (cfg.svg || '') + ' ' + cfg.label + ' API 设置';
      var preset = OPENAI_PRESETS[engine] || { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
      apiUrlInput.value = apiUrlInput.value || preset.url;
      apiModelInput.value = apiModelInput.value || preset.model;
      apiUrlGroup.style.display = '';
      apiModelGroup.style.display = '';
    } else {
      // DeepL
      apiKeyModalTitle.innerHTML = (cfg.svg || '') + ' ' + cfg.label + ' API 设置';
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
    renderEngineDropdown(pendingApiEngine);
    hideApiKeyModal();
    saveSettings();
    syncPageLangEngine();
  });

  apiKeyCancelBtn.addEventListener('click', function () {
    translateEngineSelect.value = prevEngine;
    renderEngineDropdown(prevEngine);
    hideApiKeyModal();
  });

  apiKeyModal.addEventListener('click', function (e) {
    if (e.target === apiKeyModal) {
      translateEngineSelect.value = prevEngine;
      renderEngineDropdown(prevEngine);
      hideApiKeyModal();
    }
  });

  // ─── Local model modal ──────────────────────────────────────────────

  function showLocalModelModal() {
    fetchModelStatus();
    localModelModal.style.display = 'flex';
  }

  function hideLocalModelModal(save) {
    localModelModal.style.display = 'none';
    if (save) {
      prevEngine = 'ollama';
      renderEngineDropdown('ollama');
      saveSettings();
      syncPageLangEngine();
    } else {
      translateEngineSelect.value = prevEngine;
      renderEngineDropdown(prevEngine);
    }
  }

  localModelConfirm.addEventListener('click', function () {
    hideLocalModelModal(true);
  });

  localModelCancel.addEventListener('click', function () {
    hideLocalModelModal(false);
  });

  localModelModal.addEventListener('click', function (e) {
    if (e.target === localModelModal) {
      hideLocalModelModal(false);
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
      pageOllamaUrl: 'http://127.0.0.1:11434',
      pageOllamaModel: customModel.value.trim() || '',
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
        ollamaUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'qwen2.5:7b',
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

  // ─── Local Service ──────────────────────────────────────────────
  let serviceWasRunning = false;

  async function checkLocalService() {
    if (expectingRestart) return;

    var localOk = false;
    try {
      var resp = await fetch(LOCAL_HEALTH);
      if (resp.ok) localOk = true;
    } catch (_) {}

    serviceWasRunning = localOk;

    if (localOk) {
      await sendTokenToLocalService();
      // Sync version + license from real health response
      try {
        var hResp = await fetch(LOCAL_HEALTH);
        if (hResp.ok) {
          var hData = await hResp.json();
          var runningVer = hData.version || '';
          if (runningVer) {
            await chrome.storage.local.set({ localVersion: runningVer });
          }
          updateServiceUI('running', '<span class="status-dot"></span>本地服务: v' + (runningVer || ''));
        }
      } catch (_) {}
      installBtn.style.display = 'none';
      serviceHint.style.display = '';
    } else {
      updateServiceUI('stopped', '<span class="status-dot"></span>本地服务: 未安装');
      installBtn.style.display = '';
      serviceHint.style.display = 'none';
    }

    checkRemoteVersion();
  }

  async function sendTokenToLocalService() {
    var storage = await chrome.storage.local.get(['authToken', 'userPlan']);
    var token = storage.authToken;
    if (!token) return;
    if (storage.userPlan !== 'premium') return;
    try {
      await fetch(LOCAL_BASE + '/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token }),
      });
    } catch (_) {}
  }

  // ─── Version check ─────────────────────────────────────────────────
  let latestVersion = '';

  async function checkRemoteVersion() {
    try {
      var verResp = await fetch(AUTH_API + '/api/version');
      if (verResp.ok) {
        var verData = await verResp.json();
        latestVersion = verData.version || '';
        var storage = await chrome.storage.local.get(['localVersion']);
        var localVer = storage.localVersion || '0.0.0';
        if (latestVersion && cmpVersion(latestVersion, localVer) > 0) {
          installBtn.style.display = '';
          serviceHint.style.display = 'none';
          installBtn.textContent = serviceWasRunning ? '更新 v' + latestVersion : '下载安装 (v' + latestVersion + ')';
        }
      }
    } catch (_) {}
  }

  function cmpVersion(a, b) {
    var pa = (a || '0.0.0').split('.').map(Number);
    var pb = (b || '0.0.0').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  // ─── Self-update flow (Chrome downloads API) ────────────────────────
  let expectingRestart = false;
  let activeDownloadId = null;
  let downloadProgressTimer = null;

  const INSTALLER_URLS = [
    'https://github.com/zm328876490-del/zilong-releases/releases/latest/download/installer.exe',
    'https://ghproxy.com/https://github.com/zm328876490-del/zilong-releases/releases/latest/download/installer.exe'
  ];

  function updateServiceUI(status, text) {
    serviceStatus.innerHTML = text;
    serviceStatus.className = 'service-status ' + status;
  }

  function showUpdateProgress(pct, detail) {
    updateProgressWrap.style.display = '';
    updateProgressFill.style.width = (pct || 0) + '%';
    updateProgressDetail.textContent = detail || '';
  }

  function hideUpdateProgress() {
    updateProgressWrap.style.display = 'none';
    clearInterval(downloadProgressTimer);
    downloadProgressTimer = null;
  }

  function pollChromeDownloadProgress() {
    if (downloadProgressTimer) clearInterval(downloadProgressTimer);
    downloadProgressTimer = setInterval(function () {
      if (activeDownloadId == null) return;
      chrome.downloads.search({ id: activeDownloadId }, function (results) {
        if (!results || results.length === 0) return;
        var dl = results[0];
        if (dl.state === 'complete') {
          clearInterval(downloadProgressTimer);
          downloadProgressTimer = null;
          showUpdateProgress(100, '下载完成，正在安装...');
          installBtn.style.display = 'none';
          serviceHint.style.display = '';
          expectingRestart = true;
          // Tell backend to run the installer silently
          var filePath = dl.filename;
          activeDownloadId = null;
          fetch(LOCAL_BASE + '/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
          }).catch(function () {});
          startRestartPolling();
        } else if (dl.state === 'interrupted') {
          clearInterval(downloadProgressTimer);
          downloadProgressTimer = null;
          activeDownloadId = null;
          hideUpdateProgress();
          updateServiceUI('error', '<span class="status-dot"></span>下载失败，请检查网络后重试');
          installBtn.style.display = '';
          serviceHint.style.display = 'none';
          installBtn.textContent = '重试更新';
          installBtn.disabled = false;
        } else if (dl.totalBytes > 0) {
          var pct = Math.round((dl.bytesReceived || 0) * 100 / dl.totalBytes);
          showUpdateProgress(pct, '正在下载更新 ' + pct + '%');
        } else if (dl.bytesReceived > 0) {
          showUpdateProgress(0, '正在下载更新 ' + formatBytes(dl.bytesReceived));
        }
      });
    }, 500);
  }

  function formatBytes(n) {
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(0) + 'KB';
    if (n < 1073741824) return (n / 1048576).toFixed(0) + 'MB';
    return (n / 1073741824).toFixed(1) + 'GB';
  }

  function startRestartPolling() {
    var attempts = 0;
    updateServiceUI('checking', '<span class="status-dot"></span>服务重启中...');
    var check = setInterval(function () {
      attempts++;
      fetch(LOCAL_HEALTH)
        .then(function (r) {
          if (r.ok) return r.json();
          return Promise.reject('not ok');
        })
        .then(function (data) {
          clearInterval(check);
          hideUpdateProgress();
          var newVer = data.version || '';
          if (newVer) {
            chrome.storage.local.set({ localVersion: newVer });
          }
          updateServiceUI('running', '<span class="status-dot"></span>本地服务: v' + (newVer || ''));
          installBtn.style.display = 'none';
          serviceHint.style.display = '';
          expectingRestart = false;
        })
        .catch(function () {
          if (attempts <= 2) {
            updateServiceUI('checking', '<span class="status-dot"></span>服务重启中...');
          } else if (attempts <= 15) {
            updateServiceUI('checking', '<span class="status-dot"></span>服务重启中' + '.'.repeat((attempts - 2) % 4));
          } else {
            clearInterval(check);
            hideUpdateProgress();
            updateServiceUI('stopped', '<span class="status-dot"></span>本地服务: 未安装');
            installBtn.style.display = '';
            serviceHint.style.display = 'none';
            installBtn.textContent = '下载安装程序';
            installBtn.disabled = false;
            expectingRestart = false;
          }
        });
    }, 1000);
  }

  async function startUpdate() {
    if (expectingRestart) return;
    if (_userPlan !== 'premium') {
      openAppPage('login');
      return;
    }
    installBtn.disabled = true;
    installBtn.textContent = '正在连接...';
    // Try each URL until one starts downloading
    for (var i = 0; i < INSTALLER_URLS.length; i++) {
      try {
        var dlId = await chrome.downloads.download({
          url: INSTALLER_URLS[i],
          filename: 'ai-translation-update.exe',
          conflictAction: 'overwrite',
          saveAs: false
        });
        activeDownloadId = dlId;
        showUpdateProgress(0, '正在下载更新 0%');
        installBtn.style.display = 'none';
        serviceHint.style.display = '';
        pollChromeDownloadProgress();
        return;
      } catch (e) {
        // chrome.downloads.download rejects on network error — try next URL
        if (i === INSTALLER_URLS.length - 1) {
          updateServiceUI('error', '<span class="status-dot"></span>下载启动失败，请检查网络');
          installBtn.textContent = '重试更新';
          installBtn.disabled = false;
        }
      }
    }
  }

  installBtn.addEventListener('click', startUpdate);

  // ─── Engine badge (custom dropdown, replaces old <select>) ──────────

  // ─── Login / Account links ──────────────────────────────────────────
  async function openAppPage(hash) {
    var url = chrome.runtime.getURL('app.html' + (hash ? '#' + hash : ''));
    try {
      var tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('app.html*') });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true, url: url });
      } else {
        await chrome.tabs.create({ url: url });
      }
    } catch (_) {
      // Fallback: try direct create
      try { await chrome.tabs.create({ url: url }); } catch (__) {}
    }
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

  var _userPlan = 'trial';

  // Update header based on login state
  function updateHeaderFromToken(token, plan) {
    _userPlan = plan || 'trial';
    if (token) {
      headerLicText.textContent = (plan === 'premium' ? '专业版' : '体验版') + ' · 已登录';
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
        var resp = await fetch(AUTH_API + '/api/auth/me', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (resp.ok) {
          var data = await resp.json();
          var serverPlan = data.plan || plan;
          updateHeaderFromToken(token, serverPlan);
          // Sync storage so content.js reads up-to-date plan
          if (serverPlan !== plan) {
            await chrome.storage.local.set({ userPlan: serverPlan });
          }
          return;
        }
        // Only clear on explicit 401 (token rejected by server)
        if (resp.status === 401) {
          await chrome.storage.local.remove(['authToken', 'userPlan']);
          updateHeaderFromToken(null, 'trial');
          return;
        }
      } catch (_) {}
      // Network error or server issue — keep existing login state
      updateHeaderFromToken(token, plan);
    }
    updateHeaderFromToken(null, 'trial');
  }

  function checkLicenseWarning() {
    if (!serviceWasRunning) return;
    if (_userPlan === 'premium') {
      // Already premium — ensure service status is clean
      return;
    }
    // Backend running but user not premium — show warning
    updateServiceUI('stopped', '<span class="status-dot"></span>本地服务: 翻译功能需专业版，请登录或升级');
    installBtn.style.display = '';
    serviceHint.style.display = 'none';
    installBtn.textContent = '登录/升级';
  }

  // ─── Model status ────────────────────────────────────────────────

  var _modelState = null;

  function updateModelStatus(msg) {
    _modelState = msg;

    // Update brief status in service card
    if (modelStatusBrief) {
      var briefPhase = msg.phase;
      if (briefPhase === 'ready') {
        var modelName = msg.model || '';
        modelStatusBrief.innerHTML = '<span class="status-dot"></span>本地模型: ' + (modelName || '');
        modelStatusBrief.className = 'model-status-brief running';
      } else if (briefPhase === 'error') {
        modelStatusBrief.innerHTML = '<span class="status-dot"></span>本地模型: 异常';
        modelStatusBrief.className = 'model-status-brief stopped';
      } else if (briefPhase === 'pulling_model' || briefPhase === 'downloading_ollama') {
        modelStatusBrief.innerHTML = '<span class="status-dot"></span>本地模型: 下载中 ' + (msg.progress || 0) + '%';
        modelStatusBrief.className = 'model-status-brief checking';
      } else {
        modelStatusBrief.innerHTML = '<span class="status-dot"></span>本地模型: 准备中...';
        modelStatusBrief.className = 'model-status-brief checking';
      }
      modelStatusBrief.style.display = '';
    }

    // Update detailed status in modal
    if (!modelStatus) return;
    modelStatus.style.display = '';

    var phase = msg.phase;
    var icon = '○';
    var text = msg.message || '';

    if (phase === 'ready') {
      icon = '●';
      modelStatusIcon.style.color = '#10b981';
      modelProgressWrap.style.display = 'none';
    } else if (phase === 'error') {
      icon = '✕';
      modelStatusIcon.style.color = '#ef4444';
      text = '准备失败 · 点此重试';
      modelProgressWrap.style.display = 'none';
    } else {
      icon = '◎';
      modelStatusIcon.style.color = '#f59e0b';
      var hasProgress = phase === 'pulling_model' || phase === 'downloading_ollama';
      if (hasProgress) {
        modelProgressWrap.style.display = '';
        modelProgressFill.style.width = (msg.progress || 0) + '%';
        var detail = '';
        if (msg.downloaded && msg.total) {
          detail = '已下载 ' + msg.downloaded + ' / ' + msg.total;
          if (msg.eta) detail += ' · 预计剩余 ' + msg.eta;
        }
        modelProgressDetail.textContent = detail;
      } else {
        modelProgressWrap.style.display = 'none';
      }
    }

    modelStatusIcon.textContent = icon;
    if (msg.model && (phase === 'ready' || phase === 'pulling_model' || phase === 'loading_model')) {
      modelStatusText.textContent = text + ' (' + msg.model + ')';
    } else {
      modelStatusText.textContent = text;
    }

    if (modelHardwareHint) {
      if (msg.gpuModel && msg.vramMB) {
        modelHardwareHint.textContent = '根据 GPU 自动选择: ' + msg.gpuModel + ' (' + Math.round(msg.vramMB / 1024) + 'GB)';
        modelHardwareHint.style.display = '';
      } else {
        modelHardwareHint.style.display = 'none';
      }
    }
  }

  function fetchModelStatus() {
    fetch(LOCAL_BASE + '/model/prepare/status')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (s) { updateModelStatus(s); })
      .catch(function () {});
  }

  modelStatus.addEventListener('click', function () {
    if (_modelState && _modelState.phase === 'error') {
      updateModelStatus({ phase: 'checking_ollama', message: '正在重试...' });
      fetchModelStatus();
    }
  });

  // ─── WS model_status handler ──────────────────────────────────────

  function handleModelStatus(msg) {
    updateModelStatus(msg);
  }

  // ─── Init ─────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    renderEngineDropdown(translateEngineSelect.value);
    await Promise.all([checkLocalService(), checkLoginState()]);
    checkLicenseWarning();
    fetchModelStatus();
    setInterval(fetchModelStatus, 2000);

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
