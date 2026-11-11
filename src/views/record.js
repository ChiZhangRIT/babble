// 夜间录音（#/rec、#/rec?attach=<id>）：永远近黑、字很暗、没有动画；录音时下面一大块都是「停止并保存」。
// 录音机见 core/recorder.js：每秒一片先存进本机；停下（自己点、到时间、被打断、离开这页、切到后台）就拼好存成一段，
// 马上建条目（或接到 attach 那条），条目存好以后才清掉恢复记录——中途 App 没了，下次启动 recoverPending 会把它交回来。
// 自己管更新（返回 onChange）：同步、别的页面改数据都不会重画这一页，不打断录音。
import { h, icon, longPress, download } from '../ui/dom.js';
import { stopAll } from '../ui/player.js';
import { createRecorder } from '../core/recorder.js';
import { extForMime } from '../core/audioStore.js';
import { localParts, today, fmtTime, fmtTimer, fmtDuration, fmtEntryDate } from '../core/dates.js';
import { firstNNLine } from '../core/dialogue.js';
import { t } from '../i18n.js';
/** replaceChildren，但跳过 null / false（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const enc = encodeURIComponent;
/** 存不进本机时的兜底：能分享文件就用分享（存到「文件」等；主屏幕 Web App 里 <a download> 可能没反应），不能就下载。要在点按里调用 */
function saveFile(blob) {
  const name = `babble-rec-${today()}.${extForMime(blob.type)}`;
  try {
    const file = new File([blob], name, { type: blob.type || 'audio/mp4' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(e => { if (!e || e.name !== 'AbortError') download(name, blob); });
      return;
    }
  } catch (e) { /* 不支持就下载 */ }
  download(name, blob);
}
const ERR_CODES = ['denied', 'unsupported', 'nomic', 'failed', 'empty', 'save'];
// 自动停下的原因 → 保存后的说明（自己点停止的不用说明）
const WHY = { max: 'rec.why.max', hidden: 'rec.why.hidden', pagehide: 'rec.why.hidden', interrupted: 'rec.why.interrupted', ended: 'rec.why.interrupted', error: 'rec.why.error' };

/** 条目的简短称呼：「11月4日 凌晨2:58 · 标题或第一句」 */
export function entryLabel(e, speakers, lang) {
  if (!e) return '';
  const words = e.title || firstNNLine(e.text, speakers) || '';
  return fmtEntryDate(e, lang, { sep: ' ' }) + (words ? ' · ' + words : '');
}

export function render(main, params, ctx) {
  const lang = ctx.lang();
  const maxMin = ctx.state.settings.maxRecordMin || 10;
  const sp = () => ctx.state.settings.speakers;
  const attachId = (params.query && params.query.attach) || null;
  let target = attachId;          // 录好的接到哪一条；「再录一段」时就是刚建的那条
  let phase = 'idle';             // idle | requesting | recording | stopping | saved | error
  let errInfo = null, saved = null, startedAt = 0, gone = false, warn = null;
  let tick = null, offPress = null, pressFired = false, cancelled = false;
  let meterFill = null, timerEl = null, subEl = null, warnEl = null;

  const rec = createRecorder({
    audioStore: ctx.audio, maxMs: maxMin * 60000,
    onLevel: (v) => { if (meterFill) meterFill.style.transform = `scaleX(${Math.max(0.02, v).toFixed(3)})`; },
    onState,
  });

  const root = h('div.night', { role: 'region', 'aria-label': t('nav.rec') });
  const live = h('p.sr-only', { role: 'status', 'aria-live': 'polite' });
  main.append(root, live);

  // ---------- 录音机状态 → 页面 ----------
  function onState(s, info) {
    if (s === 'saved') { onSaved(info); return; }
    // 已经离开这页（点了侧栏、拖进文件）时存失败：页面不在了，用提示条给一个「存文件」的入口，不能悄悄丢掉
    if (gone && s === 'error' && info && info.code === 'save' && info.blob) {
      const blob = info.blob;
      ctx.toast(t('rec.saveFailAway'), { ms: 120000, action: { label: t('rec.download'), run: () => saveFile(blob) } });
      return;
    }
    if (gone) return;
    if (s === 'recording') {
      if (info && info.warn) { warn = info.warn; paintWarn(); return; }
      if (phase !== 'recording') { startedAt = Date.now(); go('recording'); }
      return;
    }
    if (s === 'error') { errInfo = info || { code: 'failed' }; go('error'); return; }
    if (s === 'idle') { if (info && info.discarded && !cancelled) ctx.toast(t('rec.discarded')); cancelled = false; go('idle'); return; }
    if (s === 'requesting' || s === 'stopping') go(s);
  }

  /** 存好一段：建条目 / 接到那一条；条目真的存进本机了才清恢复记录 */
  function onSaved(res) {
    const clip = { sha256: res.sha256, mime: res.mime, bytes: res.bytes, durationSec: res.durationSec, origName: '', addedAt: Date.now() };
    let ok = true, id = null;
    const off = ctx.on('change', (info) => { if (info && info.saved === false) ok = false; });
    try {
      const cur = target && ctx.entry(target);
      if (cur && !cur.deleted) {
        if (!(cur.audio || []).some(a => a.sha256 === clip.sha256)) ctx.update(cur.id, { audio: [...(cur.audio || []), clip] });
        id = cur.id;
      } else {
        const p = res.startedAt != null ? localParts(res.startedAt, res.tz || undefined) : null;
        const e = ctx.newEntry({
          date: p ? p.date : today(), time: p ? p.time : null,
          recordedAt: p ? new Date(res.startedAt).toISOString() : null, tz: res.tz || null, timeSource: p ? 'recorder' : null,
          status: 'inbox', audio: [clip], source: { kind: 'app' },
        });
        id = ctx.put(e).id;
      }
    } catch (e) { ok = false; console.error(e); }
    off();
    if (ok && id && res.recId) Promise.resolve(ctx.audio.clearRec(res.recId)).catch(() => {});
    target = id || target;
    saved = { ...res, id, appended: !!(attachId && id === attachId) || (saved && saved.id === id) };
    if (gone) { ctx.toast(t('rec.savedAway', { dur: fmtDuration(res.durationSec) || '0:00' }), { ms: 6000 }); return; }
    go('saved');
  }

  // ---------- 操作 ----------
  async function start() {
    if (phase === 'requesting' || phase === 'recording' || phase === 'stopping') return;
    stopAll();                                      // 正在放的录音先停
    errInfo = null; warn = null;
    try { await rec.start(target ? { attachTo: target } : {}); }          // 必须在点按里调用（iOS 的麦克风、常亮都要手势）
    catch (e) { errInfo = { code: 'failed', message: (e && e.message) || String(e) }; go('error'); }
  }
  const stop = (reason = 'user') => {
    if (rec.state === 'requesting') cancelled = true;          // 还在等权限：stop 就是取消，不算「丢弃」
    if (rec.state === 'recording' || rec.state === 'requesting') rec.stop({ reason }).catch(e => console.error(e));
  };
  async function discard() {
    const ok = await ctx.confirm({ message: t('rec.discardQ'), confirmLabel: t('rec.discard'), cancelLabel: t('rec.keep'), danger: true });
    if (ok && rec.state === 'recording') await rec.discard();
  }

  // 切到后台 / 关掉页面：录到的先存好（iOS 在后台本来也录不了）
  const onVis = () => { if (document.visibilityState === 'hidden') stop('hidden'); };
  const onHide = () => stop('pagehide');
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);

  // ---------- 画面 ----------
  function go(p) {
    phase = p;
    if (!gone) draw();
  }
  function draw() {
    clearInterval(tick); tick = null;
    if (offPress) { offPress(); offPress = null; }
    meterFill = timerEl = subEl = warnEl = null;
    root.dataset.phase = phase;
    if (phase === 'recording' || phase === 'stopping') fill(root, ...recordingView());
    else if (phase === 'saved') fill(root, ...savedView());
    else if (phase === 'error') fill(root, ...errorView());
    else fill(root, ...idleView());
    live.textContent = phase === 'recording' ? t('rec.recording') : phase === 'saved' ? t('rec.saved') : phase === 'stopping' ? t('rec.saving') : '';
    const focus = root.querySelector('[data-autofocus]');
    if (focus) focus.focus({ preventScroll: true });
  }

  function attachLine() {
    if (!attachId) return null;
    const e = ctx.entry(attachId);
    if (!e || e.deleted) return h('p.n-attach', null, t('rec.attachGone'));
    return h('p.n-attach', null, t('rec.attachTo'), lang === 'en' ? ' ' : '', h('span.n-attach-what', null, entryLabel(e, sp(), lang)));
  }

  function idleView() {
    const waiting = phase === 'requesting';
    return [
      h('div.n-center', null,
        attachLine(),
        h('button.n-start', { type: 'button', disabled: waiting, 'aria-busy': waiting ? 'true' : null, onclick: start, dataset: { autofocus: '1' } },
          h('span.n-snout', { 'aria-hidden': 'true' }, h('i'), h('i')),
          h('b', null, waiting ? t('rec.requesting') : t('rec.start'))),
        h('p.n-hint', null, t('rec.hint', { n: maxMin }))),
      h('nav.n-links', null,
        waiting ? h('button.n-link', { type: 'button', onclick: () => stop('cancel') }, t('common.cancel'))
          : h('a.n-link', { href: '#/new' }, icon('pencil'), t('rec.textOnly')),
        h('button.n-link', { type: 'button', onclick: () => ctx.back(attachId ? '/e/' + enc(attachId) : '/') }, icon('back'), t('common.back'))),
    ];
  }

  function recordingView() {
    const stopping = phase === 'stopping';
    const xBtn = h('button.n-discard', { type: 'button', hidden: stopping, 'aria-label': t('rec.discardHold'),
      onclick: () => { if (!pressFired) ctx.toast(t('rec.discardTap')); pressFired = false; } },
    h('i', null, icon('x')), h('span', null, t('rec.discardHold')));
    offPress = longPress(xBtn, () => { pressFired = true; discard(); }, 1000);
    timerEl = h('p.n-timer', { role: 'timer', 'aria-label': t('rec.elapsed') }, fmtTimer(rec.elapsedMs() / 1000));
    meterFill = h('i');
    subEl = h('p.n-sub');
    warnEl = h('p.n-warn', { hidden: true, role: 'alert' });
    const stopBtn = h('button.n-stop', { type: 'button', disabled: stopping, onclick: () => stop('user'), dataset: { autofocus: '1' } },
      h('span.n-stop-ic', { 'aria-hidden': 'true' }),
      h('b', null, stopping ? t('rec.saving') : t('rec.stop')),
      stopping ? null : h('small', null, t('rec.stopHint')));
    paintSub(); paintWarn();
    tick = setInterval(() => {
      const s = fmtTimer(rec.elapsedMs() / 1000);
      if (timerEl && timerEl.textContent !== s) timerEl.textContent = s;
      paintSub();
    }, 500);
    return [
      h('div.n-top', null, xBtn),
      h('div.n-head', null,
        h('p.n-status', null, h('i', { 'aria-hidden': 'true' }), stopping ? t('rec.saving') : t('rec.recording')),
        timerEl,
        h('div.n-meter', { 'aria-hidden': 'true' }, meterFill),
        subEl, warnEl, attachLine()),
      stopBtn,
    ];
  }
  function paintSub() {
    if (!subEl) return;
    const st = rec.stats();
    const p = startedAt ? localParts(startedAt) : null;
    const parts = [p ? t('rec.startedAt', { time: fmtTime(p.time, lang) }) : null, st && st.wakeLock ? t('rec.awake') : t('rec.noAwake'), t('rec.maxMin', { n: maxMin })];
    const s = parts.filter(Boolean).join(' · ');
    if (subEl.textContent !== s) subEl.textContent = s;
  }
  function paintWarn() {
    if (!warnEl) return;
    warnEl.hidden = !warn;
    warnEl.textContent = warn ? t('rec.persistWarn') : '';
  }

  function savedView() {
    const e = saved && saved.id ? ctx.entry(saved.id) : null;
    const why = saved && WHY[saved.reason];
    const where = saved && saved.appended && e ? t('rec.savedTo', { what: entryLabel(e, sp(), lang) }) : t('rec.savedInbox');
    return [
      h('div.n-center.n-saved', null,
        h('p.n-status.ok', null, icon('check'), t('rec.saved')),
        h('p.n-big', null, fmtDuration(saved && saved.durationSec) || '0:00'),
        h('p.n-sub', null, where),
        why ? h('p.n-why', null, t(why, { n: maxMin })) : null,
        h('div.n-acts', null,
          e ? h('button.n-btn.main', { type: 'button', onclick: () => ctx.navigate('/edit/' + enc(e.id)), dataset: { autofocus: '1' } }, icon('pencil'), t('rec.write')) : null,
          h('button.n-btn', { type: 'button', onclick: start }, icon('mic'), t('rec.again')),
          h('button.n-btn', { type: 'button', onclick: () => ctx.back(attachId ? '/e/' + enc(attachId) : '/') }, t('common.done')))),
    ];
  }

  function errorView() {
    const code = ERR_CODES.includes(errInfo && errInfo.code) ? errInfo.code : 'failed';
    const blob = code === 'save' && errInfo.blob;
    return [
      h('div.n-center.n-error', null,
        h('p.n-err-t', { role: 'alert' }, t('rec.err.' + code + '.t')),
        h('p.n-err', null, t('rec.err.' + code, { msg: (errInfo && errInfo.message) || '' })),
        h('div.n-acts', null,
          blob ? h('button.n-btn.main', { type: 'button', dataset: { autofocus: '1' },
            onclick: () => saveFile(blob) }, t('rec.download')) : null,
          code === 'unsupported' ? null : h('button.n-btn' + (blob ? '' : '.main'), { type: 'button', onclick: start, dataset: blob ? {} : { autofocus: '1' } }, icon('mic'), t('rec.retry')),
          h('a.n-btn', { href: '#/diag' }, t('nav.diag')))),
      h('nav.n-links', null,
        h('a.n-link', { href: '#/new' }, icon('pencil'), t('rec.textOnly')),
        h('button.n-link', { type: 'button', onclick: () => ctx.back(attachId ? '/e/' + enc(attachId) : '/') }, icon('back'), t('common.back'))),
    ];
  }

  draw();

  return {
    // 数据变了不重画（录音不能被打断）；只有「已保存」那屏要跟着条目的标题变
    onChange: () => { if (phase === 'saved') draw(); },
    cleanup: () => {
      gone = true;
      clearInterval(tick);
      if (offPress) offPress();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      stop('leave');                                // 离开这页：录着的照样存好建条目（onSaved 会提示一句）；还在等权限的直接取消
    },
  };
}
