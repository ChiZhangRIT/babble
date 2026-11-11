// 第一次绘制之前先定深浅色：夜里（或深色外观）打开时不闪一下浅色。
// CSP 不许内联脚本，所以单独一个小文件，在 <head> 里同步加载；规则和 app.js / core/dates.js 的 isNight 一样，app 启动后会再定一次。
(function () {
  try {
    var read = function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch (e) { return {}; } };
    var L = read('babble.local'), S = read('babble.state').settings || {};
    var mins = function (t, d) { var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof t === 'string' ? t : d) || /^(\d\d):(\d\d)$/.exec(d); return m[1] * 60 + Number(m[2]); };
    var a = mins(S.nightStart, '21:00'), b = mins(S.nightEnd, '07:00');
    var now = new Date(), m = now.getHours() * 60 + now.getMinutes();
    var night = a !== b && (a < b ? m >= a && m < b : m >= a || m < b);
    var dark = (night && S.nightForcesDark !== false) || L.theme === 'dark'
      || (L.theme !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    // 夜里冷启动会直接进录音页（app.js 的 nightRedirect）：先刷成录音页的近黑
    if ((night && S.nightOpensRecorder !== false && /^#?\/?(\?.*)?$/.test(location.hash)) || /^#\/rec\b/.test(location.hash)) root.setAttribute('data-boot', 'rec');
  } catch (e) { /* 读不到就按系统外观，app.js 会再定 */ }
})();

// 启动看门狗：刚发布新版、网络又慢时，个别程序文件可能用了缓存里的旧版，新旧模块对不上 → app 起不来，页面一直空白。
// 10 秒还没启动（或启动前就出错了）→ 显示「重新载入」（这时晚到的新文件已经进了缓存，再载入一次通常就好）
(function () {
  try {
    var shown = false;
    var show = function () {
      if (shown || window.__babble || !document.body) return;
      shown = true;
      var lang = '';
      try { lang = (JSON.parse(localStorage.getItem('babble.local') || 'null') || {}).lang || ''; } catch (e) { /* 用系统语言 */ }
      var nl = String((navigator && navigator.language) || '').toLowerCase();
      if (!lang) lang = /^zh-(tw|hant|hk|mo)/.test(nl) ? 'zh-Hant-TW' : /^zh/.test(nl) ? 'zh-Hans' : 'en';
      var txt = { 'zh-Hans': ['牙牙呓语没能打开（可能刚好在更新）。', '重新载入'], 'zh-Hant-TW': ['牙牙囈語沒能開啟（可能剛好在更新）。', '重新載入'], en: ["Babble didn't start (it may have just updated).", 'Reload'] }[lang] || ['牙牙呓语没能打开（可能刚好在更新）。', '重新载入'];
      var box = document.createElement('div');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;background:Canvas;color:CanvasText;font:17px/1.5 -apple-system,system-ui,sans-serif';
      var p = document.createElement('p');
      p.textContent = txt[0];
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt[1];
      b.style.cssText = 'min-height:44px;padding:0 22px;border:0;border-radius:9px;background:#b04462;color:#fff;font:inherit';
      b.onclick = function () { location.reload(); };
      box.appendChild(p); box.appendChild(b);
      document.body.appendChild(box);
      var poll = setInterval(function () { if (window.__babble) { clearInterval(poll); box.remove(); } }, 1000);   // 其实只是慢：起来了就收起
    };
    setTimeout(show, 10000);
    window.addEventListener('error', function () { setTimeout(show, 1500); });
  } catch (e) { /* 看门狗本身出错不影响启动 */ }
})();
