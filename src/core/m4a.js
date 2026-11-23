// 床头模式「留下」的录音存成 m4a（AAC-LC，16 kHz 单声道，要的是 32 kbps，说话时实际 40 kbps 左右）：同样 20 秒，WAV 625 KB，m4a 约 100 KB（同步进仓库历史的小六倍）。
//   encodeAac(pcm, o)        WebCodecs AudioEncoder 编码 → 一帧帧 AAC（每帧 1024 个样本）+ AudioSpecificConfig；前面先垫 1024 个 0（见 LEAD）
//   ascFromDescription(d)    编码器给的 decoderConfig.description → AudioSpecificConfig（ASC）：规范说是裸 ASC，
//                            WebKit 给的却是整个 ES_Descriptor（03 … 04 … 05 [ASC] 06 …），两种都认（整个 esds 盒子也认）
//   parseAsc(asc)            ASC → { aot, sampleRate, channels, frameLen }
//   muxM4a(o)                拼成最简单的标准 m4a：ftyp（M4A）+ moov（mvhd、trak：tkhd、mdia：mdhd、hdlr soun、minf：smhd、dinf、
//                            stbl：stsd（mp4a + esds）、stts、stsc、stsz、stco；udta：iTunSMPB）+ mdat，moov 在前（边下边放）。
//                            编码器在开头多出来的预热（AAC 的编码延迟，WebKit 是 2112 个样本，时间戳里不显示；再加上垫的 1024）和结尾凑整帧补的，
//                            照 Apple 自己的 m4a（afconvert 写的）记在 iTunSMPB 里：Safari 解码（decodeAudioData）、<audio>、ffmpeg 都认，
//                            解码出来正好是原来的 PCM（对齐到样本）。不用 elst：实测 WebKit 解码时把 elst 的 media_time 加在它自己默认跳过的
//                            2112 上，开头的 132 毫秒会被吃掉两遍。mvhd / tkhd 的时长是 PCM 的（readMp4Meta 读出来就对），mdhd 是所有帧的；
//                            creation_time 是录音开始的时刻
//   verifyM4a(blob, pcm, o)  解码回来核对（和转文字同一条路：transcribe.js 的 decode16k）：时长差 ≤ 0.15 秒、音量没走样（不是静音的没变成静音、
//                            丢了 64 毫秒以上也看得出来：很轻的悄悄话也比）、没有错开（最响的那半秒和原来逐个样本对得上）
//   pcmToM4a(pcm, o)         上面几步连起来 → Blob（audio/mp4）| null。不支持、出错、超时、核对不过都是 null（调用方存 WAV），不会交出坏文件。
//                            帧数和预热对不上（编码器丢了帧、预热不是 2112 又没标出来）也算不对：拿不准就存 WAV
// 实测（Mac 上的 WKWebView）：description 是 ES_Descriptor；帧数 = ⌈(喂进去的样本数 + 2112) / 1024⌉；第一帧时间戳 0、每帧 64 ms，
// 但每喂进一块（1 秒，不是 1024 的整数倍）它按那块的时间戳重新标，帧和帧之间有时差 104 / 40 ms（偏差总在一帧以内）：时间戳只拿来看预热标没标出来；
// 同样的 PCM 编出来每次一样（但别的系统、别的版本不一定，调用方别指望重编出同一个 sha256）；5 秒说话约 25 KB（WAV 160 KB），
// 解码回来样本数一样、对齐到样本（偏移 0 的互相关：说话 0.997–0.999，白噪声、翻身声也有 0.92）、每 32 毫秒的音量差多数 < 1.5 dB
// （最响那段 −40 dB 以内、−75 dBFS 以上的都算上，连着说话的最多差 4 dB）；10 分钟的片段编码加核对 1.5 秒。
// 页面在后台时计时器会被放慢（实测 setTimeout 等着编 10 分钟要 56 秒），所以等编码器用它的 dequeue 事件，不用计时器（在后台编 10 分钟 1 秒，连核对 3.6 秒）。
// 依赖都能注入（AudioEncoder、AudioData、decode），Node 里用假编码器测。import 时什么都不做。
import { readMp4Meta } from './mp4meta.js';
import { decode16k, nextTask } from './transcribe.js';

