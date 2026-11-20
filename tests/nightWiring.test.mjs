// 床头模式接进 App：冷启动真实的 app.js（同 tests/recovery.test.mjs 的做法），看路由、ctx 和外壳接对了没有——
// #/night/<日期> 挂上昨夜页（读的是 babble-night，等启动时的收尾做完），#/rec?bed=1 挂上床头模式的准备页（这里没有 AudioContext：
// 说话识别用不了，点开始是「不支持」），昨夜页开着不挡同步，列表、日历上都有「昨夜」卡片，ctx.sync.pause 挡住自动同步（联网、切到后台、开机那次）但不挡「立即同步」，
// 床头模式开着时离开要用它自己的说法确认。全是编的：假的 localStorage、indexedDB、网络、麦克风，不碰真的文件或用户数据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';
import { t } from '../src/i18n.js';

const NIGHT = '2026-11-17';
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// 比 helpers/dom.mjs 多一点：<dialog> 能 showModal / close（确认框用）、「.a .b:last-child」这种后代选择器、style.setProperty（录音页用）
const classes = (el) => (el.className || el.attrs.class || '').split(' ');
const matches = (el, sel) => {
  const last = sel.endsWith(':last-child'), s = last ? sel.slice(0, -':last-child'.length) : sel;
  const ok = s.startsWith('.') ? classes(el).includes(s.slice(1)) : s.startsWith('#') ? el.id === s.slice(1) : el.tag === s;
  return ok && (!last || (!!el.parent && el.parent.children[el.parent.children.length - 1] === el));
};
class Rich extends Element {
  constructor(tag) {
    super(tag);
    this.style = { setProperty(k, v) { this[k] = v; } };
    if (tag === 'dialog') { this.open = false; this.showModal = () => { this.open = true; }; this.close = () => { if (this.open) { this.open = false; this.fire('close'); } }; }
  }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    if (parts.length < 2) return super.querySelectorAll(sel);
    const under = (el, ps) => { for (let p = el.parent; p; p = p.parent) if (matches(p, ps[ps.length - 1])) return ps.length === 1 || under(p, ps.slice(0, -1)); return false; };
    return all(this, el => el !== this && matches(el, parts[parts.length - 1]) && under(el, parts.slice(0, -1)));
  }
}

const env = { network: 0, idbOpens: [], held: new Set(), dom: null, app: null, loc: null, pauses: [] };
const text = () => env.dom.doc.querySelector('#main').textContent;
const button = (label, root = env.dom.doc.querySelector('#main')) => find(root, el => el.tag === 'button' && el.textContent.includes(label));
const go = async (path) => { const ok = await env.app.ctx.navigate(path, { replace: true }); await flush(); return ok; };

