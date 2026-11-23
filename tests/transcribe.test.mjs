// 语音转文字（core/transcribe.js）：模型表、选后端、按说话分段、用说话识别找说话的地方（假的说话识别 + vendor 里的真模型）、
// 整理识别结果、合进草稿、填进原话，以及在假 worker 上跑的任务流程（下载进度、识别、取消、显卡出错换处理器、内存不够）和模型缓存的大小 / 删除。
// 全是合成的信号和编出来的句子（仓库是公开的，不放真的梦话和录音）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as T from '../src/core/transcribe.js';
import { createVad } from '../src/core/vad.js';
import { T2S, toSimplified } from '../src/core/hanzi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 16000;
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const SP = { nn: { name: 'NN', emoji: NN, aliases: [] }, me: { name: '', emoji: ME, aliases: [] } };

// ---------- 合成信号：均匀噪声底 + 正弦「说话」 ----------
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
/** parts: [[起秒, 止秒, dBFS, 频率]]；noiseDb = null → 数字静音 */
function signal(sec, parts = [], { noiseDb = -60, seed = 7 } = {}) {
  const n = Math.round(sec * SR), x = new Float32Array(n), rnd = lcg(seed);
  const na = noiseDb == null ? 0 : Math.pow(10, noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) x[i] = na * rnd();
  for (const [a, b, db = -20, f = 220] of parts) {
    const amp = Math.pow(10, db / 20) * Math.SQRT2;
    for (let i = Math.round(a * SR); i < Math.min(n, Math.round(b * SR)); i++) x[i] += amp * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return x;
}
const secs = segs => segs.map(([a, b]) => [+(a / SR).toFixed(2), +(b / SR).toFixed(2)]);
const near = (got, want, tol = 0.06) => {
  assert.equal(got.length, want.length, JSON.stringify(got));
  got.forEach(([a, b], i) => { assert.ok(Math.abs(a - want[i][0]) <= tol && Math.abs(b - want[i][1]) <= tol, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); });
};

test('模型表：固定版本，按后端选文件；缓存地址带版本号', () => {
  assert.deepEqual(T.MODEL_KEYS, ['base', 'small']);
  assert.equal(T.DEFAULT_MODEL, 'base');
  assert.match(T.MODELS.base.revision, /^[0-9a-f]{40}$/);
  assert.match(T.MODELS.small.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(T.modelFiles('base', 'wasm').filter(f => f.endsWith('.onnx')), ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
  assert.deepEqual(T.modelFiles('base', 'webgpu').filter(f => f.endsWith('.onnx')), ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx']);
  assert.deepEqual(T.modelFiles('small', 'webgpu').filter(f => f.endsWith('.onnx')), ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx']);
  for (const k of T.MODEL_KEYS) for (const e of T.ENGINES) assert.ok(T.modelFiles(k, e).includes('tokenizer.json'));
  assert.equal(T.modelPrefix('base'), `https://huggingface.co/onnx-community/whisper-base/resolve/${T.MODELS.base.revision}/`);
  assert.ok(T.modelPrefix('base').startsWith(T.repoPrefix('base')));
  assert.ok(T.MODELS.base.wasm.bytes < T.MODELS.small.wasm.bytes);
});

test('设备：iPhone / iPad 只用处理器、只给标准；Mac 有 WebGPU 用显卡（更准还要 shader-f16）', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
  const ipadDesktop = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 };
  assert.equal(T.isMobileDevice(iphone), true);
  assert.equal(T.isMobileDevice(ipadDesktop), true);
  assert.equal(T.isMobileDevice(mac), false);
  assert.equal(T.isMobileDevice(null), false);
  assert.equal(T.modelAllowed('small', { mobile: true }), false);
  assert.equal(T.modelAllowed('base', { mobile: true }), true);
  assert.equal(T.modelAllowed('small', { mobile: false }), true);
  assert.equal(T.modelAllowed('huge', {}), false);
  assert.equal(T.pickEngine('base', { mobile: true, gpu: true, f16: true }), 'wasm');
  assert.equal(T.pickEngine('base', { gpu: true }), 'webgpu');
  assert.equal(T.pickEngine('base', { gpu: true, useGpu: false }), 'wasm');
  assert.equal(T.pickEngine('base', { gpu: false }), 'wasm');
  assert.equal(T.pickEngine('small', { gpu: true, f16: false }), 'wasm');
  assert.equal(T.pickEngine('small', { gpu: true, f16: true }), 'webgpu');
});

test('分段：两句之间停很久 → 两段，前后各留 0.25 秒', () => {
  near(secs(T.speechSegments(signal(16, [[2, 4], [10, 12]]))), [[1.75, 4.25], [9.75, 12.25]]);
});

test('分段：停顿短（≤ 1.5 秒）的并成一段；咔哒声（< 0.25 秒）丢掉', () => {
  near(secs(T.speechSegments(signal(12, [[2, 4], [5, 7], [10, 10.1, -10]]))), [[1.75, 7.25]]);
});

test('分段：静音、只有均匀的小杂音 → 不识别；数字静音里的小声说话也找得到', () => {
  assert.deepEqual(T.speechSegments(new Float32Array(SR * 5)), []);
  assert.deepEqual(T.speechSegments(signal(20, [], { noiseDb: -56 })), []);
  assert.deepEqual(T.speechSegments(new Float32Array(100)), []);
  near(secs(T.speechSegments(signal(10, [[3, 5, -50]], { noiseDb: null }))), [[2.75, 5.25]]);
});

test('分段：长录音里只说了几句（不到整段的 5%）也找得到；只有一下咔哒声还是不识别', () => {
  near(secs(T.speechSegments(signal(600, [[100, 120]]))), [[99.75, 120.25]]);
  near(secs(T.speechSegments(signal(600, [[100, 103], [400, 401.5, -45]]))), [[99.75, 103.25], [399.75, 401.75]]);
  near(secs(T.speechSegments(signal(600, [[200, 215, -50], [400, 400.4, -12]]))), [[199.75, 215.25], [399.75, 400.65]]);   // 一声关门不会把小声的话挤掉
  assert.deepEqual(T.speechSegments(signal(600, [[300, 300.2, -10]])), []);
  // 风扇 / 白噪声机（-28 dBFS，很平）里说了几句：只识别说话那段，不再整段送去
  near(secs(T.speechSegments(signal(120, [[50, 52, -10]], { noiseDb: -28 }))), [[49.75, 52.25]]);
});

/** 鼾声 / 呼吸似的：每 every 秒一下、每下 dur 秒的噪声，比底噪响 relDb（每下 ±jit dB） */
function bursts(sec, { every = 4, dur = 1, relDb = 6, jit = 2, noiseDb = -60, seed = 9 } = {}) {
  const x = signal(sec, [], { noiseDb, seed }), r = lcg(seed + 1), r2 = lcg(seed + 2), D = Math.round(dur * SR), ramp = Math.round(0.1 * SR);
  for (let t = 1; t + dur < sec; t += every) {
    const g = Math.pow(10, (noiseDb + relDb + jit * r()) / 20) * Math.sqrt(3), s = Math.round(t * SR);
    for (let i = 0; i < D; i++) x[s + i] += g * Math.min(1, i / ramp, (D - i) / ramp) * r2();
  }
  return x;
}

test('分段：长录音里只有鼾声、呼吸、慢慢起伏的底噪 → 还是不识别', () => {
  assert.deepEqual(T.speechSegments(bursts(600, { relDb: 5 })), []);
  assert.deepEqual(T.speechSegments(bursts(600, { relDb: 6 })), []);
  assert.deepEqual(T.speechSegments(bursts(600, { every: 4.5, dur: 1.6, relDb: 5, noiseDb: -55 })), []);
  // 自动增益让底噪慢慢起伏（约 ±2.5 dB，1 秒左右变一次）
  const x = signal(600, []), r = lcg(11);
  let g = 0;
  for (let i = 0; i < x.length; i += 160) {
    g = 0.99 * g + 0.6 * r();
    const k = Math.pow(10, g / 20);
    for (let j = i; j < Math.min(x.length, i + 160); j++) x[j] *= k;
  }
  assert.deepEqual(T.speechSegments(x), []);
});
test('分段：一直在说（60 秒）→ 切成 ≤ 28 秒的几段，首尾相接、一点不漏', () => {
  const x = signal(60, [[0, 60, -18]]);
  const segs = T.speechSegments(x);
  assert.ok(segs.length >= 3, JSON.stringify(secs(segs)));
  assert.equal(segs[0][0], 0);
  assert.equal(segs[segs.length - 1][1], x.length);
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i][1] - segs[i][0] <= 28 * SR);
    if (i) assert.equal(segs[i][0], segs[i - 1][1]);
  }
});

