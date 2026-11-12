// 语音转文字（草稿）：在这台设备上用 Whisper 把录音识别成文字，录音不离开设备（只有模型第一次用时从 Hugging Face 下载）。
// 结果只进条目的「草稿」（entry.draft），永远不改原话；用户点「填进原话」才写进去。
//
// 纯计算（Node 测试能 import，不碰 DOM）：
//   MODELS / modelFiles / modelPrefix        两种模型（标准 = whisper-base，更准 = whisper-small）和各自要下载的文件
//   isMobileDevice / modelAllowed / pickEngine   用显卡（WebGPU）还是处理器（WASM）；iPhone / iPad 只用处理器、只给标准
//   speechSegments(pcm, sr)                   按说话分段：只把有人说话的地方交给 Whisper（静音、杂音会让它编出「谢谢观看」，
//                                             它自带的 30 秒分块又会整句漏掉），每段 ≤ 28 秒、单独识别
//   cleanText(raw, { simplify })              整理：繁→简（界面是繁体时不转）、去掉编出来的字幕套话、去掉卡住的重复、标点换成全角
//   mergeDraft / draftToDialogue / appendText / sourceOf / parseSource   合进草稿、填进原话、草稿来源
// 浏览器（用到时才碰 Worker / OfflineAudioContext / caches）：
//   transcribe(o) → Promise<{ text, lines, model, engine, ms }>   一次只跑一个；cancel() 立刻结束 worker（内存马上还回去）
//   downloadModel(o)                          只下载、载入一次模型（设置页「现在下载」）
//   job() / onJob(fn)                         正在跑（或刚结束）的任务，页面离开再回来也能接着显示进度
//   modelCacheInfo(model) / deleteModel(model)   transformers.js 自己的缓存（Cache Storage「transformers-cache」）里这个模型占多少、删掉
//   probeGpu() / decode16k(blob)
//
// 第三方文件在 vendor/transformers/（transformers.js 4.3.2 + onnxruntime-web 的 wasm，见那里的 README），worker 是 src/workers/transcribe.worker.js。
// 实测（Mac 上的 WKWebView，单线程）：标准 + 处理器 + q8 下载约 80 MB、峰值内存约 0.7 GB，每个 ≤ 30 秒的片段约 2 秒（iPhone 估计 3–4 秒）；
// 更准在处理器上约 1.6 GB，超过 iPhone 网页的内存上限，所以只给 Mac；iPhone / iPad 也不用 WebGPU（显存算在网页头上，峰值 2.5 GB 以上）。
import { toSimplified } from './hanzi.js';
import { speakerOf } from './dialogue.js';

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
 * 整段差不多一样响：很响（> -30 dBFS）当作一直在说，否则当作只有杂音 / 静音（不识别，免得它编字幕套话）。
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
  const floor = pct(0.15), loud = pct(0.95);
  let spans;
  if (loud - floor < 8) {
    if (loud < -30) return [];
    spans = [[0, len]];
  } else {
    const thr = Math.max(floor + Math.min(10, Math.max(6, (loud - floor) / 2)), -55);
    const gapF = Math.round(gapSec / frameSec), pad = Math.round(padSec * sr);
    const runs = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (db[i] <= thr) continue;
      if (cur && i - cur[1] <= gapF) cur[1] = i;
      else { if (cur) runs.push(cur); cur = [i, i]; }
    }
    if (cur) runs.push(cur);
    spans = runs.filter(([a, b]) => (b - a + 1) * frameSec >= minSec).map(([a, b]) => [Math.max(0, a * F - pad), Math.min(len, (b + 1) * F + pad)]);
  }
  // 合成识别窗口
  const joined = [];
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

