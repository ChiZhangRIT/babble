// 本机录音库（IndexedDB babble-audio，第 1 版）：
//   clips    sha256 → { sha256, blob, mime, bytes, addedAt, uploaded }   录音本体（Blob 直接存，不转 base64；
//            Safari 无痕浏览等不让存 Blob 的环境改存 data: ArrayBuffer，读出来时包回 Blob）
//   rec      [recId, seq] → Blob                                         录音中的分片（每秒一片，App 被杀也能找回）
//   recMeta  recId → { recId, startedAt, mime, tz, attachTo?, done?, sha256? }  这段录音的信息（done：已经存成 clip）
// 模块导出的函数用浏览器的 indexedDB（import 时不碰它，Node 测试能 import）；
// memoryStore() 是同样接口的内存版：测试、录音诊断用，不落盘。
import { sha256Hex } from './sha256.js';

export const DB_NAME = 'babble-audio';
export const DB_VERSION = 1;

/** mime → 扩展名：audio/mp4|x-m4a|aac → m4a，webm → webm，ogg → ogg，wav → wav，mpeg → mp3；不认识的按 m4a */
export function extForMime(mime) {
  const m = baseMime(mime);
  if (m === 'audio/webm' || m === 'video/webm') return 'webm';
  if (m === 'audio/ogg' || m === 'audio/opus') return 'ogg';
  if (m === 'audio/wav' || m === 'audio/x-wav' || m === 'audio/wave' || m === 'audio/vnd.wave') return 'wav';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  return 'm4a';
}
/** 'audio/webm;codecs=opus' → 'audio/webm'（小写，去参数） */
export const baseMime = (mime) => String(mime || '').toLowerCase().split(';')[0].trim();

const EXT_MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', caf: 'audio/x-caf' };
/** 选来的文件 → mime：浏览器给了就用（去参数），没给（iOS 有时是空的）按扩展名，最后按 m4a */
export function mimeForFile(file) {
  const t = baseMime(file && file.type);
  if (t && t !== 'application/octet-stream') return t;
  const ext = String((file && file.name) || '').toLowerCase().split('.').pop();
  return EXT_MIME[ext] || 'audio/mp4';
}

const stripBlob = ({ blob, data, ...r }) => r;
/** 记录 → 一定带 blob（存的是 ArrayBuffer 的包回 Blob） */
function fromRecord(r) {
  if (!r) return null;
  if (r.blob) return r;
  const { data, ...rest } = r;
  return { ...rest, blob: data ? new Blob([data], { type: r.mime || '' }) : null };
}
const asBlob = (v) => (v instanceof Blob ? v : new Blob([v]));

