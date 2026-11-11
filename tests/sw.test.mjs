// service worker：预缓存表（CORE）要和仓库里的程序文件一致（加了新模块忘记写进去，离线时就打不开）；
// 只缓存自己网站的文件（同步的 api.github.com 不碰）；清旧缓存只清 babble- 开头的（同域名下还有别的 app）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const exists = f => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile();
const SW = read('sw.js');
const CORE = [...SW.match(/const CORE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const CACHE = SW.match(/const CACHE = '([^']+)';/)[1];
const inCore = (f, from) => assert.ok(CORE.includes(f), `${f}（${from}）没有写进 sw.js 的 CORE`);
const isLocal = u => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(u);
/** 相对 from 文件解析成 './a/b.js' 的形式（去掉 ?query #hash） */
const resolve = (from, u) => './' + path.posix.normalize(path.posix.join(path.posix.dirname(from), u.split(/[?#]/)[0]));

function filesUnder(dir, keep = () => true) {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(path.join(root, d)).sort()) {
      const p = d + '/' + f;
      if (fs.statSync(path.join(root, p)).isDirectory()) walk(p);
      else if (!f.startsWith('.') && keep(f)) out.push('./' + p);
    }
  })(dir);
  return out;
}

/** index.html 里引用的本站文件：<link href>、<script src>、<img src> */
function htmlRefs() {
  return [...read('index.html').matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)].map(m => m[1]).filter(isLocal).map(u => resolve('./index.html', u));
}

/** 从 src/app.js 开始顺着 import 走一遍：静态 import、export … from、import '…'、字面量的 import('…') */
function importGraph(start) {
  const seen = new Map();   // 文件 → 是谁 import 的
  const queue = [[start, 'index.html']];
  while (queue.length) {
    const [f, by] = queue.shift();
    if (seen.has(f)) continue;
    seen.set(f, by);
    if (!exists(f)) continue;
    const src = read(f);
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(m => m[1]);
    for (const s of specs) {
      assert.ok(s.startsWith('./') || s.startsWith('../'), `${f} import 了 ${s}：只能用相对路径（没有打包，浏览器直接加载）`);
      queue.push([resolve(f, s), f]);
    }
  }
  return seen;
}

test('CORE 里的每个文件都存在，没有重复', () => {
  assert.equal(new Set(CORE).size, CORE.length, 'CORE 有重复');
  assert.ok(CORE.includes('./') && CORE.includes('./index.html'), '要有 ./ 和 ./index.html（离线打开的入口）');
  for (const f of CORE) if (f !== './') assert.ok(exists(f), `CORE 里的 ${f} 不存在`);
});

test('index.html 引用的文件都存在，都在 CORE 里', () => {
  const refs = htmlRefs();
  for (const want of ['./src/app.js', './styles.css', './manifest.webmanifest', './icons/icon-180.png']) assert.ok(refs.includes(want), `index.html 应该引用 ${want}`);
  for (const f of refs) { assert.ok(exists(f), `index.html 引用的 ${f} 不存在`); inCore(f, 'index.html'); }
});

test('从 src/app.js 顺着 import 走到的模块都存在，都在 CORE 里', () => {
  const graph = importGraph('./src/app.js');
  assert.ok(graph.size > 10, `只走到了 ${graph.size} 个模块，解析 import 的正则可能坏了`);
  for (const [f, by] of graph) { assert.ok(exists(f), `${by} import 的 ${f} 不存在`); inCore(f, `${by} import`); }
});

test('程序文件全都在 CORE 里：src/ 下所有 .js、根目录的样式表和 manifest、icons/ 下所有文件', () => {
  for (const f of filesUnder('src', f => f.endsWith('.js'))) inCore(f, 'src/');
  for (const f of fs.readdirSync(root).filter(f => /\.(css|webmanifest)$/.test(f))) inCore('./' + f, '根目录');
  for (const f of filesUnder('icons')) inCore(f, 'icons/');
});

test('JS 里写到的图标和 CSS 里 url() 的文件都存在，都在 CORE 里', () => {
  for (const f of filesUnder('src', f => f.endsWith('.js'))) {
    for (const m of read(f).matchAll(/['"`](?:\.\/)?(icons\/[\w.-]+)['"`]/g)) {
      const p = './' + m[1];   // 页面里的相对地址按 index.html 所在目录算
      assert.ok(exists(p), `${f} 用到的 ${p} 不存在`); inCore(p, f);
    }
  }
  for (const f of fs.readdirSync(root).filter(f => f.endsWith('.css')).map(f => './' + f)) {
    for (const m of read(f).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      if (!isLocal(m[2])) continue;
      const p = resolve(f, m[2]);
      assert.ok(exists(p), `${f} 用到的 ${p} 不存在`); inCore(p, f);
    }
  }
});

test('manifest：名字、start_url / scope、图标都对；两种语言的 manifest 只差名字和 lang', () => {
  const files = fs.readdirSync(root).filter(f => f.endsWith('.webmanifest')).sort();
  assert.deepEqual(files, ['manifest.webmanifest', 'manifest.zh-Hant-TW.webmanifest']);
  const [hans, hant] = files.map(f => JSON.parse(read(f)));
  assert.equal(hans.name, '牙牙呓语');
  assert.equal(hant.name, '牙牙囈語');
  for (const m of [hans, hant]) {
    assert.equal(m.start_url, './');
    assert.equal(m.scope, './');
    assert.equal(m.id, './', '两份 manifest 的 id 一样，切换语言不会变成另一个 app');
    assert.equal(m.display, 'standalone');
    assert.equal(m.background_color, '#f8f3ee');
    for (const ic of m.icons) { const p = resolve('./manifest.webmanifest', ic.src); assert.ok(exists(p), `manifest 图标 ${p} 不存在`); inCore(p, 'manifest'); }
    assert.ok(m.icons.some(ic => ic.sizes === '512x512' && (ic.purpose || 'any').includes('any')));
    assert.ok(m.icons.some(ic => ic.sizes === '512x512' && (ic.purpose || '').includes('maskable')));
  }
  const strip = m => JSON.stringify({ ...m, name: 0, short_name: 0, lang: 0 });
  assert.equal(strip(hans), strip(hant));
});

test('图标 PNG：正方形，尺寸和文件名一致', () => {
  for (const f of filesUnder('icons', f => f.endsWith('.png'))) {
    const b = fs.readFileSync(path.join(root, f));
    assert.equal(b.toString('latin1', 1, 4), 'PNG', `${f} 不是 PNG`);
    const w = b.readUInt32BE(16), hgt = b.readUInt32BE(20);
    assert.equal(w, hgt, `${f} 不是正方形`);
    assert.equal(w, Number(f.match(/(\d+)\.png$/)[1]), `${f} 实际是 ${w}px`);
  }
});

// ---------- 在假的 service worker 环境里跑 sw.js ----------
const SCOPE = 'https://example.github.io/babble/';
function loadSw({ fetch: fakeFetch = () => Promise.reject(new TypeError('offline')), caches: initial = {}, addAllFails = false } = {}) {
  const location = new URL(SCOPE + 'sw.js');
  const abs = r => new URL(typeof r === 'string' ? r : r.url, location).href;
  const noSearch = u => u.split('?')[0];
  const stores = new Map(Object.entries(initial).map(([name, files]) => [name, new Map(Object.entries(files).map(([u, v]) => [abs(u), v]))]));
  const handlers = {}, fetched = [], timers = [];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async addAll(reqs) {
          if (addAllFails) throw new TypeError('Load failed');     // 和浏览器一样：有一个失败就整个失败，什么都不存
          for (const r of reqs) m.set(abs(r), { body: 'core:' + abs(r), status: 200, cacheMode: r.cache });
        },
        async put(req, res) { m.set(abs(req), res); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(req, opts = {}) {
      const want = opts.ignoreSearch ? noSearch(abs(req)) : abs(req);
      for (const m of stores.values()) for (const [u, v] of m) if ((opts.ignoreSearch ? noSearch(u) : u) === want) return v;
    },
  };
  class Request { constructor(u, init = {}) { this.url = new URL(u, location).href; this.method = 'GET'; this.mode = 'cors'; this.cache = init.cache || 'default'; } }
  const sandbox = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting() {}, clients: { claim() {} } },
    caches, location, URL, Request,
    Response: { error: () => ({ type: 'error', status: 0 }) },
    fetch: (req, init) => { fetched.push({ url: req.url, init }); return fakeFetch(req, init); },
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  vm.runInNewContext(SW, sandbox, { filename: 'sw.js' });
  const fire = (type, props = {}) => {
    const waits = [];
    let responded = null;
    handlers[type]({ ...props, waitUntil: p => waits.push(p), respondWith: p => { responded = Promise.resolve(p); } });
    return { settled: () => Promise.all(waits), get responded() { return responded; } };
  };
  const tick = () => { for (const t of timers.splice(0)) if (t.fn) { assert.equal(t.ms, 3000); t.fn(); } };
  return { fire, stores, fetched, tick, keys: name => [...(stores.get(name) || new Map()).keys()] };
}
const req = (p, extra = {}) => ({ request: { url: new URL(p, SCOPE).href, method: 'GET', mode: 'cors', ...extra } });
const res = (body, status = 200) => ({ body, status, clone() { return { ...this, cloned: true }; } });
const flush = () => new Promise(r => setImmediate(r));
const PENDING = Symbol('pending');
const peek = async p => { await flush(); return Promise.race([p, flush().then(() => PENDING)]); };
// 坏掉的 sw 可能让 respondWith 永远不回：每个用例最多等 3 秒，算失败而不是卡住
const swTest = (name, fn) => test(name, { timeout: 3000 }, fn);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

swTest('sw 安装：CORE 全部存进当前版本的缓存，绕过 HTTP 缓存', async () => {
  assert.match(SW, /const CACHE = 'babble-v\d+';/);
  const sw = loadSw();
  await sw.fire('install').settled();
  assert.deepEqual(sw.keys(CACHE), CORE.map(u => new URL(u, SCOPE).href));
  for (const v of sw.stores.get(CACHE).values()) assert.equal(v.cacheMode, 'reload');
});

swTest('sw 安装：有文件没取到 → 安装失败（浏览器留着旧版本和旧缓存），不会装上一个空缓存', async () => {
  const sw = loadSw({ addAllFails: true, caches: { 'babble-v0': { 'index.html': res('old index') } } });
  await assert.rejects(sw.fire('install').settled());
  assert.equal(sw.keys(CACHE).length, 0);
  assert.deepEqual(sw.keys('babble-v0'), [SCOPE + 'index.html'], '旧缓存还在');
});

swTest('sw 启用：只删自己的旧缓存，同域名下别的 app 的缓存不动', async () => {
  const sw = loadSw({ caches: { 'babble-v0': {}, 'babble-v1': {}, [CACHE]: {}, 'house-ledger-v13': {}, 'vshelf-v2': {}, babbleish: {} } });
  await sw.fire('activate').settled();
  assert.deepEqual([...sw.stores.keys()].sort(), [CACHE, 'babbleish', 'house-ledger-v13', 'vshelf-v2'].sort());
});

swTest('sw 不碰 api.github.com、别的网站和非 GET 请求', () => {
  const sw = loadSw({ fetch: async () => res('net') });
  for (const e of [
    req('https://api.github.com/repos/someone/babble-data/contents/babble.json'),
    req('https://api.github.com/repos/someone/babble-data/contents/audio/abc.m4a', { mode: 'cors' }),
    req('https://example.com/babble/src/app.js'),
    req('src/app.js', { method: 'POST' }),
  ]) assert.equal(sw.fire('fetch', e).responded, null, e.request.url);
  assert.equal(sw.fetched.length, 0);
});

swTest('sw 有网：用网络的新版本，并更新缓存（206 之类不存）', async () => {
  const sw = loadSw({ fetch: async r => res('net:' + r.url, r.url.endsWith('.m4a') ? 206 : 200) });
  const e = sw.fire('fetch', req('src/app.js'));
  assert.equal((await e.responded).body, 'net:' + SCOPE + 'src/app.js');
  await e.settled();
  assert.deepEqual(sw.keys(CACHE), [SCOPE + 'src/app.js']);
  assert.equal(sw.fetched[0].init.cache, 'no-cache');
  const partial = sw.fire('fetch', req('test.m4a'));
  assert.equal((await partial.responded).status, 206);
  await partial.settled();
  assert.deepEqual(sw.keys(CACHE), [SCOPE + 'src/app.js']);
});

swTest('sw 没网：用缓存；打开页面时没有这个地址就用 index.html；缓存里也没有就报错', async () => {
  const sw = loadSw({ caches: { [CACHE]: { 'src/app.js': res('cached app'), 'index.html': res('cached index') } } });
  assert.equal((await sw.fire('fetch', req('src/app.js?v=2')).responded).body, 'cached app');
  assert.equal((await sw.fire('fetch', req('./?x=1#/rec', { mode: 'navigate' })).responded).body, 'cached index');
  assert.equal((await sw.fire('fetch', req('src/views/nope.js')).responded).type, 'error');
});

swTest('sw 网络慢：3 秒后先用缓存；缓存里没有就继续等网络', async () => {
  const slow = deferred();
  const sw = loadSw({ fetch: () => slow.promise, caches: { [CACHE]: { 'index.html': res('cached index') } } });
  const nav = sw.fire('fetch', req('./', { mode: 'navigate' }));
  const js = sw.fire('fetch', req('src/core/dates.js'));
  assert.equal(await peek(nav.responded), PENDING);
  sw.tick();
  assert.equal((await nav.responded).body, 'cached index');
  assert.equal(await peek(js.responded), PENDING, '缓存里没有 → 继续等网络');
  slow.resolve(res('net'));
  assert.equal((await js.responded).body, 'net');
  await nav.settled();
  assert.ok(sw.keys(CACHE).includes(SCOPE), '网络回来后照样更新缓存');
});

swTest('sw 服务器 5xx：缓存里有就用缓存，没有就把错误页交给页面', async () => {
  const sw = loadSw({ fetch: async () => res('oops', 503), caches: { [CACHE]: { 'styles.css': res('cached css') } } });
  assert.equal((await sw.fire('fetch', req('styles.css')).responded).body, 'cached css');
  assert.equal((await sw.fire('fetch', req('manifest.webmanifest')).responded).status, 503);
});
