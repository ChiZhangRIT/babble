import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepClips, itemFor, entryFieldsFor } from '../src/core/nightKeep.js';
import { memoryNightStore } from '../src/core/nightStore.js';
import { memoryStore } from '../src/core/audioStore.js';
import { blankState, makeEntry, normalizeEntry, goneShas } from '../src/core/store.js';
import { wavBlob } from '../src/core/nightDetect.js';
import { recTimeFields } from '../src/core/drafts.js';
import { sha256Hex } from '../src/core/sha256.js';
import { extForMime } from '../src/core/audioStore.js';

// 床头模式的「留下」：候选片段 → 录音库里的 m4a（编不了是 WAV）→ 一条待整理。声音全是编的数字序列（仓库是公开的），不是录音。
// Node 里没有 AudioEncoder：不给 toM4a 时走 WAV（下面前一半的测试）；m4a 的用假的 toM4a（后面「m4a」开头的测试）
const SR = 16000;
const TZ = 'America/Los_Angeles';
const T0 = Date.UTC(2026, 10, 18, 10, 13, 5);          // 洛杉矶 11月18日 凌晨2:13:05（算 11月17日那一夜）
const S1 = { id: 'n_a', v: 1, nightOf: '2026-11-17', startedAt: T0 - 3 * 3600e3, endedAt: T0 + 4 * 3600e3, status: 'ended', tz: TZ };
const SESSIONS = { n_a: S1 };

/** 编的 PCM16：seed 不同内容就不同（sha 也不同） */
const pcm = (n, seed) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = ((i * 37 + seed * 101) % 2000) - 1000; return a; };

/** 往 night 里放一段 state 'new' 的候选和它的分片（每片 partLen 个样本；have = 分片里实际有几个样本，默认 = samples） */
async function seedCand(night, id, { startAt, samples, seed = 1, have = samples, partLen = SR, s = 'n_a', extra = {} }) {
  const all = pcm(have, seed);
  let seq = 0;
  for (let i = 0; i < have; i += partLen) await night.putPart(id, seq++, { b: all.slice(i, i + partLen).buffer, ls: Math.min(i + partLen, have), sp: 1 });
  const c = {
    id, s, v: 1, state: 'new', startAt, speechAt: startAt + 8000, endAt: startAt + samples * 1000 / SR, samples, sr: SR,
    durationSec: Math.round(samples / SR * 10) / 10, speechSec: 1, gateSec: 1, peakDb: -30, vadMax: 0.9, cut: 'quiet', contOf: null, parts: seq, lostSec: 0, ...extra,
  };
  await night.putCand(c);
  return { c, pcm: all.slice(0, Math.min(samples, have)) };
}

/** 假的 ctx：真的 normalizeEntry、memoryStore、memoryNightStore；记下 put 和 putClip 的调用 */
function setup({ fail } = {}) {
  const night = memoryNightStore({ fail }), audio = memoryStore(), s = blankState();
  const puts = [], putClips = [], realPutClip = audio.putClip;
  audio.putClip = (blob, opts) => { putClips.push({ blob, opts }); return realPutClip(blob, opts); };
  const deps = {
    night, audio, getState: () => s,
    put: (e, opts) => { puts.push({ e, opts }); s.data.entries[e.id] = normalizeEntry(e, e.id); return s.data.entries[e.id]; },
    newEntry: (fields) => makeEntry(fields, 5000),
  };
  return { night, audio, s, puts, putClips, deps };
}

const entriesOf = (s) => Object.values(s.data.entries);
async function quiet(fn) {
  const w = console.warn, seen = [];
  console.warn = (...a) => { seen.push(a); };
  try { return [await fn(), seen]; } finally { console.warn = w; }
}

