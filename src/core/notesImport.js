// 从备忘录迁移：解析粘贴来的笔记文字（年份行、日期行、附件占位符 U+FFFC），给每个录音位置推荐文件并写明依据。
// 只给建议，从不自动确认；拿不准的标出来让人核对。
import { fold } from './search.js';
import { localParts, isISODate } from './dates.js';
import { pad2 } from './util.js';

const SLOT = /\uFFFC/g;
const LINES = /\r\n|[\n\r\u2028\u2029]/;
const YEAR = /^\s*(\d{4})\s*年?\s*$/;
// 「1/11」「3.12」「8-1」，也认「1月11日」；全角数字和斜杠先经 NFKC 变成半角
const DATE = /^\s*(\d{1,2})\s*(?:[/.-]\s*(\d{1,2})|月\s*(\d{1,2})\s*[日号號]?)\s*$/;
const nfc = s => String(s ?? '').normalize('NFC');
const isBlank = s => !String(s).trim();

function trimBlank(lines) {
  let a = 0, b = lines.length;
  while (a < b && isBlank(lines[a])) a++;
  while (b > a && isBlank(lines[b - 1])) b--;
  return lines.slice(a, b);
}

/**
 * 解析备忘录的文字。第一行非空的（不是年份 / 日期）是标题；「2024」这样单独一行设定年份；
 * 「1/11」单独一行开始新的一条，到下一个日期 / 年份行为止（中间的空行保留，首尾空行去掉）。
 * 每条里 U+FFFC 的个数 = 录音位置数；存的 text 去掉 U+FFFC（去掉后变空的行整行不要），其余原样。
 * 警告用代码（界面翻译）：noYear 没有年份 / badDate 不存在的日期 / outOfOrder 日期比上一条早 / empty 空的一条 /
 * textOutsideEntry 第一个日期前有文字 / slotOutsideEntry 附件不在任何一条里 / noEntries 一条也没找到。
 * @param {string} text
 * @param {{defaultYear?: number}} [opts]  第一个年份行之前用的年份（不给就不猜：date 为 null + noYear）
 * @returns {{ title: string,
 *   entries: Array<{key: string, date: string|null, k: number, text: string, raw: string, audioSlots: number, warnings: string[], line: number, dateText: string}>,
 *   warnings: string[],                 // 全部警告的代码（每出现一次一个，含每条的）
 *   issues: Array<{code: string, line: number, key: string|null}> }}  // 和 warnings 一一对应：第几行（从 1 数）、哪一条
 */
export function parseNote(text, { defaultYear } = {}) {
  const lines = String(text ?? '').split(LINES);
  const entries = [], warnings = [], issues = [];
  const perDate = new Map();
  let title = '', started = false, year = Number.isInteger(defaultYear) ? defaultYear : null;
  let cur = null, lastDate = '', strayText = 0, straySlot = 0;
  const warn = (code, line, entry) => {
    warnings.push(code); issues.push({ code, line, key: entry ? entry.key : null });
    if (entry) entry.warnings.push(code);
  };
  const close = () => {
    if (!cur) return;
    const body = trimBlank(cur.body.filter(l => !(l.includes('\uFFFC') && isBlank(l.replace(SLOT, '')))).map(l => l.replace(SLOT, '')));
    const e = cur.entry;
    e.text = body.join('\n');
    e.raw = trimBlank([cur.head, ...cur.body]).join('\n');
    if (!e.text && !e.audioSlots) warn('empty', e.line, e);
    cur = null;
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1, slots = (raw.match(SLOT) || []).length;
    const bare = raw.replace(SLOT, ''), norm = bare.normalize('NFKC');
    let m;
    if ((m = norm.match(YEAR))) {
      close(); started = true; year = Number(m[1]);
      if (slots) { straySlot += slots; warn('slotOutsideEntry', lineNo, null); }
      return;
    }
    if ((m = norm.match(DATE))) {
      close(); started = true;
      const mo = Number(m[1]), d = Number(m[2] ?? m[3]);
      const ymd = `${year ?? '0000'}-${pad2(mo)}-${pad2(d)}`;
      const k = (perDate.get(ymd) || 0) + 1;
      perDate.set(ymd, k);
      const ok = year != null && isISODate(ymd);
      const entry = { key: `n_${ymd}_${k}`, date: ok ? ymd : null, k, text: '', raw: '', audioSlots: slots, warnings: [], line: lineNo, dateText: bare.trim() };
      if (year == null) warn('noYear', lineNo, entry);
      else if (!ok) warn('badDate', lineNo, entry);
      else { if (lastDate && ymd < lastDate) warn('outOfOrder', lineNo, entry); lastDate = ymd; }
      entries.push(entry);
      cur = { entry, head: raw, body: [] };
      return;
    }
    if (cur) { cur.body.push(raw); cur.entry.audioSlots += slots; return; }
    if (!started && !isBlank(bare)) {
      started = true; title = bare.trim();
      if (slots) { straySlot += slots; warn('slotOutsideEntry', lineNo, null); }
      return;
    }
    if (slots) { straySlot += slots; warn('slotOutsideEntry', lineNo, null); }
    if (!isBlank(bare)) { if (!strayText++) warn('textOutsideEntry', lineNo, null); }
  });
  close();
  if (!entries.length && String(text ?? '').trim()) warn('noEntries', 0, null);
  return { title, entries, warnings, issues };
}

