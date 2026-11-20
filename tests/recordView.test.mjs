// 录音页（#/rec）：最小 DOM + 真的 state.js、memoryStore（录音库）+ 照着 core/recorder.js 的接口写的假录音机（不碰麦克风）。
// ✕ 取消（点一下、撤销、到时间删录音；上传过的 / 还有条目在用的不删；App 没了下次找回；10 秒内又点开始 = 那段留下）、
// 「放弃这段录音」的几种情况和撤销（正在同步、撤销时间里传上去了、App 没了下次找回、「再录一段」的回到上一段）、等撤销时拿着 Web Lock、
// 刚存好的先不上传（ctx.sync.pause）每条路都放开（含切到后台）、离开这页（不弹 App 的「撤销」换掉这页的）、收起键盘。
// 撤销的 10 秒、先不上传的 2 分钟用手动的定时器（deps.setTimeout），不靠真的等；navigator.locks 是假的（deps.locks）。
// 录音、原话都是编的（仓库是公开的，没有真的录音和梦话）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, UNDO_MS, FRESH_MS } from '../src/views/record.js';
import { deletedEntries } from '../src/views/deleted.js';
import { memoryStore } from '../src/core/audioStore.js';
import { recoverPending } from '../src/core/recorder.js';
import { applyRecovery, readDraft, REC_DRAFT } from '../src/core/drafts.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, canon } from '../src/core/store.js';
import { setLang, t } from '../src/i18n.js';
import { Element, find, fakeStorage, installDom } from './helpers/dom.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));
/** 等到 cond() 成立（假录音机、录音库都是异步的） */
async function until(cond, what = '') { for (let i = 0; i < 200 && !cond(); i++) await tick(); assert.ok(cond(), what); }
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const NN = '\u{1F470}\u{1F3FB}‍♀️';
const SAID = `${NN}“编的一句梦话”`;
const DUR = { dur: '0:03' };
// 文本框要用的（最小 DOM 里没有）
Element.prototype.setSelectionRange = function (a, b) { this.selectionStart = a; this.selectionEnd = b; };
Element.prototype.blur = function () { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; };

/** 手动定时器：run(ms) 让这个时长的都到点；count(ms) 还有几个 */
function fakeTimers() {
  let n = 0;
  const live = new Map();
  return {
    setTimeout: (fn, ms) => { live.set(++n, { fn, ms }); return n; },
    clearTimeout: (id) => { live.delete(id); },
    run(ms) { for (const [id, x] of [...live]) if (x.ms === ms) { live.delete(id); x.fn(); } },
    count: (ms) => [...live.values()].filter(x => x.ms === ms).length,
  };
}

/** 假录音机：状态、回调照着 createRecorder；stop 时把编的一段存成 clip（recMeta 标 done、删分片，和真的一样），恢复记录留给页面清 */
function fakeRecorder(audio) {
  let o = null, st = 'idle', cur = null, n = 0, lastMs = 0;
  const set = (s, info) => { st = s; o.onState(s, info); };
  const api = {
    get state() { return st; },
    async start({ attachTo = null } = {}) {
      if (st === 'requesting' || st === 'recording' || st === 'stopping') return;
      const r = cur = { recId: 'r_' + (++n), attachTo, startedAt: Date.now() };
      F.starts.push(attachTo);
      set('requesting', { recId: r.recId });
      await audio.putRecMeta({ recId: r.recId, startedAt: r.startedAt, mime: 'audio/mp4', tz: null, ...(attachTo ? { attachTo } : {}) });
      await audio.putChunk(r.recId, 0, new Blob(['编的录音 ' + r.recId]));
      if (cur === r) set('recording', { recId: r.recId });
    },
    async stop({ reason = 'user' } = {}) {
      if (st === 'requesting') { const r = cur; cur = null; await audio.clearRec(r.recId); set('idle', { discarded: true }); return null; }
      if (st !== 'recording') return null;
      const r = cur;
      set('stopping', { reason });
      await tick();
      const clip = await audio.putClip(new Blob(['编的录音 ' + r.recId], { type: 'audio/mp4' }), { mime: 'audio/mp4' });
      const durationSec = F.dur;
      await audio.putRecMeta({ recId: r.recId, startedAt: r.startedAt, mime: 'audio/mp4', tz: null, done: true, sha256: clip.sha256, bytes: clip.bytes, durationSec });
      await audio.clearChunks(r.recId);
      cur = null; lastMs = durationSec * 1000;
      const res = { ...clip, durationSec, startedAt: r.startedAt, tz: null, ...(r.attachTo ? { attachTo: r.attachTo } : {}), recId: r.recId, reason, chunks: 1 };
      F.saved.push(res);
      set('saved', res);
      return res;
    },
    async discard() { F.discards++; },
    elapsedMs: () => lastMs,
    stats: () => (cur ? { recId: cur.recId, wakeLock: true } : null),
  };
  const F = { dur: 3, starts: [], saved: [], discards: 0, create: (opts) => { o = opts; return api; } };
  return F;
}

/** 假 navigator.locks：held 里是拿着的锁（query 照着真的返回 { held: [{ name }] }） */
function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      held.add(name);
      return Promise.resolve().then(() => cb({ name })).finally(() => held.delete(name));
    },
    async query() { return { held: [...held].map(name => ({ name })), pending: [] }; },
  };
}

