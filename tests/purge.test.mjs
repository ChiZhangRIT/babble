import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPurger, PURGE_ENABLED, PURGE_GRACE_MS, TRASH_KEY, shaSig, deviceSeen, deviceReport, DEVICE_EVERY } from '../src/core/purge.js';
import { blankState, makeEntry, normalizeEntry, normalizeState, deletedRecord, goneShas, PURGE_MS, TOUCH_MS } from '../src/core/store.js';
import { keepClips } from '../src/core/nightKeep.js';
import { memoryStore } from '../src/core/audioStore.js';
import { memoryNightStore } from '../src/core/nightStore.js';
import { Element, fakeStorage, installDom, find } from './helpers/dom.mjs';
import { audioPlayer, forgetClip } from '../src/ui/player.js';
import { setLang, t } from '../src/i18n.js';

// 永久删除的本机这边（core/purge.js）：清理本机、永久删除、30 天、孤儿录音、设备报到。开关在第一阶段是关着的，
// 这里都传 enabled: true 来测（另有一条专门测关着时什么都不删）。数据、录音全是编的
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 864e5, HOUR = 36e5;
const blob = (s) => new Blob([new TextEncoder().encode('假录音：' + s)], { type: 'audio/mp4' });
const item = (sha, extra = {}) => ({ sha256: sha, mime: 'audio/mp4', bytes: 10, durationSec: 3, origName: '', addedAt: 1000, ...extra });
const live = (id, audio = [], extra = {}) => makeEntry({ id, text: '编的原话 ' + id, audio, ...extra }, 1000);
const deleted = (id, audio = [], at = 5000, extra = {}) => normalizeEntry({ ...live(id, audio), deleted: true, deletedAt: at, updatedAt: at, ...extra }, id);
const tomb = (id, shas, { at = 9000, from = 8000 } = {}) => normalizeEntry({ id, updatedAt: at, purged: true, purgedAt: at, purgedFrom: from, deleted: true,
  gone: shas.map(s => ({ sha256: s, mime: 'audio/mp4', purgedAt: at, from })) }, id);

/** 一套环境：内存的录音库、床头模式库、localStorage，mutate 直接改（再整理一遍），记下调了什么。enabled: null = 不传（用 PURGE_ENABLED） */
function env({ enabled = true, sync = false, confirmed = null, saveOk = true, clock = null, timers = null } = {}) {
  const box = { S: blankState(), sync, confirmed, saveOk };
  const audio = memoryStore(), night = memoryNightStore(), storage = fakeStorage(), local = {};
  const calls = { mutate: [], forget: [], scrub: [], cloud: [], player: [] };
  const journal = { ids: new Set(), async entryIds() { return [...this.ids]; }, async forget(ids) { calls.forget.push([...ids]); for (const id of ids) this.ids.delete(id); } };
  const p = createPurger({
    getState: () => box.S,
    mutate: (fn, opts) => { calls.mutate.push(opts || null); const r = fn(box.S); box.S = normalizeState(box.S); return r; },
    saveOk: () => box.saveOk, syncOn: () => box.sync, confirmedGone: () => box.confirmed,
    audio, night, journal, storage, forgetPlayer: s => calls.player.push(s), scrubText: async ids => { calls.scrub.push([...ids]); },
    cloudHistory: { forget: id => calls.cloud.push(id) }, getLocal: () => local, setLocal: patch => Object.assign(local, patch),
    ...(enabled === null ? {} : { enabled }), ...(clock ? { now: () => clock.t } : {}),
    ...(timers ? { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => { timers.length = 0; } } : {}),
  });
  const put = (e) => { box.S.data.entries[e.id] = normalizeEntry(e, e.id); return box.S.data.entries[e.id]; };
  /** 存一段录音；age：多久以前存的（毫秒），默认两小时前（过了「一小时内碰过的不删」） */
  const clip = async (name, { age = 2 * HOUR, uploaded = false } = {}) => {
    const r = await audio.putClip(blob(name), { mime: 'audio/mp4', uploaded });
    const rec = audio.clips.get(r.sha256);
    rec.addedAt = rec.touchedAt = Date.now() - age;
    return r.sha256;
  };
  return { box, audio, night, storage, local, calls, journal, p, put, clip, has: (sha) => audio.clips.has(sha) };
}

test('开关：第一阶段关着；关着时永久删除、自动永久删除、30 天的记录都不做，别的设备来的墓碑照样清理、移除的录音照样能放回去', async () => {
  assert.equal(PURGE_ENABLED, false);
  const E = env({ enabled: null });
  const A = await E.clip('一'), B = await E.clip('二');
  E.put(deleted('e_del', [item(A)]));
  E.put(normalizeEntry({ ...live('e_rm'), removedAudio: [item(B, { removedAt: 4000 })] }, 'e_rm'));
  const before = JSON.stringify(E.box.S);
  assert.equal(E.p.enabled, false);
  assert.deepEqual(E.p.purgeEntries([{ id: 'e_del', at: E.box.S.data.entries.e_del.updatedAt }]), { done: [], changed: [], skipped: true });
  assert.deepEqual(E.p.purgeClips([{ id: 'e_rm', sha256: B, removedAt: 4000 }]), { done: [], changed: [], skipped: true });
  assert.deepEqual(await E.p.purgeOrphans([{ sha256: A, mime: 'audio/mp4' }]), { done: [], changed: [], skipped: true });
  assert.deepEqual(E.p.autoPurge(), { n: 0 });
  assert.equal(E.p.ensureTrashSince(), false);
  E.p.noteTrash();
  assert.equal(E.storage.getItem(TRASH_KEY), null);
  assert.equal(JSON.stringify(E.box.S), before);
  assert.equal(E.calls.mutate.length, 0);
  // 移除的录音照样能放回去
  const back = E.p.restoreClip('e_rm', B);
  assert.ok(back.audio.some(a => a.sha256 === B) && back.audio.find(a => a.sha256 === B).restoredAt > 4000);
  assert.ok(!(back.removedAudio || []).length);
  // 新版设备永久删除了 e_del（墓碑同步过来）：本机照样删录音
  E.put(tomb('e_del', [A]));
  const r = await E.p.sweep();
  assert.deepEqual(r.clips, [A]);
  assert.ok(!E.has(A) && E.has(B));
});

