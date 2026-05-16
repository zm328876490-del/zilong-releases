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
    baiduAppID: '',
    baiduSecret: '',
  };

  // ─── Sync mode state (subtitle hijacking) ───────────────────────────
  let syncMode = false;           // true = subtitle sync mode, false = ASR mode
  let pendingSubs = null;         // extracted subtitles waiting for WS to connect
  let preprocessedItems = [];     // [{original, translation, audioB64, start, end, played, audioEl}]
  let syncRafId = null;           // requestAnimationFrame ID
  let lastSyncTime = 0;           // last video.currentTime
  let syncVideo = null;           // the video element being synced to

  // DOM subtitle observer state
  let subtitleMode = false;       // true = DOM caption extraction mode
  let domObserver = null;         // MutationObserver for caption elements
  let ccObserver = null;          // MutationObserver for CC button (prevents user turning off)
  let captionStyleEl = null;      // injected <style> to hide native YouTube captions
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
        animation: __fadeIn__ 0.25s ease-out !important;
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
      @keyframes __fadeIn__ {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    </style>
    <div id="__subtitle_content__"></div>
  `;
  document.body.appendChild(overlay);

  const contentDiv = overlay.querySelector('#__subtitle_content__');

  let lastSpeaker = '';

  function showSubtitle(original, translation, speaker) {
    let html = '';
    if (speaker && speaker !== lastSpeaker) {
      lastSpeaker = speaker;
      html += `<div class="subtitle-speaker">Speaker ${escapeHTML(speaker)}</div>`;
    }
    if (original || translation) {
      html += '<div class="subtitle-box">';
      if (original) {
        html += `<div class="subtitle-line subtitle-original">${escapeHTML(original)}</div>`;
      }
      if (translation) {
        html += `<div class="subtitle-line subtitle-translation">${escapeHTML(translation)}</div>`;
      }
      html += '</div>';
    }
    contentDiv.innerHTML = html;

    // Auto-clear after 5 seconds of no updates
    clearTimeout(contentDiv._clearTimer);
    contentDiv._clearTimer = setTimeout(() => {
      contentDiv.innerHTML = '';
      lastSpeaker = '';
    }, 5000);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── TTS (streaming Edge TTS via MSE, with fallback) ────────────────
  let lastSpokenText = '';
  let ttsAudio = null;

  // Speech rate smoothing: 3-sentence moving average
  const rateHistory = [];
  const RATE_SMOOTH_WINDOW = 3;
  const RATE_REFERENCE = 5.0;   // ~5 chars/sec = normal speaking speed
  const RATE_MIN = 0.9;
  const RATE_MAX = 1.5;

  // Streaming TTS state
  let ttsMediaSource = null;
  let ttsSourceBuffer = null;
  let ttsPendingBuffers = [];
  let ttsMSEWorks = true;       // set to false if MSE fails for MP3
  let ttsFallbackChunks = [];   // accumulate chunks for non-MSE fallback
  let ttsFallbackRate = 1.2;

  function smoothSpeechRate(rawRate) {
    if (!rawRate || rawRate <= 0) return 1.2; // default
    rateHistory.push(rawRate);
    if (rateHistory.length > RATE_SMOOTH_WINDOW) rateHistory.shift();
    const avg = rateHistory.reduce((a, b) => a + b, 0) / rateHistory.length;
    return Math.max(RATE_MIN, Math.min(RATE_MAX, avg / RATE_REFERENCE));
  }

  function playTTSAudio(base64, mimeType, text, speechRate) {
    if (!base64 || text === lastSpokenText) return;
    lastSpokenText = text;
    stopTTS();

    const url = `data:${mimeType};base64,${base64}`;
    ttsAudio = new Audio(url);
    ttsAudio.volume = 0.9;
    ttsAudio.playbackRate = smoothSpeechRate(speechRate);
    ttsAudio.play().catch(() => {});
  }

  function stopTTS() {
    if (ttsAudio) {
      try { ttsAudio.pause(); } catch (_) {}
      ttsAudio = null;
    }
    // Clean up MSE
    if (ttsMediaSource && ttsMediaSource.readyState === 'open') {
      try { ttsMediaSource.endOfStream(); } catch (_) {}
    }
    ttsMediaSource = null;
    ttsSourceBuffer = null;
    ttsPendingBuffers = [];
  }

  // ─── Streaming TTS (MSE-based, Chrome only) ────────────────────────

  function handleAudioStart(msg) {
    lastSpokenText = msg.original;
    stopTTS();
    ttsFallbackChunks = [];
    ttsFallbackRate = smoothSpeechRate(msg.speechRate);

    if (!ttsMSEWorks) return; // will play via fallback when audio_end arrives

    try {
      ttsMediaSource = new MediaSource();
      const url = URL.createObjectURL(ttsMediaSource);
      ttsAudio = new Audio(url);
      ttsAudio.volume = 0.9;
      ttsAudio.playbackRate = ttsFallbackRate;

      ttsMediaSource.onsourceopen = () => {
        try {
          ttsSourceBuffer = ttsMediaSource.addSourceBuffer('audio/mpeg');
          ttsSourceBuffer.mode = 'sequence';
          ttsSourceBuffer.onupdateend = drainTTSQueue;
          drainTTSQueue();
        } catch (e) {
          ttsMSEWorks = false;
          ttsMediaSource = null;
          ttsSourceBuffer = null;
        }
      };

      ttsAudio.play().catch(() => {});
    } catch (e) {
      ttsMSEWorks = false;
    }
  }

  function handleAudioChunk(msg) {
    if (!msg.audio) return;
    const binary = atob(msg.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Always accumulate for fallback
    ttsFallbackChunks.push(bytes);

    if (ttsMSEWorks && ttsSourceBuffer) {
      if (!ttsSourceBuffer.updating) {
        try {
          ttsSourceBuffer.appendBuffer(bytes.buffer);
        } catch (_) {
          ttsPendingBuffers.push(bytes.buffer);
        }
      } else {
        ttsPendingBuffers.push(bytes.buffer);
      }
    }
  }

  function drainTTSQueue() {
    if (ttsSourceBuffer && !ttsSourceBuffer.updating && ttsPendingBuffers.length > 0) {
      try {
        ttsSourceBuffer.appendBuffer(ttsPendingBuffers.shift());
      } catch (_) {}
    }
  }

  function handleAudioEnd(msg) {
    if (ttsMSEWorks && ttsMediaSource) {
      const finalize = () => {
        drainTTSQueue();
        if (ttsPendingBuffers.length > 0) {
          setTimeout(finalize, 80);
        } else if (ttsMediaSource && ttsMediaSource.readyState === 'open') {
          try { ttsMediaSource.endOfStream(); } catch (_) {}
        }
        finishWarmup();
      };
      finalize();
      return;
    }

    // Fallback: play accumulated chunks as a single Audio
    if (ttsFallbackChunks.length > 0) {
      const blob = new Blob(ttsFallbackChunks, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      ttsAudio = new Audio(url);
      ttsAudio.volume = 0.9;
      ttsAudio.playbackRate = ttsFallbackRate;
      ttsAudio.play().catch(() => {});
    }
    ttsFallbackChunks = [];
    finishWarmup();
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

  function startDOMSubtitleObserver() {
    var player = document.querySelector('#movie_player') ||
                 document.querySelector('.html5-video-player');
    if (!player) {
      return false;
    }

    // Force YouTube CC on — the DOM nodes we observe only exist when CC is active
    var ccBtn = player.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
      ccBtn.click();
    }

    // Prevent user from turning CC off during translation
    if (ccBtn) {
      ccObserver = new MutationObserver(function () {
        var btn = player.querySelector('.ytp-subtitles-button');
        if (btn && btn.getAttribute('aria-pressed') === 'false') {
          btn.click();
        }
      });
      ccObserver.observe(ccBtn, {
        attributes: true,
        attributeFilter: ['aria-pressed'],
      });
    }

    // Hide YouTube native caption display so the user sees our overlay instead
    captionStyleEl = document.createElement('style');
    captionStyleEl.id = '__ai_caption_hider__';
    captionStyleEl.textContent = '.caption-window { opacity: 0 !important; }';
    document.head.appendChild(captionStyleEl);

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
    if (ccObserver) {
      ccObserver.disconnect();
      ccObserver = null;
    }
    if (captionStyleEl) {
      captionStyleEl.remove();
      captionStyleEl = null;
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
        baiduAppID: settings.baiduAppID,
        baiduSecret: settings.baiduSecret,
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
          item.audioEl.playbackRate = syncVideo.playbackRate || 1.0;
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
          item.audioEl.play().catch(() => {});
        }
      }
    }
  }

  function reSync(currentTime) {
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
    const rate = syncVideo.playbackRate || 1.0;
    for (const item of preprocessedItems) {
      if (item.audioEl) item.audioEl.playbackRate = rate;
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
        baiduAppID: settings.baiduAppID,
        baiduSecret: settings.baiduSecret,
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

  // Start background preheat as soon as a video is detected
  tryPreheat();

  // Notify that content script is ready
  chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});
})();
