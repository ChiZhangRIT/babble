// 最近删除（#/deleted）和详情页里已删除的那条：最小 DOM + 真的 state.js、memoryStore（录音库）、真的 core/purge.js（createPurger）。
// 分两步上线：PURGE_ENABLED 现在开着（第二阶段）。setup 默认传开关关着（purgeEnabled / enabled: false，第一阶段的样子：只能恢复——删除的梦话、「移除的录音」），
// purge: true 测开着时的永久删除、全部永久删除（按显示的那份删，期间变了的不删）、还剩几天、别的梦话也在用、没有条目在用的录音、旧版本设备的提醒。
// 梦话、录音都是编的（仓库是公开的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, deletedEntries, trashCount, daysLeft, sharedCount, draftKeeps } from '../src/views/deleted.js';
import { render as renderEntry } from '../src/views/entry.js';
import { createPurger } from '../src/core/purge.js';
import { memoryStore } from '../src/core/audioStore.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, deletedRecord, restoredRecord, purgedRecord, removedClips, goneShas, isTombstone, setSetting, PURGE_MS, TOUCH_MS } from '../src/core/store.js';
import { setLang, t } from '../src/i18n.js';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';

const NN = '\u{1F470}\u{1F3FB}‍♀️';
const DAY = 864e5;
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
const allCls = (root, c) => all(root, el => cls(el, c));
const btns = (root, label) => all(root, el => el.tag === 'button' && el.textContent === label);
const raw = (id) => state.getState().data.entries[id];
// 详情页画气泡时复制说话人的头像（最小 DOM 里没有）
Element.prototype.cloneNode = function () { const c = new Element(this.tag); Object.assign(c.attrs, this.attrs); c.className = this.className; c._text = this._text; for (const x of this.children) c.appendChild(x.cloneNode()); return c; };

/** 编的录音存进录音库 → 条目里的一项 audio */
async function clip(audio, seed, extra = {}) {
  const s = await audio.putClip(new Blob(['编的录音 ' + seed], { type: 'audio/mp4' }), { mime: 'audio/mp4' });
  return { sha256: s.sha256, mime: 'audio/mp4', bytes: s.bytes, durationSec: 4, origName: '', addedAt: 1000, ...extra };
}

/** 假 ctx（照着 app.js：墓碑 ctx.entry 不给、ctx.tombstone 给；永久删除、放回、找孤儿都交给真的 purger） */
async function setup({ purge = false, seed = null, sync = null, purgerNow = null, local = {} } = {}) {
  const ls = fakeStorage();
  const dom = installDom({ localStorage: ls });
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  state.setLocal(local);
  const audio = memoryStore();
  const env = { ...dom, ls, audio, toasts: [], confirms: [], navs: [], players: [], syncs: 0, answer: true, onConfirm: null,
    st: { on: !!sync, running: false, repo: sync ? 'me/dreams' : null, oldDevices: [] }, syncResult: { ok: true }, remote: null };
  if (seed) await seed(env);
  const purger = createPurger({ getState: state.getState, mutate: (fn, o) => state.mutate(fn, o), audio, storage: ls, enabled: purge,
    syncOn: () => env.st.on, confirmedGone: () => goneShas(state.getState()), now: purgerNow || Date.now });
  env.purger = purger;
  const ons = [];
  const ctx = env.ctx = {
    t, lang: () => 'zh-Hans', layout: () => 'phone', bootAt: Date.now() - 1000, storageIssue: () => null,
    get state() { return state.getState(); }, get local() { return state.getLocal(); },
    entry: (id) => { const e = id && raw(id); return e && !isTombstone(e) ? e : null; },
    tombstone: (id) => { const e = id && raw(id); return isTombstone(e) ? e : null; },
    goneShas: () => goneShas(state.getState()), removedClips: () => removedClips(state.getState()),
    restore: (id) => state.mutate(s => { const r = restoredRecord(s.data.entries[id]); if (r) s.data.entries[id] = r; }),
    restoreClip: (id, sha) => purger.restoreClip(id, sha), purgeAll: async (l) => purger.purgeAll(l),
    purgeOrphans: (l) => purger.purgeOrphans(l), localOrphans: () => purger.localOrphans(), trashInfo: (k) => purger.trashInfo(k),
    clipBlob: async (sha) => (goneShas(state.getState()).has(sha) ? null : ((await audio.getClip(sha)) || {}).blob || null),
    sync: { status: () => env.st, now: async () => { env.syncs++; return env.syncResult; }, orphans: async () => env.remote },
    confirm: async (o) => { env.confirms.push(o); if (env.onConfirm) env.onConfirm(o); return env.answer; },
    toast: (msg, o = {}) => env.toasts.push({ msg, ...o }), back: (p) => env.navs.push('back:' + p), navigate: (p) => env.navs.push(p),
    on: (ev, fn) => { ons.push([ev, fn]); return () => {}; },
  };
  env.main = new Element('main');
  const player = (o) => { const el = document.createElement('div'); el.setAttribute('class', 'player compact'); el.opts = o; el.destroy = () => { el.destroyed = true; }; env.players.push(el); return el; };
  env.player = player;
  env.handle = render(env.main, { name: 'deleted' }, ctx, { purgeEnabled: purge, player });
  const off = state.subscribe((s, info) => queueMicrotask(() => { if (env.handle) env.handle.onChange(info); }));
  Object.assign(env, {
    text: () => env.main.textContent,
    rows: (c = 'del-row') => allCls(env.main, c),
    async click(el) { assert.ok(el, 'button'); await el.fire('click'); await settle(); },
    done() { if (env.handle) env.handle.cleanup(); env.handle = null; off(); dom.restore(); },
  });
  return env;
}

