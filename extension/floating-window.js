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
  var outputCanvas = null;
  var outputCtx = null;
  var outputStream = null;
  var frameBuf = [];
  var frameBufIdx = 0;
  var frameBufCount = 0;
  var FRAME_BUF_MAX = 240;
  var FRAME_DELAY_MS = 6000;
  var captureRafId = null;
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
        '#video-wrap{position:relative;flex:1;background:#000;overflow:hidden}' +
        '#delayed-video{width:100%;height:100%;object-fit:contain;display:block}' +
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
        '<div id="video-wrap"><video id="delayed-video" autoplay muted playsinline></video><div id="sub-overlay"><div id="sub-original"></div><div id="sub-translation"></div></div><div id="status-tag">AI 翻译 · -' + (FRAME_DELAY_MS / 1000) + 's</div></div>' +
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

    ai.floatingVideo = ai.floatingWindow.document.getElementById('delayed-video');
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
        }).catch(function (e) {
          // Auto-prime failed — keep primer for manual click inside popup
          console.warn('[floating-window] auto-prime failed, waiting for user click in popup:', e.message);
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

    if (outputStream) {
      outputStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      outputStream = null;
    }
    stagingCanvas = null; stagingCtx = null;
    outputCanvas = null; outputCtx = null;
    captureVideoEl = null;

    if (ai.floatingWindow && !ai.floatingWindow.closed) {
      try { ai.floatingWindow.close(); } catch (_) {}
    }
    ai.floatingWindow = null;
    ai.floatingVideo = null;
    ai.floatingTtsQueue = [];
    ai.floatingTtsPlaying = false;
    ai.floatingTtsFallbackChunks = [];
    ai.floatingFallback = false;
    ai.floatingTimeline = [];
    ai.floatingTimelineCursor = 0;
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

    outputCanvas = document.createElement('canvas');
    outputCanvas.width = w; outputCanvas.height = h;
    outputCtx = outputCanvas.getContext('2d');
    outputStream = outputCanvas.captureStream(30);

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

      // Track when first frame enters the buffer
      if (!bufferStartTime && frameBufCount > 0) {
        bufferStartTime = now;
      }

      try {
        stagingCtx.drawImage(captureVideoEl, 0, 0, stagingCanvas.width, stagingCanvas.height);
      } catch (e) {
        console.error('[floating-window] drawImage failed:', e.message);
        captureRafId = requestAnimationFrame(tick);
        return;
      }

      // Heartbeat every 2s to confirm RAF loop is alive
      if (tickCount === 1 || tickCount % 60 === 0) {
        console.log('[floating-window] tick #' + tickCount + ', buffer=' + frameBufCount + '/' + FRAME_BUF_MAX + ', filled=' + ai.floatingBufferFilled + ', elapsed=' + (bufferStartTime ? (now - bufferStartTime).toFixed(0) + 'ms' : 'N/A'));
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
          outputCanvas.width = newW; outputCanvas.height = newH;
          outputCtx = outputCanvas.getContext('2d');
        }
      }

      createImageBitmap(stagingCanvas, 0, 0, stagingCanvas.width, stagingCanvas.height).then(function (bmp) {
        if (!ai.floatingMode) { bmp.close(); return; }
        var t = performance.now();

        if (frameBuf[frameBufIdx] && frameBuf[frameBufIdx].bitmap) {
          frameBuf[frameBufIdx].bitmap.close();
        }
        frameBuf[frameBufIdx] = { bitmap: bmp, time: t };
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
          if (ai.floatingVideo) {
            ai.floatingVideo.srcObject = outputStream;
            ai.floatingVideo.play().then(function () {
              console.log('[floating-window] floating video playing');
            }).catch(function (e) {
              console.error('[floating-window] floating video play() rejected:', e.message);
              var sEl2 = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('audio-status') : null;
              if (sEl2) sEl2.textContent = '视频播放被阻止，请刷新页面';
            });
          }
          var sEl = ai.floatingWindow && !ai.floatingWindow.closed ? ai.floatingWindow.document.getElementById('audio-status') : null;
          if (sEl) sEl.textContent = '配音延迟 ~' + (FRAME_DELAY_MS / 1000).toFixed(0) + 's';
          // Start time-aligned subtitle & TTS playback
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

      if (ai.floatingBufferFilled && outputStream) {
        var targetTime = now - FRAME_DELAY_MS;
        var best = null, bestDiff = Infinity;
        for (var i = 0; i < frameBufCount; i++) {
          var idx = (frameBufIdx - frameBufCount + i + FRAME_BUF_MAX) % FRAME_BUF_MAX;
          var frm = frameBuf[idx];
          if (!frm || !frm.bitmap) continue;
          var diff = Math.abs(frm.time - targetTime);
          if (diff < bestDiff) { bestDiff = diff; best = frm; }
        }
        if (best && best.bitmap) {
          outputCtx.drawImage(best.bitmap, 0, 0, outputCanvas.width, outputCanvas.height);
        }
      }

      captureRafId = requestAnimationFrame(tick);
    }

    captureRafId = requestAnimationFrame(tick);
  }

  // ─── Subtitle & TTS display in floating window ──────────────────────

  var _firstSubtitle = true;
  function showFloatingSubtitle(original, translation) {
    if (!ai.floatingWindow || ai.floatingWindow.closed || !ai.floatingLoaded) return;
    if (_firstSubtitle) {
      _firstSubtitle = false;
      console.log('[floating-window] first subtitle shown: "' + (original || '').slice(0, 50) + '"');
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
    console.log('[floating-window] timeline playback loop started (cachedReplay=' + _cachedReplay + ')');
    function loop() {
      var displayVideo = ai.offlineVideo;
      if (!ai.floatingMode || !displayVideo) {
        timelineRafId = null;
        return;
      }
      var originalTime = displayVideo.currentTime;
      // In cached replay mode, entries were captured on a previous loop;
      // use currentTime directly (no buffer delay) so they sync with each replay.
      var refTime = _cachedReplay ? originalTime : (originalTime - FRAME_DELAY_MS / 1000);
      var timeline = ai.floatingTimeline;
      var cursor = ai.floatingTimelineCursor;

      // Detect forward seeks: clear stale timeline entries and reset state
      if (_lastRefTime !== undefined && refTime > _lastRefTime + 0.5) {
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
        for (var r = 0; r < timeline.length; r++) { timeline[r].played = false; }
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

      // Show subtitle when entering a new item; keep showing it through gaps
      if (currentItem) {
        _lastItemEndTime = currentItem.end;
        if (currentItem !== _lastDisplayedItem) {
          console.log('[floating-window] timeline entering [' +
            currentItem.start.toFixed(1) + '-' + currentItem.end.toFixed(1) + 's] ' +
            (currentItem.audioBase64 ? '[+audio]' : '[no audio]') +
            ': ' + JSON.stringify(currentItem.original));
          showFloatingSubtitle(currentItem.original, currentItem.translation);
          _lastDisplayedItem = currentItem;
          // Reset word tracking for new item
          if (currentItem.words && currentItem.words.length > 0) {
            currentItem._wordIdx = -2;
          }
        }
        // Play TTS as soon as audio arrives (may arrive after subtitle first shown)
        if (!currentItem.played && currentItem.audioBase64 && _audioReady) {
          console.log('[floating-window] playing TTS [' +
            currentItem.start.toFixed(1) + '-' + currentItem.end.toFixed(1) + 's]');
          currentItem.played = true;
          playFloatingTTS(currentItem.audioBase64, currentItem.audioMime || 'audio/mpeg');
        }
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
      } else if (_lastDisplayedItem && refTime > _lastItemEndTime + 3.0) {
        // Only clear subtitle after 3s of silence gap (no new item)
        showFloatingSubtitle('', '');
        _lastDisplayedItem = null;
      }

      // Periodic cleanup: trim items far behind current playback position
      if (ai.floatingTimelineCursor > 30) {
        ai.floatingTimeline.splice(0, ai.floatingTimelineCursor);
        ai.floatingTimelineCursor = 0;
      }

      timelineRafId = requestAnimationFrame(loop);
    }
    timelineRafId = requestAnimationFrame(loop);
  }

  function stopTimelineLoop() {
    if (timelineRafId) {
      cancelAnimationFrame(timelineRafId);
      timelineRafId = null;
    }
    _lastDisplayedItem = null;
    _lastItemEndTime = 0;
    _lastRefTime = undefined;
  }

  function playFloatingTTS(base64, mimeType) {
    if (!ai.floatingWindow || ai.floatingWindow.closed || !ai.floatingLoaded) return;
    if (!_audioReady) {
      var sEl = ai.floatingWindow.document.getElementById('audio-status');
      if (sEl) sEl.textContent = '点击浮窗任意位置启用配音';
      return;
    }
    var s = ai.settings || {};
    var url = 'data:' + (mimeType || 'audio/mpeg') + ';base64,' + base64;
    ai.floatingTtsQueue.push({ url: url, volume: (s.ttsVolume || 100) / 100 });
    if (!ai.floatingTtsPlaying) playNextFloatingTTS();
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
      try { a.pause(); a.src = ''; } catch (_) {}
    }
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

  var _floatingEnded = false;
  var _loopLastTime = -1;
  var _loopTimeHandler = null;
  var _cachedReplay = false;

  function onFloatingVideoEnded() {
    if (!ai.floatingMode) return;
    if (_floatingEnded) return;
    if (ai.ws && ai.ws.readyState === WebSocket.OPEN) {
      ai.sendWS({ type: 'stop' });
    }
    _floatingEnded = true;
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

    if (!openFloatingWindow(video)) {
      ai.floatingMode = false;
      ai.offlineMode = false;
      ai.offlineVideo = null;
      ai.floatingFallback = false;
      ai.floatingTimeline = [];
      ai.startASRMode();
      return;
    }

    // Helper: set up loop detection and close watch for captureVideo
    function attachWatchers(cv) {
      cv.addEventListener('ended', function () {
        onFloatingVideoEnded();
      }, { once: true });

      _loopLastTime = -1;
      _cachedReplay = false;
      _loopTimeHandler = function () {
        if (!ai.floatingMode) {
          cv.removeEventListener('timeupdate', _loopTimeHandler);
          _loopTimeHandler = null;
          return;
        }
        var t = cv.currentTime;
        if (_loopLastTime >= 0 && t < _loopLastTime - 0.5) {
          console.log('[floating-window] loop detected at t=' + t.toFixed(1) + ', prev=' + _loopLastTime.toFixed(1));
          if (!_cachedReplay) {
            ai.stopAudioCapture();
            _cachedReplay = true;
            _lastRefTime = undefined;
            console.log('[floating-window] switched to replay mode');
          }
          ai.floatingTimelineCursor = 0;
          _lastDisplayedItem = null;
          for (var i = 0; i < ai.floatingTimeline.length; i++) {
            ai.floatingTimeline[i].played = false;
          }
        }
        _loopLastTime = t;
      };
      cv.addEventListener('timeupdate', _loopTimeHandler);

      _windowCloseCheckId = setInterval(function () {
        if (ai.floatingWindow && ai.floatingWindow.closed) {
          clearInterval(_windowCloseCheckId);
          _windowCloseCheckId = null;
          if (cv.ended) onFloatingVideoEnded();
          closeFloatingWindow();
        }
      }, 1000);
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
