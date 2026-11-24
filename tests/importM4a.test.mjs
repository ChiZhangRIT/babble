// 导入的录音转 m4a（core/importM4a.js）：WAV / 别的 → 24 kHz 单声道 m4a（核对过的），已经是 m4a 的原样，转不了的原样（为什么）。
// 声音全是编的数字序列（仓库是公开的），编码器、解码器都是假的（tests/helpers/fakeCodec.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importM4a, isAacMp4, wavDurationSec, wavFormat, keptOriginal, keptKey, TARGETS, MAX_SEC, MAX_UNKNOWN_BYTES, MAX_SRC_BYTES, MAX_CH_SEC, decodeBudgetMs } from '../src/core/importM4a.js';
import { pcmToM4a, pickConfig } from '../src/core/m4a.js';
import { readMp4Meta, mp4AudioCodec } from '../src/core/mp4meta.js';
import { sha256Hex } from '../src/core/sha256.js';
import { tone, wavBytes, fakeBrowser, fakeEncoder, FakeAudioData, fakeAC, box } from './helpers/fakeCodec.mjs';

const T0 = Date.UTC(2026, 10, 18, 3, 12, 40);
const wavBlob = (chs, sr, o) => new Blob([wavBytes(chs, sr, o)], { type: 'audio/wav' });
async function quiet(fn) {
  const w = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = w; }
}
/** 假编码器编出来的 m4a（16 kHz，同床头模式）：当作「已经是 m4a」的原文件 */
async function someM4a(sec = 2) {
  const b = fakeBrowser();
  return pcmToM4a(tone(sec * 16000, 5), { ...b.opts, decode: async (blob) => { const ac = new b.opts.OfflineAudioContext(1, 1, 16000); const ab = await ac.decodeAudioData(await blob.arrayBuffer()); return ab.getChannelData(0); } });
}

test('WAV（48 kHz 立体声）→ 24 kHz 单声道 m4a（48 kbps）：两个声道取平均、核对过；sha256 是 m4a 的、srcSha256 是原文件的；creation_time 是给的时刻；时长按解码出来的', async () => {
  const L = tone(3 * 48000 + 480, 2), R = tone(3 * 48000 + 480, 3, 5000), blob = wavBlob([L, R], 48000);
  const b = fakeBrowser();
  const r = await importM4a({ blob, mime: 'audio/wav', createdAt: new Date(T0) }, b.opts);
  assert.equal(r.converted, true, JSON.stringify(r));
  assert.equal(r.why, null);
  assert.deepEqual([r.mime, r.blob.type, r.sr, r.bitrate], ['audio/mp4', 'audio/mp4', 24000, 48000]);
  assert.deepEqual(b.enc.configs.map(c => [c.sampleRate, c.numberOfChannels, c.bitrate, c.codec]), [[24000, 1, 48000, 'mp4a.40.2']]);
  assert.equal(r.srcSha256, await sha256Hex(blob));
  assert.equal(r.sha256, await sha256Hex(r.blob));
  assert.notEqual(r.sha256, r.srcSha256);
  assert.deepEqual([r.bytes, r.srcBytes], [r.blob.size, blob.size]);
  assert.equal(r.durationSec, 3.01);
  const u = new Uint8Array(await r.blob.arrayBuffer()), meta = readMp4Meta(u);
  assert.equal(meta.createdAt.toISOString(), new Date(T0 - T0 % 1000).toISOString());
  assert.equal(meta.durationSec, 3.01);
  assert.equal(mp4AudioCodec(u), 'aac');
  assert.equal(new DataView(u.buffer).getUint32(box(u, 'moov', 'trak', 'mdia', 'mdhd').body + 12), 24000, 'mdhd 的时间单位 = 24 kHz');
  // 解码回来（假解码器是无损的）= 两个声道的平均
  const ac = new b.opts.OfflineAudioContext(1, 1, 24000), back = (await ac.decodeAudioData(await r.blob.arrayBuffer())).getChannelData(0);
  assert.equal(back.length, 3 * 24000 + 240);
  for (const i of [1000, 30000, 70000]) assert.ok(Math.abs(back[i] - (L[i * 2] + R[i * 2]) / 2 / 32768) < 1e-3, String(i));
  assert.deepEqual(b.ac.rates, [24000, 24000, 24000], '原文件、核对都按 24 kHz 解码');
  assert.equal(keptOriginal(r), false);
});