/** a：两段录音，在编辑页「移除」了第一段（state.js 记进 removedAudio）；b：删除了（带一段录音）；c：录音页丢掉的空条目；d：别的设备永久删除了的墓碑 */
async function seedTrash(env) {
  const A1 = await clip(env.audio, 'a1'), A2 = await clip(env.audio, 'a2'), B1 = await clip(env.audio, 'b1');
  state.mutate(s => {
    s.data.entries.a = makeEntry({ id: 'a', date: '2026-11-04', time: '02:58', text: `${NN}“编的一句”`, audio: [A1, A2] });
    s.data.entries.b = makeEntry({ id: 'b', date: '2026-11-03', text: `${NN}“删掉的一句”`, audio: [B1] });
    s.data.entries.c = makeEntry({ id: 'c', date: '2026-11-02' });
    s.data.entries.d = makeEntry({ id: 'd', date: '2026-11-01', text: '早就永久删除的' });
  });
  state.mutate(s => {
    s.data.entries.a = { ...s.data.entries.a, audio: [A2] };                                  // 编辑页「移除」
    s.data.entries.b = deletedRecord(s.data.entries.b);
    s.data.entries.c = { ...deletedRecord(s.data.entries.c), discarded: true };
    s.data.entries.d = deletedRecord(s.data.entries.d);
  });
  state.mutate(s => { s.data.entries.d = purgedRecord(s.data.entries.d, s.data.entries.d.updatedAt); }, { cause: 'purge' });
  Object.assign(env, { A1, A2, B1 });
}

test('第一阶段（开关关着）：删除的梦话、移除的录音各一节，只能恢复；没有永久删除、全部永久删除、还剩几天、没有条目在用的录音', async () => {
  const env = await setup({ seed: seedTrash });
  try {
    assert.equal(raw('a').removedAudio.length, 1, '编辑页移除的录音进了 removedAudio');
    assert.deepEqual(allCls(env.main, 'group-h').map(x => x.textContent), [t('deleted.entriesH'), t('deleted.clipsH')]);
    assert.deepEqual(deletedEntries(env.ctx.state).map(e => e.id), ['b'], '丢掉的空条目、墓碑都不算');
    assert.equal(trashCount(env.ctx), 2);
    const [entryRow, clipRow] = env.rows();
    assert.equal(find(entryRow, el => el.tag === 'a').attrs.href, '#/e/b');
    assert.ok(cls(clipRow, 'del-clip'));
    assert.equal(env.players.length, 1);
    assert.deepEqual([env.players[0].opts.key, env.players[0].opts.compact], [env.A1.sha256, true]);
    assert.equal(byCls(clipRow, 'del-body').tag, 'a', '整个文字那一栏都能点（去那条）');
    assert.equal(byCls(clipRow, 'del-body').attrs.href, '#/e/a');
    assert.equal(byCls(clipRow, 'del-from').tag, 'span');
    const from = byCls(clipRow, 'del-from').textContent;
    assert.ok(from.startsWith('来自 ') && from.includes('11月4日 凌晨2:58') && from.endsWith('“编的一句”'), from);
    assert.ok(byCls(clipRow, 'del-at').textContent.startsWith('移除于 '));
    for (const c of ['del-purge', 'del-all', 'del-orphans', 'del-left', 'del-old']) assert.equal(byCls(env.main, c), undefined, c);
    assert.ok(!env.text().includes('永久删除'), env.text());
    assert.equal(allCls(env.main, 'group-foot').at(-1).textContent, t('deleted.hint'));
    // 放回那段：接在那条最后、盖 restoredAt，提示一句；那一节没了
    await env.click(btns(clipRow, t('common.restore'))[0]);
    assert.deepEqual(raw('a').audio.map(x => x.sha256), [env.A2.sha256, env.A1.sha256]);
    assert.ok(raw('a').audio[1].restoredAt > 0);
    assert.equal(raw('a').removedAudio, undefined);
    assert.equal(env.toasts.at(-1).msg, t('deleted.clipRestored'));
    assert.deepEqual(allCls(env.main, 'group-h').map(x => x.textContent), [t('deleted.entriesH')]);
    // 恢复那条梦话 → 空了
    await env.click(btns(env.main, t('common.restore'))[0]);
    assert.equal(raw('b').deleted, undefined);
    assert.equal(byCls(env.main, 'del-empty').children[1].textContent, t('deleted.empty'));
    // 这台设备不产生墓碑：开关关着时 purger 什么都不删
    assert.deepEqual(env.purger.purgeAll({ entries: [{ id: 'c', at: raw('c').updatedAt }] }), { done: [], changed: [], skipped: true });
    assert.equal(isTombstone(raw('c')), false);
  } finally { env.done(); }
});

