// 本机录音库测试：扩展名 / mime、内存版的去重和分片、touchedAt、deleteClip / deleteClips（内存版和假的 IndexedDB）、没有 IndexedDB 时的报错、sha256（合成数据）
// IndexedDB 版的读写在 WebKit 里实测过（Blob 直接存；不收 Blob 的无痕环境退回 ArrayBuffer）；Node 里没有 indexedDB。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extForMime, baseMime, mimeForFile, mimeForExt, memoryStore, idbStore, DB_NAME } from '../src/core/audioStore.js';
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
  for (const [ext, m] of [['m4a', 'audio/mp4'], ['WEBM', 'audio/webm'], ['ogg', 'audio/ogg'], ['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['xyz', 'audio/mp4'], ['', 'audio/mp4'], [null, 'audio/mp4']]) {
    assert.equal(mimeForExt(ext), m, String(ext));
    if (ext && m !== 'audio/mp4') assert.equal(extForMime(m), ext.toLowerCase(), '仓库里的扩展名 → mime → 同一个扩展名');
  }
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

/** 最小的假 IndexedDB（get / put（外部键也行）/ delete（键或范围）/ count / getAll；请求按发出的顺序异步完成，事务最后完成）：只测 idbStore 自己的逻辑 */
function fakeIDB() {
  const stores = new Map();
  const K = k => (Array.isArray(k) ? JSON.stringify(k) : k);
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) }, createObjectStore: (n, o) => { stores.set(n, { key: o && o.keyPath, m: new Map() }); }, close() {},
    transaction() {
      const tx = {};
      let pending = 1;
      const done = () => { if (--pending === 0) setTimeout(() => tx.oncomplete && tx.oncomplete()); };
      const req = (fn) => { pending++; const r = {}; setTimeout(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); done(); }); return r; };
      tx.objectStore = (n) => {
        const s = stores.get(n);
        return {
          get: k => req(() => s.m.get(K(k))), put: (v, k) => req(() => { s.m.set(s.key ? v[s.key] : K(k), v); }), count: k => req(() => (s.m.has(K(k)) ? 1 : 0)),
          delete: k => req(() => { if (k && k.inRange) { for (const x of [...s.m.keys()]) if (k.inRange(JSON.parse(x))) s.m.delete(x); } else s.m.delete(K(k)); }),
          getAll: (range) => req(() => [...s.m].filter(([k]) => !range || range.inRange(JSON.parse(k))).map(([, v]) => v)),
        };
      };
      setTimeout(done);
      return tx;
    },
  };
  return { stores, open() { const r = {}; setTimeout(() => { r.result = db; r.onupgradeneeded({ oldVersion: 0 }); r.onsuccess(); }); return r; } };
}
/** 分片的键是 [recId, seq]：Node 里没有 IDBKeyRange，换一个只认 bound 的 */
function withKeyRange(fn) {
  const had = globalThis.IDBKeyRange;
  globalThis.IDBKeyRange = { bound: (lo, hi) => ({ inRange: k => Array.isArray(k) && k[0] === lo[0] && k[1] >= lo[1] && k[1] <= hi[1] }) };
  return Promise.resolve().then(fn).finally(() => { if (had === undefined) delete globalThis.IDBKeyRange; else globalThis.IDBKeyRange = had; });
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

/** 两种实现一样的 deleteClips 测试：a（上传过）连同 recMeta、分片删掉；b（stillGone 不同意）、c（刚存过）、正在录的 recMeta 都不动 */
async function deleteClipsCase(s) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const a = await s.putClip(new Blob(['测试录音：永久删除了的']), { mime: 'audio/mp4', uploaded: true });
    const b = await s.putClip(new Blob(['测试录音：又有人用了']), { mime: 'audio/mp4' });
    for (const seq of [0, 1, 2]) await s.putChunk('r_a', seq, new Blob(['分片' + seq]));
    await s.putRecMeta({ recId: 'r_a', startedAt: 1, mime: 'audio/mp4', tz: null, done: true, sha256: a.sha256 });
    await s.putChunk('r_live', 0, new Blob(['正在录']));
    await s.putRecMeta({ recId: 'r_live', startedAt: 2, mime: 'audio/mp4', tz: null });
    now += 2 * 3600e3;
    const c = await s.putClip(new Blob(['测试录音：刚导入的']), { mime: 'audio/mp4' });
    await s.putChunk('r_c', 0, new Blob(['c']));
    await s.putRecMeta({ recId: 'r_c', startedAt: 3, mime: 'audio/mp4', tz: null, done: true, sha256: c.sha256 });
    const asked = [];
    const out = await s.deleteClips([a.sha256, b.sha256, c.sha256, a.sha256, 'f'.repeat(64)], { stillGone: sha => { asked.push(sha); return sha !== b.sha256; }, minAge: 3600e3 });
    assert.deepEqual(out, [a.sha256], '只删了 a');
    assert.ok(asked.filter(x => x === a.sha256).length >= 1);
    assert.deepEqual((await s.listClips()).map(r => r.sha256).sort(), [b.sha256, c.sha256].sort());
    assert.equal((await s.getChunks('r_a')).length, 0, 'a 的分片删了');
    assert.equal(await s.getRecMeta('r_a'), null, 'a 的 recMeta 删了（启动时不会再拼回来）');
    assert.equal((await s.getChunks('r_live')).length, 1, '正在录的不碰');
    assert.ok(await s.getRecMeta('r_live'));
    assert.ok(await s.getRecMeta('r_c'), '没删的录音的 recMeta 留着');
    assert.deepEqual(await s.deleteClips([c.sha256], { stillGone: () => true, minAge: sha => (sha === c.sha256 ? 0 : 3600e3) }), [c.sha256], 'minAge 可以按段给（自己刚永久删除的 = 0）');
    assert.equal(await s.getRecMeta('r_c'), null);
    assert.deepEqual(await s.deleteClips([], { stillGone: () => true }), []);
    assert.deepEqual(await s.deleteClips([b.sha256]), [b.sha256], '没给 stillGone：照删');
    assert.equal((await s.listClips()).length, 0);
  } finally { Date.now = realNow; }
}