test('sweep：开着同步只删云端确认过的；还没确认（null）一个字节都不删，文字那几步照样做；做两遍一样', async () => {
  const E = env({ sync: true, confirmed: null });
  const A = await E.clip('留着的'), B = await E.clip('永久删除的'), C = await E.clip('没人用的');
  E.put(live('e_1', [item(A)]));
  E.put(tomb('t_1', [B]));
  let r = await E.p.sweep();
  assert.deepEqual(r.clips, []);
  assert.ok(E.has(A) && E.has(B) && E.has(C));
  assert.deepEqual(E.calls.scrub, [['t_1']]);
  assert.deepEqual(E.calls.cloud, ['t_1']);
  E.box.confirmed = new Set();                          // 确认过的云端里还没有它
  r = await E.p.sweep();
  assert.ok(E.has(B));
  E.box.confirmed = new Set([B]);
  r = await E.p.sweep();
  assert.deepEqual(r.clips, [B]);
  assert.deepEqual(E.calls.player, [B]);
  assert.ok(E.has(A) && !E.has(B) && E.has(C));          // 没有记号的孤儿录音不自动删
  r = await E.p.sweep();
  assert.deepEqual(r.clips, []);
  assert.deepEqual(E.calls.scrub, [['t_1']]);            // 处理过的墓碑这次打开里不再处理
  await E.p.sweep({ full: true });
  assert.deepEqual(E.calls.scrub, [['t_1'], ['t_1']]);   // full：再来一遍
  // 永久删除作废（别的设备改过：合并回来是一条普通的），后来又永久删除了：照样再处理一遍
  E.put(live('t_1'));
  await E.p.sweep();
  E.put(tomb('t_1', [B], { at: 99000, from: 98000 }));
  await E.p.sweep();
  assert.deepEqual(E.calls.scrub, [['t_1'], ['t_1'], ['t_1']]);
});

test('sweep：没开同步看墓碑存进本机没有；存不进本机时不删，存好了下次再删', async () => {
  const E = env({ saveOk: false });
  const B = await E.clip('二');
  E.put(tomb('t_1', [B]));
  await E.p.sweep();
  assert.ok(E.has(B));
  E.box.saveOk = true;
  await E.p.sweep();
  assert.ok(!E.has(B));
});

test('sweep：别的条目在用的（共用、最近删除里的、移除的）不删；编辑页草稿里刚加的不删；连同录音分片（recMeta）一起删', async () => {
  const E = env();
  const [A, B, C, D, X] = await Promise.all(['共用', '最近删除', '移除', '草稿', '真没了'].map(n => E.clip(n)));
  E.put(tomb('t_1', [A, B, C, D, X]));
  E.put(live('e_share', [item(A)]));
  E.put(deleted('e_del', [item(B)]));
  E.put(normalizeEntry({ ...live('e_rm'), removedAudio: [item(C, { removedAt: 4000 })] }, 'e_rm'));
  E.storage.setItem('babble.edit.e_open', JSON.stringify({ w: { audio: [item(D)] }, added: [D], at: Date.now() }));
  await E.audio.putRecMeta({ recId: 'r1', startedAt: 1, done: true, sha256: X });
  await E.audio.putChunk('r1', 0, blob('分片'));
  const r = await E.p.sweep();
  assert.deepEqual(r.clips, [X]);
  assert.ok(E.has(A) && E.has(B) && E.has(C) && E.has(D) && !E.has(X));
  assert.equal(E.audio.recMeta.size, 0);
  assert.equal(E.audio.rec.size, 0);
  E.storage.removeItem('babble.edit.e_open');           // 编辑页放弃了：下次清理就删
  await E.p.sweep();
  assert.ok(!E.has(D));
});

test('sweep：一小时内碰过的不删（导入、留下还没做完）；用户自己刚永久删除的照删，云端确认以后那次清理也照删', async () => {
  const E = env();
  const Y = await E.clip('刚存的', { age: 60e3 });
  E.put(tomb('t_1', [Y]));
  await E.p.sweep();
  assert.ok(E.has(Y));
  await E.p.sweep({ own: [Y] });
  assert.ok(!E.has(Y));
  // 开着同步：点永久删除时还没确认（不删）；确认以后也先留 7 天，过了就删，不用再等一小时
  const clock = { t: Date.now() };
  const F = env({ sync: true, confirmed: new Set(), clock });
  const Z = await F.clip('刚录错的', { age: 60e3 });
  const e = F.put(deleted('e_z', [item(Z)]));
  const res = F.p.purgeEntries([{ id: 'e_z', at: e.updatedAt }]);
  assert.deepEqual(res, { done: ['e_z'], changed: [] });
  await F.p.sweep();
  assert.ok(F.has(Z));
  F.box.confirmed = new Set([Z]);
  await F.p.sweep();
  assert.ok(F.has(Z), '确认了也先留 7 天');
  clock.t += PURGE_GRACE_MS;
  await F.p.sweep();
  assert.ok(!F.has(Z));
});

test('sweep 开着同步：没了的录音先留 7 天（从记号的 purgedAt 算；床头模式的片段不等，见下一条）；这期间永久删除作废了的留着；还没到时候的到时候自己再清理一次', async () => {
  const clock = { t: T0 }, timers = [];
  const E = env({ sync: true, confirmed: new Set(), clock, timers });
  const X = await E.clip('别的设备永久删除的'), Y = await E.clip('后来被恢复的');
  E.put(tomb('t_x', [X], { at: T0, from: T0 - 1 }));
  E.put(tomb('t_y', [Y], { at: T0, from: T0 - 1 }));
  await E.night.putCand({ id: 'c1', s: 'n_a', startAt: 1, entryId: 't_x', sha256: X, keptAt: 1 });
  await E.night.putPart('c1', 0, { b: new ArrayBuffer(8), ls: 1, sp: 1 });
  E.box.confirmed = new Set([X, Y]);
  let r = await E.p.sweep();
  assert.deepEqual([r.clips, r.parts], [[], 1], '录音等着；片段（找回录音用不上）云端确认了就删');
  assert.equal((await E.night.getCand('c1')).gone, true);
  assert.ok(E.has(X) && E.has(Y));
  assert.equal(timers.length, 1, '排了一次到时候的清理');
  assert.ok(Math.abs(timers[0].ms - PURGE_GRACE_MS) <= 10e3, String(timers[0].ms));
  // 期间别的设备（断网时）恢复了 t_y：又有条目在用，不再是「没了」，字节留着（下一轮同步会重新传上仓库）
  E.put(live('t_y', [item(Y)], { updatedAt: T0 + 5 }));
  clock.t = T0 + PURGE_GRACE_MS + 1;
  timers.pop().fn();
  r = await E.p.sweep();                                 // 等定时器排上的那次做完
  assert.ok(!E.has(X) && E.has(Y));
  assert.equal(timers.length, 0, '没有还要等的了');
  // 早就永久删除了的（过了 7 天才同步到）：马上删
  const Z = await E.clip('老墓碑');
  E.put(tomb('t_z', [Z], { at: T0 - 30 * DAY, from: T0 - 31 * DAY }));
  E.box.confirmed = new Set([X, Z]);
  r = await E.p.sweep();
  assert.deepEqual(r.clips, [Z]);
});