/** 假 ctx（照着 app.js：put / update / mutate 走真的 state，给 undoLabel 就弹 App 自己的「撤销」提示条；sync.pause 记下暂停了几个，sync.status 看 env.syncSt） */
function setup({ recOnly = false, attach = null, entries = [], lang = 'zh-Hans' } = {}) {
  const ls = fakeStorage();
  const dom = installDom({ localStorage: ls });
  const make = dom.doc.createElement;
  dom.doc.createElement = (tag) => { const el = make(tag); el.style.setProperty = (k, v) => { el.style[k] = v; }; return el; };
  setLang(lang);
  state.load({ storage: fakeStorage(), locks: null });
  state.setLocal({ recOnly });
  if (entries.length) state.mutate(s => { for (const e of entries) s.data.entries[e.id] = e; });
  const audio = memoryStore(), F = fakeRecorder(audio), T = fakeTimers(), locks = fakeLocks();
  const toasts = [], navs = [], holds = { n: 0, max: 0, double: 0, log: [] };
  const env = { ...dom, ls, audio, F, T, locks, toasts, navs, holds, left: false, syncSt: { running: false, uploading: false } };
  const appToast = (opts) => { if (opts && opts.undoLabel) toasts.push({ msg: opts.undoLabel, fromApp: true, ms: 10000, action: { label: t('common.undo'), run: () => {} } }); };
  const ctx = env.ctx = {
    t, lang: () => lang,
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    entry: (id) => (id && state.getState().data.entries[id]) || null, newEntry: (f) => makeEntry(f),
    put(e, opts) { const id = e.id; state.mutate(s => { s.data.entries[id] = normalizeEntry(stamp({ ...e, id }, s.data.entries[id]), id); }, opts); appToast(opts); return ctx.entry(id); },
    update: (id, patch, opts) => (ctx.entry(id) ? ctx.put({ ...ctx.entry(id), ...patch, id }, opts) : null),
    mutate: (fn, opts) => { const r = state.mutate(fn, opts); appToast(opts); return r; },
    on: (ev, fn) => (ev === 'change' ? state.subscribe((s, info) => fn(info)) : () => {}),
    audio, recovered: Promise.resolve([]),
    sync: { pause(tag) {
      holds.n++; holds.max = Math.max(holds.max, holds.n); holds.log.push('pause:' + tag);
      let on = true;
      return () => { if (!on) { holds.double++; return; } on = false; holds.n--; holds.log.push('resume:' + tag); };
    }, status: () => ({ on: true, ...env.syncSt }) },
    toast: (msg, o = {}) => { toasts.push({ msg, ...o }); return { close() {} }; },
    navigate: (p) => navs.push(p), back: (p) => navs.push('back:' + p),
  };
  const off = state.subscribe((s, info) => queueMicrotask(() => { if (!env.left) env.handle.onChange(info); }));
  env.main = new Element('main');
  env.handle = render(env.main, { name: 'record', query: attach ? { attach } : {} }, ctx, { createRecorder: F.create, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, locks });
  env.leave = () => { if (!env.left) { env.left = true; env.handle.cleanup(); } };
  env.close = () => { env.leave(); off(); dom.restore(); };
  return env;
}
const btn = (env, label) => find(env.main, el => el.tag === 'button' && !el.hidden && el.textContent.includes(label));
const byCls = (env, c) => find(env.main, el => cls(el, c) && !el.hidden);
const phase = (env) => find(env.main, el => cls(el, 'night')).dataset.phase;
const textBox = (env) => find(env.main, el => el.tag === 'textarea');
const lastToast = (env) => env.toasts[env.toasts.length - 1];
const all = () => Object.values(state.getState().data.entries);
const live = () => all().filter(e => !e.deleted);
const entry = (id) => state.getState().data.entries[id];
const shas = (e) => e.audio.map(a => a.sha256);
async function startRec(env) { await btn(env, t('rec.start')).fire('click'); await until(() => phase(env) === 'recording', '在录'); }
async function again(env) { await btn(env, t('rec.again')).fire('click'); await until(() => phase(env) === 'recording', '再录一段'); }
async function stopRec(env) {
  await find(env.main, el => el.tag === 'button' && (cls(el, 'n-stop') || cls(el, 'n-stopbar'))).fire('click');
  await until(() => phase(env) === 'saved', '已保存');
}
/** ✕；to：取消完回到哪一屏（开始前 idle，从「已保存」点的「再录一段」→ saved） */
async function cancel(env, to = 'idle') {
  const n = env.toasts.length;
  await byCls(env, 'n-discard').fire('click');
  await until(() => env.toasts.length > n && phase(env) === to, '取消完回到 ' + to);
}
async function drop(env, to = 'idle') {
  const n = env.toasts.length;
  await btn(env, t('rec.drop')).fire('click');
  await until(() => env.toasts.length > n && phase(env) === to, '丢掉以后回到 ' + to);
}
const REC_LOCK = 'babble-rec:';
async function type(env, text) { const ta = textBox(env); ta.value = text; await ta.fire('input'); }

test('「已保存」：「稍后整理」一直在；「整理好了」写了字才出现，删光了又藏起来；「放弃这段录音」在下面那一行', async () => {
  const env = setup();
  try {
    await tick();
    await startRec(env); await stopRec(env);
    assert.ok(btn(env, t('rec.later')), '有「稍后整理」');
    assert.equal(btn(env, t('entry.done')), undefined, '还没写字：没有「整理好了」');
    assert.ok(byCls(env, 'n-wfoot').contains(btn(env, t('rec.drop'))), '放弃在下面那一行');
    await type(env, SAID);
    assert.ok(btn(env, t('entry.done')), '写了字：出现「整理好了」');
    await type(env, '');
    assert.equal(btn(env, t('entry.done')), undefined, '字删光了：又藏起来');
    await type(env, SAID);
    await btn(env, t('rec.later')).fire('click');
    const [e] = all();
    assert.deepEqual([e.status, e.text], ['inbox', SAID], '稍后整理：字存进去、还在待整理');
  } finally { env.close(); }
});