export const SR = 16000;
export const CODEC = 'mp4a.40.2';            // AAC-LC
export const BITRATE = 32000;
export const PRIMING = 2112;                 // AAC-LC 编码器的标准预热（Apple 的编码器就是这么多）：时间戳不显示时按它
export const LEAD = 1024;                    // 编码前先垫这么多个 0：实测 WebKit 的编码器把头 1024 个样本编成静音（ffmpeg、Core Audio 解出来都是），
                                             // 垫上以后丢的是垫的 0（不丢也没关系：都算预热跳过）
export const TOLERANCE_SEC = 0.15;           // 解码回来的时长和 PCM 最多差这么多
const MAC_EPOCH = 2082844800;                // 1904-01-01 到 1970-01-01 的秒数
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const BLOCK_SEC = 1;                         // 每次喂给编码器 1 秒
export const QUEUE_MAX = 8;                  // 编码器手上最多压这么多块（10 分钟的片段不一下子全塞进去）

const fail = (code, detail) => Object.assign(new Error('m4a: ' + code + (detail ? ' (' + detail + ')' : '')), { code });

/** 编码 + 核对最多等多久：10 秒起，每秒录音再加 0.2 秒（10 分钟的片段 130 秒） */
export const budgetMs = (sec) => 10000 + Math.max(0, sec) * 200;

// ---------- 编码 ----------

/**
 * PCM（Int16Array 或 -1…1 的 Float32Array，单声道）→ { frames: Uint8Array[], description, sampleRate, channels, firstTs, lead }
 * lead：先喂这么多个 0（时间戳从 0 开始算，PCM 接在后面）。
 * 编码器手上压了 QUEUE_MAX 块以上就等它的 dequeue 事件（没有这个事件的编码器：让出一拍再看），出错、中止时马上不等。
 * 不支持（没有 AudioEncoder / AudioData、isConfigSupported 说不行）→ 抛 code 'unsupported'；编码器报错照样抛；signal 中止 → 抛 code 'aborted'
 * @param {Int16Array|Float32Array} pcm
 * @param {{ sr?: number, bitrate?: number, lead?: number, AudioEncoder?: any, AudioData?: any, signal?: AbortSignal }} [o]
 */