test('sweep：一小时内碰过（刚下载到）的没删，过了一小时自己再清理一次（不等下次打开 App）', async () => {
  const timers = [];
  const E = env({ sync: true, confirmed: new Set(), timers });
  const X = await E.clip('刚下载的', { age: 20 * 60e3, uploaded: true });
  E.put(tomb('t_x', [X], { at: Date.now() - 8 * DAY, from: 1 }));
  E.box.confirmed = new Set([X]);
  let r = await E.p.sweep();
  assert.deepEqual(r.clips, []);
  assert.equal(timers.length, 1);
  assert.ok(Math.abs(timers[0].ms - 40 * 60e3) <= 10e3, String(timers[0].ms));
  E.audio.clips.get(X).touchedAt -= HOUR;               // 一小时过去了
  timers.pop().fn();
  r = await E.p.sweep();
  assert.ok(!E.has(X));
  assert.equal(timers.length, 0);
});

test('sweep：修改记录（full 时清掉崩溃留下的）、转文字的记号', async () => {
  const E = env();
  const A = await E.clip('一');
  E.put(tomb('t_1', [A]));
  E.put(live('e_1'));
  E.journal.ids = new Set(['t_1', 'e_1']);
  await E.p.sweep();
  assert.deepEqual(E.calls.forget, []);                  // 平常交给 state.js（写墓碑时当场 forget）
  await E.p.sweep({ full: true });
  assert.deepEqual(E.calls.forget, [['t_1']]);
  E.local.sttRun = { key: 'e_1|' + 'a'.repeat(64) };
  await E.p.sweep();
  assert.ok(E.local.sttRun);
  E.local.sttRun = { key: 't_1|' + A };
  await E.p.sweep();
  assert.equal(E.local.sttRun, null);
  E.local.sttRun = { key: 'e_1|' + A };                   // 录音没了（别的条目里）也清
  await E.p.sweep();
  assert.equal(E.local.sttRun, null);
});

test('sweep：床头模式——留下又永久删除的片段删掉声音、标 gone，entryId / sha256 留着；留下、撤销、再永久删除的照样找到；没确认前不删', async () => {
  const E = env({ sync: true, confirmed: new Set() });
  const K1 = await E.clip('留下的一段'), K2 = await E.clip('撤销过的一段');
  const seed = async (id, extra) => { await E.night.putCand({ id, s: 'n_a', startAt: 1, ...extra }); await E.night.putPart(id, 0, { b: new ArrayBuffer(8), ls: 1, sp: 1 }); };
  await seed('c1', { entryId: 'e_k', sha256: K1, keptAt: 1 });
  await seed('c2', { entryId: null, sha256: K2, keptAt: null });          // 留下以后撤销：sha256 留着
  await seed('c3', { entryId: null });
  await seed('c4', { entryId: 'e_other', sha256: 'b'.repeat(64), keptAt: 1 });
  E.put(tomb('e_k', [K1]));
  E.put(tomb('e_undone', [K2]));
  E.put(live('e_other', [item('b'.repeat(64))]));
  let r = await E.p.sweep();
  assert.equal(r.parts, 0);
  assert.equal(E.night.maps.parts.size, 4);
  E.box.confirmed = new Set([K1, K2]);
  r = await E.p.sweep();
  assert.equal(r.parts, 2);
  const c1 = await E.night.getCand('c1'), c2 = await E.night.getCand('c2'), c3 = await E.night.getCand('c3'), c4 = await E.night.getCand('c4');
  assert.deepEqual([c1.gone, c1.entryId, c1.sha256], [true, 'e_k', K1]);
  assert.deepEqual([c2.gone, c2.sha256], [true, K2]);
  assert.ok(!c3.gone && !c4.gone);
  assert.equal(E.night.maps.parts.size, 2);
  r = await E.p.sweep();
  assert.equal(r.parts, 0);                              // 已经 gone 的不再碰
});

test('床头模式（开着同步，刚永久删除、还在 7 天里）：留下、撤销、永久删除那条 → 云端确认后片段马上删、标 gone；确认前后都不能再留，那段录音一直是没了的', async () => {
  const T = Date.now(), clock = { t: T }, timers = [];      // 条目的时间用的是真的时钟：跟它对齐
  const E = env({ sync: true, confirmed: null, clock, timers });
  const SR = 16000, pcm = new Int16Array(SR).map((_, i) => ((i * 37) % 2000) - 1000);       // 编的数字序列，不是录音
  const sessions = { n_a: { id: 'n_a', tz: 'Asia/Shanghai', nightOf: '2026-11-19' } };
  await E.night.putCand({ id: 'c1', s: 'n_a', state: 'new', startAt: T - 6 * HOUR, samples: SR, sr: SR });
  await E.night.putPart('c1', 0, { b: pcm.buffer.slice(0), ls: SR, sp: 1 });
  const deps = { night: E.night, audio: E.audio, getState: () => E.box.S, put: E.put };
  const e1 = await keepClips(deps, [await E.night.getCand('c1')], sessions, { now: T - 5 * HOUR });
  const S = e1.audio[0].sha256;
  E.box.S.data.entries[e1.id] = deletedRecord(E.box.S.data.entries[e1.id]);   // 撤销：那条进「最近删除」
  await E.night.patchCand('c1', { entryId: null, keptAt: null });                          // 候选去掉链接，sha256 留着
  assert.deepEqual(E.p.purgeEntries([{ id: e1.id, at: E.box.S.data.entries[e1.id].updatedAt }]).done, [e1.id]);
  assert.ok(goneShas(E.box.S).has(S));
  const again = () => E.night.getCand('c1').then(c => keepClips(deps, [c], sessions, { now: T }));
  // 云端还没确认（比如断网）：片段还在，但已经不能再留
  await E.p.sweep();
  assert.equal(E.night.maps.parts.size, 1);
  await assert.rejects(again(), (err) => err.code === 'purged' && err.candId === 'c1');
  // 云端确认了：不等 7 天，片段马上删、标 gone（entryId / sha256 照旧）；录音库里的那份照样等 7 天（作废了好找回）
  E.box.confirmed = new Set([S]);
  const r = await E.p.sweep();
  assert.equal(r.parts, 1);
  const c = await E.night.getCand('c1');
  assert.deepEqual([c.gone, c.entryId, c.sha256, E.night.maps.parts.size], [true, null, S, 0]);
  assert.ok(E.has(S), '录音库里的等 7 天');
  assert.equal(timers.length, 1);
  assert.ok(Math.abs(timers[0].ms - PURGE_GRACE_MS) <= 10e3, '只为录音库里那份排了一次，片段不用等');
  await assert.rejects(again(), (err) => err.code === 'purged');
  assert.ok(goneShas(E.box.S).has(S), '一直是没了的：不会又有条目在用、重新传上仓库');
  assert.equal(Object.values(E.box.S.data.entries).filter(e => !e.purged).length, 0);
});