test('deleteClips（内存版）：上传过的也删，连同那几段的 recMeta 和分片；听 stillGone、minAge（touchedAt）', async () => {
  await deleteClipsCase(memoryStore());
});

test('deleteClips（假的 IndexedDB）：同一个事务里删 clips、recMeta、分片；事务里删之前再问一次 stillGone', async () => {
  const idb = fakeIDB();
  await withKeyRange(async () => {
    const s = idbStore(() => idb);
    await deleteClipsCase(s);
    let calls = 0;
    const x = await s.putClip(new Blob(['测试录音：x']), { mime: 'audio/mp4' });
    assert.deepEqual(await s.deleteClips([x.sha256], { stillGone: () => ++calls === 1 }), [], '读到记录时又不算永久删除了：不删');
    assert.equal(calls, 2, '事务开头问一次、删之前再问一次');
    assert.equal(await s.hasClip(x.sha256), true);
    assert.deepEqual([...idb.stores.get('rec').m.keys()], ['["r_live",0]'], '只剩正在录的那段的分片');
    assert.deepEqual([...idb.stores.get('recMeta').m.keys()], ['r_live']);
  });
  assert.equal(typeof audio.deleteClips, 'function');
  await assert.rejects(audio.deleteClips(['x'], { stillGone: () => true }), /no-indexeddb/);
});

test('putClip 记下 touchedAt：新存的 = addedAt；同样内容再存一次只更新 touchedAt（5 分钟内碰过的不重写）（内存版和假的 IndexedDB）', async () => {
  const realNow = Date.now;
  try {
    for (const s of [memoryStore(), idbStore(() => fakeIDB())]) {
      let now = 1_000_000;
      Date.now = () => now;
      const a = await s.putClip(new Blob(['测试录音：留下']), { mime: 'audio/mp4' });
      let r = (await s.listClips())[0];
      assert.equal(r.addedAt, 1_000_000); assert.equal(r.touchedAt, 1_000_000);
      now += 5000;
      await s.putClip(new Blob(['测试录音：留下']), { mime: 'audio/mp4', uploaded: true });
      r = (await s.listClips())[0];
      assert.equal(r.addedAt, 1_000_000); assert.equal(r.touchedAt, 1_005_000);
      assert.equal(r.uploaded, true, '照样升级 uploaded');
      assert.equal(r.sha256, a.sha256);
      now += 5000;
      await s.putClip(new Blob(['测试录音：留下']), { mime: 'audio/mp4' });
      r = (await s.listClips())[0];
      assert.equal(r.uploaded, true, '再存一次不会把 uploaded 改回去');
      assert.equal(r.touchedAt, 1_005_000, '5 分钟内碰过：不为了改时间重写整条');
      now += 5 * 60e3;
      await s.putClip(new Blob(['测试录音：留下']), { mime: 'audio/mp4' });
      assert.equal((await s.listClips())[0].touchedAt, now, '过了 5 分钟再记');
      assert.equal((await s.getClip(a.sha256)).blob instanceof Blob, true);
    }
  } finally { Date.now = realNow; }
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
