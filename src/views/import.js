// 导入录音（#/import）和从备忘录迁移（#/import/notes）。
// 两边都是「先看后写」：选文件、解析、配对都只在内存里，点最后那个按钮之前不写任何数据（录音也不存进本机）。
// 自己管更新（返回 onChange）：同步等数据变化不会把选好的文件、贴好的笔记清掉。
import { h, icon, toast } from '../ui/dom.js';
import { audioPlayer, stopAll } from '../ui/player.js';
import { readMp4Meta } from '../core/mp4meta.js';
import { sha256Hex } from '../core/sha256.js';
import { mimeForFile } from '../core/audioStore.js';
import { clipIndex, makeEntry, newId } from '../core/store.js';
import { localParts, today, systemTz, isISODate, isTime, fmtTime, fmtDate, fmtDuration } from '../core/dates.js';
import { splitExt, fmtBytes, uniq } from '../core/util.js';
import { firstNNLine } from '../core/dialogue.js';
import { parseNote, parsePathList, suggestPairs, recordedOnDate } from '../core/notesImport.js';
import { probeDuration, AUDIO_ACCEPT, sayNodes } from './entry.js';
import { ownName } from '../core/clips.js';
import { entryLabel } from './record.js';
import { backupBox } from './settings.js';
import { t } from '../i18n.js';
/** replaceChildren，但跳过 null / false（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const AUDIO_EXT = new Set(['m4a', 'mp4', 'aac', 'caf', 'wav', 'webm', 'ogg', 'opus', 'mp3']);
const NEAR_DAYS = 3;
const nfc = s => String(s || '').normalize('NFC');
const enc = encodeURIComponent;
const dayNum = d => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
const round1 = v => (v ? Math.round(v * 10) / 10 : null);

/**
 * 读一个选来的文件（只读不存）→ { name, size, lastModified, mime, sha256, blob, createdAt, durationSec } 或 { bad: 'qta'|'notAudio'|'fail', msg }
 */
export async function readAudioFile(f) {
  const [, ext] = splitExt(f.name);
  if (ext === 'qta') return { name: f.name, bad: 'qta' };
  if (!AUDIO_EXT.has(ext) && !/^audio\//.test(f.type || '')) return { name: f.name, bad: 'notAudio' };
  try {
    const mime = mimeForFile(f);
    const buf = await f.arrayBuffer();
    const meta = readMp4Meta(buf);                         // 不是 mp4 也不抛错，全是 null
    const sha256 = await sha256Hex(buf);
    const blob = new Blob([buf], { type: mime });
    const durationSec = round1(meta.durationSec || await probeDuration(blob));
    return { name: nfc(f.name), size: f.size, lastModified: f.lastModified || null, mime, sha256, blob, createdAt: meta.createdAt || null, durationSec };
  } catch (e) { return { name: f.name, bad: 'fail', msg: (e && e.message) || String(e) }; }
}

/** 「已经在哪一条里」：条目的简称；那段录音改过名的话把名字也带上（「… · 🎙 名字」，简称里已经是这个名字就不重复） */
function clipWhere(e, sha, speakers, lang) {
  const c = e && (e.audio || []).find(a => a.sha256 === sha);
  const own = ownName(c), label = entryLabel(e, speakers, lang);
  return label + (own && !label.endsWith('🎙 ' + own) ? ' · 🎙 ' + own : '');
}

/** 拖放区（只管样子）：文件由 catchDrops 在整个窗口上接 */
function dropZone(...kids) {
  const el = h('div.im-drop', {
    ondragover: (e) => { e.preventDefault(); el.classList.add('over'); },
    ondragleave: () => el.classList.remove('over'),
    ondrop: () => el.classList.remove('over'),
  }, kids);
  return el;
}
/** 整个窗口的拖放（捕获阶段先拿到，标成已处理，app 的全局拖放就不会把页面重画掉）：在导入页上拖到哪里都算 */
function catchDrops(onFiles) {
  const fn = (e) => {
    const fl = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!fl.length) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    onFiles(fl);
  };
  window.addEventListener('drop', fn, true);
  return () => window.removeEventListener('drop', fn, true);
}
function filePicker(onFiles) {
  return h('input', { type: 'file', accept: AUDIO_ACCEPT, multiple: true, hidden: true,
    onchange: (ev) => { const fl = [...ev.target.files]; ev.target.value = ''; if (fl.length) onFiles(fl); } });
}
const metaLine = (...parts) => parts.filter(Boolean).join(' · ');

export function render(main, params, ctx) {
  return params.sub === 'notes' ? notesView(main, params, ctx) : audioView(main, params, ctx);
}

