// 本机数据：每次改动先写一条独立日志，才算保存成功。各标签页不覆盖彼此的日志。
// babble.state 是兼容旧版的快照；只有持有 Web Lock 的整理任务能更新它，写成功后才删已合并的日志。
// 整理前被关掉、快照写不下或浏览器没有 Web Locks 都不丢数据：下次读取仍会合并日志。
// 永久删除以后 scrub 把磁盘上还留着的旧原话（快照、日志、修复存档）换成墓碑：只换墓碑盖得过的，读不懂的原件一个字不改（报出来让用户自己删）。
// scrub 也拿着整理用的那把锁改快照和日志；没有 Web Locks 时没人整理，它直接改（换进去的墓碑比原来的新，读出来合并的结果不变）。
import { canon, mergeStates, normalizeState, normalizeEntry } from './store.js';
import { isObj, own } from './util.js';

export const STATE_KEY = 'babble.state';
export const PENDING_PREFIX = 'babble.pending.';
export const STATE_LOCK = 'babble-state-write';
export const ARCHIVE_PREFIX = 'babble.recovery.';

export class LocalDataError extends Error {
  constructor(state, records, issues) {
    super('local-data-damaged');
    this.code = 'corrupt'; this.state = state; this.records = records; this.issues = issues;
  }
}
const validState = value => isObj(value) && (value.app === undefined || value.app === 'babble')
  && (value.v === undefined || value.v === 1) && (value.data === undefined || isObj(value.data))
  && (value.settings === undefined || isObj(value.settings)) && (value.settingsAt === undefined || isObj(value.settingsAt));
function decode(raw, key, issues, log = false) {
  try {
    const value = JSON.parse(raw);
    if (log ? !(isObj(value) && value.app === 'babble' && value.v === 1 && validState(value.patch)) : !validState(value)) throw new Error('shape');
    const state = log ? value.patch : value;
    if (Object.values(state.data || {}).some(collection => !isObj(collection) || Object.values(collection).some(record => !isObj(record)))) issues.push(key);
    return state;                             // 局部结构坏了时仍能整理出完好的条目，原始文件保留供恢复
  } catch (e) { issues.push(key); return null; }
}
function readable(value, key, issues) {
  try { return normalizeState(value); }
  catch (e) { issues.push(key); return normalizeState(null); } // 格式有效但字段无法整理，也保留整份原件供恢复
}

function snapshot(storage) {
  if (!storage) return { state: normalizeState(null), logs: [], records: [], issues: [] };
  // 整理任务可能在另一个标签页更新快照、删除日志。快照变过就重读，不能拿旧快照搭配删过的日志。
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = storage.getItem(STATE_KEY);
    const issues = [], records = raw === null ? [] : [{ key: STATE_KEY, raw }];
    let state = readable(raw === null ? null : decode(raw, STATE_KEY, issues), STATE_KEY, issues);
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(PENDING_PREFIX)) keys.push(key);
    }
    const logs = [];
    for (const key of keys) {
      const value = storage.getItem(key);
      if (value === null) continue;
      records.push({ key, raw: value });
      const valuePatch = decode(value, key, issues, true);
      if (!valuePatch) continue;
      const count = issues.length;
      const patch = readable(valuePatch, key, issues);
      if (issues.length !== count) continue;
      // 日志没改的设置沿用当前值；缺省键不能在时间戳同为 0 时参与「谁赢」的比较。
      patch.settings = { ...state.settings, ...valuePatch.settings };
      patch.settingsAt = { ...state.settingsAt };
      for (const key of Object.keys(valuePatch.settings || {})) patch.settingsAt[key] = valuePatch.settingsAt?.[key] || 0;
      state = mergeStates(state, patch);
      logs.push(key);
    }
    if (storage.getItem(STATE_KEY) === raw) return { state: normalizeState(state), logs, records, issues };
  }
  throw new Error('local-state-busy');
}

