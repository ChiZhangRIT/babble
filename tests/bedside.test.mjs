// 床头模式的引擎（core/bedside.js）：假的麦克风 / AudioContext / 说话识别 / 常亮 / 锁 / 时钟（tests/helpers/fakeAudio.mjs）+ 内存版 nightStore。
// 开始的顺序（都在手势里）、合成的一晚 → 片段的样本一个不差、每秒一片、写失败补上、存满、噪声和预算、各种中断和自己接上、
// 识别挂了、计时器、结束放掉一切、下次启动找回、按期限清理。全是合成信号（噪声、正弦、「像说话」的谐波），不用真录音，也不写 localStorage。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBedside, recoverNights, purgeNights, LIVE_LOCK, NIGHT_LOCK, CONSTRAINTS, GAP_REASONS } from '../src/core/bedside.js';
import { memoryNightStore } from '../src/core/nightStore.js';
import { createVad } from '../src/core/vad.js';
import { P, toPcm16 } from '../src/core/nightDetect.js';
import { nightReport } from '../src/core/nightReport.js';
import { fakeAudio, FakeStream, flush, echoProbs } from './helpers/fakeAudio.mjs';
import { noise, speechy, tone, silence, mix, concat } from './helpers/signal.mjs';
import { fakeStorage } from './helpers/dom.mjs';

const BLOCK = 4096, FR = 512, SR = 16000, DAY = 86400000;

/** 假识别（echo）按绝对音量判：默认不给识别那份加增益（VAD_GAIN_MAX_DB 0），不然 −60 dBFS 的底噪放大后也算说话；gain 给了就用这个上限 */
function setup(o = {}) {
  const env = fakeAudio(o), extra = o.extra || {};
  env.store = o.store || memoryNightStore();
  env.engine = createBedside(env.deps({ store: env.store, ...extra, params: { ...(extra.params || P), VAD_GAIN_MAX_DB: o.gain ?? 0 } }));
  return env;
}
async function live(env, opts) { await env.engine.start(opts); assert.equal(env.engine.phase, 'live'); return env.clock.now(); }
const sessionOf = (env) => env.store.maps.sessions.get(env.engine.status().sessionId);
const cands = (env) => [...env.store.maps.cands.values()].sort((a, b) => a.startAt - b.startAt);
const evs = (env, k) => env.store.maps.events.filter(e => !k || e.k === k);
/** 一个候选的分片按顺序拼起来（Int16） */
async function pcmOf(store, id) {
  const parts = await store.getParts(id), out = new Int16Array(parts.reduce((n, x) => n + x.b.byteLength / 2, 0));
  let o = 0;
  for (const x of parts) { out.set(new Int16Array(x.b), o); o += x.b.byteLength / 2; }
  return out;
}
/** 假识别（echo）认作说话的第一帧、最后一帧（绝对帧号） */
function loud(sig) {
  let first = -1, last = -1;
  echoProbs(sig).forEach((v, i) => { if (v > 0.5) { if (first < 0) first = i; last = i; } });
  return { first, last };
}

