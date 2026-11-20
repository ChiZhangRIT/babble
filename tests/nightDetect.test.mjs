// 床头模式检测测试：能量门、迟滞、片段状态机、环形缓冲、WAV。全部合成信号 / 合成的逐帧判断，不用真录音
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, frameDb, createGate, createHyst, createClipper, createRing, toPcm16, wavHeader, wavBlob } from '../src/core/nightDetect.js';
import { noise, speechy, concat, mix, rng, at } from './helpers/signal.mjs';

const F = P.FRAME, S = (sec) => Math.round(sec * P.SR);
const near = (got, want, tol = F) => assert.ok(Math.abs(got - want) <= tol, `${got} ≈ ${want}（±${tol}）`);
const within = (t, ...spans) => spans.some(([a, b]) => t >= a && t < b);
/** 每 512 个样本一帧的能量 */
const dbs = (x) => { const out = []; for (let o = 0; o + F <= x.length; o += F) out.push(frameDb(x, o, F)); return out; };
const tOf = (i) => i * F / P.SR;
/** fromSec 到 toSec 每帧喂一次（帧从绝对 0 对齐）；isSpeech(t) 决定这帧算不算说话；f = 发出动作的那一帧 */
function run(cl, fromSec, toSec, isSpeech, extra = () => ({})) {
  const out = [];
  for (let a = Math.ceil(S(fromSec) / F) * F; a < S(toSec); a += F) {
    const t = a / P.SR, speech = !!isSpeech(t);
    for (const x of cl.frame({ at: a, speech, ...extra(t, speech) })) out.push({ ...x, f: a });
  }
  return out;
}
const types = (acts) => acts.map(a => a.type);

// ---------- frameDb ----------
test('frameDb：数字静音 −120，满幅方波 0 dB，只量指定的一段', () => {
  assert.equal(frameDb(new Float32Array(512)), -120);
  assert.ok(Math.abs(frameDb(new Float32Array(512).fill(1))) < 1e-9);
  const x = concat(new Float32Array(512), new Float32Array(512).fill(0.1));
  assert.equal(frameDb(x, 0, 512), -120);
  assert.ok(Math.abs(frameDb(x, 512, 512) - -20) < 1e-4);
  assert.equal(frameDb(new Float32Array(0)), -120);
  assert.equal(frameDb(Float32Array.of(NaN, 0)), -120);
});

// ---------- 能量门 ----------
test('能量门：一直 −65 dB 的底噪不开门，噪声底学到 −65', () => {
  const g = createGate(), out = dbs(noise(30, -65)).map(d => g.push(d));
  assert.ok(out.every(o => !o));
  assert.ok(Math.abs(g.floor() - -65) < 1.5, `噪声底 ${g.floor()}`);
  assert.equal(g.thr(), g.floor() + P.GATE_DB);
});

test('能量门：底噪上一段 −45 dB 的话开门，话完了 0.3 秒左右关上', () => {
  const x = mix(noise(20, -65), speechy(1.5, -45), at(10)), g = createGate(), out = dbs(x).map(d => g.push(d));
  const idx = (t) => Math.floor(t * P.SR / F);
  assert.ok(out.slice(0, idx(10)).every(o => !o), '话之前关着');
  assert.ok(out.slice(idx(10), idx(10.2)).some(o => o), '一开口就开门');
  const mid = out.slice(idx(10.2), idx(11.5));
  assert.ok(mid.filter(Boolean).length >= 0.9 * mid.length, '字和字之间的停顿撑得住');
  assert.ok(out.slice(idx(11.9)).every(o => !o), '话完了关上');
});

test('能量门：底噪从 −65 跳到 −50，8 秒内重新学会、关上门', () => {
  const g = createGate(), out = dbs(concat(noise(10, -65, 1), noise(20, -50, 2))).map(d => g.push(d));
  assert.ok(out.slice(0, 312).every(o => !o));
  assert.ok(out.slice(313, 330).some(o => o), '刚跳上去时当成有声');
  const after = out.filter((o, i) => tOf(i) >= 18);
  assert.ok(after.length > 300 && after.every(o => !o), '8 秒后又关上了');
  assert.ok(Math.abs(g.floor() - -50) < 1.5, `噪声底 ${g.floor()}`);
});

