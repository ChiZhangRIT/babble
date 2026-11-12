// App 的数据中心（浏览器里用）：读写 localStorage、改数据、撤销、通知页面重画。
// 没有 localStorage（Node 测试）也能用；load({ storage }) 可以传一个假的（有 getItem/setItem 就行）。
//
//   load()                       读入本机数据（启动时调一次）
//   getState()                   当前数据（只读；要改用 mutate）
//   mutate(fn, { undoLabel, cause })  fn(state) 直接改 state（必须是同步函数），返回 fn 的返回值。
//                                改过的记录会自动补盖修改时间、补齐字段；硬删除的记录自动改成软删除（不然同步会把它带回来）。
//                                改过的条目签上 updatedBy（谁、哪台设备），刚删除的再签 deletedBy。
//                                有改动才保存、editVersion +1、通知订阅者；给了 undoLabel 就能 undo()。
//                                cause：交给版本记录本的原因（不给就按改动猜 'edit' | 'delete' | 'restore'；恢复旧版本用 'revert'）
//   undo()                       撤销最近一次带 undoLabel 的修改（只改回那次改过的字段），返回它的 label（没有可撤销的 → null）
//   applyRemote(merged, info)    同步合并出的新数据：保存、通知，但不算本机修改（editVersion 不变）。返回有没有存进本机
//   saveOk()                     最近一次保存数据是否成功（存不下时本机存的比内存里旧，同步不能把云端版本号记下来）
//   mergeIn(other)               导入备份：逐条合并（较新的为准），算本机修改。返回 { changed: 条数 }
//   subscribe(fn)                fn(state, info)；info = { source: 'local'|'undo'|'remote'|'merge'|'storage', undoLabel?, label?, saved, ids }
//   getLocal() / setLocal(patch) 本机设置 babble.local（语言、主题、同步令牌…，不进数据、不进备份）；setLocal 不通知订阅者
//   editVersion()                本机修改计数（同步用：上传期间又改过，上传完仍算有改动）
//   setJournal(fn)               版本记录本（core/history.js 的 journal.record）：条目要被换掉之前（修改、删除、恢复、撤销、导入、
//                                同步合并），把旧的那一版交给 fn([{ entryId, version, at, cause, replacedBy }])。
//                                只调用、不等它；它抛错或失败只打日志，保存照常（数据永远比记录本重要）
//   setDefaultDevice(name) / deviceName() / author()   设备名（babble.local.device，没填用平台名）和签名 { who, device }
import { normalizeState, normalizeEntry, mergeStates, canon, stamp, deletedRecord, setSetting } from './store.js';
import { isObj } from './util.js';

export const KEY = 'babble.state', LKEY = 'babble.local';
// who：谁在用这台设备（'me' | 'nn' | null）；whoAsked：已经问过一次（答了或点了「以后再说」）
export const LOCAL_DEFAULTS = Object.freeze({ lang: null, theme: 'auto', device: null, who: null, whoAsked: false, sync: null, lastBackupAt: null, audioSync: {} });
const UNDO_MAX = 20;

let storage = null;
let S = normalizeState(null);
let L = { ...LOCAL_DEFAULTS, audioSync: {} };
let version = 0;
let lastSaveOk = true;
const subs = new Set();
const undoStack = [];
let journalFn = null;
let defaultDevice = 'Browser';

function defaultStorage() { try { return globalThis.localStorage || null; } catch (e) { return null; } }
function readJSON(k) { try { return JSON.parse((storage && storage.getItem(k)) || 'null'); } catch (e) { return null; } }
function readLocal() { const l = readJSON(LKEY); return { ...LOCAL_DEFAULTS, audioSync: {}, ...(isObj(l) ? l : {}) }; }

/** 读入本机数据。storage 不传就用 localStorage（没有也行，数据只在内存里） */
export function load({ storage: st } = {}) {
  storage = st !== undefined ? st : defaultStorage();
  S = normalizeState(readJSON(KEY));
  L = readLocal();
  undoStack.length = 0;
  return S;
}
/** 别的标签页改了数据（storage 事件）：重新读入并通知 */
export function reload() {
  S = normalizeState(readJSON(KEY));
  L = readLocal();
  emit({ source: 'storage', saved: true, ids: [] });
  return S;
}

export const getState = () => S;
export const getLocal = () => L;
export const editVersion = () => version;
export const saveOk = () => lastSaveOk;

