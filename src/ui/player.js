// 录音播放器：▶/❚❚、进度条、时间、「原声 | 均衡」（在右边，原来速度按钮的位置）。录音不在本机时 getBlob 会去下载，显示「下载中…」。
// 同一时间只放一段。元素上挂 destroy()：页面清理时一定要调，释放 object URL。
// key（传 sha256）：页面因为数据变化重画（同步、点 ⭐）或从列表点进详情时，新播放器接过正在放的同一段，不打断。
// 均衡（core/loudness.js）：把录音解码成 24 kHz 单声道、每句调到差不多的音量、编成 WAV，用同一个 <audio> 放；
//   切换时保持位置和播放状态；算好的结果按 sha256 留在内存里（最近几段）；选择记在 babble.local，所有播放器共用。存着的原录音不动。
// 样式在 styles.css 最后一节。
import { h, icon, toast } from './dom.js';
import { t } from '../i18n.js';
import { fmtDuration } from '../core/dates.js';
import { getLocal, setLocal } from '../core/state.js';
import { levelAudio, encodeWav, downmix } from '../core/loudness.js';

const MODES = ['orig', 'level'];
let leveled = null;           // 原声 / 均衡（babble.local 的 leveled；null = 还没读）
let active = null;            // 当前（正在放 / 刚放过）的会话 { key, audio, blob, urls, mode, owner, orphanTimer, leveling, levelErr, resume }
const players = new Set();    // 活着的播放器（换原声 / 均衡时一起更新、清理忘了 destroy 的）

const levelOn = () => (leveled === null ? (leveled = !!(getLocal() || {}).leveled) : leveled);

/** 停掉正在放的录音（比如开始录音前）；均衡还在算的，算好也不放 */
export function stopAll() { if (active) hush(active); }

/**
 * @param {{ getBlob: () => Promise<Blob|null>, durationSec?: number|null, compact?: boolean, key?: string, level?: boolean }} o
 *   compact：列表卡片里只有一个圆按钮（外圈显示进度），按全局的原声 / 均衡放
 *   level：false = 只放原声、不显示「原声 | 均衡」（录音诊断要听原样）
 * @returns {HTMLElement & { destroy(): void }}
 */