test('第一阶段（开关关着）：移除的录音没起名字叫「移除的录音」（不和条目里剩下的「录音 1」撞）；按钮的读屏名字带上是哪一项；删除了的梦话里移除过的录音说一声（列表、详情页）', async () => {
  const env = await setup({ seed: seedTrash });
  try {
    const clipRow = env.rows().find(r => cls(r, 'del-clip'));
    const name = byCls(clipRow, 'del-name').textContent;
    assert.ok(name.startsWith(t('deleted.clipFallback')) && !name.startsWith(t('clip.fallback', { n: 1 })), name);
    const rb = btns(clipRow, t('common.restore'))[0].attrs['aria-label'];
    assert.ok(rb.startsWith(t('common.restore') + '：' + t('deleted.clipFallback') + ' · 来自 ') || rb.startsWith(t('common.restore') + '：' + t('deleted.clipFallback') + ' · '), rb);
    assert.ok(rb.includes('“编的一句”'), rb);
    assert.ok(btns(env.rows()[0], t('common.restore'))[0].attrs['aria-label'].includes('“删掉的一句”'));
    // 删除那条（里面有一段移除的录音）：「移除的录音」一节没了，那条下面说一声（不是永久删除的提醒）
    state.mutate(s => { s.data.entries.a = deletedRecord(s.data.entries.a); });
    await settle();
    assert.deepEqual(allCls(env.main, 'group-h').map(x => x.textContent), [t('deleted.entriesH')]);
    const row = env.rows().find(r => find(r, el => el.tag === 'a').attrs.href === '#/e/a');
    assert.ok(row.textContent.includes(t('deleted.hasRemovedKeep', { n: 1 })), row.textContent);
    assert.equal(byCls(env.main, 'del-left'), undefined);
    const main = new Element('main');
    renderEntry(main, { name: 'entry', id: 'a' }, env.ctx, { purgeEnabled: false, player: env.player });
    assert.ok(byCls(main, 'e-banner').textContent.includes(t('deleted.hasRemovedKeep', { n: 1 })));
    // 开关开着（默认）：详情页说「会一起删掉」
    const main2 = new Element('main');
    renderEntry(main2, { name: 'entry', id: 'a' }, env.ctx, { player: env.player });
    assert.ok(byCls(main2, 'e-banner').textContent.includes(t('deleted.hasRemoved', { n: 1 })));
  } finally { env.done(); }
});

test('开放以后：「全部永久删除」只有一项时按一项说；「昨夜」里还没整理的同一段录音会一起删掉，确认框说一声；两个数的说法里是 0 的不说', async () => {
  const env = await setup({ purge: true, seed: async (e) => {
    e.X = await clip(e.audio, 'x');
    state.mutate(s => { s.data.entries.x = makeEntry({ id: 'x', date: '2026-11-04', text: `${NN}“留下又撤销”`, audio: [e.X] }); });
    state.mutate(s => { s.data.entries.x = deletedRecord(s.data.entries.x); });
  } });
  try {
    const X = env.X.sha256;
    env.ctx.night = { listCands: async () => [{ id: 'c1', entryId: null, sha256: X }, { id: 'c2', entryId: 'x', sha256: X },
      { id: 'c3', entryId: null, sha256: 'f'.repeat(64) }, { id: 'c4', entryId: null, sha256: X, gone: true }] };
    env.answer = false;
    await env.click(byCls(env.main, 'del-all'));
    assert.equal(env.confirms[0].title, t('deleted.confirmT'));
    assert.deepEqual(env.confirms[0].message.split('\n'), [t('deleted.purgeMsgLocal'), t('deleted.nightPending', { n: 1 })]);
  } finally { env.done(); }
  try {
    for (const lang of ['zh-Hans', 'zh-Hant-TW', 'en']) {
      setLang(lang);
      for (const [n, clips] of [[0, 2], [3, 0], [1, 2], [0, 1]]) {
        for (const k of ['deleted.purgeAllMsg', 'sync.squashTrash']) { const s = t(k, { n, clips }); assert.ok(!/(^|\D)0 /.test(s) && !(n + clips === 1 && s.includes('All')), s); }
      }
    }
    setLang('zh-Hans');
    assert.equal(t('deleted.purgeAllMsg', { n: 0, clips: 2 }), '最近删除里的 2 段录音会全部删掉，不能恢复。');
    assert.equal(t('deleted.purgeAllMsg', { n: 1, clips: 2 }), '最近删除里的 1 条梦话和 2 段录音会全部删掉，不能恢复。');
    setLang('en');
    assert.equal(t('deleted.purgeAllMsg', { n: 0, clips: 2 }), "All 2 recordings in Recently deleted will be deleted. This can't be undone.");
    assert.ok(t('sync.squashTrash', { n: 1, clips: 0 }).startsWith('Recently deleted still holds 1 entry. It counts'));
  } finally { setLang('zh-Hans'); }
});

