// 夜间录音（#/rec、#/rec?attach=<id>）：永远近黑、字很暗、没有动画。两种样子（babble.local.recOnly 记住选的哪个）：
//   边录边写（默认）：顶上一条（红点、计时、电平、「停止」），下面是写原话的地方（和编辑页一样：说话人按钮、反应表情、楷体文本框，
//     预填「👰🏻‍♀️ “”」、光标在引号中间）。整页贴着看得见的区域（visualViewport）：iPhone 弹出键盘时「停止」也一直在最上面。
//   只录音：录音时下面一大块都是「停止并保存」。
// 录音机见 core/recorder.js：每秒一片先存进本机；停下（自己点、到时间、被打断、离开这页、切到后台）就拼好存成一段，
// 马上建条目（或接到 attach 那条），写的字一起存进去；条目存好以后才清掉恢复记录——中途 App 没了，下次启动 recoverPending 会把它交回来。
// 写的字每 400 毫秒、切到后台时另存一份（babble.edit.rec，见 core/drafts.js）：App 被杀掉，下次启动时和找回的录音放进同一条。
// 「再录一段」接着放进同一条，写字的地方不变。没录音就离开：写了字就存成一条待整理（不会悄悄丢掉）。
// 自己管更新（返回 onChange）：同步、别的页面改数据都不会重画这一页，不打断录音和打字。
import { h, icon, longPress, download } from '../ui/dom.js';
import { stopAll } from '../ui/player.js';
import { createRecorder } from '../core/recorder.js';
import { extForMime } from '../core/audioStore.js';
import { localParts, today, fmtTime, fmtTimer, fmtDuration, fmtEntryDate } from '../core/dates.js';
import { previewLines } from '../core/dialogue.js';
import { clipName } from '../core/clips.js';
import { REC_DRAFT, writeDraft, dropDraft, clipOf, recTimeFields } from '../core/drafts.js';
import { writeTools, insertLine, startTemplate, keepFocus, revealCaret } from '../ui/writer.js';
import { t } from '../i18n.js';
/** replaceChildren，但跳过 null / false（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const enc = encodeURIComponent;
const store = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };
// 上一个录音页离开时还在存的那段（存好以后才把字写进条目、清草稿）：新打开的录音页等它存完再动草稿
let finishing = Promise.resolve();

/** 存不进本机时的兜底：能分享文件就用分享（存到「文件」等；主屏幕 Web App 里 <a download> 可能没反应），不能就下载。要在点按里调用 */
export function saveFile(blob) {
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

/**
 * 条目的简短称呼（选「接到哪一条」、「已存进 …」这些地方用；条目没有标题）：
 * 「2026年11月4日 凌晨2:58 · 第一句的开头」；还没写原话 → 第一段有名字的录音（「· 🎙 下雨了」）；都没有就只有日期时间
 */
export function entryLabel(e, speakers, lang) {
  if (!e) return '';
  const cut = (s) => ([...s].length > 18 ? [...s].slice(0, 17).join('') + '…' : s);
  const first = previewLines(e.text, speakers, 1)[0];
  const line = first ? first.content.replace(/\s+/g, ' ').trim() : '';
  const name = line ? '' : (e.audio || []).map(clipName).find(Boolean) || '';
  const words = line ? cut(line) : name ? '🎙 ' + cut(name) : '';
  return fmtEntryDate(e, lang, { sep: lang === 'en' ? ', ' : ' ' }) + (words ? ' · ' + words : '');
}

export function render(main, params, ctx) {
  const lang = ctx.lang();
  const maxMin = ctx.state.settings.maxRecordMin || 10;
  const sp = () => ctx.state.settings.speakers;
  const attachId = (params.query && params.query.attach) || null;
  let target = attachId;          // 录好的、写的字放进哪一条；第一段存好以后就是刚建的那条（「再录一段」接着放进去）
  let phase = 'idle';             // idle | requesting | recording | stopping | saved | error
  let errInfo = null, saved = null, startedAt = 0, gone = false, warn = null, recId = null;
  let tick = null, offPress = null, pressFired = false, cancelled = false, onFinish = null;
  let meterFill = null, timerEl = null, subEl = null, warnEl = null;

  const rec = createRecorder({
    audioStore: ctx.audio, maxMs: maxMin * 60000,
    onLevel: (v) => { if (meterFill) meterFill.style.transform = `scaleX(${Math.max(0.02, v).toFixed(3)})`; },
    onState,
  });

  // ---------- 写原话 ----------
  const tpl = startTemplate(sp());                                  // 「👰🏻‍♀️ “”」，光标在引号中间
  const att = attachId ? ctx.entry(attachId) : null;
  let base = att && !att.deleted ? att.text || '' : null;           // 上次存进条目的原话（还没有条目 → null）
  let touched = false;                                              // 点进过文本框（光标位置才算数）
  // 第一次点进来、还是预填的「👰🏻‍♀️ “”」：光标放进引号中间（点按自己放的光标在这之后，所以晚一点）
  const firstFocus = () => {
    if (touched) return;
    touched = true;
    if (ta.value === tpl.text) setTimeout(() => { if (document.activeElement === ta && ta.value === tpl.text) ta.setSelectionRange(tpl.cursor, tpl.cursor); }, 0);
  };
  const ta = h('textarea.kai.n-ta', { value: base || tpl.text, rows: 4, placeholder: t('edit.textPh', { nn: sp().nn.name || 'NN' }), 'aria-label': t('edit.text'),
    autocapitalize: 'off', spellcheck: 'false', oninput: () => persistSoon(), onfocus: firstFocus });
  const insert = (who, body) => { insertLine(ta, who, body, sp(), { atEnd: !touched }); touched = true; revealCaret(ta); persistSoon(); };
  const writeBox = h('div.n-wbox', null, writeTools({ speakers: sp(), onInsert: insert }), ta);
  const cleanText = () => (ta.value === tpl.text ? '' : ta.value);   // 预填的没动过 = 没写
  const dirty = () => cleanText() !== (base ?? '');
  const writeOn = () => !ctx.local.recOnly;
  function focusWrite() {
    const first = !touched;
    touched = true;
    ta.focus({ preventScroll: true });
    if (!first) return;
    const c = ta.value === tpl.text ? tpl.cursor : ta.value.length;
    ta.setSelectionRange(c, c);
    revealCaret(ta);
  }

  // 另存一份（只在有没存进条目的字时）。启动时 App 要先处理上次留下的那份（ctx.recovered），上一个录音页可能还在存：都好了再写
  let ready = false, owned = false, persistTimer = null;
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    if (!ready) return;
    if (dirty()) owned = writeDraft(store(), REC_DRAFT, { v: 1, text: cleanText(), target: target || null, base, rec: recId, at: Date.now() }) || owned;
    else if (owned) { dropDraft(store(), REC_DRAFT); owned = false; }
  }
  const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 400); };
  Promise.all([ctx.recovered, finishing]).catch(() => {}).then(() => { ready = true; if (!gone) persistNow(); });

  /** 写的字存进条目（没改就不动）；还没有条目、写了字 → 新建一条待整理。返回条目 id */
  function commitText(opts) {
    if (!dirty()) return target;
    const txt = cleanText(), e = target && ctx.entry(target);
    let id = null;
    if (e && !e.deleted) id = ctx.update(e.id, { text: txt }).id;
    else if (txt) id = ctx.put(ctx.newEntry({ date: today(), status: 'inbox', text: txt, source: { kind: 'app' } }), opts).id;
    if (!id) return target;
    target = id; base = txt;
    ready = true; persistNow();
    return id;
  }

  const root = h('div.night', { role: 'region', 'aria-label': t('nav.rec') });
  const top = h('div.n-main');
  const foot = h('nav.n-links.n-wfoot');
  const live = h('p.sr-only', { role: 'status', 'aria-live': 'polite' });
  root.append(top, writeBox, foot);
  main.append(root, live);

  // 贴着看得见的区域：iPhone 弹出键盘时可见区域变矮、还可能往下滚，整页跟着（停止键一直在上面）；矮的时候换紧凑的样子
  const vv = window.visualViewport || null;
  function fit() {
    const hgt = vv ? vv.height : window.innerHeight;
    root.style.setProperty('--vv-h', Math.round(hgt) + 'px');
    root.style.setProperty('--vv-top', Math.round(vv ? vv.offsetTop : 0) + 'px');
    root.classList.toggle('n-tight', hgt < 600 || hgt < window.innerHeight * 0.8);
  }
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  window.addEventListener('resize', fit);
  fit();

  // ---------- 录音机状态 → 页面 ----------
  function onState(s, info) {
    if (s === 'recording' && info && info.recId && recId !== info.recId) { recId = info.recId; persistNow(); }
    if (s === 'saved') { onSaved(info); return; }
    if (s === 'error' || s === 'idle') {
      // 存 clip 失败：分片留着下次启动找回，草稿里的 recId 也留着（到时候字和录音放进同一条）
      if (!(s === 'error' && info && info.code === 'save')) recId = null;
      persistNow();
      if (gone) { if (!(s === 'error' && info && info.code === 'save')) commitText(); finished(); }
    }
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
  function finished() { if (onFinish) { const f = onFinish; onFinish = null; f(); } }

  /** 存好一段：建条目 / 接到那一条，写的字一起存进去；条目真的存进本机了才清恢复记录 */
  function onSaved(res) {
    const clip = clipOf(res);
    const txt = cleanText(), textChanged = dirty();
    let ok = true, id = null;
    const off = ctx.on('change', (info) => { if (info && info.saved === false) ok = false; });
    try {
      const cur = target && ctx.entry(target);
      if (cur && !cur.deleted) {
        const patch = {};
        if (!(cur.audio || []).some(a => a.sha256 === clip.sha256)) patch.audio = [...(cur.audio || []), clip];
        if (textChanged) patch.text = txt;
        if (Object.keys(patch).length) ctx.update(cur.id, patch);
        id = cur.id;
      } else {
        id = ctx.put(ctx.newEntry({ ...recTimeFields(res.startedAt, res.tz), status: 'inbox', text: txt, audio: [clip], source: { kind: 'app' } })).id;
      }
    } catch (e) { ok = false; console.error(e); }
    off();
    if (ok && id) { base = txt; recId = null; }
    ready = true; persistNow();                     // 字已经在条目里了：草稿删掉（没存进去就留着，连同 recId，下次启动再找回）
    if (ok && id && res.recId) Promise.resolve(ctx.audio.clearRec(res.recId)).catch(() => {});
    target = id || target;
    saved = { ...res, id, appended: !!(attachId && id === attachId) || (saved && saved.id === id) };
    if (gone) { finished(); ctx.toast(t('rec.savedAway', { dur: fmtDuration(res.durationSec) || '0:00' }), { ms: 6000 }); return; }
    go('saved');
  }

  // ---------- 操作 ----------
  async function start() {
    if (phase === 'requesting' || phase === 'recording' || phase === 'stopping') return;
    stopAll();                                      // 正在放的录音先停
    errInfo = null; warn = null;
    const p = rec.start(target ? { attachTo: target } : {});              // 必须在点按里调用（iOS 的麦克风、常亮都要手势）
    if (writeOn()) focusWrite();                    // 键盘也要在点按里叫出来
    try { await p; }
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
  const backTo = () => (attachId ? '/e/' + enc(attachId) : '/');
  function setWrite(on) {
    ctx.setLocal({ recOnly: !on });
    draw();
    if (on && phase !== 'saved' && phase !== 'error') focusWrite();
    else if (!on && document.activeElement === ta) ta.blur();
  }
  /** 「只记文字」：写了字就先存成一条，到编辑页接着写；没写就是新的一条 */
  function textOnly() {
    const typed = dirty(), id = commitText();
    ctx.navigate(typed && id ? '/edit/' + enc(id) : '/new');
  }
  function toEditor() { const id = commitText(); if (id) ctx.navigate('/edit/' + enc(id)); }
  function finish() { commitText(); ctx.back(backTo()); }
  function markDone() {
    const id = commitText();
    if (id) ctx.update(id, { status: 'done' }, { undoLabel: t('entry.doneToast') });
    ctx.back(backTo());
  }

  // 切到后台 / 关掉页面：写的字马上另存，录到的先存好（iOS 在后台本来也录不了）
  const onVis = () => { if (document.visibilityState === 'hidden') { persistNow(); stop('hidden'); } };
  const onHide = () => { persistNow(); stop('pagehide'); };
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
    const writing = writeOn();
    root.classList.toggle('n-write', writing);
    writeBox.hidden = !writing;
    foot.hidden = !writing;
    if (writing) { fill(top, ...writeTop()); fill(foot, ...writeFoot()); fit(); }
    else if (phase === 'recording' || phase === 'stopping') fill(top, ...recordingView());
    else if (phase === 'saved') fill(top, ...savedView());
    else if (phase === 'error') fill(top, ...errorView());
    else fill(top, ...idleView());
    live.textContent = phase === 'recording' ? t('rec.recording') : phase === 'saved' ? t('rec.saved') : phase === 'stopping' ? t('rec.saving') : '';
    if (writing && document.activeElement === ta) return;          // 正在写：焦点留在文本框（键盘不收起）
    const focus = root.querySelector('[data-autofocus]');
    if (focus) focus.focus({ preventScroll: true });
  }

  function attachLine() {
    if (!attachId) return null;
    const e = ctx.entry(attachId);
    if (!e || e.deleted) return h('p.n-attach', null, t('rec.attachGone'));
    return h('p.n-attach', null, t('rec.attachTo'), lang === 'en' ? ' ' : '', h('span.n-attach-what', null, entryLabel(e, sp(), lang)));
  }
  const startBtn = (waiting) => h('button.n-start', { type: 'button', disabled: waiting, 'aria-busy': waiting ? 'true' : null, onmousedown: keepFocus, onclick: start, dataset: { autofocus: '1' } },
    h('span.n-snout', { 'aria-hidden': 'true' }, h('i'), h('i')),
    h('b', null, waiting ? t('rec.requesting') : t('rec.start')));
  const backLink = () => h('button.n-link', { type: 'button', onclick: () => ctx.back(backTo()) }, icon('back'), t('common.back'));
  const textOnlyLink = () => h('button.n-link', { type: 'button', onclick: textOnly }, icon('pencil'), t('rec.textOnly'));
  /** 长按丢弃：点一下只提示 */
  function discardBtn(stopping, withLabel) {
    const b = h('button.n-discard', { type: 'button', hidden: stopping, 'aria-label': t('rec.discardHold'), title: t('rec.discardHold'), onmousedown: keepFocus,
      onclick: () => { if (!pressFired) ctx.toast(t('rec.discardTap')); pressFired = false; } },
    h('i', null, icon('x')), withLabel ? h('span', null, t('rec.discardHold')) : null);
    offPress = longPress(b, () => { pressFired = true; discard(); }, 1000);
    return b;
  }
  /** 计时、电平、开始时间那一行（录音中两种样子共用） */
  function recParts() {
    timerEl = h('p.n-timer', { role: 'timer', 'aria-label': t('rec.elapsed') }, fmtTimer(rec.elapsedMs() / 1000));
    meterFill = h('i');
    subEl = h('p.n-sub');
    warnEl = h('p.n-warn', { hidden: true, role: 'alert' });
    paintSub(); paintWarn();
    tick = setInterval(() => {
      const s = fmtTimer(rec.elapsedMs() / 1000);
      if (timerEl && timerEl.textContent !== s) timerEl.textContent = s;
      paintSub();
    }, 500);
  }

  // ----- 只录音（v1 的样子） -----
  function idleView() {
    const waiting = phase === 'requesting';
    return [
      h('div.n-center', null, attachLine(), startBtn(waiting), h('p.n-hint', null, t('rec.hint', { n: maxMin }))),
      h('nav.n-links', null,
        waiting ? h('button.n-link', { type: 'button', onclick: () => stop('cancel') }, t('common.cancel')) : textOnlyLink(),
        waiting ? null : h('button.n-link', { type: 'button', onclick: () => setWrite(true) }, icon('bubble'), t('rec.writeToo')),
        backLink()),
    ];
  }

  function recordingView() {
    const stopping = phase === 'stopping';
    recParts();
    const stopBtn = h('button.n-stop', { type: 'button', disabled: stopping, onclick: () => stop('user'), dataset: { autofocus: '1' } },
      h('span.n-stop-ic', { 'aria-hidden': 'true' }),
      h('b', null, stopping ? t('rec.saving') : t('rec.stop')),
      stopping ? null : h('small', null, t('rec.stopHint')));
    return [
      h('div.n-top', null, discardBtn(stopping, true),
        h('button.n-link.n-wtoggle', { type: 'button', onclick: () => setWrite(true) }, icon('bubble'), t('rec.writeToo'))),
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

  function savedInfo() {
    const e = saved && saved.id ? ctx.entry(saved.id) : null;
    const why = saved && WHY[saved.reason];
    const where = saved && saved.appended && e ? t('rec.savedTo', { what: entryLabel(e, sp(), lang) }) : t('rec.savedInbox');
    return { e, why, where };
  }
  function savedView() {
    const { e, why, where } = savedInfo();
    return [
      h('div.n-center.n-saved', null,
        h('p.n-status.ok', null, icon('check'), t('rec.saved')),
        h('p.n-big', null, fmtDuration(saved && saved.durationSec) || '0:00'),
        h('p.n-sub', null, where),
        why ? h('p.n-why', null, t(why, { n: maxMin })) : null,
        h('div.n-acts', null,
          e ? h('button.n-btn.main', { type: 'button', onclick: toEditor, dataset: { autofocus: '1' } }, icon('pencil'), t('rec.write')) : null,
          h('button.n-btn', { type: 'button', onclick: start }, icon('mic'), t('rec.again')),
          h('button.n-btn', { type: 'button', onclick: finish }, t('common.done')))),
    ];
  }

  function errorParts() {
    const code = ERR_CODES.includes(errInfo && errInfo.code) ? errInfo.code : 'failed';
    const blob = code === 'save' && errInfo.blob;
    return {
      title: h('p.n-err-t', { role: 'alert' }, t('rec.err.' + code + '.t')),
      msg: h('p.n-err', null, t('rec.err.' + code, { msg: (errInfo && errInfo.message) || '' })),
      acts: h('div.n-acts', null,
        blob ? h('button.n-btn.main', { type: 'button', dataset: { autofocus: '1' }, onclick: () => saveFile(blob) }, t('rec.download')) : null,
        code === 'unsupported' ? null : h('button.n-btn' + (blob ? '' : '.main'), { type: 'button', onclick: start, dataset: blob ? {} : { autofocus: '1' } }, icon('mic'), t('rec.retry')),
        h('a.n-btn', { href: '#/diag' }, t('nav.diag'))),
    };
  }
  function errorView() {
    const { title, msg, acts } = errorParts();
    return [
      h('div.n-center.n-error', null, title, msg, acts),
      h('nav.n-links', null, textOnlyLink(), backLink()),
    ];
  }

  // ----- 边录边写 -----
  function writeTop() {
    if (phase === 'recording' || phase === 'stopping') {
      const stopping = phase === 'stopping';
      recParts();
      return [
        h('div.n-bar', { 'data-toast-avoid': '' },
          discardBtn(stopping, false),
          h('div.n-bar-mid', null,
            h('p.n-bar-time', null, h('i.n-dot', { 'aria-hidden': 'true' }), timerEl),
            h('div.n-meter', { 'aria-hidden': 'true' }, meterFill)),
          h('button.n-stopbar', { type: 'button', disabled: stopping, onmousedown: keepFocus, onclick: () => stop('user'), dataset: { autofocus: '1' } },
            h('span.n-stop-ic', { 'aria-hidden': 'true' }), h('b', null, stopping ? t('rec.saving') : t('rec.stopShort')))),
        h('div.n-bar-sub', null, subEl, warnEl, attachLine()),
      ];
    }
    if (phase === 'saved') {
      const { e, why, where } = savedInfo();
      return [
        h('div.n-bar.n-bar-saved', { 'data-toast-avoid': '' },
          h('div.n-bar-mid', null,
            h('p.n-status.ok', null, icon('check'), t('rec.saved'), ' ', h('span.n-dur', null, fmtDuration(saved && saved.durationSec) || '0:00')),
            h('p.n-sub', null, where),
            why ? h('p.n-why', null, t(why, { n: maxMin })) : null)),
        h('div.n-acts.n-acts-row', null,
          h('button.n-btn.main', { type: 'button', onmousedown: keepFocus, onclick: start, dataset: { autofocus: '1' } }, icon('mic'), t('rec.again')),
          e && e.status === 'inbox' ? h('button.n-btn', { type: 'button', onclick: markDone }, icon('check'), t('entry.done')) : null,
          h('button.n-btn', { type: 'button', onclick: finish }, t('common.done'))),
      ];
    }
    if (phase === 'error') {
      const { title, msg, acts } = errorParts();
      acts.classList.add('n-acts-row');
      return [h('div.n-errbox', null, title, msg, acts)];
    }
    return [h('div.n-hero', null, attachLine(), startBtn(phase === 'requesting'), h('p.n-hint', null, t('rec.hint', { n: maxMin })))];
  }
  function writeFoot() {
    const only = h('button.n-link', { type: 'button', onclick: () => setWrite(false) }, icon('mic'), t('rec.recOnly'));
    if (phase === 'recording' || phase === 'stopping') return [only];
    if (phase === 'saved') return [saved && saved.id ? h('button.n-link', { type: 'button', onclick: toEditor }, icon('pencil'), t('rec.toEditor')) : null, only];
    if (phase === 'requesting') return [h('button.n-link', { type: 'button', onclick: () => stop('cancel') }, t('common.cancel'))];
    return [textOnlyLink(), phase === 'error' ? null : only, backLink()];
  }

  draw();

  return {
    // 数据变了不重画（录音、打字不能被打断）。要写进的那条在别的设备上改了原话、这里又没动过：换成新的；「已保存」那屏跟着条目变
    onChange: () => {
      const e = target && ctx.entry(target);
      if (e && !e.deleted && base !== null && !dirty() && (e.text || '') !== base) { base = e.text || ''; ta.value = base || tpl.text; }
      if (phase === 'saved') draw();
    },
    cleanup: () => {
      gone = true;
      clearInterval(tick);
      if (offPress) offPress();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
      window.removeEventListener('resize', fit);
      // 离开这页：录着的照样存好建条目，写的字一起存进去（onSaved 会提示一句）；还在等权限的直接取消。没在录：写的字现在就存
      if (rec.state === 'recording' || rec.state === 'stopping' || rec.state === 'requesting') {
        finishing = new Promise(res => { onFinish = res; setTimeout(res, 70000); });
        stop('leave');
      } else {
        persistNow();
        if (dirty()) commitText(!target ? { undoLabel: t('rec.textSaved') } : undefined);
      }
    },
  };
}
