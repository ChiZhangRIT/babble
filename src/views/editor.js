// 记一条 / 编辑（#/new、#/edit/<id>）：日期、时间、录音、标题、原话（楷体，工具栏插入说话人和反应）、草稿、那天的背景。
// 原话照原样保存（新建时预填的「👰🏻‍♀️ “”」没动过就当没写）。改了没保存，离开前会问（ctx.guard）。
// 自己管更新（返回 onChange）：别的设备改了这条——没动过就换成新的，动过就保留你写的并提示一句。
// 没保存的修改随手另存在 localStorage（babble.edit.<id|new>）：iOS 在后台把 App 杀掉（切去语音备忘录抄转写时常见）也不丢，
// 下次打开同一个编辑页时恢复（app 冷启动时也会直接回到这里）；保存、取消、确认离开时删掉。
import { h, icon } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { canon } from '../core/store.js';
import { today, nowTime, isISODate, isTime, localParts, systemTz, fmtEntryDate } from '../core/dates.js';
import { insertSpeakerLine, firstNNLine } from '../core/dialogue.js';
import { AUDIO_ACCEPT, readClipFiles } from './entry.js';
import { t } from '../i18n.js';

/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');

export const REACTIONS = ['🤯', '🫨', '😲', '🤭', '😂', '🥲'];
const enc = encodeURIComponent;
// 条目里编辑页管的字段（判断别的设备是不是改了这些）
const EDITABLE = ['date', 'time', 'title', 'text', 'note', 'draft', 'audio', 'timeSource', 'recordedAt', 'tz', 'deleted'];
const pickEditable = e => Object.fromEntries(EDITABLE.map(k => [k, e[k] ?? null]));
export const EDIT_PREFIX = 'babble.edit.';
const store = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };

/**
 * 把文本框的内容换成 next、光标放到 cursor。只替换真正变了的那一段，并尽量用 insertText（这样 ⌘Z 能撤销）
 */