export async function encodeAac(pcm, o = {}) {
  const { sr = SR, bitrate = BITRATE, lead = 0, signal = null } = o;
  const AE = 'AudioEncoder' in o ? o.AudioEncoder : globalThis.AudioEncoder;
  const AD = 'AudioData' in o ? o.AudioData : globalThis.AudioData;
  if (typeof AE !== 'function' || typeof AD !== 'function') throw fail('unsupported');
  const config = { codec: CODEC, sampleRate: sr, numberOfChannels: 1, bitrate };
  if (typeof AE.isConfigSupported === 'function') {
    const s = await AE.isConfigSupported(config);
    if (!s || !s.supported) throw fail('unsupported');
  }
  if (signal && signal.aborted) throw fail('aborted');
  const frames = [];
  let description = null, sampleRate = null, channels = null, firstTs = null, broke = null, halt = null, wake = null;
  // 出错、中止（超时）：正在等的 flush 也不等了（规范里出错、close 都会让 flush 失败，这里不指望它）
  const halted = new Promise((_, rej) => { halt = rej; });
  halted.catch(() => {});
  const enc = new AE({
    output: (chunk, meta) => {
      const u = new Uint8Array(chunk.byteLength);
      chunk.copyTo(u);
      frames.push(u);
      if (firstTs == null) firstTs = Number(chunk.timestamp) || 0;
      const dc = meta && meta.decoderConfig;
      if (dc) {
        if (dc.description) description = copyBytes(dc.description);
        if (dc.sampleRate) sampleRate = dc.sampleRate;
        if (dc.numberOfChannels) channels = dc.numberOfChannels;
      }
    },
    error: (e) => { broke = broke || e || fail('encoder'); halt(broke); if (wake) wake(); },
  });
  const stop = () => { try { if (enc.state !== 'closed') enc.close(); } catch (e) { /* 已经关了 */ } };
  const onAbort = () => { broke = broke || fail('aborted'); stop(); halt(broke); if (wake) wake(); };
  // 等编码器手上的块少下去：dequeue 事件（规范里块数一减少就发）；出错、中止时由上面叫醒
  const dequeue = typeof enc.addEventListener === 'function' && 'ondequeue' in enc;
  const drained = () => (dequeue ? new Promise((resolve) => { wake = resolve; enc.addEventListener('dequeue', resolve, { once: true }); }) : nextTask());
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    enc.configure(config);
    const block = Math.max(1, Math.round(sr * BLOCK_SEC)), int16 = pcm instanceof Int16Array;
    const feed = async (data, at) => {
      const ad = new AD({ format: 'f32-planar', sampleRate: sr, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round(at * 1e6 / sr), data });
      try { enc.encode(ad); } finally { try { ad.close(); } catch (e) { /* 编码器已经复制了一份 */ } }
      while (!broke && enc.encodeQueueSize > QUEUE_MAX) await drained();
      wake = null;
    };
    if (lead > 0) await feed(new Float32Array(lead), 0);
    for (let i = 0; i < pcm.length; i += block) {
      if (broke) throw broke;
      const n = Math.min(block, pcm.length - i), data = new Float32Array(n);
      if (int16) for (let k = 0; k < n; k++) data[k] = pcm[i + k] / 32768;
      else data.set(pcm.subarray(i, i + n));
      await feed(data, lead + i);
    }
    if (broke) throw broke;
    await Promise.race([enc.flush(), halted]);
    if (broke) throw broke;
  } catch (e) {
    throw broke || e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    stop();
  }
  return { frames, description, sampleRate: sampleRate || sr, channels: channels || 1, firstTs: firstTs ?? 0, lead: Math.max(0, lead) };
}

function copyBytes(d) {
  if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  return null;
}

// ---------- AudioSpecificConfig ----------

/**
 * decoderConfig.description → ASC（Uint8Array）| null。认三种：裸 ASC；ES_Descriptor（03 开头，WebKit 给的就是这个）；
 * 整个 esds 盒子 / 前面带 4 字节版本标志的 ES_Descriptor。认不出 → null
 */
export function ascFromDescription(desc) {
  const u = desc instanceof Uint8Array ? desc : copyBytes(desc);
  if (!u || !u.length) return null;
  let p = 0;
  if (u.length >= 13 && String.fromCharCode(u[4], u[5], u[6], u[7]) === 'esds') p = 12;
  else if (u.length >= 6 && u[0] === 0 && u[1] === 0 && u[2] === 0 && u[3] === 0 && u[4] === 0x03) p = 4;
  if (u[p] === 0x03) return ascFromEs(u, p);
  // 裸 ASC：头 5 位是编码类型，0 不是合法的（所以 03、00 开头的不会是裸 ASC）
  return parseAsc(u) ? u.slice() : null;
}

