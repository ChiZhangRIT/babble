// 床头模式的引擎：整夜开着麦克风，听到像说话的声音就存一小段（连同前面 8 秒）进本机的 babble-night，早上在「昨夜」里挑。
//   开始（必须在点按里调用）：第一个 await 之前做完音频会话、AudioContext + resume、屏幕常亮、persist、getUserMedia（同 recorder.js）。
//   麦克风 → worklets/capture.worklet.js（48k → 16k，每块 4096 = 256 ms；加不了 worklet 就用 ScriptProcessor + 同一个 Decimator）
//   → onBlock：正好全是 0 的块不算声音；15 秒环形缓冲；每帧能量进能量门；整块（按噪声底放大一份）交给说话识别（vad.js，在 worker 里）
//   → 按到达顺序判（识别 2 秒没回这块就按能量；连着 8 块 → 当识别挂了，30 秒后重启一次；说完话 2 秒清一次识别的状态）→ createClipper 的动作
//   → 一条串行的写入链：开段写候选、每秒一片 PCM、收段改成 new / 太短丢掉；某片写不进去就不前移，下一片从环形缓冲里补上；
//     收段 / 丢段没写进去的下一次心跳再试，再不行间隔加倍（20 秒起、最多 5 分钟一次），结束时再试一次。「存了几段」只算收段写好、至少有一片声音的
//   每 2 秒 tick：断了没有（hidden / muted / ended / ctx / stall / silent；开头往前算到最后一块有声音的时刻）；
//     自己接上：每次 tick 都 resume AudioContext；收不到声音 6 秒重建 source → 20 秒重新要麦克风 → 45 秒换 AudioContext；
//     失败 3 次 → 请用户点一下（tapResume，在点按里）；常亮被收回马上再要、之后每分钟；到点自动结束
//   每 10 秒心跳改写 session（App 被杀时下次启动按它收尾），每分钟记一条 beat 事件
// 结束：收掉开着的段，放掉麦克风、AudioContext、识别、常亮、音频会话；session 写好了才放锁（NIGHT_LOCK 等写入链写完才放）。
// recoverNights：启动时把上次没收尾的标成 crashed（记下为什么停的）、开着的片段收在最后一句 + 2 秒（已结束的那几晚里漏下的也收）；
// purgeNights：按保留期限清理。
// 依赖都能注入（测试用 tests/helpers/fakeAudio.mjs）；不传就用浏览器自带的。import 时什么都不做。
import { P, frameDb, createGate, createHyst, createClipper, createRing } from './nightDetect.js';
import { nightKey, purgePlan } from './nightReport.js';
import { createVad } from './vad.js';
import { micError } from './recorder.js';
import { newId } from './store.js';
import { estimate as storageEstimate, persist as storagePersist } from './audioStore.js';
import { Decimator } from '../worklets/capture.worklet.js';

/** 同一个来源只能有一个床头模式在听（ifAvailable：另一个窗口拿不到就不开） */
export const LIVE_LOCK = 'babble-night-live';
/** + sessionId：在听时一直拿着；启动时找回看到锁还被拿着（别的标签页正在听）就跳过 */
export const NIGHT_LOCK = 'babble-night:';
/** 不要回声消除、降噪、自动增益：要原样的声音（自动增益会把安静时的噪声底抬上来） */
export const CONSTRAINTS = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };
/** 在听时没在听的原因；报告里另外还有 killed | user | leave | auto（两次之间、被杀） */
export const GAP_REASONS = ['hidden', 'muted', 'ended', 'ctx', 'stall', 'silent', 'error'];

const OP_WAIT_MS = 10000;          // 写入链里一次写最多等多久：iOS 偶尔一个事务一直不回，超时按失败，后面的照样写
const SETTLE_MAX_MS = 5 * 60000;   // 收段 / 丢段一直写不进去：再试的间隔每次加倍，最多这么久（一整夜不刷几千条 store-fail）
const RESUME_WAIT_MS = 2000, LOCK_WAIT_MS = 1000, AAC_WAIT_MS = 1000, MODULE_WAIT_MS = 5000, ESTIMATE_WAIT_MS = 5000, GUM_WAIT_MS = 15000;
// 事件记满 EVENTS_MAX 以后只记这些（外加一条 events-capped）
const CAP_KEEP = new Set(['beat', 'gap-open', 'gap-close', 'store-fail', 'vad', 'tap-needed', 'end', 'recovered']);

const nav = (k) => (globalThis.navigator ? globalThis.navigator[k] : undefined) || null;
const noop = () => {};
const msgOf = (e) => (e && (e.message || e.name)) || String(e);
const nameOf = (e) => (e && e.name) || 'Error';
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const call = (f, ...a) => { try { return Promise.resolve(f(...a)); } catch (e) { return Promise.reject(e); } };
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } };
const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || e.code === 22);
const tracksOf = (s) => (s && s.getAudioTracks ? s.getAudioTracks() : s && s.getTracks ? s.getTracks() : []);
function stopTracks(s) { for (const tr of (s && s.getTracks ? s.getTracks() : tracksOf(s))) { try { tr.stop(); } catch (e) { /* 已停 */ } } }
function defaultGetUserMedia() { const md = nav('mediaDevices'); return md && md.getUserMedia ? (c) => md.getUserMedia(c) : null; }
/** getSettings() 里关心的几项（iOS 认不认 autoGainControl:false 等，记下来调参用） */
function trackInfo(tr) {
  let s = {};
  try { s = (tr && tr.getSettings && tr.getSettings()) || {}; } catch (e) { /* 拿不到就空着 */ }
  const v = (k) => (s[k] === undefined ? null : s[k]);
  return { autoGainControl: v('autoGainControl'), echoCancellation: v('echoCancellation'), noiseSuppression: v('noiseSuppression'), sampleRate: v('sampleRate'), channelCount: v('channelCount') };
}
function standaloneOf(win) {
  try { return !!((win && win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) || nav('standalone') === true); } catch (e) { return false; }
}

/**
 * @param {object} o  都能注入；不传就用浏览器的
 * @param {object} o.store             core/nightStore.js（ctx.night）或 memoryNightStore()；没有 → 开始时报 noStore
 * @param {() => object} [o.settings]  设置（夜间时段：算这一晚是哪天）
 * @param {string|null} [o.device] @param {string|null} [o.build] @param {string|null} [o.tz] @param {object} [o.params] 常数，默认 nightDetect 的 P
 * @param {Function} [o.createVad]     () → 和 vad.js createVad() 一样的对象（一次开始最多一个 worker，结束时关掉）
 * @param {Function|null} [o.getUserMedia] @param {Function|null} [o.AudioContext] @param {Function|null} [o.AudioWorkletNode]
 * @param {URL|string} [o.workletUrl]  @param {object|null} [o.AudioEncoder] 只问一句支不支持 16 kHz 单声道 AAC（记进 session）
 * @param {object|null} [o.wakeLock] @param {object|null} [o.audioSession] @param {object|null} [o.locks] @param {object|null} [o.doc] @param {object|null} [o.win]
 * @param {() => Promise<boolean>} [o.persist] @param {() => Promise<{usage, quota}|null>} [o.estimate]
 * @param {() => number} [o.now] @param {Function} [o.setInterval] @param {Function} [o.clearInterval] @param {Function} [o.setTimeout] @param {Function} [o.clearTimeout]
 * @param {() => boolean} [o.sttBusy]  正在转文字：不开始，也不预先载入识别（两个 ONNX 一起在 iPhone 上怕内存不够）
 * @param {(status: object) => void} [o.onStatus]  phase、gap、needTap、vad、warn、wake、clips 变了才叫（不会每块叫一次）
 * @returns {{ readonly phase: string, prepare(): Promise<{vad: 'ready'|'off', freeBytes: number|null, budgetSec: number}>,
 *   start(opts?: {autoEndAt?: number|null}): Promise<void>, tapResume(): Promise<void>,
 *   end(reason?: 'user'|'auto'|'leave'|'error'): Promise<{sessionId, nightOf, reason, listenedMs, clips, unsaved}|null>, dispose(): void, status(): object }}
 *   clips：存好了的段数（收段写好、至少有一片声音）；unsaved：收了段却没存进来的（一片声音都没写进去、或收段一直没写进去）
 *   phase：idle | preparing | ready | starting | live | ending | ended | error
 *   status()：{ phase, sessionId, nightOf, startedAt, autoEndAt, listening, gap: {reason, from, needTap}|null, clips, lastClipAt,
 *              vad: 'loading'|'on'|'off', wake, capture: 'worklet'|'script'|null, warn: null|'store'|'full',
 *              error: {code: denied|nomic|unsupported|failed|otherTab|sttBusy|noStore, message}|null }
 */