export function audioPlayer({ getBlob, durationSec = null, compact = false, key = null, level = true }) {
  let s = null, loading = false, loadTimer = null, destroyed = false, seeking = false, pendingFrac = 0, off = null, busyMsg = false, msgTimer = null;
  const known = Number.isFinite(Number(durationSec)) && durationSec > 0 ? Number(durationSec) : null;

  const btn = h('button.player-btn', { type: 'button', onclick: toggle });
  const bar = compact ? null : h('input.player-bar', {
    type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': t('player.seek'),
    oninput: () => { seeking = true; showTime(fracOf(bar) * dur()); paintBar(fracOf(bar)); },
    onchange: () => { seeking = false; seekTo(fracOf(bar)); },
  });
  const cur = h('span', null, '0:00'), total = h('span', null, fmtDuration(known));
  const times = compact ? null : h('div.player-times', null, cur, total);
  const msg = compact ? null : h('div.player-msg', { hidden: true, role: 'status' });
  const modeSeg = compact || !level ? null : h('div.seg.player-mode', { role: 'group', 'aria-label': t('player.mode') },
    MODES.map(m => h('button', { type: 'button', dataset: { mode: m }, title: m === 'level' ? t('player.levelHint') : null,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); pickMode(m === 'level'); } }, t('player.' + m))));
  const el = h('div.player' + (compact ? '.compact' : ''), { onclick: (e) => e.stopPropagation() },   // 在卡片里：点播放器不打开条目
    btn, compact ? null : h('div.player-mid', null, bar, times, msg), modeSeg);

  const api = {
    el, level,
    sync: () => { paintMode(); paintBtn(); },
    release: () => { if (s && s !== active && s.owner === api) { if (off) { off.abort(); off = null; } kill(s); s = null; paintAll(); } },
    applyMode: (autoplay) => applyMode(autoplay),
    loaded: () => !!s,
  };
  players.add(api);

  // 页面重画：接过还在放的同一段
  if (key && active && active.key === key && (!active.owner || !active.owner.el.isConnected)) {
    clearTimeout(active.orphanTimer);
    s = active; s.owner = api;
    attach();
  }
  paintAll();

  // ---------- 播放 / 暂停 ----------
  async function toggle(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }     // 卡片里点 ▶ 不要顺便打开条目
    if (destroyed) return;
    if (s) {
      if (isPlaying()) { hush(s); paintState(); return; }
      if (s.leveling) { s.leveling.autoplay = true; claim(); paintState(); return; }   // 均衡还没算好：算好就放
      play(); return;
    }
    if (loading) return;
    // 第一次：先在点按的手势里建好 <audio> 并 load()，iOS 才允许下载（和均衡处理）完以后再 play()
    const audio = new Audio();
    audio.preload = 'auto';
    try { audio.load(); } catch (x) { /* 没关系 */ }
    showMsg(null);
    loading = true;
    loadTimer = setTimeout(() => { if (loading) { el.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); if (msg) showMsg(t('player.loading'), true); paintBtn(); } }, 150);
    let blob = null, failed = false;
    try { blob = await getBlob(); } catch (x) { failed = true; }
    loading = false;
    clearTimeout(loadTimer);
    el.classList.remove('loading');
    btn.removeAttribute('aria-busy');
    if (destroyed) return;
    if (!blob) { showMsg(null); paintBtn(); return problem(failed ? 'player.error' : 'player.missing'); }
    showMsg(null);
    s = { key, audio, blob, urls: { orig: URL.createObjectURL(blob), level: null }, mode: null, owner: api, orphanTimer: null, leveling: null, levelErr: false, resume: null };
    attach();
    play();
  }
  function play() {
    if (!s) return;
    claim();
    if (s.mode !== want()) { applyMode(true); return; }    // 先换成选的版本（第一次放 / 换过原声均衡）
    const p = s.audio.play();
    if (p && p.catch) p.catch((x) => {
      if (!x || x.name === 'AbortError') return;
      if (x.name === 'NotAllowedError') { paintBtn(); return; }   // 手势过期（下载太久）：按钮还是 ▶，再点一下就能放
      problem('player.error');
    });
  }
  /** 这一段成为当前的（别的暂停）；均衡还在算时也算，页面重画时新播放器能接手 */
  function claim() {
    if (active && active !== s) pauseOrKill(active);
    active = s;
    players.add(api);
    sweep();
  }
  /** 在放，或者马上要放（正在换版本 / 均衡算好就放） */
  function isPlaying() { return !!(s && (!s.audio.paused || (s.resume && s.resume.play) || (s.leveling && s.leveling.autoplay))); }
  function seekTo(frac) {
    if (!s) { pendingFrac = frac; return; }
    const d = dur();
    if (s.resume) { s.resume.at = Math.max(0, frac * (d || 0)); paintTime(); return; }   // 正在换版本：换好后从这里接着
    if (d) { try { s.audio.currentTime = Math.min(d, Math.max(0, frac * d)); } catch (x) { /* 还没加载好 */ } }
    else pendingFrac = frac;
  }

  // ---------- 原声 / 均衡 ----------
  /** 这个播放器现在该放哪个版本 */
  function want() { return level && levelOn() && !(s && s.levelErr) ? 'level' : 'orig'; }
  function pickMode(on) {
    if (on && s) s.levelErr = false;                       // 明确点了「均衡」：之前失败的再试一次
    if (on !== levelOn()) { leveled = on; setLocal({ leveled: on }); }
    for (const p of players) p.sync();
    // 正在放（或刚放过）的那段马上换；点的这个播放器已经加载过的话也换好（下次 ▶ 不用等）
    if (active && active.owner) active.owner.applyMode(false);
    if (s && s !== active) applyMode(false);
  }
  /** 让 <audio> 放该放的版本：均衡版本第一次要先算（「处理中…」）；换的时候记住位置和是否在放，加载好后跳回原处 */
  async function applyMode(autoplay = false) {
    if (!s || destroyed) return;
    const mine = s, m = want();
    if (m === 'level' && !mine.urls.level) {
      if (mine.leveling) { if (autoplay) mine.leveling.autoplay = true; paintAll(); return; }
      const job = mine.leveling = { autoplay };
      paintAll();
      let lb = null;
      // 太长的（导入的整夜录音之类）不做：解码要上 GB 内存，iPhone 上网页会被系统关掉。只放原声
      if (!(dur() > LEVEL_MAX_SEC)) { try { lb = await leveledBlob(mine.blob, mine.key); } catch (x) { console.warn('均衡处理失败', x); } }
      mine.leveling = null;
      if (!mine.urls) return;                                   // 这期间被释放了
      if (lb) mine.urls.level = URL.createObjectURL(lb);
      else { mine.levelErr = true; mine.owner ? mine.owner.notice('player.levelFail') : toast(t('player.levelFail')); }
      if (mine.owner) mine.owner.applyMode(job.autoplay);       // 可能已经换了主人（页面重画）：让现在的主人接着做
      return;
    }
    if (mine.leveling && mine.leveling.autoplay) { autoplay = true; mine.leveling.autoplay = false; }   // 等均衡时又切回原声：直接放原声
    if (mine.mode === m) { paintAll(); if (autoplay) play(); return; }
    const a = mine.audio, first = mine.mode == null;
    const playing = autoplay || (!first && (!a.paused || !!(mine.resume && mine.resume.play)));
    const at = first ? 0 : (mine.resume ? mine.resume.at : a.currentTime || 0);
    mine.mode = m;
    mine.resume = first ? null : { at, play: playing };          // loadedmetadata 时跳回去（见 attach）
    a.src = mine.urls[m];
    paintAll();
    if (first && playing) play();
  }
  api.notice = (k) => {
    if (!msg) { toast(t(k)); return; }
    busyMsg = false;                                           // 别让随后的「处理中…」收尾把这句话清掉
    showMsg(t(k));
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { if (msg.textContent === t(k)) showMsg(null); }, 4000);
  };

  // ---------- 绑定 <audio> 事件（换主人时解绑旧的） ----------
  function attach() {
    if (off) off.abort();
    off = new AbortController();
    const o = { signal: off.signal }, a = s.audio;
    a.addEventListener('play', () => { if (active && active !== s) pauseOrKill(active); active = s; paintState(); }, o);
    a.addEventListener('pause', paintState, o);
    a.addEventListener('ended', () => { paintBtn(); if (!seeking) { paintBar(0); showTime(0); } }, o);
    a.addEventListener('timeupdate', paintTime, o);
    a.addEventListener('durationchange', paintTime, o);
    a.addEventListener('loadedmetadata', () => {
      if (s && s.resume) {                                     // 刚换了版本：跳回原来的位置，原来在放就接着放
        const r = s.resume;
        s.resume = null;
        const d = dur();
        try { a.currentTime = d ? Math.min(r.at, Math.max(0, d - 0.05)) : r.at; } catch (x) { /* 跳不了就从头 */ }
        if (r.play) play();
      } else if (pendingFrac) { const f = pendingFrac; pendingFrac = 0; seekTo(f); }
      paintTime(); paintState();
    }, o);
    a.addEventListener('error', () => { if (s && s.audio === a && a.error) problem('player.error'); }, o);
  }

  // ---------- 界面 ----------
  function dur() {
    const d = s ? s.audio.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : known;          // Safari 的分片录音有时读不出时长：用记下的
  }
  function paintAll() { paintState(); paintMode(); paintTime(); }
  function paintState() { paintBusy(); paintBtn(); }
  function paintBtn() {
    const playing = isPlaying();
    const label = el.classList.contains('loading') ? t(s && s.leveling ? 'player.processing' : 'player.loading') : t(playing ? 'player.pause' : 'player.play');
    btn.replaceChildren(icon(playing ? 'pause' : 'play'));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    el.classList.toggle('playing', playing);
  }
  /** 「处理中…」：没在放的时候按钮转圈；完整播放器在时间那一行写字 */
  function paintBusy() {
    const busy = !!(s && s.leveling);
    if (!loading) {
      el.classList.toggle('loading', busy && s.audio.paused);
      if (busy && s.audio.paused) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
    }
    if (msg && (busy || busyMsg)) { showMsg(busy ? t('player.processing') : null, busy); busyMsg = busy; }
    if (modeSeg) { const b = modeSeg.querySelector('[data-mode="level"]'); if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy'); }
  }
  function paintTime() {
    if (seeking) return;
    const d = dur(), at = s ? (s.resume ? s.resume.at : s.audio.currentTime || 0) : pendingFrac * (d || 0);
    const frac = d ? Math.min(1, at / d) : 0;
    showTime(at);
    if (total) total.textContent = fmtDuration(d);
    paintBar(frac);
  }
  function showTime(at) {
    if (cur) cur.textContent = fmtDuration(at) || '0:00';
    if (bar) bar.setAttribute('aria-valuetext', `${fmtDuration(at) || '0:00'} / ${fmtDuration(dur()) || '—'}`);
  }
  function paintBar(frac) {
    const pct = (Math.max(0, Math.min(1, frac || 0)) * 100).toFixed(2) + '%';
    el.style.setProperty('--p', pct);
    if (bar && !seeking) bar.value = String(Math.round((frac || 0) * 1000));
  }
  function paintMode() {
    if (!modeSeg) return;
    const m = want();
    for (const b of modeSeg.children) { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }
  function showMsg(text, busy = false) {
    if (!msg) return;
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.classList.toggle('busy', !!busy);
    if (times) times.hidden = !!text;
  }
  function problem(k) {
    if (off) { off.abort(); off = null; }
    if (s) { if (s.owner === api) kill(s); s = null; }       // 下次点重新取
    busyMsg = false;
    paintAll();
    if (msg) showMsg(t(k)); else toast(t(k));
  }

  el.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(loadTimer);
    clearTimeout(msgTimer);
    players.delete(api);
    if (off) { off.abort(); off = null; }
    if (!s) return;
    const mine = s;
    s = null;
    if (mine.owner !== api) return;                              // 已经被新播放器接走
    mine.owner = null;
    if (mine === active && key && (!mine.audio.paused || mine.resume || mine.leveling)) {
      mine.orphanTimer = setTimeout(() => { if (!mine.owner) kill(mine); }, 0);   // 给重画后的新播放器一个接手的机会
    } else kill(mine);
  };
  return el;
}

