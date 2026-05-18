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

  // ─── Persistent pipeline state ─────────────────────────────────────
  // AudioContext, processorNode, and WS survive video changes.
  // Only the source node (which video is captured) gets swapped.
  let pipelineActive = false;    // AudioContext + processorNode created and live
  let activeVideo = null;       // currently captured <video> element
  let activeStream = null;      // current captureStream() MediaStream
  let videoWatcher = null;      // persistent MutationObserver for video elements
  let videoPollTimer = null;    // periodic check for video src changes / new videos

  // Settings (updated via popup messages)
  let settings = {
    wsUrl: 'ws://localhost:9527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    apiKey: '',
    region: 'eastasia',
    engine: 'microsoft',
    ttsVoice: 'default',
    subtitleEnabled: true,
    subtitleSize: 50,
    originalVolume: 30,
    ttsVolume: 100,
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
  let ccMuteUntil = 0;           // mute DOM capture for N ms after CC click
  let subtitleModeTimer = null;  // timeout: fallback to ASR if no captions

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

  // ─── Display Settings (applied in real-time) ──────────────────────
  function applySubtitleEnabled(enabled) {
    settings.subtitleEnabled = enabled;
    overlay.style.setProperty('display', enabled ? '' : 'none', 'important');
    if (!enabled) {
      // Clear current subtitle immediately
      if (subtitleBox) subtitleBox.style.opacity = '0';
      if (speakerEl) speakerEl.style.display = 'none';
    }
  }

  function applySubtitleSize(percentage) {
    settings.subtitleSize = percentage;
    const scale = percentage / 100;
    let sizeStyle = document.getElementById('__ai_subtitle_size_style__');
    if (!sizeStyle) {
      sizeStyle = document.createElement('style');
      sizeStyle.id = '__ai_subtitle_size_style__';
      overlay.appendChild(sizeStyle);
    }
    sizeStyle.textContent = `
      #__ai_subtitle_overlay__ .subtitle-original { font-size: ${Math.round(16 * scale)}px !important; }
      #__ai_subtitle_overlay__ .subtitle-translation { font-size: ${Math.round(20 * scale)}px !important; }
      #__ai_subtitle_overlay__ .subtitle-speaker { font-size: ${Math.round(12 * scale)}px !important; }
    `;
  }

  function applyOriginalVolume(percentage) {
    settings.originalVolume = percentage;
    const video = duckedVideo || findVideoElement();
    if (video) {
      video.volume = percentage / 100;
    }
  }

  function applyTtsVolume(percentage) {
    settings.ttsVolume = percentage;
    if (ttsAudio) {
      ttsAudio.volume = percentage / 100;
    }
  }

  function applyDisplaySettings(s) {
    if (s.subtitleEnabled !== undefined) applySubtitleEnabled(s.subtitleEnabled);
    if (s.subtitleSize !== undefined) applySubtitleSize(s.subtitleSize);
    if (s.originalVolume !== undefined) applyOriginalVolume(s.originalVolume);
    if (s.ttsVolume !== undefined) applyTtsVolume(s.ttsVolume);
  }

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
    original = stripCCAnnouncement(original);
    translation = stripCCAnnouncement(translation);

    // When original === translation (skip-translate), show single line
    if (original && translation && original === translation) {
      original = null;
    }

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

  // Strip YouTube CC track-name announcements from text before display/TTS
  function stripCCAnnouncement(text) {
    if (!text) return '';
    return text
      .replace(/英语[（(]自动生成[）)]\s*点击\s*查看设置/g, '')
      .replace(/English\s*\(auto.generated\)\s*click\s*view\s*settings/gi, '')
      .trim();
  }

  // Detect if text is already in the target language (character-range heuristic)
  function isTargetLanguage(text, targetLang) {
    if (!text || !targetLang) return false;
    var hasCJK = /[一-鿿]/.test(text);
    var hasKana = /[぀-ヿ]/.test(text);
    var hasHangul = /[가-힯]/.test(text);
    var asciiRatio = (text.match(/[\x00-\x7f]/g) || []).length / text.length;

    switch (targetLang) {
      case 'zh-Hans': case 'zh-Hant': case 'zh': return hasCJK;
      case 'ja': return hasKana;
      case 'ko': return hasHangul;
      case 'en': return asciiRatio >= 0.95;
      default:  return false; // conservative: only auto-skip for known lang pairs
    }
  }

  // ─── TTS (queue-based playback, no cutting) ──────────────────────
  let lastSpokenText = '';
  const SHORT_VIDEO_DURATION = 60; // videos under 60s skip TTS dedup

  function isShortVideo() {
    return activeVideo && activeVideo.duration > 0 && activeVideo.duration < SHORT_VIDEO_DURATION;
  }
  let ttsAudio = null;
  let ttsAudioUrl = null;
  let currentUtteranceId = ''; // tracks which utterance's TTS stream is active
  let currentTtsPartial = false; // true = fast partial TTS, false = final

  const TTS_RATE_PARTIAL = 1.5;   // fast rate for partials (will be interrupted)
  const TTS_RATE_FINAL = 1.0;     // natural rate for finals
  const TTS_RATE_MAX = 1.5;       // max playback rate
  let currentSpeechRate = 5;      // original speaker chars/sec, updated by audio_start

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
    text = stripCCAnnouncement(text);
    if (!base64 || !text) return;
    if (!isShortVideo() && text === lastSpokenText) return;
    lastSpokenText = text;
    const url = `data:${mimeType};base64,${base64}`;
    const audio = new Audio(url);
    audio.volume = settings.ttsVolume / 100;
    audio.playbackRate = Math.min(TTS_RATE_MAX, Math.max(1.0, (speechRate || 5) / 5));
    enqueueAudio(audio, url);
  }

  function stopTTS() {
    // Only clear queued items, leave currently playing audio alone.
    // The current utterance's audio will finish naturally and playNextInQueue
    // will pick up the next queued item (from the new utterance).
    for (const item of ttsQueue) {
      URL.revokeObjectURL(item.url);
    }
    ttsQueue = [];
    ttsFallbackChunks = [];
  }

  // ─── Streaming TTS handlers (queue-based, no MSE) ─────────────────

  function handleAudioStart(msg) {
    // New utterance — interrupt any in-progress TTS from the previous one
    var isNewUtterance = msg.utteranceId && msg.utteranceId !== currentUtteranceId;
    if (isNewUtterance) {
      stopTTS();
    }
    currentUtteranceId = msg.utteranceId || '';
    currentTtsPartial = msg.ttsPartial === true;
    currentSpeechRate = msg.speechRate || 5;
    lastSpokenText = msg.original;
    ttsFallbackChunks = [];
  }

  function handleAudioChunk(msg) {
    if (!msg.audio) return;
    // Discard chunks from stale (cancelled) utterances
    if (msg.utteranceId && msg.utteranceId !== currentUtteranceId) return;
    if (!isShortVideo() && msg.original && msg.original !== lastSpokenText) return;
    const binary = atob(msg.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ttsFallbackChunks.push(bytes);
  }

  function handleAudioEnd(msg) {
    // Discard stale utterance endings
    if (msg.utteranceId && msg.utteranceId !== currentUtteranceId) return;
    if (!isShortVideo() && msg.original && msg.original !== lastSpokenText) return;
    if (ttsFallbackChunks.length > 0) {
      const blob = new Blob(ttsFallbackChunks, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = settings.ttsVolume / 100;
      audio.playbackRate = currentTtsPartial ? TTS_RATE_PARTIAL : Math.min(TTS_RATE_MAX, Math.max(1.0, (currentSpeechRate || 5) / 5));
      enqueueAudio(audio, url);
    }
    // Short videos: clear dedup after TTS so looped replays re-speak
    if (isShortVideo()) lastSpokenText = '';
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
    // Mute DOM subtitle capture — YouTube may briefly flash the track
    // name as caption text right after CC is enabled.
    ccMuteUntil = Date.now() + 2000;
  }

  // Set up CC button click interceptor + attribute watch on a found button.
	  function setupCCButton(btn, player) {
	    if (!btn) return;
	    // Force CC on
	    if (btn.getAttribute('aria-pressed') === 'false') {
	      silentClickCC(btn);
	    }
	    // Intercept user clicks to prevent turning CC off
	    ccClickHandler = function (e) {
	      var b = player.querySelector('.ytp-subtitles-button');
	      if (b && b.getAttribute('aria-pressed') === 'true') {
	        e.stopImmediatePropagation();
	        e.preventDefault();
	      }
	    };
	    ccClickTarget = btn;
	    btn.addEventListener('click', ccClickHandler, true);
	    // Watch aria-pressed — YouTube may reset it after ads or rebinds
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
	    ccAttrObserver.observe(btn, { attributes: true, attributeFilter: ['aria-pressed'] });
	  }

  function startDOMSubtitleObserver() {
    var player = document.querySelector('#movie_player') ||
                 document.querySelector('.html5-video-player');
    if (!player) {
      return false;
    }

    var ccBtn = player.querySelector('.ytp-subtitles-button');
    if (ccBtn) {
      setupCCButton(ccBtn, player);
    } else {
      // Player exists but CC button not rendered yet — poll until it appears
      var ccPoll = 0;
      var ccPollTimer = setInterval(function () {
        ccPoll++;
        var btn = player.querySelector('.ytp-subtitles-button');
        if (btn) {
          clearInterval(ccPollTimer);
          setupCCButton(btn, player);
        } else if (ccPoll > 30) {
          clearInterval(ccPollTimer);
        }
      }, 300);
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
      if (Date.now() < ccMuteUntil) return;
      var text = getCurrentCaptionText();
      text = stripCCAnnouncement(text);
      if (!text) return;
      if (text !== lastDOMSubtitle && text.length >= 2) {
        lastDOMSubtitle = text;
        var skip = isTargetLanguage(text, settings.targetLang);
        showSubtitle(skip ? null : text, skip ? text : null);
        ws.send(JSON.stringify({ type: 'subtitle', text: text, skipTranslate: skip }));
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
    clearTimeout(subtitleModeTimer);
    subtitleModeTimer = null;
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

  // ─── Persistent Audio Pipeline ─────────────────────────────────────
  // AudioContext + processorNode are created ONCE and survive video swaps.
  // Only the source node (MediaStreamSource) is swapped when video changes.

  function ensureAudioContext() {
    if (audioContext) return true;
    try {
      audioContext = new AudioContext({ sampleRate: 16000 });
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

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

      pipelineActive = true;
      return true;
    } catch (err) {
      sendStatus('error', 'AudioContext 创建失败: ' + err.message);
      return false;
    }
  }

  function connectVideoStream(stream) {
    if (!audioContext || !processorNode) return false;

    // Disconnect and release old source
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach(function (t) { t.stop(); });
      activeStream = null;
    }

    activeStream = stream;
    sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(processorNode);
    return true;
  }

  function disconnectVideoSource() {
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach(function (t) { t.stop(); });
      activeStream = null;
    }
    if (activeVideo) {
      if (activeVideo._capturePlayHandler) {
        activeVideo.removeEventListener('play', activeVideo._capturePlayHandler);
        activeVideo._capturePlayHandler = null;
      }
      activeVideo = null;
    }
  }

  function captureVideoAudio(video) {
    if (!video) return false;
    try {
      var stream;
      try {
        stream = video.captureStream();
      } catch (e) {
        stream = video.captureStream(0);
      }

      var audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        // Fallback: tabCapture not implemented; signal limitation
        sendStatus('error', '此页面无法直接捕获视频音频，需 tabCapture 权限');
        return false;
      }

      var audioStream = new MediaStream(audioTracks);

      if (!ensureAudioContext()) return false;

      connectVideoStream(audioStream);
      activeVideo = video;
      activeVideo._lastSrc = video.src;

      // Re-capture on play to revive ended tracks when video loops
      if (activeVideo._capturePlayHandler) {
        activeVideo.removeEventListener('play', activeVideo._capturePlayHandler);
      }
      activeVideo._capturePlayHandler = function () {
        if (activeVideo === video && activeStream) {
          var tracks = activeStream.getAudioTracks();
          if (tracks.length === 0 || tracks[0].readyState === 'ended') {
            captureVideoAudio(video);
          }
        }
      };
      activeVideo.addEventListener('play', activeVideo._capturePlayHandler);

      // Apply ducking if pipeline is active but warmup hasn't finished
      if (isRunning && !warmupDone && duckedVideo !== video) {
        video.volume = settings.originalVolume / 100;
      }

      return true;
    } catch (err) {
      sendStatus('error', '音频捕获失败: ' + err.message);
      return false;
    }
  }

  function destroyPipeline() {
    stopVideoWatcher();

    if (processorNode) {
      processorNode.disconnect();
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach(function (t) { t.stop(); });
      activeStream = null;
    }
    if (activeVideo) {
      if (activeVideo._capturePlayHandler) {
        activeVideo.removeEventListener('play', activeVideo._capturePlayHandler);
        activeVideo._capturePlayHandler = null;
      }
      activeVideo = null;
    }
    if (audioContext) {
      audioContext.close().catch(function () {});
      audioContext = null;
    }
    pipelineActive = false;
  }

  // ─── Persistent Video Watcher ──────────────────────────────────────
  // Watches for video elements added/removed and swaps capture source
  // automatically so the pipeline stays live across video changes.

  function startVideoWatcher() {
    if (videoWatcher) return;

    videoWatcher = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];

        // Detect newly added video elements
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;
          var videos = [];
          if (node.tagName === 'VIDEO') {
            videos = [node];
          } else if (node.querySelectorAll) {
            videos = Array.from(node.querySelectorAll('video'));
          }
          for (var k = 0; k < videos.length; k++) {
            var v = videos[k];
            if (v.duration > 0 && !v.paused && v !== activeVideo) {
              captureVideoAudio(v);
              return;
            }
          }
        }

        // Detect removed video elements
        for (var r = 0; r < m.removedNodes.length; r++) {
          var removed = m.removedNodes[r];
          if (removed.nodeType !== 1) continue;
          if (removed === activeVideo || (removed.contains && removed.contains(activeVideo))) {
            disconnectVideoSource();
          }
        }
      }
    });

    videoWatcher.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Periodic poll: catch src changes, loop replays (ended tracks), and videos
    // that appeared without DOM mutation.
    videoPollTimer = setInterval(function () {
      if (!isRunning || !pipelineActive) return;
      var video = findVideoElement();
      if (!video) return;

      if (!activeVideo) {
        captureVideoAudio(video);
      } else if (activeVideo !== video) {
        captureVideoAudio(video);
      } else if (activeVideo.src !== activeVideo._lastSrc) {
        captureVideoAudio(video);
      } else if (activeStream) {
        // Detect ended tracks (video finished/looped) — re-capture to revive
        var tracks = activeStream.getAudioTracks();
        if (tracks.length === 0 || tracks[0].readyState === 'ended') {
          captureVideoAudio(video);
        }
      }
    }, 2000);
  }

  function stopVideoWatcher() {
    if (videoWatcher) {
      videoWatcher.disconnect();
      videoWatcher = null;
    }
    clearInterval(videoPollTimer);
    videoPollTimer = null;
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
        scheduleReconnect();
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
    // Strip CC announcement text from ASR results before any processing
    if (msg.original) msg.original = stripCCAnnouncement(msg.original);
    if (msg.text) msg.text = stripCCAnnouncement(msg.text);
    if (msg.translation) msg.translation = stripCCAnnouncement(msg.translation);

    // Skip entire audio utterance if original was completely the announcement.
    // TTS audio is generated server-side from ASR text; the streaming path
    // (audio_start/chunk/end) bypasses playTTSAudio(), so we must block here.
    if (msg.original !== undefined && msg.original === '') {
      var t = msg.type;
      if (t === 'audio_start' || t === 'audio_chunk' || t === 'audio_end' || t === 'audio') {
        return;
      }
    }

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
              var video = findVideoElement();
              var ok = video ? captureVideoAudio(video) : false;
              if (ok) {
                activatePipeline();
              } else {
                isRunning = false;
                finishWarmup();
              }
            }
          }
        } else if (msg.status === "listening" && subtitleMode && !domObserver) {
          if (!startDOMSubtitleObserver()) {
            sendStatus('error', '无法启用字幕捕获，回退到 ASR');
            fallbackToASR();
          } else {
            sendStatus(msg.status);
          }
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
    var video = findVideoElement();
    var ok = video ? captureVideoAudio(video) : false;
    if (ok) {
      preheatActive = false;
      preheatReady = true;
    } else {
      preheatActive = false;
    }
  }

  function activatePipeline() {
    startVideoWatcher();
    if (processorNode) {
      processorNode.connect(audioContext.destination);
    }
    startSent = true;
    ws.send(JSON.stringify({ type: 'start' }));
    chrome.runtime.sendMessage({ type: 'started' }).catch(function () {});
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
          item.audioEl.volume = settings.ttsVolume / 100;
          item.audioEl.playbackRate = TTS_RATE_FINAL;
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
      if (item.audioEl) item.audioEl.playbackRate = TTS_RATE_FINAL;
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
    subtitleMode = false;
    startSent = false;
    warmupDone = false;
    preheatReady = false;
    preheatActive = false;

    // Use persistent pipeline: keep existing WS and AudioContext alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      startVideoWatcher();
      duckVideoAudio();
      showLoading();
      ws.send(JSON.stringify({ type: 'warmup' }));
      return;
    }

    // No live connection — do full connect
    startVideoWatcher();
    duckVideoAudio();
    showLoading();
    connectWebSocket();
  }

  function duckVideoAudio() {
    const video = findVideoElement();
    if (video) {
      savedVolume = video.volume;
      video.volume = settings.originalVolume / 100;
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

    // Kill preheat state (but keep audio pipeline alive if it exists)
    stopDOMSubtitleObserver();
    preheatReady = false;

    // Stop preheat active — if there's a preheat WS in flight, kill it
    // (but don't kill an already-established pipeline WS)
    if (preheatActive && ws) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    preheatActive = false;

    duckVideoAudio();
    showLoading();

    // Safety timeout
    loadingOverlay._safetyTimer = setTimeout(function () {
      if (!warmupDone) {
        finishWarmup();
      }
    }, 15000);

    // Try subtitle extraction for sync mode
    var subs = await extractSubtitles();
    if (subs && subs.length > 0) {
      syncMode = true;
      pendingSubs = subs;

      // Sync mode needs fresh WS for preprocess pipeline
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

    // API extraction failed — try DOM subtitle observer for YouTube
    subtitleMode = canObserveDOMSubtitles();
    if (subtitleMode) {
      clearTimeout(subtitleModeTimer);
      subtitleModeTimer = setTimeout(function () {
        if (subtitleMode && isRunning && !lastDOMSubtitle) {
          sendStatus('error', '字幕捕获超时，回退到 ASR');
          fallbackToASR();
        }
      }, 12000);
      // DOM subtitle mode needs fresh WS
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

    // No subtitles at all — use persistent ASR pipeline
    startASRMode();
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
    destroyPipeline();
    stopTTS();
    contentDiv.innerHTML = '';
    subtitleBox = null;
    speakerEl = null;
    originalLine = null;
    translationLine = null;
    finishWarmup();

    chrome.runtime.sendMessage({ type: 'stopped' }).catch(function () {});
  }

  function updateSettings(newSettings) {
    Object.assign(settings, newSettings);
    applyDisplaySettings(newSettings);
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

      case 'updateDisplaySettings':
        applyDisplaySettings(message.settings || {});
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

    // Apply display settings in real-time
    applyDisplaySettings(newSettings);
  });

  // Load saved settings from storage on init
  chrome.storage.local.get('translationSettings', function (result) {
    if (result.translationSettings) {
      updateSettings(result.translationSettings);
    }
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