test('分段：很长的一句在 20–28 秒之间最安静的地方切开', () => {
  // 0–40 秒一直说，24 秒处小声一点
  const x = signal(40, [[0, 23.9, -18], [23.9, 24.2, -40], [24.2, 40, -18]]);
  const segs = secs(T.speechSegments(x));
  assert.ok(segs[0][1] > 23.8 && segs[0][1] < 24.3, JSON.stringify(segs));
});

// ---------- 用说话识别找说话的地方（假的说话识别：1 kHz 的正弦算「说话」，别的都不算） ----------
const mix = (...xs) => { const o = new Float32Array(xs[0].length); for (const x of xs) for (let i = 0; i < o.length; i++) o[i] += x[i] || 0; return o; };
/** 1 kHz 的「说话」：parts [[起秒, 止秒, dBFS]] */
const say = (sec, parts, o) => signal(sec, parts.map(([a, b, db = -30]) => [a, b, db, 1000]), o);
const peakOf = (x, a = 0, b = x.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i])); return m; };
/** 低频轰轰声（风扇、空调、车声）：一阶低通的噪声 + 一点白噪声，每帧能量差十几 dB */
function rumble(sec, db, seed = 5) {
  const n = Math.round(sec * SR), x = new Float32Array(n), r = lcg(seed);
  let b = 0, e = 0;
  for (let i = 0; i < n; i++) { const w = r(); b = 0.995 * b + 0.1 * w; x[i] = b + 0.05 * w; e += x[i] * x[i]; }
  const k = Math.pow(10, db / 20) / Math.sqrt(e / n);
  return x.map(v => v * k);
}
/** 这一帧（512 个样本）里 1 kHz 占了多少能量（Goertzel） */
function toneShare(x, off, f = 1000) {
  const N = 512, cw = 2 * Math.cos((2 * Math.PI * f) / SR);
  let s1 = 0, s2 = 0, e = 0;
  for (let i = 0; i < N; i++) { const v = x[off + i], s0 = v + cw * s1 - s2; s2 = s1; s1 = s0; e += v * v; }
  return e > 0 ? ((s1 * s1 + s2 * s2 - cw * s1 * s2) * 2) / (N * N) / (e / N) : 0;
}
/**
 * 假的说话识别（和 createVad() 一样的接口）：一帧里 1 kHz 占一成以上能量 → 0.9，不然 0.02。
 * log 按顺序记下 load / reset / push / close（events 给了也往里记一份 'vad.xxx'），pushed 记下每块的长度和峰值。
 * load：true / false / 函数；push：替换掉算概率的办法；delay：每块晚几毫秒回；hang：一直不回，close 时给 null（和 createVad 一样）
 */
function fakeVad({ load = true, push = null, delay = 0, hang = false, events = null } = {}) {
  const v = { log: [], pushed: [], pending: [], closed: false, state: 'idle' };
  const note = (s) => { v.log.push(s); if (events) events.push('vad.' + s); };
  v.load = () => { note('load'); if (typeof load === 'function') return load(v); v.state = load ? 'ready' : 'off'; return Promise.resolve(load); };
  v.push = (x) => {
    note('push');
    v.pushed.push({ n: x.length, peak: peakOf(x) });
    if (v.closed) return Promise.resolve(null);
    if (hang) return new Promise(r => v.pending.push(r));
    if (push) return push(x, v);
    const out = Float32Array.from({ length: x.length / 512 }, (_, i) => (toneShare(x, i * 512) > 0.1 ? 0.9 : 0.02));
    return delay ? new Promise(r => setTimeout(() => r(out), delay)) : Promise.resolve(out);
  };
  v.reset = () => note('reset');
  v.close = () => { note('close'); v.closed = true; v.state = 'off'; for (const r of v.pending.splice(0)) r(null); };
  return v;
}
const ops = (v) => v.log.map(s => s[0]).join('');             // 'lrpprc'：load、reset、push、push、reset、close

test('找说话的地方：说话识别说是说话的地方，照 speechSegments 的规矩合成窗口（前后各留 0.25 秒、停顿 ≤ 1.5 秒并起来）', async () => {
  const x = say(40, [[5, 7], [8, 9.2], [25, 26]], { noiseDb: -65 });
  const v = fakeVad(), r = await T.findSpeech(x, { vad: v });
  assert.equal(r.finder, 'vad');
  assert.equal(r.error, null);
  near(secs(r.segs), [[4.75, 9.45], [24.75, 26.25]]);
  near(secs(r.segs), secs(T.speechSegments(x)), 0.06);           // 这么清楚的声音，两种找法一样
  assert.deepEqual(v.log.filter(s => s !== 'push'), ['load', 'reset', 'reset', 'close'], '载入一次；两处有动静，各自从头开始；最后关掉');
  assert.ok(v.pushed.every(p => p.n % 512 === 0 && p.n <= T.FIND.CHUNK), '每块是 512 的整数倍、最多 1 秒');
  assert.equal(r.ran, v.pushed.reduce((s, p) => s + p.n, 0));
  assert.ok(r.ran > 6 * SR && r.ran < 9 * SR, `只跑了有动静的地方（${r.ran / SR} 秒）`);
  assert.equal(r.probs.length, Math.floor(x.length / 512));
  assert.equal(r.probs[Math.round((15 * SR) / 512)], 0, '跳过的地方当没在说');
  assert.equal(r.probs[Math.round((6 * SR) / 512)], Math.fround(0.9));
});

test('找说话的地方：先按能量跳过明显的静音——10 分钟里只说了一句只跑那附近；数字静音、平稳的底噪、低频轰轰声一点都不跑（也不载入）', async () => {
  const one = fakeVad(), r = await T.findSpeech(say(600, [[300, 302, -40]]), { vad: one });
  near(secs(r.segs), [[299.75, 302.25]]);
  assert.ok(r.ran <= 4 * SR, `跑了 ${r.ran / SR} 秒`);
  const loud = rumble(120, -45), db = T.frameDbs(loud), sorted = Float32Array.from(db).sort();
  assert.ok(sorted[sorted.length - 1] - sorted[Math.floor(db.length * 0.1)] > 10, '轰轰声每帧能量差十几 dB（只看能量会当成有动静）');
  for (const [name, x] of [['数字静音', new Float32Array(SR * 30)], ['平稳的底噪', signal(120, [], { noiseDb: -50 })], ['低频轰轰声', loud]]) {
    const v = fakeVad(), q = await T.findSpeech(x, { vad: v });
    assert.deepEqual(q.segs, [], name);
    assert.equal(q.finder, 'vad', name);
    assert.equal(q.ran, 0, name);
    assert.deepEqual(v.log, ['close'], `${name}：没有要听的就不载入`);
  }
});

