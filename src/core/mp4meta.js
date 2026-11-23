// 读 m4a / mp4 文件头：录音时间、时长、品牌。只读不改；读不到就是 null，坏文件、截断的文件也不抛错。
//   时间：moov/mvhd creation_time（1904-01-01 起的 UTC 秒；0 或 2000 年以前当作没有）→ 各轨 mdhd →
//         元数据里带时区的日期（udta/meta/ilst ©day、QuickTime keys 的 com.apple.quicktime.creationdate、udta/©day）
//   时长：mvhd duration / timescale → 不是碎片化的再看 mdhd（先看音轨）。碎片化 MP4（moov 里有 mvex、或有 moof，
//         比如 Safari 边录边切片的文件）duration 是 0：有 mehd 就用它，否则 null（播放器会从 <audio> 读真实时长）。
// mp4AudioCodec(buf)：音轨是什么编码（导入时已经是 AAC 的 m4a 原样存，别的转成 m4a，见 importM4a.js）。

const MAC_EPOCH = 2082844800;                       // 1904-01-01 到 1970-01-01 的秒数
const MIN_MS = Date.UTC(2000, 0, 1), MAX_MS = Date.UTC(2100, 0, 1);
const MAX_BOXES = 4096;                             // 每层最多看这么多个盒子（防坏文件）

/**
 * @param {ArrayBuffer|ArrayBufferView} buf  整个文件（moov 在文件末尾也能读到）
 * @returns {{ createdAt: Date|null, durationSec: number|null, brand: string|null, fragmented: boolean,
 *            createdFrom: 'mvhd'|'mdhd'|'meta'|null }}
 */
export function readMp4Meta(buf) {
  const out = { createdAt: null, durationSec: null, brand: null, fragmented: false, createdFrom: null };
  try {
    const dv = viewOf(buf);
    if (!dv || dv.byteLength < 8) return out;
    const top = boxes(dv, 0, dv.byteLength);
    if (!top.length) return out;
    const ftyp = top.find(b => b.type === 'ftyp');
    if (ftyp && ftyp.end - ftyp.body >= 4) out.brand = fourcc(dv, ftyp.body).trim() || null;
    if (top.some(b => b.type === 'moof')) out.fragmented = true;
    const moov = top.find(b => b.type === 'moov');
    if (!moov) return out;

    const mk = boxes(dv, moov.body, moov.end);
    const mvhd = mk.find(b => b.type === 'mvhd');
    const mvex = mk.find(b => b.type === 'mvex');
    if (mvex) out.fragmented = true;
    const mv = mvhd ? readTimes(dv, mvhd) : null;
    const tracks = mk.filter(b => b.type === 'trak').map(tr => readTrack(dv, tr)).filter(Boolean);

    // 时长
    let dur = seconds(mv);
    if (dur == null && out.fragmented && mvex && mv) {
      const mehd = boxes(dv, mvex.body, mvex.end).find(b => b.type === 'mehd');
      if (mehd) dur = seconds({ timescale: mv.timescale, duration: readFragDuration(dv, mehd) });
    }
    if (dur == null && !out.fragmented) {
      const t = tracks.find(x => x.handler === 'soun' && seconds(x.times) != null) || tracks.find(x => seconds(x.times) != null);
      if (t) dur = seconds(t.times);
    }
    out.durationSec = dur;

    // 录音时间
    let at = macDate(mv), from = at ? 'mvhd' : null;
    if (!at) for (const t of tracks) { at = macDate(t.times); if (at) { from = 'mdhd'; break; } }
    if (!at) { at = metaDate(dv, mk); if (at) from = 'meta'; }
    out.createdAt = at;
    out.createdFrom = from;
    return out;
  } catch (e) {
    return out;
  }
}

/**
 * 音轨（hdlr soun；没标的话第一条轨）的编码：stsd 第一项的类型。'mp4a' 再看 esds 里的 objectTypeIndication：
 * 0x40（MPEG-4 音频）、0x66–0x68（MPEG-2 AAC）→ 'aac'，0x69 / 0x6B → 'mp3'，没有 esds（读不到）也按 'aac'（mp4a 几乎都是）；
 * 别的原样给类型（'alac'、'Opus'、'fLaC'、'ac-3'、'lpcm'…）。不是 mp4、没有音轨、读不到 → null。不抛错
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {string|null}
 */