test('留一段：一条待整理，一项 audio/wav（带 startedAt、不起名字），日期时间取片段开头，source 记下哪一夜', async () => {
  const { night, audio, s, puts, putClips, deps } = setup();
  const samples = 2.5 * SR;
  const { c, pcm: p } = await seedCand(night, 'c_1', { startAt: T0, samples });
  const e = await keepClips(deps, [c], SESSIONS, { undoLabel: '留下了 1 段', now: 9000 });

  assert.equal(entriesOf(s).length, 1);
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].opts, { undoLabel: '留下了 1 段' });
  assert.equal(e, s.data.entries[e.id]);
  assert.deepEqual([e.status, e.text], ['inbox', '']);
  assert.deepEqual(e.source, { kind: 'app', night: '2026-11-17' });
  const rt = recTimeFields(T0, TZ);
  assert.deepEqual([e.date, e.time, e.recordedAt, e.tz, e.timeSource], [rt.date, rt.time, rt.recordedAt, TZ, 'recorder']);
  assert.deepEqual([e.date, e.time], ['2026-11-18', '02:13']);          // 凌晨的记在当天，不是那一夜的日期

  assert.equal(e.audio.length, 1);
  const [a] = e.audio;
  assert.deepEqual([a.mime, a.bytes, a.durationSec, a.origName, a.addedAt, a.startedAt], ['audio/wav', 44 + samples * 2, 2.5, '', 9000, T0]);
  assert.equal('name' in a, false);

  // 录音库里是 WAV：44 字节头 + 分片原样拼起来
  assert.equal(putClips.length, 1);
  assert.equal(putClips[0].opts.mime, 'audio/wav');
  const stored = await audio.getClip(a.sha256);
  assert.equal(stored.mime, 'audio/wav');
  assert.equal(a.sha256, await sha256Hex(stored.blob));
  const buf = new Uint8Array(await stored.blob.arrayBuffer());
  assert.equal(String.fromCharCode(...buf.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(buf.buffer).getUint32(40, true), samples * 2);
  assert.deepEqual(new Int16Array(buf.slice(44).buffer), p);

  // 候选记下进了哪一条；状态还是 new（留没留下看 entryId 指的条目在不在）
  const c2 = await night.getCand('c_1');
  assert.deepEqual([c2.entryId, c2.sha256, c2.keptAt, c2.state], [e.id, a.sha256, 9000, 'new']);
});

test('三段（打乱顺序给）合成一条：按时间排，名字是开始时刻 HH:MM，日期时间取最早一段', async () => {
  const { night, s, putClips, deps } = setup();
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 20 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 150e3, samples: 12 * SR + 300, seed: 2 });
  const { c: c3 } = await seedCand(night, 'c_3', { startAt: T0 + 200e3, samples: 3 * SR, seed: 3 });
  const e = await keepClips(deps, [c3, c1, c2], new Map([['n_a', S1]]), { undoLabel: '留下了 3 段', now: 9000 });

  assert.equal(entriesOf(s).length, 1);
  assert.deepEqual(e.audio.map(a => a.startedAt), [T0, T0 + 150e3, T0 + 200e3]);
  assert.deepEqual(e.audio.map(a => a.name), ['02:13', '02:15', '02:16']);
  assert.deepEqual(e.audio.map(a => a.durationSec), [20, 12, 3]);
  assert.ok(e.audio.every(a => a.mime === 'audio/wav'));
  assert.deepEqual([e.date, e.time, e.source.night], ['2026-11-18', '02:13', '2026-11-17']);
  assert.equal(putClips.length, 3);
  assert.ok(putClips.every(x => x.opts.mime === 'audio/wav'));
  assert.equal(new Set(e.audio.map(a => a.sha256)).size, 3);

  for (const [id, i] of [['c_1', 0], ['c_2', 1], ['c_3', 2]]) {
    const c = await night.getCand(id);
    assert.deepEqual([c.entryId, c.sha256, c.keptAt], [e.id, e.audio[i].sha256, 9000]);
  }
});

test('分片比 samples 长（崩溃收尾时截短过）：WAV 只到 samples；分片缺了：按分片里实际有的', async () => {
  const { night, audio, deps } = setup();
  const { c, pcm: p } = await seedCand(night, 'c_1', { startAt: T0, samples: 1.5 * SR, have: 2 * SR });
  const e = await keepClips(deps, [c], SESSIONS, { now: 9000 });
  assert.deepEqual([e.audio[0].bytes, e.audio[0].durationSec], [44 + 1.5 * SR * 2, 1.5]);
  const buf = new Uint8Array(await (await audio.getClip(e.audio[0].sha256)).blob.arrayBuffer());
  assert.deepEqual(new Int16Array(buf.slice(44).buffer), p);

  const { c: short } = await seedCand(night, 'c_2', { startAt: T0 + 600e3, samples: 3 * SR, have: 2 * SR, seed: 2 });
  const e2 = await keepClips(deps, [short], SESSIONS, { now: 9000 });
  assert.deepEqual([e2.audio[0].bytes, e2.audio[0].durationSec], [44 + 2 * SR * 2, 2]);
});

test('有一段的声音已经清掉了 → 抛 gone，什么都没存（录音库、条目、候选都没动）', async () => {
  const { night, audio, s, puts, putClips, deps } = setup();
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  await night.deleteParts('c_2');                                       // 分片一片都没了
  await assert.rejects(keepClips(deps, [c1, c2], SESSIONS), (err) => err.code === 'gone' && err.candId === 'c_2');

  const { c: c3 } = await seedCand(night, 'c_3', { startAt: T0 + 120e3, samples: 2 * SR, seed: 3, extra: { gone: true } });
  await assert.rejects(keepClips(deps, [c3, c1], SESSIONS), (err) => err.code === 'gone' && err.candId === 'c_3');

  assert.deepEqual([putClips.length, audio.clips.size, puts.length, entriesOf(s).length], [0, 0, 0, 0]);
  assert.equal(night.calls.includes('patchCand'), false);
  assert.equal((await night.getCand('c_1')).entryId, undefined);
});

