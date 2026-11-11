// 日期和时间。条目的 date 是「那一天」（'YYYY-MM-DD'，不带时区，凌晨的录音也算当天的日历日期），
// time 是当地钟表时间 'HH:MM' 或 null（不知道就是 null，不猜）。格式化只分中文 / 英文两套。
import { pad2 } from './util.js';

export const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
/** 真实存在的日历日期（2026-02-30 不算） */
export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const toDate = v => (v instanceof Date ? v : typeof v === 'number' || typeof v === 'string' ? new Date(v) : null);
const valid = d => d instanceof Date && !Number.isNaN(d.getTime());

/** 本机时区的今天 'YYYY-MM-DD' */
export function today(now = new Date()) {
  const d = toDate(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 本机时区的现在 'HH:MM' */
export const nowTime = (now = new Date()) => { const d = toDate(now); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
/** 本机的 IANA 时区（如 'America/Los_Angeles'），拿不到就是 null */
export function systemTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
}

const fmtCache = new Map();
function partsFormatter(tz) {
  const key = tz || '';
  if (!fmtCache.has(key)) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    let f;
    try { f = new Intl.DateTimeFormat('en-US', tz ? { ...opts, timeZone: tz } : opts); }
    catch (e) { f = new Intl.DateTimeFormat('en-US', opts); }   // 不认识的时区名：退回本机时区
    fmtCache.set(key, f);
  }
  return fmtCache.get(key);
}

/**
 * 某一刻在某个时区的日历日期和钟表时间
 * @param {Date|number|string} date  Date、毫秒时间戳或 ISO 字符串
 * @param {string} [tz]              IANA 时区；不填用本机时区
 * @returns {{date: string, time: string} | null}
 */
export function localParts(date, tz) {
  const d = toDate(date);
  if (!valid(d)) return null;
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(d).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}

const minutes = s => (isTime(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);
/** 现在是不是夜间时段（默认 21:00–07:00，可以跨午夜；起止相同 = 没有夜间） */
export function isNight(now = new Date(), settings = {}) {
  const start = minutes(settings.nightStart ?? '21:00'), end = minutes(settings.nightEnd ?? '07:00');
  const d = toDate(now);
  if (start == null || end == null || start === end || !valid(d)) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** 'HH:MM' → 'lateNight'(0–5) | 'morning'(5–12) | 'afternoon'(12–18) | 'evening'(18–24)；不知道时间 → null */
export function daypart(time) {
  if (!isTime(time)) return null;
  const h = Number(time.slice(0, 2));
  return h < 5 ? 'lateNight' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}
const DAYPART = {
  'zh-Hans': { lateNight: '凌晨', morning: '早上', afternoon: '下午', evening: '晚上' },
  'zh-Hant-TW': { lateNight: '凌晨', morning: '早上', afternoon: '下午', evening: '晚上' },
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const isEn = lang => lang === 'en';

/** 'HH:MM' → 凌晨2:58 / 下午1:05 / 2:58 AM；null → '' */
export function fmtTime(time, lang = 'zh-Hans') {
  if (!isTime(time)) return '';
  const H = Number(time.slice(0, 2)), mm = time.slice(3);
  if (isEn(lang)) return `${H % 12 || 12}:${mm} ${H < 12 ? 'AM' : 'PM'}`;
  const h12 = H > 12 ? H - 12 : H;          // 凌晨0:46、中午过后 下午12:30
  return (DAYPART[lang] || DAYPART['zh-Hans'])[daypart(time)] + h12 + ':' + mm;
}

/** 'YYYY-MM-DD' → 2026年11月4日 / Nov 4, 2026；year: false → 11月4日 / Nov 4。格式不对就原样返回 */
export function fmtDate(iso, lang = 'zh-Hans', { year = true } = {}) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso == null ? '' : String(iso);
  const [y, m, d] = iso.split('-').map(Number);
  if (isEn(lang)) return year ? `${MON[m - 1]} ${d}, ${y}` : `${MON[m - 1]} ${d}`;
  return year ? `${y}年${m}月${d}日` : `${m}月${d}日`;
}

/**
 * 条目的日期行：2026年11月4日 · 凌晨2:58 / Nov 4, 2026 · 2:58 AM（不知道时间就只有日期）
 * @param {{date: string, time?: string|null}} entry
 * @param {string} lang
 * @param {{year?: boolean, sep?: string}} [opts]  year: false 时省掉年份（列表里已经按年分组）
 */
export function fmtEntryDate(entry, lang = 'zh-Hans', { year = true, sep = ' · ' } = {}) {
  if (!entry) return '';
  const d = fmtDate(entry.date, lang, { year });
  const t = fmtTime(entry.time, lang);
  return t ? d + sep + t : d;
}

/** 某一刻（毫秒或 ISO）按本机时区显示：11月4日 凌晨2:58。用于「删除于」「上次同步」之类 */
export function fmtInstant(ms, lang = 'zh-Hans', { year = false } = {}) {
  const p = localParts(ms);
  if (!p) return '';
  return fmtDate(p.date, lang, { year }) + ' ' + fmtTime(p.time, lang);
}

/** 'YYYY-MM' → 2026年11月 / November 2026；year: false → 11月 / November */
export function fmtMonth(key, lang = 'zh-Hans', { year = true } = {}) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}/.test(key)) return '';
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7));
  if (isEn(lang)) return year ? `${MONTH[m - 1]} ${y}` : MONTH[m - 1];
  return year ? `${y}年${m}月` : `${m}月`;
}
/** 2026 → 2026年 / 2026 */
export const fmtYear = (y, lang = 'zh-Hans') => (isEn(lang) ? String(y) : `${y}年`);

/** 'YYYY-MM-DD' → 'YYYY-MM'（分组用）；格式不对 → '' */
export const monthKey = date => (typeof date === 'string' && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : '');

/** 秒 → 0:42 / 12:05 / 1:02:03；没有 → '' */
export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}
/** 录音计时器：秒 → 00:42 / 10:00 */
export function fmtTimer(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

/** 某一刻距今几天（按本机日历日算；今天 = 0） */
export function daysAgo(ms, now = new Date()) {
  const p = localParts(ms);
  if (!p) return null;
  const a = Date.UTC(...p.date.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)));
  const [y, m, d] = today(now).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - a) / 86400000);
}
