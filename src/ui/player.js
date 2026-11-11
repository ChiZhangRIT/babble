// 录音播放器：▶/❚❚、进度条、时间、0.75×/1×（保持音调）。录音不在本机时 getBlob 会去下载，显示「下载中…」。
// 同一时间只放一段。元素上挂 destroy()：页面清理时一定要调，释放 object URL。
// key（传 sha256）：页面因为数据变化重画（同步、点 ⭐）或从列表点进详情时，新播放器接过正在放的同一段，不打断。
// 样式在 styles.css 最后一节。
import { h, icon, toast } from './dom.js';
import { t } from '../i18n.js';
import { fmtDuration } from '../core/dates.js';

const RATES = [0.75, 1];
let rate = 1;                 // 这次打开 App 期间记住的速度（所有播放器共用）
let active = null;            // 当前（正在放 / 刚放过）的会话 { key, audio, url, owner, orphanTimer }
const players = new Set();    // 活着的播放器（换速度时一起更新、清理忘了 destroy 的）

/** 停掉正在放的录音（比如开始录音前） */
export function stopAll() { if (active) active.audio.pause(); }

/**
 * @param {{ getBlob: () => Promise<Blob|null>, durationSec?: number|null, compact?: boolean, key?: string }} o
 *   compact：列表卡片里只有一个圆按钮（外圈显示进度）
 * @returns {HTMLElement & { destroy(): void }}
 */
