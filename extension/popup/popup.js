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

  [ollamaUrlInput].forEach(function (el) {
    el.addEventListener('change', function () { saveSettings(); checkOllamaStatus(); });
    el.addEventListener('input', function () { saveSettings(); });
  });
  ollamaModelInput.addEventListener('change', function () { saveSettings(); });

  function showOllamaModal() {
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

  // Ollama guide link
  ollamaGuideLink.addEventListener('click', function () {
    ollamaGuide.style.display = ollamaGuide.style.display === 'none' ? '' : 'none';
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
