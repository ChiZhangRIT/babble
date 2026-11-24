// 床头模式的本机记录（IndexedDB babble-night，第 1 版；和 babble-audio 分开：这边升级不会让还开着的旧页面的录音库 VersionError）：
//   sessions  id → 一次床头模式（几点开始结束、哪些时候没在听、为什么、设备和采集信息；alive 每 10 秒改写一次）
//   events    n（自增）→ { n, s: sessionId, t, k, d? }   事件日志，索引 s（一晚几千条，单独存，session 记录保持小）
//   cands     id → 候选片段的信息（不含声音），索引 s
//   parts     [candId, seq] → { b: ArrayBuffer（PCM16 小端 16 kHz 单声道，约 1 秒）, ls, sp }   片段的声音，读的时候再加 WAV 头
//             ls = 到这一片为止最后一句说话结束的位置（相对片段开头，样本数）；sp = 到这一片为止说了几秒。App 被杀后靠它们收尾
// 声音一律存 ArrayBuffer（不存 Blob），用不着「IndexedDB 不收 Blob」的退路。
// 模块导出的函数用浏览器的 indexedDB（import 时不碰它，Node 测试能 import；ctx.night 就是这个模块）；
// memoryNightStore() 是同样接口的内存版：测试用，能注入写入失败、存储满。
// 启动时找回和清理只先读 listSessions() / listCands()（都是 getAll）；有要处理的才读索引、才写。
import { estimate } from './audioStore.js';

export const NIGHT_DB = 'babble-night', NIGHT_DB_VERSION = 1;
export { estimate };

const byStarted = (a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.id).localeCompare(String(b.id));
const byStart = (a, b) => (a.startAt || 0) - (b.startAt || 0) || String(a.id).localeCompare(String(b.id));
const byN = (a, b) => a.n - b.n;
/** patchOrFn：对象 → 合并进去；函数 → fn(旧记录的副本) 返回新记录（返回空就用改过的副本） */
const patched = (cur, p) => (typeof p === 'function' ? p(cur) ?? cur : { ...cur, ...p });
const evOf = (s, t, k, d) => (d === undefined ? { s, t, k } : { s, t, k, d });