// ======================================================================
// 导入录音：每段建一条「待整理」，或者接到已有的一条
// ======================================================================
function audioView(main, params, ctx) {
  const lang = ctx.lang();
  const sp = () => ctx.state.settings.speakers;
  const rows = [];          // { key, info, date, time, auto: {date,time,timeSource,recordedAt,tz}, mode, attachTo }（没有标题：文件名就是录音的名字）
  const skipped = [];       // { name, why, where? }
  let reading = 0, busy = false, done = false, players = [];
  ctx.guard(() => !done && rows.length > 0);

  const picker = filePicker(addFiles);
  const listEl = h('div.im-rows');
  const skipEl = h('div');
  const headEl = h('div');
  const goBtn = h('button.btn.primary.big.block', { type: 'button', onclick: doImport });
  const bar = h('div.bottom-bar', { hidden: true }, goBtn);
  main.append(
    h('header.navbar', null, h('button.back.text', { type: 'button', onclick: () => ctx.back('/settings') }, t('common.cancel')),
      h('span.nb-title', null, t('nav.import')), h('span')),
    h('div.page.im', null, headEl, listEl, skipEl), bar, picker);
  const offDrop = catchDrops(addFiles);

  function where(sha) {
    const ids = clipIndex(ctx.state, { includeDeleted: true }).get(sha) || [];
    const live = ids.map(id => ctx.entry(id)).find(e => e && !e.deleted);
    if (live) return { why: 'dup', where: clipWhere(live, sha, sp(), lang) };
    return ids.length ? { why: 'dupDeleted' } : null;
  }

  async function addFiles(files) {
    reading += files.length; drawHead();
    for (const f of files) {
      const info = await readAudioFile(f);
      reading--;
      if (info.bad) { skipped.push({ name: info.name, why: info.bad, msg: info.msg }); drawSkipped(); drawHead(); continue; }
      const dup = where(info.sha256);
      if (dup) { skipped.push({ name: info.name, ...dup }); drawSkipped(); drawHead(); continue; }
      if (rows.some(r => r.info.sha256 === info.sha256)) { skipped.push({ name: info.name, why: 'dupBatch' }); drawSkipped(); drawHead(); continue; }
      const auto = guessTime(info);
      rows.push({ key: info.sha256, info, auto, date: auto.date, time: auto.time || '', mode: 'new', attachTo: null });
      rows.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
      drawRows(); drawHead();
    }
  }

  function drawHead() {
    const n = rows.length;
    fill(headEl,
      n ? h('div.im-addrow', null,
        h('button.btn.small', { type: 'button', onclick: () => picker.click() }, icon('plus'), t('imp.pickMore')),
        reading ? h('span.muted.small', { role: 'status' }, t('imp.reading', { n: reading })) : null)
        : h('section.card.im-intro', null,
          h('p', null, t('imp.audio.intro')),
          dropZone(
            h('button.btn.primary', { type: 'button', onclick: () => picker.click() }, icon('import'), t('imp.pick')),
            h('p.im-drop-hint', null, reading ? t('imp.reading', { n: reading }) : t('imp.drop'))),
          h('p.group-h', null, t('imp.howH')),
          h('ol.im-steps', null, h('li', null, t('imp.how1')), h('li', null, t('imp.how2')), h('li', null, t('imp.how3')))),
    );
    bar.hidden = !n;
    goBtn.textContent = busy ? t('imp.importing') : t('imp.go', { n });
    goBtn.disabled = busy || reading > 0 || !n || rows.some(r => !isISODate(r.date) || (r.mode === 'attach' && !r.attachTo));
  }

  function drawSkipped() {
    fill(skipEl, skipped.length ? h('section', null,
      h('p.group-h', null, t('imp.skippedH', { n: skipped.length })),
      h('div.group', null, skipped.map(s => h('div.group-row.im-skip', null,
        h('div.im-skip-body', null, h('b', null, s.name),
          h('p.small.muted', null, t('imp.skip.' + s.why, { where: s.where || '', msg: s.msg || '' }))))))) : '');
  }

  function drawRows() {
    for (const p of players) p.destroy();
    players = [];
    fill(listEl, ...rows.map(rowEl));
  }

  function rowEl(r) {
    const info = r.info;
    const player = audioPlayer({ getBlob: async () => info.blob, durationSec: info.durationSec, compact: true });
    players.push(player);
    const manual = r.date !== r.auto.date || (r.time || '') !== (r.auto.time || '');
    const src = manual ? 'manual' : r.auto.timeSource || 'none';
    const dateIn = h('input.im-date', { type: 'date', value: r.date, required: true, 'aria-label': t('imp.date'),
      onchange: () => { r.date = dateIn.value; if (r.mode === 'attach') r.attachTo = null; refreshRow(); } });
    const timeIn = h('input.im-time', { type: 'time', value: r.time, 'aria-label': t('imp.time'), onchange: () => { r.time = timeIn.value; refreshRow(); } });
    const near = isISODate(r.date) ? ctx.entries().filter(e => Math.abs(dayNum(e.date) - dayNum(r.date)) <= NEAR_DAYS)
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(r.date)) - Math.abs(dayNum(b.date) - dayNum(r.date))) : [];
    const seg = h('div.seg.im-mode', { role: 'group', 'aria-label': t('imp.modeLabel') },
      ['new', 'attach'].map(m => h('button', { type: 'button', 'aria-pressed': String(r.mode === m), class: r.mode === m ? 'on' : null,
        onclick: () => { r.mode = m; if (m === 'attach' && !r.attachTo && near.length === 1) r.attachTo = near[0].id; refreshRow(); } }, t('imp.mode.' + m))));
    const attach = r.mode !== 'attach' ? null : near.length
      ? h('select.im-attach', { 'aria-label': t('imp.mode.attach'), onchange: (e) => { r.attachTo = e.target.value || null; drawHead(); } },
        h('option', { value: '' }, t('imp.attachPick')),
        near.map(e => h('option', { value: e.id, selected: r.attachTo === e.id }, entryLabel(e, sp(), lang))))
      : h('p.f-help.im-warn', null, t('imp.attachNone', { n: NEAR_DAYS }));
    const el = h('section.card.im-row', { dataset: { key: r.key } },
      h('div.im-row-top', null, player,
        h('div.im-row-name', null, h('b', null, info.name),
          h('p.im-meta', null, metaLine(fmtBytes(info.size), fmtDuration(info.durationSec)))),
        h('button.icon-btn.im-x', { type: 'button', 'aria-label': t('imp.remove'), title: t('imp.remove'),
          onclick: () => { rows.splice(rows.indexOf(r), 1); drawRows(); drawHead(); } }, icon('x'))),
      h('div.im-fields', null,
        h('label.im-f', null, h('span', null, t('imp.date')), dateIn),
        h('label.im-f', null, h('span', null, t('imp.time')), timeIn)),
      h('p.f-help.im-src' + (src === 'file' || src === 'none' ? '.im-warn' : ''), null, icon('clock'), t('imp.src.' + src)),
      h('div.im-moderow', null, seg), attach);
    function refreshRow() {
      const old = listEl.children[rows.indexOf(r)];
      if (old === el) { const pi = players.indexOf(player); if (pi >= 0) players.splice(pi, 1); player.destroy(); old.replaceWith(rowEl(r)); }
      drawHead();
    }
    return el;
  }

  async function doImport() {
    if (busy || !rows.length) return;
    busy = true; drawHead(); stopAll();
    const now = Date.now(), batchId = newId('b_'), tz = systemTz();
    const made = [];
    try {
      for (const r of rows) {
        const saved = await ctx.audio.putClip(r.info.blob, { mime: r.info.mime });
        made.push({ r, clip: { sha256: saved.sha256, mime: saved.mime || r.info.mime, bytes: saved.bytes ?? r.info.size, durationSec: r.info.durationSec, origName: r.info.name, addedAt: now } });
      }
    } catch (e) {
      busy = false; drawHead();
      toast(t('imp.saveFail', { msg: (e && e.message) || String(e) }), { ms: 9000 });
      return;
    }
    const ids = ctx.mutate(s => made.map(({ r, clip }) => {
      if (r.mode === 'attach' && r.attachTo && s.data.entries[r.attachTo] && !s.data.entries[r.attachTo].deleted) {
        const e = s.data.entries[r.attachTo];
        if (!(e.audio || []).some(a => a.sha256 === clip.sha256)) e.audio = [...(e.audio || []), clip];
        return e.id;
      }
      const e = audioEntry(r, clip, { now, batchId, tz });
      s.data.entries[e.id] = e;
      return e.id;
    }), { undoLabel: t('imp.undo', { n: made.length }) });
    done = true;
    for (const p of players) p.destroy();
    players = [];
    const uniqIds = uniq(ids);
    ctx.navigate(uniqIds.length === 1 ? '/e/' + enc(uniqIds[0]) : '/', { replace: true });
  }

  for (const f of [ctx.takeFiles()].filter(Boolean)) addFiles(f);
  drawHead();
  return {
    onChange: () => {},
    cleanup: () => { offDrop(); for (const p of players) p.destroy(); players = []; },
  };
}

