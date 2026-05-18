// content.js - Injected into every page
// Manages: subtitle overlay, audio capture via video.captureStream(),
// WebSocket connection to Go backend, TTS via speechSynthesis.

(function () {
  'use strict';

  // Prevent double injection
  if (window.__ai_translation_loaded__) return;
  window.__ai_translation_loaded__ = true;

  // ─── Configuration ────────────────────────────────────────────────
  let ws = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let isRunning = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 5;

  // Settings (updated via popup messages)
  let settings = {
    wsUrl: 'ws://localhost:9527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    apiKey: '',
    region: 'eastasia',
    engine: 'microsoft',
    ttsVoice: 'default',
  };

  // ─── Sync mode state (subtitle hijacking) ───────────────────────────
  let syncMode = false;           // true = subtitle sync mode, false = ASR mode
  let pendingSubs = null;         // extracted subtitles waiting for WS to connect
  let preprocessedItems = [];     // [{original, translation, audioB64, start, end, played, audioEl}]
  let syncRafId = null;           // requestAnimationFrame ID
  let lastSyncTime = 0;           // last video.currentTime
  let syncVideo = null;           // the video element being synced to
  let currentSyncAudio = null;    // (managed by queue, kept for backward compat)

  // DOM subtitle observer state
  let subtitleMode = false;       // true = DOM caption extraction mode
  let domObserver = null;         // MutationObserver for caption elements
  let ccClickHandler = null;      // capture-phase click handler on CC button
  let ccClickTarget = null;       // CC button element the handler is attached to
  let ccAttrObserver = null;      // watches aria-pressed, re-enables CC if YouTube resets it
  let captionStyleEl = null;      // (unused, kept for compat)
  let lastDOMSubtitle = '';       // deduplicate consecutive identical captions

  // ─── Loading Overlay (shown during warmup, auto-hides on first TTS) ──
  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = '__ai_loading_overlay__';
  loadingOverlay.innerHTML = `
    <style>
      #__ai_loading_overlay__ {
        position: fixed !important; inset: 0 !important;
        z-index: 2147483646 !important;
        background: rgba(0, 0, 0, 0.75) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: -apple-system, 'Microsoft YaHei', 'PingFang SC', sans-serif !important;
        pointer-events: all !important;
      }
      #__ai_loading_overlay__ .spinner {
        width: 48px; height: 48px;
        border: 4px solid rgba(255,255,255,0.2);
        border-top-color: #6366f1;
        border-radius: 50%;
        animation: __spin__ 0.8s linear infinite;
      }
      @keyframes __spin__ { to { transform: rotate(360deg); } }
      #__ai_loading_overlay__ .loading-text {
        color: #fff; font-size: 15px; margin-top: 16px;
        font-weight: 500; letter-spacing: 0.5px;
      }
      #__ai_loading_overlay__ .loading-sub {
        color: rgba(255,255,255,0.5); font-size: 12px; margin-top: 6px;
      }
    </style>
    <div class="spinner"></div>
    <div class="loading-text">AI 翻译准备中...</div>
    <div class="loading-sub">首次加载需要预热线，请稍候</div>
  `;

  // ─── Subtitle Overlay ─────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__ai_subtitle_overlay__';
  overlay.innerHTML = `
    <style>
      #__ai_subtitle_overlay__ {
        position: fixed !important;
        bottom: 100px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        font-family: -apple-system, 'Microsoft YaHei', 'PingFang SC', sans-serif !important;
        text-align: center !important;
        transition: opacity 0.3s !important;
        max-width: 85vw !important;
      }
      #__ai_subtitle_overlay__ .subtitle-box {
        background: rgba(0, 0, 0, 0.78) !important;
        padding: 10px 22px !important;
        border-radius: 10px !important;
        display: inline-block !important;
        opacity: 1 !important;
	        transition: opacity 0.2s ease-out !important;
      }
      #__ai_subtitle_overlay__ .subtitle-line {
        color: #fff !important;
        text-shadow: 0 1px 3px rgba(0,0,0,0.5) !important;
        word-break: break-word !important;
        line-height: 1.5 !important;
        letter-spacing: 0.5px !important;
        text-align: center !important;
      }
      #__ai_subtitle_overlay__ .subtitle-original {
        font-size: 16px !important;
        opacity: 0.85 !important;
        margin-bottom: 2px !important;
      }
      #__ai_subtitle_overlay__ .subtitle-translation {
        font-size: 20px !important;
        font-weight: 500 !important;
      }
      #__ai_subtitle_overlay__ .subtitle-speaker {
        display: inline-block !important;
        background: rgba(99, 102, 241, 0.85) !important;
        color: #fff !important;
        padding: 2px 10px !important;
        border-radius: 12px !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        letter-spacing: 0.5px !important;
        margin-bottom: 2px !important;
      }
    </style>
    <div id="__subtitle_content__"></div>
  `;
  document.body.appendChild(overlay);

  const contentDiv = overlay.querySelector('#__subtitle_content__');

  // Persistent DOM elements (reused, not recreated)
  let speakerEl = null;
  let subtitleBox = null;
  let originalLine = null;
  let translationLine = null;
  let lastSpeaker = '';

  function ensureElements() {
    if (subtitleBox) return;
    speakerEl = document.createElement('div');
    speakerEl.className = 'subtitle-speaker';
    speakerEl.style.display = 'none';
    subtitleBox = document.createElement('div');
    subtitleBox.className = 'subtitle-box';
    subtitleBox.style.opacity = '0';
    originalLine = document.createElement('div');
    originalLine.className = 'subtitle-line subtitle-original';
    translationLine = document.createElement('div');
    translationLine.className = 'subtitle-line subtitle-translation';
    subtitleBox.appendChild(originalLine);
    subtitleBox.appendChild(translationLine);
    contentDiv.appendChild(speakerEl);
    contentDiv.appendChild(subtitleBox);
  }

  function showSubtitle(original, translation, speaker) {
    // Filter YouTube CC track-name announcements from display
    if (original && isCCAnnouncement(original)) original = '';
    if (translation && isCCAnnouncement(translation)) translation = '';

    ensureElements();

    // Update speaker
    if (speaker && speaker !== lastSpeaker) {
      lastSpeaker = speaker;
      speakerEl.textContent = 'Speaker ' + speaker;
      speakerEl.style.display = 'inline-block';
    } else if (!speaker) {
      speakerEl.style.display = 'none';
    }

    // Update text content (no DOM rebuild, no animation replay)
    const hasContent = original || translation;
    if (hasContent) {
      originalLine.textContent = original || '';
      translationLine.textContent = translation || '';
      subtitleBox.style.display = 'inline-block';
      subtitleBox.style.opacity = '1';
    } else {
      subtitleBox.style.opacity = '0';
    }

    // Auto-clear after 5 seconds (fade out via transition)
    clearTimeout(contentDiv._clearTimer);
    contentDiv._clearTimer = setTimeout(() => {
      subtitleBox.style.opacity = '0';
      speakerEl.style.display = 'none';
      lastSpeaker = '';
    }, 5000);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // YouTube CC track-name accessibility announcements that slip through ASR
  function isCCAnnouncement(text) {
    if (!text) return false;
    // Match patterns like "英语（自动生成）点击 查看设置" or "English (auto-generated)..."
    return /(?:自动生成|auto.generated|字幕.*设置|字幕.*点击|查看设置|cc.*settings)/i.test(text)
        && text.length < 50;
  }

  // ─── TTS (queue-based playback, no cutting) ──────────────────────
  let lastSpokenText = '';
  let ttsAudio = null;
  let ttsAudioUrl = null;

  const TTS_RATE = 1.3;  // fixed playback speed

  // TTS chunk accumulation (for streaming TTS via handleAudioStart/Chunk/End)
  let ttsFallbackChunks = [];

  // Playback queue — sequential, no cutting
  let ttsQueue = [];
  let ttsPlaying = false;

  function playNextInQueue() {
    if (ttsQueue.length === 0) {
      ttsPlaying = false;
      ttsAudio = null;
      ttsAudioUrl = null;
      return;
    }
    ttsPlaying = true;
    const item = ttsQueue.shift();
    ttsAudio = item.audio;
    ttsAudioUrl = item.url;
    item.audio.onended = () => {
      URL.revokeObjectURL(item.url);
      playNextInQueue();
    };
    item.audio.play().catch(() => {
      URL.revokeObjectURL(item.url);
      playNextInQueue();
    });
  }

  function enqueueAudio(audio, url) {
    // Limit queue depth to prevent unbounded lag
    while (ttsQueue.length >= 2) {
      const old = ttsQueue.shift();
      URL.revokeObjectURL(old.url);
    }
    ttsQueue.push({ audio, url });
    if (!ttsPlaying) {
      playNextInQueue();
    }
  }

  function playTTSAudio(base64, mimeType, text, speechRate) {
    if (!base64 || text === lastSpokenText) return;
    if (isCCAnnouncement(text)) return;
    lastSpokenText = text;
    const url = `data:${mimeType};base64,${base64}`;
    const audio = new Audio(url);
    audio.volume = 0.9;
    audio.playbackRate = TTS_RATE;
    enqueueAudio(audio, url);
  }

  function stopTTS() {
    // Stop currently playing audio
    if (ttsAudio) {
      ttsAudio.onended = null;
      try { ttsAudio.src = ''; } catch (_) {}
      try { ttsAudio.pause(); } catch (_) {}
      ttsAudio = null;
    }
    if (ttsAudioUrl) {
      try { URL.revokeObjectURL(ttsAudioUrl); } catch (_) {}
      ttsAudioUrl = null;
    }
    // Clear queued items
    for (const item of ttsQueue) {
      URL.revokeObjectURL(item.url);
    }
    ttsQueue = [];
    ttsPlaying = false;
    ttsFallbackChunks = [];
  }

  // ─── Streaming TTS handlers (queue-based, no MSE) ─────────────────

  function handleAudioStart(msg) {
    lastSpokenText = msg.original;
    ttsFallbackChunks = [];
  }

  function handleAudioChunk(msg) {
    if (!msg.audio) return;
    if (msg.original && msg.original !== lastSpokenText) return;
    const binary = atob(msg.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ttsFallbackChunks.push(bytes);
  }

  function handleAudioEnd(msg) {
    if (msg.original && msg.original !== lastSpokenText) return;
    if (ttsFallbackChunks.length > 0) {
      const blob = new Blob(ttsFallbackChunks, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = 0.9;
      audio.playbackRate = TTS_RATE;
      enqueueAudio(audio, url);
    }
    ttsFallbackChunks = [];
    finishWarmup();
  }

  // ─── Google Translate via browser fetch ───────────────────────────

  function mapGoogleLang(lang) {
    const m = {
      'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'zh': 'zh-CN',
      'en': 'en', 'ja': 'ja', 'ko': 'ko', 'fr': 'fr', 'de': 'de',
      'es': 'es', 'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'th': 'th', 'vi': 'vi',
    };
    return m[lang] || lang;
  }

  async function handleTranslateRequest(msg) {
    const tl = mapGoogleLang(msg.targetLang || settings.targetLang);
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl='
      + encodeURIComponent(tl) + '&q=' + encodeURIComponent(msg.text || '');

    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        let translation = '';
        if (Array.isArray(data) && Array.isArray(data[0])) {
          translation = data[0].map(function (seg) {
            return Array.isArray(seg) ? (seg[0] || '') : '';
          }).join('');
        }
        ws.send(JSON.stringify({
          type: 'translate_response',
          id: msg.id,
          translation: translation,
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'translate_response',
          id: msg.id,
          error: 'HTTP ' + resp.status,
        }));
      }
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'translate_response',
        id: msg.id,
        error: e.message,
      }));
    }
  }

  // ─── Audio Capture ────────────────────────────────────────────────
  function findVideoElement() {
    // Prefer the largest playing video
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    return videos
      .filter((v) => v.duration > 0 && !v.paused)
      .sort((a, b) => {
        const areaA = a.videoWidth * a.videoHeight;
        const areaB = b.videoWidth * b.videoHeight;
        return areaB - areaA;
      })[0] || videos[0];
  }


  // ─── DOM Subtitle Observer (YouTube caption element scraping) ──────────
  // Watches YouTube's built-in caption display elements and extracts text
  // in real-time. This bypasses YouTube's timedtext API blocks.

  function canObserveDOMSubtitles() {
    var player = document.querySelector("#movie_player") ||
                 document.querySelector(".html5-video-player");
    return !!player;
  }

  function silentClickCC(btn) {
    var synth = window.speechSynthesis;
    synth.cancel();
    var orig = synth.speak;
    synth.speak = function () {};
    btn.click();
    setTimeout(function () { synth.speak = orig; }, 800);
  }

  function startDOMSubtitleObserver() {
    var player = document.querySelector('#movie_player') ||
                 document.querySelector('.html5-video-player');
    if (!player) {
      return false;
    }

    // Force CC on
    var ccBtn = player.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
      silentClickCC(ccBtn);
    }

    // Prevent user from turning CC off during translation.
    // Use capture-phase click interception so YouTube's native handler
    // never fires — avoids the subtitle-track announcement entirely.
    if (ccBtn) {
      ccClickHandler = function (e) {
        var btn = player.querySelector('.ytp-subtitles-button');
        if (btn && btn.getAttribute('aria-pressed') === 'true') {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      };
      ccClickTarget = ccBtn;
      ccBtn.addEventListener('click', ccClickHandler, true);
    }

    // Watch CC button state — YouTube may reset it after ads or player rebinds.
    // Re-enable silently whenever it flips off.
    if (ccBtn) {
      if (ccAttrObserver) ccAttrObserver.disconnect();
      ccAttrObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type === 'attributes' && m.attributeName === 'aria-pressed') {
            var b = m.target;
            if (b.getAttribute('aria-pressed') === 'false' && subtitleMode && isRunning) {
              silentClickCC(b);
            }
          }
        }
      });
      ccAttrObserver.observe(ccBtn, { attributes: true, attributeFilter: ['aria-pressed'] });
    }

    // Native captions remain visible — overlay sits below the video

    function getCurrentCaptionText() {
      // YouTube caption segments
      var segments = player.querySelectorAll('.ytp-caption-segment');
      if (segments.length === 0) {
        segments = player.querySelectorAll('.caption-window span');
      }
      var texts = [];
      for (var i = 0; i < segments.length; i++) {
        var t = (segments[i].textContent || '').trim();
        if (t) texts.push(t);
      }
      return texts.join(' ');
    }

    function checkAndSend() {
      if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;
      var text = getCurrentCaptionText();
      if (isCCAnnouncement(text)) return;
      if (text && text !== lastDOMSubtitle && text.length >= 2) {
        lastDOMSubtitle = text;
        showSubtitle(text, null);
        ws.send(JSON.stringify({ type: 'subtitle', text: text }));
      }
    }

    // Throttle to avoid spamming during rapid updates
    var throttleTimer = null;
    var lastCheckTime = 0;
    function throttledCheck() {
      var now = Date.now();
      if (now - lastCheckTime > 150) {
        lastCheckTime = now;
        checkAndSend();
      } else {
        clearTimeout(throttleTimer);
        throttleTimer = setTimeout(checkAndSend, 150);
      }
    }

    domObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        // Text content changes in caption segments
        if (m.type === 'characterData') {
          var parent = m.target.parentElement;
          if (parent && (parent.classList.contains('ytp-caption-segment') ||
              (parent.closest && parent.closest('.caption-window')))) {
            throttledCheck();
            return;
          }
        }
        // New nodes added
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.classList && (node.classList.contains('caption-window') ||
              node.classList.contains('ytp-caption-segment'))) {
            throttledCheck();
            return;
          }
          if (node.querySelectorAll) {
            var segs = node.querySelectorAll('.ytp-caption-segment, .caption-window');
            if (segs.length > 0) {
              throttledCheck();
              return;
            }
          }
        }
      }
    });

    domObserver.observe(player, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Initial check
    setTimeout(checkAndSend, 500);
    return true;
  }

  function stopDOMSubtitleObserver() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (ccClickHandler && ccClickTarget) {
      ccClickTarget.removeEventListener('click', ccClickHandler, true);
      ccClickHandler = null;
      ccClickTarget = null;
    }
    if (ccAttrObserver) {
      ccAttrObserver.disconnect();
      ccAttrObserver = null;
    }
    lastDOMSubtitle = '';
    subtitleMode = false;
  }


  // ─── Subtitle Extraction ───────────────────────────────────────────
  // Content scripts run in ISOLATED world by default, so we can't read
  // window.ytInitialPlayerResponse / __INITIAL_STATE__ directly.
  // Instead we inject a tiny script into MAIN world that posts the data
  // back via a CustomEvent on document (DOM is shared between worlds).

  async function extractSubtitles() {
    const host = location.hostname;
    if (host.includes('bilibili.com')) return extractBilibiliSubs();
    return extractTextTrackSubs();
  }

  // readPageVar finds a <script> tag containing the given JS variable name,
  // reads its textContent (CSP only blocks execution, not textContent reading),
  // and extracts the JSON value using a regex.
  function readPageVar(varName) {
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent || '';
      if (text.indexOf(varName) === -1) continue;
      // Extract the JSON: var varName = {...}; or window.varName = {...};
      var re = new RegExp('(?:window\\.)?' + varName.replace(/\$/g, '\\$') + '\\s*=\\s*(\\{[\\s\\S]*?\\});');
      var m = text.match(re);
      if (!m) continue;
      try {
        return JSON.parse(m[1]);
      } catch (_) {
        // The JSON might be too large or contain trailing data; try a simpler approach
        return null;
      }
    }
    return null;
  }

  async function extractBilibiliSubs() {
    // Step 1: try reading subtitle URL from page's __INITIAL_STATE__
    var s = readPageVar('__INITIAL_STATE__');
    var subData = s && s.videoInfo && s.videoInfo.subtitle && s.videoInfo.subtitle.subtitles;
    var subUrl = subData && subData.length > 0 ? (subData[0].subtitle_url || subData[0].sub_url) : null;

    // Step 2: if not found, try Bilibili API
    if (!subUrl) {
      try {
        var bvid = location.pathname.split('/video/')[1];
        if (bvid) {
          bvid = bvid.split('/')[0].split('?')[0];
          var apiResp = await fetch('https://api.bilibili.com/x/player/v2?bvid=' + bvid);
          var apiJson = await apiResp.json();
          var subtitleData = apiJson && apiJson.data && apiJson.data.subtitle && apiJson.data.subtitle.subtitles;
          if (subtitleData && subtitleData.length > 0) {
            subUrl = subtitleData[0].subtitle_url || subtitleData[0].sub_url;
          }
        }
      } catch (_) {}
    }

    if (!subUrl) return null;

    // Step 3: fetch and parse the subtitle JSON
    try {
      var fullUrl = subUrl.indexOf('//') === 0 ? 'https:' + subUrl : subUrl;
      var resp = await fetch(fullUrl);
      var json = await resp.json();
      var body = json.body || json;
      var subs = [];
      for (var i = 0; i < body.length; i++) {
        var text = (body[i].content || '').replace(/<[^>]*>/g, '').trim();
        if (text.length >= 2) {
          subs.push({ text: text, start: body[i].from, end: body[i].to });
        }
      }
      return subs.length > 0 ? subs : null;
    } catch (e) {
      return null;
    }
  }

  function extractTextTrackSubs() {
    var video = findVideoElement();
    if (!video || !video.textTracks || video.textTracks.length === 0) return null;

    var track = video.textTracks[0];
    if (!track.cues || track.cues.length === 0) return null;

    var subs = [];
    for (var i = 0; i < track.cues.length; i++) {
      var cue = track.cues[i];
      var text = (cue.text || '').trim();
      if (text.length >= 2) {
        subs.push({ text: text, start: cue.startTime, end: cue.endTime });
      }
    }
    if (subs.length > 0);
    return subs.length > 0 ? subs : null;
  }

  async function startAudioCapture() {
    let video = findVideoElement();
    // Fallback: video may be muted/hidden by our loading overlay
    if (!video && duckedVideo) {
      video = duckedVideo;
    }
    if (!video) {
      sendStatus('error', '未找到正在播放的视频元素');
      return false;
    }

    try {
      // Try video.captureStream() first
      let stream;
      try {
        stream = video.captureStream();
      } catch (e) {
        // captureStream() might fail on some sites
        stream = video.captureStream(0);
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        // Fallback: request tab capture via background
        return await startTabCapture();
      }

      // Use only the audio track
      const audioStream = new MediaStream(audioTracks);
      setupAudioProcessing(audioStream);
      return true;
    } catch (err) {
      sendStatus('error', '音频捕获失败: ' + err.message);
      return false;
    }
  }

  async function startTabCapture() {
    // This requires chrome.tabCapture permission
    // For simplicity in MVP, we signal the popup about the limitation
    sendStatus('error', '此页面无法直接捕获视频音频，需 tabCapture 权限');
    return false;
  }

  function setupAudioProcessing(stream) {
    audioContext = new AudioContext({ sampleRate: 16000 });

    // Some browsers require resuming the context
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    sourceNode = audioContext.createMediaStreamSource(stream);

    // Use ScriptProcessorNode for PCM extraction
    // Buffer size 1024 = ~64ms at 16kHz (lower latency)
    processorNode = audioContext.createScriptProcessor(1024, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const clamped = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = Math.round(clamped * 32767);
      }
      ws.send(pcm.buffer);
    };

    sourceNode.connect(processorNode);
    // Connect to destination only when pipeline is activated (user clicks start).
    // During preheat, audio is buffered server-side but results are suppressed.
    if (!preheatActive) {
      processorNode.connect(audioContext.destination);
    }
  }

  function stopAudioCapture() {
    if (processorNode) {
      processorNode.disconnect();
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────────
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      ws = new WebSocket(settings.wsUrl);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectAttempts = 0;
      sendStatus('connected');

      ws.send(JSON.stringify({
        type: 'config',
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        apiKey: settings.apiKey,
        region: settings.region,
        engine: settings.engine,
        ttsVoice: settings.ttsVoice,
      }));

      // In sync mode: send preprocess right after config (server processes sequentially)
      if (syncMode && pendingSubs) {
        ws.send(JSON.stringify({
          type: 'preprocess',
          subs: pendingSubs,
        }));
        pendingSubs = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (err) {
      }
    };

    ws.onclose = (event) => {
      ws = null;
      if (isRunning) {
        if (syncMode || subtitleMode) {
          stopSyncPlayback();
          stopDOMSubtitleObserver();
          isRunning = false;
          finishWarmup();
          sendStatus('error', '连接断开，请重试');
        } else {
          scheduleReconnect();
        }
      } else if (preheatActive) {
        preheatActive = false;
        setTimeout(() => tryPreheat(), 2000);
      }
    };

    ws.onerror = (err) => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      sendStatus('error', '连接失败，请确保后端服务已启动');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
    reconnectAttempts++;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (isRunning) connectWebSocket();
    }, delay);
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'original':
        showSubtitle(msg.text, null, msg.speaker);
        break;

      case 'result':
        showSubtitle(msg.original, msg.translation, msg.speaker);
        break;

      case 'audio_start':
        handleAudioStart(msg);
        break;

      case 'audio_chunk':
        handleAudioChunk(msg);
        break;

      case 'audio_end':
        handleAudioEnd(msg);
        break;

      case 'audio':
        // Backward-compat: single-shot audio (warmup / fallback)
        playTTSAudio(msg.audio, msg.audioMime, msg.original, msg.speechRate);
        finishWarmup();
        break;

      // ─── Preprocess messages (sync mode) ──────────────────────────
      case 'preprocess_start':
        sendStatus('preprocessing', '预处理 ' + msg.total + ' 条字幕...');
        break;

      case 'preprocess_result':
        if (msg.items) {
          for (const item of msg.items) {
            preprocessedItems.push(item);
          }
          // Sort by index to maintain correct order
          preprocessedItems.sort((a, b) => a.index - b.index);
        }
        break;

      case 'preprocess_complete':
        sendStatus('playing');
        startSyncPlayback();
        break;

      case 'preprocess_error':
        sendStatus('error', msg.message);
        fallbackToASR();
        break;

      // ─── Status ────────────────────────────────────────────────────
      case 'status':
        if (msg.status === 'configured') {
          if (!syncMode) {
            // In ASR mode: send warmup. In sync mode: preprocess already sent.
            ws.send(JSON.stringify({ type: 'warmup' }));
          }
        } else if (msg.status === 'ready') {
          if (preheatActive) {
            preheatPhase2();
          } else if (!startSent && !syncMode) {
            if (subtitleMode) {
              // DOM subtitle mode: no audio capture, just activate
              startSent = true;
              ws.send(JSON.stringify({ type: 'start' }));
              chrome.runtime.sendMessage({ type: 'started' }).catch(() => {});
            } else {
              startAudioCapture().then(ok => {
                if (ok) {
                  startSent = true;
                  ws.send(JSON.stringify({ type: 'start' }));
                  chrome.runtime.sendMessage({ type: 'started' }).catch(() => {});
                } else {
                  isRunning = false;
                  finishWarmup();
                }
              });
            }
          }
        } else if (msg.status === "listening" && subtitleMode && !domObserver) {
          startDOMSubtitleObserver();
          sendStatus(msg.status);
        } else {
          sendStatus(msg.status);
        }
        break;

      case 'translate_request':
        handleTranslateRequest(msg);
        break;

      case 'error':
        sendStatus('error', msg.message);
        finishWarmup();
        break;
    }
  }

  function disconnectWebSocket() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (ws) {
      ws.onclose = null; // Prevent reconnection
      ws.close(1000, 'user stop');
      ws = null;
    }
  }

  // ─── Control ──────────────────────────────────────────────────────
  let duckedVideo = null;   // video whose audio is ducked (not muted)
  let savedVolume = 1;
  const DUCK_VOLUME = 0.25; // video volume during TTS playback
  let warmupDone = false;
  let startSent = false;  // prevents duplicate 'start' messages

  // ─── Preheat system (auto-warm on page load) ───────────────────────
  // preheatActive: true while background preheat chain is in progress
  // preheatReady:  true when WS connected + warmup done + audio pipeline ready
  let preheatActive = false;
  let preheatReady = false;

  function tryPreheat() {
    if (preheatActive || preheatReady || ws) return;
    const video = findVideoElement();
    if (video) {
      preheat();
    } else {
      const observer = new MutationObserver(() => {
        const video = findVideoElement();
        if (video) {
          observer.disconnect();
          preheat();
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
  }

  function preheat() {
    if (preheatActive || preheatReady || isRunning || ws) return;
    preheatActive = true;
    start();
  }

  function preheatPhase2() {
    startAudioCapture().then(ok => {
      if (ok) {
        preheatActive = false;
        preheatReady = true;
      } else {
        preheatActive = false;
      }
    });
  }

  function activatePipeline() {
    if (processorNode) {
      processorNode.connect(audioContext.destination);
    }
    startSent = true;
    ws.send(JSON.stringify({ type: 'start' }));
    chrome.runtime.sendMessage({ type: 'started' }).catch(() => {});
  }

  function sendStatus(status, message) {
    chrome.runtime.sendMessage({
      type: 'statusUpdate',
      status: status,
      message: message || '',
    }).catch(() => {});
  }

  function showLoading() {
    if (!loadingOverlay.parentNode) {
      document.body.appendChild(loadingOverlay);
    }
    loadingOverlay.style.setProperty('display', 'flex', 'important');
  }

  function hideLoading() {
    clearTimeout(loadingOverlay._safetyTimer);
    clearTimeout(loadingOverlay._resumeTimer);
    loadingOverlay.style.setProperty('display', 'none', 'important');
  }

  function finishWarmup() {
    if (warmupDone) return;
    warmupDone = true;
    unduckVideoAudio();
    hideLoading();
  }

  // ─── Sync Playback Engine (subtitle hijacking mode) ──────────────────

  function startSyncPlayback() {
    syncVideo = findVideoElement();
    if (!syncVideo) {
      fallbackToASR();
      return;
    }

    // Pre-create Audio elements for each item that has TTS audio
    for (const item of preprocessedItems) {
      if (item.audio) {
        try {
          item.audioEl = new Audio('data:audio/mp3;base64,' + item.audio);
          item.audioEl.volume = 0.9;
          item.audioEl.playbackRate = TTS_RATE;
        } catch (e) {
        }
      }
    }

    // Monitor playback rate changes
    syncVideo.addEventListener('ratechange', onVideoRateChange);

    lastSyncTime = syncVideo.currentTime;
    chrome.runtime.sendMessage({ type: 'started' }).catch(() => {});
    finishWarmup();
    syncLoop();
  }

  function syncLoop() {
    syncRafId = requestAnimationFrame(syncLoop);

    if (!syncVideo || syncVideo.paused) return;

    const currentTime = syncVideo.currentTime;

    // Detect seeking (jump > 1 second)
    if (Math.abs(currentTime - lastSyncTime) > 1.0) {
      reSync(currentTime);
    }
    lastSyncTime = currentTime;

    for (const item of preprocessedItems) {
      if (item.played) continue;
      if (currentTime >= item.start) {
        item.played = true;
        showSubtitle(item.original, item.translation);
        if (item.audioEl) {
          enqueueAudio(item.audioEl, item.audioEl.src);
          item.audioEl = null;  // prevent re-enqueue on next frames
        }
      }
    }
  }

  function reSync(currentTime) {
    // Clear queue and stop current audio on seek
    stopTTS();
    // Mark all items before currentTime as played, find current one
    let foundCurrent = false;
    for (const item of preprocessedItems) {
      if (!foundCurrent && currentTime < item.end) {
        item.played = false; // re-trigger for display
        foundCurrent = true;
      } else {
        item.played = true;
      }
    }
    // Stop previously playing audio — the next frame will start the correct one
    if (currentSyncAudio) {
      try { currentSyncAudio.pause(); } catch (_) {}
      currentSyncAudio = null;
    }
    // Stop any playing TTS from items far past
    for (const item of preprocessedItems) {
      if (item.played && item.audioEl && !item.audioEl.paused) {
        const elapsed = currentTime - item.start;
        if (elapsed > item.end - item.start + 2) {
          item.audioEl.pause();
        }
      }
    }
  }

  function onVideoRateChange() {
    for (const item of preprocessedItems) {
      if (item.audioEl) item.audioEl.playbackRate = TTS_RATE;
    }
  }

  function stopSyncPlayback() {
    if (syncRafId) {
      cancelAnimationFrame(syncRafId);
      syncRafId = null;
    }
    if (syncVideo) {
      syncVideo.removeEventListener('ratechange', onVideoRateChange);
      syncVideo = null;
    }
    // stopTTS() handles current audio + queue cleanup
    stopTTS();
    for (const item of preprocessedItems) {
      if (item.audioEl) {
        try { item.audioEl.pause(); } catch (_) {}
        item.audioEl = null;
      }
    }
    preprocessedItems = [];
    pendingSubs = null;
    syncMode = false;
  }

  function fallbackToASR() {
    stopSyncPlayback();
    // Retry with ASR mode
    startASRMode();
  }

  function startASRMode() {
    syncMode = false;
    if (preheatReady && ws && ws.readyState === WebSocket.OPEN) {
      preheatReady = false;
      activatePipeline();
      return;
    }
    // Full ASR flow
    preheatReady = false;
    preheatActive = false;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    connectWebSocket();
  }

  function duckVideoAudio() {
    const video = findVideoElement();
    if (video) {
      savedVolume = video.volume;
      video.volume = savedVolume * DUCK_VOLUME;
      duckedVideo = video;
    }
  }

  function unduckVideoAudio() {
    if (duckedVideo) {
      duckedVideo.volume = savedVolume;
      duckedVideo = null;
    }
  }

  async function start() {
    if (isRunning) return;
    isRunning = true;
    warmupDone = false;
    startSent = false;
    syncMode = false;
    subtitleMode = false;
    pendingSubs = null;

    sendStatus('starting', '连接中...');

    // Kill preheat BEFORE any async work to prevent race conditions
    stopAudioCapture();
    stopDOMSubtitleObserver();
    preheatReady = false;
    preheatActive = false;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    duckVideoAudio();
    showLoading();

    // Safety timeout
    loadingOverlay._safetyTimer = setTimeout(() => {
      if (!warmupDone) {
        finishWarmup();
      }
    }, 15000);

    // Try subtitle extraction for sync mode
    const subs = await extractSubtitles();
    if (subs && subs.length > 0) {
      syncMode = true;
      pendingSubs = subs;

      // Disconnect any existing WS (preheat) and reconnect fresh
      if (ws) {
        ws.onclose = null; // prevent onclose handler from running stopSyncPlayback
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      preheatReady = false;
      preheatActive = false;
      connectWebSocket();
      return;
    }

    // API extraction failed — try DOM subtitle observer for YouTube
    subtitleMode = canObserveDOMSubtitles();
    if (subtitleMode) {
      // Connect WS if needed (same flow as sync mode)
      if (ws) {
        ws.onclose = null;
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      preheatReady = false;
      preheatActive = false;
      connectWebSocket();
      return;
    }

    // No subtitles at all — use ASR mode

    // If preheat fully ready, activate instantly
    if (preheatReady && ws && ws.readyState === WebSocket.OPEN) {
      preheatReady = false;
      activatePipeline();
      return;
    }

    // Preheat may have completed but WS died — reset and go full flow
    preheatReady = false;
    preheatActive = false;
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    // Full flow: connect → config → warmup → ready → capture → start
    connectWebSocket();
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    startSent = false;


    if (syncMode) {
      stopSyncPlayback();
    }
    if (subtitleMode) {
      stopDOMSubtitleObserver();
    }

    disconnectWebSocket();
    stopAudioCapture();
    stopTTS();
    contentDiv.innerHTML = '';
    subtitleBox = null;
    speakerEl = null;
    originalLine = null;
    translationLine = null;
    finishWarmup();

    chrome.runtime.sendMessage({ type: 'stopped' }).catch(() => {});
  }

  function updateSettings(newSettings) {
    Object.assign(settings, newSettings);
    // If already connected, send updated config
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'config',
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        apiKey: settings.apiKey,
        region: settings.region,
        engine: settings.engine,
        ttsVoice: settings.ttsVoice,
      }));
    }
  }

  // ─── Message Listener ─────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'start':
        updateSettings(message.settings || {});
        start();
        sendResponse({ success: true });
        break;

      case 'stop':
        stop();
        sendResponse({ success: true });
        break;

      case 'getStatus':
        sendResponse({ isRunning });
        break;

      case 'updateSettings':
        updateSettings(message.settings || {});
        sendResponse({ success: true });
        break;
    }
    return true; // Keep message channel open for async response
  });

  // ─── Initialization ───────────────────────────────────────────────

  // Watch for settings changes from popup (works even when popup is closed)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.translationSettings) return;
    const newSettings = changes.translationSettings.newValue;
    if (!newSettings) return;

    if (newSettings.ttsVoice !== undefined && newSettings.ttsVoice !== settings.ttsVoice) {
      settings.ttsVoice = newSettings.ttsVoice;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'voice', ttsVoice: newSettings.ttsVoice }));
      }
    }

    if (newSettings.engine !== undefined && newSettings.engine !== settings.engine) {
      settings.engine = newSettings.engine;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'config',
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          apiKey: settings.apiKey,
          region: settings.region,
          engine: newSettings.engine,
          ttsVoice: settings.ttsVoice,
        }));
      }
    }

    if (newSettings.sourceLang !== undefined) settings.sourceLang = newSettings.sourceLang;
    if (newSettings.targetLang !== undefined) settings.targetLang = newSettings.targetLang;
  });

  // Start background preheat as soon as a video is detected
  tryPreheat();

  // YouTube SPA navigation: re-enable CC on the new player
  document.addEventListener('yt-navigate-finish', function () {
    if (!isRunning) return;

    // Detach old observer (old player is destroyed)
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    if (ccClickHandler && ccClickTarget) {
      ccClickTarget.removeEventListener('click', ccClickHandler, true);
      ccClickHandler = null;
      ccClickTarget = null;
    }
    if (ccAttrObserver) { ccAttrObserver.disconnect(); ccAttrObserver = null; }
    lastDOMSubtitle = '';

    if (syncMode) {
      stopSyncPlayback();
    }

    // Poll for the new player, then re-enable
    var navWait = 0;
    var navTimer = setInterval(function () {
      navWait++;
      var p = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
      if (p && p.querySelector('.ytp-subtitles-button')) {
        clearInterval(navTimer);
        // Restart DOM subtitle observer on new player
        if (subtitleMode) startDOMSubtitleObserver();
      } else if (navWait > 40) {
        clearInterval(navTimer);
      }
    }, 250);
  });

  // Notify that content script is ready
  chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});
})();
