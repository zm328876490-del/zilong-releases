// buy.js - AI 实时翻译 购买页面
var AUTH_API = 'http://localhost:14532';

function $(id) { return document.getElementById(id); }

function showMsg(text, type) {
  var el = $('payMsg');
  el.textContent = text;
  el.className = 'pay-msg ' + (type || 'info');
}

function openPay() {
  $('payModalBg').classList.add('show');
  showMsg('', '');
}

function closePay() {
  $('payModalBg').classList.remove('show');
}

// Init
function init() {
  // 购买按钮
  var btnBuy = $('payBtnBuy');
  if (btnBuy) btnBuy.addEventListener('click', openPay);

  // 关闭
  var closeBtns = document.querySelectorAll('.js-close-pay');
  closeBtns.forEach(function (el) { el.addEventListener('click', closePay); });

  var bg = $('payModalBg');
  if (bg) bg.addEventListener('click', function (e) {
    if (e.target === bg) closePay();
  });

  // 发送验证码
  var cooldown = 0;
  var btnSend = $('payBtnSend');
  if (btnSend) btnSend.addEventListener('click', function () {
    var email = ($('payEmail').value || '').trim();
    if (!email || !/@/.test(email)) { showMsg('请输入有效邮箱', 'error'); return; }
    if (cooldown > 0) return;
    cooldown = 60;
    btnSend.disabled = true;
    btnSend.textContent = '发送中...';
    fetch(AUTH_API + '/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { showMsg(d.error, 'error'); return; }
        showMsg('验证码已发送，请查收邮箱', 'ok');
        var timer = setInterval(function () {
          cooldown--;
          btnSend.textContent = cooldown + 's 后重发';
          if (cooldown <= 0) {
            clearInterval(timer);
            btnSend.textContent = '发送验证码';
            btnSend.disabled = false;
          }
        }, 1000);
      })
      .catch(function () {
        showMsg('无法连接服务器', 'error');
        cooldown = 0;
        btnSend.disabled = false;
        btnSend.textContent = '发送验证码';
      });
  });

  // 登录并支付
  var btnLogin = $('payBtnLogin');
  if (btnLogin) btnLogin.addEventListener('click', function () {
    var email = ($('payEmail').value || '').trim();
    var code = ($('payCode').value || '').trim();
    if (!email || !/^\d{6}$/.test(code)) { showMsg('请填写邮箱和 6 位验证码', 'error'); return; }
    btnLogin.disabled = true;
    btnLogin.textContent = '处理中...';
    fetch(AUTH_API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { showMsg(d.error, 'error'); btnLogin.disabled = false; btnLogin.textContent = '登录并支付'; return; }
        // 支付模拟 — 开发阶段直接升级为 premium
        return fetch(AUTH_API + '/api/admin/set-plan', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + d.token },
          body: JSON.stringify({ email: email, plan: 'premium' }),
        }).then(function () { return d; });
      })
      .then(function (d) {
        showMsg('支付成功！已升级为专业版', 'ok');
        btnLogin.textContent = '已完成';
        // 同步 token 到 extension storage
        try {
          chrome.storage.local.set({ authToken: d.token, userPlan: 'premium', userEmail: email });
        } catch (_) {}
        setTimeout(closePay, 2000);
      })
      .catch(function () {
        showMsg('操作失败，请重试', 'error');
        btnLogin.disabled = false;
        btnLogin.textContent = '登录并支付';
      });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