export function createBedside(o = {}) {
  const {
    store = null, settings = () => ({}), device = null, build = null, tz = localTz(), params: p = P,
    createVad: makeVad = createVad, getUserMedia = defaultGetUserMedia(),
    AudioContext: AC = globalThis.AudioContext || globalThis.webkitAudioContext || null,
    AudioWorkletNode: AWN = globalThis.AudioWorkletNode || null,
    workletUrl = new URL('../worklets/capture.worklet.js', import.meta.url), AudioEncoder: AE = globalThis.AudioEncoder || null,
    wakeLock = nav('wakeLock'), audioSession = nav('audioSession'), locks = nav('locks'),
    doc = globalThis.document || null, win = globalThis.window || null, persist = storagePersist, estimate = storageEstimate,
    now = () => Date.now(), setInterval: si = (f, ms) => setInterval(f, ms), clearInterval: ci = (id) => clearInterval(id),
    setTimeout: st = (f, ms) => setTimeout(f, ms), clearTimeout: ct = (id) => clearTimeout(id), sttBusy = () => false, onStatus = null,
  } = o;
  const SR = p.SR, F = p.FRAME, S = (sec) => Math.round(sec * SR);

  // 几次开始之间都在的：阶段；识别（准备页先载入，结束时关掉）
  let phase = 'idle', error = null, prepP = null, vad = null, loadedVad = null, gen = 0, endP = null, summary = null, lastSig = '';
  // 这一次（start → end）的，fresh() 重置
  let ac, stream, track, source, node, gainNode, moduleAc, capture, graphAt, blocks, session, counts, early, w, autoEnd,
    ring, gate, hyst, clipper, pend, decided, lateRun, zeroSince, lastLiveAt, lastBlockAt, samples, draining,
    cur, lastClose, lastClipAt, storeBad, sessBad, fullWhy, vadDead, vadIsDown, vadRestarts, vadT, vadGain, vadQuiet, vadArmed, vadStuck,
    gap, needTap, tryAge, lastTry, tried, pending, fails, delay, stepAt, busy, resuming, unsettled,
    tickT, beatT, lastTick, lastBeatLog, beatBusy, beatAgain, capped, wake, asking, wakeRetryAt, hiddenAt, shownAt,
    unlockLive, unlockNight, prevSession, hadPrev, offs, offTrack, offCtx, torn;
  function fresh() {
    ac = stream = track = source = node = gainNode = moduleAc = capture = session = cur = lastClose = lastClipAt = fullWhy = gap = null;
    ring = gate = hyst = clipper = autoEnd = zeroSince = vadT = tickT = beatT = hiddenAt = shownAt = unlockLive = unlockNight = prevSession = wake = null;
    graphAt = blocks = decided = lateRun = lastLiveAt = lastBlockAt = samples = vadRestarts = lastTick = lastBeatLog = wakeRetryAt = vadGain = vadQuiet = 0;
    draining = storeBad = sessBad = vadIsDown = needTap = busy = resuming = beatBusy = beatAgain = capped = asking = hadPrev = torn = vadArmed = vadStuck = false;
    counts = { clips: 0, unsaved: 0, dropped: 0, writeFail: 0, lostSec: 0, wakeLost: 0, resumes: 0, taps: 0, vadRestarts: 0, late: 0, maxTickGapMs: 0, events: 0 };
    early = []; pend = []; offs = []; w = Promise.resolve(); offTrack = offCtx = noop; unsettled = new Map();
    vadDead = !!vad && vad.state === 'off'; error = summary = endP = null;
    resetLadder();
  }
  function resetLadder() { tryAge = 0; lastTry = null; tried = 0; pending = false; fails = 0; delay = p.RETRY_MIN_MS; stepAt = 0; }
  fresh();

  // ---------- 状态 ----------
  const visible = () => !doc || !doc.visibilityState || doc.visibilityState === 'visible';
  const vadOn = () => !!vad && !vadDead && !vadIsDown && vad.state === 'ready';
  const vadState = () => (!vad || vadDead || vadIsDown || vad.state === 'off' ? 'off' : vad.state === 'ready' ? 'on' : 'loading');
  const statsOf = (v) => { try { return (v && v.stats && v.stats()) || {}; } catch (e) { return {}; } };
  // storeBad：分片（声音）写不进去，下一片写好了才清；收段 / 丢段写不进去的留在 unsettled 里，再写好了就不算；sessBad：session 写不进去，下一次写好了清
  const stuck = () => { for (const x of unsettled.values()) if (x.tries) return true; return false; };
  const warnOf = () => (storeBad || sessBad || stuck() ? 'store' : fullWhy ? 'full' : null);
  function status() {
    return { phase, sessionId: session ? session.id : null, nightOf: session ? session.nightOf : null, startedAt: session ? session.startedAt : null,
      autoEndAt: autoEnd, listening: phase === 'live' && !gap, gap: gap ? { reason: gap.reason, from: gap.from, needTap } : null,
      clips: counts.clips, lastClipAt, vad: vadState(), wake: !!wake, capture, warn: warnOf(), error };
  }
  function emit() {
    const s = status(), sig = JSON.stringify(s);
    if (sig === lastSig) return;
    lastSig = sig;
    if (onStatus) { try { onStatus(s); } catch (e) { console.error(e); } }
  }
  function fail(code, e) { error = { code, message: e ? msgOf(e) : '' }; phase = 'error'; emit(); }
  /** 最多等 ms 毫秒，超时 reject（IndexedDB、resume、权限偶尔一直不回） */
  function within(pr, ms) {
    return new Promise((res, rej) => {
      const id = st(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
      Promise.resolve(pr).then((v) => { ct(id); res(v); }, (e) => { ct(id); rej(e); });
    });
  }
  const once = (f) => within(call(f), OP_WAIT_MS);
  const twice = (f) => once(f).catch(() => once(f));
  /** 写入链：所有写库一个接一个，按顺序（前一个失败不挡后一个） */
  function chain(fn) { const pr = w.then(fn); w = pr.catch(noop); return pr; }

  // ---------- 记录 ----------
  /** 事件（events store，走写入链，写不进去就算了）；session 还没建好时先攒着 */
  function log(k, d, t = now()) {
    if (!session) { early.push([t, k, d]); return; }
    if (counts.events >= p.EVENTS_MAX && !CAP_KEEP.has(k)) { if (capped) return; capped = true; k = 'events-capped'; d = undefined; }
    counts.events++;
    const sid = session.id;
    chain(() => once(() => store.logEvent(sid, t, k, d))).catch(noop);
  }
  function wroteBad(e, what) {
    counts.writeFail++;
    if (!isQuota(e)) { if (what === 'session') sessBad = true; else if (what === 'part') storeBad = true; }     // 存储满了另说：后面只数次数（显示 full）；删多写的分片失败不碍事
    log('store-fail', { what, name: nameOf(e) });
    emit();
  }
  const mine = () => { const { reviewedAt, ...rest } = session; return rest; };      // reviewedAt 归夜间页
  /** 整个 session 改写一遍（第一次没写进去就补上）；写的那一刻才取值，晚到的写也不会把旧状态写回去 */
  async function writeSession(retry) {
    const f = retry ? twice : once, s = mine();
    if (!(await f(() => store.patchSession(s.id, s)))) await f(() => store.putSession({ ...s, reviewedAt: null }));
  }
  const aliveNow = () => ({ at: now(), vis: visible(), track: !track ? 'none' : track.readyState === 'ended' ? 'ended' : 'live', muted: !!(track && track.muted),
    ctx: ac ? ac.state : 'closed', wake: !!wake, samples, lastLiveAt, floor: gate ? r1(gate.floor()) : null, thr: gate ? r1(gate.thr()) : null, q: pend.length,
    gain: vadOn() ? r1(vadGain) : null });
  function syncSession() {
    const s = statsOf(vad), full = session.notes.find(n => (n.kind === 'budget' || n.kind === 'storage') && n.to == null);
    session.vad = vadState(); session.capture = capture;
    if (ac) session.rate = ac.sampleRate;
    if (s.msAvg != null) session.vadMs = s.msAvg;
    if (full && clipper) full.n = clipper.heard;           // 存满以后又听到几次
  }
  /** 心跳：每 10 秒，切到后台 / 回到前台、pagehide、断了 / 接上时也写；同一时间只写一个，写的时候又来的等它写完再写一次（不丢） */
  function beat() {
    if (phase !== 'live') return;
    const t = now();
    session.alive = aliveNow(); syncSession();
    if (t - lastBeatLog >= p.BEAT_LOG_MS) { lastBeatLog = t; log('beat', session.alive); }
    retrySettle();
    if (beatBusy) { beatAgain = true; return; }
    beatBusy = true;
    chain(() => writeSession(false)).then(() => { sessBad = false; }, (e) => wroteBad(e, 'session'))
      .then(() => { beatBusy = false; emit(); if (beatAgain && phase === 'live') { beatAgain = false; beat(); } });
  }
  function addNote(kind, from, extra) { session.notes.push({ kind, from: Math.round(from), to: null, ...extra }); }
  function endNote(kind, to) {
    for (let i = session.notes.length - 1; i >= 0; i--) { const n = session.notes[i]; if (n.kind === kind && n.to == null) { n.to = Math.round(Math.max(n.from, to)); return; } }
  }
  const vadNote = (from) => { if (!session.notes.some(n => n.kind === 'vad' && n.to == null)) addNote('vad', from); };

  // ---------- 片段 → 写库 ----------
  const wallOf = (s) => lastBlockAt - (ring.total - s) * 1000 / SR;      // 绝对样本下标 → 墙上时间（环里只有最近一次接上以后的）
  function apply(actions) {
    for (const a of actions) {
      if (a.type === 'open') openClip(a);
      else if (a.type === 'close') closeClip(a);
      else if (a.type === 'drop') dropClip(a);
      else if (a.type === 'noise') { addNote('noise', wallOf(a.at)); log('noise-on'); }
      else if (a.type === 'noiseEnd') { endNote('noise', wallOf(a.at)); log('noise-off'); }
      else if (a.type === 'full') { fullWhy = a.why; addNote(a.why, wallOf(a.at), { n: clipper.heard }); log('full', { why: a.why }); emit(); }
      else if (a.type === 'hold') { addNote('budget', wallOf(a.at), { n: clipper.heard, held: true }); log('hold'); }      // 只按音量时先只数次数
      else if (a.type === 'holdEnd') { syncSession(); endNote('budget', wallOf(a.at)); log('hold-off'); }
    }
  }
  function openClip(a) {
    const from = Math.max(a.from, ring.start), oi = clipper.openInfo;
    const c = cur = { id: newId('c_'), from, written: from, queued: from, seq: 0, starts: [], lost: 0, ls: oi ? oi.last - from : 0, sp: oi ? oi.sp : 0, wq: false, final: false };
    c.startAt = Math.round(wallOf(from));
    // 10 分钟封顶后接着说的：和上一段首尾相接
    const rec = c.rec = { id: c.id, s: session.id, v: 1, state: 'open', startAt: c.startAt, speechAt: Math.round(wallOf(a.at)), endAt: null, samples: null, sr: SR,
      durationSec: null, speechSec: 0, gateSec: 0, peakDb: null, vadMax: null, cut: null,
      contOf: lastClose && lastClose.cut === 'max' && lastClose.to === a.from ? lastClose.id : null, parts: 0, lostSec: 0 };
    chain(() => twice(() => store.putCand(rec))).catch((e) => wroteBad(e, 'cand'));
    writePart(c, decided);                                   // 往前带的那 8 秒先写成第 0 片
    log('clip-open', { id: c.id, pre: r1((a.at - from) / SR) });
    emit();
  }
  function closeClip(a) {
    const c = cur;
    if (!c) return;
    cur = null; c.sp = a.speechSec;
    writePart(c, a.to, true);
    const n = a.to - c.from;
    chain(async () => {                                      // 收尾点之后多写的分片删掉（跨过收尾点的那片留着：读的时候按 samples 截）
      const k = c.starts.findIndex(s => s >= a.to);
      if (k >= 0) { await twice(() => store.deleteParts(c.id, k)); c.starts.length = k; c.seq = k; }
    }).catch((e) => wroteBad(e, 'trim'));
    settle(c.id, 'cand', async () => {                       // 写的那一刻才取 parts、lostSec（前面几片可能还在写）
      const f = { state: 'new', samples: n, endAt: Math.round(c.startAt + n * 1000 / SR), durationSec: r1(n / SR), speechSec: r1(a.speechSec), gateSec: r1(a.gateSec),
        peakDb: r1(a.peakDb), vadMax: r2(a.vadMax), cut: a.cut, parts: c.seq, lostSec: r1(c.lost / SR), ...(c.seq ? {} : { gone: true }) };
      if (!(await twice(() => store.patchCand(c.id, f)))) await twice(() => store.putCand({ ...c.rec, ...f }));    // 开段时没写进去：整条补上
    }, () => { counts.lostSec = r1(counts.lostSec + c.lost / SR); }, () => {      // 写好了才算「存了一段」（一片声音都没写进去的不算）
      if (c.seq > 0) { counts.clips++; lastClipAt = c.startAt; } else counts.unsaved++;
      emit();
    }, c);
    lastClose = { id: c.id, to: a.to, cut: a.cut };
    log('clip-close', { id: c.id, sec: r1(n / SR), speechSec: r1(a.speechSec), cut: a.cut });
    emit();
  }
  function dropClip(a) {
    const c = cur;
    if (!c) return;
    cur = null; c.dropped = true; lastClose = null;
    settle(c.id, 'drop', () => twice(() => store.dropCand(c.id)));
    counts.dropped++;
    log('clip-drop', { speechSec: r2(a.speechSec), cut: a.cut });
  }
  /**
   * 收段 / 丢段（一段最后那一下）：排进写入链；两次都没写进去就留在 unsettled 里，下一次心跳再排，再失败间隔加倍（2 × HEARTBEAT_MS 起，最多 SETTLE_MAX_MS）、
   * 结束时再直接写一次，不然那段会一直是 open（报告里看不见它，要等下次启动时找回）。
   * x.q：已经排在链里了；x.next：下次最早什么时候再试；first：第一次轮到时做一次的事；ok：写好了做一次的事
   */
  function settle(id, what, fn, first = noop, ok = noop, c = null) {
    const x = { q: true, what, tries: 0, next: 0, c, fn: async () => { await fn(); if (unsettled.delete(id)) { ok(); if (x.tries) emit(); } } };      // 失败过又写好了：警告收起来
    unsettled.set(id, x);
    chain(() => { x.q = false; first(); return x.fn(); }).catch((e) => settleBad(x, e));
  }
  function settleBad(x, e) { x.next = x.tries++ ? now() + Math.min(SETTLE_MAX_MS, p.HEARTBEAT_MS * 2 ** (x.tries - 1)) : 0; wroteBad(e, x.what); }
  function retrySettle() {
    const t = now();
    for (const [id, x] of unsettled) {
      if (x.q || t < x.next) continue;
      x.q = true;
      chain(() => { x.q = false; return unsettled.get(id) === x ? x.fn() : null; }).catch((e) => settleBad(x, e));
    }
  }
  /** 一片声音写进去了：「存不进」的警告收起来（只有候选、session 写好了不算：声音还是可能在丢） */
  function wroteOk() { if (storeBad) { storeBad = false; emit(); } }
  /**
   * 写一片：排进写入链，轮到时才读环形缓冲（读到 c.queued 为止；同一段同时只排一个，链慢了就合成大一点的一片）。
   * 写不进去（重试过一次）written 不前移，下一片连这次的一起写；存储满了 → 后面只数次数
   */
  function writePart(c, upTo, final = false) {
    c.queued = upTo;
    if (final) c.final = true;
    if (c.wq) return;
    c.wq = true;
    chain(async () => {
      c.wq = false;
      const to = c.queued, fin = c.final;
      if (c.dropped || to - c.written < (fin ? 1 : S(p.PART_SEC))) return;
      if (c.written < ring.start) { c.lost += ring.start - c.written; c.written = ring.start; }    // 超过 15 秒没写进去：中间那段没了
      const part = { b: ring.read(c.written, to).buffer, ls: Math.max(0, c.ls), sp: r2(c.sp) };
      try { await twice(() => store.putPart(c.id, c.seq, part)); }
      catch (e) {
        if (fin) c.lost += to - c.written;                   // 收尾那片：后面不会再补了
        wroteBad(e, 'part');
        if (isQuota(e) && clipper && phase === 'live') apply(clipper.stopSaving(decided, 'storage'));
        return;
      }
      c.starts.push(c.written); c.seq++; c.written = to;
      wroteOk();
    });
  }

  // ---------- 声音 ----------
  function onBlock(pcm) {
    if (phase !== 'live' || !pcm || !pcm.length) return;
    const t = now();
    blocks++;
    let m = 0;
    for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > m) m = a; }
    if (!(m > 0)) { if (zeroSince == null) zeroSince = t; return; }       // 静音了、坏掉的采集送来的是正好的 0：不算声音
    zeroSince = null;
    if (gap) closeGap(t);
    lastLiveAt = lastBlockAt = t;
    const start = ring.total, n = Math.floor(pcm.length / F), dbs = new Array(n);
    ring.push(pcm);
    samples += pcm.length;
    for (let i = 0; i < n; i++) dbs[i] = frameDb(pcm, i * F, F);
    const b = { start, dbs, t, probs: undefined };
    pend.push(b);
    if (vadOn()) {
      // 只放大给识别的这份（存的声音、能量门不变）：噪声底拉到 VAD_GAIN_TARGET_DB，最多 VAD_GAIN_MAX_DB，峰值不超过 −1 dBFS（不削顶）
      const fl = gate.floor() > p.FLOOR_MIN_DB ? gate.floor() : Math.min(...dbs);      // 刚开始还没有噪声底：用这一块里最安静的一帧
      vadGain = Math.max(0, Math.min(p.VAD_GAIN_MAX_DB, p.VAD_GAIN_TARGET_DB - fl, -1 - 20 * Math.log10(m)));
      if (vadGain > 0) { const k = 10 ** (vadGain / 20); for (let i = 0; i < pcm.length; i++) pcm[i] *= k; }
      call(() => vad.push(pcm)).then((pr) => {                // pcm 转交给 worker 了，之后不能再用
        const bad = !!pr && !Array.prototype.every.call(pr, Number.isFinite);
        b.probs = pr && !bad && pr.length >= n ? pr : null;
        if (bad) vadDown('nan');
        drain();
      }, () => { b.probs = null; vadDown('run'); drain(); });
    } else b.probs = null;
    drain();
  }
  /** 按到达顺序判：识别回了、或等了 VAD_WAIT_MS 还没回（这块按能量）、或 force（中断、结束） */
  function drain(force = false) {
    if (draining || !clipper) return;
    draining = true;
    try {
      while (pend.length && (force || pend[0].probs !== undefined || now() - pend[0].t > p.VAD_WAIT_MS)) {
        const b = pend.shift();
        if (b.probs === undefined) { b.probs = null; if (!force && ++lateRun >= p.VAD_LATE_MAX) vadDown('late'); }
        else if (b.probs) lateRun = 0;
        for (let i = 0; i < b.dbs.length; i++) {
          const at = b.start + i * F, db = b.dbs[i], g = gate.push(db), prob = b.probs ? b.probs[i] : null, v = hyst.push(prob);
          if (v) { vadArmed = true; vadQuiet = 0; }
          else if (v === false && vadArmed && ++vadQuiet >= S(p.VAD_IDLE_RESET_SEC) / F) vadReset();      // 说完 2 秒：清掉大声说话留下的状态
          apply(clipper.frame({ at, speech: v ?? g, db, prob, gate: g }));       // 识别回了听识别的，没回按能量
          decided = at + F;
        }
        if (cur) {
          const oi = clipper.openInfo;
          if (oi) { cur.ls = oi.last - cur.from; cur.sp = oi.sp; }
          if (decided - cur.queued >= S(p.PART_SEC)) writePart(cur, decided);
        }
      }
    } finally { draining = false; }
  }

  // ---------- 说话识别 ----------
  function loadVad() {
    const v = vad;
    return call(() => v.load()).catch(() => false).then((ok) => { vadLoaded(v, !!ok); return !!ok; });
  }
  function vadLoaded(v, ok) {
    if (v !== vad || loadedVad === v) return;
    loadedVad = v;
    if (!ok) vadDead = true;
    if (session) {
      if (ok) { session.vadLoadMs = statsOf(v).loadMs ?? null; log('vad', { ready: true }); vadReady(); }
      else { vadNote(session.startedAt); log('vad', { load: false, err: statsOf(v).lastError || null }); }     // 一直是按能量找的：从开始算
    }
    emit();
  }
  /** 开始以后才载入好：开始时记下的「没用上识别」收在这一刻（不到 GAP_SHOW_SEC 的不记） */
  function vadReady() {
    const i = session.notes.findIndex(n => n.kind === 'vad' && n.to == null);
    if (i < 0) return;
    if (now() - session.notes[i].from < p.GAP_SHOW_SEC * 1000) session.notes.splice(i, 1); else endNote('vad', now());
  }
  /** 开始 VAD_LOAD_MAX_MS 了识别还在载入（下载卡住、没报错）：重启一次（SW 已经缓存好的文件这次直接读）；还不行就整夜按能量 */
  function vadRetryLoad() {
    const v = vad;
    vadStuck = true; loadedVad = v;                          // restart 先结束原来那次载入（当失败回来）：不理它
    log('vad', { stuck: true });
    within(call(() => v.restart()), p.VAD_LOAD_MAX_MS).catch(() => false).then((ok) => { if (v === vad && loadedVad === v) { loadedVad = null; vadLoaded(v, !!ok); } });
  }
  function vadReset() { vadArmed = false; vadQuiet = 0; if (vad) { try { vad.reset(); } catch (e) { /* 没开就算了 */ } } }
  /** 识别挂了（出错、NaN、连着 8 块没回、worker 空闲时崩了）：先只按能量；30 秒后重启一次，再挂就整夜按能量 */
  function vadDown(why) {
    if (!vad || vadDead || vadIsDown || phase !== 'live') return;
    vadIsDown = true; lateRun = 0; hyst.reset();
    for (const b of pend) if (b.probs === undefined) b.probs = null;          // 还在等的块不等了
    log('vad', { down: why, err: statsOf(vad).lastError || null }); addNote('vad', now()); emit();
    if (vadRestarts < p.VAD_MAX_RESTARTS) vadT = st(restartVad, p.VAD_RESTART_MS);
    else markOff();
  }
  async function restartVad() {
    vadT = null;
    const v = vad, g = gen;
    if (!v || phase !== 'live') return;
    counts.vadRestarts = ++vadRestarts;
    let ok = false;
    try { ok = await v.restart(); } catch (e) { ok = false; }
    if (v !== vad || g !== gen || phase !== 'live') return;
    if (!ok) { markOff(); return; }
    vadIsDown = false; vadReset();                           // 新 worker 本来就是空的
    hyst.reset(); endNote('vad', now()); log('vad', { restart: true }); emit();
  }
  function markOff() { vadDead = true; vadIsDown = false; log('vad', { off: true }); emit(); }

  // ---------- 断了 / 接上 ----------
  // 声音停下时页面已经在后台（或停下后 3 秒内切走）：原因记 hidden。回到前台才发现的时候，状态里常常还是 muted
  const hiddenThen = (from) => hiddenAt != null && hiddenAt <= from + p.STALL_MS && (shownAt == null || shownAt < hiddenAt || shownAt >= from);
  function openGap(reason) {
    if (gap || phase !== 'live') return;
    drain(true); apply(clipper.flush(decided, 'gap'));
    gate.reset(); hyst.reset(); vadReset(); lateRun = 0; lastClose = null;      // 中断之后的段不算接着上一段（contOf）
    const from = lastLiveAt || now();
    gap = { from, to: null, reason: reason !== 'hidden' && hiddenThen(from) ? 'hidden' : reason };     // 往前算到最后一块有声音的时刻
    session.gaps.push(gap); resetLadder();
    log('gap-open', { reason: gap.reason, from }); beat(); emit();
  }
  function closeGap(t) {
    gap.to = t;
    if (!gap.tap) counts.resumes++;                          // 自己接上的
    log('gap-close', { reason: gap.reason, ms: t - gap.from });
    clipper.restart(ring.total);                             // 往前带的 8 秒不越过中断
    gap = null; needTap = false; resetLadder(); beat(); emit();
  }
  /** 每次 tick 和每个监听事件之后：断了就开一段 gap；在前台、不用点的时候试着接上 */
  function check() {
    if (phase !== 'live') return;
    const t = now(), vis = visible();
    const why = !track || track.readyState === 'ended' ? 'ended' : track.muted ? 'muted' : !ac || ac.state !== 'running' ? 'ctx' : null;
    if (!gap && why) openGap(vis ? why : 'hidden');
    else if (!gap && t - Math.max(lastLiveAt, graphAt) >= p.STALL_MS) openGap(!vis ? 'hidden' : zeroSince != null ? 'silent' : 'stall');
    if (!gap || !vis) return;
    if (!needTap) recover();
    else if (ac && ac.state !== 'running' && ac.state !== 'closed') resumeCtx();     // 等点的时候也接着 resume：系统的打断结束了可能自己就好
  }
  /** 一次只做一件事；age = 这段 gap 开始试着接上以后、在前台的时间（中间在后台、被冻住的不算） */
  function recover() {
    const t = now();
    if (lastTry != null && t - lastTry <= p.LATE_MS) tryAge += t - lastTry;
    lastTry = t;
    const age = tryAge;
    if (busy) return;                                        // 上一步（要麦克风、重建）还没完
    if (!ac || ac.state === 'closed') { retry(restartContext); return; }
    if (ac.state !== 'running') { resumeCtx(); if (age >= p.RESTART_MS) askTap(); return; }       // 每次都 resume；被拒 3 次 → 请用户点
    if (!track || track.readyState === 'ended') { retry(() => reacquire(true)); return; }        // 马上重新要（60 秒内一般不用点）
    if (track.muted) { if (age >= p.MUTE_WAIT_MS) retry(() => reacquire(false)); return; }      // 一般等 unmute；来电久了再重新要
    // 状态都正常却收不到声音（stall / silent）：6 秒重建 source → 20 秒重新要麦克风 → 45 秒换 AudioContext，每级一次；之后按退避再换
    const rung = age >= p.RESTART_MS ? 3 : age >= p.REACQUIRE_MS ? 2 : age >= p.REBUILD_MS ? 1 : 0;
    if (rung > tried) {
      tried = rung; missed();
      if (needTap) return;
      stepAt = t + delay;
      if (rung === 1) { if (rebuild()) pending = true; } else if (rung === 2) reacquire(true); else restartContext();
    } else if (tried === 3) retry(restartContext);
  }
  /** 重新要麦克风、换 AudioContext 这种：间隔退避 5 → 10 → … → 60 秒 */
  function retry(fn) {
    const t = now();
    if (t < stepAt) return;
    missed();
    if (needTap) return;
    stepAt = t + delay; delay = Math.min(delay * 2, p.RETRY_MAX_MS);
    fn();
  }
  /** 上一步做成了，可到了下一步还是没声音：算失败一次 */
  function missed() { if (pending) { pending = false; step(false); } }
  function step(ok) { if (!ok && gap && ++fails >= p.TAP_AFTER) askTap(); }
  function askTap() {
    if (!gap || needTap) return;
    needTap = true; gap.tap = true;
    log('tap-needed', { reason: gap.reason, fails }); beat(); emit();
  }
  function resumeCtx() {
    const a = ac;
    if (!a || resuming) return;                              // 上一次还没回（iOS 打断时可能一直等着）：不叠
    resuming = true;
    call(() => a.resume()).then(() => { resuming = false; }, () => { resuming = false; if (a === ac) step(false); });
  }
  /** 重新要麦克风（counted：做成了但还是没声音，下一步时算失败；来电时 muted 的不算，等它自己好） */
  async function reacquire(counted) {
    const g = gen;
    busy = true;
    const gp = call(getUserMedia, CONSTRAINTS);
    let s;
    try { s = await within(gp, GUM_WAIT_MS); }                    // 一直不回也不能卡住后面几级
    catch (e) {
      busy = false;
      if (e && e.name === 'TimeoutError') gp.then(stopTracks, noop);     // 晚到的流马上关掉
      if (g !== gen) return;
      log('reacquire', { err: nameOf(e) });
      if (micError(e) === 'denied') askTap(); else step(false);     // 权限要重新给（来电久了）：只能点
      return;
    }
    busy = false;
    if (g !== gen || phase !== 'live' || !gap) { stopTracks(s); return; }    // 等的时候结束了、或者自己好了
    swapStream(s);
    if (rebuild() && counted) pending = true;
    log('reacquire', { ok: true });
  }
  function swapStream(s) {
    offTrack(); stopTracks(stream);
    stream = s; track = tracksOf(s)[0] || null;
    listenTrack();
    if (session) { session.track = trackInfo(track); log('track', session.track); }
  }
  /** 断开旧的 MediaStreamSource，新建一个接到同一个节点 */
  function rebuild() {
    if (!ac || !node || !stream) return false;
    try { if (source) source.disconnect(); } catch (e) { /* 已断 */ }
    try { source = ac.createMediaStreamSource(stream); source.connect(node); log('rebuild'); return true; }
    catch (e) { source = null; log('rebuild', { err: nameOf(e) }); step(false); return false; }
  }
  /** 关掉旧的 AudioContext，新开一个（48k）+ resume，在同一个 stream 上重建 */
  async function restartContext() {
    const g = gen;
    busy = true;
    log('restart');
    try {
      dropGraph(); closeCtx();
      ac = newAC(); listenCtx(); resumeNow(ac);
      await buildGraph(session.pull);
      if (g === gen) pending = true;
    } catch (e) { if (g === gen) { log('restart', { err: nameOf(e) }); step(false); } }
    finally { busy = false; }
  }
  /** 「点一下，接着听」：要在点按里调用（同步做：新的 AudioContext 或 resume、常亮、getUserMedia） */
  async function tapResume() {
    if (phase !== 'live' || !gap) return;
    const g = gen;
    let made = false;
    if (!ac || ac.state === 'closed') { dropGraph(); closeCtx(); try { ac = newAC(); listenCtx(); made = true; } catch (e) { ac = null; } }
    if (ac) resumeNow(ac);
    requestWake();
    const gp = getUserMedia ? call(getUserMedia, CONSTRAINTS) : Promise.resolve(null);
    busy = true;
    let s;
    try { s = await gp; }
    catch (e) {
      busy = false;
      if (g === gen) { log('tap', { err: nameOf(e) }); if (micError(e) !== 'denied') step(false); emit(); }   // 还是不行：接着请用户点
      return;
    }
    busy = false;
    if (g !== gen || phase !== 'live') { stopTracks(s); return; }
    if (s) swapStream(s);
    try { if (made || !node) await buildGraph(session.pull); else rebuild(); } catch (e) { log('tap', { err: nameOf(e) }); }
    if (g !== gen) return;
    counts.taps++; needTap = false; resetLadder();
    log('tap'); emit(); check();
  }

  // ---------- 采集图 ----------
  function newAC() { try { return new AC({ sampleRate: 48000 }); } catch (e) { return new AC(); } }    // 48k → 16k 正好 3 取 1
  function resumeNow(a) { try { const r = a.resume && a.resume(); if (r && r.catch) r.catch(noop); } catch (e) { /* 不在手势里会被拒：tick 再试 */ } }
  /** worklet（0 个输出；pull = 接一个音量 0 的输出到 destination，有的浏览器不拉就不跑）；加不了 → ScriptProcessor + Decimator（总是要拉） */
  async function buildGraph(pull) {
    const a = ac, g = gen;
    let n, kind = 'worklet';
    try {
      if (!AWN || !a.audioWorklet || !a.audioWorklet.addModule) throw new Error('no AudioWorklet');
      if (moduleAc !== a) { await within(call(() => a.audioWorklet.addModule(String(workletUrl))), MODULE_WAIT_MS); moduleAc = a; }     // 一直不回也当加不了
      n = new AWN(a, 'babble-capture', { numberOfInputs: 1, numberOfOutputs: pull ? 1 : 0, channelCount: 1, channelCountMode: 'explicit',
        processorOptions: { outRate: SR, block: p.BLOCK } });
      n.port.onmessage = (e) => { const d = e && e.data; if (node === n && d && d.type === 'block') onBlock(d.pcm); };
    } catch (e) {
      if (g !== gen || a !== ac) return;
      if (!a.createScriptProcessor) throw e;
      log('capture', { kind: 'script', err: msgOf(e) });      // worklet 文件离线取不到、CSP 等
      n = a.createScriptProcessor(4096, 1, 1);
      const dec = new Decimator(a.sampleRate, { outRate: SR, block: p.BLOCK, onBlock: (pcm) => { if (node === n) onBlock(pcm); } });
      n.onaudioprocess = (ev) => dec.push(ev.inputBuffer.getChannelData(0));
      kind = 'script'; pull = true;
    }
    if (g !== gen || a !== ac) { try { n.disconnect(); } catch (e) { /* 没接 */ } return; }
    node = n; capture = kind;
    if (pull) { gainNode = a.createGain(); gainNode.gain.value = 0; n.connect(gainNode); gainNode.connect(a.destination); }
    source = a.createMediaStreamSource(stream); source.connect(n);
  }
  function dropGraph() {
    for (const x of [source, node, gainNode]) { if (x) { try { x.disconnect(); } catch (e) { /* 已断 */ } } }
    if (node) { if (node.port) node.port.onmessage = null; node.onaudioprocess = null; }
    source = node = gainNode = null;
  }
  function closeCtx() {
    offCtx();
    const a = ac;
    ac = null;
    if (a) { try { Promise.resolve(a.close()).catch(noop); } catch (e) { /* 已关 */ } }
  }
  /** 建好 3 秒一块都没来：0 输出的 worklet 没被拉（某些浏览器），改成接到 destination 再建一次 */
  async function pullFallback() {
    const g = gen;
    session.pull = true; graphAt = now();
    log('pull-fallback');
    dropGraph();
    try { await buildGraph(true); } catch (e) { if (g === gen) log('capture', { err: msgOf(e) }); }
  }

  // ---------- 常亮、锁、音频会话、监听 ----------
  async function requestWake() {
    if (!wakeLock || !wakeLock.request || wake || asking || torn || !visible()) return;
    const g = gen;
    asking = true;
    try {
      const s = await wakeLock.request('screen');
      if (g !== gen || torn) { Promise.resolve().then(() => s.release()).catch(noop); return; }
      wake = s;
      if (s && s.addEventListener) s.addEventListener('release', () => onWakeRelease(s));
      emit();
    } catch (e) { log('wake', { err: nameOf(e) }); }
    finally { if (g === gen) asking = false; }
  }
  /** 常亮被收回（低电量、发热）：在前台就马上再要一次，之后 tick 每分钟再要 */
  function onWakeRelease(s) {
    if (wake !== s) return;                                  // 自己放掉的不算
    wake = null;
    if (phase === 'live' && visible()) {
      counts.wakeLost++; log('wake', { lost: true });
      if (now() >= wakeRetryAt) { wakeRetryAt = now() + p.WAKE_RETRY_MS; requestWake(); }
    }
    emit();
  }
  function releaseWake() { const s = wake; wake = null; if (s) Promise.resolve().then(() => s.release()).catch(noop); }
  /** 一个来源只开一个（ifAvailable：拿不到马上是 null）；没有 Web Locks 就当拿到了 */
  function liveLock() {
    if (!locks || !locks.request) return Promise.resolve(true);
    return new Promise((res) => {
      const held = new Promise((r) => { unlockLive = r; });
      try { Promise.resolve(locks.request(LIVE_LOCK, { ifAvailable: true }, (l) => { res(!!l); return l ? held : null; })).catch(() => res(true)); }
      catch (e) { res(true); }
    });
  }
  function holdNight(id) {
    if (!locks || !locks.request) return Promise.resolve();
    return new Promise((res) => {
      const held = new Promise((r) => { unlockNight = r; });
      try { Promise.resolve(locks.request(NIGHT_LOCK + id, () => { res(); return held; })).catch(() => res()); } catch (e) { res(); }
    });
  }
  function unlockAll() { for (const f of [unlockLive, unlockNight]) if (f) f(); unlockLive = unlockNight = null; }
  // 音频会话：听的时候 play-and-record，结束后回到原来的（一般是 auto）
  function sessionTo(type) {
    if (!audioSession) return;
    try { prevSession = audioSession.type; hadPrev = true; audioSession.type = type; } catch (e) { /* 不支持就算了 */ }
  }
  function sessionBack() {
    if (!audioSession || !hadPrev) return;
    hadPrev = false;
    try { audioSession.type = prevSession && prevSession !== 'play-and-record' ? prevSession : 'auto'; } catch (e) { /* 同上 */ }
  }
  function on(t, type, fn) { if (!t || !t.addEventListener) return noop; t.addEventListener(type, fn); return () => t.removeEventListener(type, fn); }
  function listen() {
    offs.push(on(doc, 'visibilitychange', onVis), on(win, 'pagehide', onPageHide), on(win, 'pageshow', onPageShow));
    listenTrack(); listenCtx();
  }
  function listenTrack() {
    offTrack();
    const tr = track;
    if (!tr) return;
    const fns = ['mute', 'unmute', 'ended'].map(k => on(tr, k, () => { if (tr === track) { log(k); check(); } }));
    offTrack = () => { fns.forEach(f => f()); offTrack = noop; };
  }
  function listenCtx() {
    offCtx();
    const a = ac;
    if (!a) return;
    const off = on(a, 'statechange', () => { if (a === ac) { log('ctx', { state: a.state }); check(); } });
    offCtx = () => { off(); offCtx = noop; };
  }
  function onVis() {
    const vis = visible();
    log('vis', { state: vis ? 'visible' : 'hidden' });
    if (!vis) { hiddenAt = now(); beat(); }
    else { shownAt = now(); requestWake(); check(); beat(); }       // alive.vis 马上改回 true（被杀了找回时按它判断是不是锁屏后停的）
  }
  function onPageHide(e) {
    log('pagehide', { persisted: !!(e && e.persisted) });
    if (hiddenAt == null || (shownAt != null && shownAt >= hiddenAt)) hiddenAt = now();
    beat();
  }
  function onPageShow(e) { if (e && e.persisted) { log('pageshow'); check(); } }

  // ---------- 计时 ----------
  function tick() {
    if (phase !== 'live') return;
    const t = now(), d = t - lastTick;
    lastTick = t;
    if (d > p.LATE_MS) { counts.late++; log('late', { ms: d }); }          // 计时器被节流、页面被冻住过
    if (d > counts.maxTickGapMs) counts.maxTickGapMs = d;
    if (vadOn()) session.vadOnMs += d;
    if (capture === 'worklet' && !blocks && !session.pull && t - graphAt > p.START_WAIT_MS) pullFallback();
    drain(); check();
    if (phase !== 'live') return;
    if (visible() && !wake && !asking && t >= wakeRetryAt) { wakeRetryAt = t + p.WAKE_RETRY_MS; requestWake(); }
    if (vad && !vadDead && !vadIsDown && vad.state === 'off') vadDown('crash');    // worker 空闲时崩了：没有哪块报错，只能看 state
    if (vad && !vadStuck && vadState() === 'loading' && t - session.startedAt >= p.VAD_LOAD_MAX_MS) vadRetryLoad();
    if (autoEnd && t >= autoEnd) end('auto');
  }
  function clearTimers() { if (tickT != null) ci(tickT); if (beatT != null) ci(beatT); if (vadT != null) ct(vadT); tickT = beatT = vadT = null; }

  // ---------- 准备、开始、结束 ----------
  const freeOf = (est) => (est && Number.isFinite(est.quota) && Number.isFinite(est.usage) ? Math.max(0, est.quota - est.usage) : null);
  /** 今晚最多存多少秒：60 分钟，空间不够时按剩余的一半往下调（PCM16 16 kHz = 32000 字节/秒） */
  const budgetOf = (est) => { const free = freeOf(est); return free == null ? p.NIGHT_BUDGET_SEC : Math.min(p.NIGHT_BUDGET_SEC, Math.floor(free * p.BUDGET_FREE_SHARE / (SR * 2))); };
  function probeAac() {
    if (!AE || !AE.isConfigSupported) return Promise.resolve(null);
    return within(call(() => AE.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000 })), AAC_WAIT_MS)
      .then((r) => !!(r && r.supported), () => null);
  }
  /** 准备页：不用手势，先载入识别（顺便让 Wi-Fi 下把模型缓存好）、看看还有多少空间。可以重复调用 */
  function prepare() {
    if (prepP) return prepP;
    const busyStt = sttBusy();
    if (!busyStt && !vad) { try { vad = makeVad(); } catch (e) { vad = null; } }     // 正在转文字：先不载入
    const loadP = !busyStt && vad ? loadVad() : Promise.resolve(false);              // 先开始载入再报 preparing：第一次报的就是 loading
    if (phase === 'idle') { phase = 'preparing'; emit(); }
    const pr = (async () => {
      const ok = await loadP;
      const est = await within(call(estimate), ESTIMATE_WAIT_MS).catch(() => null);
      if (phase === 'preparing') { phase = 'ready'; emit(); }
      return { vad: ok ? 'ready' : 'off', freeBytes: freeOf(est), budgetSec: budgetOf(est), ...(busyStt ? { sttBusy: true } : {}) };
    })();
    if (!busyStt) prepP = pr;
    return pr;
  }
  async function start({ autoEndAt = null } = {}) {
    if (!['idle', 'preparing', 'ready', 'ended', 'error'].includes(phase)) return;
    if (sttBusy()) return fail('sttBusy');
    if (!store) return fail('noStore');
    if (!AC || !getUserMedia) return fail('unsupported');
    fresh();
    const g = ++gen;
    autoEnd = autoEndAt;
    // 下面这些在第一个 await 之前做完：还在点按的手势里（iOS 的 AudioContext、音频会话、常亮、麦克风权限都要）
    sessionTo('play-and-record');
    try { ac = newAC(); } catch (e) { teardown({ keepVad: true }); return fail('unsupported', e); }
    resumeNow(ac);
    requestWake();
    const persistP = call(persist), gumP = call(getUserMedia, CONSTRAINTS);
    persistP.catch(noop); gumP.catch(noop);
    if (!vad) { try { vad = makeVad(); } catch (e) { vad = null; } }
    if (vad && vad.state !== 'ready') loadVad();
    phase = 'starting'; emit();
    const estP = within(call(estimate), ESTIMATE_WAIT_MS).catch(() => null), aacP = probeAac();
    const lock = await liveLock();
    if (g !== gen || !lock) { gumP.then(stopTracks, noop); if (g === gen) { teardown({ keepVad: true }); fail('otherTab'); } return; }
    let s;
    try { s = await gumP; } catch (e) { if (g === gen) { teardown({ keepVad: true }); fail(micError(e), e); } return; }
    if (g !== gen) { stopTracks(s); return; }
    stream = s; track = tracksOf(s)[0] || null;
    await within(call(() => ac.resume()), RESUME_WAIT_MS).catch(noop);
    if (g !== gen) return;
    try { await buildGraph(false); } catch (e) { if (g === gen) { teardown({ keepVad: true }); fail('unsupported', e); } return; }
    const est = await estP, aac = await aacP;
    if (g !== gen) return;
    const t0 = now(), budgetSec = budgetOf(est);
    let nightOf = null;
    try { nightOf = nightKey(t0, settings() || {}, tz); } catch (e) { nightOf = nightKey(t0, {}, tz); }
    session = { id: newId('n_'), v: 1, nightOf, startedAt: t0, endedAt: null, status: 'live', endReason: null,
      tz, device, ua: String(nav('userAgent') || ''), build, standalone: standaloneOf(win),
      capture, rate: ac.sampleRate, pull: false, track: trackInfo(track),
      env: { aac16k: aac, persisted: null, usage: freeOf(est) == null ? null : est.usage, quota: freeOf(est) == null ? null : est.quota },
      vad: vadState(), vadLoadMs: vadOn() ? statsOf(vad).loadMs ?? null : null, vadMs: null, vadOnMs: 0,
      autoEndAt: autoEnd, budgetSec, alive: null, gaps: [], notes: [], counts, reviewedAt: null };
    const me = session;
    persistP.then((v) => { me.env.persisted = !!v; }, noop);
    if (vadState() === 'off') vadDead = true;                                  // 识别用不了：整夜按能量
    if (vadState() !== 'on') vadNote(t0);                                       // 还在载入也记上（载入好了收在那一刻）：这段时间是按能量找的
    for (const [t, k, d] of early.splice(0)) log(k, d, t);
    await within(holdNight(session.id), LOCK_WAIT_MS).catch(noop);              // 先拿锁再写：别的标签页这时启动也不会当成被杀的
    if (g !== gen) return;
    try { await within(call(() => store.putSession({ ...session })), p.SESSION_PUT_WAIT_MS); }
    catch (e) {
      if (g !== gen) return;
      if (msgOf(e) === 'no-indexeddb') { teardown({ keepVad: true }); return fail('noStore', e); }
      sessBad = true; console.warn('bedside: putSession', e);                   // 照样听：每次心跳都会再写
    }
    if (g !== gen) return;
    ring = createRing(p.RING_SEC, SR); gate = createGate(p); hyst = createHyst(p);
    clipper = createClipper({ p, budgetSec, minSpeech: () => (vadOn() ? p.MIN_SPEECH_SEC : p.ENERGY_MIN_SPEECH_SEC), energyOnly: () => !vadOn() });
    listen();
    tickT = si(tick, p.TICK_MS); beatT = si(beat, p.HEARTBEAT_MS);
    log('start', { rate: ac.sampleRate, capture, constraints: CONSTRAINTS, budgetSec, autoEndAt: autoEnd, vad: vadState() });
    log('track', session.track);
    graphAt = lastLiveAt = lastTick = lastBeatLog = now();
    phase = 'live'; emit();
    call(purgeNights, store, { now: now() }).catch(noop);
  }
  /** 结束（可以重复调用：正在结束的返回同一个 Promise，结束了的返回上次的结果） */
  function end(reason = 'user') {
    if (endP) return endP;
    if (phase !== 'live' && phase !== 'starting') return Promise.resolve(summary);
    const wasLive = phase === 'live';
    phase = 'ending'; gen++; clearTimers(); emit();          // gen++：正在开始的那半截（等权限、等写库）作废
    endP = (async () => {
      await null;                                            // 正在判的那块先判完
      const t = now();
      if (wasLive) { drain(true); apply(clipper.flush(decided, 'end')); }
      if (session) {
        if (gap) gap.to = Math.max(gap.from, t);
        syncSession();                                       // 先把「又听到几次」写进还开着的记号
        for (const n of session.notes) if (n.to == null) n.to = Math.max(n.from, t);
        session.alive = aliveNow();
      }
      teardown({ keepLocks: true });                         // 麦克风、AudioContext、识别、常亮、音频会话马上放掉；锁等 session 写好再放
      await within(w, p.END_WAIT_MS).catch(noop);            // 最后几片（最多等一会儿：IndexedDB 卡住也能结束）
      const left = [...unsettled.values()].filter(x => !x.q);     // 收段 / 丢段写失败了的：这一段的分片都写过了，直接再写一次
      if (left.length) await within(Promise.all(left.map(x => x.fn().catch(noop))), p.END_WAIT_MS).catch(noop);
      if (session) {
        Object.assign(session, { status: 'ended', endedAt: t, endReason: reason });
        counts.events++;
        await within(call(() => store.logEvent(session.id, now(), 'end', { reason })), p.END_WAIT_MS).catch(noop);
        await within(writeSession(true), p.END_WAIT_MS).catch((e) => console.warn('bedside: end', e));
      }
      const un = unlockNight;                                // NIGHT_LOCK 等写入链写完再放（每一步都有超时）：别的标签页这时启动不会去收还在写的段
      unlockNight = null; unlockAll(); w.then(un || noop);
      const gapsMs = session ? session.gaps.reduce((n, x) => n + Math.max(0, (x.to ?? t) - x.from), 0) : 0;
      // 没存进来的：一片声音都没写进去的（session 可能也没写进去：只能从这里告诉用户）
      const unsaved = counts.unsaved + [...unsettled.values()].filter(x => x.what === 'cand' && x.c && !x.c.seq).length;     // 声音写进去了的下次启动会找回
      summary = { sessionId: session ? session.id : null, nightOf: session ? session.nightOf : null, reason,
        listenedMs: session ? Math.max(0, t - session.startedAt - gapsMs) : 0, clips: counts.clips, unsaved };
      phase = 'ended'; emit();
      return summary;
    })();
    return endP;
  }
  /** 放掉这一次拿着的东西（可以重复调用）；开始失败时识别留着（再试一次不用重新载入） */
  function teardown({ keepLocks = false, keepVad = false } = {}) {
    torn = true; clearTimers();
    for (const f of offs) f();
    offs = []; offTrack();
    dropGraph(); stopTracks(stream); stream = track = null; closeCtx();
    if (vad && !keepVad) { try { vad.close(); } catch (e) { /* 已关 */ } vad = null; prepP = null; }
    releaseWake(); sessionBack();
    if (!keepLocks) unlockAll();
  }
  /** 准备好了却没开始就离开：关掉识别的 worker（正在听的话按离开结束） */
  function dispose() {
    if (phase === 'live' || phase === 'starting') { end('leave'); return; }
    if (vad) { try { vad.close(); } catch (e) { /* 已关 */ } vad = null; }
    prepP = null;
  }

  return { get phase() { return phase; }, prepare, start, tapResume, end, dispose, status };
}

