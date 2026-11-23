// 导入的录音文件统一存成 m4a（省地方）：设置 → 数据 → 导入录音（选的、拖进窗口的）、详情页 ⋯「添加录音（文件）」、编辑页「添加录音」都走这里。
// 从备忘录迁移、恢复备份不走这里（原样存）。
//   已经是 m4a（mp4 里的 AAC：语音备忘录、App 自己录的）→ 原样存，一个字节不动（why 'm4a'）；
//   别的（WAV、MP3、CAF、AIFF、webm / ogg、ALAC 的 m4a…）→ 解码成 24 kHz 单声道（decodeAudioData，和转文字同一条路：transcribe.js 的 decodeMono，
//   多声道取平均）→ m4a.js 编成 AAC-LC 48 kbps（编码器不支持 24 kHz 就 16 kHz 32 kbps）→ 解码回来和那份单声道核对（同床头模式：时长差 ≤ 0.15 秒、音量、丢段、对齐）。
//   多声道平均以后比最响的那个声道小 10 dB 以上（两个声道反相、互相抵消：平均出来几乎是静音，核对只和平均的比，看不出来）→ 不转。
//   编出来没比原文件小一成以上（原文件本来就是低码率的 MP3、AAC 的 CAF…：再压一遍只会更糊）→ 不转（why 'bigger'）。
//   解码、编码排着一个个来（详情页、编辑页、导入页同时加也是）：iPhone 上一次只解一个。
// 转不了 → 原样存原来的文件，why 说为什么（界面上一个文件说一句，keptKey）：'unsupported'（浏览器编不了 / 解不了）、'long'（知道时长、超过 30 分钟：
//   iPhone 上解码出来的声音太占内存）、'big'（文件大于 400 MB；读不出时长、文件又大于 16 MB；WAV 的声道多、解出来太占内存）、'decode'（解码不了）、
//   'timeout'（解码、编码、问编码器支不支持都有时限）、'check'（核对不过、多声道抵消了）、'bigger'、'error'。
//   出什么错都退回原文件，不会因为转换丢掉或卡住导入。
// 认同一段录音：存下的是 m4a，条目里的 sha256 是 m4a 的；原文件的 sha256 记在 srcSha256，去重时两个都比（store.js clipKeys / clipIndex withSrc）
//   ——编码器不保证每次编出来一样，同一个 WAV 导两次靠它认出来。永久删除、清理、同步只认 sha256（srcSha256 不算「有条目在用」，不会把永久删除了的找回来）。
// m4a 的 creation_time 是调用方给的时刻（条目的时间从哪来就用哪个：原文件里的录音时间，没有就是文件修改时间）；时长按解码出来的 PCM。
// 实测（Mac 上的 WKWebView，电脑朗读做的文件）：支持 24 kHz 48 kbps；9.4 秒的 48 kHz 立体声 WAV 1.8 MB → 62 KB（说话时约 53 kbps），128 kbps 的 MP3 151 KB → 62 KB，
// 44.1 kHz 的 CAF 513 KB → 38 KB，解码回来样本数一样、音量差 ≤ 0.1 dB、对齐到样本（偏移 0 的互相关 0.995–0.999）；10 分钟的 WAV（115 MB）转完 2.8 MB 用 3.4 秒，
// 29 分钟的 8 kHz WAV 18 秒（31 分钟的不转）；同样的文件、同样的时刻编出来每次一样（但别指望：去重靠 srcSha256）。
// 低码率的（8 kHz 的 MP3、AAC 的 CAF）编出来反而大、或者只小 6–8 %：按上面的规矩原样存。内存没在 iPhone 上量过（30 分钟 48 kHz 立体声 WAV 解出来几百 MB）。
// 依赖都能注入（AudioEncoder、AudioData、OfflineAudioContext、decode），Node 里用假的测。import 时什么都不做。
import { pcmToM4a, pickConfig, budgetMs, QUIET } from './m4a.js';
import { decodeMono } from './transcribe.js';
import { mp4AudioCodec } from './mp4meta.js';
import { sha256Hex } from './sha256.js';
import { baseMime } from './audioStore.js';