test('能量门不往后看：第 k 帧的结果只取决于前 k 帧', () => {
  const seq = (seed, n) => { const r = rng(seed); return Array.from({ length: n }, (_, i) => -65 + 3 * r() + ((i % 97) < 20 ? 25 : 0)); };
  const A = seq(1, 1200), g = createGate();
  const ref = A.map(d => [g.push(d), g.floor(), g.thr()]);
  for (const k of [40, 250, 333, 801]) {
    const B = [...A.slice(0, k + 1), ...seq(99 + k, 400).map(d => d + 20)], h = createGate();
    const got = B.map(d => [h.push(d), h.floor(), h.thr()]);
    assert.deepEqual(got.slice(0, k + 1), ref.slice(0, k + 1), `k = ${k}`);
  }
});

test('能量门：头 1 秒不开门；连续 2 帧才开；掉下去后撑 0.3 秒；reset 后重新学', () => {
  const warm = createGate(), w = [...Array(20).fill(-65), ...Array(40).fill(-40)].map(d => warm.push(d));
  const first = Math.ceil(P.GATE_WARM_SEC * P.SR / F) - 1;          // 第一个不在预热里的帧
  assert.equal(w.indexOf(true), first + P.GATE_ATTACK - 1, '1 秒后再连续 2 帧');

  const g = createGate(), quiet = () => g.push(-65);
  for (let i = 0; i < 64; i++) quiet();
  assert.equal(g.push(-40), false, '一帧不开');
  assert.equal(quiet(), false);
  assert.equal(g.push(-40), false);
  assert.equal(g.push(-40), true, '第二帧开');
  const hold = Math.round(P.GATE_HOLD_SEC * P.SR / F);
  for (let i = 1; i < hold; i++) assert.equal(quiet(), true, `掉下去后第 ${i} 帧还开着`);
  assert.equal(quiet(), false, `第 ${hold} 帧关上`);

  g.push(-40); assert.equal(g.push(-40), true);
  g.reset();
  for (let i = 0; i < 31; i++) assert.equal(g.push(-30), false, 'reset 后头 1 秒不开');
  assert.equal(g.floor(), -30, '噪声底从头学');
});

// ---------- 迟滞 ----------
test('迟滞：0.30 进、低于 0.15 出，中间保持；null 原样传、不改状态；reset', () => {
  const h = createHyst();
  assert.deepEqual([0.1, 0.29, 0.3, 0.2, 0.15, null, 0.16, 0.149, 0.2, 0.31].map(p => h.push(p)),
    [false, false, true, true, true, null, true, false, false, true]);
  h.reset();
  assert.equal(h.push(0.2), false);
});

// ---------- 片段状态机 ----------
test('片段：30 秒处说 2 秒 → 从 22 秒开始（前 8 秒），收在话完后 2 秒（quiet）', () => {
  const cl = createClipper(), acts = run(cl, 0, 60, t => within(t, [30, 32]));
  assert.deepEqual(types(acts), ['open', 'close']);
  const [o, c] = acts;
  near(o.from, S(22)); near(o.at, S(30));
  assert.equal(c.from, o.from);
  near(c.to, S(34)); assert.equal(c.cut, 'quiet');
  near(c.speechSec, 2, 0.05);
  near(c.f, S(52), 2 * F);                 // 20 秒没说话才收
  near(cl.savedSec, 12, 0.05);
  assert.equal(cl.mode, 'idle');
  assert.equal(cl.openInfo, null);
});

