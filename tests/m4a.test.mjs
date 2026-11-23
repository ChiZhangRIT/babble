// m4a（床头模式「留下」的录音）：ASC 解析、拼文件、编码（假的 AudioEncoder）、核对和退回 WAV。
// 声音全是编的数字序列（仓库是公开的），不是录音；假编码器是无损的（每帧原样存 1024 个 Int16），假解码器照 Core Audio 实测的做法按 iTunSMPB 去头去尾
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ascFromDescription, parseAsc, makeAsc, muxM4a, encodeAac, verifyM4a, pcmToM4a, rmsOf, alignOf, budgetMs, PRIMING, LEAD, SR, QUEUE_MAX,
} from '../src/core/m4a.js';
import { readMp4Meta } from '../src/core/mp4meta.js';

const hex = (s) => Uint8Array.from(s.match(/../g).map(x => parseInt(x, 16)));
// 实测 WebKit（Mac 上的 WKWebView）给的 decoderConfig.description：整个 ES_Descriptor，长度用 4 字节的写法，ASC = 14 08
const WEBKIT_DESC = hex('038080802200000004808080144014001800000000000000000005808080021408068080800102');
const MAC = 2082844800;

/** 编的 PCM16：seed 不同内容就不同；amp 是峰值 */
const pcm = (n, seed = 1, amp = 8000) => Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((i + seed * 37) * 0.031 * (1 + seed % 3)) * (0.6 + 0.4 * Math.sin(i / 900))));

// ---------- 读盒子（测试自己的一份，不用 m4a.js 里的） ----------
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
const FULL = { meta: 4, stsd: 8, dref: 8 };                        // 子盒子前面还有几个字节（版本标志、条目数）
function find(u, ...types) {
  let list = kids(u, 0, u.length), b = null;
  for (const t of types) {
    b = list.find(x => x.type === t);
    if (!b) return null;
    const skip = FULL[t] ?? (t === 'mp4a' ? 28 : 0);
    list = kids(u, b.body + skip, b.end);
  }
  return b;
}
const u32At = (u, p) => dvOf(u).getUint32(p);
function smpbOf(u) {
  const item = find(u, 'moov', 'udta', 'meta', 'ilst', '----');
  const data = kids(u, item.body, item.end).find(x => x.type === 'data');
  const s = String.fromCharCode(...u.subarray(data.body + 8, data.end));
  const f = s.trim().split(/\s+/).map(x => parseInt(x, 16));
  return { text: s, priming: f[1], remainder: f[2], valid: f[3] };
}
function framesOf(u) {
  const stsz = find(u, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz'), stco = find(u, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stco');
  const n = u32At(u, stsz.body + 8), sizes = Array.from({ length: n }, (_, i) => u32At(u, stsz.body + 12 + i * 4));
  let p = u32At(u, stco.body + 8);
  return sizes.map(s => { const f = u.subarray(p, p + s); p += s; return f; });
}

/** 假解码器：每帧是原样的 1024 个 Int16（小端），照 iTunSMPB 去掉预热和结尾补的（WebKit 的 decodeAudioData 实测就是这样） */
async function fakeDecode(blob) {
  const u = new Uint8Array(await blob.arrayBuffer());
  const frames = framesOf(u), all = new Float32Array(frames.length * 1024);
  frames.forEach((f, i) => { const s = new Int16Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)); for (let k = 0; k < 1024; k++) all[i * 1024 + k] = (s[k] || 0) / 32768; });
  const { priming, valid } = smpbOf(u);
  return all.slice(priming, priming + valid);
}

class FakeAudioData {
  constructor(o) {
    Object.assign(this, { format: o.format, sampleRate: o.sampleRate, numberOfFrames: o.numberOfFrames, numberOfChannels: o.numberOfChannels, timestamp: o.timestamp });
    this.data = Float32Array.from(o.data);
    this.closed = false;
  }
  copyTo(dst) { dst.set(this.data); }
  close() { this.closed = true; }
}

/**
 * 假 AudioEncoder（无损）：开头先出 delay 个 0 的预热（时间戳照样从 0 标，和 WebKit 一样）；quirk：把喂进来的头 1024 个样本当成 0（WebKit 实测的毛病）。
 * desc：decoderConfig.description（null = 不给）；flushHang：flush 永远不回；flushError：flush 时报错（flush 也不回）；failAt：编到第几块时报错。
 * 出毛病的编码器：skip 这几帧不出（restamp：后面的时间戳接着排，看不出丢过）；cut：最后几帧不出
 */