// ---------- IndexedDB 版 ----------
/** @param {() => IDBFactory|undefined} [getIDB] 测试可以注入假的 indexedDB */
export function idbNightStore(getIDB = () => globalThis.indexedDB) {
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const idb = getIDB();
      if (!idb) { reject(new Error('no-indexeddb')); return; }
      let req;
      try { req = idb.open(NIGHT_DB, NIGHT_DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = (ev) => {
        const db = req.result, has = (n) => db.objectStoreNames.contains(n);
        // 按版本一步步升级；以后加 store 写成 if (ev.oldVersion < 2) { … }（只动这个库）
        if (ev.oldVersion < 1) {
          if (!has('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          if (!has('events')) db.createObjectStore('events', { keyPath: 'n', autoIncrement: true }).createIndex('s', 's');
          if (!has('cands')) db.createObjectStore('cands', { keyPath: 'id' }).createIndex('s', 's');
          if (!has('parts')) db.createObjectStore('parts');          // 外部键 [candId, seq]
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); opening = null; };   // 别的标签页要升级：先让路
        db.onclose = () => { opening = null; };                       // 系统把连接关了（iOS 后台久了会）：下次重开
        resolve(db);
      };
      req.onerror = () => { opening = null; reject(req.error || new Error('idb-open')); };
      req.onblocked = () => { /* 旧连接还开着：等它们关掉后会继续 */ };
    });
    const pending = opening;
    // getIDB / open 也可能同步抛错；拒绝的 Promise 不能永久充当连接缓存。
    pending.catch(() => { if (opening === pending) opening = null; });
    return pending;
  }

  /** 跑一个事务（同 audioStore）：fn(tx) 发请求，返回「取结果」的函数；complete 了才 resolve。InvalidStateError 重开一次再试 */
  async function run(stores, mode, fn) {
    for (let attempt = 0; ; attempt++) {
      const db = await open();
      let tx;
      try { tx = db.transaction(stores, mode); }
      catch (e) {
        if (attempt === 0 && e && e.name === 'InvalidStateError') { opening = null; try { db.close(); } catch (_) { /* 已经断了 */ } continue; }
        throw e;
      }
      return new Promise((resolve, reject) => {
        let out;
        tx.oncomplete = () => { try { resolve(typeof out === 'function' ? out() : out); } catch (e) { reject(e); } };
        tx.onabort = () => reject(tx.error || new Error('idb-abort'));      // 存储满时是 QuotaExceededError
        try { out = fn(tx); } catch (e) { try { tx.abort(); } catch (_) { /* 已经结束 */ } reject(e); }
      });
    }
  }
  const parts = (cid, from = 0) => globalThis.IDBKeyRange.bound([cid, from], [cid, Infinity]);
  const get = (name) => (id) => run(name, 'readonly', (tx) => { const r = tx.objectStore(name).get(id); return () => r.result || null; });
  const put = (name) => (v) => run(name, 'readwrite', (tx) => { tx.objectStore(name).put(v); });
  const patch = (name) => (id, p) => run(name, 'readwrite', (tx) => {
    const st = tx.objectStore(name), g = st.get(id);
    let next = null;
    g.onsuccess = () => { if (!g.result) return; next = { ...patched(g.result, p), id }; st.put(next); };
    return () => next;
  });
  /** sid 不给 → getAll（启动时只走这条）；给了 → 索引 s */
  const all = (name, sort, sid) => run(name, 'readonly', (tx) => {
    const st = tx.objectStore(name), r = sid == null ? st.getAll() : st.index('s').getAll(sid);
    return () => (r.result || []).sort(sort);
  });

  return {
    putSession: put('sessions'), patchSession: patch('sessions'), getSession: get('sessions'),
    listSessions: () => all('sessions', byStarted),
    /** 连同这次的事件、候选片段和它们的声音一起删（同一个事务） */
    deleteSession: (id) => run(['sessions', 'events', 'cands', 'parts'], 'readwrite', (tx) => {
      tx.objectStore('sessions').delete(id);
      const ev = tx.objectStore('events'), ek = ev.index('s').getAllKeys(id);
      ek.onsuccess = () => { for (const k of ek.result || []) ev.delete(k); };
      const cs = tx.objectStore('cands'), ps = tx.objectStore('parts'), ck = cs.index('s').getAllKeys(id);
      ck.onsuccess = () => { for (const k of ck.result || []) { cs.delete(k); ps.delete(parts(k)); } };
    }),
    logEvent: (sid, t, k, d) => run('events', 'readwrite', (tx) => { tx.objectStore('events').add(evOf(sid, t, k, d)); }),
    listEvents: (sid) => all('events', byN, sid),
    putCand: put('cands'), patchCand: patch('cands'), getCand: get('cands'),
    listCands: (sid) => all('cands', byStart, sid),
    putPart: (cid, seq, { b, ls, sp }) => run('parts', 'readwrite', (tx) => { tx.objectStore('parts').put({ b, ls, sp }, [cid, seq]); }),
    /** → 按 seq 排好的 [{ b, ls, sp }] */
    getParts: (cid) => run('parts', 'readonly', (tx) => { const r = tx.objectStore('parts').getAll(parts(cid)); return () => r.result || []; }),
    /** 删 seq ≥ fromSeq 的分片（收尾时去掉最后一句 + 2 秒之后的） */
    deleteParts: (cid, fromSeq = 0) => run('parts', 'readwrite', (tx) => { tx.objectStore('parts').delete(parts(cid, fromSeq)); }),
    /** 候选片段和它的声音一起删（同一个事务） */
    dropCand: (id) => run(['cands', 'parts'], 'readwrite', (tx) => { tx.objectStore('cands').delete(id); tx.objectStore('parts').delete(parts(id)); }),
    estimate,
  };
}

// ---------- 内存版（同样接口） ----------
const named = (name, message) => Object.assign(new Error(message), { name });
/**
 * @param {{fail?: object}} [o]  fail 注入错误（测试中途也能改，返回值上的 fail 就是它）：
 *   { 方法名: n } → 接下来 n 次调用这个方法失败（UnknownError，什么都不改）；{ quota: true } → putPart 一直 QuotaExceededError
 * @returns 同样的接口，外加 maps（测试直接看里面）和 calls（调过的方法名，按顺序）
 */