test('✕ 点一下就取消：不建条目、回到开始前，写的字还在框里；撤销 = 点了停止（建条目、回到「已保存」），撤销了就不再删录音', async () => {
  const env = setup();
  try {
    await tick();
    await startRec(env);
    await type(env, SAID);
    const x = byCls(env, 'n-discard');
    assert.equal(x.attrs['aria-label'], t('rec.cancelAria'));
    assert.equal(x.attrs.title, t('rec.cancelAria'));
    assert.equal(x.textContent, '', '边录边写：只有 ✕');
    const clicked = x.fire('click');
    assert.equal(phase(env), 'stopping');
    assert.ok(env.main.textContent.includes(t('rec.cancelling')), '停下的那一会儿写「正在取消…」');
    await clicked; await until(() => phase(env) === 'idle');
    assert.equal(all().length, 0, '不建条目');
    assert.ok(btn(env, t('rec.start')), '回到点「开始录音」之前');
    assert.equal(textBox(env).value, SAID, '写的字还在框里');
    assert.equal(env.F.discards, 0, '录音机照常停下存好，不是丢弃');
    const sha = env.F.saved[0].sha256;
    assert.ok(env.audio.clips.has(sha) && env.audio.recMeta.has('r_1'), '撤销之前录音、恢复记录都留着');
    const tt = lastToast(env);
    assert.equal(tt.msg, t('rec.cancelled', DUR));
    assert.equal(tt.ms, UNDO_MS);
    assert.equal(tt.action.label, t('common.undo'));
    assert.equal(env.T.count(UNDO_MS), 1);
    assert.equal(readDraft(env.ls, REC_DRAFT).rec, 'r_1', '草稿指着取消的这段（App 没了，字和它放进同一条）');
    assert.equal(env.holds.max, 0, '没存进条目：不用暂停同步');

    tt.action.run();
    assert.equal(phase(env), 'saved');
    const [e] = all();
    assert.deepEqual(shas(e), [sha]);
    assert.equal(e.text, SAID);
    assert.equal(e.status, 'inbox');
    assert.equal(env.holds.n, 1, '存进条目了：先不上传');
    await until(() => !env.audio.recMeta.has('r_1'), '条目存好了才清恢复记录');
    assert.equal(env.T.count(UNDO_MS), 0);
    assert.ok(env.audio.clips.has(sha), '撤销了：不会再删');
    assert.equal(readDraft(env.ls, REC_DRAFT), null, '字已经在条目里');
    env.leave();
    assert.equal(env.holds.n, 0);
  } finally { env.close(); }
});

test('只录音：✕ 旁边写「取消」；没撤销 → 时间过了删掉录音和恢复记录，什么也不留；过了再点撤销也不做什么', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env);
    const x = byCls(env, 'n-discard');
    assert.ok(x.textContent.includes(t('common.cancel')));
    assert.equal(x.attrs['aria-label'], t('rec.cancelAria'));
    await cancel(env);
    const sha = env.F.saved[0].sha256, undo = lastToast(env);
    env.T.run(UNDO_MS);
    await until(() => !env.audio.clips.has(sha) && !env.audio.recMeta.has('r_1'), '录音、恢复记录都删了');
    assert.equal(all().length, 0);
    assert.equal(env.holds.max, 0);
    undo.action.run();
    assert.equal(all().length, 0);
    assert.equal(phase(env), 'idle');
  } finally { env.close(); }
});

test('✕ 取消：等撤销时已经上传了 / 有条目（含已删除的）在用这段 → 录音不删，恢复记录照样清', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await cancel(env);
    const a = env.F.saved[0].sha256;
    await env.audio.markUploaded(a);
    env.T.run(UNDO_MS);
    await until(() => !env.audio.recMeta.has('r_1'));
    assert.ok(env.audio.clips.has(a), '上传过的不删');
    await startRec(env); await cancel(env);
    const b = env.F.saved[1].sha256;
    state.mutate(s => { s.data.entries.e_ref = makeEntry({ id: 'e_ref', deleted: true, deletedAt: 1, audio: [{ sha256: b, mime: 'audio/mp4' }] }); });
    env.T.run(UNDO_MS);
    await until(() => !env.audio.recMeta.has('r_2'));
    assert.ok(env.audio.clips.has(b), '最近删除里的那条还在用：不删');
  } finally { env.close(); }
});

test('✕ 取消以后 10 秒内 App 没了：下次启动当成没收尾的录音放回「待整理」，框里的字放进同一条', async () => {
  const env = setup();
  try {
    await tick();
    await type(env, SAID);
    await startRec(env); await cancel(env);
    const sha = env.F.saved[0].sha256, draft = readDraft(env.ls, REC_DRAFT);
    assert.equal(draft.rec, 'r_1');
    assert.equal(draft.text, SAID);
    // App 被杀掉：页面不再收尾、定时器不会到点。下次启动照 app.js 的 recover() 走一遍
    const clips = await recoverPending({ audioStore: env.audio, before: Date.now() + 1000, locks: null });
    assert.deepEqual(clips.map(c => [c.sha256, c.recId]), [[sha, 'r_1']]);
    const res = state.mutate(s => applyRecovery(s, clips, { rec: draft }));
    assert.equal(res.clips, 1);
    const [e] = all();
    assert.equal(e.status, 'inbox');
    assert.equal(e.text, SAID);
    assert.deepEqual(shas(e), [sha]);
  } finally { env.close(); }
});