/**
 * 导入的一段录音 → 新的一条待整理。没有标题：文件名就是这段录音的名字（clip.origName，播放器上面显示）。
 * r：核对页的一行（日期、时间改过 → 时间来源算手动）
 */
export function audioEntry(r, clip, { now = Date.now(), batchId, tz = null } = {}) {
  const same = r.date === r.auto.date && (r.time || '') === (r.auto.time || '');
  const time = isTime(r.time) ? r.time : null;
  return makeEntry({
    date: r.date, time,
    recordedAt: same ? r.auto.recordedAt : null, tz: same ? r.auto.tz : (time ? tz : null),
    timeSource: same ? r.auto.timeSource : 'manual',
    status: 'inbox', audio: [clip], source: { kind: 'audio-import', batchId },
  }, now);
}

/**
 * 备忘录里的一条 → 条目（没有标题；录音的文件名在 clip.origName 里）。first：配给它的第一段录音文件（{ createdAt }），没有 → null。
 * 录音时间是那天或第二天上午 → 用它的钟点。修改时间故意用很早的（1 + 录音段数）：另一台设备还没同步就又导了一次时，
 * 那边改过的、先导入的都比它新，不会被盖掉；都没改过时带录音的那份赢。盖在删除标记上时 state 会补盖新时间
 */
export function noteEntry(x, audio, first, { now = Date.now(), batchId, tz = null } = {}) {
  const when = first ? recordedOnDate(first.createdAt, x.date) : null;
  return { ...makeEntry({
    id: x.id, date: x.date, time: when ? when.time : null,
    recordedAt: when ? new Date(first.createdAt).toISOString() : null, tz: when ? tz : null, timeSource: when ? 'mp4' : 'note',
    status: 'done', text: x.e.text, audio,
    source: { kind: 'apple-notes', batchId, raw: x.e.raw },
  }, now), updatedAt: 1 + audio.length };
}

/** 文件的时间：mp4 里的录音时间 → 文件修改时间（不一定准）→ 不知道（日期先填今天，时间空着） */
function guessTime(info) {
  const tz = systemTz();
  if (info.createdAt) { const p = localParts(info.createdAt); if (p) return { ...p, timeSource: 'mp4', recordedAt: new Date(info.createdAt).toISOString(), tz }; }
  if (info.lastModified) { const p = localParts(info.lastModified); if (p) return { ...p, timeSource: 'file', recordedAt: null, tz }; }
  return { date: today(), time: null, timeSource: null, recordedAt: null, tz: null };
}

