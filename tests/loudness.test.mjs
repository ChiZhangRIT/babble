// 均衡播放的声音处理测试：全部用合成信号（像说话的谐波 + 一个字一个字的包络 + 固定种子的底噪），不用真录音
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelAudio, analyzeLoudness, applyGain, limitPeaks, encodeWav, downmix, rmsDb, peakDb, dbToGain, LEVEL_DEFAULTS } from '../src/core/loudness.js';

// ---------- 合成信号 ----------
const SR = 24000;
const rng = (seed = 1) => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1; };
/** 白噪声，RMS = db */
function noise(n, db, seed = 7) { const r = rng(seed), g = dbToGain(db) * Math.sqrt(3), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = r() * g; return x; }
/** 一句「话」：基频 f0 带一点颤音、8 个谐波，每个字 200 ms（中间停 60 ms），整句 RMS = db */
function phrase(sec, db, sr = SR, f0 = 180) {
  const n = Math.round(sec * sr), x = new Float32Array(n), syl = 0.2, gap = 0.06;
  for (let i = 0; i < n; i++) {
    const t = i / sr, ph = t % (syl + gap);
    if (ph >= syl) continue;
    const f = f0 * (1 + 0.05 * Math.sin(2 * Math.PI * 3 * t));
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(2 * Math.PI * k * f * t + k) / k;
    x[i] = v * Math.sin(Math.PI * ph / syl) ** 2;
  }
  return scaleTo(x, db);
}
function scaleTo(x, db) { const g = dbToGain(db - rmsDb(x)); for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
const silence = (sec, sr = SR) => new Float32Array(Math.round(sec * sr));
function concat(...parts) { const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function mix(a, b) { const out = Float32Array.from(a); for (let i = 0; i < Math.min(a.length, b.length); i++) out[i] += b[i]; return out; }
const at = (sec, sr = SR) => Math.round(sec * sr);
const seg = (x, a, b, sr = SR) => rmsDb(x, at(a, sr), at(b, sr));
const CEIL = dbToGain(LEVEL_DEFAULTS.ceilingDb);
const maxAbs = (y) => { let m = 0; for (const v of y) { assert.ok(Number.isFinite(v), '输出里有 NaN / Infinity'); m = Math.max(m, Math.abs(v)); } return m; };

/** 小声一句（−42）+ 安静 2 秒 + 大声一句（−10），底噪 −62：1–3 s 小声，5–7 s 大声 */
function quietLoud(sr = SR) {
  const sig = concat(silence(1, sr), phrase(2, -42, sr), silence(2, sr), phrase(2, -10, sr, 140), silence(1.5, sr));
  return mix(sig, noise(sig.length, -62));
}

// ---------- 均衡 ----------
test('小声一句、大声一句：均衡后两句响度相差不到 2 dB，都接近目标', () => {
  const x = quietLoud(), y = levelAudio(x, SR);
  assert.equal(y.length, x.length);
  const q = seg(y, 1, 3), l = seg(y, 5, 7);
  assert.ok(seg(x, 5, 7) - seg(x, 1, 3) > 30, '原来差 30 dB 以上');
  assert.ok(Math.abs(q - l) <= 2, `小声 ${q.toFixed(1)} / 大声 ${l.toFixed(1)}`);
  for (const v of [q, l]) assert.ok(v > LEVEL_DEFAULTS.targetDb - 4 && v < LEVEL_DEFAULTS.targetDb + 2, `接近 −18 dBFS：${v.toFixed(1)}`);
  assert.ok(q - seg(x, 1, 3) > 15, '小声的放大了');
  assert.ok(l < seg(x, 5, 7) - 5, '大声的压低了');
});

test('找出两句话，起止时间误差不超过 60 ms', () => {
  const a = analyzeLoudness(quietLoud(), SR);
  assert.equal(a.phrases.length, 2);
  const [p, q] = a.phrases;
  for (const [got, want] of [[p.start, 1], [p.end, 3], [q.start, 5], [q.end, 7]]) assert.ok(Math.abs(got - want) <= 0.06, `${got} ≈ ${want}`);
  assert.ok(p.gainDb > 15 && q.gainDb < -5, `${p.gainDb} / ${q.gainDb}`);
  assert.ok(Math.abs(a.globalFloorDb - -62) <= 2, `噪声底 ${a.globalFloorDb}`);
});

test('安静的地方还是安静：句间底噪最多放大一点，数字静音保持为 0', () => {
  const x = quietLoud(), y = levelAudio(x, SR);
  // 开头 0–0.8 s 和句间 3.5–4.5 s（离句子边缘 0.3 s 以上）只有底噪
  for (const [a, b] of [[0, 0.8], [3.5, 4.5], [7.5, 8.5]]) {
    const before = seg(x, a, b), after = seg(y, a, b);
    assert.ok(after <= before + LEVEL_DEFAULTS.noiseBoostDb + 0.5, `${a}–${b}s：${before.toFixed(1)} → ${after.toFixed(1)}`);
    assert.ok(after < -50, `${a}–${b}s 仍然很安静：${after.toFixed(1)}`);
  }
  const zeros = levelAudio(concat(silence(1), phrase(1, -30), silence(1)), SR);
  for (let i = 0; i < at(0.5); i++) assert.equal(zeros[i], 0);
  assert.ok(levelAudio(silence(2), SR).every(v => v === 0), '全是静音 → 全是 0');
});

test('只有底噪（没有人说话）：最多放大 noiseBoostDb', () => {
  const x = noise(at(5), -58), y = levelAudio(x, SR);
  assert.equal(analyzeLoudness(x, SR).phrases.length, 0);
  const d = rmsDb(y) - rmsDb(x);
  assert.ok(d <= LEVEL_DEFAULTS.noiseBoostDb + 0.01 && d >= 0, `增益 ${d.toFixed(2)} dB`);
});

test('输出永远不超过 −1 dBFS（满幅方波、尖脉冲、满幅噪声、小声后突然很大声）', () => {
  const sq = new Float32Array(at(1.5)).map((_, i) => (Math.floor(i / 40) % 2 ? 0.999 : -0.999));
  const spikes = phrase(2, -30); for (let i = 0; i < spikes.length; i += 2400) spikes[i] = 0.98;
  const cases = [
    concat(silence(0.5), phrase(1, -45), silence(0.4), sq, silence(0.5)),
    concat(silence(0.5), spikes, silence(0.5)),
    noise(at(2), -4.8),
    mix(concat(phrase(1.5, -50), phrase(1.5, -3)), noise(at(3), -70)),
  ];
  for (const [k, x] of cases.entries()) {
    const m = maxAbs(levelAudio(x, SR));
    assert.ok(m <= CEIL + 1e-6, `第 ${k + 1} 组：峰值 ${(20 * Math.log10(m)).toFixed(3)} dBFS`);
  }
});

test('大声的那句开头不会冲出来（增益提前降好）', () => {
  const x = mix(concat(silence(0.5), phrase(1.5, -45), silence(0.45), phrase(1.5, -8, SR, 150), silence(0.5)), noise(at(4.45), -66));
  const y = levelAudio(x, SR), start = 0.5 + 1.5 + 0.45;
  const head = seg(y, start, start + 0.05), body = seg(y, start + 0.3, start + 1.5);
  assert.ok(head <= body + 3, `开头 50 ms ${head.toFixed(1)} / 后面 ${body.toFixed(1)}`);
  assert.ok(peakDb(y, at(start), at(start + 0.1)) <= LEVEL_DEFAULTS.ceilingDb + 1e-4);
});

test('增益曲线平滑：每 10 ms 最多降 6 dB、最多升 2 dB，没有台阶', () => {
  const a = analyzeLoudness(quietLoud(), SR), g = a.gainDb;
  const down = LEVEL_DEFAULTS.attackDbPerSec * LEVEL_DEFAULTS.hopMs / 1000, up = LEVEL_DEFAULTS.releaseDbPerSec * LEVEL_DEFAULTS.hopMs / 1000;
  for (let f = 1; f < g.length; f++) {
    const d = g[f] - g[f - 1];
    assert.ok(d <= up + 1e-4 && d >= -down - 1e-4, `第 ${f} 帧变化 ${d}`);
  }
  // 句子里面增益不变（不跟着一个个字忽大忽小）
  const mid = (s) => Math.round(s * 1000 / LEVEL_DEFAULTS.hopMs);
  for (const [a0, b0] of [[1.3, 2.7], [5.3, 6.7]]) {
    let lo = Infinity, hi = -Infinity;
    for (let f = mid(a0); f < mid(b0); f++) { lo = Math.min(lo, g[f]); hi = Math.max(hi, g[f]); }
    assert.ok(hi - lo < 0.01, `${a0}–${b0}s 增益变化 ${hi - lo}`);
  }
});

test('环境变吵（底噪从 −66 升到 −50）：噪声底跟上，吵的底噪不当成话，两句仍然一样响', () => {
  const quiet = mix(concat(silence(2), phrase(1.5, -40), silence(5)), noise(at(8.5), -66, 3));
  const loud = mix(concat(silence(3), phrase(1.5, -25, SR, 160), silence(4)), noise(at(8.5), -50, 5));
  const x = concat(quiet, loud), a = analyzeLoudness(x, SR);
  assert.equal(a.phrases.length, 2, JSON.stringify(a.phrases));
  assert.ok(Math.abs(a.phrases[1].start - 11.5) < 0.1, `第二句从 ${a.phrases[1].start}s 开始（变吵的那一刻 8.5s 不算话）`);
  const fl = (s) => a.floorDb[Math.round(s * 100)];
  assert.ok(Math.abs(fl(5) - -66) < 3 && Math.abs(fl(10) - -50) < 3 && Math.abs(fl(15) - -50) < 3, `噪声底 ${fl(5)} / ${fl(10)} / ${fl(15)}`);
  const y = levelAudio(x, SR), p = seg(y, 2, 3.5), q = seg(y, 8.5 + 3, 8.5 + 4.5);
  assert.ok(Math.abs(p - q) <= 2, `${p.toFixed(1)} / ${q.toFixed(1)}`);
  assert.ok(seg(y, 9, 11) <= seg(x, 9, 11) + LEVEL_DEFAULTS.noiseBoostDb + 0.5, '变吵以后的底噪没被当成小声的话放大');
});

test('一直响着的平稳声音（单音、风扇）不算话', () => {
  const tone = new Float32Array(at(4)).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / SR));
  for (const x of [tone, mix(concat(silence(2), noise(at(4), -40, 9)), noise(at(6), -65))]) {
    const a = analyzeLoudness(x, SR);
    assert.equal(a.phrases.length, 0, JSON.stringify(a.phrases));
    assert.ok(Math.max(...a.gainDb) <= LEVEL_DEFAULTS.noiseBoostDb + 1e-6);
  }
});