/** [tag][长度：每字节 7 位，最多 4 字节][内容] → { tag, body, end } | null */
function readDesc(u, p, end) {
  if (p + 2 > end) return null;
  const tag = u[p++];
  let len = 0, k = 0, b;
  do {
    if (p >= end || k++ === 4) return null;
    b = u[p++];
    len = len * 128 + (b & 0x7f);
  } while (b & 0x80);
  return p + len <= end ? { tag, body: p, end: p + len } : null;
}
function ascFromEs(u, p) {
  const es = readDesc(u, p, u.length);
  if (!es || es.tag !== 0x03 || es.body + 3 > es.end) return null;
  let q = es.body + 2;                                   // ES_ID
  const flags = u[q++];
  if (flags & 0x80) q += 2;                              // dependsOn_ES_ID
  if (flags & 0x40) q += 1 + (q < es.end ? u[q] : 0);   // URL
  if (flags & 0x20) q += 2;                              // OCR_ES_Id
  while (q < es.end) {
    const d = readDesc(u, q, es.end);
    if (!d) return null;
    if (d.tag === 0x04) {                                // DecoderConfigDescriptor：13 字节固定字段以后是 DecoderSpecificInfo（05）= ASC
      for (let r = d.body + 13; r < d.end;) {
        const s = readDesc(u, r, d.end);
        if (!s) return null;
        if (s.tag === 0x05) { const asc = u.slice(s.body, s.end); return parseAsc(asc) ? asc : null; }
        r = s.end;
      }
      return null;
    }
    q = d.end;
  }
  return null;
}

/** ASC → { aot, sampleRate, channels, frameLen } | null（只认得 GASpecificConfig 的帧长：AAC-LC 一般 1024，960 的也认） */
export function parseAsc(asc) {
  const u = asc instanceof Uint8Array ? asc : copyBytes(asc);
  if (!u || u.length < 2) return null;
  let bit = 0;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++, bit++) { if (bit >= u.length * 8) throw fail('asc'); v = v * 2 + ((u[bit >> 3] >> (7 - (bit & 7))) & 1); } return v; };
  try {
    let aot = read(5);
    if (aot === 31) aot = 32 + read(6);
    const fi = read(4), sampleRate = fi === 15 ? read(24) : RATES[fi];
    const channels = read(4);
    if (!aot || !sampleRate) return null;
    const frameLen = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].includes(aot) ? (read(1) ? 960 : 1024) : 1024;
    return { aot, sampleRate, channels, frameLen };
  } catch (e) { return null; }
}

/** AAC-LC 的 ASC（没给 description 时自己写）：2 字节 = 类型 5 位、采样率序号 4 位、声道 4 位、3 位 0 */
export function makeAsc(sampleRate = SR, channels = 1, aot = 2) {
  const fi = RATES.indexOf(sampleRate);
  if (fi < 0) return null;
  const v = (aot << 11) | (fi << 7) | (channels << 3);
  return Uint8Array.of(v >> 8, v & 0xff);
}

// ---------- 拼文件 ----------

const four = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
function cat(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (const a of list) { out.set(a, p); p += a.length; }
  return out;
}
/** 大端 32 位：u32(1, 2, …) 或 u32s(数组)（几千帧的长度表不展开成参数） */
function u32s(v) { const out = new Uint8Array(v.length * 4), dv = new DataView(out.buffer); for (let i = 0; i < v.length; i++) dv.setUint32(i * 4, v[i] >>> 0); return out; }
const u32 = (...v) => u32s(v);
function u16(...v) { const out = new Uint8Array(v.length * 2), dv = new DataView(out.buffer); v.forEach((x, i) => dv.setUint16(i * 2, x & 0xffff)); return out; }
const zeros = (n) => new Uint8Array(n);
function box(type, ...kids) {
  const body = cat(kids), out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(four(type), 4);
  out.set(body, 8);
  return out;
}
const fullBox = (type, version, flags, ...kids) => box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...kids);
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);
/** 描述符：[tag][长度][内容]，长度 ≥ 128 时用 4 字节的写法 */
function desc(tag, ...kids) {
  const body = cat(kids), n = body.length;
  const len = n < 128 ? [n] : [0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127];
  return cat([Uint8Array.of(tag, ...len), body]);
}

/**
 * 一帧帧 AAC → 整个 m4a 文件（Uint8Array）。
 * @param {{ asc: Uint8Array, frames: Uint8Array[], samples: number, priming?: number, sampleRate?: number, channels?: number,
 *           frameLen?: number, createdAt?: number|null }} o
 *   samples：原来的 PCM 有几个样本（文件的时长）；priming：开头要跳过的样本数（剩下凑整帧的是结尾补的）；createdAt：录音开始的时刻（毫秒），写进 mvhd / tkhd / mdhd
 */