test('导出的常数', () => {
  assert.equal(LIVE_LOCK, 'babble-night-live');
  assert.equal(NIGHT_LOCK, 'babble-night:');
  assert.deepEqual(CONSTRAINTS, { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  assert.deepEqual(GAP_REASONS, ['hidden', 'muted', 'ended', 'ctx', 'stall', 'silent', 'error']);
});

test('开始：AudioContext（48k）+ resume、常亮、persist、getUserMedia 都在 start() 返回之前；约束原样；session 记下采集、轨道、预算；两把锁', async () => {
  const env = setup({ est: { usage: 1e9, quota: 1e9 + 6.4e6 } });     // 还剩 6.4 MB：一半够存 100 秒
  const autoEndAt = env.clock.now() + 3600e3;
  const p = env.engine.start({ autoEndAt });
  assert.equal(env.contexts.length, 1, 'AudioContext 在手势里建');
  assert.deepEqual(env.contexts[0].opts, { sampleRate: 48000 });
  assert.equal(env.resumes, 1, '在手势里 resume');
  assert.equal(env.wakeReqs, 1, '在手势里要常亮');
  assert.equal(env.persistCalls, 1);
  assert.equal(env.gum.length, 1, '在手势里要麦克风');
  assert.deepEqual(env.gum[0], CONSTRAINTS);
  assert.equal(env.audioSession.type, 'play-and-record');
  assert.equal(env.engine.phase, 'starting');
  assert.equal(env.vad.loads, 1, '没准备过：开始时载入识别');
  await p;
  const st = env.engine.status();
  assert.equal(st.phase, 'live');
  assert.equal(st.listening, true);
  assert.equal(st.capture, 'worklet');
  assert.equal(st.vad, 'on');
  assert.equal(st.wake, true);
  assert.equal(st.autoEndAt, autoEndAt);
  assert.equal(st.gap, null);
  const s = sessionOf(env);
  assert.equal(s.status, 'live');
  assert.equal(s.v, 1);
  assert.ok(s.id.startsWith('n_'));
  assert.equal(s.nightOf, '2026-11-17', '上海 23:30 开始：算这天夜里');
  assert.equal(s.capture, 'worklet');
  assert.equal(s.rate, 48000);
  assert.equal(s.pull, false);
  assert.deepEqual(s.track, { autoGainControl: false, echoCancellation: false, noiseSuppression: false, sampleRate: 48000, channelCount: 1 });
  assert.equal(s.budgetSec, 100);
  assert.deepEqual(s.env, { aac16k: null, persisted: true, usage: 1e9, quota: 1e9 + 6.4e6 });
  assert.equal(s.tz, 'Asia/Shanghai');
  assert.equal(s.device, 'iPhone');
  assert.equal(s.build, 'test');
  assert.equal(s.standalone, false);
  assert.equal(s.vad, 'on');
  assert.equal(s.vadLoadMs, 300);
  assert.equal(s.autoEndAt, autoEndAt);
  assert.deepEqual([s.gaps, s.notes, s.reviewedAt, s.endedAt], [[], [], null, null]);
  const n = env.node;
  assert.equal(n.name, 'babble-capture');
  assert.deepEqual(n.opts, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', processorOptions: { outRate: 16000, block: 4096 } });
  assert.deepEqual(env.ctx.audioWorklet.modules, ['capture.worklet.js']);
  assert.ok(env.sources.at(-1).outs.includes(n), 'MediaStreamSource → worklet');
  assert.ok(env.locks.held.has(LIVE_LOCK));
  assert.ok(env.locks.held.has(NIGHT_LOCK + s.id));
  await flush();
  assert.deepEqual(evs(env).slice(0, 2).map(e => e.k), ['start', 'track']);
  await env.engine.end();
});

test('开始不了：别的窗口拿着 LIVE_LOCK → otherTab（麦克风、AudioContext、常亮、音频会话都放掉）；正在转文字 → sttBusy（也不载入识别）；没给权限 → denied，再试一次能开始；没有 store → noStore', async () => {
  const a = setup();
  a.busyLocks.add(LIVE_LOCK);
  await a.engine.start();
  await flush();
  assert.equal(a.engine.phase, 'error');
  assert.equal(a.engine.status().error.code, 'otherTab');
  assert.ok(a.stream.tracks[0].stopped);
  assert.equal(a.ctx.state, 'closed');
  assert.ok(a.wakes.length && a.wakes.every(w => w.released));
  assert.equal(a.audioSession.type, 'auto');
  assert.equal(a.store.maps.sessions.size, 0);

  const b = setup({ extra: { sttBusy: () => true } });
  await b.engine.start();
  assert.equal(b.engine.status().error.code, 'sttBusy');
  assert.equal(b.contexts.length + b.gum.length + b.wakeReqs, 0);
  const r = await b.engine.prepare();
  assert.equal(r.vad, 'off');
  assert.equal(b.vad.loads, 0, '正在转文字：不预先载入识别');

  const c = setup();
  c.deny = 'NotAllowedError';
  await c.engine.start();
  await flush();
  assert.equal(c.engine.status().error.code, 'denied');
  assert.equal(c.ctx.state, 'closed');
  assert.equal(c.audioSession.type, 'auto');
  assert.equal(c.locks.held.size, 0);
  assert.equal(c.vad.closed, false, '识别留着：再试一次不用重新载入');
  c.deny = null;
  await c.engine.start();
  assert.equal(c.engine.phase, 'live');
  assert.equal(c.engine.status().error, null);
  await c.engine.end();

  const d = setup({ extra: { store: null } });
  await d.engine.start();
  assert.equal(d.engine.status().error.code, 'noStore');
  assert.equal(d.contexts.length, 0);
});

test('prepare：不用手势，载入识别、看剩余空间（预算按一半）；重复调用是同一个；dispose 关掉识别；载入不了 → off', async () => {
  const env = setup({ est: { usage: 0, quota: 38.4e6 } });
  const p1 = env.engine.prepare(), p2 = env.engine.prepare();
  assert.equal(p1, p2);
  assert.equal(env.engine.phase, 'preparing');
  assert.deepEqual([env.statuses.at(-1).phase, env.statuses.at(-1).vad], ['preparing', 'loading'], '第一次报的就是正在载入');
  assert.deepEqual(await p1, { vad: 'ready', freeBytes: 38.4e6, budgetSec: 600 });
  assert.equal(env.engine.phase, 'ready');
  assert.equal(env.engine.status().vad, 'on');
  assert.equal(env.vad.loads, 1);
  env.engine.dispose();
  assert.equal(env.vad.closed, true);

  const f = setup({ vad: { mode: 'fail' } });
  assert.deepEqual(await f.engine.prepare(), { vad: 'off', freeBytes: 1e10 - 2e8, budgetSec: 3600 });
  assert.equal(f.engine.status().vad, 'off');
});

test('建好 3 秒一块都没来 → 换成接到 destination（音量 0）的 worklet 再建一次（pull），之后照常听', async () => {
  const env = setup();
  await live(env);
  const first = env.node;
  await env.clock.advance(2000);
  assert.equal(evs(env, 'pull-fallback').length, 0);
  await env.clock.advance(2000);
  assert.equal(evs(env, 'pull-fallback').length, 1);
  assert.ok(first.disconnected);
  const n = env.node;
  assert.notEqual(n, first);
  assert.equal(n.opts.numberOfOutputs, 1);
  const g = n.outs[0];
  assert.equal(g.kind, 'gain');
  assert.equal(g.gain.value, 0);
  assert.equal(g.outs[0], env.ctx.destination);
  assert.ok(env.sources.at(-1).outs.includes(n));
  assert.equal(env.ctx.audioWorklet.modules.length, 1, '同一个 AudioContext 不再 addModule');
  assert.equal(env.engine.status().gap, null, '换了接法再给 3 秒');
  await env.play(noise(2, -60, 3));
  assert.equal(env.engine.status().listening, true);
  await env.engine.end();
  assert.equal(sessionOf(env).pull, true);
  assert.deepEqual(sessionOf(env).gaps, []);
});

test('addModule 被拒 → ScriptProcessor（4096）+ Decimator，接到 destination（音量 0）；48k 进来照样是 16k 的块', async () => {
  const env = setup();
  env.worklet = 'reject';
  await live(env);
  assert.equal(env.engine.status().capture, 'script');
  const n = env.node;
  assert.equal(n.kind, 'script');
  assert.equal(n.bufferSize, 4096);
  assert.equal(n.outs[0].kind, 'gain');
  assert.equal(n.outs[0].gain.value, 0);
  assert.equal(n.outs[0].outs[0], env.ctx.destination);
  assert.ok(env.sources.at(-1).outs.includes(n));
  await env.feedScript(noise(3, -60, 5, 48000));                 // 35 次 × 4096 个 48k 样本 → 11 块 16k
  await env.engine.end();
  const s = sessionOf(env);
  assert.equal(s.capture, 'script');
  assert.equal(s.alive.samples, 11 * BLOCK);
  assert.equal(evs(env, 'capture')[0].d.kind, 'script');

  const h = setup();                                              // addModule 一直不回：等 5 秒也换 ScriptProcessor
  h.worklet = 'hang';
  const p = h.engine.start();
  await flush();
  assert.equal(h.engine.phase, 'starting');
  await h.clock.advance(5000);
  await p;
  assert.equal(h.engine.phase, 'live');
  assert.equal(h.engine.status().capture, 'script');
  await h.engine.end();

  const n2 = setup();                                             // 两样都没有 → unsupported
  n2.worklet = 'ctor'; n2.noScript = true;
  await n2.engine.start();
  await flush();
  assert.equal(n2.engine.status().error.code, 'unsupported');
  assert.equal(n2.ctx.state, 'closed');
  assert.ok(n2.stream.tracks[0].stopped);
});

test('合成的一晚（噪声 + 一段像说话 + echo 识别）→ 一个 new 片段，分片拼起来正好是：前 8 秒 + 说话 + 后 2 秒；不写 localStorage', async () => {
  const storage = fakeStorage(), had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const env = setup();
    const tLive = await live(env);
    const B = 120 * BLOCK;                                        // 30.72 秒处开始说 2 秒
    const sig = mix(noise(60, -60, 3), speechy(2, -25), B);
    await env.play(sig);
    assert.equal(cands(env).length, 1, '噪声里没有别的片段');
    const [c] = cands(env), { first, last } = loud(sig);
    assert.ok(first * FR >= B && first * FR < B + 0.25 * SR);
    const from = first * FR - 8 * SR, to = (last + 1) * FR + 2 * SR;
    assert.equal(c.state, 'new');
    assert.equal(c.cut, 'quiet');
    assert.equal(c.samples, to - from);
    assert.equal(c.durationSec, Math.round((to - from) / SR * 10) / 10);
    const pcm = await pcmOf(env.store, c.id);
    assert.ok(pcm.length >= c.samples && pcm.length < c.samples + 2 * SR, '跨过收尾点的那片留着，后面多写的删掉');
    assert.deepEqual(pcm.subarray(0, c.samples), toPcm16(sig.subarray(from, to)));
    assert.equal(c.startAt, tLive + from / 16, '墙上时间：第 k 块在 (k+1)·256 ms 到');
    assert.ok(Math.abs(c.startAt - (tLive + B / 16 - 8000)) < 300, '说话前 8 秒');
    assert.equal(c.speechAt, tLive + first * FR / 16);
    assert.equal(c.endAt, c.startAt + c.samples / 16);
    assert.ok(c.speechSec >= 1 && c.speechSec <= 2);
    assert.equal(c.vadMax, 0.9);
    assert.ok(c.peakDb > -30 && c.gateSec > 0);
    assert.equal(c.contOf, null);
    assert.equal(c.parts, (await env.store.getParts(c.id)).length);
    const st = env.engine.status();
    assert.equal(st.clips, 1);
    assert.equal(st.lastClipAt, c.startAt);
    assert.deepEqual(evs(env).map(e => e.k).filter(k => k.startsWith('clip')), ['clip-open', 'clip-close']);
    await env.engine.end();
    assert.equal(storage.length, 0, 'localStorage 一点没写');
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
});

test('开着的片段每秒写一片：4 秒后至少 4 片，ls、sp 一直在长；第 0 片是往前带的 8 秒；结束时按 end 收', async () => {
  const env = setup();
  await live(env);
  const B = 60 * BLOCK;
  const sig = mix(noise(40, -60, 3), speechy(10, -25), B);
  await env.play(sig.subarray(0, B + 17 * BLOCK));               // 说了 4.35 秒
  const [c] = cands(env);
  assert.equal(c.state, 'open');
  const parts = await env.store.getParts(c.id);
  assert.ok(parts.length >= 4, `${parts.length} 片`);
  assert.equal(parts[0].b.byteLength / 2, 8 * SR, '第 0 片 = 往前带的 8 秒');
  for (const x of parts.slice(1)) assert.ok(x.b.byteLength / 2 >= SR && x.b.byteLength / 2 < SR + BLOCK);
  for (let i = 1; i < parts.length; i++) { assert.ok(parts[i].ls >= parts[i - 1].ls); assert.ok(parts[i].sp >= parts[i - 1].sp); }
  assert.ok(parts.at(-1).ls > parts[1].ls && parts.at(-1).sp > parts[1].sp);
  assert.equal(c.contOf, null);
  await env.engine.end();
  assert.equal(cands(env)[0].cut, 'end');
  assert.equal(cands(env)[0].state, 'new');
});

test('某一片写不进去（重试一次也失败）：不前移，下一片连它一起写，声音没有洞；warn store，写进去以后消失', async () => {
  const env = setup();
  await live(env);
  const B = 60 * BLOCK, sig = mix(noise(50, -60, 3), speechy(6, -25), B);
  let i = B / BLOCK + 8;
  await env.play(sig.subarray(0, i * BLOCK));
  env.store.fail.putPart = 2;
  while (env.store.fail.putPart > 0) { await env.play(sig.subarray(i * BLOCK, (i + 1) * BLOCK)); i++; }
  assert.equal(env.engine.status().warn, 'store');
  await env.play(sig.subarray(i * BLOCK));
  assert.equal(env.engine.status().warn, null);
  const [c] = cands(env), { first, last } = loud(sig), from = first * FR - 8 * SR, to = (last + 1) * FR + 2 * SR;
  assert.equal(c.state, 'new');
  assert.equal(c.samples, to - from);
  assert.deepEqual((await pcmOf(env.store, c.id)).subarray(0, c.samples), toPcm16(sig.subarray(from, to)));
  assert.equal(c.lostSec, 0);
  await env.engine.end();
  assert.equal(sessionOf(env).counts.writeFail, 1);
  assert.equal(evs(env, 'store-fail').length, 1);
});

test('存储满了（QuotaExceededError）：开着的段收掉（cut storage），记 storage，warn full；之后再说话只数次数、不存', async () => {
  const env = setup();
  await live(env);
  const B = 60 * BLOCK;
  const sig = mix(mix(noise(90, -60, 3), speechy(6, -25), B), speechy(2, -25), 280 * BLOCK);
  await env.play(sig.subarray(0, (B / BLOCK + 8) * BLOCK));
  env.store.fail.quota = true;
  await env.play(sig.subarray((B / BLOCK + 8) * BLOCK));
  assert.equal(cands(env).length, 1, '后来那段没存');
  const [c] = cands(env);
  assert.equal(c.state, 'new');
  assert.equal(c.cut, 'storage');
  assert.ok(c.lostSec > 0, '写不进去的那点记成丢了');
  const st = env.engine.status();
  assert.equal(st.warn, 'full');
  assert.equal(st.clips, 1);
  assert.equal(evs(env, 'full')[0].d.why, 'storage');
  await env.engine.end();
  const notes = sessionOf(env).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'storage');
  assert.equal(notes[0].n, 2, '又听到 2 次（前一段剩下的、后来那段）');
  assert.ok(sessionOf(env).counts.writeFail >= 1);
});

test('今晚存够了（预算，按剩余空间算出 20 秒）→ 收掉（cut budget）、full、warn full，之后只数次数；连续 NOISE_SEC 都像说话 → 当噪声（cut noise + note noise），安静 20 秒后才再存', async () => {
  const env = setup({ est: { usage: 0, quota: 32000 * 2 * 20 } });
  await live(env);
  const B = 60 * BLOCK;
  await env.play(mix(mix(noise(80, -60, 3), speechy(6, -25), B), speechy(2, -25), 200 * BLOCK));
  const [c] = cands(env);
  assert.equal(cands(env).length, 1);
  assert.equal(c.cut, 'budget');
  assert.equal(c.samples, 20 * SR, '片段整个长度算进预算');
  assert.equal(env.engine.status().warn, 'full');
  await env.engine.end();
  const [note] = sessionOf(env).notes;
  assert.deepEqual([note.kind, note.n], ['budget', 1]);

  const nz = setup({ extra: { params: { ...P, NOISE_SEC: 20 } } });        // 调短，省时间
  const tLive = await live(nz);
  const T = 20 * BLOCK;
  await nz.play(mix(mix(noise(100, -60, 3), tone(30, -25, 300), T), speechy(2, -25), 250 * BLOCK));
  const [a, b] = cands(nz);
  assert.equal(cands(nz).length, 2);
  assert.equal(a.cut, 'noise');
  assert.equal(b.cut, 'quiet', '安静 20 秒以后照常存');
  assert.ok(b.startAt > a.endAt + 20000);
  await nz.engine.end();
  const [nn] = sessionOf(nz).notes;
  assert.equal(nn.kind, 'noise');
  assert.equal(nn.from, a.endAt);
  assert.equal(nn.to, tLive + Math.ceil((T + 30 * SR) / FR) * FR / 16, '到最后一帧有声音的末尾为止');
  assert.deepEqual(evs(nz).map(e => e.k).filter(k => k.startsWith('noise')), ['noise-on', 'noise-off']);
});

test('来电（track mute）：gap muted，从最后一块有声音的时刻算；开着的段按 gap 收掉；静音的 0 不算接上；unmute 后来了有声音的块才接上', async () => {
  const env = setup();
  await live(env);
  const B = 60 * BLOCK, sig = mix(noise(20, -60, 3), speechy(3, -25), B);
  await env.play(sig.subarray(0, (B / BLOCK + 8) * BLOCK));
  const lastLive = env.clock.now();
  await env.clock.advance(100);
  env.track.setMuted(true);
  await flush();
  let st = env.engine.status();
  assert.deepEqual(st.gap, { reason: 'muted', from: lastLive, needTap: false });
  assert.equal(st.listening, false);
  const [c] = cands(env);
  assert.equal(c.state, 'new');
  assert.equal(c.cut, 'gap');
  await env.play(silence(3));
  assert.equal(env.engine.status().gap.reason, 'muted', '静音的 0 不算接上');
  env.track.setMuted(false);
  await flush();
  assert.ok(env.engine.status().gap, 'unmute 了也要等有声音的块');
  await env.play(noise(0.256, -60, 9));
  const back = env.clock.now();
  st = env.engine.status();
  assert.equal(st.gap, null);
  assert.equal(st.listening, true);
  await env.play(mix(noise(4, -60, 10), speechy(1, -25), 8 * BLOCK));     // 接上 2 秒后又说话：往前带的不越过中断
  await env.engine.end();
  const c2 = cands(env)[1];
  assert.equal(c2.startAt, back - 256, '从接上后的第一块开始');
  assert.equal(c2.contOf, null, '首尾挨着也不算接着上一段：中间断过（contOf 只给 10 分钟封顶后接着说的）');
  const s = sessionOf(env);
  assert.deepEqual(s.gaps, [{ from: lastLive, to: back, reason: 'muted' }]);
  assert.equal(s.counts.resumes, 1, '自己接上的');
  assert.deepEqual(evs(env).map(e => e.k).filter(k => /^(mute|unmute|gap-)/.test(k)), ['mute', 'gap-open', 'unmute', 'gap-close']);
});

test('中断时没有开着的段：接上以后再说话，往前带的 8 秒也不越过中断（不会把中断前的声音拼进来）', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(6, -60, 3));
  env.track.setMuted(true);
  await flush();
  await env.clock.advance(5000);
  env.track.setMuted(false);
  await env.play(noise(0.256, -60, 4));
  const back = env.clock.now();
  await env.play(mix(noise(30, -60, 5), speechy(1, -25), 8 * BLOCK));
  const [c] = cands(env);
  assert.equal(c.startAt, back - 256);
  assert.ok(c.speechAt - c.startAt < 3000, '只带了接上以后的 2 秒');
  await env.engine.end();
});