test('putClip 出错照样抛：条目不建，候选不改', async () => {
  const { night, s, puts, deps } = setup();
  const { c } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR });
  deps.audio.putClip = async () => { throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' }); };
  await assert.rejects(keepClips(deps, [c], SESSIONS), /disk full/);
  assert.deepEqual([puts.length, entriesOf(s).length], [0, 0]);
  assert.equal(night.calls.includes('patchCand'), false);
});

test('存好条目、候选没改上（被打断）：再留一次只补链接，不再建一条；那条删了才新建', async () => {
  const { night, s, puts, deps } = setup({ fail: { patchCand: 2 } });
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const [e1, warned] = await quiet(() => keepClips(deps, [c1, c2], SESSIONS, { undoLabel: '留下了 2 段', now: 9000 }));
  assert.equal(warned.length, 2);                                       // 只记日志，条目照样返回
  assert.equal(entriesOf(s).length, 1);
  assert.equal((await night.getCand('c_1')).entryId, undefined);

  // 用户在条目里改了字，也照样认得
  s.data.entries[e1.id].text = '（编的）一句梦话';
  const e2 = await keepClips(deps, [c2, c1], SESSIONS, { undoLabel: '留下了 2 段', now: 9500 });
  assert.equal(e2.id, e1.id);
  assert.equal(e2.text, '（编的）一句梦话');
  assert.deepEqual([puts.length, entriesOf(s).length], [1, 1]);         // 没有第二次 put（也就没有第二个「撤销」）
  for (const [id, i] of [['c_1', 0], ['c_2', 1]]) {
    const c = await night.getCand(id);
    assert.deepEqual([c.entryId, c.sha256, c.keptAt], [e1.id, e1.audio[i].sha256, 9500]);
  }

  // 只有一段在那条里 → 不算，新建
  const { c: c3 } = await seedCand(night, 'c_3', { startAt: T0 + 90e3, samples: 2 * SR, seed: 3 });
  const e3 = await keepClips(deps, [c1, c3], SESSIONS, { now: 9600 });
  assert.notEqual(e3.id, e1.id);
  assert.equal(entriesOf(s).length, 2);

  // 那条删了（最近删除里的不算）→ 新建一条
  s.data.entries[e1.id] = { ...s.data.entries[e1.id], deleted: true, deletedAt: 9700 };
  s.data.entries[e3.id] = { ...s.data.entries[e3.id], deleted: true, deletedAt: 9700 };
  const e4 = await keepClips(deps, [c1, c2], SESSIONS, { now: 9800 });
  assert.ok(![e1.id, e3.id].includes(e4.id));
  assert.equal(puts.length, 3);
  assert.equal((await night.getCand('c_1')).entryId, e4.id);
});

test('留下后撤销（那条进了「最近删除」）再留同样这几段：给了 restore 就恢复那条（原话还在），不建重复的；段数不一样的不算', async () => {
  const { night, s, puts, deps } = setup();
  const restored = [];
  deps.restore = (id) => { restored.push(id); const { deleted, deletedAt, ...e } = s.data.entries[id]; s.data.entries[id] = e; return e; };
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const e1 = await keepClips(deps, [c1, c2], SESSIONS, { now: 9000 });
  s.data.entries[e1.id] = { ...s.data.entries[e1.id], text: '（编的）一句梦话', deleted: true, deletedAt: 9100 };
  const e2 = await keepClips(deps, [c1], SESSIONS, { now: 9200 });          // 只留其中一段：那条有两段，不算
  assert.notEqual(e2.id, e1.id);
  assert.deepEqual(restored, []);
  s.data.entries[e2.id] = { ...s.data.entries[e2.id], deleted: true, deletedAt: 9300 };
  const e3 = await keepClips(deps, [c2, c1], SESSIONS, { now: 9400 });
  assert.equal(e3.id, e1.id);
  assert.equal(e3.text, '（编的）一句梦话');
  assert.deepEqual(restored, [e1.id]);
  assert.equal(puts.length, 2);
  assert.equal((await night.getCand('c_1')).entryId, e1.id);
  assert.equal((await night.getCand('c_2')).entryId, e1.id);
});

test('没有要留的 → null，什么都不碰', async () => {
  const { night, puts, putClips, deps } = setup();
  assert.equal(await keepClips(deps, [], SESSIONS), null);
  assert.deepEqual([puts.length, putClips.length, night.calls.length], [0, 0, 0]);
});

/** 把条目 id 换成永久删除以后的墓碑（只有 gone 记号，没有内容） */
const purgeIt = (s, id, shas, at = 9900) => {
  s.data.entries[id] = normalizeEntry({ id, updatedAt: at, purged: true, purgedAt: at, purgedFrom: at - 1, deleted: true,
    gone: shas.map(sha => ({ sha256: sha, mime: 'audio/wav', purgedAt: at, from: at - 1 })) }, id);
};

