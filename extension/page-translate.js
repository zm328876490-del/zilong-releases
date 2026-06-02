// page-translate.js v2 — Text-node-based page translation via Go backend
// Walks #text nodes via TreeWalker, translates each node's content,
// and replaces only textNode.textContent — never touches HTML elements.
// This approach preserves all page styles, layouts, and functionality.
(function () {
  'use strict';

  if (location.href.indexOf('chrome-extension://') === 0) return;
  if (window.__ai_page_translate_loaded__) return;
  window.__ai_page_translate_loaded__ = true;

  // ─── CSS injection ────────────────────────────────────────────────────
  if (!document.getElementById('ot-page-style')) {
    const style = document.createElement('style');
    style.id = 'ot-page-style';
    style.textContent = '';
    (document.head || document.documentElement).appendChild(style);
  }

  // ─── Constants ──────────────────────────────────────────────────────
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS',
    'TEXTAREA', 'INPUT', 'TEMPLATE', 'OBJECT', 'EMBED',
    'APPLET', 'MAP', 'AREA', 'MATH', 'VIDEO', 'AUDIO', 'LINK', 'META', 'BR',
    'HR', 'WBR', 'HEAD', 'TITLE',
  ]);

  const SKIP_ROLES = new Set([]);

  const CONCURRENCY = 6;
  const BATCH_SIZE = 10;
  const CHAR_LIMIT = 1500;
  const MAX_RETRIES = 3;
  const MAX_CACHE = 10000;
  const API = 'http://localhost:29527/translate/page';
  const host = location.hostname;

  // ─── Built-in glossary for common short UI terms ─────────────────────
  // Qwen3-1.7B often returns identity for short proper nouns / brand names.
  // These are common across Amazon and other e-commerce sites.
  const BUILT_IN_GLOSSARY = {
    'prime': 'Prime会员',
    'en': '英文',
    'best sellers': '畅销榜',
    'today\'s deals': '今日特惠',
    'buy again': '再次购买',
    'shop now': '立即购买',
    'see more': '查看更多',
    'see all': '查看全部',
    'free delivery': '免费配送',
    'free shipping': '免费配送',
    'in stock': '有货',
    'out of stock': '缺货',
    'add to cart': '加入购物车',
    'buy now': '立即购买',
    'save more': '更多优惠',
    'subscribe & save': '订阅省',
    'customer reviews': '用户评价',
    'top reviews': '热门评价',
    'your orders': '我的订单',
    'your account': '我的账户',
    'your lists': '我的清单',
    'your recommendations': '我的推荐',
    'your recently viewed items': '最近浏览',
    'back to top': '返回顶部',
    'back to results': '返回结果',
    'filter by': '筛选方式',
    'sort by': '排序方式',
    'facebook': '脸书',
    'twitter': '推特',
    'instagram': 'Instagram',
    'youtube': 'YouTube',
    'twitch': 'Twitch',
    'tiktok': 'TikTok',
    'unlimited': '无限',
    'exclusive': '独家',
    'limited time deal': '限时优惠',
    'lightning deal': '闪购',
    'coupon': '优惠券',
    'featured': '精选',
    'recommended': '推荐',
    'sponsored': '赞助',
    'bestseller': '畅销品',
    'new arrival': '新品上市',
    'top rated': '高评分',
    'most wished for': '心愿榜单',
    'gift ideas': '礼品推荐',
    'gift cards': '礼品卡',
    'top up your account': '账户充值',
    'sell on amazon': '在Amazon开店',
    'become an affiliate': '成为联盟会员',
    'fulfilment by amazon': '亚马逊物流',
    'see details': '查看详情',
    'product details': '商品详情',
    'product description': '商品描述',
    'about this item': '商品信息',
    'technical details': '技术参数',
    'compare with similar items': '对比相似商品',
  };

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
  let ollamaUrl = 'http://127.0.0.1:11434';
  let ollamaModel = '';
  let openaiUrl = 'https://api.deepseek.com/v1';
  let openaiKey = '';
  let openaiModel = 'deepseek-chat';
  let deeplKey = '';

  function toBackendEnginePage(eng) {
    return (eng === 'deepseek' || eng === 'doubao' || eng === 'qwen') ? 'openai' : eng;
  }

  const memCache = new Map();
  const idleCB = window.requestIdleCallback || function (cb, opts) { return setTimeout(cb, (opts && opts.timeout) || 100); };

  // Maps original (cleanText.toLowerCase()) → translation, for bilingual toggle
  const pageTranslationMap = new Map();
  // Accumulated {src, dst} pairs for snapshot persistence
  let translatedPairs = [];

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
        if (src.toLowerCase() === dst.toLowerCase()) continue;
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
        snapPairs.forEach(function (r) { if (r.src && r.dst && r.src.toLowerCase() !== r.dst.toLowerCase()) { cacheSet(r.src.toLowerCase(), r.dst); pageTranslationMap.set(r.src.toLowerCase(), r.dst); } });
      }
      // 2. Load domain phrases (cross-page reuse)
      var rows = await dbExportDomain(host);
      rows.sort(function (a, b) { return b.hits - a.hits; });
      rows.forEach(function (r) { if (r.src && r.dst && r.src.toLowerCase() !== r.dst.toLowerCase() && !memCache.has(r.src.toLowerCase())) cacheSet(r.src.toLowerCase(), r.dst); });
    } catch (_) {}
    dbReady = true;
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function shouldSkipEl(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id && (el.id.startsWith('__ai_') || el.id === 'ai-video-lock-overlay')) return true;
    // Only skip genuinely hidden elements. Amazon uses aria-hidden="true"
    // on truncated spans that ARE visually visible (screen-reader hint).
    if (el.getAttribute('aria-hidden') === 'true' && !isVisible(el)) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    var role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    if (el.closest('[contenteditable="true"]')) return true;
    // Skip text that was already monolingual-replaced (prevent feedback loop)
    if (el.hasAttribute('data-ot-mono') || el.closest('[data-ot-mono]')) return true;
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

  // ─── Text Node Walker ───────────────────────────────────────────────
  // TreeWalker filter: accepts text nodes that need translation
  function acceptTextNode(node) {
    var parent = node.parentElement;
    if (!parent) return NodeFilter.FILTER_REJECT;
    if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
    if (parent.closest && (parent.closest('svg') || parent.closest('math'))) return NodeFilter.FILTER_REJECT;
    // Skip text nodes inside our own bilingual markup to prevent
    // MutationObserver feedback loop (re-translating .ot-orig text)
    if (parent.closest && parent.closest('.ot-bi-wrap')) return NodeFilter.FILTER_REJECT;
    if (shouldSkipEl(parent)) return NodeFilter.FILTER_REJECT;

    var text = node.textContent.trim();
    if (text.length < 2) return NodeFilter.FILTER_REJECT;

    // Pure numeric / emoji / symbols
    var stripped = text.replace(/[\s\d\p{P}\p{S}]+/gu, '');
    if (stripped.length < 1) return NodeFilter.FILTER_REJECT;

    // Skip if text is already in target language
    if (isTargetLanguage(stripped)) return NodeFilter.FILTER_REJECT;

    return NodeFilter.FILTER_ACCEPT;
  }

  // Group contiguous sibling text nodes under the same parent
  function groupSiblingTextNodes(textNodes) {
    var groups = [];
    var current = null;

    for (var i = 0; i < textNodes.length; i++) {
      var tn = textNodes[i];
      var parent = tn.parentElement;

      if (current && parent === current.parent) {
        // Check if tn is the direct nextSibling of the group's last node
        var lastNode = current.nodes[current.nodes.length - 1];
        if (lastNode.nextSibling === tn) {
          current.nodes.push(tn);
          current.text += tn.textContent;
          continue;
        }
      }

      // Start a new group
      if (current) {
        current.cleanText = current.text.trim();
        current.key = current.cleanText.toLowerCase();
        current.id = current.parent.tagName + '|' + current.key;
        groups.push(current);
      }
      current = {
        parent: parent,
        nodes: [tn],
        text: tn.textContent,
        cleanText: null,
        key: null,
        id: null,
        _otRetries: 0
      };
    }
    if (current) {
      current.cleanText = current.text.trim();
      current.key = current.cleanText.toLowerCase();
      current.id = current.parent.tagName + '|' + current.key;
      groups.push(current);
    }
    return groups;
  }

  // ─── Scan: TreeWalker → groups → enqueue ────────────────────────────
  function scanTextNodes(root, opts) {
    if (!root || !root.nodeType) return;

    var skipPageMarked = !(opts && opts.isMutation);

    var textNodes = [];
    try {
      var walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        { acceptNode: acceptTextNode },
        false
      );

      var node;
      while ((node = walker.nextNode())) {
        var _text = (node.textContent || '').trim();
        if (skipPageMarked && node.parentElement && node.parentElement.hasAttribute('data-ot-page')) continue;
        textNodes.push(node);
      }
    } catch (_) { return; }

    // Handle shadow DOM: TreeWalker doesn't enter shadow roots.
    // Recurse into shadowRoot on the current root and on any child
    // that hosts a shadow tree, so deeply nested shadow DOM is covered.
    function scanShadow(rootEl) {
      if (rootEl.shadowRoot) {
        scanTextNodes(rootEl.shadowRoot, opts);
      }
      if (rootEl.children) {
        for (var i = 0; i < rootEl.children.length; i++) {
          scanShadow(rootEl.children[i]);
        }
      }
    }
    scanShadow(root);

    var groups = groupSiblingTextNodes(textNodes);
    for (var k = 0; k < groups.length; k++) {
      enqueueGroup(groups[k]);
    }
  }

  function enqueueGroup(group) {
    if (!group.cleanText || group.cleanText.length < 2) return;

    // ── Glossary hook: apply immediately, bypass the pump/queue entirely ──
    // This avoids race conditions where the page JS re-renders the element
    // (e.g. Amazon nav hydration) before pump() gets to it, causing the group
    // to be silently dropped in takeBatch() due to parent.isConnected=false.
    var glossaryHit = BUILT_IN_GLOSSARY[group.cleanText.toLowerCase()];
    if (glossaryHit) {
      // Only apply if parent is still connected (just found by TreeWalker ms ago)
      if (group.parent.isConnected) {
        var allAttached = true;
        for (var gi = 0; gi < group.nodes.length; gi++) {
          if (group.nodes[gi].parentNode !== group.parent) { allAttached = false; break; }
        }
        if (allAttached) {
          applyGroupTranslation(group, glossaryHit);
          return;
        }
      }
    }
    // ── End glossary hook ─────────────────────────────────────────────────

    var rect = group.parent.getBoundingClientRect();
    if (rect.top >= -300 && rect.bottom <= window.innerHeight + 300) {
      viewQ.push(group);
    } else {
      bgQ.push(group);
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
      var g = q[0];
      if (!g.parent.isConnected) { q.shift(); pendingCount--; continue; }
      // Verify text nodes are still attached
      var detached = false;
      for (var ni = 0; ni < g.nodes.length; ni++) {
        if (g.nodes[ni].parentNode !== g.parent) { detached = true; break; }
      }
      if (detached) { q.shift(); pendingCount--; continue; }
      q.shift();
      batch.push(g);
      chars += g.cleanText.length;
    }
    return batch;
  }

  // ─── Translate ───────────────────────────────────────────────────────
  async function translateBatch(groups) {
    // Filter dead groups
    var valid = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g.parent.isConnected) continue;
      var allAttached = true;
      for (var ni = 0; ni < g.nodes.length; ni++) {
        if (g.nodes[ni].parentNode !== g.parent) { allAttached = false; break; }
      }
      if (!allAttached) continue;
      valid.push(g);
    }
    if (!valid.length) return;

    // ── L0: local dictionary ────────────────────────────────────────────
    var dict = window.__ai_dict;
    var needModel = [];
    for (var j = 0; j < valid.length; j++) {
      var group = valid[j];
      var ck = group.key;
      // Check dictionary first (sub-ms, no network)
      var dictHit = dict && dict.localTranslate(group.cleanText);
      if (dictHit) {
        var pp = dict.postProcess(dictHit);
        cacheSet(ck, pp);
        pageTranslationMap.set(ck, pp);
        translatedPairs.push({ src: group.cleanText, dst: pp });
        applyGroupTranslation(group, pp);
        continue;
      }
      // ── L1: memory cache + built-in glossary ──────────────────────────
      // Built-in glossary for common short UI terms that small models
      // (Qwen3-1.7B) refuse to translate, returning identity instead.
      var glossaryHit = BUILT_IN_GLOSSARY[group.cleanText.toLowerCase()];
      if (glossaryHit) {
        console.log('[page-translate] glossary hit: "%s" → "%s"', group.cleanText, glossaryHit);
        cacheSet(ck, glossaryHit);
        pageTranslationMap.set(ck, glossaryHit);
        translatedPairs.push({ src: group.cleanText, dst: glossaryHit });
        applyGroupTranslation(group, glossaryHit);
        continue;
      }
      var hit = cacheGet(ck);
      if (hit !== undefined && hit.toLowerCase() !== group.cleanText.toLowerCase()) {
        pageTranslationMap.set(ck, hit);
        translatedPairs.push({ src: group.cleanText, dst: hit });
        applyGroupTranslation(group, hit);
      } else {
        needModel.push(group);
      }
    }
    if (!needModel.length) return;

    // ── L2: IndexedDB domain phrases ──────────────────────────────────
    var needTexts = needModel.map(function (g) { return g.cleanText; });
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
            if (dst.toLowerCase() === t.toLowerCase()) { stillNeed.push(needModel[k]); continue; }
            var dk = t.toLowerCase();
            cacheSet(dk, dst);
            pageTranslationMap.set(dk, dst);
            translatedPairs.push({ src: t, dst: dst });
            applyGroupTranslation(needModel[k], dst);
          } else {
            stillNeed.push(needModel[k]);
          }
        }
        needModel = stillNeed;
        needTexts = needModel.map(function (g) { return g.cleanText; });
      }
    }
    if (!needModel.length) return;

    // ── L3: translation API ───────────────────────────────────────────
    // Ollama: small pool of concurrent requests for speed while keeping
    // instant-on-screen feedback (each text rendered as it completes).
    if (engine === 'ollama') {
      var toSave = [];
      var POOL = 2;
      var pi = 0;
      async function ollamaWorker() {
        while (pi < needModel.length) {
          var mi = pi++;
          var mg = needModel[mi];
          if (!mg.parent.isConnected) { pendingCount--; continue; }
          var src = needTexts[mi];
          var translation = await translateSingleOllama(src);
          if (!translation || translation.toLowerCase() === src.toLowerCase()) { requeueOrGiveUp(mg); continue; }
          var sk = src.toLowerCase();
          cacheSet(sk, translation);
          pageTranslationMap.set(sk, translation);
          toSave.push({ src: src, dst: translation });
          translatedPairs.push({ src: src, dst: translation });
          applyGroupTranslation(mg, translation);
        }
      }
      var workers = [];
      for (var w = 0; w < POOL; w++) workers.push(ollamaWorker());
      await Promise.all(workers);
      if (toSave.length > 0) {
        dbSave(host, toSave).catch(function () {});
        snapshotDirty = true;
        if (Math.random() < 0.02) dbPrune();
      }
      return;
    }

    var results;
    try {
      results = await fetchTranslationBatch(needTexts);
    } catch (_) {
      results = new Array(needTexts.length).fill('');
    }

    if (!results || !Array.isArray(results)) {
      needModel.forEach(function (g) { requeueOrGiveUp(g); });
      return;
    }

    var toSave = [];
    for (var mi = 0; mi < needModel.length; mi++) {
      var mg = needModel[mi];
      var translation = results[mi] || '';
      var src = needTexts[mi];
      if (!translation || translation.toLowerCase() === src.toLowerCase()) { requeueOrGiveUp(mg); continue; }
      var sk = src.toLowerCase();
      cacheSet(sk, translation);
      pageTranslationMap.set(sk, translation);
      toSave.push({ src: src, dst: translation });
      translatedPairs.push({ src: src, dst: translation });
      applyGroupTranslation(mg, translation);
    }

    if (toSave.length > 0) {
      dbSave(host, toSave).catch(function () {});
      snapshotDirty = true;
      if (Math.random() < 0.02) dbPrune();
    }
  }

  async function fetchTranslationBatch(texts) {
    // Google Translate goes through the browser so it respects the system proxy.
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

    // Non-Ollama engines route through Go backend or Google via background.
    // Ollama is handled by translateSingleOllama in translateBatch L3 above.
    var effectiveEngine = toBackendEnginePage(engine);

    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        type: 'PAGE_FETCH_TRANSLATION',
        url: API,
        body: {
          texts: texts, from: sourceLang, to: targetLang,
          engine: effectiveEngine,
          ollamaUrl: ollamaUrl, ollamaModel: ollamaModel,
          openaiUrl: openaiUrl, openaiKey: openaiKey, openaiModel: openaiModel,
          deeplKey: deeplKey,
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

  var _ollamaReqId = 0;
  async function translateSingleOllama(text) {
    var reqId = ++_ollamaReqId;
    console.log('[page-translate] translateSingleOllama #%s called, text=%s', reqId, text.substring(0, 50));
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        type: 'PAGE_OLLAMA_TRANSLATE_ONE',
        text: text,
        to: targetLang,
        ollamaUrl: ollamaUrl,
        ollamaModel: ollamaModel,
        reqId: reqId,
      }, function (resp) {
        if (chrome.runtime.lastError) {
          console.error('[page-translate] sendMessage #%s error:', reqId, chrome.runtime.lastError.message);
          resolve('');
          return;
        }
        if (!resp || !resp.ok) {
          console.error('[page-translate] translation #%s failed: resp=%s', reqId, JSON.stringify(resp));
          resolve('');
          return;
        }
        console.log('[page-translate] translation #%s success: "%s"', reqId, resp.translation);
        resolve(resp.translation || '');
      });
    });
  }

  function requeueOrGiveUp(group) {
    group._otRetries = (group._otRetries || 0) + 1;
    if (group._otRetries >= MAX_RETRIES) {
      pendingCount--;
      // Clear marker so re-scan can pick it up (e.g. after engine switch)
      if (group.parent) group.parent.removeAttribute('data-ot-page');
      return;
    }
    viewQ.push(group);
  }

  // ─── Apply Translation ──────────────────────────────────────────────

  // Store original→translation pair on the parent element as JSON,
  // so bilingual toggle can reconstruct wraps even after monolingual
  // replacement has overwritten the original text nodes.
  function recordPair(parent, original, translation) {
    var existing = parent.getAttribute('data-ot-pairs');
    var pairs = [];
    try { if (existing) pairs = JSON.parse(existing); } catch (_) {}
    pairs.push({ o: original, t: translation });
    if (pairs.length > 50) pairs = pairs.slice(-50);
    parent.setAttribute('data-ot-pairs', JSON.stringify(pairs));
  }

  function applyGroupTranslation(group, translation) {
    if (!group.parent.isConnected) return;
    for (var i = 0; i < group.nodes.length; i++) {
      if (group.nodes[i].parentNode !== group.parent) return;
    }

    pendingCount--;
    translatedCount++;

    // Mark parent ONLY after successful translation, not in enqueueGroup.
    // This prevents the race where enqueueGroup marks the parent, Amazon's JS
    // re-renders the element before pump() runs, and the marker is left on a
    // disconnected element while the replacement is unscanned.
    group.parent.setAttribute('data-ot-page', '');

    recordPair(group.parent, group.cleanText, translation);

    if (!bilingualMode) {
      applyMonolingual(group, translation);
    } else {
      applyBilingual(group, translation);
    }
  }

  function applyMonolingual(group, translation) {
    // Replace text content of the first text node, clear the rest
    group.nodes[0].textContent = translation;
    for (var i = 1; i < group.nodes.length; i++) {
      group.nodes[i].textContent = '';
    }
    // Mark to prevent MutationObserver feedback loop
    if (group.parent) group.parent.setAttribute('data-ot-mono', '1');
  }

  function applyBilingual(group, translation) {
    var original = group.cleanText;

    var wrap = document.createElement('span');
    wrap.className = 'ot-bi-wrap';
    wrap.setAttribute('data-ot-original', original);
    wrap.setAttribute('data-ot-translation', translation);

    var transSpan = document.createElement('span');
    transSpan.className = 'ot-trans';
    transSpan.textContent = translation;

    var origSpan = document.createElement('span');
    origSpan.className = 'ot-orig';
    origSpan.textContent = original;

    wrap.appendChild(transSpan);
    wrap.appendChild(origSpan);

    // Replace first text node with the wrapper, clear remaining
    var firstNode = group.nodes[0];
    try {
      firstNode.parentNode.replaceChild(wrap, firstNode);
    } catch (_) { return; }

    for (var i = 1; i < group.nodes.length; i++) {
      group.nodes[i].textContent = '';
    }
  }

  // ─── Bilingual toggle ───────────────────────────────────────────────
  function refreshBilingualRender() {
    if (bilingualMode) {
      // Rebuild bilingual wraps from pageTranslationMap
      var parents = document.querySelectorAll('[data-ot-page]');
      for (var i = 0; i < parents.length; i++) {
        rebuildBilingualForParent(parents[i]);
      }
    } else {
      // Collapse all bilingual wraps back to plain text nodes
      var wraps = document.querySelectorAll('.ot-bi-wrap');
      for (var j = wraps.length - 1; j >= 0; j--) {
        var wrap = wraps[j];
        var trans = wrap.querySelector('.ot-trans');
        var text = trans ? trans.textContent : '';
        try {
          wrap.parentNode.replaceChild(document.createTextNode(text), wrap);
        } catch (_) {}
      }
    }
  }

  function rebuildBilingualForParent(parent) {
    var existing = parent.getAttribute('data-ot-pairs');
    var pairs = [];
    try { if (existing) pairs = JSON.parse(existing); } catch (_) {}
    if (!pairs.length) return;

    // Build lookup: translation text (lower) → original text
    var transToOrig = {};
    for (var pi = 0; pi < pairs.length; pi++) {
      transToOrig[pairs[pi].t.toLowerCase()] = pairs[pi].o;
    }

    // Walk text nodes under this parent, match translation to original, create wraps
    var walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var text = node.textContent.trim();
      if (!text || text.length < 2) continue;
      // Skip text nodes already inside an existing bilingual wrap
      if (node.parentElement && node.parentElement.classList.contains('ot-bi-wrap')) continue;

      var original = transToOrig[text.toLowerCase()];
      if (!original) continue;

      var wrap = document.createElement('span');
      wrap.className = 'ot-bi-wrap';
      wrap.setAttribute('data-ot-original', original);
      wrap.setAttribute('data-ot-translation', text);

      var transSpan = document.createElement('span');
      transSpan.className = 'ot-trans';
      transSpan.textContent = text;

      var origSpan = document.createElement('span');
      origSpan.className = 'ot-orig';
      origSpan.textContent = original;

      wrap.appendChild(transSpan);
      wrap.appendChild(origSpan);

      try {
        node.parentNode.replaceChild(wrap, node);
      } catch (_) {}
    }
  }

  // ─── Snapshot save ──────────────────────────────────────────────────
  async function saveSnapshot() {
    if (!snapshotDirty || translatedCount === 0) return;
    snapshotDirty = false;
    if (translatedPairs.length > 0) {
      try { await dbSavePageSnapshot(host, location.href, translatedPairs); } catch (_) {}
    }
  }

  // ─── IntersectionObserver — 兜底：节点真正可见时再扫一次 ─────────────
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
          scanTextNodes(t, { isMutation: true });
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
              scanTextNodes(node, { isMutation: true });
              // Register IntersectionObserver for elements that might be hidden now
              watchVisibility(node);
            }
          } else if (m.type === 'attributes' && visAttrs.has(m.attributeName)) {
            if (m.target.nodeType === Node.ELEMENT_NODE && isVisible(m.target)) {
              scanTextNodes(m.target, { isMutation: true });
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
          var g = bgQ[i];
          if (!g.parent.isConnected) { pendingCount--; continue; }
          var rect = g.parent.getBoundingClientRect();
          if (rect.top >= -300 && rect.bottom <= window.innerHeight + 300) {
            promoted.push(g);
          } else {
            remaining.push(g);
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
    scanTextNodes(document.body);
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
    if (settings.openaiUrl !== undefined) openaiUrl = settings.openaiUrl;
    if (settings.openaiKey !== undefined) openaiKey = settings.openaiKey;
    if (settings.openaiModel !== undefined) openaiModel = settings.openaiModel;
    if (settings.deeplKey !== undefined) deeplKey = settings.deeplKey;
    if (langChanged && isActive) {
      stop();
      start();
    }
  }

  function clearPageCache() {
    memCache.clear();
    pageTranslationMap.clear();
    translatedPairs = [];
    translatedCount = 0;

    // Restore original text: remove all bilingual wraps
    var wraps = document.querySelectorAll('.ot-bi-wrap');
    for (var i = wraps.length - 1; i >= 0; i--) {
      var wrap = wraps[i];
      var orig = wrap.getAttribute('data-ot-original') || '';
      try {
        wrap.parentNode.replaceChild(document.createTextNode(orig), wrap);
      } catch (_) {}
    }

    // Remove page markers and pair data
    var markers = document.querySelectorAll('[data-ot-page]');
    for (var j = 0; j < markers.length; j++) {
      markers[j].removeAttribute('data-ot-page');
      markers[j].removeAttribute('data-ot-pairs');
    }

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
    scanTextNodes(document.body);
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
        ['pageBilingual', 'pageTargetLang', 'pageEngine', 'pageOllamaUrl', 'pageOllamaModel', 'pageOpenAIUrl', 'pageOpenAIKey', 'pageOpenAIModel', 'pageDeepLKey', 'pageSourceLang', 'translationSettings'],
        function (r) {
          if (r.pageBilingual !== undefined) bilingualMode = r.pageBilingual;
          else if (r.translationSettings && r.translationSettings.pageBilingual !== undefined) bilingualMode = r.translationSettings.pageBilingual;
          if (r.pageTargetLang) targetLang = r.pageTargetLang;
          if (r.pageEngine) engine = r.pageEngine;
          if (r.pageOllamaUrl) ollamaUrl = r.pageOllamaUrl;
          if (r.pageOllamaModel) ollamaModel = r.pageOllamaModel;
          if (r.pageOpenAIUrl) openaiUrl = r.pageOpenAIUrl;
          if (r.pageOpenAIKey) openaiKey = r.pageOpenAIKey;
          if (r.pageOpenAIModel) openaiModel = r.pageOpenAIModel;
          if (r.pageDeepLKey) deeplKey = r.pageDeepLKey;
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