// ---------- IndexedDB 版 ----------
/** @param {() => IDBFactory|undefined} [getIDB] 测试可以注入假的 indexedDB */
export function idbStore(getIDB = () => globalThis.indexedDB) {
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const idb = getIDB();
      if (!idb) { reject(new Error('no-indexeddb')); return; }
      let req;
      try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        // 按版本一步步升级；以后加 store 写成 if (ev.oldVersion < 2) { … }
        if (ev.oldVersion < 1) {
          if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'sha256' });
          if (!db.objectStoreNames.contains('rec')) db.createObjectStore('rec');            // 外部键 [recId, seq]，值就是 Blob
          if (!db.objectStoreNames.contains('recMeta')) db.createObjectStore('recMeta', { keyPath: 'recId' });
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
    return opening;
  }

  /**
   * 跑一个事务：fn(tx) 发请求，返回「取结果」的函数（或直接返回值）。等事务 complete 才 resolve（真写进去了才算）。
   * iOS 偶尔会断开 IndexedDB 连接（transaction() 抛 InvalidStateError）：重开一次再试。
   */
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
        tx.onabort = () => reject(tx.error || new Error('idb-abort'));
        try { out = fn(tx); } catch (e) { try { tx.abort(); } catch (_) { /* 已经结束 */ } reject(e); }
      });
    }
  }
  // 有的环境（Safari 无痕浏览、临时 WebView）IndexedDB 不收 Blob（"Error preparing Blob/File data…"）：
  // 失败一次就改存 ArrayBuffer，之后都这样；改存也失败说明不是 Blob 的问题，抛原来的错
  let blobsOk = true;
  async function storing(write) {
    if (!blobsOk) return write(true);
    try { return await write(false); }
    catch (e) {
      let r;
      try { r = await write(true); } catch (e2) { throw e; }
      blobsOk = false;
      return r;
    }
  }
  const IDBKR = () => globalThis.IDBKeyRange;
  const chunkRange = (recId) => IDBKR().bound([recId, 0], [recId, Infinity]);

  const api = {
    /** 存一段录音（同样内容只存一份）→ { sha256, mime, bytes }。uploaded: true = 已知云端有（同步下载来的） */
    async putClip(blob, { mime, uploaded = false } = {}) {
      const sha256 = await sha256Hex(blob);
      const type = baseMime(mime || blob.type) || 'audio/mp4';
      return storing(async (asBuffer) => {
        // 存成带正确类型的 Blob（不复制内容）；不收 Blob 的环境存 ArrayBuffer（要在事务外先读出来）
        const body = asBuffer ? { data: await blob.arrayBuffer() } : { blob: blob.type === type ? blob : new Blob([blob], { type }) };
        return run('clips', 'readwrite', (tx) => {
          const st = tx.objectStore('clips');
          let res = { sha256, mime: type, bytes: blob.size };
          const g = st.get(sha256);
          g.onsuccess = () => {
            const old = g.result;
            if (old) {
              res = { sha256, mime: old.mime || type, bytes: old.bytes ?? blob.size };
              if (uploaded && !old.uploaded) st.put({ ...old, uploaded: true });
            } else st.put({ sha256, ...body, mime: type, bytes: blob.size, addedAt: Date.now(), uploaded: !!uploaded });
          };
          return () => res;
        });
      });
    },
    /** → { sha256, blob, mime, bytes, addedAt, uploaded } | null */
    getClip: (sha) => run('clips', 'readonly', (tx) => { const r = tx.objectStore('clips').get(sha); return () => fromRecord(r.result); }),
    hasClip: (sha) => run('clips', 'readonly', (tx) => { const r = tx.objectStore('clips').count(sha); return () => r.result > 0; }),
    /** → 所有录音的信息（不含 blob）：[{ sha256, mime, bytes, addedAt, uploaded }] */
    listClips: () => run('clips', 'readonly', (tx) => { const r = tx.objectStore('clips').getAll(); return () => (r.result || []).map(stripBlob); }),
    markUploaded: (sha, uploaded = true) => run('clips', 'readwrite', (tx) => {
      const st = tx.objectStore('clips'), g = st.get(sha);
      g.onsuccess = () => { if (g.result && !!g.result.uploaded !== !!uploaded) st.put({ ...g.result, uploaded: !!uploaded }); };
    }),
    /** → 还没上传的录音：[{ sha256, mime, bytes, addedAt, uploaded: false }]，旧的在前 */
    pendingUploads: async () => (await api.listClips()).filter(r => !r.uploaded).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)),

    putChunk: (recId, seq, blob) => storing(async (asBuffer) => {
      const v = asBuffer ? await blob.arrayBuffer() : blob;
      return run('rec', 'readwrite', (tx) => { tx.objectStore('rec').put(v, [recId, seq]); });
    }),
    /** → 按 seq 排好的 Blob 数组 */
    getChunks: (recId) => run('rec', 'readonly', (tx) => { const r = tx.objectStore('rec').getAll(chunkRange(recId)); return () => (r.result || []).map(asBlob); }),
    /** 只删分片（recMeta 留着） */
    clearChunks: (recId) => run('rec', 'readwrite', (tx) => { tx.objectStore('rec').delete(chunkRange(recId)); }),
    /** meta = { recId, startedAt, mime, tz, attachTo?, done?, sha256? } */
    putRecMeta: (meta) => run('recMeta', 'readwrite', (tx) => { tx.objectStore('recMeta').put({ ...meta }); }),
    getRecMeta: (recId) => run('recMeta', 'readonly', (tx) => { const r = tx.objectStore('recMeta').get(recId); return () => r.result || null; }),
    listRecMeta: () => run('recMeta', 'readonly', (tx) => { const r = tx.objectStore('recMeta').getAll(); return () => r.result || []; }),
    /** 分片和 recMeta 一起删（同一个事务） */
    clearRec: (recId) => run(['rec', 'recMeta'], 'readwrite', (tx) => {
      tx.objectStore('rec').delete(chunkRange(recId));
      tx.objectStore('recMeta').delete(recId);
    }),
    estimate, persist, persisted,
  };
  return api;
}

