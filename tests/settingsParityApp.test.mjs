// 和 PickNest 一致的那几处接进 App：冷启动真的 app.js（同 tests/nightWiring.test.mjs 的做法），看接线对不对——
// 侧栏的同步小标签（ctx.syncBadge）令牌快到期是黄的「令牌快到期」、鼠标停上去写还有几天，真出了错还是红的；
// 新版本：平常打开（没有 waiting）不说，启动时 update() 一次、半小时内切回来不再看；浏览器在后台装好新版以后
// ctx.updateReady() 变成 true、发 'update'，开着的「设置 → 关于」不重画就显示那一句。
// 全是编的：假的 localStorage、indexedDB、Service Worker；网络一直不回（同步停在路上，不访问 GitHub）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Element, find, fakeStorage, installDom } from './helpers/dom.mjs';
import { t } from '../src/i18n.js';
import { UPDATE_EVERY } from '../src/core/update.js';

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const cls = (el) => (el.className || el.attrs.class || '').split(' ');
// 令牌是 5 个日历日以后那天到期（自己填的日期存成那天 23:59）
const d0 = new Date(), SOON = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 5, 23, 59).getTime();
const env = { dom: null, app: null, reg: null, fetches: 0 };

before(async () => {
  const storage = fakeStorage([['babble.local', JSON.stringify({ device: 'iPhone', who: 'me', whoAsked: true,
    sync: { repo: 'someone/test-data', token: 'synthetic', dirty: true, tokenExp: SOON } })]]);
  const loc = { hash: '#/', protocol: 'http:' };
  // 已经装好、受控制（controller），平常打开：没有等着的新版本
  const ev = {};
  env.reg = { waiting: null, installing: null, updates: 0, addEventListener: (k, fn) => { (ev[k] ||= []).push(fn); }, update() { this.updates++; return Promise.resolve(); },
    /** 浏览器在后台装新版：先 installing（发 updatefound），校验完 installed → waiting */
    install() {
      const wev = {}, w = { state: 'installing', addEventListener: (k, fn) => { (wev[k] ||= []).push(fn); } };
      this.installing = w; (ev.updatefound || []).forEach(fn => fn());
      return () => { w.state = 'installed'; this.installing = null; this.waiting = w; (wev.statechange || []).forEach(fn => fn()); };
    } };
  const serviceWorker = { controller: {}, getRegistration: async () => env.reg };
  const locks = { request(name, opts, cb) { return Promise.resolve().then(() => (cb || opts)({ name })); } };
  env.dom = installDom({ localStorage: storage, location: loc, history: { state: {}, replaceState(s, title, hash) { loc.hash = hash; } },
    navigator: { languages: ['zh-CN'], userAgent: 'Synthetic', platform: 'Synthetic', locks, serviceWorker },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => { env.fetches++; return new Promise(() => {}); },
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        request.result = { transaction() { const tx = { objectStore: () => ({ getAll: () => ({ result: [] }) }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
        request.onsuccess();
      });
      return request;
    } },
    MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 0,
    setInterval: () => 0, setTimeout: () => 0 });
  const doc = env.dom.doc;
  doc.visibilityState = 'visible';
  const shell = new Element('div'); shell.className = 'app';
  for (const id of ['side', 'main']) { const el = new Element('div'); el.id = id; shell.append(el); }
  const tabs = new Element('nav'); tabs.id = 'tabs';
  doc.body.append(shell, tabs);
  globalThis.window.__babbleBuild = 'babble-test';
  await import('../src/app.js?test=settings-parity');
  env.app = window.__babble;
  await flush();
});
after(() => { env.app?.state.setJournal(null); env.dom?.restore(); });

test('侧栏的同步小标签：令牌 5 天后到期是黄的「令牌快到期」，鼠标停上去写还有几天；同步出错时还是红的「同步出错」', async () => {
  assert.ok(env.fetches > 0, '开机那次同步在路上（网络不回）');
  const side = env.dom.doc.querySelector('#side').querySelector('.sync-badge');
  assert.ok(side, '侧栏有同步小标签');
  assert.ok(cls(side).includes('warn'), side.className);
  assert.equal(side.textContent, '令牌快到期');
  assert.equal(side.attrs.title, t('set.tokenSoon', { n: 5 }));
  const { state, ctx } = env.app;
  const keep = state.getLocal().sync;
  try {
    state.setLocal({ sync: { ...keep, err: { code: 'auth' } } });
    const bad = ctx.syncBadge();
    assert.ok(cls(bad).includes('err'), bad.className);
    assert.equal(bad.textContent, '同步出错');
    assert.equal(bad.attrs.title, t('syncErr.auth'));
    state.setLocal({ sync: { ...keep, err: null, offline: false, dirty: false, tokenExp: SOON + 60 * 864e5 } });
    const later = ctx.syncBadge();
    assert.ok(cls(later).includes('ok'), '还早：照常是已同步');
    assert.equal(later.attrs.title, undefined);
  } finally { state.setLocal({ sync: keep }); }
});

test('新版本：平常打开（没有 waiting）不说，启动时看一次、半小时内切回来不再看；浏览器在后台装好以后 ctx.updateReady()、发 update，开着的「关于」不重画就显示', async () => {
  const { ctx } = env.app;
  assert.equal(env.reg.updates, 1, '启动时 update() 一次');
  assert.equal(ctx.updateReady(), false, '平常打开不说');
  await env.dom.doc.fire('visibilitychange'); await flush();
  assert.equal(env.reg.updates, 1, '刚看过：切回来不再看');
  const real = Date.now;
  Date.now = () => real() + UPDATE_EVERY + 1000;
  try { await env.dom.doc.fire('visibilitychange'); await flush(); } finally { Date.now = real; }
  assert.equal(env.reg.updates, 2, '过了半小时切回来：再看一次');

  assert.ok(await ctx.navigate('/settings', { replace: true }));
  await flush();
  const main = env.dom.doc.querySelector('#main');
  const about = main.querySelector('#set-about');
  assert.ok(about, main.textContent);
  assert.equal(about.querySelector('.set-version').textContent, '版本 babble-test');
  const line = about.querySelector('.set-update');
  assert.equal(line.hidden, true, '还没有新版本');
  let heard = 0;
  const off = ctx.on('update', () => heard++);
  const installed = env.reg.install();
  assert.equal(ctx.updateReady(), false, '还在下载、校验');
  installed();
  off();
  assert.equal(ctx.updateReady(), true);
  assert.equal(heard, 1);
  assert.equal(main.querySelector('#set-about').querySelector('.set-update'), line, '不重画');
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, '新版本已经下载好了：关掉牙牙呓语再打开就是新版。');
});
