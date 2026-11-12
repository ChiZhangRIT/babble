// 均衡播放：把录音里每一句话调到差不多的响度——小声的放大、大声的压低，在设备当前音量下每句听起来一样响。
// 纯计算（不碰 DOM、不碰 Web Audio），Node 里也能测：单声道 Float32Array + 采样率 → 新的 Float32Array（原来的不动）。
// 同样的输入永远得到同样的输出（没有随机数）。
//
// 做法：
//   1. 每 10 ms 一帧，算 30 ms 窗口的能量（dBFS）
//   2. 噪声底跟着环境走：前后各 4 秒内能量的第 10 百分位（风扇开了也能跟上），但不超过全段噪声底 + 15 dB（一长段连着说话时不把话当成噪声）
//   3. 比噪声底高 8 dB（且高于 −75 dBFS）的帧算有声；间隔不到 300 ms 的连成一句；太短的（咔哒一声）、能量平平没有起伏的（风扇刚打开）不算
//   4. 每句按有声帧的平均能量算增益，调到 −18 dBFS；最多放大 24 dB。超过 3 秒的长句按前后 1.5 秒滑动算（慢慢变，不跟着每个字忽大忽小）
//   5. 句子之间：不到 600 ms 的停顿保持前后两句里较小的增益（底噪不会一呼一吸）；更长的安静段最多放大 6 dB
//   6. 增益曲线平滑：变小提前开始（响的那句开头不会冲出来），变大在句子开始前升好；句子前后各多留一点（开头的气声、结尾的余音）
//   7. 最后过一个峰值限制器（≤ −1 dBFS，提前压、慢慢放），保证不削波
//
//   levelAudio(x, sampleRate, opts?)     → Float32Array（均衡后的声音）
//   analyzeLoudness(x, sampleRate, opts?) → { hop, frameDb, floorDb, phrases:[{start,end,levelDb,gainDb}], gainDb }（时间单位：秒；gainDb 是每帧最终增益）
//   encodeWav(samples, sampleRate)       → Uint8Array（16 位 PCM 单声道 WAV）
//   downmix(channels)                    → 多声道取平均成单声道
//   rmsDb(x, from?, to?) / peakDb(x, from?, to?)  量一段的响度（测试、诊断用）

export const LEVEL_DEFAULTS = Object.freeze({
  targetDb: -18,        // 每句话调到的响度（有声部分的 RMS）
  maxBoostDb: 24,       // 最多放大
  maxCutDb: 30,         // 最多压低
  noiseBoostDb: 6,      // 长的安静段最多放大这么多
  ceilingDb: -1,        // 峰值上限
  hopMs: 10,            // 帧移
  winHops: 3,           // 能量窗口 = 3 帧（30 ms）
  marginDb: 8,          // 比噪声底高这么多算有声
  absMinDb: -75,        // 再小就当没声音（数字静音、极弱的底噪）
  floorWinSec: 8,       // 噪声底的滑动窗口（前后各一半）
  floorPct: 0.1,        // 噪声底取窗口里的第几百分位
  floorCapDb: 15,       // 噪声底最多比全段噪声底高这么多
  mergeGapMs: 300,      // 有声段间隔短于这个就连成一句
  minPhraseMs: 100,     // 一句至少这么长
  minActiveMs: 80,      // 一句里有声的部分至少这么长（两下咔哒不算一句）
  relGateDb: 12,        // 算一句的响度时，比这句平均低这么多的帧不算
  flatCheckSec: 1.5,    // 这么长以上的「句子」要有起伏（第 10 到 90 百分位至少差 minSpreadDb），平的是环境声
  minSpreadDb: 3,
  holdGapMs: 600,       // 句间停顿短于这个：保持增益
  preRollMs: 50,        // 句子开头往前多留
  postRollMs: 150,      // 句子结尾往后多留（余音）
  longPhraseSec: 3,     // 超过这么长的句子按滑动窗口算响度
  attackDbPerSec: 600,  // 增益变小的最快速度（30 dB / 50 ms）
  releaseDbPerSec: 200, // 增益变大的最快速度（30 dB / 150 ms）
  limitAttackDbPerMs: 3,     // 限制器：压下去的速度（提前开始）
  limitReleaseDbPerMs: 0.15, // 限制器：放回来的速度（12 dB / 80 ms）
});