test('永久删除了的录音不能再留（不然它又有条目在用，等于找回来、重新上传）：记着的 sha256 没了 → 抛 purged，什么都不读、不存', async () => {
  const { night, audio, s, puts, putClips, deps } = setup();
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const e1 = await keepClips(deps, [c1], SESSIONS, { now: 9000 });
  const S = e1.audio[0].sha256;
  // 留下、撤销（候选去掉链接，sha256 留着），那条后来永久删除了；本机的录音也清掉了
  await night.patchCand('c_1', { entryId: null, keptAt: null });
  purgeIt(s, e1.id, [S]);
  audio.clips.delete(S);
  assert.ok(goneShas(s).has(S));
  const n = { puts: puts.length, putClips: putClips.length, gets: night.calls.filter(x => x === 'getParts').length };
  const c = await night.getCand('c_1');
  await assert.rejects(keepClips(deps, [c2, c], SESSIONS, { now: 9500 }), (err) => err.code === 'purged' && err.candId === 'c_1');
  assert.deepEqual([puts.length, putClips.length, night.calls.filter(x => x === 'getParts').length], [n.puts, n.putClips, n.gets]);
  assert.ok(!audio.clips.has(S), '录音库里没再放一份');
  assert.ok(goneShas(s).has(S), '还是没了');
  assert.equal((await night.getCand('c_2')).entryId, undefined, '一起勾的另一段也没留');
});

test('永久删除了的录音不能再留：没记下 sha256、拼出来正好是它 → 抛 purged，录音库里不放，候选记下 sha256；存的时候同步来了永久删除 → 不建条目', async () => {
  const { night, audio, s, puts, putClips, deps } = setup();
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const S = await sha256Hex(wavBlob([pcm(2 * SR, 1).buffer], 2 * SR, SR));
  purgeIt(s, 't_old', [S]);                               // 以前留下过（候选没记上 sha256），那条后来永久删除了
  await assert.rejects(keepClips(deps, [c1], SESSIONS), (err) => err.code === 'purged' && err.candId === 'c_1');
  assert.deepEqual([putClips.length, audio.clips.size, puts.length], [0, 0, 0]);
  assert.equal((await night.getCand('c_1')).sha256, S, '记下 sha256：昨夜页、清理认得出它');

  // 读声音、存录音库的时候（中间在等）合并进来一条永久删除：查和建条目在同一拍里，不建
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const real = audio.putClip;
  audio.putClip = async (blob, opts) => { const r = await real(blob, opts); purgeIt(s, 't_late', [r.sha256]); return r; };
  await assert.rejects(keepClips(deps, [c2], SESSIONS), (err) => err.code === 'purged' && err.candId === 'c_2');
  assert.equal(puts.length, 0);
  assert.equal(entriesOf(s).filter(e => !e.purged).length, 0);
  assert.equal((await night.getCand('c_2')).entryId, undefined);
  assert.ok((await night.getCand('c_2')).sha256, '这时也记下 sha256：昨夜页马上认得出、不能再放');

  // 同一段录音还有别的条目在用（不算没了）：照样能留（只补链接）
  audio.putClip = real;
  const { c: c3 } = await seedCand(night, 'c_3', { startAt: T0 + 120e3, samples: 2 * SR, seed: 3 });
  const e3 = await keepClips(deps, [c3], SESSIONS, { now: 9000 });
  purgeIt(s, 't_dup', [e3.audio[0].sha256]);
  assert.equal(goneShas(s).has(e3.audio[0].sha256), false);
  assert.equal((await keepClips(deps, [await night.getCand('c_3')], SESSIONS, { now: 9100 })).id, e3.id);
});

