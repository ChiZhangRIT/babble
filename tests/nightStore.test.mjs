// 床头模式本机记录的测试：内存版和 IndexedDB 版（用这里手写的最小假 indexedDB）跑同一套读写；内存版的注入错误；
// 没有 IndexedDB 时的报错；启动时的读法和 recovery.test.mjs 里只会 getAll 的假 indexedDB 合得上。全是编的数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idbNightStore, memoryNightStore, NIGHT_DB, NIGHT_DB_VERSION } from '../src/core/nightStore.js';
import * as night from '../src/core/nightStore.js';
import * as audio from '../src/core/audioStore.js';

// ---------- 最小的假 indexedDB：够 nightStore 用（键：数字 / 字符串 / 数组；范围；索引；事务 complete、只读不许写） ----------
const rank = (k) => (Array.isArray(k) ? 3 : typeof k === 'string' ? 2 : 1);
function cmp(a, b) {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (Array.isArray(a)) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return a.length - b.length; }
  return a < b ? -1 : a > b ? 1 : 0;
}
const KeyRange = { bound: (lo, hi) => ({ lo, hi }) };
const inRange = (q, k) => (q && typeof q === 'object' && !Array.isArray(q) ? cmp(k, q.lo) >= 0 && cmp(k, q.hi) <= 0 : cmp(k, q) === 0);
const named = (name) => Object.assign(new Error(name), { name });
function fakeIDB() {
  const data = new Map();          // 库名 → { version, stores: Map(名 → { keyPath, auto, n, idx: Map(索引名 → keyPath), rows: [{ k, v }] }) }
  const env = { opens: 0, txs: [], breakNext: false, conns: [] };
  env.factory = { open(name, version) {
    env.opens++;
    const req = {};
    setTimeout(() => {
      let d = data.get(name), oldVersion = d ? d.version : 0;
      if (!d) data.set(name, d = { version, stores: new Map() });
      const conn = { closed: false, close() { this.closed = true; },
        objectStoreNames: { contains: (n) => d.stores.has(n) },
        createObjectStore(n, { keyPath = null, autoIncrement = false } = {}) {
          const st = { keyPath, auto: autoIncrement, n: 0, idx: new Map(), rows: [] };
          d.stores.set(n, st);
          return { createIndex: (iname, kp) => { st.idx.set(iname, kp); } };
        },
        transaction(names, mode = 'readonly') {
          if (env.breakNext) { env.breakNext = false; throw named('InvalidStateError'); }
          if (conn.closed) throw named('InvalidStateError');
          const scope = [].concat(names), tx = { pending: 0, done: false };
          env.txs.push({ scope, mode });
          const settle = () => setTimeout(() => { if (!tx.done && !tx.pending) { tx.done = true; tx.oncomplete && tx.oncomplete(); } });
          const request = (fn, write) => {
            if (write && mode !== 'readwrite') throw named('ReadOnlyError');
            const r = {}; tx.pending++;
            const v = fn();
            queueMicrotask(() => { r.result = v; if (r.onsuccess) r.onsuccess(); tx.pending--; settle(); });
            return r;
          };
          tx.abort = () => { tx.done = true; if (tx.onabort) tx.onabort(); };
          tx.objectStore = (n) => {
            if (!scope.includes(n)) throw named('NotFoundError');
            const st = d.stores.get(n), sorted = () => [...st.rows].sort((a, b) => cmp(a.k, b.k));
            const put = (v, k, add) => {
              v = structuredClone(v);
              if (st.keyPath) { if (st.auto && v[st.keyPath] == null) v[st.keyPath] = ++st.n; k = v[st.keyPath]; }
              if (k === undefined) throw named('DataError');
              const i = st.rows.findIndex(x => cmp(x.k, k) === 0);
              if (i >= 0 && add) throw named('ConstraintError');
              if (i >= 0) st.rows[i] = { k, v }; else st.rows.push({ k, v });
              return k;
            };
            const index = (iname) => { const kp = st.idx.get(iname); return {
              getAll: (q) => request(() => sorted().filter(x => inRange(q, x.v[kp])).map(x => structuredClone(x.v))),
              getAllKeys: (q) => request(() => sorted().filter(x => inRange(q, x.v[kp])).map(x => x.k)),
            }; };
            return {
              get: (k) => request(() => { const x = st.rows.find(y => cmp(y.k, k) === 0); return x ? structuredClone(x.v) : undefined; }),
              getAll: (q) => request(() => sorted().filter(x => q === undefined || inRange(q, x.k)).map(x => structuredClone(x.v))),
              put: (v, k) => request(() => put(v, k, false), true),
              add: (v, k) => request(() => put(v, k, true), true),
              delete: (q) => request(() => { st.rows = st.rows.filter(x => !inRange(q, x.k)); }, true),
              index,
            };
          };
          settle();
          return tx;
        } };
      env.conns.push(conn);
      req.result = conn;
      if (oldVersion < version && req.onupgradeneeded) { d.version = version; req.onupgradeneeded({ oldVersion }); }
      req.onsuccess();
    });
    return req;
  } };
  env.data = data;
  return env;
}
async function withKeyRange(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange');
  globalThis.IDBKeyRange = KeyRange;
  try { return await fn(); } finally { if (had) Object.defineProperty(globalThis, 'IDBKeyRange', had); else delete globalThis.IDBKeyRange; }
}