test('已经是 m4a（mp4 里的 AAC）→ 原样（同一个 Blob、同一个 sha256），不解码不编码；ALAC 的 m4a、MP3 不算', async () => {
  const m4a = await someM4a();
  const b = fakeBrowser();
  const r = await importM4a({ blob: m4a, mime: 'audio/mp4' }, b.opts);
  assert.deepEqual([r.converted, r.why, r.blob === m4a, r.mime, r.sha256], [false, 'm4a', true, 'audio/mp4', await sha256Hex(m4a)]);
  assert.equal(r.srcSha256, undefined);
  assert.deepEqual([b.enc.configs.length, b.ac.decoded], [0, 0]);
  assert.equal(keptOriginal(r), false, '已经是 m4a 的不说「没转成」');
  // 调用方已经知道是 AAC（aac: true）也一样，不再读文件
  assert.equal((await importM4a({ blob: m4a, aac: true, sha256: 'x'.repeat(64) }, b.opts)).sha256, 'x'.repeat(64));
  // 别的编码的 mp4：stsd 的第一项换成 alac / esds 的 objectTypeIndication 换成 MP3
  const u = new Uint8Array(await m4a.arrayBuffer()), entry = box(u, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd');
  const alac = u.slice(); alac.set([0x61, 0x6c, 0x61, 0x63], entry.body + 8 + 4);
  assert.equal(mp4AudioCodec(alac), 'alac');
  assert.equal(isAacMp4(alac), false);
  const mp3 = u.slice(), esds = box(u, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a', 'esds');
  const at = u.indexOf(0x04, esds.body + 4 + 2 + 3);                 // DecoderConfigDescriptor 的 tag
  let q = at + 1; while (u[q] & 0x80) q++; q++;
  assert.equal(u[q], 0x40);
  mp3[q] = 0x6b;
  assert.equal(mp4AudioCodec(mp3), 'mp3');
  assert.equal(isAacMp4(u), true);
  for (const x of [new Uint8Array(0), wavBytes([tone(100)], 16000), new Uint8Array(64).fill(7)]) assert.equal(mp4AudioCodec(x), null);
});

test('转不了 → 原样（原文件的 Blob、sha256、mime），why 说为什么：浏览器编不了、解码不了、编码器出错、核对不过、超时', async () => {
  // 48 kHz：假编码器不压缩（每个样本 2 个字节），24 kHz 的 m4a 才比原文件小（不然算 bigger）
  const blob = wavBlob([tone(2 * 48000, 4)], 48000), W = await sha256Hex(blob);
  const why = async (opts, src = {}) => {
    const r = await quiet(() => importM4a({ blob, mime: 'audio/wav', ...src }, opts));
    assert.equal(r.converted, false);
    assert.equal(r.blob, blob);
    assert.deepEqual([r.sha256, r.mime, r.bytes], [W, 'audio/wav', blob.size]);
    assert.equal(keptOriginal(r), true);
    return r.why;
  };
  assert.equal(await why({ ...fakeBrowser().opts, AudioEncoder: undefined }), 'unsupported');
  assert.equal(await why({ ...fakeBrowser().opts, AudioData: undefined }), 'unsupported');
  assert.equal(await why({ ...fakeBrowser().opts, OfflineAudioContext: undefined }), 'unsupported');
  assert.equal(await why(fakeBrowser({ encoder: { supported: () => false } }).opts), 'unsupported');
  // 编的 MP3（假解码器解不了）
  const junk = new Blob([Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4)], { type: 'audio/mpeg' });
  const d = await quiet(() => importM4a({ blob: junk }, fakeBrowser().opts));
  assert.deepEqual([d.converted, d.why, d.blob, d.mime, d.sha256], [false, 'decode', junk, 'audio/mpeg', await sha256Hex(junk)]);
  assert.equal(await why(fakeBrowser({ encoder: { failAt: 1 } }).opts), 'error');
  assert.equal(await why(fakeBrowser({ ac: { silent: true } }).opts), 'check', '解码回来是静音：核对不过');
  assert.equal(await why({ ...fakeBrowser({ ac: { hang: true } }).opts, timeoutMs: 40 }), 'timeout', '解码一直不回');
  const hang = fakeBrowser({ encoder: { flushHang: true } });
  assert.equal(await why({ ...hang.opts, timeoutMs: 40 }), 'timeout', '编码器一直不回');
  assert.equal(hang.enc.closed, 1, '超时也关掉编码器');
  // 问编码器支不支持一直不回（媒体进程卡住）：不等下去，原样存
  const stuck = fakeBrowser();
  stuck.opts.AudioEncoder.isConfigSupported = () => new Promise(() => {});
  assert.equal(await why({ ...stuck.opts, configMs: 30 }), 'timeout', 'isConfigSupported 一直不回');
  assert.equal(stuck.ac.decoded, 0);
  // 一个空的 WAV（解出来 0 个样本）
  const empty = wavBlob([new Int16Array(0)], 24000);
  assert.equal((await quiet(() => importM4a({ blob: empty }, fakeBrowser().opts))).why, 'decode');
});

test('24 kHz 编不了 → 16 kHz 32 kbps；都编不了 → unsupported（不去解码）', async () => {
  const blob = wavBlob([tone(2 * 48000, 6)], 48000);
  const b = fakeBrowser({ encoder: { supported: (c) => c.sampleRate !== 24000 } });
  const r = await importM4a({ blob }, b.opts);
  assert.deepEqual([r.converted, r.sr, r.bitrate], [true, 16000, 32000]);
  assert.deepEqual(b.enc.asked.slice(0, 2).map(c => [c.sampleRate, c.bitrate]), [[24000, 48000], [16000, 32000]]);
  assert.deepEqual(b.enc.configs.map(c => [c.sampleRate, c.bitrate]), [[16000, 32000]]);
  assert.deepEqual(b.ac.rates, [16000, 16000]);
  assert.equal(r.durationSec, 2);
  const none = fakeBrowser({ encoder: { supported: () => false } });
  assert.equal((await importM4a({ blob }, none.opts)).why, 'unsupported');
  assert.equal(none.ac.decoded, 0);
  assert.deepEqual(TARGETS.map(x => [x.sr, x.bitrate]), [[24000, 48000], [16000, 32000]]);
  // pickConfig：问的时候出错算不支持；没有 isConfigSupported 用第一个
  const AE = class { static async isConfigSupported(c) { if (c.sampleRate === 24000) throw new Error('nope'); return { supported: true }; } };
  assert.deepEqual(await pickConfig(TARGETS, { AudioEncoder: AE, AudioData: FakeAudioData }), TARGETS[1]);
  assert.deepEqual(await pickConfig(TARGETS, { AudioEncoder: class {}, AudioData: FakeAudioData }), TARGETS[0]);
  assert.equal(await pickConfig(TARGETS, { AudioEncoder: undefined, AudioData: FakeAudioData }), null);
});

test('超过 30 分钟不转（long）：已知时长超了 → 不解码；解出来才发现超了 → 也不转。太大的不转（big）：读不出时长、文件又大于 16 MB；文件大于 400 MB；WAV 的声道多、解出来太占内存', async () => {
  const b = fakeBrowser();
  const small = wavBlob([tone(24000)], 24000);
  let r = await importM4a({ blob: small, durationSec: MAX_SEC + 1 }, b.opts);
  assert.deepEqual([r.converted, r.why, r.blob], [false, 'long', small]);
  assert.equal(b.ac.decoded, 0);
  assert.equal(keptOriginal(r), true);
  // WAV 的头说 30 分钟以上（byteRate 写得很小）：不用 <audio> 也知道
  const longWav = wavBlob([tone(24000)], 24000, { byteRate: 20 });
  assert.ok(wavDurationSec(await longWav.arrayBuffer()) > MAX_SEC);
  assert.equal((await importM4a({ blob: longWav }, b.opts)).why, 'long');
  assert.equal(b.ac.decoded, 0);
  // 读不出时长、又很大（用一个假的 Blob：size 很大，只读开头）：不知道多长，不说「超过 30 分钟」（big：界面上说一般的那句）
  const fakeBig = (size, head = Uint8Array.of(1, 2, 3)) => ({ size, type: 'audio/mpeg', slice: () => new Blob([head]), arrayBuffer: async () => new ArrayBuffer(8) });
  r = await importM4a({ blob: fakeBig(MAX_UNKNOWN_BYTES + 1), sha256: 'a'.repeat(64), aac: false }, b.opts);
  assert.deepEqual([r.why, r.sha256, r.durationSec, keptKey(r)], ['big', 'a'.repeat(64), null, 'kept']);
  assert.equal(MAX_UNKNOWN_BYTES, 16 * 1024 * 1024);
  assert.equal(b.ac.decoded, 0);
  // 知道时长（10 秒）、可是文件大于 400 MB（96 kHz 24 位的长 WAV 那种）
  r = await importM4a({ blob: fakeBig(MAX_SRC_BYTES + 1), sha256: 'a'.repeat(64), aac: false, durationSec: 10 }, b.opts);
  assert.equal(r.why, 'big');
  assert.equal(b.ac.decoded, 0);
  // WAV 的头：6 个声道、20 分钟（声道 × 秒 = 2 小时 > 30 分钟立体声）→ big；同样长的单声道照样解码
  const six = wavBytes(Array.from({ length: 6 }, (_, c) => tone(100, c + 1)), 24000, { byteRate: 1 });
  assert.deepEqual(wavFormat(six), { sec: 1200, channels: 6 });
  assert.ok(1200 * 6 > MAX_CH_SEC && 1200 <= MAX_SEC);
  r = await importM4a({ blob: new Blob([six], { type: 'audio/wav' }) }, b.opts);
  assert.equal(r.why, 'big');
  assert.equal(b.ac.decoded, 0);
  r = await quiet(() => importM4a({ blob: new Blob([wavBytes([tone(100)], 24000, { byteRate: 1 })], { type: 'audio/wav' }) }, b.opts));
  assert.notEqual(r.why, 'big');
  assert.equal(b.ac.decoded, 1, '单声道 20 分钟：去解码了');
  // 时长说不长（或者读不出），解出来超过 30 分钟：解码用假的（直接给 PCM），不编码
  const huge = { length: MAX_SEC * 24000 + 24000 };                 // 不真的分配 170 MB：只看长度
  const enc = fakeEncoder();
  r = await importM4a({ blob: small, durationSec: 10 }, { AudioEncoder: enc.AE, AudioData: FakeAudioData, decode: async () => huge });
  assert.deepEqual([r.why, r.durationSec], ['long', MAX_SEC + 1]);
  assert.equal(enc.log.configs.length, 0);
});

test('wavDurationSec：fmt 的 byteRate + data 的长度；data 写成 0 / 0xFFFFFFFF（边录边写的）按到文件结尾；只给开头时按 total；不是 WAV → null', () => {
  const u = wavBytes([tone(16000 * 3)], 16000);
  assert.equal(wavDurationSec(u), 3);
  assert.equal(wavDurationSec(u.buffer), 3);
  const open = u.slice(); new DataView(open.buffer).setUint32(40, 0xffffffff, true);
  assert.equal(wavDurationSec(open), 3);
  new DataView(open.buffer).setUint32(40, 0, true);
  assert.equal(wavDurationSec(open), 3);
  assert.equal(wavDurationSec(u.subarray(0, 64), u.length), 3, '只读了开头');
  const st = wavBytes([tone(48000), tone(48000)], 48000);
  assert.equal(wavDurationSec(st), 1);
  for (const x of [new Uint8Array(0), new Uint8Array(100), Uint8Array.from('RIFF\0\0\0\0AVI LIST', c => c.charCodeAt(0))]) assert.equal(wavDurationSec(x), null);
  assert.equal(decodeBudgetMs(1800), 200000);
  assert.equal(decodeBudgetMs(null), 120000);
});

test('解码器自己抛错也不抛出去：原样存（decode）；报告的回调出错不影响转换', async () => {
  const blob = new Blob([wavBytes([tone(24000)], 48000)]);
  const r = await quiet(() => importM4a({ blob, sha256: 'b'.repeat(64) }, { ...fakeBrowser().opts, decode: () => { throw new Error('boom'); } }));
  assert.deepEqual([r.converted, r.why, r.blob, r.sha256], [false, 'decode', blob, 'b'.repeat(64)]);
  const ac = fakeAC();
  const odd = await quiet(() => importM4a({ blob }, { AudioEncoder: fakeEncoder().AE, AudioData: FakeAudioData, OfflineAudioContext: ac.AC, targets: [{ sr: 24000, bitrate: 48000 }], onResult: () => { throw new Error('只是报告'); } }));
  assert.equal(odd.converted, true, '报告的回调出错不影响');
});

test('多声道取平均以后抵消了（反相、几乎反相、5.1 只有中间声道有声）→ 不转（check / downmix），原样存原文件；一边有声一边没声（−6 dB）、两边一样的照样转', async () => {
  const n = 2 * 48000, L = tone(n, 7), inv = Int16Array.from(L, x => -x), near = Int16Array.from(L, x => Math.round(-0.9 * x)), zero = new Int16Array(n);
  const kept = async (chs, label) => {
    const blob = wavBlob(chs, 48000), b = fakeBrowser();
    const r = await importM4a({ blob, mime: 'audio/wav' }, b.opts);
    assert.deepEqual([r.converted, r.why, r.detail, r.blob === blob, r.sha256], [false, 'check', 'downmix', true, await sha256Hex(blob)], label);
    assert.equal(keptKey(r), 'kept', label);
    assert.equal(b.enc.configs.length, 0, label + '：没去编码');
    assert.ok(r.chRms.length === chs.length && r.mixRms < Math.max(...r.chRms) / 3, label);
  };
  await kept([L, inv], '反相');
  await kept([L, near], 'R = −0.9 L');
  await kept([zero, zero, L, zero, zero, zero], '5.1 只有中间声道');
  for (const [chs, label] of [[[L, zero], '只有左声道'], [[L, L], '两边一样'], [[L, tone(n, 8)], '两边不一样']]) {
    const r = await importM4a({ blob: wavBlob(chs, 48000) }, fakeBrowser().opts);
    assert.equal(r.converted, true, label + ' ' + JSON.stringify({ why: r.why, detail: r.detail }));
  }
  // 静音的立体声（最响的声道也在 −80 dBFS 以下）：不算抵消，照样转
  const hush = Int16Array.from(L, x => Math.round(x / 20000));
  assert.equal((await importM4a({ blob: wavBlob([hush, Int16Array.from(hush, x => -x)], 48000) }, fakeBrowser().opts)).converted, true);
});

test('编出来没比原文件小一成以上（原文件本来就是低码率的）→ 不转（bigger），原样存，界面上说「原文件已经够小」；不去核对', async () => {
  const blob = wavBlob([tone(3 * 8000, 9)], 8000), b = fakeBrowser();   // 8 kHz 单声道：假编码器 24 kHz 编出来是它的 3 倍
  const r = await importM4a({ blob, mime: 'audio/wav' }, b.opts);
  assert.deepEqual([r.converted, r.why, r.blob === blob, r.sha256], [false, 'bigger', true, await sha256Hex(blob)]);
  assert.equal(keptKey(r), 'keptSmall');
  assert.equal(b.enc.configs.length, 1, '编了');
  assert.equal(b.ac.decoded, 1, '只解了原文件：编出来太大就不核对');
  // pcmToM4a 的 maxBytes：大了 → null、why bigger；够小 → 照样核对、交出来
  let got = null;
  assert.equal(await pcmToM4a(tone(16000, 3), { ...fakeBrowser().opts, maxBytes: 1000, onResult: (x) => { got = x; } }), null);
  assert.equal(got.why, 'bigger');
  assert.ok(await pcmToM4a(tone(16000, 3), { ...fakeBrowser().opts, maxBytes: 10 ** 7 }));
});

test('几个一起转（详情页、编辑页、导入页同时加）：解码、编码排着一个个来，排队的时候不算时限', async () => {
  const b = fakeBrowser();
  let running = 0, most = 0, started = 0;
  const gates = [];
  const decode = async (blob, sr) => {
    started++; running++; most = Math.max(most, running);
    await new Promise(res => gates.push(res));
    const ac = new b.opts.OfflineAudioContext(1, 1, sr), ab = await ac.decodeAudioData(await blob.arrayBuffer());
    running--;
    return ab.getChannelData(0);
  };
  // 只有解原文件（第三个参数是 stats）要等 gates；核对时解 m4a 不等
  const real = { ...b.opts, timeoutMs: 400, decode: async (blob, sr, stats) => {
    if (stats) return decode(blob, sr);
    const ac = new b.opts.OfflineAudioContext(1, 1, sr);
    return (await ac.decodeAudioData(await blob.arrayBuffer())).getChannelData(0);
  } };
  const p1 = importM4a({ blob: wavBlob([tone(48000, 1)], 48000) }, real), p2 = importM4a({ blob: wavBlob([tone(48000, 2)], 48000) }, real);
  const tick = () => new Promise(r => setImmediate(r));
  for (let i = 0; i < 50 && started < 1; i++) await tick();
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(started, 1, '第二个还在排队');
  await new Promise(r => setTimeout(r, 300));                    // 排着的这段时间不算第二个的时限（timeoutMs 400）
  gates.shift()();
  for (let i = 0; i < 400 && started < 2; i++) await tick();
  assert.equal(started, 2);
  gates.shift()();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual([r1.converted, r2.converted], [true, true], JSON.stringify([r1.why, r2.why]));
  assert.equal(most, 1, '同时只解一个');
});

test('decodeMono 的 stats：每个声道的均方根、平均以后的；单声道也填；不给 stats 照旧', async () => {
  const { decodeMono } = await import('../src/core/transcribe.js');
  const ac = fakeAC(), L = tone(4800, 3), stats = {};
  const st = wavBlob([L, Int16Array.from(L, x => -x)], 48000);
  const out = await decodeMono(st, { AC: ac.AC, sr: 24000, stats });
  assert.equal(stats.channels, 2);
  assert.equal(stats.chRms.length, 2);
  assert.ok(Math.abs(stats.chRms[0] - stats.chRms[1]) < 1e-6 && stats.chRms[0] > 0.05, JSON.stringify(stats));
  assert.ok(stats.mixRms < 1e-6);
  assert.equal(out.length, 2400);
  const plain = await decodeMono(st, { AC: ac.AC, sr: 24000 });
  assert.deepEqual(Array.from(plain.subarray(0, 50)), Array.from(out.subarray(0, 50)));
  const mono = {};
  await decodeMono(wavBlob([L], 48000), { AC: ac.AC, sr: 24000, stats: mono });
  assert.equal(mono.channels, 1);
  assert.equal(mono.chRms[0], mono.mixRms);
});

test('keptKey：已经是 m4a、转成了 → null；超过 30 分钟 → keptLong；原文件已经够小 → keptSmall；别的（太大、读不出时长、编不了、核对不过…）→ kept', () => {
  assert.equal(keptKey({ converted: true, why: null }), null);
  assert.equal(keptKey({ converted: false, why: 'm4a' }), null);
  assert.equal(keptKey(null), null);
  assert.equal(keptKey({ converted: false, why: 'long' }), 'keptLong');
  assert.equal(keptKey({ converted: false, why: 'bigger' }), 'keptSmall');
  for (const w of ['big', 'unsupported', 'decode', 'timeout', 'check', 'error']) assert.equal(keptKey({ converted: false, why: w }), 'kept', w);
});


test('移动设备按展开后的 PCM 内存预估跳过转换，不会先解码再发现太大；桌面正常转换路径仍可用', async () => {
  const b = fakeBrowser(), blob = wavBlob([tone(24000)], 24000);
  const r = await importM4a({ blob, durationSec: 1200 }, { ...b.opts, mobile: true });
  assert.deepEqual([r.why, r.detail, r.blob], ['big', 'decoded-memory', blob]);
  assert.equal(b.ac.decoded, 0, '在任何大内存解码之前就拦截');
  const desktop = await importM4a({ blob, durationSec: 1200 }, { ...b.opts, mobile: false });
  assert.notEqual(desktop.why, 'big'); assert.ok(b.ac.decoded > 0);
});
