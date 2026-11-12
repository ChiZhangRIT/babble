// 备份 zip：babble.json（全部数据 + 录音文件对照表）、audio/ 下的录音（按日期和录音的名字 / 第一句起名）、梦话.md（人能直接读的版本）。
// 恢复 = 逐条合并（不覆盖、不删除），恢复前先确认（页面负责）。每段录音按 sha256 校验，对不上的不恢复。
import { createZip, readZip } from './zip.js';
import { sha256Hex } from './sha256.js';
import { normalizeState, live, byNewest } from './store.js';
import { extForMime } from './audioStore.js';
import { fmtEntryDate, fmtDuration, fmtDate, today } from './dates.js';
import { firstNNLine } from './dialogue.js';
import { isObj, sanitizeFileName, splitExt } from './util.js';
import { clipFileStem } from './clips.js';

export const BACKUP_JSON = 'babble.json';
const MIME_BY_EXT = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav' };
const SHA = /^[0-9a-f]{64}$/;

// 梦话.md 的文字（只有这几句，不进 i18n 文案表：core 模块不碰界面语言状态）
const MD = {
  'zh-Hans': { file: '梦话.md', title: '牙牙呓语', exported: '导出于 {date}', count: '共 {n} 条 · {a} 段录音', note: '那天的背景', draft: '草稿',
    inbox: '（待整理）', audio: '录音', missing: '这台设备上没有这段录音，没有放进备份' },
  'zh-Hant-TW': { file: '夢話.md', title: '牙牙囈語', exported: '匯出於 {date}', count: '共 {n} 則 · {a} 段錄音', note: '那天的背景', draft: '草稿',
    inbox: '（待整理）', audio: '錄音', missing: '這臺裝置上沒有這段錄音，沒有放進備份' },
  en: { file: 'sleep-talk.md', title: 'Babble · 牙牙呓语', exported: 'Exported {date}', count: '{n} entries · {a} recordings', note: 'Background', draft: 'Draft',
    inbox: ' (to tidy)', audio: 'Recording', missing: 'not on this device, so not included in this backup' },
};
const md = lang => MD[lang] || MD['zh-Hans'];
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
/** 备份里那份人能读的文件名：梦话.md / 夢話.md / sleep-talk.md */
export const markdownName = (lang = 'zh-Hans') => md(lang).file;

/** 备份文件名：牙牙呓语备份 2026-11-11.zip */
export function backupFileName(date = new Date(), lang = 'zh-Hans') {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return (lang === 'en' ? 'babble-backup ' : lang === 'zh-Hant-TW' ? '牙牙囈語備份 ' : '牙牙呓语备份 ') + d + '.zip';
}

