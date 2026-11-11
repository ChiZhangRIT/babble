// 数据层：state.data.entries 是「id → 条目」。每条有 updatedAt（毫秒），删除只打 deleted 标记、内容保留（能在「最近删除」里恢复）。
// 多台设备合并时逐条比较 updatedAt 取较新的一份；时间相同内容不同时按内容排序取一份，保证每台设备结果一样。
// 设置按键合并，各键有自己的修改时间（settingsAt）。不认识的字段、集合原样保留，旧版 app 同步时不会弄丢新版的数据。
import { isObj, str, own, safeKey } from './util.js';
import { isTime, today } from './dates.js';

export const COLLECTIONS = ['entries'];
export const TIME_SOURCES = ['recorder', 'mp4', 'note', 'file', 'manual'];
export const SOURCE_KINDS = ['app', 'audio-import', 'apple-notes', 'recovered'];

// 默认表情：👰🏻‍♀️（NN）和 🥷🏻（我）。写成转义，免得编辑器把零宽连接符弄丢
export const NN_EMOJI = '\u{1F470}\u{1F3FB}\u200D\u2640\uFE0F';
export const ME_EMOJI = '\u{1F977}\u{1F3FB}';
export const DEFAULT_SETTINGS = Object.freeze({
  speakers: { nn: { name: 'NN', emoji: NN_EMOJI, aliases: [] }, me: { name: '', emoji: ME_EMOJI, aliases: [] } },
  nightStart: '21:00', nightEnd: '07:00', nightOpensRecorder: true, nightForcesDark: true,
  maxRecordMin: 10,
});
const clone = v => JSON.parse(JSON.stringify(v));

const collectionsOf = (...states) => [...new Set([...COLLECTIONS, ...states.flatMap(s => Object.keys((s && isObj(s.data) && s.data) || {}))])].filter(safeKey);

export function blankState() {
  return { app: 'babble', v: 1, data: Object.fromEntries(COLLECTIONS.map(c => [c, {}])), settings: clone(DEFAULT_SETTINGS), settingsAt: {} };
}

/** 和键的顺序无关的序列化：判断两份数据是否一样，以及打平时决定取哪一份 */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// ---------- 整理一条记录：修得好的修好，用户写的文字一个字都不改 ----------
const SHA = /^[0-9a-fA-F]{64}$/;
const numOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

function normAudio(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(a => isObj(a) && SHA.test(a.sha256)).map(a => ({
    ...a, sha256: a.sha256.toLowerCase(), mime: str(a.mime) || 'audio/mp4', bytes: numOrNull(a.bytes), durationSec: numOrNull(a.durationSec),
    origName: str(a.origName), addedAt: Number(a.addedAt) || 0,
  })).filter(a => !seen.has(a.sha256) && seen.add(a.sha256));
}

/** 条目的字段检查。日期格式坏了也不丢整条：原值留在 badDate 里，日期先用创建那天，等用户改 */
export function normalizeEntry(rec, id = rec && rec.id) {
  const updatedAt = Number(rec.updatedAt) || 0;
  const r = { ...rec, id, updatedAt, createdAt: Number(rec.createdAt) || updatedAt };
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    if (r.date != null && r.date !== '' && r.badDate === undefined) r.badDate = str(r.date);
    r.date = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '1970-01-01';
  }
  r.time = isTime(r.time) ? r.time : null;
  r.recordedAt = typeof r.recordedAt === 'string' && r.recordedAt ? r.recordedAt : null;
  r.tz = typeof r.tz === 'string' && r.tz ? r.tz : null;
  r.timeSource = TIME_SOURCES.includes(r.timeSource) ? r.timeSource : null;
  r.status = r.status === 'inbox' ? 'inbox' : 'done';
  r.title = str(r.title);
  r.text = str(r.text);
  r.note = str(r.note);
  r.draft = isObj(r.draft) ? { ...r.draft, text: str(r.draft.text), source: str(r.draft.source) } : null;
  r.fav = r.fav === true;
  r.audio = normAudio(r.audio);
  r.source = isObj(r.source) && typeof r.source.kind === 'string' ? r.source : { ...(isObj(r.source) ? r.source : {}), kind: 'app' };
  if (r.deleted) { r.deleted = true; r.deletedAt = Number(r.deletedAt) || updatedAt; }
  else { delete r.deleted; delete r.deletedAt; }
  return r;
}