export function mp4AudioCodec(buf) {
  try {
    const dv = viewOf(buf);
    if (!dv || dv.byteLength < 8) return null;
    const moov = boxes(dv, 0, dv.byteLength).find(b => b.type === 'moov');
    if (!moov) return null;
    const traks = boxes(dv, moov.body, moov.end).filter(b => b.type === 'trak');
    const entries = [];
    for (const tr of traks) {
      const mdia = boxes(dv, tr.body, tr.end).find(b => b.type === 'mdia');
      if (!mdia) continue;
      const kids = boxes(dv, mdia.body, mdia.end), hdlr = kids.find(b => b.type === 'hdlr'), minf = kids.find(b => b.type === 'minf');
      const stbl = minf && boxes(dv, minf.body, minf.end).find(b => b.type === 'stbl');
      const stsd = stbl && boxes(dv, stbl.body, stbl.end).find(b => b.type === 'stsd');
      if (!stsd || stsd.body + 16 > stsd.end) continue;
      const entry = boxes(dv, stsd.body + 8, stsd.end)[0];              // 版本标志 4 + 条目数 4
      if (!entry) continue;
      entries.push({ entry, soun: !!hdlr && hdlr.body + 12 <= hdlr.end && fourcc(dv, hdlr.body + 8) === 'soun' });
    }
    const hit = entries.find(x => x.soun) || entries[0];
    if (!hit) return null;
    if (hit.entry.type !== 'mp4a') return hit.entry.type;
    const oti = esdsOti(dv, hit.entry);
    return oti == null || oti === 0x40 || (oti >= 0x66 && oti <= 0x68) ? 'aac' : oti === 0x69 || oti === 0x6b ? 'mp3' : 'mp4a/' + oti.toString(16);
  } catch (e) {
    return null;
  }
}
/** mp4a 里的 esds（QuickTime 的写法可能套在 wave 里、前面还有 v1 / v2 的字段：直接在 mp4a 里找 'esds' 四个字）→ objectTypeIndication | null */
function esdsOti(dv, entry) {
  for (let p = entry.body; p + 8 <= entry.end; p++) {
    if (dv.getUint8(p + 4) !== 0x65 || fourcc(dv, p + 4) !== 'esds') continue;
    const size = dv.getUint32(p), end = Math.min(entry.end, p + (size >= 12 ? size : entry.end - p));
    let q = p + 12;                                                    // 盒子头 8 + 版本标志 4
    const desc = (tag) => {                                            // [tag][长度：每字节 7 位，最多 4 字节] → 内容的开头 | -1
      if (q >= end || dv.getUint8(q) !== tag) return -1;
      q++;
      for (let k = 0; k < 4 && q < end; k++) if (!(dv.getUint8(q++) & 0x80)) return q;
      return -1;
    };
    if (desc(0x03) < 0 || q + 3 > end) return null;
    const flags = dv.getUint8(q + 2);
    q += 3;                                                            // ES_ID 2 + 标志 1
    if (flags & 0x80) q += 2;
    if (flags & 0x40) q += 1 + (q < end ? dv.getUint8(q) : 0);
    if (flags & 0x20) q += 2;
    return desc(0x04) >= 0 && q < end ? dv.getUint8(q) : null;
  }
  return null;
}

function viewOf(buf) {
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  if (ArrayBuffer.isView(buf)) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}
const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
/** 盒子类型应该是可打印字符（© = 0xA9 也算）：用来认出「这不是 MP4」 */
function is4cc(dv, p) {
  if (p + 4 > dv.byteLength) return false;
  for (let i = 0; i < 4; i++) { const c = dv.getUint8(p + i); if (!((c >= 0x20 && c <= 0x7e) || c === 0xa9)) return false; }
  return true;
}
function u64(dv, p) {
  const hi = dv.getUint32(p), lo = dv.getUint32(p + 4);
  if (hi === 0xffffffff && lo === 0xffffffff) return -1;      // 全 1 = 未知
  const v = hi * 0x100000000 + lo;
  return v > Number.MAX_SAFE_INTEGER ? -1 : v;
}

/** [start, end) 里的盒子 → [{ type, start, body, end }]；超出范围的截到 end，类型不像样就停（anyType：ilst 里的条目类型可以是数字） */
function boxes(dv, start, end, anyType = false) {
  const list = [];
  let p = start;
  while (p + 8 <= end && list.length < MAX_BOXES) {
    let size = dv.getUint32(p);
    if (!anyType && !is4cc(dv, p + 4)) break;
    const type = fourcc(dv, p + 4);
    let body = p + 8;
    if (size === 1) {                         // 64 位长度
      if (p + 16 > end) break;
      size = u64(dv, p + 8);
      if (size < 0) break;
      body = p + 16;
    } else if (size === 0) size = end - p;    // 一直到结尾
    if (size < body - p) break;
    const boxEnd = Math.min(p + size, end);   // 截断的文件：能读多少读多少
    list.push({ type, start: p, body, end: boxEnd });
    p += size;
  }
  return list;
}