test('永久删除条目：按看到的那一版删，期间变了 → changed；已经是墓碑 → done；一次 mutate（cause purge）；没开同步马上删本机的录音', async () => {
  const E = env();
  const A = await E.clip('一', { age: 60e3 }), B = await E.clip('二');
  const a = E.put(deleted('e_a', [item(A)]));
  const b = E.put(deleted('e_b', [item(B)]));
  E.put(tomb('e_c', []));
  E.put(live('e_live'));
  const res = E.p.purgeEntries([{ id: 'e_a', at: a.updatedAt }, { id: 'e_b', at: b.updatedAt - 1 }, { id: 'e_c', at: 1 }, { id: 'e_live', at: 1000 }, { id: 'e_none', at: 1 }]);
  assert.deepEqual(res, { done: ['e_a', 'e_c'], changed: ['e_b', 'e_live', 'e_none'] });
  assert.deepEqual(E.calls.mutate, [{ cause: 'purge' }]);
  const t = E.box.S.data.entries.e_a;
  assert.ok(t.purged && t.purgedFrom === a.updatedAt && t.text === '' && !t.audio.length);
  assert.ok(t.gone.some(g => g.sha256 === A));
  assert.ok(!E.box.S.data.entries.e_b.purged);
  await E.p.sweep();                                     // 等永久删除后排上的那次清理做完
  assert.ok(!E.has(A), '刚删的不用等一小时');
  assert.ok(E.has(B));
});

test('永久删除移除的录音：removedAt 对得上才删（别的设备放回去、又移除过 → changed）；全部永久删除一次做完', async () => {
  const E = env();
  const A = await E.clip('一'), B = await E.clip('二'), C = await E.clip('三');
  E.put(normalizeEntry({ ...live('e_1', [item(C)]), removedAudio: [item(A, { removedAt: 4000 }), item(B, { removedAt: 4100 })] }, 'e_1'));
  const d = E.put(deleted('e_2', [item('c'.repeat(64))]));
  const res = E.p.purgeAll({ entries: [{ id: 'e_2', at: d.updatedAt }], clips: [{ id: 'e_1', sha256: A, removedAt: 4000 }, { id: 'e_1', sha256: B, removedAt: 9999 }] });
  assert.deepEqual(res, { done: ['e_2', { id: 'e_1', sha256: A }], changed: [{ id: 'e_1', sha256: B }] });
  assert.equal(E.calls.mutate.length, 1);
  const e1 = E.box.S.data.entries.e_1;
  assert.ok(!e1.purged && e1.text === '编的原话 e_1' && e1.audio.length === 1);
  assert.deepEqual(e1.removedAudio.map(x => x.sha256), [B]);
  assert.ok(e1.gone.some(g => g.sha256 === A && g.from === 4000));
  assert.ok(E.box.S.data.entries.e_2.purged);
  await E.p.sweep();
  assert.ok(!E.has(A) && E.has(B) && E.has(C));
  assert.deepEqual(E.p.purgeAll({}), { done: [], changed: [] });
});

test('孤儿录音：再查一次没人用（期间有条目在用了、草稿里加了、正在存的 → changed；已经没了 → done），写一个孤儿墓碑，照常删', async () => {
  const E = env();
  const [O1, O2, U, D, R] = await Promise.all(['孤儿一', '孤儿二', '又有人用', '草稿', '正在存'].map(n => E.clip(n)));
  const G = await E.clip('早没了');
  E.put(live('e_1', [item(U)]));
  E.put(tomb('t_1', [G]));
  E.storage.setItem('babble.edit.new', JSON.stringify({ w: { audio: [] }, added: [D], at: 1 }));
  await E.audio.putRecMeta({ recId: 'r1', startedAt: 1, done: true, sha256: R });
  const res = await E.p.purgeOrphans([O1, O2, U, D, R, G, 'nope'].map(s => ({ sha256: s, mime: 'audio/webm' })).concat([{ sha256: O1.toUpperCase() }]));
  assert.deepEqual(res.done.sort(), [O1, O2, G].sort());
  assert.deepEqual(res.changed.sort(), [U, D, R].sort());
  const orphans = Object.values(E.box.S.data.entries).filter(e => e.id.startsWith('o_'));
  assert.equal(orphans.length, 1);
  assert.ok(orphans[0].purged && orphans[0].purgedFrom === 0);
  assert.deepEqual(orphans[0].gone.map(g => g.sha256).sort(), [O1, O2].sort());
  assert.equal(orphans[0].gone.find(g => g.sha256 === O1).mime, 'audio/webm');
  await E.p.sweep();
  assert.ok(!E.has(O1) && !E.has(O2) && E.has(U) && E.has(D) && E.has(R));
});

test('这台设备上没有条目在用的录音：不算条目在用的、已经没了的、草稿里的、正在存的、一小时内的；标出上传过没有', async () => {
  const E = env();
  const [O, Up, Use, Rm, Del, Dr, Rec, Young, G] = await Promise.all(['孤儿', '传过', '在用', '移除', '最近删除', '草稿', '正在存', '刚存', '没了'].map(n => E.clip(n)));
  E.audio.clips.get(Up).uploaded = true;
  E.audio.clips.get(Young).touchedAt = Date.now() - 60e3;
  E.put(live('e_1', [item(Use)]));
  E.put(normalizeEntry({ ...live('e_2'), removedAudio: [item(Rm, { removedAt: 4000 })] }, 'e_2'));
  E.put(deleted('e_3', [item(Del)]));
  E.put(tomb('t_1', [G]));
  E.storage.setItem('babble.edit.e_1', JSON.stringify({ w: {}, inline: { [Dr]: { startedAt: 1 } }, at: 1 }));
  await E.audio.putRecMeta({ recId: 'r1', startedAt: 1, sha256: Rec });
  const list = await E.p.localOrphans();
  assert.deepEqual(list.map(x => x.sha256).sort(), [O, Up].sort());
  assert.equal(list.find(x => x.sha256 === Up).uploaded, true);
  assert.equal(list.find(x => x.sha256 === O).uploaded, false);
});

