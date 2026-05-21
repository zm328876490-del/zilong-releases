// offscreen.js — Hidden document for background video processing
// Plays video at 2x speed, captures audio via captureStream(),
// sends PCM over WebSocket to Go backend, receives preprocessed
// subtitles + TTS audio, and returns results to the main page.
(function () {
  'use strict';

  if (window.__ai_offscreen_loaded__) return;
  window.__ai_offscreen_loaded__ = true;

  // ─── State ─────────────────────────────────────────────────────────
  let video = null;
  let audioContext = null;
  let stream = null;
  let sourceNode = null;
  let processorNode = null;
  let ws = null;
  let isRecording = false;
  let sessionId = '';
  let settings = {};
  let preprocessedItems = [];
  let safetyTimer = null;
  let keepAlivePort = null;
  let keepAliveTimer = null;
  let blobUrls = []; // track blob URLs for cleanup

  const OFFLINE_SPEED = 2.0;

  // ─── Keep service worker alive ─────────────────────────────────────
  keepAlivePort = chrome.runtime.connect({ name: 'offscreen-keepalive' });
  keepAlivePort.onDisconnect.addListener(function () {
    keepAlivePort = null;
  });
  // Heartbeat every 20s to prevent SW termination
  keepAliveTimer = setInterval(function () {
    if (keepAlivePort) {
      try { keepAlivePort.postMessage({ type: 'ping' }); } catch (_) {
        keepAlivePort = null;
      }
    }
    if (!keepAlivePort && chrome.runtime) {
      keepAlivePort = chrome.runtime.connect({ name: 'offscreen-keepalive' });
    }
  }, 20000);

  // ─── Message handlers ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    switch (message.type) {
      case 'startRecording':
        startRecording(message.videoUrl, message.settings, message.sessionId);
        sendResponse({ success: true });
        break;
      case 'stopRecording':
        stopRecording();
        sendResponse({ success: true });
        break;
      case 'ping':
        sendResponse({ pong: true });
        break;
    }
    return true;
  });

  // ─── Status reporting ──────────────────────────────────────────────
  function reportStatus(status, msg) {
    chrome.runtime.sendMessage({
      type: 'offscreenStatus',
      status: status,
      message: msg || '',
      sessionId: sessionId,
    }).catch(function () {});
  }

  function reportResult(items) {
    chrome.runtime.sendMessage({
      type: 'offscreenResult',
      items: items,
      sessionId: sessionId,
    }).catch(function () {});
  }

  function reportError(msg) {
    chrome.runtime.sendMessage({
      type: 'offscreenError',
      message: msg,
      sessionId: sessionId,
    }).catch(function () {});
  }

  // ─── Core: start recording ─────────────────────────────────────────
  async function startRecording(videoUrl, _settings, _sessionId) {
    settings = _settings || {};
    sessionId = _sessionId || '';

    reportStatus('loading', '正在下载视频...');

    // 1. Download video
    let videoBlob;
    try {
      var fetchStart = Date.now();
      var resp = await fetch(videoUrl);
      if (!resp.ok) {
        // If direct fetch fails (e.g. CORS / Referer check), report and let caller fallback
        reportError('视频下载失败 HTTP ' + resp.status + ' (可尝试页面内播放)');
        return;
      }
      videoBlob = await resp.blob();
      var fetchMs = Date.now() - fetchStart;
      var sizeMB = (videoBlob.size / 1024 / 1024).toFixed(1);
      reportStatus('loaded', '视频已下载 ' + sizeMB + 'MB (' + (fetchMs / 1000).toFixed(1) + 's)');
    } catch (e) {
      reportError('视频下载异常: ' + e.message);
      return;
    }

    // 2. Create video element
    video = document.createElement('video');
    var blobUrl = URL.createObjectURL(videoBlob);
    blobUrls.push(blobUrl);
    video.src = blobUrl;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    // 3. Wait for metadata
    try {
      await new Promise(function (resolve, reject) {
        var timeout = setTimeout(function () {
          reject(new Error('视频元数据加载超时'));
        }, 30000);
        video.onloadedmetadata = function () {
          clearTimeout(timeout);
          resolve();
        };
        video.onerror = function () {
          clearTimeout(timeout);
          reject(new Error('视频加载失败'));
        };
        video.load();
      });
    } catch (e) {
      reportError(e.message);
      cleanup();
      return;
    }

    var durationSec = video.duration || 0;
    if (durationSec <= 0) {
      reportError('视频时长无效');
      cleanup();
      return;
    }

    reportStatus('capturing', '开始采集音频 (时长 ' + Math.round(durationSec) + 's)...');

    // 4. Capture audio stream
    try {
      stream = video.captureStream();
    } catch (e) {
      reportError('captureStream 失败: ' + e.message);
      cleanup();
      return;
    }

    var audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      reportError('视频无音轨');
      cleanup();
      return;
    }
    var audioStream = new MediaStream([audioTrack]);

    // 5. Set up AudioContext
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
    } catch (e) {
      reportError('AudioContext 创建失败: ' + e.message);
      cleanup();
      return;
    }

    // Start loading AudioWorklet module in parallel with WS handshake
    var workletPromise = audioContext.audioWorklet.addModule('audio-processor.js');

    // 6. Connect to backend
    var connected = await connectWebSocket();
    if (!connected) {
      reportError('后端 WebSocket 连接失败');
      cleanup();
      return;
    }

    // Wait for backend to be configured before starting audio
    var configured = await waitForConfig();
    if (!configured) {
      reportError('后端配置超时');
      cleanup();
      return;
    }

    // Ensure AudioWorklet module is loaded before creating the node
    try {
      await workletPromise;
    } catch (e) {
      reportError('AudioWorklet 加载失败: ' + e.message);
      cleanup();
      return;
    }

    // 7. Create AudioWorkletNode — runs on dedicated audio thread, never drops chunks
    processorNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');

    var silentChunks = 0;
    var maxSilentChunks = Math.ceil(3000 / (4096 / (audioContext.sampleRate || 16000) * 1000));

    processorNode.port.onmessage = function (e) {
      if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
      // Transfer ArrayBuffer directly to WebSocket (zero-copy)
      ws.send(e.data.pcm);

      // Silence detection
      if (e.data.maxAbs < 50) {
        silentChunks++;
        if (silentChunks >= maxSilentChunks) {
          reportError('采集到静音音频，当前页面可能不支持离线采集');
          onRecordingFatal();
        }
      } else {
        silentChunks = 0;
      }
    };

    sourceNode = audioContext.createMediaStreamSource(audioStream);
    sourceNode.connect(processorNode);

    // 8. Send offline ASR start and begin playback
    ws.send(JSON.stringify({
      type: 'offline_asr_start',
      sampleRate: audioContext.sampleRate,
      speed: OFFLINE_SPEED,
      sessionId: sessionId,
    }));

    isRecording = true;
    video.playbackRate = OFFLINE_SPEED;
    video.currentTime = 0;

    // 9. Handle video end
    var ended = false;
    function onEnded() {
      if (ended) return;
      ended = true;
      video.removeEventListener('ended', onEnded);
      onRecordingDone();
    }
    video.addEventListener('ended', onEnded, { once: true });

    // Loop detection (TikTok-style looping without 'ended' event)
    var lastTime = -1;
    function onTimeUpdate() {
      if (!isRecording || ended) {
        video.removeEventListener('timeupdate', onTimeUpdate);
        return;
      }
      var t = video.currentTime;
      if (lastTime >= 0 && t < lastTime - 0.5) {
        onEnded();
      }
      lastTime = t;
    }
    video.addEventListener('timeupdate', onTimeUpdate);

    // Safety timeout: duration / speed + 60s buffer
    var maxWaitMs = Math.ceil((durationSec / OFFLINE_SPEED) * 1000) + 60000;
    safetyTimer = setTimeout(function () {
      if (isRecording) {
        reportError('录制超时');
        onEnded();
      }
    }, maxWaitMs);

    // 10. Play
    try {
      await video.play();
      reportStatus('recording', '2x 倍速录制中 (可切换窗口)...');
    } catch (e) {
      reportError('视频播放失败: ' + e.message);
      cleanup();
    }
  }

  // ─── WebSocket connection ──────────────────────────────────────────
  function connectWebSocket() {
    var wsUrl = settings.wsUrl || 'ws://localhost:29527/ws';

    return new Promise(function (resolve) {
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        resolve(false);
        return;
      }

      ws.binaryType = 'arraybuffer';

      var resolved = false;
      var timeout = setTimeout(function () {
        if (!resolved) { resolved = true; resolve(false); }
      }, 10000);

      ws.onopen = function () {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        // Send config so backend knows languages, engine, voice etc.
        ws.send(JSON.stringify({
          type: 'config',
          sourceLang: settings.sourceLang || 'auto',
          targetLang: settings.targetLang || 'zh-Hans',
          apiKey: settings.apiKey || '',
          region: settings.region || 'eastasia',
          engine: settings.engine || 'microsoft',
          ttsVoice: settings.ttsVoice || 'default',
          sessionId: sessionId,
        }));

        // Signal WebSocket ready — caller still waits for 'configured' status
      };

      ws.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          handleBackendMessage(msg);
        } catch (_) {
          // binary data — ignore
        }
      };

      ws.onerror = function () {
        // onclose will follow
      };

      ws.onclose = function () {
        ws = null;
        if (isRecording) {
          reportError('WebSocket 连接断开');
          onRecordingFatal();
        }
      };

      // resolve when open fires
      var checkTimer = setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          clearInterval(checkTimer);
          resolve(true);
        }
      }, 100);
    });
  }

  function waitForConfig() {
    return new Promise(function (resolve) {
      var timeout = setTimeout(function () { resolve(false); }, 15000);

      // Store original handler, then wrap to detect 'configured'
      var origHandler = ws.onmessage;
      ws.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          if (msg.type === 'status' && msg.status === 'configured') {
            clearTimeout(timeout);
            resolve(true);
            // Restore original handler
            ws.onmessage = origHandler;
            return;
          }
          // Forward to original handler
          if (origHandler) origHandler.call(ws, event);
        } catch (_) {
          if (origHandler) origHandler.call(ws, event);
        }
      };
    });
  }

  // ─── Backend message handling ──────────────────────────────────────
  function handleBackendMessage(msg) {
    switch (msg.type) {
      case 'offline_asr_result':
        if (msg.subs && msg.subs.length > 0) {
          reportStatus('processing', 'ASR 识别完成: ' + msg.subs.length + ' 个片段, 开始翻译...');
        } else {
          reportError('离线 ASR 未识别到语音');
          scheduleCleanup();
        }
        break;

      case 'preprocess_start':
        reportStatus('processing', '翻译 + TTS 处理中 (' + msg.total + ' 个片段)...');
        break;

      case 'preprocess_result':
        if (msg.items && msg.items.length > 0) {
          for (var i = 0; i < msg.items.length; i++) {
            preprocessedItems.push(msg.items[i]);
          }
          preprocessedItems.sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
          if (msg.ready) {
            // All items received — send result back
            reportStatus('complete', '处理完成: ' + preprocessedItems.length + ' 条字幕');
            reportResult(preprocessedItems);
            scheduleCleanup();
          }
        }
        break;

      case 'preprocess_complete':
        // Final ack — items were already delivered in preprocess_result batches
        scheduleCleanup();
        break;

      case 'preprocess_error':
        reportError(msg.message || '预处理失败');
        scheduleCleanup();
        break;

      case 'error':
        reportError(msg.message || '后端错误');
        scheduleCleanup();
        break;
    }
  }

  function scheduleCleanup() {
    setTimeout(function () { cleanup(); }, 2000);
  }

  // ─── Recording lifecycle ───────────────────────────────────────────
  function onRecordingDone() {
    if (!isRecording) return;
    isRecording = false;

    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }

    if (video) {
      try { video.pause(); } catch (_) {}
    }

    if (processorNode) {
      processorNode.port.onmessage = null;
      try { processorNode.disconnect(); } catch (_) {}
      processorNode = null;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'offline_asr_end',
        sessionId: sessionId,
      }));
    }

    reportStatus('processing', '音频已采集完毕，正在识别...');
    // Results will come through WebSocket → handleBackendMessage → reportResult
  }

  function onRecordingFatal() {
    isRecording = false;
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    cleanup();
  }

  function stopRecording() {
    reportStatus('stopped', '用户停止录制');
    cleanup();
  }

  // ─── Cleanup ───────────────────────────────────────────────────────
  function cleanup() {
    isRecording = false;

    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }

    if (processorNode) {
      processorNode.port.onmessage = null;
      try { processorNode.disconnect(); } catch (_) {}
      processorNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) {}
      sourceNode = null;
    }
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
      audioContext = null;
    }
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      stream = null;
    }
    if (video) {
      try { video.pause(); } catch (_) {}
      try { video.remove(); } catch (_) {}
      video = null;
    }
    // Revoke all blob URLs we created
    for (var i = 0; i < blobUrls.length; i++) {
      try { URL.revokeObjectURL(blobUrls[i]); } catch (_) {}
    }
    blobUrls = [];

    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (keepAlivePort) {
      try { keepAlivePort.disconnect(); } catch (_) {}
      keepAlivePort = null;
    }

    preprocessedItems = [];

    // Close this offscreen document
    try { chrome.offscreen.closeDocument(); } catch (_) {}
  }
})();
