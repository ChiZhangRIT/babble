// 修改记录（不碰 DOM，Node 里也能测）：
//   1. 本机的版本记录本：条目要被换掉之前（本机修改、删除、恢复、撤销、导入备份、同步合并），把旧的那一版存进
//      IndexedDB babble-history（单独一个库，不动录音库；只在这台设备上，不同步）。和上一份一模一样就不存；每条最多留 100 版。
//      记录本只排队、不等写完，出错只打日志——绝不影响保存数据（见 state.js 的 setJournal）。
//   2. 云端历史：按需从 GitHub 上 babble.json 的提交记录里，一个版本一个版本地找这一条以前的样子（sync.js 的 commits / fileAt）。
//   3. 比较两版：改了哪些（原话 / 背景 / 录音 / 收藏 / 状态 / 日期 / 草稿 / 删除），原话按行比较。
// 记录本里的一项：{ id, entryId, at（被换掉的时刻）, version（那一版的条目 JSON）, cause, replacedBy（换掉它的人 { who, device }） }
// cause：'edit' 修改 | 'delete' 删除 | 'restore' 从最近删除恢复 | 'undo' 撤销 | 'import' 导入备份 | 'sync' 同步合并 | 'revert' 恢复旧版本
import { canon, normalizeEntry } from './store.js';
import { isObj, own } from './util.js';

export const HISTORY_DB = 'babble-history';
export const HISTORY_DB_VERSION = 1;
export const HISTORY_CAP = 100;
const STORE = 'versions';

/** 平台默认的设备名：iPhone / iPad / Mac / Browser（设置里可以改成「小明的 iPhone」之类） */
export function platformDevice(nav = globalThis.navigator) {
  const ua = String((nav && nav.userAgent) || ''), pf = String((nav && nav.platform) || '');
  if (/iPad/.test(ua) || (pf === 'MacIntel' && nav && nav.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Mac/.test(pf)) return 'Mac';
  return 'Browser';
}

/** 这一版是谁改的：updatedBy.at 和 updatedAt 对得上才算（老版本 App 改过的条目会留着上一个人的签名，那就不显示） */
export function versionBy(e) {
  const b = e && isObj(e.updatedBy) ? e.updatedBy : null;
  return b && (b.at == null || b.at === e.updatedAt) ? b : null;
}
/** 谁删的：同样要和 deletedAt 对得上 */
export function deletionBy(e) {
  const b = e && e.deleted && isObj(e.deletedBy) ? e.deletedBy : null;
  return b && (b.at == null || b.at === e.deletedAt) ? b : null;
}

// ======================================================================
// 本机版本记录本
// ======================================================================
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * @param {{ append(rec, {cap, same}): Promise<boolean>, list(entryId): Promise<object[]> }} backend
 * @param {{ cap?: number, log?: (e) => void }} [o]
 * @returns {{ record(items): Promise<void>, list(entryId): Promise<object[]>, idle(): Promise<void> }}
 *   record([{ entryId, version, cause, replacedBy, at }])：当场复制一份（之后数据再变也不影响），排队写入，马上返回；从不抛错
 *   list(entryId)：这一条的旧版本，新的在前
 */
export function createJournal(backend, { cap = HISTORY_CAP, log = (e) => console.warn('babble-history', e) } = {}) {
  let chain = Promise.resolve();
  function record(items) {
    let recs = [];
    try {
      recs = (Array.isArray(items) ? items : [items]).filter(x => x && x.entryId && isObj(x.version)).map(x => ({
        entryId: String(x.entryId), at: Number(x.at) || Date.now(), version: plain(x.version),
        cause: typeof x.cause === 'string' ? x.cause : 'edit', replacedBy: isObj(x.replacedBy) ? plain(x.replacedBy) : null,
      }));
    } catch (e) { log(e); return chain; }
    if (!recs.length) return chain;
    chain = chain.then(async () => {
      for (const r of recs) {
        try {
          const key = canon(r.version);
          await backend.append(r, { cap, same: (last) => !!last && canon(last.version) === key });
        } catch (e) { log(e); }
      }
    });
    return chain;
  }
  return { record, list: (entryId) => backend.list(String(entryId)), idle: () => chain };
}

/** 内存版（测试用；IndexedDB 打不开时也能凑合） */
export function memoryBackend() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async append(rec, { cap = HISTORY_CAP, same = () => false } = {}) {
      const mine = rows.filter(r => r.entryId === rec.entryId);
      if (mine.length && same(mine[mine.length - 1])) return false;
      rows.push({ ...rec, id: ++seq });
      for (const old of mine.slice(0, Math.max(0, mine.length + 1 - cap))) rows.splice(rows.indexOf(old), 1);
      return true;
    },
    async list(entryId) { return rows.filter(r => r.entryId === entryId).sort((a, b) => b.id - a.id).map(r => plain(r)); },
  };
}

