// 语音转文字（草稿）：在这台设备上用 Whisper 把录音识别成文字，录音不离开设备（只有模型第一次用时从 Hugging Face 下载）。
// 结果只进条目的「草稿」（entry.draft），永远不改原话；用户点「填进原话」才写进去。
//
// 纯计算（Node 测试能 import，不碰 DOM）：
//   MODELS / modelFiles / modelPrefix        两种模型（标准 = whisper-base，更准 = whisper-small）和各自要下载的文件
//   isMobileDevice / modelAllowed / pickEngine   用显卡（WebGPU）还是处理器（WASM）；iPhone / iPad 只用处理器、只给标准
//   speechSegments(pcm, sr)                   按说话分段（按能量）：只把有人说话的地方交给 Whisper（静音、杂音会让它编出「谢谢观看」，
//                                             它自带的 30 秒分块又会整句漏掉），每段 ≤ 28 秒、单独识别。说话识别用不了时用它
//   findSpeech(pcm, { vad })                  用说话识别（Silero VAD，和床头模式同一个）找说话的地方，窗口和 speechSegments 一个样子；
//                                             frameDbs / bandDbs / rollingFloor / pregate（先按能量跳过静音）、vadGainDb、speechRuns 是它的几步；
//                                             nextTask() 让出一拍（不用计时器，m4a.js 也用）
//   cleanText(raw, { simplify })              整理：繁→简（界面是繁体时不转）、去掉编出来的字幕套话、去掉卡住的重复、标点换成全角
//   mergeDraft / draftToDialogue / appendText / sourceOf / parseSource   合进草稿、填进原话、草稿来源
// 浏览器（用到时才碰 Worker / OfflineAudioContext / caches）：
//   transcribe(o) → Promise<{ text, lines, model, engine, ms, segs, finder }>   一次只跑一个；先找说话的地方（说话识别的 worker 用完就关），
//                                             再开 Whisper 的 worker；cancel() 立刻结束正在用的 worker（内存马上还回去）
//   downloadModel(o)                          只下载、载入一次模型（设置页「现在下载」）
//   job() / onJob(fn)                         正在跑（或刚结束）的任务，页面离开再回来也能接着显示进度
//   modelCacheInfo(model) / deleteModel(model)   transformers.js 自己的缓存（Cache Storage「transformers-cache」）里这个模型占多少、删掉
//   probeGpu() / decode16k(blob) / decodeMono(blob, { sr })
//
// 第三方文件在 vendor/transformers/（transformers.js 4.3.2 + onnxruntime-web 的 wasm，见那里的 README），worker 是 src/workers/transcribe.worker.js。
// 实测（Mac 上的 WKWebView，单线程）：标准 + 处理器 + q8 下载约 80 MB、峰值内存约 0.7 GB，每个 ≤ 30 秒的片段约 2 秒（iPhone 估计 3–4 秒）；
// 更准在处理器上约 1.6 GB，超过 iPhone 网页的内存上限，所以只给 Mac；iPhone / iPad 也不用 WebGPU（显存算在网页头上，峰值 2.5 GB 以上）。
import { toSimplified } from './hanzi.js';
import { speakerOf } from './dialogue.js';
import { createVad, STEP } from './vad.js';

export const SR = 16000;
export const HF = 'https://huggingface.co/';
export const MODEL_CACHE = 'transformers-cache';     // transformers.js 自己的缓存名（同域名下别的 App 也可能用），只动自己模型的那几项

// 版本固定（仓库会更新：base 在 2026-11-02 改过），缓存地址里也带着版本号
export const MODELS = {
  base: { key: 'base', repo: 'onnx-community/whisper-base', revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c', mobile: true,
    wasm: { dtype: 'q8', bytes: 79664191 },
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, bytes: 208840059 } },
  small: { key: 'small', repo: 'onnx-community/whisper-small', revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732', mobile: false,
    wasm: { dtype: 'q8', bytes: 251846613 },
    webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, bytes: 412526691 } },
};
export const MODEL_KEYS = Object.keys(MODELS);
export const DEFAULT_MODEL = 'base';
export const ENGINES = ['wasm', 'webgpu'];
const JSONS = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };

/** 这个模型在这种后端下要下载的文件（相对仓库的路径） */
export function modelFiles(key, engine) {
  const d = MODELS[key][engine].dtype;
  const dt = (part) => (typeof d === 'string' ? d : d[part]);
  return [...JSONS, ...['encoder_model', 'decoder_model_merged'].map(p => `onnx/${p}${SUFFIX[dt(p)] ?? ''}.onnx`)];
}
/** 缓存里这个模型（这个版本）的地址前缀；repoPrefix 是所有版本 */
export const modelPrefix = (key) => `${HF}${MODELS[key].repo}/resolve/${MODELS[key].revision}/`;
export const repoPrefix = (key) => `${HF}${MODELS[key].repo}/resolve/`;

// ---------- 设备 ----------

/** iPhone / iPad（含「请求桌面网站」的 iPad）/ 安卓：内存紧，只用处理器、只给标准 */
export function isMobileDevice(nav = globalThis.navigator) {
  if (!nav) return false;
  return /iPhone|iPad|iPod|Android/i.test(String(nav.userAgent || '')) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}
/** 更准在 iPhone / iPad 上没实机验证过、内存估计不够：先不给 */
export const modelAllowed = (key, { mobile = false } = {}) => !!MODELS[key] && (!mobile || MODELS[key].mobile);
/**
 * 用什么跑：手机、没有 WebGPU、用户关了「用显卡加速」→ 处理器（wasm）；
 * 更准的编码器是 fp16，显卡还要支持 shader-f16，不支持也用处理器。
 */
export function pickEngine(key, { mobile = false, gpu = false, f16 = false, useGpu = true } = {}) {
  if (mobile || !gpu || !useGpu) return 'wasm';
  if (key === 'small' && !f16) return 'wasm';
  return 'webgpu';
}

// ---------- 按说话分段 ----------

/**
 * 找出有人说话的地方 → 识别窗口 [[起, 止), …]（样本下标）。
 * 30 ms 一帧算响度；噪声底取较安静的 15% 分位，往上 6–10 dB 算有声（最低 -55 dBFS）；停顿 < 0.6 秒的并在一起，
 * 有声不到 0.25 秒的当咔哒声丢掉，前后各留 0.25 秒；相邻的再合成窗口（停顿 ≤ 1.5 秒、窗口 ≤ 20 秒），一个窗口是一行；
 * 一口气超过 28 秒的在 20–28 秒之间最安静的地方切开（Whisper 一次只看 30 秒）。
 * 「响」取 95% 分位；说话不到整段的 5%（10 分钟里只说了二十几秒）时它还落在噪声里，这时看最响的 0.25 秒是不是明显高出一截。
 * 整段差不多一样响：很响（≥ -30 dBFS）当作一直在说，否则当作只有杂音 / 静音（不识别，免得它编字幕套话）。
 * @param {Float32Array} pcm 单声道
 * @param {number} [sr]
 * @returns {Array<[number, number]>}
 */
