// 多设备同步：数据在用户自己的 GitHub 私有仓库里，用 GitHub 的 contents API 读写；删录音、「清理云端历史」用 Git Data API（trees / commits / refs）。
//   babble.json = { app:'babble', v:1, device, savedAt, features, state }   features：['purge1'] = 认得永久删除的版本写的（旧版本没有）
//   audio/<sha256>.<ext>   录音（以内容哈希命名，内容不改；永久删除了的会从仓库删掉，提交历史里还在，要「清理云端历史」才没有）
// 每一轮：确认仓库是私有的（5 分钟内确认过就不再问；要传录音时这一轮一定再问一次）→ 先拉取 babble.json、逐条合并（别的设备永久删除了的，这一轮就不会再传上去）
//   （babble.json 读不出来、服务器出错：这一轮报错，但本机的录音照样先传上去）
// → 传本机还没上传、合并后还有条目在用的录音（断网就留到下一轮，文字照常同步）→ 本机有云端没有的改动才上传 babble.json
//   （录音仍然比条目先到云端；带上云端版本号 sha，云端被别的设备改过会返回 409 / 422，这时重新拉取合并再传）
// → 删掉仓库里永久删除了的录音（只删「云端确认过的那一版」和「本机现在」都算永久删除的；分支上的 babble.json 得正是合并过的那份；
//   一次提交删完，分支只快进——中间有人提交就重新列）→ babble.json 这一轮变过（或者是这次打开后的第一轮）：有争议的录音
//   （又有条目在用、又有永久删除的记号）查一下仓库里还在不在，不在了这一轮就重传
// → 在后台下载本机缺的录音（不挡下一轮同步）。每天（新版本第一次跑、别的设备清理过云端历史时马上）把仓库里的录音对一遍：
//   条目在用、本机标着已上传、仓库里却没有的改回待上传。
// 删录音的进度、云端确认过的版本记在 localStorage 的 babble.purge（只在这台设备上，几个标签页共用）。
// 用旧版本（没有 features）传 babble.json 的设备记进同步的 data.oldSeen（{ id, name, at, updatedAt }，键由名字算出来）：每台设备都看得到，
// 不只是正好拉到那一版的那台（「设置 → 同步」据此列出还没更新的设备）。
// 修改记录要的云端历史（commits / fileAt）、「清理云端历史」（squash）、找没有条目在用的录音（orphans，只读）只在用户点了才做，用同一套令牌和出错处理。
import { normalizeState, mergeStates, canon, referencedClips, claimShas, stubShas, goneShas, contestedShas } from './store.js';
import { extForMime, mimeForExt } from './audioStore.js';
import { sha256Hex } from './sha256.js';
import { isObj, safeKey } from './util.js';

export { referencedClips };
export const GH_API = 'https://api.github.com';
export const SYNC_FILE = 'babble.json';
export const CODE_PREFIX = 'babble-sync:';
export const PURGE_KEY = 'babble.purge';      // 删录音的进度（localStorage，只在这台设备上）
export const FEATURES = Object.freeze(['purge1']);   // 写进 babble.json 顶层：认得永久删除的版本
// object 格式：超过 1MB 的文件也能拿到 sha / size（content 为空），默认格式会直接报错
const ACCEPT_OBJ = 'application/vnd.github.object+json', ACCEPT_RAW = 'application/vnd.github.raw+json';
const MISSING_RETRY_MS = 5 * 60 * 1000;      // 云端还没有的录音（对方还没传）：后台 5 分钟内不再问
const PURGED_RETRY_MS = 60 * 60 * 1000;      // 永久删除过、又有条目在用的录音（仓库里的可能删了，等有它的设备重传）：1 小时问一次
const FATAL = ['net', 'auth', 'perm', 'public'];
const VERIFY_MS = 5 * 60 * 1000;              // 「仓库是私有的」确认多久有效（仓库可能被改成公开、删掉重建）
const AUDIT_MS = 24 * 3600 * 1000, AUDIT_V = 1;   // 每天把仓库里的录音对一遍；AUDIT_V 变大（新版本第一次跑）马上对一遍
const AUDIT_RETRY_MS = 60 * 60 * 1000;       // 没有要删的、只是对账没做成：1 小时内不再试（不让每一轮都多几个请求）
const OLD_MS = 30 * 864e5;                    // 用旧版本上传过的设备记 30 天
const ORPHAN_MAX = 100, ORPHAN_AGE_MS = 24 * 3600 * 1000;   // 找没有条目在用的录音：最多看 100 个文件；24 小时内传的先不列
const AUDIO_RE = /^audio\/([0-9a-f]{64})\.([A-Za-z0-9]{1,8})$/;
const keysOf = x => (x instanceof Map ? [...x.keys()] : [...(x || [])]);
/** data.oldSeen 里这个设备名的键（每台设备算出来一样；名字里有中文、空格也行）；太长 → null */
export const oldSeenKey = (name) => { const k = 'o.' + [...String(name)].map(c => c.codePointAt(0).toString(36)).join('.'); return safeKey(k) ? k : null; };

/** 同步出错：带错误代码（显示时再翻译成 syncErr.<code>），网络问题是 'net' */
export class SyncError extends Error {
  constructor(code, vars = {}) { super(code); this.code = code; this.vars = vars; }
}

/** 同步码：babble-sync:<owner/repo>:<token> */
export const syncCode = (repo, token) => `${CODE_PREFIX}${repo}:${token}`;
/** → { repo, token } | null */
export function parseSyncCode(text) {
  const m = String(text || '').trim().match(/^babble-sync:([\w.-]+\/[\w.-]+):(\S+)$/);
  return m ? { repo: m[1], token: m[2] } : null;
}
/** 录音在仓库里的路径 */
export const audioPath = (sha, mime) => `audio/${sha}.${extForMime(mime)}`;

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
export const toB64 = text => bytesToB64(new TextEncoder().encode(text));
export const fromB64 = b64 => new TextDecoder().decode(b64ToBytes(b64));

/** git 的 blob sha（sha1("blob <长度>\0" + 内容)）：GitHub 返回的 sha 就是它，用来确认云端的录音和本机一模一样。
 *  没有 crypto.subtle（局域网 http 打开）→ null，这时只比大小 */