function fakeEncoder({ delay = PRIMING, quirk = true, desc = WEBKIT_DESC, sampleRate = SR, channels = 1, supported = true, flushHang = false, flushError = false, failAt = null, firstTs = 0,
  skip = [], restamp = false, cut = 0 } = {}) {
  const log = { encode: [], closed: 0, configs: [], instances: 0 };
  class AE {
    static async isConfigSupported(c) { log.configs.push(c); return { supported, config: c }; }
    constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.encodeQueueSize = 0; log.instances++; }
    configure(c) { this.cfg = c; this.state = 'configured'; this.buf = [new Float32Array(delay)]; this.have = delay; this.fed = 0; this.sent = 0; this.emitted = 0; this.held = []; }
    encode(ad) {
      if (this.state !== 'configured') throw new Error('InvalidStateError');
      log.encode.push({ ts: ad.timestamp, n: ad.numberOfFrames, format: ad.format, sr: ad.sampleRate });
      if (failAt != null && log.encode.length > failAt) { queueMicrotask(() => this.error(new Error('encoder broke (injected)'))); return; }
      const f = new Float32Array(ad.numberOfFrames);
      ad.copyTo(f, { planeIndex: 0 });
      if (quirk && this.fed < 1024) f.fill(0, 0, Math.min(f.length, 1024 - this.fed));
      this.fed += f.length;
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
        const bytes = new Uint8Array(Int16Array.from(out, x => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))).buffer);
        const i = this.sent++;
        if (skip.includes(i)) continue;
        const at = restamp ? this.emitted + this.held.length : i;
        const chunk = { type: 'key', timestamp: firstTs + at * 64000, duration: 64000, byteLength: bytes.length, copyTo: (d) => d.set(bytes) };
        this.held.push(chunk);
        while (this.held.length > cut) this.emit(this.held.shift());
      }
    }
    emit(chunk) {
      this.output(chunk, this.emitted++ === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, ...(desc ? { description: desc.buffer.slice(0) } : {}) } } : undefined);
    }
    flush() {
      if (flushError) { setTimeout(() => this.error(new Error('flush broke (injected)')), 5); return new Promise(() => {}); }
      return flushHang ? new Promise(() => {}) : Promise.resolve().then(() => this.drain(true));
    }
    close() { this.state = 'closed'; log.closed++; }
  }
  return { AE, log };
}
const deps = (o = {}) => { const f = fakeEncoder(o); return { f, opts: { AudioEncoder: f.AE, AudioData: FakeAudioData, decode: fakeDecode } }; };
async function quiet(fn) {
  const w = console.warn, seen = [];
  console.warn = (...a) => { seen.push(a); };
  try { return [await fn(), seen]; } finally { console.warn = w; }
}

// ---------- ASC ----------

test('ascFromDescription：WebKit 的 ES_Descriptor、裸 ASC、整个 esds 盒子、带版本标志的，都拿到同一个 ASC；认不出的 → null', () => {
  const asc = [0x14, 0x08];
  assert.deepEqual([...ascFromDescription(WEBKIT_DESC)], asc);
  assert.deepEqual([...ascFromDescription(WEBKIT_DESC.buffer)], asc);                           // ArrayBuffer
  assert.deepEqual([...ascFromDescription(new DataView(WEBKIT_DESC.buffer))], asc);             // 别的 ArrayBufferView
  assert.deepEqual([...ascFromDescription(Uint8Array.of(0x14, 0x08))], asc);                   // 规范里的写法：裸 ASC
  const short = hex('0319000000041140150001f700009d8800008986050214080601 02'.replace(/ /g, ''));   // 一字节长度的写法（我们自己写的那种）
  assert.deepEqual([...ascFromDescription(short)], asc);
  const withVf = Uint8Array.from([0, 0, 0, 0, ...WEBKIT_DESC]);
  assert.deepEqual([...ascFromDescription(withVf)], asc);
  const esdsBox = Uint8Array.from([0, 0, 0, 12 + WEBKIT_DESC.length, ...'esds'.split('').map(c => c.charCodeAt(0)), 0, 0, 0, 0, ...WEBKIT_DESC]);
  assert.deepEqual([...ascFromDescription(esdsBox)], asc);
  // ES_Descriptor 带 dependsOn / URL / OCR 的可选字段
  const flagged = hex('0320' + '0001' + 'e0' + '0002' + '03616263' + '0003' + '0411401500180000000000000000000502' + '1408' + '060102');
  assert.deepEqual([...ascFromDescription(flagged)], asc);
  // 坏的
  for (const bad of [null, undefined, new Uint8Array(0), Uint8Array.of(0x03), WEBKIT_DESC.subarray(0, 20), hex('0305000000060102'), Uint8Array.of(0x00, 0x00), 'x', 42]) {
    assert.equal(ascFromDescription(bad), null, String(bad && bad.length));
  }
});