// ---------- 两个版本跑同一套 ----------
const pcm = (n, v) => new Int16Array(n).fill(v).buffer;
const sess = (id, startedAt, extra) => ({ id, v: 1, nightOf: '2026-11-17', startedAt, endedAt: null, status: 'live', gaps: [], notes: [], counts: {}, ...extra });
const cand = (id, s, startAt, extra) => ({ id, s, v: 1, state: 'open', startAt, endAt: null, sr: 16000, parts: 0, ...extra });
const MAKERS = {
  '内存版': async (fn) => fn(memoryNightStore()),
  'IndexedDB 版（假 indexedDB）': (fn) => withKeyRange(() => fn(idbNightStore(() => fakeIDB().factory))),
};

for (const [label, make] of Object.entries(MAKERS)) {
  test(`${label}：session 存取、合并修改、函数修改、找不到 → null；按开始时间排`, () => make(async (st) => {
    await st.putSession(sess('n_b', 2000));
    await st.putSession(sess('n_a', 1000, { counts: { clips: 0 } }));
    assert.deepEqual((await st.listSessions()).map(s => s.id), ['n_a', 'n_b']);
    const p = await st.patchSession('n_a', { status: 'ended', endedAt: 1500 });
    assert.equal(p.status, 'ended'); assert.equal(p.startedAt, 1000);
    const f = await st.patchSession('n_a', (s) => { s.counts.clips++; });
    assert.equal(f.counts.clips, 1);
    const g = await st.patchSession('n_a', (s) => ({ ...s, reviewedAt: 9, id: '别改 id' }));
    assert.equal(g.id, 'n_a'); assert.equal(g.reviewedAt, 9);
    assert.equal((await st.getSession('n_a')).counts.clips, 1);
    assert.equal(await st.patchSession('n_x', { status: 'ended' }), null);
    assert.equal(await st.getSession('n_x'), null);
    assert.equal((await st.listSessions()).length, 2, '改一个不存在的不会新建');
    // 读出来的是副本：改了不影响存着的
    (await st.getSession('n_b')).gaps.push({ from: 1, to: 2 });
    assert.deepEqual((await st.getSession('n_b')).gaps, []);
  }));

  test(`${label}：候选片段存取；listCands(sid) 只要这次的，不给 sid 要全部；按开始时间排`, () => make(async (st) => {
    await st.putCand(cand('c_2', 'n_a', 300));
    await st.putCand(cand('c_1', 'n_a', 100));
    await st.putCand(cand('c_3', 'n_b', 200));
    assert.deepEqual((await st.listCands('n_a')).map(c => c.id), ['c_1', 'c_2']);
    assert.deepEqual((await st.listCands()).map(c => c.id), ['c_1', 'c_3', 'c_2']);
    assert.deepEqual(await st.listCands('n_none'), []);
    const c = await st.patchCand('c_1', { state: 'new', samples: 16000, cut: 'quiet' });
    assert.equal(c.state, 'new'); assert.equal(c.s, 'n_a');
    assert.equal((await st.getCand('c_1')).samples, 16000);
    assert.equal(await st.patchCand('c_x', { state: 'new' }), null);
    assert.equal(await st.getCand('c_x'), null);
  }));

  test(`${label}：分片按 seq 排（10 在 2 后面）；deleteParts(id, from) 只删 seq ≥ from；别的片段不动`, () => make(async (st) => {
    for (const seq of [2, 0, 10, 1]) await st.putPart('c_1', seq, { b: pcm(4, seq), ls: seq * 100, sp: seq / 10 });
    await st.putPart('c_2', 0, { b: pcm(2, 7), ls: 0, sp: 0 });
    const ps = await st.getParts('c_1');
    assert.deepEqual(ps.map(p => p.ls), [0, 100, 200, 1000]);
    assert.ok(ps[3].b instanceof ArrayBuffer);
    assert.deepEqual([...new Int16Array(ps[3].b)], [10, 10, 10, 10]);
    assert.deepEqual(Object.keys(ps[0]).sort(), ['b', 'ls', 'sp']);
    await st.putPart('c_1', 1, { b: pcm(4, 5), ls: 150, sp: 0.15 });              // 同一个 seq 重写 = 覆盖
    assert.equal((await st.getParts('c_1'))[1].ls, 150);
    await st.deleteParts('c_1', 2);
    assert.deepEqual((await st.getParts('c_1')).map(p => p.ls), [0, 150]);
    await st.deleteParts('c_1');
    assert.deepEqual(await st.getParts('c_1'), []);
    assert.equal((await st.getParts('c_2')).length, 1);
  }));

  test(`${label}：dropCand 片段信息和声音一起删；deleteSession 连事件、片段、声音一起删，别的 session 不动`, () => make(async (st) => {
    await st.putSession(sess('n_a', 1000)); await st.putSession(sess('n_b', 2000));
    await st.putCand(cand('c_1', 'n_a', 1)); await st.putCand(cand('c_2', 'n_a', 2)); await st.putCand(cand('c_3', 'n_b', 3));
    for (const c of ['c_1', 'c_2', 'c_3']) for (const seq of [0, 1]) await st.putPart(c, seq, { b: pcm(2, 1), ls: 0, sp: 0 });
    await st.logEvent('n_a', 10, 'start', { rate: 48000 }); await st.logEvent('n_b', 11, 'start'); await st.logEvent('n_a', 12, 'end', { reason: 'user' });
    await st.dropCand('c_1');
    assert.equal(await st.getCand('c_1'), null);
    assert.deepEqual(await st.getParts('c_1'), []);
    assert.equal((await st.getParts('c_2')).length, 2);
    await st.deleteSession('n_a');
    assert.equal(await st.getSession('n_a'), null);
    assert.deepEqual(await st.listCands('n_a'), []);
    assert.deepEqual(await st.getParts('c_2'), []);
    assert.deepEqual(await st.listEvents('n_a'), []);
    assert.ok(await st.getSession('n_b'));
    assert.equal((await st.getParts('c_3')).length, 2);
    assert.deepEqual((await st.listEvents('n_b')).map(e => e.k), ['start']);
  }));

  test(`${label}：事件自增编号、按顺序；没给 d 就没有 d 字段`, () => make(async (st) => {
    await st.logEvent('n_a', 100, 'start', { rate: 48000 });
    await st.logEvent('n_a', 101, 'vis');
    await st.logEvent('n_b', 102, 'start');
    await st.logEvent('n_a', 103, 'gap-open', { reason: 'muted' });
    const ev = await st.listEvents('n_a');
    assert.deepEqual(ev.map(e => e.k), ['start', 'vis', 'gap-open']);
    assert.ok(ev[0].n < ev[1].n && ev[1].n < ev[2].n);
    assert.deepEqual(ev[0].d, { rate: 48000 });
    assert.equal('d' in ev[1], false);
    assert.equal(ev[2].s, 'n_a'); assert.equal(ev[2].t, 103);
  }));
}