// ---------- 整理识别出的文字 ----------

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
// Whisper 在静音、杂音上常编的话（训练数据里的字幕、片尾），在简体化以后的文字上找
const HALLU = [
  /(?:中文)?字幕(?:由|提供|制作|志愿者|组|翻译|校对|[：:])[^，。！？!?\n]*/g,
  /(?:请)?不吝点赞[^。！\n]*/g,
  /明镜(?:与|和)?点点(?:栏目)?/g,
  /(?:谢谢|感谢)(?:大家|各位|您)?(?:的)?(?:观看|收看|收听)[！!。.]*/g,
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
export async function decode16k(blob, { AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext } = {}) {
  if (!AC) throw new SttError('unsupported', 'OfflineAudioContext');
  let ab;
  try {
    const ctx = new AC(1, 1, SR);
    const buf = await blob.arrayBuffer();
    ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && typeof p.then === 'function') p.then(res, rej); });
  } catch (e) { throw new SttError('decode', (e && e.message) || String(e)); }
  const ch = ab.numberOfChannels, n = ab.length;
  if (ch === 1) return ab.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const x = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += x[i]; }
  for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}

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
const RUNNING = ['prepare', 'download', 'load', 'run'];
export const isRunning = (view) => !!view && RUNNING.includes(view.phase);
let current = null, seq = 0;
const subs = new Set();
/** 正在跑或刚结束的任务（只读）：{ id, kind:'run'|'download', key, model, engine, phase, pct, loaded, total, seg, segs, partial, lines, cached, error } */
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
 * 识别一段录音 → Promise<{ text, lines, model, engine, ms, segs }>（text：一个窗口一行；没听出说话 → ''）
 * @param {object} o
 * @param {Blob|(() => Promise<Blob|null>)} o.blob
 * @param {string} o.model           'base' | 'small'
 * @param {*} [o.key]                页面用来认出是哪一段（比如 条目id|sha256）
 * @param {boolean} [o.simplify]     繁→简（默认 true）
 * @param {boolean} [o.useGpu]       允许用显卡（默认 true；手机上总是不用）
 * @param {(engine: string) => void} [o.onEngine]   决定用什么跑之后（页面记下来：万一 App 被系统关掉，下次知道是显卡的问题）
 * @param {(err: Error) => void} [o.onGpuFail]      显卡出错、已经改用处理器重来
 * @param {object} [deps]            测试注入：{ Worker, decode, probeGpu, cacheInfo, mobile, now, workerUrl }
 */
export function transcribe(o, deps) { return start({ ...o, kind: 'run' }, deps); }
/** 只下载并载入一次模型（之后识别不用再等下载）→ Promise<{ model, engine }> */
export function downloadModel(o, deps) { return start({ ...o, kind: 'download', key: o.key ?? 'download:' + o.model }, deps); }

async function start(o, deps = {}) {
  if (current && isRunning(current.view)) throw new SttError('busy');
  const d = { Worker: globalThis.Worker, decode: decode16k, probeGpu, cacheInfo: modelCacheInfo, mobile: isMobileDevice(), now: () => Date.now(), workerUrl, ...deps };
  const model = MODELS[o.model] ? o.model : DEFAULT_MODEL;
  const j = { cancelled: false, stop: null, view: { id: ++seq, kind: o.kind, key: o.key ?? null, model, engine: null, phase: 'prepare', pct: null, loaded: 0, total: 0, seg: 0, segs: 0, partial: '', lines: [], cached: null, error: null, startedAt: d.now() } };
  current = j;
  const set = (patch) => { if (current === j) { Object.assign(j.view, patch); emit(); } };
  const check = () => { if (j.cancelled) throw new SttError('cancel'); };
  const simplify = o.simplify !== false;
  emit();
  try {
    if (typeof d.Worker !== 'function') throw new SttError('unsupported', 'Worker');
    if (!modelAllowed(model, { mobile: d.mobile })) throw new SttError('tooBig');
    let segs = [];
    if (o.kind === 'run') {
      const blob = typeof o.blob === 'function' ? await o.blob() : o.blob;
      check();
      if (!blob) throw new SttError('noAudio');
      const pcm = await d.decode(blob);
      check();
      segs = speechSegments(pcm).map(([a, b]) => pcm.slice(a, b));
      if (!segs.length) { set({ phase: 'done', pct: 100 }); return { text: '', lines: [], model, engine: null, ms: d.now() - j.view.startedAt, segs: 0 }; }
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
    return { text: lines.join('\n'), lines, model, engine, ms: d.now() - j.view.startedAt, segs: segs.length };
  } catch (e) {
    const err = e instanceof SttError ? e : new SttError('failed', (e && e.message) || String(e));
    if (j.cancelled) err.code = 'cancel';
    set({ phase: err.code === 'cancel' ? 'cancel' : 'error', error: { code: err.code, message: err.message } });
    throw err;
  } finally {
    j.stop = null;
  }
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
