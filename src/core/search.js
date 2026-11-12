// 搜索：简繁折叠、忽略大小写和全角半角，去掉表情、标点、空白后匹配原话、背景、草稿和录音的名字（条目没有标题）。
// 只有表情的搜索词（如「🤯」）退一步：保留表情、忽略肤色和变体选择符再比。
import { toSimplified } from './hanzi.js';
import { clipName } from './clips.js';

// 比较时丢掉的字符：标点、符号（含表情、肤色）、空白、控制和格式字符（ZWJ 等）、变体选择符、键帽
const DROP = /[\p{P}\p{S}\p{Z}\s\p{Cc}\p{Cf}\uFE00-\uFE0F\u20E3]/u;
// 宽松模式（只有表情的搜索词）：只丢空白、ZWJ、变体选择符、肤色
const LOOSE_DROP = /[\p{Z}\s\p{Cc}\p{Cf}\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u;

const charCache = [new Map(), new Map()];
/** 一个字（码位）折叠后的样子（可能是 ''，也可能不止一个字：NFKC「㎏」→「kg」） */
function foldChar(ch, loose) {
  const cache = charCache[loose ? 1 : 0];
  let f = cache.get(ch);
  if (f === undefined) {
    f = '';
    for (const c of ch.normalize('NFKC')) if (!(loose ? LOOSE_DROP : DROP).test(c)) f += c;
    f = toSimplified(f).toLowerCase();
    cache.set(ch, f);
  }
  return f;
}

const strCache = [new Map(), new Map()];
function foldStr(s, loose) {
  s = String(s ?? '');
  const cache = strCache[loose ? 1 : 0];
  let f = cache.get(s);
  if (f === undefined) {
    f = '';
    for (const ch of s) f += foldChar(ch, loose);
    if (cache.size > 5000) cache.clear();
    cache.set(s, f);
  }
  return f;
}

/** 比较用的形式：繁 → 简、小写、全角 → 半角，去掉表情、标点、空白（「為什麼？」→「为什么」） */
export const fold = s => foldStr(s, false);

/** 搜索词：按空白拆开，每个词都要命中（可以在不同字段）。只有表情的词用宽松模式。 */
function terms(query) {
  return String(query ?? '').trim().split(/\s+/).filter(Boolean)
    .map(w => (fold(w) ? { f: fold(w), loose: false } : { f: foldStr(w, true), loose: true }))
    .filter(x => x.f);
}

/** 搜哪些字：原话、背景、草稿、每段录音的名字（起的名字 / 原文件名）。旧条目存着的 title 不搜（界面上不显示） */
export const searchFields = e => (e ? [e.text, e.note, e.draft && e.draft.text, ...(Array.isArray(e.audio) ? e.audio.map(clipName) : [])] : []);

/**
 * 条目是否匹配（搜索词为空 → true）
 * @param {object} entry
 * @param {string} query
 * @param {object} [speakers]  暂时没用到（表情本来就不参与匹配），留着和其他模块的签名一致
 */
export function matchEntry(entry, query, speakers) {
  const ts = terms(query);
  if (!ts.length) return true;
  const fs = searchFields(entry);
  return ts.every(t => fs.some(x => x && foldStr(x, t.loose).includes(t.f)));
}

/** 折叠后的每个位置对应原文的哪一段 → { folded, start[], end[] } */
function foldMap(text, loose) {
  let folded = '';
  const start = [], end = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch, loose);
    for (let k = 0; k < f.length; k++) { start.push(i); end.push(i + ch.length); }
    folded += f;
    i += ch.length;
  }
  return { folded, start, end };
}

// 命中的末尾如果跟着肤色、变体选择符、键帽、标签字符，一起标上（不把一个表情拆成两半）
const TRAIL = /[\uFE0E\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;
function tail(s, i) {
  while (i < s.length) {
    const ch = String.fromCodePoint(s.codePointAt(i));
    if (!TRAIL.test(ch)) break;
    i += ch.length;
  }
  return i;
}

/**
 * 把命中的部分标出来（简繁、大小写都算命中，标的是原文）→ [{ text, hit }]，拼起来就是原文
 * @param {string} text
 * @param {string} query
 */
export function highlight(text, query) {
  const s = String(text ?? '');
  const ts = terms(query);
  if (!s || !ts.length) return [{ text: s, hit: false }];
  const ranges = [];
  for (const loose of [false, true]) {
    const mine = ts.filter(t => t.loose === loose);
    if (!mine.length) continue;
    const m = foldMap(s, loose);
    for (const t of mine) {
      for (let p = m.folded.indexOf(t.f); p >= 0; p = m.folded.indexOf(t.f, p + 1)) {
        ranges.push([m.start[p], tail(s, m.end[p + t.f.length - 1])]);
      }
    }
  }
  if (!ranges.length) return [{ text: s, hit: false }];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: s.slice(at, a), hit: false });
    out.push({ text: s.slice(a, b), hit: true });
    at = b;
  }
  if (at < s.length) out.push({ text: s.slice(at), hit: false });
  return out;
}
