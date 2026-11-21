// App 的数据中心（浏览器里用）：读写本机日志与快照、改数据、撤销、通知页面重画。
// load({ storage:null }) 可只用内存（Node 测试）；假的 storage 需实现标准 Storage 接口。
//
//   load()                       读入本机数据（启动时调一次）
//   getState()                   当前数据（只读；要改用 mutate）
//   mutate(fn, { undoLabel, cause, track })  fn(state) 直接改 state（必须是同步函数），返回 fn 的返回值。
//                                改过的记录会自动补盖修改时间、补齐字段；硬删除的记录自动改成软删除（不然同步会把它带回来）。
//                                墓碑（永久删除了的条目）本机改不了：整条覆盖、恢复、撤销、导入写上去的都不算，原样留着。
//                                从条目的 audio 拿掉的录音自动放进 removedAudio（「最近删除 → 移除的录音」，能放回去）；
//                                拿回 audio 的盖上 restoredAt。track: false 不记（录音页放弃还没上传的那段：录音本身随后就删）；
//                                录音页整条丢掉的（discarded）也不记。刚加的录音碰上时钟快的设备留下的记号，addedAt 挪到记号之后（store.js freshAdds）。
//                                改过的条目签上 updatedBy（谁、哪台设备），刚删除的再签 deletedBy（墓碑只签 updatedBy）。
//                                有改动才保存、editVersion +1、通知订阅者；给了 undoLabel 就能 undo()。
//                                cause：交给版本记录本的原因（不给就按改动猜 'edit' | 'delete' | 'restore'；恢复旧版本用 'revert'；
//                                'purge' 永久删除：什么都不记）
//   undo()                       撤销最近一次带 undoLabel 的修改（只改回那次改过的字段），返回它的 label（没有可撤销的 → null）。
//                                永久删除了的条目跳过（那条撤销记录在永久删除时就清掉了：还亮着的「撤销」点了什么都不做）
//   applyRemote(merged, info)    同步合并出的新数据：保存、通知，但不算本机修改（editVersion 不变）。返回有没有存进本机
//   saveOk()                     最近一次保存数据是否成功（存不下时本机存的比内存里旧，同步不能把云端版本号记下来）
//   mergeIn(other)               导入备份：逐条合并（较新的为准），算本机修改。返回 { changed: 条数 }
//   subscribe(fn)                fn(state, info)；info = { source: 'local'|'undo'|'remote'|'merge'|'storage', undoLabel?, label?, saved, ids,
//                                purged, unpurged }：purged = 这次变成墓碑的条目 id；unpurged = 本来是墓碑、这次合并回来的
//                                （别的设备同时改过 / 恢复了：那次永久删除作废）。都是数组，没有就空
//   getLocal() / setLocal(patch) 本机设置 babble.local（语言、主题、同步令牌…，不进数据、不进备份）；setLocal 不通知订阅者
//   editVersion()                本机修改计数（同步用：上传期间又改过，上传完仍算有改动）
//   setJournal(record, forget)   版本记录本（core/history.js 的 journal.record / journal.forget）：条目要被换掉之前（修改、删除、恢复、撤销、
//                                导入、同步合并），把旧的那一版交给 record([{ entryId, version, at, cause, replacedBy }])；
//                                条目变成墓碑（本机永久删除、别的设备来的、另一个标签页存进来的）→ 不记它的旧版本，forget([id…]) 连以前记的一起忘掉
//                                （按存好以后的数据定）。都只调用、不等；抛错或失败只打日志，保存照常（数据永远比记录本重要）
//   scrubText(ids)               永久删除了的条目：磁盘上还留着的旧原话（快照、待合并的日志、修复存档）换成墓碑（persistence.scrub）。
//                                改不动的修复存档记进 babble.local.archiveLeft。→ Promise<{ changed, left }>
//   setDefaultDevice(name) / deviceName() / author()   设备名（babble.local.device，没填用平台名）和签名 { who, device }
import { normalizeState, normalizeEntry, mergeStates, canon, stamp, deletedRecord, setSetting, trackRemoved, freshAdds, isTombstone } from './store.js';
import { isObj, own } from './util.js';
import { createPersistence, LocalDataError, PENDING_PREFIX } from './persistence.js';
export { PENDING_PREFIX };