export function muxM4a(o) {
  const { asc, frames, samples, priming = 0, sampleRate: sr = SR, channels = 1, frameLen = 1024, createdAt = null } = o;
  const total = frames.length * frameLen;
  if (!asc || !asc.length || !frames.length || !(samples > 0) || priming < 0 || priming + samples > total) throw fail('mux', 'bad input');
  const t = Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt / 1000) + MAC_EPOCH : 0;
  const sizes = frames.map(f => f.length);
  let bytes = 0, biggest = 0;
  for (const x of sizes) { bytes += x; if (x > biggest) biggest = x; }
  // esds 里的码率：平均 = 总字节 / 时长；最高 = 任意连续 1 秒（16 帧左右）里最多的；缓冲 = 最大的一帧
  const win = Math.max(1, Math.round(sr / frameLen));
  let run = 0, most = 0;
  for (let i = 0; i < sizes.length; i++) { run += sizes[i] - (i >= win ? sizes[i - win] : 0); if (run > most) most = run; }
  const avg = Math.round(bytes * 8 * sr / total), max = Math.max(avg, Math.round(most * 8 * sr / (Math.min(win, sizes.length) * frameLen)));
  const esds = fullBox('esds', 0, 0, desc(0x03, u16(0), Uint8Array.of(0),
    desc(0x04, Uint8Array.of(0x40, 0x15), Uint8Array.of((biggest >> 16) & 255, (biggest >> 8) & 255, biggest & 255), u32(max, avg),
      desc(0x05, asc)),
    desc(0x06, Uint8Array.of(0x02))));
  const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(channels, 16, 0, 0), u32(sr * 65536), esds);
  const ftyp = box('ftyp', Uint8Array.from(four('M4A ')), u32(0), Uint8Array.from([...four('M4A '), ...four('mp42'), ...four('isom')]));
  const moovFor = (offset) => {
    const stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1), mp4a),
      fullBox('stts', 0, 0, u32(1, frames.length, frameLen)),
      fullBox('stsc', 0, 0, u32(1, 1, frames.length, 1)),            // 一个 chunk 装下所有帧
      fullBox('stsz', 0, 0, u32(0, frames.length), u32s(sizes)),
      fullBox('stco', 0, 0, u32(1, offset)));
    const minf = box('minf', fullBox('smhd', 0, 0, u16(0, 0)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl);
    const mdia = box('mdia',
      fullBox('mdhd', 0, 0, u32(t, t, sr, total), u16(0x55c4, 0)),   // 语言 und
      fullBox('hdlr', 0, 0, u32(0), Uint8Array.from(four('soun')), zeros(12), Uint8Array.from([...'SoundHandler'].map(c => c.charCodeAt(0)).concat(0))),
      minf);
    // 电影的时间单位也用采样率（不丢精度）：mvhd / tkhd 是 PCM 的时长，mdhd 是所有帧；去掉的头尾在 iTunSMPB 里
    const trak = box('trak', fullBox('tkhd', 0, 3, u32(t, t, 1, 0, samples), zeros(8), u16(0, 0, 0x0100, 0), MATRIX, u32(0, 0)), mdia);
    const mvhd = fullBox('mvhd', 0, 0, u32(t, t, sr, samples, 0x00010000), u16(0x0100, 0), zeros(8), MATRIX, zeros(24), u32(2));
    return box('moov', mvhd, trak, smpbBox(priming, total - priming - samples, samples));
  };
  const head = ftyp.length + moovFor(0).length + 8;                    // moov 的长度和 stco 里的数无关：先算一遍长度
  const moov = moovFor(head);
  const mdat = new Uint8Array(8 + bytes);
  new DataView(mdat.buffer).setUint32(0, mdat.length);
  mdat.set(four('mdat'), 4);
  let p = 8;
  for (const f of frames) { mdat.set(f, p); p += f.length; }
  return cat([ftyp, moov, mdat]);
}