function normSpeaker(v, def) {
  const o = isObj(v) ? v : {};
  return { ...o, name: typeof o.name === 'string' ? o.name : def.name, emoji: typeof o.emoji === 'string' && o.emoji.trim() ? o.emoji : def.emoji,
    aliases: (Array.isArray(o.aliases) ? o.aliases : []).filter(x => typeof x === 'string' && x.trim()) };
}
/** 设置补齐默认值；不认识的键原样保留 */
function normSettings(src) {
  const s = {};
  if (isObj(src)) for (const [k, v] of Object.entries(src)) if (safeKey(k)) s[k] = v;
  const D = DEFAULT_SETTINGS;
  const sp = isObj(s.speakers) ? s.speakers : {};
  s.speakers = { ...Object.fromEntries(Object.entries(sp).filter(([k, v]) => safeKey(k) && isObj(v))), nn: normSpeaker(sp.nn, D.speakers.nn), me: normSpeaker(sp.me, D.speakers.me) };
  for (const k of ['nightStart', 'nightEnd']) if (!isTime(s[k])) s[k] = D[k];
  for (const k of ['nightOpensRecorder', 'nightForcesDark']) if (typeof s[k] !== 'boolean') s[k] = D[k];
  if (!(typeof s.maxRecordMin === 'number' && s.maxRecordMin >= 1 && s.maxRecordMin <= 180)) s.maxRecordMin = D.maxRecordMin;
  return s;
}

/** 读入本地、云端或备份里的数据时的整理：丢掉不是对象的记录和危险的键，补齐默认值 */
export function normalizeState(s) {
  const out = blankState();
  if (!isObj(s)) return out;
  const data = isObj(s.data) ? s.data : {};
  for (const c of collectionsOf(s)) {
    const src = own(data, c);
    if (src !== undefined && !isObj(src)) continue;
    out.data[c] = out.data[c] || {};
    for (const [id, rec] of Object.entries(src || {})) {
      if (!isObj(rec) || !safeKey(id)) continue;
      out.data[c][id] = c === 'entries' ? normalizeEntry(rec, id) : { ...rec, id, updatedAt: Number(rec.updatedAt) || 0 };
    }
  }
  out.settings = normSettings(s.settings);
  if (isObj(s.settingsAt)) for (const [k, t] of Object.entries(s.settingsAt)) if (safeKey(k) && Number(t) > 0) out.settingsAt[k] = Number(t);
  return out;
}

function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  if ((b.updatedAt || 0) !== (a.updatedAt || 0)) return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
  return canon(b) > canon(a) ? b : a;
}

/** 两份数据逐条合并（顺序无关：merge(a,b) 和 merge(b,a) 结果一样） */
export function mergeStates(a, b) {
  const out = blankState();
  const da = (a && isObj(a.data) && a.data) || {}, db = (b && isObj(b.data) && b.data) || {};
  for (const c of collectionsOf(a, b)) {
    out.data[c] = out.data[c] || {};
    const ids = new Set([...Object.keys(own(da, c) || {}), ...Object.keys(own(db, c) || {})]);
    for (const id of ids) if (safeKey(id)) out.data[c][id] = pick(own(own(da, c), id), own(own(db, c), id));
  }
  const sa = (a && a.settings) || {}, sb = (b && b.settings) || {}, ta0 = (a && a.settingsAt) || {}, tb0 = (b && b.settingsAt) || {};
  const settings = {};
  const keys = new Set([...Object.keys(sa), ...Object.keys(sb), ...Object.keys(ta0), ...Object.keys(tb0)]);
  for (const k of keys) {
    if (!safeKey(k)) continue;
    const ta = own(ta0, k) || 0, tb = own(tb0, k) || 0;
    const from = tb > ta ? sb : ta > tb ? sa : (canon(own(sb, k)) > canon(own(sa, k)) ? sb : sa);
    if (own(from, k) !== undefined) settings[k] = own(from, k);
    if (ta || tb) out.settingsAt[k] = Math.max(ta, tb);
  }
  out.settings = normSettings(settings);
  return out;
}

