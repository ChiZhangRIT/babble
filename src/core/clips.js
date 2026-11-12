// 录音的名字：条目 audio[] 里每段可以有用户起的 name（显示、分享、备份时的文件名用它）；origName 是导入时的原文件名，永远不改。
// 显示名 = name → origName 去掉扩展名 → 「录音 1」（这一句由页面传进来，core 不碰界面语言）。
// 同步到 GitHub 的录音文件还是 audio/<sha256>.<ext>，改名不改那边。
import { sanitizeFileName, splitExt, str } from './util.js';
import { isDefaultRecordingName } from './notesImport.js';

export const CLIP_NAME_MAX = 80;

/** 用户输入的名字整理一下：文件名里不能用的字符（/\:*?"<>| 和控制字符）换成空格、合并空白、去掉首尾空格和点，最长 80 个字 */
export const cleanClipName = (s) => sanitizeFileName(s, CLIP_NAME_MAX);

/** 原文件名去掉扩展名（「测试录音.m4a」→「测试录音」）；没有 → '' */
export function origBase(clip) {
  const n = str(clip && clip.origName).trim();
  if (!n) return '';
  const [base, ext] = splitExt(n);
  return (/^[a-z0-9]{1,5}$/.test(ext) ? base : n).trim();     // 「11.5 晚上」这种不是扩展名
}

/** 用户起的名字（没起 / 只有空格 → ''） */
export const ownName = (clip) => (clip && typeof clip.name === 'string' ? clip.name.trim() : '');

/** 有意义的名字：起的名字 → 原文件名（去扩展名）；都没有 → ''（页面用「录音 1」顶上） */
export const clipName = (clip) => ownName(clip) || origBase(clip);

/**
 * 显示名
 * @param {object} clip
 * @param {number} i            第几段（从 0 开始）
 * @param {(n: number) => string} [fallback]  没名字时的叫法，如 n => t('clip.fallback', { n })
 */
export function clipLabel(clip, i = 0, fallback = (n) => `录音 ${n}`) {
  return clipName(clip) || fallback(i + 1);
}

/**
 * 改名：返回新的 audio 列表（不改原来的数组和对象）。名字整理后是空的、或者和默认名（原文件名）一样 → 去掉 name，回到默认。
 * 找不到这段 / 名字没变 → 原样返回同一个数组（页面据此判断要不要保存）
 */
export function renameClip(audio, sha256, name) {
  const list = Array.isArray(audio) ? audio : [];
  const i = list.findIndex(a => a && a.sha256 === sha256);
  if (i < 0) return list;
  const clean = cleanClipName(name);
  const next = { ...list[i] };
  if (!clean || clean === origBase(next)) delete next.name; else next.name = clean;
  if ((next.name || '') === (list[i].name || '')) return list;
  return list.map((a, k) => (k === i ? next : a));
}

/**
 * 当文件名用的名字：起的名字 → 原文件名（去扩展名，语音备忘录的默认名「新录音 3」/ 地址不算）→ ''（调用的地方用日期和 NN 的第一句起名）。
 * 已经整理过，能直接放进文件名
 */
export function clipFileStem(clip) {
  const own = cleanClipName(ownName(clip));
  if (own) return own;
  const base = origBase(clip);
  return base && !isDefaultRecordingName(base) ? cleanClipName(base) : '';
}
