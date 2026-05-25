// page-translate.js — Page-level DOM translation via Go backend
(function () {
  'use strict';

  console.log('[page-translate] script loaded');

  if (window.__ai_page_translate_loaded__) return;
  window.__ai_page_translate_loaded__ = true;

  // ─── Constants ──────────────────────────────────────────────────────
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS',
    'TEXTAREA', 'INPUT', 'TEMPLATE', 'OBJECT', 'EMBED',
    'APPLET', 'MAP', 'AREA', 'MATH', 'VIDEO', 'AUDIO', 'LINK', 'META', 'BR',
    'HR', 'WBR', 'HEAD', 'TITLE',
  ]);

  const INLINE_TAGS = new Set([
    'SPAN', 'B', 'I', 'U', 'EM', 'STRONG', 'SMALL', 'MARK', 'SUB', 'SUP',
    'A', 'ABBR', 'CITE', 'CODE', 'DEL', 'DFN', 'INS', 'KBD', 'Q', 'S', 'SAMP',
    'TIME', 'VAR', 'LABEL', 'FONT',
  ]);

  const SKIP_ROLES = new Set([
    'menu', 'menubar', 'listbox', 'tablist', 'toolbar', 'presentation', 'none',
  ]);

  const CONCURRENCY = 4;
  const BATCH_SIZE = 30;
  const CHAR_LIMIT = 1500;
  const MAX_RETRIES = 3;
  const MAX_CACHE = 5000;
  const API = 'http://localhost:29527/translate/page';

  // ─── State ──────────────────────────────────────────────────────────
  let isActive = false;
  let bilingualMode = false;
  let viewQ = [], bgQ = [];
  let pendingCount = 0, translatedCount = 0;
  let pumping = false;
  let activeRequests = 0;
  let observer = null;
  let scrollTicking = false;
  let mutationTimer = null;
  let pumpTimer = null;

  let targetLang = 'zh-Hans';
  let engine = 'microsoft';
  let sourceLang = 'auto';
  let ollamaUrl = 'http://localhost:11434';
  let ollamaModel = 'qwen2.5:7b';

  const memCache = new Map();

  // ─── Cache helpers ──────────────────────────────────────────────────
  function cacheGet(key) {
    if (!memCache.has(key)) return undefined;
    const v = memCache.get(key);
    memCache.delete(key);
    memCache.set(key, v); // move to end (LRU)
    return v;
  }

  function cacheSet(key, value) {
    if (memCache.has(key)) memCache.delete(key);
    memCache.set(key, value);
    if (memCache.size > MAX_CACHE) {
      const first = memCache.keys().next().value;
      memCache.delete(first);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function shouldSkipEl(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    if (el.hasAttribute('data-ot-translated')) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    if (el.closest('[contenteditable="true"]')) return true;
    return false;
  }

  function isSubtreeSkippable(el) {
    if (el.hasAttribute && el.hasAttribute('data-ot-translated')) return true;
    if (el.closest && (el.closest('svg') || el.closest('math') || el.closest('[data-ot-translated]'))) return true;
    return false;
  }

  function isTargetLanguage(text) {
    const stripped = text.replace(/[\s\d\p{P}]+/gu, '');
    if (stripped.length === 0) return false;

    const t = targetLang;
    let re;
    if (t === 'zh' || t === 'zh-Hans' || t === 'zh-Hant') {
      re = /\p{Script=Han}/u;
    } else if (t === 'ja') {
      re = /[぀-ゟ゠-ヿ\p{Script=Han}]/u;
    } else if (t === 'ko') {
      re = /[가-힯]/u;
    } else if (t === 'th') {
      re = /[฀-๿]/u;
    } else if (t === 'ru') {
      re = /\p{Script=Cyrillic}/u;
    } else {
      const letters = (stripped.match(/[a-zA-Z]/g) || []).length;
      return letters / stripped.length > 0.8;
    }

    const matching = (stripped.match(new RegExp(re.source, 'gu')) || []).length;
    return matching / stripped.length > 0.5;
  }

  let debugLeafLog = 0;
  function isTranslatableLeaf(el) {
    if (!isVisible(el)) {
      if (debugLeafLog++ < 10) console.log('[page-translate] leaf rejected: <' + el.tagName + '> not visible, text=' + JSON.stringify((el.textContent || '').trim().slice(0, 50)));
      return false;
    }

    // Collect direct text (excluding deeply nested block elements)
    let text = '';
    let hasBlockChild = false;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (INLINE_TAGS.has(child.tagName)) {
          text += child.textContent;
        } else if (!SKIP_TAGS.has(child.tagName)) {
          hasBlockChild = true;
        }
      }
    }
    text = text.trim();
    if (text.length < 2) {
      if (debugLeafLog++ < 10) console.log('[page-translate] leaf rejected: <' + el.tagName + '> text too short, text=' + JSON.stringify(text));
      return false;
    }

    // Pure numeric / emoji / symbols
    const stripped = text.replace(/[\s\d\p{P}\p{S}]+/gu, '');
    if (stripped.length < 1) {
      if (debugLeafLog++ < 10) console.log('[page-translate] leaf rejected: <' + el.tagName + '> pure numeric/symbol, text=' + JSON.stringify(text));
      return false;
    }

    // Skip if text is already in target language
    if (isTargetLanguage(stripped)) {
      if (debugLeafLog++ < 10) console.log('[page-translate] leaf rejected: <' + el.tagName + '> is target language, text=' + JSON.stringify(text));
      return false;
    }

    // Don't translate elements that have translatable block children
    if (hasBlockChild) {
      if (debugLeafLog++ < 10) console.log('[page-translate] leaf rejected: <' + el.tagName + '> has block child, text=' + JSON.stringify(text));
      return false;
    }

    if (debugLeafLog++ < 5) console.log('[page-translate] leaf ACCEPTED: <' + el.tagName + '> text=' + JSON.stringify(text.slice(0, 60)));
    return true;
  }

  // ─── Scan DOM ────────────────────────────────────────────────────────
  let scanVisited = 0, scanSkipped = 0, scanLeaf = 0, scanRecurse = 0;
  function scanDOM(root, _inHidden) {
    if (!root || !root.tagName) return;
    if (shouldSkipEl(root)) { scanVisited++; scanSkipped++; return; }
    if (isSubtreeSkippable(root)) { scanVisited++; scanSkipped++; return; }

    scanVisited++;
    if (isTranslatableLeaf(root)) {
      scanLeaf++;
      enqueue(root);
      return;
    }

    const children = root.children;
    if (!children || children.length === 0) return;
    scanRecurse++;
    for (const child of children) {
      if (!child.tagName) continue;
      if (shouldSkipEl(child) || isSubtreeSkippable(child)) { scanVisited++; scanSkipped++; continue; }
      scanVisited++;
      if (isTranslatableLeaf(child)) {
        scanLeaf++;
        enqueue(child);
      } else if (child.children && child.children.length > 0) {
        scanRecurse++;
        scanDOM(child, _inHidden);
      }
    }
  }

  function enqueue(el) {
    if (el.hasAttribute('data-ot-queued')) return;
    el.setAttribute('data-ot-queued', '');
    el._otRetries = 0;

    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
      viewQ.push(el);
    } else {
      bgQ.push(el);
    }
    pendingCount++;
  }

  // ─── Pump ────────────────────────────────────────────────────────────
  function startPump() {
    pumping = true;
    schedulePump();
  }

  function schedulePump() {
    if (!pumping) return;
    pumpTimer = setTimeout(() => {
      pump();
      schedulePump();
    }, 150);
  }

  async function pump() {
    if (!isActive || activeRequests >= CONCURRENCY) return;

    let batch = takeBatch(viewQ, BATCH_SIZE);
    if (batch.length === 0) batch = takeBatch(bgQ, BATCH_SIZE);
    if (batch.length === 0) return;

    activeRequests++;
    console.log('[page-translate] pump: batch=' + batch.length + ' viewQ=' + viewQ.length + ' bgQ=' + bgQ.length);
    try {
      await translateBatch(batch);
    } finally {
      activeRequests--;
    }
  }

  function takeBatch(q, maxCount) {
    const batch = [];
    let chars = 0;
    while (q.length > 0 && batch.length < maxCount && chars < CHAR_LIMIT) {
      const el = q.shift();
      if (!el.isConnected) {
        pendingCount--;
        continue;
      }
      batch.push(el);
      chars += (el.textContent || '').length;
    }
    return batch;
  }

  // ─── Translate ───────────────────────────────────────────────────────
  async function translateBatch(leaves) {
    const texts = leaves.map(function (el) {
      return (el.textContent || '').trim();
    });

    const cached = [];
    const uncachedIdx = [];
    const uncachedTexts = [];

    for (let i = 0; i < texts.length; i++) {
      const key = texts[i].toLowerCase();
      const hit = cacheGet(key);
      if (hit !== undefined) {
        cached.push({ idx: i, translation: hit });
      } else {
        uncachedIdx.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    let translations = new Array(texts.length).fill('');

    if (uncachedTexts.length > 0) {
      const results = await fetchTranslationBatch(uncachedTexts);
      for (let i = 0; i < uncachedIdx.length; i++) {
        const idx = uncachedIdx[i];
        const result = results[i] || '';
        translations[idx] = result;
        if (result) cacheSet(texts[idx].toLowerCase(), result);
      }
    }

    for (const c of cached) {
      translations[c.idx] = c.translation;
    }

    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      if (!el.isConnected) continue;
      if (translations[i]) {
        applyTranslation(el, translations[i]);
      } else {
        requeueOrGiveUp(el);
      }
    }
  }

  async function fetchTranslationBatch(texts) {
    console.log('[page-translate] fetchTranslationBatch: ' + texts.length + ' texts to=' + targetLang + ' engine=' + engine);
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: texts,
          from: sourceLang,
          to: targetLang,
          engine: engine,
          ollamaUrl: ollamaUrl,
          ollamaModel: ollamaModel,
        }),
      });
      console.log('[page-translate] fetch response status=' + resp.status);
      if (!resp.ok) return new Array(texts.length).fill('');
      const data = await resp.json();
      console.log('[page-translate] fetch results:', data.results);
      return data.results || new Array(texts.length).fill('');
    } catch (e) {
      console.error('[page-translate] fetch error:', e.message || e);
      return new Array(texts.length).fill('');
    }
  }

  function requeueOrGiveUp(el) {
    el._otRetries = (el._otRetries || 0) + 1;
    if (el._otRetries >= MAX_RETRIES) {
      pendingCount--;
      return;
    }
    viewQ.push(el);
  }

  // ─── Apply Translation ──────────────────────────────────────────────
  function applyTranslation(el, translation) {
    el.setAttribute('data-ot-translated', '');
    el.setAttribute('data-ot-original', el.textContent.trim());
    el.setAttribute('data-ot-translation', translation);
    pendingCount--;
    translatedCount++;
    safeReplace(el, translation);
  }

  function safeReplace(el, translation) {
    const original = el.getAttribute('data-ot-original') || el.textContent.trim();
    if (!bilingualMode) {
      el.textContent = translation;
      return;
    }

    // Build bilingual DOM: .ot-orig + .ot-trans inside .ot-bi-wrap
    const frag = document.createDocumentFragment();
    const origSpan = document.createElement('span');
    origSpan.className = 'ot-orig';
    origSpan.textContent = original;

    const transSpan = document.createElement('span');
    transSpan.className = 'ot-trans';
    transSpan.textContent = translation;

    const wrap = document.createElement('span');
    wrap.className = 'ot-bi-wrap';
    wrap.appendChild(transSpan);
    wrap.appendChild(origSpan);

    frag.appendChild(wrap);

    // Preserve any non-text children (images, etc.)
    const nonTextChildren = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && !INLINE_TAGS.has(child.tagName)) {
        nonTextChildren.push(child);
      }
    }

    el.textContent = '';
    el.appendChild(frag);
    for (const c of nonTextChildren) {
      el.appendChild(c);
    }
  }

  // ─── Bilingual toggle ───────────────────────────────────────────────
  function refreshBilingualRender() {
    const nodes = document.querySelectorAll('[data-ot-translated]');
    nodes.forEach(function (el) {
      const original = el.getAttribute('data-ot-original');
      const translation = el.getAttribute('data-ot-translation');
      if (!original || !translation) return;

      // Remove existing bilingual wraps
      const wraps = el.querySelectorAll('.ot-bi-wrap');
      wraps.forEach(function (w) { w.remove(); });

      if (!bilingualMode) {
        el.textContent = translation;
      } else {
        el.textContent = '';
        const origSpan = document.createElement('span');
        origSpan.className = 'ot-orig';
        origSpan.textContent = original;

        const transSpan = document.createElement('span');
        transSpan.className = 'ot-trans';
        transSpan.textContent = translation;

        const wrap = document.createElement('span');
        wrap.className = 'ot-bi-wrap';
        wrap.appendChild(origSpan);
        wrap.appendChild(transSpan);

        el.appendChild(wrap);
      }
    });
  }

  // ─── MutationObserver ───────────────────────────────────────────────
  function watchMutations() {
    var pendingMutations = [];
    observer = new MutationObserver(function (mutations) {
      var addedTotal = 0;
      for (var mi = 0; mi < mutations.length; mi++) {
        addedTotal += mutations[mi].addedNodes.length;
        pendingMutations.push(mutations[mi]);
      }
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(function () {
        if (!isActive) return;
        var batch = pendingMutations;
        pendingMutations = [];
        var totalRecords = batch.length;
        console.log('[page-translate] mutation processing: ' + totalRecords + ' records');
        for (var i = 0; i < batch.length; i++) {
          var m = batch[i];
          for (var j = 0; j < m.addedNodes.length; j++) {
            var node = m.addedNodes[j];
            if (node.nodeType === Node.ELEMENT_NODE) {
              scanDOM(node);
            }
          }
          if (m.type === 'attributes' && m.attributeName === 'style') {
            if (m.target.nodeType === Node.ELEMENT_NODE && isVisible(m.target)) {
              scanDOM(m.target);
            }
          }
        }
        console.log('[page-translate] mutation scan done, pendingCount=' + pendingCount + ' visited=' + scanVisited + ' leaf=' + scanLeaf);
      }, 100);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
    });
  }

  // ─── Scroll watcher — promote bgQ to viewQ ──────────────────────────
  function watchScroll() {
    window.addEventListener('scroll', function () {
      if (!isActive || scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(function () {
        // Promote visible bgQ items to viewQ
        const promoted = [];
        const remaining = [];
        for (const el of bgQ) {
          if (!el.isConnected) {
            pendingCount--;
            continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
            promoted.push(el);
          } else {
            remaining.push(el);
          }
        }
        bgQ = remaining;
        viewQ = promoted.concat(viewQ);
        scrollTicking = false;
      });
    }, { passive: true });
  }

  // ─── Public API ──────────────────────────────────────────────────────
  function start() {
    if (isActive) return;
    isActive = true;
    console.log('[page-translate] start(), targetLang=' + targetLang + ' engine=' + engine + ' bilingual=' + bilingualMode);
    scanDOM(document.body);
    console.log('[page-translate] scanDOM done, pendingCount=' + pendingCount + ' viewQ=' + viewQ.length + ' bgQ=' + bgQ.length + ' stats={visited:' + scanVisited + ' skipped:' + scanSkipped + ' leaf:' + scanLeaf + ' recurse:' + scanRecurse + '}');
    startPump();
    watchMutations();
    watchScroll();
  }

  function stop() {
    isActive = false;
    pumping = false;
    if (pumpTimer) clearTimeout(pumpTimer);
    if (mutationTimer) clearTimeout(mutationTimer);
    if (observer) { observer.disconnect(); observer = null; }
    viewQ = [];
    bgQ = [];
    pendingCount = 0;
    activeRequests = 0;
  }

  function updateSettings(settings) {
    if (settings.targetLang !== undefined) targetLang = settings.targetLang;
    if (settings.engine !== undefined) engine = settings.engine;
    if (settings.sourceLang !== undefined) sourceLang = settings.sourceLang;
    if (settings.ollamaUrl !== undefined) ollamaUrl = settings.ollamaUrl;
    if (settings.ollamaModel !== undefined) ollamaModel = settings.ollamaModel;
  }

  function setBilingual(enabled) {
    bilingualMode = enabled;
    refreshBilingualRender();
  }

  // ─── Message handlers ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    switch (msg.type) {
      case 'PAGE_TRANSLATE_TOGGLE':
        if (msg.enabled) start();
        else stop();
        sendResponse({ success: true });
        break;

      case 'PAGE_UPDATE_BILINGUAL':
        setBilingual(!!msg.enabled);
        sendResponse({ success: true });
        break;

      case 'PAGE_UPDATE_SETTINGS':
        updateSettings(msg.settings || {});
        sendResponse({ success: true });
        break;

      case 'PAGE_GET_STATUS':
        sendResponse({
          isActive: isActive,
          translatedCount: translatedCount,
          pendingCount: pendingCount,
        });
        break;
    }
  });

  // ─── Auto-start on load ─────────────────────────────────────────────
  chrome.storage.local.get('pageGlobalEnabled', function (result) {
    console.log('[page-translate] storage read, pageGlobalEnabled:', result.pageGlobalEnabled);
    if (result.pageGlobalEnabled !== false) {
      // Also load other settings
      chrome.storage.local.get(
        ['pageBilingual', 'pageTargetLang', 'pageEngine', 'pageOllamaUrl', 'pageOllamaModel', 'pageSourceLang', 'translationSettings'],
        function (r) {
          if (r.pageBilingual !== undefined) bilingualMode = r.pageBilingual;
          else if (r.translationSettings && r.translationSettings.pageBilingual !== undefined) bilingualMode = r.translationSettings.pageBilingual;
          if (r.pageTargetLang) targetLang = r.pageTargetLang;
          if (r.pageEngine) engine = r.pageEngine;
          if (r.pageOllamaUrl) ollamaUrl = r.pageOllamaUrl;
          if (r.pageOllamaModel) ollamaModel = r.pageOllamaModel;
          if (r.pageSourceLang) sourceLang = r.pageSourceLang;

          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
          } else {
            start();
          }
        }
      );
    }
  });
})();