/** IndexedDB 版：库 babble-history，表 versions（自增 id，entryId 上有索引）。import 时不碰 indexedDB */
export function idbBackend(getIDB = () => globalThis.indexedDB) {
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const idb = getIDB();
      if (!idb) { reject(new Error('no-indexeddb')); return; }
      let req;
      try { req = idb.open(HISTORY_DB, HISTORY_DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        if (ev.oldVersion < 1 && !db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }).createIndex('entryId', 'entryId');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      req.onerror = () => { opening = null; reject(req.error || new Error('idb-open')); };
    });
    return opening;
  }
  /** 一个事务：fn(store, done) 发请求；事务 complete 才算数。iOS 断开过连接（InvalidStateError）就重开一次 */
  async function run(mode, fn) {
    for (let attempt = 0; ; attempt++) {
      const db = await open();
      let tx;
      try { tx = db.transaction(STORE, mode); }
      catch (e) {
        if (attempt === 0 && e && e.name === 'InvalidStateError') { opening = null; try { db.close(); } catch (_) { /* 已断开 */ } continue; }
        throw e;
      }
      return new Promise((resolve, reject) => {
        let out;
        tx.oncomplete = () => resolve(out);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('idb-abort'));
        try { fn(tx.objectStore(STORE), (v) => { out = v; }); } catch (e) { try { tx.abort(); } catch (_) { /* 已结束 */ } reject(e); }
      });
    }
  }
  const only = (id) => globalThis.IDBKeyRange.only(id);
  return {
    // 同一个事务里：看最后一份 → 一样就不存 → 存 → 数一数 → 超过上限删最旧的
    append: (rec, { cap = HISTORY_CAP, same = () => false } = {}) => run('readwrite', (store, done) => {
      const idx = store.index('entryId');
      idx.openCursor(only(rec.entryId), 'prev').onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && same(cur.value)) { done(false); return; }
        store.add(rec);
        done(true);
        idx.count(only(rec.entryId)).onsuccess = (ev) => {
          let extra = ev.target.result - cap;
          if (extra <= 0) return;
          idx.openCursor(only(rec.entryId), 'next').onsuccess = (ev2) => {
            const c = ev2.target.result;
            if (c && extra-- > 0) { c.delete(); c.continue(); }
          };
        };
      };
    }),
    list: (entryId) => run('readonly', (store, done) => {
      store.index('entryId').getAll(only(entryId)).onsuccess = (e) => done((e.target.result || []).sort((a, b) => b.id - a.id));
    }),
  };
}

/** App 用的记录本（浏览器里的 IndexedDB）。第一次写的时候才打开数据库 */
export const journal = createJournal(idbBackend());

// ======================================================================
// 比较两版
// ======================================================================
// 录音列表的比较连名字一起（改名也算改了录音）
const shas = (e) => ((e && e.audio) || []).map(a => a && a.sha256 + (a.name ? '|' + a.name : '')).join(',');
const draftText = (e) => (e && e.draft && typeof e.draft.text === 'string' ? e.draft.text : '');