test('「放弃这段录音」：这页刚建、只有这一段、没写字 → 整条丢掉（最近删除里也没有），回到开始录音前；时间过了删录音、放开同步', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    assert.deepEqual(env.holds.log, ['pause:rec-fresh']);
    const [e0] = all(), sha = env.F.saved[0].sha256;
    const d = btn(env, t('rec.drop'));
    assert.ok(cls(d, 'n-drop') && cls(d, 'n-link') && !cls(d, 'main'), '不是主按钮：安静的链接');
    assert.ok(!byCls(env, 'n-acts').contains(d), '不在上面那排按钮里');
    assert.ok(btn(env, t('rec.later')), '有「稍后整理」');
    await drop(env);
    const e = entry(e0.id);
    assert.equal(e.deleted, true);
    assert.equal(e.discarded, true);
    assert.deepEqual(e.audio, []);
    assert.deepEqual(deletedEntries(state.getState()), [], '最近删除里不显示');
    assert.equal(lastToast(env).msg, t('rec.dropped', DUR));
    assert.equal(lastToast(env).action.label, t('common.undo'));
    assert.ok(btn(env, t('rec.start')), '回到开始录音前');
    assert.ok(env.audio.clips.has(sha), '撤销时间里录音还在');
    assert.equal(env.holds.n, 1, '撤销时间里还暂停着');
    env.T.run(UNDO_MS);
    await until(() => !env.audio.clips.has(sha), '时间过了删录音');
    assert.equal(env.holds.n, 0, '撤销时间过了：放开');
    // 接着录：新建一条（不接到丢掉的那条）
    await startRec(env);
    assert.equal(env.F.starts[1], null);
    await stopRec(env);
    assert.equal(live().length, 1);
    assert.notEqual(live()[0].id, e0.id);
    env.leave();
    assert.equal(env.holds.n, 0);
    assert.deepEqual(env.holds.log, ['pause:rec-fresh', 'resume:rec-fresh', 'pause:rec-fresh', 'resume:rec-fresh']);
    assert.equal(env.holds.double, 0);
  } finally { env.close(); }
});

test('「放弃这段录音」：接到已有的一条 → 只从那条里拿掉这一段（别的录音留着）；撤销放回原来的位置；再录还是接到那一条', async () => {
  const old = 'a'.repeat(64);
  const E = makeEntry({ id: 'e_old', date: '2026-11-04', status: 'inbox', audio: [{ sha256: old, mime: 'audio/mp4', durationSec: 5 }] });
  const env = setup({ recOnly: true, attach: 'e_old', entries: [E] });
  try {
    await startRec(env);
    assert.equal(env.F.starts[0], 'e_old');
    await stopRec(env);
    const s1 = env.F.saved[0].sha256;
    assert.deepEqual(shas(entry('e_old')), [old, s1]);
    await drop(env);
    assert.ok(!entry('e_old').deleted);
    assert.deepEqual(shas(entry('e_old')), [old]);
    assert.equal(lastToast(env).msg, t('rec.dropped', DUR));
    env.T.run(UNDO_MS);
    await until(() => !env.audio.clips.has(s1), '没有条目在用了：删');
    await startRec(env);
    assert.equal(env.F.starts[1], 'e_old');
    await stopRec(env);
    const s2 = env.F.saved[1].sha256;
    await drop(env);
    lastToast(env).action.run();
    assert.equal(phase(env), 'saved');
    assert.deepEqual(shas(entry('e_old')), [old, s2]);
    env.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env.audio.clips.has(s2));
  } finally { env.close(); }
});

test('「放弃这段录音」：写了字 → 条目留着、只拿掉录音，提示「写的字还在」；框里刚写、还没存进条目的字也算', async () => {
  const env = setup();
  try {
    await startRec(env);
    await type(env, SAID);
    await stopRec(env);
    const [e0] = all(), s1 = env.F.saved[0].sha256;
    assert.equal(e0.text, SAID);
    const row = byCls(env, 'n-acts-row'), d = btn(env, t('rec.drop'));
    assert.ok(!row.contains(d) && byCls(env, 'n-wfoot').contains(d), '边录边写：在下面那一行（和去编辑页、只录音一起）');
    assert.ok(btn(env, t('entry.done')) && btn(env, t('rec.later')), '写了字：有「整理好了」和「稍后整理」');
    await drop(env);
    const e = entry(e0.id);
    assert.ok(!e.deleted);
    assert.equal(e.text, SAID);
    assert.deepEqual(e.audio, []);
    assert.equal(lastToast(env).msg, t('rec.droppedText'));
    assert.equal(textBox(env).value, SAID);
    env.T.run(UNDO_MS);
    await until(() => !env.audio.clips.has(s1));
  } finally { env.close(); }
  const env2 = setup();
  try {
    await startRec(env2); await stopRec(env2);
    const [e0] = all();
    assert.equal(e0.text, '');
    await type(env2, SAID);                         // 存好以后接着写的（还在框里，离开时才存进条目）
    await drop(env2);
    assert.ok(!entry(e0.id).deleted);
    assert.deepEqual(entry(e0.id).audio, []);
    assert.equal(lastToast(env2).msg, t('rec.droppedText'));
    env2.leave();
    assert.equal(entry(e0.id).text, SAID, '离开时字存进那一条');
    assert.equal(live().length, 1);
  } finally { env2.close(); }
});

