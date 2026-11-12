// 记一条 / 编辑（#/new、#/edit/<id>）：日期、时间、录音、原话（楷体，工具栏插入说话人和反应）、草稿、那天的背景。
// 条目没有标题：旧数据里存着的 title 这里不显示、不改（保存时不带这个字段，原样留着，不会多出同步和修改记录）。
// 原话照原样保存（新建时预填的「👰🏻‍♀️ “”」没动过就当没写）。改了没保存，离开前会问（ctx.guard）。
// 自己管更新（返回 onChange）：别的设备改了这条——没动过就换成新的，动过就保留你写的并提示一句。
// 没保存的修改随手另存在 localStorage（babble.edit.<id|new>）：iOS 在后台把 App 杀掉（切去语音备忘录抄转写时常见）也不丢，
// 下次打开同一个编辑页时恢复（app 冷启动时也会直接回到这里）；保存、取消、确认离开时删掉。
// 工具栏的「🎙 录一段」：不离开编辑页就录（同录音页的录音机：每秒存一片、常亮、切到后台就存好），边录边接着写。
// 录好：已有的条目马上接上（不保存也不丢）；新的一条先放进工作副本（随草稿另存），保存时一起存，没保存就离开 → 单独存成一条待整理。
import { h, icon } from '../ui/dom.js';
import { audioPlayer, stopAll } from '../ui/player.js';
import { canon } from '../core/store.js';
import { today, nowTime, isISODate, isTime, localParts, systemTz, fmtEntryDate, fmtTimer, fmtDuration } from '../core/dates.js';
import { createRecorder } from '../core/recorder.js';
import { EDIT_PREFIX, readDraft, clipOf, recTimeFields } from '../core/drafts.js';
import { REACTIONS, replaceText, writeTools, insertLine, startTemplate, keepFocus } from '../ui/writer.js';
import { AUDIO_ACCEPT, readClipFiles, clipCaption, renameClipSheet } from './entry.js';
import { renameClip } from '../core/clips.js';
import { saveFile } from './record.js';
import { t } from '../i18n.js';
export { REACTIONS, replaceText, EDIT_PREFIX };

/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');

const enc = encodeURIComponent;
// 条目里编辑页管的字段（判断别的设备是不是改了这些）
const EDITABLE = ['date', 'time', 'text', 'note', 'draft', 'audio', 'timeSource', 'recordedAt', 'tz', 'deleted'];
const pickEditable = e => Object.fromEntries(EDITABLE.map(k => [k, e[k] ?? null]));
const store = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };
/** 条目 → 编辑页的工作副本（没有标题：旧数据里存着的 title 不进来）。template：预填的「👰🏻‍♀️ “”」（原话空着时用它） */
export function workingCopy(e, template) {
  return {
    date: e.date, time: e.time || '', text: e.text ? e.text : template.text, note: e.note || '',
    draftText: e.draft ? e.draft.text : '', draftSrc: e.draft ? e.draft.source : '',
    audio: (e.audio || []).map(a => ({ ...a })), timeSource: e.timeSource || null, recordedAt: e.recordedAt || null, tz: e.tz || null,
  };
}

/**
 * 工作副本 → 保存时写进条目的字段。没有 title：已有条目存着的标题原样留着（ctx.update 只改给的字段），新的一条是 ''。
 * @param {{ template: {text: string}, prev?: object|null, audio: Array, keepDraft?: boolean }} o
 *   prev：条目现在的样子（新的一条 null）；audio：保存后的录音列表；keepDraft：草稿这里没动过 → 用条目现在的
 *   （「转成文字」可能在后台刚做完，别拿打开时的旧草稿盖掉）
 */
export function savedFields(w, { template, prev = null, audio, keepDraft = false }) {
  return {
    date: w.date, time: isTime(w.time) ? w.time : null,
    text: w.text === template.text ? '' : w.text,
    note: w.note,
    draft: prev && keepDraft ? prev.draft || null
      : w.draftText.trim() ? { ...((prev && prev.draft) || {}), text: w.draftText, source: w.draftSrc || 'paste' } : null,
    audio, timeSource: w.timeSource, recordedAt: w.recordedAt, tz: w.tz,
  };
}

/** 条目的可编辑字段：b 和 a 比只是录音列表最后多了几段 → 多的那几段；别的也变了 → null */
export function addedAudio(a, b) {
  if (!a || !b || canon({ ...a, audio: null }) !== canon({ ...b, audio: null })) return null;
  const A = a.audio || [], B = b.audio || [];
  if (B.length <= A.length || A.some((x, i) => canon(x) !== canon(B[i]))) return null;
  return B.slice(A.length);
}