test('itemFor：§4.5 的字段；时长按 samples，WAV 短了按 WAV；合成时的名字按那一晚的时区', () => {
  const sha = 'a'.repeat(64);
  const cand = { id: 'c_1', startAt: T0, samples: 391234, sr: SR };
  assert.deepEqual(itemFor({ sha256: sha, mime: 'audio/wav', bytes: 44 + 391234 * 2 }, cand, { merged: false, tz: TZ, now: 7000 }),
    { sha256: sha, mime: 'audio/wav', bytes: 44 + 391234 * 2, durationSec: 24.5, origName: '', addedAt: 7000, startedAt: T0 });
  assert.equal(itemFor({ sha256: sha, mime: 'audio/wav', bytes: 44 + 391234 * 2 }, cand, { merged: true, tz: TZ, now: 7000 }).name, '02:13');
  assert.equal(itemFor({ sha256: sha, mime: 'audio/wav', bytes: 1000 }, cand, { merged: true, tz: 'Asia/Taipei', now: 7000 }).name, '18:13');
  assert.equal(itemFor({ sha256: sha, mime: 'audio/wav', bytes: 44 + SR * 2 }, cand, { tz: TZ }).durationSec, 1);    // 分片缺了
  assert.equal(itemFor({ sha256: sha, mime: 'audio/wav', bytes: null }, cand, { tz: TZ }).durationSec, 24.5);
  assert.equal(itemFor({ sha256: sha, bytes: 100 }, cand, { tz: TZ }).mime, 'audio/wav');
  // m4a：时长按 PCM（给了 samples 按它，不然按 cand.samples），和文件多大无关
  assert.equal(itemFor({ sha256: sha, mime: 'audio/mp4', bytes: 1000 }, cand, { tz: TZ }).durationSec, 24.5);
  assert.equal(itemFor({ sha256: sha, mime: 'audio/mp4', bytes: 1000 }, cand, { tz: TZ, samples: 2 * SR }).durationSec, 2);
  assert.equal(itemFor({ sha256: sha, mime: 'audio/mp4', bytes: 1000 }, cand, { tz: TZ }).mime, 'audio/mp4');
  // 存进条目时这些新字段不会被整理掉
  const e = normalizeEntry({ id: 'e1', audio: [itemFor({ sha256: sha, mime: 'audio/wav', bytes: 1000 }, cand, { merged: true, tz: TZ, now: 7000 })] }, 'e1');
  assert.deepEqual([e.audio[0].startedAt, e.audio[0].name], [T0, '02:13']);
});

test('entryFieldsFor：最早一段的开头、它那一晚的时区和日期；Map 或对象都行；找不到那一晚也不抛', () => {
  const S2 = { ...S1, id: 'n_b', tz: 'Asia/Taipei', nightOf: '2026-11-18' };
  const late = { id: 'c_9', s: 'n_a', startAt: T0 + 3600e3 };
  const early = { id: 'c_1', s: 'n_b', startAt: T0 - 60e3 };           // 台北 11月18日 18:12
  const want = { ...recTimeFields(T0 - 60e3, 'Asia/Taipei'), status: 'inbox', text: '', source: { kind: 'app', night: '2026-11-18' } };
  assert.deepEqual(entryFieldsFor([late, early], { n_a: S1, n_b: S2 }), want);
  assert.deepEqual(entryFieldsFor([late, early], new Map([['n_a', S1], ['n_b', S2]])), want);
  assert.deepEqual([want.date, want.time, want.timeSource], ['2026-11-18', '18:12', 'recorder']);

  // 晚上 11:58 开始的：记在那天
  const beforeMidnight = { id: 'c_2', s: 'n_a', startAt: Date.UTC(2026, 10, 18, 7, 58) };
  const f = entryFieldsFor([beforeMidnight], SESSIONS);
  assert.deepEqual([f.date, f.time, f.tz], ['2026-11-17', '23:58', TZ]);

  const lost = entryFieldsFor([{ id: 'c_3', s: 'n_x', startAt: T0 }], SESSIONS);
  assert.deepEqual([lost.status, lost.source, lost.timeSource], ['inbox', { kind: 'app', night: null }, 'recorder']);
});

// ---------- m4a ----------

/** 假的 toM4a：每次编出来都不一样（编号不同 → sha256 不同，像不保证一模一样的编码器）；same：同样的 PCM 编出来一样；off：编不了（null） */
function fakeM4a({ off = false, same = false } = {}) {
  const calls = [];
  let k = 0;
  const fn = async (p, o) => {
    calls.push({ pcm: p, ...o });
    if (off) return null;
    return new Blob([same ? 'm4a ' : `m4a #${++k} `, p.slice().buffer], { type: 'audio/mp4' });
  };
  return Object.assign(fn, { calls });
}
/** 「撤销」：候选去掉链接（sha256 留着），条目进「最近删除」 */
async function unkeep(night, s, entryId, ids, at = 9100) {
  for (const id of ids) await night.patchCand(id, { entryId: null, keptAt: null });
  s.data.entries[entryId] = { ...s.data.entries[entryId], deleted: true, deletedAt: at };
}
const restorer = (s) => (id) => { const { deleted, deletedAt, ...e } = s.data.entries[id]; s.data.entries[id] = e; return e; };