/** 保存数据；存不下（空间满）返回 false */
export function saveState() {
  if (!storage) return (lastSaveOk = true);
  try { storage.setItem(KEY, JSON.stringify(S)); lastSaveOk = true; } catch (e) { lastSaveOk = false; }
  return lastSaveOk;
}
export function saveLocal() {
  if (!storage) return true;
  try { storage.setItem(LKEY, JSON.stringify(L)); return true; } catch (e) { return false; }   // 本机设置存不下也不影响使用
}
/** 改本机设置（浅合并）并保存，返回新的本机设置 */
export function setLocal(patch = {}) {
  Object.assign(L, patch);
  saveLocal();
  return L;
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---------- 签名和版本记录本 ----------
export function setJournal(fn) { journalFn = typeof fn === 'function' ? fn : null; }
export function setDefaultDevice(name) { defaultDevice = String(name || '').trim() || 'Browser'; }
/** 这台设备的名字：设置里填的，没填就是平台名（iPhone / iPad / Mac） */
export const deviceName = () => (typeof L.device === 'string' && L.device.trim()) || defaultDevice;
/** 签名：谁在用这台设备 + 设备名 */
export const author = () => ({ who: L.who === 'me' || L.who === 'nn' ? L.who : null, device: deviceName() });
const byOf = (e) => (e && isObj(e.updatedBy) ? { who: e.updatedBy.who ?? null, device: e.updatedBy.device || '' } : null);

/** 本机改过的条目签名：updatedBy.at = 这一版的 updatedAt；刚删除的签 deletedBy（已经是删除状态的保留原来的） */
function sign(next, prev, by) {
  const r = { ...next, updatedBy: { ...by, at: next.updatedAt } };
  if (!r.deleted) delete r.deletedBy;
  else if (!(prev && prev.deleted)) r.deletedBy = { ...by, at: r.deletedAt };
  return r;
}
/** 交给记录本：make() 算出要记的旧版本（没设记录本就不算）。不等、不抛错 */
function journal(make) {
  if (!journalFn) return;
  try {
    const items = make();
    if (!items || !items.length) return;
    const p = journalFn(items);
    if (p && typeof p.catch === 'function') p.catch(e => console.warn('babble-history', e));
  } catch (e) { console.warn('babble-history', e); }
}
/** 合并 / 导入后被换掉的条目（旧的那一版） */
function replacedIn(before, after, cause, device = '') {
  const A = (before && before.data && before.data.entries) || {}, B = (after && after.data && after.data.entries) || {}, at = Date.now();
  const out = [];
  for (const id of Object.keys(A)) {
    const a = A[id], b = B[id];
    if (!b || canon(a) === canon(b)) continue;
    out.push({ entryId: id, version: a, at, cause, replacedBy: byOf(b) || (device ? { who: null, device } : null) });
  }
  return out;
}
function emit(info) {
  for (const fn of [...subs]) { try { fn(S, info); } catch (e) { console.error(e); } }
}

function markDirty() { if (L.sync) { L.sync.dirty = true; saveLocal(); } }

// 比较改动前后：补盖修改时间，记下每条的旧版本和改了哪些字段（撤销用）。
// 新建的记录自带修改时间就照用（备忘录导入故意用很早的时间：别的设备上真正改过的、先导入的都比它新）
function diff(before, after, now, by) {
  const recs = [], settings = [];
  const cols = new Set([...Object.keys(before.data || {}), ...Object.keys(after.data || {})]);
  for (const c of cols) {
    const A = (before.data && before.data[c]) || {};
    if (!isObj(after.data[c])) after.data[c] = {};
    const B = after.data[c];
    for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const a = A[id], b = B[id];
      if (canon(a) === canon(b)) continue;
      let next = b;
      if (b === undefined) next = a.deleted ? a : deletedRecord(a, now);        // 硬删除 → 软删除
      else if (a ? (b.updatedAt || 0) <= (a.updatedAt || 0) : !(Number(b.updatedAt) > 0)) next = stamp(b, a, now);
      if (c === 'entries') next = normalizeEntry(next, id);
      B[id] = next;
      if (canon(a) === canon(next)) continue;
      if (c === 'entries' && by) B[id] = next = sign(next, a, by);
      // 撤销只改回这些字段（修改时间和签名不算：撤销本身会重新盖）
      const keys = a ? [...new Set([...Object.keys(a), ...Object.keys(next)])].filter(k => k !== 'updatedAt' && k !== 'updatedBy' && canon(a[k]) !== canon(next[k])) : null;
      recs.push({ c, id, prev: a === undefined ? null : a, keys });
    }
  }
  for (const k of new Set([...Object.keys(before.settings || {}), ...Object.keys(after.settings || {})])) {
    if (canon(before.settings[k]) === canon(after.settings[k])) continue;
    const prevAt = (before.settingsAt && before.settingsAt[k]) || 0;
    if (((after.settingsAt && after.settingsAt[k]) || 0) <= prevAt) after.settingsAt[k] = Math.max(now, prevAt + 1);
    settings.push({ k, had: Object.prototype.hasOwnProperty.call(before.settings, k), prev: before.settings[k] });
  }
  return { recs, settings };
}