test('「放弃这段录音」：已经上传过 → 照常软删除（进最近删除，带着录音）/ 照常拿掉；本机的录音都不删；查不到算上传过', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    const [e0] = all(), s1 = env.F.saved[0].sha256;
    await env.audio.markUploaded(s1);
    await drop(env);
    const e = entry(e0.id);
    assert.equal(e.deleted, true);
    assert.equal(e.discarded, undefined);
    assert.deepEqual(shas(e), [s1]);
    assert.deepEqual(deletedEntries(state.getState()).map(x => x.id), [e0.id]);
    assert.equal(lastToast(env).msg, t('rec.droppedDeleted'));
    env.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env.audio.clips.has(s1));
    // 录音库读不出来：当成上传过
    await startRec(env); await stopRec(env);
    const e1 = live()[0];
    env.audio.getClip = async () => { throw new Error('读不出来'); };
    await drop(env);
    assert.equal(entry(e1.id).deleted, true);
    assert.equal(entry(e1.id).discarded, undefined);
    env.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env.audio.clips.has(env.F.saved[1].sha256));
  } finally { env.close(); }
  const E = makeEntry({ id: 'e_old', date: '2026-11-04', status: 'inbox', text: SAID });
  const env2 = setup({ recOnly: true, attach: 'e_old', entries: [E] });
  try {
    await startRec(env2); await stopRec(env2);
    const s1 = env2.F.saved[0].sha256;
    await env2.audio.markUploaded(s1);
    await drop(env2);
    assert.deepEqual(entry('e_old').audio, []);
    assert.ok(!entry('e_old').deleted);
    assert.equal(lastToast(env2).msg, t('rec.droppedText'));
    env2.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env2.audio.clips.has(s1));
  } finally { env2.close(); }
});

test('撤销「放弃这段录音」：换回原来那条（一模一样）、回到「已保存」；录音不删；还暂停着；离开以后时间到了照样删、不再碰同步', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    const [before] = all(), s1 = env.F.saved[0].sha256;
    await drop(env);
    lastToast(env).action.run();
    assert.equal(phase(env), 'saved');
    const after = entry(before.id);
    const strip = ({ updatedAt, updatedBy, ...r }) => r;
    assert.equal(canon(strip(after)), canon(strip(before)));
    assert.ok(after.updatedAt > before.updatedAt, '修改时间更新（同步时盖过删除）');
    env.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env.audio.clips.has(s1));
    assert.equal(env.holds.n, 1);
    await drop(env);                                // 又能「放弃这段录音」：还是整条丢掉
    assert.equal(entry(before.id).discarded, true);
    env.leave();
    assert.equal(env.holds.n, 0, '离开就放开');
    env.T.run(UNDO_MS);
    await until(() => !env.audio.clips.has(s1), '离开以后时间到了照样删录音');
    assert.equal(env.holds.n, 0);
    assert.equal(env.holds.max, 1);
    assert.equal(env.holds.double, 0);
  } finally { env.close(); }
});

test('刚存好的先不上传：同时只暂停一个；再存一段重新算 2 分钟；到点放开；离开两次也不多放', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    assert.equal(env.holds.n, 1);
    assert.equal(env.T.count(FRESH_MS), 1);
    await again(env); await stopRec(env);
    assert.equal(env.holds.max, 1);
    assert.equal(env.T.count(FRESH_MS), 1, '重新计时（旧的取消了）');
    env.T.run(FRESH_MS);
    assert.equal(env.holds.n, 0);
    assert.deepEqual(env.holds.log, ['pause:rec-fresh', 'resume:rec-fresh']);
    env.leave();
    env.handle.cleanup();
    assert.equal(env.holds.n, 0);
    assert.equal(env.holds.double, 0);
  } finally { env.close(); }
});

test('撤销时间过了放开同步；那以后又存了新的一段就接着暂停（等它的 2 分钟）；取消以后回到的是「已保存」→ 照样等 2 分钟', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);       // A
    await drop(env);
    await startRec(env); await stopRec(env);       // B：又存了一段
    env.T.run(UNDO_MS);                            // A 的撤销时间过了
    assert.equal(env.holds.n, 1, 'B 还要等');
    await again(env); await cancel(env, 'saved');  // C：录了又取消，回到 B 的「已保存」（还能「放弃这段录音」）
    env.T.run(UNDO_MS);
    assert.equal(env.holds.n, 1, 'B 那屏又回来了：还等着');
    assert.equal(env.T.count(FRESH_MS), 1);
    env.T.run(FRESH_MS);
    assert.equal(env.holds.n, 0);
    assert.equal(env.holds.max, 1);
    assert.equal(env.holds.double, 0);
  } finally { env.close(); }
});

test('离开这页时还在录：照常存好建条目、提示「已保存」，不暂停同步', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env);
    env.leave();
    await until(() => all().length === 1);
    assert.equal(lastToast(env).msg, t('rec.savedAway', DUR));
    assert.deepEqual(shas(all()[0]), [env.F.saved[0].sha256]);
    assert.equal(env.holds.max, 0);
    await until(() => !env.audio.recMeta.has('r_1'));
  } finally { env.close(); }
});

test('✕ 取消以后离开（写的字存成一条，不弹 App 的「撤销」免得换掉这条提示），再在提示条上撤销：录音接到那一条、提示「已保存」，不暂停同步', async () => {
  const env = setup();
  try {
    await startRec(env); await type(env, SAID); await cancel(env);
    const undo = lastToast(env), n = env.toasts.length;
    assert.equal(undo.msg, t('rec.cancelled', DUR));
    env.leave();
    const [e] = live();
    assert.equal(e.text, SAID);
    assert.deepEqual(e.audio, []);
    assert.equal(env.toasts.length, n, '离开时没有别的提示条换掉「取消了这段录音 · 撤销」');
    assert.ok(!env.toasts.some(x => x.fromApp));
    undo.action.run();
    assert.equal(lastToast(env).msg, t('rec.savedAway', DUR));
    assert.deepEqual(shas(entry(e.id)), [env.F.saved[0].sha256]);
    assert.equal(live().length, 1);
    assert.equal(env.holds.max, 0);
    env.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env.audio.clips.has(env.F.saved[0].sha256));
  } finally { env.close(); }
  // 没在等撤销：写了字就离开 → 照常弹 App 的「写的字已存进「待整理」· 撤销」
  const env2 = setup();
  try {
    await tick();
    await type(env2, SAID);
    env2.leave();
    assert.equal(lastToast(env2).msg, t('rec.textSaved'));
    assert.ok(lastToast(env2).fromApp);
  } finally { env2.close(); }
});