const text = (str) => Uint8Array.from([...str].map(c => c.charCodeAt(0) & 0xff));
/** udta/meta/ilst 里的 iTunSMPB（Apple 的写法：「 00000000 预热 补齐 有效样本数 00000000 × 8」，十六进制大写） */
function smpbBox(priming, remainder, valid) {
  const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
  const s = ' ' + [hex(0, 8), hex(priming, 8), hex(remainder, 8), hex(valid, 16), ...Array(8).fill(hex(0, 8))].join(' ');
  const item = box('----', fullBox('mean', 0, 0, text('com.apple.iTunes')), fullBox('name', 0, 0, text('iTunSMPB')), box('data', u32(1, 0), text(s)));
  return box('udta', fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, u32(0), text('mdir'), text('appl'), zeros(10)), box('ilst', item)));
}

// ---------- 核对 ----------

/** 均方根（Int16 按 ±32768 折成 ±1）：[from, to) 一段；NaN、无穷大 → NaN */
export function rmsOf(pcm, from = 0, to = pcm.length) {
  const k = pcm instanceof Int16Array ? 1 / 32768 : 1, end = Math.min(to, pcm.length);
  let s = 0;
  for (let i = from; i < end; i++) { const x = pcm[i] * k; s += x * x; }
  return end > from ? Math.sqrt(s / (end - from)) : 0;
}
const dbOf = (r) => Math.round(20 * Math.log10(r + 1e-12) * 10) / 10;
const QUIET = 1e-4;                                   // −80 dBFS 以下算静音
const WIN = 512;                                      // 逐段比：每 512 个样本（32 毫秒）一段：丢了 64 毫秒以上，不管从哪儿开始，总有一整段是空的
                                                      //（一段 64 毫秒的话，丢的正好跨两段时每段只少一半，看不出来；AAC 的帧和这些段正好错开 64 个样本）
const WIN_FLOOR = 10 ** (-75 / 20), WIN_REL = 0.01;   //   比哪些段：原来 ≥ 最响那段 −40 dB、也 ≥ −75 dBFS 的（很轻的悄悄话也比：只比 −50 dBFS 以上的话，
                                                      //   −58 dBFS 的悄悄话中间丢了一秒也看不出来）
const RANGE = 4;                                      // 音量最多差 4 倍（±12 dB）；实测 WebKit 说话、噪声每段最多差 4 dB（多数 < 1.5 dB）
export const ALIGN = Object.freeze({
  SEC: 0.5, LAG: 2048,                                // 对齐：原来最响的那段为中心取 0.5 秒，偏移 ±2048 个样本逐个算归一化的互相关
  MIN: 0.7, SLACK: 0.02,                              // 偏移 0 的要 ≥ 0.7，而且比最好的那个偏移最多差 0.02（实测 WebKit 都是偏移 0 最好：说话 0.997–0.999，白噪声 0.92）
  MIN_LEN: 2048,                                      // 不到 2048 个样本的片段不比（太短，算不准）
});

/**
 * 对齐：pcm 的 [from, to) 和 out 错开 g 个样本（out[i + g] 对 pcm[i]，g 在 ±maxLag 以内）的归一化互相关
 * → { lag: 最好的偏移, best: 它的互相关, at0: 偏移 0 的 }。偏移以后重叠不到一半的不算
 */
export function alignOf(pcm, out, from, to, maxLag = ALIGN.LAG) {
  const k = pcm instanceof Int16Array ? 1 / 32768 : 1, len = to - from, x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = pcm[from + i] * k;
  const L = Math.min(maxLag, Math.floor(len / 2));
  let best = -Infinity, lag = 0, at0 = 0;
  for (let g = -L; g <= L; g++) {
    const a = Math.max(0, -g - from), b = Math.min(len, out.length - g - from);
    let xy = 0, xx = 0, yy = 0;
    for (let i = a, j = from + a + g; i < b; i++, j++) { const u = x[i], v = out[j]; xy += u * v; xx += u * u; yy += v * v; }
    const c = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
    if (g === 0) at0 = c;
    if (c > best) { best = c; lag = g; }
  }
  return { lag, best, at0 };
}