test('很长、中间不停的一段话（前半小声后半大声）：慢慢调，两半差距大大缩小', () => {
  const x = mix(concat(silence(1), phrase(5, -40), phrase(5, -16, SR, 150), silence(1)), noise(at(12), -64));
  const a = analyzeLoudness(x, SR);
  assert.equal(a.phrases.length, 1);
  const y = levelAudio(x, SR), d0 = seg(x, 7, 10) - seg(x, 2, 4.5), d1 = seg(y, 7, 10) - seg(y, 2, 4.5);
  assert.ok(Math.abs(d1) < 4 && Math.abs(d1) < Math.abs(d0) - 15, `原来差 ${d0.toFixed(1)}，现在差 ${d1.toFixed(1)}`);
});

test('很短的一声（「嗯」250 ms）也算一句；咔哒一下不算', () => {
  const x = mix(concat(silence(1), phrase(0.25, -45), silence(1), new Float32Array(at(0.01)).fill(0.2), silence(1)), noise(at(3.26), -64));
  const a = analyzeLoudness(x, SR);
  assert.equal(a.phrases.length, 1);
  assert.ok(seg(levelAudio(x, SR), 1, 1.25) > -24);
});

test('不同采样率结果一致；同样的输入每次得到同样的输出；原数组不动', () => {
  const res = [16000, 24000, 44100, 48000].map(sr => { const y = levelAudio(quietLoud(sr), sr); return [seg(y, 1, 3, sr), seg(y, 5, 7, sr)]; });
  for (const [q, l] of res) { assert.ok(Math.abs(q - res[1][0]) < 1, `${q}`); assert.ok(Math.abs(l - res[1][1]) < 1, `${l}`); }
  const x = quietLoud(), copy = Float32Array.from(x);
  const y1 = levelAudio(x, SR), y2 = levelAudio(x, SR);
  assert.deepEqual(x, copy);
  assert.ok(y1 !== x);
  assert.deepEqual(y1, y2);
});