test('30 天：从这台设备第一次看到算、也不早于 trashSince；已经在「最近删除」里的从开放那天算；删除时间错了（太早、在将来）都不影响', async () => {
  const clock = { t: T0 };
  const E = env({ clock });
  E.put(deleted('e_old', [], T0 - 90 * DAY));            // 早就删了
  E.put(deleted('e_future', [], T0 + 100 * DAY));        // 别的设备时钟快
  assert.equal(E.p.ensureTrashSince(), true);
  assert.equal(E.box.S.settings.trashSince, T0);
  assert.equal(E.p.ensureTrashSince(), false);           // 只写一次
  assert.deepEqual(E.p.autoPurge(), { n: 0 });           // 第一次看到：一个都不删
  clock.t = T0 + 30 * DAY - 1;
  assert.deepEqual(E.p.autoPurge(), { n: 0 });
  for (const k of ['e:e_old', 'e:e_future']) assert.ok(E.p.trashInfo(k).shownAt <= T0 + PURGE_MS, k);
  clock.t = T0 + 30 * DAY;
  assert.deepEqual(E.p.autoPurge(), { n: 2 });
  assert.ok(E.box.S.data.entries.e_old.purged && E.box.S.data.entries.e_future.purged);
  assert.deepEqual(E.calls.mutate.at(-1), { cause: 'purge' });
  assert.equal(E.p.trashInfo('e:e_old').shownAt, null);   // 不在「最近删除」里了
});

test('30 天：trashSince 晚于第一次看到 → 从 trashSince 算；删了恢复又删 → 重新算；恢复的条目里移除的录音从恢复那天算；显示的日期不晚于真删的', async () => {
  const clock = { t: T0 };
  const E = env({ clock });
  const A = 'a'.repeat(64), B = 'b'.repeat(64);
  E.put(deleted('e_1', [], T0 - DAY));
  E.put(normalizeEntry({ ...deleted('e_2', [item(A)], T0 - DAY), removedAudio: [item(B, { removedAt: T0 - 2 * DAY })] }, 'e_2'));
  E.p.noteTrash();                                        // 开关打开前记下的（多个标签页、旧数据）不算早于 trashSince
  clock.t = T0 + 5 * DAY;
  E.p.ensureTrashSince();
  assert.equal(E.p.trashInfo('e:e_1').shownAt, T0 + 5 * DAY + PURGE_MS);
  assert.equal(E.p.trashInfo('c:e_2:' + B).shownAt, null);   // 删除了的条目里的移除的录音跟着条目走
  // e_2 第 10 天恢复：移除的录音第一次出现在「最近删除」里
  clock.t = T0 + 10 * DAY;
  E.put({ ...E.box.S.data.entries.e_2, deleted: false, deletedAt: undefined, updatedAt: clock.t });
  E.p.noteTrash();
  // e_1 第 12 天恢复、第 13 天又删
  clock.t = T0 + 12 * DAY;
  E.put({ ...E.box.S.data.entries.e_1, deleted: false, deletedAt: undefined, updatedAt: clock.t });
  E.p.noteTrash();
  clock.t = T0 + 13 * DAY;
  E.put({ ...E.box.S.data.entries.e_1, deleted: true, deletedAt: clock.t, updatedAt: clock.t });
  E.p.noteTrash();
  const purgeAt = { e1: T0 + 43 * DAY, b: T0 + 40 * DAY };
  assert.ok(E.p.trashInfo('e:e_1').shownAt <= purgeAt.e1);
  assert.ok(E.p.trashInfo('c:e_2:' + B).shownAt <= purgeAt.b);
  clock.t = T0 + 35 * DAY;                               // trashSince + 30 天：哪个都还没到
  assert.deepEqual(E.p.autoPurge(), { n: 0 });
  clock.t = purgeAt.b;
  assert.deepEqual(E.p.autoPurge(), { n: 1 });
  const e2 = E.box.S.data.entries.e_2;
  assert.ok(!e2.purged && !(e2.removedAudio || []).length && e2.gone.some(g => g.sha256 === B && g.from === T0 - 2 * DAY));
  assert.ok(e2.audio.some(a => a.sha256 === A));
  clock.t = purgeAt.e1 - 1;
  assert.deepEqual(E.p.autoPurge(), { n: 0 });
  clock.t = purgeAt.e1;
  assert.deepEqual(E.p.autoPurge(), { n: 1 });
  assert.ok(E.box.S.data.entries.e_1.purged);
});

test('babble.trash：几个标签页一起写取较早的；不在「最近删除」里的去掉；记在将来的（时钟错过）改成现在；本机数据有问题时不自动删', async () => {
  const clock = { t: T0 };
  const E = env({ clock });
  const e = E.put(deleted('e_1', [], T0));
  E.storage.setItem(TRASH_KEY, JSON.stringify({ ['e:e_1|' + e.deletedAt]: T0 - 5 * DAY, 'e:e_gone|1': 1 }));
  E.p.noteTrash();
  assert.deepEqual(JSON.parse(E.storage.getItem(TRASH_KEY)), { ['e:e_1|' + e.deletedAt]: T0 - 5 * DAY });
  E.storage.setItem(TRASH_KEY, JSON.stringify({ ['e:e_1|' + e.deletedAt]: T0 + 50 * DAY }));
  E.p.noteTrash();
  assert.deepEqual(JSON.parse(E.storage.getItem(TRASH_KEY)), { ['e:e_1|' + e.deletedAt]: T0 });
  const F = createPurger({ getState: () => E.box.S, mutate: () => { throw new Error('不该写'); }, storage: E.storage, storageOk: () => false, enabled: true, now: () => T0 + 99 * DAY });
  assert.deepEqual(F.autoPurge(), { n: 0 });
  assert.equal(F.ensureTrashSince(), false);
});

