// 多设备同步：数据在用户自己的 GitHub 私有仓库里，用 GitHub 的 contents API 读写。
//   babble.json = { app:'babble', v:1, device, savedAt, state }
//   audio/<sha256>.<ext>   录音（以内容哈希命名，只增不改）
// 每一轮：确认仓库是私有的（5 分钟内确认过就不再问；要传录音时这一轮一定再问一次）→ 先传本机还没上传的录音（断网就留到下一轮，文字照常同步）
// → 拉取 babble.json、逐条合并 → 本机有云端没有的改动才上传
// （带上云端版本号 sha，云端被别的设备改过会返回 409 / 422，这时重新拉取合并再传）→ 在后台下载本机缺的录音（不挡下一轮同步）。
// 修改记录要的云端历史（commits / fileAt）只在用户点了才去取，用同一套令牌和出错处理。
import { normalizeState, mergeStates, canon, byNewest } from './store.js';
import { extForMime } from './audioStore.js';
import { sha256Hex } from './sha256.js';

export const GH_API = 'https://api.github.com';
export const SYNC_FILE = 'babble.json';
export const CODE_PREFIX = 'babble-sync:';
// object 格式：超过 1MB 的文件也能拿到 sha / size（content 为空），默认格式会直接报错
const ACCEPT_OBJ = 'application/vnd.github.object+json', ACCEPT_RAW = 'application/vnd.github.raw+json';
const MISSING_RETRY_MS = 5 * 60 * 1000;      // 云端还没有的录音（对方还没传）：后台 5 分钟内不再问
const FATAL = ['net', 'auth', 'perm', 'public'];
const VERIFY_MS = 5 * 60 * 1000;              // 「仓库是私有的」确认多久有效（仓库可能被改成公开、删掉重建）

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

/** 条目引用的录音：sha → mime，新的条目在前（下载顺序）。默认只算没删除的条目 */
export function referencedClips(state, { includeDeleted = false } = {}) {
  const list = Object.values((state && state.data && state.data.entries) || {}).filter(e => e && (includeDeleted || !e.deleted)).sort(byNewest);
  const m = new Map();
  for (const e of list) for (const a of e.audio || []) {
    const sha = a && typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
    if (/^[0-9a-f]{64}$/.test(sha) && !m.has(sha)) m.set(sha, a.mime || 'audio/mp4');
  }
  return m;
}

/**
 * @param {object} o
 * @param {() => object} o.getState                 当前本机数据
 * @param {(merged, info) => void} o.applyRemote    合并出新内容时调用（info.device = 上次写入云端的设备名）
 * @param {() => object|null} o.getConfig           babble.local 里的 sync：{ repo, token, sha, etag, dirty, at, err, offline, tokenExp }；没开同步 → null
 * @param {(cfg) => void} o.saveConfig              保存同步状态（只存本机）
 * @param {() => number} o.editVersion              本机修改计数：上传期间又改过的话，上传完仍然算「有改动」
 * @param {string|(() => string)} o.device          设备名（写进云端；可以是函数，设置里改了名字马上生效）
 * @param {object} o.audioStore                     src/core/audioStore.js（没有就只同步文字）
 * @param {(status) => void} [o.onStatus]           进度变化时调用（设置页显示待上传 / 待下载）
 * @param {() => object} [o.getLocal]  @param {() => void} [o.saveLocal]   babble.local：录音同步进度记在 local.audioSync
 * @param {typeof fetch} [o.fetch]
 * @returns {{ syncNow(): Promise<{ok: boolean, skipped?: boolean, error?: object, offline?: boolean}>,
 *             checkRepo(repo: string, token: string): Promise<string>,
 *             getAudio(sha: string, mime?: string): Promise<Blob|null>,
 *             status(): { running, uploading, downloading, pendingUp, pendingDown, lastError, tokenExpires },
 *             idle(): Promise<void>,
 *             commits({ page, perPage }): Promise<Array<{ sha, at, message }>>,
 *             fileAt(ref: string): Promise<object|null> }}
 */
