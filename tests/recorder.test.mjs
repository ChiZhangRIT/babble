// 录音机测试：假的 MediaRecorder / getUserMedia / Wake Lock / 音频会话 + 内存版 audioStore（合成数据）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, recoverPending, REC_LOCK } from '../src/core/recorder.js';
import { memoryStore } from '../src/core/audioStore.js';
import { sha256Hex } from '../src/core/sha256.js';

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const text = async (blob) => new TextDecoder().decode(await blob.arrayBuffer());

class FakeTrack extends EventTarget {
  constructor() { super(); this.kind = 'audio'; this.stopped = false; }
  stop() { this.stopped = true; }
}
class FakeStream {
  constructor() { this.tracks = [new FakeTrack()]; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
function fakeEnv({ mime = 'audio/mp4', deny = null } = {}) {
  const env = { recorders: [], streams: [], constraints: [], wakes: [], session: { type: 'auto' }, states: [] };
  class FakeMR extends EventTarget {
    constructor(stream, opts) { super(); this.stream = stream; this.opts = opts; this.state = 'inactive'; this.mimeType = ''; env.recorders.push(this); }
    start(ts) { this.timeslice = ts; this.state = 'recording'; this.mimeType = mime; }
    emit(s) { const e = new Event('dataavailable'); e.data = new Blob([s], { type: mime }); this.dispatchEvent(e); }
    stop() {                                  // 和浏览器一样：异步地先给最后一片，再发 stop
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      setTimeout(() => { this.emit('|尾'); this.dispatchEvent(new Event('stop')); }, 0);
    }
  }
  env.MediaRecorder = FakeMR;
  env.getUserMedia = async (c) => {
    env.constraints.push(c);
    if (deny) throw new DOMException('Permission denied', deny);
    const s = new FakeStream(); env.streams.push(s); return s;
  };
  env.wakeLock = {
    async request(type) {
      const s = new EventTarget();
      Object.assign(s, { type, released: false, async release() { if (s.released) return; s.released = true; s.dispatchEvent(new Event('release')); } });
      env.wakes.push(s); return s;
    },
  };
  env.doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  env.store = memoryStore();
  let t = 1_000_000;
  env.clock = { now: () => t, advance: (ms) => { t += ms; } };
  env.make = (extra = {}) => createRecorder({
    audioStore: env.store, getUserMedia: env.getUserMedia, MediaRecorder: FakeMR, wakeLock: env.wakeLock,
    audioSession: env.session, AudioContext: null, locks: null, doc: env.doc, now: env.clock.now,
    onState: (s, info) => env.states.push([s, info]), ...extra,
  });
  return env;
}

test('开始：先 requesting 再 recording；不强制格式、1 秒一片、要屏幕常亮、音频会话切到录音', async () => {
  const env = fakeEnv();
  const rec = env.make();
  assert.equal(rec.state, 'idle');
  await rec.start({ attachTo: 'e_abc' });
  assert.deepEqual(env.states.map(s => s[0]), ['requesting', 'recording']);
  assert.equal(rec.state, 'recording');
  assert.deepEqual(env.constraints[0], { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  const mr = env.recorders[0];
  assert.equal(mr.opts, undefined, 'MediaRecorder 不传 mimeType');
  assert.equal(mr.timeslice, 1000);
  assert.equal(env.wakes.length, 1);
  assert.equal(env.session.type, 'play-and-record');
  await flush();
  const metas = await env.store.listRecMeta();
  assert.equal(metas.length, 1);
  assert.equal(metas[0].attachTo, 'e_abc');
  assert.equal(metas[0].startedAt, 1_000_000);
  assert.equal(metas[0].mime, 'audio/mp4');
  assert.equal(typeof metas[0].tz, 'string');
  await rec.discard();
});

test('每一片 dataavailable 立刻存盘；stop 拼起来存成 clip，清掉分片，收尾', async () => {
  const env = fakeEnv();
  const rec = env.make();
  await rec.start();
  const mr = env.recorders[0];
  const { recId } = env.states.find(s => s[0] === 'recording')[1];
  mr.emit('片0'); await flush();
  assert.equal((await env.store.getChunks(recId)).length, 1);
  mr.emit('片1'); mr.emit('片2'); await flush();
  const chunks = await env.store.getChunks(recId);
  assert.deepEqual(await Promise.all(chunks.map(text)), ['片0', '片1', '片2']);
  env.clock.advance(42_340);
  assert.equal(rec.elapsedMs(), 42_340);
  const res = await rec.stop();
  assert.equal(rec.state, 'saved');
  const whole = '片0片1片2|尾';
  assert.equal(res.sha256, await sha256Hex(new TextEncoder().encode(whole)));
  assert.equal(res.bytes, new TextEncoder().encode(whole).length);
  assert.equal(res.mime, 'audio/mp4');
  assert.equal(res.durationSec, 42.3);
  assert.equal(res.startedAt, 1_000_000);
  assert.equal(res.reason, 'user');
  assert.equal(res.chunks, 4);
  assert.equal(await text((await env.store.getClip(res.sha256)).blob), whole);
  assert.equal((await env.store.getChunks(recId)).length, 0, '分片清掉了');
  const meta = await env.store.getRecMeta(recId);
  assert.equal(meta.done, true, '标成已存好（条目建好前被杀也能找回）');
  assert.equal(meta.sha256, res.sha256);
  assert.ok(env.streams[0].tracks.every(t => t.stopped), '麦克风关了');
  assert.equal(env.wakes[0].released, true, '屏幕常亮放掉了');
  assert.equal(env.session.type, 'auto', '音频会话回到原来的');
  assert.deepEqual(env.states.map(s => s[0]), ['requesting', 'recording', 'stopping', 'saved']);
  assert.equal(env.states.at(-1)[1].sha256, res.sha256);
  assert.equal(rec.elapsedMs(), 42_340);
  assert.equal(await rec.stop(), null, '再停一次没事');
});

test('麦克风被打断（track mute / ended）→ 自动停止并保存', async () => {
  for (const ev of ['mute', 'ended']) {
    const env = fakeEnv();
    const rec = env.make();
    await rec.start();
    env.recorders[0].emit('一点点');
    env.streams[0].tracks[0].dispatchEvent(new Event(ev));
    await sleep(10);
    assert.equal(rec.state, 'saved', ev);
    const saved = env.states.at(-1)[1];
    assert.equal(saved.reason, 'interrupted');
    assert.equal(await text((await env.store.getClip(saved.sha256)).blob), '一点点|尾');
  }
});

test('MediaRecorder 出错 → 已录的照样保存（等最后一片）；出错后不再发 stop 也不会卡住', async () => {
  const env = fakeEnv();
  const rec = env.make();
  await rec.start();
  const mr = env.recorders[0];
  mr.emit('前半段');
  mr.state = 'inactive';                                   // 和浏览器一样：error 之后异步给最后一片、发 stop
  mr.dispatchEvent(new Event('error'));
  setTimeout(() => { mr.emit('|最后'); mr.dispatchEvent(new Event('stop')); }, 5);
  await sleep(30);
  assert.equal(rec.state, 'saved');
  assert.equal(env.states.at(-1)[1].reason, 'error');
  assert.equal(await text((await env.store.getClip(env.states.at(-1)[1].sha256)).blob), '前半段|最后');

  const quiet = fakeEnv();
  const r2 = quiet.make();
  await r2.start();
  quiet.recorders[0].emit('只有这些');
  quiet.recorders[0].state = 'inactive';
  quiet.recorders[0].dispatchEvent(new Event('error'));    // 之后什么都不来
  await sleep(1700);
  assert.equal(r2.state, 'saved');
  assert.equal(await text((await quiet.store.getClip(quiet.states.at(-1)[1].sha256)).blob), '只有这些');
});

test('等权限时离开页面（stop）→ 取消，不会在后台开始录', async () => {
  const env = fakeEnv();
  let grant;
  const rec = env.make({ getUserMedia: (c) => new Promise(res => { grant = () => res(env.getUserMedia(c)); }) });
  const starting = rec.start();
  assert.equal(rec.state, 'requesting');
  assert.equal(rec.elapsedMs(), 0);
  assert.equal(await rec.stop(), null);
  assert.equal(rec.state, 'idle');
  grant();
  await starting;
  await flush();
  assert.equal(rec.state, 'idle');
  assert.equal(env.recorders.length, 0, '没有建 MediaRecorder');
  assert.ok(env.streams[0].tracks[0].stopped, '麦克风马上关掉');
  assert.equal(env.store.recMeta.size, 0);
  assert.equal(env.session.type, 'auto');
});

test('到 maxMs 自动停止', async () => {
  const env = fakeEnv();
  const rec = env.make({ maxMs: 30 });
  await rec.start();
  env.recorders[0].emit('十分钟');
  await sleep(80);
  assert.equal(rec.state, 'saved');
  assert.equal(env.states.at(-1)[1].reason, 'max');
});

test('没给麦克风权限 → error denied，收尾干净；没有 MediaRecorder → unsupported', async () => {
  const env = fakeEnv({ deny: 'NotAllowedError' });
  const rec = env.make();
  await rec.start();
  assert.equal(rec.state, 'error');
  assert.equal(env.states.at(-1)[1].code, 'denied');
  assert.equal(env.recorders.length, 0);
  assert.equal(env.session.type, 'auto');
  await flush();
  assert.ok(env.wakes.every(w => w.released), '屏幕常亮放掉了');
  assert.equal((await env.store.listRecMeta()).length, 0);

  const nomic = fakeEnv({ deny: 'NotFoundError' });
  const r2 = nomic.make();
  await r2.start();
  assert.equal(nomic.states.at(-1)[1].code, 'nomic');

  const old = fakeEnv();
  const r3 = old.make({ MediaRecorder: null });
  await r3.start();
  assert.equal(r3.state, 'error');
  assert.equal(old.states.at(-1)[1].code, 'unsupported');
  assert.equal(old.constraints.length, 0, '不支持就不去要权限');

  // 出错后可以再试
  const again = fakeEnv();
  let deny = true;
  const r4 = again.make({ getUserMedia: async (c) => { if (deny) throw new DOMException('no', 'NotAllowedError'); return again.getUserMedia(c); } });
  await r4.start();
  assert.equal(r4.state, 'error');
  deny = false;
  await r4.start();
  assert.equal(r4.state, 'recording');
  await r4.discard();
});

test('丢弃：不存 clip，分片和 recMeta 都清掉', async () => {
  const env = fakeEnv();
  const rec = env.make();
  await rec.start();
  env.recorders[0].emit('不要了');
  await flush();
  await rec.discard();
  assert.equal(rec.state, 'idle');
  assert.equal(env.store.clips.size, 0);
  assert.equal(env.store.rec.size, 0);
  assert.equal(env.store.recMeta.size, 0);
  assert.ok(env.streams[0].tracks[0].stopped);
});

test('没有任何声音数据 → error empty，不留垃圾', async () => {
  const env = fakeEnv();
  class Silent extends env.MediaRecorder { stop() { this.state = 'inactive'; setTimeout(() => this.dispatchEvent(new Event('stop')), 0); } }
  const rec = env.make({ MediaRecorder: Silent });
  await rec.start();
  assert.equal(await rec.stop(), null);
  assert.equal(rec.state, 'error');
  assert.equal(env.states.at(-1)[1].code, 'empty');
  assert.equal(env.store.recMeta.size, 0);
});

test('切回前台时屏幕常亮被系统放掉了就再要一次', async () => {
  const env = fakeEnv();
  const rec = env.make();
  await rec.start();
  await flush();
  await env.wakes[0].release();                            // 系统切后台时会放掉
  env.doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(env.wakes.length, 2);
  env.doc.dispatchEvent(new Event('visibilitychange'));    // 还拿着：不重复要
  await flush();
  assert.equal(env.wakes.length, 2);
  await rec.stop();
  env.doc.dispatchEvent(new Event('visibilitychange'));    // 停了以后不再要
  await flush();
  assert.equal(env.wakes.length, 2);
  assert.ok(env.wakes.every(w => w.released));
});

test('存 clip 失败：报 error save，分片留着，下次启动 recoverPending 找回', async () => {
  const env = fakeEnv();
  const putClip = env.store.putClip;
  env.store.putClip = async () => { throw new Error('QuotaExceededError'); };
  const rec = env.make();
  await rec.start({ attachTo: 'e_x' });
  env.recorders[0].emit('差点丢了');
  assert.equal(await rec.stop(), null);
  assert.equal(env.states.at(-1)[1].code, 'save');
  env.store.putClip = putClip;
  const found = await recoverPending({ audioStore: env.store, before: Date.now(), locks: null });
  assert.equal(found.length, 1);
  assert.equal(await text((await env.store.getClip(found[0].sha256)).blob), '差点丢了|尾');
  assert.equal(found[0].attachTo, 'e_x');
  assert.equal(env.store.recMeta.size, 1, '恢复记录留着：App 建好条目、存进本机以后才清');
  assert.equal(env.store.rec.size, 0, '分片拼好存成 clip 后就删了（recMeta 标成 done）');
});

test('recoverPending：拼起残留分片；跳过启动后开始的、正在录的（锁还在）；清掉空的；交回已存好但可能没建条目的', async () => {
  const store = memoryStore();
  const boot = 2_000_000;
  // 上次被杀：留下 meta + 三片
  await store.putRecMeta({ recId: 'r_old', startedAt: boot - 60_000, mime: 'audio/mp4', tz: 'America/Los_Angeles' });
  for (const [i, s] of ['甲', '乙', '丙'].entries()) await store.putChunk('r_old', i, new Blob([s], { type: 'audio/mp4' }));
  // 只有 meta、一片都没有
  await store.putRecMeta({ recId: 'r_empty', startedAt: boot - 50_000, mime: 'audio/mp4', tz: null });
  // 这次启动之后才开始的
  await store.putRecMeta({ recId: 'r_new', startedAt: boot + 1, mime: 'audio/mp4', tz: null });
  await store.putChunk('r_new', 0, new Blob(['新']));
  // 别的标签页正在录（拿着锁）
  await store.putRecMeta({ recId: 'r_busy', startedAt: boot - 10_000, mime: 'audio/mp4', tz: null });
  await store.putChunk('r_busy', 0, new Blob(['忙']));
  // 已经存成 clip（done），条目可能没建
  const kept = await store.putClip(new Blob(['已存好'], { type: 'audio/webm' }), { mime: 'audio/webm' });
  await store.putRecMeta({ recId: 'r_done', startedAt: boot - 5_000, mime: 'audio/webm', tz: null, done: true, sha256: kept.sha256, bytes: kept.bytes, durationSec: 3.2, attachTo: 'e_y' });
  const locks = { query: async () => ({ held: [{ name: REC_LOCK + 'r_busy' }], pending: [] }) };

  const found = await recoverPending({ audioStore: store, before: boot, locks });
  assert.deepEqual(found.map(f => f.recId), ['r_old', 'r_done']);
  const [old, done] = found;
  assert.equal(old.sha256, await sha256Hex(new TextEncoder().encode('甲乙丙')));
  assert.equal(old.startedAt, boot - 60_000);
  assert.equal(old.tz, 'America/Los_Angeles');
  assert.equal(old.durationSec, null, '读不出时长就是 null，不猜');
  assert.equal(old.attachTo, undefined);
  assert.equal(await text((await store.getClip(old.sha256)).blob), '甲乙丙');
  assert.deepEqual({ sha256: done.sha256, mime: done.mime, durationSec: done.durationSec, attachTo: done.attachTo }, { sha256: kept.sha256, mime: 'audio/webm', durationSec: 3.2, attachTo: 'e_y' });
  assert.deepEqual([...store.recMeta.keys()].sort(), ['r_busy', 'r_done', 'r_new', 'r_old'], '空的清了；找回的留着，等 App 建好条目再清');
  assert.equal((await store.getRecMeta('r_old')).done, true, '拼好的标成已存好');
  assert.equal((await store.getChunks('r_old')).length, 0);
  const again = await recoverPending({ audioStore: store, before: boot, locks });
  assert.deepEqual(again.map(f => [f.recId, f.sha256]), [['r_old', old.sha256], ['r_done', kept.sha256]], 'App 没清（条目没存进去）：下次启动还交回来');
});

test('录音中 Web Lock 一直拿着，停了就放', async () => {
  const env = fakeEnv();
  const held = new Map();
  const locks = { request: (name, fn) => { const p = Promise.resolve(fn()).then(() => held.delete(name)); held.set(name, true); return p; } };
  let heldWhenSaved = null;
  const rec = env.make({ locks, onState: (s, info) => { env.states.push([s, info]); if (s === 'saved') heldWhenSaved = held.size; } });
  await rec.start();
  const { recId } = env.states.find(s => s[0] === 'recording')[1];
  assert.ok(held.has(REC_LOCK + recId));
  env.recorders[0].emit('x');
  await rec.stop();
  await flush();
  assert.equal(heldWhenSaved, 1, '存好、条目建好（saved 回调）之前锁还拿着：别的标签页不会重复找回');
  assert.equal(held.size, 0);
});

test('存盘卡住（IndexedDB 一直不回）：stop 不会一直等，麦克风马上放掉，用内存里的录音存；存 clip 也卡住 → error save 带 blob', async () => {
  const env = fakeEnv();
  const putChunk = env.store.putChunk;
  env.store.putChunk = (id, seq, b) => (seq === 1 ? new Promise(() => {}) : putChunk(id, seq, b));
  const rec = env.make({ writeWaitMs: 30, saveWaitMs: 50 });
  await rec.start();
  const mr = env.recorders[0];
  mr.emit('片0'); mr.emit('片1'); mr.emit('片2'); await flush();
  const res = await rec.stop();
  assert.ok(res, '没有卡住');
  assert.equal(await text((await env.store.getClip(res.sha256)).blob), '片0片1片2|尾');
  assert.ok(env.streams[0].tracks.every(t => t.stopped));

  const env2 = fakeEnv();
  env2.store.putClip = () => new Promise(() => {});
  const rec2 = env2.make({ writeWaitMs: 30, saveWaitMs: 50 });
  await rec2.start();
  env2.recorders[0].emit('片0');
  assert.equal(await rec2.stop(), null);
  const [s, info] = env2.states.at(-1);
  assert.equal(s, 'error'); assert.equal(info.code, 'save');
  assert.equal(await text(info.blob), '片0|尾');
  assert.ok(env2.streams[0].tracks.every(t => t.stopped));
});

test('开头写 recMeta 失败：下一片时补写；某一片写失败重试一次', async () => {
  const env = fakeEnv();
  const putRecMeta = env.store.putRecMeta, putChunk = env.store.putChunk;
  let metaFails = 1, chunkFails = 1;
  env.store.putRecMeta = async (m) => { if (metaFails-- > 0) throw new Error('AbortError'); return putRecMeta(m); };
  env.store.putChunk = async (id, seq, b) => { if (seq === 0 && chunkFails-- > 0) throw new Error('AbortError'); return putChunk(id, seq, b); };
  const rec = env.make();
  await rec.start();
  const { recId } = env.states.find(s => s[0] === 'recording')[1];
  env.recorders[0].emit('片0'); await flush(8);
  assert.ok(await env.store.getRecMeta(recId), 'recMeta 补写上了（App 被杀也能找回）');
  assert.equal((await env.store.getChunks(recId)).length, 1, '第 0 片（文件头）重试后写进去了');
  await rec.discard();
});