test('设备报到：新记录；没变化 3 天内不再写；改名记下以前的名字；版本、谁在用变了就写', () => {
  const a = deviceSeen(null, { id: 'd_1', name: 'iPhone', who: 'me', build: 'b1', now: T0 });
  assert.deepEqual(a, { id: 'd_1', name: 'iPhone', who: 'me', build: 'b1', features: ['purge1'], updatedAt: T0, seenAt: T0, since: T0, whoAt: T0 });
  assert.equal(deviceSeen(a, { id: 'd_1', name: 'iPhone', who: 'me', build: 'b1', now: T0 + DEVICE_EVERY - 1 }), null);
  assert.equal(deviceSeen(a, { id: 'd_1', name: 'iPhone', who: 'me', build: 'b1', now: T0 + DEVICE_EVERY }).seenAt, T0 + DEVICE_EVERY);
  const b = deviceSeen(a, { id: 'd_1', name: '小明的 iPhone', who: 'me', build: 'b1', now: T0 + 1 });
  assert.deepEqual([b.name, b.aka, b.updatedAt], ['小明的 iPhone', ['iPhone'], T0 + 1]);
  assert.deepEqual([b.since, b.whoAt], [T0, T0], '第一次报到、「谁在用」改的时刻都留着');
  const c = deviceSeen(b, { id: 'd_1', name: '小明的 iPhone', who: 'me', build: 'b2', now: T0 + 2 });
  assert.deepEqual([c.build, c.since, c.whoAt], ['b2', T0, T0]);
  const d = deviceSeen(b, { id: 'd_1', name: '小明的 iPhone', who: 'nn', build: 'b1', now: T0 + 2 });
  assert.deepEqual([d.who, d.since, d.whoAt], ['nn', T0, T0 + 2]);
  assert.equal(deviceSeen(b, { id: 'd_1', name: '小明的 iPhone', who: 'me', build: 'b1', now: T0 + 3 }), null);
  assert.equal(deviceSeen(b, { id: 'd_1', name: '小明的 iPhone', who: 'me', build: 'b1', now: T0 - DAY }), null, '时钟往回拨：不每轮都重写');
  assert.equal(deviceSeen(null, { id: '', name: 'x' }), null);
  // 时钟慢的设备再报到：updatedAt 照样比上一次新
  assert.equal(deviceSeen(a, { id: 'd_1', name: 'iPad', now: T0 - 5 }).updatedAt, T0 + 1);
});

test('设备一览：报过到的（新的在前）；60 天内改过梦话、旧版本推送过、却没报到的列为等待；改过名、同名不同人的分得清', () => {
  const s = blankState();
  s.data.devices = {
    d_me: { id: 'd_me', name: '小明的 iPhone', aka: ['iPhone'], who: 'me', build: 'b1', updatedAt: T0 - HOUR, seenAt: T0 - HOUR },
    d_mac: { id: 'd_mac', name: 'Mac', who: null, build: 'b1', updatedAt: T0 - DAY, seenAt: T0 - DAY },
  };
  const sign = (id, device, who, at) => { s.data.entries[id] = normalizeEntry({ ...live(id), updatedAt: at, updatedBy: { who, device, at } }, id); };
  sign('e_1', 'iPhone', 'me', T0 - 2 * DAY);              // 改名以前签的
  sign('e_2', 'iPhone', 'nn', T0 - 3 * DAY);              // 另一台也叫 iPhone 的（她的）
  sign('e_3', 'iPad', null, T0 - 10 * DAY);
  sign('e_4', 'iPad', 'nn', T0 - 11 * DAY);
  sign('e_5', 'Mac', 'me', T0 - 5 * DAY);
  sign('e_6', '旧电脑', null, T0 - 90 * DAY);             // 太久以前
  const r = deviceReport(s, { me: 'd_me', oldDevices: ['iPhone', 'Windows'], now: T0 });
  assert.deepEqual(r.updated.map(d => [d.id, d.me]), [['d_me', true], ['d_mac', false]]);
  assert.equal(r.updated[0].seenAt, T0 - HOUR);
  assert.deepEqual(r.waiting.map(w => [w.name, w.who, w.old]), [['iPhone', 'nn', true], ['iPad', 'nn', false], ['Windows', null, true]]);
  assert.equal(r.waiting[2].at, null);
  // 这台设备（还没报到，比如还没同步过）不算在等的，列在报到的最前面（seenAt null）
  const r2 = deviceReport(s, { me: 'd_new', self: { name: 'iPad', who: 'nn' }, oldDevices: ['Windows'], now: T0 });
  assert.deepEqual(r2.waiting.map(w => w.name), ['iPhone', 'Windows']);
  assert.deepEqual(r2.updated[0], { id: 'd_new', name: 'iPad', who: 'nn', build: null, seenAt: null, me: true });
  assert.equal(deviceReport(s, { me: 'd_me', self: { name: '小明的 iPhone', who: 'me' }, now: T0 }).updated.length, 2, '报过到的不重复列');
  assert.deepEqual(deviceReport(blankState()), { updated: [], waiting: [] });
});

test('设备一览：两台同名的（她的 iPad 还是旧版本、没说是谁在用；他的 iPad 更新了）——他报到时早就写了谁，之后没写谁的签名是别的设备签的，列为等待；旧版本推送过的名字一定列上', () => {
  const s = blankState();
  s.data.devices = { d_his: { id: 'd_his', name: 'iPad', who: 'me', build: 'b1', updatedAt: T0 - HOUR, seenAt: T0 - HOUR, since: T0 - 5 * DAY, whoAt: T0 - 5 * DAY } };
  const sign = (id, device, who, at) => { s.data.entries[id] = normalizeEntry({ ...live(id), updatedAt: at, updatedBy: { who, device, at } }, id); };
  sign('e_his_old', 'iPad', null, T0 - 20 * DAY);         // 他更新以前、还没说是谁时签的：对得上他
  sign('e_his', 'iPad', 'me', T0 - 2 * DAY);
  let r = deviceReport(s, { me: 'd_mac', self: { name: 'Mac', who: 'me' }, now: T0 });
  assert.deepEqual(r.waiting, []);
  sign('e_hers', 'iPad', null, T0 - DAY);                 // 她的旧 iPad 签的
  r = deviceReport(s, { me: 'd_mac', self: { name: 'Mac', who: 'me' }, now: T0 });
  assert.deepEqual(r.waiting.map(w => [w.name, w.who, w.at, w.old]), [['iPad', null, T0 - DAY, false]]);
  // 只改了设置（没签名），sync 看到 iPad 用旧版本推送过（已经按报到的时间筛过）：同名的报过到也照样列上
  delete s.data.entries.e_hers;
  r = deviceReport(s, { me: 'd_mac', self: { name: 'Mac', who: 'me' }, oldDevices: ['iPad'], now: T0 });
  assert.deepEqual(r.waiting.map(w => [w.name, w.who, w.old]), [['iPad', null, true]]);
  // 这台设备就是他的 iPad：按它的记录算（不因为是自己就把她的签名也算成自己的）
  sign('e_hers', 'iPad', null, T0 - DAY);
  r = deviceReport(s, { me: 'd_his', self: { name: 'iPad', who: 'me' }, now: T0 });
  assert.deepEqual(r.waiting.map(w => w.name), ['iPad']);
});