export function memoryNightStore({ fail = {} } = {}) {
  const sessions = new Map(), events = [], cands = new Map(), parts = new Map(), calls = [];
  let n = 0;
  const copy = (v) => (v == null ? null : structuredClone(v));      // 像 IndexedDB 一样存进去、读出来都是副本
  const key = (cid, seq) => cid + '\u0000' + seq;
  // 每个方法都过这里：记下调用、等一拍（像事务一样异步）、按 fail 失败
  const op = (name, fn) => async (...a) => {
    calls.push(name);
    await null;
    if (name === 'putPart' && fail.quota) throw named('QuotaExceededError', 'quota (injected)');
    if (fail[name] > 0) { fail[name]--; throw named('UnknownError', name + ' (injected)'); }
    return fn(...a);
  };
  const patch = (map) => (id, p) => { const cur = map.get(id); if (!cur) return null; const next = { ...patched(copy(cur), p), id }; map.set(id, copy(next)); return copy(next); };
  const partsOf = (cid) => [...parts.values()].filter(x => x.cid === cid).sort((a, b) => a.seq - b.seq);
  const delParts = (cid, from = 0) => { for (const x of partsOf(cid)) if (x.seq >= from) parts.delete(key(cid, x.seq)); };
  const api = {
    putSession: op('putSession', (s) => { sessions.set(s.id, copy(s)); }),
    patchSession: op('patchSession', patch(sessions)),
    getSession: op('getSession', (id) => copy(sessions.get(id))),
    listSessions: op('listSessions', () => [...sessions.values()].map(copy).sort(byStarted)),
    deleteSession: op('deleteSession', (id) => {
      sessions.delete(id);
      for (let i = events.length - 1; i >= 0; i--) if (events[i].s === id) events.splice(i, 1);
      for (const c of [...cands.values()]) if (c.s === id) { cands.delete(c.id); delParts(c.id); }
    }),
    logEvent: op('logEvent', (sid, t, k, d) => { events.push(copy({ n: ++n, ...evOf(sid, t, k, d) })); }),
    listEvents: op('listEvents', (sid) => events.filter(e => e.s === sid).map(copy).sort(byN)),
    putCand: op('putCand', (c) => { cands.set(c.id, copy(c)); }),
    patchCand: op('patchCand', patch(cands)),
    getCand: op('getCand', (id) => copy(cands.get(id))),
    listCands: op('listCands', (sid) => [...cands.values()].filter(c => sid == null || c.s === sid).map(copy).sort(byStart)),
    putPart: op('putPart', (cid, seq, { b, ls, sp }) => { parts.set(key(cid, seq), copy({ cid, seq, b, ls, sp })); }),
    getParts: op('getParts', (cid) => partsOf(cid).map(({ b, ls, sp }) => copy({ b, ls, sp }))),
    deleteParts: op('deleteParts', (cid, fromSeq = 0) => delParts(cid, fromSeq)),
    dropCand: op('dropCand', (id) => { cands.delete(id); delParts(id); }),
    estimate: async () => null,
  };
  return { ...api, maps: { sessions, events, cands, parts }, calls, fail };
}

// ---------- 模块级接口（浏览器里的 babble-night；ctx.night 就是这个模块） ----------
const db = idbNightStore();
export const putSession = (s) => db.putSession(s);
export const patchSession = (id, patchOrFn) => db.patchSession(id, patchOrFn);
export const getSession = (id) => db.getSession(id);
export const listSessions = () => db.listSessions();
export const deleteSession = (id) => db.deleteSession(id);
export const logEvent = (sid, t, k, d) => db.logEvent(sid, t, k, d);
export const listEvents = (sid) => db.listEvents(sid);
export const putCand = (c) => db.putCand(c);
export const patchCand = (id, patchOrFn) => db.patchCand(id, patchOrFn);
export const getCand = (id) => db.getCand(id);
export const listCands = (sid) => db.listCands(sid);
export const putPart = (candId, seq, part) => db.putPart(candId, seq, part);
export const getParts = (candId) => db.getParts(candId);
export const deleteParts = (candId, fromSeq = 0) => db.deleteParts(candId, fromSeq);
export const dropCand = (id) => db.dropCand(id);