test('开放以后：一条永久删除——先确认（没开同步：只说这台设备），变成墓碑，本机的录音删掉，没有撤销；列表跟着变', async () => {
  const env = await setup({ purge: true, seed: seedTrash });
  try {
    const row = env.rows()[0];
    assert.equal(btns(row, t('common.restore')).length, 1);
    await env.click(btns(row, t('common.purge'))[0]);
    assert.deepEqual(env.confirms.map(c => [c.title, c.message, c.confirmLabel, c.danger]), [[t('deleted.confirmT'), t('deleted.purgeMsgLocal'), t('common.purge'), true]]);
    const b = raw('b');
    assert.equal(isTombstone(b), true);
    assert.deepEqual([b.text, b.audio, b.gone.map(g => g.sha256)], ['', [], [env.B1.sha256]]);
    assert.equal(env.toasts.at(-1).msg, t('common.purged'));
    assert.ok(env.toasts.every(x => !x.action), '没有撤销');
    assert.equal(env.syncs, 0, '没开同步：不同步');
    assert.equal(await env.audio.hasClip(env.B1.sha256), false, '刚永久删除的：不等一小时');
    assert.equal(await env.audio.hasClip(env.A1.sha256), true, '移除的录音还在');
    assert.deepEqual(env.rows().map(r => cls(r, 'del-clip')), [true], '那条不在列表里了');
    // 取消就什么都不做
    env.answer = false;
    await env.click(btns(env.rows()[0], t('common.purge'))[0]);
    assert.equal(raw('a').removedAudio.length, 1);
  } finally { env.done(); }
});

test('开放以后：全部永久删除按显示的那份删；确认时另一台设备改了那条 → 那条不删、说一声；移除的录音变成 gone 记号', async () => {
  const env = await setup({ purge: true, seed: seedTrash });
  try {
    const all = byCls(env.main, 'del-all');
    assert.equal(all.textContent, t('deleted.purgeAll'));
    env.onConfirm = () => { state.mutate(s => { s.data.entries.b = { ...s.data.entries.b, note: '别的设备刚写的背景' }; }); };   // 点了以后、删之前
    await env.click(all);
    assert.deepEqual([env.confirms[0].title, env.confirms[0].message], [t('deleted.confirmAllT'), t('deleted.purgeAllMsg', { n: 1, clips: 1 })]);
    assert.equal(isTombstone(raw('b')), false, '变过的不删');
    assert.equal(raw('b').note, '别的设备刚写的背景');
    assert.equal(raw('a').removedAudio, undefined);
    assert.deepEqual(raw('a').gone.map(g => [g.sha256, g.from > 0]), [[env.A1.sha256, true]]);
    assert.deepEqual(raw('a').audio.map(x => x.sha256), [env.A2.sha256], '在用的录音不动');
    assert.equal(env.toasts.at(-1).msg, t('common.purged') + '\n' + t('deleted.changedElsewhere', { n: 1 }));
    assert.deepEqual(env.rows().map(r => find(r, el => el.tag === 'a').attrs.href), ['#/e/b'], '没删的那条还在，按新的那版');
  } finally { env.done(); }
});

test('开放以后、开着同步：确认框说「所有设备和同步仓库」和提交历史；删完马上同步，同步不上说一声；旧版本设备的提醒', async () => {
  const env = await setup({ purge: true, seed: seedTrash, sync: true });
  try {
    env.st.oldDevices = ['iPad', 'Mac']; env.handle.onChange({});
    assert.equal(byCls(env.main, 'del-old').textContent, t('deleted.oldDevices', { devices: 'iPad、Mac' }));
    env.syncResult = { ok: false, offline: true };
    await env.click(btns(env.rows()[0], t('common.purge'))[0]);
    assert.equal(env.confirms[0].message, [t('deleted.purgeMsg'), t('deleted.graceNote'), t('deleted.historyNote'), t('deleted.oldDevices', { devices: 'iPad、Mac' })].join('\n'));
    assert.equal(env.syncs, 1);
    assert.deepEqual(env.toasts.slice(-2).map(x => x.msg), [t('common.purged'), t('common.purgedOffline')]);
    assert.equal(isTombstone(raw('b')), true);
  } finally { env.done(); }
});