test('找说话的地方：白噪声机（−45 dBFS）里更小声（−50）的说话：整体能量看不出来（只按能量找不到），它那个频带里看得出来，交给说话识别', async () => {
  const x = say(60, [[20, 23, -50]], { noiseDb: -45 });
  assert.deepEqual(T.speechSegments(x), []);
  const v = fakeVad(), r = await T.findSpeech(x, { vad: v });
  near(secs(r.segs), [[19.75, 23.25]]);
  assert.ok(r.ran < 6 * SR, `只跑了说话附近（${r.ran / SR} 秒）`);
  // 几个频带的能量：1 kHz 在 700–1800 Hz 那个频带里
  const [lo, mid, hi] = T.bandDbs(x).map(b => b[Math.round((21 * SR) / 512)] - b[Math.round((10 * SR) / 512)]);
  assert.ok(mid > 3 && mid > lo + 1 && hi < 1, JSON.stringify({ lo, mid, hi }));
  const all = T.frameDbs(x);
  assert.ok(all[Math.round((21 * SR) / 512)] - all[Math.round((10 * SR) / 512)] < 1.5, '整体能量只多了一点点');
});

test('找说话的地方：鼾声（一阵阵比底噪响 8 dB 的杂音）只按能量会每一下都送去识别；说话识别不认 → 不送，中间说的那句照样找到', async () => {
  const snore = bursts(120, { relDb: 8, every: 4, dur: 1.2 });
  assert.ok(T.speechSegments(snore).length >= 20, '只按能量：鼾声都送去识别');
  const v = fakeVad(), r = await T.findSpeech(snore, { vad: v });
  assert.deepEqual(r.segs, []);
  assert.ok(r.ran > 0, '鼾声过了能量那一关，是说话识别说不像说话');
  near(secs((await T.findSpeech(mix(snore, say(120, [[50, 53, -40]], { noiseDb: null })), { vad: fakeVad() })).segs), [[49.75, 53.25]]);
});

test('找说话的地方：只放大给说话识别的那份（噪声底拉到 −40 dBFS，最多 +30 dB，峰值不超过 −1 dBFS），交给 Whisper 的声音不动', async () => {
  assert.equal(T.vadGainDb(-70, 0.01), 30);
  assert.equal(T.vadGainDb(-120, 0), 30, '数字静音：最多 +30 dB');
  assert.equal(T.vadGainDb(-55, 0.01), 15);
  assert.equal(T.vadGainDb(-35, 0.01), 0, '噪声底已经比 −40 dBFS 响：不放大');
  assert.ok(Math.abs(T.vadGainDb(-70, 0.5) - (-1 - 20 * Math.log10(0.5))) < 1e-9, '峰值顶到 −1 dBFS 为止');
  assert.equal(T.vadGainDb(-70, 1), 0);
  const x = say(20, [[5, 8, -50]], { noiseDb: -70 }), copy = x.slice(), v = fakeVad();
  const r = await T.findSpeech(x, { vad: v });
  assert.deepEqual(x, copy, '原来的声音一个样本都没改');
  near(secs(r.segs), [[4.75, 8.25]]);
  const boost = 20 * Math.log10(Math.max(...v.pushed.map(p => p.peak)) / peakOf(x, 5 * SR, 8 * SR));
  assert.ok(Math.abs(boost - 30) < 0.5, `放大了 ${boost} dB`);
  const loud = fakeVad();
  await T.findSpeech(say(20, [[5, 8, -6]], { noiseDb: -70 }), { vad: loud });
  const top = Math.max(...loud.pushed.map(p => p.peak));
  assert.ok(top <= Math.pow(10, -1 / 20) + 1e-6 && top > 0.85, `大声的只放大到 −1 dBFS（${top}）`);
});

test('说话识别的概率 → 说话的地方：≥ 0.30 进、< 0.15 出；停顿 ≤ 0.3 秒连成一句；隔得近（会进同一个窗口）的几句在说的加起来不到 0.25 秒（8 帧）才丢掉', () => {
  const P = (...parts) => Float32Array.from(parts.flatMap(([p, k]) => Array(k).fill(p)));
  assert.deepEqual(T.speechRuns(P([0, 5], [0.29, 20], [0, 5])), [], '没到 0.30 不算');
  assert.deepEqual(T.speechRuns(P([0, 5], [0.3, 1], [0.16, 9], [0.1, 5])), [[5, 15]], '进了以后 ≥ 0.15 一直算');
  assert.deepEqual(T.speechRuns(P([0.9, 7], [0, 5])), [], '7 帧（0.22 秒）太短');
  assert.deepEqual(T.speechRuns(P([0.9, 8], [0, 5])), [[0, 8]]);
  assert.deepEqual(T.speechRuns(P([0.9, 4], [0, 9], [0.9, 4])), [[0, 17]], '停 9 帧（0.29 秒）连成一句，凑够 8 帧');
  assert.deepEqual(T.speechRuns(P([0.9, 4], [0, 10], [0.9, 4])), [[0, 4], [14, 18]], '停 10 帧就是两句；各自太短，但隔得近，合起来凑够 8 帧 → 都留下');
  assert.deepEqual(T.speechRuns(P([0.9, 3], [0, 10], [0.9, 4])), [], '合起来 7 帧：还是太短');
  // 小声嘀咕的一串短音节（每个 3 帧，p 只有 0.3–0.5，隔 0.5 秒）：一个个看都太短，连在一起留下
  const murmur = P([0, 20], [0.4, 3], [0.05, 16], [0.35, 3], [0.1, 16], [0.5, 3], [0, 20]);
  assert.deepEqual(T.speechRuns(murmur), [[20, 23], [39, 42], [58, 61]]);
  // 隔得远（停顿加前后各 0.25 秒的余量超过 1.5 秒，进不了同一个窗口）：各算各的，都丢掉；正好 62 帧还算近
  assert.deepEqual(T.speechRuns(P([0.9, 4], [0, 63], [0.9, 4])), []);
  assert.deepEqual(T.speechRuns(P([0.9, 4], [0, 62], [0.9, 4])), [[0, 4], [66, 70]]);
  // 够长的一句旁边隔得近的一两帧跟着留下（反正在同一个窗口里）
  assert.deepEqual(T.speechRuns(P([0.9, 8], [0, 30], [0.9, 1], [0, 5])), [[0, 8], [38, 39]]);
  assert.deepEqual(T.speechRuns(P([0.9, 10], [NaN, 3], [0.9, 10])), [[0, 23]], 'NaN 当没在说');
  assert.deepEqual(T.speechRuns(P([0.9, 10], [0.2, 40])), [[0, 50]], '一直 ≥ 0.15 就一直算（迟滞）');
});

test('找说话的地方：小声嘀咕的一串短音节（每个 0.15 秒、识别只给 0.4，隔 0.5 秒）：一个个都太短，连在一起送去识别；单独的一个、隔得远的几个照样不送', async () => {
  const soft = (x) => Float32Array.from({ length: x.length / 512 }, (_, i) => (toneShare(x, i * 512) > 0.1 ? 0.4 : 0.02));
  const x = say(12, [[3, 3.15, -40], [3.65, 3.8, -40], [4.3, 4.45, -40]], { noiseDb: -63 });
  const r = await T.findSpeech(x, { vad: fakeVad({ push: async (pcm) => soft(pcm) }) });
  assert.equal(r.finder, 'vad');
  near(secs(r.segs), [[2.75, 4.7]], 0.1);
  const runs = T.speechRuns(r.probs);
  assert.equal(runs.length, 3);
  assert.ok(runs.every(([a, b]) => b - a < 8), '每个都不到 8 帧：以前一个个看全丢了');
  for (const parts of [[[3, 3.15, -40]], [[3, 3.15, -40], [6, 6.15, -40], [9, 9.15, -40]]]) {
    const q = await T.findSpeech(say(12, parts, { noiseDb: -63 }), { vad: fakeVad({ push: async (pcm) => soft(pcm) }) });
    assert.deepEqual(q.segs, [], JSON.stringify(parts));
  }
});

