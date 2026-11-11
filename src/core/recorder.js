// 录音机：idle → requesting → recording → stopping → saved | error。
// 每秒一片（timeslice 1000）立刻存进 audioStore.rec；App 被杀、来电打断，下次启动 recoverPending() 能把它拼回来。
// 依赖都能注入（测试用假的）；不传就用浏览器自带的。import 时不碰 DOM。
import { readMp4Meta } from './mp4meta.js';
import { baseMime } from './audioStore.js';

export const REC_STATES = ['idle', 'requesting', 'recording', 'stopping', 'saved', 'error'];
/** 录音时持有的 Web Lock 名字前缀：别的标签页启动时看到锁还在，就知道这段录音没丢、别去「找回」 */
export const REC_LOCK = 'babble-rec:';
const CONSTRAINTS = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } };

const nav = (k) => (globalThis.navigator ? globalThis.navigator[k] : undefined) || null;
const msgOf = (e) => (e && (e.message || e.name)) || String(e);
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } };
const newRecId = () => 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
/** getUserMedia 的错误 → denied（没给权限）| nomic（没有麦克风 / 被占用）| unsupported | failed */
function micError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'NotReadableError' || n === 'AbortError') return 'nomic';
  if (n === 'TypeError' || n === 'NotSupportedError') return 'unsupported';
  return 'failed';
}

/**
 * @param {object} o
 * @param {object} o.audioStore     src/core/audioStore.js（或 memoryStore()）
 * @param {(level: number) => void} [o.onLevel]        0..1，约每 100 ms 一次（不传就不开 AudioContext）
 * @param {(state: string, info?: object) => void} [o.onState]
 *        info：requesting/recording → { recId }（recording 时存盘失败会再报一次 { warn: 'persist' }）；
 *              stopping → { reason }；saved → stop() 的结果；error → { code, message?, reason? }
 *              code：unsupported | denied | nomic | failed | empty（一点声音数据都没有）|
 *                    save（存 clip 失败：分片留着下次启动找回；info.blob 是这段录音，页面可以提供下载兜底）
 * @param {number} [o.maxMs]        到时自动停止并保存（默认 10 分钟）
 * @param {Function|null} [o.getUserMedia]  (constraints) → Promise<MediaStream>
 * @param {Function|null} [o.MediaRecorder] @param {object|null} [o.wakeLock] navigator.wakeLock
 * @param {object|null} [o.audioSession] navigator.audioSession @param {Function|null} [o.AudioContext]
 * @param {object|null} [o.locks] navigator.locks @param {object|null} [o.doc] document（visibilitychange）
 * @param {() => number} [o.now] @param {number} [o.timeslice]
 * @param {number} [o.writeWaitMs]  stop 时最多等分片写完多久（IndexedDB 卡住也不会一直「保存中」）
 * @param {number} [o.saveWaitMs]   存 clip 最多等多久，超时按存失败处理（error save，页面提供下载）
 * @returns {{ readonly state: string, start(opts?: {attachTo?: string}): Promise<void>,
 *   stop(opts?: {reason?: string}): Promise<{sha256, mime, bytes, durationSec, startedAt, tz, attachTo?, recId, reason, chunks}|null>,
 *   discard(): Promise<void>, elapsedMs(): number, stats(): object }}
 */