test('开放以后：还剩几天（不早于开放那天 + 30 天）、另有几段移除的录音；一段录音别的梦话也在用 → 确认框说那里的留着，录音本身不删', async () => {
  const now = Date.now();
  const env = await setup({ purge: true, seed: async (e) => {
    await seedTrash(e);
    state.mutate(s => {
      setSetting(s, 'trashSince', now - 10 * DAY);
      s.data.entries.x = makeEntry({ id: 'x', date: '2026-10-01', text: `${NN}“也用这段”`, audio: [{ ...e.A1 }] });
      s.data.entries.b = { ...s.data.entries.b, deletedAt: now - 20 * DAY, removedAudio: [{ ...e.A2, removedAt: now - 25 * DAY }] };
    });
  } });
  try {
    assert.equal(daysLeft(now + 20 * DAY - 1000, now), 20);
    assert.equal(daysLeft(now - 1, now), 0);
    const [entryRow, clipRow] = env.rows();
    assert.equal(byCls(entryRow, 'del-left').textContent, t('deleted.left', { n: 20 }) + ' · ' + t('deleted.hasRemoved', { n: 1 }));
    assert.ok(byCls(clipRow, 'del-at').textContent.endsWith(' · ' + t('deleted.left', { n: 30 })), '刚移除的：30 天');
    assert.equal(sharedCount(env.ctx.state, 'a', env.A1.sha256), 1);
    await env.click(btns(clipRow, t('common.purge'))[0]);
    assert.equal(env.confirms[0].title, t('deleted.confirmClipT'));
    assert.equal(env.confirms[0].message, [t('deleted.purgeClipMsgLocal'), t('deleted.shared', { n: 1 })].join('\n'));
    assert.equal(raw('a').removedAudio, undefined);
    assert.equal(goneShas(env.ctx.state).has(env.A1.sha256), false, 'x 还在用');
    await settle();
    assert.equal(await env.audio.hasClip(env.A1.sha256), true);
  } finally { env.done(); }
});

test('草稿改过、里面有这段录音转出的字：永久删除录音时这些字留着（确认框说一声）', () => {
  const sha = 'a'.repeat(64), other = 'b'.repeat(64);
  const parts = [{ sha256: sha, text: '转出的一句' }, { sha256: other, text: '另一段' }];
  assert.equal(draftKeeps({ draft: { text: '转出的一句\n\n另一段', parts } }, sha), false, '没改过：整理时按剩下的重新拼');
  assert.equal(draftKeeps({ draft: { text: '我自己重写了\n\n另一段', parts } }, sha), false, '那段的字已经不在了');
  assert.equal(draftKeeps({ draft: { text: '前面加了字 转出的一句\n\n另一段', parts } }, sha), true);
  assert.equal(draftKeeps({ draft: null }, sha), false);
});

test('开放以后：没有条目在用的录音——点「查找」才查，只在这台设备上、没上传过的标出来、只能一段段删；删了写一个孤儿墓碑、本机的也删', async () => {
  const later = () => Date.now() + 2 * TOUCH_MS;           // 一小时内碰过的不算：把 purger 的钟拨快
  const env = await setup({ purge: true, purgerNow: later, seed: async (e) => {
    await seedTrash(e);
    e.O1 = await clip(e.audio, 'orphan');                   // 以前导入后撤销留下的
  } });
  try {
    const sec = byCls(env.main, 'del-orphans');
    assert.equal(sec.attrs.id || sec.id, 'orphans');
    assert.equal(byCls(sec, 'del-help').textContent, t('deleted.orphansHelp'));
    assert.equal(allCls(sec, 'del-row').length, 0, '没点查找不列');
    await env.click(byCls(sec, 'del-find'));
    const rows = allCls(byCls(env.main, 'del-orphans'), 'del-row');
    assert.equal(rows.length, 1, '只有没人用的那段（移除的、删除的梦话里的都算有人用）');
    assert.equal(byCls(rows[0], 'del-name').textContent, t('deleted.orphansHere'));
    assert.equal(byCls(rows[0], 'del-warn').textContent, t('deleted.orphansOnlyHere'));
    assert.equal(byCls(byCls(env.main, 'del-orphans'), 'del-all'), undefined, '只在这台设备上的不给「全部永久删除」');
    env.handle.onChange({});
    assert.equal(allCls(byCls(env.main, 'del-orphans'), 'del-row').length, 1, '找到的记着，重画还在');
    await env.click(btns(rows[0], t('common.purge'))[0]);
    assert.deepEqual([env.confirms[0].title, env.confirms[0].message], [t('deleted.orphansT', { n: 1 }), [t('deleted.orphansMsgLocal', { n: 1 }), t('deleted.orphansOnlyHereMsg')].join('\n')]);
    assert.ok(env.confirms[0].message.startsWith('没有哪条梦话在用它。'), '一段：「它」，不是「它们」');
    const tomb = Object.values(env.ctx.state.data.entries).find(x => x.id.startsWith('o_'));
    assert.ok(tomb && isTombstone(tomb));
    assert.deepEqual(tomb.gone.map(g => g.sha256), [env.O1.sha256]);
    await settle();
    assert.equal(await env.audio.hasClip(env.O1.sha256), false);
    assert.equal(allCls(byCls(env.main, 'del-orphans'), 'del-row').length, 0);
  } finally { env.done(); }
});

test('没有条目在用的录音：这次打开修过数据、一条梦话都没有（还没同步下来）时不显示', async () => {
  const env = await setup({ purge: true, seed: seedTrash, local: { repairedAt: Date.now() } });
  try { assert.equal(byCls(env.main, 'del-orphans'), undefined); } finally { env.done(); }
  const empty = await setup({ purge: true });
  try {
    assert.equal(byCls(empty.main, 'del-orphans'), undefined);
    assert.equal(byCls(empty.main, 'del-empty').children[1].textContent, t('deleted.empty'));
  } finally { empty.done(); }
});