test('锁屏 / 切走：在后台时停了 → hidden；被冻住、回到前台才发现（轨道还是 muted）也记 hidden；切走了还在收声音（Mac）就不算断', async () => {
  const a = setup();
  await live(a);
  await a.play(noise(2, -60, 3));
  a.setVisible(false);
  await flush();
  await a.play(noise(2, -60, 4));
  assert.equal(a.engine.status().gap, null, '切走了还在收');
  const last = a.clock.now();
  a.track.setMuted(true);
  await flush();
  assert.deepEqual(a.engine.status().gap, { reason: 'hidden', from: last, needTap: false });
  await a.engine.end();
  assert.ok(evs(a, 'vis').length >= 1);

  const b = setup();
  await live(b);
  await b.play(noise(2, -60, 3));
  const last2 = b.clock.now();
  b.setVisible(false);
  b.track.muted = true;                                           // iOS：后台里轨道被静音，事件回到前台才到
  b.clock.jump(600000);
  b.setVisible(true);
  await flush();
  assert.deepEqual(b.engine.status().gap, { reason: 'hidden', from: last2, needTap: false });
  b.track.setMuted(false);
  await b.play(noise(1, -60, 5));
  assert.equal(b.engine.status().gap, null);
  await b.engine.end();
  assert.equal(sessionOf(b).gaps[0].reason, 'hidden');

  const c = setup();
  await live(c);
  await c.play(noise(2, -60, 3));
  c.setVisible(false);
  await c.clock.advance(1000);
  c.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  await flush();
  assert.equal(sessionOf(c).alive.at, c.clock.now(), 'pagehide 马上写心跳');
  assert.equal(sessionOf(c).alive.vis, false);
  await c.clock.advance(5000);                                     // 后台里块不来了，计时器还在跑
  assert.equal(c.engine.status().gap.reason, 'hidden');
  await c.engine.end();
  assert.deepEqual(evs(c).map(e => e.k).filter(k => k === 'vis' || k === 'pagehide'), ['vis', 'pagehide']);
});

test('麦克风断开（ended）→ 马上重新要；被拒（NotAllowedError）→ 请用户点；tapResume 在点按里要麦克风 → 接着听，这段 gap 记 tap', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(2, -60, 3));
  const last = env.clock.now();
  env.deny = 'NotAllowedError';
  env.track.end();
  await flush();
  let st = env.engine.status();
  assert.equal(st.gap.reason, 'ended');
  assert.equal(st.gap.from, last);
  assert.equal(st.gap.needTap, true);
  assert.equal(env.gum.length, 2, '马上重新要了一次');
  assert.equal(evs(env, 'tap-needed').length, 1);
  await env.clock.advance(30000);
  assert.equal(env.gum.length, 2, '等用户点的时候不自己再要');
  env.deny = null;
  const old = env.track;
  const p = env.engine.tapResume();
  assert.equal(env.gum.length, 3, 'getUserMedia 在点按里');
  await p;
  assert.notEqual(env.track, old);
  assert.equal(env.sources.at(-1).stream, env.stream, '新的 source 接在新的 stream 上');
  assert.ok(env.sources.at(-1).outs.includes(env.node));
  assert.equal(env.engine.status().gap.needTap, false);
  await env.play(noise(1, -60, 4));
  st = env.engine.status();
  assert.equal(st.gap, null);
  assert.equal(st.listening, true);
  await env.engine.end();
  const s = sessionOf(env);
  assert.equal(s.gaps.length, 1);
  assert.equal(s.gaps[0].tap, true);
  assert.equal(s.gaps[0].from, last);
  assert.equal(s.counts.taps, 1);
  assert.equal(s.counts.resumes, 0);
  assert.equal(evs(env, 'tap').length, 1);
});

test('AudioContext 被打断（interrupted）→ gap ctx；每次 tick 都 resume，被拒 3 次 → 请用户点；等点的时候也接着 resume，好了自己接上', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(2, -60, 3));
  env.resumeMode = 'reject';
  const r0 = env.resumes;
  env.ctx.setState('interrupted');
  await flush();
  assert.equal(env.engine.status().gap.reason, 'ctx');
  assert.equal(env.resumes, r0 + 1);
  assert.equal(env.engine.status().gap.needTap, false);
  await env.clock.advance(2000);
  assert.equal(env.resumes, r0 + 2);
  assert.equal(env.engine.status().gap.needTap, false);
  await env.clock.advance(2000);
  assert.equal(env.resumes, r0 + 3);
  assert.equal(env.engine.status().gap.needTap, true, '被拒 3 次');
  env.resumeMode = 'ok';
  await env.clock.advance(2000);
  assert.equal(env.ctx.state, 'running');
  await env.play(noise(1, -60, 4));
  assert.equal(env.engine.status().gap, null);
  assert.equal(env.contexts.length, 1);
  await env.engine.end();
  assert.equal(sessionOf(env).gaps[0].tap, true);
});

test('块不来了、状态都正常（stall）→ 6 秒重建 source、20 秒重新要麦克风、45 秒换 AudioContext（按 tick），还不行就请用户点', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(2, -60, 3));
  const last = env.clock.now();
  await env.clock.advance(70000);
  const st = env.engine.status();
  assert.equal(st.gap.reason, 'stall');
  assert.equal(st.gap.from, last);
  assert.equal(st.gap.needTap, true);
  const [open] = evs(env, 'gap-open').map(e => e.t);
  assert.ok(open - last >= 3000 && open - last < 5000);
  const rel = (k) => evs(env, k).map(e => e.t - open);
  assert.deepEqual(rel('rebuild'), [6000, 20000], '6 秒重建；20 秒重新要麦克风以后也重建');
  assert.deepEqual(rel('reacquire'), [20000]);
  assert.deepEqual(rel('restart'), [46000]);
  assert.deepEqual(rel('tap-needed'), [52000]);
  assert.equal(env.gum.length, 2);
  assert.equal(env.contexts.length, 2);
  assert.equal(env.contexts[0].state, 'closed', '旧的 AudioContext 关掉');
  assert.equal(env.streams[0].tracks[0].stopped, true, '旧的轨道停掉');
  assert.ok(env.sources.at(-1).outs.includes(env.node));
  assert.equal(env.node.context, env.ctx, '在新的 AudioContext 上重建');
  await env.engine.tapResume();
  await env.play(noise(1, -60, 4));
  assert.equal(env.engine.status().gap, null);
  await env.engine.end();

  const h = setup();                                               // 恢复到一半切走 10 分钟：回来接着往下数，不会一下跳到最后一级
  await live(h);
  await h.play(noise(2, -60, 3));
  await h.clock.advance(6000);
  const [o2] = evs(h, 'gap-open').map(e => e.t);
  await h.clock.advance(o2 + 4000 - h.clock.now());
  h.setVisible(false);
  await h.clock.advance(600000);
  h.setVisible(true);
  await flush();
  await h.clock.advance(2000);
  assert.equal(evs(h, 'restart').length + evs(h, 'reacquire').length, 0);
  assert.equal(evs(h, 'rebuild').length, 1, '前台的时间到 6 秒才重建');
  assert.equal(h.engine.status().gap.reason, 'stall');
  await h.engine.end();
});

