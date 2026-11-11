import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankState, normalizeState, mergeStates, canon, stamp, deletedRecord, restoredRecord, live, newId, setSetting,
  makeEntry, byNewest, clipIndex, DEFAULT_SETTINGS, NN_EMOJI, ME_EMOJI,
} from '../src/core/store.js';
import * as state from '../src/core/state.js';

// 测试只用编出来的数据
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const withEntry = (s, id, fields) => { s.data.entries[id] = { id, date: '2026-01-02', text: '', ...fields }; return s; };
const fakeStorage = () => {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => m.delete(k) };
};

test('合并：每条取较新的一份，两边顺序无关', () => {
  const a = withEntry(blankState(), 'e1', { text: '旧', updatedAt: 100 });
  const b = withEntry(blankState(), 'e1', { text: '新', updatedAt: 200 });
  withEntry(a, 'e2', { text: '只在 a', updatedAt: 50 });
  for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
    assert.equal(m.data.entries.e1.text, '新');
    assert.equal(m.data.entries.e2.text, '只在 a');
  }
});

test('删除标记比旧的修改新：合并后仍是删除，不会复活', () => {
  const a = withEntry(blankState(), 'e1', { updatedAt: 100 });
  const b = withEntry(blankState(), 'e1', { deleted: true, deletedAt: 150, updatedAt: 150 });
  for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
    assert.equal(m.data.entries.e1.deleted, true);
    assert.equal(live(m).length, 0);
  }
});

test('软删除保留全部内容；恢复后同一个 id，比旧的删除新，同步后不会被删除盖回去', () => {
  const original = normalizeState(withEntry(blankState(), 'e1', { text: '👰🏻‍♀️“今天吃什么”', audio: [{ sha256: SHA_A, mime: 'audio/mp4' }], updatedAt: 10 })).data.entries.e1;
  const removed = deletedRecord(original, 20);
  assert.equal(removed.text, original.text);
  assert.deepEqual(removed.audio, original.audio);
  assert.equal(removed.deletedAt, 20);
  assert.equal(deletedRecord(removed, 30), null, '已经删除的不再删一次');
  const reloaded = normalizeState(JSON.parse(JSON.stringify({ ...blankState(), data: { entries: { e1: removed } } })));
  assert.equal(live(reloaded).length, 0);
  const restored = restoredRecord(reloaded.data.entries.e1, 15);
  assert.equal(restored.id, 'e1');
  assert.equal(restored.deleted, undefined);
  assert.equal(restored.deletedAt, undefined);
  assert.ok(restored.updatedAt > removed.updatedAt);
  assert.equal(restoredRecord(original), null, '没删除的不能「恢复」');
  const other = blankState(); other.data.entries.e1 = restored;
  for (const m of [mergeStates(reloaded, other), mergeStates(other, reloaded)]) assert.equal(live(m).length, 1);
});

test('时间相同内容不同：每台设备合并出同一个结果', () => {
  const a = withEntry(blankState(), 'e1', { text: '甲', updatedAt: 100 });
  const b = withEntry(blankState(), 'e1', { text: '乙', updatedAt: 100 });
  assert.equal(canon(mergeStates(a, b)), canon(mergeStates(b, a)));
});

test('设置按键合并，各键看自己的修改时间；setSetting 盖新时间', () => {
  const a = normalizeState({}), b = normalizeState({});
  a.settings.nightStart = '22:00'; a.settingsAt.nightStart = 300;
  b.settings.nightStart = '20:30'; b.settingsAt.nightStart = 200;
  b.settings.maxRecordMin = 5; b.settingsAt.maxRecordMin = 250;
  const m = mergeStates(a, b);
  assert.equal(m.settings.nightStart, '22:00');
  assert.equal(m.settings.maxRecordMin, 5);
  assert.equal(m.settings.nightEnd, DEFAULT_SETTINGS.nightEnd, '没人改过的键用默认值');
  const s = normalizeState({});
  s.settingsAt.nightEnd = 5000;
  assert.equal(setSetting(s, 'nightEnd', '06:30', 1000), true);
  assert.equal(s.settingsAt.nightEnd, 5001);
  assert.equal(setSetting(s, 'nightEnd', '06:30', 9000), false, '值没变不算修改');
  assert.equal(setSetting(s, '__proto__', 1), false);
});