test('详情页里已删除的那条：第一阶段只有「恢复」；开放以后多「永久删除」和还剩几天，删了回「最近删除」；永久删除了的只说一句', async () => {
  for (const purge of [false, true]) {
    const env = await setup({ purge, seed: seedTrash });
    try {
      const main = new Element('main');
      if (purge) state.mutate(s => { setSetting(s, 'trashSince', Date.now() - DAY); });
      const page = renderEntry(main, { name: 'entry', id: 'b' }, env.ctx, { purgeEnabled: purge, player: env.player });
      const banner = byCls(main, 'e-banner');
      // 录音也能听（永久删除前听一下误录的是什么）：画了播放器，拿的是这条的录音
      const pl = env.players.at(-1);
      assert.ok(main.contains(pl), '已删除的那条也画了播放器');
      assert.equal(await pl.opts.getBlob().then(b => b && b.size), env.B1.bytes);
      assert.equal(byCls(main, 'e-clip-cap').textContent, t('clip.fallback', { n: 1 }));
      assert.ok(banner.textContent.startsWith(t('entry.deleted')));
      assert.deepEqual(allCls(banner, 'e-banner-by').map(x => x.textContent).filter(x => x.includes('永久删除')), purge ? [t('deleted.left', { n: 30 })] : []);
      assert.deepEqual(all(banner, el => el.tag === 'button').map(b => b.textContent), purge ? [t('common.restore'), t('common.purge')] : [t('common.restore')]);
      if (purge) {
        // 点了确认、还在删（开着同步时要先同步一次，最多 10 秒）：按钮写「正在永久删除…」，恢复和永久删除都不能点，再点也不会再问一次
        let go = null;
        const real = env.ctx.purgeAll;
        env.ctx.purgeAll = (l) => new Promise(res => { go = () => res(real(l)); });
        const p = btns(byCls(main, 'e-banner'), t('common.purge'))[0].fire('click');
        await settle();
        const busyBanner = byCls(main, 'e-banner');
        assert.deepEqual(all(busyBanner, el => el.tag === 'button').map(b => [b.textContent, !!b.disabled]),
          [[t('common.restore'), true], [t('deleted.purging'), true]]);
        await all(busyBanner, el => el.tag === 'button')[1].fire('click');
        await settle();
        assert.equal(env.confirms.length, 1, '删的时候再点不会再问一次');
        go(); await p; await settle();
        env.ctx.purgeAll = real;
        assert.equal(env.confirms[0].message, t('deleted.purgeMsgLocal'));
        assert.equal(isTombstone(raw('b')), true);
        assert.deepEqual(env.navs, ['back:/deleted']);
      }
      page.cleanup();
      const gone = new Element('main');
      renderEntry(gone, { name: 'entry', id: 'd' }, env.ctx, { purgeEnabled: purge });
      assert.equal(byCls(gone, 'empty').textContent, t('entry.purgedNote'));
    } finally { env.done(); }
  }
});

test('开放以后、开着同步：「查找」先同步一轮再看仓库；这台设备和仓库里都有的并成一行；「全部永久删除」只删仓库里有、或者上传过的；24 小时内传上来的只计数', async () => {
  const R1 = '1'.repeat(64), R2 = '2'.repeat(64);
  const env = await setup({ purge: true, sync: true, purgerNow: () => Date.now() + 2 * TOUCH_MS, seed: async (e) => {
    await seedTrash(e);
    e.O1 = await clip(e.audio, 'orphan');
    await e.audio.markUploaded(e.O1.sha256, true);
    e.O2 = await clip(e.audio, 'only-here');
  } });
  try {
    env.remote = { ok: true, recent: 2, more: false, files: [
      { sha256: env.O1.sha256, path: `audio/${env.O1.sha256}.m4a`, ext: 'm4a', size: 30, at: '2026-11-01T00:00:00Z', mime: 'audio/mp4' },
      { sha256: R1, path: `audio/${R1}.m4a`, ext: 'm4a', size: 1200, at: '2026-10-01T00:00:00Z', mime: 'audio/mp4' },
      { sha256: R2, path: `audio/${R2}.wav`, ext: 'wav', size: 900, at: '2026-09-01T00:00:00Z', mime: 'audio/wav' }] };
    await env.click(byCls(byCls(env.main, 'del-orphans'), 'del-find'));
    const sec = byCls(env.main, 'del-orphans'), rows = allCls(sec, 'del-row');
    assert.deepEqual(rows.map(r => byCls(r, 'del-name').textContent).sort(),
      [t('deleted.orphansBoth'), t('deleted.orphansHere'), t('deleted.orphansRepo'), t('deleted.orphansRepo')].sort());
    assert.equal(allCls(sec, 'del-warn').length, 1, '只有没上传过的那段标出来');
    assert.equal(allCls(sec, 'group-foot').at(-1).textContent, t('deleted.orphansRecent', { n: 2 }));
    await env.click(byCls(sec, 'del-all'));
    assert.equal(env.confirms[0].title, t('deleted.orphansT', { n: 3 }));
    assert.equal(env.confirms[0].message, [t('deleted.orphansMsg'), t('deleted.graceNote'), t('deleted.historyNote')].join('\n'));
    const tomb = Object.values(env.ctx.state.data.entries).find(x => x.id.startsWith('o_'));
    assert.deepEqual(tomb.gone.map(g => g.sha256).sort(), [env.O1.sha256, R1, R2].sort());
    assert.deepEqual(allCls(byCls(env.main, 'del-orphans'), 'del-row').map(r => byCls(r, 'del-name').textContent), [t('deleted.orphansHere')]);
    assert.equal(env.syncs, 1, '删完马上同步一次');
  } finally { env.done(); }
});