test('shaSig：和顺序无关；Set、Map 都行；没有 → none', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.equal(shaSig(new Set([a, b])), shaSig(new Set([b, a])));
  assert.equal(shaSig(new Map([[a, 1], [b, 2]])), shaSig(new Set([a, b])));
  assert.notEqual(shaSig(new Set([a])), shaSig(new Set([a, b])));
  assert.equal(shaSig(null), 'none');
  assert.equal(TOUCH_MS, HOUR);
});

test('app.js：墓碑对页面不可见、写不进去；永久删除了的录音不给（不碰本机录音库）；开关关着时永久删除、清理云端历史什么都不做；移除的录音照样放回去', async () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64), G = 'c'.repeat(64);
  const st = blankState();
  st.data.entries.e_live = normalizeEntry({ ...live('e_live', [item(A)]), updatedBy: { who: 'nn', device: 'iPhone', at: Date.now() } }, 'e_live');
  st.data.entries.e_rm = normalizeEntry({ ...live('e_rm'), removedAudio: [item(B, { removedAt: 4000 })] }, 'e_rm');
  st.data.entries.e_del = deleted('e_del', [], 5000);
  st.data.entries.t_gone = tomb('t_gone', [G]);
  const storage = fakeStorage([['babble.state', JSON.stringify(st)], ['babble.local', JSON.stringify({ device: 'iPad', whoAsked: true })]]);
  const loc = { hash: '#/', protocol: 'http:' };
  let txs = 0;
  const dom = installDom({ localStorage: storage, location: loc, history: { state: {}, replaceState(s, title, hash) { loc.hash = hash; } },
    navigator: { languages: ['zh-CN'], userAgent: 'Synthetic', platform: 'Synthetic', locks: { request: async (name, fn) => fn() } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => { throw new Error('should not fetch'); }, indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        request.result = { transaction() { txs++; const tx = { objectStore: () => ({ getAll: () => ({ result: [] }), get: () => ({ result: null }), count: () => ({ result: 0 }) }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
        request.onsuccess();
      });
      return request;
    } },
    setInterval: () => 0, setTimeout: () => 0 });
  try {
    const shell = new Element('div'); shell.className = 'app';
    for (const id of ['side', 'main']) { const el = new Element('div'); el.id = id; shell.append(el); }
    const tabs = new Element('nav'); tabs.id = 'tabs';
    dom.doc.body.append(shell, tabs);
    await import('../src/app.js?test=purge-wiring');
    const { ctx, state } = window.__babble;
    await ctx.recovered; await ctx.nightRecovered;
    assert.equal(ctx.entry('t_gone'), null);
    assert.ok(ctx.tombstone('t_gone').purged);
    assert.equal(ctx.tombstone('e_live'), null);
    assert.equal(ctx.put({ ...ctx.tombstone('t_gone'), text: '复活了', purged: false, deleted: false }), null);
    assert.equal(ctx.update('t_gone', { text: '复活了' }), null);
    assert.ok(state.getState().data.entries.t_gone.purged && state.getState().data.entries.t_gone.text === '');
    assert.ok(ctx.goneShas().has(G) && !ctx.goneShas().has(A));
    const before = txs;
    assert.equal(await ctx.clipBlob(G, 'audio/mp4'), null);
    assert.equal(txs, before, '永久删除了的：不去本机录音库找');
    assert.equal(await ctx.clipBlob(A), null);
    assert.ok(txs > before, '别的照常去找');
    assert.deepEqual(ctx.removedClips().map(x => [x.entryId, x.item.sha256]), [['e_rm', B]]);
    assert.ok(ctx.restoreClip('e_rm', B).audio.some(a => a.sha256 === B));
    assert.deepEqual(ctx.removedClips(), []);
    const saved = JSON.stringify(state.getState().data.entries);
    assert.equal((await ctx.purge([{ id: 'e_del', at: ctx.entry('e_del').updatedAt }])).skipped, true);
    assert.equal((await ctx.purgeAll({ entries: [{ id: 'e_del', at: ctx.entry('e_del').updatedAt }], clips: [] })).skipped, true);
    assert.equal((await ctx.purgeOrphans([{ sha256: 'd'.repeat(64) }])).skipped, true);
    assert.deepEqual(await ctx.sync.squash(), { ok: false, skipped: true });
    assert.equal(JSON.stringify(state.getState().data.entries), saved);
    assert.equal(state.getState().settings.trashSince, undefined, '开关关着：不写 trashSince');
    assert.equal(storage.getItem(TRASH_KEY), null);
    assert.deepEqual(ctx.trashInfo('e:e_del'), { shownAt: null });
    const stt = ctx.sync.status();
    assert.deepEqual([stt.pendingPurge, stt.purging, stt.oldDevices], [0, false, []]);
    assert.deepEqual(ctx.sync.devices().waiting.map(w => [w.name, w.who]), [['iPhone', 'nn']]);
    state.setJournal(null);
  } finally { dom.restore(); }
});