export function speechSegments(pcm, sr = SR, o = {}) {
  const { frameSec = 0.03, gapSec = 0.6, padSec = 0.25, minSec = 0.25, joinSec = 1.5, windowSec = 20, maxSec = 28 } = o;
  const len = pcm.length, F = Math.max(1, Math.round(sr * frameSec)), n = Math.floor(len / F);
  if (n < 2) return [];
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * F, end = j + F; j < end; j++) e += pcm[j] * pcm[j];
    db[i] = 10 * Math.log10(e / F + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const pct = (q) => sorted[Math.min(n - 1, Math.floor(n * q))];
  const floor = pct(0.15), loud = pct(0.95), K = Math.ceil(minSec / frameSec);
  let thr = Math.max(floor + Math.min(10, Math.max(6, (loud - floor) / 2)), -55), minOn = 1, spans;
  if (loud - floor < 8) {
    // 95% 分位还在噪声里：要么说话不到整段的 5%（长录音里只说了几句），要么整段一样响 / 只有杂音。
    // 最响的 0.25 秒比噪声底高 8 dB、也比 95% 分位高 6 dB 才算有人说话（鼾声、呼吸、慢慢起伏的杂音只是噪声里偏响的那头，过不了）；
    // 很响的整段只有特别平（风扇、白噪声机）才这样找，不然还是当作一直在说
    const peak = sorted[Math.max(0, n - K)];
    if (peak - floor >= 8 && peak - loud >= 6 && (loud < -30 || loud - floor < 3)) {
      thr = Math.max(floor + 6, loud + 3, -55);
      minOn = K;                                // 每段里真正响的帧也要凑够 0.25 秒，零星的杂音帧连不成一段
    } else if (loud >= -30) spans = [[0, len]];
    else return [];
  }
  if (!spans) {
    const gapF = Math.round(gapSec / frameSec), pad = Math.round(padSec * sr);
    const runs = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (db[i] <= thr) continue;
      if (cur && i - cur[1] <= gapF) { cur[1] = i; cur[2]++; }
      else { if (cur) runs.push(cur); cur = [i, i, 1]; }
    }
    if (cur) runs.push(cur);
    spans = runs.filter(([a, b, on]) => (b - a + 1) * frameSec >= minSec && on >= minOn).map(([a, b]) => [Math.max(0, a * F - pad), Math.min(len, (b + 1) * F + pad)]);
  }
  return windowsOf(spans, db, F, sr, { joinSec, windowSec, maxSec, minSec });
}

/**
 * 有说话的地方（样本下标，已经前后留好余量、按顺序）→ 识别窗口：停顿 ≤ joinSec 且合起来 ≤ windowSec 的并成一个窗口；
 * 超过 maxSec 的在 windowSec–maxSec 之间最安静的那帧切开（db：每帧 F 个样本的能量）；剩下不到 minSec 的丢掉。
 * speechSegments（按能量）和 findSpeech（说话识别）共用，两边交给 Whisper 的窗口是一个样子
 */
function windowsOf(spans, db, F, sr, { joinSec, windowSec, maxSec, minSec }) {
  const n = db.length, joined = [];
  for (const [s, e] of spans) {
    const last = joined[joined.length - 1];
    if (last && (s <= last[1] || (s - last[1] <= joinSec * sr && e - last[0] <= windowSec * sr))) last[1] = Math.max(last[1], e);
    else joined.push([s, e]);
  }
  // 太长的切开
  const out = [], maxLen = maxSec * sr, winLen = windowSec * sr;
  for (let [s, e] of joined) {
    while (e - s > maxLen) {
      const fa = Math.ceil((s + winLen) / F), fb = Math.min(n, Math.floor((s + maxLen) / F));
      let best = fb, bv = Infinity;
      for (let f = fa; f < fb; f++) if (db[f] < bv) { bv = db[f]; best = f; }
      const cut = Math.min(Math.max(best * F, s + F), s + maxLen);
      out.push([s, cut]);
      s = cut;
    }
    if (e - s >= minSec * sr) out.push([s, e]);
  }
  return out;
}

// ---------- 用说话识别（Silero VAD）找说话的地方 ----------
// 只按能量分段时，鼾声、翻身、风扇里起伏的杂音也会当成说话交给 Whisper（又慢，又会编出字来）；小声嘀咕在风扇声里又容易漏掉。
// 所以先用床头模式那个说话识别（core/vad.js + workers/vad.worker.js，1.3 MB，每 32 ms 一个概率）找说话的地方，再照 speechSegments 的规矩合成窗口。
// 快：先按能量跳过明显的静音（门限低、余量大，宁可多跑也不漏），只在剩下的地方跑说话识别；
// 小声：和床头模式一样，只把给识别的这份放大（噪声底拉到 −40 dBFS、最多 +30 dB、峰值不超过 −1 dBFS），交给 Whisper 的还是原来的声音。
// 说话识别载入不了、跑到一半坏了、卡住了 → 照旧按能量分段（speechSegments）。识别用的 worker 在 Whisper 载入之前一定关掉（两个模型不同时占内存）。
// 实测（Node，Mac M4 Max，单线程 WASM，真模型；TTS 的话 + 合成的风扇、白噪声机、鼾声）：说话识别一步约 0.15 毫秒，交给它的每分钟约 0.3 秒；
// 先按能量挑这一步每分钟约 10 毫秒（每算 1 分钟让出一次主线程，30 分钟的录音页面最多卡 40 毫秒左右，一次算完要卡 0.4 秒）。
// 安静的屋里、风扇、白噪声机里没人说话 → 一帧都不跑；10 分钟里说了一分钟 → 每分钟约 20–50 毫秒；
// 一直打鼾（占 30%）→ 跑六成多，每分钟约 0.3 秒；整夜听得见呼吸声（比底噪高 6 dB；安静的屋里比宽带的底噪还低 10 dB 的也是）→ 几乎全跑，每分钟约 0.4 秒
//（呼吸一下一下隔 1.5 秒左右，前后放宽、隔 ≤ 1 秒连起来以后就连成一整片）。和只按能量比：鼾声、风扇里送去识别的从几十秒降到 1 秒以内，
// 白噪声机、风扇里比噪声还小声的话从找不到（0%）变成找到 80–100%。iPhone 没量过（估计一步 0.2–1 毫秒）。
export const FIND = Object.freeze({
  FRAME: STEP,                                            // 一帧 512 个样本（32 ms），和说话识别一步一样
  FLOOR_SEC: 30, FLOOR_PCT: 0.10,                         // 噪声底：前后各 15 秒里每帧能量的第 10 百分位
  PRE_BANDS: Object.freeze([[250, 700, 4], [700, 1800, 2], [1800, 4500, 1.5]].map(Object.freeze)),   // 先按能量挑：三个频带（二阶带通）里
  PRE_EMPH: Object.freeze([0.97, 1.5]),                   //   有一个比它自己的噪声底高出门限（dB），或者预加重（y = x[i] − 0.97·x[i−1]）以后高 1.5 dB，或者本身 ≥ −30 dBFS；
  PRE_ABS_DB: -30,                                        //   连着两帧才算（噪声偶尔一帧冒头不算）
  PRE_PAD_SEC: 0.75, PRE_JOIN_SEC: 1,                     //   前后各放宽 0.75 秒，隔 ≤ 1 秒的连起来
  PRE_SLICE_SEC: 60,                                      //   长录音每算 60 秒让出一次主线程（页面不卡、能取消）
  GAIN_TARGET_DB: -40, GAIN_MAX_DB: 30, GAIN_BLOCK: 4096, // 只给识别的那份放大（和床头模式 nightDetect.js 的 VAD_GAIN_* 一样，每 4096 个样本算一次）
  ENTER: 0.30, EXIT: 0.15,                                // 迟滞：≥ 0.30 进、< 0.15 出（和床头模式一样）
  MERGE_SEC: 0.3, MIN_SEC: 0.25,                          // 停顿 ≤ 0.3 秒的连成一句；隔得近的几句（和下面合成窗口一个规矩）真正在说的加起来不到 0.25 秒就丢掉
                                                          //（咔哒声、一两帧像说话的鼾声）。一句一句地看会把小声嘀咕的一串短音节（每个只有几帧）全丢掉
  PAD_SEC: 0.25, JOIN_SEC: 1.5, WINDOW_SEC: 20, MAX_SEC: 28,   // 合成识别窗口：和 speechSegments 一样
  IDLE_RESET_SEC: 2,                                      // 说过话以后 2 秒没听到说话 → 清一次识别的状态（大声说完以后它对紧跟着的小声会变迟钝）
  QUIET_RESET: true,                                      // 一整块都不像说话（< 0.15）也清一次：鼾声之后它对紧跟着的小声几乎全给 0
  CHUNK: 16384,                                           // 一次交给 worker 1 秒（32 步）
  LOAD_MS: 60000, CHUNK_MS: 10000,                        // 载入 60 秒（第一次用要下载约 16 MB，Whisper 也要用这些）、一块 10 秒还没回 → 当识别用不了，按能量
  SHOW_MS: 400,                                           // 找了 0.4 秒还没找完才显示「找说话的地方…」（短录音不闪一下）
});