/** 一条还在的梦话 live 用着录音 X；删除的 dup（重复导入的那种）也只有 X；删除的 rec 是一段 11 秒的误录 Y（只它在用） */
async function seedShared(env) {
  const X = await clip(env.audio, 'x'), Y = await clip(env.audio, 'y', { durationSec: 11 });
  state.mutate(s => {
    s.data.entries.live = makeEntry({ id: 'live', date: '2026-11-10', text: `${NN}“编的原来那条”`, audio: [X] });
    s.data.entries.dup = makeEntry({ id: 'dup', date: '2026-11-10', text: `${NN}“编的原来那条”`, audio: [X] });
    s.data.entries.rec = makeEntry({ id: 'rec', date: '2026-11-17', audio: [Y] });
  });
  state.mutate(s => { s.data.entries.dup = deletedRecord(s.data.entries.dup); });
  state.mutate(s => { s.data.entries.rec = deletedRecord(s.data.entries.rec); });
  Object.assign(env, { X, Y });
}

test('开放以后、开着同步：删的梦话的录音别的梦话也在用 → 确认框说「其中 n 段」留着，一段录音也不删时不说「录音文件马上从仓库删掉」；全部永久删除也说；每行写着几段录音、多长', async () => {
  const env = await setup({ purge: true, sync: true, seed: seedShared });
  try {
    const row = (id) => env.rows().find(r => find(r, el => el.tag === 'a').attrs.href === '#/e/' + id);
    assert.equal(byCls(row('rec'), 'del-audio').textContent, t('deleted.hasAudio', { n: 1, dur: '0:11' }));
    assert.equal(byCls(row('rec'), 'del-audio').textContent, '1 段录音 · 0:11');
    assert.equal(byCls(row('dup'), 'del-audio').textContent, '1 段录音 · 0:04');
    env.answer = false;
    await env.click(btns(row('dup'), t('common.purge'))[0]);
    assert.equal(env.confirms[0].message, [t('deleted.purgeMsg'), t('deleted.sharedSome', { n: 1 }), t('deleted.historyNote')].join('\n'));
    await env.click(btns(row('rec'), t('common.purge'))[0]);
    assert.equal(env.confirms[1].message, [t('deleted.purgeMsg'), t('deleted.graceNote'), t('deleted.historyNote')].join('\n'), '只它在用：照常说');
    await env.click(byCls(env.main, 'del-all'));
    assert.equal(env.confirms[2].message, [t('deleted.purgeAllMsg', { n: 2, clips: 0 }), t('deleted.sharedSome', { n: 1 }), t('deleted.graceNote'), t('deleted.historyNote')].join('\n'));
    assert.equal(env.syncs, 0, '都取消了');
    // 真删 dup：X 留着（live 还在用），录音库里也还在
    env.answer = true;
    await env.click(btns(row('dup'), t('common.purge'))[0]);
    assert.equal(isTombstone(raw('dup')), true);
    assert.ok(!goneShas(state.getState()).has(env.X.sha256));
    assert.ok(await env.audio.getClip(env.X.sha256));
  } finally { env.done(); }
});

test('开放以后：删一行时只那一行写「正在永久删除…」（底下的「全部永久删除」不变），别的按钮都先不能点；删完恢复', async () => {
  const env = await setup({ purge: true, seed: seedShared });
  try {
    let go = null;
    const real = env.ctx.purgeAll;
    env.ctx.purgeAll = (l) => new Promise(res => { go = () => res(real(l)); });
    const row = (id) => env.rows().find(r => find(r, el => el.tag === 'a').attrs.href === '#/e/' + id);
    const p = btns(row('rec'), t('common.purge'))[0].fire('click');
    await settle();
    const label = (r) => find(r, el => el.tag === 'button' && cls(el, 'del-purge'));
    assert.deepEqual([label(row('rec')).textContent, !!label(row('rec')).disabled], [t('deleted.purging'), true]);
    assert.deepEqual([label(row('dup')).textContent, !!label(row('dup')).disabled], [t('common.purge'), true]);
    const all1 = byCls(env.main, 'del-all');
    assert.deepEqual([all1.textContent, !!all1.disabled], [t('deleted.purgeAll'), true]);
    go(); await p; await settle();
    env.ctx.purgeAll = real;
    assert.equal(isTombstone(raw('rec')), true);
    assert.deepEqual([label(row('dup')).textContent, !!label(row('dup')).disabled], [t('common.purge'), false]);
    // 「全部永久删除」：写在它自己上面
    env.ctx.purgeAll = (l) => new Promise(res => { go = () => res(real(l)); });
    const q = byCls(env.main, 'del-all').fire('click');
    await settle();
    assert.equal(byCls(env.main, 'del-all').textContent, t('deleted.purging'));
    assert.equal(label(row('dup')).textContent, t('common.purge'));
    go(); await q; await settle();
    env.ctx.purgeAll = real;
  } finally { env.done(); }
});