function fracOf(bar) { return Number(bar.value) / 1000; }
/** 别人开始放：没人管的直接释放，有人管的暂停 */
function pauseOrKill(sess) { if (!sess.owner) kill(sess); else hush(sess); }
/** 暂停，并取消「换好版本 / 均衡算好就放」 */
function hush(sess) {
  if (sess.resume) sess.resume.play = false;
  if (sess.leveling) sess.leveling.autoplay = false;
  sess.audio.pause();
}
function kill(sess) {
  clearTimeout(sess.orphanTimer);
  try { sess.audio.pause(); sess.audio.removeAttribute('src'); sess.audio.load(); } catch (e) { /* 已释放 */ }
  if (sess.urls) { for (const u of Object.values(sess.urls)) if (u) URL.revokeObjectURL(u); sess.urls = null; }
  sess.resume = null;
  if (active === sess) active = null;
}
/** 页面忘了 destroy、元素已经不在页面上的播放器：释放它们的录音（正在放的那个除外），不再登记 */
function sweep() {
  for (const p of [...players]) if (!p.el.isConnected && !(active && active.owner === p)) { p.release(); players.delete(p); }
}

// ---------- 均衡版本：解码 → loudness.js → WAV，按 sha256 缓存最近几段 ----------
const LEVEL_SR = 24000;                 // 24 kHz 单声道：说话足够清楚，10 分钟的录音解码后也只有约 58 MB
const LEVEL_MAX_SEC = 20 * 60;          // 超过 20 分钟的不做均衡（内存）
const CACHE_N = 4, CACHE_BYTES = 80e6;  // 最多留 4 段、约 80 MB（至少留最近一段）
const cache = new Map();                // sha256 → { p: Promise<Blob>, bytes }（最近用的在最后）
const loose = new WeakMap();            // 没有 sha256 的（导入预览）：跟着 Blob 对象走

