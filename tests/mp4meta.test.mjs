// m4a / mp4 文件头解析测试：合成的盒子 + 本机临时生成的正弦波 m4a（不进仓库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMp4Meta, parseDay } from '../src/core/mp4meta.js';

// ---------- 拼盒子 ----------
const enc = new TextEncoder();
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u8 = (...b) => Uint8Array.from(b);
const u16 = (v) => u8(v >>> 8, v & 255);
const u32 = (v) => u8(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u64 = (v) => cat(u32(Math.floor(v / 2 ** 32)), u32(v % 2 ** 32));
const type4 = (t) => (t.length === 4 && t[0] === '©' ? cat(u8(0xa9), enc.encode(t.slice(1))) : enc.encode(t));
const box = (type, ...kids) => { const body = cat(...kids); return cat(u32(body.length + 8), typeof type === 'number' ? u32(type) : type4(type), body); };
const full = (type, version, ...kids) => box(type, u8(version, 0, 0, 0), ...kids);
const ftyp = (brand = 'M4A ') => box('ftyp', enc.encode(brand), u32(0), enc.encode('M4A mp42isom'));
const MAC = 2082844800;
const mac = (iso) => Date.parse(iso) / 1000 + MAC;
const mvhd0 = (created, timescale, duration) => full('mvhd', 0, u32(created), u32(created), u32(timescale), u32(duration), new Uint8Array(80));
const mvhd1 = (created, timescale, duration) => full('mvhd', 1, u64(created), u64(created), u32(timescale), u64(duration), new Uint8Array(80));
const mdhd0 = (created, timescale, duration) => full('mdhd', 0, u32(created), u32(created), u32(timescale), u32(duration), u32(0));
const hdlr = (h) => full('hdlr', 0, u32(0), enc.encode(h), new Uint8Array(12), u8(0));
const trak = (mdhd, handler = 'soun') => box('trak', box('mdia', mdhd, hdlr(handler)));
const mdat = (n) => box('mdat', new Uint8Array(n));
const buf = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);

