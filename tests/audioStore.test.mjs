// 本机录音库测试：扩展名 / mime、内存版的去重和分片、deleteClip（内存版和假的 IndexedDB）、没有 IndexedDB 时的报错、sha256（合成数据）
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

test('deleteClip：没上传的删掉（true）；已经上传的、没有的不删（false）；别的录音、分片不受影响', async () => {
  const s = memoryStore();
  const a = await s.putClip(new Blob(['测试录音：取消的']), { mime: 'audio/mp4' });
  const b = await s.putClip(new Blob(['测试录音：传上去了的']), { mime: 'audio/mp4' });
  const c = await s.putClip(new Blob(['测试录音：同步下载来的']), { mime: 'audio/mp4', uploaded: true });
  await s.markUploaded(b.sha256);
  await s.putChunk('r_1', 0, new Blob(['分片']));
  await s.putRecMeta({ recId: 'r_1', startedAt: 1, mime: 'audio/mp4', tz: null, done: true, sha256: a.sha256 });
  assert.equal(await s.deleteClip(a.sha256), true);
  assert.equal(await s.hasClip(a.sha256), false);
  assert.equal(await s.deleteClip(a.sha256), false, '已经没有了');
  assert.equal(await s.deleteClip(b.sha256), false, '上传过的不删');
  assert.equal(await s.deleteClip(c.sha256), false, '云端来的不删');
  assert.deepEqual((await s.listClips()).map(r => r.sha256).sort(), [b.sha256, c.sha256].sort());
  assert.equal((await s.getChunks('r_1')).length, 1, '分片、recMeta 不归它管（clearRec 才删）');
  assert.ok(await s.getRecMeta('r_1'));
  await s.markUploaded(b.sha256, false);                      // 换了仓库：以前的「已上传」不算数了 → 又能删
  assert.equal(await s.deleteClip(b.sha256), true);
  assert.equal(typeof audio.deleteClip, 'function');
  await assert.rejects(audio.deleteClip('x'), /no-indexeddb/);   // 模块级的照样只在用的时候才碰 IndexedDB
});

/** 最小的假 IndexedDB（只有 clips 用到的 get / put / delete / count；请求、事务完成都异步）：只测 idbStore 自己的逻辑 */
function fakeIDB() {
  const stores = new Map();
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) }, createObjectStore: (n, o) => { stores.set(n, { key: o && o.keyPath, m: new Map() }); }, close() {},
    transaction() {
      const tx = {};
      let pending = 1;
      const done = () => { if (--pending === 0) setTimeout(() => tx.oncomplete && tx.oncomplete()); };
      const req = (fn) => { pending++; const r = {}; setTimeout(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); done(); }); return r; };
      tx.objectStore = (n) => { const s = stores.get(n); return { get: k => req(() => s.m.get(k)), put: v => req(() => { s.m.set(v[s.key], v); }), delete: k => req(() => { s.m.delete(k); }), count: k => req(() => (s.m.has(k) ? 1 : 0)) }; };
      setTimeout(done);
      return tx;
    },
  };
  return { stores, open() { const r = {}; setTimeout(() => { r.result = db; r.onupgradeneeded({ oldVersion: 0 }); r.onsuccess(); }); return r; } };
}

test('IndexedDB 版 deleteClip（假的 IndexedDB）：没上传的删掉；上传过的不删', async () => {
  const idb = fakeIDB(), s = idbStore(() => idb);
  const a = await s.putClip(new Blob(['测试录音：取消的']), { mime: 'audio/mp4' });
  const b = await s.putClip(new Blob(['测试录音：传上去了的']), { mime: 'audio/mp4' });
  await s.markUploaded(b.sha256);
  assert.equal(await s.deleteClip(b.sha256), false);
  assert.equal(await s.deleteClip(a.sha256), true);
  assert.equal(await s.deleteClip(a.sha256), false);
  assert.equal(await s.hasClip(a.sha256), false);
  assert.equal(await s.hasClip(b.sha256), true);
  assert.deepEqual([...idb.stores.get('clips').m.keys()], [b.sha256]);
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