/**
 * 解码回来核对 → { ok, why, durationSec, rmsDb, srcRmsDb, at?, lag?, corr? }：
 *   文件头的时长（readMp4Meta）、解码出来的时长都和 PCM 差 ≤ tolSec（why 'header' / 'duration'）；
 *   整段音量差在 ±12 dB 以内（原来不是静音的没变成静音，原来是静音的没多出声音；why 'level'）；
 *   原来有声音（最响那段 −40 dB 以内、≥ −75 dBFS）的每 32 毫秒也在 ±12 dB 以内（中间、开头没有丢一截；why 'dropout'，at = 第几个样本）；
 *   没有错开：原来最响的那半秒，偏移 0 的互相关 ≥ 0.7、而且差不多是最好的（why 'align'，lag = 最好的偏移，corr = 偏移 0 的互相关）。
 *   音量只差一点的错开（预热算错了、中间丢了一帧后面全挪了）只有这一步看得出来。
 * decode 出错照样抛
 */
export async function verifyM4a(blob, pcm, { sr = SR, decode = decode16k, tolSec = TOLERANCE_SEC } = {}) {
  const want = pcm.length / sr, src = rmsOf(pcm);
  const res = (ok, why, extra = {}) => ({ ok, why, srcRmsDb: dbOf(src), ...extra });
  const meta = readMp4Meta(new Uint8Array(await blob.arrayBuffer()));
  if (meta.durationSec == null || Math.abs(meta.durationSec - want) > tolSec) return res(false, 'header', { durationSec: meta.durationSec });
  const out = await decode(blob);
  const got = out && out.length != null ? out.length / sr : NaN, rms = out ? rmsOf(out) : NaN;
  const r = res(false, null, { durationSec: Math.round(got * 1000) / 1000, rmsDb: dbOf(rms) });
  if (!(Math.abs(got - want) <= tolSec)) return { ...r, why: 'duration' };
  if (!Number.isFinite(rms)) return { ...r, why: 'level' };
  if (src > QUIET ? rms < src / RANGE || rms > src * RANGE : rms > QUIET * RANGE) return { ...r, why: 'level' };
  const wins = Math.floor(Math.min(pcm.length, out.length) / WIN), lv = new Float64Array(wins);
  let loud = 0, at = 0;
  for (let w = 0; w < wins; w++) { lv[w] = rmsOf(pcm, w * WIN, w * WIN + WIN); if (lv[w] > loud) { loud = lv[w]; at = w * WIN; } }
  const gate = Math.max(WIN_FLOOR, loud * WIN_REL);
  for (let w = 0; w < wins; w++) {
    const a = lv[w];
    if (a < gate) continue;
    const b = rmsOf(out, w * WIN, w * WIN + WIN);
    if (!(b >= a / RANGE && b <= a * RANGE)) return { ...r, why: 'dropout', at: w * WIN };
  }
  if (src <= QUIET || pcm.length < ALIGN.MIN_LEN) return { ...r, ok: true };
  // 最响的那段（没有整段的就从头）为中心取 0.5 秒
  const half = Math.round(ALIGN.SEC * sr / 2), mid = wins ? at + WIN / 2 : pcm.length >> 1;
  const from = Math.max(0, Math.min(pcm.length - 2 * half, mid - half)), to = Math.min(pcm.length, from + 2 * half);
  const al = alignOf(pcm, out, from, to);
  const extra = { lag: al.lag, corr: Math.round(al.at0 * 1000) / 1000 };
  if (!(al.at0 >= ALIGN.MIN && al.at0 >= al.best - ALIGN.SLACK)) return { ...r, ...extra, why: 'align' };
  return { ...r, ...extra, ok: true };
}

// ---------- 连起来 ----------

