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
  // Ollama management elements
  const ollamaStatusBar = document.getElementById('ollamaStatusBar');
  const ollamaStatusDot = document.getElementById('ollamaStatusDot');
  const ollamaStatusText = document.getElementById('ollamaStatusText');
  const ollamaGuideLink = document.getElementById('ollamaGuideLink');
  const ollamaGuide = document.getElementById('ollamaGuide');
  const ollamaModelInstall = document.getElementById('ollamaModelInstall');
  const ollamaModelCheckboxes = document.getElementById('ollamaModelCheckboxes');
  const btnPullModels = document.getElementById('btnPullModels');
  const pullProgress = document.getElementById('pullProgress');
  const pullProgressBar = document.getElementById('pullProgressBar');
  const pullProgressFill = document.getElementById('pullProgressFill');
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
  const versionBadge = document.getElementById('versionBadge');

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
      label: 'Ollama',
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
    prevEngine = engine;
    renderEngineDropdown(engine);
    if (engine === 'ollama') {
      showOllamaModal();
    } else if (isOpenAIEngine(engine) || engine === 'deepl') {
      showApiKeyModal(engine);
    } else {
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

  // ─── Ollama recommended models ────────────────────────────────────
  const RCMD_MODELS = [
    { name: 'qwen2.5:0.5b',  size: '0.4GB', quality: '差',   speed: '极快', scenario: '纯实验' },
    { name: 'qwen2.5:7b',    size: '4.7GB', quality: '良好', speed: '中等', scenario: '推荐日常使用 · 默认' },
    { name: 'qwen2.5:14b',   size: '8.9GB', quality: '优秀', speed: '较慢', scenario: '高质量需求' },
    { name: 'qwen2.5:32b',   size: '19GB',  quality: '极佳', speed: '慢',   scenario: '需高端显卡' },
    { name: 'llama3.1:8b',   size: '4.9GB', quality: '良好', speed: '中等', scenario: '英文→中文不错' },
    { name: 'gemma3:12b',    size: '8GB',   quality: '优秀', speed: '中等', scenario: '多语种翻译强' },
    { name: 'llava:7b',      size: '4GB',   quality: '—',   speed: '—',   scenario: '右键识别图片文字' },
  ];

  let _ollamaTimer = null;
  let _ollamaPostChecked = false;
  let pulling = false;

  function detectDeviceRAM() {
    try { const gb = navigator.deviceMemory; return typeof gb === 'number' && gb > 0 ? gb : null; } catch (_) { return null; }
  }

  function modelLevel(m) {
    const gb = parseFloat(m.size);
    if (gb <= 2) return 'light';
    if (gb <= 8) return 'mid';
    return 'heavy';
  }

  const AUTH_API = 'http://101.96.227.131/auth-server';
  const INSTALLER_URL = 'https://github.com/zm328876490-del/zilong-releases/releases/latest/download/installer.exe';
  const LOCAL_BASE = 'http://localhost:29527';
  const LOCAL_HEALTH = LOCAL_BASE + '/health';

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

  // Engine switching handled by custom dropdown via selectEngine()

  [sourceLangSelect].forEach(
    function (el) {
      el.addEventListener('change', function () { saveSettings(); syncPageLangEngine(); });
      el.addEventListener('input', saveSettings);
    }
  );

  [ollamaUrlInput].forEach(function (el) {
    el.addEventListener('change', function () { saveSettings(); checkOllamaStatus(); });
    el.addEventListener('input', function () { saveSettings(); });
  });
  ollamaModelInput.addEventListener('change', function () { saveSettings(); });

  function showOllamaModal() {
    var cfg = ENGINE_CONFIG['ollama'];
    document.getElementById('ollamaModalTitle').innerHTML = (cfg ? cfg.svg : '') + ' ' + cfg.label + ' 本地翻译';
    ollamaModal.style.display = 'flex';
    _ollamaPostChecked = false;
    checkOllamaStatus();
    // Auto-refresh models every 3 seconds
    _ollamaTimer = setInterval(checkOllamaStatus, 3000);
    // Check for ongoing background downloads
    checkOngoingDownloads();
  }

  function hideOllamaModal() {
    ollamaModal.style.display = 'none';
    if (_ollamaTimer) { clearInterval(_ollamaTimer); _ollamaTimer = null; }
    // Keep pull polling running in background (SW handles the actual download)
  }

  ollamaConfirmBtn.addEventListener('click', function () {
    prevEngine = 'ollama';
    renderEngineDropdown('ollama');
    hideOllamaModal();
    saveSettings();
    syncPageLangEngine();
  });

  ollamaCancelBtn.addEventListener('click', function () {
    translateEngineSelect.value = prevEngine;
    renderEngineDropdown(prevEngine);
    hideOllamaModal();
  });

  ollamaModal.addEventListener('click', function (e) {
    if (e.target === ollamaModal) {
      translateEngineSelect.value = prevEngine;
      renderEngineDropdown(prevEngine);
      hideOllamaModal();
    }
  });

  // Ollama guide link
  ollamaGuideLink.addEventListener('click', function () {
    ollamaGuide.style.display = ollamaGuide.style.display === 'none' ? '' : 'none';
  });

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

  // ─── Local Service ──────────────────────────────────────────────
  let latestVersion = '';
  let latestHash = '';

  async function checkLocalService() {
    serviceStatus.textContent = '检测中...';
    serviceStatus.className = 'service-status checking';
    var localOk = false;
    try {
      var resp = await fetch(LOCAL_HEALTH);
      if (resp.ok) localOk = true;
    } catch (_) {}

    var storage = await chrome.storage.local.get(['localVersion']);
    if (localOk) {
      var ver = storage.localVersion || '';
      serviceStatus.textContent = '本地服务: 运行中 ✅' + (ver ? ' v' + ver : '');
      serviceStatus.className = 'service-status running';
      sendTokenToLocalService();
      // Sync version + license from real health response
      try {
        var hResp = await fetch(LOCAL_HEALTH);
        if (hResp.ok) {
          var hData = await hResp.json();
          var runningVer = hData.version || '';
          var lic = hData.licensed;
          var plan = hData.plan || '';
          if (runningVer && runningVer !== storage.localVersion) {
            await chrome.storage.local.set({ localVersion: runningVer });
            ver = runningVer;
          }
          if (!lic) {
            serviceStatus.textContent = '本地服务: 运行中 ⚠️ 未激活' + (ver ? ' v' + ver : '');
            serviceStatus.className = 'service-status unlicensed';
          } else {
            serviceStatus.textContent = '本地服务: 运行中 ✅ 已激活' + (ver ? ' v' + ver : '');
          }
        }
      } catch (_) {}
      installBtn.style.display = 'none';
    } else {
      serviceStatus.textContent = '本地服务: 未安装';
      serviceStatus.className = 'service-status stopped';
      installBtn.style.display = '';
    }

    // Version check
    try {
      var verResp = await fetch(AUTH_API + '/api/version');
      if (verResp.ok) {
        var verData = await verResp.json();
        latestVersion = verData.version || '';
        var storage = await chrome.storage.local.get(['localVersion']);
        var localVer = storage.localVersion || '0.0.0';
        if (latestVersion && cmpVersion(latestVersion, localVer) > 0) {
          installBtn.style.display = '';
          installBtn.textContent = localOk ? '更新 v' + latestVersion : '下载安装 (v' + latestVersion + ')';
          if (localOk) versionBadge.style.display = '';
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

  let activeDownloadId = null;
  let progressTimer = null;

  function pollProgress() {
    if (activeDownloadId == null) { clearInterval(progressTimer); return; }
    chrome.downloads.search({ id: activeDownloadId }, function (results) {
      if (results.length === 0) return;
      var item = results[0];
      if (item.state === 'complete') {
        clearInterval(progressTimer);
        progressTimer = null;
        chrome.downloads.open(activeDownloadId);
        if (latestVersion) chrome.storage.local.set({ localVersion: latestVersion });
        versionBadge.style.display = 'none';
        activeDownloadId = null;
        installBtn.textContent = '下载安装程序';
        installBtn.disabled = false;
      } else if (item.state === 'interrupted') {
        clearInterval(progressTimer);
        progressTimer = null;
        activeDownloadId = null;
        installBtn.textContent = '下载安装程序';
        installBtn.disabled = false;
      } else if (item.totalBytes > 0) {
        var pct = Math.round(item.bytesReceived / item.totalBytes * 100);
        installBtn.textContent = '下载中 ' + pct + '%';
      }
    });
  }

  function restoreDownloadState() {
    chrome.downloads.search({ state: 'in_progress', filenameRegex: 'AI-Translation-Installer' }, function (results) {
      if (results.length > 0) {
        activeDownloadId = results[0].id;
        pollProgress();
        progressTimer = setInterval(pollProgress, 500);
        installBtn.disabled = true;
        installBtn.style.display = '';
      }
    });
  }

  installBtn.addEventListener('click', async function () {
    installBtn.textContent = '开始下载...';
    installBtn.disabled = true;

    try {
      activeDownloadId = await chrome.downloads.download({
        url: INSTALLER_URL,
        filename: 'AI-Translation-Installer-v' + (latestVersion || 'latest') + '.exe',
        saveAs: false,
      });
      pollProgress();
      progressTimer = setInterval(pollProgress, 500);
    } catch (e) {
      alert('下载失败: ' + (e.message || '网络错误'));
      installBtn.textContent = '下载安装程序';
      installBtn.disabled = false;
      activeDownloadId = null;
    }
  });

  // ─── Engine badge (custom dropdown, replaces old <select>) ──────────

  // ─── Login / Account links ──────────────────────────────────────────
  function openAppPage(hash) {
    var url = chrome.runtime.getURL('app.html' + (hash ? '#' + hash : ''));
    chrome.tabs.query({ url: chrome.runtime.getURL('app.html*') }, function (tabs) {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true, url: url });
      } else {
        chrome.tabs.create({ url: url });
      }
    });
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
          updateHeaderFromToken(token, data.plan || plan);
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

  // ─── Ollama management ───────────────────────────────────────────

  async function checkOllamaStatus() {
    if (!ollamaStatusDot || !ollamaStatusText || !ollamaGuideLink || !ollamaGuide) return;
    const urlInput = document.getElementById('ollamaUrl');
    const baseUrl = (urlInput?.value || 'http://localhost:11434').replace(/\/$/, '');
    try {
      const resp = await fetch(baseUrl + '/api/tags', { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json();
        const allModels = (data.models || []).map(function (m) { return m.name; });

        // Populate model select
        var result = await chrome.storage.local.get('translationSettings');
        var settings = result.translationSettings || {};
        var savedModel = settings.ollamaModel || 'qwen2.5:7b';
        if (allModels.length === 0) {
          ollamaModelInput.innerHTML = '<option value="">请先拉取模型</option>';
        } else {
          ollamaModelInput.innerHTML = allModels.map(function (n) {
            var clean = n.replace(/:latest$/, '');
            var selected = (clean === savedModel || n === savedModel) ? ' selected' : '';
            return '<option value="' + n + '"' + selected + '>' + n + '</option>';
          }).join('');
          // Auto-select first if saved model not found
          if (!allModels.some(function (n) { return n.replace(/:latest$/, '') === savedModel || n === savedModel; })) {
            ollamaModelInput.value = allModels[0];
          }
        }

        // Refresh recommended models
        renderModelInstallList(allModels);

        // Status bar
        var showModels = allModels.slice(0, 3);
        ollamaStatusDot.style.background = '#10b981';
        ollamaStatusText.textContent = showModels.length > 0
          ? '已连接 · ' + showModels.join(', ') : '已连接 · 无本地模型';
        if (ollamaStatusBar) ollamaStatusBar.style.background = 'rgba(209,250,229,0.6)';
        ollamaGuideLink.style.display = 'inline';
        ollamaGuide.style.display = 'none';

        // Test POST endpoint once
        if (!_ollamaPostChecked) {
          _ollamaPostChecked = true;
          testOllamaPost(baseUrl);
        }
        return;
      }
    } catch (_) {}
    // Not connected
    ollamaStatusDot.style.background = '#ef4444';
    ollamaStatusText.textContent = '未检测到本地服务';
    if (ollamaStatusBar) ollamaStatusBar.style.background = 'rgba(255,255,255,0.6)';
    ollamaGuideLink.style.display = 'inline';
  }

  async function testOllamaPost(baseUrl) {
    try {
      var resp = await fetch(baseUrl + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: '', prompt: '', stream: false }),
        signal: AbortSignal.timeout(3000)
      });
      if (resp.status === 403) {
        ollamaStatusDot.style.background = '#f59e0b';
        ollamaStatusText.textContent = '⚠️ POST 被拒 — 请设置 OLLAMA_ORIGINS=* 后重启 Ollama';
        if (ollamaStatusBar) ollamaStatusBar.style.background = 'rgba(254,243,199,0.8)';
        ollamaGuideLink.style.display = 'inline';
      }
    } catch (_) {}
  }

  function renderModelInstallList(installed) {
    if (!ollamaModelInstall || !ollamaModelCheckboxes) return;
    var installedSet = new Set((installed || []).map(function (m) { return m.replace(/:latest$/, ''); }));
    var hasMissing = RCMD_MODELS.some(function (m) { return !installedSet.has(m.name); });
    ollamaModelInstall.style.display = hasMissing ? 'block' : 'none';
    if (!hasMissing) return;

    var ram = detectDeviceRAM();
    var checkedBefore = new Set();
    ollamaModelCheckboxes.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) { checkedBefore.add(cb.value); });

    ollamaModelCheckboxes.innerHTML = RCMD_MODELS.map(function (m) {
      var ok = installedSet.has(m.name);
      var lv = modelLevel(m);
      var tagColor = lv === 'light' ? '#10b981' : lv === 'heavy' ? '#f59e0b' : '#6366f1';
      var ramWarn = '';
      if (ram && !ok) {
        var gb = parseFloat(m.size);
        if (gb > ram * 0.6) ramWarn = ' <span style="font-size:10px;color:#ef4444;">⚠️ 内存不足</span>';
      }

      if (ok) {
        return '<div style="padding:4px 0;border-bottom:1px solid rgba(0,0,0,0.04);">' +
          '<div style="display:flex;align-items:center;">' +
          '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#10b9811a;color:#10b981;flex-shrink:0;margin-right:6px;">已安装</span>' +
          '<b style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.name + '</b>' +
          '<span style="font-size:10px;color:#9ca3af;flex-shrink:0;">' + m.size + '</span>' +
          '</div>' +
          '<div style="margin-top:2px;margin-left:18px;">' +
          '<button data-delete-model="' + m.name + '" style="padding:1px 6px;border:1px solid rgba(239,68,68,0.3);border-radius:4px;background:rgba(254,226,226,0.6);color:#dc2626;font-size:10px;cursor:pointer;flex-shrink:0;line-height:1.4;">删除</button>' +
          '</div>' +
          '</div>';
      }

      return '<div style="padding:4px 0;border-bottom:1px solid rgba(0,0,0,0.04);">' +
        '<label style="display:flex;align-items:center;cursor:pointer;">' +
        '<input type="checkbox" value="' + m.name + '" style="accent-color:#6366f1;flex-shrink:0;margin-right:6px;">' +
        '<b style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.name + '</b>' +
        '<span style="font-size:10px;color:#9ca3af;flex-shrink:0;">' + m.size + '</span>' +
        '</label>' +
        '<div style="font-size:9px;margin-left:18px;margin-top:1px;">' +
        '<span style="padding:1px 5px;border-radius:3px;background:' + tagColor + '1a;color:' + tagColor + ';white-space:nowrap;">' + m.scenario + '</span>' +
        (ramWarn ? ramWarn : '') +
        '</div>' +
        '</div>';
    }).join('');

    // Wire delete buttons
    ollamaModelCheckboxes.querySelectorAll('[data-delete-model]').forEach(function (btn) {
      btn.onclick = function (e) {
        e.preventDefault();
        deleteModel(btn.dataset.deleteModel);
      };
    });

    // Restore checked state
    ollamaModelCheckboxes.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      if (checkedBefore.has(cb.value)) cb.checked = true;
    });

    // RAM info
    if (ram) {
      var info = document.createElement('div');
      info.style.cssText = 'font-size:10px;color:#9ca3af;margin-top:6px;padding-top:4px;';
      info.textContent = '⚡ 本机内存 ' + ram + 'GB，⚠️ 标注的大模型需充足显存';
      ollamaModelCheckboxes.appendChild(info);
    }

    if (btnPullModels) btnPullModels.disabled = false;
  }

  async function deleteModel(name) {
    if (!confirm('确认删除模型 ' + name + ' ？\n\n删除后需重新拉取才能使用。')) return;
    var urlInput = document.getElementById('ollamaUrl');
    var baseUrl = (urlInput?.value || 'http://localhost:11434').replace(/\/$/, '');
    try {
      if (pullProgressBar) pullProgressBar.style.display = 'none';
      if (pullProgress) { pullProgress.style.display = 'block'; pullProgress.textContent = '正在删除 ' + name + ' ...'; }
      var resp = await chrome.runtime.sendMessage({ type: 'OLLAMA_DELETE', baseUrl: baseUrl, model: name });
      if (!resp?.success) throw new Error(resp?.error || '未知错误');
      if (pullProgress) pullProgress.textContent = name + ' 已删除';
      await checkOllamaStatus();
      setTimeout(function () { if (pullProgress) pullProgress.style.display = 'none'; }, 2000);
    } catch (e) {
      if (pullProgress) pullProgress.textContent = '删除失败: ' + e.message;
    }
  }

  var _pullTimer = null;
  var _pullNames = [];

  btnPullModels.addEventListener('click', pullSelectedModels);

  async function pullSelectedModels() {
    if (pulling) return;
    var urlInput = document.getElementById('ollamaUrl');
    var baseUrl = (urlInput?.value || 'http://localhost:11434').replace(/\/$/, '');
    var names = [];
    document.querySelectorAll('#ollamaModelCheckboxes input[type=checkbox]:checked:not([disabled])').forEach(function (cb) {
      names.push(cb.value);
    });
    if (!names.length) return;
    pulling = true;
    _pullNames = names.slice();
    if (btnPullModels) { btnPullModels.disabled = true; btnPullModels.textContent = '拉取中...'; }
    if (pullProgress) { pullProgress.style.display = 'block'; pullProgress.textContent = '已提交 ' + names.length + ' 个下载任务到后台...'; }
    if (pullProgressBar) { pullProgressBar.style.display = 'block'; pullProgressFill.style.width = '0%'; }

    // Send all pull requests to background SW (runs even if popup closes)
    for (var i = 0; i < names.length; i++) {
      chrome.runtime.sendMessage({ type: 'OLLAMA_PULL_START', baseUrl: baseUrl, model: names[i] }, function () {});
    }

    // Start polling for progress
    startPullPolling();
  }

  async function checkOngoingDownloads() {
    try {
      var resp = await chrome.runtime.sendMessage({ type: 'OLLAMA_PULL_PROGRESS' });
      var downloads = resp?.downloads || {};
      var pullingNames = Object.keys(downloads).filter(function (n) { return downloads[n].status === 'pulling'; });
      if (pullingNames.length > 0) {
        // Resume UI state for ongoing downloads
        pulling = true;
        _pullNames = pullingNames;
        if (btnPullModels) { btnPullModels.disabled = true; btnPullModels.textContent = '拉取中...'; }
        if (pullProgress) { pullProgress.style.display = 'block'; }
        if (pullProgressBar) { pullProgressBar.style.display = 'block'; }
        startPullPolling();
      }
    } catch (_) {}
  }

  function startPullPolling() {
    if (_pullTimer) clearInterval(_pullTimer);
    _pullTimer = setInterval(pollPullProgress, 500);
  }

  async function pollPullProgress() {
    try {
      var resp = await chrome.runtime.sendMessage({ type: 'OLLAMA_PULL_PROGRESS' });
      var downloads = resp?.downloads || {};

      // Check for ongoing downloads from _pullNames, or any downloads in progress
      var allNames = Object.keys(downloads);
      if (allNames.length === 0) {
        // Check if _pullNames were cleaned up; if all models now installed, refresh
        if (_pullNames.length > 0) {
          stopPullPolling();
          await checkOllamaStatus();
        }
        return;
      }

      // Show progress for pulling models
      var pullingNames = allNames.filter(function (n) { return downloads[n].status === 'pulling'; });
      var doneNames = allNames.filter(function (n) { return downloads[n].status === 'success'; });
      var errorNames = allNames.filter(function (n) { return downloads[n].status === 'error'; });

      // Find the first pulling model to show progress bar for
      var active = pullingNames.length > 0 ? pullingNames[0] : (doneNames.length > 0 ? doneNames[doneNames.length - 1] : null);
      if (active && downloads[active]) {
        var d = downloads[active];
        if (pullProgressFill) pullProgressFill.style.width = (d.pct || 0) + '%';
        if (pullProgress) pullProgress.textContent = '下载中 ' + active + ' ' + (d.pct || 0) + '%';
        if (pullProgressBar) pullProgressBar.style.display = 'block';
      }

      // All done?
      if (pullingNames.length === 0) {
        if (errorNames.length > 0 && pullProgress) {
          var has403 = errorNames.some(function (n) { return downloads[n].error && downloads[n].error.indexOf('403') !== -1; });
          if (has403) {
            pullProgress.innerHTML = '<span style="color:#dc2626;">⚠️ 403 拒绝访问 — 请设置环境变量 OLLAMA_ORIGINS=* 后重启 Ollama</span>';
          } else {
            pullProgress.innerHTML = '<span style="color:#dc2626;">⚠️ 部分模型拉取失败：' + errorNames.join(', ') + '</span>';
          }
        }
        stopPullPolling();
        await checkOllamaStatus();
      }
    } catch (_) {}
  }

  function stopPullPolling() {
    if (_pullTimer) { clearInterval(_pullTimer); _pullTimer = null; }
    pulling = false;
    _pullNames = [];
    if (btnPullModels) { btnPullModels.disabled = false; btnPullModels.textContent = '拉取选中模型'; }
    if (pullProgressBar) pullProgressBar.style.display = 'none';
    if (pullProgress && !pulling) {
      // Keep text visible briefly then hide
      setTimeout(function () { if (pullProgress && !pulling) pullProgress.style.display = 'none'; }, 3000);
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    renderEngineDropdown(translateEngineSelect.value);
    checkLocalService();
    restoreDownloadState();
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