test('默认设置：NN 👰🏻‍♀️、我 🥷🏻、夜间 21:00–07:00；坏的设置值换回默认，表情别名保留', () => {
  const s = blankState();
  assert.equal(s.settings.speakers.nn.emoji, NN_EMOJI);
  assert.equal(s.settings.speakers.me.emoji, ME_EMOJI);
  assert.equal(NN_EMOJI, '\u{1F470}\u{1F3FB}‍♀️');
  assert.deepEqual([s.settings.nightStart, s.settings.nightEnd, s.settings.nightOpensRecorder, s.settings.nightForcesDark, s.settings.maxRecordMin], ['21:00', '07:00', true, true, 10]);
  const n = normalizeState({ settings: { nightStart: '25:00', nightForcesDark: 'yes', maxRecordMin: -3, future: { x: 1 },
    speakers: { nn: { name: '小猪', emoji: '🐷', aliases: ['👰‍♀️', 3, ''] }, me: 'bad' } } });
  assert.equal(n.settings.nightStart, '21:00');
  assert.equal(n.settings.nightForcesDark, true);
  assert.equal(n.settings.maxRecordMin, 10);
  assert.deepEqual(n.settings.future, { x: 1 }, '不认识的设置原样保留');
  assert.deepEqual(n.settings.speakers.nn, { name: '小猪', emoji: '🐷', aliases: ['👰‍♀️'] });
  assert.equal(n.settings.speakers.me.emoji, ME_EMOJI);
});

test('整理条目：用户的文字一个字不改，字段补齐，不认识的字段保留，可重复整理', () => {
  const text = '👰🏻‍♀️“今天吃什么”\n🥷🏻 🤯\n\n过了一会儿..\n👰🏻‍♀️ 他说了”';
  const s = normalizeState({ data: { entries: { e1: { date: '2026-11-04', time: '02:58', text, title: '  测试  ', futureField: { keep: true }, updatedAt: '7',
    audio: [{ sha256: SHA_A.toUpperCase(), bytes: '1234' }, { sha256: SHA_A }, { sha256: 'xyz' }, 'junk'] } } } });
  const e = s.data.entries.e1;
  assert.equal(e.text, text);
  assert.equal(e.title, '  测试  ');
  assert.deepEqual(e.futureField, { keep: true });
  assert.equal(e.updatedAt, 7);
  assert.equal(e.createdAt, 7);
  assert.deepEqual([e.status, e.fav, e.note, e.draft, e.timeSource, e.recordedAt, e.tz], ['done', false, '', null, null, null, null]);
  assert.deepEqual(e.source, { kind: 'app' });
  assert.equal(e.audio.length, 1, '坏的、重复的录音引用去掉');
  assert.equal(e.audio[0].sha256, SHA_A);
  assert.equal(e.audio[0].bytes, 1234);
  assert.equal(e.audio[0].durationSec, null);
  assert.equal(canon(normalizeState(s)), canon(s));
});

test('坏日期不丢整条：原值留在 badDate；时间格式不对 → null；status 只认 inbox / done', () => {
  const s = normalizeState({ data: { entries: { e1: { date: '11/4', time: '2:58', status: 'weird', createdAt: Date.UTC(2026, 10, 4, 12), text: '“今天吃什么”' } } } });
  const e = s.data.entries.e1;
  assert.equal(e.date, '2026-11-04');
  assert.equal(e.badDate, '11/4');
  assert.equal(e.time, null);
  assert.equal(e.status, 'done');
  assert.equal(e.text, '“今天吃什么”');
  assert.equal(canon(normalizeState(s)), canon(s));
});

test('同步来的坏数据：__proto__ 不污染原型，不是对象的记录丢掉，不认识的集合保留并合并', () => {
  const evil = JSON.parse('{"data":{"__proto__":{"k":{"id":"k"}},"entries":{"__proto__":{"x":1},"ok":{"date":"2026-01-01","text":"a"},"bad":"x","n":null},"future":{"x":{"v":1,"updatedAt":5}},"junk":3},"settings":{"__proto__":{"polluted":1}}}');
  const s = normalizeState(evil);
  assert.equal(({}).k, undefined);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(Object.keys(s.data.entries), ['ok']);
  assert.equal(s.data.future.x.v, 1);
  assert.equal(s.data.junk, undefined);
  const b = normalizeState({ data: { future: { x: { v: 2, updatedAt: 9 } } } });
  assert.equal(mergeStates(s, b).data.future.x.v, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(mergeStates(blankState(), s).data.entries, 'constructor'));
});

test('stamp 总比上一版新；newId 带前缀且不重复', () => {
  assert.equal(stamp({ id: 'x' }, { id: 'x', updatedAt: 5000 }, 1000).updatedAt, 5001);
  assert.equal(stamp({ id: 'x' }, null, 1000).updatedAt, 1000);
  assert.ok(newId().startsWith('e_'));
  assert.ok(newId('n_').startsWith('n_'));
  assert.notEqual(newId(), newId());
});

