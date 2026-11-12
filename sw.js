// 离线缓存：有网时取最新版本（3 秒内没响应就先用缓存，夜里信号差也能马上打开），没网时用缓存。
// 只管本网站的文件。同步（api.github.com）不经过这里，也不进缓存；录音存在 IndexedDB，不在这里。
// 语音转文字的第三方文件（vendor/，几十 MB）不预先缓存：第一次用到时存进 VENDOR_CACHE，以后先用缓存（之后离线也能转文字）；
// 名字带版本号，App 发新版不用重新下载，换版本时改名字，旧的会被清掉。模型文件在 Hugging Face（别的网站），
// 由 transformers.js 自己存在「transformers-cache」里，这里不碰。
const CACHE = 'babble-v9';
const VENDOR_CACHE = 'babble-vendor-tf432';
const VENDOR = new URL('./vendor/', location).pathname;
// 程序文件全部预先缓存（tests/sw.test.mjs 检查这张表和磁盘上的文件、index.html、import 关系一致），第一次打开之后就能离线用
const CORE = [
  './', './index.html', './styles.css',
  './manifest.webmanifest', './manifest.zh-Hant-TW.webmanifest',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './src/app.js', './src/boot.js', './src/i18n.js',
  './src/core/audioStore.js', './src/core/backup.js', './src/core/clips.js', './src/core/dates.js', './src/core/dialogue.js', './src/core/drafts.js', './src/core/hanzi.js', './src/core/history.js', './src/core/loudness.js',
  './src/core/mp4meta.js', './src/core/notesImport.js', './src/core/recorder.js', './src/core/search.js', './src/core/sha256.js',
  './src/core/state.js', './src/core/store.js', './src/core/sync.js', './src/core/util.js', './src/core/zip.js',
  './src/strings/cal.js', './src/strings/core.js', './src/strings/history.js', './src/strings/list.js', './src/strings/more.js', './src/strings/stt.js',
  './src/core/transcribe.js', './src/workers/transcribe.worker.js',
  './src/ui/dom.js', './src/ui/player.js', './src/ui/stt.js', './src/ui/writer.js',
  './src/views/calendar.js', './src/views/deleted.js', './src/views/device.js', './src/views/diagnostics.js', './src/views/editor.js', './src/views/entry.js', './src/views/history.js', './src/views/import.js',
  './src/views/list.js', './src/views/record.js', './src/views/settings.js',
];
const WAIT = 3000;

self.addEventListener('install', e => {
  // cache: 'reload' 绕过浏览器的 HTTP 缓存（GitHub Pages 有 10 分钟缓存），存进来的是刚发布的版本。
  // 有一个文件没取到就算安装失败（不吞掉错误）：浏览器留着旧版本和旧缓存，下次打开再装；不然 activate 会把旧缓存删掉，只剩一个空的新缓存，离线就打不开了
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  // 只清自己的旧版本：同一个 github.io 域名下的其它网页 app（房屋账本、虚拟书架）也用 Cache Storage
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('babble-') && k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // 别的网站（api.github.com 等）和非 GET 请求一律不碰：浏览器直接发，不缓存
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith(VENDOR)) { e.respondWith(vendor(e, req)); return; }
  let stored = Promise.resolve();
  const net = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.status === 200) {   // 206（分段）之类不能也不该存
      const copy = res.clone();
      stored = caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  });
  e.waitUntil(net.then(() => stored, () => {}).catch(() => {}));
  // 打开页面（navigate）缓存里没有这个地址时用 index.html（路由在 # 后面，地址带参数也一样）
  const cached = () => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
  e.respondWith(new Promise(resolve => {
    let settled = false;
    const finish = r => { if (!settled && r) { settled = true; resolve(r); } };
    // 网络 3 秒没回来：缓存里有就先用缓存（网络回来后照样更新缓存，下次打开就是新的）；缓存里也没有就继续等网络
    const timer = setTimeout(() => cached().then(finish, () => {}), WAIT);
    // 服务器出错（GitHub Pages 偶尔 5xx）时也先用缓存
    net.then(res => { clearTimeout(timer); if (res.status >= 500) cached().then(r => finish(r || res), () => finish(res)); else finish(res); })
      .catch(() => { clearTimeout(timer); cached().then(r => finish(r || Response.error()), () => finish(Response.error())); });
  }));
});

// 第三方文件：先用缓存；没有就从网络取（成功的存起来）。文件名里有版本号（缓存名也是），不会过期
function vendor(e, req) {
  return caches.open(VENDOR_CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.status === 200) e.waitUntil(c.put(req, res.clone()).catch(() => {}));
    return res;
  })));
}
