// floating-window.js — Delayed video mirror + subtitles + TTS popup
// Runs as a content script in MV3 isolated world. Accesses content.js
// closure variables through window.__ai__ bridge.
(function () {
  'use strict';

  if (window.__ai_floating_loaded__) return;
  window.__ai_floating_loaded__ = true;

  var ai = window.__ai__;
  if (!ai) return; // content.js bridge not ready

  // Local state (not shared with content.js)
  var stagingCanvas = null;
  var stagingCtx = null;
  // outputCanvas lives INSIDE the floating window — we draw delayed frames
  // directly onto it. No captureStream → srcObject → <video> indirection,
  // which previously added 100-200ms jitter and broke alignment.
  var outputCanvas = null;
  var outputCtx = null;
  var frameBuf = [];
  var frameBufIdx = 0;
  var frameBufCount = 0;
  // Virtual playback time of the floating window (seconds, in source video coords).
  // Advances strictly at 1× real-time. NEVER paused — the floating window
  // is just the original video delayed by ~6s. Subtitle and TTS are
  // segment-driven (videoTime is the single source of truth, like offline
  // mode). If a TTS line is still playing when the next segment begins,
  // the old TTS is cut and the new one starts — no drift, no pause.
  var _vt = null;            // null until first render
  var _vtLastAdvanceMs = 0;  // wall-clock anchor for vt advancement
  // FRAME_BUF_MAX is recomputed when FRAME_DELAY_MS changes (adaptive delay).
  // 30 fps × 16s headroom = 480 frames covers up to 15s delay + safety.
  var FRAME_BUF_MAX = 480;
  var FRAME_DELAY_MS = 6000;
  var captureRafId = null;
  var renderRafId = null;
  var captureVideoEl = null;
  var _audioReady = false;
  var _windowCloseCheckId = null;

  // ─── Helpers ────────────────────────────────────────────────────────

  function isFloatableVideo(video) {
    if (!video || ai.isLiveStream(video) || !video.duration || video.duration <= 0) return false;
    return true;
  }

  // ─── Popup window management ─────────────────────────────────────────

  function openFloatingWindow(video) {
    if (ai.floatingWindow && !ai.floatingWindow.closed) {
      try { ai.floatingWindow.close(); } catch (_) {}
    }

    var w = Math.round((video.videoWidth || 640) * 0.7) || 480;
    var h = Math.round((video.videoHeight || 360) * 0.7) + 100 || 400;
    var left = Math.max(0, screen.width - w - 40);
    var top = Math.max(0, (screen.height - h) / 2);

    ai.floatingWindow = window.open('about:blank', 'ai_translation_overlay',
      'width=' + w + ',height=' + h +
      ',left=' + left + ',top=' + top +
      ',resizable=1,scrollbars=0,status=0,toolbar=0,menubar=0,location=0');

    if (!ai.floatingWindow) {
      ai.sendStatus('error', '弹窗被浏览器拦截，请允许弹窗后刷新页面');
      return false;
    }

    try {
      ai.floatingWindow.document.write('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>AI 翻译配音</title>\n<style>\n' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{background:#0a0a1a;font-family:-apple-system,"Microsoft YaHei","PingFang SC",sans-serif;overflow:hidden;display:flex;flex-direction:column;height:100vh}' +
        '#video-wrap{position:relative;flex:1;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center}' +
        '#delayed-canvas{max-width:100%;max-height:100%;width:auto;height:auto;display:block;image-rendering:auto}' +
        '#sub-overlay{position:absolute;bottom:60px;left:0;right:0;text-align:center;pointer-events:none;z-index:10;padding:0 12px}' +
        '#sub-original{color:#fff;font-size:15px;text-shadow:0 1px 4px rgba(0,0,0,.85);margin-bottom:4px;min-height:20px;word-break:break-word}' +
        '#sub-translation{color:#ffd700;font-size:20px;font-weight:600;text-shadow:0 1px 4px rgba(0,0,0,.85);min-height:26px;word-break:break-word}' +
        '#status-tag{position:absolute;top:8px;right:12px;color:rgba(255,255,255,.5);font-size:11px;pointer-events:none}' +
        '#audio-panel{background:#111;padding:8px 12px;display:flex;align-items:center;gap:10px}' +
        '#audio-panel span{color:#888;font-size:12px}' +
        '#audio-primer{position:absolute;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:20;cursor:pointer}' +
        '#audio-primer span{color:#ffd700;font-size:18px;font-weight:600;text-align:center;line-height:1.6}' +
        '#audio-primer.hidden{display:none}' +
        '</style>\n</head>\n<body>\n' +
        '<div id="video-wrap"><canvas id="delayed-canvas"></canvas><div id="sub-overlay"><div id="sub-original"></div><div id="sub-translation"></div></div><div id="status-tag">AI 翻译 · -' + (FRAME_DELAY_MS / 1000) + 's</div></div>' +
        '<div id="audio-panel"><span>🔊</span><span id="audio-status">正在启用配音...</span></div>' +
        '<audio id="tts-player" style="display:none"></audio>' +
        '<div id="audio-primer"><span>🔊<br>点击此处启用配音</span></div>' +
        '</body>\n</html>');
      ai.floatingWindow.document.close();
    } catch (e) {
      console.error('[floating-window] document.write failed:', e.message);
      try { ai.floatingWindow.close(); } catch (_) {}
      ai.floatingWindow = null;
      ai.sendStatus('error', '浮窗初始化失败');
      return false;
    }

    // Direct canvas inside the popup. Render loop draws delayed bitmaps here.
    ai.floatingCanvas = ai.floatingWindow.document.getElementById('delayed-canvas');
    ai.floatingCanvasCtx = ai.floatingCanvas ? ai.floatingCanvas.getContext('2d') : null;
    ai.floatingLoaded = true;

    var sEl = ai.floatingWindow.document.getElementById('audio-status');
    var a = ai.floatingWindow.document.getElementById('tts-player');
    var primer = ai.floatingWindow.document.getElementById('audio-primer');

    // Try to prime audio using the main page's user gesture.
    // This may fail because the popup document doesn't always inherit user
    // activation from the opener. If so, the primer overlay stays visible
    // and the user clicks it for a direct gesture inside the popup.
    function primeAudio() {
      try {
        var p = new ai.floatingWindow.AudioContext();
        p.resume();
        var buf = p.createBuffer(1, 1, 22050);
        var src = p.createBufferSource();
        src.buffer = buf;
        src.connect(p.destination);
        src.start(0);
      } catch (_) {}

      try {
        a.volume = 0;
        a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        a.play().then(function () {
          a.pause(); a.currentTime = 0; a.volume = 1; a.src = '';
          _audioReady = true;
          if (primer) primer.classList.add('hidden');
          if (sEl) sEl.textContent = '配音已启用';
        }).catch(function () {
          // Auto-prime failed (browser autoplay policy) — show primer
          if (sEl) sEl.textContent = '点击浮窗任意位置启用配音';
        });
      } catch (_) {
        if (sEl) sEl.textContent = '点击浮窗任意位置启用配音';
      }
    }

    if (primer) {
      primer.addEventListener('click', function onClick() {
        primer.classList.add('hidden');
        primeAudio();
      });
    }
    // Attempt auto-prime immediately (may or may not work cross-window)
    primeAudio();

    return true;
  }

  function closeFloatingWindow() {
    // Clear popup close watcher
    if (_windowCloseCheckId) { clearInterval(_windowCloseCheckId); _windowCloseCheckId = null; }

    stopFloatingTTS();
    stopTimelineLoop();
    ai.floatingMode = false;
    ai.floatingLoaded = false;
    ai.floatingBufferFilled = false;
    if (captureRafId) { cancelAnimationFrame(captureRafId); captureRafId = null; }
    if (ai._cancelRenderRaf) { try { ai._cancelRenderRaf(); } catch (_) {} ai._cancelRenderRaf = null; }
    renderRafId = null;

    // Stop backend pipeline + audio capture immediately
    ai.stopAudioCapture();

    // Clean up loop detection
    if (_loopTimeHandler && ai.offlineVideo) {
      try { ai.offlineVideo.removeEventListener('timeupdate', _loopTimeHandler); } catch (_) {}
    }
    _loopTimeHandler = null;
    _loopLastTime = -1;
    _cachedReplay = false;

    ai._captureVideo = null;

    for (var i = 0; i < frameBuf.length; i++) {
      if (frameBuf[i] && frameBuf[i].bitmap) {
        try { frameBuf[i].bitmap.close(); } catch (_) {}
      }
    }
    frameBuf = [];
    frameBufIdx = 0;
    frameBufCount = 0;
    _vt = null;
    _vtLastAdvanceMs = 0;

    // CRITICAL: clear ALL session-scoped state on the ai shim. Without
    // this, the next startFloatingWindowMode() inherits stale flags from
    // the just-closed session — most notably audioFrozen=true (set when
    // source video ended or looped), which silently drops every PCM batch
    // and produces the "no audio capture after restart" bug.
    ai.audioFrozen = false;
    ai._visibleLine = null;
    ai._currentTtsEntry = null;
    ai._lastTtsFp = null;
    ai._lastTtsFpTime = 0;
    // Also reset module-level closure state. startFloatingWindowMode
    // resets these too, but if anything else triggers a render/timeline
    // path between close and the next start, stale values would leak.
    _floatingEnded = false;
    _firstSubtitle = true;
    _lastRefTime = undefined;
    _lastDisplayedItem = null;
    _lastItemEndTime = 0;

    stagingCanvas = null; stagingCtx = null;
    outputCanvas = null; outputCtx = null;
    captureVideoEl = null;
    ai.floatingCanvas = null;
    ai.floatingCanvasCtx = null;

    if (ai.floatingWindow && !ai.floatingWindow.closed) {
      try { ai.floatingWindow.close(); } catch (_) {}
    }
    ai.floatingWindow = null;
    ai.floatingVideo = null; // legacy field, kept for any external readers
    ai.floatingTtsQueue = [];
    ai.floatingTtsPlaying = false;
    ai.floatingTtsFallbackChunks = [];
    ai.floatingFallback = false;
    ai.floatingTimeline = [];
    ai.floatingTimelineCursor = 0;
    ai._displayedFrameVideoTime = undefined;
    // Reset adaptive delay so next session starts from baseline.
    FRAME_DELAY_MS = 6000;
    FRAME_BUF_MAX = 480;
    _adaptiveTickCount = 0;
    _lowHeadroomStreak = 0;
    _highHeadroomStreak = 0;
    _lastDelayChangeAt = 0;

    // Notify content.js so it can sync FAB/isRunning state. Without this
    // a user-initiated popup close leaves the FAB stuck in "running" —
    // the next click then routes to stop() (which does nothing useful)
    // instead of start(), making the extension appear unresponsive until
    // the user clicks a second time.
    if (typeof window.__ai_onFloatingClosed__ === 'function') {
      try { window.__ai_onFloatingClosed__(); } catch (_) {}
    }
  }

  window.__ai_closeFloatingWindow__ = closeFloatingWindow;

  // ─── Frame buffer + canvas pipeline (for blob URL / TikTok) ─────────

  function startFrameBuffer(video) {
    captureVideoEl = video;
    var vw = video.videoWidth || 640;
    var vh = video.videoHeight || 360;
    // Downscale large videos (e.g. 1080x1920 portrait) to keep frame buffer manageable
    var MAX_DIM = 720;
    var scale = Math.min(1, MAX_DIM / Math.max(vw, vh));
    var w = Math.round(vw * scale);
    var h = Math.round(vh * scale);
    console.log('[floating-window] frame buffer canvas: ' + w + 'x' + h + ' (scale ' + scale.toFixed(2) + ' from ' + vw + 'x' + vh + ')');

    stagingCanvas = document.createElement('canvas');
    stagingCanvas.width = w; stagingCanvas.height = h;
    stagingCtx = stagingCanvas.getContext('2d');

    // The popup canvas IS the output now. Size it to match capture aspect.
    outputCanvas = ai.floatingCanvas;
    outputCtx = ai.floatingCanvasCtx;
    if (outputCanvas) {
      outputCanvas.width = w;
      outputCanvas.height = h;
      // re-grab ctx after width/height assignment (resizing resets ctx state)
      outputCtx = outputCanvas.getContext('2d');
      ai.floatingCanvasCtx = outputCtx;
    }

    frameBuf = []; frameBufIdx = 0; frameBufCount = 0;
    ai.floatingBufferFilled = false;
    var bmpFailCount = 0;
    var tickCount = 0;
    var bufferStartTime = 0;
    var lastCaptureTime = 0;
    var CAPTURE_INTERVAL = 33; // ~30fps, avoids 144Hz memory bomb

    function tick() {
      if (!ai.floatingMode || !captureVideoEl) return;
      tickCount++;
      var now = performance.now();

      // Rate-limit capture to ~30fps
      if (now - lastCaptureTime < CAPTURE_INTERVAL) {
        captureRafId = requestAnimationFrame(tick);
        return;
      }
      lastCaptureTime = now;

      // CRITICAL: don't buffer frames until the ASR audio path is live.
      // The startup window (WS connect + AudioWorklet load) takes 1-2s.
      // If we buffer frames during that window, the floating window will
      // play back the video's opening seconds for which no audio was ever
      // captured — user sees lips moving but no subtitle/TTS for the
      // opening words. Defer the buffer clock until both sides are armed.
      if (!ai.asrCaptureReady) {
        captureRafId = requestAnimationFrame(tick);
        return;
      }

      // Track when first frame enters the buffer (after ASR is ready)
      if (!bufferStartTime && frameBufCount > 0) {
        bufferStartTime = now;
      }

      // Snapshot the video's currentTime AT capture moment so each frame
      // carries its true source-video timestamp. This becomes the canonical
      // alignment anchor: subtitle/TTS look up timeline by the same videoTime.
      var captureVideoTime = captureVideoEl.currentTime;
      try {
        stagingCtx.drawImage(captureVideoEl, 0, 0, stagingCanvas.width, stagingCanvas.height);
      } catch (e) {
        if (tickCount === 1) console.error('[floating-window] drawImage failed:', e.message);
        captureRafId = requestAnimationFrame(tick);
        return;
      }

      // Periodic canvas resize: handle video dimension changes (fullscreen, resize)
      if (tickCount > 0 && tickCount % 90 === 0) {
        var newVw = captureVideoEl.videoWidth || 640;
        var newVh = captureVideoEl.videoHeight || 360;
        var newScale = Math.min(1, MAX_DIM / Math.max(newVw, newVh));
        var newW = Math.round(newVw * newScale);
        var newH = Math.round(newVh * newScale);
        if (newW !== stagingCanvas.width || newH !== stagingCanvas.height) {
          console.log('[floating-window] resizing canvases: ' + stagingCanvas.width + 'x' + stagingCanvas.height + ' -> ' + newW + 'x' + newH);
          stagingCanvas.width = newW; stagingCanvas.height = newH;
          stagingCtx = stagingCanvas.getContext('2d');
          if (outputCanvas) {
            outputCanvas.width = newW; outputCanvas.height = newH;
            outputCtx = outputCanvas.getContext('2d');
            ai.floatingCanvasCtx = outputCtx;
          }
        }
      }

      createImageBitmap(stagingCanvas, 0, 0, stagingCanvas.width, stagingCanvas.height).then(function (bmp) {
        if (!ai.floatingMode) { bmp.close(); return; }
        var t = performance.now();

        if (frameBuf[frameBufIdx] && frameBuf[frameBufIdx].bitmap) {
          frameBuf[frameBufIdx].bitmap.close();
        }
        // videoTime: the EXACT video position this frame depicts. Used
        // by the timeline loop so subtitle/TTS sync to the same frame
        // (not to wall-clock elapsed, which drifts on buffering/seek).
        frameBuf[frameBufIdx] = { bitmap: bmp, time: t, videoTime: captureVideoTime };
        frameBufIdx = (frameBufIdx + 1) % FRAME_BUF_MAX;
        if (frameBufCount < FRAME_BUF_MAX) frameBufCount++;

        if (bmpFailCount > 0) {
          bmpFailCount = 0;
          console.log('[floating-window] createImageBitmap recovered');
        }

        // Use wall-clock elapsed time since first frame (decoupled from frame rate)
        if (!ai.floatingBufferFilled && bufferStartTime && t - bufferStartTime >= FRAME_DELAY_MS) {
          ai.floatingBufferFilled = true;
          console.log('[floating-window] Buffer filled after ' + (t - bufferStartTime).toFixed(0) + 'ms, ' + frameBufCount + ' frames');
          // Pre-seed _displayedFrameVideoTime from the oldest frame so the
          // very first timeline loop tick has a valid refTime (avoids a
          // momentary fallback to originalTime - 6s, which would mismatch).
          var oldestIdx = (frameBufIdx - frameBufCount + FRAME_BUF_MAX) % FRAME_BUF_MAX;
          var oldestFrm = frameBuf[oldestIdx];
          if (oldestFrm) {
            ai._displayedFrameVideoTime = oldestFrm.videoTime;
          }
          var sEl = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('audio-status') : null;
          if (sEl) sEl.textContent = '配音延迟 ~' + (FRAME_DELAY_MS / 1000).toFixed(0) + 's';
          // Start the render loop INSIDE the popup window so RAF runs on
          // the popup's compositor (foregrounded). Then start time-aligned
          // subtitle & TTS playback.
          startRenderLoop();
          startTimelineLoop();
        }
      }).catch(function (e) {
        bmpFailCount++;
        if (bmpFailCount === 1) {
          console.error('[floating-window] createImageBitmap failed (canvas tainted?):', e.message);
          var sEl = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('audio-status') : null;
          if (sEl) sEl.textContent = '视频镜像不可用 (跨域限制)';
        }
      });

      captureRafId = requestAnimationFrame(tick);
    }

    captureRafId = requestAnimationFrame(tick);
  }

  // ─── Render loop (runs in popup window, draws delayed frames) ──────
  //
  // Lives in the popup's own RAF queue so it stays smooth even when the
  // opener tab is throttled. Each frame:
  //   1. Pick the bitmap whose capture-time is closest to (now - FRAME_DELAY).
  //   2. drawImage onto the popup canvas.
  //   3. Publish that bitmap's videoTime so timeline/TTS can read it.
  // Drawing and publishing happen in the SAME RAF turn — zero gap between
  // "what the user sees" and "what subtitle/TTS thinks is showing".
  function startRenderLoop() {
    if (renderRafId) return;
    if (!ai.floatingWindow || ai.floatingWindow.closed) return;
    var popupRAF = ai.floatingWindow.requestAnimationFrame
      ? ai.floatingWindow.requestAnimationFrame.bind(ai.floatingWindow)
      : requestAnimationFrame;
    var popupCAF = ai.floatingWindow.cancelAnimationFrame
      ? ai.floatingWindow.cancelAnimationFrame.bind(ai.floatingWindow)
      : cancelAnimationFrame;

    function render() {
      if (!ai.floatingMode || !ai.floatingBufferFilled) {
        renderRafId = null;
        return;
      }
      if (!ai.floatingWindow || ai.floatingWindow.closed) {
        renderRafId = null;
        return;
      }
      if (!outputCanvas || !outputCtx) {
        renderRafId = popupRAF(render);
        return;
      }

      var now = performance.now();

      // Advance virtual playback time _vt (the video time the floating
      // window SHOULD be showing). Always at 1×, never paused — the
      // floating window is just the original video delayed by ~6s, so
      // its clock must run at the same rate.
      // Initialize from the oldest buffered frame on the first tick.
      if (_vt === null) {
        var oldIdx = (frameBufIdx - frameBufCount + FRAME_BUF_MAX) % FRAME_BUF_MAX;
        var oldFrm = frameBuf[oldIdx];
        _vt = oldFrm ? oldFrm.videoTime : 0;
        _vtLastAdvanceMs = now;
      } else {
        var dt = (now - _vtLastAdvanceMs) / 1000;
        if (dt > 0 && dt < 1) _vt += dt; // ignore huge gaps (tab throttled)
        _vtLastAdvanceMs = now;
      }

      // Pick the frame whose videoTime is closest to _vt.
      var best = null, bestDiff = Infinity;
      var maxVideoTime = -Infinity;
      for (var i = 0; i < frameBufCount; i++) {
        var idx = (frameBufIdx - frameBufCount + i + FRAME_BUF_MAX) % FRAME_BUF_MAX;
        var frm = frameBuf[idx];
        if (!frm || !frm.bitmap) continue;
        if (frm.videoTime > maxVideoTime) maxVideoTime = frm.videoTime;
        var diff = Math.abs(frm.videoTime - _vt);
        if (diff < bestDiff) { bestDiff = diff; best = frm; }
      }
      // Source video looped (TikTok prefetch). New frames have videoTime
      // near 0, all far below our _vt. Detect this and snap _vt to the
      // oldest new frame so the loop replays from the start.
      if (best && _vt > maxVideoTime + 2.0) {
        var oIdx = (frameBufIdx - frameBufCount + FRAME_BUF_MAX) % FRAME_BUF_MAX;
        var oFrm = frameBuf[oIdx];
        if (oFrm) {
          _vt = oFrm.videoTime;
          _vtLastAdvanceMs = now;
          // Re-pick best with the new _vt.
          best = null; bestDiff = Infinity;
          for (var j = 0; j < frameBufCount; j++) {
            var jdx = (frameBufIdx - frameBufCount + j + FRAME_BUF_MAX) % FRAME_BUF_MAX;
            var jfrm = frameBuf[jdx];
            if (!jfrm || !jfrm.bitmap) continue;
            var jd = Math.abs(jfrm.videoTime - _vt);
            if (jd < bestDiff) { bestDiff = jd; best = jfrm; }
          }
        }
      }
      if (best && best.bitmap) {
        try {
          outputCtx.drawImage(best.bitmap, 0, 0, outputCanvas.width, outputCanvas.height);
          // Publish the videoTime of the frame on screen so the timeline
          // loop reads the EXACT same anchor (= _vt rounded to nearest
          // available frame). Drawn + published in the same RAF turn.
          ai._displayedFrameVideoTime = best.videoTime;
          ai._lastRenderedAtMs = now; // for adaptive-delay health checks
        } catch (e) {
          // Stale bitmap (closed during eviction) — skip silently
        }
      }

      renderRafId = popupRAF(render);
    }
    renderRafId = popupRAF(render);

    // Stash CAF so closeFloatingWindow can cancel cleanly.
    ai._cancelRenderRaf = function () {
      if (renderRafId) { try { popupCAF(renderRafId); } catch (_) {} renderRafId = null; }
    };
  }

  // ─── Subtitle & TTS display in floating window ──────────────────────

  var _firstSubtitle = true;
  function showFloatingSubtitle(original, translation) {
    if (!ai.floatingWindow || ai.floatingWindow.closed || !ai.floatingLoaded) return;
    if (_firstSubtitle) {
      _firstSubtitle = false;
    }
    try {
      var origEl = ai.floatingWindow.document.getElementById('sub-original');
      var transEl = ai.floatingWindow.document.getElementById('sub-translation');
      // undefined = don't touch this field (partial update), null/'' = clear it
      if (origEl && original !== undefined) origEl.textContent = original || '';
      if (transEl && translation !== undefined) transEl.textContent = translation || '';
    } catch (_) {}
  }
  window.__ai_showFloatingSubtitle__ = showFloatingSubtitle;
  window.__ai_playFloatingTTS__ = playFloatingTTS;

  // ─── Timeline playback loop ────────────────────────────────────────

  var timelineRafId = null;
  var _lastDisplayedItem = null;
  var _lastItemEndTime = 0;
  var _lastRefTime = undefined;

  function escapeHTML(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Word-level highlighting for the original text in the floating window
  function highlightFloatingWord(item, wordIdx) {
    if (!item || !item.words || item.words.length === 0) return;
    var origEl = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('sub-original') : null;
    if (!origEl) return;
    if (wordIdx < 0) {
      origEl.textContent = item.original;
      return;
    }
    if (wordIdx >= item.words.length) {
      origEl.textContent = item.original;
      return;
    }
    var word = item.words[wordIdx].word;
    var text = item.original;
    var idx = text.indexOf(word);
    if (idx >= 0) {
      var before = escapeHTML(text.substring(0, idx));
      var hl = escapeHTML(text.substring(idx, idx + word.length));
      var after = escapeHTML(text.substring(idx + word.length));
      origEl.innerHTML = before + '<span style="color:#fbbf24;font-weight:600">' + hl + '</span>' + after;
    } else {
      var escaped = escapeHTML(text);
      var escapedWord = escapeHTML(word);
      var wIdx = escaped.indexOf(escapedWord);
      if (wIdx >= 0) {
        var before = escaped.substring(0, wIdx);
        var hl = escaped.substring(wIdx, wIdx + escapedWord.length);
        var after = escaped.substring(wIdx + escapedWord.length);
        origEl.innerHTML = before + '<span style="color:#fbbf24;font-weight:600">' + hl + '</span>' + after;
      } else {
        origEl.textContent = text;
      }
    }
  }

  function startTimelineLoop() {
    if (timelineRafId) return;

    // Run timeline loop on the POPUP's RAF so it stays foregrounded and
    // ticks adjacent to the render loop (both run on popup compositor).
    var popupRAF = (ai.floatingWindow && !ai.floatingWindow.closed && ai.floatingWindow.requestAnimationFrame)
      ? ai.floatingWindow.requestAnimationFrame.bind(ai.floatingWindow)
      : requestAnimationFrame;
    var popupCAF = (ai.floatingWindow && !ai.floatingWindow.closed && ai.floatingWindow.cancelAnimationFrame)
      ? ai.floatingWindow.cancelAnimationFrame.bind(ai.floatingWindow)
      : cancelAnimationFrame;
    ai._cancelTimelineRaf = function () {
      if (timelineRafId) { try { popupCAF(timelineRafId); } catch (_) {} timelineRafId = null; }
    };

    function loop() {
      var displayVideo = ai.offlineVideo;
      if (!ai.floatingMode || !displayVideo) {
        timelineRafId = null;
        return;
      }
      var originalTime = displayVideo.currentTime;
      // Alignment anchor: use the videoTime of the frame CURRENTLY ON SCREEN
      // in the floating window. This is published by the tick() loop after
      // each drawImage and tracks the actual displayed frame perfectly —
      // immune to wall-clock drift, video buffering, RAF throttling, seeks,
      // and playbackRate changes.
      //
      // In cached-replay mode the floating window does not delay frames
      // (it plays the source-video element directly), so fall back to
      // displayVideo.currentTime.
      var refTime;
      if (_cachedReplay) {
        refTime = originalTime;
      } else if (typeof ai._displayedFrameVideoTime === 'number') {
        refTime = ai._displayedFrameVideoTime;
      } else {
        // First few frames before any displayed frame is published.
        refTime = Math.max(0, originalTime - FRAME_DELAY_MS / 1000);
      }
      var timeline = ai.floatingTimeline;
      var cursor = ai.floatingTimelineCursor;

      // Detect FLOATING-WINDOW loop: the user is currently seeing the
      // displayed frame jump back to ~0. This is the ONLY correct signal
      // for "should I replay the timeline" — the source video may have
      // looped 6s ago but the user only sees the loop now.
      if (_lastRefTime !== undefined && refTime < _lastRefTime - 1.0) {
        // Reset cursor and "played" flags so cached entries replay in
        // sync with what the user actually sees on the popup canvas.
        ai.floatingTimelineCursor = 0;
        _lastDisplayedItem = null;
        _lastItemEndTime = 0;
        for (var r = 0; r < timeline.length; r++) { timeline[r].played = false; }
        // Reset virtual playback time so render loop picks the new loop's
        // frames from the start (not stuck at end-of-previous-loop vt).
        _vt = null;
        if (!_cachedReplay) {
          _cachedReplay = true;
          // Tell backend to clear the rolling buffer so the 2nd loop's
          // audio doesn't append to the 1st.
          try { ai.sendWS && ai.sendWS({ type: 'session_split' }); } catch (_) {}
        }
      } else if (_lastRefTime !== undefined && refTime > _lastRefTime + 0.5) {
        // Forward seek inside the same playback: trim stale entries.
        var cutIdx = timeline.length;
        for (var s = 0; s < timeline.length; s++) {
          if (timeline[s].start >= refTime) { cutIdx = s; break; }
        }
        if (cutIdx < timeline.length) {
          console.log('[floating-window] seek detected, trimming ' + (timeline.length - cutIdx) + ' stale entries after refTime=' + refTime.toFixed(1));
          timeline.splice(cutIdx, timeline.length - cutIdx);
        }
        _lastDisplayedItem = null;
        _lastItemEndTime = 0;
        for (var r2 = 0; r2 < timeline.length; r2++) { timeline[r2].played = false; }
      }
      _lastRefTime = refTime;

      // Find the current item based on refTime
      var currentItem = null;
      for (var i = cursor; i < timeline.length; i++) {
        var item = timeline[i];
        if (refTime >= item.start && refTime < item.end) {
          currentItem = item;
          break;
        }
        // Advance cursor past items that have fully passed
        if (item.end > 0 && refTime >= item.end) {
          ai.floatingTimelineCursor = i + 1;
        }
      }

      // ─── SUBTITLE + TTS — ATOMIC, ONE-TO-ONE ──────────────────────
      //
      // User contract: 字幕和配音必须严格对应。看到一句字幕就听到这一
      // 句的配音；不会出现"字幕换了 TTS 还在读上一句"。
      //
      // Strategy:
      //   1. A "line transition" = (original, translation) text changed.
      //   2. On line transition: STOP whatever TTS is playing right
      //      now, show the new subtitle, and play the new entry's TTS.
      //   3. If the new entry's audio hasn't arrived yet, the entry
      //      gets queued in _pendingLine — its TTS plays the moment
      //      audioBase64 appears, BUT only if the subtitle is still
      //      showing this same line. If the line already changed
      //      again, the late audio is discarded (we never play stale).
      //   4. Duplicate entries (same text) collapse into a single
      //      show+play. This handles whisper overlap, prefetch races,
      //      etc., regardless of how many entry objects exist.
      if (currentItem) {
        _lastItemEndTime = currentItem.end;

        var isNewLine = !_lastDisplayedItem ||
          currentItem.original !== _lastDisplayedItem.original ||
          currentItem.translation !== _lastDisplayedItem.translation;

        if (isNewLine) {
          // New segment is now visible (videoTime crossed seg.start).
          // Strict rule: cut whatever TTS is playing and start this
          // segment's TTS. Picture / subtitle / audio all driven by the
          // same clock (_vt) — no drift, no pause.
          if (ai._currentTtsEntry && ai._currentTtsEntry !== currentItem) {
            try { stopFloatingTTS(); } catch (_) {}
          }
          showFloatingSubtitle(currentItem.original, currentItem.translation);
          if (currentItem.words && currentItem.words.length > 0) {
            currentItem._wordIdx = -2;
          }
          // Bind this entry as the "currently visible line". Audio for
          // any OTHER entry that arrives later will be ignored.
          ai._visibleLine = currentItem;

          if (currentItem.audioBase64 && _audioReady) {
            currentItem.played = true;
            playFloatingTTS(currentItem.audioBase64, currentItem.audioMime || 'audio/mpeg', currentItem);
          }
          // else: audio not ready yet. The audio_end handler will check
          // ai._visibleLine + _vt < entry.end and play if still valid.
        } else if (currentItem !== _lastDisplayedItem) {
          // SAME text, different entry object → duplicate. Mark it
          // played so future loops don't play its audio either.
          currentItem.played = true;
        }
        _lastDisplayedItem = currentItem;
        // Word-level highlighting (per-frame update, like offline sync mode)
        if (currentItem.words && currentItem.words.length > 0) {
          var wordIdx = -1;
          for (var w = 0; w < currentItem.words.length; w++) {
            if (refTime >= currentItem.words[w].start && refTime < currentItem.words[w].end) {
              wordIdx = w;
              break;
            }
          }
          if (wordIdx < 0 && refTime >= currentItem.words[currentItem.words.length - 1].end) {
            wordIdx = currentItem.words.length;
          }
          if (wordIdx !== currentItem._wordIdx) {
            currentItem._wordIdx = wordIdx;
            highlightFloatingWord(currentItem, wordIdx);
          }
        }
      } else if (_lastDisplayedItem && refTime > _lastItemEndTime + 1.2) {
        // Clear subtitle after 1.2s of true silence. Since refTime now
        // tracks the actually-displayed frame (not wall-clock), and the
        // backend is always 3–4s ahead of the floating window, any
        // genuine new ASR result for this region has already arrived
        // before we get here. The old 3s threshold caused stale subtitles
        // to linger over silent segments.
        showFloatingSubtitle('', '');
        _lastDisplayedItem = null;
      }

      // Periodic cleanup: trim items far behind current playback position
      if (ai.floatingTimelineCursor > 30) {
        ai.floatingTimeline.splice(0, ai.floatingTimelineCursor);
        ai.floatingTimelineCursor = 0;
      }

      // Adaptive FRAME_DELAY_MS — sample every ~10 frames to avoid jitter.
      _adaptiveTickCount++;
      if (!_cachedReplay && _adaptiveTickCount % 10 === 0 && timeline.length > 0) {
        var asrHeadVt = timeline[timeline.length - 1].end || 0;
        var headroom = asrHeadVt - refTime;
        adaptDelay(headroom);
      }

      timelineRafId = popupRAF(loop);
    }
    timelineRafId = popupRAF(loop);
  }

  // ─── Adaptive delay controller ─────────────────────────────────────
  //
  // Goal: keep the floating window's effective delay just large enough
  // that backend ASR always stays ahead. If the user is on a slow CPU,
  // running a large whisper model, or has many tabs competing, the
  // headroom shrinks. We bump FRAME_DELAY_MS step-wise (6→8→10→12→15s)
  // BEFORE the buffer underruns. If headroom stays comfortable for a
  // while, we tiptoe back down.
  var FRAME_DELAY_MIN = 4000;
  var FRAME_DELAY_MAX = 10000;  // Cap at 10s. If beyond this, tell user it's slow.
  var DELAY_STEP_UP_MS = 1000;
  var DELAY_STEP_DOWN_MS = 1000;
  var _adaptiveTickCount = 0;
  var _lowHeadroomStreak = 0;
  var _highHeadroomStreak = 0;
  var _lastDelayChangeAt = 0;

  function adaptDelay(headroomSec) {
    var nowMs = performance.now();
    // Cooldown: don't change delay more than once every 4 seconds.
    if (nowMs - _lastDelayChangeAt < 4000) return;

    if (headroomSec < 1.5) {
      _lowHeadroomStreak++;
      _highHeadroomStreak = 0;
    } else if (headroomSec > 3.0) {
      _highHeadroomStreak++;
      _lowHeadroomStreak = 0;
    } else {
      _lowHeadroomStreak = 0;
      _highHeadroomStreak = 0;
      return;
    }

    var oldDelay = FRAME_DELAY_MS;
    var newDelay = oldDelay;

    // Emergency: headroom already negative — backend is BEHIND the window.
    // Bump aggressively, regardless of streak.
    if (headroomSec < 0) {
      newDelay = Math.min(FRAME_DELAY_MAX, oldDelay + 2000);
    } else if (_lowHeadroomStreak >= 8) {
      // Step up after 8 consecutive samples of low headroom
      newDelay = Math.min(FRAME_DELAY_MAX, oldDelay + DELAY_STEP_UP_MS);
    } else if (_highHeadroomStreak >= 5) {
      // Step down after 5 consecutive samples of comfort
      newDelay = Math.max(FRAME_DELAY_MIN, oldDelay - DELAY_STEP_DOWN_MS);
    }

    if (newDelay !== oldDelay) {
      console.log('[floating-window] adaptive delay: ' + oldDelay + 'ms → ' + newDelay +
        'ms (headroom=' + headroomSec.toFixed(2) + 's)');
      FRAME_DELAY_MS = newDelay;
      _lastDelayChangeAt = nowMs;
      _lowHeadroomStreak = 0;
      _highHeadroomStreak = 0;

      // Resize ring buffer to fit new delay + 1s safety margin.
      var neededFrames = Math.ceil((newDelay + 2000) / 33);
      if (neededFrames > FRAME_BUF_MAX) {
        FRAME_BUF_MAX = neededFrames;
        console.log('[floating-window] frame buffer expanded to ' + FRAME_BUF_MAX + ' frames');
      }

      // Update status text in popup.
      try {
        var sEl = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('audio-status') : null;
        if (sEl) sEl.textContent = '配音延迟 ~' + (newDelay / 1000).toFixed(1) + 's' +
          (newDelay > oldDelay ? ' (网络/算力较慢，自动加缓冲)' : '');
        var tagEl = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('status-tag') : null;
        if (tagEl) tagEl.textContent = 'AI 翻译 · -' + (newDelay / 1000).toFixed(1) + 's';
      } catch (_) {}
    }
  }

  function stopTimelineLoop() {
    if (ai._cancelTimelineRaf) {
      try { ai._cancelTimelineRaf(); } catch (_) {}
      ai._cancelTimelineRaf = null;
    } else if (timelineRafId) {
      cancelAnimationFrame(timelineRafId);
    }
    timelineRafId = null;
    _lastDisplayedItem = null;
    _lastItemEndTime = 0;
    _lastRefTime = undefined;
  }

  // TTS playback. The single source of truth is videoTime (_vt). Each
  // segment fires its TTS when _vt crosses seg.start; if a previous
  // segment's TTS is still playing, it gets cut. The only exception is
  // a silent gap: TTS is allowed to finish in the gap between segments.
  // The "is there a next segment now?" check happens in the timeline
  // loop (see _checkTtsCutoffOnNextSegment), not here.
  //
  // _currentTtsEntry: the timeline entry whose TTS is currently playing
  // (or just queued). Used by the timeline loop to know whether to cut
  // when a new segment becomes current.
  function playFloatingTTS(base64, mimeType, entry) {
    if (!ai.floatingWindow || ai.floatingWindow.closed || !ai.floatingLoaded) return;
    if (!_audioReady) {
      var sEl = ai.floatingWindow.document.getElementById('audio-status');
      if (sEl) sEl.textContent = '点击浮窗任意位置启用配音';
      return;
    }
    // Duplicate-defense: same audio just played → skip (guards against
    // accidental double-trigger from late-arriving audio race).
    var fp = base64.substring(0, 64);
    if (ai._lastTtsFp === fp && (Date.now() - (ai._lastTtsFpTime || 0)) < 8000) {
      return;
    }
    ai._lastTtsFp = fp;
    ai._lastTtsFpTime = Date.now();

    var a = ai.floatingWindow.document.getElementById('tts-player');
    if (!a) {
      try { a = new ai.floatingWindow.Audio(); a.id = 'tts-player'; } catch (_) { return; }
    }
    try { a.onended = null; a.pause(); } catch (_) {}
    var s = ai.settings || {};
    a.volume = (s.ttsVolume || 100) / 100;
    a.playbackRate = 1.0;

    ai._currentTtsEntry = entry || null;

    a.onended = function () {
      ai._currentTtsEntry = null;
    };

    a.src = 'data:' + (mimeType || 'audio/mpeg') + ';base64,' + base64;
    var p = a.play();
    if (p !== undefined) {
      p.catch(function (e) {
        ai._currentTtsEntry = null;
        if (e && e.name === 'NotAllowedError') {
          _audioReady = false;
          var sEl2 = ai.floatingWindow.document.getElementById('audio-status');
          if (sEl2) sEl2.textContent = '点击浮窗任意位置启用配音';
        }
      });
    }
  }

  function playNextFloatingTTS() {
    var q = ai.floatingTtsQueue;
    if (q.length === 0) { ai.floatingTtsPlaying = false; return; }
    ai.floatingTtsPlaying = true;

    // Reuse the persistent audio element created during user-gesture click
    var a = ai.floatingWindow.document.getElementById('tts-player');
    if (!a) {
      // Fallback: create one now (may be blocked by autoplay policy)
      a = new ai.floatingWindow.Audio();
      a.id = 'tts-player';
    }

    var item = q.shift();
    a.volume = item.volume;
    a.src = item.url;

    var ended = false;
    function onEnd() {
      if (ended) return;
      ended = true;
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('error', onErr);
      a.src = '';
      playNextFloatingTTS();
    }
    function onErr(e) {
      if (ended) return;
      var msg = (a.error && a.error.message) || 'unknown';
      console.error('[floating-window] TTS play error:', msg);
      onEnd();
    }
    a.addEventListener('ended', onEnd);
    a.addEventListener('error', onErr);

    var playPromise = a.play();
    if (playPromise !== undefined) {
      playPromise.catch(function (e) {
        console.error('[floating-window] TTS play() rejected:', e.message);
        if (!ended) {
          // If user hasn't interacted yet, prompt and skip this clip
          var sEl = ai.floatingWindow.document.getElementById('audio-status');
          if (sEl) sEl.textContent = '点击浮窗任意位置启用配音';
          _audioReady = false;
          onEnd();
        }
      });
    }
  }

  function stopFloatingTTS() {
    var a = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('tts-player') : null;
    if (a) {
      try { a.onended = null; a.pause(); a.src = ''; } catch (_) {}
    }
    ai._currentTtsEntry = null;
    ai.floatingTtsQueue = [];
    ai.floatingTtsPlaying = false;
  }

  function handleFloatingAudioStart(msg) {
    stopFloatingTTS();
    ai.floatingTtsFallbackChunks = [];
  }

  function handleFloatingAudioChunk(msg) {
    if (!msg.audio) return;
    var binary = atob(msg.audio);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ai.floatingTtsFallbackChunks.push(bytes);
  }

  function handleFloatingAudioEnd(msg) {
    var chunks = ai.floatingTtsFallbackChunks;
    if (chunks.length > 0) {
      var blob = new Blob(chunks, { type: 'audio/mpeg' });
      var reader = new FileReader();
      reader.onload = function () {
        var b64 = reader.result.split(',')[1];
        playFloatingTTS(b64, 'audio/mpeg');
      };
      reader.readAsDataURL(blob);
      ai.floatingTtsFallbackChunks = [];
    }
  }

  window.__ai_handleFloatingAudioStart__ = handleFloatingAudioStart;
  window.__ai_handleFloatingAudioChunk__ = handleFloatingAudioChunk;
  window.__ai_handleFloatingAudioEnd__ = handleFloatingAudioEnd;
  // Bridge for content.js to play TTS immediately when late-arriving
  // audio matches the currently-visible line.
  ai.playFloatingTTSDirect = playFloatingTTS;
  // Expose current _vt so content.js can validate late-arriving audio
  // (drop if _vt already crossed entry.end).
  ai.getFloatingVt = function () { return _vt; };

  var _floatingEnded = false;
  var _loopLastTime = -1;
  var _loopTimeHandler = null;
  var _cachedReplay = false;

  function onFloatingVideoEnded() {
    if (!ai.floatingMode) return;
    if (_floatingEnded) return; // idempotent
    _floatingEnded = true;
    // Step 1: FREEZE audio IMMEDIATELY. From this instant, any new PCM
    //   batch from the worklet gets dropped — this is what prevents the
    //   TikTok 2nd-loop audio from polluting the timeline. The worklet
    //   itself keeps running (it's tied to AudioContext, not the video),
    //   but content.js's onmessage handler rejects non-flush batches
    //   when audioFrozen is true.
    ai.audioFrozen = true;
    // Step 2: flush the AudioWorklet so the final < 256ms of PCM (the
    //   real tail of the original video) is sent. This batch is marked
    //   {flush:true} and is allowed through the audioFrozen gate.
    try {
      if (ai._flushAudioWorklet) ai._flushAudioWorklet();
    } catch (_) {}
    // Step 3: ask backend to immediately process whatever it has buffered.
    if (ai.ws && ai.ws.readyState === WebSocket.OPEN) {
      try { ai.sendWS({ type: 'flush_tail' }); } catch (_) {}
    }
  }


  // ─── Main entry: startFloatingWindowMode ────────────────────────────

  window.startFloatingWindowMode = function (video) {
    console.log('[floating-window] startFloatingWindowMode called, video:', {
      src: video.currentSrc || video.src,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
    });

    ai.floatingMode = true;
    ai.offlineMode = true;
    ai.syncMode = false;
    ai.subtitleMode = false;
    ai.floatingFallback = true;
    ai.floatingTimeline = [];
    ai.floatingTimelineCursor = 0;
    ai._displayedFrameVideoTime = undefined;
    // Reset module-level state to avoid carry-over from previous session
    _lastRefTime = undefined;
    _lastDisplayedItem = null;
    _lastItemEndTime = 0;
    _cachedReplay = false;
    _loopLastTime = -1;
    _firstSubtitle = true;
    _floatingEnded = false;
    ai.audioFrozen = false;
    ai._visibleLine = null;
    ai._lastTtsFp = null;
    ai._currentTtsEntry = null;
    _vt = null;
    _vtLastAdvanceMs = 0;

    if (!openFloatingWindow(video)) {
      ai.floatingMode = false;
      ai.offlineMode = false;
      ai.offlineVideo = null;
      ai.floatingFallback = false;
      ai.floatingTimeline = [];
      ai.startASRMode();
      return;
    }

    // Helper: set up watchers for source video (NOT for floating window UX)
    function attachWatchers(cv) {
      cv.addEventListener('ended', function () {
        onFloatingVideoEnded();
      }); // NOT once:true — TikTok loop can fire ended multiple times; the
          // onFloatingVideoEnded function is idempotent (guarded by
          // _floatingEnded flag), so extra fires are safe.

      // Detect source-video RESET (TikTok player swaps video element mid-
      // playback for prefetch). When currentTime jumps backwards or play
      // event fires with currentTime ≈ 0 AFTER PCM has already started
      // flowing, we must tell backend to clear its rolling buffer —
      // otherwise the "second start" audio gets appended to the first
      // and ASR produces overlapping/duplicate utterances. This is the
      // root cause of "first sentence TTS reads twice".
      // Source-video end detection. Three triggers all converge to
      // onFloatingVideoEnded (idempotent, sets audioFrozen=true so the
      // 2nd loop or any post-end audio doesn't pollute the timeline):
      //   1. 'ended' event — the standard path (YouTube etc.) — see attachWatchers above
      //   2. currentTime ≥ duration - 0.2 — defensive, some players don't fire 'ended'
      //   3. currentTime jumps backward (>1.0 → <0.5) — TikTok auto-loop
      //      (the player neither fires 'ended' nor pauses — it just loops).
      // _hasPlayedThroughOnce guards against false positives during
      // initial seek / startup.
      var _lastObservedTime = -1;
      var _hasPlayedThroughOnce = false;
      function onSourceTimeChange() {
        var t = cv.currentTime;
        var dur = cv.duration;

        // Backward jump → TikTok-style loop reset
        if (_lastObservedTime > 1.0 && t < 0.5 && !_floatingEnded) {
          console.log('[floating-window] source video looped (currentTime ' +
            _lastObservedTime.toFixed(1) + ' → ' + t.toFixed(1) + '), stopping audio capture');
          try { ai.sendWS && ai.sendWS({ type: 'session_split' }); } catch (_) {}
          onFloatingVideoEnded();
          _lastObservedTime = t;
          return;
        }

        // Track that we've seen real playback progress (used by the
        // duration-based detector below to avoid false positives if the
        // user starts the window when video is already near the end).
        if (isFinite(dur) && dur > 1 && t < dur - 1) {
          _hasPlayedThroughOnce = true;
        }

        // Reached near end without 'ended' firing
        if (_hasPlayedThroughOnce && isFinite(dur) && dur > 1 &&
            t >= dur - 0.2 && !_floatingEnded) {
          console.log('[floating-window] source video reached end (currentTime ' +
            t.toFixed(2) + ' / ' + dur.toFixed(2) + '), stopping audio capture');
          onFloatingVideoEnded();
        }

        _lastObservedTime = t;
      }
      cv.addEventListener('timeupdate', onSourceTimeChange);
      cv.addEventListener('seeking', onSourceTimeChange);

      _loopLastTime = -1;
      _cachedReplay = false;
      _loopTimeHandler = null;

      // Use popup's 'unload' event (reliable) + occasional .closed poll
      // (fallback). The previous version polled only .closed which is
      // unreliable in Chromium — false positives caused the popup to
      // auto-destroy itself when the user just changed tabs.
      var unloadFired = false;
      try {
        ai.floatingWindow.addEventListener('unload', function () {
          unloadFired = true;
          if (cv.ended) onFloatingVideoEnded();
          // Defer cleanup so the unload handler can complete first.
          setTimeout(closeFloatingWindow, 0);
        });
      } catch (_) {}

      // Conservative .closed poll: require .closed to be true for TWO
      // consecutive checks (3s apart) before believing it.
      var closedStreak = 0;
      _windowCloseCheckId = setInterval(function () {
        if (unloadFired) {
          clearInterval(_windowCloseCheckId);
          _windowCloseCheckId = null;
          return;
        }
        if (ai.floatingWindow && ai.floatingWindow.closed) {
          closedStreak++;
          if (closedStreak >= 2) {
            clearInterval(_windowCloseCheckId);
            _windowCloseCheckId = null;
            if (cv.ended) onFloatingVideoEnded();
            closeFloatingWindow();
          }
        } else {
          closedStreak = 0;
        }
      }, 3000);
    }

    // Page video capture + frame buffer display
    startFrameBuffer(video);
    _floatingEnded = false;
    video.currentTime = 0;

    // Wait for seek to complete before playing. Setting currentTime
    // triggers an async seek; if play() runs first the video may
    // briefly output audio from the old position, corrupting timestamps.
    function startVideoPlayback() {
      video.play().catch(function (e) {
        console.error('[floating-window] video.play() rejected:', e.message);
        video.muted = true;
        video.play().catch(function () {});
        var sEl = ai.floatingWindow && !ai.floatingWindow.closed
          ? ai.floatingWindow.document.getElementById('audio-status') : null;
        if (sEl) sEl.textContent = '视频播放被阻止';
      });
      // Start ASR after play — PCM is buffered locally during WS warmup
      // and flushed to backend when pipeline is ready.
      ai.startASRMode();
    }
    if (video.seeking) {
      video.addEventListener('seeked', function onSeeked() {
        video.removeEventListener('seeked', onSeeked);
        startVideoPlayback();
      }, { once: true });
    } else {
      startVideoPlayback();
    }
    ai.offlineVideo = video;
    ai._captureVideo = video;
    attachWatchers(video);
  };
})();