function leveledBlob(blob, key) {
  if (!key) {
    let p = loose.get(blob);
    if (!p) { p = makeLeveled(blob); loose.set(blob, p); p.catch(() => loose.delete(blob)); }
    return p;
  }
  let c = cache.get(key);
  if (c) { cache.delete(key); cache.set(key, c); return c.p; }
  c = { p: makeLeveled(blob), bytes: 0 };
  cache.set(key, c);
  c.p.then(b => { c.bytes = b.size; prune(); }, () => { if (cache.get(key) === c) cache.delete(key); });   // 失败的不留：下次还能再试
  prune();
  return c.p;
}
function prune() {
  let sum = 0;
  for (const c of cache.values()) sum += c.bytes;
  for (const [k, c] of cache) {
    if (cache.size <= 1 || (cache.size <= CACHE_N && sum <= CACHE_BYTES)) break;
    cache.delete(k);
    sum -= c.bytes;
  }
}
async function makeLeveled(blob) {
  await new Promise(r => setTimeout(r, 0));                  // 先让「处理中…」画出来
  let audio = await decodeAt(await blob.arrayBuffer(), LEVEL_SR);
  const sr = audio.sampleRate, ch = [];
  for (let c = 0; c < audio.numberOfChannels; c++) ch.push(audio.getChannelData(c));
  const x = ch.length === 1 ? ch[0] : downmix(ch);           // 单声道不用再复制一份（levelAudio 不改输入）
  ch.length = 0; audio = null;                               // 立体声：解码出来的两路用完就放掉，省得和均衡结果同时占着内存
  return new Blob([encodeWav(levelAudio(x, sr), sr)], { type: 'audio/wav' });
}
/** OfflineAudioContext 解码并重采样到 sr（Safari 的 MediaRecorder 分片 mp4、语音备忘录 m4a 都行） */
function decodeAt(buf, sr) {
  const C = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!C) return Promise.reject(new Error('OfflineAudioContext unsupported'));
  let ctx;
  try { ctx = new C(1, 1, sr); } catch (e) { ctx = new C(1, 1, 44100); }   // 不支持 24 kHz 的老浏览器
  return new Promise((resolve, reject) => {
    try { const p = ctx.decodeAudioData(buf, resolve, reject); if (p && p.then) p.then(resolve, reject); } catch (e) { reject(e); }
  });
}