// ---------- 内存版：注入错误 ----------
test('内存版：fail.putPart = n → 接下来 n 次失败、什么都没写，然后照常；quota → QuotaExceededError；calls 按顺序记下', async () => {
  const st = memoryNightStore({ fail: { putPart: 2 } });
  for (let i = 0; i < 2; i++) await assert.rejects(st.putPart('c_1', 0, { b: pcm(2, 1), ls: 0, sp: 0 }), (e) => e.name === 'UnknownError');
  assert.equal(st.maps.parts.size, 0);
  await st.putPart('c_1', 0, { b: pcm(2, 1), ls: 0, sp: 0 });
  assert.equal(st.maps.parts.size, 1);
  st.fail.quota = true;
  await assert.rejects(st.putPart('c_1', 1, { b: pcm(2, 1), ls: 0, sp: 0 }), (e) => e.name === 'QuotaExceededError');
  await st.putCand(cand('c_1', 'n_a', 1));                       // 存储满只让分片写不进，别的照常（测试好控制）
  st.fail.quota = false;
  await st.putPart('c_1', 1, { b: pcm(2, 1), ls: 0, sp: 0 });
  assert.deepEqual(st.calls, ['putPart', 'putPart', 'putPart', 'putPart', 'putCand', 'putPart']);
  assert.equal(await st.estimate(), null);
});