test('来电久了（一直 muted）：30 秒后才重新要麦克风，失败按 5 → 10 秒退避，3 次 → 请用户点；麦克风断开（ended）重新要成功 → 新的轨道接上', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(2, -60, 3));
  env.deny = 'NotReadableError';
  env.track.setMuted(true);
  await flush();
  const [open] = evs(env, 'gap-open').map(e => e.t);
  await env.clock.advance(60000);
  const tries = evs(env, 'reacquire').map(e => e.t - open);
  assert.equal(tries.length, 3);
  assert.ok(tries[0] >= 30000 && tries[0] < 32000, '等 30 秒');
  assert.ok(tries[1] - tries[0] >= 5000 && tries[1] - tries[0] < 7000);
  assert.ok(tries[2] - tries[1] >= 10000 && tries[2] - tries[1] < 12000);
  assert.equal(env.engine.status().gap.needTap, true);
  assert.equal(env.engine.status().gap.reason, 'muted');
  env.track.setMuted(false);                                       // 电话打完：原来的轨道自己好了
  await env.play(noise(1, -60, 4));
  assert.equal(env.engine.status().gap, null);
  await env.engine.end();

  let late, calls = 0;                                            // 重新要麦克风一直不回：15 秒后算失败，晚到的流马上关掉
  const hang = setup({ extra: { getUserMedia: (c) => (++calls === 1 ? hang.getUserMedia(c) : new Promise((res) => { late = res; })) } });
  await live(hang);
  await hang.play(noise(2, -60, 3));
  hang.track.end();
  await flush();
  assert.equal(calls, 2, '马上重新要');
  await hang.clock.advance(16000);
  assert.ok(evs(hang, 'reacquire').some(e => e.d.err === 'TimeoutError'));
  const ls = new FakeStream();
  late(ls);
  await flush();
  assert.equal(ls.tracks[0].stopped, true);
  await hang.engine.end();

  const e2 = setup();
  await live(e2);
  await e2.play(noise(2, -60, 3));
  const old = e2.track;
  old.end();
  await flush();
  assert.equal(e2.gum.length, 2);
  assert.notEqual(e2.track, old);
  assert.ok(e2.sources.at(-1).stream === e2.stream && e2.sources.at(-1).outs.includes(e2.node));
  await e2.play(noise(1, -60, 4));
  assert.equal(e2.engine.status().gap, null);
  await e2.engine.end();
  const s = sessionOf(e2);
  assert.equal(s.gaps[0].reason, 'ended');
  assert.equal(s.gaps[0].tap, undefined);
  assert.equal(s.counts.resumes, 1);
});

test('一段说到 MAX_CLIP_SEC 封顶：接着说的那段和它首尾相接（contOf），两段拼起来一个样本不多不少', async () => {
  const env = setup({ extra: { params: { ...P, MAX_CLIP_SEC: 30 } } });          // 调短，省时间
  const tLive = await live(env);
  const B = 60 * BLOCK, sig = mix(noise(70, -60, 3), speechy(24, -25), B);
  await env.play(sig);
  const [a, b] = cands(env);
  assert.equal(cands(env).length, 2);
  assert.equal(a.cut, 'max');
  assert.equal(a.samples, Math.ceil(30 * SR / FR) * FR, '到 30 秒的那一帧收');
  assert.equal(b.contOf, a.id);
  assert.equal(b.startAt, a.endAt);
  assert.equal(b.cut, 'quiet');
  const from = (a.startAt - tLive) * 16;
  const both = new Int16Array(a.samples + b.samples);
  both.set((await pcmOf(env.store, a.id)).subarray(0, a.samples));
  both.set((await pcmOf(env.store, b.id)).subarray(0, b.samples), a.samples);
  assert.deepEqual(both, toPcm16(sig.subarray(from, from + both.length)));
  await env.engine.end();
});

test('块照来但全是 0（坏掉的采集）→ silent', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(2, -60, 3));
  const last = env.clock.now();
  await env.play(silence(5));
  assert.deepEqual(env.engine.status().gap, { reason: 'silent', from: last, needTap: false });
  await env.engine.end();
  assert.equal(sessionOf(env).alive.samples, 7 * BLOCK, '0 不算听到的样本（2 秒噪声 = 7 整块）');
});

test('常亮在前台被收回 → 马上再要（之后每分钟）；记 wakeLost；在后台被收回不算', async () => {
  const env = setup();
  await live(env);
  assert.equal(env.wakes.length, 1);
  env.wakes[0].release();
  await flush();
  assert.equal(env.wakeReqs, 2, '马上再要');
  assert.equal(env.engine.status().wake, true);
  env.wakeDeny = true;
  env.wakes[1].release();
  await flush();
  assert.equal(env.engine.status().wake, false);
  assert.equal(env.wakeReqs, 2, '一分钟内不再马上要');
  await env.clock.advance(62000);
  assert.equal(env.wakeReqs, 3, '每分钟再要');
  env.wakeDeny = false;
  await env.clock.advance(60000);
  assert.equal(env.engine.status().wake, true);
  env.setVisible(false);
  env.wakes.at(-1).release();
  await flush();
  assert.equal(env.engine.status().wake, false);
  env.setVisible(true);
  await flush();
  assert.equal(env.engine.status().wake, true, '回到前台马上要');
  await env.engine.end();
  assert.equal(sessionOf(env).counts.wakeLost, 2);
  assert.ok(env.wakes.every(w => w.released));
});

test('识别一直不回（hang）：每块等 2 秒就按能量判（照样能存）；连着 8 块 → 停了（note vad、状态 off）；30 秒后重启一次；再挂就整夜按能量', async () => {
  const env = setup({ vad: { mode: 'hang', after: 'echo' } });
  const tLive = await live(env);
  const sig = mix(noise(110, -60, 3), tone(1.5, -25, 300), 20 * BLOCK);
  await env.play(sig.subarray(0, 24 * BLOCK));
  assert.equal(env.engine.status().vad, 'off');
  const down = evs(env, 'vad').find(e => e.d && e.d.down);
  assert.equal(down.d.down, 'late');
  assert.ok(down.t - tLive > 2000 && down.t - tLive < 5000);
  await env.play(sig.subarray(24 * BLOCK, 160 * BLOCK));
  assert.equal(env.vad.restarts, 1);
  assert.equal(env.engine.status().vad, 'on');
  const [c] = cands(env);
  assert.equal(cands(env).length, 1, '按能量也存下来了');
  assert.equal(c.state, 'new');
  assert.equal(c.vadMax, 0);
  assert.ok(c.gateSec >= 1.5 && c.speechSec >= 1.5);
  env.vad.mode = 'crash';
  await env.play(sig.subarray(160 * BLOCK, 300 * BLOCK));
  assert.equal(env.vad.restarts, 1, '只重启一次');
  assert.equal(env.engine.status().vad, 'off');
  await env.engine.end();
  const s = sessionOf(env), vn = s.notes.filter(n => n.kind === 'vad');
  assert.equal(vn.length, 2);
  assert.equal(vn[0].from, down.t);
  assert.ok(Math.abs(vn[0].to - vn[0].from - 30000) < 600, '停了 30 秒');
  assert.equal(vn[1].to, s.endedAt);
  assert.equal(s.counts.vadRestarts, 1);
  assert.equal(s.vad, 'off');
  assert.equal(env.vad.closed, true);
});

test('和真的 createVad（vad.js，假 Worker）一起：转交、按 seq 配对的概率照样存出一样的片段；worker 崩了 → 停，30 秒后 restart 开新 worker；结束时关掉', async () => {
  const workers = [];
  let crashNext = false;
  class FW {                                                      // 回复走微任务：和假时钟一起不会时快时慢
    constructor(url, opts) { Object.assign(this, { url: String(url), opts, terminated: false }); workers.push(this); }
    postMessage(m, transfer) {
      const got = transfer && transfer.length ? structuredClone(m, { transfer }) : m;
      Promise.resolve().then(() => {
        if (this.terminated) return;
        if (got.type === 'load') this.onmessage({ data: { type: 'ready', ms: 5 } });
        else if (got.type === 'block' && crashNext) { crashNext = false; this.onerror({ message: 'boom', preventDefault() {} }); }
        else if (got.type === 'block') this.onmessage({ data: { type: 'probs', seq: got.seq, probs: echoProbs(got.pcm), ms: 1.2 } });
      });
    }
    terminate() { this.terminated = true; }
  }
  const env = setup({ extra: { createVad: () => createVad({ Worker: FW, url: 'vad.worker.js' }) } });
  assert.equal((await env.engine.prepare()).vad, 'ready');
  await live(env);
  const B = 60 * BLOCK, sig = mix(noise(45, -60, 3), speechy(2, -25), B);
  await env.play(sig);
  const [c] = cands(env), { first, last } = loud(sig), from = first * FR - 8 * SR, to = (last + 1) * FR + 2 * SR;
  assert.equal(cands(env).length, 1);
  assert.equal(c.samples, to - from);
  assert.deepEqual((await pcmOf(env.store, c.id)).subarray(0, c.samples), toPcm16(sig.subarray(from, to)));
  assert.equal(c.vadMax, 0.9);
  crashNext = true;
  await env.play(noise(1, -60, 4));
  assert.equal(env.engine.status().vad, 'off');
  assert.equal(evs(env, 'vad').find(e => e.d && e.d.down).d.down, 'run');
  await env.play(noise(31, -60, 5));
  assert.equal(workers.length, 2, 'restart 开了新的 worker');
  assert.equal(env.engine.status().vad, 'on');
  await env.engine.end();
  assert.ok(workers.every(w => w.terminated), '结束时 worker 关掉');
  const s = sessionOf(env);
  assert.equal(s.vadMs, 1.2);
  assert.equal(s.counts.vadRestarts, 1);
});