test('app.js：编辑页留下的草稿，那条后来永久删除了——过了一天也照样回到那个编辑页（让人选另存为新的一条或丢掉），别的过了一天的不回去', async () => {
  const st = blankState();
  st.data.entries.e_live = live('e_live');
  st.data.entries.t_gone = tomb('t_gone', []);
  const old = Date.now() - 3 * DAY;
  const storage = fakeStorage([['babble.state', JSON.stringify(st)], ['babble.local', JSON.stringify({ device: 'iPad', whoAsked: true })],
    ['babble.edit.e_live', JSON.stringify({ w: { text: '编的改了一半' }, at: old })],
    ['babble.edit.t_gone', JSON.stringify({ w: { text: '编的原话 改了一半' }, at: old })]]);
  const loc = { hash: '#/', protocol: 'http:' };
  const dom = installDom({ localStorage: storage, location: loc, history: { state: {}, replaceState(s, title, hash) { loc.hash = hash; } },
    navigator: { languages: ['zh-CN'], userAgent: 'Synthetic', platform: 'Synthetic', locks: { request: async (name, fn) => fn() } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => { throw new Error('should not fetch'); }, indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        request.result = { transaction() { const tx = { objectStore: () => ({ getAll: () => ({ result: [] }), get: () => ({ result: null }), count: () => ({ result: 0 }) }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
        request.onsuccess();
      });
      return request;
    } },
    setInterval: () => 0, setTimeout: () => 0 });
  try {
    const shell = new Element('div'); shell.className = 'app';
    for (const id of ['side', 'main']) { const el = new Element('div'); el.id = id; shell.append(el); }
    const tabs = new Element('nav'); tabs.id = 'tabs';
    dom.doc.body.append(shell, tabs);
    if (!Element.prototype.prepend) Element.prototype.prepend = function (...kids) { const rest = this.children; this.children = []; this.append(...kids); for (const c of rest) this.children.push(c); };
    await import('../src/app.js?test=stale-tomb-draft');
    assert.equal(loc.hash, '#/edit/t_gone');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.ok(find(dom.doc.body, el => (el.attrs.class || el.className || '').includes('ed-purged')), '编辑页说「已经永久删除」，等人选');
    window.__babble.state.setJournal(null);
  } finally { dom.restore(); }
});

test('和真的 state.js 一起：永久删除走 mutate（cause purge）、写不回去、撤销不回来；移除的录音永久删除后不会被当成又拿掉了一次；移除、放回去、再移除以后按旧的那次删 → changed', async () => {
  const state = await import('../src/core/state.js');
  state.load({ storage: null });
  const audio = memoryStore(), infos = [];
  const off = state.subscribe((st, info) => infos.push(info));
  const p = createPurger({ getState: state.getState, mutate: state.mutate, saveOk: state.saveOk, audio, enabled: true });
  try {
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    state.mutate(s => { s.data.entries.e_1 = live('e_1', [item(A, { addedAt: Date.now() }), item(B, { addedAt: Date.now() })]); s.data.entries.e_2 = live('e_2'); });
    state.mutate(s => { s.data.entries.e_1 = { ...s.data.entries.e_1, audio: s.data.entries.e_1.audio.filter(a => a.sha256 !== B) }; });   // 编辑页「移除」
    const rm = state.getState().data.entries.e_1.removedAudio;
    assert.deepEqual(rm.map(x => x.sha256), [B]);
    const res = p.purgeClips([{ id: 'e_1', sha256: B, removedAt: rm[0].removedAt }]);
    assert.deepEqual(res, { done: [{ id: 'e_1', sha256: B }], changed: [] });
    const e1 = state.getState().data.entries.e_1;
    assert.ok(!(e1.removedAudio || []).length && e1.gone.some(g => g.sha256 === B));
    assert.deepEqual(e1.audio.map(a => a.sha256), [A]);
    // 条目：删除 → 永久删除 → 别的页面整条写回去、撤销都不会复活
    state.mutate(s => { s.data.entries.e_2 = { ...s.data.entries.e_2, deleted: true, deletedAt: Date.now() }; }, { undoLabel: '删了' });
    const at = state.getState().data.entries.e_2.updatedAt;
    infos.length = 0;
    assert.deepEqual(p.purgeEntries([{ id: 'e_2', at }]), { done: ['e_2'], changed: [] });
    assert.deepEqual(infos.map(i => i.purged), [['e_2']]);
    state.mutate(s => { s.data.entries.e_2 = { ...s.data.entries.e_2, purged: false, deleted: false, text: '复活' }; });
    assert.equal(state.undo(), null);
    const t2 = state.getState().data.entries.e_2;
    assert.ok(t2.purged && t2.text === '' && t2.purgedFrom === at);
    // 移除、放回去、再移除：新的 removedAt；按上一次移除（页面画出来时那次）去永久删除 → changed，不删
    state.mutate(s => { s.data.entries.e_1 = { ...s.data.entries.e_1, audio: [] }; });
    const r1 = state.getState().data.entries.e_1.removedAudio.find(x => x.sha256 === A).removedAt;
    assert.ok(p.restoreClip('e_1', A).audio.some(x => x.sha256 === A));
    assert.equal(p.restoreClip('e_1', A), null, '已经放回去了');
    state.mutate(s => { s.data.entries.e_1 = { ...s.data.entries.e_1, audio: [] }; });
    const r2 = state.getState().data.entries.e_1.removedAudio.find(x => x.sha256 === A).removedAt;
    assert.ok(r2 > r1);
    assert.deepEqual(p.purgeClips([{ id: 'e_1', sha256: A, removedAt: r1 }]), { done: [], changed: [{ id: 'e_1', sha256: A }] });
  } finally { off(); }
});

test('player.forgetClip：正在放的这段停掉、释放（不管哪个播放器）；再点重新取，取不到就说找不到；别的录音不受影响', async () => {
  class FakeAudio {
    constructor() { this.paused = true; this.src = ''; this.duration = 3; this.currentTime = 0; this.on = []; }
    emit(k) { for (const l of this.on) if (l.k === k && !(l.signal && l.signal.aborted)) l.fn(); }
    load() {} play() { this.paused = false; this.emit('play'); return Promise.resolve(); } pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
    addEventListener(k, fn, o) { this.on.push({ k, fn, signal: o && o.signal }); } removeAttribute(k) { if (k === 'src') this.src = ''; }
  }
  const dom = installDom({ Audio: FakeAudio });
  dom.doc.createElement = (tag) => { const el = new Element(tag); el.style.setProperty = () => {}; return el; };
  setLang('zh-Hans');
  try {
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    let blobA = blob('一'), asked = 0;
    const pa = audioPlayer({ getBlob: async () => { asked++; return blobA; }, key: A, level: false });
    const pb = audioPlayer({ getBlob: async () => blob('二'), key: B, level: false });
    const btnOf = (p) => find(p, el => el.tag === 'button');
    const click = async (p) => { for (const fn of btnOf(p).events.click) await fn({ preventDefault() {}, stopPropagation() {} }); };
    await click(pa);
    assert.equal(asked, 1);
    assert.ok(pa.classList.contains('playing'));
    forgetClip(B);                                        // 别的录音：不受影响
    assert.ok(pa.classList.contains('playing'));
    forgetClip(A);
    assert.ok(!pa.classList.contains('playing'), '停掉了');
    blobA = null;                                         // 本机已经删掉、也不给下载了
    await click(pa);
    assert.equal(asked, 2, '再点重新取');
    assert.ok(pa.textContent.includes(t('player.missing')));
    await click(pb);
    assert.ok(pb.classList.contains('playing'));
    pa.destroy(); pb.destroy();
  } finally { dom.restore(); }
});