/** 「共享 › 拷贝」得到的路径列表（一行一个，可以是 file:// 网址）→ 按顺序的文件名 */
export function parsePathList(text) {
  const out = [];
  for (let s of String(text ?? '').split(LINES)) {
    s = s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!s) continue;
    if (/^file:\/\//i.test(s)) { try { s = decodeURIComponent(s.replace(/^file:\/\/[^/]*/i, '')); } catch (e) { /* 保留原样 */ } }
    const name = nfc(s.split(/[\\/]/).pop()).trim();
    if (name) out.push(name);
  }
  return out;
}

// 音频扩展名：只去掉这些（「1.5 小时」这种不当扩展名）
const AUDIO_EXT = /\.(m4a|mp4|m4v|aac|caf|wav|webm|ogg|oga|opus|mp3|qta)$/i;
const baseOf = name => nfc(String(name ?? '').split(/[\\/]/).pop()).replace(AUDIO_EXT, '').trim();
const DT_CHARS = '[\\d\\s\\-_.:/,，年月日号號时時分秒点點]*';
const PURE_DT = new RegExp(`^${DT_CHARS}(?:am|pm|a\\.m\\.|p\\.m\\.|上午|下午|凌晨|早上|中午|晚上)?${DT_CHARS}$`, 'i');

/**
 * 语音备忘录 / 录音软件的默认名 → true（这种名字不拿去原话里找，也不当分享 / 备份时的文件名）：
 * 地址（「123 Main St」，Voice Memos 用位置命名）、「新录音 3」「新錄音 3」「New Recording 3」、
 * 「Audio Recording …」（QuickTime）、纯日期时间（「2024-10-05 10.15」「20241005」）、一串十六进制 / UUID。
 */
export function isDefaultRecordingName(name) {
  const b = baseOf(name);
  if (!b) return true;
  if (/^\d+\s+\S/.test(b)) return true;
  if (/^(?:新录音|新錄音|新規録音|New Recording|Recording|录音|錄音|Audio)(?:\s*\d+)?$/i.test(b)) return true;
  if (/^Audio Recording\b/i.test(b)) return true;
  if (/\d/.test(b) && PURE_DT.test(b)) return true;
  if (/^[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i.test(b) || /^[0-9a-f]{16,}$/i.test(b)) return true;
  return false;
}

/** 文件名里写的日期 → [{ y: number|null, m, d }]（「10-5标题」「10.5」「10月5日」「2024-10-05」「20241005」） */
export function nameDates(name) {
  const b = baseOf(name).normalize('NFKC'), out = [];
  const add = (y, m, d) => {
    m = Number(m); d = Number(d); y = y == null ? null : Number(y);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && !out.some(x => x.y === y && x.m === m && x.d === d)) out.push({ y, m, d });
  };
  for (const r of b.matchAll(/(?<!\d)(\d{4})\s*[-._/年]\s*(\d{1,2})\s*[-._/月]\s*(\d{1,2})(?!\d)/g)) add(r[1], r[2], r[3]);
  for (const r of b.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)) add(r[1], r[2], r[3]);
  if (!out.length) {
    for (const r of b.matchAll(/(?<!\d)(\d{1,2})\s*[-.]\s*(\d{1,2})(?!\d)/g)) add(null, r[1], r[2]);
    for (const r of b.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})/g)) add(null, r[1], r[2]);
  }
  return out;
}
const dateHit = (nd, date) => {
  if (!date) return false;
  const [y, m, d] = date.split('-').map(Number);
  return nd.m === m && nd.d === d && (nd.y == null || nd.y === y);
};

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/**
 * 录音文件里的时间（mp4 创建时间）算不算这一天：当地日期同一天，或第二天中午 12 点前（夜里过了零点才录的）。
 * 算 → { date, time }（当地日期和钟表时间），不算或不知道 → null
 * @param {Date|number|string|null} createdAt
 * @param {string} date  'YYYY-MM-DD'
 * @param {string} [tz]  IANA 时区；不填用本机
 */
