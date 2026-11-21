// 永久删除碰到的其他页面：最小 DOM + 真的 state.js（墓碑都是「别的设备」永久删除以后同步进来的样子：先删除、再 purgedRecord）。
//   修改记录：「恢复这个版本」录音只多不少（现在的都留着；移除的放回来；找得到的补上；永久删除了的不放回、说一声），看一版时永久删除了的不给播放器；墓碑只说一句
//   录音页：要接的那条永久删除了——预填的旧原话不再存，只把新写的连同录音存成新的一条
//   从备忘录迁移：以前永久删除过的（固定 id）算已存在、不再导入，完成页说几条
//   设置 → 同步：「已更新到新版的设备」（core/purge.js 的 deviceReport）；「清理云端历史」开关关着不显示；停止同步时还有没从仓库删掉的录音说一声
// 梦话、录音都是编的（仓库是公开的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render as renderHistory } from '../src/views/history.js';
import { render as renderRecord } from '../src/views/record.js';
import { render as renderImport } from '../src/views/import.js';
import { render as renderSettings } from '../src/views/settings.js';
import { deviceReport } from '../src/core/purge.js';
import { memoryStore } from '../src/core/audioStore.js';
import { REC_DRAFT } from '../src/core/drafts.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, deletedRecord, purgedRecord, goneShas, isTombstone } from '../src/core/store.js';
import { setLang, t } from '../src/i18n.js';
import { toast } from '../src/ui/dom.js';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';

const NN = '\u{1F470}\u{1F3FB}‍♀️';
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
const allCls = (root, c) => all(root, el => cls(el, c));
const btn = (root, label) => find(root, el => el.tag === 'button' && !el.hidden && el.textContent.includes(label));
const raw = (id) => state.getState().data.entries[id];
const sha = (c) => c.repeat(64);
const item = (c, extra = {}) => ({ sha256: sha(c), mime: 'audio/mp4', bytes: 9, durationSec: 4, origName: '', addedAt: 1000, ...extra });
/** 别的设备上删除、再永久删除了这一条（同步进来的样子） */
function purgeElsewhere(id) {
  state.mutate(s => { s.data.entries[id] = deletedRecord(s.data.entries[id]); });
  state.mutate(s => { const e = s.data.entries[id]; s.data.entries[id] = purgedRecord(e, e.updatedAt); }, { cause: 'purge' });
}
// 最小 DOM 里没有的：播放器、录音页要用
Element.prototype.cloneNode = function () { const c = new Element(this.tag); Object.assign(c.attrs, this.attrs); c.className = this.className; c._text = this._text; for (const x of this.children) c.appendChild(x.cloneNode()); return c; };
Element.prototype.setSelectionRange = function (a, b) { this.selectionStart = a; this.selectionEnd = b; };
Element.prototype.blur = function () { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; };
Element.prototype.scrollIntoView = function () {};
const plainQuery = Element.prototype.querySelector;
Element.prototype.querySelector = function (sel) {               // 加上 [data-x="y"]（播放器找「均衡」按钮）
  const m = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(sel || '');
  if (!m) return plainQuery.call(this, sel);
  const k = m[1].replace(/-(\w)/g, (x, c) => c.toUpperCase());
  return find(this, el => el !== this && el.dataset[k] === m[2]) || null;
};
function dom(extra = {}) {
  const d = installDom(extra);
  const make = d.doc.createElement;
  d.doc.createElement = (tag) => { const el = make(tag); el.style.setProperty = (k, v) => { el.style[k] = v; }; return el; };
  return d;
}
/** 照着 app.js 的 ctx 的公共部分：墓碑 ctx.entry 不给、ctx.tombstone 给；给 undoLabel 记进 toasts */
function baseCtx(env) {
  const ctx = {
    t, lang: () => 'zh-Hans', layout: () => 'phone',
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    entry: (id) => { const e = id && raw(id); return e && !isTombstone(e) ? e : null; },
    tombstone: (id) => { const e = id && raw(id); return isTombstone(e) ? e : null; },
    goneShas: () => goneShas(state.getState()), newEntry: (f) => makeEntry(f),
    put(e, opts) { const id = e.id; if (ctx.tombstone(id)) return null; state.mutate(s => { s.data.entries[id] = normalizeEntry(stamp({ ...e, id }, s.data.entries[id]), id); }, opts); if (opts && opts.undoLabel) env.toasts.push({ msg: opts.undoLabel, shell: true }); return ctx.entry(id); },
    update: (id, patch, opts) => (ctx.entry(id) ? ctx.put({ ...ctx.entry(id), ...patch, id }, opts) : null),
    mutate: (fn, opts) => { const r = state.mutate(fn, opts); if (opts && opts.undoLabel) env.toasts.push({ msg: opts.undoLabel, shell: true }); return r; },
    toast: (msg, o = {}) => { env.toasts.push({ msg, ...o }); return { close() {} }; },
    confirm: async (o) => { env.confirms.push(o); return env.answer; },
    back: (p) => env.navs.push('back:' + p), navigate: (p) => env.navs.push(p), guard: () => {},
    on: (ev, fn) => (ev === 'change' ? state.subscribe((s, info) => fn(info)) : () => {}),
  };
  return ctx;
}

