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
  let wasPaused = false;          // track pause→play transitions
  let syncLastCleanup = 0;        // last time sliding window cleanup ran
  let syncPrevActiveItem = null;  // detect activeItem transitions for word highlight reset
  let currentSyncAudio = null;    // (managed by queue, kept for backward compat)

  // DOM subtitle observer state
  let subtitleMode = false;       // true = DOM caption extraction mode
  let domObserver = null;         // MutationObserver for caption elements
  let ccClickHandler = null;      // capture-phase click handler on CC button
  let ccClickTarget = null;       // CC button element the handler is attached to
  let ccKeyHandler = null;        // capture-phase keydown handler to block 'c' hotkey
  let ccAttrObserver = null;      // watches aria-pressed, re-enables CC if YouTube resets it
  let captionStyleEl = null;      // (unused, kept for compat)
  let lastDOMSubtitle = '';       // deduplicate consecutive identical captions
  let ccMuteUntil = 0;           // mute DOM capture for N ms after CC click
  let subtitleModeTimer = null;  // timeout: fallback to ASR if no captions

  // Offline ASR state
  let offlineMode = false;        // true = offline full-audio ASR mode
  let offlineRecording = false;   // true = currently recording (Phase 1)
  let offlineVideo = null;        // the video being recorded/replayed
  let offlineAudioCtx = null;     // AudioContext for capture (shared with real-time ASR)
  let offlineStream = null;       // MediaStream from captureStream
  let offlineProcessor = null;    // ScriptProcessor for offline PCM capture
  let offlineSavedRate = 1;       // saved playbackRate before speed-up
  let offlineSavedVolume = 1;     // saved volume before mute
  const OFFLINE_SPEED = 2.0;      // playback speed during recording phase (2x faster collection)

  // ─── Loading Overlay (shown during warmup, auto-hides on first TTS) ──
  let loadingTarget = null;  // video element to track position for loading overlay
  let loadingRafId = null;   // RAF loop for repositioning loading overlay
  let subtitlePosRafId = null; // RAF loop for repositioning subtitle overlay over video

  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = '__ai_loading_overlay__';
  loadingOverlay.innerHTML = `
    <style>
      #__ai_loading_overlay__ {
        position: fixed !important;
        z-index: 2147483646 !important;
        background: #0a0a1a !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: -apple-system, 'Microsoft YaHei', 'PingFang SC', sans-serif !important;
        pointer-events: all !important;
        overflow: hidden !important;
        transition: opacity 0.3s !important;
      }
      /* Mesh gradient background */
      #__ai_loading_overlay__::before {
        content: '' !important;
        position: absolute !important;
        inset: 0 !important;
        background:
          radial-gradient(ellipse 60% 50% at 30% 30%, rgba(99,102,241,0.25), transparent),
          radial-gradient(ellipse 50% 60% at 70% 60%, rgba(168,85,247,0.2), transparent),
          radial-gradient(ellipse 40% 40% at 50% 50%, rgba(59,130,246,0.15), transparent) !important;
        animation: __mesh_pulse__ 4s ease-in-out infinite !important;
      }
      @keyframes __mesh_pulse__ {
        0%, 100% { opacity: 0.7; }
        50% { opacity: 1; }
      }
      /* Scanning line */
      #__ai_loading_overlay__::after {
        content: '' !important;
        position: absolute !important;
        left: 0 !important; right: 0 !important;
        height: 2px !important;
        background: linear-gradient(90deg, transparent, rgba(99,102,241,0.6), rgba(168,85,247,0.6), transparent) !important;
        animation: __scan__ 2.5s linear infinite !important;
        pointer-events: none !important;
      }
      @keyframes __scan__ {
        0% { top: -2px; }
        100% { top: 100%; }
      }
      /* Pulsing ring */
      .__ai_ring__ {
        position: absolute !important;
        width: 120px; height: 120px;
        border-radius: 50% !important;
        border: 1px solid rgba(99,102,241,0.4) !important;
        animation: __ring__ 2s ease-out infinite !important;
        pointer-events: none !important;
      }
      .__ai_ring__:nth-child(2) { animation-delay: 0.6s; }
      .__ai_ring__:nth-child(3) { animation-delay: 1.2s; }
      @keyframes __ring__ {
        0% { transform: scale(0.6); opacity: 0.8; }
        100% { transform: scale(2.0); opacity: 0; }
      }
      /* Equalizer bars */
      .__ai_eq__ {
        position: absolute !important;
        bottom: 40% !important;
        display: flex !important;
        align-items: flex-end !important;
        gap: 4px !important;
        height: 48px !important;
        pointer-events: none !important;
      }
      .__ai_eq__ span {
        width: 5px !important;
        border-radius: 3px !important;
        background: linear-gradient(180deg, #a855f7, #6366f1) !important;
        animation: __eq__ 0.9s ease-in-out infinite !important;
      }
      .__ai_eq__ span:nth-child(1) { height: 18px; animation-delay: 0s; }
      .__ai_eq__ span:nth-child(2) { height: 38px; animation-delay: 0.1s; }
      .__ai_eq__ span:nth-child(3) { height: 25px; animation-delay: 0.2s; }
      .__ai_eq__ span:nth-child(4) { height: 48px; animation-delay: 0.3s; }
      .__ai_eq__ span:nth-child(5) { height: 32px; animation-delay: 0.4s; }
      .__ai_eq__ span:nth-child(6) { height: 22px; animation-delay: 0.5s; }
      .__ai_eq__ span:nth-child(7) { height: 42px; animation-delay: 0.6s; }
      .__ai_eq__ span:nth-child(8) { height: 28px; animation-delay: 0.7s; }
      @keyframes __eq__ {
        0%, 100% { transform: scaleY(0.5); opacity: 0.5; }
        50% { transform: scaleY(1); opacity: 1; }
      }
      .__ai_content__ {
        position: relative !important;
        z-index: 1 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
      }
      .__ai_logo__ {
        width: 56px; height: 56px;
        border-radius: 16px !important;
        background: linear-gradient(135deg, #6366f1, #a855f7) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin-bottom: 20px !important;
        box-shadow: 0 0 32px rgba(99,102,241,0.4) !important;
      }
      .__ai_logo__ svg { width: 28px; height: 28px; fill: #fff; }
      #__ai_loading_overlay__ .loading-text {
        position: relative !important;
        z-index: 1 !important;
        color: #e2e8f0 !important;
        font-size: 15px !important;
        font-weight: 600 !important;
        letter-spacing: 1px !important;
      }
      #__ai_loading_overlay__ .loading-sub {
        position: relative !important;
        z-index: 1 !important;
        color: rgba(148,163,184,0.8) !important;
        font-size: 12px !important;
        margin-top: 8px !important;
        letter-spacing: 0.5px !important;
      }
      /* Corner accents */
      .__ai_corner__ {
        position: absolute !important;
        width: 40px; height: 40px;
        pointer-events: none !important;
        border-color: rgba(99,102,241,0.5) !important;
        border-style: solid !important;
      }
      .__ai_corner__.tl { top: 12px; left: 12px; border-width: 2px 0 0 2px; border-radius: 4px 0 0 0; }
      .__ai_corner__.tr { top: 12px; right: 12px; border-width: 2px 2px 0 0; border-radius: 0 4px 0 0; }
      .__ai_corner__.bl { bottom: 12px; left: 12px; border-width: 0 0 2px 2px; border-radius: 0 0 0 4px; }
      .__ai_corner__.br { bottom: 12px; right: 12px; border-width: 0 2px 2px 0; border-radius: 0 0 4px 0; }
    </style>
    <div class="__ai_corner__ tl"></div><div class="__ai_corner__ tr"></div>
    <div class="__ai_corner__ bl"></div><div class="__ai_corner__ br"></div>
    <div class="__ai_ring__"></div><div class="__ai_ring__"></div><div class="__ai_ring__"></div>
    <div class="__ai_eq__"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    <div class="__ai_content__">
      <div class="__ai_logo__">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      </div>
      <div class="loading-text" id="__ai_load_title__">AI 翻译引擎启动</div>
      <div class="loading-sub" id="__ai_load_sub__">正在分析音频流...</div>
    </div>
  `;

  // ─── Bookmark Tab (right edge, like a bookmark peeking out) ─────────
  const fab = document.createElement('div');
  fab.id = '__ai_fab__';
  fab.title = 'AI 翻译';
  fab.innerHTML = `
    <style>
      #__ai_fab__ {
        position: fixed !important;
        top: 42% !important;
        right: 0 !important;
        z-index: 2147483647 !important;
        width: 42px !important;
        height: 62px !important;
        border-radius: 12px 0 0 12px !important;
        background: linear-gradient(180deg, #7c3aed 0%, #6d28d9 50%, #5b21b6 100%) !important;
        box-shadow: -3px 0 14px rgba(124, 58, 237, 0.32), 0 0 24px rgba(139, 92, 246, 0.12) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        cursor: pointer !important;
        pointer-events: all !important;
        transition: width 0.25s, box-shadow 0.25s, background 0.25s !important;
        user-select: none !important;
        overflow: hidden !important;
      }
      /* Bookmark fold notch */
      #__ai_fab__::before {
        content: '' !important;
        position: absolute !important;
        top: 0 !important; right: 0 !important;
        width: 0 !important; height: 0 !important;
        border-style: solid !important;
        border-width: 0 14px 14px 0 !important;
        border-color: transparent #1e1b2e transparent transparent !important;
        transition: border-right-color 0.25s !important;
      }
      #__ai_fab__:hover {
        width: 50px !important;
        box-shadow: -6px 0 22px rgba(124, 58, 237, 0.48), 0 0 36px rgba(139, 92, 246, 0.22) !important;
      }
      #__ai_fab__:active { width: 38px !important; }
      #__ai_fab__ svg { width: 20px; height: 20px; fill: #fff; flex-shrink: 0; }
      #__ai_fab__ .fab-label {
        color: rgba(255,255,255,0.85) !important;
        font-size: 10px !important;
        font-family: -apple-system, 'Microsoft YaHei', 'PingFang SC', sans-serif !important;
        writing-mode: vertical-rl !important;
        letter-spacing: 3px !important;
        font-weight: 500 !important;
      }
      #__ai_fab__.running {
        background: linear-gradient(180deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%) !important;
        box-shadow: -3px 0 14px rgba(239, 68, 68, 0.32), 0 0 24px rgba(248, 113, 113, 0.12) !important;
      }
      #__ai_fab__.running::before { border-right-color: #1e1b2e !important; }
      #__ai_fab__.running svg.play-icon { display: none; }
      #__ai_fab__:not(.running) svg.pause-icon { display: none; }
      #__ai_fab__.loading {
        pointer-events: none !important;
        opacity: 0.55 !important;
      }
    </style>
    <svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    <svg class="pause-icon" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
    <span class="fab-label">翻译</span>
  `;

  // ─── Subtitle Overlay ─────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__ai_subtitle_overlay__';
  overlay.innerHTML = `
    <style>
      #__ai_subtitle_overlay__ {
        position: fixed !important;
        /* top, left, max-width set dynamically via JS to follow video rect */
        transform: translateX(-50%) !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        font-family: -apple-system, 'Microsoft YaHei', 'PingFang SC', sans-serif !important;
        text-align: center !important;
        transition: opacity 0.3s !important;
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
    </style>
    <div id="__subtitle_content__"></div>
  `;
  document.body.appendChild(overlay);
  document.body.appendChild(fab);

  // Reposition subtitle on fullscreen change or window resize
  document.addEventListener('fullscreenchange', function () {
    if (isRunning) updateSubtitlePosition();
  });
  window.addEventListener('resize', function () {
    if (isRunning) updateSubtitlePosition();
  });

  // FAB click handler
  fab.addEventListener('click', function () {
    if (fab.classList.contains('loading')) return;
    if (isRunning) {
      stop();
    } else {
      start();
    }
  });

  const contentDiv = overlay.querySelector('#__subtitle_content__');

  // ─── Display Settings (applied in real-time) ──────────────────────
  function applySubtitleEnabled(enabled) {
    settings.subtitleEnabled = enabled;
    overlay.style.setProperty('display', enabled ? '' : 'none', 'important');
    if (!enabled) {
      // Clear current subtitle immediately
      if (subtitleBox) subtitleBox.style.opacity = '0';
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
  let subtitleBox = null;
  let originalLine = null;
  let translationLine = null;

  function ensureElements() {
    if (subtitleBox) return;
    subtitleBox = document.createElement('div');
    subtitleBox.className = 'subtitle-box';
    subtitleBox.style.opacity = '0';
    originalLine = document.createElement('div');
    originalLine.className = 'subtitle-line subtitle-original';
    translationLine = document.createElement('div');
    translationLine.className = 'subtitle-line subtitle-translation';
    subtitleBox.appendChild(originalLine);
    subtitleBox.appendChild(translationLine);
    contentDiv.appendChild(subtitleBox);
  }

  function showSubtitle(original, translation) {
    original = stripCCAnnouncement(original);
    translation = stripCCAnnouncement(translation);

    // When original === translation (skip-translate), show single line
    if (original && translation && original === translation) {
      original = null;
    }

    ensureElements();

    // Update text content (no DOM rebuild, no animation replay)
    const hasContent = original || translation;
    if (hasContent) {
      originalLine.textContent = original || '';
      translationLine.textContent = translation || '';
      subtitleBox.style.display = 'inline-block';
      subtitleBox.style.transition = 'none';
      subtitleBox.style.opacity = '1';
      // Re-enable transition after paint for future auto-clear fade-out
      requestAnimationFrame(function () {
        subtitleBox.style.transition = '';
      });
      startSubtitlePositioning();
    } else {
      subtitleBox.style.opacity = '0';
    }

    // Auto-clear after 5 seconds (fade out via transition)
    clearTimeout(contentDiv._clearTimer);
    contentDiv._clearTimer = setTimeout(() => {
      subtitleBox.style.opacity = '0';
    }, 5000);
  }

  function updateSubtitlePosition() {
    var video = duckedVideo || activeVideo || findVideoElement();
    if (!video || !video.isConnected) {
      // Fallback: center bottom of viewport
      overlay.style.setProperty('bottom', '100px', 'important');
      overlay.style.setProperty('left', '50%', 'important');
      overlay.style.setProperty('max-width', '85vw', 'important');
      return;
    }
    var rect = video.getBoundingClientRect();
    // Place subtitle at the bottom of the video area, centered
    // Keep at least 60px from the bottom of the viewport to avoid overlapping player controls
    var bottomFromVideo = window.innerHeight - rect.bottom;
    var bottom = Math.max(bottomFromVideo + 20, 60);
    overlay.style.setProperty('bottom', bottom + 'px', 'important');
    overlay.style.setProperty('left', (rect.left + rect.width / 2) + 'px', 'important');
    overlay.style.setProperty('max-width', Math.max(300, rect.width * 0.85) + 'px', 'important');
  }

  function startSubtitlePositioning() {
    if (subtitlePosRafId) return;
    function loop() {
      if (!isRunning) { subtitlePosRafId = null; return; }
      updateSubtitlePosition();
      subtitlePosRafId = requestAnimationFrame(loop);
    }
    subtitlePosRafId = requestAnimationFrame(loop);
  }

  function stopSubtitlePositioning() {
    if (subtitlePosRafId) {
      cancelAnimationFrame(subtitlePosRafId);
      subtitlePosRafId = null;
    }
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

  function stopTTS(all) {
    // Stop currently playing audio immediately
    if (ttsAudio) {
      try { ttsAudio.pause(); } catch (_) {}
      ttsAudio = null;
      ttsAudioUrl = null;
    }
    // Clear queued items
    for (const item of ttsQueue) {
      URL.revokeObjectURL(item.url);
      if (item.audio) {
        try { item.audio.pause(); } catch (_) {}
      }
    }
    ttsQueue = [];
    ttsFallbackChunks = [];
    ttsPlaying = false;
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

  function isLiveStream(video) {
    if (!video) return false;
    if (!isFinite(video.duration)) return true;
    if (document.querySelector('.ytp-live-badge')) return true;
    if (document.querySelector('.live-status-icon') || document.querySelector('.bilibili-live-player')) return true;
    return false;
  }


  // ─── DOM Subtitle Observer (YouTube caption element scraping) ──────────
  // Watches YouTube's built-in caption display elements and extracts text
  // in real-time. This bypasses YouTube's timedtext API blocks.

  function canObserveDOMSubtitles() {
    var player = document.querySelector("#movie_player") ||
                 document.querySelector(".html5-video-player");
    return !!player;
  }

  // Dispatch a full MouseEvent on the CC button. Using dispatchEvent
  // instead of .click() is more compatible with YouTube's React handlers.
  function clickCCButton(btn) {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    ccMuteUntil = Date.now() + 2000;
  }

  // Try to force CC on, with retry. Returns true once aria-pressed is 'true'.
  function forceEnableCC(btn, player) {
    if (!btn) return false;
    if (btn.getAttribute('aria-pressed') === 'true') return true;

    var tries = 0;
    function attempt() {
      if (!subtitleMode || !isRunning) return;
      var b = player.querySelector('.ytp-subtitles-button');
      if (!b) return;
      if (b.getAttribute('aria-pressed') === 'true') return;
      tries++;
      clickCCButton(b);
      if (tries < 5) {
        setTimeout(function () {
          if (b.getAttribute('aria-pressed') !== 'true') attempt();
        }, 600);
      }
    }
    attempt();
    return false; // async, result not immediately known
  }

  function setupCCButton(btn, player) {
    if (!btn) return;
    forceEnableCC(btn, player);

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

    // Block 'c' keyboard shortcut (YouTube CC toggle) — allow programmatic events
    ccKeyHandler = function (e) {
      if (!e.isTrusted) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.key === 'c' || e.key === 'C') {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', ccKeyHandler, true);

    // Watch aria-pressed — YouTube may reset it after ads or rebinds
    if (ccAttrObserver) ccAttrObserver.disconnect();
    ccAttrObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'attributes' && m.attributeName === 'aria-pressed') {
          var b = m.target;
          if (b.getAttribute('aria-pressed') === 'false' && subtitleMode && isRunning) {
            forceEnableCC(b, player);
          }
        }
      }
    });
    ccAttrObserver.observe(btn, { attributes: true, attributeFilter: ['aria-pressed'] });
  }

  function startDOMSubtitleObserver() {
    // Clean up any previous observers (safe to call multiple times)
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    if (ccClickHandler && ccClickTarget) {
      ccClickTarget.removeEventListener('click', ccClickHandler, true);
      ccClickHandler = null;
      ccClickTarget = null;
    }
    if (ccAttrObserver) { ccAttrObserver.disconnect(); ccAttrObserver = null; }
    if (ccKeyHandler) { document.removeEventListener('keydown', ccKeyHandler, true); ccKeyHandler = null; }

    var player = document.querySelector('#movie_player') ||
                 document.querySelector('.html5-video-player');
    if (!player) {
      return false;
    }

    var ccBtn = player.querySelector('.ytp-subtitles-button');
    if (ccBtn) {
      setupCCButton(ccBtn, player);
    }

    // MutationObserver to catch CC button appearing later (infinite patience)
    var ccBtnWatcher = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        for (var j = 0; j < mutations[i].addedNodes.length; j++) {
          var node = mutations[i].addedNodes[j];
          if (node.nodeType !== 1) continue;
          var btn = node.classList && node.classList.contains('ytp-subtitles-button')
            ? node : node.querySelector && node.querySelector('.ytp-subtitles-button');
          if (btn && btn.getAttribute('aria-pressed') === 'false') {
            setupCCButton(btn, player);
            ccBtnWatcher.disconnect();
            return;
          }
        }
      }
    });
    ccBtnWatcher.observe(player, { childList: true, subtree: true });

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

    var captionsRecovered = false;
    function checkAndSend() {
      if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() < ccMuteUntil) return;
      var text = getCurrentCaptionText();
      text = stripCCAnnouncement(text);
      if (!text) return;
      if (text !== lastDOMSubtitle && text.length >= 2) {
        // First caption after ASR fallback — kill ASR audio pipeline
        if (!captionsRecovered && activeStream) {
          captionsRecovered = true;
          var tracks = activeStream.getAudioTracks();
          for (var k = 0; k < tracks.length; k++) {
            tracks[k].stop();
          }
          activeStream = null;
        }
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
    if (ccKeyHandler) {
      document.removeEventListener('keydown', ccKeyHandler, true);
      ccKeyHandler = null;
    }
    lastDOMSubtitle = '';
    subtitleMode = false;
  }


  // ─── Subtitle Extraction ───────────────────────────────────────────
  // Content scripts run in ISOLATED world by default, so we can't read
  // window.ytInitialPlayerResponse / __INITIAL_STATE__ directly.
  // Instead we inject a tiny script into MAIN world that posts the data
  // back via a CustomEvent on document (DOM is shared between worlds).

  async function tryExtractBilibiliSubs() {
    if (location.hostname.includes('bilibili.com')) return extractBilibiliSubs();
    return null;
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
      // Unmute before capture — some sites (TikTok) mute on page load
      video.muted = false;
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
            if (v.duration > 0 && !v.paused && v !== activeVideo && isRunning) {
              captureVideoAudio(v);
              return;
            }
          }
        }

        // Detect removed video elements — stop translation on swipe/scroll
        for (var r = 0; r < m.removedNodes.length; r++) {
          var removed = m.removedNodes[r];
          if (removed.nodeType !== 1) continue;
          if (removed === activeVideo || (removed.contains && removed.contains(activeVideo)) ||
              removed === syncVideo || (removed.contains && removed.contains(syncVideo)) ||
              removed === offlineVideo || (removed.contains && removed.contains(offlineVideo))) {
            stop();
            return;
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

      // Offline ASR: signal start of audio streaming
      if (offlineMode && offlineRecording) {
        var actualRate = (offlineAudioCtx && offlineAudioCtx.sampleRate) ? offlineAudioCtx.sampleRate : 48000;
        ws.send(JSON.stringify({ type: 'offline_asr_start', sampleRate: actualRate, speed: OFFLINE_SPEED }));
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
        updateLoadingText('模型推理中...', '已处理 ' + msg.total + ' 个片段');
        sendStatus('preprocessing', '处理 ' + msg.total + ' 个片段...');
        break;

      case 'preprocess_result':
        if (msg.items) {
          for (const item of msg.items) {
            preprocessedItems.push(item);
          }
          preprocessedItems.sort((a, b) => a.index - b.index);
          // Early replay: start playback as soon as first batch is ready
          if (msg.ready && !syncRafId && offlineMode && offlineVideo) {
            updateLoadingText('首批就绪', '正在启动回放...');
            sendStatus('playing');
            startVideoReplay(offlineVideo);
          }
        }
        break;

      case 'preprocess_complete':
        // Save to IndexedDB cache (always, even during early replay)
        if (offlineVideo) {
          savePreprocessedToCache(offlineVideo, preprocessedItems);
        }
        // Start replay if not already started by early batch
        if (!syncRafId) {
          sendStatus('playing');
          if (offlineMode && offlineVideo) {
            startVideoReplay(offlineVideo);
          } else {
            startSyncPlayback();
          }
        }
        break;

      case 'offline_asr_result':
        if (msg.subs && msg.subs.length > 0) {
          offlineRecording = false;
          // Don't close offlineAudioCtx — it's the global audioContext shared with real-time ASR
          if (offlineProcessor) { offlineProcessor.disconnect(); offlineProcessor = null; }
          offlineAudioCtx = null;
          if (offlineStream) { offlineStream.getTracks().forEach(function(t) { t.stop(); }); offlineStream = null; }
          if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
          updateLoadingText('模型推理中...', '已处理 ' + msg.subs.length + ' 个片段');
          sendStatus('preprocessing', '模型推理中...');
          ws.send(JSON.stringify({ type: 'preprocess', subs: msg.subs }));
        } else {
          sendStatus('error', '离线 ASR 未识别到字幕');
          cleanupOffline();
        }
        break;

      case 'preprocess_error':
        sendStatus('error', msg.message);
        cleanupOffline();
        break;

      // ─── Status ────────────────────────────────────────────────────
      case 'status':
        if (msg.status === 'configured') {
          if (!syncMode && !offlineMode) {
            // In ASR mode: send warmup. In sync/offline mode: skip.
            ws.send(JSON.stringify({ type: 'warmup' }));
          }
        } else if (msg.status === 'ready') {
          if (preheatActive) {
            preheatPhase2();
          } else if (!startSent && !syncMode && !offlineMode) {
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
        if (offlineMode) {
          cleanupOffline();
        } else {
          finishWarmup();
        }
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
  let syncLoadingHidden = false;  // separate from warmupDone: hide loading only when first subtitle renders
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
    fab.classList.add('loading');
    if (!loadingOverlay.parentNode) {
      document.body.appendChild(loadingOverlay);
    }
    loadingOverlay.style.setProperty('display', 'flex', 'important');
    if (!loadingTarget) {
      loadingTarget = findVideoElement();
    }
    // Immediate first position to avoid flash
    applyOverlayPosition();
    if (loadingTarget && !loadingRafId) {
      positionLoadingOverlay();
    }
  }

  function applyOverlayPosition() {
    if (!loadingTarget || !loadingTarget.isConnected) {
      loadingTarget = findVideoElement();
    }
    if (!loadingTarget) {
      loadingOverlay.style.setProperty('left', '0', 'important');
      loadingOverlay.style.setProperty('top', '0', 'important');
      loadingOverlay.style.setProperty('width', '100vw', 'important');
      loadingOverlay.style.setProperty('height', '100vh', 'important');
      loadingOverlay.style.setProperty('border-radius', '0', 'important');
      return;
    }
    var rect = loadingTarget.getBoundingClientRect();
    var isVisible = rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
    if (!isVisible) {
      loadingOverlay.style.setProperty('display', 'none', 'important');
      return;
    }
    loadingOverlay.style.setProperty('display', 'flex', 'important');
    loadingOverlay.style.setProperty('left', rect.left + 'px', 'important');
    loadingOverlay.style.setProperty('top', rect.top + 'px', 'important');
    loadingOverlay.style.setProperty('width', rect.width + 'px', 'important');
    loadingOverlay.style.setProperty('height', rect.height + 'px', 'important');
    var style = window.getComputedStyle(loadingTarget);
    loadingOverlay.style.setProperty('border-radius', style.borderRadius, 'important');
  }

  function positionLoadingOverlay() {
    loadingRafId = requestAnimationFrame(positionLoadingOverlay);
    applyOverlayPosition();
  }

  function updateLoadingText(title, sub) {
    var titleEl = document.getElementById('__ai_load_title__');
    var subEl = document.getElementById('__ai_load_sub__');
    if (titleEl && title) titleEl.textContent = title;
    if (subEl && sub) subEl.textContent = sub;
  }

  function hideLoading() {
    fab.classList.remove('loading');
    clearTimeout(loadingOverlay._safetyTimer);
    clearTimeout(loadingOverlay._resumeTimer);
    if (loadingRafId) {
      cancelAnimationFrame(loadingRafId);
      loadingRafId = null;
    }
    loadingTarget = null;
    loadingOverlay.style.setProperty('display', 'none', 'important');
  }

  function finishWarmup() {
    if (warmupDone) return;
    warmupDone = true;
    unduckVideoAudio();
    // In offline/sync mode, keep loading until first subtitle renders
    if (offlineMode || syncMode) return;
    hideLoading();
  }

  // ─── Sync Playback Engine (subtitle hijacking mode) ──────────────────

  function startVideoReplay(video) {
    wasPaused = false;
    syncLastCleanup = 0;
    syncPrevActiveItem = null;
    syncMode = true;
    syncVideo = video;
    video.playbackRate = 1;
    video.muted = false;
    video.volume = settings.originalVolume / 100;
    duckedVideo = null;  // prevent unduck from overriding our volume

    // Create Audio elements for preprocessed items
    for (var i = 0; i < preprocessedItems.length; i++) {
      var item = preprocessedItems[i];
      if (item.audio && !item.audioEl) {
        try {
          item.audioEl = new Audio('data:audio/mp3;base64,' + item.audio);
          item.audioEl.volume = settings.ttsVolume / 100;
          item.audioEl.playbackRate = 1.0;
        } catch (e) {}
      }
    }

    function doReplay() {
      video.removeEventListener('seeked', doReplay);
      if (video.paused) {
        video.play().catch(function () {});
      }
      if (video.currentTime > 1.0) {
        video.currentTime = 0;
        setTimeout(function () {
          unduckVideoAudio();
          if (!syncRafId) syncLoop();
        }, 200);
        return;
      }
      unduckVideoAudio();
      video.addEventListener('ratechange', onVideoRateChange);
      lastSyncTime = video.currentTime;
      chrome.runtime.sendMessage({ type: 'started' }).catch(function () {});
      syncLoop();
    }

    var seekTimeout = null;
    video.addEventListener('seeked', doReplay, { once: true });
    seekTimeout = setTimeout(function () {
      video.removeEventListener('seeked', doReplay);
      doReplay();
    }, 500);
    video.currentTime = 0;
    video.play().catch(function () {
      if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
      video.removeEventListener('seeked', doReplay);
      doReplay();
    });
  }

  function startSyncPlayback() {
    syncLastCleanup = 0;
    syncPrevActiveItem = null;
    syncVideo = findVideoElement();
    if (!syncVideo) {
      sendStatus('error', '未找到视频元素');
      return;
    }

    // Pre-create Audio elements for each item that has TTS audio
    for (const item of preprocessedItems) {
      if (item.audio) {
        try {
          item.audioEl = new Audio('data:audio/mp3;base64,' + item.audio);
          item.audioEl.volume = settings.ttsVolume / 100;
          item.audioEl.playbackRate = 1.0;
        } catch (e) {
        }
      }
    }

    // Monitor playback rate changes
    syncVideo.addEventListener('ratechange', onVideoRateChange);

    lastSyncTime = syncVideo.currentTime;
    chrome.runtime.sendMessage({ type: 'started' }).catch(() => {});
    unduckVideoAudio();
    syncLoop();
  }

  function syncLoop() {
    syncRafId = requestAnimationFrame(syncLoop);

    if (!syncVideo) return;

    var now = syncVideo.currentTime;
    var paused = syncVideo.paused;

    // Video paused — pause TTS, keep position
    if (paused && !wasPaused) {
      wasPaused = true;
      stopTTS(); // clear queue
      if (ttsAudio) {
        try { ttsAudio.pause(); } catch (_) {}
      }
      return;
    }

    // Video resumed — resume TTS from where it paused
    if (!paused && wasPaused) {
      wasPaused = false;
      if (ttsAudio && ttsAudio.paused) {
        try { ttsAudio.play().catch(function () {}); } catch (_) {}
      }
      lastSyncTime = now;
      return;
    }

    if (paused) return;

    const currentTime = now;

    // Detect seeking (jump > 1 second)
    if (Math.abs(currentTime - lastSyncTime) > 1.0) {
      reSync(currentTime);
    }
    lastSyncTime = currentTime;

    var activeItem = null;

    for (const item of preprocessedItems) {
      if (currentTime >= item.start && currentTime < item.end) {
        activeItem = item;
        if (!item.played) {
          item.played = true;
          showSubtitle(item.original, item.translation);
          if (!syncLoadingHidden) { syncLoadingHidden = true; unduckVideoAudio(); hideLoading(); }
          if (item.audioEl) {
            // Stop previous TTS immediately so new sentence audio plays on time
            stopTTS();
            enqueueAudio(item.audioEl, item.audioEl.src);
            item.audioEl = null;
          }
        }
        break;
      }
    }

    // Sliding window: periodically trim played items behind current position
    if (!syncLastCleanup || currentTime - syncLastCleanup > 5) {
      syncLastCleanup = currentTime;
      var keepFrom = currentTime - 15; // keep items within 15s behind
      var firstKept = 0;
      for (var ci = 0; ci < preprocessedItems.length; ci++) {
        if (preprocessedItems[ci].end > keepFrom) { firstKept = ci; break; }
        // Release audio resources for old items
        if (preprocessedItems[ci].audioEl) {
          try { preprocessedItems[ci].audioEl.pause(); } catch (_) {}
          preprocessedItems[ci].audioEl = null;
        }
        preprocessedItems[ci].audio = null; // free base64 string
      }
      if (firstKept > 0) {
        preprocessedItems.splice(0, firstKept);
      }
    }

    // Word-by-word highlighting for active item
    if (activeItem !== syncPrevActiveItem) {
      syncPrevActiveItem = activeItem;
      // Force re-highlight when transitioning to a new item
      if (activeItem) activeItem._wordIdx = -2;
    }
    if (activeItem && activeItem.words && activeItem.words.length > 0) {
      var wordIdx = -1;
      for (var w = 0; w < activeItem.words.length; w++) {
        if (currentTime >= activeItem.words[w].start && currentTime < activeItem.words[w].end) {
          wordIdx = w;
          break;
        }
      }
      // Also handle case after last word's end but before segment end
      if (wordIdx < 0 && currentTime >= activeItem.words[activeItem.words.length - 1].end) {
        wordIdx = activeItem.words.length;
      }
      if (wordIdx !== activeItem._wordIdx) {
        activeItem._wordIdx = wordIdx;
        highlightOriginalWord(activeItem, wordIdx);
      }
    }
  }

  function reSync(currentTime) {
    wasPaused = false;
    // Clear queue and stop ALL audio on seek/loop
    stopTTS();
    if (ttsAudio) {
      try { ttsAudio.pause(); } catch (_) {}
      ttsAudio = null;
      ttsPlaying = false;
    }
    syncPrevActiveItem = null;  // force re-highlight on next frame
    // Reset all items at or after currentTime for replay on loop/seek
    for (const item of preprocessedItems) {
      item._wordIdx = -1;
      if (currentTime < item.end) {
        item.played = false; // re-trigger for display
        // Re-create Audio element on loop (it was consumed and set to null)
        if (!item.audioEl && item.audio) {
          try {
            item.audioEl = new Audio('data:audio/mp3;base64,' + item.audio);
            item.audioEl.volume = settings.ttsVolume / 100;
            item.audioEl.playbackRate = 1.0;
          } catch (e) {}
        }
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

  function highlightOriginalWord(item, wordIdx) {
    if (!item || !item.words || item.words.length === 0) return;
    if (wordIdx < 0) {
      // No word active yet — show plain text
      originalLine.textContent = item.original;
      return;
    }
    if (wordIdx >= item.words.length) {
      // All words spoken but segment still active — keep text visible, don't dim
      originalLine.textContent = item.original;
      return;
    }
    // Build highlighted HTML: split by word boundaries
    var word = item.words[wordIdx].word;
    var text = item.original;
    var idx = text.indexOf(word);
    // Find the word in context (approximate match)
    var before = '', after = '', highlight = word;
    if (idx >= 0) {
      before = escapeHTML(text.substring(0, idx));
      highlight = escapeHTML(text.substring(idx, idx + word.length));
      after = escapeHTML(text.substring(idx + word.length));
    } else {
      // Fallback: just show text with word highlighted if we can find it
      var escaped = escapeHTML(text);
      var escapedWord = escapeHTML(word);
      var wIdx = escaped.indexOf(escapedWord);
      if (wIdx >= 0) {
        before = escaped.substring(0, wIdx);
        highlight = escaped.substring(wIdx, wIdx + escapedWord.length);
        after = escaped.substring(wIdx + escapedWord.length);
      } else {
        originalLine.textContent = text;
        return;
      }
    }
    originalLine.innerHTML = before + '<span style="color:#fbbf24;font-weight:600">' + highlight + '</span>' + after;
  }

  function onVideoRateChange() {
    for (const item of preprocessedItems) {
      if (item.audioEl) item.audioEl.playbackRate = 1.0;
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
    // Start ASR in parallel but keep DOM subtitle observer alive.
    // DO NOT set subtitleMode = false — captions may appear later and
    // the existing domObserver will pick them up automatically.
    startSent = false;
    warmupDone = false;
    syncLoadingHidden = false;
    preheatReady = false;
    preheatActive = false;

    if (ws && ws.readyState === WebSocket.OPEN) {
      startVideoWatcher();
      duckVideoAudio();
      showLoading();
      ws.send(JSON.stringify({ type: 'warmup' }));
      return;
    }

    startVideoWatcher();
    duckVideoAudio();
    showLoading();
    connectWebSocket();
  }

  function startASRMode() {
    syncMode = false;
    subtitleMode = false;
    startSent = false;
    warmupDone = false;
    syncLoadingHidden = false;
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

  // ─── Offline ASR (record full audio → ASR → preprocess → replay) ─────

  function cleanupOffline() {
    offlineRecording = false;
    // Don't close offlineAudioCtx — it's the global audioContext shared with real-time ASR
    if (offlineProcessor) { offlineProcessor.disconnect(); offlineProcessor = null; }
    offlineAudioCtx = null;
    if (offlineStream) { offlineStream.getTracks().forEach(function(t) { t.stop(); }); offlineStream = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (offlineVideo) {
      if (offlineVideo._offlineTimeUpdateHandler) {
        offlineVideo.removeEventListener('timeupdate', offlineVideo._offlineTimeUpdateHandler);
        offlineVideo._offlineTimeUpdateHandler = null;
      }
      try { offlineVideo.playbackRate = offlineSavedRate; } catch (_) {}
      try { offlineVideo.volume = offlineSavedVolume; } catch (_) {}
      offlineVideo = null;
    }
    offlineMode = false;
  }

  function onOfflineRecordingDone() {
    if (!offlineRecording) return;
    offlineRecording = false;

    // Don't close offlineAudioCtx — it's the global audioContext
    if (offlineProcessor) { offlineProcessor.disconnect(); offlineProcessor = null; }
    offlineAudioCtx = null;
    if (offlineStream) { offlineStream.getTracks().forEach(function(t) { t.stop(); }); offlineStream = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }

    // Clean up loop-detection timeupdate listener
    if (offlineVideo && offlineVideo._offlineTimeUpdateHandler) {
      offlineVideo.removeEventListener('timeupdate', offlineVideo._offlineTimeUpdateHandler);
      offlineVideo._offlineTimeUpdateHandler = null;
    }

    updateLoadingText('神经网络处理中...', '正在提取特征向量');

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'offline_asr_end' }));
    }
  }

  function startOfflineRecording(video) {
    offlineMode = true;
    offlineRecording = true;
    offlineVideo = video;
    offlineSavedRate = video.playbackRate;
    offlineSavedVolume = video.volume;

    // Unmute before captureStream — TikTok etc. mute on page load
    video.muted = false;
    var stream = video.captureStream();
    video.playbackRate = OFFLINE_SPEED;
    offlineStream = stream;
    var audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      cleanupOffline();
      sendStatus('error', '未捕获到音频，可能站点限制');
      return;
    }
    var audioStream = new MediaStream([audioTrack]);

    // Reuse the global AudioContext (same as real-time ASR) to avoid
    // suspended-state issues and ensure correct sample rate.
    if (!ensureAudioContext()) {
      cleanupOffline();
      sendStatus('error', '无法初始化音频上下文');
      return;
    }
    offlineAudioCtx = audioContext;
    sendStatus('offline_recording', 'AudioContext sampleRate: ' + offlineAudioCtx.sampleRate);

    var silentChunks = 0;
    var maxSilentChunks = Math.ceil(3000 / (4096 / (offlineAudioCtx.sampleRate || 48000) * 1000)); // ~3s worth
    var totalChunks = 0;

    offlineProcessor = offlineAudioCtx.createScriptProcessor(4096, 1, 1);
    offlineProcessor.onaudioprocess = function (e) {
      if (!offlineRecording) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      var input = e.inputBuffer.getChannelData(0);
      var pcm = new Int16Array(input.length);
      var maxAbs = 0;
      for (var i = 0; i < input.length; i++) {
        var clamped = Math.max(-1, Math.min(1, input[i]));
        var val = Math.round(clamped * 32767);
        pcm[i] = val;
        if (Math.abs(val) > maxAbs) maxAbs = Math.abs(val);
      }
      ws.send(pcm.buffer);

      // PCM silence monitor: detect captureStream() returning silent audio
      totalChunks++;
      if (maxAbs < 50) {
        silentChunks++;
        if (silentChunks >= maxSilentChunks) {
          offlineRecording = false;
          sendStatus('error', '未捕获到音频，可能站点限制');
          cleanupOffline();
          finishWarmup();
        }
      } else {
        silentChunks = 0; // reset on real audio
      }
    };

    // Disconnect any existing source and connect this stream for recording
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    sourceNode = offlineAudioCtx.createMediaStreamSource(audioStream);
    sourceNode.connect(offlineProcessor);
    // Connect to destination so onaudioprocess fires
    offlineProcessor.connect(offlineAudioCtx.destination);

    video.addEventListener('ended', onOfflineRecordingDone, { once: true });

    // TikTok auto-loop detection: watch for backward time jumps (looping without ended)
    var _lastTime = -1;
    function onOfflineTimeUpdate() {
      if (!offlineRecording) {
        video.removeEventListener('timeupdate', onOfflineTimeUpdate);
        return;
      }
      var t = video.currentTime;
      if (_lastTime >= 0 && t < _lastTime - 0.5) {
        // Video looped — treat as recording done
        onOfflineRecordingDone();
        video.removeEventListener('timeupdate', onOfflineTimeUpdate);
      }
      _lastTime = t;
    }
    video.addEventListener('timeupdate', onOfflineTimeUpdate);
    video._offlineTimeUpdateHandler = onOfflineTimeUpdate;

    loadingTarget = video;
    showLoading();
    updateLoadingText('数据采集中...', '帧同步处理');
    sendStatus('offline_recording');

    video.currentTime = 0;
    video.play();
  }

  async function start() {
    if (isRunning) return;
    isRunning = true;
    fab.classList.add('running');
    warmupDone = false;
    syncLoadingHidden = false;
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

    // Try Bilibili subtitle extraction for sync mode
    var subs = await tryExtractBilibiliSubs();
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

    // Bilibili extraction failed or not Bilibili — try DOM subtitle observer for YouTube
    subtitleMode = canObserveDOMSubtitles();
    if (subtitleMode) {
      // Kick CC button immediately — don't wait for WS warmup chain
      startDOMSubtitleObserver();
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

    // Not YouTube/Bilibili DOM — check VOD vs live
    var video = findVideoElement();
    if (video && !isLiveStream(video) && video.duration > 0) {
      // VOD: check IndexedDB cache first
      loadPreprocessedFromCache(video).then(function (cached) {
        if (cached && cached.length > 0) {
          // Cache hit — skip recording + ASR + preprocessing
          preprocessedItems = cached;
          offlineMode = true;
          offlineVideo = video;
          updateLoadingText('本地缓存匹配', '即时加载');
          sendStatus('playing');
          startVideoReplay(video);
        } else {
          // Cache miss — offline recording
          startOfflineRecording(video);
          if (ws) {
            ws.onclose = null;
            try { ws.close(); } catch (_) {}
            ws = null;
          }
          preheatReady = false;
          preheatActive = false;
          connectWebSocket();
        }
      });
      return;
    }

    // Live stream — real-time ASR
    startASRMode();
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    fab.classList.remove('running');
    startSent = false;
    stopSubtitlePositioning();

    if (syncMode) {
      stopSyncPlayback();
    }
    if (subtitleMode) {
      stopDOMSubtitleObserver();
    }
    if (offlineMode) {
      cleanupOffline();
    }

    disconnectWebSocket();
    destroyPipeline();
    stopTTS();
    // Clear subtitles instantly (no transition)
    if (subtitleBox) { subtitleBox.style.transition = 'none'; subtitleBox.style.opacity = '0'; }
    contentDiv.innerHTML = '';
    subtitleBox = null;
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

  // ─── IndexedDB cache for preprocessed results (max 10 videos) ──────
  const IDB_NAME = 'AITranslationCache';
  const IDB_VERSION = 1;
  const IDB_STORE = 'preprocessed';
  const IDB_MAX = 10;

  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getVideoKey(video) {
    var src = (video.currentSrc || video.src || '').replace(/\?.*$/, '').replace(/#.*$/, '');
    var hash = 0;
    for (var i = 0; i < src.length; i++) {
      hash = ((hash << 5) - hash) + src.charCodeAt(i);
      hash |= 0;
    }
    return 'vid_' + Math.abs(hash);
  }

  async function savePreprocessedToCache(video, items) {
    try {
      var db = await openIDB();
      var tx = db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      var key = getVideoKey(video);

      // LRU eviction: if at capacity, remove oldest
      var allReq = store.getAll();
      allReq.onsuccess = function () {
        var all = allReq.result;
        if (all.length >= IDB_MAX) {
          all.sort(function (a, b) { return (a.lastAccess || 0) - (b.lastAccess || 0); });
          var toDelete = all.length - IDB_MAX + 1;
          for (var d = 0; d < toDelete && d < all.length; d++) {
            store.delete(all[d].key);
          }
        }
      };

      var entry = {
        key: key,
        src: video.currentSrc || video.src,
        items: items.map(function (item) { return {
          original: item.original,
          translation: item.translation,
          audio: item.audio,
          start: item.start,
          end: item.end,
          durationMs: item.durationMs,
          words: item.words
        }; }),
        createdAt: Date.now(),
        lastAccess: Date.now()
      };
      store.put(entry);
      return new Promise(function (resolve) { tx.oncomplete = resolve; });
    } catch (e) {
      // Cache is optional — never fail the main flow
    }
  }

  async function loadPreprocessedFromCache(video) {
    try {
      var db = await openIDB();
      var entry = await new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var store = tx.objectStore(IDB_STORE);
        var req = store.get(getVideoKey(video));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      if (!entry) return null;
      // Update lastAccess (write-back, fire-and-forget)
      var writeTx = db.transaction(IDB_STORE, 'readwrite');
      var writeStore = writeTx.objectStore(IDB_STORE);
      entry.lastAccess = Date.now();
      writeStore.put(entry);
      return entry.items;
    } catch (e) {
      return null;
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

  // Auto-start disabled — user triggers manually via popup button

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
    if (ccKeyHandler) { document.removeEventListener('keydown', ccKeyHandler, true); ccKeyHandler = null; }
    lastDOMSubtitle = '';

    if (syncMode) {
      stopSyncPlayback();
    }

    if (!subtitleMode) return;

    // Watch body for the new player to appear, then restart observer
    var bodyWatcher = new MutationObserver(function (mutations) {
      var p = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
      if (p && p.querySelector('.ytp-subtitles-button')) {
        bodyWatcher.disconnect();
        startDOMSubtitleObserver();
      }
    });
    bodyWatcher.observe(document.body, { childList: true, subtree: true });
    // Safety cleanup after 30s
    setTimeout(function () { bodyWatcher.disconnect(); }, 30000);
  });

  // Notify that content script is ready
  chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});
})();