const toDb = (e, F) => { const v = 10 * Math.log10(e / F + 1e-12); return v > -120 ? v : -120; };     // NaN 也当 −120

/** 每帧（F 个样本）的能量 dBFS（≥ −120；不满一帧的尾巴不算）。给了 db、[i0, i1)：只算这几帧、写进 db（长录音分几次算） */
export function frameDbs(pcm, F = FIND.FRAME, db = new Float32Array(Math.floor(pcm.length / F)), i0 = 0, i1 = db.length) {
  for (let i = i0; i < i1; i++) {
    let e = 0;
    for (let j = i * F, end = j + F; j < end; j++) e += pcm[j] * pcm[j];
    db[i] = toDb(e, F);
  }
  return db;
}

/**
 * 每帧在几个频带里的能量（dBFS）→ Float32Array[]：bands 里每个一个（[[低 Hz, 高 Hz], …]，二阶带通，RBJ，峰值 0 dB），
 * 给了 emph 再加一个预加重（y = x[i] − emph·x[i−1]）的。
 * 分开看频带：白噪声机、风扇这种平稳的宽带噪声里，小声说话的整体能量几乎不变，但在它集中的那个频带里看得出来（悄悄话在预加重的高频里）；
 * 风扇、空调、车声低频的起伏（帧和帧之间差十几 dB）也不进这几个频带
 */
export function bandDbs(pcm, F = FIND.FRAME, sr = SR, bands = FIND.PRE_BANDS, emph = 0) {
  const m = bandMeter(pcm, F, sr, bands, emph);
  m.run(0, m.out[0].length);
  return m.out;
}

/** bandDbs 分几次算：→ { out, run(i0, i1) }，run 按顺序一段接一段（滤波器的状态接着上一段），结果和一次算完一样 */
function bandMeter(pcm, F, sr, bands, emph) {
  const n = Math.floor(pcm.length / F), K = bands.length, out = [...bands, ...(emph ? [0] : [])].map(() => new Float32Array(n));
  const co = new Float64Array(K * 3);                                // 每个频带 b0（b1 = 0、b2 = −b0）、a1、a2
  bands.forEach(([lo, hi], k) => {
    const w = 2 * Math.PI * Math.sqrt(lo * hi) / sr, sw = Math.sin(w), al = sw * Math.sinh((Math.LN2 / 2) * Math.log2(hi / lo) * w / sw), a0 = 1 + al;
    co.set([al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0], k * 3);
  });
  const st = new Float64Array(K * 2), e = new Float64Array(K + 1);    // 每个频带的 y[n−1]、y[n−2]；每个频带这一帧的能量
  let x1 = 0, x2 = 0;
  const run = (i0, i1) => { for (let i = i0; i < i1; i++) {
    e.fill(0);
    for (let j = i * F, end = j + F; j < end; j++) {
      let x = pcm[j];
      if (!(x === x && x !== Infinity && x !== -Infinity)) x = 0;
      const d = x - x2, h = x - emph * x1;
      for (let k = 0, c = 0, q = 0; k < K; k++, c += 3, q += 2) {
        const y1 = st[q], y = co[c] * d - co[c + 1] * y1 - co[c + 2] * st[q + 1];
        st[q + 1] = y1; st[q] = y;
        e[k] += y * y;
      }
      e[K] += h * h;
      x2 = x1; x1 = x;
    }
    for (let k = 0; k < out.length; k++) out[k][i] = toDb(e[k], F);
  } };
  return { out, run };
}

/** 每帧的噪声底：以这帧为中心 win 帧里的第 pct 分位（0.5 dB 一格的直方图滑过去，长录音也快） */
export function rollingFloor(db, win, pct = FIND.FLOOR_PCT) {
  const m = floorMeter(db, win, pct);
  m.run(0, db.length);
  return m.out;
}

/** rollingFloor 分几次算：→ { out, run(i0, i1) }，run 按顺序一段接一段（db 要已经算完） */
function floorMeter(db, win, pct) {
  const n = db.length, half = Math.max(1, Math.floor(win / 2)), B = 242, hist = new Int32Array(B), out = new Float32Array(n);
  const bin = (v) => Math.max(0, Math.min(B - 1, Math.floor((v + 120) * 2)));
  let lo = 0, hi = 0, count = 0;                         // 窗口 [lo, hi)
  const run = (i0, i1) => { for (let i = i0; i < i1; i++) {
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    while (hi < b) { hist[bin(db[hi++])]++; count++; }
    while (lo < a) { hist[bin(db[lo++])]--; count--; }
    const want = Math.floor(count * pct);
    let k = 0, c = hist[0];
    while (c <= want && k < B - 1) c += hist[++k];
    out[i] = k / 2 - 120 + 0.25;
  } };
  return { out, run };
}