// ---------- 修改记录 ----------
test('修改记录「恢复这个版本」：现在的录音都留着；那一版有的——在「移除的录音」里的放回来、本机或云端找得到的补上、找不到的说一声、永久删除了的不放回；看一版时永久删除了的只写一句', async () => {
  const d = dom();
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  const env = { toasts: [], confirms: [], navs: [], answer: true, sheets: [] };
  try {
    // h：现在只有 A；B 在编辑页移除了（removedAudio）；C 的「移除的录音」后来永久删除了（gone 记号）
    state.mutate(s => { s.data.entries.h = makeEntry({ id: 'h', date: '2026-11-04', text: `${NN}“现在的原话”`, audio: [item('a'), item('b'), item('c')] }); });
    state.mutate(s => { s.data.entries.h = { ...s.data.entries.h, audio: [item('a')] }; });                  // 移除 B、C
    state.mutate(s => {
      const e = s.data.entries.h, c = e.removedAudio.find(x => x.sha256 === sha('c'));
      s.data.entries.h = { ...e, removedAudio: e.removedAudio.filter(x => x !== c), gone: [{ sha256: sha('c'), mime: 'audio/mp4', purgedAt: c.removedAt + 5, from: c.removedAt }] };
    }, { cause: 'purge' });
    const old = { ...makeEntry({ id: 'h', date: '2026-11-04', text: `${NN}“以前的原话”`, audio: [item('b', { name: '以前的名字' }), item('c'), item('d'), item('e')] }, 1000), updatedAt: 1000 };
    const ctx = Object.assign(baseCtx(env), {
      history: { list: async () => [{ id: 'v1', entryId: 'h', at: 1000, version: old, cause: 'edit' }], cloud: { session: () => ({ stop() {}, checked: 0 }) } },
      sync: { status: () => ({ on: false }) },
      clipBlob: async (s) => (s === sha('d') ? new Blob(['编的录音 d']) : null),        // D 云端找得到，E 哪儿都没有
      sheet: (content, o = {}) => { const api = { content, foot: o.foot || [], close: () => { if (o.onClose) o.onClose(); } }; env.sheets.push(api); return api; },
    });
    const main = new Element('main');
    const page = renderHistory(main, { name: 'entry', id: 'h', sub: 'history' }, ctx);
    await settle();
    const rows = all(main, el => el.tag === 'button' && cls(el, 'hist-row'));
    assert.equal(rows.length, 2);
    await rows[1].fire('click');                                                        // 看以前那一版
    const sheet = env.sheets.at(-1).content, foot = env.sheets.at(-1).foot;
    assert.deepEqual(allCls(sheet, 'hist-purged').map(x => x.textContent), [t('player.purged')], 'C 只写一句');
    assert.equal(allCls(sheet, 'player').length, 3, 'B、D、E 有播放器');
    assert.equal(foot.length, 1);
    await foot[0].fire('click');
    await settle();
    const h = raw('h');
    assert.deepEqual(h.audio.map(a => a.sha256), [sha('a'), sha('b'), sha('d')], '现在的 A 留着，B 放回来，D 补上');
    assert.ok(h.audio[1].restoredAt > 0, '放回来的盖 restoredAt');
    assert.deepEqual(h.audio.map(a => a.name || null), [null, '以前的名字', null], '名字也换回那一版的');
    assert.equal(h.removedAudio, undefined);
    assert.equal(h.text, `${NN}“以前的原话”`);
    assert.deepEqual(h.gone.map(g => g.sha256), [sha('c')]);
    assert.deepEqual(env.toasts.at(-1).msg.split('\n').slice(1), [t('hist.clipsBack', { n: 2 }), t('hist.clipMissing', { n: 1 }), t('hist.clipPurged', { n: 1 })]);
    page.cleanup();
    // 永久删除了的条目：只说一句，不读这台设备的旧版本
    let listed = 0;
    ctx.history.list = async () => { listed++; return []; };
    purgeElsewhere('h');
    const gone = new Element('main');
    renderHistory(gone, { name: 'entry', id: 'h', sub: 'history' }, ctx);
    await settle();
    assert.equal(byCls(gone, 'empty').textContent, t('entry.purgedNote'));
    assert.equal(listed, 0);
  } finally { d.restore(); }
});

