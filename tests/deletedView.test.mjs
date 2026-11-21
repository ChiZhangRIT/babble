// 最近删除（#/deleted）和详情页里已删除的那条：最小 DOM + 真的 state.js、memoryStore（录音库）、真的 core/purge.js（createPurger）。
// 分两步上线：PURGE_ENABLED 关着（默认）只能恢复——删除的梦话、「移除的录音」；页面和 purger 都传开关打开（purgeEnabled / enabled: true），
// 测开放以后的永久删除、全部永久删除（按显示的那份删，期间变了的不删）、还剩几天、别的梦话也在用、没有条目在用的录音、旧版本设备的提醒。
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

test('第一阶段：移除的录音没起名字叫「移除的录音」（不和条目里剩下的「录音 1」撞）；按钮的读屏名字带上是哪一项；删除了的梦话里移除过的录音说一声（列表、详情页）', async () => {
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
    renderEntry(main, { name: 'entry', id: 'a' }, env.ctx);
    assert.ok(byCls(main, 'e-banner').textContent.includes(t('deleted.hasRemovedKeep', { n: 1 })));
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
    assert.deepEqual([env.confirms[0].title, env.confirms[0].message], [t('deleted.orphansT', { n: 1 }), [t('deleted.orphansMsgLocal'), t('deleted.orphansOnlyHereMsg')].join('\n')]);
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
      const page = renderEntry(main, { name: 'entry', id: 'b' }, env.ctx, { purgeEnabled: purge });
      const banner = byCls(main, 'e-banner');
      assert.ok(banner.textContent.startsWith(t('entry.deleted')));
      assert.deepEqual(allCls(banner, 'e-banner-by').map(x => x.textContent).filter(x => x.includes('永久删除')), purge ? [t('deleted.left', { n: 30 })] : []);
      assert.deepEqual(all(banner, el => el.tag === 'button').map(b => b.textContent), purge ? [t('common.restore'), t('common.purge')] : [t('common.restore')]);
      if (purge) {
        await env.click(btns(banner, t('common.purge'))[0]);
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
