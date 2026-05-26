// page-translate.js — Page-level DOM translation via Go backend
(function () {
  'use strict';


  if (window.__ai_page_translate_loaded__) return;
  window.__ai_page_translate_loaded__ = true;

  // ─── CSS injection ────────────────────────────────────────────────────
  if (!document.getElementById('ot-page-style')) {
    const style = document.createElement('style');
    style.id = 'ot-page-style';
    style.textContent = '@keyframes ot-spin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(style);
  }

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
    'presentation', 'none',
  ]);

  const CONCURRENCY = 4;
  const BATCH_SIZE = 30;
  const CHAR_LIMIT = 1500;
  const MAX_RETRIES = 3;
  const MAX_CACHE = 10000;
  const API = 'http://localhost:29527/translate/page';
  const host = location.hostname;

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
  let dbReady = false;
  let snapshotDirty = false;
  let snapshotTimer = null;
  let pausedByVideo = false;
  let _pageIsJapanese = undefined;

  let targetLang = 'zh-Hans';
  let engine = 'microsoft';
  let sourceLang = 'auto';
  let ollamaUrl = 'http://localhost:11434';
  let ollamaModel = 'qwen2.5:7b';

  const memCache = new Map();
  const idleCB = window.requestIdleCallback || function (cb, opts) { return setTimeout(cb, (opts && opts.timeout) || 100); };

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

  // ─── IndexedDB ──────────────────────────────────────────────────────
  const DB_NAME = 'OtTranslateDB';
  const DB_VERSION = 2;
  const STORE = 'phrases';
  const SNAP_STORE = 'snapshots';
  const MAX_DB_ENTRIES = 50000;
  const MAX_SNAPSHOTS = 100;

  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (e.oldVersion < 1 && !db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('host', 'host', { unique: false });
          store.createIndex('hits', 'hits', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (e.oldVersion < 2 && !db.objectStoreNames.contains(SNAP_STORE)) {
          var snapStore = db.createObjectStore(SNAP_STORE, { keyPath: 'url' });
          snapStore.createIndex('host', 'host', { unique: false });
          snapStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function makeKey(h, src) {
    return h + '::' + src;
  }

  async function dbLookup(h, srcs) {
    try {
      var db = await openDB();
      var result = new Map();
      var tx = db.transaction(STORE, 'readonly');
      var store = tx.objectStore(STORE);
      await Promise.all(srcs.map(function (src) {
        return new Promise(function (resolve) {
          var r = store.get(makeKey(h, src));
          r.onsuccess = function (e) { var row = e.target.result; if (row && row.dst) result.set(src, row.dst); resolve(); };
          r.onerror = function () { resolve(); };
        });
      }));
      return result;
    } catch (_) { return new Map(); }
  }

  async function dbSave(h, pairs) {
    if (!pairs.length) return;
    try {
      var db = await openDB();
      var tx = db.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      var now = Date.now();
      for (var i = 0; i < pairs.length; i++) {
        var src = pairs[i].src, dst = pairs[i].dst;
        if (!src || !dst) continue;
        var key = makeKey(h, src);
        var existing = await new Promise(function (resolve) {
          var r = store.get(key);
          r.onsuccess = function (e) { resolve(e.target.result); };
          r.onerror = function () { resolve(null); };
        });
        store.put({
          key: key, host: h, src: src, dst: dst,
          hits: (existing && existing.hits || 0) + 1,
          updatedAt: now,
        });
      }
    } catch (_) {}
  }

  function dbPrune() {
    openDB().then(function (db) {
      var tx = db.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      var countReq = store.count();
      countReq.onsuccess = function (e) {
        var count = e.target.result;
        if (count <= MAX_DB_ENTRIES) return;
        var allReq = store.getAll();
        allReq.onsuccess = function (e2) {
          var all = e2.target.result;
          all.sort(function (a, b) { return a.hits - b.hits || a.updatedAt - b.updatedAt; });
          var toDelete = all.slice(0, Math.floor(count * 0.1));
          for (var i = 0; i < toDelete.length; i++) store.delete(toDelete[i].key);
        };
      };
    }).catch(function () {});
  }

  // ─── Page Snapshots ─────────────────────────────────────────────────
  async function dbSavePageSnapshot(h, url, pairs) {
    if (!pairs.length) return;
    try {
      var db = await openDB();
      var tx = db.transaction(SNAP_STORE, 'readwrite');
      var store = tx.objectStore(SNAP_STORE);
      var capped = pairs.slice(0, 500);
      store.put({ url: url, host: h, pairs: capped, count: capped.length, updatedAt: Date.now() });
      var total = await new Promise(function (r) { var q = store.count(); q.onsuccess = function (e) { r(e.target.result); }; });
      if (total > MAX_SNAPSHOTS) {
        var all = await new Promise(function (r) { var q = store.getAll(); q.onsuccess = function (e) { r(e.target.result); }; });
        all.sort(function (a, b) { return a.updatedAt - b.updatedAt; });
        for (var i = 0; i < total - MAX_SNAPSHOTS; i++) store.delete(all[i].url);
      }
    } catch (_) {}
  }

  async function dbLoadPageSnapshot(url) {
    try {
      var db = await openDB();
      var tx = db.transaction(SNAP_STORE, 'readonly');
      var store = tx.objectStore(SNAP_STORE);
      return new Promise(function (resolve) {
        var req = store.get(url);
        req.onsuccess = function (e) { resolve((e.target.result && e.target.result.pairs) || []); };
        req.onerror = function () { resolve([]); };
      });
    } catch (_) { return []; }
  }

  async function dbExportDomain(h) {
    try {
      var db = await openDB();
      var tx = db.transaction(STORE, 'readonly');
      var idx = tx.objectStore(STORE).index('host');
      return new Promise(function (resolve) {
        var req = idx.getAll(IDBKeyRange.only(h));
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function () { resolve([]); };
      });
    } catch (_) { return []; }
  }

  async function warmupCache() {
    try {
      // 1. Load page snapshot (instant restore for revisit)
      var snapPairs = await dbLoadPageSnapshot(location.href);
      if (snapPairs.length > 0) {
        snapPairs.forEach(function (r) { if (r.src && r.dst) cacheSet(r.src, r.dst); });
      }
      // 2. Load domain phrases (cross-page reuse)
      var rows = await dbExportDomain(host);
      rows.sort(function (a, b) { return b.hits - a.hits; });
      rows.forEach(function (r) { if (r.src && r.dst && !memCache.has(r.src)) cacheSet(r.src, r.dst); });
    } catch (_) {}
    dbReady = true;
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // NOTE: 不检查 opacity — 元素可能正在 fade-in 动画中 (opacity 0→1)，
    // 此时已有完整 DOM 内容，应当翻译。CSS transition 不会触发 mutation，
    // 等动画结束再扫会永久错过 (Ozon Vue Portal 下拉菜单根因)。
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function shouldSkipEl(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id && (el.id.startsWith('__ai_') || el.id === 'ai-video-lock-overlay')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    if (el.hasAttribute('data-ot-translated')) return true;
    if (el._otTranslated) return true;
    if (el.isContentEditable) return true;
    var role = el.getAttribute('role');
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
    if (!text) return false;
    var meaningful = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (meaningful.length === 0) return false;

    // Two-layer Japanese exclusion for zh targets:
    // L1: text has kana → must be Japanese, do NOT skip
    // L2: entire page is Japanese → even pure-kanji text should NOT be skipped
    if (targetLang === 'zh' || targetLang === 'zh-Hans' || targetLang === 'zh-Hant') {
      if (/[぀-ゟ゠-ヿ]/.test(meaningful)) return false;
      if (isJapanesePage()) return false;
    }

    var pattern;
    if (targetLang === 'zh' || targetLang === 'zh-Hans' || targetLang === 'zh-Hant' || targetLang === 'ja') {
      pattern = targetLang === 'ja'
        ? /[一-鿿㐀-䶿぀-ゟ゠-ヿ]/g
        : /[一-鿿㐀-䶿]/g;
    } else if (targetLang === 'ko') {
      pattern = /[가-힯ᄀ-ᇿ]/g;
    } else if (targetLang === 'ru') {
      pattern = /[Ѐ-ӿԀ-ԯ]/g;
    } else if (targetLang === 'ar') {
      pattern = /[؀-ۿݐ-ݿ]/g;
    } else if (targetLang === 'th') {
      pattern = /[฀-๿]/g;
    } else {
      var letters = (meaningful.match(/[a-zA-Z]/g) || []).length;
      return letters / meaningful.length > 0.8;
    }

    var matches = meaningful.match(pattern);
    var count = matches ? matches.length : 0;
    return count / meaningful.length >= 0.5;
  }

  function isJapanesePage() {
    if (_pageIsJapanese !== undefined) return _pageIsJapanese;
    var pageLang = (document.documentElement.lang || '').toLowerCase();
    if (pageLang.indexOf('ja') === 0) { _pageIsJapanese = true; return true; }
    try {
      var sample = (document.body && document.body.innerText || '').slice(0, 3000);
      _pageIsJapanese = /[぀-ゟ゠-ヿ]{3,}/.test(sample);
    } catch (_) { _pageIsJapanese = false; }
    return _pageIsJapanese;
  }

  var debugLeafLog = 0;
  function isTranslatableLeaf(el) {
    // Prevent re-scanning already-queued elements
    if (el._otDone) return false;

    if (!isVisible(el)) {
      return false;
    }

    // Collect direct text (excluding deeply nested block elements)
    var text = '', hasBlockChild = false, interactiveChildren = 0;
    for (var ci = 0; ci < el.childNodes.length; ci++) {
      var child = el.childNodes[ci];
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'A' || child.tagName === 'BUTTON') {
          interactiveChildren++;
          text += child.textContent;
        } else if (INLINE_TAGS.has(child.tagName)) {
          text += child.textContent;
        } else if (!SKIP_TAGS.has(child.tagName)) {
          hasBlockChild = true;
        }
      }
    }
    text = text.trim();
    if (text.length < 2) {
      return false;
    }

    // 多个 <a>/<button> 兄弟 → 该容器是导航/菜单组，不能整体当 leaf 翻译
    // (textContent=translation 会摧毁所有链接结构、href 和事件绑定，
    //  Ozon 下拉菜单 vue-portal-target 就栽在这里 — 翻译完点不开)
    if (interactiveChildren >= 2) {
      return false;
    }

    // Pure numeric / emoji / symbols
    var stripped = text.replace(/[\s\d\p{P}\p{S}]+/gu, '');
    if (stripped.length < 1) {
      return false;
    }

    // Skip if text is already in target language
    if (isTargetLanguage(stripped)) {
      return false;
    }

    // Mark mixed-content elements (text + block children like images/icons)
    // so safeReplace knows to preserve non-text children
    if (hasBlockChild) {
      el._otMixed = true;
      el._otDirectText = text;
    }

    return true;
  }

  // ─── Scan DOM ────────────────────────────────────────────────────────
  var scanVisited = 0, scanSkipped = 0, scanLeaf = 0, scanRecurse = 0;
  function scanDOM(root, _inHidden) {
    if (!root || !root.tagName) return;
    if (shouldSkipEl(root)) { scanVisited++; scanSkipped++; return; }
    if (isSubtreeSkippable(root)) { scanVisited++; scanSkipped++; return; }

    scanVisited++;
    if (isTranslatableLeaf(root)) {
      scanLeaf++;
      root._otDone = true;
      enqueue(root);
      // Even if it's a leaf, it might have a shadowRoot
    }

    // Shadow DOM support
    if (root.shadowRoot) {
      scanDOM(root.shadowRoot, _inHidden);
    }

    var children = root.children;
    if (!children || children.length === 0) return;
    scanRecurse++;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (!child.tagName) continue;
      if (shouldSkipEl(child) || isSubtreeSkippable(child)) { scanVisited++; scanSkipped++; continue; }
      scanVisited++;
      if (isTranslatableLeaf(child)) {
        scanLeaf++;
        child._otDone = true;
        enqueue(child);
      }
      // Always recurse into children unless skippable, to ensure we find all nested text
      if (child.children && child.children.length > 0) {
        scanRecurse++;
        scanDOM(child, _inHidden);
      } else if (child.shadowRoot) {
        scanDOM(child.shadowRoot, _inHidden);
      }
    }
  }

  function enqueue(el) {
    if (el._otQueued) return;
    el._otQueued = true;
    el._otRetries = 0;

    var rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
      viewQ.push(el);
    } else {
      bgQ.push(el);
    }
    pendingCount++;
  }

  // ─── Pump ────────────────────────────────────────────────────────────
  function startPump() {
    pump();
    var id = setInterval(function () {
      if (!isActive) { clearInterval(id); return; }
      if (!pausedByVideo && !document.hidden) pump();
    }, 150);
    // Idle pre-translation: process bgQ during browser idle time
    (function scheduleIdle() {
      if (!isActive || pausedByVideo || document.hidden) return;
      idleCB(function () {
        if (bgQ.length > 0 && activeRequests < CONCURRENCY + 2) pump();
        scheduleIdle();
      }, { timeout: 2000 });
    })();
  }

  function pump() {
    if (!isActive || pausedByVideo || pumping || document.hidden) return;
    pumping = true;
    try {
      var hasViewQ = viewQ.length > 0;
      var maxConcurrency = hasViewQ ? CONCURRENCY : CONCURRENCY + 2;
      while (activeRequests < maxConcurrency) {
        var q = hasViewQ ? viewQ : bgQ;
        if (q.length === 0) break;
        var batch = takeBatch(q, BATCH_SIZE);
        if (batch.length === 0) break;
        activeRequests++;
        translateBatch(batch).finally(function () { activeRequests--; });
      }
      // All queues drained: flush snapshot for next visit
      if (viewQ.length === 0 && bgQ.length === 0 && activeRequests === 0 && snapshotDirty) {
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(saveSnapshot, 3000);
      }
    } finally {
      pumping = false;
    }
  }

  function takeBatch(q, maxCount) {
    var batch = [], chars = 0;
    while (q.length > 0 && batch.length < maxCount && chars < CHAR_LIMIT) {
      var el = q[0];
      if (!el.isConnected || el._otTranslated) { q.shift(); continue; }
      q.shift();
      batch.push(el);
      chars += (el.textContent || '').length;
    }
    return batch;
  }

  // ─── Translate ───────────────────────────────────────────────────────
  async function translateBatch(leaves) {
    // Filter dead / already-translated nodes
    var valid = [];
    for (var i = 0; i < leaves.length; i++) {
      if (leaves[i].isConnected && !leaves[i]._otTranslated) valid.push(leaves[i]);
    }
    if (!valid.length) return;

    // ── L0: local dictionary ────────────────────────────────────────────
    var dict = window.__ai_dict;
    var texts = valid.map(function (el) { return (el.textContent || '').trim(); });
    var needModel = [];
    for (var j = 0; j < valid.length; j++) {
      var key = texts[j].toLowerCase();
      // Check dictionary first (sub-ms, no network)
      var dictHit = dict && dict.localTranslate(texts[j]);
      if (dictHit) {
        var pp = dict.postProcess(dictHit);
        cacheSet(key, pp);
        applyTranslation(valid[j], pp);
        continue;
      }
      // ── L1: memory cache ──────────────────────────────────────────────
      var hit = cacheGet(key);
      if (hit !== undefined) {
        applyTranslation(valid[j], hit);
      } else {
        needModel.push(valid[j]);
      }
    }
    if (!needModel.length) return;

    // ── L2: IndexedDB domain phrases ──────────────────────────────────
    var needTexts = needModel.map(function (el) { return (el.textContent || '').trim(); });
    var uniqueTexts = [];
    var seenTexts = {};
    for (var ui = 0; ui < needTexts.length; ui++) {
      if (!seenTexts[needTexts[ui]]) { seenTexts[needTexts[ui]] = true; uniqueTexts.push(needTexts[ui]); }
    }
    if (dbReady) {
      var dbHits = await dbLookup(host, uniqueTexts);
      if (dbHits.size > 0) {
        var stillNeed = [];
        for (var k = 0; k < needModel.length; k++) {
          var t = needTexts[k];
          if (dbHits.has(t)) {
            var dst = dbHits.get(t);
            cacheSet(t.toLowerCase(), dst);
            applyTranslation(needModel[k], dst);
          } else {
            stillNeed.push(needModel[k]);
          }
        }
        needModel = stillNeed;
        needTexts = needModel.map(function (el) { return (el.textContent || '').trim(); });
      }
    }
    if (!needModel.length) return;

    // ── L3: translation API ───────────────────────────────────────────
    needModel.forEach(function (el) { addSpinner(el); });

    var results;
    try {
      results = await fetchTranslationBatch(needTexts);
    } catch (_) {
      results = new Array(needTexts.length).fill('');
    }

    needModel.forEach(function (el) { removeSpinner(el); });

    if (!results || !Array.isArray(results)) {
      needModel.forEach(function (el) { requeueOrGiveUp(el); });
      return;
    }

    var toSave = [];
    for (var mi = 0; mi < needModel.length; mi++) {
      var el = needModel[mi];
      var translation = results[mi] || '';
      var src = needTexts[mi];
      if (!translation) { requeueOrGiveUp(el); continue; }
      cacheSet(src.toLowerCase(), translation);
      toSave.push({ src: src, dst: translation });
      applyTranslation(el, translation);
    }

    if (toSave.length > 0) {
      dbSave(host, toSave).catch(function () {});
      snapshotDirty = true;
      if (Math.random() < 0.02) dbPrune();
    }
  }

  async function fetchTranslationBatch(texts) {
    // Google Translate goes through the browser so it respects the system proxy.
    // Microsoft and Ollama go through the Go backend.
    if (engine === 'google') {
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({
          type: 'PAGE_GOOGLE_TRANSLATE',
          texts: texts, from: sourceLang, to: targetLang,
        }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            resolve(new Array(texts.length).fill(''));
            return;
          }
          resolve(resp.results || new Array(texts.length).fill(''));
        });
      });
    }

    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        type: 'PAGE_FETCH_TRANSLATION',
        url: API,
        body: {
          texts: texts, from: sourceLang, to: targetLang,
          engine: engine, ollamaUrl: ollamaUrl, ollamaModel: ollamaModel,
        },
      }, function (resp) {
        if (chrome.runtime.lastError) {
          resolve(new Array(texts.length).fill(''));
          return;
        }
        if (!resp || !resp.ok) {
          resolve(new Array(texts.length).fill(''));
          return;
        }
        resolve(resp.results || new Array(texts.length).fill(''));
      });
    });
  }

  function requeueOrGiveUp(el) {
    removeSpinner(el);
    el._otRetries = (el._otRetries || 0) + 1;
    if (el._otRetries >= MAX_RETRIES) {
      el._otDone = false;
      el._otQueued = false;
      pendingCount--;
      return;
    }
    viewQ.push(el);
  }

  // ─── Spinner ─────────────────────────────────────────────────────────
  function addSpinner(el) {
    if (el.querySelector && el.querySelector('.ot-sp')) return;
    var s = document.createElement('span');
    s.className = 'ot-sp';
    s.style.cssText = 'display:inline-block;width:9px;height:9px;margin-left:3px;'
      + 'border:2px solid #fce7f3;border-top-color:#e83e8c;border-radius:50%;'
      + 'animation:ot-spin .6s linear infinite;vertical-align:middle;flex-shrink:0';
    el.appendChild(s);
  }

  function removeSpinner(el) {
    if (el.querySelector) {
      var s = el.querySelector('.ot-sp');
      if (s) s.remove();
    }
  }

  // ─── Apply Translation ──────────────────────────────────────────────
  function applyTranslation(el, translation) {
    if (!el.isConnected || el._otTranslated) return;
    el.setAttribute('data-ot-translated', '');
    el.setAttribute('data-ot-original', el._otDirectText || el.textContent.trim());
    el.setAttribute('data-ot-translation', translation);
    el._otTranslated = true;
    pendingCount--;
    translatedCount++;
    safeReplace(el, translation);
  }

  function safeReplace(el, translation) {
    var original = el.getAttribute('data-ot-original') || el.textContent.trim();

    // Mixed-content elements (text + block children like img/svg):
    // only replace text portions, preserve non-text children in place.
    if (el._otMixed) {
      // Collect block-level children to preserve (img, svg, etc.)
      var preserved = [];
      for (var ci = 0; ci < el.childNodes.length; ci++) {
        var c = el.childNodes[ci];
        if (c.nodeType === Node.ELEMENT_NODE && !INLINE_TAGS.has(c.tagName) && !SKIP_TAGS.has(c.tagName)) {
          preserved.push(c);
        }
      }

      if (!bilingualMode) {
        // Replace text content of first text-bearing node, clear others
        var found = false;
        for (var ci2 = 0; ci2 < el.childNodes.length; ci2++) {
          var c2 = el.childNodes[ci2];
          if (c2.nodeType === Node.TEXT_NODE) {
            if (!found) { c2.textContent = translation; found = true; }
            else { c2.textContent = ''; }
          } else if (c2.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(c2.tagName)) {
            if (!found) { c2.textContent = translation; found = true; }
            else { c2.textContent = ''; }
          }
        }
        if (!found) {
          el.insertBefore(document.createTextNode(translation), el.firstChild);
        }
        return;
      }

      // Bilingual mode for mixed elements
      el.textContent = '';
      var frag = document.createDocumentFragment();
      var origSpan = document.createElement('span');
      origSpan.className = 'ot-orig';
      origSpan.textContent = original;
      var transSpan = document.createElement('span');
      transSpan.className = 'ot-trans';
      transSpan.textContent = translation;
      var wrap = document.createElement('span');
      wrap.className = 'ot-bi-wrap';
      wrap.appendChild(transSpan);
      wrap.appendChild(origSpan);
      frag.appendChild(wrap);
      el.appendChild(frag);
      for (var pi = 0; pi < preserved.length; pi++) {
        el.appendChild(preserved[pi]);
      }
      return;
    }

    if (!bilingualMode) {
      el.textContent = translation;
      return;
    }

    // Build bilingual DOM: .ot-orig + .ot-trans inside .ot-bi-wrap
    var frag = document.createDocumentFragment();
    var origSpan = document.createElement('span');
    origSpan.className = 'ot-orig';
    origSpan.textContent = original;

    var transSpan = document.createElement('span');
    transSpan.className = 'ot-trans';
    transSpan.textContent = translation;

    var wrap = document.createElement('span');
    wrap.className = 'ot-bi-wrap';
    wrap.appendChild(transSpan);
    wrap.appendChild(origSpan);

    frag.appendChild(wrap);

    // Preserve any non-text children (images, etc.)
    var nonTextChildren = [];
    for (var ci = 0; ci < el.childNodes.length; ci++) {
      var child = el.childNodes[ci];
      if (child.nodeType === Node.ELEMENT_NODE && !INLINE_TAGS.has(child.tagName)) {
        nonTextChildren.push(child);
      }
    }

    el.textContent = '';
    el.appendChild(frag);
    for (var ni = 0; ni < nonTextChildren.length; ni++) {
      el.appendChild(nonTextChildren[ni]);
    }
  }

  // ─── Bilingual toggle ───────────────────────────────────────────────
  function refreshBilingualRender() {
    var nodes = document.querySelectorAll('[data-ot-translated]');
    nodes.forEach(function (el) {
      var original = el.getAttribute('data-ot-original');
      var translation = el.getAttribute('data-ot-translation');
      if (!original || !translation) return;

      // Remove existing bilingual wraps
      var wraps = el.querySelectorAll('.ot-bi-wrap');
      wraps.forEach(function (w) { w.remove(); });

      if (!bilingualMode) {
        el.textContent = translation;
      } else {
        el.textContent = '';
        var origSpan = document.createElement('span');
        origSpan.className = 'ot-orig';
        origSpan.textContent = original;

        var transSpan = document.createElement('span');
        transSpan.className = 'ot-trans';
        transSpan.textContent = translation;

        var wrap = document.createElement('span');
        wrap.className = 'ot-bi-wrap';
        wrap.appendChild(transSpan);
        wrap.appendChild(origSpan);

        el.appendChild(wrap);
      }
    });
  }

  // ─── Snapshot save ──────────────────────────────────────────────────
  async function saveSnapshot() {
    if (!snapshotDirty || translatedCount === 0) return;
    snapshotDirty = false;
    var pairs = [];
    document.querySelectorAll('[data-ot-translated]').forEach(function (el) {
      var src = el.getAttribute('data-ot-original');
      var dst = el.getAttribute('data-ot-translation');
      if (src && dst) pairs.push({ src: src, dst: dst });
    });
    if (pairs.length > 0) {
      try { await dbSavePageSnapshot(host, location.href, pairs); } catch (_) {}
    }
  }

  // ─── IntersectionObserver — 兜底：节点真正可见时再扫一次 ─────────────
  // 用途：DOM 已插入但 isVisible=false (display:none / 0×0 / 折叠容器)，
  //       当节点进入视口或尺寸变非零时强制重扫。覆盖 portal / 折叠菜单 / lazy DOM。
  var visibilityObserver = null;
  function ensureVisibilityObserver() {
    if (visibilityObserver || typeof IntersectionObserver === 'undefined') return visibilityObserver;
    visibilityObserver = new IntersectionObserver(function (entries) {
      if (!isActive) return;
      for (var i = 0; i < entries.length; i++) {
        var ent = entries[i];
        if (ent.isIntersecting && ent.target) {
          var t = ent.target;
          visibilityObserver.unobserve(t);
          if (t._otVisWatch) t._otVisWatch = false;
          // 节点已在视口内，清掉 _otDone 标记给子树一次重扫机会
          // (旧 scan 可能因 isVisible=false 提前 return，子节点根本没遍历到)
          scanDOM(t);
        }
      }
    }, { root: null, threshold: 0.01 });
    return visibilityObserver;
  }

  function watchVisibility(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node._otVisWatch) return;
    var io = ensureVisibilityObserver();
    if (!io) return;
    node._otVisWatch = true;
    try { io.observe(node); } catch (_) {}
  }

  // ─── MutationObserver ───────────────────────────────────────────────
  function watchMutations() {
    var pendingMutations = [];
    observer = new MutationObserver(function (mutations) {
      if (!isActive) return;
      for (var mi = 0; mi < mutations.length; mi++) {
        pendingMutations.push(mutations[mi]);
      }
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(function () {
        if (!isActive || document.hidden) return;
        var batch = pendingMutations;
        pendingMutations = [];
        var visAttrs = new Set(['style', 'class', 'hidden', 'aria-hidden']);
        for (var i = 0; i < batch.length; i++) {
          var m = batch[i];
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var node = m.addedNodes[j];
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              scanDOM(node);
              // 兜底：节点可能此刻还隐藏 (动画/折叠/portal target 空壳)，
              // 注册 IntersectionObserver，等真正进入视口再扫一次。
              if (!node._otDone) watchVisibility(node);
            }
          } else if (m.type === 'attributes' && visAttrs.has(m.attributeName)) {
            if (m.target.nodeType === Node.ELEMENT_NODE && isVisible(m.target)) {
              // When a container becomes visible, scan it and its children
              scanDOM(m.target);
            }
          }
        }
      }, 150);
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
      if (!isActive || scrollTicking || document.hidden) return;
      scrollTicking = true;
      requestAnimationFrame(function () {
        var promoted = [], remaining = [];
        for (var i = 0; i < bgQ.length; i++) {
          var el = bgQ[i];
          if (!el.isConnected) { pendingCount--; continue; }
          var rect = el.getBoundingClientRect();
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
    scanDOM(document.body);
    startPump();
    watchMutations();
    watchScroll();
  }

  function stop() {
    isActive = false;
    pumping = false;
    if (pumpTimer) clearTimeout(pumpTimer);
    if (mutationTimer) clearTimeout(mutationTimer);
    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (observer) { observer.disconnect(); observer = null; }
    if (visibilityObserver) { visibilityObserver.disconnect(); visibilityObserver = null; }
    viewQ = [];
    bgQ = [];
    pendingCount = 0;
    activeRequests = 0;
  }

  function updateSettings(settings) {
    var langChanged = settings.targetLang !== undefined && settings.targetLang !== targetLang;
    if (langChanged) clearPageCache();
    if (settings.targetLang !== undefined) targetLang = settings.targetLang;
    if (settings.engine !== undefined) engine = settings.engine;
    if (settings.sourceLang !== undefined) sourceLang = settings.sourceLang;
    if (settings.ollamaUrl !== undefined) ollamaUrl = settings.ollamaUrl;
    if (settings.ollamaModel !== undefined) ollamaModel = settings.ollamaModel;
    if (langChanged && isActive) {
      stop();
      start();
    }
  }

  function clearPageCache() {
    memCache.clear();
    openDB().then(function (db) {
      var tx = db.transaction([SNAP_STORE, STORE], 'readwrite');
      tx.objectStore(SNAP_STORE).clear();
      tx.objectStore(STORE).clear();
    }).catch(function () {});
  }

  function setBilingual(enabled) {
    bilingualMode = enabled;
    refreshBilingualRender();
  }

  // ─── Video translation coordination ─────────────────────────────────
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== '__ai_video_translate__') return;
    if (e.data.type === 'video_started') {
      if (isActive) pauseForVideo();
    } else if (e.data.type === 'video_stopped') {
      if (pausedByVideo) resumeFromVideo();
    }
  });

  function showToast(msg) {
    var toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(30,27,46,0.95);color:#e5e7eb;font-size:13px;font-family:-apple-system,"Microsoft YaHei","PingFang SC",sans-serif;white-space:nowrap;padding:10px 20px;border-radius:10px;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,0.35);pointer-events:none;opacity:0;transition:opacity 0.3s;';
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.style.opacity = '1'; });
    setTimeout(function () {
      toast.style.opacity = '0';
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 2500);
  }

  function pauseForVideo() {
    pausedByVideo = true;
    pumping = false;
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    viewQ = [];
    bgQ = [];
    pendingCount = 0;
    activeRequests = 0;
    showToast('视频翻译进行中，页面翻译已暂停');
  }

  function resumeFromVideo() {
    pausedByVideo = false;
    scanDOM(document.body);
    startPump();
    showToast('视频翻译已结束，页面翻译已恢复');
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
    if (result.pageGlobalEnabled !== false) {
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

          // Fire-and-forget: warm IndexedDB cache in background, start translation immediately
          warmupCache();
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