// ---------- 录音页 ----------
/** 假录音机（照着 createRecorder 的接口；stop 时把编的一段存进录音库） */
function fakeRecorder(audio) {
  let o = null, st = 'idle', cur = null, n = 0;
  const set = (s, info) => { st = s; o.onState(s, info); };
  const api = {
    get state() { return st; },
    async start({ attachTo = null } = {}) {
      const r = cur = { recId: 'r_' + (++n), attachTo, startedAt: Date.now() };
      set('requesting', { recId: r.recId });
      await audio.putRecMeta({ recId: r.recId, startedAt: r.startedAt, mime: 'audio/mp4', tz: null, ...(attachTo ? { attachTo } : {}) });
      set('recording', { recId: r.recId });
    },
    async stop({ reason = 'user' } = {}) {
      if (st !== 'recording') return null;
      const r = cur;
      set('stopping', { reason });
      const clip = await audio.putClip(new Blob(['编的录音 ' + r.recId], { type: 'audio/mp4' }), { mime: 'audio/mp4' });
      await audio.putRecMeta({ recId: r.recId, startedAt: r.startedAt, mime: 'audio/mp4', tz: null, done: true, sha256: clip.sha256, bytes: clip.bytes, durationSec: 3 });
      cur = null;
      const res = { ...clip, durationSec: 3, startedAt: r.startedAt, tz: null, recId: r.recId, reason, chunks: 1 };
      set('saved', res);
      return res;
    },
    async discard() {}, elapsedMs: () => 3000, stats: () => null,
  };
  return { create: (opts) => { o = opts; return api; } };
}
function recSetup() {
  const ls = fakeStorage(), d = dom({ localStorage: ls });
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  state.mutate(s => { s.data.entries.x = makeEntry({ id: 'x', date: '2026-11-04', status: 'inbox', text: `${NN}“那条原来的原话”` }); });
  const audio = memoryStore(), F = fakeRecorder(audio);
  const env = { ls, audio, toasts: [], confirms: [], navs: [], answer: true, left: false };
  const ctx = env.ctx = Object.assign(baseCtx(env), { audio, recovered: Promise.resolve([]), sync: { pause: () => () => {}, status: () => ({ on: true }) } });
  const off = state.subscribe((s, info) => queueMicrotask(() => { if (!env.left) env.handle.onChange(info); }));
  env.main = new Element('main');
  env.handle = renderRecord(env.main, { name: 'record', query: { attach: 'x' } }, ctx, { createRecorder: F.create, setTimeout: () => 0, clearTimeout: () => {}, locks: null });
  env.ta = () => find(env.main, el => el.tag === 'textarea');
  env.close = () => { if (!env.left) { env.left = true; env.handle.cleanup(); } off(); d.restore(); };
  return env;
}
const live = () => Object.values(state.getState().data.entries).filter(e => !e.deleted);

test('录音页：录着的时候要接的那条在别的设备上永久删除了——框里预填的旧原话不再存，只把新写的连同录音存成新的一条待整理，提示一句', async () => {
  const env = recSetup();
  try {
    await settle();
    assert.equal(env.ta().value, `${NN}“那条原来的原话”`);
    env.ta().value = `${NN}“那条原来的原话”\n${NN}“新写的一句”`; await env.ta().fire('input');
    await btn(env.main, t('rec.start')).fire('click'); await settle();
    purgeElsewhere('x'); await settle();
    assert.equal(env.ta().value.includes('新写的一句'), true, '正在写：先不动框里的字');
    await find(env.main, el => el.tag === 'button' && cls(el, 'n-stopbar')).fire('click'); await settle();
    const [e] = live();
    assert.equal(live().length, 1);
    assert.notEqual(e.id, 'x');
    assert.deepEqual([e.text, e.status, e.audio.length], [`${NN}“新写的一句”`, 'inbox', 1]);
    assert.deepEqual([raw('x').purged, raw('x').text, raw('x').audio], [true, '', []], '墓碑里什么都没写进去');
    assert.ok(env.toasts.some(x => x.msg === t('rec.targetPurged')));
    const draft = JSON.parse(env.ls.getItem(REC_DRAFT) || 'null');
    assert.ok(!draft || (draft.base !== `${NN}“那条原来的原话”` && draft.target !== 'x'), '草稿里不再有旧原话');
  } finally { env.close(); }
});