// ======================================================================
// 从备忘录迁移：粘贴笔记 → 选录音（可选路径列表）→ 导入核对 → 确认导入
// ======================================================================
const EV_CLASS = { pathOrder: 'ev-path', titleInText: 'ev-title', nameDate: 'ev-date', mp4Date: 'ev-date', order: 'ev-order' };

function notesView(main, params, ctx) {
  const lang = ctx.lang();
  const sp = () => ctx.state.settings.speakers;
  let step = 'text';               // text | files | review | done
  let noteText = '', yearText = '', parsed = null;
  let files = [], reading = 0, pathText = '', pathList = [];
  let pairs = [], assign = new Map(), manual = new Set(), checked = new Set(), moved = new Set();
  const dateFix = new Map();
  let busy = false, result = null, players = [];
  let reDeleted = true;            // 之前导入过、后来删掉（或撤销了导入）的条目：再导一次时重新导入
  ctx.guard(() => step !== 'done' && !!(noteText.trim() || files.length));

  const body = h('div.page.im');
  const bar = h('div.bottom-bar.im-bar', { hidden: true });
  const backBtn = h('button.back.text', { type: 'button' });
  main.append(h('header.navbar', null, backBtn, h('span.nb-title', null, t('nav.importNotes')), h('span')), body, bar);
  const picker = filePicker(addFiles);
  main.append(picker);
  const offDrop = catchDrops(addFiles);

  const fileByName = () => new Map(files.map(f => [f.name, f]));
  const slotCount = () => (parsed ? parsed.entries.reduce((n, e) => n + (e.audioSlots || 0), 0) : 0);
  const killPlayers = () => { for (const p of players) p.destroy(); players = []; };
  const mkPlayer = (f) => { const p = audioPlayer({ getBlob: async () => f.blob, durationSec: f.durationSec, compact: true }); players.push(p); return p; };

  function reparse() {
    const y = Number(yearText);
    parsed = noteText.trim() ? parseNote(noteText, Number.isInteger(y) && y >= 1900 && y <= 2200 ? { defaultYear: y } : {}) : null;
  }

  function draw() {
    killPlayers();
    fill(backBtn, step === 'done' ? t('common.done') : step === 'text' ? t('common.cancel') : t('imp.n.prev'));
    backBtn.onclick = () => {
      if (step === 'files') go('text');
      else if (step === 'review') go(slotCount() ? 'files' : 'text');
      else ctx.back('/settings');
    };
    if (step === 'text') drawText();
    else if (step === 'files') drawFiles();
    else if (step === 'review') drawReview();
    else drawDone();
  }
  function go(s) {
    step = s;
    if (s === 'review') suggest();
    draw();
    (ctx.layout() === 'phone' ? window : main).scrollTo(0, 0);
  }
  const stepHead = (n, title) => h('p.im-step', null, h('span', null, t('imp.n.step', { n })), h('b', null, title));

  // ---------- 第 1 步：粘贴笔记文字 ----------
  function drawText() {
    const sum = h('div.im-sum-wrap', { 'aria-live': 'polite' });
    let timer = null;
    const ta = h('textarea.im-note', { rows: 10, value: noteText, placeholder: t('imp.n.textPh'), spellcheck: 'false', autocapitalize: 'off', 'aria-label': t('imp.n.textLabel'),
      oninput: () => { noteText = ta.value; clearTimeout(timer); timer = setTimeout(() => { reparse(); paint(); }, 200); } });
    const next = h('button.btn.primary.big.block', { type: 'button', onclick: () => { reparse(); if (parsed && parsed.entries.length) go(slotCount() ? 'files' : 'review'); } });
    function paint() {
      fill(sum, parsed ? parseSummary(parsed) : '');
      const n = slotCount();
      next.textContent = n ? t('imp.n.next2') : t('imp.n.next3');
      next.disabled = !(parsed && parsed.entries.length);
      bar.hidden = false;
    }
    fill(body, stepHead(1, t('imp.n.s1')),
      h('p.im-lead', null, t('imp.n.intro')),
      ta, sum);
    fill(bar, next);
    paint();
  }

  function parseSummary(p) {
    const years = new Map();
    for (const e of p.entries) if (e.date) years.set(e.date.slice(0, 4), (years.get(e.date.slice(0, 4)) || 0) + 1);
    const byKey = new Map(p.entries.map(e => [e.key, e]));
    const issues = p.issues || [];
    const needYear = issues.some(i => i.code === 'noYear');
    const yearIn = h('input.im-year', { type: 'number', inputmode: 'numeric', min: 1900, max: 2200, value: yearText, placeholder: String(new Date().getFullYear()),
      onchange: () => { yearText = yearIn.value.trim(); reparse(); draw(); } });
    const SHOW = 12;
    return h('section.card.im-sum', null,
      h('p.im-big', null, t('imp.n.entries', { n: p.entries.length }), h('span.im-sep', null, ' · '), t('imp.n.slots', { n: slotCount() })),
      years.size ? h('div.chips.im-years', null, [...years].sort().map(([y, n]) => h('span.pill', null, t('imp.n.year', { year: y, n })))) : null,
      p.title ? h('p.im-sub', null, t('imp.n.noteTitle', { title: p.title })) : null,
      issues.length ? h('div.im-issues', null,
        h('p.im-issues-h', null, t('imp.n.warnH', { n: issues.length })),
        h('ul', null, issues.slice(0, SHOW).map(i => {
          const e = i.key ? byKey.get(i.key) : null;
          return h('li', null, i.line ? h('span.im-line', null, t('imp.n.line', { line: i.line })) : null,
            e && e.dateText ? h('span.im-dt', null, e.dateText) : null, t('imp.warn.' + i.code));
        })),
        issues.length > SHOW ? h('p.small.muted', null, t('imp.n.more', { n: issues.length - SHOW })) : null) : null,
      needYear || yearText ? h('label.im-yearrow', null, h('span', null, t('imp.n.defaultYear')), yearIn) : null);
  }

  // ---------- 第 2 步：选录音文件（+ 可选的路径列表） ----------
  async function addFiles(list) {
    reading += list.length;
    if (step === 'files') drawFiles();
    for (const f of list) {
      const info = await readAudioFile(f);
      reading--;
      if (info.bad) toast(t('imp.n.badFile', { name: info.name, why: t('imp.skip.' + info.bad, { msg: info.msg || '', where: '' }) }), { ms: 8000 });
      else if (files.some(x => x.sha256 === info.sha256 || x.name === info.name)) toast(t('imp.n.dupFile', { name: info.name }));
      else files.push(info);
    }
    files.sort((a, b) => (a.createdAt ? +new Date(a.createdAt) : Infinity) - (b.createdAt ? +new Date(b.createdAt) : Infinity) || a.name.localeCompare(b.name));
    if (step === 'files') drawFiles();
    else if (step === 'review') { suggest(); draw(); }
    else if (files.length) toast(t('imp.n.filesAdded', { n: files.length }));
  }

  function drawFiles() {
    const slots = slotCount(), n = files.length;
    const countCls = n && n !== slots ? '.im-warn' : '';
    const pathInfo = h('p.f-help');
    const pathTa = h('textarea.im-paths', { rows: 4, value: pathText, placeholder: t('imp.n.pathPh'), spellcheck: 'false', autocapitalize: 'off', 'aria-label': t('imp.n.pathLabel'),
      oninput: () => { pathText = pathTa.value; paintPaths(); } });
    function paintPaths() {
      pathList = parsePathList(pathText);
      if (!pathList.length) { fill(pathInfo, t('imp.n.pathHelp')); pathInfo.classList.remove('im-warn'); return; }
      const names = new Set(files.map(f => f.name.toLowerCase()));
      const missing = pathList.filter(p => !names.has(nfc(p).toLowerCase()));
      pathInfo.classList.toggle('im-warn', missing.length > 0 || pathList.length !== slots);
      fill(pathInfo, t('imp.n.pathCount', { n: pathList.length, m: pathList.length - missing.length, slots }),
        missing.length ? h('span', null, ' ', t('imp.n.pathMissing', { names: missing.slice(0, 4).join('、') + (missing.length > 4 ? '…' : '') })) : '');
    }
    fill(body, stepHead(2, t('imp.n.s2')),
      h('p.im-lead', null, t('imp.n.filesIntro')),
      dropZone(
        h('button.btn.primary', { type: 'button', onclick: () => picker.click() }, icon('import'), n ? t('imp.pickMore') : t('imp.pick')),
        h('p.im-drop-hint', null, reading ? t('imp.reading', { n: reading }) : t('imp.drop'))),
      h('p.im-count' + countCls, { role: 'status' }, t('imp.n.filesCount', { n, slots }),
        n > slots ? h('span', null, ' · ', t('imp.n.filesMore', { n: n - slots })) : n && n < slots ? h('span', null, ' · ', t('imp.n.filesLess', { n: slots - n })) : ''),
      n ? h('div.group.im-files', null, files.map(f => h('div.group-row.im-file', null, mkPlayer(f),
        h('div.im-file-body', null, h('b', null, f.name),
          h('p.im-meta', null, metaLine(fmtBytes(f.size), fmtDuration(f.durationSec), f.createdAt ? instant(f.createdAt) : t('imp.n.noTime')))),
        h('button.icon-btn', { type: 'button', 'aria-label': t('imp.remove'), title: t('imp.remove'), onclick: () => { files = files.filter(x => x !== f); drawFiles(); } }, icon('x'))))) : null,
      h('label.f-label', { for: 'im-paths' }, t('imp.n.pathLabel')),
      Object.assign(pathTa, { id: 'im-paths' }), pathInfo);
    paintPaths();
    bar.hidden = false;
    fill(bar, h('button.btn.primary.big.block', { type: 'button', disabled: reading > 0, onclick: () => go('review') }, t('imp.n.next3')));
  }
  const instant = (d) => { const p = localParts(d); return p ? `${p.date} ${fmtTime(p.time, lang)}` : ''; };

  // ---------- 第 3 步：导入核对 ----------
  function suggest() {
    pairs = parsed ? suggestPairs(parsed.entries, files.map(f => ({ name: f.name, size: f.size, createdAt: f.createdAt, lastModified: f.lastModified })),
      { pathOrder: pathList.length ? pathList : undefined }) : [];
    assign = new Map(pairs.map(p => [p.slot, p.fileName]));
    manual = new Set(); checked = new Set(); moved = new Set();
  }
  function model() {
    const fixedK = new Map();
    const entries = (parsed ? parsed.entries : []).map(e => {
      const fix = dateFix.get(e.key);
      const date = e.date || (isISODate(fix) ? fix : null);
      let id = e.date ? e.key : null;
      if (!e.date && date) {           // 改好的日期：k 接在笔记里同一天的条目后面（同样的笔记、同样的改法 → 同样的 id，再导也不会重复）
        const base = parsed.entries.filter(x => x.date === date).length;
        const k = base + (fixedK.get(date) || 0) + 1;
        fixedK.set(date, (fixedK.get(date) || 0) + 1);
        id = `n_${date}_${k}`;
      }
      const ex = id ? ctx.entry(id) : null;
      const again = !!(ex && ex.deleted && ex.source && ex.source.kind === 'apple-notes');
      return { e, date, id, again, exists: !!ex && !(again && reDeleted), existsDeleted: !!(ex && ex.deleted), slots: pairs.filter(p => p.entryKey === e.key) };
    });
    return { entries, byKey: new Map(entries.map(x => [x.e.key, x])), clips: clipIndex(ctx.state) };
  }
  const isUncertain = (p) => !manual.has(p.slot) && (moved.has(p.slot) || p.conflict || p.confidence === 'weak' || !p.fileName);

  let lastSig = '';
  const existSig = () => model().entries.map(x => (x.exists ? 1 : 0) + (x.again ? 2 : 0)).join('');
  function drawReview() {
    killPlayers();
    const m = model(), fb = fileByName();
    lastSig = m.entries.map(x => (x.exists ? 1 : 0) + (x.again ? 2 : 0)).join('');
    const importable = m.entries.filter(x => !x.exists && x.date);
    const audioRows = pairs.filter(p => { const x = m.byKey.get(p.entryKey); return x && !x.exists; });
    const need = audioRows.filter(isUncertain).sort((a, b) => rank(a) - rank(b) || a.slot - b.slot);
    const ok = audioRows.filter(p => !isUncertain(p));
    const left = need.filter(p => !checked.has(p.slot) && m.byKey.get(p.entryKey).date);
    const usedNames = new Set([...assign.values()].filter(Boolean));
    const unused = files.filter(f => !usedNames.has(f.name));
    const noAudio = m.entries.filter(x => !x.e.audioSlots && !x.exists && x.date);
    const existing = m.entries.filter(x => x.exists);
    const again = m.entries.filter(x => x.again && x.date);
    const bad = m.entries.filter(x => !x.e.date);
    const legend = {};
    for (const p of audioRows) if (assign.get(p.slot) && !manual.has(p.slot) && !moved.has(p.slot)) for (const c of p.evidence) legend[c] = (legend[c] || 0) + 1;

    fill(body, stepHead(3, t('imp.n.s3')),
      h('section.card.im-sum', null,
        h('p.im-big', null, t('imp.r.big', { files: files.length, slots: slotCount() })),
        h('p.im-sub', null, t('imp.r.sub')),
        h('p.im-sub', null, t('imp.r.total', { n: m.entries.length, m: m.entries.filter(x => !x.e.audioSlots).length })),
        again.length ? h('label.im-again', null, h('input', { type: 'checkbox', checked: reDeleted, onchange: (e) => { reDeleted = e.target.checked; drawReview(); } }),
          h('span', null, t('imp.r.again', { n: again.length }))) : null,
        Object.keys(legend).length ? h('div.im-legend', null, Object.keys(EV_CLASS).filter(c => legend[c]).map(c => h('span.ev.' + EV_CLASS[c], null, t('imp.ev.' + c), ' ', legend[c]))) : null),
      need.length ? section(t('imp.r.needH'), need.length, need.map(p => slotRow(p, m, fb, true))) : null,
      ok.length ? section(t('imp.r.okH'), ok.length, ok.map(p => slotRow(p, m, fb, false))) : null,
      bad.length ? section(t('imp.r.badDateH'), bad.length, bad.map(x => badDateRow(x)), t('imp.r.badDateHelp')) : null,
      unused.length ? section(t('imp.r.unusedH'), -unused.length, unused.map(f => h('div.im-r', null, mkPlayer(f),
        h('div.im-r-body', null, h('p.im-r-file', null, f.name), h('p.im-meta', null, metaLine(fmtBytes(f.size), fmtDuration(f.durationSec), f.createdAt ? instant(f.createdAt) : ''))))), t('imp.r.unusedHelp')) : null,
      noAudio.length ? folded(t('imp.r.noAudioH'), noAudio.length, noAudio.map(x => entryLine(x))) : null,
      existing.length ? folded(t('imp.r.existsH'), existing.length, existing.map(x => entryLine(x, x.existsDeleted ? t('imp.r.existsDeleted') : t('imp.r.exists')))) : null,
      h('p.im-foot', null, t('imp.r.foot')));

    const n = importable.length;
    const goBtn = h('button.btn.primary.big.block', { type: 'button', 'aria-disabled': busy || !n || left.length ? 'true' : null,
      onclick: () => {
        if (busy || !n) return;
        if (left.length) {
          const el = body.querySelector(`[data-slot="${left[0].slot}"]`);
          if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
          toast(t('imp.r.leftToast', { n: left.length }), { ms: 6000 });
          return;
        }
        doImport();
      } }, busy ? t('imp.importing') : n ? t('imp.r.go', { n }) : t('imp.r.nothing'));
    bar.hidden = false;
    fill(bar, left.length && n ? h('p.im-left', { role: 'status' }, t('imp.r.left', { n: left.length })) : '', goBtn);
  }
  const rank = (p) => (p.conflict && !moved.has(p.slot) ? 0 : !assign.get(p.slot) ? 1 : moved.has(p.slot) ? 2 : 3);
  const section = (title, n, rows, foot) => h('section.im-sec', null,
    h('p.group-h', null, title, h('small', null, n < 0 ? t('imp.r.countFiles', { n: -n }) : t('imp.r.count', { n }))),
    h('div.group.im-group', null, rows), foot ? h('p.group-foot', null, foot) : null);
  const folded = (title, n, rows) => h('details.im-fold', null,
    h('summary.group-h', null, title, h('small', null, t('imp.r.count', { n }))),
    h('div.group.im-group', null, rows));

  const firstLine = (e) => firstNNLine(e.text, sp()) || (e.text.split('\n').find(l => l.trim()) || '').trim();
  const firstText = (e) => { const l = firstLine(e); return h('span.kai', null, l ? sayNodes(l) : t('imp.r.empty')); };   // 说的话楷体、动作普通字体
  function noteLine(x, p) {
    const multi = x.e.audioSlots > 1;
    return h('p.im-r-note', null, h('small', null, '↔ ', t('imp.r.note')), h('span.im-dt', null, x.e.dateText),
      firstText(x.e),
      multi ? h('small.im-slotn', null, t('imp.r.slotN', { n: p.entrySlot + 1 })) : null);
  }
  function entryLine(x, tag) {
    return h('div.im-r.im-r-plain', null,
      h('div.im-r-body', null,
        h('p.im-r-file', null, x.date ? fmtDate(x.date, lang) : x.e.dateText, tag ? h('span.tag.neutral', null, tag) : null),
        h('p.im-r-note', null, firstText(x.e))));
  }
  function badDateRow(x) {
    const inp = h('input.im-date', { type: 'date', value: dateFix.get(x.e.key) || '', 'aria-label': t('imp.date'),
      onchange: () => { if (inp.value) dateFix.set(x.e.key, inp.value); else dateFix.delete(x.e.key); drawReview(); } });
    return h('div.im-r', null, h('div.im-r-body', null,
      h('p.im-r-file', null, x.e.dateText, ' ', h('span.ev.ev-flag', null, t('imp.warn.' + (x.e.warnings.includes('noYear') ? 'noYear' : 'badDate')))),
      h('p.im-r-note', null, firstText(x.e)),
      h('label.im-f', null, h('span', null, t('imp.date')), inp)));
  }

  function slotRow(p, m, fb, uncertain) {
    const x = m.byKey.get(p.entryKey);
    const name = assign.get(p.slot) || null;
    const f = name ? fb.get(name) : null;
    const isManual = manual.has(p.slot), isMoved = moved.has(p.slot);
    const when = f && x.date ? recordedOnDate(f.createdAt, x.date) : null;
    const dateText = x.date ? (when ? `${x.date} ${fmtTime(when.time, lang)}` : `${x.date}${t('imp.r.noteDate')}`) : x.e.dateText;
    const chips = [];
    if (f && !isManual && !isMoved) {
      for (const c of p.evidence) chips.push(h('span.ev.' + EV_CLASS[c], null, c === 'titleInText' && p.titleMatch === 'partial' ? t('imp.ev.titlePartial') : t('imp.ev.' + c)));
      if (p.conflict) for (const c of p.conflicts) chips.push(h('span.ev.ev-flag', null, t('imp.cf.' + c)));
    }
    if (isManual) chips.push(h('span.ev.ev-manual', null, t('imp.r.manual')));
    if (isMoved) chips.push(h('span.ev.ev-flag', null, f ? t('imp.r.moved') : t('imp.r.movedNone')));
    const dupIds = f ? (m.clips.get(f.sha256) || []) : [];
    if (dupIds.length) chips.push(h('span.ev.ev-flag', null, t('imp.r.dupClip', { where: clipWhere(ctx.entry(dupIds[0]), f.sha256, sp(), lang) })));
    let why = null;
    if (!isManual && !isMoved && uncertain) {
      if (!f) why = t('imp.r.why.none');
      else if (!p.conflict && p.evidence.length <= 1) why = p.evidence[0] === 'order' ? t('imp.r.why.order') : t('imp.r.why.one');
    }
    const sel = h('select.im-sel', { 'aria-label': t('imp.r.reassign'), onchange: (e) => reassign(p.slot, e.target.value || null) },
      h('option', { value: '', selected: !name }, t('imp.r.none')),
      files.map(ff => {
        const other = [...assign].find(([s2, n2]) => s2 !== p.slot && n2 === ff.name);
        const otherKey = other && pairs.find(q => q.slot === other[0]);
        const label = otherKey ? t('imp.r.usedBy', { name: ff.name, what: (m.byKey.get(otherKey.entryKey) || {}).e?.dateText || '' }) : ff.name;
        return h('option', { value: ff.name, selected: name === ff.name }, label);
      }));
    const done = checked.has(p.slot);
    const check = uncertain && !isManual ? h('button.chip.im-ok', { type: 'button', 'aria-pressed': String(done), onclick: () => { if (done) checked.delete(p.slot); else checked.add(p.slot); drawReview(); } },
      icon('check'), done ? t('imp.r.checked') : t('imp.r.ok')) : null;
    const reassignBox = uncertain ? h('div.im-reassign', null, h('span.small.muted', null, t('imp.r.reassign')), sel, check)
      : h('details.im-reassign-fold', null, h('summary.small', null, t('imp.r.reassign')), h('div.im-reassign', null, sel));
    const cls = uncertain ? (done ? '.im-r.checked' : '.im-r.uncertain') : '.im-r';
    return h('div' + cls, { dataset: { slot: String(p.slot) } },
      f ? mkPlayer(f) : h('span.im-noplay', { 'aria-hidden': 'true' }, icon('mic')),
      h('div.im-r-body', null,
        h('div.im-r-top', null, h('p.im-r-file' + (f ? '' : '.none'), null, f ? f.name : t('imp.r.noFile')),
          !uncertain && chips.length === 1 ? chips.shift() : null),
        h('p.im-meta', null, metaLine(f ? fmtBytes(f.size) : null, f ? fmtDuration(f.durationSec) : null, dateText)),
        noteLine(x, p),
        chips.length ? h('div.im-chips', null, chips) : null,
        why ? h('p.im-why', null, why) : null,
        reassignBox));
  }

  function reassign(slot, name) {
    const prev = assign.get(slot) || null;
    if (name) {
      for (const [s2, n2] of [...assign]) {
        if (s2 !== slot && n2 === name) { assign.set(s2, prev); manual.delete(s2); checked.delete(s2); moved.add(s2); }   // 两个位置互换
      }
    }
    assign.set(slot, name);
    manual.add(slot); moved.delete(slot);
    drawReview();
  }

  // ---------- 第 4 步：写入 ----------
  async function doImport() {
    busy = true; drawReview(); stopAll();
    const m = model(), fb = fileByName();
    const now = Date.now(), batchId = newId('b_'), tz = systemTz();
    const todo = m.entries.filter(x => !x.exists && x.date);
    const clipOf = new Map();
    try {
      for (const x of todo) for (const p of x.slots) {
        const name = assign.get(p.slot);
        if (!name || clipOf.has(name)) continue;
        const f = fb.get(name);
        if (!f) continue;
        const saved = await ctx.audio.putClip(f.blob, { mime: f.mime });
        clipOf.set(name, { sha256: saved.sha256, mime: saved.mime || f.mime, bytes: saved.bytes ?? f.size, durationSec: f.durationSec, origName: f.name, addedAt: now });
      }
    } catch (e) {
      busy = false; drawReview();
      toast(t('imp.saveFail', { msg: (e && e.message) || String(e) }), { ms: 9000 });
      return;
    }
    const gone = (e) => !e || (reDeleted && e.deleted && e.source && e.source.kind === 'apple-notes');   // 没有，或者是删掉的导入条目（重新导入盖掉删除标记）
    const fresh = todo.filter(x => gone(ctx.entry(x.id)));
    let withAudio = 0;
    ctx.mutate(s => {
      for (const x of fresh) {
        if (!gone(s.data.entries[x.id])) continue;          // 再查一次：同一份笔记导两次也不会重复
        const names = x.slots.map(p => assign.get(p.slot)).filter(Boolean);
        const audio = [];
        for (const nm of names) { const c = clipOf.get(nm); if (c && !audio.some(a => a.sha256 === c.sha256)) audio.push(c); }
        const first = names.length ? fb.get(names[0]) : null;
        s.data.entries[x.id] = noteEntry(x, audio, first, { now, batchId, tz });
        if (audio.length) withAudio++;
      }
    }, { undoLabel: fresh.length ? t('imp.r.undo', { n: fresh.length }) : null });
    result = { n: fresh.length, withAudio, skipped: m.entries.filter(x => x.exists).length + (todo.length - fresh.length), bad: m.entries.filter(x => !x.exists && !x.date).length };
    busy = false;
    go('done');
  }

  function drawDone() {
    const r = result || { n: 0, withAudio: 0, skipped: 0 };
    fill(body,
      h('section.card.im-done', null,
        h('p.im-done-ic', { 'aria-hidden': 'true' }, icon('check')),
        h('p.im-big', null, t('imp.r.done', { n: r.n })),
        r.withAudio ? h('p.im-sub', null, t('imp.r.doneAudio', { n: r.withAudio })) : null,
        r.skipped ? h('p.im-sub', null, t('imp.r.doneSkipped', { n: r.skipped })) : null,
        r.bad ? h('p.im-sub.im-warn', null, t('imp.r.doneBad', { n: r.bad })) : null),
      h('p.group-h', null, t('set.backupH')),
      h('section.card', null, h('p.im-lead', null, t('imp.r.backupHint')), backupBox(ctx)));
    bar.hidden = false;
    fill(bar, h('button.btn.big.block', { type: 'button', onclick: () => ctx.navigate('/') }, t('imp.r.view')));
  }

  for (const f of [ctx.takeFiles()].filter(Boolean)) addFiles(f);
  draw();
  return {
    // 别的设备同步来同 id 的条目：标成「已存在」。只在「已存在」有变化时重画（不打断正在试听的录音）
    onChange: () => { if (step !== 'review' || busy) return; const sig = existSig(); if (sig !== lastSig) drawReview(); },
    cleanup: () => { offDrop(); killPlayers(); },
  };
}
