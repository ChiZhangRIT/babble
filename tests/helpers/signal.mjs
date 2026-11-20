// 床头模式测试用的合成信号（不用真录音）：固定种子的噪声、正弦、「像说话」的谐波，都按整段 RMS（dBFS）给响度。默认 16 kHz
export const SR = 16000;
export const at = (sec, sr = SR) => Math.round(sec * sr);
export const gain = (db) => Math.pow(10, db / 20);

/** 固定种子的伪随机数（LCG），−1..1 */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
export const silence = (sec, sr = SR) => new Float32Array(at(sec, sr));

/** 白噪声，RMS = db */
export function noise(sec, db, seed = 7, sr = SR) {
  const r = rng(seed), g = gain(db) * Math.sqrt(3), x = silence(sec, sr);
  for (let i = 0; i < x.length; i++) x[i] = r() * g;
  return x;
}
/** 正弦，RMS = db */
export function tone(sec, db, hz, sr = SR) {
  const g = gain(db) * Math.SQRT2, x = silence(sec, sr);
  for (let i = 0; i < x.length; i++) x[i] = g * Math.sin(2 * Math.PI * hz * i / sr);
  return x;
}
/** 像说话：150 Hz 基频的 4 个谐波（150–600 Hz），4 Hz 一个「字」，每个字后 30% 的时间停顿；整段 RMS = db */
export function speechy(sec, db, sr = SR) {
  const x = silence(sec, sr), syl = 0.25, on = 0.7 * syl;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, ph = t % syl;
    if (ph >= on) continue;
    let v = 0;
    for (let k = 1; k <= 4; k++) v += Math.sin(2 * Math.PI * 150 * k * t + k) / k;
    x[i] = v * Math.sin(Math.PI * ph / on) ** 2;
  }
  return scale(x, db);
}
export function rmsDb(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-12);
}
function scale(x, db) { const g = gain(db - rmsDb(x)); for (let i = 0; i < x.length; i++) x[i] *= g; return x; }

export function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** b 叠到 a 上（从 a 的 offset 样本开始），返回新的 */
export function mix(a, b, offset = 0) {
  const out = Float32Array.from(a);
  for (let i = 0; i < b.length && offset + i < out.length; i++) out[offset + i] += b[i];
  return out;
}
/** 切成整块（每块是拷贝，可以 transfer）；最后不满一块的丢掉 */
export function blocks(f32, n = 4096) {
  const out = [];
  for (let o = 0; o + n <= f32.length; o += n) out.push(f32.slice(o, o + n));
  return out;
}