const EPS = 1e-12;                                   // −120 dB，免得 log(0)
const msToDb = (ms) => 10 * Math.log10(ms + EPS);   // 均方 → dB
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(Math.abs(g), 1e-9));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 一段的 RMS（dBFS）；from/to 是样本下标 */
export function rmsDb(x, from = 0, to = x.length) {
  const a = Math.max(0, Math.floor(from)), b = Math.min(x.length, Math.floor(to));
  if (b <= a) return msToDb(0);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return msToDb(s / (b - a));
}
/** 一段的峰值（dBFS） */
export function peakDb(x, from = 0, to = x.length) {
  const a = Math.max(0, Math.floor(from)), b = Math.min(x.length, Math.floor(to));
  let p = 0;
  for (let i = a; i < b; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
  return gainToDb(p);
}

/** 多声道 → 单声道（取平均）。只有一个声道时原样返回 */
export function downmix(channels) {
  if (!channels || !channels.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map(c => c.length)), out = new Float32Array(n), k = 1 / channels.length;
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] * k;
  return out;
}

// ---------- 分析：能量、噪声底、句子、增益曲线 ----------
export function analyzeLoudness(x, sampleRate, opts = {}) {
  const o = { ...LEVEL_DEFAULTS, ...opts };
  const len = x.length;
  const hop = Math.max(1, Math.round(sampleRate * o.hopMs / 1000));
  const n = Math.max(1, Math.ceil(len / hop));
  const fr = (ms) => Math.max(0, Math.round(ms / o.hopMs));   // 毫秒 → 帧数

  // 1. 每帧均方，再和前后帧平均（30 ms 窗口）
  const blk = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * hop, b = Math.min(len, a + hop);
    let s = 0;
    for (let i = a; i < b; i++) { const v = x[i]; s += v * v; }
    blk[f] = b > a && s >= 0 ? s / (b - a) : 0;              // NaN 当静音
  }
  const half = Math.max(0, (o.winHops - 1) >> 1);
  const ms = new Float64Array(n), db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, f - half); k <= Math.min(n - 1, f + half); k++) { s += blk[k]; c++; }
    ms[f] = s / c;
    db[f] = msToDb(ms[f]);
  }

  // 2. 噪声底：0.5 dB 一格的直方图，滑动窗口取百分位；每 250 ms 算一次，中间线性插值
  const LO = -120, BIN = 0.5, NB = 241;
  const bins = new Int16Array(n);
  for (let f = 0; f < n; f++) bins[f] = clamp(Math.round((db[f] - LO) / BIN), 0, NB - 1);
  // 滑动直方图：窗口 [lo, hi] 里各个能量格的帧数，取百分位
  const slider = () => {
    const hist = new Int32Array(NB);
    let lo = 0, hi = -1;
    return {
      to(wLo, wHi) { while (hi < wHi) hist[bins[++hi]]++; while (lo < wLo) hist[bins[lo++]]--; },
      pct(p) {
        const k = Math.floor(p * (hi - lo));
        let cum = 0;
        for (let i = 0; i < NB; i++) { cum += hist[i]; if (cum > k) return LO + i * BIN; }
        return 0;
      },
    };
  };
  const all = slider();
  all.to(0, n - 1);
  const globalFloor = all.pct(o.floorPct);
  const cap = globalFloor + o.floorCapDb;
  // 每 250 ms 算一次：长窗口的百分位；再看前后 0.75 秒是不是平的（平 = 环境声，不管多响都是噪声底），平的地方往两边各推 0.75 秒
  const W = Math.max(1, fr(o.floorWinSec * 500)), Ws = Math.max(1, fr(o.flatCheckSec * 500)), step = Math.max(1, fr(250));
  const grid = [];
  for (let g = 0; ; g = Math.min(n - 1, g + step)) { grid.push(g); if (g >= n - 1) break; }
  const long = slider(), short = slider(), pctVal = new Float32Array(grid.length), flatVal = new Float32Array(grid.length).fill(-Infinity);
  grid.forEach((g, j) => {
    long.to(Math.max(0, g - W), Math.min(n - 1, g + W));
    pctVal[j] = Math.min(long.pct(o.floorPct), cap);
    short.to(Math.max(0, g - Ws), Math.min(n - 1, g + Ws));
    const p10 = short.pct(0.1);
    if (short.pct(0.9) - p10 < o.minSpreadDb) flatVal[j] = p10;
  });
  const reach = Math.ceil(Ws / step);
  const gridVal = pctVal.map((v, j) => {
    for (let k = Math.max(0, j - reach); k <= Math.min(grid.length - 1, j + reach); k++) if (flatVal[k] > v) v = flatVal[k];
    return v;
  });
  const floor = new Float32Array(n);
  for (let j = 0; j < grid.length; j++) {
    const a = grid[j], b = j + 1 < grid.length ? grid[j + 1] : a;
    for (let f = a; f <= b; f++) floor[f] = b > a ? gridVal[j] + (gridVal[j + 1] - gridVal[j]) * (f - a) / (b - a) : gridVal[j];
  }

  // 3. 有声帧 → 句子（合并短间隔，丢掉太短的）
  const active = new Uint8Array(n);
  for (let f = 0; f < n; f++) active[f] = db[f] > floor[f] + o.marginDb && db[f] > o.absMinDb ? 1 : 0;
  let runs = [];
  for (let f = 0; f < n; f++) {
    if (!active[f]) continue;
    let e = f;
    while (e < n && active[e]) e++;
    const last = runs[runs.length - 1];
    if (last && f - last.e < fr(o.mergeGapMs)) last.e = e; else runs.push({ s: f, e });
    f = e;
  }
  const actCount = (r) => { let c = 0; for (let f = r.s; f < r.e; f++) c += active[f]; return c; };
  // 说话一个字一个字地起伏；风扇、空调刚打开（噪声底还没跟上）那几秒的能量几乎是平的 → 不算一句
  const spread = (r) => { const v = db.slice(r.s, r.e).sort(); return v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)]; };
  runs = runs.filter(r => r.e - r.s >= fr(o.minPhraseMs) && actCount(r) >= fr(o.minActiveMs) && (r.e - r.s < fr(o.flatCheckSec * 1000) || spread(r) >= o.minSpreadDb));

  // 4. 每句的增益（dB）。响度 = 有声帧的平均能量，再只算不比它低 relGateDb 的帧（去掉字与字之间的弱音，
  //    大声、小声的句子同样对待）；长句逐帧按前后 1.5 秒的窗口算
  const gainOf = (level) => clamp(o.targetDb - level, -o.maxCutDb, o.maxBoostDb);
  const levelOf = (a, b) => {
    let s = 0, c = 0;
    for (let f = a; f < b; f++) if (active[f]) { s += ms[f]; c++; }
    if (!c) return null;
    const gate = msToDb(s / c) - o.relGateDb;
    let s2 = 0, c2 = 0;
    for (let f = a; f < b; f++) if (active[f] && db[f] > gate) { s2 += ms[f]; c2++; }
    return msToDb(c2 ? s2 / c2 : s / c);
  };
  const longF = fr(o.longPhraseSec * 1000), halfWin = Math.max(1, longF >> 1);
  const phrases = runs.map(r => {
    const level = levelOf(r.s, r.e);
    const p = { s: r.s, e: r.e, levelDb: level, gainDb: gainOf(level), per: null };
    if (r.e - r.s > longF) {
      p.per = new Float32Array(r.e - r.s);
      for (let f = r.s; f < r.e; f++) {
        const l = levelOf(Math.max(r.s, f - halfWin), Math.min(r.e, f + halfWin + 1));
        p.per[f - r.s] = l == null ? p.gainDb : gainOf(l);
      }
    }
    return p;
  });
  const gAt = (p, f) => (p.per ? p.per[clamp(f, p.s, p.e - 1) - p.s] : p.gainDb);

  // 5. 目标增益曲线：句子（前后多留一点）用句子的增益，重叠处取小的；句间按停顿长短决定
  const T = new Float32Array(n).fill(NaN), inPhrase = new Uint8Array(n);
  const pre = fr(o.preRollMs), post = fr(o.postRollMs);
  for (const p of phrases) {
    for (let f = Math.max(0, p.s - pre); f < Math.min(n, p.e + post); f++) {
      const g = gAt(p, f);
      T[f] = inPhrase[f] ? Math.min(T[f], g) : g;
      inPhrase[f] = 1;
    }
  }
  let overall = 0;
  for (let f = 0; f < n; f++) overall += ms[f];
  const idleGain = clamp(o.targetDb - msToDb(overall / n), -o.maxCutDb, o.noiseBoostDb);   // 整段都没有话
  let next = 0;                                         // 下一句的下标（句子按时间排好、不重叠）
  for (let f = 0; f < n; f++) {
    if (inPhrase[f]) continue;
    let e = f;
    while (e < n && !inPhrase[e]) e++;
    while (next < phrases.length && phrases[next].s < f) next++;
    const L = f > 0 ? phrases[next - 1] : null, R = e < n ? phrases[next] : null;
    let g;
    if (!L && !R) g = idleGain;
    else if (L && R && (R.s - L.e) < fr(o.holdGapMs)) g = Math.min(T[f - 1], T[e]);
    else g = Math.min(L ? T[f - 1] : Infinity, R ? T[e] : Infinity, o.noiseBoostDb);
    for (let k = f; k < e; k++) T[k] = g;
    f = e - 1;
  }

  // 6. 平滑：变小提前开始（倒着走，每帧最多降 down）；安静段里在句子前提前升好；变大每帧最多升 up
  const down = o.attackDbPerSec * o.hopMs / 1000, up = o.releaseDbPerSec * o.hopMs / 1000;
  const G = Float32Array.from(T);
  for (let f = n - 2; f >= 0; f--) G[f] = Math.min(G[f], G[f + 1] + down);
  for (let f = n - 2; f >= 0; f--) if (!inPhrase[f]) G[f] = Math.max(G[f], G[f + 1] - up);
  for (let f = 1; f < n; f++) G[f] = Math.min(G[f], G[f - 1] + up);

  const sec = (f) => f * hop / sampleRate;
  return {
    hop, sampleRate, frameDb: db, floorDb: floor, globalFloorDb: globalFloor, gainDb: G,
    phrases: phrases.map(p => ({ start: sec(p.s), end: sec(p.e), levelDb: p.levelDb, gainDb: p.gainDb })),
  };
}