export const KEY = 'babble.state', LKEY = 'babble.local';
// who：谁在用这台设备（'me' | 'nn' | null）；whoAsked：已经问过一次（答了或点了「以后再说」）
export const LOCAL_DEFAULTS = Object.freeze({ lang: null, theme: 'auto', device: null, who: null, whoAsked: false, sync: null, lastBackupAt: null, audioSync: {} });
const UNDO_MAX = 20;

let storage = null;
let persistence = createPersistence(null);
let memoryOnly = false;
let usesBrowserStorage = true, persistenceLocks;
let S = normalizeState(null);
let L = { ...LOCAL_DEFAULTS, audioSync: {} };
let version = 0;
let lastSaveOk = true;
let storageFault = null;
const subs = new Set();
const undoStack = [];
let journalFn = null, forgetFn = null;
let defaultDevice = 'Browser';

function defaultStorage() { try { return globalThis.localStorage || null; } catch (e) { return null; } }
function readJSON(k) { try { return JSON.parse((storage && storage.getItem(k)) || 'null'); } catch (e) { return null; } }
function readLocal() { const l = readJSON(LKEY); return { ...LOCAL_DEFAULTS, audioSync: {}, ...(isObj(l) ? l : {}) }; }

/** 读入本机数据。storage 不传就用 localStorage；只有显式传 null 的测试模式允许纯内存保存。 */
export function load({ storage: st, locks } = {}) {
  usesBrowserStorage = st === undefined;
  persistenceLocks = locks;
  storage = st !== undefined ? st : defaultStorage();
  memoryOnly = st === null;                   // 仅显式的 storage:null（Node 测试）允许把内存当成保存成功
  persistence = createPersistence(storage, { locks });
  try { S = persistence.read(); lastSaveOk = !!storage || memoryOnly; storageFault = !storage && !memoryOnly ? new Error('storage-unavailable') : null; }
  catch (e) { S = e instanceof LocalDataError ? e.state : normalizeState(null); lastSaveOk = false; storageFault = e; }
  L = readLocal();
  undoStack.length = 0;
  return S;
}
/** 别的标签页改了数据（storage 事件）：重新读入并通知 */
export function reload() {
  const before = S;
  const retrying = !lastSaveOk;
  try {
    if (usesBrowserStorage) {
      // 权限恢复后必须重新拿浏览器的存储对象；仍不可访问时继续保护，不能当成读到了一本空白记录。
      const next = defaultStorage();
      if (!next) throw new Error('storage-unavailable');
      if (next !== storage) { storage = next; persistence = createPersistence(storage, { locks: persistenceLocks }); }
    }
    S = mergeStates(S, persistence.read());
    L = readLocal();
    storageFault = null;
  }
  catch (e) { lastSaveOk = false; storageFault = e; if (e instanceof LocalDataError) S = mergeStates(S, e.state); }
  const changed = canon(before) !== canon(S);
  const saved = saveState();                 // 内存里上次没存下的修改也保留、重试，不用别的标签页覆盖它
  if (changed || retrying) { version++; markDirty(); } // 重试落盘时，磁盘上旧的同步配置也不能清掉「待上传」
  const pc = purgeChange(before, S);         // 别的标签页永久删除的：这里的撤销记录也清掉
  afterPurge(pc);
  emit({ source: 'storage', saved, changed: changed || retrying, ids: [], ...pc });
  return S;
}

export const getState = () => S;
export const getLocal = () => L;
export const editVersion = () => version;
export const saveOk = () => lastSaveOk;
export const storageIssue = () => storageFault ? { code: storageFault.code || 'unavailable', count: storageFault.issues?.length || 0 } : null;
export function recoveryExport() {
  if (!storage) return null;
  try { return storageFault ? persistence.evidence() : persistence.archive(); } catch (e) { return null; }
}
export function recoveryArchive() { try { return persistence.archive(); } catch (e) { return null; } }
export async function recoverFrom(other) {
  const next = await persistence.recover(mergeStates(S, normalizeState(other)));
  const pc = purgeChange(S, next);
  S = next; storageFault = null; lastSaveOk = true; version++;
  if (L.sync) { L.sync.sha = L.sync.etag = null; markDirty(); }
  afterPurge(pc);
  emit({ source: 'merge', saved: true, ids: Object.keys(S.data.entries), ...pc });
  return S;
}