export function audioPlayer({ getBlob, durationSec = null, compact = false, key = null }) {
  let s = null, loading = false, loadTimer = null, destroyed = false, seeking = false, pendingFrac = 0, off = null;
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
  const seg = compact ? null : h('div.seg.player-rate', { role: 'group', 'aria-label': t('player.rate') },
    RATES.map(r => h('button', { type: 'button', dataset: { rate: String(r) }, onclick: (e) => { e.preventDefault(); e.stopPropagation(); setRate(r); } }, (r === 1 ? '1' : String(r)) + '×')));
  const el = h('div.player' + (compact ? '.compact' : ''), { onclick: (e) => e.stopPropagation() },   // 在卡片里：点播放器不打开条目
    btn, compact ? null : h('div.player-mid', null, bar, times, msg), seg);

  const api = {
    el,
    sync: () => { paintRate(); paintBtn(); },
    release: () => { if (s && s !== active && s.owner === api) { if (off) { off.abort(); off = null; } kill(s); s = null; paintBtn(); paintTime(); } },
  };
  players.add(api);

  // 页面重画：接过还在放的同一段
  if (key && active && active.key === key && (!active.owner || !active.owner.el.isConnected)) {
    clearTimeout(active.orphanTimer);
    s = active; s.owner = api;
    attach();
  }
  paintBtn(); paintRate(); paintTime();

  // ---------- 播放 / 暂停 ----------
  async function toggle(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }     // 卡片里点 ▶ 不要顺便打开条目
    if (destroyed) return;
    if (s && !s.audio.paused) { s.audio.pause(); return; }
    if (s) { play(); return; }
    if (loading) return;
    // 第一次：先在点按的手势里建好 <audio> 并 load()，iOS 才允许下载完以后再 play()
    const audio = new Audio();
    audio.preload = 'auto';
    keepPitch(audio);
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
    const url = URL.createObjectURL(blob);
    audio.src = url;
    s = { key, audio, url, owner: api, orphanTimer: null };
    attach();
    play();
  }
  function play() {
    if (active && active !== s) pauseOrKill(active);
    active = s;
    players.add(api);
    sweep();
    s.audio.defaultPlaybackRate = rate;
    s.audio.playbackRate = rate;
    keepPitch(s.audio);
    const p = s.audio.play();
    if (p && p.catch) p.catch((x) => {
      if (!x || x.name === 'AbortError') return;
      if (x.name === 'NotAllowedError') { paintBtn(); return; }   // 手势过期（下载太久）：按钮还是 ▶，再点一下就能放
      problem('player.error');
    });
  }
  function seekTo(frac) {
    if (!s) { pendingFrac = frac; return; }
    const d = dur();
    if (d) { try { s.audio.currentTime = Math.min(d, Math.max(0, frac * d)); } catch (x) { /* 还没加载好 */ } }
    else pendingFrac = frac;
  }
  function setRate(r) {
    rate = r;
    if (active) { active.audio.defaultPlaybackRate = r; active.audio.playbackRate = r; keepPitch(active.audio); }
    for (const p of players) p.sync();
  }

  // ---------- 绑定 <audio> 事件（换主人时解绑旧的） ----------
  function attach() {
    if (off) off.abort();
    off = new AbortController();
    const o = { signal: off.signal }, a = s.audio;
    a.addEventListener('play', () => { if (active && active !== s) pauseOrKill(active); active = s; paintBtn(); }, o);
    a.addEventListener('pause', paintBtn, o);
    a.addEventListener('ended', () => { paintBtn(); if (!seeking) { paintBar(0); showTime(0); } }, o);
    a.addEventListener('timeupdate', paintTime, o);
    a.addEventListener('durationchange', paintTime, o);
    a.addEventListener('loadedmetadata', () => { if (pendingFrac) { const f = pendingFrac; pendingFrac = 0; seekTo(f); } paintTime(); }, o);
    a.addEventListener('error', () => { if (s && s.audio === a && a.error) problem('player.error'); }, o);
  }

  // ---------- 界面 ----------
  function dur() {
    const d = s ? s.audio.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : known;          // Safari 的分片录音有时读不出时长：用记下的
  }
  function paintBtn() {
    const playing = !!(s && !s.audio.paused);
    const label = el.classList.contains('loading') ? t('player.loading') : t(playing ? 'player.pause' : 'player.play');
    btn.replaceChildren(icon(playing ? 'pause' : 'play'));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    el.classList.toggle('playing', playing);
  }
  function paintTime() {
    if (seeking) return;
    const d = dur(), at = s ? s.audio.currentTime || 0 : pendingFrac * (d || 0);
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
  function paintRate() {
    if (!seg) return;
    for (const b of seg.children) { const on = Number(b.dataset.rate) === rate; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
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
    paintBtn(); paintTime();
    if (msg) showMsg(t(k)); else toast(t(k));
  }

  el.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(loadTimer);
    players.delete(api);
    if (off) { off.abort(); off = null; }
    if (!s) return;
    const mine = s;
    s = null;
    if (mine.owner !== api) return;                              // 已经被新播放器接走
    mine.owner = null;
    if (mine === active && key && !mine.audio.paused) {
      mine.orphanTimer = setTimeout(() => { if (!mine.owner) kill(mine); }, 0);   // 给重画后的新播放器一个接手的机会
    } else kill(mine);
  };
  return el;
}

function fracOf(bar) { return Number(bar.value) / 1000; }
function keepPitch(a) { a.preservesPitch = true; a.webkitPreservesPitch = true; a.mozPreservesPitch = true; }
/** 别人开始放：没人管的直接释放，有人管的暂停 */
function pauseOrKill(sess) { if (!sess.owner) kill(sess); else sess.audio.pause(); }
function kill(sess) {
  clearTimeout(sess.orphanTimer);
  try { sess.audio.pause(); sess.audio.removeAttribute('src'); sess.audio.load(); } catch (e) { /* 已释放 */ }
  if (sess.url) { URL.revokeObjectURL(sess.url); sess.url = null; }
  if (active === sess) active = null;
}
/** 页面忘了 destroy、元素已经不在页面上的播放器：释放它们的录音（正在放的那个除外），不再登记 */
function sweep() {
  for (const p of [...players]) if (!p.el.isConnected && !(active && active.owner === p)) { p.release(); players.delete(p); }
}