const QUOTES = /[“”‘’「」『』"'«»„‟‹›〝〞＂＇]/g;
/**
 * 录音在备份里的文件名：「2026-11-04 录音的名字 (sha前8位).m4a」；录音没起名（原文件名也是默认的）→ 用 NN 的第一句（去掉引号和文件名里不能用的字符）。
 * 条目没有标题：旧数据里存着的 title 不用
 */
export function clipFileName(entry, clip, speakers) {
  const words = clipFileStem(clip) || sanitizeFileName(String(firstNNLine(entry.text || '', speakers) || '').replace(QUOTES, ''), 24);
  return `${entry.date}${words ? ' ' + words : ''} (${clip.sha256.slice(0, 8)}).${extForMime(clip.mime)}`;
}

const oldestFirst = (a, b) => byNewest(b, a);
const validDate = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

/**
 * @param {object} state        app 数据
 * @param {object} audioStore   src/core/audioStore.js
 * @param {{lang?: string, getBlob?: (sha) => Promise<Blob|null>, now?: Date, info?: object}} [opts]
 *        getBlob：本机没有的录音去哪拿（比如 ctx.clipBlob，会从云端下载）；info：传一个空对象进来，会填上
 *        { entries, clips, missing: [sha…], bytes }（页面用来提示「N 段录音不在这台设备上」）
 * @returns {Promise<Blob>} zip
 */
export async function buildBackup(state, audioStore, { lang = 'zh-Hans', getBlob = null, now = new Date(), info = null } = {}) {
  const s = normalizeState(state);
  const speakers = s.settings.speakers;
  // 每段录音只放一份，用最早引用它的条目起名；没删除的条目优先（已删除条目的录音本机有就带上，没有不去下载）
  const all = Object.values(s.data.entries).sort(oldestFirst);
  const owners = new Map();
  for (const e of [...all.filter(e => !e.deleted), ...all.filter(e => e.deleted)]) {
    for (const a of e.audio) if (!owners.has(a.sha256)) owners.set(a.sha256, { e, a });
  }
  const files = {}, zipFiles = [], missing = [], names = new Set();
  for (const [sha, { e, a }] of owners) {
    const rec = await Promise.resolve(audioStore && audioStore.getClip(sha)).catch(() => null);
    let blob = (rec && rec.blob) || null;
    if (!blob && getBlob && !e.deleted) blob = await Promise.resolve(getBlob(sha)).catch(() => null);
    if (!blob) { if (!e.deleted) missing.push(sha); continue; }
    let path = 'audio/' + clipFileName(e, a, speakers);
    if (names.has(path)) path = `audio/${e.date} (${sha}).${extForMime(a.mime)}`;   // sha 前 8 位撞了（几乎不可能）
    names.add(path);
    files[sha] = path;
    zipFiles.push({ name: path, data: blob, date: validDate(e.recordedAt) || validDate(a.addedAt) || now });
  }
  const json = { app: 'babble', v: 1, kind: 'backup', exportedAt: now.toISOString(), state, files };
  if (missing.length) json.missing = missing;
  const zip = await createZip([
    { name: BACKUP_JSON, data: JSON.stringify(json, null, 1), date: now },
    { name: markdownName(lang), data: backupMarkdown(s, { lang, files, now }), date: now },
    ...zipFiles,
  ]);
  if (info && typeof info === 'object') Object.assign(info, { entries: live(s).length, clips: Object.keys(files).length, missing, bytes: zip.size });
  return zip;
}

// 行首会被 Markdown 当成标题 / 引用 / 列表 / 分隔线的符号前面加 \（只影响显示，读纯文本时几乎看不出）
const BLOCK = /^(#{1,6}(\s|$)|>|[-+*](\s|$)|`{3}|~{3}|<|\||[-*_=]{3,}\s*$|=+\s*$)/;
function mdLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map(l => {
    const line = l.trimStart();                       // 和 App 里显示一样：行首空格不算（不然 4 个空格会变成代码块）
    if (!line.trim()) return '';
    const esc = BLOCK.test(line) ? '\\' + line : line.replace(/^(\d{1,9})([.)])(\s|$)/, '$1\\$2$3');
    return esc + '  ';                                // 行尾两个空格 = 换行，原话一行还是一行
  });
}
const trimBlank = lines => { let a = 0, b = lines.length; while (a < b && !lines[a]) a++; while (b > a && !lines[b - 1]) b--; return lines.slice(a, b); };
const quoteBlock = (label, text) => ['> **' + label + '**  ', ...trimBlank(mdLines(text)).map(l => (l ? '> ' + l : '>'))];

/**
 * 人能直接读的版本：按年分节、从旧到新，像原来的备忘录。原话逐字照抄（引号不配对也不改）
 * @param {object} state  整理过的数据（normalizeState）
 * @param {{lang?: string, files?: {[sha]: string}, now?: Date}} [opts]  files：sha → 备份里的路径（用来链接录音）
 */