test('✕ 点错了（她还在说）、10 秒内又点「开始录音」：取消的那段留下（= 撤销），接着录的接在同一条；那段不会在录的时候被删', async () => {
  for (const recOnly of [false, true]) {
    const env = setup({ recOnly });
    try {
      await tick();
      env.F.dur = 45;
      await startRec(env); await cancel(env);
      const undo = lastToast(env), a = env.F.saved[0].sha256;
      assert.equal(undo.msg, t('rec.cancelled', { dur: '0:45' }));
      assert.equal(all().length, 0);
      env.F.dur = 3;
      await startRec(env);
      const [e] = live();
      assert.deepEqual(shas(e), [a], '一开始录就把取消的那段存进条目');
      assert.equal(lastToast(env).msg, t('rec.cancelKept', { dur: '0:45' }));
      assert.equal(env.F.starts[1], e.id, '接着录的接到同一条');
      assert.equal(env.T.count(UNDO_MS), 0, '不再等着删它');
      undo.action.run();                           // 旧提示条上的撤销：已经留下了，什么也不做
      assert.equal(live().length, 1);
      assert.equal(phase(env), 'recording');
      env.T.run(UNDO_MS);
      await tick(); await tick();
      assert.ok(env.audio.clips.has(a), '录着下一段的时候没删');
      await until(() => !env.audio.recMeta.has('r_1'), '条目存好了：恢复记录清掉');
      await stopRec(env);
      assert.deepEqual(shas(entry(e.id)), env.F.saved.map(s => s.sha256));
      assert.equal(live().length, 1);
      assert.equal(env.holds.max, 1);
      env.leave();
      assert.equal(env.holds.n, 0);
    } finally { env.close(); }
  }
});

test('留下了的那段 + 接着录的这段又点 ✕：回到留下那段的「已保存」；这段照常能撤销 / 到时间删', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await cancel(env);        // A：点错的 ✕
    await startRec(env);                           // 又开始：A 留下
    const [e] = live(), [a] = env.F.saved.map(s => s.sha256);
    await cancel(env, 'saved');                    // B：这次真不要
    const b = env.F.saved[1].sha256;
    assert.ok(btn(env, t('rec.drop')), '回到 A 的「已保存」（还能「放弃这段录音」）');
    assert.ok(env.main.textContent.includes(t('rec.savedInbox')));
    assert.deepEqual(shas(entry(e.id)), [a]);
    assert.equal(lastToast(env).msg, t('rec.cancelled', DUR));
    env.T.run(UNDO_MS);
    await until(() => !env.audio.clips.has(b), 'B 删了');
    assert.ok(env.audio.clips.has(a), 'A 留着');
  } finally { env.close(); }
});

test('上一段（放弃这段录音）还在等撤销时又取消一段：上一段马上收尾（它的提示条被换掉了，撤销不了）', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);       // A
    const [e0] = all();
    await drop(env);
    const first = lastToast(env);
    await startRec(env);
    assert.equal(env.F.starts[1], null, '放弃这段录音不是点错的 ✕：不会自己留下');
    await cancel(env);
    const [a, b] = env.F.saved.map(s => s.sha256);
    await until(() => !env.audio.clips.has(a), '上一段删了');
    assert.ok(env.audio.clips.has(b));
    assert.equal(env.T.count(UNDO_MS), 1);
    first.action.run();
    assert.equal(entry(e0.id).discarded, true, '换掉的提示条上的撤销不算数');
    assert.equal(live().length, 0);
  } finally { env.close(); }
});

test('「放弃这段录音」整条丢掉时正在同步（可能正在传这段）→ 当成传上去了：照常软删除、带着录音、不删；撤销时间里传上去了 → 换回平常的删除（进最近删除），录音不删；只拿掉一段的到时间再看', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    const [e0] = all(), s1 = env.F.saved[0].sha256;
    env.syncSt.uploading = true;
    await drop(env);
    assert.equal(entry(e0.id).deleted, true);
    assert.equal(entry(e0.id).discarded, undefined);
    assert.deepEqual(shas(entry(e0.id)), [s1]);
    assert.equal(lastToast(env).msg, t('rec.droppedDeleted'));
    assert.ok(!env.audio.recMeta.has('r_1'), '不写恢复记录（录音就在那条里）');
    env.T.run(UNDO_MS);
    await tick(); await tick();
    assert.ok(env.audio.clips.has(s1));
    env.syncSt.uploading = false;
    // 丢掉时没在同步，撤销时间里传上去了（比如别的标签页正好在传）
    await startRec(env); await stopRec(env);
    const e1 = live()[0], s2 = env.F.saved[1].sha256;
    await drop(env);
    assert.equal(entry(e1.id).discarded, true);
    await env.audio.markUploaded(s2);
    env.T.run(UNDO_MS);
    await until(() => !entry(e1.id).discarded, '换回平常的删除');
    assert.equal(entry(e1.id).deleted, true);
    assert.deepEqual(shas(entry(e1.id)), [s2], '带着录音（仓库里的录音有条目指着）');
    assert.ok(deletedEntries(state.getState()).some(x => x.id === e1.id), '最近删除里看得见');
    await until(() => !env.audio.recMeta.has('r_2'));
    assert.ok(env.audio.clips.has(s2), '本机的不删');
  } finally { env.close(); }
  // 只拿掉一段的（接到已有的一条）：正在同步也照常拿掉、写回恢复记录；时间过了看传上去没有——没传就删，传上去了就不删本机的
  const old = 'a'.repeat(64);
  const E = makeEntry({ id: 'e_old', date: '2026-11-04', status: 'inbox', audio: [{ sha256: old, mime: 'audio/mp4', durationSec: 5 }] });
  const env2 = setup({ recOnly: true, attach: 'e_old', entries: [E] });
  try {
    await startRec(env2); await stopRec(env2);
    const s1 = env2.F.saved[0].sha256;
    env2.syncSt.running = true;
    await drop(env2);
    assert.deepEqual(shas(entry('e_old')), [old]);
    assert.ok(env2.audio.recMeta.has('r_1'));
    env2.syncSt.running = false;
    env2.T.run(UNDO_MS);
    await until(() => !env2.audio.clips.has(s1) && !env2.audio.recMeta.has('r_1'), '没传上去：删');
    await startRec(env2); await stopRec(env2);
    const s2 = env2.F.saved[1].sha256;
    await drop(env2);
    await env2.audio.markUploaded(s2);              // 撤销时间里传上去了
    env2.T.run(UNDO_MS);
    await until(() => !env2.audio.recMeta.has('r_2'));
    assert.ok(env2.audio.clips.has(s2), '传上去了：本机的不删');
    assert.deepEqual(shas(entry('e_old')), [old]);
  } finally { env2.close(); }
});