export async function gitBlobSha(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(head.length + bytes.length);
  buf.set(head); buf.set(bytes, head.length);
  const h = await subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 响应头 github-authentication-token-expiration（'2026-12-31 08:00:00 UTC' / '… -0800'）→ 毫秒；没有 / 看不懂 → null */
export function parseTokenExpiry(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const z = m[7];
  if (z && /^[+-]/.test(z)) { const d = z.slice(1).replace(':', ''); ms -= (z[0] === '-' ? -1 : 1) * (Number(d.slice(0, 2)) * 60 + Number(d.slice(2, 4))) * 60000; }
  return Number.isFinite(ms) ? ms : null;
}

/** 条目（含删除了的、移除的录音）里这段录音的 mime；没有 → null */
const mimeOf = (state, sha) => referencedClips(state, { includeDeleted: true, includeRemoved: true }).get(sha) || null;
/** 云端那份里有走了样的墓碑：旧版本在永久删除留下的空白条目上恢复过旧版、打过字（带着内容），或者点了「恢复」（没有 deleted，
 *  旧版本会把它当成没删除的空白条目）。整理时会改回墓碑，要马上传一份干净的 → [[id, 那份的 updatedAt]…] */
const leaks = (raw) => Object.entries(isObj(raw.data) && isObj(raw.data.entries) ? raw.data.entries : {}).filter(([, e]) => isObj(e) && e.purged && (e.deleted !== true ||
  ['title', 'text', 'note'].some(k => typeof e[k] === 'string' && e[k] !== '') || isObj(e.draft) || ['audio', 'removedAudio'].some(k => Array.isArray(e[k]) && e[k].length > 0)))
  .map(([id, e]) => [id, Number(e.updatedAt) || 0]);
/** 云端那份里同一段录音既在 audio、又在 removedAudio：旧版本把新版本移除了的录音又放回去了（旧版本不认识 removedAudio，原样留着那条旧记录）。
 *  整理时那条旧记录会去掉（留 audio）：马上传一份干净的、比那份新 1 毫秒，旧版本按时间直接采用——不然它以后再移除这段时，
 *  那条旧记录还在，合并时被当成更早的移除，录音又回来一次 → [[id, 那份的 updatedAt]…] */
const bothIn = (raw) => Object.entries(isObj(raw.data) && isObj(raw.data.entries) ? raw.data.entries : {}).filter(([, e]) => isObj(e) && !e.purged
  && Array.isArray(e.audio) && Array.isArray(e.removedAudio) && e.removedAudio.some(r => isObj(r) && typeof r.sha256 === 'string'
  && e.audio.some(a => isObj(a) && typeof a.sha256 === 'string' && a.sha256.toLowerCase() === r.sha256.toLowerCase())))
  .map(([id, e]) => [id, Number(e.updatedAt) || 0]);

/**
 * @param {object} o
 * @param {() => object} o.getState                 当前本机数据
 * @param {(merged, info) => void} o.applyRemote    合并出新内容时调用（info.device = 上次写入云端的设备名）
 * @param {() => object|null} o.getConfig           babble.local 里的 sync：{ repo, token, sha, etag, dirty, at, err, offline, tokenExp }；没开同步 → null
 * @param {(cfg) => void} o.saveConfig              保存同步状态（只存本机）
 * @param {() => number} o.editVersion              本机修改计数：上传期间又改过的话，上传完仍然算「有改动」
 * @param {string|(() => string)} o.device          设备名（写进云端；可以是函数，设置里改了名字马上生效）
 * @param {object} o.audioStore                     src/core/audioStore.js（没有就只同步文字，也不删仓库里的录音）
 * @param {(status) => void} [o.onStatus]           进度变化时调用（设置页显示待上传 / 待下载 / 待删除）
 * @param {() => object} [o.getLocal]  @param {() => void} [o.saveLocal]   babble.local：录音同步进度记在 local.audioSync
 * @param {(patch) => void} [o.setLocal]            清理云端历史强制更新之前记下 squashMark = { R, at }（app.js 据此补写 cloudResetAt）；没给就用 getLocal + saveLocal
 * @param {Storage} [o.storage]                     localStorage：删录音的进度记在 babble.purge（几个标签页共用）；没给就放内存
 * @param {typeof fetch} [o.fetch]
 * @returns {{ syncNow(opts?: { forcePush?: boolean, forceAudit?: boolean }): Promise<{ok: boolean, skipped?: boolean, error?: object, offline?: boolean}>,
 *             checkRepo(repo: string, token: string): Promise<string>,
 *             getAudio(sha: string, mime?: string): Promise<Blob|null>,
 *             status(): { running, uploading, downloading, purging, pendingUp, pendingDown, pendingPurge, lastError, tokenExpires, oldDevices },
 *             idle(): Promise<void>,
 *             commits({ page, perPage }): Promise<Array<{ sha, at, message }>>,
 *             fileAt(ref: string): Promise<object|null>,
 *             squash(): Promise<{ ok, already?, commit?, branch?, missing?, error?, skipped? }>,
 *             orphans(): Promise<{ ok, files?: Array<{ sha256, path, ext, size, at, mime }>, recent?, more?, error?, skipped? }>,
 *             historyInfo(): Promise<{ commits: number|null, branch: string|null, others: string[] }|null>,
 *             confirmedGone(): Set<string>|null }}
 */
export function createSync(o) {
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const store = o.audioStore || null;
  const device = () => String((typeof o.device === 'function' ? o.device() : o.device) || '');
  let chain = Promise.resolve();
  let verified = null, verifiedAt = 0, verifiedRound = 0, round = 0;   // 最近确认过是私有仓库的 repo 名、时刻、第几轮
  let branch = null;              // { repo, name }：仓库的默认分支（确认私有时顺便记下；删录音、清理历史改它）
  let contestedOnce = false;      // 这次打开以后查过一次有争议的录音
  let auditFailAt = 0;            // 上次只是对账、没做成的时刻
  const memAudio = {};          // 没给 getLocal 时（测试）录音同步进度放内存里
  const audioSync = () => {
    const L = o.getLocal && o.getLocal();
    if (!L) return memAudio;
    if (!L.audioSync || typeof L.audioSync !== 'object') L.audioSync = {};
    return L.audioSync;
  };
  function saveAudioSync(patch) {
    Object.assign(audioSync(), patch);
    if (o.getLocal && o.saveLocal) o.saveLocal();
  }

  // ---------- 删录音的进度（babble.purge，只存本机；换了仓库从头来） ----------
  // { repo, sha, gone, done:{sha:ms}, verifiedAt:{sha:blob sha}, auditAt, auditV, forceAt, resetSeen, oldPushers:{设备名:ms} }
  //   sha + gone：最近确认云端有的 babble.json（blob sha）和那一版里永久删除了的录音（D8：本机、仓库里的录音都只删这里面的）
  //   done：仓库里确认删掉了的，记的是当时那段记号的 purgedAt（之后又永久删除一次、purgedAt 更大，还会再删；和本机时钟无关）
  //   verifiedAt：有争议的录音在哪一版 babble.json 时确认过仓库里还在
  //   auditAt / auditV / forceAt：上次对账的时刻、版本、要马上对账的时刻；resetSeen：看到过的 cloudResetAt（有设备清理过云端历史）
  //   oldPushers：谁最后一次用旧版本（babble.json 没有 features）上传是什么时候（这台设备看到的；同步的数据里还有 data.oldSeen）。
  //   用新版本上传过不算数（同名的另一台可能还是旧版本），要看它在 data.devices 里第一次报到的时刻
  // 几个标签页共用：写之前重新读一遍合并（表取并集、时间取大的）；sha + gone 每个标签页用和自己的 cfg.sha 对得上的那份
  let pmem = null, P = null;
  const readP = () => {
    try { const v = o.storage ? JSON.parse(o.storage.getItem(PURGE_KEY) || 'null') : pmem; return isObj(v) ? v : null; } catch (e) { return null; }
  };
  const maxMap = (a, b) => {
    const m = { ...(isObj(b) ? b : {}) };
    for (const [k, v] of Object.entries(isObj(a) ? a : {})) m[k] = Math.max(Number(v) || 0, Number(m[k]) || 0);
    return m;
  };
  function mergeP(a, b) {                       // a 是这个标签页的（优先），b 是磁盘上的
    if (!b || b.repo !== a.repo) return a;
    return { ...b, ...a, done: maxMap(a.done, b.done), verifiedAt: { ...(isObj(b.verifiedAt) ? b.verifiedAt : {}), ...a.verifiedAt },
      oldPushers: maxMap(a.oldPushers, b.oldPushers), resetSeen: a.resetSeen ?? b.resetSeen ?? null,
      auditAt: Math.max(a.auditAt || 0, b.auditAt || 0), auditV: Math.max(a.auditV || 0, b.auditV || 0), forceAt: Math.max(a.forceAt || 0, b.forceAt || 0) };
  }
  function purgeState(cfg) {
    if (P && P.repo === cfg.repo) return P;
    const d = readP();
    P = d && d.repo === cfg.repo ? d : { repo: cfg.repo };
    for (const k of ['done', 'verifiedAt', 'oldPushers']) if (!isObj(P[k])) P[k] = {};
    if (!Array.isArray(P.gone)) P.gone = [];
    return P;
  }
  /** 一轮开始：接上别的标签页记下的；确认过的云端版本用和本机 cfg.sha 对得上的那份 */
  function reloadP(cfg) {
    const p = purgeState(cfg), d = readP();
    if (!d || d.repo !== cfg.repo) return;
    const keep = p.sha && p.sha === cfg.sha ? p : d.sha && d.sha === cfg.sha ? d : p;
    Object.assign(p, mergeP(p, d), { sha: keep.sha || null, gone: Array.isArray(keep.gone) ? keep.gone : [] });
  }
  function saveP() {
    if (!P) return;
    Object.assign(P, mergeP(P, readP()));
    try { if (o.storage) o.storage.setItem(PURGE_KEY, JSON.stringify(P)); else pmem = JSON.parse(JSON.stringify(P)); } catch (e) { /* 存不下：下一轮再算 */ }
  }
  /** 记下「云端确认有的版本」：babble.json 的 blob sha，和那一版（整理过的 state）里永久删除了的录音 */
  function confirm(cfg, sha, state) {
    const p = purgeState(cfg);
    p.sha = sha; p.gone = keysOf(goneShas(state)).sort();
    saveP();
  }
  /** 云端确认过的永久删除了的录音（Set）；没开同步、这台设备还没确认过现在的云端版本 → null（本机的录音先别删） */
  function confirmedGone() {
    const cfg = o.getConfig();
    if (!cfg || !cfg.sha) return null;
    const p = purgeState(cfg);
    return p.sha === cfg.sha ? new Set(p.gone) : null;
  }
  /** 仓库里确认删掉了：记下的是这段最近一次永久删除（或更晚的） */
  const isDone = (p, stubs, sha) => { const d = Number(p.done[sha]) || 0; return d > 0 && d >= (Number((stubs.get(sha) || {}).purgedAt) || 0); };
  const markDone = (p, stubs, sha) => { p.done[sha] = Math.max(Number(p.done[sha]) || 0, Number((stubs.get(sha) || {}).purgedAt) || 1); };
  /** 云端确认过、本机现在也算永久删除了的录音（D8：只删这些） */
  const goneNow = () => { const c = confirmedGone() || new Set(), g = goneShas(o.getState()); return new Set([...c].filter(s => g.has(s))); };
  const pendingN = (cfg) => { const p = purgeState(cfg), stubs = stubShas(o.getState()); return [...goneNow()].filter(s => !isDone(p, stubs, s)).length; };
  /** 谁上传的 babble.json：没有 features 的是旧版本（永久删除、清理云端历史的提示里点名），记最后一次 */
  function notePusher(cfg, d) {
    const p = purgeState(cfg), name = String(d.device || '?'), at = Date.parse(d.savedAt) || Date.now();
    if (!(Array.isArray(d.features) && d.features.includes(FEATURES[0]))) p.oldPushers[name] = Math.max(Number(p.oldPushers[name]) || 0, at);
    for (const [n, t] of Object.entries(p.oldPushers)) if (Date.now() - t > OLD_MS) delete p.oldPushers[n];
  }
  /** 旧版本传的这一版：记进同步的 data.oldSeen（只记更晚的）。merged 直接改 → 记了没有 */
  function noteOldSeen(merged, d) {
    if (Array.isArray(d.features) && d.features.includes(FEATURES[0])) return false;
    const name = String(d.device || '').trim(), k = name && oldSeenKey(name);
    if (!k) return false;
    const at = Date.parse(d.savedAt) || Date.now(), O = isObj(merged.data.oldSeen) ? merged.data.oldSeen : {}, c = isObj(O[k]) ? O[k] : null;
    if (c && (Number(c.at) || 0) >= at) return false;
    merged.data.oldSeen = { ...O, [k]: { id: k, name, at, updatedAt: Math.max(at, (Number(c && c.updatedAt) || 0) + 1) } };
    return true;
  }
  /**
   * 最近 30 天用旧版本上传过（这台设备看到的 oldPushers，和同步的 data.oldSeen）的设备名里，那次上传晚于同名设备在数据里报到的时刻
   * （data.devices：{ name, aka?, since = 第一次报到 }；同名的几台取最晚第一次报到的：每台都已经是新版本以后，再有旧版本上传就一定是别的设备；
   * aka 是改名前的名字）。用新版本上传过不算（同名的另一台可能还是旧版本；更新了的那台同步一轮就会报到）。
   * 这台设备自己不算（正在用的就是新版本；更新以后还没传过的时候，云端那份还是自己用旧版本传的）
   */
  function oldDevices(cfg) {
    const p = purgeState(cfg), since = {}, data = (o.getState() || {}).data, devs = isObj(data) && isObj(data.devices) ? data.devices : {}, me = device() || '?';
    for (const r of Object.values(devs)) {
      if (!isObj(r)) continue;
      const at = Number(r.since) || Number(r.seenAt) || Number(r.updatedAt) || 0;
      for (const n of [r.name, ...(Array.isArray(r.aka) ? r.aka : [])]) if (typeof n === 'string' && n) since[n] = Math.max(since[n] || 0, at);
    }
    const last = { ...p.oldPushers };
    for (const r of Object.values(isObj(data) && isObj(data.oldSeen) ? data.oldSeen : {})) {
      if (isObj(r) && typeof r.name === 'string' && r.name) last[r.name] = Math.max(Number(last[r.name]) || 0, Number(r.at) || 0);
    }
    return Object.entries(last).filter(([n, t]) => n !== me && Date.now() - t <= OLD_MS && t > (since[n] || 0)).map(([n]) => n).sort();
  }

  // ---------- 进度 ----------
  const saved = audioSync();
  const st = { running: false, uploading: false, downloading: false, purging: false,
    pendingUp: Number(saved.pendingUp) || 0, pendingDown: Number(saved.pendingDown) || 0, pendingPurge: Number(saved.pendingPurge) || 0 };
  let upErr = null, downErr = null, delErr = null;
  function status() {
    const cfg = o.getConfig();
    let old = [];
    try { old = cfg ? oldDevices(cfg) : []; } catch (e) { /* 只是提示 */ }
    return { ...st, lastError: upErr || downErr || delErr, tokenExpires: (cfg && cfg.tokenExp) || null, oldDevices: old };
  }
  function changed(patch) {
    Object.assign(st, patch);
    if (o.onStatus) { try { o.onStatus(status()); } catch (e) { /* 界面出错不影响同步 */ } }
  }

  // ---------- GitHub API ----------
  const headers = (token, accept) => ({ Authorization: 'Bearer ' + token, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
  function noteExpiry(cfg, r) {
    const v = r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('github-authentication-token-expiration') : null;
    const ms = v ? parseTokenExpiry(v) : null;
    if (ms && cfg.repo) cfg.tokenExp = ms;           // 令牌到期时间（设置页提前提醒）；响应里没有就保留上次的
  }
  async function gh(cfg, method, path, { body, etag, accept, timeout = 20000 } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    const h = headers(cfg.token, accept);
    if (body) h['Content-Type'] = 'application/json';
    if (etag) h['If-None-Match'] = etag;
    try {
      const r = await doFetch(GH_API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl.signal });
      noteExpiry(cfg, r);
      return r;
    } catch (e) {
      throw new SyncError('net');
    } finally {
      clearTimeout(timer);
    }
  }
  /** 取文件原始内容（录音）：连同读取内容一起限时。云端没有 → null */
  async function getBytes(cfg, path) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5 * 60 * 1000);
    let r;
    try {
      r = await doFetch(GH_API + path, { method: 'GET', headers: headers(cfg.token, ACCEPT_RAW), cache: 'no-store', signal: ctl.signal });
      noteExpiry(cfg, r);
      if (r.status === 404) return null;
      if (!r.ok) throw httpError(r);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      throw e instanceof SyncError ? e : new SyncError('net');
    } finally {
      clearTimeout(timer);
    }
  }
  const contents = (cfg, p) => `/repos/${cfg.repo}/contents/${p}`;
  const git = (cfg, p) => `/repos/${cfg.repo}/git/${p}`;
  /** 读 JSON；读不出来（连接断了）当成断网 */
  const json = async (r) => { try { return await r.json(); } catch (e) { throw new SyncError('net'); } };
  function httpError(r) {
    if (r.status === 401) return new SyncError('auth');
    const rate = r.status === 429 || (r.status === 403 && r.headers && r.headers.get && r.headers.get('x-ratelimit-remaining') === '0');
    if (rate) return new SyncError('http', { status: r.status });       // 请求太多：稍后再试，不是权限问题
    if (r.status === 404) verified = null;                              // 仓库可能被删了（重建的可能是公开的）：下次重新确认
    if (r.status === 403 || r.status === 404) return new SyncError('perm');
    return new SyncError('http', { status: r.status });
  }

  /** 仓库必须是私有的（visibility 为 private；企业版的 internal 也不行）。5 分钟内确认过就不再问；force：一定再问。顺便记下默认分支 */
  async function ensurePrivate(cfg, force = false) {
    if (!force && verified === cfg.repo && Date.now() - verifiedAt < VERIFY_MS) return;
    const t0 = Date.now(), n = round;
    verified = null;
    const r = await gh(cfg, 'GET', `/repos/${cfg.repo}`);
    if (!r.ok) throw httpError(r);
    const info = await r.json();
    if (!(info.visibility ? info.visibility === 'private' : info.private)) throw new SyncError('public');
    verified = cfg.repo; verifiedAt = t0; verifiedRound = n;
    branch = { repo: cfg.repo, name: typeof info.default_branch === 'string' && info.default_branch ? info.default_branch : 'main' };
  }
  /** 停止同步了（或换了仓库、令牌）：正在跑的这一轮不再往下传 */
  const stopped = (cfg) => { const c = o.getConfig(); return !c || c.repo !== cfg.repo || c.token !== cfg.token; };

  // ---------- babble.json ----------
  async function pull(cfg) {
    const known = !!cfg.sha && purgeState(cfg).sha === cfg.sha;   // 还没记下现在的云端版本确认了什么（新版本第一次跑）：不带 ETag，完整取一次
    const r = await gh(cfg, 'GET', contents(cfg, SYNC_FILE), { etag: known && cfg.etag, accept: ACCEPT_OBJ });
    if (r.status === 304) return;
    if (r.status === 404) {                          // 云端还没有文件：第一次同步
      cfg.sha = cfg.etag = null;
      cfg.dirty = true;
      return;
    }
    if (!r.ok) throw httpError(r);
    const j = await r.json();
    const etag = r.headers.get('ETag');           // 真的合并进来了才记下（不然以后的 304 会把这个版本挡在外面）
    if (j.sha === cfg.sha && known) { cfg.etag = etag; return; }
    let text = j.encoding === 'base64' && j.content ? fromB64(j.content) : null;
    if (text == null) {                              // 超过 1MB 的文件要单独取原文
      const raw = await gh(cfg, 'GET', contents(cfg, SYNC_FILE), { accept: ACCEPT_RAW });
      if (!raw.ok) throw httpError(raw);
      text = await raw.text();
    }
    let d = null;
    try { d = JSON.parse(text); } catch (e) { d = null; }
    if (!d || d.app !== 'babble' || !d.state || typeof d.state !== 'object') throw new SyncError('badFile', { file: SYNC_FILE });
    // 两边都先整理成同样的格式再比较：不然本机刚改的记录（还没补默认字段）和云端整理过的永远「不一样」，每次同步都会再传一遍
    const remote = normalizeState(d.state), leak = leaks(d.state), both = bothIn(d.state), local = normalizeState(o.getState()), merged = mergeStates(local, remote);
    // 改回去的墓碑比走了样的那份新 1 毫秒：旧版本只比时间，直接采用干净的（不然时间一样时它按内容留下自己那份，两边来回推）
    for (const [id, u] of leak) { const e = merged.data.entries[id]; if (e && e.purged && e.updatedAt <= u) merged.data.entries[id] = { ...e, updatedAt: u + 1 }; }
    for (const [id, u] of both) { const e = merged.data.entries[id]; if (e && !e.purged && e.updatedAt <= u) merged.data.entries[id] = { ...e, updatedAt: u + 1 }; }
    noteOldSeen(merged, d);                          // 旧版本传的：记进同步的数据，别的设备也看得到（这一轮就传上去）
    const cm = canon(merged);
    notePusher(cfg, d);
    if (cm !== canon(local)) o.applyRemote(merged, { device: d.device || '' });
    cfg.sha = j.sha; cfg.etag = etag;
    confirm(cfg, j.sha, remote);                     // 云端这一版里永久删除了哪些（本机的录音、仓库里的文件只按确认过的删）
    const stubs = stubShas(o.getState());            // 别的设备传了新版本（它的录音先传）：以前云端没有的录音马上再试（永久删除过的还是 1 小时一次）
    for (const s of [...missingAt.keys()]) if (!stubs.has(s)) missingAt.delete(s);
    // 保存合并结果时可能又接上了别的标签页的新记录；云端那份带着不该有的内容（旧版本写进墓碑的、放回去的录音的旧移除记录）：这一轮就传一份干净的
    cfg.dirty = leak.length > 0 || both.length > 0 || canon(normalizeState(o.getState())) !== canon(remote);
  }

  /** force：合并以后没有本机才有的改动也传（清理云端历史要分支上的 babble.json 正是这台设备整理过的这一份） */
  async function push(cfg, force = false) {
    if (!cfg.sha) { verified = null; await ensurePrivate(cfg); }   // 要新建文件（云端被删过或重建过）：再确认一次仓库没变成公开的
    for (let i = 0; i < 4; i++) {
      const version = o.editVersion(), state = o.getState();
      const body = {
        message: `更新 ${SYNC_FILE}（${device()}）`,
        content: toB64(JSON.stringify({ app: 'babble', v: 1, device: device(), savedAt: new Date().toISOString(), features: FEATURES, state })),
      };
      const sent = normalizeState(state);            // 传上去的这一版（确认云端有了以后记下它永久删除了哪些）
      if (cfg.sha) body.sha = cfg.sha;
      const r = await gh(cfg, 'PUT', contents(cfg, SYNC_FILE), { body, timeout: 60000 });
      if (r.ok) {
        const j = await r.json();
        cfg.sha = j.content.sha;
        cfg.etag = null;
        cfg.dirty = o.editVersion() !== version;      // 上传期间又改过：留到下一次
        confirm(cfg, cfg.sha, sent);                  // 云端现在就是刚传的这份
        return;
      }
      if (r.status !== 409 && r.status !== 422) throw httpError(r);
      cfg.etag = null;
      await pull(cfg);                                // 云端被别的设备改过：合并后再传
      if (!cfg.dirty && !force) return;
    }
    throw new SyncError('mergeFail');
  }

  // ---------- 录音上传 ----------
  /** 换了仓库：以前的「已上传」不算数（录音要传到新仓库） */
  async function resetIfRepoChanged(cfg) {
    if (audioSync().repo === cfg.repo) return;
    for (const c of await store.listClips()) if (c.uploaded) await store.markUploaded(c.sha256, false);
    saveAudioSync({ repo: cfg.repo });
  }

  /** 传一段录音：先 GET 看云端有没有；没有才 PUT。PUT 返回 409 / 422 不当成功，重新 GET 再决定 */
  async function uploadClip(cfg, sha, mime) {
    const rec = await store.getClip(sha);
    if (!rec || !rec.blob) return;
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    if (await sha256Hex(bytes) !== sha) throw new SyncError('shaMismatch');   // 本机这份坏了：不传
    const path = contents(cfg, audioPath(sha, mime));
    const blobSha = await gitBlobSha(bytes);
    const same = info => !!info && (blobSha ? info.sha === blobSha : info.size === bytes.length);
    let content = null;
    for (let i = 0; i < 3; i++) {
      const r = await gh(cfg, 'GET', path, { accept: ACCEPT_OBJ });
      let remoteSha = null;
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (same(j)) { await store.markUploaded(sha, true); return; }                   // 已经在云端，内容一样
        remoteSha = (j && j.sha) || null;                                             // 在，但内容不对（以前传坏了）：覆盖
      } else if (r.status !== 404) throw httpError(r);
      if (goneShas(o.getState()).has(sha)) return;   // 刚合并进了永久删除：不传了
      content = content || bytesToB64(bytes);
      const body = { message: `添加录音 ${sha.slice(0, 8)}（${device()}）`, content };
      if (remoteSha) body.sha = remoteSha;
      const p = await gh(cfg, 'PUT', path, { body, timeout: 60000 + Math.round(content.length / 20) });   // 按 20KB/s 估上传时间
      if (p.ok) {
        const j = await p.json().catch(() => null);
        if (j && same(j.content)) { await store.markUploaded(sha, true); return; }
        continue;                                    // 回应对不上：再 GET 一次确认
      }
      if (p.status !== 409 && p.status !== 422) throw httpError(p);
      // 409 / 422：可能别的设备刚传了同一段，也可能是同时提交冲突。回到开头重新 GET
    }
    throw new SyncError('audioUp');
  }

  /** 传本机还没上传、合并后还有条目在用的录音（没被条目引用的不传：比如导入时预览了又取消的文件、移除的、删除了的条目的；永久删除了的不传）。
   *  传之前仓库必须是这一轮确认过私有的 */
  async function uploadClips(cfg) {
    if (!store) return;
    await resetIfRepoChanged(cfg);
    const s = o.getState(), refs = referencedClips(s), gone = goneShas(s);
    const todo = (await store.pendingUploads()).filter(c => refs.has(c.sha256) && !gone.has(c.sha256));
    changed({ pendingUp: todo.length, uploading: todo.length > 0 });
    let err = null;
    try {
      if (todo.length && verifiedRound !== round) await ensurePrivate(cfg, true);
      for (const c of todo) {
        if (stopped(cfg)) return;
        const cur = o.getState();
        if (goneShas(cur).has(c.sha256) || !referencedClips(cur).has(c.sha256)) {   // 传的过程中永久删除了、不再有条目在用了（列表是开始时算的）
          changed({ pendingUp: Math.max(0, st.pendingUp - 1) });
          continue;
        }
        try {
          await uploadClip(cfg, c.sha256, refs.get(c.sha256) || c.mime);
          changed({ pendingUp: Math.max(0, st.pendingUp - 1) });
        } catch (e) {
          if (!(e instanceof SyncError) || (FATAL.includes(e.code) && e.code !== 'net')) throw e;
          err = { code: e.code === 'shaMismatch' ? 'shaMismatch' : 'audioUp', vars: { ...(e.vars || {}) } };   // 这段先跳过，下一轮再试；文字照常同步
          if (e.code === 'net') break;               // 断网 / 大文件传超时：这一轮不再传录音，真断网的话下面上传 babble.json 时会报离线
        }
      }
    } finally {
      upErr = err;
      saveAudioSync({ pendingUp: st.pendingUp });
      changed({ uploading: false });
    }
  }

  // ---------- 录音下载 ----------
  const inflight = new Map();     // sha → Promise<Blob|null>：同一段录音同时只下载一次
  const missingAt = new Map();    // sha → 云端没有（404）的时刻
  let dlWanted = false, dlLoop = null;
  const isGone = sha => goneShas(o.getState()).has(sha);

  function fetchClip(cfg, sha, mime) {
    if (inflight.has(sha)) return inflight.get(sha);
    const p = (async () => {
      if (isGone(sha)) return null;                  // 永久删除了：本机还没删也不给，不下载
      const have = await store.getClip(sha);
      if (have && have.blob) return have.blob;
      const bytes = await getBytes(cfg, contents(cfg, audioPath(sha, mime)));
      if (!bytes) { missingAt.set(sha, Date.now()); return null; }      // 对方还没传上来
      missingAt.delete(sha);
      if (await sha256Hex(bytes) !== sha) throw new SyncError('shaMismatch');   // 下载坏了或文件被改过：丢掉，下次重下
      if (isGone(sha)) return null;                  // 下载的时候合并进了永久删除（下载列表是开始时算的，几个标签页共用录音库）：不存
      const blob = new Blob([bytes], { type: mime });
      await store.putClip(blob, { mime, uploaded: true });
      await store.markUploaded(sha, true);           // 从云端来的，不用再传（老版本的 putClip 不认 uploaded）
      return blob;
    })().finally(() => inflight.delete(sha));
    inflight.set(sha, p);
    return p;
  }

  async function missingClips() {
    const out = [];
    for (const [sha, mime] of referencedClips(o.getState())) if (!(await store.hasClip(sha))) out.push([sha, mime]);
    return out;
  }

  /** 后台按「新的条目在前」一段一段下载本机缺的录音 */
  async function downloadLoop() {
    changed({ downloading: true });
    let err = downErr;
    try {
      while (dlWanted) {
        dlWanted = false;
        err = null;
        const cfg = o.getConfig();
        if (!cfg) return;
        const todo = await missingClips(), stubs = stubShas(o.getState());
        changed({ pendingDown: todo.length });
        for (const [sha, mime] of todo) {
          const cur = o.getConfig();
          if (!cur || cur.repo !== cfg.repo) return;                        // 停止同步或换了仓库
          const miss = missingAt.get(sha);
          if (miss && Date.now() - miss < (stubs.has(sha) ? PURGED_RETRY_MS : MISSING_RETRY_MS)) continue;
          try {
            if (await fetchClip(cur, sha, mime)) changed({ pendingDown: Math.max(0, st.pendingDown - 1) });
          } catch (e) {
            if (e instanceof SyncError && FATAL.includes(e.code)) { err = null; return; }   // 离线 / 令牌问题：文字同步会报，这里先停
            err = { code: e instanceof SyncError && e.code === 'shaMismatch' ? 'shaMismatch' : 'audioDown', vars: { ...((e && e.vars) || {}) } };
          }
        }
      }
    } finally {
      downErr = err;
      saveAudioSync({ pendingDown: st.pendingDown });
      changed({ downloading: false });
    }
  }
  function kickDownloads() {
    if (!store) return;
    dlWanted = true;
    if (!dlLoop) dlLoop = downloadLoop().catch(() => {}).finally(() => { dlLoop = null; });
  }

  /** 播放器要用的录音：本机有就直接给；没有就马上下载（不排队），校验 sha256 后存进本机。云端也没有 → null。
   *  永久删除了的 → null（本机还没删也不给，也不去网上找）。
   *  mime：已经没有条目引用的录音（恢复旧版本时）要给，才找得到仓库里的文件名 */
  async function getAudio(sha, mimeHint = null) {
    sha = String(sha || '').toLowerCase();
    if (!store || !/^[0-9a-f]{64}$/.test(sha)) return null;
    const s = o.getState();
    if (goneShas(s).has(sha)) return null;
    const have = await store.getClip(sha);
    if (have && have.blob) return have.blob;
    const cfg = o.getConfig();
    if (!cfg) return null;
    const mime = mimeOf(s, sha) || mimeHint || 'audio/mp4';
    const blob = await fetchClip(cfg, sha, mime);
    if (blob && !dlLoop) changed({ pendingDown: (await missingClips()).length });
    return blob;
  }

  // ---------- 仓库里的录音：删掉永久删除了的、对账 ----------
  const refPath = (name) => 'heads/' + name.split('/').map(encodeURIComponent).join('/');
  /** 默认分支的 ref 路径（heads/<分支>）：还不知道默认分支就再确认一次仓库 */
  async function headRef(cfg) {
    if (!branch || branch.repo !== cfg.repo) await ensurePrivate(cfg, true);
    return refPath(branch.name);
  }
  /** 分支现在指向的提交；空仓库（409 Git Repository is empty）→ null */
  async function refHead(cfg, ref) {
    const r = await gh(cfg, 'GET', git(cfg, 'ref/' + ref));
    if (r.status === 409) return null;
    if (!r.ok) throw httpError(r);
    const j = await json(r);
    return (j && j.object && j.object.sha) || null;
  }
  /** 分支最新提交的文件 → { ref, head, treeSha, parents, files:[{ path, sha256, ext, blob, size }], jsonSha, truncated }；空仓库 → null。
   *  三个 GET：ref → 提交 → 整棵树（recursive）；树太大被截断时 babble.json 的 blob sha 从根目录单独取 */
  async function listHead(cfg) {
    const ref = await headRef(cfg), head = await refHead(cfg, ref);
    if (!head) return null;
    const c = await gh(cfg, 'GET', git(cfg, 'commits/' + head));
    if (!c.ok) throw httpError(c);
    const cj = await json(c);
    const treeSha = cj.tree && cj.tree.sha, parents = (Array.isArray(cj.parents) ? cj.parents : []).map(x => x && x.sha).filter(Boolean);
    const t = await gh(cfg, 'GET', git(cfg, `trees/${treeSha}?recursive=1`), { timeout: 60000 });
    if (!t.ok) throw httpError(t);
    const tj = await json(t);
    const files = [];
    let jsonSha = null;
    for (const x of Array.isArray(tj.tree) ? tj.tree : []) {
      if (!x || x.type !== 'blob') continue;
      if (x.path === SYNC_FILE) jsonSha = x.sha;
      const m = AUDIO_RE.exec(x.path);
      if (m) files.push({ path: x.path, sha256: m[1], ext: m[2], blob: x.sha, size: Number.isFinite(x.size) ? x.size : null });
    }
    if (tj.truncated && !jsonSha) {
      const top = await gh(cfg, 'GET', git(cfg, 'trees/' + treeSha));
      if (!top.ok) throw httpError(top);
      const x = ((await json(top)).tree || []).find(f => f && f.path === SYNC_FILE && f.type === 'blob');
      jsonSha = (x && x.sha) || null;
    }
    return { ref, head, treeSha, parents, files, jsonSha, truncated: !!tj.truncated };
  }
  /** 一次提交删掉这些文件，分支只快进（这中间有人提交了 → false，重新列）。每次写之前看一眼：本机又改过 → 'dirty'（先传 babble.json）。
   *  成功 → { head, treeSha }（新的提交）。提交说明里只写段数，不写条目内容 */
  async function commitDeletes(cfg, L, targets) {
    if (cfg.dirty) return 'dirty';
    const t = await gh(cfg, 'POST', git(cfg, 'trees'), { body: { base_tree: L.treeSha, tree: targets.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: null })) }, timeout: 60000 });
    if (t.status === 422) return false;                                 // 有文件已经不在了：重新列
    if (!t.ok) throw httpError(t);
    const tree = (await json(t)).sha;
    if (cfg.dirty) return 'dirty';
    const c = await gh(cfg, 'POST', git(cfg, 'commits'), { body: { message: `删除录音 ${new Set(targets.map(f => f.sha256)).size} 段（${device()}）`, tree, parents: [L.head] } });
    if (!c.ok) throw httpError(c);
    const commit = (await json(c)).sha;
    if (cfg.dirty) return 'dirty';
    const p = await gh(cfg, 'PATCH', git(cfg, 'refs/' + L.ref), { body: { sha: commit, force: false } });
    if (p.ok) return { head: commit, treeSha: tree };
    if (p.status === 422 || p.status === 409) return false;            // 不是快进：别的设备刚提交过
    throw httpError(p);
  }
  /** 树被截断（文件太多）时一段一段 GET（路径按永久删除记号里的 mime）→ { checked: 确认不在了的, found: 还在的文件 }；出错的两边都不算 */
  async function checkPaths(cfg, shas) {
    const stubs = stubShas(o.getState()), checked = new Set(), found = [];
    for (const sha of shas) {
      if (stopped(cfg)) break;
      const path = audioPath(sha, (stubs.get(sha) || {}).mime);
      const r = await gh(cfg, 'GET', contents(cfg, path), { accept: ACCEPT_OBJ });
      if (r.status === 404) checked.add(sha);
      else if (r.ok) found.push({ path, sha256: sha });
    }
    return { checked, found };
  }

  /**
   * 删掉仓库里永久删除了的录音（每台设备都做）：只删「云端确认过的那一版」和「本机现在」都算永久删除的（D8），
   * 而且分支上的 babble.json 正是本机合并过的那份（不是就先合并）。本机又改过（cfg.dirty）就不删，先传 babble.json。
   * 对账（每天一次；新版本第一次跑、有设备清理过云端历史、opts.forceAudit 时马上）：条目在用、本机标着已上传、仓库里却没有的，改回待上传。
   * 返回改回待上传的段数（调用的一轮接着再传一次）
   */
  async function purgeRemote(cfg, opts = {}) {
    if (!store || cfg.dirty) return 0;
    const p = purgeState(cfg), mark = (o.getState().settings || {}).cloudResetAt ?? null;
    const force = () => { p.forceAt = Math.max(Date.now(), (p.auditAt || 0) + 1); saveP(); };   // 一定晚于上次对账（同一毫秒也算）
    if (mark != null && mark !== p.resetSeen) { p.resetSeen = mark; force(); }   // 有设备清理过云端历史：它那一刻别的设备传的可能丢了
    if (opts.forceAudit) force();
    if (!confirmedGone()) return 0;
    const f0 = p.forceAt || 0, want = pendingN(cfg);
    const audit = ((p.auditV || 0) < AUDIT_V || f0 > (p.auditAt || 0) || Date.now() - (p.auditAt || 0) > AUDIT_MS) && (want > 0 || opts.forceAudit || Date.now() - auditFailAt > AUDIT_RETRY_MS);
    if (!want) delErr = null;                        // 没有要删的了（别的设备删好了、又有人用上了）：以前没删成的不再报
    changed({ pendingPurge: want });
    if (!want && !audit) return 0;
    changed({ purging: true });
    let healed = 0;
    // 只是对账没做成（没有要删的）：不报错，过一会儿再对；有要删的没删成：报 audioDel，下一轮再删
    const fail = () => { if (pendingN(cfg)) delErr = { code: 'audioDel', vars: {} }; else auditFailAt = Date.now(); };
    try {
      for (let i = 0; i < 3; i++) {
        if (stopped(cfg)) return healed;
        const L = await listHead(cfg);
        if (!L) { delErr = null; return healed; }    // 空仓库：没什么可删
        if (L.jsonSha !== cfg.sha) {                 // babble.json 在我们合并以后又变了：先合并（可能有人又用上了这段）
          cfg.etag = null;
          await pull(cfg);
          if (cfg.dirty || !confirmedGone()) return healed;
          continue;
        }
        if (cfg.dirty) return healed;
        const gone = goneNow(), targets = L.files.filter(f => gone.has(f.sha256));   // 同一段的每个扩展名都删
        let at = L;
        if (targets.length) {
          const ok = await commitDeletes(cfg, L, targets);
          if (ok === 'dirty') return healed;
          if (!ok) continue;                         // 分支动过：重新列
          at = { ...L, ...ok };
          for (const f of targets) if (await store.hasClip(f.sha256)) await store.markUploaded(f.sha256, false);   // 以后又有人用：要重新传
        }
        let checked = gone, stubs = stubShas(o.getState());
        if (L.truncated) {                           // 列表不全：还没删好的一段段问，只把真的确认过的记成删好了
          const r = await checkPaths(cfg, [...gone].filter(s => !isDone(p, stubs, s) && !targets.some(f => f.sha256 === s)));
          checked = new Set([...r.checked, ...targets.map(f => f.sha256)]);
          if (r.found.length) {
            const ok = await commitDeletes(cfg, at, r.found);
            if (ok === 'dirty') return healed;
            if (ok) for (const f of r.found) checked.add(f.sha256);
          }
        }
        stubs = stubShas(o.getState());
        for (const s of checked) markDone(p, stubs, s);
        if (audit && !L.truncated) {                 // 对账：条目在用、仓库里却没有的（被手动删了、清理历史时丢了）改回待上传
          const have = new Set(L.files.filter(f => !targets.includes(f)).map(f => f.sha256)), refs = referencedClips(o.getState());
          for (const c of await store.listClips()) if (c.uploaded && refs.has(c.sha256) && !have.has(c.sha256)) { await store.markUploaded(c.sha256, false); healed++; }
          p.auditAt = Math.max(Date.now(), f0); p.auditV = AUDIT_V;
        }
        delErr = null;
        return healed;
      }
      fail();
    } catch (e) {
      if (e instanceof SyncError && e.code === 'net') return healed;   // 断网：下一轮再删，这一轮照样算同步好了
      // 令牌失效、仓库变公开：整轮报错。别的（403 / 404 = perm）只是 Git Data API 用不了——这一轮的 contents API 刚刚都正常，不让它挡住同步
      if (e instanceof SyncError && (e.code === 'auth' || e.code === 'public')) throw e;
      fail();
    } finally {
      saveP();
      changed({ purging: false, pendingPurge: pendingN(cfg) });
      saveAudioSync({ pendingPurge: st.pendingPurge });
    }
    return healed;
  }

  /** 有争议的录音（没删除的条目在用、又有永久删除的记号）：本机有、标着已上传的，GET 一下仓库里还在不在，不在了改回待上传（D9）。
   *  同一版 babble.json 下查过的不再查。返回改回待上传的段数 */
  async function checkContested(cfg) {
    if (!store) return 0;
    const s = o.getState(), K = keysOf(contestedShas(s));
    if (!K.length) return 0;
    const p = purgeState(cfg), refs = referencedClips(s), up = new Set((await store.listClips()).filter(c => c.uploaded).map(c => c.sha256));
    let healed = 0;
    try {
      for (const sha of K) {
        if (stopped(cfg)) break;
        if (!up.has(sha) || p.verifiedAt[sha] === cfg.sha) continue;
        const r = await gh(cfg, 'GET', contents(cfg, audioPath(sha, refs.get(sha))), { accept: ACCEPT_OBJ });
        if (r.status === 404) { await store.markUploaded(sha, false); healed++; }
        else if (r.ok) p.verifiedAt[sha] = cfg.sha;
        else if (r.status === 401) throw httpError(r);
      }
    } catch (e) {
      if (!(e instanceof SyncError) || (FATAL.includes(e.code) && e.code !== 'net')) throw e;   // 断网：下次再查
    } finally { saveP(); }
    return healed;
  }

  // ---------- 一轮同步 ----------
  async function run(opts = {}) {
    const cfg = o.getConfig();
    if (!cfg) return { ok: true, skipped: true };
    changed({ running: true });
    let ok = false;
    round++;
    const sha0 = cfg.sha;
    reloadP(cfg);
    try {
      await ensurePrivate(cfg);
      try { await pull(cfg); }                       // 先合并：别的设备永久删除了的，这一轮就不会再传上去
      catch (e) {
        // babble.json 读不出来（手动改坏了）、服务器出错：这台设备的录音照样先传进私有仓库（只传本机知道没永久删除的），再报这个错。
        // 断网、令牌、仓库公开、请求太多（429 / 403 限流）不传
        const rate = e instanceof SyncError && e.code === 'http' && e.vars && (e.vars.status === 429 || e.vars.status === 403);
        if (e instanceof SyncError && (e.code === 'badFile' || (e.code === 'http' && !rate)) && !stopped(cfg)) {
          try { await uploadClips(cfg); } catch (_) { /* 报原来的错 */ }
        }
        throw e;
      }
      if (stopped(cfg)) return { ok: false, skipped: true };
      await uploadClips(cfg);                        // 再传录音、最后传 babble.json：别的设备看到条目时，录音已经在云端了
      if (stopped(cfg)) return { ok: false, skipped: true };
      if (cfg.dirty || opts.forcePush) await push(cfg, !!opts.forcePush);
      if (stopped(cfg)) return { ok: false, skipped: true };
      const dirty0 = cfg.dirty;
      let heal = await purgeRemote(cfg, opts);
      if (stopped(cfg)) return { ok: false, skipped: true };
      if (cfg.dirty && !dirty0) await push(cfg);     // 删之前发现云端又变了、合并出本机才有的：这一轮就传（下一轮再删）
      if (cfg.sha !== sha0 || !contestedOnce) { heal += await checkContested(cfg); contestedOnce = true; }
      if (heal && !stopped(cfg)) await uploadClips(cfg);   // 仓库里少了的录音：这一轮就重传
      cfg.at = Date.now();
      cfg.offline = false;
      cfg.err = null;
      ok = true;
      return { ok: true };
    } catch (e) {
      const code = e instanceof SyncError ? e.code : 'unknown';
      cfg.offline = code === 'net';
      cfg.err = code === 'net' ? null : { code, vars: e.vars || {}, message: e instanceof SyncError ? '' : String((e && e.message) || e) };
      return { ok: false, error: cfg.err, offline: cfg.offline };
    } finally {
      o.saveConfig(cfg);
      changed({ running: false });
      if (ok && o.getConfig() === cfg) kickDownloads();
    }
  }

  /** 同一时间只跑一个（同步、清理云端历史、找没有条目在用的录音都排在同一条队里） */
  function queue(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }
  /** opts.forcePush：没改动也传一次 babble.json；opts.forceAudit：马上把仓库里的录音对一遍 */
  const syncNow = (opts = {}) => queue(() => run(opts || {}));

  /** 等正在跑的同步和后台下载都结束（测试、导出备份前用） */
  async function idle() {
    await chain;
    while (dlLoop) await dlLoop;
  }

  /** 连接一个仓库：先检查令牌和仓库（必须是私有的），再做第一次同步 */
  async function checkRepo(repo, token) {
    const r = await gh({ token }, 'GET', `/repos/${String(repo || '').trim()}`);
    if (r.status === 401) throw new SyncError('auth');
    if (!r.ok) throw new SyncError('notFound');
    const info = await r.json();
    if (!(info.visibility ? info.visibility === 'private' : info.private)) throw new SyncError('public');
    return info.full_name || repo;
  }

  // ---------- 清理云端历史、找没有条目在用的录音（用户点了才做；出错返回给界面，不记进同步状态） ----------
  const failed = (code, vars = {}) => ({ ok: false, error: { code, vars } });
  const caught = (e) => (e instanceof SyncError ? { ok: false, error: { code: e.code, vars: e.vars || {} }, offline: e.code === 'net' }
    : { ok: false, error: { code: 'unknown', vars: {}, message: String((e && e.message) || e) } });
  const setMark = (v) => {                       // 马上存进 babble.local（强制更新之前一定要落盘）
    if (o.setLocal) { o.setLocal({ squashMark: v }); return; }
    const L = o.getLocal && o.getLocal();
    if (L) { L.squashMark = v; if (o.saveLocal) o.saveLocal(); }
  };
  /** 分支现在是 R，或者 R 在它往前 10 个提交（第一个父提交）以内：强制更新生效了 */
  async function reaches(cfg, ref, R) {
    let h = await refHead(cfg, ref);
    for (let i = 0; i <= 10 && h; i++) {
      if (h === R) return true;
      const c = await gh(cfg, 'GET', git(cfg, 'commits/' + h));
      if (!c.ok) throw httpError(c);
      const j = await json(c);
      h = (j && Array.isArray(j.parents) && j.parents[0] && j.parents[0].sha) || null;
    }
    return false;
  }
  /**
   * 提交历史换成一个新的根提交，只留现在的内容（永久删除了的文件也不带上；D14）：
   * 先同步一轮、马上对一遍录音（少了的这一轮就重传）→ 已经只有一个干净的根提交 → already → 强制传一遍 babble.json
   * （根提交里要正是这台设备整理过的这一份，旧版本留下的内容都不带上）→ 列文件、建根提交、分支没动才强制更新、再核对
   */
  async function doSquash() {
    const cfg = o.getConfig();
    if (!cfg) return { ok: false, skipped: true };
    const ready = async () => {                    // 录音都传完、该删的都删了、本机没有没传的改动
      if (cfg.dirty || pendingN(cfg)) return false;
      const refs = referencedClips(o.getState());
      return !store || !(await store.pendingUploads()).some(c => refs.has(c.sha256));
    };
    let r = await run({ forceAudit: true });
    if (!r.ok) return r;
    if (stopped(cfg)) return { ok: false, skipped: true };
    if (!(await ready())) return failed('squashPending');
    try {
      await ensurePrivate(cfg, true);
      const name = branch.name, L0 = await listHead(cfg), gone0 = goneShas(o.getState());
      if (!L0 || (!L0.parents.length && L0.jsonSha === cfg.sha && !L0.files.some(f => gone0.has(f.sha256)))) return { ok: true, already: true, branch: name };
      r = await run({ forcePush: true });
      if (!r.ok) return r;
      if (stopped(cfg)) return { ok: false, skipped: true };
      if (!(await ready())) return failed('squashPending');
      for (let i = 0; i < 3; i++) {
        if (stopped(cfg)) return { ok: false, skipped: true };
        const L = await listHead(cfg);
        if (!L) return { ok: true, already: true, branch: name };
        if (L.jsonSha !== cfg.sha) {                 // 有设备（可能是旧版本）刚传过 babble.json：合并以后再强制传一遍干净的
          r = await run({ forcePush: true });
          if (!r.ok) return r;
          continue;
        }
        const gone = goneShas(o.getState()), drop = L.files.filter(f => gone.has(f.sha256));
        if (!L.parents.length && !drop.length) return { ok: true, already: true, branch: name };
        let tree = L.treeSha;
        if (drop.length) {                           // 永久删除了、又被放回来的文件：新的根提交里也不要
          const t = await gh(cfg, 'POST', git(cfg, 'trees'), { body: { base_tree: L.treeSha, tree: drop.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: null })) }, timeout: 60000 });
          if (t.status === 422) continue;
          if (!t.ok) throw httpError(t);
          tree = (await json(t)).sha;
        }
        const c = await gh(cfg, 'POST', git(cfg, 'commits'), { body: { message: `清理历史（${device()}）`, tree, parents: [] } });
        if (!c.ok) throw httpError(c);
        const R = (await json(c)).sha;
        if (await refHead(cfg, L.ref) !== L.head) continue;            // 这中间有人提交了：重来
        setMark({ R, at: Date.now() });              // 强制更新之前记下：之后崩了，下次启动也会写 cloudResetAt
        const p = await gh(cfg, 'PATCH', git(cfg, 'refs/' + L.ref), { body: { sha: R, force: true } });
        if (!p.ok) {
          const j = await p.json().catch(() => null), msg = String((j && j.message) || '');
          if (p.status === 422 || p.status === 403 || p.status === 409) setMark(null);   // 明确没改成：什么都没变
          if ((p.status === 422 || p.status === 403) && /protect|rule|force.?push/i.test(msg)) return failed('protected', { branch: name });
          throw httpError(p);
        }
        if (!(await reaches(cfg, L.ref, R))) return failed('squashRace');   // 记号留着：各设备照样对一遍录音
        cfg.etag = null;
        o.saveConfig(cfg);
        const have = new Set(L.files.filter(f => !drop.includes(f)).map(f => f.sha256));
        return { ok: true, commit: R, branch: name, missing: [...referencedClips(o.getState()).keys()].filter(sha => !have.has(sha)) };
      }
      return failed('squashRace');
    } catch (e) { return caught(e); }
  }
  const squash = () => queue(doSquash);

  /** 仓库里没有条目在用、也没永久删除的录音（只读）。先同步一轮，拿最新的条目；24 小时内传上来的只计数不列出（条目可能还在路上） */
  async function scanOrphans() {
    const cfg = o.getConfig();
    if (!cfg) return { ok: true, skipped: true, files: [], recent: 0, more: false };
    const r = await run();
    if (!r.ok) return r;
    try {
      const L = await listHead(cfg), s = o.getState(), claim = claimShas(s), gone = goneShas(s);
      const cand = (L ? L.files : []).filter(f => !claim.has(f.sha256) && !gone.has(f.sha256));
      const files = [];
      let recent = 0;
      for (const f of cand.slice(0, ORPHAN_MAX)) {
        const c = await gh(cfg, 'GET', `/repos/${cfg.repo}/commits?path=${encodeURIComponent(f.path)}&per_page=1`);
        if (!c.ok) throw httpError(c);
        const list = await c.json().catch(() => null), m = (Array.isArray(list) && list[0] && list[0].commit) || {};
        const at = Date.parse((m.committer && m.committer.date) || (m.author && m.author.date) || '') || 0;
        if (!at || Date.now() - at < ORPHAN_AGE_MS) { recent++; continue; }
        files.push({ sha256: f.sha256, path: f.path, ext: f.ext, size: f.size, at, mime: mimeForExt(f.ext) });
      }
      return { ok: true, files, recent, more: cand.length > ORPHAN_MAX };
    } catch (e) { return caught(e); }
  }
  const orphans = () => queue(scanOrphans);

  /** 清理确认框、卡片要的（尽力而为）：提交数（commits?per_page=1 的 Link rel="last"）、默认分支、别的分支和标签 */
  async function historyInfo() {
    const cfg = o.getConfig();
    if (!cfg) return null;
    const out = { commits: null, branch: null, others: [] };
    try {
      await headRef(cfg);
      out.branch = branch.name;
      const r = await gh(cfg, 'GET', `/repos/${cfg.repo}/commits?per_page=1`);
      if (r.ok) {
        const last = String((r.headers && r.headers.get && r.headers.get('Link')) || '').split(',').find(x => /rel="last"/.test(x));
        const m = last && last.match(/[?&]page=(\d+)/);
        out.commits = m ? Number(m[1]) : ((await r.json().catch(() => null)) || []).length;
      }
      for (const kind of ['branches', 'tags']) {
        const x = await gh(cfg, 'GET', `/repos/${cfg.repo}/${kind}?per_page=100`);
        const list = x.ok ? await x.json().catch(() => null) : null;
        for (const b of Array.isArray(list) ? list : []) if (b && typeof b.name === 'string' && !(kind === 'branches' && b.name === out.branch)) out.others.push(b.name);
      }
    } catch (e) { /* 只是提示：拿不到就不显示 */ }
    return out;
  }

  // ---------- 云端历史（修改记录，按需） ----------
  /** babble.json 的提交记录，新的在前 → [{ sha, at, message }]。没开同步 → [] */
  async function commits({ page = 1, perPage = 30 } = {}) {
    const cfg = o.getConfig();
    if (!cfg) return [];
    const r = await gh(cfg, 'GET', `/repos/${cfg.repo}/commits?path=${encodeURIComponent(SYNC_FILE)}&per_page=${perPage}&page=${page}`);
    if (!r.ok) throw httpError(r);
    const list = await r.json().catch(() => null);
    return (Array.isArray(list) ? list : []).filter(c => c && typeof c.sha === 'string').map(c => {
      const m = c.commit || {};
      return { sha: c.sha, at: (m.committer && m.committer.date) || (m.author && m.author.date) || null, message: m.message || '' };
    });
  }
  /** 某次提交时的 babble.json（{ app, v, device, savedAt, state }）。那时没有这个文件 / 不是牙牙呓语的文件 → null。
   *  直接要原文（raw）：超过 1MB 的文件也能取 */
  async function fileAt(ref) {
    const cfg = o.getConfig();
    if (!cfg) return null;
    const r = await gh(cfg, 'GET', contents(cfg, SYNC_FILE) + (ref ? '?ref=' + encodeURIComponent(ref) : ''), { accept: ACCEPT_RAW, timeout: 60000 });
    if (r.status === 404) return null;
    if (!r.ok) throw httpError(r);
    let text;
    try { text = await r.text(); } catch (e) { throw new SyncError('net'); }
    let d = null;
    try { d = JSON.parse(text); } catch (e) { d = null; }
    return d && d.app === 'babble' && d.state && typeof d.state === 'object' ? d : null;
  }

  return { syncNow, checkRepo, getAudio, status, idle, commits, fileAt, squash, orphans, historyInfo, confirmedGone };
}