/** 新的或改过的记录：盖上修改时间（比旧的至少新 1 毫秒，同一毫秒改两次也分得出先后） */
export function stamp(rec, prev, now = Date.now()) {
  return { ...rec, updatedAt: Math.max(now, ((prev && prev.updatedAt) || 0) + 1) };
}

/** 软删除：内容保留，照样同步，在「最近删除」里能恢复 */
export function deletedRecord(rec, now = Date.now()) {
  return rec && !rec.deleted ? stamp({ ...rec, deleted: true, deletedAt: now }, rec, now) : null;
}

/** 恢复：去掉删除标记，修改时间晚于删除（别的设备上旧的删除不会再盖过来） */
export function restoredRecord(rec, now = Date.now()) {
  if (!rec || !rec.deleted) return null;
  const { deleted, deletedAt, ...r } = rec;
  return stamp(r, rec, now);
}

/** 没删除的条目（数组，无序；排序用 byNewest） */
export const live = state => Object.values((state && state.data && state.data.entries) || {}).filter(r => !r.deleted);

/** 排序：新的在前。同一天按时间（不知道时间的排在那天最后），再按创建时间、id */
export function byNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const ta = a.time || '', tb = b.time || '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  if ((a.createdAt || 0) !== (b.createdAt || 0)) return (b.createdAt || 0) - (a.createdAt || 0);
  return String(b.id).localeCompare(String(a.id), 'en', { numeric: true });
}

/** sha256 → 引用这段录音的条目 id 列表（导入去重、同步下载用） */
export function clipIndex(state, { includeDeleted = false } = {}) {
  const idx = new Map();
  for (const e of Object.values((state && state.data && state.data.entries) || {})) {
    if (e.deleted && !includeDeleted) continue;
    for (const a of e.audio || []) { if (!idx.has(a.sha256)) idx.set(a.sha256, []); idx.get(a.sha256).push(e.id); }
  }
  return idx;
}

/** 生成记录 id：前缀 + 时间 + 随机，几台设备同时新建也不会撞 */
export function newId(prefix = 'e_') {
  const rnd = (globalThis.crypto && crypto.getRandomValues) ? [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(36).padStart(2, '0')).join('') : Math.random().toString(36).slice(2, 12);
  return prefix + Date.now().toString(36) + rnd;
}

/**
 * 新条目（字段补齐、盖好时间）。fields 里给什么用什么，没给的用默认值：
 * 日期默认今天，时间 null，status 'done'，source { kind: 'app' }
 */
export function makeEntry(fields = {}, now = Date.now()) {
  return normalizeEntry({
    id: newId('e_'), createdAt: now, updatedAt: now, date: today(new Date(now)), time: null, recordedAt: null, tz: null, timeSource: null,
    status: 'done', title: '', text: '', note: '', draft: null, fav: false, audio: [], source: { kind: 'app' },
    ...fields,
  });
}

/** 改一项设置（直接改 state），修改时间比旧的至少新 1 毫秒。返回是否真的变了 */
export function setSetting(state, key, value, now = Date.now()) {
  if (!safeKey(key) || canon(state.settings[key]) === canon(value)) return false;
  if (value === undefined) delete state.settings[key]; else state.settings[key] = value;
  state.settingsAt[key] = Math.max(now, (state.settingsAt[key] || 0) + 1);
  return true;
}
