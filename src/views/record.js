// 夜间录音（#/rec、#/rec?attach=<id>）：永远近黑、字很暗、没有动画。两种样子（babble.local.recOnly 记住选的哪个）：
//   边录边写（默认）：顶上一条（红点、计时、电平、「停止」），下面是写原话的地方（和编辑页一样：说话人按钮、反应表情、楷体文本框，
//     预填「👰🏻‍♀️ “”」、光标在引号中间）。整页贴着看得见的区域（visualViewport）：iPhone 弹出键盘时「停止」也一直在最上面。
//   只录音：录音时下面一大块都是「停止并保存」。
// 录音机见 core/recorder.js：每秒一片先存进本机；停下（自己点、到时间、被打断、离开这页、切到后台）就拼好存成一段，
// 马上建条目（或接到 attach 那条），写的字一起存进去；条目存好以后才清掉恢复记录——中途 App 没了，下次启动 recoverPending 会把它交回来。
// 写的字每 400 毫秒、切到后台时另存一份（babble.edit.rec，见 core/drafts.js）：App 被杀掉，下次启动时和找回的录音放进同一条。
// 「再录一段」接着放进同一条，写字的地方不变。没录音就离开：写了字就存成一条待整理（不会悄悄丢掉）。
// 录着的时候左上角的 ✕ 点一下就取消这段：录音机照常停下、存成一段（数据安全），但不建条目、不进编辑页，回到点「开始录音」之前
//   （写的字留在框里；是在「已保存」上点的「再录一段」就回到那一屏）。
//   提示条上 10 秒内能「撤销」= 当成点了停止（照常建条目 / 接上）；过了才删掉录音（audioStore.deleteClip + clearRec）。
//   这 10 秒里又点了「开始录音」：多半是 ✕ 点错了（她还在说）——取消的那段照常留下（= 撤销），新录的接在同一条里，提示一句。
//   这 10 秒里 App 没了：恢复记录还在（clearRec 还没做），下次启动 recoverPending 当成没收尾的录音放回「待整理」——宁可多留；
//   草稿的 rec 这时写的是取消的那段（见 persistNow），框里写的字和它放进同一条。
// 存好以后「放弃这段录音」丢掉这页最后存的那段：还没上传的——这页刚建、只有这一段、没写字的那条整条删掉（软删除、audio 清空、
//   标 discarded，「最近删除」里不显示），别的（接到已有的一条、还有别的录音、写了字）只从条目里拿掉这一段；撤销时间过了再删录音本身。
//   还没上传的先把恢复记录写回去（recMeta，attachTo 原来那条）：这 10 秒里 App 没了，下次启动这段回到那条（整条丢掉的回到「待整理」），和 ✕ 一样宁可多留。
//   已经上传过的：照常软删除（进「最近删除」，带着录音）/ 照常拿掉，本机的录音不删；整条丢掉时正在同步（可能正在传这段）也当成传上去了。
//   丢掉的是「再录一段」录的：回到上一段的「已保存」；不然回到开始录音前。10 秒内撤销 = 换回原来那条、回到「已保存」。
//   撤销时间过了、删录音本身之前都再查一遍：已经上传的（deleteClip 自己不删；整条丢掉的换回平常的删除，带着录音进「最近删除」）、
//   还有条目（含已删除的）在用的不删。
//   等撤销的这 10 秒拿着那段的 Web Lock（babble-rec:<recId>，和录音机录着时一样）：别的标签页这时启动，不会把它当成没收尾的找回去。
//   ✕、「放弃这段录音」都收起键盘：iPhone 的键盘会盖住底部的提示条（「撤销」就看不见了）。
// 刚存进条目的录音先别上传（ctx.sync.pause('rec-fresh')，同时只拿一个）：离开这页、切到后台 / 锁屏、最后一次存好 2 分钟后、
//   取消 / 丢掉的撤销时间过了（之后没再存过新的、也没回到「已保存」）——哪个先到就放开。「立即同步」照样能传。
// 自己管更新（返回 onChange）：同步、别的页面改数据都不会重画这一页，不打断录音和打字。
// deps（测试用）：createRecorder 换成假的录音机；setTimeout / clearTimeout 换成手动的（撤销的 10 秒、先不上传的 2 分钟、离开时最多等 70 秒存完）；
//   locks 换成假的 navigator.locks（null = 没有）。
// #/rec?bed=1 是床头模式：第一行就整个交给 views/bedside.js（外壳的近黑、没有底栏侧栏这些照样有）；空闲时提示下面放它的入口（bedLink）。
import { h, icon, download } from '../ui/dom.js';
import { stopAll } from '../ui/player.js';
import { createRecorder, REC_LOCK } from '../core/recorder.js';
import { extForMime } from '../core/audioStore.js';
import { deletedRecord, clipIndex, stamp } from '../core/store.js';
import { localParts, today, fmtTime, fmtTimer, fmtDuration, fmtEntryDate } from '../core/dates.js';
import { previewLines } from '../core/dialogue.js';
import { clipName } from '../core/clips.js';
import { REC_DRAFT, writeDraft, dropDraft, clipOf, recTimeFields } from '../core/drafts.js';
import { writeTools, insertLine, startTemplate, keepFocus, revealCaret } from '../ui/writer.js';
import { t } from '../i18n.js';
import * as bedside from './bedside.js';
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
// 取消 / 丢掉以后能撤销多久；刚存好的录音先不上传多久
export const UNDO_MS = 10000, FRESH_MS = 120000;
const dur = (r) => fmtDuration(r && r.durationSec) || '0:00';

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