before(async () => {
  const now = Date.now();
  // 一晚编的记录：已经结束、看过了（不会写回去），开始时间是几小时前（清理不会动它）；nightOf 固定，路由用它
  const seeds = { sessions: [{ id: 'n_wire', v: 1, nightOf: NIGHT, startedAt: now - 5 * 3600e3, endedAt: now - 3600e3, status: 'ended', endReason: 'auto', tz: 'UTC',
    gaps: [], notes: [], counts: { clips: 0 }, reviewedAt: now - 1800e3 }] };
  const storage = fakeStorage([['babble.local', JSON.stringify({ sync: { repo: 'someone/test-data', token: 'synthetic', dirty: true } })]]);
  env.loc = { hash: '#/night/' + NIGHT, protocol: 'http:' };
  const locks = {
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (opts.ifAvailable && env.held.has(name)) return Promise.resolve().then(() => cb(null));
      env.held.add(name);
      return Promise.resolve().then(() => cb({ name })).finally(() => env.held.delete(name));
    },
    async query() { return { held: [...env.held].map(name => ({ name })) }; },
  };
  env.dom = installDom({ localStorage: storage, location: env.loc, history: { state: {}, replaceState(s, title, hash) { env.loc.hash = hash; } },
    navigator: { languages: ['zh-CN'], userAgent: 'Synthetic', platform: 'Synthetic', locks, mediaDevices: { getUserMedia: () => new Promise(() => {}) } },   // 麦克风一直不答应：停在「正在准备」
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => { env.network++; throw new Error('offline (synthetic)'); },
    indexedDB: { open(name) {
      env.idbOpens.push(name); const request = {};
      queueMicrotask(() => {
        request.result = { transaction() { const tx = { objectStore: (store) => ({ getAll: () => ({ result: structuredClone(seeds[store] || []) }) }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
        request.onsuccess();
      });
      return request;
    } },
    setInterval: () => 0, setTimeout: () => 0 });
  const doc = env.dom.doc;
  Object.assign(doc, { visibilityState: 'visible', createElement: tag => new Rich(tag), createElementNS: (ns, tag) => new Rich(tag) });
  const shell = new Rich('div'); shell.className = 'app';
  for (const id of ['side', 'main']) { const el = new Rich('div'); el.id = id; shell.append(el); }
  const tabs = new Rich('nav'); tabs.id = 'tabs';
  doc.body.append(shell, tabs);
  globalThis.window.__babbleBuild = 'babble-test';
  await import('../src/app.js?test=night-wiring');
  env.app = window.__babble;
  const orig = env.app.ctx.sync.pause;          // 页面拿到的 ctx.sync 就是这个对象：记下谁暂停、谁恢复
  env.app.ctx.sync.pause = (tag) => { env.pauses.push(tag); const resume = orig(tag); return () => { env.pauses.push('resume ' + tag); resume(); }; };
});
after(() => { env.app?.state.setJournal(null); env.dom?.restore(); delete globalThis.AudioContext; });

test('#/night/<日期> 挂昨夜页：等启动时的收尾，读 babble-night 画出那一晚；侧栏算在「呓语」下面', async () => {
  const m = env.app.mounted.main;
  assert.equal(m.name, 'night');
  assert.equal(m.params.id, NIGHT);
  assert.equal(env.dom.doc.body.dataset.route, 'night');
  await env.app.ctx.nightRecovered;
  await flush();
  assert.ok(env.idbOpens.includes('babble-night'), '启动时没打开 babble-night');
  assert.ok(text().includes(t('night.allNight')), '没画出这一晚的记录：' + text());
  assert.ok(find(env.dom.doc.querySelector('#side'), el => el.tag === 'a' && el.attrs['aria-current'] === 'page' && el.attrs.href === '#/'), '侧栏应该高亮「呓语」');
  assert.equal(env.app.ctx.build, 'babble-test');
  assert.equal(env.app.ctx.night.listSessions.length, 0, 'ctx.night 是 nightStore 模块');
});

test('昨夜页开着时照常自动同步（只在留下以后等撤销时暂停）；列表、日历上都有「昨夜」卡片', async () => {
  assert.ok(env.network > 0, '开在昨夜页：开机那次照常同步');
  let n = env.network;
  await window.fire('online'); await flush();
  assert.ok(env.network > n, '昨夜页开着时联网照常同步');
  assert.deepEqual(env.pauses, []);
  assert.ok(await go('/'));
  assert.equal(env.app.mounted.main.name, 'list');
  assert.ok(find(env.dom.doc.querySelector('#main'), el => classes(el).includes('nt-banner')), '列表上要有「昨夜」卡片的位置');
  env.app.ctx.setListMode('cal'); await flush();
  assert.equal(env.app.mounted.main.name, 'calendar');
  assert.ok(find(env.dom.doc.querySelector('#main'), el => classes(el).includes('nt-banner')), '日历上也要有「昨夜」卡片的位置');
  env.app.ctx.setListMode('list'); await flush();
  assert.equal(env.app.mounted.main.name, 'list');
  n = env.network;
  await window.fire('online'); await flush();
  assert.ok(env.network > n);
});

test('ctx.sync.pause(tag)：暂停时联网、切到后台都不同步，「立即同步」照样同步；resume 以后恢复', async () => {
  const resume = env.app.ctx.sync.pause('x');
  let n = env.network;
  await window.fire('online'); await flush();
  env.dom.doc.visibilityState = 'hidden'; await env.dom.doc.fire('visibilitychange'); await flush();
  env.dom.doc.visibilityState = 'visible';
  assert.equal(env.network, n, '暂停着不该自动同步');
  await env.app.ctx.sync.now();
  assert.ok(env.network > n, '「立即同步」暂停着也要同步');
  resume();
  resume();                                           // 重复 resume 没关系
  n = env.network;
  await window.fire('online'); await flush();
  assert.ok(env.network > n, 'resume 以后联网要同步');
  const a = env.app.ctx.sync.pause('a'), b = env.app.ctx.sync.pause('a');
  a(); n = env.network;
  await window.fire('online'); await flush();
  assert.equal(env.network, n, '还有一个没 resume：照样暂停');
  b();
});

test('#/rec 空闲时提示下面有床头模式的入口；#/rec?bed=1 是准备页：没有 AudioContext → 说话识别用不了，点开始 → 不支持（同步暂停了又恢复）', async () => {
  assert.ok(await go('/rec'));
  assert.equal(env.app.mounted.main.name, 'record');
  const link = find(env.dom.doc.querySelector('#main'), el => el.tag === 'button' && classes(el).includes('bed-link'));
  assert.ok(link, '录音页没有床头模式的入口');
  assert.ok(link.textContent.includes(t('bed.link')));
  assert.ok(await go('/rec?bed=1'));
  assert.equal(env.app.mounted.main.name, 'record');
  assert.equal(env.app.mounted.main.params.query.bed, '1');
  assert.ok(text().includes(t('bed.title')) && text().includes(t('bed.start')), '没画出准备页：' + text());
  assert.ok(text().includes(t('bed.vadOff')), '没有 Worker：说话识别应该是用不了');
  env.pauses.length = 0;
  await button(t('bed.start')).fire('click'); await flush();
  assert.ok(text().includes(t('rec.err.unsupported.t')), '应该是「不支持」那一屏：' + text());
  assert.equal(button(t('rec.retry')), undefined, '不支持时没有「再试一次」');
  assert.deepEqual(env.pauses, ['bedside', 'resume bedside']);
  assert.ok(await go('/'), '没开始就能直接离开');
});

test('床头模式开着（正在准备）时离开：用床头模式的说法确认；「继续听」留下，「结束并离开」才走', async () => {
  globalThis.AudioContext = class {
    constructor(o = {}) { this.sampleRate = o.sampleRate || 48000; this.state = 'suspended'; this.audioWorklet = { addModule: async () => {} }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    addEventListener() {} removeEventListener() {}
  };
  assert.ok(await go('/rec?bed=1'));
  await button(t('bed.start')).fire('click'); await flush();
  assert.ok(text().includes(t('bed.starting')), '应该停在「正在准备」（麦克风一直不答应）：' + text());
  const ask = async (label) => {
    const p = env.app.ctx.navigate('/', { replace: true });
    await flush();
    const dlg = find(env.dom.doc.body, el => el.tag === 'dialog' && el.open);
    assert.ok(dlg, '离开前要先问');
    assert.equal(find(dlg, el => classes(el).includes('confirm-msg')).textContent, t('bed.leaveQ'));
    assert.ok(button(t('bed.stay'), dlg) && button(t('bed.leave'), dlg), '按钮要用床头模式的说法');
    await button(label, dlg).fire('click');
    const ok = await p; await flush();
    return ok;
  };
  assert.equal(await ask(t('bed.stay')), false);
  assert.equal(env.app.mounted.main.name, 'record');
  assert.ok(text().includes(t('bed.starting')), '「继续听」：还在床头模式');
  assert.equal(await ask(t('bed.leave')), true);
  assert.equal(env.app.mounted.main.name, 'list');
  assert.ok(env.pauses.includes('resume bedside'), '离开后同步要恢复');
});