test('找说话的地方：长录音先按能量挑时每算 1 分钟让出一次主线程（页面不卡）、能取消；分几次算出来的和一次算完一样', async () => {
  const x = say(600, [[100, 102, -40], [430, 433, -45]], { noiseDb: -60 });
  let ticks = 0, at = null, stop = false;
  const tick = () => { if (!stop) { ticks++; setImmediate(tick); } };
  setImmediate(tick);
  const v = fakeVad({ load: (vv) => { at = ticks; vv.state = 'ready'; return Promise.resolve(true); } });
  const r = await T.findSpeech(x, { vad: v });
  stop = true;
  near(secs(r.segs), [[99.75, 102.25], [429.75, 433.25]]);
  assert.ok(at >= 10, `载入之前让出了 ${at} 次`);
  // 一样：每 7 秒让一次 / 一次算完
  const a = fakeVad(), b = fakeVad();
  const ra = await T.findSpeech(x, { vad: a, PRE_SLICE_SEC: 7 }), rb = await T.findSpeech(x, { vad: b, PRE_SLICE_SEC: 1e9 });
  assert.deepEqual(ra.segs, rb.segs);
  assert.deepEqual(ra.probs, rb.probs);
  assert.deepEqual(a.pushed, b.pushed, '交给识别的地方一样');
  assert.deepEqual(rb.segs, r.segs);
  // 取消：挑到一半就停（不载入），也关掉
  let n = 0;
  const c = fakeVad();
  await assert.rejects(T.findSpeech(x, { vad: c, check: () => { if (++n === 3) throw new T.SttError('cancel'); } }), e => e.code === 'cancel');
  assert.deepEqual(c.log, ['close']);
  // 1 分钟以内的不让（短录音不多等）：check 的次数和从来不让的一样
  const calls = async (o) => { let m = 0; await T.findSpeech(say(60, [[20, 22]]), { vad: fakeVad(), check: () => { m++; }, ...o }); return m; };
  assert.equal(await calls({}), await calls({ PRE_SLICE_SEC: 1e9 }));
  assert.ok(await calls({ PRE_SLICE_SEC: 10 }) > await calls({}));
});

test('找说话的地方：每处有动静的地方从头开始；一整块（1 秒）都不像说话、说完 2 秒以后也清一次状态', async () => {
  // 一直有动静（−28 dBFS 的底噪）：只有一处；2–4 秒说话
  const x = say(12, [[2, 4, -10]], { noiseDb: -28 });
  const v = fakeVad(), r = await T.findSpeech(x, { vad: v });
  near(secs(r.segs), [[1.75, 4.25]]);
  // 第 0 块不像说话 → 清；第 1–3 块在说；说完到第 5 块满 2 秒 → 清；之后每块都不像说话 → 每块之后清
  assert.equal(ops(v), 'lr' + 'pr' + 'ppppp' + 'r' + 'pr'.repeat(6) + 'c');
  const w = fakeVad();
  await T.findSpeech(x, { vad: w, QUIET_RESET: false });
  assert.equal(ops(w), 'lr' + 'pppppp' + 'r' + 'pppppp' + 'c', '只有说完 2 秒那一次');
});

test('找说话的地方：说话识别用不了（载入不了、出错、给的不对、卡住）→ 照旧按能量分段；不管怎样都关掉', async () => {
  const x = say(30, [[5, 7]]), want = T.speechSegments(x);
  const cases = [
    ['load', fakeVad({ load: false }), {}],
    ['run', fakeVad({ push: async () => null }), {}],
    ['run', fakeVad({ push: async () => new Float32Array(3) }), {}],
    ['nan', fakeVad({ push: async (pcm) => new Float32Array(pcm.length / 512).fill(NaN) }), {}],
    [/bad output NaN/, fakeVad({ push: async () => { throw new Error('vad: bad output NaN'); } }), {}],
    [/boom/, fakeVad({ load: () => { throw new Error('boom'); } }), {}],
    [/vad load timeout/, fakeVad({ load: () => new Promise(() => {}) }), { loadMs: 20 }],
    [/vad push timeout/, fakeVad({ push: () => new Promise(() => {}) }), { chunkMs: 20 }],
  ];
  for (const [why, v, o] of cases) {
    const r = await T.findSpeech(x, { vad: v, ...o });
    assert.equal(r.finder, 'energy', String(why));
    assert.deepEqual(r.segs, want, String(why));
    if (why instanceof RegExp) assert.match(r.error, why); else assert.equal(r.error, why);
    assert.equal(v.log.filter(s => s === 'close').length, 1, String(why));
    assert.equal(v.log.at(-1), 'close', String(why));
  }
  assert.deepEqual(await T.findSpeech(x, { vad: null }), { segs: want, finder: 'energy', ran: 0, error: null }, '没给说话识别');
});

test('找说话的地方：取消（check 抛出 cancel）原样往外抛，不当作识别坏了；也关掉', async () => {
  const v = fakeVad();
  let n = 0;
  await assert.rejects(T.findSpeech(say(30, [[5, 7], [20, 22]]), { vad: v, check: () => { if (++n > 3) throw new T.SttError('cancel'); } }), e => e.code === 'cancel');
  assert.equal(v.log.at(-1), 'close');
  assert.ok(v.log.includes('push'));
});

test('简繁转换是一个字换一个字（去掉套话时靠这个对齐位置）', () => {
  for (const [k, v] of T2S) { assert.equal(k.length, 1, k); assert.equal(v.length, 1, k); }
  const s = '媽媽，我不要去上學 😴 𠀀';
  assert.equal(toSimplified(s).length, s.length);
});

test('整理识别结果：繁→简、全角标点、词组间空格换逗号；数字里的标点不动', () => {
  const raw = '今天晚上吃饺子吧,我想要豬肉白菜餡的,明天早上7點起床,別忘了帶魚散。';
  assert.equal(T.cleanText(raw), '今天晚上吃饺子吧，我想要猪肉白菜馅的，明天早上7点起床，别忘了带鱼散。');
  assert.equal(T.cleanText(raw, { simplify: false }), '今天晚上吃饺子吧，我想要豬肉白菜餡的，明天早上7點起床，別忘了帶魚散。');
  assert.equal(T.cleanText('明天早上7点起床 别忘了带鱼饭'), '明天早上7点起床，别忘了带鱼饭');
  assert.equal(T.cleanText('嗯 那個蛋糕是我的 不許吃'), '嗯，那个蛋糕是我的，不许吃');
  assert.equal(T.cleanText('你去哪儿?快回来!'), '你去哪儿？快回来！');
  assert.equal(T.cleanText('一共7,000块 7:30 见'), '一共7,000块 7:30 见');
  assert.equal(T.cleanText(',嗯,'), '嗯');
  assert.equal(T.cleanText('   '), '');
  assert.equal(T.cleanText(null), '');
});

test('整理识别结果：去掉静音 / 杂音上编出来的字幕套话', () => {
  for (const s of ['字幕製作人', '謝謝觀看', '谢谢大家收看!', '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目', '字幕由Amara.org社区提供', '(音乐)', '♪♪',
    '多谢您的观看', '我们下期再见', '字幕by索兰娅', 'Thank you for watching.', 'MING PAO CANADA | MING PAO TORONTO']) assert.equal(T.cleanText(s), '', s);
  assert.equal(T.cleanText('今天好累 謝謝觀看'), '今天好累');
  assert.equal(T.cleanText('[音乐] 你别走'), '你别走');
  assert.equal(T.cleanText('谢谢你'), '谢谢你');                    // 正常的话不动
  assert.equal(T.cleanText('谢谢大家'), '谢谢大家');
  assert.equal(T.cleanText('下次见'), '下次见');
  assert.equal(T.cleanText('我订阅了杂志'), '我订阅了杂志');
});

test('整理识别结果：卡住的重复只留一遍；正常的重复不动', () => {
  assert.equal(T.cleanText('我看你这一天'.repeat(10) + '我看你这'), '我看你这一天');
  assert.equal(T.cleanText('我看你，'.repeat(5)), '我看你');
  assert.equal(T.cleanText('嗯嗯嗯'), '嗯嗯嗯');
  assert.equal(T.cleanText('不要不要不要'), '不要不要不要');
  assert.equal(T.cleanText('哈'.repeat(12)), '哈哈哈');
  assert.equal(T.collapseRepeats('不要'.repeat(5) + '不去'), '不要不去');       // 中间的半截不当重复
});