/** 让出一拍、不用计时器（MessageChannel：页面在后台也不会被放慢）；没有 MessageChannel 才用 setTimeout */
export const nextTask = () => new Promise((resolve) => {
  if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

/**
 * 先按能量挑出要交给说话识别的地方 → [[起, 止), …]（样本下标，都是一帧 512 的整数倍）。
 * 门限故意低，前后各放宽 0.75 秒，隔 ≤ 1 秒的连起来：只跳过明显的静音和平稳的底噪，有一点动静都交给说话识别去判断。
 * 一帧算有动静：哪个频带比它自己的噪声底高出那个频带的门限，或者本身就不小声（≥ PRE_ABS_DB），而且前一帧或后一帧也是（噪声偶尔冒头的一帧不算）。
 * 数字静音（−120）的帧不算
 * @param {Float32Array} db   frameDbs 的结果
 * @param {Array<{ db: Float32Array, floor: Float32Array, thr: number }>} bands   bandDbs 的结果、各自的 rollingFloor 和门限
 */
export function pregate(db, bands, sr = SR, o = {}) {
  const { FRAME: F, PRE_ABS_DB, PRE_PAD_SEC, PRE_JOIN_SEC } = { ...FIND, ...o };
  const n = db.length, pad = Math.round(PRE_PAD_SEC * sr / F), join = Math.round(PRE_JOIN_SEC * sr / F), out = [];
  const hit = (i) => i >= 0 && i < n && db[i] > -120 && (db[i] >= PRE_ABS_DB || bands.some(b => b.db[i] >= b.floor[i] + b.thr));
  for (let i = 0, prev = false, cur = hit(0); i < n; i++) {
    const next = hit(i + 1), ok = cur && (prev || next);
    prev = cur; cur = next;
    if (!ok) continue;
    const a = Math.max(0, i - pad), b = Math.min(n, i + pad + 1), last = out[out.length - 1];
    if (last && a - last[1] <= join) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [a * F, b * F]);
}

/** 只给识别的这份放大多少 dB：噪声底拉到 −40 dBFS，最多 +30 dB，峰值不超过 −1 dBFS（和床头模式一样） */
export function vadGainDb(floorDb, peak, o = {}) {
  const { GAIN_TARGET_DB, GAIN_MAX_DB } = { ...FIND, ...o };
  const room = peak > 0 ? -1 - 20 * Math.log10(peak) : Infinity;
  return Math.max(0, Math.min(GAIN_MAX_DB, GAIN_TARGET_DB - floorDb, room));
}

/**
 * 每帧的概率 → 说话的地方 [[起帧, 止帧), …]：迟滞（≥ 0.30 进、< 0.15 出），停顿 ≤ 0.3 秒的连成一句；
 * 隔得近的几句算一堆（前后各留 PAD_SEC 以后停顿 ≤ JOIN_SEC：和合成识别窗口一个规矩，这一堆本来就会进同一个窗口），
 * 一堆里在说的帧加起来凑不够 0.25 秒才丢掉。小声嘀咕的「不要…嗯…不要」每个音节只有几帧，单看都太短，连在一起就留下；
 * 单独的一两帧（咔哒声、像说话的鼾声）照样丢。实测（真模型，合成的悄悄话 + −63 dBFS 的卧室）：三个隔 0.4–0.8 秒的悄悄话音节（−46 dBFS）
 * 找到的从 17 / 72 个变成 43 / 72；10 分钟的鼾声、风扇、翻身、呼吸声里没多出一个窗口；离说话 2 秒以内的鼾声会跟着进那个窗口（每 90 秒多送约 0.5 秒）
 */
export function speechRuns(probs, sr = SR, o = {}) {
  const { FRAME: F, ENTER, EXIT, MERGE_SEC, MIN_SEC, PAD_SEC, JOIN_SEC } = { ...FIND, ...o };
  const merge = Math.round(MERGE_SEC * sr / F), minOn = Math.ceil(MIN_SEC * sr / F), runs = [];
  let on = false, cur = null;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!on && p >= ENTER) on = true;
    else if (on && !(p >= EXIT)) on = false;            // NaN 当没在说
    if (!on) continue;
    if (cur && i - cur[1] <= merge) { cur[1] = i + 1; cur[2]++; }
    else { if (cur) runs.push(cur); cur = [i, i + 1, 1]; }
  }
  if (cur) runs.push(cur);
  const gap = (JOIN_SEC * sr + 2 * Math.round(PAD_SEC * sr)) / F, out = [];   // 两句之间隔这么多帧以内（2 秒）：进同一个窗口
  for (let i = 0; i < runs.length;) {
    let j = i, on = runs[i][2];
    while (j + 1 < runs.length && runs[j + 1][0] - runs[j][1] <= gap) on += runs[++j][2];
    if (on >= minOn) for (let k = i; k <= j; k++) out.push([runs[k][0], runs[k][1]]);
    i = j + 1;
  }
  return out;
}

const within = (p, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(what + ' timeout')), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * 找说话的地方 → { segs: 识别窗口（和 speechSegments 一样）, finder: 'vad' | 'energy', ran: 交给说话识别的样本数, error }
 * 说话识别用不了（没给、载入不了、出错、卡住、给的概率不对）→ finder 'energy'，segs = speechSegments(pcm)，error 写原因。
 * 不管怎样结束，vad 都在返回之前 close（Whisper 载入前把内存还回去）。
 * @param {Float32Array} pcm  16 kHz 单声道
 * @param {object} o
 * @param {object|null} o.vad    createVad() 那样的对象（load / push / reset / close）；null → 直接按能量
 * @param {() => void} [o.check] 每一块之前调一次：取消了就抛出来（不当作识别坏了，原样往外抛）
 * @param {(done: number, total: number) => void} [o.onProgress]   交给识别的样本数：做了多少 / 一共多少
 * @param {number} [o.loadMs] [o.chunkMs]   载入、每块最多等多久
 */