export function createRecorder(o = {}) {
  const {
    audioStore, onLevel, onState, maxMs = 10 * 60 * 1000, timeslice = 1000, now = () => Date.now(), writeWaitMs = 3000, saveWaitMs = 60000,
    getUserMedia = defaultGetUserMedia(), MediaRecorder: MR = globalThis.MediaRecorder || null,
    wakeLock = nav('wakeLock'), audioSession = nav('audioSession'),
    AudioContext: AC = globalThis.AudioContext || globalThis.webkitAudioContext || null,
    locks = nav('locks'), doc = globalThis.document || null,
  } = o;
  let state = 'idle', cur = null, stopping = null, lastMs = 0;
  const set = (s, info) => { state = s; if (onState) { try { onState(s, info); } catch (e) { console.error(e); } } };

  // ---------- 开始 ----------
  async function start({ attachTo = null } = {}) {
    if (state === 'requesting' || state === 'recording' || state === 'stopping') return;
    if (!audioStore) throw new Error('createRecorder: audioStore required');
    if (!getUserMedia || !MR) { set('error', { code: 'unsupported' }); return; }
    const r = cur = { recId: newRecId(), attachTo: attachTo || null, chunks: [], seq: 0, bytes: 0, writes: Promise.resolve(), mime: '' };
    set('requesting', { recId: r.recId });
    // 下面三件在第一个 await 之前做：还在点按的手势里（iOS 的 AudioContext、音频会话、Wake Lock 都要手势或前台）
    sessionTo(r, 'play-and-record');
    openLevel(r);
    requestWake(r);
    let stream;
    try { stream = await getUserMedia(CONSTRAINTS); }
    catch (e) { return fail(r, { code: micError(e), message: msgOf(e) }); }
    if (r.cancelled) { stopTracks(stream); teardown(r); return; }     // 等权限时已经丢弃了
    r.stream = stream;
    let mr;
    try { mr = new MR(stream); }            // 不指定格式：Safari → audio/mp4，Chrome → audio/webm
    catch (e) { return fail(r, { code: 'unsupported', message: msgOf(e) }); }
    r.mr = mr;
    mr.addEventListener('dataavailable', (e) => onData(r, e.data));
    mr.addEventListener('error', (e) => { r.mrError = (e && e.error) || e; finalize(r, 'error'); });
    mr.addEventListener('stop', () => { r.mrStopped = true; if (r.onMrStop) r.onMrStop(); else finalize(r, 'ended'); });
    for (const tr of tracksOf(stream)) {
      tr.addEventListener('ended', () => finalize(r, 'interrupted'));
      tr.addEventListener('mute', () => finalize(r, 'interrupted'));     // 来电、Siri、锁屏：先把录到的存好
    }
    holdLock(r);
    r.mime = baseMime(mr.mimeType);
    r.startedAt = now();
    r.tz = localTz();
    // 没写进去（或 IndexedDB 一直不回）：照样开始录，下一片时再写
    try { await within(audioStore.putRecMeta(metaOf(r)), writeWaitMs); r.metaOk = true; } catch (e) { r.warn = 'persist'; }
    if (r.cancelled) { teardown(r); await within(audioStore.clearRec(r.recId), writeWaitMs).catch(() => {}); return; }
    try { mr.start(timeslice); }
    catch (e) { await audioStore.clearRec(r.recId).catch(() => {}); return fail(r, { code: 'failed', message: msgOf(e) }); }
    r.startT = now();
    if (!r.mime && mr.mimeType) {          // Chrome 开始后才知道格式：补写 recMeta
      r.mime = baseMime(mr.mimeType);
      r.writes = r.writes.then(() => audioStore.putRecMeta(metaOf(r))).then(() => { r.metaOk = true; }, () => {});
    }
    if (maxMs > 0) r.maxTimer = setTimeout(() => finalize(r, 'max'), maxMs);
    hookLevel(r);
    if (doc && doc.addEventListener) {
      const onVis = () => { if (doc.visibilityState === 'visible' && !r.torn && !r.wake) requestWake(r); };
      doc.addEventListener('visibilitychange', onVis);
      r.offVis = () => doc.removeEventListener('visibilitychange', onVis);
    }
    set('recording', { recId: r.recId });
    if (r.warn) set('recording', { recId: r.recId, warn: r.warn });
  }
  function fail(r, info) {
    teardown(r);
    if (cur === r) cur = null;
    if (!r.cancelled) set('error', info);
  }
  const metaOf = (r) => ({ recId: r.recId, startedAt: r.startedAt, mime: r.mime || '', tz: r.tz, ...(r.attachTo ? { attachTo: r.attachTo } : {}) });

  // 每一片立刻存盘（串行，保证顺序；stop 时等它们写完，最多等 writeWaitMs）。
  // recMeta 还没写进去就先补写（没有它 recoverPending 找不到这段）；某一片失败重试一次（第 0 片是文件头，丢了整段都放不了）
  function onData(r, blob) {
    if (!blob || !blob.size || r.cancelled) return;
    const seq = r.seq++;
    r.chunks.push(blob);
    r.bytes += blob.size;
    const fixMime = !r.mime && blob.type;
    if (fixMime) r.mime = baseMime(blob.type);
    r.writes = r.writes.then(async () => {
      if (r.cancelled) return;
      let err = null;
      if (fixMime || !r.metaOk) { try { await audioStore.putRecMeta(metaOf(r)); r.metaOk = true; } catch (e) { err = e; } }
      try { await audioStore.putChunk(r.recId, seq, blob); }
      catch (e) { try { await audioStore.putChunk(r.recId, seq, blob); } catch (e2) { err = e2; } }
      if (err) throw err;
    }).catch((e) => {
      if (r.warn) return;
      r.warn = 'persist';      // 存不进去也继续录：内存里还有，stop 时照样能存（只是被杀就找不回了）
      if (cur === r && state === 'recording') set('recording', { recId: r.recId, warn: 'persist', message: msgOf(e) });
    });
  }
  function finalize(r, reason) { if (cur === r && state === 'recording') stop({ reason }).catch(e => console.error(e)); }

  // ---------- 停止并保存 ----------
  async function stop({ reason = 'user' } = {}) {
    if (state === 'stopping' && stopping) return stopping;
    if (state === 'requesting' && cur) { await discard(); return null; }   // 还没开始录（在等权限）：取消，别在后台偷偷开始
    if (state !== 'recording' || !cur) return null;
    const r = cur;
    set('stopping', { reason });
    stopping = (async () => {
      r.endT = now();
      lastMs = r.endT - r.startT;
      clearTimeout(r.maxTimer);
      await stopMr(r);                       // 等最后一片 dataavailable 和 stop
      teardown(r, true);                     // 麦克风、常亮、音频会话马上放掉；Web Lock 留到存好、条目建好（别的标签页别去「找回」）
      await within(r.writes, writeWaitMs).catch(() => {});   // 某一片一直写不完（iOS 挂起又恢复后偶尔这样）：不等了，内存里有完整的
      cur = null;
      const durationSec = Math.round(lastMs / 100) / 10;
      const mime = r.mime || 'audio/mp4';
      const blob = new Blob(r.chunks, { type: mime });
      r.chunks = [];
      if (!blob.size) {
        await within(audioStore.clearRec(r.recId), writeWaitMs).catch(() => {});
        unlock(r);
        set('error', { code: 'empty', reason });
        return null;
      }
      let clip;
      try { clip = await within(audioStore.putClip(blob, { mime }), saveWaitMs); }
      catch (e) { unlock(r); set('error', { code: 'save', message: msgOf(e), reason, recId: r.recId, blob }); return null; }   // 分片还在：下次启动找回；blob 给页面兜底（提供下载）
      // 先标「已存好」再删分片：万一条目还没建 App 就没了，下次启动 recoverPending 还会把它交回去（已在条目里的 App 会跳过）
      await within((async () => {
        await audioStore.putRecMeta({ ...metaOf(r), done: true, sha256: clip.sha256, bytes: clip.bytes, durationSec });
        await audioStore.clearChunks(r.recId);
      })(), writeWaitMs).catch(() => { /* 清不掉也没关系：下次启动 recoverPending 会处理 */ });
      const result = {
        sha256: clip.sha256, mime: clip.mime, bytes: clip.bytes, durationSec, startedAt: r.startedAt, tz: r.tz,
        ...(r.attachTo ? { attachTo: r.attachTo } : {}), recId: r.recId, reason, chunks: r.seq,
      };
      try { set('saved', result); } finally { unlock(r); }   // 页面在 saved 回调里同步建好条目，之后才放锁
      return result;
    })();
    try { return await stopping; } finally { stopping = null; }
  }
  function stopMr(r) {
    const mr = r.mr;
    if (!mr || r.mrStopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); r.onMrStop = null; resolve(); };
      r.onMrStop = done;
      // 已经自己停了（出错、麦克风没了）：最后一片和 stop 事件马上会来，也可能永远不来 → 等一会儿就算
      const inactive = mr.state === 'inactive';
      timer = setTimeout(done, inactive ? 1500 : 4000);
      if (!inactive) { try { mr.stop(); } catch (e) { done(); } }
    });
  }

  // ---------- 丢弃（长按 ✕） ----------
  async function discard() {
    const r = cur;
    if (!r || state === 'stopping') { if (!r && state !== 'idle' && state !== 'stopping') set('idle'); return; }
    r.cancelled = true;
    cur = null;
    clearTimeout(r.maxTimer);
    if (r.mr) await stopMr(r);
    teardown(r, true);                       // 锁等分片清掉再放：别的标签页别把丢弃的这段「找回」
    await within(r.writes, writeWaitMs).catch(() => {});
    await within(audioStore.clearRec(r.recId), writeWaitMs).catch(() => {});
    unlock(r);
    lastMs = 0;
    set('idle', { discarded: true });
  }

  // ---------- 收尾（可重复调用）；keepLock：Web Lock 先留着（stop 存好以后再放） ----------
  function teardown(r, keepLock = false) {
    if (!keepLock) unlock(r);
    if (r.torn) return;
    r.torn = true;
    clearTimeout(r.maxTimer);
    stopTracks(r.stream);
    closeLevel(r);
    if (r.wake) { const w = r.wake; r.wake = null; Promise.resolve().then(() => w.release()).catch(() => {}); }
    sessionBack(r);
    if (r.offVis) { r.offVis(); r.offVis = null; }
  }
  function unlock(r) { if (r.unlock) { r.unlock(); r.unlock = null; } }

  // 音频会话：录音时 play-and-record，结束后回到原来的（一般是 auto）
  function sessionTo(r, type) {
    if (!audioSession) return;
    try { r.prevSession = audioSession.type; audioSession.type = type; } catch (e) { /* 不支持就算了 */ }
  }
  function sessionBack(r) {
    if (!audioSession || !('prevSession' in r)) return;
    try { audioSession.type = r.prevSession && r.prevSession !== 'play-and-record' ? r.prevSession : 'auto'; } catch (e) { /* 同上 */ }
  }

  // 屏幕常亮：开始时要一次，切回前台（visible）时没有就再要
  async function requestWake(r) {
    if (!wakeLock || !wakeLock.request || r.torn) return;
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return;
    try {
      const s = await wakeLock.request('screen');
      if (r.torn) { Promise.resolve().then(() => s.release()).catch(() => {}); return; }
      r.wake = s;
      if (s && s.addEventListener) s.addEventListener('release', () => { if (r.wake === s) r.wake = null; });
    } catch (e) { r.wakeError = msgOf(e); /* 低电量模式等会拒绝：不影响录音 */ }
  }

  // 正在录的这段拿着 Web Lock，结束才放
  function holdLock(r) {
    if (!locks || !locks.request) return;
    try {
      const held = new Promise((res) => { r.unlock = res; });
      Promise.resolve(locks.request(REC_LOCK + r.recId, () => held)).catch(() => {});
    } catch (e) { /* 不支持就算了 */ }
  }

  // 电平（尽力而为：失败不影响录音）
  function openLevel(r) {
    if (!AC || !onLevel) return;
    try {
      r.ctx = new AC();
      if (r.ctx.state === 'suspended' && r.ctx.resume) r.ctx.resume().catch(() => {});
    } catch (e) { r.ctx = null; }
  }
  function hookLevel(r) {
    if (!r.ctx || !r.stream) return;
    try {
      const an = r.ctx.createAnalyser();
      an.fftSize = 1024;
      r.ctx.createMediaStreamSource(r.stream).connect(an);
      const f = an.getFloatTimeDomainData ? new Float32Array(an.fftSize) : null;
      const b = f ? null : new Uint8Array(an.fftSize);
      r.levelTimer = setInterval(() => {
        let sum = 0;
        if (f) { an.getFloatTimeDomainData(f); for (const v of f) sum += v * v; }
        else { an.getByteTimeDomainData(b); for (const v of b) { const x = (v - 128) / 128; sum += x * x; } }
        const rms = Math.sqrt(sum / an.fftSize);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;
        try { onLevel(Math.max(0, Math.min(1, (db + 60) / 60))); } catch (e) { /* 页面的事 */ }
      }, 100);
    } catch (e) { closeLevel(r); }
  }
  function closeLevel(r) {
    clearInterval(r.levelTimer);
    r.levelTimer = null;
    if (r.ctx) { const c = r.ctx; r.ctx = null; try { Promise.resolve(c.close()).catch(() => {}); } catch (e) { /* 已关 */ } }
  }

  return {
    get state() { return state; },
    start, stop, discard,
    /** 计时器时长（毫秒）：录音中是到现在，停了是最后一段的长度 */
    elapsedMs: () => (cur ? (cur.startT ? (cur.endT || now()) - cur.startT : 0) : lastMs),
    /** 诊断用：{ recId, chunks, bytes, mime, wakeLock, wakeError, warn } */
    stats: () => {
      const r = cur;
      return r ? { recId: r.recId, chunks: r.seq, bytes: r.bytes, mime: r.mime, wakeLock: !!r.wake, wakeError: r.wakeError || null, warn: r.warn || null } : null;
    },
  };
}