/** 先试 24 kHz 48 kbps，编码器不支持再 16 kHz 32 kbps（说话够清楚；音乐会闷一点） */
export const TARGETS = Object.freeze([Object.freeze({ sr: 24000, bitrate: 48000 }), Object.freeze({ sr: 16000, bitrate: 32000 })]);
export const MAX_SEC = 30 * 60;                       // 知道时长、超过 30 分钟不转（long）：30 分钟立体声解码出来就有几百 MB
export const MAX_UNKNOWN_BYTES = 16 * 1024 * 1024;     // 读不出时长的文件：大于这么多也不转（big；压缩过的 16 MB 可能就有半小时以上）
export const MAX_SRC_BYTES = 400 * 1024 * 1024;        // 原文件大于这么多不转（big）：解码时原文件、解出来的声音同时在内存里（30 分钟 48 kHz 立体声 16 位的 WAV 346 MB 还转）
export const MAX_CH_SEC = MAX_SEC * 2;                 // 声道数 × 秒数最多这么多（big）：解出来的声音（24 kHz、每个声道一份）最多和 30 分钟立体声一样大；只有 WAV 的头里看得到声道数
export const DOWNMIX_MIN_DB = -10;                     // 多声道平均以后比最响的声道小这么多（反相抵消了）→ 不转（check）；一边有声、一边没声是 −6 dB，照样转
export const SHRINK_MAX = 0.9;                         // 编出来大于原文件的九成 → 不转（bigger）
export const CONFIG_MS = 5000;                         // 问编码器支不支持（isConfigSupported）最多等多久
/** 解码原文件最多等多久：20 秒起，每秒录音再加 0.1 秒（30 分钟 200 秒）；不知道多长按 120 秒 */
export const decodeBudgetMs = (sec) => (Number.isFinite(sec) && sec > 0 ? 20000 + sec * 100 : 120000);
const CHECK = new Set(['header', 'duration', 'level', 'dropout', 'align']);

const timeout = () => Object.assign(new Error('importM4a: timeout'), { code: 'timeout' });
/** p 和计时器比快：超时 → 抛 code 'timeout'（p 自己后来出错也不算没接住） */
function within(p, ms) {
  let timer = null;
  Promise.resolve(p).catch(() => {});
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(timeout()), ms); })]).finally(() => clearTimeout(timer));
}

/** 原文件已经是 m4a（mp4 里的 AAC）→ true：原样存 */
export const isAacMp4 = (buf) => mp4AudioCodec(buf) === 'aac';

/**
 * WAV（RIFF / WAVE）的时长、声道数：fmt 里的 byteRate、声道数，data 的长度（写成 0 或 0xFFFFFFFF 的按到文件结尾）→ { sec, channels } | null（不是 WAV、读不出）。
 * 只要文件开头（data 块的头）就够了
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @param {number} [total] 整个文件多大（buf 只是开头时给）
 */