test('空的、极短的输入不出错', () => {
  assert.equal(levelAudio(new Float32Array(0), SR).length, 0);
  const y = levelAudio(Float32Array.from([0.1, -0.1, 0.5, 0, 0]), SR);
  assert.equal(y.length, 5);
  maxAbs(y);
  assert.equal(levelAudio(Float32Array.from([NaN, 0.1]), SR).length, 2);
});

test('10 分钟的录音（24 kHz）几秒内处理完', () => {
  const parts = [];
  for (let k = 0; k < 60; k++) parts.push(phrase(4, k % 2 ? -40 : -12, SR, 150 + k), silence(6));
  const x = mix(concat(...parts), noise(at(600), -60));
  const t0 = performance.now(), y = levelAudio(x, SR), ms = performance.now() - t0;
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
  assert.ok(Math.abs(seg(y, 0, 4) - seg(y, 10, 14)) <= 2);
  assert.ok(maxAbs(y) <= CEIL + 1e-6);
});

test('applyGain：帧中心之间线性插值；limitPeaks：没超过的不动', () => {
  const x = new Float32Array(100).fill(0.5);
  const y = applyGain(x, Float32Array.from([0, -6.0206]), 50);
  assert.ok(Math.abs(y[0] - 0.5) < 1e-6 && Math.abs(y[25] - 0.5) < 1e-6 && Math.abs(y[75] - 0.25) < 1e-4 && Math.abs(y[99] - 0.25) < 1e-4);
  assert.ok(Math.abs(y[50] - 0.375) < 1e-3);
  const z = Float32Array.from([0.1, -0.2, 0.3]);
  assert.deepEqual(limitPeaks(Float32Array.from(z), SR), z);
});