test('m4a：能编就存 audio/mp4（同步传成 .m4a），时长按 PCM；编码器收到这段的 PCM、采样率和开始时刻；新编的先给候选记下 sha256', async () => {
  const { night, audio, s, putClips, deps } = setup();
  deps.toM4a = fakeM4a();
  const samples = 2.5 * SR;
  const { c, pcm: p } = await seedCand(night, 'c_1', { startAt: T0, samples, have: 3 * SR });
  const e = await keepClips(deps, [c], SESSIONS, { now: 9000 });
  const [a] = e.audio;
  const stored = await audio.getClip(a.sha256);
  assert.deepEqual([a.mime, a.durationSec, a.bytes, a.startedAt], ['audio/mp4', 2.5, stored.blob.size, T0]);
  assert.deepEqual([putClips.length, putClips[0].opts.mime, stored.mime, extForMime(stored.mime)], [1, 'audio/mp4', 'audio/mp4', 'm4a']);
  assert.equal(a.sha256, await sha256Hex(stored.blob));
  assert.equal(deps.toM4a.calls.length, 1);
  const call = deps.toM4a.calls[0];
  assert.ok(call.pcm instanceof Int16Array);
  assert.deepEqual(call.pcm, p);                                         // 只到 samples（分片多出来的半秒不要）
  assert.deepEqual([call.sr, call.createdAt], [SR, T0]);
  const c2 = await night.getCand('c_1');
  assert.deepEqual([c2.entryId, c2.sha256, c2.keptAt], [e.id, a.sha256, 9000]);
  assert.equal(night.calls.filter(x => x === 'patchCand').length, 2);     // 先记 sha256，再记进了哪一条
  assert.equal(audio.clips.size, 1, '不另存 WAV');
});

test('m4a：几段一起留，每段各编一份；编不了的那段存 WAV（一条里两种都行）', async () => {
  const { night, deps } = setup();
  const m = fakeM4a();
  let n = 0;
  deps.toM4a = (p, o) => (++n === 2 ? Promise.resolve(null) : m(p, o));
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 3 * SR, seed: 2 });
  const { c: c3 } = await seedCand(night, 'c_3', { startAt: T0 + 120e3, samples: SR, seed: 3 });
  const e = await keepClips(deps, [c3, c2, c1], SESSIONS, { now: 9000 });
  assert.deepEqual(e.audio.map(a => [a.mime, a.durationSec, a.name]), [['audio/mp4', 2, '02:13'], ['audio/wav', 3, '02:14'], ['audio/mp4', 1, '02:15']]);
  assert.equal(e.audio[1].bytes, 44 + 3 * SR * 2);
});

test('m4a：编不了（不支持、出错、核对不过 → toM4a 给 null）→ 照旧存 WAV，候选只改一次', async () => {
  const { night, audio, deps } = setup();
  deps.toM4a = fakeM4a({ off: true });
  const { c, pcm: p } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR });
  const e = await keepClips(deps, [c], SESSIONS, { now: 9000 });
  assert.deepEqual([e.audio[0].mime, e.audio[0].bytes, e.audio[0].durationSec], ['audio/wav', 44 + 2 * SR * 2, 2]);
  const buf = new Uint8Array(await (await audio.getClip(e.audio[0].sha256)).blob.arrayBuffer());
  assert.deepEqual(new Int16Array(buf.slice(44).buffer), p);
  assert.equal(deps.toM4a.calls.length, 1);
  assert.equal(night.calls.filter(x => x === 'patchCand').length, 1);
});

test('m4a：toM4a 自己抛错（注入的）也只记日志、存 WAV', async () => {
  const { night, deps } = setup();
  deps.toM4a = async () => { throw new Error('boom (injected)'); };
  const { c } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR });
  const [e, warned] = await quiet(() => keepClips(deps, [c], SESSIONS, { now: 9000 }));
  assert.equal(e.audio[0].mime, 'audio/wav');
  assert.equal(warned.length, 1);
});

test('m4a：留下、撤销、再留同样这几段 → 用录音库里记着的那份（不重编，sha256 不变），恢复「最近删除」里的那条', async () => {
  const { night, audio, s, puts, deps } = setup();
  deps.toM4a = fakeM4a();
  deps.restore = restorer(s);
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const e1 = await keepClips(deps, [c1, c2], SESSIONS, { now: 9000 });
  const shas = e1.audio.map(a => a.sha256);
  await unkeep(night, s, e1.id, ['c_1', 'c_2']);
  const again = [await night.getCand('c_1'), await night.getCand('c_2')];
  assert.deepEqual(again.map(c => c.sha256), shas);
  const e2 = await keepClips(deps, again, SESSIONS, { now: 9400 });
  assert.equal(e2.id, e1.id);
  assert.deepEqual(e2.audio.map(a => a.sha256), shas);
  assert.equal(deps.toM4a.calls.length, 2, '没有重编');
  assert.deepEqual([puts.length, audio.clips.size], [1, 2]);
  assert.equal((await night.getCand('c_1')).entryId, e1.id);

  // 记着的那份已经不在录音库里（也不是永久删除了）：重编一份（编出来不一样 → 新建一条）
  await unkeep(night, s, e1.id, ['c_1'], 9500);
  audio.clips.delete(shas[0]);
  const e3 = await keepClips(deps, [await night.getCand('c_1')], SESSIONS, { now: 9600 });
  assert.notEqual(e3.audio[0].sha256, shas[0]);
  assert.equal(e3.audio[0].mime, 'audio/mp4');
  assert.equal(deps.toM4a.calls.length, 3);
  assert.equal((await night.getCand('c_1')).sha256, e3.audio[0].sha256);
});