test('草稿来源', () => {
  assert.equal(T.sourceOf('base', 'Mac'), 'whisper-base@Mac');
  assert.deepEqual(T.parseSource('whisper-base@Mac'), { model: 'base', device: 'Mac' });
  assert.deepEqual(T.parseSource('whisper-small@device'), { model: 'small', device: '' });
  assert.deepEqual(T.parseSource('whisper-small'), { model: 'small', device: '' });
  assert.equal(T.parseSource('paste'), null);
  assert.equal(T.parseSource(null), null);
});

test('合进草稿：按录音顺序拼、同一段重新识别就换掉；改过的、粘贴的草稿只往后接', () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64), order = [A, B];
  const src = 'whisper-base@Mac';
  const d1 = T.mergeDraft(null, { sha256: B, text: '第二段', source: src, at: 1 }, order);
  assert.deepEqual(d1, { text: '第二段', source: src, at: 1, parts: [{ sha256: B, text: '第二段' }] });
  const d2 = T.mergeDraft(d1, { sha256: A, text: '第一段', source: src, at: 2 }, order);
  assert.equal(d2.text, '第一段\n\n第二段');
  assert.equal(d2.at, 2);
  const d3 = T.mergeDraft(d2, { sha256: A, text: '第一段（重来）', source: src, at: 3 }, order);
  assert.equal(d3.text, '第一段（重来）\n\n第二段');
  assert.equal(d3.parts.length, 2);
  // 用户改过
  const edited = { ...d3, text: d3.text + '\n我自己加的', edited: 5 };
  const d4 = T.mergeDraft(edited, { sha256: B, text: '第二段（重来）', source: src, at: 6 }, order);
  assert.equal(d4.text, '第一段（重来）\n\n第二段\n我自己加的\n\n第二段（重来）');
  assert.equal(d4.parts, undefined);
  // 手动粘贴的
  const d5 = T.mergeDraft({ text: '语音备忘录的转写\n', source: 'paste' }, { sha256: A, text: '识别的', source: src, at: 7 }, order);
  assert.equal(d5.text, '语音备忘录的转写\n\n识别的');
  assert.equal(d5.source, src);
  // 空草稿当没有
  assert.equal(T.mergeDraft({ text: '  ', source: 'paste' }, { sha256: A, text: 'x', source: src, at: 8 }, order).text, 'x');
});

test('填进原话：每行写成 NN 说的话；写了说话人的行、空行原样；接在原话后面', () => {
  assert.equal(T.draftToDialogue('今天吃什么\n\n\n明天再说', SP), `${NN}“今天吃什么”\n\n${NN}“明天再说”`);
  assert.equal(T.draftToDialogue(`${ME}“吃什么都行？”\n「為什麼」`, SP), `${ME}“吃什么都行？”\n${NN}「為什麼」`);
  assert.equal(T.draftToDialogue('嗯', { nn: { emoji: '🐷', aliases: [] }, me: { emoji: ME, aliases: [] } }), '🐷“嗯”');
  assert.equal(T.draftToDialogue('  \n ', SP), '');
  assert.equal(T.appendText('', 'x'), 'x');
  assert.equal(T.appendText(`${NN}“原话”\n\n`, 'x'), `${NN}“原话”\nx`);
});

test('出错信息分类', () => {
  assert.equal(T.errorCode('RangeError: Out of memory'), 'oom');
  assert.equal(T.errorCode('Aborted(OOM)'), 'oom');
  assert.equal(T.errorCode('WebAssembly.Memory(): could not allocate memory'), 'oom');
  assert.equal(T.errorCode('TypeError: Failed to fetch'), 'net');
  assert.equal(T.errorCode('Load failed'), 'net');
  assert.equal(T.errorCode('Importing a module script failed.'), 'net');      // 第一次用时没网：worker 连 transformers.js 都取不到
  assert.equal(T.errorCode('webgpuInit is not a function', 'wasm'), 'gpu');
  assert.equal(T.errorCode('something odd', 'webgpu'), 'gpu');
  assert.equal(T.errorCode('something odd', 'wasm'), 'failed');
});

// ---------- 假 worker 上的任务流程 ----------
function fakeWorkers(script) {
  const made = [];
  class FW {
    constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.terminated = false; made.push(this); }
    postMessage(m, transfer) { this.sent.push({ m, transfer }); setTimeout(() => { if (!this.terminated) script(this, m); }, 0); }
    emit(m) { if (!this.terminated && this.onmessage) this.onmessage({ data: m }); }
    terminate() { this.terminated = true; }
  }
  return { FW, made };
}
const SAYS = ['今天晚上吃饺子吧,我想要豬肉白菜餡的', '字幕製作人', '媽媽 我不要去上學'];
const okScript = (w, m) => {
  if (m.type === 'load') { w.emit({ type: 'progress', pct: 40, loaded: 40, total: 100 }); w.emit({ type: 'progress', pct: 100, loaded: 100, total: 100 }); w.emit({ type: 'ready' }); }
  if (m.type === 'run') {
    m.segments.forEach((s, i) => { w.emit({ type: 'seg', id: m.id, i }); w.emit({ type: 'partial', id: m.id, i, t: SAYS[i].slice(0, 3) }); w.emit({ type: 'segDone', id: m.id, i, text: SAYS[i] }); });
    w.emit({ type: 'result', id: m.id, texts: m.segments.map((s, i) => SAYS[i]) });
  }
};
const threeSays = () => signal(24, [[1, 3], [8, 10], [16, 18]]);
// 这些流程测试按能量分段（createVad: null）；先用说话识别找说话的地方见后面「识别：先找说话的地方」那几个
const deps = (extra = {}) => ({ decode: async () => threeSays(), probeGpu: async () => ({ gpu: false, f16: false }), cacheInfo: async () => ({ bytes: 0, files: [], complete: { wasm: false, webgpu: false } }), mobile: false, workerUrl: () => 'x.js', createVad: null, ...extra });
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await tick(); } }

test('识别：下载模型 → 分段识别 → 整理好的几行；worker 用完就结束', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const phases = [];
  const off = T.onJob(v => { if (v && phases[phases.length - 1] !== v.phase) phases.push(v.phase); });
  const engines = [];
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base', key: 'e|a', onEngine: e => engines.push(e) }, deps({ Worker: FW }));
  off();
  assert.equal(r.text, '今天晚上吃饺子吧，我想要猪肉白菜馅的\n妈妈，我不要去上学');
  assert.deepEqual(r.lines.length, 2);
  assert.equal(r.engine, 'wasm');
  assert.equal(r.segs, 3);
  assert.deepEqual(engines, ['wasm']);
  assert.deepEqual(phases, ['prepare', 'download', 'run', 'done']);
  assert.equal(T.job().total, T.MODELS.base.wasm.bytes, '下载进度的总数用表里的大小');
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.type, 'module');
  assert.ok(made[0].terminated);
  const load = made[0].sent[0].m;
  assert.deepEqual(load, { type: 'load', model: 'onnx-community/whisper-base', revision: T.MODELS.base.revision, device: 'wasm', dtype: 'q8' });
  const run = made[0].sent[1];
  assert.equal(run.m.segments.length, 3);
  assert.equal(run.transfer.length, 3, '处理器：片段直接转交，不复制');
  const j = T.job();
  assert.equal(j.key, 'e|a');
  assert.equal(j.phase, 'done');
});

test('识别：模型已经在缓存里 → 显示「载入」而不是下载进度', async () => {
  const { FW } = fakeWorkers(okScript);
  const phases = new Set();
  const off = T.onJob(v => v && phases.add(v.phase));
  await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, cacheInfo: async () => ({ bytes: 1, files: [], complete: { wasm: true, webgpu: false } }) }));
  off();
  assert.ok(phases.has('load'));
  assert.ok(!phases.has('download'));
});

