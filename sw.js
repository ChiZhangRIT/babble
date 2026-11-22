// 每次启动固定使用同一份完整缓存。新版安装时按 release.json 校验文件，等旧页面全部关闭后再启用。
// 只管本网站的文件。同步（api.github.com）不经过这里，也不进缓存；录音存在 IndexedDB，不在这里。
// 语音转文字、床头模式说话识别的第三方文件（vendor/：transformers.js 和 onnxruntime 几十 MB、Silero VAD 模型 1.3 MB）不预先缓存：
// 第一次用到时按 release.json 的 vendor 核对 sha256，存进 VENDOR_CACHE，以后先用缓存（之后离线也能用）；
// 名字带版本号，App 发新版不用重新下载；已有的文件换了版本（或去掉了）才改名字，旧的会被清掉，只是加了文件不改。Whisper 模型文件在 Hugging Face（别的网站），
// 由 transformers.js 自己存在「transformers-cache」里，这里不碰。
const CACHE = 'babble-v31';
const VENDOR_CACHE = 'babble-vendor-tf432';
const VENDOR = new URL('./vendor/', location).pathname;
// 程序文件全部预先缓存（tests/sw.test.mjs 检查这张表和磁盘上的文件、index.html、import 关系一致），第一次打开之后就能离线用
const CORE = [
  './', './index.html', './styles.css',
  './manifest.webmanifest', './manifest.zh-Hant-TW.webmanifest',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/icon-180-v2.png', './icons/icon-192-v2.png', './icons/icon-512-v2.png', './icons/icon-maskable-512-v2.png',
  './icons/icon-180-v3.png', './icons/icon-192-v3.png', './icons/icon-512-v3.png', './icons/icon-maskable-512-v3.png',
  './icons/icon-180-v4.png', './icons/icon-192-v4.png', './icons/icon-512-v4.png', './icons/icon-maskable-512-v4.png',
  './src/app.js', './src/boot.js', './src/i18n.js',
  './src/start.js', './src/ui/recovery.js', './src/strings/recovery.js',
  './src/core/audioStore.js', './src/core/backup.js', './src/core/clips.js', './src/core/dates.js', './src/core/dialogue.js', './src/core/drafts.js', './src/core/hanzi.js', './src/core/history.js', './src/core/loudness.js',
  './src/core/mp4meta.js', './src/core/notesImport.js', './src/core/recorder.js', './src/core/search.js', './src/core/sha256.js',
  './src/core/state.js', './src/core/store.js', './src/core/sync.js', './src/core/util.js', './src/core/zip.js',
  './src/core/persistence.js',
  './src/strings/cal.js', './src/strings/core.js', './src/strings/history.js', './src/strings/list.js', './src/strings/more.js', './src/strings/stt.js',
  './src/core/transcribe.js', './src/workers/transcribe.worker.js',
  './src/ui/dom.js', './src/ui/player.js', './src/ui/stt.js', './src/ui/swipe.js', './src/ui/writer.js',
  './src/views/calendar.js', './src/views/deleted.js', './src/views/device.js', './src/views/diagnostics.js', './src/views/editor.js', './src/views/entry.js', './src/views/history.js', './src/views/import.js',
  './src/views/list.js', './src/views/record.js', './src/views/settings.js',
  // 床头模式（整夜录音的引擎、采集 worklet、说话识别 worker、昨夜页）
  './src/core/nightDetect.js', './src/core/nightReport.js', './src/core/nightStore.js', './src/core/vad.js', './src/core/bedside.js',
  './src/core/nightKeep.js', './src/core/purge.js', './src/worklets/capture.worklet.js', './src/workers/vad.worker.js',
  './src/views/bedside.js', './src/views/night.js', './src/strings/night.js',
];
const RELEASE = './release.json';
const BASE = new URL('./', location).pathname;
const CORE_PATHS = new Map(CORE.map(u => [new URL(u, location).pathname, u]));
const HASH = /^[a-f0-9]{64}$/;

async function verify(response, expected) {
  if (response.status !== 200 || !HASH.test(expected || '')) throw new Error('release-file-unavailable');
  const bytes = await response.clone().arrayBuffer();
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('release-hash-mismatch');
  return response;
}
async function install() {
  const response = await fetch(new Request(RELEASE, { cache: 'no-store' }));
  if (response.status !== 200) throw new Error('release-unavailable');
  const release = await response.clone().json();
  if (release.cache !== CACHE || release.vendorCache !== VENDOR_CACHE || !release.core
    || Object.keys(release.core).length !== CORE.length || CORE.some(u => !HASH.test(release.core[u] || ''))) throw new Error('release-version-mismatch');
  const files = await Promise.all(CORE.map(async u => [u, await verify(await fetch(new Request(u, { cache: 'reload' })), release.core[u])]));
  const cache = await caches.open(CACHE);
  for (const [url, file] of files) await cache.put(new Request(url), file);
  await cache.put(new Request(RELEASE), response);
}
self.addEventListener('install', e => { e.waitUntil(install()); });
self.addEventListener('activate', e => {
  // 只清自己的旧版本：同一个 github.io 域名下的其它网页 app（房屋账本、虚拟书架）也用 Cache Storage
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('babble-') && k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k)))));
  // 不 skipWaiting / claim：正在录音、编辑或刚打开的旧页面继续由旧 worker 服务。
});
self.addEventListener('message', e => { if (e.data === 'babble-build') e.ports?.[0]?.postMessage(CACHE); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // 别的网站（api.github.com 等）和非 GET 请求一律不碰：浏览器直接发，不缓存
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  if (url.pathname.startsWith(VENDOR)) { e.respondWith(vendor(e, req)); return; }
  const file = req.mode === 'navigate' ? './index.html' : CORE_PATHS.get(url.pathname);
  if (file) e.respondWith(core(file));
});

async function core(file) {
  try {
    const cache = await caches.open(CACHE), request = new Request(file);
    const hit = await cache.match(request);
    if (hit) return hit;
    // 缓存意外缺文件时，只接收当前版本校验通过的原件，不能借用别的版本或未经校验的网络文件。
    const release = await (await cache.match(new Request(RELEASE))).json();
    const response = await verify(await fetch(new Request(file, { cache: 'reload' })), release.core[file]);
    await cache.put(request, response.clone());
    return response;
  } catch (e) { return Response.error(); }
}

// 大文件按需取，同样按当前版本的清单校验；不预先下载。
function vendor(e, req) {
  return (async () => {
    try {
      const cache = await caches.open(VENDOR_CACHE), request = new Request(new URL(req.url).pathname);
      const hit = await cache.match(request);
      if (hit) return hit;
      const active = await caches.open(CACHE);
      const release = await (await active.match(new Request(RELEASE))).json();
      const path = './' + new URL(req.url).pathname.slice(BASE.length);
      const response = await verify(await fetch(req), release.vendor?.[path]);
      await cache.put(request, response.clone());
      return response;
    } catch (e) { return Response.error(); }
  })();
}