export function render(main, params, ctx, deps = {}) {
  if (params.query && params.query.bed) return bedside.render(main, params, ctx);
  const makeRecorder = deps.createRecorder || createRecorder;
  const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms)), unlater = deps.clearTimeout || ((id) => clearTimeout(id));
  const locks = deps.locks !== undefined ? deps.locks : (() => { try { return (globalThis.navigator && navigator.locks) || null; } catch (e) { return null; } })();
  const lang = ctx.lang();
  const maxMin = ctx.state.settings.maxRecordMin || 10;
  const sp = () => ctx.state.settings.speakers;
  const attachId = (params.query && params.query.attach) || null;
  let target = attachId;          // 录好的、写的字放进哪一条；第一段存好以后就是刚建的那条（「再录一段」接着放进去）
  let phase = 'idle';             // idle | requesting | recording | stopping | saved | error
  // saved：这页最后存好、还在 target 里的那段（「已保存」显示它；prev 是同一条里它前面那段，丢掉它以后回到那一屏）
  let errInfo = null, saved = null, startedAt = 0, gone = false, warn = null, recId = null;
  let tick = null, cancelling = false, onFinish = null;
  let meterFill = null, timerEl = null, subEl = null, warnEl = null;
  // pend：取消 / 丢掉以后还能撤销的那一段（同时只有一个）；saveSeq：这页存进条目几次了；mine：这页存录音时新建的条目
  // from：点「开始录音」/「再录一段」时在哪个「已保存」上（取消了回到那一屏；不是从「已保存」点的 → null）
  let pend = null, saveSeq = 0, hold = null, holdTimer = null, dropping = false, from = null;
  const mine = new Set();
  const hidden = () => document.visibilityState === 'hidden';
  /** 这一段还在那条里（条目没删、录音没被拿掉）：取消 / 丢掉以后能不能回到它的「已保存」 */
  const stillThere = (r) => { const e = r && r.id ? ctx.entry(r.id) : null; return !!(e && !e.deleted && (e.audio || []).some(a => a.sha256 === r.sha256)); };
  /** 正在同步（可能正在传刚存的录音）：查不了当成在同步（「放弃这段录音」就只软删除、不删录音） */
  const syncBusy = () => { try { const s = ctx.sync.status ? ctx.sync.status() : null; return !!(s && (s.running || s.uploading)); } catch (e) { return true; } };

  const rec = makeRecorder({
    audioStore: ctx.audio, maxMs: maxMin * 60000,
    onLevel: (v) => { if (meterFill) meterFill.style.transform = `scaleX(${Math.max(0.02, v).toFixed(3)})`; },
    onState,
  });

  // ---------- 写原话 ----------
  const tpl = startTemplate(sp());                                  // 「👰🏻‍♀️ “”」，光标在引号中间
  /** 要接的那条现在的原话（没有 attach、那条不在了 → null，还没有条目） */
  const attBase = () => { const a = attachId ? ctx.entry(attachId) : null; return a && !a.deleted ? a.text || '' : null; };
  let base = attBase();                                             // 上次存进条目的原话（还没有条目 → null）
  let touched = false;                                              // 点进过文本框（光标位置才算数）
  // 第一次点进来、还是预填的「👰🏻‍♀️ “”」：光标放进引号中间（点按自己放的光标在这之后，所以晚一点）
  const firstFocus = () => {
    if (touched) return;
    touched = true;
    if (ta.value === tpl.text) setTimeout(() => { if (document.activeElement === ta && ta.value === tpl.text) ta.setSelectionRange(tpl.cursor, tpl.cursor); }, 0);
  };
  const ta = h('textarea.kai.n-ta', { value: base || tpl.text, rows: 4, placeholder: t('edit.textPh', { nn: sp().nn.name || 'NN' }), 'aria-label': t('edit.text'),
    autocapitalize: 'off', spellcheck: 'false', oninput: () => { persistSoon(); paintDone(); }, onfocus: firstFocus });
  const insert = (who, body) => { insertLine(ta, who, body, sp(), { atEnd: !touched }); touched = true; revealCaret(ta); persistSoon(); };
  const writeBox = h('div.n-wbox', null, writeTools({ speakers: sp(), onInsert: insert }), ta);
  const cleanText = () => (ta.value === tpl.text ? '' : ta.value);   // 预填的没动过 = 没写
  const dirty = () => cleanText() !== (base ?? '');
  /** 算不算写了字：空白、只有预填的「👰🏻‍♀️ “”」都不算 */
  const hasWords = (s) => { const x = String(s || '').trim(); return !!x && x !== tpl.text.trim(); };
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

  // 另存一份（只在有没存进条目的字时）。启动时 App 要先处理上次留下的那份（ctx.recovered），上一个录音页可能还在存：都好了再写。
  // rec：正在录的那段；没在录、刚取消 / 丢掉的那段还能撤销（写回了恢复记录）时写它（这时 App 没了，下次启动字和它放进同一条）
  let ready = false, owned = false, persistTimer = null;
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    if (!ready) return;
    const r = recId || (pend && pend.arm) || null;
    if (dirty()) owned = writeDraft(store(), REC_DRAFT, { v: 1, text: cleanText(), target: target || null, base, rec: r, at: Date.now() }) || owned;
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
    if (s === 'saved') { if (cancelling) onCancelled(info); else onSaved(info); return; }
    const wasCancel = cancelling;
    if (s === 'error' || s === 'idle') {
      const saveErr = s === 'error' && info && info.code === 'save';
      cancelling = false;
      // 存 clip 失败：分片留着下次启动找回，草稿里的 recId 也留着（到时候字和录音放进同一条）
      if (!saveErr) recId = null;
      persistNow();
      if (gone) { if (!saveErr) commitText(); finished(); }
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
    if (s === 'error') {
      if (wasCancel && info && info.code === 'empty') { go('idle'); return; }   // 取消的那段什么也没录到：没什么可取消的
      errInfo = info || { code: 'failed' }; go('error'); return;                 // 取消时存不进去：和平常一样给「下载」，分片留着下次找回
    }
    if (s === 'idle') { go('idle'); return; }
    if (s === 'requesting' || s === 'stopping') go(s);
  }
  function finished() { if (onFinish) { const f = onFinish; onFinish = null; f(); } }

  /**
   * 存好一段：建条目 / 接到那一条，写的字一起存进去；条目真的存进本机了才清恢复记录。
   * mode：'show' 照常（换到「已保存」；页面已经不在了就提示一句）；
   *       'quiet' 取消的那段在提示条上撤销时页面已经不在了 / 在忙 → 只存进条目、提示一句，页面不动；
   *       'kept' 取消的那段还能撤销时又点了「开始录音」→ 照常存进条目（接着录的接在后面）、提示「留下了」，页面交给 start()
   */
  function onSaved(res, mode = 'show') {
    const clip = clipOf(res);
    const txt = cleanText(), textChanged = dirty();
    const quiet = mode !== 'show';
    let ok = true, id = null;
    holdFresh();                                    // 先别上传：给「放弃这段录音」留时间（离开这页了、切到后台了就不拿）
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
        mine.add(id);
      }
    } catch (e) { ok = false; console.error(e); }
    off();
    if (ok && id) { base = txt; if (!quiet) recId = null; }
    ready = true;
    if (!(gone && quiet)) persistNow();             // 字已经在条目里了：草稿删掉（没存进去就留着，连同 recId，下次启动再找回）
    if (ok && id && res.recId) Promise.resolve(ctx.audio.clearRec(res.recId)).catch(() => {});
    target = id || target;
    if (id) saveSeq++;
    const rec = id ? { ...res, id, appended: !!(attachId && id === attachId) || (!!saved && saved.id === id), prev: saved && saved.id === id && stillThere(saved) ? saved : null } : null;
    if (mode === 'kept') { if (rec) saved = rec; ctx.toast(t('rec.cancelKept', { dur: dur(res) }), { ms: 6000 }); return; }
    if (gone || quiet) { if (!quiet) finished(); ctx.toast(t('rec.savedAway', { dur: dur(res) }), { ms: 6000 }); return; }
    saved = rec || { ...res, id, appended: false, prev: null };
    go('saved');
  }

  /** ✕ 取消的那段存好了：不进条目，回到点「开始录音」之前（从「已保存」点的就回到那一屏）；提示条上 10 秒内能撤销（= 当成点了停止） */
  function onCancelled(res) {
    cancelling = false;
    recId = null;
    const back = stillThere(from) ? from : null;
    const p = { kind: 'cancel', res, sha: res.sha256, arm: res.recId || null, back };
    // 撤销时还在回到的那一屏上（没再存过新的）→ 和点了停止一样换到「已保存」；页面不在了 / 在录别的 → 只存进条目
    wait(p, t('rec.cancelled', { dur: dur(res) }), () => onSaved(res, onScreen(p) ? 'show' : 'quiet'));
    persistNow();                                   // 草稿的 rec 换成取消的这段（见 persistNow）
    if (gone) { commitText(); finished(); return; }   // 取消完已经离开这页：写的字照常存成一条
    if (back) { saved = back; go('saved'); } else go('idle');
  }
  /** 撤销时页面还停在取消 / 丢掉以后回到的那一屏（没再存过新的、没在录） */
  const onScreen = (p) => !gone && saveSeq === p.seq && (phase === 'idle' || phase === 'error' || (phase === 'saved' && !!p.back && saved === p.back));

  // ---------- 取消 / 丢掉以后：等撤销，时间过了才删录音 ----------
  /** 开始等撤销（提示条带「撤销」）。上一个还在等的马上收尾：它的提示条被换掉了，撤销不了了 */
  function wait(p, msg, undo) {
    if (pend) settle(pend);
    p.seq = saveSeq;
    pend = p;
    lockRec(p);
    p.timer = later(() => settle(p), UNDO_MS);
    ctx.toast(msg, { ms: UNDO_MS, action: { label: t('common.undo'), run: () => { if (!take(p)) return; try { undo(); } finally { unlock(p); } } } });
  }
  const take = (p) => { if (pend !== p) return false; unlater(p.timer); pend = null; return true; };
  /** 等撤销时拿着这段的 Web Lock：别的标签页这时启动（recoverPending）不会把写着的恢复记录当成没收尾的录音找回去；App 没了锁自己就放了 */
  function lockRec(p) {
    if (!p.arm || !locks || !locks.request) return;
    try {
      const held = new Promise((res) => { p.unlock = res; });
      Promise.resolve(locks.request(REC_LOCK + p.arm, () => held)).catch(() => {});
    } catch (e) { p.unlock = null; }
  }
  const unlock = (p) => { if (p.unlock) { const f = p.unlock; p.unlock = null; f(); } };
  /** 撤销的时间过了：删录音本身、清恢复记录；那以后没再存过新的录音、也没回到别的「已保存」→ 不用再等「放弃这段录音」，放开同步 */
  function settle(p) {
    if (!take(p)) return;
    if (!gone) persistNow();                        // 草稿不再指着这段（离开了就不碰：新的录音页可能在写）
    purge(p).finally(() => unlock(p));              // 恢复记录清掉以后才放锁
    if (saveSeq === p.seq && (gone || phase !== 'saved')) releaseHold();
  }
  /**
   * 删掉一段录音：还有条目（含已删除的）在用的不删；已经上传的不删（deleteClip 自己也不删）——
   * 整条丢掉的这时候发现传上去了（丢掉时正在传）：换回平常的删除（带着录音，进「最近删除」），仓库里的录音有条目指着。恢复记录照样清掉
   */
  async function purge(p) {
    try {
      if (p.sha && ctx.audio.deleteClip) {
        const c = await ctx.audio.getClip(p.sha);
        if (c && c.uploaded) { if (p.kind === 'drop' && p.whole) unhide(p); }
        else if (c && !clipIndex(ctx.state, { includeDeleted: true }).has(p.sha)) await ctx.audio.deleteClip(p.sha);
      }
    } catch (e) { console.warn('rec deleteClip', e); }
    if (p.arm) await Promise.resolve(ctx.audio.clearRec(p.arm)).catch(() => {});
  }
  /** 整条丢掉的（discarded、audio 清空）换回平常的删除：带着原来的录音，「最近删除」里看得见、能恢复 */
  function unhide(p) {
    ctx.mutate(st => {
      const cur = st.data.entries[p.prev.id];
      if (!cur || !cur.deleted || !cur.discarded) return;
      const { discarded, ...r } = cur;
      st.data.entries[cur.id] = stamp({ ...r, audio: p.prev.audio }, cur);
    });
  }

  // ---------- 刚存进条目的录音先别上传：同时只拿一个；离开这页、切到后台、最后一次存好 2 分钟后、撤销时间过了就放开 ----------
  function holdFresh() {
    if (gone || hidden()) return;
    if (!hold) { try { hold = ctx.sync.pause('rec-fresh'); } catch (e) { hold = null; console.warn(e); } }
    unlater(holdTimer);
    holdTimer = later(releaseHold, FRESH_MS);
  }
  function releaseHold() {
    unlater(holdTimer); holdTimer = null;
    if (!hold) return;
    const resume = hold;
    hold = null;
    try { resume(); } catch (e) { console.warn(e); }
  }

  /**
   * 「放弃这段录音」：丢掉这页最后存的那段（规则见开头）。
   * 「上传过没有」要问 audioStore（查不到当成上传过：只软删除，本机的录音不动）；还没上传的先写回恢复记录（写不进去也当成上传过）；
   * 问的时候页面换了就算了
   */
  async function dropLast() {
    const s = saved;
    if (phase !== 'saved' || !s || !s.id || dropping) return;
    if (document.activeElement === ta) ta.blur();   // 收起键盘：提示条上的「撤销」才看得见
    dropping = true;
    let up = true, arm = null;
    try { const c = await ctx.audio.getClip(s.sha256); up = !!(c && c.uploaded); } catch (e) { /* 当成上传过 */ }
    if (!up && s.recId) {
      try {
        await ctx.audio.putRecMeta({ recId: s.recId, startedAt: s.startedAt ?? null, mime: s.mime || 'audio/mp4', tz: s.tz || null, attachTo: s.id,
          done: true, sha256: s.sha256, bytes: s.bytes ?? null, durationSec: s.durationSec ?? null });
        arm = s.recId;
      } catch (e) { up = true; console.warn('rec drop recMeta', e); }
    }
    dropping = false;
    const e = ctx.entry(s.id), sha = s.sha256;
    if (gone || phase !== 'saved' || saved !== s || !e || e.deleted || !(e.audio || []).some(a => a.sha256 === sha)) {
      if (arm) Promise.resolve(ctx.audio.clearRec(arm)).catch(() => {});
      return;
    }
    const words = [e.text, e.note, e.draft && e.draft.text, cleanText()].some(hasWords);
    const whole = mine.has(e.id) && !words && e.audio.length === 1 && e.audio[0].sha256 === sha;
    // 整条丢掉、正在同步（可能正在传这段）：当成传上去了——照常进「最近删除」、带着录音（恢复记录不要了）。
    // 只拿掉一段的不用：撤销时间过了再看传上去没有（传上去了就不删本机的）
    if (whole && !up && syncBusy()) {
      up = true;
      if (arm) Promise.resolve(ctx.audio.clearRec(arm)).catch(() => {});
      arm = null;
    }
    const back = whole ? null : (stillThere(s.prev) && s.prev.sha256 !== sha ? s.prev : null);
    const p = { kind: 'drop', prev: e, whole, clip: sha, sha: up ? null : sha, arm, target, base, saved: s, back };
    let msg;
    if (whole) {
      const del = deletedRecord(e);
      ctx.mutate(st => { st.data.entries[e.id] = up ? del : { ...del, audio: [], discarded: true }; });
      msg = up ? t('rec.droppedDeleted') : t('rec.dropped', { dur: dur(s) });
      target = attachId; base = attBase();          // 下一段新建一条（或接到 attach 那条），和刚打开这页一样
    } else {
      ctx.update(e.id, { audio: e.audio.filter(a => a.sha256 !== sha) });
      msg = words ? t('rec.droppedText') : t('rec.dropped', { dur: dur(s) });
    }
    saved = back;
    persistNow();
    wait(p, msg, () => undoDrop(p));
    go(back ? 'saved' : 'idle');
  }
  /** 撤销「放弃这段录音」：整条删掉的换回原来那条；只拿掉一段的把它放回原来的位置（这期间写进去的字、新录的不动）。
   *  页面还停在丢掉以后那一屏 → 回到「已保存」；不然（在录下一段、离开了）只换回数据、提示一句 */
  function undoDrop(p) {
    const cur = ctx.entry(p.prev.id);
    if (p.whole || !cur) ctx.put(p.prev);
    else {
      const a = p.prev.audio.find(x => x.sha256 === p.clip), list = [...cur.audio];
      if (a && !list.some(x => x.sha256 === p.clip)) { list.splice(Math.min(p.prev.audio.indexOf(a), list.length), 0, a); ctx.update(cur.id, { audio: list }); }
    }
    if (p.arm) Promise.resolve(ctx.audio.clearRec(p.arm)).catch(() => {});   // 录音又在条目里了：恢复记录不要了
    if (!onScreen(p)) { ctx.toast(t('common.undone')); return; }
    target = p.target; base = p.base; saved = p.saved;
    persistNow();
    go('saved');
  }

  // ---------- 操作 ----------
  async function start() {
    if (phase === 'requesting' || phase === 'recording' || phase === 'stopping') return;
    stopAll();                                      // 正在放的录音先停
    errInfo = null; warn = null;
    // 刚取消的那段还能撤销时又点了开始：多半是 ✕ 点错了（她还在说）——那段照常留下（= 撤销），这段接在同一条里。
    // 不这样的话那段会在录这段的时候到时间删掉，提示条也顾不上看
    let kept = false;
    if (pend && pend.kind === 'cancel') {
      const c = pend;
      take(c);
      try { onSaved(c.res, 'kept'); kept = true; } catch (e) { console.error(e); } finally { unlock(c); }
    }
    from = phase === 'saved' || kept ? saved : null;
    const p = rec.start(target ? { attachTo: target } : {});              // 必须在点按里调用（iOS 的麦克风、常亮都要手势）
    if (writeOn()) focusWrite();                    // 键盘也要在点按里叫出来
    try { await p; }
    catch (e) { errInfo = { code: 'failed', message: (e && e.message) || String(e) }; go('error'); }
  }
  const stop = (reason = 'user') => {
    if (rec.state === 'recording' || rec.state === 'requesting') rec.stop({ reason }).catch(e => console.error(e));   // 还在等权限：stop 就是取消
  };
  /** ✕：取消这段。录音机照常停下、存好（见 onCancelled），只是不进条目 */
  function cancelRec() {
    if (rec.state !== 'recording') return;
    cancelling = true;
    if (document.activeElement === ta) ta.blur();   // 收起键盘：iPhone 上键盘会盖住底部的提示条（「撤销」）；写的字照样在框里
    rec.stop({ reason: 'user' }).then(() => { cancelling = false; }, (e) => { cancelling = false; console.error(e); });
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

  // 切到后台 / 关掉页面：写的字马上另存，录到的先存好（iOS 在后台本来也录不了）。
  // 刚存好的也不再等「放弃这段录音」：锁屏睡觉去了，照常上传（JS 在后台不跑，等 2 分钟就成了等到明天打开）
  const onVis = () => { if (hidden()) { persistNow(); stop('hidden'); releaseHold(); } };
  const onHide = () => { persistNow(); stop('pagehide'); releaseHold(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);

  // ---------- 画面 ----------
  function go(p) {
    phase = p;
    if (!gone) draw();
  }
  function draw() {
    clearInterval(tick); tick = null;
    meterFill = timerEl = subEl = warnEl = null;
    root.dataset.phase = phase;
    const writing = writeOn();
    root.classList.toggle('n-write', writing);
    writeBox.hidden = !writing;
    foot.hidden = !writing;
    if (writing) { fill(top, ...writeTop()); fill(foot, ...writeFoot()); paintDone(); fit(); }
    else if (phase === 'recording' || phase === 'stopping') fill(top, ...recordingView());
    else if (phase === 'saved') fill(top, ...savedView());
    else if (phase === 'error') fill(top, ...errorView());
    else fill(top, ...idleView());
    live.textContent = phase === 'recording' ? t('rec.recording') : phase === 'saved' ? t('rec.saved') : phase === 'stopping' ? savingText() : '';
    if (writing && document.activeElement === ta) return;          // 正在写：焦点留在文本框（键盘不收起）
    const focus = root.querySelector('[data-autofocus]');
    if (focus) focus.focus({ preventScroll: true });
  }

  /** 「录好接到：…」。idle：开始录音前，录好要接到的那条（attach 那条，或者取消 / 丢掉以后还接着的这页那条）；录着的时候只说 attach 那条 */
  function attachLine(idle = false) {
    const id = idle ? target || attachId : attachId;
    if (!id) return null;
    const e = ctx.entry(id);
    if (!e || e.deleted) return id === attachId ? h('p.n-attach', null, t('rec.attachGone')) : null;
    return h('p.n-attach', null, t('rec.attachTo'), lang === 'en' ? ' ' : '', h('span.n-attach-what', null, entryLabel(e, sp(), lang)));
  }
  const startBtn = (waiting) => h('button.n-start', { type: 'button', disabled: waiting, 'aria-busy': waiting ? 'true' : null, onmousedown: keepFocus, onclick: start, dataset: { autofocus: '1' } },
    h('span.n-snout', { 'aria-hidden': 'true' }, h('i'), h('i')),
    h('b', null, waiting ? t('rec.requesting') : t('rec.start')));
  const backLink = () => h('button.n-link', { type: 'button', onclick: () => ctx.back(backTo()) }, icon('back'), t('common.back'));
  // 床头模式的入口（推入 #/rec?bed=1，「返回」回到这里）：接到某一条时、正在等麦克风权限时不放
  const bedEntry = (waiting) => (attachId || waiting ? null : bedside.bedLink(ctx));
  const textOnlyLink = () => h('button.n-link', { type: 'button', onclick: textOnly }, icon('pencil'), t('rec.textOnly'));
  /** ✕ 取消这段：点一下就取消（提示条上能撤销）；只录音时旁边写「取消」，边录边写只有 ✕ */
  const cancelBtn = (stopping, withLabel) => h('button.n-discard', { type: 'button', hidden: stopping, 'aria-label': t('rec.cancelAria'), title: t('rec.cancelAria'),
    onmousedown: keepFocus, onclick: cancelRec }, h('i', null, icon('x')), withLabel ? h('span', null, t('common.cancel')) : null);
  const savingText = () => t(cancelling ? 'rec.cancelling' : 'rec.saving');
  /** 「放弃这段录音」：放在已保存那几个按钮的最后，不是主按钮 */
  const dropBtn = () => h('button.n-link.n-drop', { type: 'button', onmousedown: keepFocus, onclick: dropLast }, icon('trash'), t('rec.drop'));
  // 「整理好了」只在写了字以后出现（一条还没有字的不算整理完）；边录边写时一边写一边看，只在有没有字变了的时候换
  const wrote = (e) => !!e && [e.text, e.note, e.draft && e.draft.text, cleanText()].some(hasWords);
  let doneSlot = null, doneShown = false;
  const doneBtn = () => h('button.n-btn', { type: 'button', onclick: markDone }, icon('check'), t('entry.done'));
  function paintDone() {
    if (!doneSlot || phase !== 'saved') return;
    const e = saved && saved.id ? ctx.entry(saved.id) : null, show = !!e && e.status === 'inbox' && wrote(e);
    if (show !== doneShown) { doneShown = show; doneSlot.replaceChildren(...(show ? [doneBtn()] : [])); }
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
      h('div.n-center', null, attachLine(true), startBtn(waiting), h('p.n-hint', null, t('rec.hint', { n: maxMin })), bedEntry(waiting)),
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
      h('b', null, stopping ? savingText() : t('rec.stop')),
      stopping ? null : h('small', null, t('rec.stopHint')));
    return [
      h('div.n-top', null, cancelBtn(stopping, true),
        h('button.n-link.n-wtoggle', { type: 'button', onclick: () => setWrite(true) }, icon('bubble'), t('rec.writeToo'))),
      h('div.n-head', null,
        h('p.n-status', null, h('i', { 'aria-hidden': 'true' }), stopping ? savingText() : t('rec.recording')),
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
        h('p.n-big', null, dur(saved)),
        h('p.n-sub', null, where),
        why ? h('p.n-why', null, t(why, { n: maxMin })) : null,
        h('div.n-acts', null,
          e ? h('button.n-btn.main', { type: 'button', onclick: toEditor, dataset: { autofocus: '1' } }, icon('pencil'), t('rec.write')) : null,
          h('button.n-btn', { type: 'button', onclick: start }, icon('mic'), t('rec.again')),
          h('button.n-btn', { type: 'button', onclick: finish }, t('rec.later'))),
        e ? h('nav.n-links', null, dropBtn()) : null),
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
          cancelBtn(stopping, false),
          h('div.n-bar-mid', null,
            h('p.n-bar-time', null, h('i.n-dot', { 'aria-hidden': 'true' }), timerEl),
            h('div.n-meter', { 'aria-hidden': 'true' }, meterFill)),
          h('button.n-stopbar', { type: 'button', disabled: stopping, onmousedown: keepFocus, onclick: () => stop('user'), dataset: { autofocus: '1' } },
            h('span.n-stop-ic', { 'aria-hidden': 'true' }), h('b', null, stopping ? savingText() : t('rec.stopShort')))),
        h('div.n-bar-sub', null, subEl, warnEl, attachLine()),
      ];
    }
    if (phase === 'saved') {
      const { e, why, where } = savedInfo();
      return [
        h('div.n-bar.n-bar-saved', { 'data-toast-avoid': '' },
          h('div.n-bar-mid', null,
            h('p.n-status.ok', null, icon('check'), t('rec.saved'), ' ', h('span.n-dur', null, dur(saved))),
            h('p.n-sub', null, where),
            why ? h('p.n-why', null, t(why, { n: maxMin })) : null)),
        h('div.n-acts.n-acts-row', null,
          h('button.n-btn.main', { type: 'button', onmousedown: keepFocus, onclick: start, dataset: { autofocus: '1' } }, icon('mic'), t('rec.again')),
          (doneSlot = h('span.n-done-slot'), doneShown = false, doneSlot),
          h('button.n-btn', { type: 'button', onclick: finish }, t('rec.later'))),
      ];
    }
    if (phase === 'error') {
      const { title, msg, acts } = errorParts();
      acts.classList.add('n-acts-row');
      return [h('div.n-errbox', null, title, msg, acts)];
    }
    return [h('div.n-hero', null, attachLine(true), startBtn(phase === 'requesting'), h('p.n-hint', null, t('rec.hint', { n: maxMin })), bedEntry(phase === 'requesting'))];
  }
  function writeFoot() {
    const only = h('button.n-link', { type: 'button', onclick: () => setWrite(false) }, icon('mic'), t('rec.recOnly'));
    if (phase === 'recording' || phase === 'stopping') return [only];
    if (phase === 'saved') {
      const has = !!(saved && saved.id && ctx.entry(saved.id));
      return [has ? h('button.n-link', { type: 'button', onclick: toEditor }, icon('pencil'), t('rec.toEditor')) : null, only, has ? dropBtn() : null];
    }
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
      releaseHold();                                // 刚存好的不用再等「放弃这段录音」了（还在等撤销的那段照样到时间再删）
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
      window.removeEventListener('resize', fit);
      // 离开这页：录着的照样存好建条目，写的字一起存进去（onSaved 会提示一句）；还在等权限的直接取消。没在录：写的字现在就存
      if (rec.state === 'recording' || rec.state === 'stopping' || rec.state === 'requesting') {
        finishing = new Promise(res => { onFinish = res; later(res, 70000); });
        stop('leave');
      } else {
        persistNow();
        // 还在等撤销（✕ 取消 / 放弃这段录音）：字照样存，但不弹 App 的「撤销」——它会换掉提示条上那个能撤销录音的
        if (dirty()) commitText(!target && !pend ? { undoLabel: t('rec.textSaved') } : undefined);
      }
    },
  };
}