test('片段：停 15 秒还是同一段；停 25 秒分成两段，第二段不往前越过第一段', () => {
  let acts = run(createClipper(), 0, 80, t => within(t, [30, 32], [47, 49]));
  assert.deepEqual(types(acts), ['open', 'close']);
  near(acts[1].to, S(51)); near(acts[1].speechSec, 4, 0.1);

  acts = run(createClipper(), 0, 100, t => within(t, [30, 32], [57, 59]));
  assert.deepEqual(types(acts), ['open', 'close', 'open', 'close']);
  const [, c1, o2, c2] = acts;
  assert.ok(o2.from >= c1.to);
  near(o2.from, S(49)); assert.equal(c2.from, o2.from);
});

test('片段：0.2 秒咔哒一声 → drop；只按能量时要求 0.6 秒（收段时才问）', () => {
  let cl = createClipper(), acts = run(cl, 0, 60, t => within(t, [30, 30.2]));
  assert.deepEqual(types(acts), ['open', 'drop']);
  assert.ok(acts[1].speechSec < P.MIN_SPEECH_SEC);
  assert.equal(acts[1].cut, 'quiet');
  assert.equal(cl.savedSec, 0);

  acts = run(createClipper(), 0, 60, t => within(t, [30, 30.45]));
  assert.equal(acts[1].type, 'close', '0.45 秒：识别开着时留下');
  let ms = P.MIN_SPEECH_SEC;
  cl = createClipper({ minSpeech: () => ms });
  acts = run(cl, 0, 40, t => within(t, [30, 30.45]));
  ms = P.ENERGY_MIN_SPEECH_SEC;                                       // 识别中途挂了
  acts.push(...run(cl, 40, 60, () => false));
  assert.deepEqual(types(acts), ['open', 'drop']);
});

test('片段：收段时带上说话秒数、能量门秒数、最大能量和最大概率', () => {
  const acts = run(createClipper(), 0, 60, t => within(t, [30, 31], [33, 34]),
    (t, sp) => ({ db: sp ? (within(t, [33, 34]) ? -38 : -44) : -65, prob: sp ? 0.8 : 0.05, gate: within(t, [30, 31]) }));
  const c = acts.find(a => a.type === 'close');
  assert.equal(c.peakDb, -38);
  assert.equal(c.vadMax, 0.8);
  near(c.speechSec, 2, 0.07); near(c.gateSec, 1, 0.07);
});

test('片段：连着说 11 分钟 → 600 秒封顶，下一段无缝接上（不丢、不重复样本）', () => {
  const cl = createClipper(), acts = run(cl, 0, 700, t => t >= 10 && t < 670 && (t - 10) % 5 < 3);
  assert.deepEqual(types(acts), ['open', 'close', 'open', 'close']);
  const [o1, c1, o2, c2] = acts;
  assert.equal(c1.cut, 'max');
  assert.ok(c1.to - c1.from >= S(P.MAX_CLIP_SEC) && c1.to - c1.from < S(P.MAX_CLIP_SEC) + F, `${c1.to - c1.from}`);
  assert.equal(o2.from, c1.to, '从上一段结尾接着开');
  assert.equal(c2.from, c1.to);
  assert.equal(c2.cut, 'quiet');
  near(c2.to, S(670));
  assert.equal((c1.to - c1.from) + (c2.to - c2.from), c2.to - o1.from, '两段首尾相接');
  near(cl.savedSec, (c2.to - o1.from) / P.SR, 1e-6);
});

test('片段：90% 时间都像说话的 4 分钟 → 存前 3 分钟（noise），冷却到 20 秒安静，之后照常', () => {
  const cl = createClipper(), noisy = (t) => t >= 10 && t < 250 && t % 1 < 0.9;
  const acts = run(cl, 0, 260, noisy);
  assert.deepEqual(types(acts), ['open', 'close', 'noise']);
  const [, c, n] = acts;
  assert.equal(c.cut, 'noise');
  assert.ok(c.to - c.from >= S(P.NOISE_SEC) && c.to - c.from < S(P.NOISE_SEC) + F);
  assert.equal(n.at, c.to);
  assert.equal(cl.mode, 'cool');

  const rest = run(cl, 260, 360, t => within(t, [320, 322]));
  assert.deepEqual(types(rest), ['noiseEnd', 'open', 'close']);
  const [ne, o2, c2] = rest;
  near(ne.at, S(249.9)); near(ne.f, S(269.9), 2 * F);              // 最后一声之后 20 秒
  near(o2.from, S(312)); assert.equal(c2.cut, 'quiet');
});