/**
 * PCM（16 kHz 单声道）→ 核对过的 m4a（Blob audio/mp4）| null（不支持、出错、超时、核对不过 → null，调用方存 WAV）。
 * @param {Int16Array|Float32Array} pcm
 * @param {{ sr?: number, createdAt?: number|null, timeoutMs?: number, decode?: Function, AudioEncoder?: any, AudioData?: any,
 *           OfflineAudioContext?: any, onResult?: (r: object) => void }} [o]
 *   没给 decode 时用 decode16k（要 OfflineAudioContext：没有就不做，核对不了的不存）；onResult 收到 { ok, why, … }（诊断、测试用）
 */
export async function pcmToM4a(pcm, o = {}) {
  const { sr = SR, createdAt = null, onResult = null } = o;
  const report = (r) => { if (onResult) try { onResult(r); } catch (e) { /* 只是报告 */ } return null; };
  const AE = 'AudioEncoder' in o ? o.AudioEncoder : globalThis.AudioEncoder;
  if (!pcm || !pcm.length || typeof AE !== 'function') return report({ ok: false, why: 'unsupported' });
  const timeoutMs = o.timeoutMs ?? budgetMs(pcm.length / sr);
  let decode = o.decode;
  if (!decode) {
    const AC = 'OfflineAudioContext' in o ? o.OfflineAudioContext : (globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext);
    if (!AC) return report({ ok: false, why: 'unsupported' });
    decode = (b) => decode16k(b, { AC });
  }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const late = new Promise((_, rej) => { timer = setTimeout(() => { if (ctl) ctl.abort(); rej(fail('timeout')); }, timeoutMs); });
  const t0 = Date.now();
  try {
    const run = (async () => {
      const e = await encodeAac(pcm, { lead: LEAD, ...o, AudioEncoder: AE, sr, signal: ctl && ctl.signal });
      const asc = e.description ? ascFromDescription(e.description) : makeAsc(sr, 1);
      const a = asc && parseAsc(asc);
      if (!a || a.aot !== 2 || a.sampleRate !== sr || a.channels !== 1 || e.sampleRate !== sr || e.channels !== 1) throw fail('config', a ? `${a.aot}/${a.sampleRate}/${a.channels}` : 'asc');
      if (!e.frames.length || e.frames.some(f => !f.length)) throw fail('frames');
      const n = pcm.length, fl = a.frameLen;
      // 要跳过的开头 = 编码器的预热（时间戳是负的——有的编码器这样标——就按它，不然按标准的 2112）+ 垫的 0。
      // 帧数得正好是 ⌈(预热 + PCM) / 帧长⌉：少了（丢了帧）、多了（预热不是 2112 又没标出来）都会让声音错开或者丢掉结尾，存 WAV
      //（以前少了帧时把预热截短、凑够 PCM 的长度，文件照样存下来，只是错开了）
      const priming = (e.firstTs < 0 ? Math.round(-e.firstTs * sr / 1e6) : PRIMING) + e.lead, want = Math.ceil((priming + n) / fl);
      if (e.frames.length !== want) throw fail('frames', `${e.frames.length} ≠ ${want}`);
      const bytes = muxM4a({ asc, frames: e.frames, samples: n, priming, sampleRate: sr, channels: 1, frameLen: fl, createdAt });
      const blob = new Blob([bytes], { type: 'audio/mp4' });
      const v = await verifyM4a(blob, pcm, { sr, decode });
      return { blob, v, frames: e.frames.length, priming };
    })();
    run.catch(() => {});                                // 超时以后它自己失败也不算没接住
    const { blob, v, frames, priming } = await Promise.race([run, late]);
    const r = { ...v, bytes: blob.size, frames, priming, ms: Date.now() - t0 };
    if (onResult) report(r);
    if (!v.ok) { console.warn('m4a: check failed', r); return null; }
    return blob;
  } catch (e) {
    const why = (e && e.code) || 'error';
    if (why !== 'unsupported') console.warn('m4a', e);
    return report({ ok: false, why, error: (e && e.message) || String(e), ms: Date.now() - t0 });
  } finally {
    clearTimeout(timer);
  }
}