test('识别：没听出说话 → 不开 worker、不下载模型，结果是空的', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => signal(10, [], { noiseDb: -56 }) }));
  assert.equal(r.text, '');
  assert.equal(made.length, 0);
});

test('识别：finder energy（「按音量再找一遍」）→ 不开说话识别，按能量找；说话识别说没人说话时结果写着 finder vad', async () => {
  const { FW } = fakeWorkers(okScript);
  let made = 0;
  const v = () => { made++; return fakeVad({ push: async (pcm) => new Float32Array(pcm.length / 512).fill(0.01) }); };   // 说话识别：哪儿都没人说话
  const r1 = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, createVad: v }));
  assert.deepEqual([r1.text, r1.finder, made], ['', 'vad', 1], '说话识别没找到：结果是空的、finder vad（页面给「按音量再找一遍」）');
  const r2 = await T.transcribe({ blob: new Blob(['x']), model: 'base', finder: 'energy' }, deps({ Worker: FW, createVad: v }));
  assert.equal(made, 1, '按音量：没再开说话识别');
  assert.equal(r2.finder, 'energy');
  assert.ok(r2.text.length > 0, '按能量找到了、识别了');
});

test('识别：显卡出错 → 换一个新 worker 用处理器重来（片段发的是副本）', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load' && m.device === 'webgpu') { w.emit({ type: 'error', message: 'webgpu device lost' }); return; }
    okScript(w, m);
  });
  const fails = [], engines = [];
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base', onGpuFail: e => fails.push(e.code), onEngine: e => engines.push(e) },
    deps({ Worker: FW, probeGpu: async () => ({ gpu: true, f16: true }) }));
  assert.equal(r.engine, 'wasm');
  assert.equal(r.lines.length, 2);
  assert.deepEqual(fails, ['gpu']);
  assert.deepEqual(engines, ['webgpu', 'wasm']);
  assert.equal(made.length, 2);
  assert.ok(made.every(w => w.terminated));
  assert.equal(made[0].sent[0].m.device, 'webgpu');
  assert.deepEqual(made[0].sent[0].m.dtype, { encoder_model: 'fp32', decoder_model_merged: 'q4' });
  assert.equal(made[1].sent[0].m.device, 'wasm');
});

test('识别：显卡跑到一半出错也换处理器；下载不了（网络）不换，直接报错', async () => {
  const { FW } = fakeWorkers((w, m) => {
    if (m.type === 'run' && w.sent[0].m.device === 'webgpu') { w.emit({ type: 'error', message: 'GPU validation error' }); return; }
    okScript(w, m);
  });
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, probeGpu: async () => ({ gpu: true }) }));
  assert.equal(r.engine, 'wasm');
  const net = fakeWorkers((w, m) => { if (m.type === 'load') w.emit({ type: 'error', message: 'TypeError: Failed to fetch' }); });
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: net.FW, probeGpu: async () => ({ gpu: true }) })), e => e.code === 'net');
  assert.equal(net.made.length, 1);
  assert.equal(T.job().phase, 'error');
  assert.equal(T.job().error.code, 'net');
});

test('识别：取消 → 结束 worker，任务记成「取消」；跑着的时候不能再开一个', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load') w.emit({ type: 'ready' });
    if (m.type === 'run') w.emit({ type: 'seg', id: m.id, i: 0 });        // 卡在第一段
  });
  const p = T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW }));
  await waitFor(() => T.job() && T.job().phase === 'run');
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW })), e => e.code === 'busy');
  assert.equal(T.cancel(), true);
  await assert.rejects(p, e => e.code === 'cancel');
  assert.ok(made[0].terminated);
  assert.equal(T.job().phase, 'cancel');
  assert.equal(T.cancel(), false);
});

test('识别：读录音时取消也能停；内存不够 → oom；手机上选了更准 → tooBig；读不出录音 → decode', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { FW, made } = fakeWorkers(okScript);
  const p = T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => { await slow; return threeSays(); } }));
  await tick();
  T.cancel();
  release();
  await assert.rejects(p, e => e.code === 'cancel');
  assert.equal(made.length, 0);

  const oom = fakeWorkers((w, m) => { if (m.type === 'load') w.emit({ type: 'error', message: 'RangeError: Out of memory' }); });
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: oom.FW })), e => e.code === 'oom');
  assert.equal(T.job().error.code, 'oom');
  T.clearJob();
  assert.equal(T.job(), null);

  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'small' }, deps({ Worker: oom.FW, mobile: true })), e => e.code === 'tooBig');
  await assert.rejects(T.transcribe({ blob: null, model: 'base' }, deps({ Worker: oom.FW })), e => e.code === 'noAudio');
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: oom.FW, decode: async () => { throw new T.SttError('decode', 'bad'); } })), e => e.code === 'decode');
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: undefined })), e => e.code === 'unsupported');
  // worker 自己崩了（没发消息）
  const crash = fakeWorkers((w, m) => { if (m.type === 'load' && w.onerror) w.onerror({ message: 'Aborted()', preventDefault() {} }); });
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: crash.FW })), e => e.code === 'failed' && /Aborted/.test(e.message));
});

test('只下载模型：载入一次就结束 worker，不识别', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const r = await T.downloadModel({ model: 'small' }, deps({ Worker: FW, probeGpu: async () => ({ gpu: true, f16: true }) }));
  assert.equal(r.engine, 'webgpu');
  assert.equal(made.length, 1);
  assert.equal(made[0].sent.length, 1);
  assert.equal(made[0].sent[0].m.model, 'onnx-community/whisper-small');
  assert.ok(made[0].terminated);
  assert.equal(T.job().kind, 'download');
  assert.equal(T.job().key, 'download:small');
});

// ---------- 识别：先用说话识别找说话的地方 ----------
/** 两分钟的鼾声里 50–53 秒说了一句（1 kHz）：只按能量 20 多段，说话识别 1 段 */
const snoreTalk = () => mix(bursts(120, { relDb: 8, every: 4, dur: 1.2 }), say(120, [[50, 53, -40]], { noiseDb: null }));

test('识别：先找说话的地方（鼾声不送去识别），说话识别关掉以后才开 Whisper 的 worker', async () => {
  const events = [];
  const { FW, made } = fakeWorkers(okScript);
  class Logged extends FW { constructor(...a) { super(...a); events.push('whisper.new'); } }
  const v = fakeVad({ events });
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: Logged, decode: async () => snoreTalk(), createVad: () => v }));
  assert.equal(r.finder, 'vad');
  assert.equal(r.segs, 1);
  assert.equal(T.job().finder, 'vad');
  assert.equal(made[0].sent[1].m.segments.length, 1);
  near(secs([[0, made[0].sent[1].m.segments[0].length]]), [[0, 3.5]]);
  assert.ok(T.speechSegments(snoreTalk()).length >= 20, '只按能量：鼾声每一下都要识别');
  assert.equal(events.filter(e => e === 'vad.close').length, 1);
  assert.ok(events.indexOf('vad.close') < events.indexOf('whisper.new'), events.join(' '));
  assert.equal(events.at(-1), 'whisper.new', '开 Whisper 以后说话识别什么都不做了');
  assert.ok(made[0].terminated);
});

