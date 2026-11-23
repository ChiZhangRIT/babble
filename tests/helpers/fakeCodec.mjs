// 导入转 m4a 的测试用的假浏览器（全是编的数字，不是录音）：
//   wavBytes(channels, sr)     Int16Array（每个声道一个）→ WAV 文件的字节（16 位 PCM）；byteRate 可以写成别的（「很长的」WAV）
//   tone(n, seed, amp)         编的「声音」：几个正弦叠起来、慢慢起伏
//   FakeAudioData              同 WebCodecs AudioData（f32-planar，单声道）
//   fakeEncoder(o)             假 AudioEncoder（无损：每帧原样存 1024 个 Int16，后面再跟 1 个字节的「第几个编码器」——每次编出来都不一样，
//                              和不保证每次一样的真编码器一样）；开头先出 2112 个 0 的预热；supported(cfg)：isConfigSupported 的回答；failAt / flushHang
//   fakeAC(o)                  假 OfflineAudioContext：decodeAudioData 认 WAV（线性插值到 context 的采样率）和假编码器编出来的 m4a（照 iTunSMPB 去头去尾）；
//                              别的（编的 MP3、坏文件）解不了。hang：永远不回；silent：m4a 解出来全是 0（核对不过）；log 记下每次解码的采样率
import { makeAsc, PRIMING } from '../../src/core/m4a.js';

export function tone(n, seed = 1, amp = 8000) {
  return Int16Array.from({ length: n }, (_, i) => Math.round(amp * (0.6 * Math.sin((i + seed * 37) * 0.031 * (1 + seed % 3)) + 0.3 * Math.sin(i * 0.0071 * seed)) * (0.6 + 0.4 * Math.sin(i / 900))));
}

export function wavBytes(channels, sr, { byteRate = null } = {}) {
  const ch = channels.length, n = channels[0].length, data = n * ch * 2, u = new Uint8Array(44 + data), dv = new DataView(u.buffer);
  const tag = (p, s) => { for (let i = 0; i < 4; i++) u[p + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + data, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, byteRate ?? sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, data, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) dv.setInt16(44 + (i * ch + c) * 2, channels[c][i], true);
  return u;
}

export class FakeAudioData {
  constructor(o) {
    Object.assign(this, { format: o.format, sampleRate: o.sampleRate, numberOfFrames: o.numberOfFrames, numberOfChannels: o.numberOfChannels, timestamp: o.timestamp });
    this.data = Float32Array.from(o.data);
  }
  copyTo(dst) { dst.set(this.data); }
  close() {}
}

let instances = 0;
export function fakeEncoder({ supported = () => true, failAt = null, flushHang = false } = {}) {
  const log = { configs: [], asked: [], encoded: 0, closed: 0 };
  class AE {
    static async isConfigSupported(c) { log.asked.push(c); return { supported: !!supported(c), config: c }; }
    constructor({ output, error }) { Object.assign(this, { output, error, state: 'unconfigured', encodeQueueSize: 0, id: ++instances }); }
    configure(c) { log.configs.push(c); Object.assign(this, { cfg: c, state: 'configured', buf: [new Float32Array(PRIMING)], have: PRIMING, sent: 0 }); }
    encode(ad) {
      if (this.state !== 'configured') throw new Error('InvalidStateError');
      log.encoded++;
      if (failAt != null && log.encoded > failAt) { queueMicrotask(() => this.error(new Error('encoder broke (injected)'))); return; }
      const f = new Float32Array(ad.numberOfFrames);
      ad.copyTo(f, { planeIndex: 0 });
      this.buf.push(f); this.have += f.length;
      this.drain(false);
    }
    drain(final) {
      while (this.have >= 1024 || (final && this.have > 0)) {
        const out = new Float32Array(1024);
        let k = 0;
        while (k < 1024 && this.buf.length) {
          const b = this.buf[0], take = Math.min(b.length, 1024 - k);
          out.set(b.subarray(0, take), k); k += take;
          if (take === b.length) this.buf.shift(); else this.buf[0] = b.subarray(take);
        }
        this.have = Math.max(0, this.have - 1024);
        const bytes = new Uint8Array(2049);
        new Int16Array(bytes.buffer, 0, 1024).set(Int16Array.from(out, x => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))));
        bytes[2048] = this.id & 255;
        const i = this.sent++;
        this.output({ type: 'key', timestamp: i * Math.round(1024 * 1e6 / this.cfg.sampleRate), byteLength: bytes.length, copyTo: (d) => d.set(bytes) },
          i === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: this.cfg.sampleRate, numberOfChannels: 1, description: makeAsc(this.cfg.sampleRate, 1) } } : undefined);
      }
    }
    flush() { return flushHang ? new Promise(() => {}) : Promise.resolve().then(() => this.drain(true)); }
    close() { this.state = 'closed'; log.closed++; }
  }
  return { AE, log };
}

