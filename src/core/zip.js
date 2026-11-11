// 最简 zip（只存储不压缩：m4a 本来就压缩过）。文件名 UTF-8（通用位标志第 11 位），带 UTC 修改时间（0x5455 扩展字段）。
// 读：支持只存储的条目；别的工具压缩过的（deflate）有 DecompressionStream 时也能读（比如在 Mac 上解压后又重新压缩的备份）。
// 不支持 zip64（单个文件或整个包超过 4GB、超过 65535 个文件）。

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const MAX32 = 0xFFFFFFFF;
const enc = new TextEncoder();

/** zip 读写出错：code = 'notZip' | 'unsupported' | 'crc' | 'tooBig' | 'dupName' */
export class ZipError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** 32 位 CRC → 无符号整数。可以分段算：crc32(b, crc32(a)) === crc32(a + b) */
export function crc32(bytes, crc = 0) {
  const T = table();
  let c = (crc ^ MAX32) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('zip: unsupported data');
}

// DOS 时间（本地时间，2 秒精度，1980–2107）
function dosDateTime(d) {
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  if (y !== d.getFullYear()) return { time: 0, date: ((y - 1980) << 9) | (1 << 5) | 1 };
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function fromDos(date, time) {
  if (!date) return null;
  const d = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
  return Number.isNaN(d.getTime()) ? null : d;
}
// 0x5455 扩展时间字段：只放修改时间（UTC 秒），解压后时间不受时区影响
function extTime(d) {
  const b = new Uint8Array(9), v = new DataView(b.buffer);
  v.setUint16(0, 0x5455, true); v.setUint16(2, 5, true); v.setUint8(4, 1);
  v.setUint32(5, Math.max(0, Math.min(MAX32, Math.floor(d.getTime() / 1000))), true);
  return b;
}

/**
 * @param {Array<{name: string, data: Uint8Array|Blob|ArrayBuffer|string, date?: Date}>} files  name 用 / 分隔目录
 * @returns {Promise<Blob>} application/zip
 */
export async function createZip(files) {
  const parts = [], central = [], seen = new Set();
  let offset = 0;
  for (const f of files) {
    const name = String(f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new ZipError('dupName', '(empty)');
    if (seen.has(name)) throw new ZipError('dupName', name);
    seen.add(name);
    const nameBytes = enc.encode(name);
    const data = await toBytes(f.data);
    const size = data.length, crc = crc32(data);
    const when = f.date instanceof Date && !Number.isNaN(f.date.getTime()) ? f.date : new Date();
    const { time, date } = dosDateTime(when), extra = extTime(when);
    if (size >= MAX32 || offset + 30 + nameBytes.length + extra.length + size >= MAX32) throw new ZipError('tooBig');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, SIG_LOCAL, true);
    lh.setUint16(4, 20, true);              // 解压需要的版本 2.0
    lh.setUint16(6, FLAG_UTF8, true);
    lh.setUint16(8, 0, true);               // 0 = 只存储
    lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, extra.length, true);
    // Blob 原样放进去（不用在内存里再复制一份大录音）
    parts.push(new Uint8Array(lh.buffer), nameBytes, extra, f.data instanceof Blob ? f.data : data);
    central.push({ nameBytes, crc, size, time, date, offset, extra });
    offset += 30 + nameBytes.length + extra.length + size;
  }
  if (central.length > 0xFFFF) throw new ZipError('tooBig');
  const cdStart = offset;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, SIG_CENTRAL, true);
    ch.setUint16(4, (3 << 8) | 20, true);   // 生成方：Unix，2.0（这样文件权限才有意义）
    ch.setUint16(6, 20, true);
    ch.setUint16(8, FLAG_UTF8, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, c.time, true); ch.setUint16(14, c.date, true);
    ch.setUint32(16, c.crc, true); ch.setUint32(20, c.size, true); ch.setUint32(24, c.size, true);
    ch.setUint16(28, c.nameBytes.length, true); ch.setUint16(30, c.extra.length, true);
    ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, (0o100644 << 16) >>> 0, true);   // 普通文件 rw-r--r--
    ch.setUint32(42, c.offset, true);
    parts.push(new Uint8Array(ch.buffer), c.nameBytes, c.extra);
    offset += 46 + c.nameBytes.length + c.extra.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, central.length, true); end.setUint16(10, central.length, true);
  end.setUint32(12, offset - cdStart, true); end.setUint32(16, cdStart, true);
  parts.push(new Uint8Array(end.buffer));
  return new Blob(parts, { type: 'application/zip' });
}