test('录音页：在预填的旧原话前面、中间插进去的字也算新写的；旧原话本身改过——字整段放进那条的编辑页草稿（不悄悄丢、也不存回旧原话），提示条能去那里', async () => {
  for (const [typed, want] of [[`${NN}“新写的一句”\n${NN}“那条原来的原话”`, `${NN}“新写的一句”`], [`${NN}“那条原来的原话（她笑了）”`, '（她笑了）']]) {
    const env = recSetup();
    try {
      await settle();
      env.ta().value = typed; await env.ta().fire('input');
      await btn(env.main, t('rec.start')).fire('click'); await settle();
      purgeElsewhere('x'); await settle();
      await find(env.main, el => el.tag === 'button' && cls(el, 'n-stopbar')).fire('click'); await settle();
      assert.deepEqual(live().map(e => [e.text, e.audio.length]), [[want, 1]], typed);
      assert.ok(env.toasts.some(x => x.msg === t('rec.targetPurged')));
    } finally { env.close(); }
  }
  const env = recSetup();
  try {
    await settle();
    const typed = `${NN}“那条原来的原话！”\n${NN}“新写的一句”`;                   // 改了旧原话里的一个字，又接了一句
    env.ta().value = typed; await env.ta().fire('input');
    await btn(env.main, t('rec.start')).fire('click'); await settle();
    purgeElsewhere('x'); await settle();
    await find(env.main, el => el.tag === 'button' && cls(el, 'n-stopbar')).fire('click'); await settle();
    assert.deepEqual(live().map(e => [e.text, e.audio.length]), [['', 1]], '录音照样存成一条，旧原话不存回去');
    assert.equal(JSON.parse(env.ls.getItem('babble.edit.x')).w.text, typed, '字整段放进那条的编辑页草稿');
    const kept = env.toasts.find(x => x.msg === t('rec.targetPurgedKept'));
    assert.ok(kept && kept.action && kept.action.label === t('rec.openEdit'));
    assert.ok(!env.ta().value.includes('那条原来的原话'));
    env.close();
    assert.equal(live().length, 1, '离开时也不另存');
    assert.ok(!(env.ls.getItem(REC_DRAFT) || '').includes('那条原来的原话'));
  } finally { env.close(); }
});

test('录音页：没写新的字时那条永久删除了——框里换回预填的「👰🏻‍♀️ “”」（旧原话不留着），之后录的单独存成一条', async () => {
  const env = recSetup();
  try {
    await settle();
    purgeElsewhere('x'); await settle();
    assert.ok(!env.ta().value.includes('那条原来的原话'), env.ta().value);
    assert.ok(env.toasts.some(x => x.msg === t('rec.targetPurged')));
    await btn(env.main, t('rec.start')).fire('click'); await settle();
    await find(env.main, el => el.tag === 'button' && cls(el, 'n-stopbar')).fire('click'); await settle();
    const [e] = live();
    assert.deepEqual([live().length, e.text, e.audio.length], [1, '', 1]);
    env.close();
    assert.equal(live().length, 1, '离开时也不把旧原话存成一条');
  } finally { env.close(); }
});