export function recordedOnDate(createdAt, date, tz) {
  if (createdAt == null || !date) return null;
  const p = localParts(createdAt, tz);
  if (!p) return null;
  return p.date === date || (p.date === nextDay(date) && p.time < '12:00') ? p : null;
}

// 文件名（去掉日期数字后的汉字部分）在原话里连续出现的最长长度
function longestHanRun(title, text) {
  let best = 0;
  for (const [run] of title.matchAll(/\p{Script=Han}{2,}/gu)) {
    const cs = [...run];
    for (let len = cs.length; len > Math.max(best, 1); len--) {
      let hit = false;
      for (let a = 0; a + len <= cs.length && !hit; a++) hit = text.includes(cs.slice(a, a + len).join(''));
      if (hit) { best = len; break; }
    }
  }
  return best;
}

// 文件名和原话的吻合程度：2 = 整个出现，1 = 有 ≥2 个连续汉字出现，0 = 没有
const titleLevel = (ftitle, ftext) => (!ftitle ? 0 : ftext.includes(ftitle) ? 2 : longestHanRun(ftitle, ftext) >= 2 ? 1 : 0);

const CODES = ['pathOrder', 'nameDate', 'titleInText', 'mp4Date', 'order'];
const SCORE = { pathOrder: 1000, nameDate: 40, mp4Date: 40, titleInText: 40, order: 5 };
const sameName = (a, b) => nfc(a).toLowerCase() === nfc(b).toLowerCase();
const ms = v => (v == null ? NaN : +(v instanceof Date ? v : new Date(v)));

/**
 * 给每个录音位置（按笔记里的顺序）推荐一个文件，并写明依据：
 * - pathOrder：粘贴的路径列表里第 n 个正好是这个文件（最可靠）
 * - nameDate：文件名里的日期（10-5 / 10.5 / 10月5日）是这一条的日期
 * - titleInText：文件名（默认名除外）简繁折叠后出现在原话里；或文件名里有连续 ≥2 个汉字出现在原话里（titleMatch: 'partial'）
 * - mp4Date：录音文件的创建时间是这一天，或第二天中午前
 * - order：没有路径列表、文件数和位置数相同时按顺序对（有 mp4 时间就按时间排）
 * 有 pathOrder 或 ≥2 条依据 → 'strong'，否则 'weak'；文件自己的依据指向别处（录音时间、文件名日期不是这一天，文件名和别的条目更吻合，
 * 路径列表里排在别处，路径列表个数对不上）→ conflict，conflicts 里写是哪几条。
 * 一个文件只配给一个位置；配不上的位置 fileName 为 null。
 * @param {Array} entries  parseNote 的 entries（用到 key、date、text、audioSlots）
 * @param {Array<{name, size, createdAt: Date|null, lastModified: number}>} files
 * @param {{pathOrder?: string[], tz?: string}} [opts]
 * @returns {Array<{slot: number, entrySlot: number, entryKey: string, fileName: string|null, evidence: string[],
 *   confidence: 'strong'|'weak', conflict: boolean, conflicts: string[], titleMatch?: 'full'|'partial', expectedName?: string}>}
 */