test('片段：存满预算 → full，之后只数「又听到几次」；flush、restart 都不解除', () => {
  // 第一段 22–34 秒（12 秒）；第二段 52 秒开始，开着的长度也算：到 80 秒就满 40 秒了
  const cl = createClipper({ budgetSec: 40 });
  const acts = run(cl, 0, 120, t => within(t, [30, 32], [60, 64], [105, 106]));
  assert.deepEqual(types(acts), ['open', 'close', 'open', 'close', 'full']);
  const c2 = acts[3], full = acts[4];
  assert.equal(c2.cut, 'budget'); near(c2.speechSec, 4, 0.05); near(c2.to, S(80));
  assert.equal(full.why, 'budget'); assert.equal(full.at, c2.to);
  assert.ok(cl.savedSec >= 40 && cl.savedSec < 40.1, `${cl.savedSec}`);
  assert.equal(cl.mode, 'full'); assert.equal(cl.heard, 1);

  assert.deepEqual(cl.flush(S(120), 'gap'), []);
  cl.restart(S(130));
  assert.deepEqual(run(cl, 130, 200, t => within(t, [140, 141], [150, 151], [190, 191])), []);
  assert.equal(cl.mode, 'full');
  assert.equal(cl.heard, 3, '隔 20 秒以上才算新的一次');
  assert.deepEqual(cl.flush(S(200), 'end'), []);

  const zero = createClipper({ budgetSec: 0 }), z = run(zero, 0, 40, t => within(t, [30, 31]));
  assert.deepEqual(z.map(a => [a.type, a.why]), [['full', 'budget']]);
  assert.equal(zero.heard, 1);
});

test('片段：只按音量时打鼾（每 4 秒响 1 秒）65 分钟，70 分钟时说话 → 照样存下（额度按听了多久放开，鼾声用不完一晚的）；识别开着时照旧', () => {
  const snore = (t) => t >= 60 && t < 3900 && t % 4 < 1, talk = (t) => within(t, [4200, 4202]), sound = (t) => snore(t) || talk(t);
  const cl = createClipper({ energyOnly: () => true, minSpeech: () => P.ENERGY_MIN_SPEECH_SEC }), acts = run(cl, 0, 4300, sound);
  const closes = acts.filter(a => a.type === 'close'), hold = acts.find(a => a.type === 'hold'), off = acts.find(a => a.type === 'holdEnd');
  assert.ok(closes.some(c => c.from <= S(4200) && c.to >= S(4202)), '70 分钟时说的话存下了');
  assert.ok(!types(acts).includes('full'));
  assert.deepEqual(types(acts).filter(x => x.startsWith('hold')), ['hold', 'holdEnd']);
  assert.equal(closes.find(c => c.to === hold.at || c.cut === 'budget').cut, 'budget');
  const snoreSec = closes.filter(c => c.to <= S(3900)).reduce((n, c) => n + (c.to - c.from) / P.SR, 0);
  near(snoreSec, P.NIGHT_BUDGET_SEC * (P.ENERGY_BUDGET_SHARE + hold.at / P.SR / P.ENERGY_BUDGET_RAMP_SEC), 1);    // 用到当时的额度（约 17 分钟）为止
  near(off.at, S(3897 + 20), 2 * F);                                // 最后一声（3896–3897 秒）之后安静 20 秒才解除

  const vad = run(createClipper(), 0, 4300, sound);                 // 识别开着（鼾声本来就不算说话；这里硬当成说话）：还是整个预算
  assert.ok(types(vad).includes('full') && !types(vad).includes('hold'));

  let eo = true;
  const back = createClipper({ energyOnly: () => eo });
  run(back, 0, 1200, snore);
  assert.equal(back.mode, 'hold');
  eo = false;                                                       // 识别回来了：马上照常存
  assert.deepEqual(types(run(back, 1200, 1300, snore)).slice(0, 2), ['holdEnd', 'open']);

  const st = createClipper({ energyOnly: () => true });
  run(st, 0, 1200, snore);
  assert.deepEqual(st.stopSaving(S(1200), 'storage').map(a => a.type), ['holdEnd', 'full']);
});

