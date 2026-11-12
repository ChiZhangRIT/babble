// 界面文字：简体中文 / 繁體中文（台灣） / English。各部分的文案在 src/strings/*.js，这里合并成一张表。
// t('key', { n: 3 })：{n} 换成变量；文案也可以是函数 (vars, { lang, num }) => 字符串（单复数之类）。
// 用户写的内容（原话、标题、名字）永远不经过 t()，也不做简繁转换。
import { STRINGS as core } from './strings/core.js';
import { STRINGS as list } from './strings/list.js';
import { STRINGS as more } from './strings/more.js';
import { STRINGS as cal } from './strings/cal.js';
import { STRINGS as history } from './strings/history.js';
import { STRINGS as stt } from './strings/stt.js';

export const LANGS = ['zh-Hans', 'zh-Hant-TW', 'en'];
export const LANG_LABELS = { 'zh-Hans': '简体中文', 'zh-Hant-TW': '繁體中文（台灣）', en: 'English' };
export const TABLES = { core, list, more, cal, history, stt };

/** 各部分合并成 { 'zh-Hans': {...}, 'zh-Hant-TW': {...}, en: {...} }；同一个键出现两次时后面的覆盖前面的（测试会查重复） */
export const STRINGS = Object.fromEntries(LANGS.map(l => [l, Object.assign({}, ...Object.values(TABLES).map(tb => (tb && tb[l]) || {}))]));

let lang = 'zh-Hans';
export const getLang = () => lang;
export function setLang(l) { lang = LANGS.includes(l) ? l : 'zh-Hans'; return lang; }
/** 第一次打开、还没选过语言时：系统语言列表里有繁体中文（台湾/香港/澳门/Hant）→ zh-Hant-TW，其他中文或没有中文 → zh-Hans。
 *  English 只在设置里明确选了才用（iPhone 系统语言是英文的也先显示简体，和说明文字一致） */
export function guessLang(langs = (globalThis.navigator && (navigator.languages || [navigator.language])) || []) {
  for (const raw of langs) {
    const l = String(raw || '').toLowerCase();
    if (/^zh-(tw|hk|mo)|^zh-hant/.test(l)) return 'zh-Hant-TW';
    if (l.startsWith('zh')) return 'zh-Hans';
  }
  return 'zh-Hans';
}

const num = (v, digits = 0) => (v == null || !Number.isFinite(Number(v)) ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Number(v)));

export function t(key, vars = {}) {
  const s = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS['zh-Hans'][key] ?? key;
  if (typeof s === 'function') return s(vars || {}, { lang, num });
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}
/** 有没有这个键（可选文案用） */
export const has = key => STRINGS['zh-Hans'][key] !== undefined;