/**
 * 启动时（storageIssue() 之后、purgeNights 之前）：上次还 live、这次启动前开始、锁也没人拿着的 → 被杀了（App 被划掉、内存被清、崩溃、重载）。
 * 收在最后一次心跳（alive.at，最多晚 10 秒）；开着的 gap 保留原因；stopWhy 记下为什么停的（报告里说）：开着的 gap 的原因，
 * 没有的话最后一次心跳时在后台 → hidden（锁屏、切走以后被系统清掉，gap 常常来不及写），都不是 → killed。
 * 开着的片段按最后一片的 ls 收在最后一句 + 2 秒（cut 'crash'），说话不够 MIN_SPEECH 的、一片都没有的丢掉。
 * 已经结束的那几晚（或找不到那晚的记录）里还 open 的片段（收段没写进去、结束时还没写完就被划掉）也这样收（cut 'end' / 'crash'）。
 * 只读 listSessions()、listCands()（都是 getAll），有要处理的才读分片、才写。某一次处理失败就留着，下次再试（同 recoverPending）。
 * @returns {Promise<{crashed: string[], clips: number}>}
 */
export async function recoverNights({ store, before = Date.now(), locks = nav('locks'), now = Date.now, p = P } = {}) {
  const out = { crashed: [], clips: 0 };
  if (!store) return out;
  const ss = (await store.listSessions()).filter(Boolean), byId = new Map(ss.map(s => [s.id, s]));
  const live = ss.filter(s => s.status === 'live' && s.startedAt < before);
  let held = null;
  const isHeld = async (id) => {                            // 别的标签页还在听（或结束了还在写）
    if (!held) { held = []; if (locks && locks.query) { try { held = ((await locks.query()).held || []).map(l => l.name); } catch (e) { /* 查不了就不管 */ } } }
    return held.includes(NIGHT_LOCK + id);
  };
  /** 开着的片段收在最后一片记的最后一句 + 2 秒；说话不够、一片都没有的丢掉 → 收下了没有 */
  const close = async (c, cut) => {
    const parts = await store.getParts(c.id), last = parts[parts.length - 1];
    if (!last || !(last.sp >= p.MIN_SPEECH_SEC)) { await store.dropCand(c.id); return false; }
    const total = parts.reduce((n, x) => n + Math.floor(x.b.byteLength / 2), 0);
    const n = Math.max(0, Math.min(total, last.ls + Math.round(p.POST_ROLL_SEC * p.SR)));
    await store.patchCand(c.id, { state: 'new', samples: n, endAt: Math.round(c.startAt + n * 1000 / p.SR), durationSec: r1(n / p.SR),
      speechSec: r1(last.sp), cut, parts: parts.length });
    return true;
  };
  for (const s of live) {
    if (await isHeld(s.id)) continue;
    try {
      const end = Math.max(s.startedAt, (s.alive && s.alive.at) || s.startedAt);
      const gaps = (s.gaps || []).map(g => ({ ...g })), open = gaps.find(g => g.to == null);
      if (open) open.to = Math.max(open.from, end);
      const stopWhy = open ? open.reason : s.alive && s.alive.vis === false ? 'hidden' : 'killed';
      let clips = 0;
      for (const c of await store.listCands(s.id)) if (c.state === 'open' && await close(c, 'crash')) clips++;
      const notes = (s.notes || []).map(x => (x.to == null ? { ...x, to: Math.max(x.from, end) } : x));
      await store.putSession({ ...s, status: 'crashed', endedAt: end, endReason: 'killed', stopWhy, gaps, notes });
      await store.logEvent(s.id, now(), 'recovered', { stoppedWhy: stopWhy, clips });
      out.crashed.push(s.id); out.clips += clips;
    } catch (e) { console.warn('recoverNights', s.id, e); }
  }
  const skip = new Set(ss.filter(s => s.status === 'live').map(s => s.id));       // 还在听的、上面刚处理过（或没处理成）的
  const left = (await store.listCands()).filter(c => c && c.state === 'open' && !skip.has(c.s) && c.startAt < before);
  const done = new Map();                                   // sessionId → { cands, clips }
  for (const c of left) {
    try {
      if (await isHeld(c.s)) continue;
      const s = byId.get(c.s), kept = await close(c, s && s.status === 'ended' ? 'end' : 'crash'), d = done.get(c.s) || { cands: [], clips: 0 };
      d.cands.push(c.id); if (kept) { d.clips++; out.clips++; }
      done.set(c.s, d);
    } catch (e) { console.warn('recoverNights', c.id, e); }
  }
  for (const [sid, d] of done) if (byId.has(sid)) await store.logEvent(sid, now(), 'recovered', d).catch(noop);
  return out;
}

/**
 * 按保留期限清理（nightReport.purgePlan）：删掉的候选 24 小时后、所有候选 7 天后清掉声音并标 gone；30 天前的整晚连记录一起删。
 * 不碰还在听的 session 和还开着的片段。启动时（找回之后）和每次开始床头模式时跑；先只读 getAll，有要清的才写
 * @returns {Promise<{parts: number, sessions: number}>}
 */
export async function purgeNights(store, { now = Date.now() } = {}) {
  const out = { parts: 0, sessions: 0 };
  if (!store) return out;
  const plan = purgePlan({ sessions: await store.listSessions(), cands: await store.listCands(), now });
  for (const id of plan.parts) {
    try { await store.deleteParts(id); await store.patchCand(id, { gone: true }); out.parts++; } catch (e) { console.warn('purgeNights', id, e); }
  }
  for (const id of plan.sessions) {
    try { await store.deleteSession(id); out.sessions++; } catch (e) { console.warn('purgeNights', id, e); }
  }
  return out;
}
