// 数据层：state.data.entries 是「id → 条目」。每条有 updatedAt（毫秒）。删除先只打 deleted 标记、内容保留（能在「最近删除」里恢复）；
// 从条目里拿掉的录音放进 removedAudio（「移除的录音」，也能放回去）。永久删除：条目换成墓碑（purged：没有内容，只留 id、时间和录音的记号 gone），
// 移除的录音换成同一条里的记号。记号只盖住永久删除时看到的那一版（from）：之后别的设备恢复、改过、重新加的不受影响（这次永久删除作废）。
// 多台设备合并时逐条比较 updatedAt 取较新的一份；时间相同内容不同时按内容排序取一份，保证每台设备结果一样。
// 带了上面这些新字段的条目由 pickEntry 合并：文字照样整条取新的，录音按 sha 一段一段比各自的时间；合出来和两边都不一样时
// updatedAt = 两边较大的 + 1（旧版 app 只比时间，直接采用，不会来回推）。
// 设置按键合并，各键有自己的修改时间（settingsAt）。不认识的字段、集合原样保留，旧版 app 同步时不会弄丢新版的数据。
// 别的集合（比如 data.devices：用上新版的设备报到，见 purge.js）整条取 updatedAt 新的；报到记录的 updatedAt 就是最后一次报到的时刻。
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

const fin = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = v => (Array.isArray(v) ? v : []);
const validItem = a => isObj(a) && SHA.test(a.sha256);
const lowSha = a => a.sha256.toLowerCase();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bySha = (a, b) => cmp(a.sha256, b.sha256);
/** srcSha256：导入时转成 m4a 的，原文件的 sha256（只用来认出同一个文件，见 importM4a.js）。有这个键才整理：坏的去掉，好的改小写 */
const audioItem = a => {
  const x = {
    ...a, sha256: a.sha256.toLowerCase(), mime: str(a.mime) || 'audio/mp4', bytes: numOrNull(a.bytes), durationSec: numOrNull(a.durationSec),
    origName: str(a.origName), addedAt: Number(a.addedAt) || 0,
  };
  if ('srcSha256' in x) { if (typeof x.srcSha256 === 'string' && SHA.test(x.srcSha256)) x.srcSha256 = x.srcSha256.toLowerCase(); else delete x.srcSha256; }
  return x;
};
/** 条目里的录音：坏的、重复的去掉。restoredAt（从「移除的录音」放回来的时刻）只留有效的；removedAt 不属于这里 */
function normAudio(list) {
  const seen = new Set();
  return arr(list).filter(validItem).map(a => {
    const { removedAt, ...x } = audioItem(a);
    if (x.restoredAt !== undefined) { const t = Number(x.restoredAt); if (Number.isFinite(t) && t > 0) x.restoredAt = t; else delete x.restoredAt; }
    return x;
  }).filter(a => !seen.has(a.sha256) && seen.add(a.sha256));
}
/** 移除的录音：removedAt 没有就算这一版的时间；同一段有几份留 removedAt 大的（一样大按内容取一份） */
function normRemoved(list, at) {
  const best = new Map();
  for (const a of arr(list)) {
    if (!validItem(a)) continue;
    const { restoredAt, ...x } = audioItem(a);
    x.removedAt = fin(a.removedAt) || at;
    const c = best.get(x.sha256);
    if (!c || x.removedAt > c.removedAt || (x.removedAt === c.removedAt && canon(x) > canon(c))) best.set(x.sha256, x);
  }
  return [...best.values()];
}

// ---------- 永久删除的记号（gone） ----------
/** 一段录音此刻的时间：在 audio 里 = restoredAt（放回来的）或 addedAt；在 removedAudio 里 = removedAt */
export const stateTime = (it, removed = false) => (removed ? fin(it.removedAt) : fin(it.restoredAt) || fin(it.addedAt));
/**
 * 记号：sha → { sha256, mime, purgedAt, from }。from = 永久删除时看到的那一版的时间（条目的 updatedAt / 那段的 removedAt）；
 * from = −1 只是个记号（永久删除作废了），什么也不盖。同一段有几份：from、purgedAt 各取大的，mime 跟 purgedAt 大的（一样大取大的）——和合并的先后无关
 */