export function replaceText(ta, next, cursor) {
  const old = ta.value;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let q = 0;
  while (q < old.length - p && q < next.length - p && old[old.length - 1 - q] === next[next.length - 1 - q]) q++;
  const lowSur = (s, i) => { const c = s.charCodeAt(i); return c >= 0xDC00 && c <= 0xDFFF; };
  while (p > 0 && lowSur(old, p)) p--;                                  // 不要从一个表情中间切开
  while (q > 0 && lowSur(old, old.length - q)) q--;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(p, old.length - q);
  let ok = false;
  try { ok = document.execCommand('insertText', false, next.slice(p, next.length - q)); } catch (e) { ok = false; }
  if (!ok || ta.value !== next) ta.value = next;
  ta.setSelectionRange(cursor, cursor);
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
  const template = insertSpeakerLine('', 0, 'nn', sp());         // 「👰🏻‍♀️ “”」，光标在引号中间
  const fromEntry = (e) => ({
    date: e.date, time: e.time || '', title: e.title || '', text: e.text ? e.text : template.text, note: e.note || '',
    draftText: e.draft ? e.draft.text : '', draftSrc: e.draft ? e.draft.source : '',
    audio: (e.audio || []).map(a => ({ ...a })), timeSource: e.timeSource || null, recordedAt: e.recordedAt || null, tz: e.tz || null,
  });
  let w = fromEntry(src || { date: today() });
  let base = canon(w), baseEntry = src ? canon(pickEditable(src)) : null;
  let saved = false, players = [], suggest = null, touchedText = false;
  // 这次编辑里加的、移除的录音（sha256）：保存时在条目「现在」的录音上加减，别的设备刚接上的录音不会被旧的列表盖掉
  const addedSha = new Set(), removedSha = new Set();
  const isDirty = () => !saved && canon(w) !== base;
  ctx.guard(isDirty);

  // ---------- 没保存的修改另存一份 ----------
  const draftKey = EDIT_PREFIX + (isNew ? 'new' : id);
  let persistTimer = null;
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    const st = store();
    if (!st) return;
    try {
      if (isDirty()) st.setItem(draftKey, JSON.stringify({ w, added: [...addedSha], removed: [...removedSha], at: Date.now() }));
      else st.removeItem(draftKey);
    } catch (e) { /* 存不下就算了：页面还开着时内容在内存里 */ }
  }
  const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 400); };
  const dropDraft = () => { clearTimeout(persistTimer); persistTimer = null; try { const st = store(); if (st) st.removeItem(draftKey); } catch (e) { /* 同上 */ } };
  let restoredAt = null;
  try {
    const d = JSON.parse((store() && store().getItem(draftKey)) || 'null');
    if (d && d.w && typeof d.w === 'object' && canon({ ...w, ...d.w }) !== base) {
      w = { ...w, ...d.w, audio: Array.isArray(d.w.audio) ? d.w.audio : w.audio };
      for (const x of d.added || []) addedSha.add(x);
      for (const x of d.removed || []) removedSha.add(x);
      restoredAt = Number(d.at) || null;
    } else if (d) dropDraft();
  } catch (e) { dropDraft(); }

  // ---------- 控件 ----------
  const dateInput = h('input.ed-date#ed-date', { type: 'date', required: true, value: w.date, dataset: { fid: 'ed-date' },
    oninput: () => { w.date = dateInput.value; manualTime(); dateErr.hidden = true; } });
  const timeInput = h('input.ed-time#ed-time', { type: 'time', value: w.time, dataset: { fid: 'ed-time' },
    oninput: () => { w.time = timeInput.value; manualTime(); } });
  const dateErr = h('p.f-help.err', { hidden: true, role: 'alert' }, t('edit.badDate'));
  const timeHelp = h('p.f-help.ed-tsrc');
  const suggestEl = h('div.ed-suggest', { hidden: true });
  const titleInput = h('input#ed-title', { type: 'text', value: w.title, dataset: { fid: 'ed-title' }, enterkeyhint: 'next', oninput: () => { w.title = titleInput.value; persistSoon(); },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ta.focus(); } } });
  const ta = h('textarea.kai.ed-text#ed-text', { value: w.text, rows: 6, placeholder: t('edit.textPh', { nn: nn() }), dataset: { fid: 'ed-text' },
    autocapitalize: 'off', spellcheck: 'false', oninput: () => onText(), onfocus: () => { touchedText = true; } });
  const noteTa = h('textarea.ed-note#ed-note', { value: w.note, rows: 2, placeholder: t('edit.notePh'), dataset: { fid: 'ed-note' }, oninput: () => { w.note = noteTa.value; grow(noteTa, 56); persistSoon(); } });
  const draftTa = h('textarea.ed-draft', { value: w.draftText, rows: 3, placeholder: t('edit.draftPh'), dataset: { fid: 'ed-draft' },
    oninput: () => { w.draftText = draftTa.value; if (!w.draftSrc && w.draftText.trim()) w.draftSrc = 'paste'; grow(draftTa, 80); persistSoon(); } });
  const audioBox = h('div.ed-audio');
  const banner = h('p.ed-banner', { hidden: !(src && src.deleted), role: 'status' }, src && src.deleted ? t('edit.remoteDeleted') : null);
  const restoredEl = h('div.ed-banner.ed-restored', { hidden: !restoredAt, role: 'status' },
    h('span', null, t('edit.restored', { time: restoredAt ? fmtEntryDate({ ...localParts(restoredAt), timeSource: null }, ctx.lang(), { sep: daySep(ctx.lang()) }) : '' })),
    h('button.link-btn', { type: 'button', onclick: () => { resetTo(isNew ? { date: today() } : (ctx.entry(id) || src)); dropDraft(); restoredEl.hidden = true; build(); } }, t('edit.restoredDiscard')));
  const fileInput = h('input', { type: 'file', accept: AUDIO_ACCEPT, multiple: true, hidden: true,
    onchange: (ev) => { const fl = [...ev.target.files]; ev.target.value = ''; if (fl.length) addFiles(fl); } });

  const keep = (e) => e.preventDefault();          // 点工具栏不把焦点从原话框抢走（手机上键盘不收起）
  const toolBtn = (cls, label, who, body, aria) => h('button.' + cls, { type: 'button', onmousedown: keep, 'aria-label': aria || null, title: aria || null,
    onclick: () => insertLine(who, body) }, label);
  const tools = () => h('div.ed-tools', { role: 'toolbar', 'aria-label': t('edit.insert') },
    h('div.ed-spk', null,
      toolBtn('spk-btn.nn', [h('span.spk-emoji', null, sp().nn.emoji), h('span', null, nn())], 'nn'),
      toolBtn('spk-btn.me', [h('span.spk-emoji', null, sp().me.emoji), h('span', null, sp().me.name || t('edit.me'))], 'me')),
    h('div.ed-react', { role: 'group', 'aria-label': t('edit.reactions') },
      REACTIONS.map(r => toolBtn('react-btn', r, 'me', r, sp().me.emoji + ' ' + r))));
  let toolsEl = tools();

  // ---------- 原话 ----------
  function onText() {
    w.text = ta.value;
    titleInput.placeholder = firstNNLine(w.text, sp()) || t('edit.titlePh');
    grow(ta, 168);
    persistSoon();
  }
  function insertLine(who, body) {
    const cur = touchedText ? ta.selectionEnd : ta.value.length;
    const r = insertSpeakerLine(ta.value, cur, who, sp(), body);
    replaceText(ta, r.text, r.cursor);
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
          h('div.ed-clip-foot', null, h('span.ed-clip-name', null, c.origName || (w.audio.length > 1 ? t('entry.clipN', { n: i + 1 }) : '')),
            h('button.link-btn.danger', { type: 'button', onclick: () => removeClip(c) }, t('edit.removeClip'))));
      }),
      h('button.btn.small.ed-add', { type: 'button', onclick: () => fileInput.click() }, icon('plus'), t('edit.addAudio')));
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

  // ---------- 保存 ----------
  function save(markDone = false) {
    if (!isISODate(w.date)) { dateErr.hidden = false; dateInput.focus(); return; }
    if (!isNew && !isDirty() && !markDone) { saved = true; dropDraft(); ctx.back(backTo); return; }
    // 新建但什么都没写（只有预填的「👰🏻‍♀️ “”」）：不建空条目，直接回去
    if (isNew && w.text === template.text && !w.title.trim() && !w.note.trim() && !w.draftText.trim() && !w.audio.length) { saved = true; dropDraft(); ctx.back(backTo); return; }
    const prev = isNew ? null : ctx.entry(id);
    const curAudio = prev ? prev.audio || [] : [];
    const audio = [...curAudio.filter(a => !removedSha.has(a.sha256)),
      ...w.audio.filter(a => addedSha.has(a.sha256) && !curAudio.some(x => x.sha256 === a.sha256))];
    const fields = {
      date: w.date, time: isTime(w.time) ? w.time : null,
      title: w.title.trim() ? w.title : '',
      text: w.text === template.text ? '' : w.text,
      note: w.note,
      draft: w.draftText.trim() ? { ...((prev && prev.draft) || {}), text: w.draftText, source: w.draftSrc || 'paste' } : null,
      audio: isNew ? w.audio : audio, timeSource: w.timeSource, recordedAt: w.recordedAt, tz: w.tz,
    };
    saved = true;
    dropDraft();
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
        h('div.f-label', null, h('label', { for: 'ed-title' }, t('edit.title'), ' ', h('small', null, t('edit.optional')))),
        titleInput,
        h('div.f-label', null, h('label', { for: 'ed-text' }, t('edit.text')), h('small', null, t('edit.textHint'))),
        h('div.ed-textbox', null, toolsEl, ta),
        draftEl,
        h('div.f-label', null, h('label', { for: 'ed-note' }, t('edit.note'))),
        noteTa),
      inbox ? h('div.bottom-bar.ed-done', null, h('button.btn.primary.big', { type: 'button', onclick: () => save(true) }, icon('check'), t('entry.done'))) : null,
      fileInput].filter(Boolean));
    titleInput.placeholder = firstNNLine(w.text, sp()) || t('edit.titlePh');
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
    w = fromEntry(e); base = canon(w); addedSha.clear(); removedSha.clear();
    dateInput.value = w.date; timeInput.value = w.time; titleInput.value = w.title; ta.value = w.text; noteTa.value = w.note; draftTa.value = w.draftText;
  }

  // 切到后台、页面被收起：马上存一份（之后 App 可能直接被系统杀掉）
  const onHide = () => { if (document.visibilityState === 'hidden') persistNow(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', persistNow);

  function onChange() {
    if (saved || isNew) return;
    const e = ctx.entry(id);
    if (!e) return;
    const now = canon(pickEditable(e));
    if (now === baseEntry) return;                  // 改的是别的（比如列表里点了收藏）
    baseEntry = now;
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
      window.removeEventListener('pagehide', persistNow);
      dropDraft();
      for (const p of players) p.destroy(); players = [];
    },
  };
}