/** 保存数据；存不下（空间满）返回 false */
export function saveState() {
  if (storageFault) return (lastSaveOk = false);
  if (!storage) return (lastSaveOk = memoryOnly);
  try { S = persistence.save(S); lastSaveOk = true; }
  catch (e) { lastSaveOk = false; if (e instanceof LocalDataError) storageFault = e; }
  return lastSaveOk;
}
export const idle = () => persistence.idle();
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
export function setJournal(fn, forget = null) { journalFn = typeof fn === 'function' ? fn : null; forgetFn = typeof forget === 'function' ? forget : null; }
export function setDefaultDevice(name) { defaultDevice = String(name || '').trim() || 'Browser'; }
/** 这台设备的名字：设置里填的，没填就是平台名（iPhone / iPad / Mac） */
export const deviceName = () => (typeof L.device === 'string' && L.device.trim()) || defaultDevice;
/** 签名：谁在用这台设备 + 设备名 */
export const author = () => ({ who: L.who === 'me' || L.who === 'nn' ? L.who : null, device: deviceName() });
const byOf = (e) => (e && isObj(e.updatedBy) ? { who: e.updatedBy.who ?? null, device: e.updatedBy.device || '' } : null);

/** 本机改过的条目签名：updatedBy.at = 这一版的 updatedAt；刚删除的签 deletedBy（已经是删除状态的保留原来的）；墓碑只签 updatedBy */
function sign(next, prev, by) {
  const r = { ...next, updatedBy: { ...by, at: next.updatedAt } };
  if (!r.deleted || r.purged) delete r.deletedBy;
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
/** 记录本：这几条连以前记的旧版本一起忘掉（变成墓碑了）。不等、不抛错 */
function forgetLater(ids) {
  if (!forgetFn || !ids.length) return;
  try {
    const p = forgetFn([...ids]);
    if (p && typeof p.catch === 'function') p.catch(e => console.warn('babble-history', e));
  } catch (e) { console.warn('babble-history', e); }
}
const entriesOf = s => (s && s.data && s.data.entries) || {};
/** 合并 / 导入后被换掉的条目（旧的那一版）。墓碑不记（没有内容），换成墓碑的也不记（要忘掉的） */
function replacedIn(before, after, cause, device = '') {
  const A = entriesOf(before), B = entriesOf(after), at = Date.now();
  const out = [];
  for (const id of Object.keys(A)) {
    const a = A[id], b = B[id];
    if (!b || isTombstone(a) || isTombstone(b) || canon(a) === canon(b)) continue;
    out.push({ entryId: id, version: a, at, cause, replacedBy: byOf(b) || (device ? { who: null, device } : null) });
  }
  return out;
}
/** 前后两份数据：这次变成墓碑的（purged）、本来是墓碑又合并回来的（unpurged：那次永久删除作废了） */
function purgeChange(before, after) {
  const A = entriesOf(before), B = entriesOf(after), purged = [], unpurged = [];
  for (const id of Object.keys(B)) if (isTombstone(B[id]) && !isTombstone(A[id])) purged.push(id);
  for (const id of Object.keys(A)) if (isTombstone(A[id]) && B[id] && !isTombstone(B[id])) unpurged.push(id);
  return { purged, unpurged };
}
/** 撤销记录里这几条清掉（永久删除了：撤销不回来）。记录本身留着、只是空了——还亮着的「撤销」提示点了什么都不做，不会撤到更早的那次 */
function dropUndo(ids) {
  if (!ids.length) return;
  const gone = new Set(ids);
  for (const u of undoStack) u.recs = u.recs.filter(r => !(r.c === 'entries' && gone.has(r.id)));
}
const afterPurge = ({ purged }) => { forgetLater(purged); dropUndo(purged); };
function emit(info) {
  for (const fn of [...subs]) { try { fn(S, info); } catch (e) { console.error(e); } }
}

function markDirty() { if (L.sync) { L.sync.dirty = true; saveLocal(); } }

// 比较改动前后：补盖修改时间，记下每条的旧版本和改了哪些字段（撤销用）。
// 新建的记录自带修改时间就照用（备忘录导入故意用很早的时间：别的设备上真正改过的、先导入的都比它新）
function diff(before, after, now, by, { track = true } = {}) {
  const recs = [], settings = [];
  const cols = new Set([...Object.keys(before.data || {}), ...Object.keys(after.data || {})]);
  for (const c of cols) {
    const A = (before.data && before.data[c]) || {};
    if (!isObj(after.data[c])) after.data[c] = {};
    const B = after.data[c];
    for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const a = A[id], b = B[id];
      if (canon(a) === canon(b)) continue;
      if (c === 'entries' && isTombstone(a)) { B[id] = a; continue; }      // 墓碑改不了（整条覆盖、恢复、撤销、导入、恢复旧版本都挡在这里）
      let next = b;
      if (b === undefined) next = a.deleted ? a : deletedRecord(a, now);        // 硬删除 → 软删除
      else if (a ? (b.updatedAt || 0) <= (a.updatedAt || 0) : !(Number(b.updatedAt) > 0)) next = stamp(b, a, now);
      if (c === 'entries') {
        // 拿掉的录音进 removedAudio、拿回来的盖 restoredAt（先于整理：整理会把 audio / removedAudio 里重复的去掉一份）
        if (a && !next.purged) next = freshAdds(a, trackRemoved(a, next, now, { removals: track && !next.discarded }), now);
        next = normalizeEntry(next, id);
      }
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
export function mutate(fn, { undoLabel = null, cause = null, track = true } = {}) {
  if (storageFault) throw storageFault;
  const before = structuredClone(S);
  let result;
  try { result = fn(S); } catch (e) { S = before; throw e; }
  const by = author(), now = Date.now();
  const d = diff(before, S, now, by, { track });
  if (!d.recs.length && !d.settings.length) {
    // 编辑页保存失败后再次点保存，内存已经是新值，也仍须重试落盘。
    if (!lastSaveOk) emit({ source: 'local', saved: saveState(), ids: [], purged: [], unpurged: [] });
    return result;
  }
  version++;
  const saved = saveState();
  markDirty();
  // 按存好的数据定：变成墓碑的（这次永久删除的，或者存的时候从磁盘合并进来、另一个标签页刚永久删除的）不记旧版本，连以前的一起忘掉
  const E = S.data.entries, { purged } = purgeChange(before, S);
  const forget = new Set([...purged, ...d.recs.filter(r => r.c === 'entries' && isTombstone(E[r.id])).map(r => r.id)]);
  if (cause !== 'purge') journal(() => d.recs.filter(r => r.c === 'entries' && r.prev && !isTombstone(r.prev) && !forget.has(r.id)).map(r => {
    const next = E[r.id];
    const why = cause || (next && next.deleted && !r.prev.deleted ? 'delete' : r.prev.deleted && next && !next.deleted ? 'restore' : 'edit');
    return { entryId: r.id, version: r.prev, at: now, cause: why, replacedBy: { who: by.who, device: by.device } };
  }));
  forgetLater([...forget]);
  dropUndo(purged);
  if (undoLabel) {
    undoStack.push({ label: undoLabel, recs: d.recs.filter(r => !(r.c === 'entries' && forget.has(r.id))), settings: d.settings });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  emit({ source: 'local', undoLabel, saved, ids: d.recs.map(r => r.id), purged, unpurged: [] });
  return result;
}

/** 最近一次可撤销的修改的 label（没有 → null） */
export const peekUndo = () => (undoStack.length ? undoStack[undoStack.length - 1].label : null);

/** 撤销：把那次改过的字段改回旧值（盖上新的修改时间，同步时会赢）；之后别的设备改的其它字段留着。撤销「新建」= 软删除 */
export function undo() {
  if (storageFault) return null;
  const u = undoStack.pop();
  if (!u) return null;
  const now = Date.now(), by = author(), before = { data: { entries: { ...S.data.entries } } };   // 只用来看存的时候合并进来的墓碑
  const ids = [], replaced = [];
  for (const { c, id, prev, keys } of u.recs) {
    if (!isObj(S.data[c])) S.data[c] = {};
    const cur = S.data[c][id];
    if (c === 'entries' && isTombstone(cur)) continue;                 // 永久删除了：撤销不回来
    let next;
    if (prev && cur && keys) {
      next = { ...cur };
      for (const k of keys) { if (prev[k] === undefined) delete next[k]; else next[k] = structuredClone(prev[k]); }
      next = stamp(next, cur, now);
    } else if (prev) next = stamp(structuredClone(prev), cur, now);
    else if (cur && !cur.deleted) next = deletedRecord(cur, now);
    else continue;
    if (c === 'entries') {
      // 撤销「接上一段录音」：那段进「移除的录音」；撤销「移除」：放回来的盖 restoredAt。被记号盖住的旧录音照样回不来（不挪 addedAt）
      next = sign(normalizeEntry(cur ? trackRemoved(cur, next, now) : next, id), cur, by);
      if (cur) replaced.push({ entryId: id, version: cur, at: now, cause: 'undo', replacedBy: { who: by.who, device: by.device } });
    }
    S.data[c][id] = next;
    ids.push(id);
  }
  if (!ids.length && !u.settings.length) return null;                  // 全是永久删除了的：什么都没撤
  for (const { k, had, prev } of u.settings) setSetting(S, k, had ? prev : undefined, now);
  version++;
  const saved = saveState();
  markDirty();
  const pc = purgeChange(before, S);                                   // 存的时候从磁盘合并进来的墓碑
  journal(() => replaced.filter(r => !isTombstone(S.data.entries[r.entryId])));
  afterPurge(pc);
  emit({ source: 'undo', label: u.label, saved, ids, ...pc });
  return u.label;
}

/** 同步合并出的新数据（已经包含本机的修改）：不算本机修改 */
export function applyRemote(merged, info = {}) {
  if (storageFault) return false;
  const old = S;
  S = normalizeState(merged);
  const saved = saveState();
  const pc = purgeChange(old, S);
  journal(() => replacedIn(old, S, 'sync', info.device || ''));
  afterPurge(pc);
  emit({ ...info, source: 'remote', saved, ids: [], ...pc });
  return saved;
}

/** 导入备份：逐条合并，较新的为准，不会删掉本机的条目 */
export function mergeIn(other) {
  if (storageFault) throw storageFault;
  const before = S;
  const next = mergeStates(S, normalizeState(other));
  const ids = Object.keys(next.data.entries).filter(id => canon(before.data.entries[id]) !== canon(next.data.entries[id]));
  const settingsChanged = canon(before.settings) !== canon(next.settings);
  if (!ids.length && !settingsChanged) return { changed: 0 };
  S = next;
  version++;
  const saved = saveState();
  markDirty();
  const pc = purgeChange(before, S);
  journal(() => replacedIn(before, next, 'import'));
  afterPurge(pc);
  emit({ source: 'merge', saved, ids, ...pc });
  return { changed: ids.length };
}

/** 永久删除了的条目：磁盘上的旧原话换成墓碑（见开头）。存储有问题时不碰磁盘 */
export async function scrubText(ids) {
  const list = [...new Set(Array.isArray(ids) ? ids : [])].filter(id => isTombstone(own(S.data.entries, id)));
  if (!list.length || storageFault || !storage) return { changed: 0, left: [] };
  const r = await persistence.scrub(list, () => S);
  const had = Array.isArray(L.archiveLeft) ? L.archiveLeft : [];
  const left = [...new Set([...had, ...r.left])].filter(k => { try { return storage.getItem(k) !== null; } catch (e) { return true; } });
  if (canon(left) !== canon(had)) setLocal({ archiveLeft: left.length ? left : null });
  return r;
}