test('片段：只按音量的额度只算只按音量时存下的：识别开着时存了很多、半夜识别挂了，后面说话照样存（不先只数次数）；整晚的总预算照样算全部', () => {
  let eo = false;
  const cl = createClipper({ budgetSec: 600, energyOnly: () => eo });
  const talks = Array.from({ length: 12 }, (_, i) => 300 + i * 590);                 // 2 小时里说 12 次、每次 30 秒
  run(cl, 0, 7200, t => talks.some(a => t >= a && t < a + 30));
  assert.ok(cl.savedSec > 440 && cl.savedSec < 600, String(cl.savedSec));
  eo = true;                                                        // 识别挂了：这时的额度约 306 秒，比识别开着时存的少
  const acts = run(cl, 7200, 7600, t => within(t, [7490, 7495]));
  assert.deepEqual(types(acts), ['open', 'close']);
  assert.equal(acts[1].cut, 'quiet');
  const more = run(cl, 7600, 8100, t => within(t, [7800, 7950]));    // 再说很久：到总预算就存满
  assert.deepEqual(types(more), ['open', 'close', 'full']);
  assert.equal(more[1].cut, 'budget');
  near(cl.savedSec * P.SR, 600 * P.SR);
});

test('片段：stopSaving 收掉开着的段（storage）再 full；重复调用不再出动作', () => {
  const cl = createClipper();
  run(cl, 0, 33, t => within(t, [30, 32]));
  assert.equal(cl.mode, 'open');
  const info = cl.openInfo;
  near(info.from, S(22)); near(info.last, S(32)); near(info.sp, 2, 0.05);
  const acts = cl.stopSaving(S(33), 'storage');
  assert.deepEqual(acts.map(a => [a.type, a.cut ?? a.why]), [['close', 'storage'], ['full', 'storage']]);
  assert.equal(acts[0].to, S(33)); assert.equal(acts[1].at, S(33));
  assert.deepEqual(cl.stopSaving(S(34), 'storage'), []);
  assert.deepEqual(run(cl, 34, 80, t => within(t, [60, 62])), []);
  assert.equal(cl.heard, 1);

  const idle = createClipper();
  assert.deepEqual(idle.stopSaving(S(5), 'storage'), [{ type: 'full', at: S(5), why: 'storage' }]);
});

test('片段：flush 收在 min(最后一句 + 2 秒, at)；冷却中 flush → noiseEnd；空闲时什么都没有', () => {
  let cl = createClipper();
  run(cl, 0, 33, t => within(t, [30, 32]));
  let a = cl.flush(S(33), 'gap');
  assert.deepEqual(a.map(x => [x.type, x.cut]), [['close', 'gap']]);
  assert.equal(a[0].to, S(33));
  assert.equal(cl.mode, 'idle');
  assert.deepEqual(cl.flush(S(34), 'gap'), []);

  cl = createClipper();
  run(cl, 0, 40, t => within(t, [30, 32]));
  a = cl.flush(S(40), 'end');
  assert.equal(a[0].to, S(34)); assert.equal(a[0].cut, 'end');

  cl = createClipper();
  run(cl, 0, 200, t => t >= 10 && t % 1 < 0.9);
  assert.equal(cl.mode, 'cool');
  assert.deepEqual(cl.flush(S(200), 'gap'), [{ type: 'noiseEnd', at: S(200) }]);
  assert.equal(cl.mode, 'idle');
});

test('片段：restart 之后往前带的 8 秒不越过中断', () => {
  const plain = run(createClipper(), 0, 130, t => within(t, [100, 101]));
  near(plain[0].from, S(92));
  const cl = createClipper();
  cl.restart(S(97));
  const acts = run(cl, 97, 130, t => within(t, [100, 101]));
  assert.equal(acts[0].type, 'open');
  assert.equal(acts[0].from, S(97));
});