function normGone(...lists) {
  const G = new Map();
  for (const list of lists) for (const g of arr(list)) {
    if (!validItem(g)) continue;
    const f = numOrNull(g.from);
    const s = { sha256: lowSha(g), mime: str(g.mime) || 'audio/mp4', purgedAt: fin(g.purgedAt), from: f === null ? -1 : f };
    const c = G.get(s.sha256);
    if (!c) { G.set(s.sha256, s); continue; }
    const later = s.purgedAt > c.purgedAt || (s.purgedAt === c.purgedAt && s.mime > c.mime);
    G.set(s.sha256, { sha256: s.sha256, mime: later ? s.mime : c.mime, purgedAt: Math.max(s.purgedAt, c.purgedAt), from: Math.max(s.from, c.from) });
  }
  return G;
}
const unionGone = (...lists) => [...normGone(...lists).values()];
const stub = (a, purgedAt, from) => ({ sha256: lowSha(a), mime: str(a.mime) || 'audio/mp4', purgedAt, from });
/** 被这一条的记号盖住了：记号的 from 不早于这段的时间（from = −1 的谁也不盖） */
const dead = (G, sha, t) => { const g = G.get(sha); return !!g && t <= g.from; };
/** 这一段（audio 里的样子）被条目自己的记号盖住了没有（修改记录的预览、恢复旧版本用） */
export const killedIn = (entry, item) => isObj(entry) && validItem(item) && dead(normGone(entry.gone), lowSha(item), stateTime(item));

const normBy = v => ({ ...v, who: v.who === 'me' || v.who === 'nn' ? v.who : null, device: str(v.device) });
const isoDay = ms => { const d = new Date(ms); return ms && Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '1970-01-01'; };
/**
 * 墓碑：只留这些键（旧版 app 写进去的原话、恢复时去掉的 deleted、别的字段都不要）。内容字段给读者熟悉的空值；
 * 创建时间、日期、删除时间都从 purgedAt 来，旧版 app 怎么改都整理成同一个样子。purgedFrom 没有 → 0（谁也盖不过：宁可作废）
 */
function tombstone(rec, id) {
  const updatedAt = Number(rec.updatedAt) || 0, purgedAt = fin(rec.purgedAt) || updatedAt;
  const t = {
    id, updatedAt, createdAt: purgedAt, date: isoDay(purgedAt), time: null, recordedAt: null, tz: null, timeSource: null,
    status: 'done', title: '', text: '', note: '', draft: null, fav: false, audio: [], source: { kind: 'app' },
    deleted: true, deletedAt: purgedAt, purged: true, purgedAt, purgedFrom: fin(rec.purgedFrom), gone: unionGone(rec.gone).sort(bySha),
  };
  if (isObj(rec.updatedBy)) t.updatedBy = normBy(rec.updatedBy);
  return t;
}
const joinParts = (parts) => parts.map(p => p.text).join('\n\n');       // 和 transcribe.js 拼草稿的写法一样
const okPart = p => isObj(p) && typeof p.sha256 === 'string' && typeof p.text === 'string';

/**
 * 条目的字段检查。日期格式坏了也不丢整条：原值留在 badDate 里，日期先用创建那天，等用户改。
 * purged 的整理成墓碑。别的条目：被 gone 记号盖住的录音去掉；同一段既在 audio 又在 removedAudio（本机把它放回 audio 了）留 audio，
 * 时间不比那次移除新的盖上 restoredAt = removedAt + 1；草稿里已经永久删除的录音转出的那几段去掉（草稿没改过就按剩下的重新拼，改过的一个字不动）。
 * removedAudio、gone 空了就不写（没有这些的条目整理出来和以前一模一样）
 */