test('「放弃这段录音」以后 10 秒内 App 没了：整条丢掉的回到「待整理」（字和它放进同一条），接上的回到原来那条——和 ✕ 一样宁可多留', async () => {
  const env = setup();
  try {
    await tick();
    await startRec(env); await stopRec(env);
    const [e0] = all(), s1 = env.F.saved[0].sha256;
    assert.ok(!env.audio.recMeta.has('r_1'), '存进条目以后恢复记录清掉了');
    await drop(env);
    assert.equal(entry(e0.id).discarded, true);
    const meta = await env.audio.getRecMeta('r_1');
    assert.ok(meta && meta.done && meta.sha256 === s1 && meta.attachTo === e0.id, '恢复记录写回去了');
    await type(env, SAID);                          // 丢掉以后又写了几句
    await window.fire('pagehide');                  // 被关掉之前：草稿马上另存
    const draft = readDraft(env.ls, REC_DRAFT);
    assert.equal(draft.rec, 'r_1', '草稿指着丢掉的这段');
    assert.equal(draft.target, null);
    // 等撤销的时候别的标签页启动：锁拿着，不会把它找回去
    assert.ok(env.locks.held.has(REC_LOCK + 'r_1'));
    assert.deepEqual(await recoverPending({ audioStore: env.audio, before: Date.now() + 1000, locks: env.locks }), []);
    // App 被杀掉（锁没了、定时器不会到点）：下次启动照 app.js 的 recover() 走一遍
    const clips = await recoverPending({ audioStore: env.audio, before: Date.now() + 1000, locks: null });
    assert.deepEqual(clips.map(c => c.sha256), [s1]);
    state.mutate(s => applyRecovery(s, clips, { rec: draft }));
    const [e] = live();
    assert.notEqual(e.id, e0.id);
    assert.equal(e.status, 'inbox');
    assert.equal(e.text, SAID);
    assert.deepEqual(shas(e), [s1]);
    assert.deepEqual(deletedEntries(state.getState()), [], '丢掉的那条照样不显示');
  } finally { env.close(); }
  const old = 'a'.repeat(64);
  const E = makeEntry({ id: 'e_old', date: '2026-11-04', status: 'inbox', audio: [{ sha256: old, mime: 'audio/mp4', durationSec: 5 }] });
  const env2 = setup({ recOnly: true, attach: 'e_old', entries: [E] });
  try {
    await startRec(env2); await stopRec(env2);
    const s1 = env2.F.saved[0].sha256;
    await drop(env2);
    assert.deepEqual(shas(entry('e_old')), [old]);
    const clips = await recoverPending({ audioStore: env2.audio, before: Date.now() + 1000, locks: null });
    state.mutate(s => applyRecovery(s, clips, {}));
    assert.deepEqual(shas(entry('e_old')), [old, s1], '回到原来那条');
    assert.equal(live().length, 1);
  } finally { env2.close(); }
});

test('「放弃这段录音」的恢复记录、锁：撤销了 / 时间过了都清掉、放开', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    await drop(env);
    assert.ok(env.audio.recMeta.has('r_1') && env.locks.held.has(REC_LOCK + 'r_1'));
    lastToast(env).action.run();
    await until(() => !env.audio.recMeta.has('r_1') && !env.locks.held.has(REC_LOCK + 'r_1'), '撤销：录音又在条目里了');
    await drop(env);
    assert.ok(env.audio.recMeta.has('r_1'));
    env.T.run(UNDO_MS);
    await until(() => !env.audio.recMeta.has('r_1') && !env.locks.held.has(REC_LOCK + 'r_1') && !env.audio.clips.has(env.F.saved[0].sha256), '时间过了');
    // ✕ 取消的那段也一样拿着锁
    await startRec(env); await cancel(env);
    assert.ok(env.locks.held.has(REC_LOCK + 'r_2'));
    lastToast(env).action.run();
    await until(() => !env.locks.held.has(REC_LOCK + 'r_2'));
  } finally { env.close(); }
});

