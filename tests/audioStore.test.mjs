// 本机录音库测试：扩展名 / mime、内存版的去重和分片、没有 IndexedDB 时的报错、sha256（合成数据）
// IndexedDB 版的读写在 WebKit 里实测过（Blob 直接存；不收 Blob 的无痕环境退回 ArrayBuffer）；Node 里没有 indexedDB。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extForMime, baseMime, mimeForFile, memoryStore, idbStore, DB_NAME } from '../src/core/audioStore.js';
import * as audio from '../src/core/audioStore.js';
import { sha256Hex, sha256Js } from '../src/core/sha256.js';

test('mime → 扩展名', () => {
  for (const [m, ext] of [['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'], ['audio/aac', 'm4a'], ['AUDIO/MP4; codecs="mp4a.40.2"', 'm4a'],
    ['audio/webm;codecs=opus', 'webm'], ['audio/ogg', 'ogg'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/mpeg', 'mp3'], ['', 'm4a'], [null, 'm4a']]) {
    assert.equal(extForMime(m), ext, String(m));
  }
  assert.equal(baseMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(DB_NAME, 'babble-audio');
});

test('选来的文件 → mime：浏览器给的优先，空的按扩展名', () => {
  assert.equal(mimeForFile({ name: '测试录音.m4a', type: '' }), 'audio/mp4');
  assert.equal(mimeForFile({ name: '测试录音.M4A', type: 'audio/x-m4a' }), 'audio/x-m4a');
  assert.equal(mimeForFile({ name: 'a.webm', type: 'application/octet-stream' }), 'audio/webm');
  assert.equal(mimeForFile({ name: 'a.mp3', type: '' }), 'audio/mpeg');
  assert.equal(mimeForFile({ name: '没有扩展名', type: '' }), 'audio/mp4');
});

test('内存版：同样内容只存一份；uploaded 标记；待上传按加入顺序', async () => {
  const s = memoryStore();
  const a = await s.putClip(new Blob(['测试录音A']), { mime: 'audio/mp4' });
  const again = await s.putClip(new Blob(['测试录音A'], { type: 'audio/x-m4a' }));
  assert.equal(again.sha256, a.sha256);
  assert.equal(again.mime, 'audio/mp4', '去重时保留第一次的类型');
  assert.equal(s.clips.size, 1);
  assert.equal(a.sha256, createHash('sha256').update('测试录音A').digest('hex'));
  const b = await s.putClip(new Blob(['测试录音B'], { type: 'audio/webm;codecs=opus' }));
  assert.equal(b.mime, 'audio/webm');
  assert.equal(await s.hasClip(a.sha256), true);
  assert.equal(await s.hasClip('0'.repeat(64)), false);
  assert.equal(await s.getClip('0'.repeat(64)), null);
  assert.ok((await s.listClips()).every(r => !('blob' in r)));
  await s.markUploaded(a.sha256);
  assert.deepEqual((await s.pendingUploads()).map(r => r.sha256), [b.sha256]);
  await s.putClip(new Blob(['测试录音B']), { uploaded: true });    // 同步下载来的：已知云端有
  assert.equal((await s.pendingUploads()).length, 0);
});

test('内存版：分片按 seq 排序；clearChunks 只删分片；clearRec 全删', async () => {
  const s = memoryStore();
  for (const seq of [2, 0, 10, 1]) await s.putChunk('r_1', seq, new Blob(['c' + seq]));
  await s.putChunk('r_2', 0, new Blob(['别的']));
  const texts = await Promise.all((await s.getChunks('r_1')).map(b => b.text()));
  assert.deepEqual(texts, ['c0', 'c1', 'c2', 'c10']);
  await s.putRecMeta({ recId: 'r_1', startedAt: 1, mime: 'audio/mp4', tz: null });
  await s.clearChunks('r_1');
  assert.equal((await s.getChunks('r_1')).length, 0);
  assert.ok(await s.getRecMeta('r_1'));
  assert.equal((await s.getChunks('r_2')).length, 1);
  await s.clearRec('r_2');
  assert.equal((await s.getChunks('r_2')).length, 0);
  assert.deepEqual((await s.listRecMeta()).map(m => m.recId), ['r_1']);
});

test('没有 IndexedDB（Node）：import 不出错，用的时候才报错；存储空间查询返回空', async () => {
  await assert.rejects(idbStore(() => undefined).listClips(), /no-indexeddb/);
  await assert.rejects(audio.getClip('x'), /no-indexeddb/);
  assert.equal(await audio.persisted(), false);
});

test('sha256：Blob / ArrayBuffer / 视图一致；纯 JS 版和 crypto.subtle 一致', async () => {
  const bytes = new TextEncoder().encode('👰🏻‍♀️“今天吃什么”');
  const want = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await sha256Hex(new Blob([bytes])), want);
  assert.equal(await sha256Hex(bytes.buffer), want);
  const padded = new Uint8Array(bytes.length + 6); padded.set(bytes, 3);
  assert.equal(await sha256Hex(padded.subarray(3, 3 + bytes.length)), want);
  assert.equal(sha256Js(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  let seed = 1;
  for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 4097]) {
    const b = Uint8Array.from({ length: n }, () => (seed = (seed * 48271) % 2147483647) & 255);
    assert.equal(sha256Js(b), createHash('sha256').update(b).digest('hex'), String(n));
  }
  await assert.rejects(sha256Hex('不是二进制'), TypeError);
});