test('识别载入不了（fail）：从开始就只按能量（note vad 从开始算）；按能量时说话不到 0.6 秒的丢掉', async () => {
  const env = setup({ vad: { mode: 'fail' } });
  await live(env);
  const s0 = sessionOf(env);
  assert.equal(env.engine.status().vad, 'off');
  assert.equal(s0.vad, 'off');
  assert.deepEqual(s0.notes, [{ kind: 'vad', from: s0.startedAt, to: null }]);
  await env.play(mix(mix(noise(70, -60, 3), tone(0.25, -25, 300), 20 * BLOCK), tone(1.5, -25, 300), 140 * BLOCK));
  const drops = evs(env, 'clip-drop');
  assert.equal(drops.length, 1);
  assert.ok(drops[0].d.speechSec >= 0.3 && drops[0].d.speechSec < 0.6, `能量门算的说话 ${drops[0].d.speechSec} 秒`);
  assert.equal(cands(env).length, 1);
  assert.equal(cands(env)[0].state, 'new');
  await env.engine.end();
  assert.equal(sessionOf(env).counts.dropped, 1);
});

test('识别算出 NaN → 当挂了（停、30 秒后重启）', async () => {
  const env = setup({ vad: { mode: 'nan' } });
  await live(env);
  await env.play(noise(1, -60, 3));
  assert.equal(env.engine.status().vad, 'off');
  assert.equal(evs(env, 'vad').find(e => e.d && e.d.down).d.down, 'nan');
  await env.play(noise(31, -60, 4));
  assert.equal(env.vad.restarts, 1);
  assert.equal(env.engine.status().vad, 'on');
  await env.engine.end();

  const idle = setup();                                           // worker 空闲时崩了：没有哪块报错，tick 看 state
  await live(idle);
  idle.vad.state = 'off';
  await idle.clock.advance(2000);
  assert.equal(idle.engine.status().vad, 'off');
  assert.equal(evs(idle, 'vad').find(e => e.d && e.d.down).d.down, 'crash');
  await idle.clock.advance(30000);
  assert.equal(idle.vad.restarts, 1);
  await idle.engine.end();
});

test('心跳每 10 秒改写 session.alive；beat 事件每 60 秒一条；onStatus 不会每块叫；计时器晚了 5 秒以上记 late；到 autoEndAt 自动结束', async () => {
  const env = setup();
  const tLive = await live(env, { autoEndAt: env.clock.now() + 200000 });
  const n0 = env.statuses.length;
  await env.play(noise(10.5, -60, 3));
  let s = sessionOf(env);
  assert.equal(s.alive.at, tLive + 10000);
  assert.equal(s.alive.samples, 39 * BLOCK);
  assert.deepEqual([s.alive.vis, s.alive.track, s.alive.muted, s.alive.ctx, s.alive.wake, s.alive.q], [true, 'live', false, 'running', true, 0]);
  assert.ok(Math.abs(s.alive.floor + 60) < 2 && Math.abs(s.alive.thr - s.alive.floor - 7) < 0.2);
  await env.play(noise(10, -60, 4));
  assert.equal(sessionOf(env).alive.at, tLive + 20000);
  await env.play(noise(110, -60, 5));
  assert.deepEqual(evs(env, 'beat').map(e => e.t - tLive), [60000, 120000]);
  assert.equal(env.statuses.length, n0, '一直在听：状态没变就不叫');
  env.clock.jump(8000);
  await env.play(noise(2.1, -60, 6));
  assert.equal(evs(env, 'late').length, 1);
  assert.ok(evs(env, 'late')[0].d.ms >= 8000);
  await env.play(noise(70, -60, 7));
  assert.equal(env.engine.phase, 'ended');
  s = sessionOf(env);
  assert.equal(s.status, 'ended');
  assert.equal(s.endReason, 'auto');
  assert.ok(s.endedAt >= tLive + 200000 && s.endedAt < tLive + 202100);
  assert.equal(s.counts.late, 1);
  assert.ok(s.counts.maxTickGapMs >= 8000);
  assert.ok(s.vadOnMs > 190000);
});

test('结束：session 写成 ended 的时候 NIGHT_LOCK 还拿着（别的标签页这时启动也不会当成被杀的），写完才放', async () => {
  const env = setup();
  await live(env);
  const id = env.engine.status().sessionId, seen = [];
  const patch = env.store.patchSession;
  env.store.patchSession = (sid, x) => { if (x && x.status === 'ended') seen.push(env.locks.held.has(NIGHT_LOCK + id)); return patch(sid, x); };
  await env.play(noise(2, -60, 3));
  await env.engine.end();
  await flush();
  assert.deepEqual(seen, [true]);
  assert.equal(env.locks.held.size, 0);
});

test('结束：开着的段按 end 收；轨道停、AudioContext 关、识别关、常亮放、两把锁放、音频会话回到原来的；session 写 ended；再叫 end 拿到同一个结果；之后的事件没人听', async () => {
  const env = setup();
  env.audioSession.type = 'ambient';
  await live(env);
  await env.play(mix(noise(14, -60, 3), speechy(3, -25), 40 * BLOCK));
  const p1 = env.engine.end('user'), p2 = env.engine.end('leave');
  assert.equal(p1, p2);
  assert.equal(env.engine.phase, 'ending');
  const sum = await p1;
  assert.equal(env.engine.phase, 'ended');
  await flush();                                                 // Web Locks 放锁是异步的
  const [c] = cands(env);
  assert.equal(c.state, 'new');
  assert.equal(c.cut, 'end');
  assert.ok(env.streams.every(s => s.tracks.every(t => t.stopped)));
  assert.ok(env.contexts.every(a => a.state === 'closed'));
  assert.ok(env.node === null, '采集节点都断开了');
  assert.equal(env.vad.closed, true);
  assert.ok(env.wakes.every(w => w.released));
  assert.equal(env.locks.held.size, 0);
  assert.equal(env.audioSession.type, 'ambient');
  assert.equal(env.clock.pending, 0, '计时器都清了');
  const s = sessionOf(env);
  assert.equal(s.status, 'ended');
  assert.equal(s.endReason, 'user');
  assert.equal(s.counts.clips, 1);
  assert.equal(s.alive.at, s.endedAt);
  assert.deepEqual(sum, { sessionId: s.id, nightOf: s.nightOf, reason: 'user', listenedMs: s.endedAt - s.startedAt, clips: 1, unsaved: 0 });
  assert.equal(await env.engine.end('auto'), sum);
  assert.equal(evs(env, 'end').length, 1);
  assert.equal(env.engine.status().phase, 'ended');
  const n = env.store.maps.events.length, statuses = env.statuses.length;
  env.track.setMuted(true);
  env.setVisible(false);
  env.win.dispatchEvent(new Event('pagehide'));
  env.wakes[0].dispatchEvent(new Event('release'));
  await env.clock.advance(30000);
  assert.equal(env.store.maps.events.length, n, '监听都拿掉了');
  assert.equal(env.statuses.length, statuses);
});

test('等权限的时候离开（end leave）：开始作废，权限给了也马上关麦克风；没有留下 live 的 session；准备好没开始就离开（dispose）关掉识别', async () => {
  let grant;
  const env = setup({ extra: { getUserMedia: () => new Promise((res) => { grant = res; }) } });
  const p = env.engine.start();
  await flush();
  assert.equal(env.engine.phase, 'starting');
  const sum = await env.engine.end('leave');
  assert.equal(env.engine.phase, 'ended');
  assert.equal(sum.sessionId, null);
  assert.equal(sum.reason, 'leave');
  const s = new FakeStream();
  grant(s);
  await p;
  await flush();
  assert.equal(s.tracks[0].stopped, true);
  assert.equal(env.ctx.state, 'closed');
  assert.equal(env.locks.held.size, 0);
  assert.equal(env.store.maps.sessions.size, 0);
  assert.equal(env.audioSession.type, 'auto');
  assert.equal(env.engine.phase, 'ended');

  const r = setup();
  await r.engine.prepare();
  r.engine.dispose();
  assert.equal(r.vad.closed, true);
  const l = setup();
  await live(l);
  l.engine.dispose();                                            // 正在听：按离开结束
  await flush(6);
  assert.equal(l.engine.phase, 'ended');
  assert.equal(sessionOf(l).endReason, 'leave');
});

test('事件记满 EVENTS_MAX 以后只记 beat、gap-*、出错和 end，外加一条 events-capped', async () => {
  const env = setup({ extra: { params: { ...P, EVENTS_MAX: 4 } } });
  await live(env);
  for (let i = 0; i < 6; i++) { env.setVisible(i % 2 === 1); await flush(); }
  await env.play(noise(1, -60, 3));
  await env.clock.advance(5000);
  await env.engine.end();
  const ks = evs(env).map(e => e.k);
  assert.equal(ks.filter(k => k === 'events-capped').length, 1);
  assert.deepEqual(ks.slice(0, 4), ['start', 'track', 'vis', 'vis']);
  assert.ok(ks.includes('gap-open') && ks.at(-1) === 'end');
  assert.ok(!ks.slice(5).includes('vis'));
});

