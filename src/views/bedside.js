// 床头模式（#/rec?bed=1，record.js 第一行交过来；外壳和夜间录音页一样：近黑、没有底栏侧栏、「谁在用」等离开再问）。
// 手机插上电放在床头整夜开着，听到像说话的声音就存一小段（往前带 8 秒），早上在「昨夜」里挑。几屏：
//   准备：说明和清单、「到 早上7:00 自动结束」（babble.local.bedAutoEnd，默认开；没有夜间时段就不显示）、说话识别好了没有、
//         空间不够时今晚最多存多久。打开就先载入说话识别（engine.prepare，趁还连着 Wi-Fi）；
//         正在转文字 / 另一个窗口开着床头模式 / 这里存不了数据 → 不载、「开始」点不了（写原因）
//   整夜：纯黑，一小块很暗的字（在听 · 几点开始 · 存了几段 / 暂停了和原因 / 最多一条警告），每分钟换个位置防烙印；
//         不动、不闪、没有秒。底下「按住结束」要按 2 秒（点一下只提示）。要点一下才能接着听时整屏都是「点一下，接着听」
//   收尾 → 结束：听了多久、存了几段（有没存进来的也说）、「去看这一晚」、提醒把自动锁定改回来。开不了 → 原因和「再试一次」
// 引擎见 core/bedside.js（deps.createBedside 可以换成假的）；开始和「点一下」都必须在点按里同步调用（iOS 的麦克风、常亮、声音会话要手势）。
// 开着的时候暂停同步（ctx.sync.pause），离开这页先问（ctx.guard，床头模式的说法），离开 = 结束（end('leave')）。
// 自己管更新（onChange 什么也不做）：同步、别的页面改数据都不重画，整夜的黑屏不能闪。
import { h, icon, longPress } from '../ui/dom.js';
import { stopAll } from '../ui/player.js';
import { createBedside, LIVE_LOCK, GAP_REASONS } from '../core/bedside.js';
import { P } from '../core/nightDetect.js';
import { nightKey, autoEndAt, fmtSpan } from '../core/nightReport.js';
import { localParts, fmtTime } from '../core/dates.js';
import { fmtBytes } from '../core/util.js';
import { job, isRunning, onJob } from '../core/transcribe.js';
import { forgetNight } from './night.js';
import { t } from '../i18n.js';

// 引擎的阶段 → 画哪一屏
const SCREEN = { idle: 'ready', preparing: 'ready', ready: 'ready', starting: 'starting', live: 'live', ending: 'ending', ended: 'ended', error: 'error' };
const OWN_ERR = ['otherTab', 'sttBusy', 'noStore'];             // 这几个用 bed.*；其余和录音页一样（rec.err.*）
const REC_ERR = ['denied', 'nomic', 'failed', 'unsupported'];
// 状态字的 9 个位置（±24 px）：先在中间，之后每 MOVE_MS 跳到下一个（跳着走，不是一点点挪）
const SPOTS = [[0, 0], [-24, -24], [24, 24], [24, -24], [-24, 24], [0, -24], [0, 24], [-24, 0], [24, 0]];
const BROKEN_MS = 6 * 3600000;                                  // 录音页入口：今晚断了不到 6 小时才说「断了，点这里接着听」

const clock = (ms, lang, tz) => { const p = ms == null ? null : localParts(ms, tz); return p ? fmtTime(p.time, lang) : ''; };
const why = (r) => t('night.why.' + (GAP_REASONS.includes(r) ? r : 'error'));
const call = (fn) => new Promise(res => res(fn()));             // 同步调用（还在点按里），同步抛的错也变成 reject
/** 文字变了才写（整夜的那块字只在状态变时重画）；put 顺便把空的藏起来 */
const text = (el, s) => { if (el.textContent !== s) el.textContent = s; };
const put = (el, s) => { text(el, s); el.hidden = !s; };
// 上一个床头页离开时还在收尾（存最后一段、放开麦克风和锁）：新打开的等它收完再查锁、再载入、再让点「开始」
let leaving = Promise.resolve();