// ---------- WAV ----------
test('WAV：44 字节文件头（RIFF / PCM / 单声道 / 16 位）+ 小端样本，超出 ±1 削掉，NaN 当 0', () => {
  const w = encodeWav(Float32Array.from([0, 1, -1, 0.5, 2, -3, NaN, -0.5]), 24000);
  assert.ok(w instanceof Uint8Array);
  assert.equal(w.length, 44 + 16);
  const v = new DataView(w.buffer), s = (o, n) => String.fromCharCode(...w.slice(o, o + n));
  assert.equal(s(0, 4), 'RIFF'); assert.equal(v.getUint32(4, true), w.length - 8); assert.equal(s(8, 4), 'WAVE');
  assert.equal(s(12, 4), 'fmt '); assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1); assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 24000); assert.equal(v.getUint32(28, true), 48000);
  assert.equal(v.getUint16(32, true), 2); assert.equal(v.getUint16(34, true), 16);
  assert.equal(s(36, 4), 'data'); assert.equal(v.getUint32(40, true), 16);
  const pcm = [...Array(8)].map((_, i) => v.getInt16(44 + i * 2, true));
  assert.deepEqual(pcm, [0, 32767, -32768, 16384, 32767, -32768, 0, -16384]);
  assert.equal(encodeWav(new Float32Array(0), 16000).length, 44);
});

test('downmix：多声道取平均，单声道原样返回', () => {
  const a = Float32Array.from([1, 0.5, 0]), b = Float32Array.from([0, 0.5, -1]);
  assert.deepEqual([...downmix([a, b])], [0.5, 0.5, -0.5]);
  assert.equal(downmix([a]), a);
  assert.equal(downmix([]).length, 0);
});