export function suggestPairs(entries, files, { pathOrder, tz } = {}) {
  const slots = [];
  for (const e of entries || []) {
    const ftext = fold(e.text);
    for (let j = 0; j < (e.audioSlots || 0); j++) slots.push({ slot: slots.length, entrySlot: j, e, ftext });
  }
  const fl = (files || []).map((f, i) => {
    const name = nfc(f.name), def = isDefaultRecordingName(name);
    return { i, name, at: ms(f.createdAt), ftitle: def ? '' : fold(baseOf(name)), dates: nameDates(name), createdAt: f.createdAt ?? null };
  });
  const order = Array.isArray(pathOrder) && pathOrder.length ? pathOrder.map(nfc) : null;
  const pathCountOff = !!order && order.length !== slots.length;
  let byOrder = null;
  if (!order && fl.length && fl.length === slots.length) {
    byOrder = fl.every(x => Number.isFinite(x.at)) ? [...fl].sort((a, b) => a.at - b.at || a.i - b.i) : fl;
  }

  const judge = (s, x) => {
    const ev = new Set();
    let titleMatch;
    if (order && order[s.slot] && sameName(order[s.slot], x.name)) ev.add('pathOrder');
    if (x.dates.some(nd => dateHit(nd, s.e.date))) ev.add('nameDate');
    const lv = titleLevel(x.ftitle, s.ftext);
    if (lv) { titleMatch = lv === 2 ? 'full' : 'partial'; ev.add('titleInText'); }
    if (recordedOnDate(x.createdAt, s.e.date, tz)) ev.add('mp4Date');
    if (byOrder && byOrder[s.slot] === x) ev.add('order');
    const evidence = CODES.filter(c => ev.has(c));
    let score = evidence.reduce((n, c) => n + SCORE[c], 0);
    if (titleMatch === 'partial') score -= 25;   // 部分命中比整个文件名命中弱
    return { evidence, score, titleMatch };
  };

  // 所有（位置, 文件）组合打分，分高的先配；同分时位置靠前的配时间早的
  const pairs = [];
  for (const s of slots) for (const x of fl) {
    const j = judge(s, x);
    if (j.score > 0) pairs.push({ s, x, ...j });
  }
  pairs.sort((a, b) => b.score - a.score || a.s.slot - b.s.slot || (a.x.at || 0) - (b.x.at || 0) || a.x.i - b.x.i);
  const bySlot = new Map(), used = new Set();
  for (const p of pairs) {
    if (bySlot.has(p.s.slot) || used.has(p.x.i)) continue;
    bySlot.set(p.s.slot, p); used.add(p.x.i);
  }

  return slots.map(s => {
    const p = bySlot.get(s.slot);
    const row = { slot: s.slot, entrySlot: s.entrySlot, entryKey: s.e.key, fileName: null, evidence: [], confidence: 'weak', conflict: false, conflicts: [] };
    if (order && order[s.slot]) row.expectedName = order[s.slot];
    if (!p) return row;
    const x = p.x, why = [];
    if (order) {
      const at = order.findIndex(n => sameName(n, x.name));
      const want = order[s.slot] && fl.find(f => sameName(f.name, order[s.slot]));
      if ((at >= 0 && at !== s.slot) || (want && want !== x)) why.push('pathOrder');
      if (pathCountOff && p.evidence.includes('pathOrder')) why.push('pathCount');
    }
    if (x.dates.length && !x.dates.some(nd => dateHit(nd, s.e.date))) why.push('nameDate');
    if (x.ftitle && slots.some(o => o.e !== s.e && titleLevel(x.ftitle, o.ftext) > titleLevel(x.ftitle, s.ftext))) why.push('titleInText');
    if (Number.isFinite(x.at) && !p.evidence.includes('mp4Date')) why.push('mp4Date');
    Object.assign(row, {
      fileName: x.name, evidence: p.evidence,
      confidence: p.evidence.includes('pathOrder') || p.evidence.length >= 2 ? 'strong' : 'weak',
      conflict: why.length > 0, conflicts: why,
    });
    if (p.titleMatch) row.titleMatch = p.titleMatch;
    return row;
  });
}