test('mvhd 版本 0：录音时间（1904 起的秒）、时长、品牌', () => {
  const file = cat(ftyp(), mdat(64), box('moov', mvhd0(mac('2026-01-02T03:04:05Z'), 1000, 42500), trak(mdhd0(0, 44100, 0))));
  const m = readMp4Meta(buf(file));
  assert.equal(m.brand, 'M4A');
  assert.equal(m.createdAt.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(m.createdFrom, 'mvhd');
  assert.equal(m.durationSec, 42.5);
  assert.equal(m.fragmented, false);
});

test('mvhd 版本 1（64 位）', () => {
  const file = cat(ftyp('mp42'), box('moov', mvhd1(mac('2025-06-17T09:10:11Z'), 44100, 44100 * 61)));
  const m = readMp4Meta(buf(file));
  assert.equal(m.brand, 'mp42');
  assert.equal(m.createdAt.toISOString(), '2025-06-17T09:10:11.000Z');
  assert.equal(m.durationSec, 61);
});

test('mvhd 没有时长 / 时间是 0 → 用音轨的 mdhd', () => {
  const file = cat(ftyp(), box('moov', mvhd0(0, 600, 0),
    trak(mdhd0(mac('2024-05-14T01:02:03Z'), 90000, 90000 * 5), 'vide'),
    trak(mdhd0(mac('2024-05-14T01:02:03Z'), 48000, 48000 * 7.5))));
  const m = readMp4Meta(buf(file));
  assert.equal(m.durationSec, 7.5, '先看音轨（soun）');
  assert.equal(m.createdAt.toISOString(), '2024-05-14T01:02:03.000Z');
  assert.equal(m.createdFrom, 'mdhd');
  const noMvhd = readMp4Meta(buf(cat(ftyp(), box('moov', trak(mdhd0(0, 1000, 1234))))));
  assert.equal(noMvhd.durationSec, 1.234);
  assert.equal(noMvhd.createdAt, null);
});

test('creation_time 是 0、2000 年以前、全 1 的时长 → null，不猜', () => {
  for (const created of [0, mac('1999-12-31T23:59:59Z'), 1]) {
    const m = readMp4Meta(buf(cat(ftyp(), box('moov', mvhd0(created, 1000, 1000)))));
    assert.equal(m.createdAt, null, String(created));
    assert.equal(m.durationSec, 1);
  }
  assert.equal(readMp4Meta(buf(cat(ftyp(), box('moov', mvhd0(0, 1000, 0xffffffff))))).durationSec, null);
  assert.equal(readMp4Meta(buf(cat(ftyp(), box('moov', mvhd0(0, 0, 1000))))).durationSec, null, 'timescale 0');
});

test('碎片化 MP4（mvex + moof，时长 0）→ durationSec null；有 mehd 就用它', () => {
  const frag = cat(ftyp('iso5'), box('moov', mvhd0(0, 1000, 0), trak(mdhd0(0, 48000, 0)), box('mvex', full('trex', 0, new Uint8Array(20)))),
    box('moof', full('mfhd', 0, u32(1))), mdat(32), box('moof', full('mfhd', 0, u32(2))), mdat(32));
  const m = readMp4Meta(buf(frag));
  assert.equal(m.fragmented, true);
  assert.equal(m.durationSec, null);
  assert.equal(m.brand, 'iso5');
  const withMehd = cat(ftyp('iso5'), box('moov', mvhd0(0, 1000, 0), box('mvex', full('mehd', 0, u32(3200)))));
  assert.equal(readMp4Meta(buf(withMehd)).durationSec, 3.2);
  const onlyMoof = cat(ftyp('iso5'), box('moof', full('mfhd', 0, u32(1))), mdat(8));   // 没有 moov 的一片
  assert.deepEqual(readMp4Meta(buf(onlyMoof)), { createdAt: null, durationSec: null, brand: 'iso5', fragmented: true, createdFrom: null });
});

test('元数据日期：udta/meta/ilst ©day（FullBox meta）、QuickTime keys、udta/©day；只认带时区的', () => {
  const data = (s) => box('data', u32(1), u32(0), enc.encode(s));
  const itunes = (s) => cat(ftyp(), box('moov', mvhd0(0, 1000, 2000), box('udta', full('meta', 0, hdlr('mdir'), box('ilst', box('©day', data(s)))))));
  assert.equal(readMp4Meta(buf(itunes('2023-09-09T03:30:00-0700'))).createdAt.toISOString(), '2023-09-09T10:30:00.000Z');
  assert.equal(readMp4Meta(buf(itunes('2023-09-09T03:30:00-0700'))).createdFrom, 'meta');
  assert.equal(readMp4Meta(buf(itunes('2026'))).createdAt, null, '只有年份：不猜');
  assert.equal(readMp4Meta(buf(itunes('2023-09-09 03:30:00'))).createdAt, null, '没有时区：不猜');

  const key = (name) => cat(u32(8 + name.length), enc.encode('mdta'), enc.encode(name));
  const keys = full('keys', 0, u32(2), key('com.apple.quicktime.make'), key('com.apple.quicktime.creationdate'));
  const qt = cat(ftyp('qt  '), box('moov', mvhd0(0, 600, 600), box('meta', hdlr('mdta'), keys, box('ilst', box(1, data('Apple')), box(2, data('2023-12-10T01:15:00+0800'))))));
  const m = readMp4Meta(buf(qt));
  assert.equal(m.createdAt.toISOString(), '2023-12-09T17:15:00.000Z');
  assert.equal(m.brand, 'qt');

  const old = cat(ftyp(), box('moov', mvhd0(0, 600, 600), box('udta', box('©day', u16(20), u16(0), enc.encode('2023-04-18T01:10:00Z')))));
  assert.equal(readMp4Meta(buf(old)).createdAt.toISOString(), '2023-04-18T01:10:00.000Z');
  // mvhd 有效时优先 mvhd
  const both = cat(ftyp(), box('moov', mvhd0(mac('2026-01-01T00:00:00Z'), 1000, 1000), box('udta', full('meta', 0, box('ilst', box('©day', data('2020-01-01T00:00:00Z')))))));
  assert.equal(readMp4Meta(buf(both)).createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('parseDay：时区换算、非法日期', () => {
  assert.equal(parseDay('2023-09-09T10:30:00Z').toISOString(), '2023-09-09T10:30:00.000Z');
  assert.equal(parseDay('2023-09-09T02:30:00.5-08:00').toISOString(), '2023-09-09T10:30:00.000Z');
  assert.equal(parseDay('2023-13-09T02:30:00Z'), null);
  assert.equal(parseDay(''), null);
  assert.equal(parseDay(null), null);
});

test('moov 在 mdat 后面、64 位长度的 mdat、TypedArray 视图、截断的 moov', () => {
  const big = cat(u32(1), enc.encode('mdat'), u64(16 + 100), new Uint8Array(100));
  const file = cat(ftyp(), big, box('moov', mvhd0(mac('2023-07-07T12:00:00Z'), 1000, 9000)));
  assert.equal(readMp4Meta(buf(file)).durationSec, 9);
  const padded = cat(new Uint8Array(7), file, new Uint8Array(5));
  assert.equal(readMp4Meta(padded.subarray(7, 7 + file.length)).durationSec, 9);
  const truncated = file.subarray(0, file.length - 40);    // moov 尾巴被截掉，mvhd 还完整
  assert.equal(readMp4Meta(truncated).durationSec, 9);
  const cutMvhd = file.subarray(0, file.length - 100);     // mvhd 本身被截断
  assert.equal(readMp4Meta(cutMvhd).durationSec, null);
});

test('乱七八糟的输入不抛错，全是 null', () => {
  const nulls = { createdAt: null, durationSec: null, brand: null, fragmented: false, createdFrom: null };
  for (const input of [null, undefined, 'abc', 42, {}, new ArrayBuffer(0), new ArrayBuffer(7), enc.encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt ').buffer,
    u32(0xffffffff).buffer, cat(u32(1), enc.encode('ftyp'), u32(0xffffffff), u32(0xffffffff)).buffer, cat(u32(4), enc.encode('ftyp')).buffer]) {
    assert.deepEqual(readMp4Meta(input), nulls, String(input));
  }
  // 随机字节、随机改坏的合法文件：只要求不抛错、类型对
  const good = cat(ftyp(), box('moov', mvhd0(mac('2026-01-02T03:04:05Z'), 1000, 42500), trak(mdhd0(0, 44100, 0)), box('udta', full('meta', 0, box('ilst', box('©day', box('data', u32(1), u32(0), enc.encode('2026'))))))));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 400; i++) {
    const b = i < 100 ? Uint8Array.from({ length: Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256)) : good.slice(0, Math.floor(rnd() * good.length) + 1);
    if (i >= 100) for (let k = 0; k < 4; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const m = readMp4Meta(b.buffer);
    assert.ok(m.createdAt === null || m.createdAt instanceof Date);
    assert.ok(m.durationSec === null || (typeof m.durationSec === 'number' && m.durationSec > 0));
  }
});

// 真的 m4a：先在本机生成（不进仓库），没有就跳过。生成方法（macOS）：
//   python3 生成 2.5 秒 440Hz 单声道 16 位 44.1kHz 的 sine-2.5s.wav，然后
//   afconvert -f m4af -d aac sine-2.5s.wav /tmp/babble-build/fixtures/sine-2.5s.m4a
//   ffmpeg -i sine-2.5s.wav -c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof -f mp4 /tmp/babble-build/fixtures/sine-frag.m4a
const FIX = process.env.BABBLE_FIXTURES || '/tmp/babble-build/fixtures';
const real = join(FIX, 'sine-2.5s.m4a');
test('真的 m4a（afconvert 生成的 2.5 秒正弦波）', { skip: !existsSync(real) && `没有 ${real}` }, () => {
  const m = readMp4Meta(readFileSync(real));
  assert.equal(m.brand, 'M4A');
  assert.equal(m.fragmented, false);
  assert.ok(Math.abs(m.durationSec - 2.5) < 0.1, String(m.durationSec));     // AAC 前后有几十毫秒补帧
  if (m.createdAt) assert.ok(m.createdAt.getTime() > Date.UTC(2020, 0, 1));
});
const frag = join(FIX, 'sine-frag.m4a');
test('真的碎片化 m4a（ffmpeg empty_moov）', { skip: !existsSync(frag) && `没有 ${frag}` }, () => {
  const m = readMp4Meta(readFileSync(frag));
  assert.equal(m.fragmented, true);
  assert.equal(m.durationSec, null);
});