// ---------- 读假 m4a ----------
const dvOf = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
function kids(u, from, to) {
  const out = [], dv = dvOf(u);
  for (let p = from; p + 8 <= to;) {
    const size = dv.getUint32(p);
    if (size < 8) break;
    out.push({ type: String.fromCharCode(...u.subarray(p + 4, p + 8)), start: p, body: p + 8, end: p + size });
    p += size;
  }
  return out;
}
const FULL = { meta: 4, stsd: 8, dref: 8 };
export function box(u, ...types) {
  let list = kids(u, 0, u.length), b = null;
  for (const t of types) {
    b = list.find(x => x.type === t);
    if (!b) return null;
    list = kids(u, b.body + (FULL[t] ?? (t === 'mp4a' ? 28 : 0)), b.end);
  }
  return b;
}
function fakeM4aPcm(u) {
  const dv = dvOf(u), stsz = box(u, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz'), stco = box(u, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stco');
  const mdhd = box(u, 'moov', 'trak', 'mdia', 'mdhd');
  const sr = dv.getUint32(mdhd.body + 12), n = dv.getUint32(stsz.body + 8);
  let p = dv.getUint32(stco.body + 8);
  const all = new Float32Array(n * 1024);
  for (let i = 0; i < n; i++) {
    const size = dv.getUint32(stsz.body + 12 + i * 4);
    for (let k = 0; k < 1024 && k * 2 + 1 < size; k++) all[i * 1024 + k] = dv.getInt16(p + k * 2, true) / 32768;
    p += size;
  }
  const item = box(u, 'moov', 'udta', 'meta', 'ilst', '----');
  const data = kids(u, item.body, item.end).find(x => x.type === 'data');
  const f = String.fromCharCode(...u.subarray(data.body + 8, data.end)).trim().split(/\s+/).map(x => parseInt(x, 16));
  return { sr, channels: [all.slice(f[1], f[1] + f[3])] };
}
function wavPcm(u) {
  const dv = dvOf(u), tag = (p) => String.fromCharCode(...u.subarray(p, p + 4));
  if (u.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let ch = 1, sr = 0, p = 12;
  while (p + 8 <= u.length) {
    const id = tag(p), len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') { ch = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); }
    if (id === 'data') {
      const n = Math.floor(Math.min(len, u.length - p - 8) / (2 * ch)), out = Array.from({ length: ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = dv.getInt16(p + 8 + (i * ch + c) * 2, true) / 32768;
      return { sr, channels: out };
    }
    p += 8 + len + (len & 1);
  }
  return null;
}
/** 线性插值换采样率 */
export function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.round(x.length * to / from), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i * from / to, a = Math.floor(t), f = t - a; out[i] = (x[a] ?? 0) * (1 - f) + (x[Math.min(a + 1, x.length - 1)] ?? 0) * f; }
  return out;
}

export function fakeAC({ hang = false, silent = false } = {}) {
  const log = { rates: [], decoded: 0 };
  class AC {
    constructor(ch, len, sr) { this.sampleRate = sr; log.rates.push(sr); }
    decodeAudioData(buf, ok, bad) {
      const p = new Promise((resolve, reject) => {
        if (hang) return;
        const u = new Uint8Array(buf);
        const isMp4 = u.length > 8 && String.fromCharCode(...u.subarray(4, 8)) === 'ftyp';
        let src = null;
        try { src = isMp4 ? fakeM4aPcm(u) : wavPcm(u); } catch (e) { src = null; }
        if (!src) { reject(new Error('EncodingError: Decoding failed (fake)')); return; }
        log.decoded++;
        const chans = src.channels.map(c => resample(c, src.sr, this.sampleRate));
        if (silent && isMp4) for (const c of chans) c.fill(0);
        resolve({ numberOfChannels: chans.length, length: chans[0].length, sampleRate: this.sampleRate, duration: chans[0].length / this.sampleRate, getChannelData: (i) => chans[i] });
      });
      p.then(ok, bad);
      return p;
    }
  }
  return { AC, log };
}

/** 一套能转的假浏览器：{ AudioEncoder, AudioData, OfflineAudioContext } + 两个 log */
export function fakeBrowser(o = {}) {
  const enc = fakeEncoder(o.encoder), ac = fakeAC(o.ac);
  return { opts: { AudioEncoder: enc.AE, AudioData: FakeAudioData, OfflineAudioContext: ac.AC }, enc: enc.log, ac: ac.log };
}