export function backupMarkdown(state, { lang = 'zh-Hans', files = {}, now = new Date() } = {}) {
  const T = md(lang);
  const entries = live(state).sort(oldestFirst);
  const nClips = new Set(entries.flatMap(e => (e.audio || []).map(a => a.sha256))).size;
  const out = [`# ${T.title}`, '', fill(T.exported, { date: fmtDate(today(now), lang) }) + ' · ' + fill(T.count, { n: entries.length, a: nClips }), ''];
  let year = null;
  for (const e of entries) {
    const y = e.date.slice(0, 4);
    if (y !== year) { out.push(`## ${y}`, ''); year = y; }
    out.push(`### ${fmtEntryDate(e, lang, { sep: ' ' })}${e.fav ? ' ⭐' : ''}${e.status === 'inbox' ? T.inbox : ''}`, '');   // 只有日期时间（条目没有标题）
    const clips = e.audio || [];
    if (clips.length) {
      clips.forEach((a, i) => {
        // eslint-disable-next-line no-control-regex
        const name = clipFileStem(a).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').replace(/[[\]<\\]/g, '\\$&');   // 录音的名字（链接文字里 [ ] < 要转义）
        const label = `🎙 ${T.audio}${clips.length > 1 ? ' ' + (i + 1) : ''}${name ? ' · ' + name : ''}${a.durationSec != null ? ' · ' + fmtDuration(a.durationSec) : ''}`;
        out.push((files[a.sha256] ? `[${label}](<${files[a.sha256]}>)` : `${label}（${T.missing}）`) + '  ');
      });
      out.push('');
    }
    const body = trimBlank(mdLines(e.text || ''));
    if (body.length) out.push(...body, '');
    if (String(e.note || '').trim()) out.push(...quoteBlock(T.note, e.note), '');
    if (e.draft && String(e.draft.text || '').trim()) out.push(...quoteBlock(T.draft + (e.draft.source ? ` · ${e.draft.source}` : ''), e.draft.text), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** 读备份出错：code = 'badBackup' */
export class BackupError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

async function head(input, n) {
  if (input instanceof Uint8Array) return input.subarray(0, n);
  if (input instanceof ArrayBuffer) return new Uint8Array(input, 0, Math.min(n, input.byteLength));
  if (input && typeof input.slice === 'function') return new Uint8Array(await input.slice(0, n).arrayBuffer());
  throw new BackupError('badBackup');
}
async function allText(input) {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) return new TextDecoder().decode(input);
  return input.text();
}
function parseJSON(text) {
  let d = null;
  try { d = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (e) { d = null; }
  if (!isObj(d) || d.app !== 'babble' || !isObj(d.state)) throw new BackupError('badBackup');
  return d;
}

/**
 * 读备份（校验每段录音的 sha256）。也认单独的 JSON：安全模式导出的 babble-data.json、数据仓库里的 babble.json
 * @param {Blob|Uint8Array|ArrayBuffer} blob
 * @returns {Promise<{state: object, clips: Array<{sha256: string, blob: Blob, mime: string}>,
 *                    bad: string[], missing: string[], exportedAt: string|null}>}
 *          bad：录音文件和 sha256 对不上（没放进 clips）；missing：对照表里有、zip 里没有的录音
 */
export async function readBackup(blob) {
  const sig = await head(blob, 4);
  if (!(sig[0] === 0x50 && sig[1] === 0x4b)) {               // 不是 zip（PK 开头）：当 JSON 读
    const d = parseJSON(await allText(blob));
    return { state: normalizeState(d.state), clips: [], bad: [], missing: [], exportedAt: d.exportedAt || d.savedAt || null };
  }
  let files;
  try { files = await readZip(blob); } catch (e) { throw new BackupError('badBackup', e && e.code); }
  // babble.json 一般在最外层；在 Mac 上解压后又整个文件夹压缩的话，会多一层目录
  const nfc = s => String(s).normalize('NFC');
  const jsonFile = files.filter(f => f.name === BACKUP_JSON || f.name.endsWith('/' + BACKUP_JSON))
    .filter(f => !f.name.startsWith('__MACOSX/'))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!jsonFile) throw new BackupError('badBackup');
  const base = jsonFile.name.slice(0, jsonFile.name.length - BACKUP_JSON.length);
  const d = parseJSON(new TextDecoder().decode(jsonFile.data));
  const state = normalizeState(d.state);
  const mimes = new Map();
  for (const e of Object.values(state.data.entries)) for (const a of e.audio) if (!mimes.has(a.sha256)) mimes.set(a.sha256, a.mime);
  const byName = new Map(files.map(f => [nfc(f.name), f]));
  const clips = [], bad = [], missing = [];
  for (const [key, path] of Object.entries(isObj(d.files) ? d.files : {})) {
    const sha = String(key).toLowerCase();
    if (!SHA.test(sha) || typeof path !== 'string') continue;
    const f = byName.get(nfc(base + path));
    if (!f) { missing.push(sha); continue; }
    if (await sha256Hex(f.data) !== sha) { bad.push(sha); continue; }       // 文件坏了或被改过：这段不恢复
    const mime = mimes.get(sha) || MIME_BY_EXT[splitExt(path)[1]] || 'audio/mp4';
    clips.push({ sha256: sha, blob: new Blob([f.data], { type: mime }), mime });
  }
  return { state, clips, bad, missing, exportedAt: d.exportedAt || null };
}

/**
 * 恢复：先存录音（条目合并进来时录音已经在本机），再逐条合并（ctx.mergeIn，较新的为准，不删本机的条目）
 * @param {{state, clips}} backup  readBackup 的结果
 * @param {{audioStore: object, mergeIn: (state) => {changed: number}}} deps
 * @returns {Promise<{changed: number, clips: number}>}  clips = 新存进本机的录音段数
 */
export async function restoreBackup(backup, { audioStore, mergeIn }) {
  let n = 0;
  for (const c of (backup && backup.clips) || []) {
    if (await audioStore.hasClip(c.sha256)) continue;
    await audioStore.putClip(c.blob, { mime: c.mime });
    n++;
  }
  const r = mergeIn(backup.state) || {};
  return { changed: r.changed || 0, clips: n };
}