test('开放以后：页面开着的时候才知道日期（第一次同步成功写下 trashSince）→「n 天后永久删除」马上画出来，不用离开再回来', async () => {
  const env = await setup({ purge: true, seed: seedShared });
  try {
    assert.equal(byCls(env.main, 'del-left'), undefined, '还不知道日期：不写');
    env.purger.noteTrash();
    state.mutate(s => { setSetting(s, 'trashSince', Date.now()); });
    await settle();
    assert.deepEqual(allCls(env.main, 'del-left').map(x => x.textContent), [t('deleted.left', { n: 30 }), t('deleted.left', { n: 30 })]);
  } finally { env.done(); }
});

test('没有梦话在用的录音：几段一起删说「它们」；只在这台设备上的（开着同步）按这台设备说，不说仓库、7 天、提交历史；又在用了的说「又在用了」不说「别的设备上改过」', async () => {
  const now = Date.now();
  const env = await setup({ purge: true, sync: true, seed: async (e) => {
    await seedTrash(e);
    e.O1 = await clip(e.audio, '孤儿一'); e.O2 = await clip(e.audio, '孤儿二'); e.O3 = await clip(e.audio, '只在这里');
    for (const c of [e.O1, e.O2, e.O3]) { const r = e.audio.clips ? e.audio.clips.get(c.sha256) : null; if (r) r.addedAt = r.touchedAt = now - 2 * 36e5; }
  } });
  try {
    // 这台设备上的三段（两段上传过），仓库里也有那两段
    env.ctx.localOrphans = async () => [env.O1, env.O2, env.O3].map((c, i) => ({ sha256: c.sha256, mime: 'audio/mp4', bytes: 9, addedAt: now - 2 * 36e5, uploaded: i < 2 }));
    env.remote = { ok: true, files: [env.O1, env.O2].map(c => ({ sha256: c.sha256, path: 'audio/' + c.sha256 + '.m4a', ext: 'm4a', size: 9, at: now - 3 * 864e5, mime: 'audio/mp4' })), recent: 0, more: false };
    env.handle.onChange({});
    await env.click(byCls(env.main, 'del-find'));
    env.answer = false;
    await env.click(find(env.main, el => el.tag === 'button' && el.textContent === t('deleted.orphansPurgeAll')));
    assert.equal(env.confirms[0].message, [t('deleted.orphansMsg', { n: 2 }), t('deleted.graceNote'), t('deleted.historyNote')].join('\n'));
    assert.ok(env.confirms[0].message.startsWith('没有哪条梦话在用它们。'));
    const onlyRow = allCls(env.main, 'del-row').find(r => byCls(r, 'del-warn'));
    await env.click(btns(onlyRow, t('common.purge'))[0]);
    assert.equal(env.confirms[1].message, [t('deleted.orphansMsgLocal', { n: 1 }), t('deleted.orphansOnlyHereMsg')].join('\n'), '只在这台设备上：不说所有设备、仓库、7 天');
    // 点确认的那一刻又被梦话用上了：说「又在用了」
    env.answer = true;
    env.onConfirm = () => state.mutate(s => { s.data.entries.a = { ...s.data.entries.a, audio: [...s.data.entries.a.audio, env.O3] }; });
    await env.click(btns(onlyRow, t('common.purge'))[0]);
    env.onConfirm = null;
    assert.equal(env.toasts.at(-1).msg, t('deleted.orphansChanged', { n: 1 }));
  } finally { env.done(); }
});

test('从「设置 → 存储」点进来（#/deleted?focus=orphans）：滚到「没有梦话在用的录音」那一节', async () => {
  const env = await setup({ purge: true, seed: seedTrash });
  const scrolled = [];
  Element.prototype.scrollIntoView = function (o) { scrolled.push([this.id, o]); };
  try {
    const main = new Element('main'), params = { name: 'deleted', query: { focus: 'orphans' } };
    const page = render(main, params, env.ctx, { purgeEnabled: true, player: env.player });
    assert.deepEqual(scrolled, [['orphans', { block: 'start' }]]);
    assert.equal(params.query.focus, null, '只滚一次（重画、回来不再滚）');
    page.cleanup();
  } finally { delete Element.prototype.scrollIntoView; env.done(); }
});