function checked(storage) {
  const result = snapshot(storage);
  if (result.issues.length) throw new LocalDataError(result.state, result.records, result.issues);
  return result;
}
export const readStoredState = storage => checked(storage).state;

/** 只记录还没落盘的条目和设置；不重复保存整本，录音和令牌也不在这里。 */
function changes(before, after) {
  const patch = { data: {}, settings: {}, settingsAt: {} };
  for (const [collection, records] of Object.entries(after.data)) {
    const changed = Object.fromEntries(Object.entries(records).filter(([id, value]) => canon(value) !== canon(before.data[collection]?.[id])));
    if (Object.keys(changed).length) patch.data[collection] = changed;
  }
  for (const key of Object.keys(after.settings)) {
    if (canon(after.settings[key]) === canon(before.settings[key]) && after.settingsAt[key] === before.settingsAt[key]) continue;
    patch.settings[key] = after.settings[key];
    if (after.settingsAt[key]) patch.settingsAt[key] = after.settingsAt[key];
  }
  return Object.keys(patch.data).length || Object.keys(patch.settings).length ? patch : null;
}

/**
 * 把 ids 这几条墓碑盖得过的旧记录换成墓碑（scrub 用；调用的人管锁）。
 *   盖得过 = 不是墓碑、updatedAt ≤ purgedFrom（让这次永久删除作废的、更新的那份不动）；本身是墓碑但带着字的（旧版 app 写进去的）只去掉字。
 *   babble.state、此刻读到的每份 babble.pending.*、每份 babble.recovery.*（整理出的 state，和 records 里能读懂的原件：快照或日志的样子）。
 * @returns {{ changed: number, left: string[] }}  left：改不干净的修复存档（读不懂的原件里还提到这一条，或者写不回去）
 */
function scrubKeys(storage, ids, state) {
  const out = { changed: 0, left: [] };
  const T = new Map();
  for (const id of ids) { const t = own(own(own(state, 'data'), 'entries'), id); if (isObj(t) && t.purged) T.set(id, t); }
  if (!storage || !T.size) return out;
  /** 一份 entries 里换掉盖得过的 → 换了几条 */
  const fix = (entries) => {
    let n = 0;
    if (!isObj(entries)) return 0;
    for (const [id, t] of T) {
      const rec = own(entries, id);
      if (!isObj(rec)) continue;
      let next = null;
      if (rec.purged) { const clean = normalizeEntry(rec, id); if (canon(clean) !== canon(rec)) next = clean; }
      else if ((Number(rec.updatedAt) || 0) <= t.purgedFrom) next = t;
      if (next) { entries[id] = next; n++; }
    }
    return n;
  };
  const dataOf = v => (isObj(v) && isObj(v.patch) ? v.patch.data : isObj(v) ? v.data : null);   // 日志 { patch: { data } }、快照 { data }
  const mentions = raw => [...T.keys()].some(id => raw.includes(id));          // 只用在读不懂的原件上（存档里的原件是转义过的字符串：只找 id 本身）
  const parse = raw => { try { const v = JSON.parse(raw); return isObj(v) ? v : null; } catch (e) { return null; } };
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && (key === STATE_KEY || key.startsWith(PENDING_PREFIX) || key.startsWith(ARCHIVE_PREFIX))) keys.push(key);
  }
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const archive = key.startsWith(ARCHIVE_PREFIX), v = parse(raw);
    let n = 0, stuck = false;
    if (!v) { if (archive && mentions(raw)) out.left.push(key); continue; }   // 读不懂（坏了的快照、日志由修复页面处理）：不改
    if (!archive) n = fix(own(dataOf(v), 'entries'));
    else {
      n = fix(own(own(v.state, 'data'), 'entries'));
      for (const r of Array.isArray(v.records) ? v.records : []) {
        if (!isObj(r) || typeof r.raw !== 'string') continue;
        const w = parse(r.raw), m = w ? fix(own(dataOf(w), 'entries')) : 0;
        if (m) { r.raw = JSON.stringify(w); n += m; }
        else if (!w && mentions(r.raw)) stuck = true;                         // 读不懂的原件一个字不改
      }
    }
    if (n) { try { storage.setItem(key, JSON.stringify(v)); out.changed += n; } catch (e) { stuck = true; } }
    if (archive && stuck) out.left.push(key);
  }
  return out;
}