// ---------- 内存版（同样接口） ----------
export function memoryStore() {
  const clips = new Map(), rec = new Map(), recMeta = new Map();
  const tick = () => Promise.resolve();
  const api = {
    clips, rec, recMeta,     // 测试直接看里面
    async putClip(blob, { mime, uploaded = false } = {}) {
      const sha256 = await sha256Hex(blob);
      const type = baseMime(mime || blob.type) || 'audio/mp4';
      const old = clips.get(sha256);
      if (old) { if (uploaded) old.uploaded = true; return { sha256, mime: old.mime, bytes: old.bytes }; }
      clips.set(sha256, { sha256, blob, mime: type, bytes: blob.size, addedAt: Date.now(), uploaded: !!uploaded });
      return { sha256, mime: type, bytes: blob.size };
    },
    async getClip(sha) { await tick(); const r = clips.get(sha); return r ? { ...r } : null; },
    async hasClip(sha) { await tick(); return clips.has(sha); },
    async listClips() { await tick(); return [...clips.values()].map(stripBlob); },
    async markUploaded(sha, uploaded = true) { await tick(); const r = clips.get(sha); if (r) r.uploaded = !!uploaded; },
    pendingUploads: async () => (await api.listClips()).filter(r => !r.uploaded).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)),
    async putChunk(recId, seq, blob) { await tick(); rec.set(recId + '\u0000' + seq, { recId, seq, blob }); },
    async getChunks(recId) { await tick(); return [...rec.values()].filter(c => c.recId === recId).sort((a, b) => a.seq - b.seq).map(c => c.blob); },
    async clearChunks(recId) { await tick(); for (const [k, c] of [...rec]) if (c.recId === recId) rec.delete(k); },
    async putRecMeta(meta) { await tick(); recMeta.set(meta.recId, { ...meta }); },
    async getRecMeta(recId) { await tick(); const m = recMeta.get(recId); return m ? { ...m } : null; },
    async listRecMeta() { await tick(); return [...recMeta.values()].map(m => ({ ...m })); },
    async clearRec(recId) { await api.clearChunks(recId); recMeta.delete(recId); },
    estimate: async () => null, persist: async () => false, persisted: async () => false,
  };
  return api;
}

// ---------- 存储空间 ----------
const storage = () => (globalThis.navigator && globalThis.navigator.storage) || null;
/** 存储用量 → { usage, quota } | null */
export async function estimate() { try { const s = storage(); return s && s.estimate ? await within(s.estimate(), 5000, null) : null; } catch (e) { return null; } }
/** 申请「不要自动清理」→ boolean */
export async function persist() { try { const s = storage(); return s && s.persist ? !!(await within(s.persist(), 8000, false)) : false; } catch (e) { return false; } }
/** 是否已经持久保存 → boolean；浏览器一直不回答 → null（不知道） */
export async function persisted() {
  try { const s = storage(); if (!s || !s.persisted) return false; const v = await within(s.persisted(), 5000, null); return v == null ? null : !!v; } catch (e) { return false; }
}
// 有的 WebView 里 persisted() / estimate() 偶尔一直不回：最多等 ms，超时按 fallback
function within(p, ms, fallback) {
  let timer;
  const late = new Promise(r => { timer = setTimeout(() => r(fallback), ms); if (timer && timer.unref) timer.unref(); });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(timer));
}

// ---------- 模块级接口（浏览器里的 babble-audio；ctx.audio 就是这个模块） ----------
const db = idbStore();
export const putClip = (blob, opts) => db.putClip(blob, opts);
export const getClip = (sha) => db.getClip(sha);
export const hasClip = (sha) => db.hasClip(sha);
export const listClips = () => db.listClips();
export const markUploaded = (sha, uploaded = true) => db.markUploaded(sha, uploaded);
export const pendingUploads = () => db.pendingUploads();
export const putChunk = (recId, seq, blob) => db.putChunk(recId, seq, blob);
export const getChunks = (recId) => db.getChunks(recId);
export const clearChunks = (recId) => db.clearChunks(recId);
export const putRecMeta = (meta) => db.putRecMeta(meta);
export const getRecMeta = (recId) => db.getRecMeta(recId);
export const listRecMeta = () => db.listRecMeta();
export const clearRec = (recId) => db.clearRec(recId);
