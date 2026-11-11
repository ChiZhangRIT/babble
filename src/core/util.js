// 小工具：不碰 DOM，Node 里也能用（测试、各个 core 模块共用）。

export const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
export const pad2 = n => String(n).padStart(2, '0');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 记录 id、设置的键：不许用 __proto__ 之类（同步来的文件或备份可能被人改过）
const SAFE_KEY = /^[A-Za-z0-9_.:@-]{1,200}$/;
export const safeKey = k => typeof k === 'string' && SAFE_KEY.test(k) && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

/** 连续调用只执行最后一次：debounce(fn, 3000) → f()；f.cancel()、f.flush() */
export function debounce(fn, ms) {
  let timer = null, args = null;
  const f = (...a) => { args = a; clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, ms); };
  f.cancel = () => { clearTimeout(timer); timer = null; };
  f.flush = () => { if (timer) { f.cancel(); fn(...args); } };
  f.pending = () => timer !== null;
  return f;
}

/** 文件名拆成 主名 + 扩展名（「测试录音.m4a」→ ['测试录音', 'm4a']） */
export function splitExt(name) {
  const s = str(name).split(/[\\/]/).pop();
  const i = s.lastIndexOf('.');
  return i > 0 ? [s.slice(0, i), s.slice(i + 1).toLowerCase()] : [s, ''];
}
/** 路径里的文件名 */
export const baseName = p => str(p).split(/[\\/]/).pop();

/** 1536 → '1.5 KB'；null → '' */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 文件名里不能用的字符（/\:*?"<>| 和控制字符）换掉，去掉首尾空格和点 */
export function sanitizeFileName(s, max = 80) {
  // eslint-disable-next-line no-control-regex
  const out = str(s).replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return [...out].slice(0, max).join('').trim();
}

/** 去重（保持原顺序） */
export const uniq = arr => [...new Set(arr)];