test('内存版：dropCand / deleteSession / patch 注入失败时什么都不删不改（一整个事务）', async () => {
  const st = memoryNightStore({ fail: { dropCand: 1, deleteSession: 1, patchCand: 1 } });
  await st.putSession(sess('n_a', 1)); await st.putCand(cand('c_1', 'n_a', 1));
  await st.putPart('c_1', 0, { b: pcm(2, 1), ls: 0, sp: 0 }); await st.logEvent('n_a', 1, 'start');
  await assert.rejects(st.dropCand('c_1'));
  await assert.rejects(st.deleteSession('n_a'));
  await assert.rejects(st.patchCand('c_1', { state: 'new' }));
  assert.equal(st.maps.cands.get('c_1').state, 'open');
  assert.equal(st.maps.parts.size, 1); assert.equal(st.maps.events.length, 1); assert.equal(st.maps.sessions.size, 1);
  await st.dropCand('c_1');
  assert.equal(st.maps.cands.size, 0); assert.equal(st.maps.parts.size, 0);
});

test('内存版：存进去的是副本（之后改原对象、改读出来的 ArrayBuffer 都不影响）', async () => {
  const st = memoryNightStore();
  const s = sess('n_a', 1); await st.putSession(s); s.status = 'ended';
  assert.equal((await st.getSession('n_a')).status, 'live');
  const b = pcm(2, 3); await st.putPart('c_1', 0, { b, ls: 0, sp: 0 }); new Int16Array(b).fill(9);
  const [p] = await st.getParts('c_1'); new Int16Array(p.b).fill(8);
  assert.deepEqual([...new Int16Array((await st.getParts('c_1'))[0].b)], [3, 3]);
});