export async function findSpeech(pcm, { vad = null, sr = SR, check = () => {}, onProgress = null, loadMs = FIND.LOAD_MS, chunkMs = FIND.CHUNK_MS, ...o } = {}) {
  const c = { ...FIND, ...o }, F = c.FRAME;
  const energy = (error) => ({ segs: speechSegments(pcm, sr), finder: 'energy', ran: 0, error: error || null });
  if (!vad) return energy(null);
  let ran = 0;
  try {
    const n = Math.floor(pcm.length / F);
    if (n < 2) return { segs: [], finder: 'vad', ran: 0, error: null };
    // 先按能量挑：长录音每算 PRE_SLICE_SEC 让出一次主线程（不然 30 分钟的录音页面要卡一两秒、也取消不了），算出来和一次算完一样
    const slice = Math.max(1, Math.round(c.PRE_SLICE_SEC * sr / F));
    const each = async (fn) => { for (let i = 0; i < n; i += slice) { const j = Math.min(n, i + slice); fn(i, j); if (j < n) { await nextTask(); check(); } } };
    const db = new Float32Array(n), bm = bandMeter(pcm, F, sr, c.PRE_BANDS, c.PRE_EMPH ? c.PRE_EMPH[0] : 0);
    await each((i, j) => { frameDbs(pcm, F, db, i, j); bm.run(i, j); });
    const win = Math.round(c.FLOOR_SEC * sr / F), fm = [db, ...bm.out].map(x => floorMeter(x, win, c.FLOOR_PCT));
    await each((i, j) => { for (const m of fm) m.run(i, j); });
    const floor = fm[0].out, thr = [...c.PRE_BANDS.map(b => b[2]), ...(c.PRE_EMPH ? [c.PRE_EMPH[1]] : [])];
    const bands = bm.out.map((b, k) => ({ db: b, floor: fm[k + 1].out, thr: thr[k] }));
    const regions = pregate(db, bands, sr, c);
    const total = regions.reduce((s, [a, b]) => s + b - a, 0);
    const probs = new Float32Array(n);                    // 跳过的地方当 0（没在说）
    if (total) {
      check();
      const ok = await within(vad.load(), loadMs, 'vad load');
      check();
      if (!ok) return energy('load');
      const idle = Math.round(c.IDLE_RESET_SEC * sr / F);
      for (const [a, b] of regions) {
        vad.reset();                                      // 不连着的地方：状态和前 64 个样本从 0 开始
        let on = false, armed = false, quiet = 0, still;
        for (let s = a; s < b; s += c.CHUNK) {
          check();
          const e = Math.min(b, s + c.CHUNK), x = pcm.slice(s, e);
          for (let k = 0; k < x.length; k += c.GAIN_BLOCK) {
            const end = Math.min(x.length, k + c.GAIN_BLOCK);
            let m = 0;
            for (let i = k; i < end; i++) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > m) m = v; }
            const g = vadGainDb(floor[Math.min(n - 1, Math.floor((s + (k + end) / 2) / F))], m, c);
            if (g > 0) { const kk = 10 ** (g / 20); for (let i = k; i < end; i++) x[i] *= kk; }
          }
          const want = (e - s) / F, pr = await within(vad.push(x), chunkMs, 'vad push');     // x 转交给 worker 了
          check();
          if (!pr || pr.length !== want) return energy('run');
          still = true;
          for (let i = 0; i < want; i++) {
            const p = pr[i];
            if (!Number.isFinite(p)) return energy('nan');
            probs[s / F + i] = p;
            if (!on && p >= c.ENTER) on = true; else if (on && p < c.EXIT) on = false;
            if (on) { armed = true; quiet = 0; } else if (armed) quiet++;
            if (p >= c.EXIT) still = false;
          }
          ran += e - s;
          if ((armed && quiet >= idle) || (c.QUIET_RESET && still && !armed)) { vad.reset(); armed = false; quiet = 0; }
          if (onProgress) onProgress(ran, total);
        }
      }
    }
    const pad = Math.round(c.PAD_SEC * sr), len = pcm.length;
    const spans = speechRuns(probs, sr, c).map(([a, b]) => [Math.max(0, a * F - pad), Math.min(len, b * F + pad)]);
    return { segs: windowsOf(spans, db, F, sr, { joinSec: c.JOIN_SEC, windowSec: c.WINDOW_SEC, maxSec: c.MAX_SEC, minSec: c.MIN_SEC }), finder: 'vad', ran, error: null, probs };
  } catch (e) {
    if (e && e.code === 'cancel') throw e;
    return energy((e && e.message) || String(e));
  } finally {
    try { vad.close(); } catch (e) { /* 已经关了 */ }
  }
}

// ---------- 整理识别出的文字 ----------

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
// Whisper 在静音、杂音上常编的话（训练数据里的字幕、片尾），在简体化以后的文字上找
const HALLU = [
  /(?:中文)?字幕(?:由|提供|制作|志愿者|组|翻译|校对|[：:]|\s*by)[^，。！？!?\n]*/gi,
  /(?:请)?不吝点赞[^。！\n]*/g,
  /明镜(?:与|和)?点点(?:栏目)?/g,
  /(?:谢谢|感谢|多谢)(?:大家|各位|您)?(?:的)?(?:观看|收看|收听)[！!。.]*/g,
  /(?:我们)?下期(?:节目)?再见[！!。.]*/g,
  /thank you (?:so much )?for watching[.!]*/gi,
  /ming pao(?: canada| toronto|\s*\|)*/gi,
  /(?:请|欢迎|记得)?(?:点赞|订阅|转发|打赏|关注)(?:[、，,和与及]?(?:点赞|订阅|转发|打赏|关注|支持)(?:我们|本频道|频道)?)+/g,
  /(?:请|欢迎)订阅(?:我的|我们的|本)?频道/g,
  /amara\.org[^\n]*/gi,
  /优优独播剧场|yoyo television series exclusive/gi,
  /本(?:节目|视频|期节目)由.{0,16}?(?:提供|赞助|播出)/g,
  /[[【(（](?:音乐|背景音乐|笑声?|掌声|鼓掌|叹气|咳嗽|music|laughs?|applause)[\]】)）]/gi,
  /♪+/g,
];
/** 去掉编出来的套话。toSimplified 一个字换一个字（长度不变），所以在简体版上找到的位置，原文上也是同一段 */
export function stripHallucinations(s) {
  let out = String(s || ''), simp = toSimplified(out);
  for (const re of HALLU) {
    re.lastIndex = 0;
    const cuts = [];
    let m;
    while ((m = re.exec(simp))) { if (!m[0]) { re.lastIndex++; continue; } cuts.push([m.index, m.index + m[0].length]); }
    for (const [a, b] of cuts.reverse()) { out = out.slice(0, a) + out.slice(b); simp = simp.slice(0, a) + simp.slice(b); }
  }
  return out;
}

/**
 * 去掉卡住的重复（小模型会「我看你这一天我看你这一天……」一直循环）：同一段连着出现 ≥ 4 遍只留 1 遍，
 * 末尾跟着的半截也去掉；单个字连着 ≥ 6 个留 3 个（「嗯嗯嗯」是正常的）。重复 3 遍以内原样保留（「不要不要不要」）。
 */
export function collapseRepeats(s, { minReps = 4, minRepsChar = 6, maxUnit = 24 } = {}) {
  const a = Array.from(String(s || '')), n = a.length, out = [];
  const same = (i, j, p) => { for (let k = 0; k < p; k++) if (a[i + k] !== a[j + k]) return false; return true; };
  let i = 0;
  while (i < n) {
    let best = null;
    for (let p = 1; p <= maxUnit && i + 2 * p <= n; p++) {
      let k = 1;
      while (i + (k + 1) * p <= n && same(i, i + k * p, p)) k++;
      if (k >= (p === 1 ? minRepsChar : minReps) && (!best || k * p > best.k * best.p)) best = { p, k };
    }
    if (!best) { out.push(a[i++]); continue; }
    const unit = a.slice(i, i + best.p);
    out.push(...(best.p === 1 ? [unit[0], unit[0], unit[0]] : unit));
    i += best.k * best.p;
    let j = 0;
    while (j < best.p - 1 && i + j < n && a[i + j] === unit[j]) j++;
    if (j && i + j === n) i += j;                 // 只在结尾时去掉半截（中间的可能是下一句的开头）
  }
  return out.join('');
}