/** 按每帧增益（dB）放大/压低：帧中心之间线性插值，没有台阶 */
export function applyGain(x, gainDb, hop) {
  const len = x.length, n = gainDb.length, out = new Float32Array(len);
  if (!len) return out;
  const lin = new Float32Array(n);
  for (let f = 0; f < n; f++) lin[f] = dbToGain(gainDb[f]);
  let i = 0;
  for (const end = Math.min(len, Math.ceil(hop / 2)); i < end; i++) out[i] = x[i] * lin[0];
  for (let f = 0; f < n - 1 && i < len; f++) {
    const a = (f + 0.5) * hop, g0 = lin[f], dg = (lin[f + 1] - g0) / hop;
    for (const end = Math.min(len, Math.ceil(a + hop)); i < end; i++) out[i] = x[i] * (g0 + dg * (i - a));
  }
  for (; i < len; i++) out[i] = x[i] * lin[n - 1];
  return out;
}

/**
 * 峰值限制器（原地修改 y）：每 32 个样本一块，算出每块要压多少；
 * 每块的值不高于左右相邻块的要求，所以块中心之间插值也一定压够；倒着走让压缩提前开始，顺着走让放开慢一点。
 * 最后再硬卡一次（只防浮点误差）。
 */
export function limitPeaks(y, sampleRate, opts = {}) {
  const o = { ...LEVEL_DEFAULTS, ...opts };
  const ceil = dbToGain(o.ceilingDb), B = 32, len = y.length, nb = Math.ceil(len / B);
  if (!len) return y;
  const req = new Float32Array(nb);
  let any = false;
  for (let b = 0; b < nb; b++) {
    let p = 0;
    for (let i = b * B, end = Math.min(len, i + B); i < end; i++) { const v = Math.abs(y[i]); if (v > p) p = v; }
    if (p > ceil) { req[b] = 20 * Math.log10(ceil / p); any = true; }
  }
  if (any) {
    const r = new Float32Array(nb);
    for (let b = 0; b < nb; b++) r[b] = Math.min(req[b], b > 0 ? req[b - 1] : 0, b + 1 < nb ? req[b + 1] : 0);
    const blockMs = B * 1000 / sampleRate, atk = o.limitAttackDbPerMs * blockMs, rel = o.limitReleaseDbPerMs * blockMs;
    for (let b = nb - 2; b >= 0; b--) r[b] = Math.min(r[b], r[b + 1] + atk);
    for (let b = 1; b < nb; b++) r[b] = Math.min(r[b], r[b - 1] + rel);
    const lin = new Float32Array(nb);
    for (let b = 0; b < nb; b++) lin[b] = r[b] < 0 ? dbToGain(r[b]) : 1;
    let i = 0;
    for (const end = Math.min(len, B / 2); i < end; i++) y[i] *= lin[0];
    for (let b = 0; b < nb - 1 && i < len; b++) {
      const a = (b + 0.5) * B, g0 = lin[b], dg = (lin[b + 1] - g0) / B;
      if (g0 === 1 && dg === 0) { i = Math.min(len, Math.ceil(a + B)); continue; }
      for (const end = Math.min(len, Math.ceil(a + B)); i < end; i++) y[i] *= g0 + dg * (i - a);
    }
    for (; i < len; i++) y[i] *= lin[nb - 1];
  }
  for (let i = 0; i < len; i++) { const v = y[i]; if (v > ceil) y[i] = ceil; else if (v < -ceil) y[i] = -ceil; else if (v !== v) y[i] = 0; }
  return y;
}

/** 均衡：分析 → 按句调增益 → 限制峰值。返回新的 Float32Array，x 不动 */
export function levelAudio(x, sampleRate, opts = {}) {
  const a = analyzeLoudness(x, sampleRate, opts);
  return limitPeaks(applyGain(x, a.gainDb, a.hop), sampleRate, opts);
}

/** 16 位 PCM 单声道 WAV（小端）。超出 ±1 的削掉，NaN 当 0 */
export function encodeWav(samples, sampleRate) {
  const n = samples.length, size = 44 + n * 2;
  const buf = new ArrayBuffer(size), v = new DataView(buf);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, size - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const pcm = little ? new Int16Array(buf, 44, n) : null;
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    s = s > 1 ? 1 : s < -1 ? -1 : s === s ? s : 0;
    const q = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    if (pcm) pcm[i] = q; else v.setInt16(44 + i * 2, q, true);
  }
  return new Uint8Array(buf);
}