/** older → newer 改了哪些：'deleted' | 'restored' | 'text' | 'note' | 'audio' | 'fav' | 'status' | 'date' | 'draft'（条目没有标题：旧数据里的 title 不比） */
export function changedFields(older, newer) {
  if (!older || !newer) return [];
  const out = [];
  const diff = (k) => (older[k] ?? '') !== (newer[k] ?? '');
  if (!!older.deleted !== !!newer.deleted) out.push(newer.deleted ? 'deleted' : 'restored');
  if (diff('text')) out.push('text');
  if (diff('note')) out.push('note');
  if (shas(older) !== shas(newer)) out.push('audio');
  if (!!older.fav !== !!newer.fav) out.push('fav');
  if ((older.status || 'done') !== (newer.status || 'done')) out.push('status');
  if (older.date !== newer.date || (older.time || null) !== (newer.time || null)) out.push('date');
  if (draftText(older) !== draftText(newer)) out.push('draft');
  return out;
}

const lines = (s) => (typeof s === 'string' && s.length ? s.replace(/\r\n?/g, '\n').split('\n') : []);

/**
 * 按行比较 → [{ t: 'same' | 'del' | 'add', line }]（最长公共子序列；太长时中间那段整段算删掉再加上）
 */
export function lineDiff(a, b, { maxCells = 250000 } = {}) {
  const A = lines(a), B = lines(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const x = A.slice(p, A.length - q), y = B.slice(p, B.length - q);
  const mid = [];
  if (x.length * y.length > maxCells) {
    for (const line of x) mid.push({ t: 'del', line });
    for (const line of y) mid.push({ t: 'add', line });
  } else {
    // L[i][j] = x[i..] 和 y[j..] 的最长公共子序列长度
    const W = y.length + 1, L = new Uint32Array((x.length + 1) * W);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      L[i * W + j] = x[i] === y[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { mid.push({ t: 'same', line: x[i] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) mid.push({ t: 'del', line: x[i++] });
      else mid.push({ t: 'add', line: y[j++] });
    }
    while (i < x.length) mid.push({ t: 'del', line: x[i++] });
    while (j < y.length) mid.push({ t: 'add', line: y[j++] });
  }
  return [...A.slice(0, p).map(line => ({ t: 'same', line })), ...mid, ...A.slice(A.length - q).map(line => ({ t: 'same', line }))];
}

/** 只留改动和前后 context 行，其余连续没变的行收成 { t: 'skip', n } */
export function compactDiff(ops, context = 1) {
  const keep = ops.map(() => false);
  ops.forEach((o, i) => { if (o.t !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true; });
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) { out.push(ops[i]); continue; }
    const last = out[out.length - 1];
    if (last && last.t === 'skip') last.n++; else out.push({ t: 'skip', n: 1 });
  }
  return out;
}

// ======================================================================
// 版本列表：当前 + 本机记录 + 云端
// ======================================================================
/** 比较内容用的键：不看修改时间和签名（同样的内容只列一次） */
export function contentKey(e) {
  const { updatedAt, updatedBy, ...rest } = normalizeEntry(e, e.id);
  return canon(rest);
}

/**
 * @param {object|null} current                       现在的条目
 * @param {Array<{version, at, cause, replacedBy}>} local   本机记录本（新的在前）
 * @param {Array<{version, commit: {sha, at, device}}>} cloud  云端找到的（从新到旧）
 * @returns {Array<{ v, key, current: boolean, local: object|null, cloud: object|null }>}
 *   同样内容只留一份（当前版本优先，其次本机记录里较新的那份）；cloud 记的是这份内容出现过的最早的提交。
 *   当前版本排第一，其余按那一版的修改时间新的在前
 */
export function buildVersions(current, local = [], cloud = []) {
  const map = new Map();
  const add = (v, extra) => {
    if (!isObj(v) || !v.id) return;
    const n = normalizeEntry(v, v.id), key = contentKey(n);
    const have = map.get(key);
    if (!have) { map.set(key, { v: n, key, current: !!extra.current, local: extra.local || null, cloud: extra.cloud || null }); return; }
    if (extra.local && !have.local) have.local = extra.local;
    if (extra.cloud) have.cloud = extra.cloud;        // 越往后越旧：留最早出现的那次提交
  };
  if (current) add(current, { current: true });
  for (const r of local || []) if (r) add(r.version, { local: r });
  for (const c of cloud || []) if (c) add(c.version, { cloud: c.commit || null });
  return [...map.values()].sort((a, b) => (Number(b.current) - Number(a.current)) || ((b.v.updatedAt || 0) - (a.v.updatedAt || 0))
    || (((b.local && b.local.at) || 0) - ((a.local && a.local.at) || 0)));
}

// ======================================================================
// 云端历史
// ======================================================================
/**
 * 从 GitHub 上 babble.json 的提交记录里找某一条以前的版本（按需，一个提交一个提交地取）。
 * @param {{ commits({page, perPage}): Promise<Array<{sha, at, message}>>, fileAt(sha): Promise<object|null> }} api   sync.js 给的
 * @returns {{ session(entryId): { run({ batch, onProgress }): Promise<{found, more, checked, stopped}>, stop(), readonly checked: number }, files: Map }}
 *   run 每次最多看 batch 个提交（接着上次停下的地方往更早找），中途可以 stop()；出错（SyncError）照样抛，下次 run 从出错的那个提交重来。
 *   看过的提交按 sha 缓存（只缓存问过的条目，不留整份文件）：同一次打开 App 里再看不用重新下载。
 *   某个版本里还没有这一条 → 更早的也不会有，到头了（more: false）。
 */
export function createCloudHistory(api, { perPage = 30 } = {}) {
  const files = new Map();       // 提交 sha → { device, savedAt, ok, entries: Map(entryId → 条目 | null) }
  async function versionAt(c, entryId) {
    let f = files.get(c.sha);
    if (f && (!f.ok || f.entries.has(entryId))) return f;
    const d = await api.fileAt(c.sha);
    if (!f) { f = { device: (d && typeof d.device === 'string' && d.device) || '', savedAt: (d && d.savedAt) || null, ok: !!d, entries: new Map() }; files.set(c.sha, f); }
    if (d) {
      const entries = d.state && isObj(d.state.data) && isObj(d.state.data.entries) ? d.state.data.entries : {};
      const rec = own(entries, entryId);
      f.entries.set(entryId, isObj(rec) ? normalizeEntry(rec, entryId) : null);
    }
    return f;
  }
  function session(entryId) {
    const commits = [];
    let page = 0, idx = 0, morePages = true, reachedStart = false, stopFlag = false;
    async function nextCommit() {
      while (idx >= commits.length && morePages) {
        const list = await api.commits({ page: page + 1, perPage });
        page++;
        if (!Array.isArray(list) || list.length < perPage) morePages = false;
        for (const c of list || []) if (c && c.sha && !commits.some(x => x.sha === c.sha)) commits.push(c);
      }
      return idx < commits.length ? commits[idx] : null;
    }
    async function run({ batch = perPage, onProgress = null } = {}) {
      stopFlag = false;
      const found = [];
      let n = 0;
      while (!stopFlag && !reachedStart && n < batch) {
        const c = await nextCommit();
        if (!c) { reachedStart = true; break; }
        if (onProgress) { try { onProgress({ checked: idx + 1, commit: c }); } catch (e) { /* 界面出错不影响 */ } }
        const f = await versionAt(c, entryId);
        idx++; n++;
        if (!f.ok) continue;                              // 那次提交里文件被删了 / 看不懂：跳过
        const v = f.entries.get(entryId);
        if (!v) { reachedStart = true; break; }           // 那时还没有这一条
        found.push({ version: v, commit: { sha: c.sha, at: c.at || f.savedAt || null, device: f.device } });
      }
      return { found, more: !reachedStart, checked: idx, stopped: stopFlag && !reachedStart };
    }
    return { run, stop: () => { stopFlag = true; }, get checked() { return idx; }, get more() { return !reachedStart; } };
  }
  return { session, files };
}