// ---------- 环形缓冲 ----------
test('环形缓冲：绕圈写、按绝对下标读拷贝，超出范围的截掉', () => {
  const r = createRing(1, 1000), v = (a, b) => Float32Array.from({ length: b - a }, (_, i) => ((a + i) % 2000) / 32767);
  const want = (a, b) => Int16Array.from({ length: b - a }, (_, i) => (a + i) % 2000);
  r.push(v(0, 700));
  assert.equal(r.total, 700); assert.equal(r.start, 0);
  assert.deepEqual(r.read(0, 700), want(0, 700));
  r.push(v(700, 1400));
  assert.equal(r.total, 1400); assert.equal(r.start, 400);
  assert.deepEqual(r.read(0, 5000), want(400, 1400), '两头都截掉');
  assert.deepEqual(r.read(900, 1100), want(900, 1100), '跨过环的接缝');
  const copy = r.read(1000, 1010); copy.fill(0);
  assert.deepEqual(r.read(1000, 1010), want(1000, 1010), '读出来的是拷贝');
  assert.equal(r.read(1500, 1600).length, 0);
  assert.equal(r.read(1200, 1100).length, 0);
  r.push(v(1400, 3900));                                              // 比整个环还长
  assert.equal(r.total, 3900); assert.equal(r.start, 2900);
  assert.deepEqual(r.read(0, 3900), want(2900, 3900));
  assert.equal(createRing().read(0, 1).length, 0);
});

test('toPcm16：削顶、NaN → 0、四舍五入', () => {
  assert.deepEqual(toPcm16(Float32Array.of(0, 1, -1, 0.5, 2, -2, NaN, -0.5)), Int16Array.of(0, 32767, -32768, 16384, 32767, -32768, 0, -16384));
});

// ---------- WAV ----------
test('WAV 头：RIFF / fmt / data 各字段', () => {
  const h = wavHeader(10, 16000), v = new DataView(h.buffer), str = (a, n) => String.fromCharCode(...h.subarray(a, a + n));
  assert.equal(h.length, 44);
  assert.equal(str(0, 4), 'RIFF'); assert.equal(v.getUint32(4, true), 36 + 20); assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt '); assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, 'PCM'); assert.equal(v.getUint16(22, true), 1, '单声道');
  assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(32, true), 2); assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36, 4), 'data'); assert.equal(v.getUint32(40, true), 20);
  assert.equal(new DataView(wavHeader(3, 8000).buffer).getUint32(24, true), 8000);
});

test('wavBlob：分片拼起来，长度取 min(samples, 分片里有的)', async () => {
  const parts = [Int16Array.of(1, 2, 3).buffer, Int16Array.of(4, 5, 6).buffer];
  const read = async (b) => { const ab = await b.arrayBuffer(); return { n: new DataView(ab).getUint32(40, true) / 2, pcm: Array.from(new Int16Array(ab, 44)) }; };
  let b = wavBlob(parts, 5);
  assert.equal(b.type, 'audio/wav'); assert.equal(b.size, 44 + 10);
  assert.deepEqual(await read(b), { n: 5, pcm: [1, 2, 3, 4, 5] });
  assert.deepEqual(await read(wavBlob(parts, 2)), { n: 2, pcm: [1, 2] });
  assert.deepEqual(await read(wavBlob(parts, 100)), { n: 6, pcm: [1, 2, 3, 4, 5, 6] }, '分片不够：按分片');
  assert.deepEqual(await read(wavBlob(parts, null)), { n: 6, pcm: [1, 2, 3, 4, 5, 6] });
  assert.equal(wavBlob([], 0).size, 44);
  const r = createRing(1, 100); r.push(Float32Array.of(0.25, -0.25));
  assert.deepEqual(await read(wavBlob([r.read(0, 2).buffer], 2)), { n: 2, pcm: [8192, -8192] });
});