export function render(main, params, ctx, deps = {}) {
  const { createBedside: make = createBedside, holdMs = P.HOLD_MS, moveMs = P.MOVE_MS, sttBusy = () => isRunning(job()), onJob: onStt = onJob,
    locks = (globalThis.navigator && navigator.locks) || null, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval } = deps;
  const lang = ctx.lang();
  const settings = () => (ctx.state && ctx.state.settings) || {};
  const autoOn = () => ctx.local.bedAutoEnd !== false;
  const noStore = !ctx.night;
  const firstTip = !ctx.local.bedVadOk;          // 画的时候就定下来：说话识别中途好了，清单也不跳
  forgetNight();                                  // 这一晚要写 babble-night：「昨夜」卡片别照之前读到的先画
  let st = null, screen = null, cur = null, focusEl = null, els = {}, gone = false;
  let resume = null, tab = null, prepared = false, vad = null, room = null, summary = null;
  let moveTimer = null, spot = 0, offPress = null, pressFired = false, wasTap = false;
  const sr = h('p.sr-only', { role: 'status', 'aria-live': 'polite' });

  // ---------- 引擎状态 → 页面 ----------
  function onStatus(s) {
    const prev = st && st.phase;
    st = s;
    if (s.vad === 'on') vadOk();
    if (s.phase === 'ended' || s.phase === 'error') release();
    if (s.phase === 'ended' && prev !== 'ended') settle();
    if (gone) return;
    if (s.phase === 'starting' || s.phase === 'live') hold();
    // 换屏才重画；开不了的原因可能直接换一个（「再试一次」时正在转文字：不经过「正在准备」）
    if (SCREEN[s.phase] !== screen || screen === 'error') draw(); else paint();
  }
  const vadOk = () => { if (!ctx.local.bedVadOk) ctx.setLocal({ bedVadOk: true }); };    // 以后不再提醒「第一次要下载」
  const hold = () => { if (!resume && ctx.sync && ctx.sync.pause) resume = ctx.sync.pause('bedside'); };
  const release = () => { const r = resume; resume = null; if (r) r(); };
  // 结束了要知道听了多久：自己按的从 end('user') 拿；到点自动结束的再问一次 end()（已经结束时给上次的结果）
  function settle() {
    call(() => engine.end()).then(sum => { if (sum && !summary) { summary = sum; if (!gone && screen === 'ended') draw(); } }, () => {});
  }

  // ---------- 准备 ----------
  // 'wait' = 还没查完另一个窗口（一般只有几毫秒）：点不了，不写原因
  const blocked = () => (noStore ? 'noStore' : tab == null ? 'wait' : tab ? 'otherTab' : sttBusy() ? 'sttBusy' : null);
  // 先载入说话识别（第一次要下载）；开不了的时候不载：另一个窗口也开着就是两份 ORT 一起占内存
  function warm() {
    if (prepared || gone || blocked()) return;
    prepared = true;
    call(() => engine.prepare()).then(r => {
      vad = r && r.vad === 'ready' ? 'on' : 'off';
      if (vad === 'on') vadOk();
      room = r && r.budgetSec < P.NIGHT_BUDGET_SEC ? r : null;
    }, () => { vad = 'off'; }).then(refresh);
  }
  // 另一个窗口（iPad 分屏、Mac 另一个标签页）正开着床头模式：它拿着 LIVE_LOCK
  const checkTab = () => Promise.resolve(locks && locks.query ? locks.query() : null)
    .then(s => { tab = !!s && (s.held || []).some(l => l.name === LIVE_LOCK); }, () => { tab = false; });
  const refresh = () => { if (!gone && screen === 'ready') { warm(); paintReady(); } };
  const recheck = () => { if (!gone && screen === 'ready') checkTab().then(refresh); };
  // 转文字跑完、切回这个窗口（另一个窗口可能已经结束了）：「开始」能不能点要跟着变
  const offJob = onStt(refresh);
  const onVis = () => { if (document.visibilityState !== 'hidden') recheck(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', recheck);

  // ---------- 操作 ----------
  // 开始：都在这次点按里同步做完（引擎在第一个 await 之前要声音会话、AudioContext、常亮、麦克风）
  function start() {
    if (noStore) return;
    stopAll();                                      // 正在放的录音先停
    summary = null;
    hold();
    call(() => engine.start({ autoEndAt: autoOn() ? autoEndAt(Date.now(), settings()) : null })).catch(failed);
    if (SCREEN[engine.phase] === 'ready') release();     // 引擎没接（不在能开始的阶段）：同步照常
  }
  // 引擎自己没接住的错（不该有）：还没开始的当成「没能开始」
  function failed(e) {
    console.error(e);
    if (['live', 'ending', 'ended'].includes(engine.phase)) return;
    release();
    st = { ...st, phase: 'error', error: { code: 'failed', message: (e && e.message) || String(e) } };
    if (!gone) draw();
  }
  const end = () => call(() => engine.end('user')).then(sum => { if (sum) summary = sum; if (!gone && screen === 'ended') draw(); }, e => console.error(e));
  const tapResume = () => call(() => engine.tapResume()).catch(e => console.error(e));

  // ---------- 画面 ----------
  function draw() {
    stopEvery(moveTimer); moveTimer = null;
    if (offPress) { offPress(); offPress = null; }
    screen = SCREEN[st.phase] || 'ready';
    focusEl = null; wasTap = false;
    const next = screen === 'ready' ? readyView() : screen === 'live' ? liveView() : screen === 'ended' ? endedView() : screen === 'error' ? errorView()
      : busyView(t(screen === 'starting' ? 'bed.starting' : 'bed.ending'));
    if (cur) cur.replaceWith(next); else main.append(next, sr);
    cur = next;
    if (screen !== 'live') text(sr, '');
    paint();
    if (focusEl) focusEl.focus({ preventScroll: true });
  }
  function paint() { if (screen === 'ready') paintReady(); else if (screen === 'live') paintLive(); }
  const backLink = () => h('button.n-link', { type: 'button', onclick: () => ctx.back('/') }, icon('back'), t('common.back'));
  const busyView = (msg) => h('div.night', null, h('div.n-center', null, h('p.n-status', { role: 'status' }, msg)));

  function readyView() {
    const S = settings(), nn = (S.speakers && S.speakers.nn && S.speakers.nn.name) || 'NN';
    const endAt = autoEndAt(Date.now(), S);
    const tips = [t('bed.tipPower'), t('bed.tipLock'), t('bed.tipLowPower'), t('bed.tipDnd'), t('bed.tipNear', { nn }), t('bed.tipLocal'), firstTip ? t('bed.tipFirst') : null];
    els = { vad: h('p.bed-vad', { role: 'status' }), room: h('p.bed-space'), why: h('p.bed-why'),
      start: h('button.n-btn.main.bed-start', { type: 'button', onclick: start }, icon('mic'), t('bed.start')) };
    // 焦点不放在「开始」上：外壳把焦点给这一页，读屏从标题和清单读起
    return h('div.night.bed-ready', { role: 'region', 'aria-label': t('bed.title') },
      h('div.n-center', null,
        h('h1.bed-h', null, t('bed.title')),
        h('p.bed-lead', null, t('bed.intro')),
        h('ul.bed-tips', null, tips.filter(Boolean).map(s => h('li', null, s))),
        endAt == null ? null : h('label.bed-auto', null,
          h('span', null, h('b', null, t('bed.autoEnd', { time: clock(endAt, lang) })), h('small', null, t('bed.autoEndHelp'))),
          h('input.toggle', { type: 'checkbox', role: 'switch', checked: autoOn(), onchange: (e) => ctx.setLocal({ bedAutoEnd: !!e.target.checked }) })),
        els.vad, els.room, els.start, els.why),
      h('nav.n-links', null, backLink()));
  }
  function paintReady() {
    const no = blocked(), v = prepared ? vad || 'loading' : null;
    els.start.disabled = !!no;
    put(els.why, no && no !== 'wait' ? t('bed.' + no) : '');
    put(els.vad, v ? t(v === 'on' ? 'bed.vadReady' : v === 'off' ? 'bed.vadOff' : 'bed.vadLoading') : '');
    put(els.room, room && !no ? t('bed.space', { free: fmtBytes(room.freeBytes) || '—', min: Math.max(0, Math.floor(room.budgetSec / 60)) }) : '');
  }

  // 整夜的黑屏。字只在状态变时重画；位置每 MOVE_MS 换一次（和状态无关）
  function liveView() {
    els = { l1: h('p'), l2: h('p'), warn: h('p.bed-warn'), tapSub: h('small') };
    els.box = h('div.bed-box', null, els.l1, els.l2, els.warn);
    els.end = h('button.bed-end', { type: 'button', 'data-toast-avoid': '', onclick: () => { if (!pressFired) ctx.toast(t('bed.endTap')); pressFired = false; } }, t('bed.endHold'));
    offPress = longPress(els.end, () => { pressFired = true; end(); }, holdMs);
    els.tap = h('button.bed-tap', { type: 'button', hidden: true, onclick: tapResume }, h('b', null, t('bed.tap')), els.tapSub);
    const box = els.box, place = () => { const [x, y] = SPOTS[spot]; box.style.transform = `translate(${x}px, ${y}px)`; };
    place();
    moveTimer = every(() => { spot = (spot + 1) % SPOTS.length; place(); }, moveMs);
    return h('div.bed', { role: 'region', 'aria-label': t('bed.title') }, els.box, els.end, els.tap);
  }
  function paintLive() {
    const s = st, g = s.gap, tap = !!(g && g.needTap);
    els.tap.hidden = !tap; els.box.hidden = tap; els.end.hidden = tap;
    if (tap) put(els.tapSub, t('bed.tapSub', { why: why(g.reason) }));
    else if (g) { put(els.l1, t('bed.paused', { why: why(g.reason) })); put(els.l2, t('bed.pausedSub')); }
    else {
      put(els.l1, [t('bed.listening'), s.startedAt ? t('bed.since', { time: clock(s.startedAt, lang) }) : null, s.clips ? t('bed.clips', { n: s.clips }) : t('bed.noClips')].filter(Boolean).join(' · '));
      put(els.l2, s.clips && s.lastClipAt ? t('bed.lastClip', { time: clock(s.lastClipAt, lang) }) : '');
    }
    // 暗暗的琥珀色警告，一次最多一条：存不进（声音在丢）> 常亮没了 > 说话识别停了 > 存够了
    put(els.warn, s.warn === 'store' ? t('bed.storeFail') : s.wake === false ? t('bed.noWake') : s.vad === 'off' ? t('bed.energy') : s.warn === 'full' ? t('bed.full') : '');
    text(sr, tap ? t('bed.tap') : g ? t('bed.paused', { why: why(g.reason) }) : t('bed.listening'));
    if (tap && !wasTap) els.tap.focus({ preventScroll: true });
    wasTap = tap;
  }

  function endedView() {
    const s = st, sum = summary;
    const auto = sum ? sum.reason === 'auto' : !!(s.autoEndAt && Date.now() >= s.autoEndAt);
    const n = (sum ? sum.clips : s.clips) || 0, lost = (sum && sum.unsaved) || 0, nightOf = (sum && sum.nightOf) || s.nightOf;
    const line = [sum && sum.listenedMs != null ? t('bed.listened', { dur: fmtSpan(sum.listenedMs, t) }) : null,
      n ? t('bed.clips', { n }) : lost ? null : t('bed.endedNone'), lost ? t('bed.unsaved', { n: lost }) : null];
    const see = nightOf ? h('button.n-btn.main', { type: 'button', onclick: () => ctx.navigate('/night/' + nightOf) }, t('bed.seeNight')) : null;
    focusEl = see;
    return h('div.night.bed-done', null,
      h('div.n-center', null,
        h('h1.bed-h', null, auto && s.autoEndAt ? t('bed.endedAuto', { time: clock(s.autoEndAt, lang) }) : t('bed.ended')),
        h('p.bed-sum', null, line.filter(Boolean).join(' · ')),
        h('p.bed-why', null, t('bed.lockBack')),
        h('div.n-acts', null, see, h('button.n-btn', { type: 'button', onclick: () => ctx.back('/') }, t('common.done')))));
  }

  function errorView() {
    const e = st.error || {}, own = OWN_ERR.includes(e.code), code = own ? e.code : REC_ERR.includes(e.code) ? e.code : 'failed';
    const retry = code === 'unsupported' || code === 'noStore' ? null : h('button.n-btn.main', { type: 'button', onclick: start }, icon('mic'), t('rec.retry'));
    focusEl = retry;
    return h('div.night', null,
      h('div.n-center.n-error', null,
        h('p.n-err-t', { role: 'alert' }, own ? t('bed.cantStart') : t('rec.err.' + code + '.t')),
        h('p.n-err', null, own ? t('bed.' + code) : t('rec.err.' + code, { msg: e.message || '' })),
        retry ? h('div.n-acts', null, retry) : null),
      h('nav.n-links', null, backLink()));
  }

  const engine = make({ store: ctx.night, settings, device: ctx.device, build: ctx.build || null, sttBusy, onStatus });
  st = engine.status();
  // 开着（或正在开）的时候离开要先问：离开就不听了
  ctx.guard(() => st.phase === 'live' || st.phase === 'starting', { message: t('bed.leaveQ'), confirmLabel: t('bed.leave'), cancelLabel: t('bed.stay') });
  draw();
  leaving.then(recheck);

  return {
    onChange() {},          // 数据变了不重画：要显示的都在引擎的状态里，整夜的黑屏不能闪
    cleanup() {
      gone = true;
      stopEvery(moveTimer); moveTimer = null;
      if (offPress) offPress();
      offJob();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', recheck);
      // 开着就结束（存好正在录的那段；正在收尾的 end() 给的是同一个）；没开始过的关掉说话识别
      const ph = engine.phase || st.phase;
      if (ph === 'live' || ph === 'starting' || ph === 'ending') leaving = call(() => engine.end('leave')).catch(e => console.error(e));
      else { try { engine.dispose(); } catch (e) { console.error(e); } }
      release();
    },
  };
}

/**
 * 录音页上的入口（record.js 放在空闲的两种样子里提示的下面；接到某一条时不放）。点了推入 #/rec?bed=1（「返回」回到录音页）。
 * 今晚最后一次床头模式断了（App 被关掉、离开了那一页）、断了不到 6 小时 → 「床头模式 凌晨2:10 断了，点这里接着听」
 */
export function bedLink(ctx) {
  const label = h('small', null, t('bed.link'));
  const btn = h('button.n-link.bed-link', { type: 'button', onclick: () => ctx.navigate('/rec?bed=1') },
    h('span.bed-link-ic', null, icon('moon')), h('span.bed-link-txt', null, h('b', null, t('bed.title')), label), icon('chev'));
  const night = ctx.night;
  if (night && night.listSessions) {
    Promise.resolve(ctx.nightRecovered).then(() => night.listSessions()).then(ss => {
      const s = ss && ss[ss.length - 1], now = Date.now();           // listSessions 按开始时间排好
      if (!s || !s.endedAt || now - s.endedAt >= BROKEN_MS || !(s.status === 'crashed' || s.endReason === 'leave')) return;
      if (s.nightOf !== nightKey(now, (ctx.state && ctx.state.settings) || {}, s.tz)) return;
      label.textContent = t('bed.linkBroken', { time: clock(s.endedAt, ctx.lang(), s.tz) }); label.classList.add('broken');
    }).catch(() => {});
  }
  return btn;
}
