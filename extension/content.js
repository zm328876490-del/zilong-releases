// content.js - Injected into every page
// Manages: subtitle overlay, audio capture via video.captureStream(),
// WebSocket connection to Go backend, TTS via speechSynthesis.

(function () {
  'use strict';

  // Prevent double injection
  if (window.__ai_translation_loaded__) return;
  window.__ai_translation_loaded__ = true;

  // ─── Shared state bridge for floating-window.js ────────────────────
  // floating-window.js accesses these via window.__ai__ to share the
  // content script's closure-scoped variables.
  window.__ai__ = {
    get ws() { return ws; },
    get settings() { return settings; },
    get isRunning() { return isRunning; },
    set isRunning(v) { isRunning = v; },
    get offlineVideo() { return offlineVideo; },
    set offlineVideo(v) { offlineVideo = v; },
    get offlineMode() { return offlineMode; },
    set offlineMode(v) { offlineMode = v; },
    get floatingMode() { return floatingMode; },
    set floatingMode(v) { floatingMode = v; },
    get floatingWindow() { return floatingWindow; },
    set floatingWindow(v) { floatingWindow = v; },
    get floatingVideo() { return floatingVideo; },
    set floatingVideo(v) { floatingVideo = v; },
    get floatingBufferFilled() { return floatingBufferFilled; },
    set floatingBufferFilled(v) { floatingBufferFilled = v; },
    get floatingLoaded() { return floatingLoaded; },
    set floatingLoaded(v) { floatingLoaded = v; },
    get floatingTtsQueue() { return floatingTtsQueue; },
    set floatingTtsQueue(v) { floatingTtsQueue = v; },
    get floatingTtsPlaying() { return floatingTtsPlaying; },
    set floatingTtsPlaying(v) { floatingTtsPlaying = v; },
    get floatingTtsFallbackChunks() { return floatingTtsFallbackChunks; },
    set floatingTtsFallbackChunks(v) { floatingTtsFallbackChunks = v; },
    get floatingFallback() { return floatingFallback; },
    set floatingFallback(v) { floatingFallback = v; },
    get floatingTimeline() { return floatingTimeline; },
    set floatingTimeline(v) { floatingTimeline = v; },
    get floatingTimelineCursor() { return floatingTimelineCursor; },
    set floatingTimelineCursor(v) { floatingTimelineCursor = v; },
    get syncMode() { return syncMode; },
    set syncMode(v) { syncMode = v; },
    get preprocessedItems() { return preprocessedItems; },
    set preprocessedItems(v) { preprocessedItems = v; },
    get currentSessionId() { return currentSessionId; },
    sendWS: sendWS,
    sendStatus: sendStatus,
    startASRMode: startASRMode,
    savePreprocessedToCache: savePreprocessedToCache,
    isLiveStream: isLiveStream,
    findVideoElement: findVideoElement,
    loadPreprocessedFromCache: loadPreprocessedFromCache,
    startVideoReplay: startVideoReplay,
    cleanupOffline: cleanupOffline,
    stopAudioCapture: stopAudioCapture,
    finishWarmup: finishWarmup,
    _captureVideo: null,
    // True once captureVideoAudio() has successfully connected the source
    // and PCM is actually flowing into the worklet. The floating window
    // uses this to defer its frame-buffering clock so that buffer t=0 ==
    // the moment ASR first sees audio. Without this, the ~1-2s startup
    // window (WS connect + worklet load) causes the opening words of the
    // video to be played in the floating window but never seen by ASR.
    asrCaptureReady: false,
    // When true, the worklet drops incoming PCM instead of forwarding to
    // backend. Used by floating-window to stop feeding ASR after the source
    // video reaches its first 'ended' — prevents TikTok auto-loop's 2nd
    // play from polluting the timeline with duplicate utterances.
    audioFrozen: false,
    _flushAudioWorklet: function () {
      if (processorNode) {
        try { processorNode.port.postMessage('flush'); } catch (_) {}
      }
    },
  };

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
  // Source video whose PCM is currently entering the worklet queue. This is
  // updated AFTER a flush+settle when switching sources, so PCM batches
  // still in the worklet queue continue to be timestamped against the OLD
  // video. Without this lock, batches from the old video would be stamped
  // with the new video's currentTime → all timestamps wrong → ASR segments
  // misaligned → subtitles/TTS don't match what's on screen.
  let currentPcmSrcVideo = null;
  // Worklet readiness promise — resolved when AudioWorkletNode is live.
  let workletReadyPromise = null;
  // Last sample-sequence we saw from the worklet; used to detect drops.
  let _lastSampleSeqEnd = 0;
  let _audioHoleCount = 0;
  // Audio-out debug stats (front-end side). Aggregated and printed once per second
  // so we can compare with the backend [audio-in] aggregate log to spot loss in flight.
  let _dbgSentChunks = 0;
  let _dbgSentBytes = 0;
  let _dbgSentPeakMax = 0;
  let _dbgFrozenDrops = 0;
  let _dbgWsBuffered = 0;
  let _dbgLastFlushMs = 0;
  let pcmBuffer = [];          // PCM chunks buffered during warmup before WS ready
  let videoWatcher = null;      // persistent MutationObserver for video elements
  let videoPollTimer = null;    // periodic check for video src changes / new videos
  let urlWatchTimer = null;     // periodic URL change detection (SPA navigation)
  let lastUrl = location.href;  // tracked for SPA navigation detection
  let urlWatcherBusy = false;  // prevent overlapping async auto-resume calls

  // Settings (updated via popup messages)
  let settings = {
    wsUrl: 'ws://localhost:29527/ws',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    apiKey: '',
    region: 'eastasia',
    engine: 'microsoft',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5:7b',
    ttsVoice: 'default',
    subtitleEnabled: true,
    subtitleSize: 50,
    originalVolume: 30,
    ttsVolume: 100,
  };

  // ─── Sync mode state (subtitle hijacking) ───────────────────────────
  let syncMode = false;           // true = subtitle sync mode, false = ASR mode
  let preprocessedItems = [];     // [{original, translation, audioB64, start, end, played, audioEl}]
  let currentSessionId = '';     // unique per video session, echoed by backend for validation
  let processGeneration = 0;     // incremented on cleanup, prevents stale preprocess results
  let activeProcessGeneration = 0; // generation when current preprocess was sent
  let waitingPreprocess = false;  // true between sending preprocess and receiving preprocess_complete/error

  let floatingMode = false; let floatingWindow = null; let floatingLoaded = false; let floatingVideo = null; let floatingBufferFilled = false; let floatingTtsQueue = []; let floatingTtsPlaying = false; let floatingTtsFallbackChunks = []; let floatingFallback = false; let offscreenPending = false; let floatingTimeline = []; let floatingTimelineCursor = 0;

function generateSessionId() {
    return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function sendWS(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    msg.sessionId = currentSessionId;
    ws.send(JSON.stringify(msg));
  }

  function syncSessionToBackend() {
    // Update backend's sessionId so streaming ASR results match currentSessionId
    sendWS({
      type: 'config',
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      apiKey: settings.apiKey,
      region: settings.region,
      engine: settings.engine,
      ttsVoice: settings.ttsVoice,
      ollamaUrl: settings.ollamaUrl,
      ollamaModel: settings.ollamaModel,
    });
  }
  let syncRafId = null;           // requestAnimationFrame ID
  let lastSyncTime = 0;           // last video.currentTime
  let syncVideo = null;           // the video element being synced to
  let wasPaused = false;          // track pause→play transitions
  let syncLastCleanup = 0;        // last time sliding window cleanup ran
  let syncPrevActiveItem = null;  // detect activeItem transitions for word highlight reset
  let currentSyncAudio = null;    // (managed by queue, kept for backward compat)

  // Offline ASR state
  let offlineMode = false;        // true = offline full-audio ASR mode
  let offlineRecording = false;   // true = currently recording (Phase 1)
  let offlineVideo = null;        // the video being recorded/replayed
  let offlineAudioCtx = null;     // AudioContext for capture (shared with real-time ASR)
  let offlineStream = null;       // MediaStream from captureStream
  let workletReady = false;        // AudioWorklet module loaded and node created
  let pendingStream = null;      // MediaStream waiting for worklet to be ready
  let pendingMediaElement = null; // HTMLMediaElement waiting for worklet to be ready
  let pendingSrcVideoForStream = null; // video to lock as currentPcmSrcVideo when pendingStream attaches
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
    <span class="fab-label">视频</span>
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

  // ─── Toast notification ─────────────────────────────────────────────
  function showFabToast(msg) {
    var toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = 'position:fixed;right:62px;top:50%;transform:translateY(-50%);background:rgba(30,27,46,0.95);color:#d1d5db;font-size:12px;font-family:-apple-system,"Microsoft YaHei","PingFang SC",sans-serif;white-space:nowrap;padding:8px 14px;border-radius:8px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;opacity:0;transition:opacity 0.3s;';
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.style.opacity = '1'; });
    setTimeout(function () {
      toast.style.opacity = '0';
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 2000);
  }

  // FAB click handler
  fab.addEventListener('click', function () {
    if (fab.classList.contains('loading')) return;
    var video = findVideoElement();
    if (!video) {
      showFabToast('当前页面未检测到视频');
      return;
    }
    if (isRunning) {
      stop();
    } else {
      // Pre-open floating window while user gesture is active.
      // window.open() called deep in an async call chain loses the
      // user gesture and gets blocked by Chrome's popup blocker.
      if (window.startFloatingWindowMode && !isLiveStream(video)) {
        var w = Math.round((video.videoWidth || 640) * 0.7) || 480;
        var h = Math.round((video.videoHeight || 360) * 0.7) + 100 || 400;
        var left = Math.max(0, screen.width - w - 40);
        var top = Math.max(0, (screen.height - h) / 2);
        var pw = window.open('about:blank', 'ai_translation_overlay',
          'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
          ',resizable=1,scrollbars=0,status=0,toolbar=0,menubar=0,location=0');
        if (pw) window.__ai_preopened_window__ = pw;
      }
      start();
    }
  });

  // Floating popup close → sync FAB + isRunning. Without this hook,
  // a user closing the popup leaves isRunning=true and FAB in "running"
  // state, so the next click is routed to stop() (no-op) instead of
  // start(). User then has to click twice to restart translation.
  window.__ai_onFloatingClosed__ = function () {
    if (!isRunning) return;
    // Full teardown matches the stop() codepath so audio/WS/pipeline are
    // clean for the next start(). Avoids relying on partial cleanup.
    try { stop(); } catch (e) {
      // Defensive: at minimum sync the flags so FAB shows the right state.
      isRunning = false;
      fab.classList.remove('running');
    }
  };

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

// ─── TTS (queue-based playback, no cutting) ──────────────────────
  let lastSpokenText = '';
  const SHORT_VIDEO_DURATION = 60; // videos under 60s skip TTS dedup

  // E6 字幕模式：被切断时不要硬 pause，而是 80ms 内音量渐变到 0 再 pause。
  // 配合下一句立刻开播 → 形成 ~80ms 交叉淡化，消除"咔嗒"硬切感。
  // 字幕模式没有 ASR 时间窗信息，无法预测，只能在切断瞬间做。
  const TTS_FADE_MS = 80;
  function softStopTtsAudio(audio, fadeMs) {
    if (!audio) return;
    try {
      if (audio.paused || audio.ended) {
        try { audio.pause(); } catch (_) {}
        return;
      }
      var startVol = audio.volume || 0;
      if (startVol <= 0.01) { try { audio.pause(); } catch (_) {} return; }
      var startT = performance.now();
      var ms = fadeMs || TTS_FADE_MS;
      // 标记，避免对同一 audio 同时跑多个 fade
      if (audio._fadingOut) return;
      audio._fadingOut = true;
      var step = function () {
        var elapsed = performance.now() - startT;
        var k = Math.min(1, elapsed / ms);
        try {
          audio.volume = Math.max(0, startVol * (1 - k));
        } catch (_) {}
        if (k < 1 && !audio.paused && !audio.ended) {
          requestAnimationFrame(step);
        } else {
          try { audio.pause(); } catch (_) {}
          try { audio.volume = startVol; } catch (_) {} // 恢复，防止 audio 被复用
          audio._fadingOut = false;
        }
      };
      requestAnimationFrame(step);
    } catch (_) {
      try { audio.pause(); } catch (_) {}
    }
  }


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
    // E6: 当前正在播的句子做 80ms 平滑淡出，不硬切
    if (ttsAudio) {
      softStopTtsAudio(ttsAudio, TTS_FADE_MS);
      // 立刻让出引用 — 下一句 enqueue 能马上接力 (形成交叉淡化效果)
      ttsAudio = null;
      ttsAudioUrl = null;
    }
    // 队列里还没开播的直接清掉 (硬 pause 无所谓，本来就没出声)
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
        sendWS({
          type: 'translate_response',
          id: msg.id,
          translation: translation,
        });
      } else {
        sendWS({
          type: 'translate_response',
          id: msg.id,
          error: 'HTTP ' + resp.status,
        });
      }
    } catch (e) {
      sendWS({
        type: 'translate_response',
        id: msg.id,
        error: e.message,
      });
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
    // YouTube/Bilibili live streams have infinite duration
    if (!isFinite(video.duration)) return true;
    // Bilibili: some live streams report finite duration, check player wrapper
    if (location.hostname.includes('bilibili') && document.querySelector('.bilibili-live-player')) return true;
    return false;
  }




  // ─── Persistent Audio Pipeline ─────────────────────────────────────
  // AudioContext + processorNode are created ONCE and survive video swaps.
  // Only the source node (MediaStreamSource) is swapped when video changes.

  // Returns a Promise<boolean> that resolves true ONLY when AudioContext +
  // AudioWorkletNode are both ready. Synchronous callers that only need
  // AudioContext (not worklet) can still treat truthy resolve as success.
  // Multiple concurrent callers share the same in-flight promise.
  function ensureAudioContext() {
    if (workletReadyPromise) return workletReadyPromise;

    workletReadyPromise = new Promise(function (resolve) {
      try {
        if (!audioContext) {
          audioContext = new AudioContext({ sampleRate: 16000 });
        }
        if (audioContext.state === 'suspended') {
          audioContext.resume().catch(function () {});
        }

        if (processorNode) {
          pipelineActive = true;
          workletReady = true;
          resolve(true);
          return;
        }

        audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'))
          .then(function () {
            processorNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');

            processorNode.port.onmessage = function (event) {
              if (!pipelineActive) return;
              var data = event.data;
              // Frozen mode: source video ended (TikTok auto-loop or
              // end-of-content). Drop PCM to prevent the 2nd/3rd loop's
              // audio from getting fed to ASR as "new content" — that
              // pollutes the timeline and causes duplicate subtitles +
              // out-of-order TTS the user reported.
              // EXCEPTION: a 'flush' batch (worklet draining its tail in
              // response to the end-of-video flush request) is always
              // allowed through, even after audioFrozen is set — that's
              // the legitimate final ~256ms of the original video.
              if (window.__ai__.audioFrozen && !data.flush) {
                _dbgFrozenDrops++;
                return;
              }

              // Overflow notice from worklet — main thread was stalled, we
              // dropped oldest samples. Log it so we can see if this is the
              // cause of any alignment drift.
              if (data.overflow) {
                _audioHoleCount++;
                return;
              }

              var pcm = new Int16Array(data.pcm);

              // Sequence continuity check — if there's a gap between the
              // end of the last batch and the start of this one, the
              // worklet skipped samples and we MUST inject a marker so the
              // backend doesn't misalign timestamps.
              if (typeof data.sampleStartSeq === 'number') {
                if (_lastSampleSeqEnd !== 0 &&
                    data.sampleStartSeq !== _lastSampleSeqEnd) {
                  var gap = data.sampleStartSeq - _lastSampleSeqEnd;
                }
                _lastSampleSeqEnd = data.sampleStartSeq + (data.sampleCount || pcm.length);
              }

              // Anchor PCM batch to EXACT video time of its FIRST sample.
              // CRITICAL: use currentPcmSrcVideo (locked to the source the
              // batch CAME FROM), not activeVideo (which may have already
              // been swapped to a new source while this batch sat in the
              // worklet queue). Mis-locking causes systematic timestamp
              // offset and subtitle/TTS desync.
              var srcVideo = currentPcmSrcVideo || activeVideo || offlineVideo;
              var startCtx = data.startCtxTime;
              var vt = 0;
              if (typeof startCtx === 'number' && startCtx >= 0 && audioContext) {
                var ctxNow = audioContext.currentTime;
                var vtNow = srcVideo ? srcVideo.currentTime : 0;
                vt = vtNow - (ctxNow - startCtx);
              } else {
                var rawVt = srcVideo ? srcVideo.currentTime : 0;
                var chunkDur = pcm.length / audioContext.sampleRate;
                vt = rawVt - chunkDur - 0.1;
              }
              if (vt < 0) vt = 0;

              var isFlush = !!data.flush;

              var head = new Uint8Array(8);
              new DataView(head.buffer).setFloat64(0, vt, true);
              var combined = new Uint8Array(8 + pcm.byteLength);
              combined.set(head, 0);
              combined.set(new Uint8Array(pcm.buffer), 8);

              if (!ws || ws.readyState !== WebSocket.OPEN) {
                pcmBuffer.push(combined);
                return;
              }
              ws.send(combined.buffer);

              // ── DEBUG: aggregate stats for outgoing PCM (1Hz flush) ──
              _dbgSentChunks++;
              _dbgSentBytes += combined.byteLength;
              // Peak abs amplitude across this chunk — quick sanity for "is it silence?"
              var _pk = 0;
              for (var _pi = 0; _pi < pcm.length; _pi++) {
                var _v = pcm[_pi]; if (_v < 0) _v = -_v;
                if (_v > _pk) _pk = _v;
              }
              if (_pk > _dbgSentPeakMax) _dbgSentPeakMax = _pk;
              _dbgWsBuffered = ws.bufferedAmount;
              var _now = Date.now();
              if (_dbgLastFlushMs === 0) _dbgLastFlushMs = _now;
              if (_now - _dbgLastFlushMs >= 1000) {
                _dbgSentChunks = 0;
                _dbgSentBytes = 0;
                _dbgSentPeakMax = 0;
                _dbgFrozenDrops = 0;
                _dbgLastFlushMs = _now;
              }

              if (isFlush) {
                try { sendWS({ type: 'flush_tail' }); } catch (_) {}
              }
            };

            // Connect any source that was waiting for the worklet to load.
            // Lock currentPcmSrcVideo to the source we're connecting.
            if (pendingStream) {
              sourceNode = audioContext.createMediaStreamSource(pendingStream);
              sourceNode.connect(processorNode);
              activeStream = pendingStream;
              if (pendingSrcVideoForStream) {
                currentPcmSrcVideo = pendingSrcVideoForStream;
                pendingSrcVideoForStream = null;
              }
              pendingStream = null;
            } else if (pendingMediaElement) {
              sourceNode = audioContext.createMediaElementSource(pendingMediaElement);
              sourceNode.connect(processorNode);
              activeVideo = pendingMediaElement;
              currentPcmSrcVideo = pendingMediaElement;
              pendingMediaElement = null;
            }

            pipelineActive = true;
            workletReady = true;
            resolve(true);
          })
          .catch(function (err) {
            sendStatus('error', 'AudioWorklet 加载失败: ' + err.message);
            workletReadyPromise = null; // allow retry
            resolve(false);
          });
      } catch (err) {
        sendStatus('error', 'AudioContext 创建失败: ' + err.message);
        workletReadyPromise = null;
        resolve(false);
      }
    });

    return workletReadyPromise;
  }

  // Connect a new audio MediaStream to the worklet. `srcVideo` is the
  // <video> element whose currentTime should be used to timestamp PCM
  // batches arriving from this stream. We update currentPcmSrcVideo only
  // AFTER flushing the worklet, so any in-queue PCM from the previous
  // source is timestamped against its own video, not the new one.
  function connectVideoStream(stream, srcVideo) {
    if (!audioContext) return false;

    var sameVideo = (srcVideo && srcVideo === currentPcmSrcVideo);

    // Step 1: flush worklet so any partial batch from the OLD source is
    // emitted before we change anything else.
    if (processorNode) {
      try { processorNode.port.postMessage('flush'); } catch (_) {}
    }

    // Step 2: disconnect old source. We do NOT stop the old MediaStream
    // tracks here — defer that by 250ms so the worklet has time to drain
    // its render-quantum pipeline (a stopped track immediately silences
    // the AudioContext input). 250ms > 1 quantum + flush emission.
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) {}
      sourceNode = null;
    }
    if (activeStream && activeStream !== stream) {
      var oldStream = activeStream;
      setTimeout(function () {
        try { oldStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
      }, 250);
    }
    activeStream = stream;

    // Step 3: if worklet not yet loaded, stash and let the loader connect.
    if (!processorNode) {
      pendingStream = stream;
      pendingSrcVideoForStream = srcVideo || null;
      return true;
    }

    // Step 4: connect new source. Give the worklet ~50ms to drain the
    // flush before we re-arm currentPcmSrcVideo — the in-flight flush
    // message is delivered cross-thread and we don't want the next batch
    // (from the new source) to inherit the old video's timestamp lock.
    sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(processorNode);

    if (!sameVideo) {
      // Defer the source-video lock change so the old-source batch (just
      // flushed) is timestamped against the old video.
      setTimeout(function () {
        currentPcmSrcVideo = srcVideo || null;
        // Reset hole-detection counter — a real swap is not a "hole".
        _lastSampleSeqEnd = 0;
      }, 60);
    } else {
      currentPcmSrcVideo = srcVideo;
    }
    return true;
  }

  function disconnectVideoSource() {
    pcmBuffer = [];
    pendingStream = null;
    pendingMediaElement = null;
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

  async function captureVideoAudio(video) {
    if (!video) return false;

    // If we're swapping AWAY from a previous active video, flush its
    // worklet tail FIRST so the last < 256ms of that video survives,
    // then tell the backend to start a fresh ASR session — otherwise
    // the new video's audio gets appended to the old buffer and whisper
    // merges them into a single (wrong) mega-segment.
    if (activeVideo && activeVideo !== video) {
      if (processorNode) {
        try { processorNode.port.postMessage('flush'); } catch (_) {}
      }
      try { sendWS({ type: 'session_split' }); } catch (_) {}
    }

    // Already capturing this video with a healthy stream — skip re-capture
    if (activeVideo === video && sourceNode && activeStream) {
      var tracks = activeStream.getAudioTracks();
      if (tracks.length > 0 && tracks[0].readyState !== 'ended') {
        return true;
      }
    }

    try {
      video.muted = false;

      // CRITICAL: ensure AudioWorklet is fully loaded BEFORE we call
      // video.captureStream(). Otherwise the 100-500ms worklet load
      // window silently drops any audio data the stream produces.
      var workletOk = await ensureAudioContext();
      if (!workletOk) return false;

      // Try captureStream() first
      var stream = null;
      var crossOriginError = false;
      try {
        stream = video.captureStream();
      } catch (e) {
        try { stream = video.captureStream(0); } catch (e2) {
          crossOriginError = true;
        }
      }

      if (crossOriginError || (stream && stream.getAudioTracks().length === 0)) {
        // Cross-origin video: fallback to createMediaElementSource
        try {
          if (sourceNode) { try { sourceNode.disconnect(); } catch (_) {} sourceNode = null; }
          if (activeStream) {
            try { activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
            activeStream = null;
          }
          sourceNode = audioContext.createMediaElementSource(video);
          sourceNode.connect(processorNode);
          if (!pipelineActive) {
            processorNode.connect(audioContext.destination);
          }
          activeVideo = video;
          currentPcmSrcVideo = video;
          activeVideo._lastSrc = video.src;
          pipelineActive = true;
          window.__ai__.asrCaptureReady = true;
          sendStatus('listening', '跨域音频捕获成功 (MediaElementSource)');
          return true;
        } catch (e3) {
          sendStatus('error', '音频捕获失败 (跨域): ' + e3.message);
          return false;
        }
      }

      var audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        sendStatus('error', '此页面无法直接捕获视频音频，需 tabCapture 权限');
        return false;
      }

      var audioStream = new MediaStream(audioTracks);

      // Pass video so connectVideoStream can lock currentPcmSrcVideo
      // correctly (after flushing the old tail).
      connectVideoStream(audioStream, video);
      activeVideo = video;
      activeVideo._lastSrc = video.src;
      // Signal to the floating window that audio is now flowing — it can
      // safely start its delay-buffer clock from this point.
      window.__ai__.asrCaptureReady = true;

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
      processorNode.port.onmessage = null;
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
    pendingStream = null;
    pendingMediaElement = null;
    pendingSrcVideoForStream = null;
    workletReady = false;
    // CRITICAL: clear the worklet-ready promise. ensureAudioContext() caches
    // this promise to dedupe concurrent callers; if we leave it set after
    // destroying the AudioContext, the next start() will see a resolved
    // promise but a null processorNode/audioContext, and no PCM will ever
    // flow → "stop then start" produces a dead pipeline with no subtitles.
    workletReadyPromise = null;
    currentPcmSrcVideo = null;
    pcmBuffer = [];
    _lastSampleSeqEnd = 0;
    _audioHoleCount = 0;
    window.__ai__.asrCaptureReady = false;
    window.__ai__.audioFrozen = false;
    window.__ai__._droppedUids = {};
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

  // stopAudioCapture stops the backend pipeline and disconnects the audio
  // source without tearing down the full AudioContext. Used by floating
  // window close to prevent orphaned capture/processing after window is gone.
  function stopAudioCapture() {
    pcmBuffer = [];
    window.__ai__.asrCaptureReady = false;
    // Reset frozen flag here too. closeFloatingWindow clears its own
    // state, but if stopAudioCapture is reached via any other path the
    // next capture session must not inherit a stuck audioFrozen=true.
    window.__ai__.audioFrozen = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWS({ type: 'stop' });
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach(function (t) { t.stop(); });
      activeStream = null;
    }
  }

  // ─── Persistent Video Watcher ──────────────────────────────────────
  // Watches for video elements added/removed and swaps capture source
  // automatically so the pipeline stays live across video changes.

  function startVideoWatcher() {
    if (videoWatcher) return;

    videoWatcher = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var didCleanup = false;

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
            if (v !== activeVideo && isRunning && !waitingPreprocess) {
              if (!didCleanup) { cleanupDisplayState(); didCleanup = true; }
              tryResumeOrCapture(v);
            }
          }
        }

        // Detect removed video elements — soft cleanup on swipe/scroll (keep running)
        for (var r = 0; r < m.removedNodes.length; r++) {
          var removed = m.removedNodes[r];
          if (removed.nodeType !== 1) continue;
          if (removed === activeVideo || (removed.contains && removed.contains(activeVideo)) ||
              removed === syncVideo || (removed.contains && removed.contains(syncVideo)) ||
              removed === offlineVideo || (removed.contains && removed.contains(offlineVideo))) {
            if (!didCleanup && !waitingPreprocess) {
              cleanupDisplayState();
              didCleanup = true;
            }
            if (removed === activeVideo || (removed.contains && removed.contains(activeVideo))) {
              activeVideo = null;
            }
            if ((removed === offlineVideo || (removed.contains && removed.contains(offlineVideo))) && !waitingPreprocess) {
              cleanupOffline();
            }
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
        if (!waitingPreprocess) tryResumeOrCapture(video);
      } else if (activeVideo !== video) {
        // Different video element — destroy old display state before switching
        if (!waitingPreprocess) { cleanupDisplayState(); tryResumeOrCapture(video); }
      } else if (activeVideo.src !== activeVideo._lastSrc) {
        // Same element, different source — new video content, destroy old state
        if (!waitingPreprocess) { cleanupDisplayState(); tryResumeOrCapture(video); }
      } else if (activeStream) {
        // Detect ended tracks (video finished/looped) — re-capture to revive.
        // Flush worklet FIRST so the final < 256ms of the previous play is
        // emitted before the recapture process disconnects the source.
        var tracks = activeStream.getAudioTracks();
        if (tracks.length === 0 || tracks[0].readyState === 'ended') {
          if (processorNode) {
            try { processorNode.port.postMessage('flush'); } catch (_) {}
          }
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

  function startUrlWatcher() {
    if (urlWatchTimer) return;
    lastUrl = location.href;
    urlWatchTimer = setInterval(function () {
      if (location.href === lastUrl || urlWatcherBusy) return;

      var prevUrl = lastUrl;
      lastUrl = location.href;

      urlWatcherBusy = true;

      if (isRunning) {
        // Save current state before navigating away
        if (preprocessedItems.length > 0) {
          var saveVideo = offlineVideo || syncVideo || findVideoElement();
          if (saveVideo) {
            savePreprocessedToCache(saveVideo, preprocessedItems, prevUrl);
          }
        }

        // Fully clean up current session
        cleanupOffline();
        cleanupDisplayState();
        disconnectWebSocket();
        destroyPipeline();
        finishWarmup();
        isRunning = false;
        fab.classList.remove('running');
      }

      // Always try auto-resume — user may have navigated back to a cached video
      tryAutoResume().catch(function () {}).finally(function () {
        urlWatcherBusy = false;
      });
    }, 1000);
  }

  function stopUrlWatcher() {
    clearInterval(urlWatchTimer);
    urlWatchTimer = null;
  }

  async function tryAutoResume() {
    var video = findVideoElement();
    if (!video) {
      isRunning = false;
      fab.classList.remove('running');
      chrome.runtime.sendMessage({ type: 'stopped' }).catch(function () {});
      return;
    }

    // Wait for metadata if not loaded yet (same reason as tryResumeOrCapture)
    if (video.readyState === 0) {
      var _tripped = false;
      video.addEventListener('loadedmetadata', function () {
        if (_tripped) return; _tripped = true;
        tryAutoResume();
      }, { once: true });
      setTimeout(function () {
        if (!_tripped) { _tripped = true; isRunning = false; fab.classList.remove('running'); }
      }, 5000);
      return;
    }

    if (isLiveStream(video) || video.duration <= 0) {
      isRunning = false;
      fab.classList.remove('running');
      chrome.runtime.sendMessage({ type: 'stopped' }).catch(function () {});
      return;
    }

    var cached = await loadPreprocessedFromCache(video);
    if (!cached || cached.length === 0) {
      isRunning = false;
      fab.classList.remove('running');
      chrome.runtime.sendMessage({ type: 'stopped' }).catch(function () {});
      return;
    }

    // Cache hit — auto-resume playback
    preprocessedItems = cached;
    offlineMode = true;
    offlineVideo = video;
    syncMode = true;
    isRunning = true;
    fab.classList.add('running');
    updateLoadingText('本地缓存匹配', '即时加载');
    sendStatus('playing');
    startVideoReplay(video);
    syncSessionToBackend();
    startVideoWatcher();
    startUrlWatcher();
  }

  // tryResumeOrCapture checks IndexedDB cache for a newly-detected video.
  // Cache hit → resume playback. Cache miss → capture ASR audio.
  async function tryResumeOrCapture(video) {
    if (!video) {
      captureVideoAudio(video);
      syncSessionToBackend();
      return;
    }

    // Guard against concurrent calls (poll timer + mutation observer race)
    if (video._resumeCaptureBusy) return;
    video._resumeCaptureBusy = true;

    try {
      // If metadata hasn't loaded yet, wait for it before deciding live vs VOD.
      // Otherwise isLiveStream() returns true for NaN duration (not loaded = infinite).
      if (video.readyState === 0) {
        video._resumeCaptureBusy = false; // clear so loadedmetadata callback can re-enter
        var _tripped = false;
        video.addEventListener('loadedmetadata', function () {
          if (_tripped) return; _tripped = true;
          tryResumeOrCapture(video);
        }, { once: true });
        // Safety timeout: if metadata never loads, fall back to ASR after 5s
        setTimeout(function () {
          if (!_tripped) { _tripped = true; captureVideoAudio(video); syncSessionToBackend(); }
        }, 5000);
        return;
      }

      if (isLiveStream(video) || video.duration <= 0) {
        captureVideoAudio(video);
        syncSessionToBackend();
        return;
      }

      var cached = await loadPreprocessedFromCache(video);
      if (cached && cached.length > 0) {
        // Cache hit — switch to offline playback mode
        preprocessedItems = cached;
        offlineMode = true;
        offlineVideo = video;
        syncMode = true;
        updateLoadingText('本地缓存匹配', '即时加载');
        sendStatus('playing');
        startVideoReplay(video);
        syncSessionToBackend();
        startVideoWatcher();
      } else {
        // Cache miss — start real-time ASR capture
        captureVideoAudio(video);
        syncSessionToBackend();
      }
    } finally {
      video._resumeCaptureBusy = false;
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

      sendWS({
        type: 'config',
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        apiKey: settings.apiKey,
        region: settings.region,
        engine: settings.engine,
        ttsVoice: settings.ttsVoice,
        rolling: floatingFallback,
        ollamaUrl: settings.ollamaUrl,
        ollamaModel: settings.ollamaModel,
      });

      // Offline ASR: signal start of audio streaming
      if (offlineMode && offlineRecording) {
        var actualRate = (offlineAudioCtx && offlineAudioCtx.sampleRate) ? offlineAudioCtx.sampleRate : 48000;
        sendWS({ type: 'offline_asr_start', sampleRate: actualRate, speed: OFFLINE_SPEED });
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
    // Drop messages from previous sessions (stale video responses)
    if (msg.sessionId && msg.sessionId !== currentSessionId) return;

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
        if (floatingFallback) {
          // Don't show immediately — the timeline loop handles all display.
          // But we need to handle partial ASR text. For now, skip in floating mode
          // since the timeline's 'result' entry has the final original+translation.
        } else {
          showSubtitle(msg.text, null, msg.speaker);
        }
        break;

      case 'result':
        if (floatingFallback) {
          // Check if backend sent timestamps (new backend) or not (old backend)
          var hasTimestamps = (msg.startTime !== undefined && msg.endTime !== undefined && (msg.startTime > 0 || msg.endTime > 0));
          if (hasTimestamps) {
            // Buffer with timestamps for time-aligned playback in floating window
            var entry = {
              utteranceId: msg.utteranceId || '',
              start: msg.startTime || 0,
              end: msg.endTime || 0,
              original: msg.original || '',
              translation: msg.translation || '',
              words: msg.words || [],
              audioChunks: [],
              audioMime: 'audio/mpeg',
              displayed: false,
              played: false,
            };
            // Insert into timeline keyed by start time. Whisper batches
            // and translate-API latency can deliver out of order; if we
            // append blindly, the timeline-loop's cursor logic produces
            // wrong-order subtitles ("顺序混乱"). Binary insert keeps
            // floatingTimeline always sorted by .start.
            var lo = 0, hi = floatingTimeline.length;
            while (lo < hi) {
              var mid = (lo + hi) >>> 1;
              if (floatingTimeline[mid].start < entry.start) lo = mid + 1;
              else hi = mid;
            }
            // Drop near-duplicate (overlapping start within 0.3s AND
            // same original text) to defend against whisper overlap
            // re-emitting the same segment twice. This is the main
            // cause of "first TTS plays twice".
            var dup = false;
            for (var d = Math.max(0, lo - 2); d < Math.min(floatingTimeline.length, lo + 2); d++) {
              var ex = floatingTimeline[d];
              if (Math.abs(ex.start - entry.start) < 0.3 && ex.original === entry.original) {
                dup = true; break;
              }
            }
            if (!dup) {
              floatingTimeline.splice(lo, 0, entry);
              // If we inserted BEFORE the current cursor, shift cursor.
              if (lo < ai.floatingTimelineCursor) ai.floatingTimelineCursor++;
            } else {
              // Remember dropped utteranceId so its incoming audio_start/
              // chunk/end can be ignored instead of falling through to the
              // legacy "play immediately" path (which would cause the
              // duplicate TTS the user reported).
              if (!window.__ai__._droppedUids) window.__ai__._droppedUids = {};
              if (entry.utteranceId) window.__ai__._droppedUids[entry.utteranceId] = Date.now();
            }
            // Subtitle and TTS are handled by the floating window timeline loop,
            // which uses refTime = displayedFrameVideoTime to align with the
            // delayed video. Don't show/play here.
          } else {
            // Old backend without timestamps — fallback to immediate display
            if (window.__ai_showFloatingSubtitle__) {
              window.__ai_showFloatingSubtitle__(msg.original, msg.translation);
            }
          }
        } else {
          showSubtitle(msg.original, msg.translation, msg.speaker);
        }
        break;

      case 'audio_start':
        if (floatingFallback) {
          // Check if there's a matching timeline entry (new backend with timestamps)
          var uid = msg.utteranceId || '';
          // Ignore audio for utterances we dropped as duplicates
          if (window.__ai__._droppedUids && window.__ai__._droppedUids[uid]) break;
          var found = false;
          for (var i = floatingTimeline.length - 1; i >= 0; i--) {
            if (floatingTimeline[i].utteranceId === uid) {
              floatingTimeline[i].audioChunks = [];
              found = true;
              break;
            }
          }
          if (!found && window.__ai_handleFloatingAudioStart__) {
            // Old backend fallback: no timeline entry, play immediately
            window.__ai_handleFloatingAudioStart__(msg);
          }
        } else {
          handleAudioStart(msg);
        }
        break;

      case 'audio_chunk':
        if (floatingFallback) {
          var uid = msg.utteranceId || '';
          if (window.__ai__._droppedUids && window.__ai__._droppedUids[uid]) break;
          var found = false;
          for (var i = floatingTimeline.length - 1; i >= 0; i--) {
            if (floatingTimeline[i].utteranceId === uid && msg.audio) {
              var binary = atob(msg.audio);
              var bytes = new Uint8Array(binary.length);
              for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
              floatingTimeline[i].audioChunks.push(bytes);
              found = true;
              break;
            }
          }
          if (!found && window.__ai_handleFloatingAudioChunk__) {
            window.__ai_handleFloatingAudioChunk__(msg);
          }
        } else {
          handleAudioChunk(msg);
        }
        break;

      case 'audio_end':
        if (floatingFallback) {
          var uid2 = msg.utteranceId || '';
          if (window.__ai__._droppedUids && window.__ai__._droppedUids[uid2]) {
            // Cleanup old dropped uids (keep map small)
            var nowTs = Date.now();
            for (var dk in window.__ai__._droppedUids) {
              if (nowTs - window.__ai__._droppedUids[dk] > 60000) {
                delete window.__ai__._droppedUids[dk];
              }
            }
            break;
          }
          var found = false;
          for (var k = floatingTimeline.length - 1; k >= 0; k--) {
            if (floatingTimeline[k].utteranceId === uid2) {
              var chunks2 = floatingTimeline[k].audioChunks;
              var entryRef = floatingTimeline[k];
              if (chunks2.length > 0) {
                var blob2 = new Blob(chunks2, { type: 'audio/mpeg' });
                var reader2 = new FileReader();
                reader2.onload = function () {
                  entryRef.audioBase64 = reader2.result.split(',')[1];
                  // If this entry is what the user is CURRENTLY seeing
                  // on the subtitle, play its audio immediately — the
                  // subtitle has been waiting for it. If a different
                  // line is now showing, do NOT play — that would be
                  // the "TTS reads something different from subtitle"
                  // bug the user reported.
                  try {
                    var ai = window.__ai__;
                    // Late-arriving TTS audio. Rules:
                    //   1. This entry must still be the currently-visible line.
                    //   2. _vt must not have crossed entry.end yet (don't
                    //      backfill audio for a subtitle that's already gone).
                    //   3. There must not be another TTS playing right now
                    //      (no conflict). _currentTtsEntry===null means free.
                    var vt = ai && ai.getFloatingVt ? ai.getFloatingVt() : null;
                    var stillVisible = ai && ai._visibleLine === entryRef;
                    var inWindow = vt === null || vt < entryRef.end;
                    var noConflict = !ai || !ai._currentTtsEntry;
                    if (stillVisible && inWindow && noConflict && !entryRef.played) {
                      entryRef.played = true;
                      if (ai.playFloatingTTSDirect) {
                        ai.playFloatingTTSDirect(entryRef.audioBase64, entryRef.audioMime || 'audio/mpeg', entryRef);
                      }
                    }
                  } catch (_) {}
                };
                reader2.readAsDataURL(blob2);
              }
              entryRef.audioChunks = [];
              found = true;
              break;
            }
          }
          if (!found && window.__ai_handleFloatingAudioEnd__) {
            window.__ai_handleFloatingAudioEnd__(msg);
          }
        } else {
          handleAudioEnd(msg);
        }
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
        if (activeProcessGeneration !== processGeneration) break; // stale results from previous video
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
        if (activeProcessGeneration !== processGeneration) break;
        waitingPreprocess = false;
        if (offlineVideo) {
          savePreprocessedToCache(offlineVideo, preprocessedItems);
        }
        if (!syncRafId && !floatingFallback) {
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
          // Only clean up recording-specific state (skip if floating mode — pipeline still active)
          if (offlineRecording) {
            offlineRecording = false;
            // processorNode is shared; don't disconnect it here
            offlineAudioCtx = null;
            if (offlineStream) { offlineStream.getTracks().forEach(function(t) { t.stop(); }); offlineStream = null; }
            if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
          }
          updateLoadingText('模型推理中...', '已处理 ' + msg.subs.length + ' 个片段');
          sendStatus('preprocessing', '模型推理中...');
          activeProcessGeneration = processGeneration;
          waitingPreprocess = true;
          sendWS({ type: 'preprocess', subs: msg.subs });
        } else {
          sendStatus('error', '离线 ASR 未识别到字幕');
          cleanupOffline();
        }
        break;

      case 'preprocess_error':
        waitingPreprocess = false;
        sendStatus('error', msg.message);
        cleanupOffline();
        break;

      // ─── Status ────────────────────────────────────────────────────
      case 'status':
        if (msg.status === 'configured') {
          if (!syncMode && !offlineRecording) {
            // In ASR mode: send warmup. In sync/offline-recording mode: skip.
            sendWS({ type: 'warmup' });
          }
        } else if (msg.status === 'ready') {
          if (preheatActive) {
            preheatPhase2();
          } else if (!startSent && !syncMode && !offlineRecording) {
            var video = window.__ai__._captureVideo || findVideoElement();
            if (video) {
              captureVideoAudio(video).then(function (ok) {
                if (ok) {
                  activatePipeline();
                } else {
                  isRunning = false;
                  finishWarmup();
                }
              });
            } else {
              isRunning = false;
              finishWarmup();
            }
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
    if (!video) {
      preheatActive = false;
      return;
    }
    captureVideoAudio(video).then(function (ok) {
      preheatActive = false;
      if (ok) preheatReady = true;
    });
  }

  function activatePipeline() {
    // In floating mode, skip the page video watcher — we capture from
    // a specific hidden video element, not from arbitrary page videos.
    if (!floatingFallback) {
      startVideoWatcher();
    }
    if (processorNode) {
      processorNode.connect(audioContext.destination);
    }

    // Send 'start' BEFORE flushing buffered PCM. The backend Start() clears
    // the rolling buffer, so we must start first (on an empty buffer), then
    // flush so the backend appends the buffered audio to a fresh buffer.
    startSent = true;
    sendWS({ type: 'start', rolling: floatingFallback });

    if (pcmBuffer.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      for (var i = 0; i < pcmBuffer.length; i++) {
        ws.send(pcmBuffer[i].buffer);
      }
      pcmBuffer = [];
    }
    chrome.runtime.sendMessage({ type: 'started' }).catch(function () {});
    if (window.__ai_onPipelineStarted__) {
      window.__ai_onPipelineStarted__();
    }
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
    activeVideo = video;
    if (activeVideo) activeVideo._lastSrc = (activeVideo.currentSrc || activeVideo.src);
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
    activeVideo = syncVideo;
    activeVideo._lastSrc = (activeVideo.currentSrc || activeVideo.src);

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

    // Initial render: show first subtitle + hide loading even if video hasn't
    // started playing yet (browser autoplay policy may block video.play()).
    if (!syncLoadingHidden && preprocessedItems.length > 0) {
      for (const item of preprocessedItems) {
        if (now >= item.start && now < item.end) {
          if (!item.played) {
            item.played = true;
            showSubtitle(item.original, item.translation);
            syncLoadingHidden = true;
            unduckVideoAudio();
            hideLoading();
            if (item.audioEl) {
              stopTTS();
              enqueueAudio(item.audioEl, item.audioEl.src);
              item.audioEl = null;
            }
          }
          break;
        }
      }
    }

    // Video paused — pause TTS, keep position
    if (paused && !wasPaused) {
      wasPaused = true;
      stopTTS(); // clear queue
      if (ttsAudio) {
        try { ttsAudio.pause(); } catch (_) {}
      }
      return;
    }

    // Video resumed — detect if user seeked while paused, then resume TTS
    if (!paused && wasPaused) {
      wasPaused = false;
      // Detect time jump during pause (user dragged progress bar)
      if (Math.abs(now - lastSyncTime) > 1.0) {
        reSync(now);
      }
      if (ttsAudio && ttsAudio.paused) {
        try { ttsAudio.play().catch(function () {}); } catch (_) {}
      }
      lastSyncTime = now;
      return;
    }

    if (paused) {
      // Detect scrubbing while paused (user dragged progress bar without play)
      if (Math.abs(now - lastSyncTime) > 1.0) {
        reSync(now);
        lastSyncTime = now;
      }
      return;
    }

    const currentTime = now;

    // Detect seeking while playing (jump > 1 second)
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
    // Reset all items: mark future items unplayed, skip past items
    for (const item of preprocessedItems) {
      item._wordIdx = -1;
      if (currentTime < item.end) {
        item.played = false; // re-trigger for display
        // Re-create Audio element if consumed (looped/seeks)
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

    // Immediately show the subtitle at the new position (so it updates even
    // when the user scrubs while paused and hasn't resumed playback yet).
    var seekItem = null;
    for (var si = 0; si < preprocessedItems.length; si++) {
      if (currentTime >= preprocessedItems[si].start && currentTime < preprocessedItems[si].end) {
        seekItem = preprocessedItems[si];
        break;
      }
    }
    if (seekItem) {
      showSubtitle(seekItem.original, seekItem.translation);
      // Update word highlighting at the new position
      if (seekItem.words && seekItem.words.length > 0) {
        var wordIdx = -1;
        for (var w = 0; w < seekItem.words.length; w++) {
          if (currentTime >= seekItem.words[w].start && currentTime < seekItem.words[w].end) {
            wordIdx = w;
            break;
          }
        }
        if (wordIdx < 0 && currentTime >= seekItem.words[seekItem.words.length - 1].end) {
          wordIdx = seekItem.words.length;
        }
        seekItem._wordIdx = wordIdx;
        highlightOriginalWord(seekItem, wordIdx);
      }
    } else if (preprocessedItems.length === 0) {
      // No items at all — clear subtitle
      showSubtitle('', '');
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
    syncMode = false;
  }

  function startASRMode() {
    syncMode = false;
    startSent = false;
    warmupDone = false;
    syncLoadingHidden = false;
    preheatReady = false;
    preheatActive = false;

    // No volume ducking in floating mode — TTS plays in separate window
    if (!floatingFallback) {
      duckVideoAudio();
    }

    // For floating mode: start audio capture immediately from the hidden
    // video (main page, same document = reliable captureStream). PCM is
    // buffered until the WebSocket is ready and 'start' is sent.
    if (floatingFallback) {
      var captureVideo = window.__ai__._captureVideo || findVideoElement();
      if (captureVideo) { captureVideoAudio(captureVideo); }
    }

    // Use persistent pipeline: keep existing WS and AudioContext alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!floatingFallback) { startVideoWatcher(); duckVideoAudio(); showLoading(); }
      sendWS({ type: 'warmup' });
      return;
    }

    // No live connection — do full connect
    if (!floatingFallback) { startVideoWatcher(); duckVideoAudio(); showLoading(); }
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
    // Close floating window if active
    if (floatingFallback && window.__ai_closeFloatingWindow__) {
      window.__ai_closeFloatingWindow__();
      floatingFallback = false;
    }
    offlineRecording = false;
    // processorNode is the shared AudioWorkletNode — don't disconnect
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

    // processorNode is shared; don't disconnect
    offlineAudioCtx = null;
    if (offlineStream) { offlineStream.getTracks().forEach(function(t) { t.stop(); }); offlineStream = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }

    // Clean up loop-detection timeupdate listener
    if (offlineVideo && offlineVideo._offlineTimeUpdateHandler) {
      offlineVideo.removeEventListener('timeupdate', offlineVideo._offlineTimeUpdateHandler);
      offlineVideo._offlineTimeUpdateHandler = null;
    }

    // Stop the video immediately after recording completes
    if (offlineVideo) {
      try { offlineVideo.pause(); } catch (_) {}
    }

    updateLoadingText('神经网络处理中...', '正在提取特征向量');

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWS({ type: 'offline_asr_end' });
    }
  }

  async function startOfflineRecording(video) {
    offlineMode = true;
    offlineRecording = true;
    offlineVideo = video;
    offlineSavedRate = video.playbackRate;
    offlineSavedVolume = video.volume;

    // CRITICAL: load AudioWorklet FIRST. captureStream() before worklet is
    // ready means the load-window's 100-500ms of audio is silently dropped.
    var workletOk = await ensureAudioContext();
    if (!workletOk) {
      cleanupOffline();
      sendStatus('error', '无法初始化音频上下文');
      return;
    }
    offlineAudioCtx = audioContext;

    // Unmute before captureStream — TikTok etc. mute on page load
    video.muted = false;
    var stream = null;
    var useMediaElementSource = false;
    try {
      stream = video.captureStream();
    } catch (e) {
      try { stream = video.captureStream(0); } catch (e2) {
        useMediaElementSource = true;
      }
    }
    video.playbackRate = OFFLINE_SPEED;
    offlineStream = stream;

    var audioStream = null;
    if (!useMediaElementSource) {
      var audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        if (stream.getAudioTracks().length === 0) {
          useMediaElementSource = true;
        } else {
          cleanupOffline();
          sendStatus('error', '未捕获到音频，可能站点限制');
          return;
        }
      } else {
        audioStream = new MediaStream([audioTrack]);
      }
    }
    sendStatus('offline_recording', 'AudioContext sampleRate: ' + offlineAudioCtx.sampleRate);

    // Worklet is guaranteed ready here. Flush any prior tail then connect.
    if (processorNode) {
      try { processorNode.port.postMessage('flush'); } catch (_) {}
    }

    // Disconnect any existing source and connect this stream for recording
    if (sourceNode) { try { sourceNode.disconnect(); } catch (_) {} sourceNode = null; }

    if (useMediaElementSource) {
      sourceNode = offlineAudioCtx.createMediaElementSource(video);
    } else {
      sourceNode = offlineAudioCtx.createMediaStreamSource(audioStream);
    }
    sourceNode.connect(processorNode);
    // Lock source video for PCM timestamping
    currentPcmSrcVideo = video;
    _lastSampleSeqEnd = 0;

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

  function cleanupDisplayState() {
    // Stop sync playback loop + TTS + clear preprocessed items (display layer)
    stopSyncPlayback();
    stopTTS();
    // Clear subtitles instantly
    if (subtitleBox) { subtitleBox.style.transition = 'none'; subtitleBox.style.opacity = '0'; }
    contentDiv.innerHTML = '';
    subtitleBox = null;
    originalLine = null;
    translationLine = null;
    stopSubtitlePositioning();
    // Release all preprocessed audio resources
    for (const item of preprocessedItems) {
      if (item.audioEl) {
        try { item.audioEl.pause(); } catch (_) {}
        item.audioEl = null;
      }
      item.audio = null;
    }
    preprocessedItems = [];
    syncPrevActiveItem = null;
    lastSpokenText = '';
    currentUtteranceId = '';
    currentSessionId = generateSessionId();
    waitingPreprocess = false;
    processGeneration++;
  }

  function notifyPageTranslate(paused) {
    window.postMessage({ source: '__ai_video_translate__', type: paused ? 'video_started' : 'video_stopped' }, '*');
  }

  async function start() {
    // Full cleanup if already running from a previous video
    if (isRunning) {
      cleanupOffline();
      cleanupDisplayState();
      disconnectWebSocket();
      destroyPipeline();
      isRunning = false;
      fab.classList.remove('running');
      finishWarmup();
      chrome.runtime.sendMessage({ type: 'stopped' }).catch(function () {});
    }
    isRunning = true;
    notifyPageTranslate(true);
    fab.classList.add('running');
    warmupDone = false;
    syncLoadingHidden = false;
    startSent = false;
    syncMode = false;
    waitingPreprocess = false;
    if (!currentSessionId) currentSessionId = generateSessionId();

    lastUrl = location.href;
    startUrlWatcher();
    sendStatus('starting', '连接中...');

    preheatReady = false;

    // Stop preheat active — if there's a preheat WS in flight, kill it
    if (preheatActive && ws) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    preheatActive = false;

    // Safety timeout (loadingOverlay might not exist yet if showLoading deferred)
    if (loadingOverlay) {
      loadingOverlay._safetyTimer = setTimeout(function () {
        if (!warmupDone) {
          finishWarmup();
        }
      }, 15000);
    }

    // VOD → floating window or offline recording; live → real-time ASR
    var video = findVideoElement();
    if (video && !isLiveStream(video)) {
      if (window.startFloatingWindowMode) {
        window.startFloatingWindowMode(video);
      } else {
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
      return;
    }

    // No video or live stream — real-time ASR
    startASRMode();
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    fab.classList.remove('running');
    startSent = false;

    stopUrlWatcher();
    cleanupOffline();
    cleanupDisplayState();
    disconnectWebSocket();
    destroyPipeline();
    finishWarmup();

    notifyPageTranslate(false);

    chrome.runtime.sendMessage({ type: 'stopped' }).catch(function () {});
  }

  function updateSettings(newSettings) {
    Object.assign(settings, newSettings);
    applyDisplaySettings(newSettings);
    // If already connected, send updated config
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWS({
        type: 'config',
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        apiKey: settings.apiKey,
        region: settings.region,
        engine: settings.engine,
        ttsVoice: settings.ttsVoice,
        ollamaUrl: settings.ollamaUrl,
        ollamaModel: settings.ollamaModel,
      });
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

  // getVideoKey returns a stable cache key for a video+page combination.
  // optPageUrl overrides location.href (used when saving during navigation).
  function getVideoKey(video, optPageUrl) {
    var pageUrl = (optPageUrl || location.href).replace(/#.*/, '');
    var src = (video.currentSrc || video.src || '');
    // Non-blob URL: src is the most reliable differentiator
    if (src.indexOf('blob:') !== 0 && src.length > 0) {
      return hashKey(pageUrl + '|' + src.replace(/\?.*/, ''));
    }
    // Blob URL: build a composite key from available video identifiers
    var extra = '';
    // 1. video element id attribute (most reliable when present)
    if (video.id) {
      extra = '#id=' + video.id;
    }
    // 2. first <source> child with non-blob src (common on video platforms)
    if (!extra) {
      var sources = video.querySelectorAll('source');
      for (var si = 0; si < sources.length; si++) {
        var s = (sources[si].src || '').replace(/\?.*/, '');
        if (s && s.indexOf('blob:') !== 0) {
          extra = 'src=' + s;
          break;
        }
      }
    }
    // 3. DOM path fallback: ancestor chain (up to 5 levels) via nth-of-type
    if (!extra) {
      var path = '', el = video, depth = 0;
      while (el && el !== document.body && el !== document.documentElement && depth < 5) {
        var tag = el.tagName.toLowerCase();
        if (el.id) { path = '#' + el.id + '>' + path; break; }
        var nth = 1, prev = el.previousElementSibling;
        while (prev) { if (prev.tagName === el.tagName) nth++; prev = prev.previousElementSibling; }
        path = tag + ':nth-of-type(' + nth + ')>' + path;
        el = el.parentElement;
        depth++;
      }
      extra = 'path=' + path;
    }
    return hashKey(pageUrl + '|' + extra);
  }

  function hashKey(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return 'vid_' + Math.abs(h);
  }

  async function savePreprocessedToCache(video, items, optPageUrl) {
    try {
      var db = await openIDB();
      var tx = db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      var key = getVideoKey(video, optPageUrl);

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
    return null; // TODO: remove after debugging window mode
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
      case 'stop':
        // No-op: start/stop now handled by FAB button on page
        sendResponse({ success: true });
        break;

      case 'getStatus':
        sendResponse({ isRunning, floatingMode });
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
        sendWS({ type: 'voice', ttsVoice: newSettings.ttsVoice });
      }
    }

    if (newSettings.engine !== undefined && newSettings.engine !== settings.engine) {
      settings.engine = newSettings.engine;
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendWS({
          type: 'config',
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          apiKey: settings.apiKey,
          region: settings.region,
          engine: newSettings.engine,
          ttsVoice: settings.ttsVoice,
          ollamaUrl: settings.ollamaUrl,
          ollamaModel: settings.ollamaModel,
        });
      }
    }
    if (newSettings.ollamaUrl !== undefined) settings.ollamaUrl = newSettings.ollamaUrl;
    if (newSettings.ollamaModel !== undefined) settings.ollamaModel = newSettings.ollamaModel;

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

  // YouTube SPA navigation: detach stale state on page change
  document.addEventListener('yt-navigate-finish', function () {
    if (!isRunning) return;
    if (syncMode) {
      stopSyncPlayback();
    }
  });

  // Notify that content script is ready
  chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});
})();