test('recoverNights：live、锁没人拿着 → crashed，收在 alive.at；开着的 gap 保留原因；开着的片段收在 ls + 2 秒，sp < 0.3 的和没分片的丢掉；拿着锁的、这次启动后开始的跳过', async () => {
  const store = memoryNightStore(), T = Date.UTC(2026, 10, 17, 16, 0), H = 3600e3;
  const sess = (id, o = {}) => ({ id, v: 1, nightOf: '2026-11-17', startedAt: T, endedAt: null, status: 'live', endReason: null, tz: 'Asia/Shanghai',
    gaps: [], notes: [], counts: {}, alive: { at: T + H }, reviewedAt: null, ...o });
  await store.putSession(sess('n_a', { gaps: [{ from: T + 0.2 * H, to: T + 0.3 * H, reason: 'muted' }, { from: T + H - 9000, to: null, reason: 'hidden' }],
    notes: [{ kind: 'vad', from: T, to: null }] }));
  await store.putSession(sess('n_held'));
  await store.putSession(sess('n_late', { startedAt: T + 2 * H }));
  await store.putSession(sess('n_done', { status: 'ended', endedAt: T + 100, endReason: 'user' }));
  const cand = (id, o = {}) => ({ id, s: 'n_a', v: 1, state: 'open', startAt: T + 0.5 * H, sr: SR, ...o });
  const part = (sec, ls, sp) => ({ b: new Int16Array(Math.round(sec * SR)).fill(7).buffer, ls, sp });
  await store.putCand(cand('c_ok'));
  await store.putPart('c_ok', 0, part(8, 128512, 0.4));
  for (let i = 1; i <= 4; i++) await store.putPart('c_ok', i, part(1, 140000, 1.2));
  await store.putCand(cand('c_short'));
  await store.putPart('c_short', 0, part(8, 128512, 0.2));
  await store.putCand(cand('c_empty'));
  await store.putCand(cand('c_new', { state: 'new', samples: 5 }));
  await store.putCand(cand('c_held', { s: 'n_held' }));
  const locks = { query: async () => ({ held: [{ name: NIGHT_LOCK + 'n_held' }] }) };
  const r = await recoverNights({ store, before: T + 1.5 * H, locks, now: () => T + 9 * H });
  assert.deepEqual(r, { crashed: ['n_a'], clips: 1 });
  const a = await store.getSession('n_a');
  assert.equal(a.status, 'crashed');
  assert.equal(a.endReason, 'killed');
  assert.equal(a.endedAt, T + H);
  assert.equal(a.stopWhy, 'hidden', '开着的 gap 的原因');
  assert.deepEqual(a.gaps, [{ from: T + 0.2 * H, to: T + 0.3 * H, reason: 'muted' }, { from: T + H - 9000, to: T + H, reason: 'hidden' }]);
  assert.deepEqual(a.notes, [{ kind: 'vad', from: T, to: T + H }]);
  const c = await store.getCand('c_ok');
  assert.deepEqual([c.state, c.samples, c.endAt, c.durationSec, c.speechSec, c.cut, c.parts], ['new', 172000, T + 0.5 * H + 10750, 10.8, 1.2, 'crash', 5]);
  assert.equal(await store.getCand('c_short'), null);
  assert.equal((await store.getParts('c_short')).length, 0);
  assert.equal(await store.getCand('c_empty'), null);
  assert.equal((await store.getCand('c_new')).state, 'new');
  assert.equal((await store.getCand('c_held')).state, 'open');
  for (const id of ['n_held', 'n_late']) assert.equal((await store.getSession(id)).status, 'live');
  assert.equal((await store.getSession('n_done')).status, 'ended');
  const ev = await store.listEvents('n_a');
  assert.deepEqual([ev.at(-1).k, ev.at(-1).t, ev.at(-1).d.stoppedWhy], ['recovered', T + 9 * H, 'hidden']);

  const s2 = memoryNightStore();
  await s2.putSession(sess('n_x', { status: 'ended' }));
  await s2.putCand(cand('c_x', { s: 'n_x', state: 'new' }));
  s2.calls.length = 0;
  assert.deepEqual(await recoverNights({ store: s2, before: T + 9 * H, locks }), { crashed: [], clips: 0 });
  assert.deepEqual(s2.calls, ['listSessions', 'listCands'], '没有 live 的、也没有漏下的 open：只读两个 getAll，不查锁、不读分片、不写');

  // 为什么停的：在后台时停的（alive.vis false，gap 没来得及写）→ hidden；在前台（来电、Siri 也一样）→ killed，不按 muted / ctx 猜
  const s3 = memoryNightStore();
  await s3.putSession(sess('n_hid', { alive: { at: T + H, vis: false, muted: true, ctx: 'interrupted' } }));
  await s3.putSession(sess('n_vis', { id: 'n_vis', alive: { at: T + H, vis: true, muted: true, ctx: 'interrupted' } }));
  await recoverNights({ store: s3, before: T + 9 * H, locks: null, now: () => T + 9 * H });
  assert.equal((await s3.getSession('n_hid')).stopWhy, 'hidden');
  assert.equal((await s3.getSession('n_vis')).stopWhy, 'killed');
  assert.equal((await s3.listEvents('n_hid')).at(-1).d.stoppedWhy, 'hidden');
});

test('App 在说话时被杀：下次启动 recoverNights 把开着的片段收在最后一句 + 2 秒，已经写进去的声音一点不丢；会话收在最后一次心跳', async () => {
  const env = setup();
  await live(env);
  const B = 40 * BLOCK, sig = mix(noise(30, -60, 3), speechy(3, -25), B), stop = B + 20 * BLOCK;
  await env.play(sig.subarray(0, stop));                          // 说完 2 秒左右（还没到 20 秒收段）就没了
  const before = env.clock.now() + 60000;
  const r = await recoverNights({ store: env.store, before, locks: { query: async () => ({ held: [] }) }, now: () => before });
  assert.equal(r.crashed.length, 1);
  assert.equal(r.clips, 1);
  const [c] = cands(env), { first, last } = loud(sig.subarray(0, stop)), from = first * FR - 8 * SR;
  const pcm = await pcmOf(env.store, c.id);
  assert.equal(c.state, 'new');
  assert.equal(c.cut, 'crash');
  assert.equal(c.samples, Math.min(pcm.length, (last + 1) * FR - from + 2 * SR));
  assert.ok(c.samples >= (last + 1) * FR - from + SR, '说的都在');
  assert.deepEqual(pcm.subarray(0, c.samples), toPcm16(sig.subarray(from, from + c.samples)));
  const s = sessionOf(env);
  assert.equal(s.status, 'crashed');
  assert.equal(s.endReason, 'killed');
  assert.equal(s.endedAt, s.alive.at);
});

test('purgeNights：删掉 24 小时以上的、7 天前的片段清掉声音并标 gone；30 天前的整晚连记录删；不碰 live 和开着的', async () => {
  const store = memoryNightStore(), now = Date.UTC(2026, 10, 18, 2, 0);
  const sess = (id, days, status = 'ended') => store.putSession({ id, startedAt: now - days * DAY, status, gaps: [], notes: [] });
  await sess('n_live', 40, 'live'); await sess('n_old', 31); await sess('n_week', 8); await sess('n_new', 1);
  const cand = async (id, s, o = {}) => { await store.putCand({ id, s, state: 'new', startAt: now - DAY, ...o }); await store.putPart(id, 0, { b: new ArrayBuffer(8), ls: 0, sp: 1 }); };
  await cand('c_week', 'n_week');
  await cand('c_del', 'n_new', { state: 'deleted', deletedAt: now - 2 * DAY });
  await cand('c_del_recent', 'n_new', { state: 'deleted', deletedAt: now - 3600e3 });
  await cand('c_keep', 'n_new');
  await cand('c_open', 'n_live', { state: 'open' });
  await cand('c_live', 'n_live');
  await cand('c_old', 'n_old');
  await store.logEvent('n_old', now - 31 * DAY, 'start');
  assert.deepEqual(await purgeNights(store, { now }), { parts: 2, sessions: 1 });
  for (const id of ['c_week', 'c_del']) { assert.equal((await store.getCand(id)).gone, true); assert.equal((await store.getParts(id)).length, 0); }
  for (const id of ['c_del_recent', 'c_keep', 'c_open', 'c_live']) { assert.equal((await store.getCand(id)).gone, undefined); assert.equal((await store.getParts(id)).length, 1); }
  assert.equal(await store.getSession('n_old'), null);
  assert.equal(await store.getCand('c_old'), null);
  assert.equal((await store.listEvents('n_old')).length, 0);
  assert.equal((await store.getSession('n_live')).status, 'live');
  assert.deepEqual(await purgeNights(store, { now }), { parts: 0, sessions: 0 }, '再跑一次没有要清的');
});

// ---------- 复查后补的 ----------
test('锁屏后被系统清掉（找回 → 报告）：gap 没写进去、或者结尾那段很短，也说「屏幕锁上了」；在前台被杀才说 App 被关掉了', async () => {
  const run = async (how) => {
    const env = setup();
    await live(env);
    await env.play(noise(12, -60, 3));                               // 心跳写过一次
    if (how === 'frozen') { env.setVisible(false); await flush(); }   // 切走马上被冻住：轨道的事件一直没来，gap 没开
    if (how === 'short') { env.setVisible(false); await flush(); await env.clock.advance(1000); env.track.setMuted(true); await flush(); await env.clock.advance(4000); }   // 后台里又跑了几秒
    // 之后页面就没了（被系统清掉）：什么都不再发生
    const before = env.clock.now() + 3600e3;
    assert.equal((await recoverNights({ store: env.store, before, locks: { query: async () => ({ held: [] }) }, now: () => before })).crashed.length, 1);
    const s = sessionOf(env);
    return { s, rep: nightReport({ sessions: [s], cands: cands(env), nightOf: s.nightOf, now: before }) };
  };
  let { s, rep } = await run('frozen');
  assert.deepEqual([s.gaps.length, s.alive.vis, s.stopWhy], [0, false, 'hidden']);
  assert.deepEqual(rep.stopped, { at: s.alive.at, why: 'hidden', killed: true });
  assert.equal(rep.empty, 'stopped');
  ({ s, rep } = await run('short'));
  assert.deepEqual(s.gaps.map(g => g.reason), ['hidden']);
  assert.ok(s.gaps[0].to - s.gaps[0].from < P.GAP_SHOW_SEC * 1000, '结尾那段不到 30 秒');
  assert.equal(rep.stopped.why, 'hidden');
  ({ s, rep } = await run('visible'));
  assert.equal(s.stopWhy, 'killed');
  assert.deepEqual(rep.stopped, { at: s.alive.at, why: 'killed', killed: true });
});

test('心跳正在写的时候又要写（切到后台马上断了）：等前一次写完再写一次，开着的 gap、alive.vis 都写进去', async () => {
  const env = setup();
  await live(env);
  await env.play(noise(2, -60, 3));
  const patch = env.store.patchSession;
  let first = true, release = null;
  env.store.patchSession = (id, x) => {                            // 像 IndexedDB：调用时就拷一份，过一会儿才写完
    const snap = structuredClone(x);
    if (!first) return patch(id, snap);
    first = false;
    return new Promise((r) => { release = () => r(patch(id, snap)); });
  };
  env.setVisible(false);
  await flush();
  env.track.setMuted(true);
  await flush();
  assert.equal(env.engine.status().gap.reason, 'hidden');
  assert.deepEqual(sessionOf(env).gaps, [], '第一次还没写完');
  release();
  await flush();
  const s = sessionOf(env);
  assert.deepEqual(s.gaps.map(g => [g.reason, g.to]), [['hidden', null]], '写完马上又写了一次');
  assert.equal(s.alive.vis, false);
  await env.engine.end();
});