// ---------- 从备忘录迁移 ----------
test('从备忘录迁移：以前永久删除过的（同一个 n_ id）算已存在、写「以前永久删除过，跳过」，不再导入；完成页说有几条', async () => {
  const d = dom();
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  const env = { toasts: [], confirms: [], navs: [], answer: true };
  try {
    state.mutate(s => { s.data.entries['n_2024-05-20_1'] = makeEntry({ id: 'n_2024-05-20_1', date: '2024-05-20', text: `${NN}“编的第一句”` }); });
    purgeElsewhere('n_2024-05-20_1');
    const ctx = Object.assign(baseCtx(env), { audio: memoryStore(), takeFiles: () => null, clipBlob: async () => null, sync: { status: () => ({ on: false }) } });
    const main = new Element('main');
    renderImport(main, { name: 'import', sub: 'notes', query: {} }, ctx);
    const ta = find(main, el => el.tag === 'textarea');
    ta.value = ['2024', '', '5/20', `${NN}“编的第一句”`, '', '5/21', `${NN}“编的第二句”`].join('\n'); await ta.fire('input');
    await find(main, el => el.tag === 'button' && cls(el, 'big') && cls(el, 'block')).fire('click'); await settle();
    const fold = find(main, el => el.tag === 'details' && cls(el, 'im-fold') && el.textContent.startsWith(t('imp.r.existsH')));
    assert.ok(fold && fold.textContent.includes(t('imp.r.existsPurged')), fold && fold.textContent);
    await btn(main, t('imp.r.go', { n: 1 })).fire('click'); await settle();
    assert.deepEqual(live().map(e => e.id), ['n_2024-05-21_1']);
    assert.equal(raw('n_2024-05-20_1').purged, true);
    assert.ok(main.textContent.includes(t('imp.r.purged', { n: 1 })), main.textContent);
    assert.ok(!main.textContent.includes(t('imp.r.doneSkipped', { n: 1 })), '不算成「已存在」');
  } finally { d.restore(); }
});

// ---------- 设置 → 同步 ----------
function syncSetup({ purge = false, st = {}, local = {} } = {}) {
  const d = dom();
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  state.setLocal({ device: 'iPhone', who: 'me', deviceId: 'd_this', sync: { repo: 'me/dreams', token: 'x' }, ...local });
  const now = Date.now(), S = state.getState();
  // 同步进来的（不经本机修改：本机改的会签上这台设备）：iPad 报到过；Mac 两天前改过梦话、还没报到
  state.applyRemote({ ...S, data: { ...S.data,
    devices: { d_ipad: { id: 'd_ipad', name: 'iPad', who: 'nn', build: '2026-11-20.1', features: ['purge1'], updatedAt: now - 36e5, seenAt: now - 36e5 } },
    entries: { a: { ...makeEntry({ id: 'a', date: '2026-11-04', text: '编的' }, now - 2 * 864e5), updatedBy: { who: 'me', device: 'Mac', at: now - 2 * 864e5 } } } } });
  const env = { toasts: [], confirms: [], navs: [], answer: true, squashed: 0, stopped: 0,
    st: { on: true, running: false, repo: 'me/dreams', pendingUp: 0, pendingDown: 0, pendingPurge: 0, oldDevices: [], ...st } };
  const ctx = env.ctx = Object.assign(baseCtx(env), {
    device: 'iPhone',
    sync: {
      status: () => env.st, devices: () => deviceReport(state.getState(), { me: 'd_this', self: { name: 'iPhone', who: 'me' }, oldDevices: env.st.oldDevices }),
      historyInfo: async () => ({ commits: 42, branch: 'main', others: [] }), squash: async () => { env.squashed++; return { ok: true, branch: 'main', missing: [] }; },
      stop: () => { env.stopped++; }, now: async () => ({ ok: true }),
    },
  });
  env.main = new Element('main');
  env.handle = renderSettings(env.main, { name: 'settings', sub: 'sync', query: {} }, ctx, { purgeEnabled: purge });
  env.close = () => { env.handle.cleanup(); d.restore(); };
  return env;
}

test('设置 → 同步：「已更新到新版的设备」列出这台（还没报到也算）和报过到的，还有最近改过梦话、没报到的；第一阶段没有「清理云端历史」', async () => {
  const env = syncSetup();
  try {
    await settle();
    const sec = byCls(env.main, 'set-devices');
    assert.equal(find(sec, el => el.tag === 'h2').textContent, t('sync.devicesH'));
    assert.ok(sec.textContent.includes(t('sync.devicesLead')));
    const [upd, wait] = allCls(sec, 'set-dev-list');
    assert.deepEqual(all(upd, el => el.tag === 'li').map(li => byCls(li, 'set-dev-name').textContent), ['🥷🏻 iPhone · ' + t('sync.deviceThis'), '👰🏻‍♀️ NN · iPad'], '读屏时名字和「这台设备」中间隔开');
    assert.ok(all(upd, el => el.tag === 'li')[0].textContent.includes(t('sync.deviceSoon')), '这台还没报到：同步成功一次以后');
    assert.ok(all(upd, el => el.tag === 'li')[1].textContent.includes(t('sync.deviceBuild', { v: '2026-11-20.1' })));
    assert.ok(cls(wait, 'wait'));
    assert.deepEqual(all(wait, el => el.tag === 'li').map(li => byCls(li, 'set-dev-name').textContent), ['🥷🏻 Mac']);
    assert.equal(byCls(env.main, 'set-squash'), undefined);
    assert.ok(env.main.textContent.includes(t('sync.historyNote')));
    assert.ok(!env.main.textContent.includes('清理云端历史'));
  } finally { env.close(); }
});

