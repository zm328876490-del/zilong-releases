// app.js - AI 实时翻译 统一页面
var AUTH_API = 'http://localhost:14532';

function $(id) { return document.getElementById(id); }

// ─── Tab switching ───────────────────────────────────────────────────
var navLinks = document.querySelectorAll('#mainNav a');

function switchTab(name) {
  navLinks.forEach(function (a) {
    a.classList.toggle('active', a.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(function (p) {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
  if (name === 'account') loadAccount();
}

navLinks.forEach(function (a) {
  a.addEventListener('click', function () {
    var tab = a.dataset.tab;
    if (tab) switchTab(tab);
  });
});

// Hash routing
function routeFromHash() {
  var hash = window.location.hash.replace('#', '') || 'login';
  // Map old page hashes to tabs
  var map = { login: 'login', buy: 'buy', account: 'account' };
  switchTab(map[hash] || 'login');
}
window.addEventListener('hashchange', routeFromHash);

// ─── Shared helpers ──────────────────────────────────────────────────
function showMsg(elId, text, type) {
  var el = $(elId);
  el.textContent = text;
  el.className = 'msg ' + (type || 'info');
}

function sendCodeRequest(email, btnEl, msgElId, onSuccess) {
  btnEl.disabled = true;
  btnEl.textContent = '发送中...';
  showMsg(msgElId, '发送中...', 'info');

  fetch(AUTH_API + '/api/auth/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email }),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) {
        showMsg(msgElId, d.error, 'error');
        btnEl.disabled = false;
        btnEl.textContent = '发送验证码';
        return;
      }
      showMsg(msgElId, '验证码已发送，请查收邮箱', 'ok');
      if (onSuccess) onSuccess();
    })
    .catch(function () {
      showMsg(msgElId, '无法连接服务器', 'error');
      btnEl.disabled = false;
      btnEl.textContent = '发送验证码';
    });
}

function startCountdown(btnEl) {
  var left = 60;
  btnEl.textContent = '重新发送 (' + left + 's)';
  var timer = setInterval(function () {
    left--;
    if (left <= 0) {
      clearInterval(timer);
      btnEl.textContent = '发送验证码';
      btnEl.disabled = false;
    } else {
      btnEl.textContent = '重新发送 (' + left + 's)';
    }
  }, 1000);
}

function saveAuth(token, plan, email) {
  try {
    chrome.storage.local.set({ authToken: token, userPlan: plan, userEmail: email });
  } catch (_) {}
}

// ─── Login tab ───────────────────────────────────────────────────────
(function () {
  var btnSend = $('loginBtnSend');
  var btnGo = $('loginBtnGo');
  var emailEl = $('loginEmail');
  var codeEl = $('loginCode');

  btnSend.addEventListener('click', function () {
    var email = emailEl.value.trim();
    if (!email || !/@/.test(email)) { showMsg('loginMsg', '请输入有效邮箱', 'error'); return; }
    sendCodeRequest(email, btnSend, 'loginMsg', function () {
      startCountdown(btnSend);
    });
  });

  btnGo.addEventListener('click', function () {
    var email = emailEl.value.trim();
    var code = codeEl.value.trim();
    if (!email || !code) { showMsg('loginMsg', '请填写邮箱和验证码', 'error'); return; }
    btnGo.disabled = true;
    btnGo.textContent = '登录中...';
    showMsg('loginMsg', '登录中...', 'info');

    fetch(AUTH_API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          showMsg('loginMsg', d.error, 'error');
          btnGo.disabled = false;
          btnGo.textContent = '登录';
          return;
        }
        showMsg('loginMsg', '登录成功', 'ok');
        saveAuth(d.token, d.plan || 'trial', email);
        setTimeout(function () { window.close(); }, 600);
      })
      .catch(function () {
        showMsg('loginMsg', '无法连接服务器', 'error');
        btnGo.disabled = false;
        btnGo.textContent = '登录';
      });
  });

  codeEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') btnGo.click();
  });
})();