export function normalizeEntry(rec, id = rec && rec.id) {
  if (rec.purged) return tombstone(rec, id);
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
  r.source = isObj(r.source) && typeof r.source.kind === 'string' ? r.source : { ...(isObj(r.source) ? r.source : {}), kind: 'app' };
  if (r.deleted) { r.deleted = true; r.deletedAt = Number(r.deletedAt) || updatedAt; }
  else { delete r.deleted; delete r.deletedAt; delete r.deletedBy; }
  // 谁改的 / 谁删的：{ who: 'me'|'nn'|null, device, at }（at = 签名时的 updatedAt / deletedAt）。老数据没有就没有
  for (const k of ['updatedBy', 'deletedBy']) {
    if (r[k] === undefined) continue;
    if (isObj(r[k])) r[k] = normBy(r[k]);
    else delete r[k];
  }
  // 录音：记号盖住的去掉；同一段 audio / removedAudio 都有的留 audio
  const G = normGone(r.gone);
  const removed = normRemoved(r.removedAudio, updatedAt).filter(a => !dead(G, a.sha256, a.removedAt)), rm = new Map(removed.map(a => [a.sha256, a]));
  r.audio = normAudio(r.audio).filter(a => !dead(G, a.sha256, stateTime(a)))
    .map(a => { const x = rm.get(a.sha256); return !x || stateTime(a) > x.removedAt ? a : { ...a, restoredAt: x.removedAt + 1 }; });
  const inA = new Set(r.audio.map(a => a.sha256)), rem = removed.filter(a => !inA.has(a.sha256));
  // 转出的字（草稿的 parts）：录音已经永久删除（有记号、条目里哪儿都没有了）的那几段去掉
  if (G.size && r.draft && Array.isArray(r.draft.parts)) {
    const has = new Set([...inA, ...rem.map(a => a.sha256)]);
    const lost = p => okPart(p) && G.has(p.sha256.toLowerCase()) && !has.has(p.sha256.toLowerCase());
    if (r.draft.parts.some(lost)) {
      const d = { ...r.draft, parts: r.draft.parts.filter(p => !lost(p)) };
      if (r.draft.text === joinParts(r.draft.parts.filter(okPart))) d.text = joinParts(d.parts.filter(okPart));
      if (!d.parts.length) delete d.parts;
      r.draft = d.parts || d.text ? d : null;
    }
  }
  if (rem.length) r.removedAudio = rem.sort((a, b) => a.removedAt - b.removedAt || bySha(a, b)); else delete r.removedAudio;
  if (G.size) r.gone = [...G.values()].sort(bySha); else delete r.gone;
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

// ---------- 条目的合并 ----------
const hasNew = e => !!(e.purged || e.gone || e.removedAudio || (Array.isArray(e.audio) && e.audio.some(x => x && x.restoredAt)));
/** 两份墓碑：取较新的那份，purgedAt / purgedFrom 取大的，记号合起来 */
function mergeTombs(A, B) {
  const W = pick(A, B);
  return tombstone({ ...W, purgedAt: Math.max(A.purgedAt, B.purgedAt), purgedFrom: Math.max(A.purgedFrom, B.purgedFrom), gone: unionGone(A.gone, B.gone) }, W.id);
}
/** 作废的墓碑带过去的记号：这次永久删除记下的（from ≥ purgedFrom）变成只是记号；更早的「移除的录音」的永久删除照样算 */
const inert = t => t.gone.map(g => (g.from >= t.purgedFrom ? { ...g, from: -1 } : g));
/**
 * 两份都没永久删除：文字整条取较新的（W），录音按 sha 一段一段比时间（audio / removedAudio 各用自己的时间，被记号盖住的不算；
 * 一样新时 W 的优先，再是 audio 优先）。只在较旧那份的 audio 里、哪儿都没有记录（没移除过、没记号）的录音照旧整条取新的：
 * 旧版 app 移除的、旧备份里的不会加回来
 */
function mergeLive(A, B) {
  const W = pick(A, B), O = W === A ? B : A, G = normGone(A.gone, B.gone);
  const best = new Map();                                           // sha → { state, t, item, inW }
  const offer = (it, state, t, inW) => {
    if (dead(G, it.sha256, t)) return;
    const c = best.get(it.sha256);
    if (!c || t > c.t || (t === c.t && ((inW && !c.inW) || (inW === c.inW && state === 'audio')))) best.set(it.sha256, { state, t, item: it, inW });
  };
  for (const [X, inW] of [[W, true], [O, false]]) {
    for (const it of X.audio) offer(it, 'audio', stateTime(it), inW);
    for (const it of X.removedAudio || []) offer(it, 'removed', it.removedAt, inW);
  }
  const known = new Set([...W.audio, ...(W.removedAudio || [])].map(a => a.sha256));
  for (const [sha, c] of best) if (!c.inW && c.state === 'audio' && !known.has(sha) && !G.has(sha)) best.delete(sha);
  const inW = new Set(W.audio.map(a => a.sha256));
  const audio = [...W.audio.filter(x => best.get(x.sha256)?.state === 'audio').map(x => best.get(x.sha256).item),
    ...[...best.values()].filter(c => c.state === 'audio' && !inW.has(c.item.sha256)).sort((p, q) => p.t - q.t || bySha(p.item, q.item)).map(c => c.item)];
  const removedAudio = [...best.values()].filter(c => c.state === 'removed').map(c => c.item);
  return normalizeEntry({ ...W, audio, removedAudio, gone: [...G.values()] }, W.id);
}
/**
 * 合并同一条的两份（顺序无关；合并自己不变）。两份都没有新字段：和以前一样整条取新的（结果一模一样）。
 * 墓碑对一份没永久删除的：那份不比永久删除时看到的那一版新（updatedAt ≤ purgedFrom）→ 墓碑赢（只有那份有的录音不记号：成了没人用的录音，不删）；
 * 更新（别的设备恢复了、改过、加了录音）→ 这次永久删除作废，那份赢，updatedAt 比墓碑新，墓碑的记号带上但只是记号。
 * 合出来和两边都不一样：updatedAt = 两边较大的 + 1（旧版 app 只比时间，直接采用；不会来回推）
 */
export function pickEntry(a, b, id = (a || b) && (a || b).id) {
  if (!a) return b;
  if (!b) return a;
  if (!hasNew(a) && !hasNew(b)) return pick(a, b);
  const A = normalizeEntry(a, id), B = normalizeEntry(b, id);
  let out;
  if (A.purged && B.purged) out = mergeTombs(A, B);
  else if (A.purged || B.purged) {
    const t = A.purged ? A : B, o = A.purged ? B : A;
    out = o.updatedAt <= t.purgedFrom
      ? normalizeEntry({ ...t, gone: unionGone(t.gone, o.gone) }, id)
      : normalizeEntry({ ...o, gone: unionGone(o.gone, inert(t)), updatedAt: Math.max(o.updatedAt, t.updatedAt + 1) }, id);
  } else out = mergeLive(A, B);
  const c = canon(out);
  if (c !== canon(A) && c !== canon(B)) out = { ...out, updatedAt: Math.max(A.updatedAt, B.updatedAt) + 1 };
  return out;
}

/** 两份数据逐条合并（顺序无关：merge(a,b) 和 merge(b,a) 结果一样）。条目用 pickEntry，别的集合整条取新的 */
export function mergeStates(a, b) {
  const out = blankState();
  const da = (a && isObj(a.data) && a.data) || {}, db = (b && isObj(b.data) && b.data) || {};
  for (const c of collectionsOf(a, b)) {
    out.data[c] = out.data[c] || {};
    const ids = new Set([...Object.keys(own(da, c) || {}), ...Object.keys(own(db, c) || {})]);
    for (const id of ids) {
      if (!safeKey(id)) continue;
      const x = own(own(da, c), id), y = own(own(db, c), id);
      out.data[c][id] = c === 'entries' ? pickEntry(x, y, id) : pick(x, y);
    }
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

/** 软删除：内容保留，照样同步，在「最近删除」里能恢复。deletedAt = 盖好的修改时间（时钟慢也不早于上一版）。墓碑本来就是删除了的 → null */
export function deletedRecord(rec, now = Date.now()) {
  if (!rec || rec.deleted) return null;
  const r = stamp({ ...rec, deleted: true }, rec, now);
  return { ...r, deletedAt: r.updatedAt };
}

/** 恢复：去掉删除标记，修改时间晚于删除（别的设备上旧的删除不会再盖过来）。永久删除了的不能恢复 → null */
export function restoredRecord(rec, now = Date.now()) {
  if (!rec || !rec.deleted || rec.purged) return null;
  const { deleted, deletedAt, deletedBy, ...r } = rec;
  return stamp(r, rec, now);
}

// ---------- 永久删除、移除的录音：改一条（在 mutate 里用；没什么可做 → null） ----------
export const PURGE_MS = 30 * 864e5, TOUCH_MS = 36e5;
const FRESH_MS = 6e5;                                    // freshAdds：10 分钟内加的才算「刚加的」
export const isTombstone = e => !!(e && e.purged);
const stampAt = (rec, now) => Math.max(now, (Number(rec.updatedAt) || 0) + 1);   // 和 stamp 盖的时间一样

/** 永久删除一条（在「最近删除」里的）：from = 用户看到的那一版的 updatedAt，期间变了（别的设备恢复、改过）→ null。条目里所有的录音都记下 */
export function purgedRecord(rec, from, now = Date.now()) {
  if (!isObj(rec) || !rec.deleted || rec.purged || rec.updatedAt !== from) return null;
  const t = stampAt(rec, now);
  const gone = unionGone(rec.gone, [...arr(rec.audio), ...arr(rec.removedAudio)].filter(validItem).map(a => stub(a, t, from)));
  return normalizeEntry({ id: rec.id, updatedAt: t, purged: true, purgedAt: t, purgedFrom: from, deleted: true, gone }, rec.id);
}
/**
 * 永久删除「移除的录音」：items = [{ sha256, removedAt }]，就是用户看到的那几段。还在 removedAudio 里、removedAt 一样的才删
 * （别的设备放回去了、又移除了一次的不删，调用的人把对不上的报成 changed）；一段都对不上 → null。
 * 记号的 from = removedAt：那次移除以前的旧副本被盖住，之后放回去、重新加的不受影响
 */
export function purgeRemovedRecord(rec, items, now = Date.now()) {
  if (!isObj(rec) || rec.purged || rec.deleted) return null;
  const want = new Map(arr(items).filter(x => isObj(x) && typeof x.sha256 === 'string').map(x => [x.sha256.toLowerCase(), Number(x.removedAt)]));
  const hit = arr(rec.removedAudio).filter(a => validItem(a) && want.has(lowSha(a)) && want.get(lowSha(a)) === Number(a.removedAt));
  if (!hit.length) return null;
  const t = stampAt(rec, now), drop = new Set(hit.map(lowSha));
  return normalizeEntry({ ...rec, updatedAt: t, removedAudio: arr(rec.removedAudio).filter(a => !(validItem(a) && drop.has(lowSha(a)))),
    gone: unionGone(rec.gone, hit.map(a => stub(a, t, Number(a.removedAt)))) }, rec.id);
}
/** 「移除的录音」放回那条最后：restoredAt 晚于移除（时钟慢也一样），别的设备上同时的永久删除、旧的移除都盖不过它。不在里面 → null */
export function restoreRemovedRecord(rec, sha, now = Date.now()) {
  const s = String(sha || '').toLowerCase();
  const it = isObj(rec) && !rec.purged ? arr(rec.removedAudio).find(a => validItem(a) && lowSha(a) === s) : null;
  if (!it) return null;
  const t = Math.max(stampAt(rec, now), fin(it.removedAt) + 1);
  const { removedAt, ...item } = it;
  return normalizeEntry({ ...rec, updatedAt: t, audio: [...arr(rec.audio), { ...item, restoredAt: t }], removedAudio: arr(rec.removedAudio).filter(a => a !== it) }, rec.id);
}
/** 没有条目在用的录音 [{ sha256, mime }] → 一个孤儿墓碑（o_…，purgedFrom 0，记号的 from 0）；之后和别的永久删除一样传开。没有 → null */
export function orphanTombstone(list, now = Date.now()) {
  const seen = new Set(), gone = arr(list).filter(x => validItem(x) && !seen.has(lowSha(x)) && seen.add(lowSha(x))).map(x => stub(x, now, 0));
  if (!gone.length) return null;
  const id = newId('o_');
  return normalizeEntry({ id, updatedAt: now, purged: true, purgedAt: now, purgedFrom: 0, deleted: true, gone }, id);
}
/**
 * 本机修改时记下拿掉的录音（state.js 的 diff、undo 用；返回新的 next，还没整理）：
 *   prev.audio 里有、next 里哪儿都没有（也没被记号盖住）的 → 放进 next.removedAudio，removedAt = 现在（不早于上一版：时钟慢也不往前记）；
 *     removals: false 时不记（录音页放弃还没上传的那段：录音本身随后就删，见 state.js mutate 的 track）；
 *   prev.removedAudio 里的、next 没提到的照样留着；prev 的记号都带上（本机的修改不会让「移除的录音」、记号悄悄变少）；
 *   从 removedAudio 回到 audio 的（撤销移除、放回去、重新加）：时间不比那次移除新的盖上 restoredAt = 现在，别的设备上那次移除、旧副本都盖不过它；
 *   反过来从 audio 回到 next 带着的 removedAudio 里的（撤销「恢复这个版本」）：removedAt 不比放回去的时间新的改成现在
 */
export function trackRemoved(prev, next, now = Date.now(), { removals = true } = {}) {
  if (!isObj(prev) || !isObj(next) || prev.purged || next.purged) return next;
  const G = normGone(prev.gone, next.gone), at = stampAt(prev, now);
  const pA = new Set(arr(prev.audio).filter(validItem).map(lowSha));
  const pR = new Map(arr(prev.removedAudio).filter(validItem).map(a => [lowSha(a), fin(a.removedAt)]));
  const back = new Set();
  const audio = arr(next.audio).map(a => {
    const r = validItem(a) && !pA.has(lowSha(a)) ? pR.get(lowSha(a)) : undefined;
    if (r === undefined) return a;
    back.add(lowSha(a));
    return stateTime(a) > r + 1 ? a : { ...a, restoredAt: Math.max(now, r + 1) };
  });
  const inA = new Set(audio.filter(validItem).map(lowSha));
  // 从 prev.audio 回到 next.removedAudio 的（撤销「恢复这个版本」、撤销导入时的「接上」：next.removedAudio 是撤销前那份，removedAt 还是放回去之前的）：
  // removedAt 不比它在 prev 里的时间新的改成现在，不然存盘、同步时和放回去的那份逐段比时间，放回去的更新，又回到 audio
  const pI = new Map(arr(prev.audio).filter(validItem).map(a => [lowSha(a), a]));
  let moved = false;
  const kept = arr(next.removedAudio).filter(a => !(validItem(a) && back.has(lowSha(a)))).map(a => {
    const p = validItem(a) ? pI.get(lowSha(a)) : null;
    if (!p || inA.has(lowSha(a)) || fin(a.removedAt) > stateTime(p)) return a;
    moved = true;
    const { restoredAt, ...x } = a;
    return { ...x, removedAt: Math.max(at, stateTime(p) + 1) };
  }), inR = new Set(kept.filter(validItem).map(lowSha)), add = [];
  const keep = (a, t) => { const s = lowSha(a); if (inA.has(s) || inR.has(s) || dead(G, s, t)) return false; inR.add(s); return true; };
  if (removals) for (const a of arr(prev.audio).filter(validItem)) if (keep(a, stateTime(a))) { const { restoredAt, ...x } = a; add.push({ ...x, removedAt: at }); }
  for (const a of arr(prev.removedAudio).filter(validItem)) if (keep(a, fin(a.removedAt))) add.push(a);
  const out = { ...next, audio };
  if (add.length || moved || kept.length !== arr(next.removedAudio).length) out.removedAudio = [...kept, ...add];
  if (G.size) out.gone = [...G.values()];
  return out;
}
/**
 * 刚加进来的录音（选文件、导入、录音、留下：10 分钟内加的、上一版里哪儿都没有）碰上这一条的记号、addedAt 又不比记号新（别的设备时钟快）：
 * addedAt 挪到记号之后，不被当成旧的盖掉。草稿、旧版本、撤销拿回来的旧录音时间旧，照样被盖住
 */
export function freshAdds(prev, next, now = Date.now()) {
  if (!isObj(prev) || !isObj(next) || next.purged) return next;
  const G = normGone(prev.gone, next.gone);
  if (!G.size) return next;
  const old = new Set([...arr(prev.audio), ...arr(prev.removedAudio)].filter(validItem).map(lowSha));
  let hit = false;
  const audio = arr(next.audio).map(a => {
    if (!validItem(a)) return a;
    const g = G.get(lowSha(a)), t = fin(a.addedAt);
    if (!g || old.has(lowSha(a)) || t < now - FRESH_MS || t > g.from) return a;
    hit = true;
    return { ...a, addedAt: g.from + 1 };
  });
  return hit ? { ...next, audio } : next;
}
/**
 * 「恢复这个版本」的录音（在 mutate 里拿最新的条目算）：现在的录音一段不少，加上那一版有、现在没有的。
 * 被这一条的记号盖住的、gone（哪儿都已经永久删除了）里的不加（purged 计数）；在「移除的录音」里的放回来（盖 restoredAt）；
 * 哪儿都没有的，have（Set 或函数：事先确认本机或云端拿得到）里有才加，否则 missing 计数。
 * @returns {{ audio, removedAudio, purged: number, missing: number, back: number }}  back：加回来的段数
 */
export function restoreAudio(cur, items, { gone = new Set(), have = new Set(), now = Date.now() } = {}) {
  const can = typeof have === 'function' ? have : s => !!(have && have.has(s));
  const G = normGone(cur && cur.gone), audio = [...arr(cur && cur.audio)];
  let removedAudio = [...arr(cur && cur.removedAudio)], purged = 0, missing = 0, back = 0;
  for (const it of normAudio(items)) {
    const s = it.sha256;
    if (audio.some(a => validItem(a) && lowSha(a) === s)) continue;
    if (dead(G, s, stateTime(it)) || gone.has(s)) { purged++; continue; }
    const r = removedAudio.find(a => validItem(a) && lowSha(a) === s);
    if (r) {
      const { removedAt, ...item } = r;
      audio.push({ ...item, restoredAt: Math.max(now, fin(removedAt) + 1) });
      removedAudio = removedAudio.filter(a => a !== r);
      back++;
    } else if (can(s)) { audio.push(it); back++; }
    else missing++;
  }
  return { audio, removedAudio, purged, missing, back };
}

// ---------- 由数据算出来的（纯函数，每次 O(条目数)） ----------
const entriesOf = state => Object.values((state && isObj(state.data) && isObj(state.data.entries) && state.data.entries) || {}).filter(isObj);
/** 有条目在用的录音：没永久删除的条目（含最近删除里的）的 audio 和 removedAudio */
export function claimShas(state) {
  const out = new Set();
  for (const e of entriesOf(state)) if (!e.purged) for (const a of [...arr(e.audio), ...arr(e.removedAudio)]) if (validItem(a)) out.add(lowSha(a));
  return out;
}
/** 所有记号（墓碑的、条目里的；盖不盖都算）：sha → { mime, purgedAt }（purgedAt 取最大的，一样大取 mime 大的：每台设备算出来一样） */
export function stubShas(state) {
  const out = new Map();
  for (const e of entriesOf(state)) for (const g of arr(e.gone)) {
    if (!validItem(g)) continue;
    const s = lowSha(g), at = fin(g.purgedAt), mime = str(g.mime) || 'audio/mp4', c = out.get(s);
    if (!c || at > c.purgedAt || (at === c.purgedAt && mime > c.mime)) out.set(s, { mime, purgedAt: at });
  }
  return out;
}
/** 确实没了的录音：有记号、又没有条目在用（同一段别的条目还在用、重新导入过、永久删除作废了的都不算）。只有这些在各台设备和仓库里删 */
export function goneShas(state) {
  const C = claimShas(state), out = new Set();
  for (const s of stubShas(state).keys()) if (!C.has(s)) out.add(s);
  return out;
}
/** 有记号、又有没删除的条目在用（仓库里该有）的录音：同步时查一下仓库里还在不在（被删过就重新传） */
export function contestedShas(state) {
  const R = referencedClips(state), out = new Set();
  for (const s of stubShas(state).keys()) if (R.has(s)) out.add(s);
  return out;
}
/**
 * 条目引用的录音：sha → mime，新的条目在前（下载顺序）。默认只算没删除的条目的 audio（墓碑也算删除了，而且没有录音）；
 * includeDeleted 连最近删除里的条目，includeRemoved 连「移除的录音」（只是找 mime 用：这两种都不上传、不下载）
 */
export function referencedClips(state, { includeDeleted = false, includeRemoved = false } = {}) {
  const list = entriesOf(state).filter(e => includeDeleted || !e.deleted).sort(byNewest);
  const m = new Map();
  for (const e of list) for (const a of [...arr(e.audio), ...(includeRemoved ? arr(e.removedAudio) : [])]) {
    const sha = a && typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
    if (/^[0-9a-f]{64}$/.test(sha) && !m.has(sha)) m.set(sha, a.mime || 'audio/mp4');
  }
  return m;
}
/** 「移除的录音」（没删除、没永久删除的条目里的；删除了的条目里的跟着条目走）：[{ entryId, item, at: 条目的 updatedAt }]，移除得晚的在前 */
export function removedClips(state) {
  const out = [];
  for (const e of entriesOf(state)) if (!e.deleted && !e.purged) for (const item of arr(e.removedAudio)) if (validItem(item)) out.push({ entryId: e.id, item, at: e.updatedAt });
  return out.sort((a, b) => fin(b.item.removedAt) - fin(a.item.removedAt) || cmp(a.entryId, b.entryId) || bySha(a.item, b.item));
}
/**
 * 「最近删除」里的每一项（30 天怎么算见 purge.js）：键 → { kind, id, sha?, since }（since 是同步来的时间，只用来显示）
 *   'e:'+id          删除了（没永久删除）的条目，since = deletedAt
 *   'c:'+id+':'+sha  没删除的条目里移除的录音，since = removedAt（删除了的条目里的跟着条目走，恢复以后重新算）
 */
export function trashKeys(state) {
  const out = new Map();
  for (const e of entriesOf(state)) {
    if (e.purged) continue;
    if (e.deleted) out.set('e:' + e.id, { kind: 'entry', id: e.id, since: fin(e.deletedAt) || fin(e.updatedAt) });
    else for (const it of arr(e.removedAudio)) if (validItem(it)) out.set('c:' + e.id + ':' + lowSha(it), { kind: 'clip', id: e.id, sha: lowSha(it), since: fin(it.removedAt) });
  }
  return out;
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

/**
 * 一段录音认得出的 sha256：存下的文件的（sha256），导入时转成 m4a 的再加上原文件的（srcSha256）。只用来去重：
 * 永久删除、清理、同步、「有条目在用」都只认 sha256
 */
export const clipKeys = (a) => (a && typeof a.sha256 === 'string' ? [a.sha256, ...(typeof a.srcSha256 === 'string' && a.srcSha256 && a.srcSha256 !== a.sha256 ? [a.srcSha256] : [])] : []);
/** 两段是同一个录音（clipKeys 有一个对得上）：同一个 WAV 导两次、编出来的 m4a 不一样也认得出 */
export const sameClip = (a, b) => { const k = clipKeys(b); return clipKeys(a).some(x => k.includes(x)); };

/**
 * sha256 → 引用这段录音的条目 id 列表（导入去重、同步下载用）。
 * withSrc：原文件的 sha256（srcSha256）也放进去（导入去重用：选的文件和以前转成 m4a 的是同一个）
 */
export function clipIndex(state, { includeDeleted = false, withSrc = false } = {}) {
  const idx = new Map();
  for (const e of Object.values((state && state.data && state.data.entries) || {})) {
    if (e.deleted && !includeDeleted) continue;
    for (const a of e.audio || []) {
      for (const k of withSrc ? clipKeys(a) : [a.sha256]) {
        if (!idx.has(k)) idx.set(k, []);
        if (!idx.get(k).includes(e.id)) idx.get(k).push(e.id);
      }
    }
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