test('makeEntry 补齐默认值；byNewest 新的在前，同一天按时间、没时间的排后', () => {
  const now = Date.UTC(2026, 10, 4, 10, 58);
  const e = makeEntry({ text: '👰🏻‍♀️ “”' }, now);
  assert.ok(e.id.startsWith('e_'));
  assert.deepEqual([e.createdAt, e.updatedAt, e.status, e.time, e.fav], [now, now, 'done', null, false]);
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(e.audio, []);
  const list = [
    { id: 'a', date: '2025-01-01', time: null }, { id: 'b', date: '2026-11-04', time: null, createdAt: 2 }, { id: 'c', date: '2026-11-04', time: '02:58' },
    { id: 'n_2026-11-04_2', date: '2026-11-04', time: null, createdAt: 1 }, { id: 'n_2026-11-04_10', date: '2026-11-04', time: null, createdAt: 1 },
  ];
  assert.deepEqual(list.sort(byNewest).map(x => x.id), ['c', 'b', 'n_2026-11-04_10', 'n_2026-11-04_2', 'a']);
});

test('clipIndex：录音 → 引用它的条目（默认不含已删除）', () => {
  const s = normalizeState({ data: { entries: {
    e1: { date: '2026-01-01', audio: [{ sha256: SHA_A }] }, e2: { date: '2026-01-02', audio: [{ sha256: SHA_A }, { sha256: SHA_B }] },
    e3: { date: '2026-01-03', deleted: true, audio: [{ sha256: SHA_B }] } } } });
  const idx = clipIndex(s);
  assert.deepEqual(idx.get(SHA_A), ['e1', 'e2']);
  assert.deepEqual(idx.get(SHA_B), ['e2']);
  assert.deepEqual(clipIndex(s, { includeDeleted: true }).get(SHA_B), ['e2', 'e3']);
});

// ---------- state.js（app 的数据中心） ----------
test('state：没有 localStorage 也能用；mutate 保存、计数、补盖修改时间、通知订阅者', () => {
  state.load({ storage: null });
  assert.equal(Object.keys(state.getState().data.entries).length, 0);
  const st = fakeStorage();
  state.load({ storage: st });
  const seen = [];
  const off = state.subscribe((s, info) => seen.push(info));
  const v0 = state.editVersion();
  const e = makeEntry({ text: '“今天吃什么”' }, 1000);
  const ret = state.mutate(s => { s.data.entries[e.id] = e; return 'ok'; });
  assert.equal(ret, 'ok');
  assert.equal(state.editVersion(), v0 + 1);
  assert.equal(JSON.parse(st.m.get(state.KEY)).data.entries[e.id].text, '“今天吃什么”');
  // 直接改字段、忘了盖时间：自动补上
  const before = state.getState().data.entries[e.id].updatedAt;
  state.mutate(s => { s.data.entries[e.id].fav = true; });
  assert.ok(state.getState().data.entries[e.id].updatedAt > before);
  // 没改东西：不保存、不计数、不通知
  const n = seen.length, v = state.editVersion();
  state.mutate(() => {});
  assert.equal(seen.length, n);
  assert.equal(state.editVersion(), v);
  assert.equal(seen[0].source, 'local');
  assert.deepEqual(seen[0].ids, [e.id]);
  off();
  // 重新读入
  state.load({ storage: st });
  assert.equal(state.getState().data.entries[e.id].fav, true);
});

test('state：硬删除自动变成软删除；撤销删除 = 原样恢复；撤销新建 = 软删除；设置也能撤销', () => {
  state.load({ storage: fakeStorage() });
  const e = makeEntry({ text: '“今天吃什么”' });
  state.mutate(s => { s.data.entries[e.id] = e; }, { undoLabel: '新建' });
  state.mutate(s => { delete s.data.entries[e.id]; }, { undoLabel: '删除' });
  const tomb = state.getState().data.entries[e.id];
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.text, '“今天吃什么”');
  assert.equal(state.peekUndo(), '删除');
  assert.equal(state.undo(), '删除');
  const back = state.getState().data.entries[e.id];
  assert.equal(back.deleted, undefined);
  assert.ok(back.updatedAt > tomb.updatedAt, '撤销也要盖新时间，同步时才会赢');
  assert.equal(state.undo(), '新建');
  assert.equal(state.getState().data.entries[e.id].deleted, true);
  assert.equal(state.undo(), null);
  state.mutate(s => setSetting(s, 'nightStart', '22:30'), { undoLabel: '夜间' });
  assert.equal(state.getState().settings.nightStart, '22:30');
  state.undo();
  assert.equal(state.getState().settings.nightStart, '21:00');
});