test('识别：找说话的地方要一会儿 → 显示「找说话的地方…」（phase vad）和进度；很快就找完的不显示', async () => {
  const { FW } = fakeWorkers(okScript);
  const views = [];
  const off = T.onJob(j => { if (j) views.push([j.phase, j.pct]); });
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => snoreTalk(), createVad: () => fakeVad({ delay: 1 }), vadShowMs: 0 }));
  off();
  assert.equal(r.finder, 'vad');
  const phases = views.map(v => v[0]).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases, ['prepare', 'vad', 'download', 'run', 'done']);
  assert.ok(T.isRunning({ phase: 'vad' }), '找说话的地方也算在跑（床头模式不会这时开始、可以取消）');
  const pcts = views.filter(v => v[0] === 'vad').map(v => v[1]).filter(p => p != null);
  assert.ok(pcts.length > 3 && pcts.every((p, i) => !i || p >= pcts[i - 1]) && pcts.at(-1) === 100, JSON.stringify(pcts));
  const quick = new Set();
  const off2 = T.onJob(j => j && quick.add(j.phase));
  await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => snoreTalk(), createVad: () => fakeVad() }));
  off2();
  assert.ok(!quick.has('vad'), '不到 0.4 秒就找完了：不闪一下');
});

test('识别：找说话的地方时取消 → 马上关掉说话识别，不开 Whisper', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const v = fakeVad({ hang: true });
  const p = T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => snoreTalk(), createVad: () => v, vadShowMs: 0 }));
  await waitFor(() => T.job() && T.job().phase === 'vad' && v.pending.length);
  assert.equal(T.cancel(), true);
  await assert.rejects(p, e => e.code === 'cancel');
  assert.ok(v.closed);
  assert.equal(made.length, 0);
  assert.equal(T.job().phase, 'cancel');
  // 载入时取消也一样
  const w = fakeVad({ load: () => new Promise(() => {}) });
  const q = T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => snoreTalk(), createVad: () => w }));
  await waitFor(() => w.log.includes('load'));
  T.cancel();
  await assert.rejects(q, e => e.code === 'cancel');
  assert.ok(w.closed);
  assert.equal(made.length, 0);
});

test('识别：说话识别没找到说话 → 不开 Whisper；说话识别用不了 → 照旧按能量识别（也是先关掉它）', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const v = fakeVad();
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => bursts(60, { relDb: 8, every: 4, dur: 1.2 }), createVad: () => v }));
  assert.deepEqual([r.text, r.segs, r.finder], ['', 0, 'vad']);
  assert.ok(v.closed);
  assert.equal(made.length, 0);
  const events = [];
  class Logged extends FW { constructor(...a) { super(...a); events.push('whisper.new'); } }
  const bad = fakeVad({ load: false, events });
  const e = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: Logged, createVad: () => bad }));
  assert.deepEqual([e.finder, e.segs, e.lines.length], ['energy', 3, 2]);
  assert.deepEqual(events, ['vad.load', 'vad.close', 'whisper.new']);
  const t = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, createVad: () => { throw new Error('no'); } }));
  assert.deepEqual([t.finder, t.segs], ['energy', 3]);
  // 不注入：用真的 createVad()，Node 里没有 Worker → 载入不了 → 按能量
  const dd = deps({ Worker: FW });
  delete dd.createVad;
  const u = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, dd);
  assert.deepEqual([u.finder, u.segs], ['energy', 3]);
});

// ---------- 模型缓存 ----------
function fakeCaches(sizes) {
  const store = new Map(Object.entries(sizes));
  return {
    store,
    async has(name) { return name === T.MODEL_CACHE; },
    async open(name) {
      assert.equal(name, T.MODEL_CACHE);
      return {
        async keys() { return [...store.keys()].map(url => ({ url })); },
        async match(r) { const n = store.get(r.url); return n == null ? undefined : { headers: { get: k => (k === 'content-length' ? String(n) : null) } }; },
        async delete(r) { return store.delete(r.url); },
      };
    },
  };
}

test('模型缓存：算这个模型（所有版本）占多少、固定版本齐不齐；删除只删这个模型', async () => {
  const pre = T.modelPrefix('base');
  const sizes = Object.fromEntries(T.modelFiles('base', 'wasm').map((f, i) => [pre + f, 1000 + i]));
  sizes[T.repoPrefix('base') + 'main/onnx/encoder_model.onnx'] = 5000;                       // 旧版本
  sizes['https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'] = 77;   // 别的模型
  sizes['https://huggingface.co/someone/other-app-model/resolve/main/model.onnx'] = 88;        // 同域名下别的 App
  const cs = fakeCaches(sizes);
  const info = await T.modelCacheInfo('base', { caches: cs });
  const want = T.modelFiles('base', 'wasm').reduce((n, f, i) => n + 1000 + i, 0) + 5000;
  assert.equal(info.bytes, want);
  assert.deepEqual(info.complete, { wasm: true, webgpu: false });
  assert.deepEqual((await T.modelCacheInfo('small', { caches: cs })).complete, { wasm: false, webgpu: false });
  assert.equal(await T.deleteModel('base', { caches: cs }), T.modelFiles('base', 'wasm').length + 1);
  assert.deepEqual([...cs.store.keys()].sort(), Object.keys(sizes).filter(u => !u.includes('whisper-base')).sort());
  assert.equal(await T.modelCacheInfo('base', { caches: null }), null);
  assert.equal(await T.deleteModel('base', { caches: null }), 0);
  const empty = { async has() { return false; }, async open() { throw new Error('不该打开（会建出一个空缓存）'); } };
  assert.deepEqual(await T.modelCacheInfo('base', { caches: empty }), { bytes: 0, files: [], complete: { wasm: false, webgpu: false } });
});