// 按需读一段：Blob 只读需要的部分，不用整个读进内存
function source(input) {
  if (input instanceof Uint8Array) return { size: input.length, read: async (a, b) => input.subarray(a, b) };
  if (input instanceof ArrayBuffer) return source(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return source(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  if (input && typeof input.slice === 'function' && typeof input.size === 'number') {
    return { size: input.size, read: async (a, b) => new Uint8Array(await input.slice(a, b).arrayBuffer()) };
  }
  throw new ZipError('notZip');
}
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function decodeName(bytes, flags) {
  if (flags & FLAG_UTF8) return new TextDecoder().decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }       // Mac 的「压缩」不设标志，但也是 UTF-8
  catch (e) { return String.fromCharCode(...bytes); }
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('unsupported', 'deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Blob|Uint8Array|ArrayBuffer} data
 * @returns {Promise<Array<{name: string, data: Uint8Array, date: Date|null}>>}  不含目录条目；每个文件都校验过 CRC
 */
export async function readZip(data) {
  const src = source(data);
  if (src.size < 22) throw new ZipError('notZip');
  const tailLen = Math.min(src.size, 22 + 0xFFFF);
  const tailStart = src.size - tailLen;
  const tail = await src.read(tailStart, src.size);
  let p = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === SIG_END) { p = i; break; }
  if (p < 0) throw new ZipError('notZip');
  const count = u16(tail, p + 10), cdSize = u32(tail, p + 12), cdOff = u32(tail, p + 16);
  if (count === 0xFFFF || cdSize === MAX32 || cdOff === MAX32) throw new ZipError('unsupported', 'zip64');
  if (cdOff + cdSize > src.size) throw new ZipError('notZip');
  const cd = await src.read(cdOff, cdOff + cdSize);
  const out = [];
  for (let i = 0, q = 0; i < count; i++) {
    if (q + 46 > cd.length || u32(cd, q) !== SIG_CENTRAL) throw new ZipError('notZip');
    const flags = u16(cd, q + 8), method = u16(cd, q + 10), time = u16(cd, q + 12), date = u16(cd, q + 14);
    const crc = u32(cd, q + 16), csize = u32(cd, q + 20), usize = u32(cd, q + 24);
    const nlen = u16(cd, q + 28), xlen = u16(cd, q + 30), clen = u16(cd, q + 32), lho = u32(cd, q + 42);
    const name = decodeName(cd.subarray(q + 46, q + 46 + nlen), flags);
    q += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;                                   // 目录
    if (flags & 1) throw new ZipError('unsupported', 'encrypted');
    if (csize === MAX32 || usize === MAX32 || lho === MAX32) throw new ZipError('unsupported', 'zip64');
    const lh = await src.read(lho, lho + 30);
    if (lh.length < 30 || u32(lh, 0) !== SIG_LOCAL) throw new ZipError('notZip');
    const start = lho + 30 + u16(lh, 26) + u16(lh, 28);                // 本地头的扩展字段长度可能和中央目录里的不同
    if (start + csize > src.size) throw new ZipError('notZip');
    const raw = await src.read(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw;
    else if (method === 8) bytes = await inflateRaw(raw);
    else throw new ZipError('unsupported', 'method ' + method);
    if (bytes.length !== usize || crc32(bytes) !== crc) throw new ZipError('crc', name);
    out.push({ name, data: bytes, date: fromDos(date, time) });
  }
  return out;
}