export function createPersistence(storage, { locks = globalThis.navigator?.locks } = {}) {
  const writer = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  let seq = 0, job = null, again = false;

  function compact() {
    const { state, logs } = checked(storage);
    if (!logs.length) return;
    storage.setItem(STATE_KEY, JSON.stringify(state));
    // 只删这次确实读到的日志；别的标签页此刻新写的日志留给下一次。
    for (const key of logs) storage.removeItem(key);
  }
  function schedule() {
    if (!storage || !locks?.request) return;
    again = true;
    if (job) return;
    job = Promise.resolve().then(async () => {
      do {
        again = false;
        await locks.request(STATE_LOCK, compact);
      } while (again);
    }).catch(() => { /* 整理失败：已保存的日志原样保留，下次再试 */ }).finally(() => { job = null; });
  }

  return {
    read() { const result = readStoredState(storage); schedule(); return result; },
    save(state) {
      if (!storage) return state;
      const disk = readStoredState(storage);
      const merged = mergeStates(disk, state);
      const patch = changes(disk, merged);
      if (patch) storage.setItem(PENDING_PREFIX + writer + '.' + (++seq), JSON.stringify({ app: 'babble', v: 1, patch }));
      schedule();
      return merged;
    },
    evidence() {
      const { state, records, issues } = snapshot(storage);
      return { app: 'babble', v: 1, kind: 'local-recovery', exportedAt: new Date().toISOString(), state, records, issues };
    },
    archive() {
      if (!storage) return null;
      const keys = [];
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(ARCHIVE_PREFIX)) keys.push(key); }
      for (const key of keys.sort().reverse()) {
        try { const data = JSON.parse(storage.getItem(key)); if (data?.kind === 'local-recovery' && Array.isArray(data.records)) return data; } catch (e) { /* 保留损坏的旧存档，试下一份 */ }
      }
      return null;
    },
    async recover(state) {
      if (!storage || !locks?.request) throw new Error('recovery-unavailable');
      return locks.request(STATE_LOCK, () => {
        const { state: readable, records, issues } = snapshot(storage);
        const merged = mergeStates(readable, normalizeState(state));
        const archive = { app: 'babble', v: 1, kind: 'local-recovery', exportedAt: new Date().toISOString(), state: readable, records, issues };
        // 原始数据存档成功、并且新快照真正落盘后，才移走损坏的日志；任一步失败都留下原件。
        storage.setItem(ARCHIVE_PREFIX + Date.now() + '.' + writer + '.' + (++seq), JSON.stringify(archive));
        storage.setItem(STATE_KEY, JSON.stringify(merged));
        for (const { key } of records) if (key.startsWith(PENDING_PREFIX)) storage.removeItem(key);
        return readStoredState(storage);            // 整理期间新写入的日志也读回来
      });
    },
    async idle() { while (job) await job; },
    /**
     * 永久删除以后：磁盘上的旧原话换成墓碑（规则见 scrubKeys）。state 可以是函数（拿到锁的时候再取最新的）。
     * 有 Web Locks 就拿着整理用的那把锁做（不和整理、修复抢）；没有的话没人整理、快照只在锁里写、日志写好就不再变，直接改。
     * @returns {Promise<{ changed: number, left: string[] }>}
     */
    async scrub(ids, state) {
      const run = () => scrubKeys(storage, Array.isArray(ids) ? ids : [], typeof state === 'function' ? state() : state);
      if (!storage) return { changed: 0, left: [] };
      return locks?.request ? locks.request(STATE_LOCK, run) : run();
    },
  };
}