test('收段没写进去（patchCand 两次都失败）：先还是 open，下一次心跳再写就好了；结束时还没写进去的直接再写；丢段也一样', async () => {
  const env = setup();
  await live(env);
  env.store.fail.patchCand = 2;
  const B = 40 * BLOCK, sig = mix(noise(50, -60, 3), speechy(2, -25), B), { first, last } = loud(sig);
  const closeAt = Math.ceil(((last + 1) * FR + 20 * SR) / BLOCK) + 1;
  await env.play(sig.subarray(0, closeAt * BLOCK));
  assert.equal(evs(env, 'clip-close').length, 1);
  assert.equal(cands(env)[0].state, 'open', '两次都没写进去');
  assert.equal(env.engine.status().warn, 'store');
  await env.play(sig.subarray(closeAt * BLOCK));                   // 下一次心跳
  const [c] = cands(env);
  assert.deepEqual([c.state, c.cut, c.samples], ['new', 'quiet', (last + 1) * FR + 2 * SR - (first * FR - 8 * SR)]);
  assert.equal(c.parts, (await env.store.getParts(c.id)).length);
  assert.equal(env.engine.status().warn, null, '再写好了：「存不进」收起来（不用等下一片声音）');
  await env.engine.end();
  assert.equal(sessionOf(env).counts.clips, 1);

  const e2 = setup();                                               // 结束时收段两次都失败：链空了以后直接再写一次
  await live(e2);
  await e2.play(mix(noise(14, -60, 3), speechy(3, -25), 40 * BLOCK));
  e2.store.fail.patchCand = 2;
  await e2.engine.end();
  assert.deepEqual(cands(e2).map(x => [x.state, x.cut]), [['new', 'end']]);

  const e4 = setup();                                               // 收段到最后都没写进去，但声音都写进去了：下次启动会找回，不说「没存进来」
  await live(e4);
  await e4.play(mix(noise(14, -60, 3), speechy(3, -25), 40 * BLOCK));
  e4.store.fail.patchCand = Infinity; e4.store.fail.putCand = Infinity;
  const s4 = await e4.engine.end();
  assert.deepEqual([cands(e4).map(x => x.state), s4.unsaved], [['open'], 0]);

  const e3 = setup({ vad: { mode: 'fail' } });                      // 丢段（太短）两次都失败：心跳时再丢
  await live(e3);
  e3.store.fail.dropCand = 2;
  await e3.play(mix(noise(40, -60, 3), tone(0.25, -25, 300), 20 * BLOCK));
  assert.equal(evs(e3, 'clip-drop').length, 1);
  assert.equal(cands(e3).length, 0);
  await e3.engine.end();
});

test('片段一直写不进去（不是存储满）：警告一直是「存不进」（session 写好了也不收起，片段写好了才收）；没存进声音的段不算「存了」，结束时说几段没存进来', async () => {
  const env = setup();
  await live(env);
  env.store.fail.putPart = Infinity;                                // 分片一片都写不进去；候选、session 照常
  const sig = mix(mix(noise(120, -60, 3), speechy(2, -25), 40 * BLOCK), speechy(2, -25), 250 * BLOCK);
  const warns = [];
  for (let o = 0; o + 10 * BLOCK <= sig.length; o += 10 * BLOCK) { await env.play(sig.subarray(o, o + 10 * BLOCK)); warns.push(env.engine.status().warn); }
  assert.equal(evs(env, 'clip-close').length, 2);
  assert.ok(warns.slice(warns.indexOf('store')).every(w => w === 'store'), warns.join(','));
  assert.equal(env.engine.status().clips, 0, '没存进声音：不说「存了」');
  const sum = await env.engine.end();
  assert.deepEqual([sum.clips, sum.unsaved], [0, 2]);
  assert.deepEqual(cands(env).map(c => [c.state, c.parts, c.gone]), [['new', 0, true], ['new', 0, true]], '一片声音都没有：早上显示「没存进来」，不算待听');
  assert.equal(sessionOf(env).counts.unsaved, 2);

  const all = setup();                                              // 开始以后什么都写不进去（session 也是）：结束时照样知道
  await live(all);
  for (const k of ['putCand', 'patchCand', 'putPart', 'patchSession', 'putSession']) all.store.fail[k] = Infinity;
  await all.play(mix(noise(40, -60, 3), speechy(2, -25), 40 * BLOCK));
  assert.equal(all.engine.status().warn, 'store');
  const warn = console.warn;
  console.warn = () => {};                                          // 结束时 session 写不进去会记一句
  const s2 = await all.engine.end().finally(() => { console.warn = warn; });
  assert.deepEqual([s2.clips, s2.unsaved], [0, 1]);
  assert.equal(all.store.maps.cands.size, 0);

  const ok = setup();                                               // 一片写不进去、下一片写好了：警告收起来，照样算存了
  await live(ok);
  ok.store.fail.putPart = 2;
  await ok.play(mix(noise(40, -60, 3), speechy(2, -25), 40 * BLOCK));
  assert.equal(ok.engine.status().warn, null);
  assert.deepEqual([(await ok.engine.end()).clips, ok.engine.status().clips], [1, 1]);
});

test('收段一直写不进去：下一次心跳再试，之后越隔越久（最多 5 分钟一次），不会整夜每 10 秒记一次 store-fail；结束时再试一次', async () => {
  const env = setup();
  await live(env);
  const sig = mix(noise(40, -60, 3), speechy(2, -25), 40 * BLOCK);
  env.store.fail.patchCand = Infinity;
  await env.play(sig);
  const fails = () => evs(env, 'store-fail').filter(e => e.d && e.d.what === 'cand').length;
  const first = fails();
  assert.ok(first >= 1);
  for (let i = 0; i < 30; i++) await env.play(noise(20, -60, 4 + i));      // 再听 10 分钟
  assert.ok(fails() - first <= 7, `10 分钟里重试了 ${fails() - first} 次`);
  assert.ok(fails() - first >= 4);
  env.store.fail.patchCand = 0;
  await env.engine.end();
  assert.deepEqual(cands(env).map(c => c.state), ['new']);
  assert.equal(sessionOf(env).counts.clips, 1);
});

test('结束时写入链还卡着（IndexedDB 一直不回）：照样结束；NIGHT_LOCK 拿到链写完才放（别的标签页这时找回不碰它），收段晚一点也写进去', async () => {
  const env = setup();
  await live(env);
  await env.play(mix(noise(14, -60, 3), speechy(3, -25), 40 * BLOCK));
  const id = env.engine.status().sessionId, recover = () => recoverNights({ store: env.store, before: env.clock.now() + 1, locks: env.locks });
  env.store.putPart = () => new Promise(() => {});                 // 最后那片一直不回（每次最多等 10 秒，试两次）
  const p = env.engine.end();
  await flush();                                                   // 走到「最多等 END_WAIT_MS」那一步
  await env.clock.advance(6000);
  await p;
  assert.equal(sessionOf(env).status, 'ended');
  assert.equal(env.locks.held.has(LIVE_LOCK), false);
  assert.equal(env.locks.held.has(NIGHT_LOCK + id), true, '链还没写完');
  assert.equal(cands(env)[0].state, 'open');
  assert.deepEqual(await recover(), { crashed: [], clips: 0 }, '拿着锁：不碰');
  assert.equal(cands(env)[0].state, 'open');
  await env.clock.advance(25000);
  assert.equal(cands(env)[0].state, 'new', '最后那片放弃以后照样收段');
  assert.equal(env.locks.held.has(NIGHT_LOCK + id), false);
});

test('recoverNights：已经结束的那晚里还 open 的片段（收段没写进去就被划掉了）也收好；找不到那晚记录的按 crash 收；拿着锁的、还 live 的不碰；收之前报告也不说「没听到说话」', async () => {
  const store = memoryNightStore(), T = Date.UTC(2026, 10, 17, 16, 0), H = 3600e3;
  const sess = (id, o = {}) => ({ id, v: 1, nightOf: '2026-11-17', startedAt: T, endedAt: T + H, status: 'ended', endReason: 'user', tz: 'Asia/Shanghai',
    gaps: [], notes: [], counts: {}, alive: { at: T + H }, reviewedAt: null, ...o });
  await store.putSession(sess('n_e'));
  await store.putSession(sess('n_busy'));
  await store.putSession(sess('n_l', { status: 'live', endedAt: null, endReason: null }));
  const part = (sec, ls, sp) => ({ b: new Int16Array(Math.round(sec * SR)).fill(3).buffer, ls, sp });
  const cand = async (id, s, sp) => { await store.putCand({ id, s, v: 1, state: 'open', startAt: T + 0.5 * H, sr: SR }); await store.putPart(id, 0, part(8, 128000, sp)); await store.putPart(id, 1, part(4, 150000, sp)); };
  await cand('c_e1', 'n_e', 1.2); await cand('c_e2', 'n_e', 0.1); await cand('c_gone', 'n_none', 1); await cand('c_busy', 'n_busy', 1); await cand('c_l', 'n_l', 1);
  assert.equal(nightReport({ sessions: [await store.getSession('n_e')], cands: await store.listCands(), nightOf: '2026-11-17', now: T + 9 * H }).empty, null);
  const locks = { query: async () => ({ held: [{ name: NIGHT_LOCK + 'n_busy' }, { name: NIGHT_LOCK + 'n_l' }] }) };
  assert.deepEqual(await recoverNights({ store, before: T + 9 * H, locks, now: () => T + 9 * H }), { crashed: [], clips: 2 });
  const c = async (id) => store.getCand(id);
  assert.deepEqual(await c('c_e1').then(x => [x.state, x.cut, x.samples, x.parts, x.speechSec]), ['new', 'end', 150000 + 2 * SR, 2, 1.2]);
  assert.equal(await c('c_e2'), null, '说话不够：丢掉');
  assert.deepEqual(await c('c_gone').then(x => [x.state, x.cut]), ['new', 'crash']);
  assert.equal((await c('c_busy')).state, 'open', '别的标签页拿着锁（结束了还在写）');
  assert.equal((await c('c_l')).state, 'open', '还 live 的归上面那一步');
  assert.deepEqual((await store.listEvents('n_e')).map(e => [e.k, e.d]), [['recovered', { cands: ['c_e1', 'c_e2'], clips: 1 }]]);
  assert.equal((await store.getSession('n_e')).status, 'ended', '那晚本身不改');
  const r = nightReport({ sessions: [await store.getSession('n_e')], cands: await store.listCands(), nightOf: '2026-11-17', now: T + 9 * H });
  assert.deepEqual(r.clips.map(x => x.id), ['c_e1']);
});