/**
 * 改数据。fn(state) 直接改 state.data.entries[id] / state.settings[key]（同步函数）。
 * @returns fn 的返回值
 */
export function mutate(fn, { undoLabel = null, cause = null } = {}) {
  const before = structuredClone(S);
  let result;
  try { result = fn(S); } catch (e) { S = before; throw e; }
  const by = author(), now = Date.now();
  const d = diff(before, S, now, by);
  if (!d.recs.length && !d.settings.length) return result;
  version++;
  const saved = saveState();
  markDirty();
  journal(() => d.recs.filter(r => r.c === 'entries' && r.prev).map(r => {
    const next = S.data.entries[r.id];
    const why = cause || (next && next.deleted && !r.prev.deleted ? 'delete' : r.prev.deleted && next && !next.deleted ? 'restore' : 'edit');
    return { entryId: r.id, version: r.prev, at: now, cause: why, replacedBy: { who: by.who, device: by.device } };
  }));
  if (undoLabel) {
    undoStack.push({ label: undoLabel, recs: d.recs, settings: d.settings });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  emit({ source: 'local', undoLabel, saved, ids: d.recs.map(r => r.id) });
  return result;
}

/** 最近一次可撤销的修改的 label（没有 → null） */
export const peekUndo = () => (undoStack.length ? undoStack[undoStack.length - 1].label : null);

/** 撤销：把那次改过的字段改回旧值（盖上新的修改时间，同步时会赢）；之后别的设备改的其它字段留着。撤销「新建」= 软删除 */
export function undo() {
  const u = undoStack.pop();
  if (!u) return null;
  const now = Date.now(), by = author();
  const ids = [], replaced = [];
  for (const { c, id, prev, keys } of u.recs) {
    if (!isObj(S.data[c])) S.data[c] = {};
    const cur = S.data[c][id];
    let next;
    if (prev && cur && keys) {
      next = { ...cur };
      for (const k of keys) { if (prev[k] === undefined) delete next[k]; else next[k] = structuredClone(prev[k]); }
      next = stamp(next, cur, now);
    } else if (prev) next = stamp(structuredClone(prev), cur, now);
    else if (cur && !cur.deleted) next = deletedRecord(cur, now);
    else continue;
    if (c === 'entries') {
      next = sign(next, cur, by);
      if (cur) replaced.push({ entryId: id, version: cur, at: now, cause: 'undo', replacedBy: { who: by.who, device: by.device } });
    }
    S.data[c][id] = next;
    ids.push(id);
  }
  for (const { k, had, prev } of u.settings) setSetting(S, k, had ? prev : undefined, now);
  version++;
  const saved = saveState();
  markDirty();
  journal(() => replaced);
  emit({ source: 'undo', label: u.label, saved, ids });
  return u.label;
}

/** 同步合并出的新数据（已经包含本机的修改）：不算本机修改 */
export function applyRemote(merged, info = {}) {
  const old = S;
  S = normalizeState(merged);
  const saved = saveState();
  journal(() => replacedIn(old, S, 'sync', info.device || ''));
  emit({ ...info, source: 'remote', saved, ids: [] });
  return saved;
}

/** 导入备份：逐条合并，较新的为准，不会删掉本机的条目 */
export function mergeIn(other) {
  const before = S;
  const next = mergeStates(S, normalizeState(other));
  const ids = Object.keys(next.data.entries).filter(id => canon(before.data.entries[id]) !== canon(next.data.entries[id]));
  const settingsChanged = canon(before.settings) !== canon(next.settings);
  if (!ids.length && !settingsChanged) return { changed: 0 };
  S = next;
  version++;
  const saved = saveState();
  markDirty();
  journal(() => replacedIn(before, next, 'import'));
  emit({ source: 'merge', saved, ids });
  return { changed: ids.length };
}