export function wavFormat(buf, total) {
  try {
    const dv = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tag = (p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    if (dv.byteLength < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    const size = Number.isFinite(total) && total > 0 ? total : dv.byteLength;
    let rate = 0, channels = 0;
    for (let p = 12; p + 8 <= dv.byteLength;) {
      const id = tag(p), len = dv.getUint32(p + 4, true);
      if (id === 'fmt ' && p + 16 <= dv.byteLength) { channels = dv.getUint16(p + 10, true); rate = dv.getUint32(p + 16, true); }
      if (id === 'data') {
        const n = len === 0 || len === 0xffffffff || p + 8 + len > size ? size - p - 8 : len;
        return rate > 0 && n > 0 ? { sec: Math.round(n / rate * 1000) / 1000, channels: channels || null } : null;
      }
      p += 8 + len + (len & 1);
    }
    return null;
  } catch (e) { return null; }
}
/** WAV 的时长（秒）| null，见 wavFormat */
export const wavDurationSec = (buf, total) => { const f = wavFormat(buf, total); return f ? f.sec : null; };

let heavy = Promise.resolve();
/** 解码、编码排着一个个来（不管哪个页面调的）：排队的时候不算时限 */
function oneAtATime(fn) {
  const run = heavy.then(fn);
  heavy = run.then(() => {}, () => {});
  return run;
}

/**
 * 选来的录音文件 → 要存的那份（不存，只算）：
 *   转成了 → { converted: true, why: null, blob: m4a, mime: 'audio/mp4', sha256: m4a 的, bytes, srcSha256: 原文件的, srcBytes, durationSec, sr, bitrate, ms }
 *   已经是 m4a / 转不了 → { converted: false, why, blob: 原文件, mime: 原来的, sha256: 原文件的, bytes, ms }
 * @param {{ blob: Blob, mime?: string, sha256?: string, durationSec?: number|null, createdAt?: number|Date|null, aac?: boolean, buf?: ArrayBuffer }} src
 *   durationSec：已经知道的时长（文件头、<audio> 读的），超过 30 分钟就不解码；aac / buf：已经读好的（不用再读一遍文件）；
 *   createdAt：写进 m4a 的 creation_time
 * @param {{ AudioEncoder?: any, AudioData?: any, OfflineAudioContext?: any, decode?: (blob: Blob, sr: number, stats?: object) => Promise<Float32Array>,
 *           timeoutMs?: number, configMs?: number, targets?: Array<{ sr: number, bitrate: number }>, onResult?: (r: object) => void }} [o]
 *   decode：解码（原文件和编出来的 m4a 都用它；不给就是 decodeMono；解原文件时第三个参数是 stats，同 decodeMono 的，填不填都行）；
 *   timeoutMs：解码、编码 + 核对各自最多等多久（不给按时长算）；configMs：问编码器支不支持最多等多久（不给 5 秒）
 */
export async function importM4a(src, o = {}) {
  const t0 = Date.now(), blob = src.blob, mime = baseMime(src.mime || blob.type) || 'audio/mp4';
  let sha256 = src.sha256 || null;
  const pass = {};                                       // 换掉的浏览器接口（测试用），原样交给 m4a.js
  for (const k of ['AudioEncoder', 'AudioData', 'OfflineAudioContext']) if (k in o) pass[k] = o[k];
  const keep = async (why, extra = {}) => {
    if (!sha256) sha256 = await sha256Hex(blob);
    const r = { converted: false, why, blob, mime, sha256, bytes: blob.size, ms: Date.now() - t0, ...extra };
    if (o.onResult) try { o.onResult(r); } catch (e) { /* 只是报告 */ }
    return r;
  };
  try {
    let aac = src.aac, buf = src.buf || null;
    if (aac == null) { buf = buf || await blob.arrayBuffer(); aac = isAacMp4(buf); }
    if (aac) return await keep('m4a');
    const wav = wavFormat(buf || await blob.slice(0, 65536).arrayBuffer(), blob.size);
    buf = null;
    const sec = Number.isFinite(src.durationSec) && src.durationSec > 0 ? src.durationSec : wav ? wav.sec : null;
    if (sec != null && sec > MAX_SEC) return await keep('long', { durationSec: sec });
    // 解出来太占内存的不解：原文件太大、读不出时长又不小、WAV 的声道太多（别的格式看不到声道数，按立体声算：30 分钟以内都行）
    if (blob.size > MAX_SRC_BYTES || (sec == null ? blob.size > MAX_UNKNOWN_BYTES : sec * ((wav && wav.channels) || 2) > MAX_CH_SEC)) {
      return await keep('big', { durationSec: sec });
    }
    // 编码器支持哪个采样率（24 kHz 不行就 16 kHz），解码要 OfflineAudioContext：哪个都没有就不解码。问的时候一直不回（媒体进程卡住）也不等下去
    let cfg;
    try { cfg = await within(pickConfig(o.targets || TARGETS, pass), o.configMs ?? CONFIG_MS); }
    catch (e) { return await keep(e && e.code === 'timeout' ? 'timeout' : 'unsupported', { detail: 'config' }); }
    const AC = 'OfflineAudioContext' in o ? o.OfflineAudioContext : (globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext);
    if (!cfg || (!o.decode && !AC)) return await keep('unsupported');
    if (!sha256) sha256 = await sha256Hex(blob);
    return await oneAtATime(() => convert(cfg, AC, sec));
  } catch (e) {
    console.warn('importM4a', e);
    return keep('error', { error: (e && e.message) || String(e) });
  }

  // 解码 → 看多声道抵消了没有 → 编码、核对（排着队，一次一个）
  async function convert({ sr, bitrate }, AC, sec) {
    const stats = {};
    const decode = o.decode ? (b) => o.decode(b, sr) : (b) => decodeMono(b, { AC, sr });
    const decodeSrc = o.decode ? (b) => o.decode(b, sr, stats) : (b) => decodeMono(b, { AC, sr, stats });
    let pcm;
    try { pcm = await within(decodeSrc(blob), o.timeoutMs ?? decodeBudgetMs(sec)); }
    catch (e) {
      if (e && e.code === 'timeout') return keep('timeout');
      console.warn('importM4a: decode', e);
      return keep('decode', { error: (e && e.message) || String(e) });
    }
    if (!pcm || !pcm.length) return keep('decode');
    const dur = pcm.length / sr;
    if (dur > MAX_SEC) { pcm = null; return keep('long', { durationSec: Math.round(dur * 10) / 10 }); }
    // 多声道取平均以后比最响的声道小很多：反相、互相抵消了（核对只和平均的比，看不出来）→ 原样存
    if (Array.isArray(stats.chRms) && stats.chRms.length > 1) {
      const top = Math.max(...stats.chRms), mix = stats.mixRms;
      if (top > QUIET && !(mix >= top * 10 ** (DOWNMIX_MIN_DB / 20))) {
        pcm = null;
        return keep('check', { detail: 'downmix', chRms: stats.chRms, mixRms: mix });
      }
    }
    let r = null;
    const createdAt = src.createdAt instanceof Date ? src.createdAt.getTime() : Number(src.createdAt) || null;
    const m4a = await pcmToM4a(pcm, { ...pass, sr, bitrate, createdAt, decode, maxBytes: Math.floor(blob.size * SHRINK_MAX),
      timeoutMs: o.timeoutMs ?? budgetMs(dur), onResult: (x) => { r = x; } });
    pcm = null;
    if (!m4a) {
      const w = (r && r.why) || 'error';
      return keep(w === 'unsupported' || w === 'timeout' || w === 'bigger' ? w : CHECK.has(w) ? 'check' : 'error', { detail: w });
    }
    const out = { converted: true, why: null, blob: m4a, mime: 'audio/mp4', sha256: await sha256Hex(m4a), bytes: m4a.size, srcSha256: sha256, srcBytes: blob.size,
      durationSec: Math.round(dur * 1000) / 1000, sr, bitrate, ms: Date.now() - t0 };
    if (o.onResult) try { o.onResult(out); } catch (e) { /* 只是报告 */ }
    return out;
  }
}

/** 转换结果要不要在界面上说一句「没转成 m4a，按原来的格式存」：已经是 m4a 的、转成了的不说 */
export const keptOriginal = (r) => !!r && !r.converted && r.why !== 'm4a';
/**
 * 没转成 m4a 时说哪一句（文案 imp.* / entry.* 的后半）：'keptLong'（知道时长、超过 30 分钟）、'keptSmall'（原文件已经够小，不是出了问题）、
 * 'kept'（别的：编不了、解不开、太大、核对不过…）；已经是 m4a 的、转成了的 → null
 */
export const keptKey = (r) => (!keptOriginal(r) ? null : r.why === 'long' ? 'keptLong' : r.why === 'bigger' ? 'keptSmall' : 'kept');