// ---------- worker 和第三方文件 ----------
test('worker 只 import 仓库里的 transformers.js，wasm 指向仓库里的文件（不走 CDN）', () => {
  const src = fs.readFileSync(path.join(root, 'src/workers/transcribe.worker.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['../../vendor/transformers/transformers.min.js']);
  assert.match(src, /env\.backends\.onnx\.wasm/);
  assert.match(src, /ort-wasm-simd-threaded\$\{v\}\.mjs/);
  assert.doesNotMatch(src, /jsdelivr|unpkg|https?:\/\//);
  assert.match(src, /language: 'zh'/);
  const core = fs.readFileSync(path.join(root, 'src/core/transcribe.js'), 'utf8');
  assert.match(core, /new URL\('\.\.\/workers\/transcribe\.worker\.js', import\.meta\.url\)/);
  for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'LICENSE', 'LICENSE-onnxruntime-web', 'README.md']) {
    assert.ok(fs.existsSync(path.join(root, 'vendor/transformers', f)), f);
  }
  assert.match(fs.readFileSync(path.join(root, 'vendor/transformers/LICENSE'), 'utf8'), /Apache License/);
  assert.match(fs.readFileSync(path.join(root, 'vendor/transformers/LICENSE-onnxruntime-web'), 'utf8'), /MIT License/);
  for (const f of fs.readdirSync(path.join(root, 'vendor/transformers'))) assert.ok(!f.endsWith('.map'), '不带 source map');
});

test('CSP：允许 wasm，只多放 Hugging Face 的下载地址；worker 只能是本站的', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = Object.fromEntries(csp.split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dir['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(dir['connect-src'], ["'self'", 'https://api.github.com', 'https://huggingface.co', 'https://*.hf.co']);
  assert.deepEqual(dir['worker-src'], ["'self'"]);
  assert.deepEqual(dir['default-src'], ["'self'"]);
});

// ---------- 真模型：vendor 里的 Silero VAD 在 Node 里找说话的地方 ----------
// 和 tests/vad.test.mjs 一样：打包版 transformers.js 用打包进来的 onnxruntime-web（import 时让它以为不是 Node），模型从磁盘读（不联网）；
// worker 脚本在这个进程里 import（self 是个假的），InProc 当 Worker 交给 createVad，消息照样转交、异步送达。
const norm = (x, db) => { let e = 0; for (const v of x) e += v * v; const k = Math.pow(10, db / 20) / Math.sqrt(e / x.length + 1e-20); return x.map(v => v * k); };
/** 共振峰合成的「元音」（和 tests/vad.test.mjs 一样）：基频 150–245 Hz 起伏的脉冲列过三个共振器，一个音节 220 ms、停 60 ms */
function vowels(sec, db, seed) {
  const F = [[800, 1200, 2500], [300, 2300, 3000], [350, 800, 2400], [500, 1800, 2600], [600, 1000, 2500]];
  const n = Math.round(sec * SR), x = new Float32Array(n), r = lcg(seed), res = [[0, 0], [0, 0], [0, 0]];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, syl = Math.floor(t / 0.28), st = t - syl * 0.28;
    if (st > 0.22) continue;
    ph += (190 + 40 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(6 * Math.PI * t)) / SR;
    let src = r() * 0.02;
    if (ph >= 1) { ph -= 1; src += 1; }
    let y = 0;
    F[syl % 5].forEach((f, k) => {
      const R = Math.exp(-Math.PI * (80 + 40 * k) / SR), c = 2 * R * Math.cos(2 * Math.PI * f / SR), s = res[k], o = src + c * s[0] - R * R * s[1];
      s[1] = s[0]; s[0] = o; y += o / (k + 1);
    });
    x[i] = y * Math.sin(Math.PI * st / 0.22);
  }
  return norm(x, db);
}
/** 风扇似的底噪：白噪声 + 低频轰轰 */
function hum(sec, db, seed) { const n = Math.round(sec * SR), x = new Float32Array(n), r = lcg(seed); let b = 0; for (let i = 0; i < n; i++) { const w = r(); b = 0.995 * b + 0.05 * w; x[i] = b + 0.2 * w; } return norm(x, db); }
/** 鼾声似的：每 4 秒一下、每下 1–1.4 秒（占 25–35%），200 Hz 左右的低通噪声带 30 Hz 上下的颤动，比底噪响 rel dB */
function snores(sec, floorDb, { rel = 8, every = 4, seed = 3 } = {}) {
  const n = Math.round(sec * SR), x = new Float32Array(n), r = lcg(seed), r2 = lcg(seed + 1);
  for (let t = 1; t + 1.4 < sec; t += every) {
    const D = Math.round((1.2 + 0.2 * r()) * SR), s0 = Math.round(t * SR), b = new Float32Array(D), fl = 30 + 5 * r();
    let y1 = 0, y2 = 0, e = 0;
    for (let i = 0; i < D; i++) { y1 += 0.08 * (r2() - y1); y2 += 0.08 * (y1 - y2); b[i] = y2 * Math.sin(Math.PI * i / D) ** 0.7 * (0.6 + 0.4 * Math.sin(2 * Math.PI * fl * i / SR)); e += b[i] * b[i]; }
    const k = Math.pow(10, (floorDb + rel) / 20) / Math.sqrt(e / D);
    for (let i = 0; i < D; i++) x[s0 + i] += b[i] * k;
  }
  return x;
}
const place = (sec, x, total) => { const o = new Float32Array(Math.round(total * SR)); o.set(x, Math.round(sec * SR)); return o; };
/** [a, b) 秒里有多少被这些窗口盖住了（0..1） */
const covered = (segs, [a, b]) => segs.reduce((s, [x, y]) => s + Math.max(0, Math.min(b * SR, y) - Math.max(a * SR, x)), 0) / ((b - a) * SR);
const sentSec = (segs) => segs.reduce((s, [a, b]) => s + b - a, 0) / SR;

test('真模型：风扇声里一阵阵的鼾声不送去识别（只按能量会送）；鼾声中间、很小声的「元音」都找得到；说话识别关掉以后才开 Whisper', async (t) => {
  const rel = Object.getOwnPropertyDescriptor(process, 'release');
  let tf;
  Object.defineProperty(process, 'release', { value: { name: 'browser' }, configurable: true });
  try { tf = await import(pathToFileURL(path.join(root, 'vendor/transformers/transformers.min.js')).href); }
  finally { Object.defineProperty(process, 'release', rel); }
  if (!(tf.env.backends && tf.env.backends.onnx && tf.env.backends.onnx.wasm)) { t.skip('这一版 transformers.js 在 Node 里不用 onnxruntime-web'); return; }
  tf.env.logLevel = 40;
  tf.env.fetch = async (u) => {
    const s = String(u);
    if (!s.startsWith('file:')) throw new Error('测试里不联网：' + s);
    try { return new Response(fs.readFileSync(fileURLToPath(s))); } catch (e) { return new Response('', { status: 404 }); }
  };
  const events = [];
  let cur = null;
  const deliver = (to, m, transfer) => { const got = transfer && transfer.length ? structuredClone(m, { transfer }) : m; setTimeout(() => to(got), 0); };
  globalThis.self = { postMessage: (m, transfer) => { const w = cur; deliver((d) => { if (w && !w.terminated && w.onmessage) w.onmessage({ data: d }); }, m, transfer); }, addEventListener() {} };
  class InProc {
    constructor(url) { this.url = String(url); this.terminated = false; cur = this; events.push('vad.new'); }
    postMessage(m, transfer) { deliver((d) => { if (!this.terminated) self.onmessage({ data: d }); }, m, transfer); }
    terminate() { this.terminated = true; if (cur === this) cur = null; events.push('vad.terminate'); }
  }
  try {
    await import(pathToFileURL(path.join(root, 'src/workers/vad.worker.js')).href);
    const real = () => createVad({ Worker: InProc, url: 'vad.worker.js' });
    // 40 秒：风扇似的底噪 −50 dBFS + 鼾声（比底噪响 8 dB）；8–11 秒、25–28 秒是「元音」（−45 dBFS）
    const noisy = mix(hum(40, -50, 1), snores(40, -50));
    const talk = mix(noisy, place(8, vowels(3, -45, 8), 40), place(25, vowels(3, -45, 9), 40));
    const a = await T.findSpeech(noisy, { vad: real() });
    assert.equal(a.finder, 'vad', a.error);
    assert.deepEqual(a.segs, [], '只有鼾声：不识别');
    assert.ok(T.speechSegments(noisy).length >= 5, '只按能量：鼾声都送去识别');
    const b = await T.findSpeech(talk, { vad: real() });
    assert.equal(b.finder, 'vad', b.error);
    assert.equal(b.segs.length, 2, JSON.stringify(secs(b.segs)));
    assert.ok(covered(b.segs, [8, 11]) > 0.9 && covered(b.segs, [25, 28]) > 0.9, JSON.stringify(secs(b.segs)));
    // 说完 2 秒以内的一下鼾声会跟着进那个窗口（隔得近的几句一起算够不够长）：每个窗口多一两秒，还是比只按能量少一半多
    assert.ok(sentSec(b.segs) < 12, `送去识别 ${sentSec(b.segs)} 秒`);
    assert.ok(sentSec(T.speechSegments(talk)) > 20, '只按能量：大半段都送去识别');
    assert.ok(b.ran < talk.length, '底噪那几秒没跑');
    // 很安静的屋里（底噪 −75 dBFS）很小声的「元音」（−60 dBFS）：放大了给识别，找得全；只按能量只找到一点
    const soft = mix(hum(40, -75, 1), place(8, vowels(3, -60, 8), 40), place(25, vowels(3, -60, 9), 40));
    const c = await T.findSpeech(soft, { vad: real() });
    assert.ok(covered(c.segs, [8, 11]) > 0.95 && covered(c.segs, [25, 28]) > 0.95, JSON.stringify(secs(c.segs)));
    const e = T.speechSegments(soft);
    assert.ok(covered(e, [8, 11]) < 0.5 && covered(e, [25, 28]) < 0.5, JSON.stringify(secs(e)));
    // 整个识别：真的说话识别 + 假的 Whisper worker
    events.length = 0;
    const { FW, made } = fakeWorkers(okScript);
    class Logged extends FW { constructor(...x) { super(...x); events.push('whisper.new'); } }
    const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: Logged, decode: async () => talk, createVad: real }));
    assert.equal(r.finder, 'vad');
    assert.equal(r.segs, 2);
    assert.deepEqual(events, ['vad.new', 'vad.terminate', 'whisper.new']);
    assert.ok(made[0].terminated);
  } finally { delete globalThis.self; }
});