// ─── Buy tab ─────────────────────────────────────────────────────────
(function () {
  var btnBuy = $('payBtnBuy');
  var modalBg = $('payModalBg');
  var btnSend = $('payBtnSend');
  var btnLogin = $('payBtnLogin');

  function openPay() { modalBg.classList.add('show'); showMsg('payMsg', '', ''); }
  function closePay() { modalBg.classList.remove('show'); }

  if (btnBuy) btnBuy.addEventListener('click', openPay);

  document.querySelectorAll('.js-close-pay').forEach(function (el) {
    el.addEventListener('click', closePay);
  });

  if (modalBg) modalBg.addEventListener('click', function (e) {
    if (e.target === modalBg) closePay();
  });

  btnSend.addEventListener('click', function () {
    var email = ($('payEmail').value || '').trim();
    if (!email || !/@/.test(email)) { showMsg('payMsg', '请输入有效邮箱', 'error'); return; }
    sendCodeRequest(email, btnSend, 'payMsg', function () {
      startCountdown(btnSend);
    });
  });

  btnLogin.addEventListener('click', function () {
    var email = ($('payEmail').value || '').trim();
    var code = ($('payCode').value || '').trim();
    if (!email || !/^\d{6}$/.test(code)) { showMsg('payMsg', '请填写邮箱和 6 位验证码', 'error'); return; }
    btnLogin.disabled = true;
    btnLogin.textContent = '处理中...';
    showMsg('payMsg', '处理中...', 'info');

    fetch(AUTH_API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          showMsg('payMsg', d.error, 'error');
          btnLogin.disabled = false;
          btnLogin.textContent = '登录并支付';
          return;
        }
        return fetch(AUTH_API + '/api/admin/set-plan', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + d.token },
          body: JSON.stringify({ email: email, plan: 'premium' }),
        }).then(function () { return d; });
      })
      .then(function (d) {
        showMsg('payMsg', '支付成功！已升级为专业版', 'ok');
        btnLogin.textContent = '已完成';
        saveAuth(d.token, 'premium', email);
        setTimeout(closePay, 2000);
      })
      .catch(function () {
        showMsg('payMsg', '操作失败，请重试', 'error');
        btnLogin.disabled = false;
        btnLogin.textContent = '登录并支付';
      });
  });
})();

// ─── Account tab ─────────────────────────────────────────────────────
function loadAccount() {
  var content = $('acctContent');
  var loading = $('acctLoading');
  if (!content || content.style.display !== 'none') return;

  try {
    chrome.storage.local.get(['authToken', 'userPlan', 'userEmail'], function (result) {
      var token = result.authToken;
      if (!token) {
        loading.textContent = '未登录，请先登录';
        return;
      }
      fetch(AUTH_API + '/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token },
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { loading.textContent = d.error; return; }
          var user = d.user;
          $('acctEmail').textContent = user.email || result.userEmail || '-';
          var plan = d.plan || result.userPlan || 'trial';
          if (plan === 'premium') {
            $('acctPlan').innerHTML = '<span class="plan-badge premium">专业版</span>';
          } else {
            $('acctPlan').innerHTML = '<span class="plan-badge trial">体验版</span>';
          }
          $('acctLogin').textContent = formatDate(user.updatedAt || user.createdAt);
          try { chrome.storage.local.set({ userPlan: plan }); } catch (_) {}
          loading.style.display = 'none';
          content.style.display = '';
        })
        .catch(function () { loading.textContent = '无法连接服务器'; });
    });
  } catch (_) { loading.textContent = '无法读取存储数据'; }
}

// Logout
$('btnLogout').addEventListener('click', function () {
  var btn = $('btnLogout');
  btn.disabled = true;
  btn.textContent = '退出中...';
  try {
    chrome.storage.local.remove(['authToken', 'userPlan', 'userEmail'], function () {
      showMsg('acctMsg', '已退出登录', 'ok');
      btn.textContent = '已退出';
      setTimeout(function () { window.close(); }, 1000);
    });
  } catch (_) {
    showMsg('acctMsg', '操作失败', 'error');
    btn.disabled = false;
    btn.textContent = '退出登录';
  }
});

function formatDate(isoStr) {
  if (!isoStr) return '-';
  try {
    var d = new Date(isoStr);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch (_) { return isoStr; }
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

// ─── Init ────────────────────────────────────────────────────────────
routeFromHash();