/** mvhd / mdhd：版本 0 是 32 位、版本 1 是 64 位的 creation_time、timescale、duration */
function readTimes(dv, b) {
  const p = b.body;
  if (p + 4 > b.end) return null;
  const v = dv.getUint8(p);
  if (v === 1) {
    if (p + 32 > b.end) return null;
    return { created: u64(dv, p + 4), timescale: dv.getUint32(p + 20), duration: u64(dv, p + 24) };
  }
  if (v !== 0 || p + 20 > b.end) return null;
  const d = dv.getUint32(p + 16);
  return { created: dv.getUint32(p + 4), timescale: dv.getUint32(p + 12), duration: d === 0xffffffff ? -1 : d };
}
function readFragDuration(dv, mehd) {
  const p = mehd.body;
  if (p + 8 > mehd.end) return -1;
  if (dv.getUint8(p) === 1) return p + 12 <= mehd.end ? u64(dv, p + 4) : -1;
  return dv.getUint32(p + 4);
}
function readTrack(dv, trak) {
  const mdia = boxes(dv, trak.body, trak.end).find(b => b.type === 'mdia');
  if (!mdia) return null;
  const kids = boxes(dv, mdia.body, mdia.end);
  const mdhd = kids.find(b => b.type === 'mdhd'), hdlr = kids.find(b => b.type === 'hdlr');
  return { times: mdhd ? readTimes(dv, mdhd) : null, handler: hdlr && hdlr.body + 12 <= hdlr.end ? fourcc(dv, hdlr.body + 8) : null };
}
function seconds(t) {
  if (!t || !(t.timescale > 0) || !(t.duration > 0)) return null;
  const v = Math.round((t.duration / t.timescale) * 1000) / 1000;
  return v > 0 && Number.isFinite(v) ? v : null;
}
function macDate(t) {
  if (!t || !(t.created > 0)) return null;
  const ms = (t.created - MAC_EPOCH) * 1000;
  return ms >= MIN_MS && ms < MAX_MS ? new Date(ms) : null;
}

// ---------- 元数据里的日期 ----------
const CREATION_KEY = 'com.apple.quicktime.creationdate';
function metaDate(dv, moovKids) {
  const metas = [];
  const top = moovKids.find(b => b.type === 'meta');
  if (top) metas.push(top);
  const udta = moovKids.find(b => b.type === 'udta');
  const uk = udta ? boxes(dv, udta.body, udta.end) : [];
  const um = uk.find(b => b.type === 'meta');
  if (um) metas.push(um);
  for (const m of metas) {
    const kids = metaKids(dv, m);
    const ilst = kids.find(b => b.type === 'ilst');
    if (!ilst) continue;
    const items = boxes(dv, ilst.body, ilst.end, true);
    const day = items.find(b => b.type === '©day');
    const d1 = day ? parseDay(dataString(dv, day)) : null;
    if (d1) return d1;
    const keys = kids.find(b => b.type === 'keys');
    const idx = keys ? keyIndex(dv, keys, CREATION_KEY) : 0;
    if (idx) {
      const item = items.find(b => dv.getUint32(b.start + 4) === idx);
      const d2 = item ? parseDay(dataString(dv, item)) : null;
      if (d2) return d2;
    }
  }
  // QuickTime 老写法：udta/©day 直接是 [2 字节长度][2 字节语言][文字]
  const qt = uk.find(b => b.type === '©day');
  if (qt && qt.body + 4 <= qt.end) {
    const len = Math.min(dv.getUint16(qt.body), qt.end - qt.body - 4);
    return parseDay(utf8(dv, qt.body + 4, qt.body + 4 + len));
  }
  return null;
}
/** meta 在 ISO/iTunes 里是 FullBox（先 4 字节版本/标志），在 QuickTime 里直接是子盒子：看后面像不像盒子来判断 */
function metaKids(dv, m) {
  const p = m.body;
  const quickTime = p + 8 <= m.end && dv.getUint32(p) >= 8 && is4cc(dv, p + 4);
  return boxes(dv, quickTime ? p : p + 4, m.end);
}
/** ilst 条目里的 data 盒子：[类型 4][地区 4][值] */
function dataString(dv, item) {
  const data = boxes(dv, item.body, item.end).find(b => b.type === 'data');
  if (!data || data.body + 8 > data.end) return '';
  return utf8(dv, data.body + 8, data.end);
}
/** keys：[版本/标志 4][数量 4]，每条 [长度 4][命名空间 4][名字]；返回 1 起的序号，没有 → 0 */
function keyIndex(dv, keys, name) {
  let p = keys.body + 8;
  const n = keys.body + 8 <= keys.end ? dv.getUint32(keys.body + 4) : 0;
  for (let i = 1; i <= n && i <= MAX_BOXES && p + 8 <= keys.end; i++) {
    const size = dv.getUint32(p);
    if (size < 8 || p + size > keys.end) break;
    if (utf8(dv, p + 8, p + size) === name) return i;
    p += size;
  }
  return 0;
}
function utf8(dv, a, b) {
  if (b <= a) return '';
  return new TextDecoder('utf-8').decode(new Uint8Array(dv.buffer, dv.byteOffset + a, b - a)).replace(/\0+$/, '');
}
/** 只认带时区的完整时间（2023-09-09T03:30:00-0700 / …Z）；只有日期或没有时区的不猜 → null */
export function parseDay(s) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss = '0', zone] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +hh > 23 || +mi > 59 || +ss > 60) return null;
  let off = 0;
  if (zone !== 'Z') {
    const z = zone.replace(':', '');
    off = (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3, 5));
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) - off * 60000;
  return ms >= MIN_MS && ms < MAX_MS ? new Date(ms) : null;
}