test('m4a：存好条目、候选的链接没改上（被打断）→ 再留一次只补链接（新编的已经先记下了 sha256，不重编），不建第二条', async () => {
  const { night, s, puts, deps } = setup();
  deps.toM4a = fakeM4a();
  const put = deps.put;
  deps.put = (e, o) => { night.fail.patchCand = 2; return put(e, o); };   // 先记 sha256 成功，之后两次改链接失败
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const [e1, warned] = await quiet(() => keepClips(deps, [c1, c2], SESSIONS, { now: 9000 }));
  assert.equal(warned.length, 2);
  const half = await night.getCand('c_1');
  assert.deepEqual([half.entryId, half.sha256], [undefined, e1.audio[0].sha256]);
  deps.put = put;
  const e2 = await keepClips(deps, [half, await night.getCand('c_2')], SESSIONS, { now: 9500 });
  assert.equal(e2.id, e1.id);
  assert.deepEqual([puts.length, entriesOf(s).length, deps.toM4a.calls.length], [1, 1, 2]);
  assert.equal((await night.getCand('c_2')).entryId, e1.id);
});

test('m4a：新编的先给候选记下 sha256 再存进录音库；记不上 → 抛出去，录音库里不放、条目不建（不会有一份谁都不认得的 m4a）；再点一次照常留下', async () => {
  const { night, audio, s, puts, putClips, deps } = setup({ fail: { patchCand: 1 } });
  deps.toM4a = fakeM4a();
  const order = [], realPatch = night.patchCand, realPut = audio.putClip;
  night.patchCand = (id, p) => { order.push('patch:' + Object.keys(p).join(',')); return realPatch(id, p); };
  audio.putClip = (b, o) => { order.push('putClip'); return realPut(b, o); };
  const { c } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR });
  await assert.rejects(keepClips(deps, [c], SESSIONS, { now: 9000 }), /patchCand \(injected\)/);
  assert.deepEqual([putClips.length, audio.clips.size, puts.length, entriesOf(s).length], [0, 0, 0, 0]);
  assert.equal((await night.getCand('c_1')).sha256, undefined);
  order.length = 0;
  const e = await keepClips(deps, [await night.getCand('c_1')], SESSIONS, { now: 9100 });
  assert.deepEqual(order, ['patch:sha256', 'putClip', 'patch:entryId,sha256,keptAt']);
  assert.equal(e.audio[0].mime, 'audio/mp4');
  const c2 = await night.getCand('c_1');
  assert.deepEqual([c2.sha256, c2.entryId], [e.audio[0].sha256, e.id]);
  assert.ok(audio.clips.has(c2.sha256));
  // WAV（编不了）不用先记：WAV 的 sha256 总能从 PCM 算出来
  const { c: w } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: SR, seed: 2 });
  deps.toM4a = fakeM4a({ off: true });
  order.length = 0;
  await keepClips(deps, [w], SESSIONS, { now: 9200 });
  assert.deepEqual(order, ['putClip', 'patch:entryId,sha256,keptAt']);
});

test('m4a：以前的版本留下的 WAV 原样用——候选记着 WAV 的 sha256、或者这段的 WAV 已经在录音库里 → 不编 m4a、不另存一份', async () => {
  const { night, audio, s, puts, deps } = setup({ fail: { patchCand: 1 } });
  deps.restore = restorer(s);
  deps.toM4a = fakeM4a({ off: true });                                   // 「以前的版本」：只存 WAV
  const { c: c1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 600e3, samples: 2 * SR, seed: 2 });
  const [w2] = await quiet(() => keepClips(deps, [c2], SESSIONS, { now: 8000 }));   // 这次改链接失败：候选没记下 sha256
  assert.equal((await night.getCand('c_2')).sha256, undefined);
  const w1 = await keepClips(deps, [c1], SESSIONS, { now: 8500 });
  await unkeep(night, s, w1.id, ['c_1']);
  assert.equal(audio.clips.size, 2);

  deps.toM4a = fakeM4a();                                                // 更新到这一版
  const e1 = await keepClips(deps, [await night.getCand('c_1')], SESSIONS, { now: 9000 });
  assert.equal(e1.id, w1.id, '恢复了那条');
  assert.equal(e1.audio[0].mime, 'audio/wav');
  const e2 = await keepClips(deps, [await night.getCand('c_2')], SESSIONS, { now: 9100 });
  assert.equal(e2.id, w2.id, '只补链接');
  assert.deepEqual([e2.audio[0].mime, (await night.getCand('c_2')).sha256], ['audio/wav', w2.audio[0].sha256]);
  assert.deepEqual([deps.toM4a.calls.length, audio.clips.size, puts.length], [0, 2, 2]);
});