export function createSync(o) {
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const store = o.audioStore || null;
  const device = () => String((typeof o.device === 'function' ? o.device() : o.device) || '');
  let chain = Promise.resolve();
  let verified = null, verifiedAt = 0, verifiedRound = 0, round = 0;   // 最近确认过是私有仓库的 repo 名、时刻、第几轮
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

  // ---------- 进度 ----------
  const saved = audioSync();
  const st = { running: false, uploading: false, downloading: false,
    pendingUp: Number(saved.pendingUp) || 0, pendingDown: Number(saved.pendingDown) || 0 };
  let upErr = null, downErr = null;
  function status() {
    const cfg = o.getConfig();
    return { ...st, lastError: upErr || downErr, tokenExpires: (cfg && cfg.tokenExp) || null };
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
  function httpError(r) {
    if (r.status === 401) return new SyncError('auth');
    const rate = r.status === 429 || (r.status === 403 && r.headers && r.headers.get && r.headers.get('x-ratelimit-remaining') === '0');
    if (rate) return new SyncError('http', { status: r.status });       // 请求太多：稍后再试，不是权限问题
    if (r.status === 404) verified = null;                              // 仓库可能被删了（重建的可能是公开的）：下次重新确认
    if (r.status === 403 || r.status === 404) return new SyncError('perm');
    return new SyncError('http', { status: r.status });
  }

  /** 仓库必须是私有的（visibility 为 private；企业版的 internal 也不行）。5 分钟内确认过就不再问；force：一定再问 */
  async function ensurePrivate(cfg, force = false) {
    if (!force && verified === cfg.repo && Date.now() - verifiedAt < VERIFY_MS) return;
    const t0 = Date.now(), n = round;
    verified = null;
    const r = await gh(cfg, 'GET', `/repos/${cfg.repo}`);
    if (!r.ok) throw httpError(r);
    const info = await r.json();
    if (!(info.visibility ? info.visibility === 'private' : info.private)) throw new SyncError('public');
    verified = cfg.repo; verifiedAt = t0; verifiedRound = n;
  }
  /** 停止同步了（或换了仓库、令牌）：正在跑的这一轮不再往下传 */
  const stopped = (cfg) => { const c = o.getConfig(); return !c || c.repo !== cfg.repo || c.token !== cfg.token; };

  // ---------- babble.json ----------
  async function pull(cfg) {
    const r = await gh(cfg, 'GET', contents(cfg, SYNC_FILE), { etag: cfg.sha && cfg.etag, accept: ACCEPT_OBJ });
    if (r.status === 304) return;
    if (r.status === 404) {                          // 云端还没有文件：第一次同步
      cfg.sha = cfg.etag = null;
      cfg.dirty = true;
      return;
    }
    if (!r.ok) throw httpError(r);
    const j = await r.json();
    const etag = r.headers.get('ETag');           // 真的合并进来了才记下（不然以后的 304 会把这个版本挡在外面）
    if (j.sha === cfg.sha) { cfg.etag = etag; return; }
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
    const remote = normalizeState(d.state), local = normalizeState(o.getState()), merged = mergeStates(local, remote), cm = canon(merged);
    if (cm !== canon(local)) o.applyRemote(merged, { device: d.device || '' });
    cfg.sha = j.sha; cfg.etag = etag;
    missingAt.clear();                               // 别的设备传了新版本（它的录音先传）：以前云端没有的录音马上再试
    cfg.dirty = cm !== canon(remote);
  }

  async function push(cfg) {
    if (!cfg.sha) { verified = null; await ensurePrivate(cfg); }   // 要新建文件（云端被删过或重建过）：再确认一次仓库没变成公开的
    for (let i = 0; i < 4; i++) {
      const version = o.editVersion();
      const body = {
        message: `更新 ${SYNC_FILE}（${device()}）`,
        content: toB64(JSON.stringify({ app: 'babble', v: 1, device: device(), savedAt: new Date().toISOString(), state: o.getState() })),
      };
      if (cfg.sha) body.sha = cfg.sha;
      const r = await gh(cfg, 'PUT', contents(cfg, SYNC_FILE), { body, timeout: 60000 });
      if (r.ok) {
        const j = await r.json();
        cfg.sha = j.content.sha;
        cfg.etag = null;
        cfg.dirty = o.editVersion() !== version;      // 上传期间又改过：留到下一次
        return;
      }
      if (r.status !== 409 && r.status !== 422) throw httpError(r);
      cfg.etag = null;
      await pull(cfg);                                // 云端被别的设备改过：合并后再传
      if (!cfg.dirty) return;
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

  /** 传本机还没上传、而且有条目在用的录音（没被条目引用的不传：比如导入时预览了又取消的文件）。
   *  传之前仓库必须是这一轮确认过私有的 */
  async function uploadClips(cfg) {
    if (!store) return;
    await resetIfRepoChanged(cfg);
    const refs = referencedClips(o.getState());
    const todo = (await store.pendingUploads()).filter(c => refs.has(c.sha256));
    changed({ pendingUp: todo.length, uploading: todo.length > 0 });
    let err = null;
    try {
      if (todo.length && verifiedRound !== round) await ensurePrivate(cfg, true);
      for (const c of todo) {
        if (stopped(cfg)) return;
        try {
          await uploadClip(cfg, c.sha256, refs.get(c.sha256) || c.mime);
          changed({ pendingUp: Math.max(0, st.pendingUp - 1) });
        } catch (e) {
          if (!(e instanceof SyncError) || (FATAL.includes(e.code) && e.code !== 'net')) throw e;
          err = { code: e.code === 'shaMismatch' ? 'shaMismatch' : 'audioUp', vars: { ...(e.vars || {}) } };   // 这段先跳过，下一轮再试；文字照常同步
          if (e.code === 'net') break;               // 断网 / 大文件传超时：这一轮不再传录音，真断网的话下面拉取时会报离线
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

  function fetchClip(cfg, sha, mime) {
    if (inflight.has(sha)) return inflight.get(sha);
    const p = (async () => {
      const have = await store.getClip(sha);
      if (have && have.blob) return have.blob;
      const bytes = await getBytes(cfg, contents(cfg, audioPath(sha, mime)));
      if (!bytes) { missingAt.set(sha, Date.now()); return null; }      // 对方还没传上来
      missingAt.delete(sha);
      if (await sha256Hex(bytes) !== sha) throw new SyncError('shaMismatch');   // 下载坏了或文件被改过：丢掉，下次重下
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
        const todo = await missingClips();
        changed({ pendingDown: todo.length });
        for (const [sha, mime] of todo) {
          const cur = o.getConfig();
          if (!cur || cur.repo !== cfg.repo) return;                        // 停止同步或换了仓库
          const miss = missingAt.get(sha);
          if (miss && Date.now() - miss < MISSING_RETRY_MS) continue;
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
   *  mime：已经没有条目引用的录音（恢复旧版本时）要给，才找得到仓库里的文件名 */
  async function getAudio(sha, mimeHint = null) {
    sha = String(sha || '').toLowerCase();
    if (!store || !/^[0-9a-f]{64}$/.test(sha)) return null;
    const have = await store.getClip(sha);
    if (have && have.blob) return have.blob;
    const cfg = o.getConfig();
    if (!cfg) return null;
    const mime = referencedClips(o.getState(), { includeDeleted: true }).get(sha) || mimeHint || 'audio/mp4';
    const blob = await fetchClip(cfg, sha, mime);
    if (blob && !dlLoop) changed({ pendingDown: (await missingClips()).length });
    return blob;
  }

  // ---------- 一轮同步 ----------
  async function run() {
    const cfg = o.getConfig();
    if (!cfg) return { ok: true, skipped: true };
    changed({ running: true });
    let ok = false;
    round++;
    try {
      await ensurePrivate(cfg);
      await uploadClips(cfg);                        // 先传录音：别的设备看到条目时，录音已经在云端了
      if (stopped(cfg)) return { ok: false, skipped: true };
      await pull(cfg);
      if (stopped(cfg)) return { ok: false, skipped: true };
      if (cfg.dirty) await push(cfg);
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

  /** 同一时间只跑一个同步 */
  function syncNow() {
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  }

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
    const r = await gh(cfg, 'GET', contents(cfg, SYNC_FILE) + '?ref=' + encodeURIComponent(ref), { accept: ACCEPT_RAW, timeout: 60000 });
    if (r.status === 404) return null;
    if (!r.ok) throw httpError(r);
    let text;
    try { text = await r.text(); } catch (e) { throw new SyncError('net'); }
    let d = null;
    try { d = JSON.parse(text); } catch (e) { d = null; }
    return d && d.app === 'babble' && d.state && typeof d.state === 'object' ? d : null;
  }

  return { syncNow, checkRepo, getAudio, status, idle, commits, fileAt };
}