test('设置 → 同步：都报到了 → 写一句「都报到了」；停止同步时还有没从仓库删掉的录音 → 确认框说一声（开关关着也说）', async () => {
  const env = syncSetup({ st: { pendingPurge: 2 } });
  try {
    const S = state.getState();
    state.applyRemote({ ...S, data: { ...S.data, devices: { ...S.data.devices, d_mac: { id: 'd_mac', name: 'Mac', who: 'me', build: null, features: ['purge1'], updatedAt: Date.now(), seenAt: Date.now() } } } });
    env.handle.onChange({}); await settle();
    assert.equal(byCls(env.main, 'set-dev-ok').textContent, t('sync.devicesAll'));
    assert.ok(env.main.textContent.includes(t('sync.audioDel', { n: 2 })));
    await btn(env.main, t('sync.stop')).fire('click'); await settle();
    assert.equal(env.confirms[0].message, t('sync.stopConfirm') + '\n' + t('sync.stopPending', { n: 2 }));
    assert.equal(env.stopped, 1);
  } finally { env.close(); }
});

test('设置 → 同步（开放以后）：「清理云端历史」——同步没完成时不能点；能点时先确认（说清楚留下什么、没备份），清理完提示', async () => {
  const busy = syncSetup({ purge: true, st: { pendingPurge: 1 } });
  try {
    await settle();
    const card = byCls(busy.main, 'set-squash');
    assert.equal(btn(card, t('sync.squashBtn')).disabled, true);
    assert.ok(card.textContent.includes(t('sync.squashWait')));
    assert.ok(card.textContent.includes(t('sync.squashCount', { n: 42 })));
    assert.ok(busy.main.textContent.includes(t('sync.historyNotePurge')));
  } finally { busy.close(); }
  const env = syncSetup({ purge: true });
  try {
    state.mutate(s => { s.data.entries.b = deletedRecord(makeEntry({ id: 'b', date: '2026-11-03', text: '删掉的' })); });
    env.handle.onChange({}); await settle();
    const card = byCls(env.main, 'set-squash');
    assert.ok(card.textContent.includes(t('sync.noBackup')) && card.textContent.includes(t('sync.backupFirst')));
    await btn(card, t('sync.squashBtn')).fire('click'); await settle();
    const c = env.confirms[0];
    assert.deepEqual([c.title, c.confirmLabel, c.danger], [t('sync.squashConfirmT'), t('sync.squashGo'), true]);
    assert.deepEqual(c.message.split('\n\n').slice(0, 3), [t('sync.squashConfirm', { repo: 'me/dreams' }), t('sync.squashTrash', { n: 1, clips: 0 }), t('sync.squashNoBackup')]);
    assert.ok(c.message.endsWith(t('sync.squashPoints')));
    assert.equal(env.squashed, 1);
    assert.equal(env.toasts.at(-1).msg, t('sync.squashDone'));
  } finally { env.close(); }
});

test('提示条：toast 返回的 close 只关自己那条——之后弹了别的（从备份恢复时「正在同步」期间，合并弹了「存储满了」），不会被它关掉', () => {
  const dom = installDom({ MutationObserver: class { observe() {} disconnect() {} }, getComputedStyle: () => ({ bottom: '24px' }), requestAnimationFrame: () => 0 });
  try {
    const el = () => dom.doc.querySelector('#toast'), on = () => el().classList.contains('on');
    const a = toast(t('set.restoreSyncing'), { ms: 50 });
    assert.ok(on());
    const b = toast(t('common.storageFull'), { ms: 50 });
    a.close();
    assert.ok(on(), '已经不是自己那条了：不关');
    assert.equal(el().textContent, t('common.storageFull'));
    b.close();
    assert.ok(!on(), '自己那条还在显示：关掉');
    b.close();                                           // 再关一次也没事
    const d = toast(t('common.undone'), { ms: 50 });
    b.close();
    assert.ok(on());
    d.close();                                           // 收掉计时器（下面换回没有 DOM 的环境）
    assert.ok(!on());
  } finally { dom.restore(); }
});