test('parseAsc / makeAsc：AAC-LC 16 kHz 单声道 = 14 08，帧长 1024；960 的帧长、显式写出的采样率也认', () => {
  assert.deepEqual(parseAsc(Uint8Array.of(0x14, 0x08)), { aot: 2, sampleRate: 16000, channels: 1, frameLen: 1024 });
  assert.deepEqual([...makeAsc(16000, 1)], [0x14, 0x08]);
  assert.deepEqual(parseAsc(makeAsc(44100, 2)), { aot: 2, sampleRate: 44100, channels: 2, frameLen: 1024 });
  assert.equal(parseAsc(Uint8Array.of(0x14, 0x0c)).frameLen, 960);
  // 采样率序号 15：后面 24 位直接写采样率
  assert.equal(parseAsc(Uint8Array.of(0x17, 0x80, 0x1f, 0x40, 0x08)).sampleRate, 16000);
  assert.equal(makeAsc(12345, 1), null);
  assert.equal(parseAsc(Uint8Array.of(0x14)), null);
  assert.equal(parseAsc(Uint8Array.of(0x00, 0x08)), null);                                   // 类型 0
});

// ---------- 拼文件 ----------

test('muxM4a：ftyp M4A + moov（在前）+ mdat；readMp4Meta 读出的时长正好是 PCM、录音时间是 createdAt；iTunSMPB 记下预热和补齐', () => {
  const frames = Array.from({ length: 82 }, (_, i) => Uint8Array.from({ length: 50 + (i * 7) % 200 }, (_, k) => (i + k) & 255));
  const at = Date.UTC(2026, 10, 18, 10, 13, 5, 678);
  const file = muxM4a({ asc: Uint8Array.of(0x14, 0x08), frames, samples: 81234, priming: 2112, createdAt: at });
  const m = readMp4Meta(file);
  assert.deepEqual([m.brand, m.durationSec, m.fragmented, m.createdFrom], ['M4A', 5.077, false, 'mvhd']);
  assert.equal(m.createdAt.toISOString(), '2026-11-18T10:13:05.000Z');
  assert.deepEqual(kids(file, 0, file.length).map(b => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(String.fromCharCode(...file.subarray(16, 28)), 'M4A mp42isom');

  // 时间：mvhd / tkhd 是 PCM 的样本数，mdhd 是所有帧；时间单位都是采样率
  const mvhd = find(file, 'moov', 'mvhd'), tkhd = find(file, 'moov', 'trak', 'tkhd'), mdhd = find(file, 'moov', 'trak', 'mdia', 'mdhd');
  assert.deepEqual([u32At(file, mvhd.body + 4), u32At(file, mvhd.body + 12), u32At(file, mvhd.body + 16)], [Math.floor(at / 1000) + MAC, 16000, 81234]);
  assert.equal(u32At(file, tkhd.body + 20), 81234);
  assert.deepEqual([u32At(file, mdhd.body + 12), u32At(file, mdhd.body + 16)], [16000, 82 * 1024]);
  assert.equal(find(file, 'moov', 'trak', 'edts'), null, '不写 elst（WebKit 会多跳一遍）');
  assert.equal(String.fromCharCode(...file.subarray(find(file, 'moov', 'trak', 'mdia', 'hdlr').body + 8).subarray(0, 4)), 'soun');

  // 样本表：82 帧、每帧 1024、一个 chunk、stco 指着 mdat 里的第一帧
  const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
  const stts = find(file, ...stbl, 'stts'), stsc = find(file, ...stbl, 'stsc');
  assert.deepEqual([u32At(file, stts.body + 4), u32At(file, stts.body + 8), u32At(file, stts.body + 12)], [1, 82, 1024]);
  assert.deepEqual([1, 2, 3, 4].map(i => u32At(file, stsc.body + i * 4)), [1, 1, 82, 1]);
  const got = framesOf(file);
  assert.equal(got.length, 82);
  got.forEach((f, i) => assert.deepEqual(f, frames[i]));
  const mdat = kids(file, 0, file.length).find(b => b.type === 'mdat');
  assert.equal(u32At(file, find(file, ...stbl, 'stco').body + 8), mdat.body);
  assert.equal(mdat.end, file.length);

  // stsd：mp4a（单声道、16 位、16000 << 16）+ esds 里的 ASC
  const mp4a = find(file, ...stbl, 'stsd', 'mp4a');
  assert.deepEqual([file[mp4a.body + 7], file[mp4a.body + 17], file[mp4a.body + 19], u32At(file, mp4a.body + 24)], [1, 1, 16, 16000 * 65536]);
  const esds = find(file, ...stbl, 'stsd', 'mp4a', 'esds');
  assert.deepEqual([...ascFromDescription(file.subarray(esds.body + 4, esds.end))], [0x14, 0x08]);
  assert.deepEqual([...ascFromDescription(file.subarray(esds.start, esds.end))], [0x14, 0x08]);

  // iTunSMPB：Apple 的写法
  const s = smpbOf(file);
  assert.deepEqual([s.priming, s.remainder, s.valid], [2112, 82 * 1024 - 2112 - 81234, 81234]);
  assert.equal(s.text, ' 00000000 00000840 0000026E 0000000000013D52 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000');

  // 没给录音时间：0（readMp4Meta 当作没有）
  assert.equal(readMp4Meta(muxM4a({ asc: makeAsc(), frames, samples: 81234, priming: 2112 })).createdAt, null);
});

test('muxM4a：输入不对就抛（帧不够、没有 ASC、没有帧、samples 不是正数）', () => {
  const frames = [Uint8Array.of(1, 2, 3)];
  assert.throws(() => muxM4a({ asc: makeAsc(), frames, samples: 1000, priming: 100 }), /mux/);     // 1024 < 1100
  assert.throws(() => muxM4a({ asc: null, frames, samples: 10 }), /mux/);
  assert.throws(() => muxM4a({ asc: makeAsc(), frames: [], samples: 10 }), /mux/);
  assert.throws(() => muxM4a({ asc: makeAsc(), frames, samples: 0 }), /mux/);
  assert.ok(muxM4a({ asc: makeAsc(), frames, samples: 1024 }).length > 0);
});

// ---------- 编码 ----------

test('encodeAac：先喂 lead 个 0、再每块 1 秒（f32-planar，Int16 折成 ±1），时间戳接着算；编完关掉编码器；拿到 description、采样率', async () => {
  const { f, opts } = deps();
  const p = pcm(2.5 * SR);
  const e = await encodeAac(p, { ...opts, lead: 1024 });
  assert.deepEqual(f.log.configs[0], { codec: 'mp4a.40.2', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000 });
  assert.deepEqual(f.log.encode.map(x => [x.ts, x.n]), [[0, 1024], [64000, 16000], [1064000, 16000], [2064000, 8000]]);
  assert.ok(f.log.encode.every(x => x.format === 'f32-planar' && x.sr === 16000));
  assert.equal(f.log.closed, 1);
  assert.equal(e.frames.length, Math.ceil((2112 + 1024 + p.length) / 1024));
  assert.deepEqual([e.sampleRate, e.channels, e.firstTs, e.lead], [16000, 1, 0, 1024]);
  assert.deepEqual([...ascFromDescription(e.description)], [0x14, 0x08]);
  // Float32 照样收（不再折算）
  const { opts: o2, f: f2 } = deps();
  await encodeAac(Float32Array.from(p, x => x / 32768), o2);
  assert.deepEqual(f2.log.encode.map(x => x.n), [16000, 16000, 8000]);
});

test('encodeAac：没有 AudioEncoder / AudioData、配置不支持 → unsupported；编码器报错照样抛（也关掉）；中止 → aborted', async () => {
  await assert.rejects(encodeAac(pcm(100), { AudioEncoder: null, AudioData: FakeAudioData }), (e) => e.code === 'unsupported');
  await assert.rejects(encodeAac(pcm(100), { AudioEncoder: fakeEncoder().AE, AudioData: undefined }), (e) => e.code === 'unsupported');
  const no = deps({ supported: false });
  await assert.rejects(encodeAac(pcm(100), no.opts), (e) => e.code === 'unsupported');
  assert.equal(no.f.log.instances, 0);
  const broke = deps({ failAt: 1 });
  await assert.rejects(encodeAac(pcm(3 * SR), broke.opts), /encoder broke/);
  assert.equal(broke.f.log.closed, 1);
  const late = deps({ flushError: true });                              // flush 时报错、flush 自己不回：不用等到超时
  await assert.rejects(encodeAac(pcm(SR), late.opts), /flush broke/);
  assert.equal(late.f.log.closed, 1);
  const ac = new AbortController();
  const hang = deps({ flushHang: true });
  const run = encodeAac(pcm(SR), { ...hang.opts, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(run, (e) => e.code === 'aborted');
  assert.equal(hang.f.log.closed, 1);
});

// ---------- 核对、连起来 ----------

test('pcmToM4a：编码 + 拼文件 + 解码回来核对 → audio/mp4；解出来和原来的 PCM 一样（编码器吃掉头 1024 个样本也一样：垫过 0）', async () => {
  const { f, opts } = deps();
  const p = pcm(5 * SR + 1234, 2);
  let r = null;
  const blob = await pcmToM4a(p, { ...opts, createdAt: Date.UTC(2026, 10, 18, 10, 13, 5), onResult: (x) => { r = x; } });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'audio/mp4');
  const u = new Uint8Array(await blob.arrayBuffer());
  assert.equal(readMp4Meta(u).durationSec, Math.round(p.length / SR * 1000) / 1000);
  assert.equal(readMp4Meta(u).createdAt.toISOString(), '2026-11-18T10:13:05.000Z');
  const s = smpbOf(u);
  assert.deepEqual([s.priming, s.valid], [PRIMING + LEAD, p.length]);
  const back = await fakeDecode(blob);
  assert.deepEqual(Int16Array.from(back, x => Math.round(x * 32768)), p);
  assert.equal(f.log.encode[0].n, LEAD);
  assert.deepEqual([r.ok, r.why, r.priming, r.bytes, r.durationSec], [true, null, PRIMING + LEAD, blob.size, Math.round(p.length / SR * 1000) / 1000]);

  // 编码器自己把预热标成负的时间戳：按它算
  const neg = deps({ delay: 1024, firstTs: -64000 });
  const b2 = await pcmToM4a(p, { ...neg.opts });
  assert.equal(smpbOf(new Uint8Array(await b2.arrayBuffer())).priming, 1024 + LEAD);
  assert.deepEqual(Int16Array.from(await fakeDecode(b2), x => Math.round(x * 32768)), p);

  // 没给 description：自己写 ASC
  const nod = deps({ desc: null });
  assert.ok(await pcmToM4a(p, nod.opts));
});

test('pcmToM4a：不支持、编码器出错、超时、配置不对 → null（调用方存 WAV）；超时也关掉编码器', async () => {
  const p = pcm(2 * SR);
  const why = async (o, extra = {}) => { let r = null; const [b] = await quiet(() => pcmToM4a(p, { ...o, ...extra, onResult: (x) => { r = x; } })); assert.equal(b, null); return r.why; };
  assert.equal(await why({ AudioEncoder: undefined }), 'unsupported');
  assert.equal(await why({ AudioEncoder: fakeEncoder().AE, AudioData: FakeAudioData, OfflineAudioContext: undefined }), 'unsupported');   // 核对不了的不存
  assert.equal(await why(deps({ supported: false }).opts), 'unsupported');
  assert.equal(await why(deps({ failAt: 0 }).opts), 'error');
  const hang = deps({ flushHang: true });
  assert.equal(await why(hang.opts, { timeoutMs: 30 }), 'timeout');
  assert.equal(hang.f.log.closed, 1);
  assert.equal(await why(deps({ sampleRate: 44100 }).opts), 'config');
  assert.equal(await why(deps({ desc: makeAsc(44100, 1) }).opts), 'config');
  assert.equal(await why(deps({ channels: 2 }).opts), 'config');
  assert.equal(await why(deps({ desc: Uint8Array.of(0x03, 0x01) }).opts), 'config');            // description 认不出
  assert.equal(await why(deps().opts, { decode: async () => { throw new Error('decode failed'); } }), 'error');
  assert.equal(await pcmToM4a(new Int16Array(0), deps().opts), null);
  assert.equal(await pcmToM4a(null, deps().opts), null);
});

test('核对不过 → null：解出来短了 / 长了、静音了、中间丢了一截；原来静音的多出声音', async () => {
  const p = pcm(3 * SR, 3);
  const check = async (decode, src = p) => { let r = null; const [b] = await quiet(() => pcmToM4a(src, { ...deps().opts, decode, onResult: (x) => { r = x; } })); return [b, r]; };
  const cut = (fn) => async (blob) => fn(await fakeDecode(blob));
  let [b, r] = await check(cut(x => x.slice(0, x.length - 0.2 * SR)));
  assert.deepEqual([b, r.why], [null, 'duration']);
  [b, r] = await check(cut(x => Float32Array.from([...x, ...new Float32Array(0.2 * SR)])));
  assert.deepEqual([b, r.why], [null, 'duration']);
  [b, r] = await check(cut(x => x.slice(0, x.length - 0.1 * SR)));                     // 0.1 秒以内的差算对
  assert.ok(b);
  [b, r] = await check(cut(x => new Float32Array(x.length)));
  assert.deepEqual([b, r.why], [null, 'level']);
  [b, r] = await check(cut(x => x.map(v => v * 5)));
  assert.deepEqual([b, r.why], [null, 'level']);
  [b, r] = await check(cut(x => { const y = x.slice(); y.fill(0, 0, 1024); return y; }));    // 开头丢了 64 毫秒：整段音量看不出来，逐段看得出
  assert.deepEqual([b, r.why, r.at], [null, 'dropout', 0]);
  [b, r] = await check(cut(x => { const y = x.slice(); y.fill(0, 20000, 22000); return y; }));
  assert.deepEqual([b, r.why, r.at], [null, 'dropout', 20480]);          // 只丢了一半的那段（−3 dB）不算
  [b, r] = await check(cut(x => x.map(() => NaN)));
  assert.deepEqual([b, r.why], [null, 'level']);
  // 原来就是静音：解出来也得是静音
  const silent = new Int16Array(SR);
  [b, r] = await check(fakeDecode, silent);
  assert.ok(b);
  [b, r] = await check(cut(x => x.map(() => 0.01)), silent);
  assert.deepEqual([b, r.why], [null, 'level']);
});

/** 编的噪声（固定种子的 LCG），dBFS 是均方根 */
function noiseAt(n, db, seed = 7) {
  let x = seed >>> 0;
  const out = new Float32Array(n), k = 10 ** (db / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = (x / 2 ** 32 * 2 - 1) * k; }
  return out;
}
/** 安静的屋里（底噪 −75 dBFS）两段很轻的「悄悄话」（−58 dBFS 的调幅噪声）：1–3 秒、5–7 秒；整段 8 秒 */
function whisperClip() {
  const n = 8 * SR, x = noiseAt(n, -75, 3), w = noiseAt(n, -58, 11);
  for (const [a, b] of [[1, 3], [5, 7]]) for (let i = a * SR; i < b * SR; i++) x[i] += w[i] * (0.7 + 0.3 * Math.sin(i / 700)) * 1.15;
  return Int16Array.from(x, v => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
}
const check = async (src, o = {}, decode = fakeDecode) => { let r = null; const [b] = await quiet(() => pcmToM4a(src, { ...deps(o).opts, decode, onResult: (x) => { r = x; } })); return [b, r]; };
const later = (fn) => async (blob) => fn(await fakeDecode(blob));

test('核对：很轻的悄悄话（−58 dBFS，底噪 −75）中间丢了半秒也看得出来（以前只比 −50 dBFS 以上的段，一段都不比）；没丢的照样存', async () => {
  const p = whisperClip();
  let loudest = 0;
  for (let i = 0; i + 1024 <= p.length; i += 1024) loudest = Math.max(loudest, rmsOf(p, i, i + 1024));
  assert.ok(20 * Math.log10(loudest) < -50, `最响的一段也不到 −50 dBFS（${(20 * Math.log10(loudest)).toFixed(1)}）`);
  let [b, r] = await check(p);
  assert.ok(b, JSON.stringify(r));
  assert.deepEqual([r.ok, r.lag, r.corr], [true, 0, 1]);
  for (const [a, z] of [[2 * SR, 2.5 * SR], [5.5 * SR, 5.5 * SR + 1024]]) {           // 悄悄话中间丢了半秒、64 毫秒
    [b, r] = await check(p, {}, later(x => { const y = x.slice(); y.fill(0, a, z); return y; }));
    assert.deepEqual([b, r.why], [null, 'dropout'], `${a}–${z}`);
    assert.ok(r.at >= a - 1024 && r.at < z, String(r.at));
  }
  // 底噪那几秒（比最响那段低 17 dB）丢了也算
  [b, r] = await check(p, {}, later(x => { const y = x.slice(); y.fill(0, 3.5 * SR, 4 * SR); return y; }));
  assert.deepEqual([b, r.why], [null, 'dropout']);
});

test('pcmToM4a：帧数对不上 → frames（存 WAV，以前截短预热照样存下来）：最后一帧没出来、中间丢了一帧、预热不是 2112 又没标出来', async () => {
  const p = whisperClip();
  const want = Math.ceil((PRIMING + LEAD + p.length) / 1024);
  for (const [name, o] of [
    ['最后一帧没出来', { cut: 1 }], ['最后两帧没出来', { cut: 2 }],
    ['中间丢了一帧（时间戳照实标）', { skip: [50] }], ['中间丢了一帧（时间戳接着排）', { skip: [50], restamp: true }],
    ['预热 1024', { delay: 1024 }], ['预热 0', { delay: 0, quirk: false }], ['预热 3136（多出一帧）', { delay: PRIMING + 1024 }],
  ]) {
    const [b, r] = await check(p, o);
    assert.deepEqual([b, r.why], [null, 'frames'], name);
  }
  // 一点不差的照样存；帧数正好是 ⌈(预热 + 垫的 0 + PCM) / 1024⌉、预热不截
  const [b, r] = await check(p);
  assert.ok(b);
  assert.deepEqual([r.frames, r.priming], [want, PRIMING + LEAD]);
});

test('核对：错开了 → align。平稳的噪声挪了几百个样本，时长、音量、每 32 毫秒都看不出来，最响那半秒的互相关看得出来', async () => {
  const p = Int16Array.from(noiseAt(5 * SR, -30, 5), v => Math.round(v * 32768));
  const shift = (g) => later(x => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[(i + g) % x.length]; return y; });
  for (const g of [300, 1024, 1088, x => x]) {
    if (typeof g !== 'number') continue;
    const [b, r] = await check(p, {}, shift(g));
    assert.deepEqual([b, r.why, r.lag], [null, 'align', -g], String(g));
    assert.ok(r.corr < 0.2, String(r.corr));
  }
  // 往回挪（解码器多跳了一截）也一样
  let [b, r] = await check(p, {}, shift(p.length - 500));
  assert.deepEqual([b, r.why, r.lag], [null, 'align', 500]);
  // 解码器不认 iTunSMPB（只跳标准的 2112，后面全给）：垫的 0 跑到了开头 → 不存
  [b, r] = await check(p, {}, async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()), all = await fakeDecode(blob); return Float32Array.from({ length: all.length + LEAD }, (_, i) => (i < LEAD ? 0 : all[i - LEAD])); });
  assert.equal(b, null);
  assert.ok(['dropout', 'align', 'duration'].includes(r.why), r.why);
  // 解出来加了一点噪声（像有损编码）但没错开：照样存
  const fuzz = noiseAt(5 * SR, -50, 9);
  [b, r] = await check(p, {}, later(x => x.map((v, i) => v + fuzz[i])));
  assert.ok(b, JSON.stringify(r));
  assert.equal(r.lag, 0);
  // 很短的（不到 2048 个样本）不比对齐
  const tiny = p.slice(0, 2000);
  [b, r] = await check(tiny, {}, async (blob) => { const x = await fakeDecode(blob); return Float32Array.from(x, (_, i) => x[(i + 5) % x.length]); });
  assert.ok(b);
  assert.equal(r.lag, undefined);
});

test('alignOf：最好的偏移、它的互相关、偏移 0 的；重叠不到一半的偏移不算', () => {
  const x = noiseAt(4000, -20, 4), y = new Float32Array(4000);
  for (let i = 0; i < 4000; i++) y[i] = x[(i + 4000 - 37) % 4000];            // y[i + 37] = x[i]
  const r = alignOf(x, y, 1000, 3000, 200);
  assert.equal(r.lag, 37);
  assert.ok(Math.abs(r.best - 1) < 1e-6 && Math.abs(r.at0) < 0.1, JSON.stringify(r));
  assert.equal(alignOf(x, x, 0, 100, 2048).lag, 0);
  assert.ok(Math.abs(alignOf(x, x, 0, 100, 2048).at0 - 1) < 1e-6);
});

// ---------- 等编码器：dequeue 事件，不用计时器 ----------

/**
 * 有排队的假编码器：encode 先排着（encodeQueueSize 加一），每一拍（setImmediate）编掉一块、块数减一、发一个 dequeue 事件（dequeue: false 就没有这个事件）。
 * stall：一块都不编（只能靠出错、中止结束）。每块出一帧（内容无所谓：只测等待）
 */
function queuedEncoder({ dequeue = true, stall = false } = {}) {
  const log = { maxQueue: 0, events: 0, frames: 0, closed: 0, last: null };
  class AE extends (dequeue ? EventTarget : Object) {
    static async isConfigSupported(c) { return { supported: true, config: c }; }
    constructor({ output, error }) {
      super();
      Object.assign(this, { output, error, state: 'unconfigured', encodeQueueSize: 0, q: [], busy: false, done: null });
      if (dequeue) this.ondequeue = null;
      log.last = this;
    }
    configure() { this.state = 'configured'; }
    encode(ad) {
      this.q.push(ad.numberOfFrames);
      this.encodeQueueSize++;
      log.maxQueue = Math.max(log.maxQueue, this.encodeQueueSize);
      if (!stall) this.kick();
    }
    kick() { if (!this.busy && this.state === 'configured') { this.busy = true; setImmediate(() => this.work()); } }
    work() {
      this.busy = false;
      if (this.state !== 'configured' || !this.q.length) return;
      this.q.shift();
      this.encodeQueueSize--;
      const i = log.frames++;
      this.output({ timestamp: i * 64000, byteLength: 2, copyTo: (d) => d.set([1, 2]) }, i === 0 ? { decoderConfig: { sampleRate: SR, numberOfChannels: 1 } } : undefined);
      if (dequeue) { log.events++; this.dispatchEvent(new Event('dequeue')); }
      if (this.q.length) this.kick(); else if (this.done) this.done();
    }
    flush() { return new Promise((r) => { if (!this.q.length) r(); else this.done = r; }); }
    close() { this.state = 'closed'; log.closed++; }
  }
  return { AE, log };
}
/** 跑 fn 的时候数一数 setTimeout 用了几次 */
async function countTimers(fn) {
  const real = globalThis.setTimeout;
  let n = 0;
  globalThis.setTimeout = (...a) => { n++; return real(...a); };
  try { return [await fn(), n]; } finally { globalThis.setTimeout = real; }
}

test('encodeAac：编码器手上压了 8 块以上就等它的 dequeue 事件，不用计时器（页面在后台时计时器会被放慢：实测 10 分钟从 0.5 秒变成 56 秒）；没有 dequeue 事件的让出一拍再看', async () => {
  for (const dequeue of [true, false]) {
    const { AE, log } = queuedEncoder({ dequeue });
    const [e, timers] = await countTimers(() => encodeAac(pcm(30 * SR), { AudioEncoder: AE, AudioData: FakeAudioData, lead: 1024 }));
    assert.equal(e.frames.length, 31, String(dequeue));
    assert.equal(timers, 0, `${dequeue}：没用计时器`);
    assert.ok(log.maxQueue > QUEUE_MAX && log.maxQueue <= QUEUE_MAX + 1, `${dequeue}：最多压了 ${log.maxQueue} 块`);
    assert.equal(log.events, dequeue ? 31 : 0);
    assert.equal(log.closed, 1);
  }
});

test('encodeAac：等着编码器的时候它出错、或者中止了 → 马上不等（不会一直等 dequeue）', async () => {
  const stuck = queuedEncoder({ stall: true });
  const run = encodeAac(pcm(30 * SR), { AudioEncoder: stuck.AE, AudioData: FakeAudioData });
  await new Promise(r => setImmediate(r));
  assert.equal(stuck.log.maxQueue, QUEUE_MAX + 1, '压满了，在等');
  stuck.log.last.error(new Error('stuck (injected)'));
  await assert.rejects(run, /stuck/);
  assert.equal(stuck.log.closed, 1);
  const ac = new AbortController(), held = queuedEncoder({ stall: true });
  const run2 = encodeAac(pcm(30 * SR), { AudioEncoder: held.AE, AudioData: FakeAudioData, signal: ac.signal });
  await new Promise(r => setImmediate(r));
  ac.abort();
  await assert.rejects(run2, (e) => e.code === 'aborted');
  assert.equal(held.log.closed, 1);
});

test('verifyM4a：文件头的时长不对（不是 m4a、时长写错）→ header，不去解码', async () => {
  const p = pcm(SR);
  let decoded = 0;
  const decode = async () => { decoded++; return new Float32Array(SR); };
  assert.equal((await verifyM4a(new Blob([new Uint8Array(100)]), p, { decode })).why, 'header');
  const file = muxM4a({ asc: makeAsc(), frames: Array.from({ length: 40 }, () => Uint8Array.of(1)), samples: 2 * SR, priming: 0 });   // 写的是 2 秒，PCM 是 1 秒
  assert.equal((await verifyM4a(new Blob([file]), p, { decode })).why, 'header');
  assert.equal(decoded, 0);
});

test('rmsOf / budgetMs', () => {
  assert.equal(rmsOf(Int16Array.of(16384, -16384)), 0.5);
  assert.equal(rmsOf(Float32Array.of(0.5, -0.5, 0, 0), 0, 2), 0.5);
  assert.equal(rmsOf(new Float32Array(0)), 0);
  assert.equal(budgetMs(0), 10000);
  assert.equal(budgetMs(600), 130000);
});