/** 标点：半角逗号问号等换成全角（数字里的 7,000、7:30 不动），中文词组之间的空格换成逗号，全角标点两边不留空格 */
export function tidyPunct(s) {
  const C = `[${CJK}]`;
  return String(s || '').replace(/[\u00a0\u3000\t ]+/g, ' ')
    .replace(/(?<!\d),|,(?!\d)/g, '，')
    .replace(/\?/g, '？').replace(/!/g, '！').replace(/;/g, '；')
    .replace(/(?<!\d):|:(?!\d)/g, '：')
    .replace(new RegExp(`(${C})\\.(?![.\\d])`, 'g'), '$1。')
    .replace(new RegExp(`(${C}) +(?=${C})`, 'g'), '$1，')
    .replace(/ *([，。！？；：、]) */g, '$1')
    .replace(/([，、；：])[，、；：]+/g, '$1')
    .replace(/^[，。！？；：、\s]+/, '')
    .replace(/[，、；：\s]+$/, '')
    .trim();
}

/**
 * 一段识别结果 → 整理好的一行（没有字了 → ''）
 * @param {string} raw
 * @param {{ simplify?: boolean }} [o]  simplify：繁体字换成简体（界面是繁体中文时不换；Whisper 的 zh 输出简繁混着）
 */
export function cleanText(raw, { simplify = true } = {}) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (simplify) s = toSimplified(s);
  s = tidyPunct(stripHallucinations(s));
  s = tidyPunct(collapseRepeats(s));
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

// ---------- 草稿 ----------

/** 草稿来源：'whisper-base@Mac'（哪个模型、在哪台设备上识别的） */
export const sourceOf = (model, device) => `whisper-${model}@${device || 'device'}`;
export function parseSource(src) {
  const m = /^whisper-([a-z]+)(?:@(.*))?$/.exec(String(src || ''));
  return m ? { model: m[1], device: m[2] && m[2] !== 'device' ? m[2] : '' } : null;
}
const joinParts = (parts) => parts.map(p => p.text).join('\n\n');

/**
 * 一段录音的识别结果合进草稿（原话不碰）→ 新的 draft。
 * 草稿是识别出来、没改过的：按录音顺序重新拼（多段之间空一行；同一段重新识别就换掉那一段）；
 * 草稿是手动粘贴的、或者识别后改过：接在后面（空一行），原来的一个字不动。
 * @param {object|null} draft   entry.draft
 * @param {{ sha256, text, source, at }} add
 * @param {string[]} order      条目里录音的 sha256 顺序
 */
export function mergeDraft(draft, { sha256, text, source, at }, order = []) {
  const idx = (sha) => { const i = order.indexOf(sha); return i < 0 ? Infinity : i; };
  const fresh = (parts) => { const ps = parts.slice().sort((a, b) => idx(a.sha256) - idx(b.sha256)); return { text: joinParts(ps), source, at, parts: ps }; };
  const old = draft && typeof draft.text === 'string' && draft.text.trim() ? draft : null;
  if (!old) return fresh([{ sha256, text }]);
  const parts = Array.isArray(old.parts) ? old.parts.filter(p => p && typeof p.sha256 === 'string' && typeof p.text === 'string') : [];
  if (parts.length && old.text === joinParts(parts)) return fresh([...parts.filter(p => p.sha256 !== sha256), { sha256, text }]);
  const { parts: _stale, ...rest } = old;
  return { ...rest, text: old.text.replace(/\s+$/, '') + '\n\n' + text, source, at };
}