/** 最多等 ms 毫秒，超时 reject（IndexedDB 偶尔一直不回） */
function within(p, ms) {
  let timer;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

function defaultGetUserMedia() {
  const md = nav('mediaDevices');
  return md && md.getUserMedia ? (c) => md.getUserMedia(c) : null;
}
function stopTracks(stream) {
  if (!stream) return;
  for (const tr of stream.getTracks ? stream.getTracks() : tracksOf(stream)) { try { tr.stop(); } catch (e) { /* 已停 */ } }
}
const tracksOf = (stream) => (stream && stream.getAudioTracks ? stream.getAudioTracks() : stream && stream.getTracks ? stream.getTracks() : []);

/**
 * 启动时调用：上次没收尾的录音（还留着 recMeta 的）拼起来存成 clip（recMeta 标成 done、删掉分片），返回找回的列表。
 * before：只处理这个时刻之前开始的录音（别把这次启动后刚开始的录音当成残留）；Web Lock 还被拿着的（别的标签页正在录）也跳过。
 * 已经存成 clip 但条目可能没建的（recMeta.done）也一并返回：App 按 sha256 跳过已经在条目里的。
 * recMeta 不在这里删：App 把条目建好、存进本机以后再 clearRec(recId)（中途被杀、存不下，下次启动还会交回来）。
 * 一点数据都没有的直接清掉；某一段处理失败就留着，下次再试。
 * @returns {Promise<Array<{sha256, mime, bytes, durationSec: number|null, startedAt, tz: string|null, attachTo?: string, recId}>>}
 */
export async function recoverPending({ audioStore, before = Date.now(), locks = nav('locks') } = {}) {
  if (!audioStore) return [];
  const metas = await audioStore.listRecMeta();
  if (!metas.length) return [];
  let held = new Set();
  if (locks && locks.query) {
    try { const q = await locks.query(); held = new Set((q.held || []).map(l => l.name)); } catch (e) { /* 查不了就不管 */ }
  }
  const out = [];
  for (const m of metas.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    if (m.startedAt != null && m.startedAt >= before) continue;
    if (held.has(REC_LOCK + m.recId)) continue;
    try {
      let clip = null;
      if (m.done && m.sha256 && await audioStore.hasClip(m.sha256)) {
        clip = { sha256: m.sha256, mime: m.mime || 'audio/mp4', bytes: m.bytes ?? null, durationSec: m.durationSec ?? null };
      } else {
        const chunks = await audioStore.getChunks(m.recId);
        const mime = baseMime(m.mime || (chunks[0] && chunks[0].type)) || 'audio/mp4';
        const blob = new Blob(chunks, { type: mime });
        if (blob.size) {
          const saved = await audioStore.putClip(blob, { mime });
          clip = { ...saved, durationSec: readMp4Meta(await blob.arrayBuffer()).durationSec };   // Safari 的分片 mp4 读不出 → null
          await audioStore.putRecMeta({ ...m, mime, done: true, sha256: clip.sha256, bytes: clip.bytes, durationSec: clip.durationSec });
          await audioStore.clearChunks(m.recId);
        }
      }
      if (clip) out.push({ ...clip, startedAt: m.startedAt ?? null, tz: m.tz || null, ...(m.attachTo ? { attachTo: m.attachTo } : {}), recId: m.recId });
      else await audioStore.clearRec(m.recId);
    } catch (e) {
      console.warn('recoverPending', m.recId, e);
    }
  }
  return out;
}
