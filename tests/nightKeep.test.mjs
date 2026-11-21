import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepClips, itemFor, entryFieldsFor } from '../src/core/nightKeep.js';
import { memoryNightStore } from '../src/core/nightStore.js';
import { memoryStore } from '../src/core/audioStore.js';
import { blankState, makeEntry, normalizeEntry, goneShas } from '../src/core/store.js';
import { wavBlob } from '../src/core/nightDetect.js';
import { recTimeFields } from '../src/core/drafts.js';
import { sha256Hex } from '../src/core/sha256.js';

// 床头模式的「留下」：候选片段 → 录音库里的 WAV → 一条待整理。声音全是编的数字序列（仓库是公开的），不是录音
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