const OPEN_QUOTE = /^[“「『"‘'＂]/;
/** 草稿 → 原话的写法：每一行写成 NN 说的话（👰🏻‍♀️“…”）；已经写了是谁说的行、空行原样留着 */
export function draftToDialogue(text, speakers) {
  const emoji = (speakers && speakers.nn && speakers.nn.emoji) || '👰🏻‍♀️';
  return String(text || '').split('\n').map(line => {
    const s = line.trim();
    if (!s || speakerOf(s, speakers)) return s;
    return OPEN_QUOTE.test(s) ? emoji + s : `${emoji}“${s}”`;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** 接在原话后面（原话空着就直接用）；原话本身一个字不改 */
export function appendText(text, add) {
  const base = String(text || '').replace(/\s+$/, '');
  return base ? base + '\n' + add : add;
}

// ---------- 出错 ----------
export class SttError extends Error {
  constructor(code, message) { super(message || code); this.name = 'SttError'; this.code = code; }
}
/** worker 报的错 → oom（内存不够）| net（下载不了）| gpu（显卡出错）| failed */
export function errorCode(msg, engine) {
  const s = String(msg || '');
  if (/out of memory|\boom\b|bad_alloc|allocation failed|could not allocate|memory access out of bounds|Array buffer allocation|Maximum memory|grow memory|WebAssembly\.Memory/i.test(s)) return 'oom';
  if (/failed to fetch|networkerror|load failed|network connection|internet|ERR_|status 5\d\d|\b(?:502|503|504)\b|could not locate file|unable to (?:load|fetch)|fetch|module script|dynamically imported module/i.test(s)) return 'net';
  if (engine === 'webgpu' || /webgpu|\bgpu\b|adapter|webgpuInit/i.test(s)) return 'gpu';
  return 'failed';
}

// ---------- 浏览器：解码、显卡、缓存 ----------

/** 录音 → 16 kHz 单声道（多声道取平均）。m4a、Safari 录的分片 mp4（48 kHz 立体声）都实测过 */
export const decode16k = (blob, { AC } = {}) => decodeMono(blob, { AC, sr: SR });

/**
 * 录音 → sr 的单声道 Float32Array（decodeAudioData 按 OfflineAudioContext 的采样率重采样；多声道取平均）。导入时转 m4a 用 24 kHz（importM4a.js）。
 * stats（可选，导入时用）：填上 { channels, chRms: 每个声道的均方根, mixRms: 平均以后的 }——两个声道反相时平均出来是静音，导入时看这个就不转
 */
export async function decodeMono(blob, { AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext, sr = SR, stats = null } = {}) {
  if (!AC) throw new SttError('unsupported', 'OfflineAudioContext');
  let ab;
  try {
    const ctx = new AC(1, 1, sr);
    const buf = await blob.arrayBuffer();
    ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && typeof p.then === 'function') p.then(res, rej); });
  } catch (e) { throw new SttError('decode', (e && e.message) || String(e)); }
  const ch = ab.numberOfChannels, n = ab.length;
  if (ch === 1) {
    const x = ab.getChannelData(0);
    if (stats) { const r = rmsF32(x); Object.assign(stats, { channels: 1, chRms: [r], mixRms: r }); }
    return x;
  }
  const out = new Float32Array(n), chRms = [];
  for (let c = 0; c < ch; c++) {
    const x = ab.getChannelData(c);
    if (stats) { let s = 0; for (let i = 0; i < n; i++) { const v = x[i]; out[i] += v; s += v * v; } chRms.push(n ? Math.sqrt(s / n) : 0); }
    else for (let i = 0; i < n; i++) out[i] += x[i];
  }
  for (let i = 0; i < n; i++) out[i] /= ch;
  if (stats) Object.assign(stats, { channels: ch, chRms, mixRms: rmsF32(out) });
  return out;
}
/** 均方根 */
function rmsF32(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return x.length ? Math.sqrt(s / x.length) : 0; }

let gpuMemo = null;
/** 有没有能用的显卡（WebGPU）、支不支持 fp16 → { gpu, f16 }（查一次记住） */
export function probeGpu(nav = globalThis.navigator) {
  if (gpuMemo) return gpuMemo;
  const g = nav && nav.gpu;
  gpuMemo = !g || typeof g.requestAdapter !== 'function' ? Promise.resolve({ gpu: false, f16: false })
    : Promise.resolve().then(() => g.requestAdapter()).then(a => ({ gpu: !!a, f16: !!(a && a.features && a.features.has('shader-f16')) }), () => ({ gpu: false, f16: false }));
  return gpuMemo;
}

/**
 * 缓存里这个模型有多少：{ bytes, files, complete: { wasm, webgpu } }；看不到缓存 → null
 * bytes 算这个模型所有版本（旧版本也占地方），complete 只看固定的这个版本
 */
export async function modelCacheInfo(key, { caches: cs = globalThis.caches } = {}) {
  if (!cs || !MODELS[key]) return null;
  try {
    const none = { bytes: 0, files: [], complete: { wasm: false, webgpu: false } };
    if (!(await cs.has(MODEL_CACHE))) return none;
    const c = await cs.open(MODEL_CACHE);
    const all = repoPrefix(key), mine = modelPrefix(key);
    const reqs = (await c.keys()).filter(r => r.url.startsWith(all));
    const sizes = await Promise.all(reqs.map(r => c.match(r).then(res => Number(res && res.headers && res.headers.get('content-length')) || 0, () => 0)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    const files = reqs.filter(r => r.url.startsWith(mine)).map(r => r.url.slice(mine.length));
    return { bytes, files, complete: Object.fromEntries(ENGINES.map(e => [e, modelFiles(key, e).every(f => files.includes(f))])) };
  } catch (e) { return null; }
}
/** 删掉缓存里这个模型（所有版本）→ 删了几个文件 */
export async function deleteModel(key, { caches: cs = globalThis.caches } = {}) {
  if (!cs || !MODELS[key] || !(await cs.has(MODEL_CACHE))) return 0;
  const c = await cs.open(MODEL_CACHE), all = repoPrefix(key);
  let n = 0;
  for (const r of await c.keys()) if (r.url.startsWith(all) && (await c.delete(r))) n++;
  return n;
}

// ---------- 任务（一次只跑一个） ----------
const RUNNING = ['prepare', 'vad', 'download', 'load', 'run'];
export const isRunning = (view) => !!view && RUNNING.includes(view.phase);
let current = null, seq = 0;
const subs = new Set();
/**
 * 正在跑或刚结束的任务（只读）：{ id, kind:'run'|'download', key, model, engine, phase, pct, loaded, total, seg, segs, partial, lines, cached, error, finder }
 * phase：prepare（读录音）→ vad（找说话的地方，找得久才有）→ download | load → run → done | error | cancel；finder：'vad' | 'energy'（怎么找的说话）
 */
export const job = () => (current ? current.view : null);
export function onJob(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit() { for (const fn of [...subs]) { try { fn(job()); } catch (e) { console.error(e); } } }
/** 停下正在跑的任务（结束 worker）。返回有没有停 */
export function cancel() {
  const j = current;
  if (!j || !isRunning(j.view)) return false;
  j.cancelled = true;
  if (j.stop) j.stop();
  return true;
}
/** 页面看完结果（出错提示点了「知道了」）后清掉 */
export function clearJob(id) { if (current && !isRunning(current.view) && (id == null || current.view.id === id)) { current = null; emit(); } }

const workerUrl = () => new URL('../workers/transcribe.worker.js', import.meta.url);

/**
 * 识别一段录音 → Promise<{ text, lines, model, engine, ms, segs, finder }>（text：一个窗口一行；没听出说话 → ''）
 * 先用说话识别找说话的地方（findSpeech；用不了就按能量），它的 worker 关掉以后才开 Whisper 的 worker。
 * @param {object} o
 * @param {Blob|(() => Promise<Blob|null>)} o.blob
 * @param {string} o.model           'base' | 'small'
 * @param {*} [o.key]                页面用来认出是哪一段（比如 条目id|sha256）
 * @param {boolean} [o.simplify]     繁→简（默认 true）
 * @param {boolean} [o.useGpu]       允许用显卡（默认 true；手机上总是不用）
 * @param {(engine: string) => void} [o.onEngine]   决定用什么跑之后（页面记下来：万一 App 被系统关掉，下次知道是显卡的问题）
 * @param {(err: Error) => void} [o.onGpuFail]      显卡出错、已经改用处理器重来
 * @param {'auto'|'energy'} [o.finder]  'energy'：不用说话识别、按能量找（说话识别说没人说话时，页面上的「按音量再找一遍」）
 * @param {object} [deps]            测试注入：{ Worker, decode, probeGpu, cacheInfo, mobile, now, workerUrl,
 *                                   createVad（() → createVad() 那样的对象；null = 只按能量）, vadLoadMs, vadChunkMs, vadShowMs }
 */
export function transcribe(o, deps) { return start({ ...o, kind: 'run' }, deps); }
/** 只下载并载入一次模型（之后识别不用再等下载）→ Promise<{ model, engine }> */
export function downloadModel(o, deps) { return start({ ...o, kind: 'download', key: o.key ?? 'download:' + o.model }, deps); }

async function start(o, deps = {}) {
  if (current && isRunning(current.view)) throw new SttError('busy');
  const d = { Worker: globalThis.Worker, decode: decode16k, probeGpu, cacheInfo: modelCacheInfo, mobile: isMobileDevice(), now: () => Date.now(), workerUrl,
    createVad: () => createVad(), vadShowMs: FIND.SHOW_MS, ...deps };
  const model = MODELS[o.model] ? o.model : DEFAULT_MODEL;
  const j = { cancelled: false, stop: null, view: { id: ++seq, kind: o.kind, key: o.key ?? null, model, engine: null, phase: 'prepare', pct: null, loaded: 0, total: 0, seg: 0, segs: 0, partial: '', lines: [], cached: null, error: null, finder: null, startedAt: d.now() } };
  current = j;
  const set = (patch) => { if (current === j) { Object.assign(j.view, patch); emit(); } };
  const check = () => { if (j.cancelled) throw new SttError('cancel'); };
  const simplify = o.simplify !== false;
  emit();
  try {
    if (typeof d.Worker !== 'function') throw new SttError('unsupported', 'Worker');
    if (!modelAllowed(model, { mobile: d.mobile })) throw new SttError('tooBig');
    let segs = [], finder = null;
    if (o.kind === 'run') {
      const blob = typeof o.blob === 'function' ? await o.blob() : o.blob;
      check();
      if (!blob) throw new SttError('noAudio');
      const pcm = await d.decode(blob);
      check();
      const found = await (o.finder === 'energy' ? findSpeech(pcm, { vad: null }) : findFor(j, d, pcm, set, check));
      finder = found.finder;
      set({ finder });
      segs = found.segs.map(([a, b]) => pcm.slice(a, b));
      if (!segs.length) { set({ phase: 'done', pct: 100 }); return { text: '', lines: [], model, engine: null, ms: d.now() - j.view.startedAt, segs: 0, finder }; }
    }
    let engine = pickEngine(model, { mobile: d.mobile, ...(await d.probeGpu()), useGpu: o.useGpu !== false });
    check();
    const told = (en) => { if (o.onEngine) { try { o.onEngine(en); } catch (x) { /* 页面的事 */ } } };
    told(engine);
    let texts;
    try { texts = await runWorker(j, d, { model, engine, segs, simplify }, set); }
    catch (e) {
      if (engine !== 'webgpu' || j.cancelled || (e && (e.code === 'cancel' || e.code === 'net'))) throw e;
      if (o.onGpuFail) { try { o.onGpuFail(e); } catch (x) { /* 页面的事 */ } }
      engine = 'wasm';                           // 显卡出错：换一个新 worker 用处理器重来
      told(engine);
      texts = await runWorker(j, d, { model, engine, segs, simplify }, set);
    }
    const lines = texts.map(x => cleanText(x, { simplify })).filter(Boolean);
    set({ phase: 'done', pct: 100, lines, partial: '' });
    return { text: lines.join('\n'), lines, model, engine, ms: d.now() - j.view.startedAt, segs: segs.length, finder };
  } catch (e) {
    const err = e instanceof SttError ? e : new SttError('failed', (e && e.message) || String(e));
    if (j.cancelled) err.code = 'cancel';
    set({ phase: err.code === 'cancel' ? 'cancel' : 'error', error: { code: err.code, message: err.message } });
    throw err;
  } finally {
    j.stop = null;
  }
}

/**
 * 找说话的地方（findSpeech）：开说话识别的 worker（取消时马上结束它），找完（不管成没成）一定已经关掉。
 * 找了 vadShowMs 还没找完才显示「找说话的地方…」（phase 'vad'，pct 是交给识别的部分做了多少；载入时 pct 是 null）
 */
async function findFor(j, d, pcm, set, check) {
  let vad = null;
  if (d.createVad) { try { vad = d.createVad(); } catch (e) { console.warn('转文字：说话识别开不了，按能量找', e); vad = null; } }
  if (!vad) return findSpeech(pcm, { vad: null });
  let shown = false, pct = null;
  const show = () => { shown = true; set({ phase: 'vad', pct }); };
  const t = setTimeout(show, d.vadShowMs);
  j.stop = () => { try { vad.close(); } catch (e) { /* 已经关了 */ } };
  try {
    const found = await findSpeech(pcm, { vad, check, loadMs: d.vadLoadMs, chunkMs: d.vadChunkMs, onProgress: (done, total) => {
      const p = Math.floor((done / total) * 100);
      if (p === pct) return;
      pct = p;
      if (shown) show();
    } });
    if (found.error) console.warn('转文字：说话识别用不了，按能量找', found.error);
    return found;
  } finally { clearTimeout(t); j.stop = null; }
}

/** 开一个 worker：载入模型 →（识别各段）→ 结束 worker。resolve 每段的原始文字 */
function runWorker(j, d, { model, engine, segs, simplify }, set) {
  return (async () => {
    const info = await Promise.resolve(d.cacheInfo(model)).catch(() => null);
    const cached = !!(info && info.complete && info.complete[engine]);
    if (j.cancelled) throw new SttError('cancel');
    return new Promise((resolve, reject) => {
      let w, done = false;
      const end = (fn, v) => { if (done) return; done = true; try { w && w.terminate(); } catch (e) { /* 已经停了 */ } j.stop = null; fn(v); };
      try { w = new d.Worker(d.workerUrl(), { type: 'module' }); } catch (e) { reject(new SttError('unsupported', (e && e.message) || String(e))); return; }
      j.stop = () => end(reject, new SttError('cancel'));
      const fail = (msg) => end(reject, new SttError(errorCode(msg, engine), String(msg || 'worker error')));
      const texts = [];
      set({ engine, cached, phase: cached ? 'load' : 'download', pct: cached ? null : 0, loaded: 0, total: 0, seg: 0, segs: segs.length, partial: '', lines: [] });
      let heard = false;
      // 没说过一句话就出错：多半是 worker 或 transformers.js 没取到（第一次用时没网）
      w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail((e && e.message) || (heard ? 'worker error' : 'Importing a module script failed')); };
      w.onmessageerror = () => fail('messageerror');
      w.onmessage = ({ data: m }) => {
        if (done || !m) return;
        heard = true;
        if (m.type === 'progress') {
          // transformers.js 报的总数有时把没下载的文件也算进去（更准 + 显卡时多出 300 多 MB）：总数用表里实测的大小
          const loaded = Number(m.loaded) || 0, total = Math.max(MODELS[model][engine].bytes, loaded);
          if (!cached) set({ phase: 'download', pct: Math.min(100, (loaded / total) * 100), loaded, total });
        }
        else if (m.type === 'ready') {
          if (j.view.kind === 'download' || !segs.length) { end(resolve, []); return; }
          set({ phase: 'run', pct: 0, seg: 0 });
          // 用显卡时可能要换处理器重来：发副本，原来的留着
          const bufs = engine === 'webgpu' ? segs.map(s => s.slice()) : segs;
          w.postMessage({ type: 'run', id: j.view.id, segments: bufs }, bufs.map(s => s.buffer));
        } else if (m.type === 'seg') set({ seg: m.i, partial: '' });
        else if (m.type === 'partial') set({ partial: j.view.partial + (simplify ? toSimplified(m.t) : m.t) });
        else if (m.type === 'segDone') {
          texts[m.i] = m.text;
          const line = cleanText(m.text, { simplify });
          set({ pct: Math.round(((m.i + 1) / segs.length) * 100), lines: line ? [...j.view.lines, line] : j.view.lines, partial: '' });
        } else if (m.type === 'result') end(resolve, Array.isArray(m.texts) ? m.texts : texts);
        else if (m.type === 'error') fail(m.message);
      };
      const mm = MODELS[model];
      w.postMessage({ type: 'load', model: mm.repo, revision: mm.revision, device: engine, dtype: mm[engine].dtype });
    });
  })();
}