test('state：fn 抛错时数据不变；同步合并不算本机修改；导入备份算；开了同步就标记待上传', () => {
  const st = fakeStorage();
  state.load({ storage: st });
  state.setLocal({ sync: { repo: 'someone/babble-data', token: 'x', dirty: false } });
  assert.throws(() => state.mutate(s => { s.data.entries.x = makeEntry(); throw new Error('boom'); }));
  assert.equal(Object.keys(state.getState().data.entries).length, 0);
  assert.equal(state.getLocal().sync.dirty, false);
  const v = state.editVersion();
  const remote = withEntry(blankState(), 'r1', { text: '云端的', updatedAt: 5 });
  state.applyRemote(remote, { device: 'iPad' });
  assert.equal(state.editVersion(), v);
  assert.equal(state.getState().data.entries.r1.text, '云端的');
  assert.equal(state.getLocal().sync.dirty, false);
  const backup = withEntry(blankState(), 'b1', { text: '备份里的', updatedAt: 5 });
  withEntry(backup, 'r1', { text: '更旧的', updatedAt: 1 });
  assert.deepEqual(state.mergeIn(backup), { changed: 1 });
  assert.equal(state.getState().data.entries.r1.text, '云端的', '合并不会用旧的覆盖新的');
  assert.equal(state.editVersion(), v + 1);
  assert.equal(state.getLocal().sync.dirty, true);
  assert.deepEqual(state.mergeIn(backup), { changed: 0 }, '再导入一次什么也不变');
  assert.equal(JSON.parse(st.m.get(state.LKEY)).sync.token, 'x', '本机设置单独存');
  assert.equal(JSON.parse(st.m.get(state.KEY)).sync, undefined, '令牌不进数据');
});

test('state：存储空间满时 mutate 照常改内存，info.saved = false', () => {
  const st = fakeStorage();
  state.load({ storage: st });
  st.setItem = () => { throw new Error('QuotaExceededError'); };
  let info = null;
  const off = state.subscribe((s, i) => { info = i; });
  state.mutate(s => { const e = makeEntry(); s.data.entries[e.id] = e; });
  off();
  assert.equal(info.saved, false);
  assert.equal(live(state.getState()).length, 1);
});

test('state：撤销只改回那次改动的字段——之后同步来的别的字段（对方改的原话）不会被盖掉', () => {
  state.load({ storage: fakeStorage() });
  const e = makeEntry({ text: '👰🏻‍♀️“今天吃什么”', status: 'inbox' });
  state.mutate(s => { s.data.entries[e.id] = e; });
  state.mutate(s => { s.data.entries[e.id].status = 'done'; }, { undoLabel: '整理好了' });
  // 10 秒内同步来另一台设备对原话的修改
  const cur = state.getState().data.entries[e.id];
  const remote = structuredClone(state.getState());
  remote.data.entries[e.id] = { ...cur, text: '👰🏻‍♀️“明天吃什么”', updatedAt: cur.updatedAt + 5 };
  state.applyRemote(remote, { device: 'iPad' });
  assert.equal(state.undo(), '整理好了');
  const back = state.getState().data.entries[e.id];
  assert.equal(back.status, 'inbox', '状态改回去了');
  assert.equal(back.text, '👰🏻‍♀️“明天吃什么”', '对方改的原话还在');
  assert.ok(back.updatedAt > cur.updatedAt + 5);
});

test('state：新建的记录自带修改时间就照用（备忘录导入用很早的时间，任何真正的修改都比它新）；盖在删除标记上的照样盖新时间', () => {
  state.load({ storage: fakeStorage() });
  const e = makeEntry({ id: 'n_2026-01-02_1', text: '“今天吃什么”' }, 5000);
  state.mutate(s => { s.data.entries[e.id] = { ...e, updatedAt: 1 }; });
  assert.equal(state.getState().data.entries[e.id].updatedAt, 1);
  state.mutate(s => { delete s.data.entries[e.id]; });
  const tomb = state.getState().data.entries[e.id];
  state.mutate(s => { s.data.entries[e.id] = { ...e, updatedAt: 1 }; });
  assert.ok(state.getState().data.entries[e.id].updatedAt > tomb.updatedAt, '重新导入要赢过删除标记');
  // 没给修改时间的新记录：照样补上
  state.mutate(s => { s.data.entries.x = { id: 'x', date: '2026-01-02', text: '' }; });
  assert.ok(state.getState().data.entries.x.updatedAt > 1000);
});

test('state：applyRemote 返回有没有存进本机；saveOk() 记着最近一次保存是否成功', () => {
  const st = fakeStorage();
  state.load({ storage: st });
  assert.equal(state.applyRemote(withEntry(blankState(), 'r1', { updatedAt: 5 })), true);
  assert.equal(state.saveOk(), true);
  const real = st.setItem;
  st.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(state.applyRemote(withEntry(blankState(), 'r2', { updatedAt: 5 })), false);
  assert.equal(state.saveOk(), false);
  st.setItem = real;
  state.mutate(s => { s.data.entries.r2.fav = true; });
  assert.equal(state.saveOk(), true);
});