test('给说话识别的那份按噪声底放大（存的声音、能量门不变）：很安静的屋里小声说也能认出来；峰值不超过 −1 dBFS（大声的不削顶）；心跳记下增益', async () => {
  // 假识别按绝对音量（−45 dBFS）判，所以这里把目标噪声底调到 −50（真的 Silero 用 −40，见 P）
  const run = async (gain, floorDb, talkDb, sec = 30) => {
    const env = setup({ gain, extra: { params: { ...P, VAD_GAIN_TARGET_DB: -50 } } });
    const got = [], push = env.vad.push;
    env.vad.push = (pcm) => { got.push(pcm.slice()); return push(pcm); };
    await live(env);
    const sig = mix(noise(sec, floorDb, 3), speechy(2, talkDb), 40 * BLOCK);
    await env.play(sig);
    return { env, sig, got };
  };
  let { env, sig, got } = await run(0, -70, -57);
  assert.equal(cands(env).length, 0, '不放大：小声的认不出来');
  assert.deepEqual(got[45], sig.subarray(45 * BLOCK, 46 * BLOCK), '原样交给识别');
  await env.engine.end();
  ({ env, sig, got } = await run(30, -70, -57));
  assert.equal(cands(env).length, 1, '放大 20 dB（噪声底 −70 → −50）就认出来了');
  const k = got[45][100] / sig[45 * BLOCK + 100];
  assert.ok(Math.abs(20 * Math.log10(k) - 20) < 1, `增益 ${20 * Math.log10(k)} dB`);
  assert.ok(Math.abs(sessionOf(env).alive.gain - 20) < 1);
  const [c] = cands(env), from = (c.startAt - sessionOf(env).startedAt) * 16;
  assert.deepEqual((await pcmOf(env.store, c.id)).subarray(0, c.samples), toPcm16(sig.subarray(from, from + c.samples)), '存的是原来的声音');
  await env.engine.end();
  ({ env, sig, got } = await run(30, -80, -12, 20));                // 很大声（峰值约 −2 dBFS）：放大到峰值 −1 dBFS 为止，不削顶
  assert.equal(cands(env).length, 1);
  for (const [i, x] of got.entries()) {
    let m = 0, top = 0;
    for (let j = 0; j < x.length; j++) { m = Math.max(m, Math.abs(x[j])); if (Math.abs(sig[i * BLOCK + j]) > Math.abs(sig[i * BLOCK + top])) top = j; }
    assert.ok(m <= Math.max(10 ** (-1 / 20), Math.abs(sig[i * BLOCK + top])) + 1e-6, `第 ${i} 块峰值 ${m}`);
    assert.ok(x[top] / sig[i * BLOCK + top] >= 1 - 1e-6, '只放大不压低');
  }
  await env.engine.end();
});

test('大声说完以后识别 2 秒没听到说话：清一次识别的状态（不然紧跟着小声的回话认不出来，片段在大声那句后 2 秒就收了）；没说话时不反复清', async () => {
  const run = async (resetSec) => {
    const env = setup({ extra: { params: { ...P, VAD_IDLE_RESET_SEC: resetSec } } });
    const v = env.vad, frameDb = (x, i) => 10 * Math.log10(x.subarray(i * FR, (i + 1) * FR).reduce((s, a) => s + a * a, 0) / FR + 1e-12);
    let sore = false;                                               // 像 Silero：听过很响的以后，小声的（−45…−30）也给低分，直到 reset
    v.push = (pcm) => {
      v.pushes++;
      const x = pcm.slice(), out = echoProbs(x);
      for (let i = 0; i < out.length; i++) { const db = frameDb(x, i); if (db > -30) sore = true; else if (sore) out[i] = 0.05; }
      return Promise.resolve(out);
    };
    v.reset = () => { v.resets++; sore = false; };
    await live(env);
    const sig = mix(mix(noise(60, -60, 3), speechy(2, -20), 40 * BLOCK), speechy(1.5, -38), 40 * BLOCK + 7 * SR);
    await env.play(sig);
    await env.engine.end();
    return { env, sig };
  };
  let { env, sig } = await run(P.VAD_IDLE_RESET_SEC);
  const replyEnd = 40 * BLOCK + 8.5 * SR;
  let [c] = cands(env), to = (c.startAt - sessionOf(env).startedAt) * 16 + c.samples;
  assert.equal(cands(env).length, 1);
  assert.ok(to >= replyEnd + SR && to <= replyEnd + 2 * SR, '收在回话之后 2 秒');
  assert.equal(env.vad.resets, 2, '大声那句、回话之后各清一次；之后一直安静不再清');
  ({ env, sig } = await run(1e9));
  [c] = cands(env); to = (c.startAt - sessionOf(env).startedAt) * 16 + c.samples;
  assert.ok(to < 40 * BLOCK + 5 * SR, '不清：回话没认出来，片段在大声那句后 2 秒就收了');
  assert.equal(env.vad.resets, 0);
});

test('开始时识别还在载入：这段按能量找也记一条 vad（载入好了收在那一刻，不到 30 秒的不记）；一直载入不好（下载卡住）→ 10 分钟后重启一次，还不行就整夜按能量', async () => {
  /** load 由测试来定什么时候好；restart 先把卡着的那次当失败结束（和 vad.js 一样） */
  const slow = (env, restartOk = true) => {
    const v = env.vad;
    let pend = null, done = null;
    v.load = () => { v.loads++; if (v.state === 'ready') return Promise.resolve(true); if (pend) return pend; v.state = 'loading'; return (pend = new Promise((r) => { done = (ok) => { pend = null; v.state = ok ? 'ready' : 'off'; r(ok); }; })); };
    v.restart = () => { v.restarts++; if (done) done(false); v.state = restartOk ? 'ready' : 'off'; return Promise.resolve(restartOk); };
    return (ok) => done(ok);
  };
  let env = setup();
  let finish = slow(env);
  const t0 = await live(env);
  assert.equal(env.engine.status().vad, 'loading');
  assert.deepEqual(sessionOf(env).notes, [{ kind: 'vad', from: t0, to: null }]);
  await env.play(noise(120, -60, 3));
  finish(true);
  await flush();
  const tReady = env.clock.now();
  assert.equal(env.engine.status().vad, 'on');
  await env.engine.end();
  let s = sessionOf(env);
  assert.deepEqual(s.notes, [{ kind: 'vad', from: t0, to: tReady }]);
  assert.equal(nightReport({ sessions: [s], cands: [], nightOf: s.nightOf, now: s.endedAt }).energyMs, tReady - t0);

  env = setup();                                                    // 10 秒就好了：不记
  finish = slow(env);
  await live(env);
  await env.play(noise(10, -60, 3));
  finish(true);
  await flush();
  await env.engine.end();
  assert.deepEqual(sessionOf(env).notes, []);

  for (const ok of [true, false]) {                                 // 一直不好：VAD_LOAD_MAX_MS 后重启一次
    env = setup({ extra: { params: { ...P, VAD_LOAD_MAX_MS: 40000 } } });
    slow(env, ok);
    await live(env);
    await env.play(noise(39, -60, 3));
    assert.equal(env.vad.restarts, 0);
    await env.play(noise(4, -60, 4));
    assert.equal(env.vad.restarts, 1);
    assert.ok(evs(env, 'vad').some(e => e.d && e.d.stuck));
    assert.equal(env.engine.status().vad, ok ? 'on' : 'off');
    await env.play(noise(30, -60, 5));
    assert.equal(env.vad.restarts, 1, '只重启一次');
    await env.engine.end();
    s = sessionOf(env);
    assert.equal(s.notes.length, 1);
    assert.equal(s.notes[0].to, ok ? s.notes[0].to : s.endedAt);
    assert.ok(s.notes[0].to - s.notes[0].from >= 40000);
    assert.equal(s.vad, ok ? 'on' : 'off');
  }
});

test('只按音量时一直有像说话的声音（鼾声）：额度按听了多久慢慢放开，超了就收段（cut budget）、先只数次数（note budget held，有起止和次数），安静下来再存；不显示「存满了」', async () => {
  // 预算 60 秒，一开始只给 1/4（15 秒），每听 1 秒多给 0.1 秒；安静后新开的一段至少 20 秒
  const env = setup({ vad: { mode: 'fail' }, est: { usage: 0, quota: 32000 * 2 * 60 }, extra: { params: { ...P, ENERGY_BUDGET_RAMP_SEC: 600, ENERGY_FREE_SEC: 20 } } });
  const t0 = await live(env);
  const snore = concat(...Array.from({ length: 20 }, () => concat(tone(1, -35, 120), silence(3))));      // 80 秒：每 4 秒响 1 秒
  const sig = mix(mix(noise(150, -60, 3), snore, 5 * SR), speechy(2, -25), 120 * SR);
  await env.play(sig);
  assert.equal(env.engine.status().warn, null, '暂时只数次数，不是存满了');
  await env.engine.end();
  const cs = cands(env).filter(c => c.state === 'new'), s = sessionOf(env), [n] = s.notes.filter(x => x.kind === 'budget');
  assert.equal(cs[0].cut, 'budget');
  assert.ok(cs[0].durationSec >= 19 && cs[0].durationSec <= 21, `第一段 ${cs[0].durationSec} 秒`);
  assert.ok(n && n.held && n.n === 0, JSON.stringify(n));                      // 一直是同一阵鼾声：不算「又听到」
  assert.ok(n.from === cs[0].endAt && n.to > t0 + 85000 && n.to < t0 + 120000, '鼾声停了 20 秒以后解除');
  const talk = cs.at(-1);
  assert.ok(talk.startAt <= t0 + 120000 && talk.endAt >= t0 + 122000, '后来说的话存下了');
  assert.deepEqual(evs(env).map(e => e.k).filter(k => k.startsWith('hold')), ['hold', 'hold-off']);
});