// ---------- IndexedDB 版 ----------
test('没有 IndexedDB（Node）：import 不出错，用的时候才报错；模块级接口也一样；estimate 就是 audioStore 的', async () => {
  await assert.rejects(idbNightStore(() => undefined).listSessions(), /no-indexeddb/);
  await assert.rejects(night.listSessions(), /no-indexeddb/);
  await assert.rejects(night.putPart('c_1', 0, { b: pcm(1, 0), ls: 0, sp: 0 }), /no-indexeddb/);
  assert.equal(night.estimate, audio.estimate);
  assert.equal(NIGHT_DB, 'babble-night'); assert.equal(NIGHT_DB_VERSION, 1);
  for (const k of ['putSession', 'patchSession', 'getSession', 'listSessions', 'deleteSession', 'logEvent', 'listEvents', 'putCand', 'patchCand', 'getCand',
    'listCands', 'putPart', 'getParts', 'deleteParts', 'dropCand', 'estimate']) {
    assert.equal(typeof night[k], 'function', k);
    assert.equal(typeof memoryNightStore()[k], 'function', k);
  }
});

test('IndexedDB 版：第 1 版的库结构（四个 store、键、索引 s）；连接被系统断开（InvalidStateError）重开一次再试', () => withKeyRange(async () => {
  const env = fakeIDB(), st = idbNightStore(() => env.factory);
  await st.listSessions();
  const d = env.data.get('babble-night');
  assert.equal(d.version, 1);
  assert.deepEqual([...d.stores.keys()].sort(), ['cands', 'events', 'parts', 'sessions']);
  assert.equal(d.stores.get('sessions').keyPath, 'id');
  assert.equal(d.stores.get('cands').keyPath, 'id'); assert.equal(d.stores.get('cands').idx.get('s'), 's');
  assert.equal(d.stores.get('events').keyPath, 'n'); assert.equal(d.stores.get('events').auto, true); assert.equal(d.stores.get('events').idx.get('s'), 's');
  assert.equal(d.stores.get('parts').keyPath, null);
  assert.equal(env.opens, 1);
  env.breakNext = true;
  await st.putSession(sess('n_a', 1));
  assert.equal(env.opens, 2);
  assert.ok(await st.getSession('n_a'));
  // 别的标签页要升级：关掉连接，下次自动重开
  env.conns.at(-1).onversionchange();
  assert.ok(await st.getSession('n_a'));
  assert.equal(env.opens, 3);
  // 读用 readonly 事务，写用 readwrite；dropCand 同一个事务里删 cands 和 parts
  assert.ok(env.txs.filter(x => x.mode === 'readonly').length >= 3);
  await st.dropCand('c_1');
  assert.deepEqual(env.txs.at(-1), { scope: ['cands', 'parts'], mode: 'readwrite' });
}));

test('启动时的读法：recovery.test.mjs 里的假 indexedDB（只有 open → transaction → objectStore → getAll）也能读出空列表', async () => {
  let opens = 0;
  const seen = [];
  const stub = { open() {
    opens++; const request = {};
    queueMicrotask(() => {
      request.result = { transaction(stores) { seen.push(stores); const tx = { objectStore: () => ({ getAll: () => ({ result: [] }) }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
      request.onsuccess();
    });
    return request;
  } };
  const st = idbNightStore(() => stub);
  assert.deepEqual(await st.listSessions(), []);
  assert.deepEqual(await st.listCands(), []);
  assert.equal(opens, 1);
  assert.deepEqual(seen, ['sessions', 'cands']);
});


test('IndexedDB 打开时同步失败或接口暂不可用：环境恢复后可重试，重试并发共用新连接', () => withKeyRange(async () => {
  for (const mode of ['getter', 'missing', 'open']) {
    const env = fakeIDB(); let failed = true;
    const st = idbNightStore(() => {
      if (failed) {
        if (mode === 'getter') throw new Error('temporary getter');
        if (mode === 'missing') return undefined;
        return { open() { throw Object.assign(new Error('temporary open'), { name: 'SecurityError' }); } };
      }
      return env.factory;
    });
    await assert.rejects(st.listSessions());
    failed = false;
    await Promise.all([st.putSession(sess('recovered', 1)), st.listCands()]);
    assert.ok(await st.getSession('recovered'), mode);
    assert.equal(env.opens, 1, mode + ': 重试后的并发请求共用连接');
  }
}));