test('m4a：永久删除了的录音不能再留——编出来的 m4a、这段的 WAV（以前的版本留下的）正好是它，或者存的时候同步来了 → purged，什么都不存', async () => {
  const { night, audio, s, puts, putClips, deps } = setup();
  deps.toM4a = fakeM4a({ same: true });
  // 编出来的 m4a 正好是永久删除了的
  const { c: c1, pcm: p1 } = await seedCand(night, 'c_1', { startAt: T0, samples: 2 * SR, seed: 1 });
  const M = await sha256Hex(await deps.toM4a(p1, {}));
  purgeIt(s, 't_m4a', [M]);
  await assert.rejects(keepClips(deps, [c1], SESSIONS), (err) => err.code === 'purged' && err.candId === 'c_1');
  assert.deepEqual([putClips.length, audio.clips.size, puts.length], [0, 0, 0]);
  assert.equal((await night.getCand('c_1')).sha256, M, '记下 sha256：昨夜页、清理认得出它');

  // 这段的 WAV 是永久删除了的（以前的版本留下过、候选没记上 sha256）：不编就停
  const { c: c2 } = await seedCand(night, 'c_2', { startAt: T0 + 60e3, samples: 2 * SR, seed: 2 });
  const W = await sha256Hex(wavBlob([pcm(2 * SR, 2).buffer], 2 * SR, SR));
  purgeIt(s, 't_wav', [W]);
  const n = deps.toM4a.calls.length;
  await assert.rejects(keepClips(deps, [c2], SESSIONS), (err) => err.code === 'purged' && err.candId === 'c_2');
  assert.equal(deps.toM4a.calls.length, n);
  assert.equal((await night.getCand('c_2')).sha256, W);

  // 存 m4a 的时候同步来了它的永久删除：不建条目，候选记下 sha256
  const { c: c3 } = await seedCand(night, 'c_3', { startAt: T0 + 120e3, samples: 2 * SR, seed: 3 });
  const real = audio.putClip;
  audio.putClip = async (blob, opts) => { const r = await real(blob, opts); purgeIt(s, 't_late', [r.sha256]); return r; };
  await assert.rejects(keepClips(deps, [c3], SESSIONS), (err) => err.code === 'purged' && err.candId === 'c_3');
  assert.equal(puts.length, 0);
  const c3b = await night.getCand('c_3');
  assert.ok(c3b.sha256 && goneShas(s).has(c3b.sha256));
  assert.equal(c3b.entryId, undefined);

  // 记着的 m4a sha256 永久删除了：什么都不读、不编
  audio.putClip = real;
  const gets = night.calls.filter(x => x === 'getParts').length, m = deps.toM4a.calls.length;
  await assert.rejects(keepClips(deps, [c3b], SESSIONS), (err) => err.code === 'purged');
  assert.deepEqual([night.calls.filter(x => x === 'getParts').length, deps.toM4a.calls.length], [gets, m]);
});


test('批量留下：先逐段检查，再逐段读取、处理、存盘；不把后面片段的 PCM 提前读入', async () => {
  const { night, audio, deps } = setup();
  const cands = [];
  for (let i = 0; i < 3; i++) cands.push((await seedCand(night, 'seq_' + i, { startAt: T0 + i * 60000, samples: SR, seed: i })).c);
  const events = [], read = night.getParts, write = audio.putClip;
  night.getParts = async id => { events.push('read:' + id); return read(id); };
  audio.putClip = async (b, o) => { events.push('write'); return write(b, o); };
  const entry = await keepClips(deps, cands, SESSIONS);
  assert.equal(entry.audio.length, 3);
  assert.deepEqual(events, ['read:seq_0','read:seq_1','read:seq_2', 'read:seq_0','write','read:seq_1','write','read:seq_2','write']);
});


test('批量中途存候选身份失败：不建半条记录，使用原选择重试也复用前一段的 m4a', async () => {
  const { night, audio, s, puts, deps } = setup();
  const cands = [];
  for (let i=0;i<2;i++) cands.push((await seedCand(night, 'retry_'+i, { startAt:T0+i*60000, samples:SR, seed:i })).c);
  deps.toM4a = fakeM4a();
  const patch = night.patchCand; let fail = true;
  night.patchCand = (id, value) => {
    if (fail && id==='retry_1' && value.sha256 && !value.entryId) { fail=false; throw new Error('second identity failed'); }
    return patch(id,value);
  };
  await assert.rejects(keepClips(deps,cands,SESSIONS), /second identity failed/);
  assert.equal(puts.length,0); assert.equal(entriesOf(s).length,0);
  assert.equal(audio.clips.size,1);
  const firstSha=(await night.getCand('retry_0')).sha256;
  const entry=await keepClips(deps,cands,SESSIONS);
  assert.equal(entry.audio[0].sha256,firstSha);
  assert.equal(deps.toM4a.calls.length,3,'第二次只编第二段，第一段不重编');
  assert.equal(audio.clips.size,2); assert.equal(puts.length,1);
});