export function render(main, params, ctx) {
  const isNew = params.sub === 'new';
  const id = isNew ? null : params.id;
  const sp = () => ctx.state.settings.speakers;
  const nn = () => sp().nn.name || 'NN';
  const backTo = isNew ? '/' : '/e/' + enc(id);
  const src = isNew ? null : ctx.entry(id);

  if (!isNew && !src) {
    try { const st = store(); if (st) st.removeItem(EDIT_PREFIX + id); } catch (e) { /* 没有就算了 */ }   // 条目不在了：另存的修改也用不上
    main.append(h('header.navbar', null, h('button.back', { type: 'button', onclick: () => ctx.back('/') }, icon('back'), t('nav.list')), h('span'), h('span')),
      h('div.page', null, h('p.empty', null, t('common.notFound'))));
    return;
  }

  // ---------- 工作副本 ----------
  const template = startTemplate(sp());                          // 「👰🏻‍♀️ “”」，光标在引号中间
  const fromEntry = (e) => workingCopy(e, template);
  const qDate = isNew && params.query && isISODate(params.query.date) ? params.query.date : null;   // 日历里某一天的「记一条」
  let w = fromEntry(src || { date: qDate || today() });
  let base = canon(w), baseEntry = src ? canon(pickEditable(src)) : null;
  let saved = false, players = [], suggest = null, touchedText = false, gone = false, recId = null;
  // 这次编辑里加的、移除的、改了名的录音（sha256）：保存时在条目「现在」的录音上加减、改名，别的设备刚接上的录音不会被旧的列表盖掉
  const addedSha = new Set(), removedSha = new Set(), renamedSha = new Set();
  // 新的一条里在这里录的（sha256 → { startedAt, tz }）：没保存就离开时单独存成一条待整理，不丢（随草稿另存，恢复后也记得）
  const inlineSha = new Map();
  const isDirty = () => !saved && canon(w) !== base;
  ctx.guard(isDirty);

  // ---------- 没保存的修改另存一份 ----------
  const draftKey = EDIT_PREFIX + (isNew ? 'new' : id);
  let persistTimer = null;
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    const st = store();
    if (!st || gone) return false;
    try {
      // rec：正在录的那段（App 被杀时，启动时把找回的录音和这份草稿放在一起，见 core/drafts.js）
      if (isDirty()) {
        st.setItem(draftKey, JSON.stringify({ w, added: [...addedSha], removed: [...removedSha], renamed: [...renamedSha], at: Date.now(), ...(recId ? { rec: recId } : {}), ...(inlineSha.size ? { inline: Object.fromEntries(inlineSha) } : {}) }));
        return true;
      }
      st.removeItem(draftKey);
    } catch (e) { /* 存不下就算了：页面还开着时内容在内存里 */ }
    return false;
  }
  const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 400); };
  const dropDraft = () => { clearTimeout(persistTimer); persistTimer = null; try { const st = store(); if (st) st.removeItem(draftKey); } catch (e) { /* 同上 */ } };
  let restoredAt = null;
  /** 用另存的那份；和条目一样（没有修改）就删掉。草稿之后条目里多出来的录音（别的设备接上的、启动时找回接上的）也列进来 */
  function applyDraft(d) {
    if (!d || !d.w || typeof d.w !== 'object') { if (d) dropDraft(); return false; }
    const cur = isNew ? null : ctx.entry(id) || src;
    const removed = new Set(Array.isArray(d.removed) ? d.removed : []);
    let audio = Array.isArray(d.w.audio) ? d.w.audio : w.audio;
    if (cur) audio = [...audio, ...(cur.audio || []).filter(a => !audio.some(x => x.sha256 === a.sha256) && !removed.has(a.sha256)).map(a => ({ ...a }))];
    const dw = { ...d.w };
    delete dw.title;                              // 旧版本另存的草稿里可能有标题：不要了
    const next = { ...w, ...dw, audio };
    if (canon(next) === base) { dropDraft(); return false; }
    w = next;
    for (const x of d.added || []) addedSha.add(x);
    for (const x of removed) removedSha.add(x);
    for (const x of Array.isArray(d.renamed) ? d.renamed : []) renamedSha.add(x);
    if (d.inline && typeof d.inline === 'object') for (const [k, v] of Object.entries(d.inline)) if (w.audio.some(a => a.sha256 === k)) inlineSha.set(k, v || {});
    restoredAt = Number(d.at) || null;
    return true;
  }
  const stored = readDraft(store(), draftKey);
  // 另存时正在录音（rec）：上次 App 是录到一半被关掉的。启动时 App 先把找回的录音放好（「记一条」的会连同这份草稿存成一条），之后再看
  const waitRecovery = !!(stored && stored.rec);
  if (!waitRecovery) applyDraft(stored);

  // ---------- 控件 ----------
  const dateInput = h('input.ed-date#ed-date', { type: 'date', required: true, value: w.date, dataset: { fid: 'ed-date' },
    oninput: () => { w.date = dateInput.value; manualTime(); dateErr.hidden = true; } });
  const timeInput = h('input.ed-time#ed-time', { type: 'time', value: w.time, dataset: { fid: 'ed-time' },
    oninput: () => { w.time = timeInput.value; manualTime(); } });
  const dateErr = h('p.f-help.err', { hidden: true, role: 'alert' }, t('edit.badDate'));
  const timeHelp = h('p.f-help.ed-tsrc');
  const suggestEl = h('div.ed-suggest', { hidden: true });
  const ta = h('textarea.kai.ed-text#ed-text', { value: w.text, rows: 6, placeholder: t('edit.textPh', { nn: nn() }), dataset: { fid: 'ed-text' },
    autocapitalize: 'off', spellcheck: 'false', oninput: () => onText(), onfocus: () => { touchedText = true; } });
  const noteTa = h('textarea.ed-note#ed-note', { value: w.note, rows: 2, placeholder: t('edit.notePh'), dataset: { fid: 'ed-note' }, oninput: () => { w.note = noteTa.value; grow(noteTa, 56); persistSoon(); } });
  const draftTa = h('textarea.ed-draft', { value: w.draftText, rows: 3, placeholder: t('edit.draftPh'), dataset: { fid: 'ed-draft' },
    oninput: () => { w.draftText = draftTa.value; if (!w.draftSrc && w.draftText.trim()) w.draftSrc = 'paste'; grow(draftTa, 80); persistSoon(); } });
  const audioBox = h('div.ed-audio');
  const banner = h('p.ed-banner', { hidden: !(src && src.deleted), role: 'status' }, src && src.deleted ? t('edit.remoteDeleted') : null);
  const restoredMsg = () => t('edit.restored', { time: restoredAt ? fmtEntryDate({ ...localParts(restoredAt), timeSource: null }, ctx.lang(), { sep: daySep(ctx.lang()) }) : '' });
  const restoredEl = h('div.ed-banner.ed-restored', { hidden: !restoredAt, role: 'status' },
    h('span', null, restoredMsg()),
    h('button.link-btn', { type: 'button', onclick: () => {
      // 在这里录的、还没存进条目的录音不跟着放弃：留在工作副本里（保存时一起存；不保存就离开 → 单独存成一条待整理）
      const keep = w.audio.filter(a => inlineSha.has(a.sha256));
      resetTo(isNew ? { date: qDate || today() } : (ctx.entry(id) || src)); dropDraft();
      for (const a of keep) if (!w.audio.some(x => x.sha256 === a.sha256)) { w.audio.push(a); addedSha.add(a.sha256); }
      restoredEl.hidden = true; build();
    } }, t('edit.restoredDiscard')));
  const fileInput = h('input', { type: 'file', accept: AUDIO_ACCEPT, multiple: true, hidden: true,
    onchange: (ev) => { const fl = [...ev.target.files]; ev.target.value = ''; if (fl.length) addFiles(fl); } });

  // 点工具栏不把焦点从原话框抢走（手机上键盘不收起）。录音的按钮、录音条是同一个元素，重画工具栏时搬过去
  const recBtn = h('button.spk-btn.ed-rec', { type: 'button', onmousedown: keepFocus, onclick: () => startRec(), 'aria-label': t('rec.inlineAria'), title: t('rec.inlineAria') },
    icon('mic'), h('span', null, t('rec.inline')));
  const recStrip = h('div.ed-recstrip', { hidden: true, 'data-toast-avoid': '' });
  const tools = () => {
    const el = writeTools({ speakers: sp(), onInsert: (who, body) => insertAt(who, body), extra: recBtn });
    el.prepend(recStrip);
    return el;
  };
  let toolsEl = tools();

  // ---------- 原话 ----------
  function onText() {
    w.text = ta.value;
    grow(ta, 168);
    persistSoon();
  }
  function insertAt(who, body) {
    insertLine(ta, who, body, sp(), { atEnd: !touchedText });
    touchedText = true;
    onText();
  }
  function grow(el, min) {
    const sc = ctx.layout() === 'phone' ? document.scrollingElement : main;
    const top = sc ? sc.scrollTop : 0;
    el.style.height = 'auto';
    el.style.height = Math.max(min, el.scrollHeight + 2) + 'px';
    if (sc) sc.scrollTop = top;
  }

  // ---------- 日期、时间 ----------
  function manualTime() {
    w.timeSource = 'manual'; w.recordedAt = null;
    if (w.time && !w.tz) w.tz = systemTz();
    paintTime();
  }
  function paintTime() {
    persistSoon();
    timeHelp.textContent = w.timeSource ? t('entry.src.' + w.timeSource) : t('edit.dateHelp');
    clearTime.hidden = !w.time;
    if (suggest && suggest.date === w.date && suggest.time === w.time) suggest = null;
    suggestEl.hidden = !suggest;
    if (suggest) {
      suggestEl.replaceChildren(icon('clock'), h('span', null, t('edit.mp4Time', { time: fmtEntryDate(suggest, ctx.lang(), { sep: daySep(ctx.lang()) }) })),
        h('button.btn.small.soft', { type: 'button', onclick: useSuggest }, t('edit.useMp4Time')));
    }
  }
  function useSuggest() {
    if (!suggest) return;
    Object.assign(w, { date: suggest.date, time: suggest.time, timeSource: 'mp4', recordedAt: suggest.iso, tz: suggest.tz });
    dateInput.value = w.date; timeInput.value = w.time;
    suggest = null; dateErr.hidden = true;
    paintTime();
  }
  const nowBtn = h('button.link-btn', { type: 'button', onclick: () => { w.date = today(); w.time = nowTime(); dateInput.value = w.date; timeInput.value = w.time; manualTime(); } }, t('edit.now'));
  const clearTime = h('button.link-btn', { type: 'button', onclick: () => { w.time = ''; timeInput.value = ''; manualTime(); } }, t('edit.clearTime'));

  // ---------- 录音 ----------
  function drawAudio() {
    persistSoon();
    for (const p of players) p.destroy();
    players = [];
    audioBox.replaceChildren(
      ...w.audio.map((c, i) => {
        const p = audioPlayer({ getBlob: () => ctx.clipBlob(c.sha256), durationSec: c.durationSec, key: c.sha256 });
        players.push(p);
        return h('div.ed-clip', null, p,
          h('div.ed-clip-foot', null, clipCaption(c, i, () => renameSheet(c, i)),
            h('button.link-btn.danger', { type: 'button', onclick: () => removeClip(c) }, t('edit.removeClip'))));
      }),
      h('button.btn.small.ed-add', { type: 'button', onclick: () => fileInput.click() }, icon('plus'), t('edit.addAudio')));
  }
  // 改名先改在工作副本里，跟着「保存」一起存（取消就不改）
  function renameSheet(c, i) {
    renameClipSheet(ctx, c, i, (name) => {
      const next = renameClip(w.audio, c.sha256, name);
      if (next === w.audio) return;
      w.audio = next;
      renamedSha.add(c.sha256);
      drawAudio();
    });
  }
  async function removeClip(c) {
    if (!(await ctx.confirm({ message: t('edit.removeConfirm'), confirmLabel: t('edit.removeClip'), danger: true }))) return;
    w.audio = w.audio.filter(a => a.sha256 !== c.sha256);
    if (addedSha.has(c.sha256)) addedSha.delete(c.sha256); else removedSha.add(c.sha256);
    drawAudio();
  }
  async function addFiles(fl) {
    const got = await readClipFiles(fl, ctx);
    const have = new Set(w.audio.map(a => a.sha256)), notes = [];
    for (const g of got) {
      if (have.has(g.clip.sha256)) { notes.push(t('entry.audioDup', { name: g.clip.origName })); continue; }
      have.add(g.clip.sha256);
      w.audio.push(g.clip);
      if (removedSha.has(g.clip.sha256)) removedSha.delete(g.clip.sha256); else addedSha.add(g.clip.sha256);
      // 录音文件里有时间：和现在填的不一样就提示，点了才用
      if (g.createdAt && !suggest) {
        const tz = systemTz(), p = localParts(g.createdAt, tz || undefined);
        if (p && (p.date !== w.date || p.time !== w.time)) suggest = { ...p, iso: g.createdAt.toISOString(), tz };
      }
    }
    if (notes.length) ctx.toast(notes.join('\n'));
    drawAudio(); paintTime();
  }

  // ---------- 录一段（不离开编辑页） ----------
  // 录到的：已有的条目马上接上（同时列进工作副本、不算没保存的修改）；新的一条放进工作副本（added），草稿另存好了才清恢复记录。
  let recr = null, recState = 'idle', recErr = null, recTick = null, recMeter = null, recTimer = null, recWaiters = [], awayId = null;   // awayId：离开时新建的那条待整理，之后录完的那段也接到这条
  const recBusy = () => !!recr && (recr.state === 'requesting' || recr.state === 'recording' || recr.state === 'stopping');
  function recorder() {
    if (!recr) {
      recr = createRecorder({ audioStore: ctx.audio, maxMs: (ctx.state.settings.maxRecordMin || 10) * 60000, onState: onRec,
        onLevel: (v) => { if (recMeter) recMeter.style.transform = `scaleX(${Math.max(0.02, v).toFixed(3)})`; } });
    }
    return recr;
  }
  function startRec() {
    if (recBusy()) return;
    stopAll();
    recErr = null;
    // 要在点按里调用（iOS 的麦克风、常亮都要手势）；焦点留在原话框，接着写
    recorder().start(isNew ? {} : { attachTo: id }).catch(e => { recErr = { code: 'failed', message: (e && e.message) || String(e) }; paintRec(); });
  }
  /** 停下并等它存好（保存前用） */
  function stopRec(reason = 'user') {
    if (!recBusy()) return Promise.resolve();
    return new Promise((res) => { recWaiters.push(res); recr.stop({ reason }).catch(() => res()); });
  }
  function onRec(s, info) {
    recState = s;
    if (s === 'recording' && info && info.recId && recId !== info.recId) { recId = info.recId; persistNow(); }
    if (s === 'saved') onClip(info);
    else if (s === 'error') {
      if (!(info && info.code === 'save')) recId = null;     // 存 clip 失败：分片留着下次启动找回
      recErr = info || { code: 'failed' };
      if (gone && info && info.code === 'save' && info.blob) {
        const blob = info.blob;
        ctx.toast(t('rec.saveFailAway'), { ms: 120000, action: { label: t('rec.download'), run: () => saveFile(blob) } });
      }
      persistNow();
    } else if (s === 'idle') { recId = null; persistNow(); }
    if (s === 'saved' || s === 'error' || s === 'idle') {
      if (gone) keepInline([]);
      const ws = recWaiters; recWaiters = []; for (const f of ws) f();
    }
    if (!gone) paintRec();
  }
  function onClip(res) {
    const clip = clipOf(res), dur = fmtDuration(res.durationSec) || '0:00';
    let ok = false;
    if (!isNew) {
      const e = ctx.entry(id);
      if (e && !e.deleted) {
        ok = true;
        const off = ctx.on('change', (info) => { if (info && info.saved === false) ok = false; });
        if (!(e.audio || []).some(a => a.sha256 === clip.sha256)) ctx.update(id, { audio: [...(e.audio || []), clip] });
        off();
      }
    }
    if (gone) {
      if (ok) ctx.toast(t('rec.inlineAway', { dur }), { ms: 6000 });
      else { inlineSha.set(clip.sha256, { startedAt: res.startedAt, tz: res.tz }); keepInline([clip]); ok = true; }
    } else {
      // 新的一条、时间还空着：用录音开始的时间（同一天才用）
      if (isNew && !w.time && res.startedAt != null) {
        const rt = recTimeFields(res.startedAt, res.tz);
        if (rt.date === w.date) { Object.assign(w, { time: rt.time, timeSource: rt.timeSource, recordedAt: rt.recordedAt, tz: rt.tz }); timeInput.value = w.time; paintTime(); }
      }
      if (!w.audio.some(a => a.sha256 === clip.sha256)) {
        w.audio.push({ ...clip });
        if (ok) addToBase([clip]);                  // 已经存进条目：不算没保存的修改
        else { inlineSha.set(clip.sha256, { startedAt: res.startedAt, tz: res.tz }); if (removedSha.has(clip.sha256)) removedSha.delete(clip.sha256); else addedSha.add(clip.sha256); }
      }
      recId = null;
      drawAudio();
      const kept = persistNow();
      ok = ok || kept;
      ctx.toast(t(isNew || !ok ? 'rec.inlineAdded' : 'rec.inlineSaved', { dur }), { ms: 2400 });
    }
    recId = null;
    // 条目里、草稿里都有了才清恢复记录（不然下次启动时找回，单独建一条）
    if (ok && res.recId) Promise.resolve(ctx.audio.clearRec(res.recId)).catch(() => {});
  }
  /** 离开了编辑页、这条又没保存：这次录的单独存成一条待整理。
   *  马上存（不等还在录的那段收尾）——收尾要一两秒，这期间 App 被关掉的话，已经录好的几段就哪条都不在了；
   *  还在录的那段录完再接到同一条（App 先被关掉的话，下次启动按没收尾的录音找回，单独一条） */
  function keepInline(clips) {
    if (!clips.length) return;
    const cur = awayId ? ctx.entry(awayId) : null;
    if (cur && !cur.deleted) {
      const have = cur.audio || [];
      ctx.update(awayId, { audio: [...have, ...clips.filter(c => !have.some(a => a.sha256 === c.sha256)).map(c => ({ ...c }))] });
    } else {
      const first = inlineSha.get(clips[0].sha256) || {};
      awayId = ctx.put(ctx.newEntry({ ...recTimeFields(first.startedAt, first.tz), status: 'inbox', audio: clips.map(c => ({ ...c })), source: { kind: 'app' } })).id;
    }
    ctx.toast(t('rec.savedAway', { dur: fmtDuration(clips.reduce((n, c) => n + (c.durationSec || 0), 0)) || '0:00' }), { ms: 6000 });
  }
  /** 这次编辑里改过草稿没有（和打开时的条目比） */
  function draftTouched() {
    try { const b = JSON.parse(base); return w.draftText !== b.draftText || (w.draftSrc || '') !== (b.draftSrc || ''); } catch (e) { return true; }
  }
  function addToBase(clips) {
    try { const b = JSON.parse(base); b.audio = [...(b.audio || []), ...clips.map(c => ({ ...c }))]; base = canon(b); } catch (e) { /* 算成有修改也没关系 */ }
  }
  function paintRec() {
    clearInterval(recTick); recTick = null;
    recMeter = recTimer = null;
    const busy = recBusy();
    recBtn.hidden = busy;
    recStrip.hidden = !busy && !recErr;
    if (!busy && recErr) {
      const code = recErr.code || 'failed';
      recStrip.className = 'ed-recstrip err';
      const blob = recErr.blob;
      recStrip.replaceChildren(...[h('span.ed-rec-msg', { role: 'alert' }, t('rec.err.' + code + '.t')),     // replaceChildren 会把 null 写成「null」
        blob ? h('button.btn.small', { type: 'button', onclick: () => saveFile(blob) }, t('rec.download')) : null,
        h('button.icon-btn.small', { type: 'button', 'aria-label': t('common.close'), onclick: () => { recErr = null; paintRec(); } }, icon('x'))].filter(Boolean));
      return;
    }
    if (!busy) { recStrip.replaceChildren(); return; }
    recStrip.className = 'ed-recstrip';
    if (recState === 'requesting') {
      recStrip.replaceChildren(h('span.ed-rec-msg', null, t('rec.requesting')),
        h('button.btn.small', { type: 'button', onmousedown: keepFocus, onclick: () => stopRec('cancel') }, t('common.cancel')));
      return;
    }
    const stopping = recState === 'stopping';
    recTimer = h('span.ed-rec-time', { role: 'timer', 'aria-label': t('rec.elapsed') }, fmtTimer(recr.elapsedMs() / 1000));
    recMeter = h('i');
    recStrip.replaceChildren(
      h('span.ed-rec-dot', { 'aria-hidden': 'true' }), recTimer,
      h('span.ed-rec-meter', { 'aria-hidden': 'true' }, recMeter),
      h('span.ed-rec-msg', null, stopping ? t('rec.saving') : t('rec.recording')),
      h('button.btn.small.ed-rec-stop', { type: 'button', disabled: stopping, onmousedown: keepFocus, onclick: () => stopRec('user') },
        h('span.ed-rec-sq', { 'aria-hidden': 'true' }), t('rec.stopShort')));
    if (!stopping) recTick = setInterval(() => { const x = fmtTimer(recr.elapsedMs() / 1000); if (recTimer && recTimer.textContent !== x) recTimer.textContent = x; }, 500);
  }

  // ---------- 保存 ----------
  let saving = false;
  async function save(markDone = false) {
    if (saving) return;
    if (recBusy()) { saving = true; await stopRec('user'); saving = false; if (gone) return; }       // 正在录：先停下存好，录到的一起保存
    if (!isISODate(w.date)) { dateErr.hidden = false; dateInput.focus(); return; }
    if (!isNew && !isDirty() && !markDone) { saved = true; dropDraft(); ctx.back(backTo); return; }
    // 新建但什么都没写（只有预填的「👰🏻‍♀️ “”」）：不建空条目，直接回去
    if (isNew && w.text === template.text && !w.note.trim() && !w.draftText.trim() && !w.audio.length) { saved = true; dropDraft(); ctx.back(backTo); return; }
    const prev = isNew ? null : ctx.entry(id);
    const curAudio = prev ? prev.audio || [] : [];
    const named = (a) => {                       // 这次改了名的：名字用工作副本里的
      const mine = renamedSha.has(a.sha256) && w.audio.find(x => x.sha256 === a.sha256);
      if (!mine) return a;
      const { name, ...rest } = a;
      return mine.name ? { ...rest, name: mine.name } : rest;
    };
    const audio = [...curAudio.filter(a => !removedSha.has(a.sha256)),
      ...w.audio.filter(a => addedSha.has(a.sha256) && !curAudio.some(x => x.sha256 === a.sha256))].map(named);
    const fields = savedFields(w, { template, prev, audio: isNew ? w.audio : audio, keepDraft: !draftTouched() });   // 没有 title：存着的原样留着
    saved = true;
    dropDraft();
    inlineSha.clear();
    if (isNew) {
      const e = ctx.put(ctx.newEntry({ ...fields, status: 'done', source: { kind: 'app' } }));
      ctx.navigate('/e/' + enc(e.id), { replace: true });
      return;
    }
    ctx.update(id, { ...fields, ...(prev && prev.deleted ? { deleted: false } : {}) });
    // 「整理好了」单独一步：提示里点「撤销」只改回状态，刚写的原话不动
    if (markDone) ctx.update(id, { status: 'done' }, { undoLabel: t('entry.doneToast') });
    else ctx.toast(t('edit.saved'), { ms: 1600 });
    ctx.back(backTo);
  }
  const cancel = () => ctx.back(backTo);

  // ---------- 画 ----------
  const draftOpen = () => !!w.draftText.trim();
  let draftEl;
  function build() {
    const inbox = !isNew && src.status === 'inbox';
    toolsEl = tools();
    draftEl = h('details.ed-draft-box', { open: draftOpen(), ontoggle: () => { if (draftEl.open) grow(draftTa, 80); } },
      h('summary', null, icon('chev'), h('span', null, t('edit.draft')), h('small', null, t('edit.draftHint'))),
      draftTa,
      h('div.ed-draft-foot', null, h('button.btn.small', { type: 'button', onclick: () => {
        if (!w.draftText.trim()) return;
        const base0 = ta.value === template.text ? '' : ta.value;
        replaceText(ta, base0 ? base0.replace(/\s*$/, '') + '\n' + w.draftText : w.draftText, (base0 ? base0.replace(/\s*$/, '').length + 1 : 0) + w.draftText.length);
        touchedText = true; onText();
      } }, t('edit.draftInsert'))));
    main.replaceChildren(...[
      h('header.navbar', null,
        h('button.back.text', { type: 'button', onclick: cancel }, t('common.cancel')),
        h('span.nb-title', null, isNew ? t('nav.new') : t('common.edit')),
        h('button.tb-btn.ed-save', { type: 'button', onclick: () => save(false) }, t('common.save'))),
      h('div.page.editor', null,
        restoredEl, banner,
        h('div.ed-dt', null,
          h('div', null, h('div.f-label', null, h('label', { for: 'ed-date' }, t('edit.date'))), dateInput),
          h('div', null, h('div.f-label', null, h('label', { for: 'ed-time' }, t('edit.time'), ' ', h('small', null, t('edit.optional'))), h('span.ed-time-acts', null, nowBtn, clearTime)), timeInput)),
        dateErr, timeHelp, suggestEl,
        h('div.f-label', null, h('span', null, t('edit.audio'))),
        audioBox,
        h('div.f-label', null, h('label', { for: 'ed-text' }, t('edit.text')), h('small', null, t('edit.textHint'))),
        h('div.ed-textbox', null, toolsEl, ta),
        draftEl,
        h('div.f-label', null, h('label', { for: 'ed-note' }, t('edit.note'))),
        noteTa),
      inbox ? h('div.bottom-bar.ed-done', null, h('button.btn.primary.big', { type: 'button', onclick: () => save(true) }, icon('check'), t('entry.done'))) : null,
      fileInput].filter(Boolean));
    drawAudio(); paintTime();
    // 页面已经在文档里（app 先挂容器再调 render），可以直接量高度
    grow(ta, 168); grow(noteTa, 56); if (draftOpen()) grow(draftTa, 80);
  }
  build();

  // 新建、或者原话还空着：光标放进引号中间；宽屏编辑已有的也直接放进原话框（手机上不抢着弹键盘）
  if (isNew || w.text === template.text || ctx.layout() !== 'phone') {
    requestAnimationFrame(() => {
      if (!main.isConnected) return;
      ta.focus({ preventScroll: true });
      const c = w.text === template.text ? template.cursor : ta.value.length;
      ta.setSelectionRange(c, c);
      touchedText = true;
    });
  }

  // ⌘S / ⌘↩ 保存，Esc 取消（有修改时 app 会先问）
  // （main 这个容器换页后会留给别的页面用，所以清理时要把监听拿掉）
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) { e.preventDefault(); save(false); }
    else if (e.key === 'Escape' && !e.isComposing && !document.querySelector('dialog[open]')) { e.preventDefault(); cancel(); }
  };
  main.addEventListener('keydown', onKey);

  /** 工作副本换成 e 的内容（没有修改） */
  function resetTo(e) {
    w = fromEntry(e); base = canon(w); addedSha.clear(); removedSha.clear(); renamedSha.clear();
    dateInput.value = w.date; timeInput.value = w.time; ta.value = w.text; noteTa.value = w.note; draftTa.value = w.draftText;
  }

  // 切到后台、页面被收起：马上存一份（之后 App 可能直接被系统杀掉）；录着的先存好（iOS 在后台本来也录不了）
  const onHide = () => { if (document.visibilityState === 'hidden') { persistNow(); if (recBusy()) recr.stop({ reason: 'hidden' }).catch(() => {}); } };
  const onPageHide = () => { persistNow(); if (recBusy()) recr.stop({ reason: 'pagehide' }).catch(() => {}); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  // 上次录到一半被关掉的草稿：App 处理完找回的录音以后再恢复（「记一条」的那份可能已经连同录音存成一条了）
  if (waitRecovery) {
    Promise.resolve(ctx.recovered).catch(() => {}).then(() => {
      if (gone || !main.isConnected || isDirty()) return;
      if (!applyDraft(readDraft(store(), draftKey))) return;
      restoredEl.firstChild.textContent = restoredMsg(); restoredEl.hidden = !restoredAt;
      dateInput.value = w.date; timeInput.value = w.time; ta.value = w.text; noteTa.value = w.note; draftTa.value = w.draftText;
      build();
    });
  }

  function onChange() {
    if (saved || isNew) return;
    const e = ctx.entry(id);
    if (!e) return;
    const cur = pickEditable(e), now = canon(cur);
    if (now === baseEntry) return;                  // 改的是别的（比如列表里点了收藏）
    const was = JSON.parse(baseEntry), more = addedAudio(was, cur);
    baseEntry = now;
    if (more) {
      // 只是多了录音（这里录的一段刚接上、别的设备加的）：列进来，不重画，不打断正在写的
      const fresh = more.filter(a => !w.audio.some(x => x.sha256 === a.sha256) && !removedSha.has(a.sha256));
      if (fresh.length) { w.audio.push(...fresh.map(a => ({ ...a }))); addToBase(fresh); drawAudio(); }
      return;
    }
    if (isDirty() && !draftTouched() && canon({ ...was, draft: null }) === canon({ ...cur, draft: null })) {
      // 只是草稿变了（「转成文字」在后台做完了），这里又没改草稿：换上新的草稿，不打断正在写的
      const text = e.draft ? e.draft.text : '', source = e.draft ? e.draft.source : '';
      try { const b = JSON.parse(base); Object.assign(b, { draftText: text, draftSrc: source }); base = canon(b); } catch (x) { /* 算成有修改也没关系 */ }
      Object.assign(w, { draftText: text, draftSrc: source });
      draftTa.value = text;
      if (draftEl.open) grow(draftTa, 80);
      persistSoon();
      return;
    }
    if (!isDirty()) {
      // 没动过：直接换成新的内容（焦点留在原来的框里）
      const fid = document.activeElement && main.contains(document.activeElement) ? document.activeElement.dataset.fid : null;
      resetTo(e);
      banner.hidden = !e.deleted;
      if (e.deleted) banner.textContent = t('edit.remoteDeleted');
      build();
      if (fid) { const el = main.querySelector(`[data-fid="${fid}"]`); if (el) el.focus({ preventScroll: true }); }
    } else {
      banner.textContent = t(e.deleted ? 'edit.remoteDeleted' : 'edit.remoteChanged');
      banner.hidden = false;
    }
  }

  return {
    onChange,
    // 页面被清理 = 保存了、没改过，或者确认了「离开」（有修改时 app 先问过）：另存的那份也不要了。
    // （iOS 杀掉 App、刷新页面时不会走到这里，那份留着下次恢复）
    cleanup: () => {
      main.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      dropDraft();
      gone = true;
      clearInterval(recTick);
      for (const p of players) p.destroy(); players = [];
      // 离开时还在录：照样存好（已有的条目接上；新的一条没保存 → 单独存成一条待整理）。这次录的、没保存的也一样
      const unsaved = !saved ? w.audio.filter(a => inlineSha.has(a.sha256)) : [];      // 已有的条目只有接不上（被删了）的才在 inlineSha 里
      if (unsaved.length) keepInline(unsaved);                       // 先存已经录好的，再让还在录的那段收尾
      if (recBusy()) recr.stop({ reason: 'leave' }).catch(() => {});
    },
  };
}