test('切到后台 / 锁屏：刚存好的不再等（放开同步）；在后台才存好的也不暂停', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    assert.equal(env.holds.n, 1);
    env.doc.visibilityState = 'hidden';
    await env.doc.fire('visibilitychange');
    assert.equal(env.holds.n, 0, '锁屏了：放开');
    assert.equal(env.T.count(FRESH_MS), 0);
    env.doc.visibilityState = 'visible';
    await again(env);
    env.doc.visibilityState = 'hidden';
    await env.doc.fire('visibilitychange');          // 录着的时候切走：录音机停下存好
    await until(() => phase(env) === 'saved');
    assert.equal(env.holds.n, 0, '在后台存好的：不暂停');
    assert.equal(env.holds.max, 1);
    env.doc.visibilityState = 'visible';
    await window.fire('pagehide');
    assert.equal(env.holds.double, 0);
  } finally { env.close(); }
});

test('「再录一段」录的点 ✕ / 「放弃这段录音」：回到上一段的「已保存」（还能写几句、放弃这段录音）；撤销回到这一段；一段段丢完才回到开始前', async () => {
  const env = setup({ recOnly: true });
  try {
    env.F.dur = 5;
    await startRec(env); await stopRec(env);       // A 0:05
    const [e] = all(), [a] = env.F.saved.map(s => s.sha256);
    env.F.dur = 7;
    await again(env); await cancel(env, 'saved');  // B 0:07：取消，回到 A
    assert.ok(env.main.textContent.includes('0:05'), 'A 的「已保存」');
    assert.ok(btn(env, t('rec.drop')) && btn(env, t('rec.write')));
    lastToast(env).action.run();                   // 撤销 = 点了停止：换到 B 的「已保存」
    assert.equal(phase(env), 'saved');
    assert.ok(env.main.textContent.includes('0:07'));
    const b = env.F.saved[1].sha256;
    assert.deepEqual(shas(entry(e.id)), [a, b]);
    env.F.dur = 9;
    await again(env); await stopRec(env);          // C 0:09
    const c = env.F.saved[2].sha256;
    await drop(env, 'saved');                      // 丢掉 C：回到 B
    assert.ok(env.main.textContent.includes('0:07'));
    assert.deepEqual(shas(entry(e.id)), [a, b]);
    lastToast(env).action.run();                   // 撤销：回到 C
    assert.ok(env.main.textContent.includes('0:09'));
    assert.deepEqual(shas(entry(e.id)), [a, b, c]);
    await drop(env, 'saved');                      // C → B
    await drop(env, 'saved');                      // B → A（C 的撤销收尾了）
    assert.ok(env.main.textContent.includes('0:05'));
    assert.deepEqual(shas(entry(e.id)), [a]);
    await drop(env);                               // A：整条丢掉，回到开始前
    assert.equal(entry(e.id).discarded, true);
    await startRec(env);
    assert.equal(env.F.starts[env.F.starts.length - 1], null, '下一段新建一条');
    await stopRec(env);                            // 停好再走（不然离开时存的那段会落到下一个测试里）
  } finally { env.close(); }
});

test('丢掉以后还接着之前那条（写了字）：开始前写「录好接到：…」；刚打开时不写', async () => {
  const env = setup();
  try {
    await tick();
    assert.ok(!env.main.textContent.includes(t('rec.attachTo')));
    await startRec(env); await type(env, SAID); await stopRec(env);
    await drop(env);
    assert.equal(lastToast(env).msg, t('rec.droppedText'));
    assert.ok(env.main.textContent.includes(t('rec.attachTo')) && env.main.textContent.includes('编的一句梦话'), env.main.textContent);
    await startRec(env);
    assert.equal(env.F.starts[1], live()[0].id);
    await stopRec(env);
  } finally { env.close(); }
});

test('边录边写：✕、「放弃这段录音」都收起键盘（提示条上的「撤销」才看得见），写的字留在框里', async () => {
  const env = setup();
  try {
    await tick();
    await startRec(env);
    assert.equal(env.doc.activeElement, textBox(env), '开始录音：光标在框里');
    await type(env, SAID);
    await cancel(env);
    assert.notEqual(env.doc.activeElement, textBox(env));
    assert.equal(textBox(env).value, SAID);
    await startRec(env); await stopRec(env);       // 刚才取消的那段留下了；这段接上
    textBox(env).focus();
    await drop(env, 'saved');
    assert.notEqual(env.doc.activeElement, textBox(env));
    assert.equal(textBox(env).value, SAID);
  } finally { env.close(); }
});

test('录着下一段时撤销「放弃这段录音」：换回数据、提示「已撤销」，录音不被打断', async () => {
  const env = setup({ recOnly: true });
  try {
    await startRec(env); await stopRec(env);
    const [e0] = all();
    await drop(env);
    const undo = lastToast(env);
    await startRec(env);
    undo.action.run();
    assert.equal(phase(env), 'recording');
    assert.equal(lastToast(env).msg, t('common.undone'));
    assert.ok(!entry(e0.id).deleted);
    assert.deepEqual(shas(entry(e0.id)), [env.F.saved[0].sha256]);
    await stopRec(env);
  } finally { env.close(); }
});

test('最近删除：「放弃这段录音」丢掉的空条目不显示；丢掉的但有字 / 有录音的、普通删除的照样显示', () => {
  const st = { data: { entries: {
    a: { id: 'a', deleted: true, deletedAt: 3, discarded: true, text: '', audio: [] },
    b: { id: 'b', deleted: true, deletedAt: 2, discarded: true, text: SAID, audio: [] },
    c: { id: 'c', deleted: true, deletedAt: 1, discarded: true, text: '', audio: [{ sha256: 'c'.repeat(64) }] },
    d: { id: 'd', deleted: true, deletedAt: 4, text: '', audio: [] },
  } } };
  assert.deepEqual(deletedEntries(st).map(e => e.id), ['d', 'b', 'c']);
});
