// 梦话详情（#/e/<id>）：日期、时间来源、录音（每段下面可以「转成文字（草稿）」）、草稿、对话气泡（原话一个字不改）、那天的背景、「整理好了」。
// 气泡：NN 在左（浅玫瑰底 + 头像表情），我在右（卡片底）；只有表情的反应画成大表情；旁白居中；空行是分段；
// 引号里是说的话（楷体），引号外是动作 / 环境（普通字体、小一点、淡一点）；整行都是动作的画成浅浅的「动作」气泡（sayNodes，列表卡片也用）。
// 「👰🏻‍♀️：」后面跟着录音的地方画成「🎙 录音」小标签，点了滚到播放器。
// 每段录音上面是它的名字（clips.js 的显示名），点了改名（renameClipSheet，编辑页也用）。
// 自己管更新（返回 onChange）：数据变了原地重画、保留滚动；删除后正在离开时不重画。
// 也导出给别的页面用的：readClipFiles（选来的录音文件 → 存进本机录音库）、chatView、sayNodes、clipCaption、renameClipSheet。
// #/e/<id>/history（params.sub === 'history'）是修改记录页，在 views/history.js。
import { h, icon, copyText, download } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { clipTranscriber, draftView } from '../ui/stt.js';
import { fmtEntryDate, fmtDate, fmtTime, fmtYear, fmtInstant, localParts, systemTz } from '../core/dates.js';
import { parseDialogue, firstNNLine, segments, isDescOnly } from '../core/dialogue.js';
import { highlight } from '../core/search.js';
import { clipLabel, clipFileStem, ownName, origBase, renameClip, CLIP_NAME_MAX } from '../core/clips.js';
import { readMp4Meta } from '../core/mp4meta.js';
import { mimeForFile, baseMime, extForMime } from '../core/audioStore.js';
import { splitExt, sanitizeFileName } from '../core/util.js';
import { t } from '../i18n.js';
import { render as renderHistory, lastEditedLine, fmtAgo } from './history.js';
import { deletionBy } from '../core/history.js';
import { byLabel } from './device.js';

/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');

export const AUDIO_ACCEPT = '.m4a,audio/mp4,audio/x-m4a,audio/*';
const AUDIO_EXT = new Set(['m4a', 'mp4', 'aac', 'caf', 'wav', 'webm', 'ogg', 'opus', 'mp3']);
const enc = encodeURIComponent;

// ---------- 对话气泡 ----------

/** 连续同一个人说的行并成一组（头像只画一次）→ [{ type:'run', who, items }, { type:'narration' }, { type:'gap' }] */
export function chatRuns(blocks) {
  const out = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === 'line' && last && last.type === 'run' && last.who === b.who) last.items.push(b);
    else out.push(b.type === 'line' ? { type: 'run', who: b.who, items: [b] } : b);
  }
  return out;
}

/**
 * 一行原话 → 节点（原文一个字不改，只是分段换字体）：引号里说的话 span.say（楷体），引号外的动作 / 环境 span.desc。
 * q：搜索词，命中的地方包上 <mark>（可以跨过说的话和动作的分界）
 */
export function sayNodes(content, q = '') {
  const s = String(content ?? '');
  const marks = q && String(q).trim() ? highlight(s, q) : null;
  let at = 0;
  return segments(s).map(g => {
    const a = at, b = (at += g.text.length);
    return h(g.kind === 'speech' ? 'span.say' : 'span.desc', null, marks ? cutMarks(marks, a, b) : g.text);
  });
}
/** highlight() 的结果里 [a, b) 这一段 → 文字和 <mark> */
function cutMarks(marks, a, b) {
  const out = [];
  let at = 0;
  for (const m of marks) {
    const x = Math.max(a, at), y = Math.min(b, at + m.text.length);
    if (x < y) { const piece = m.text.slice(x - at, y - at); out.push(m.hit ? h('mark', null, piece) : piece); }
    at += m.text.length;
    if (at >= b) break;
  }
  return out;
}

/**
 * 把原话画成聊天气泡
 * @param {string} text
 * @param {object} speakers   settings.speakers
 * @param {{ onCue?: () => void, hasAudio?: boolean }} [o]
 */
export function chatView(text, speakers, { onCue = null, hasAudio = false } = {}) {
  const names = { nn: speakers.nn.name || 'NN', me: speakers.me.name || t('edit.me') };
  let cues = 0;                                    // 第 k 个「录音」标签对应第 k 段录音（备忘录里就是这个顺序）
  return h('div.chat', null, chatRuns(parseDialogue(text, speakers)).map(r => {
    if (r.type === 'gap') return h('div.chat-gap', { 'aria-hidden': 'true' });
    if (r.type === 'narration') return h('p.chat-narr', null, sayNodes(r.content));
    const who = h('span.sr-only', null, names[r.who] + '：');
    return h('div.run.run-' + r.who, null,
      h('span.av', { 'aria-hidden': 'true', title: names[r.who] }, speakers[r.who].emoji),
      h('div.run-body', null, r.items.map(b => {
        if (b.audioCue) {
          const k = cues++;
          return h('button.cue', { type: 'button', disabled: !hasAudio, title: hasAudio ? null : t('entry.cueNone'), onclick: () => onCue && onCue(k) },
            who.cloneNode(true), icon('mic'), t('entry.cue'));
        }
        if (b.reactionOnly) return h('p.react', null, who.cloneNode(true), b.content);
        return h('p.bubble' + (isDescOnly(b.content) ? '.act' : ''), null, who.cloneNode(true), sayNodes(b.content));   // .act：整行都是动作
      })));
  }));
}

// ---------- 录音文件 ----------

/** 读录音时长：mp4 头里没有（比如分片录音）时用 <audio> 读一下；读不到 → null */
export function probeDuration(blob, ms = 4000) {
  return new Promise(resolve => {
    let a = null, url = null, done = false;
    const fin = (v) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (a) { a.removeAttribute('src'); try { a.load(); } catch (e) { /* 已释放 */ } }
      if (url) URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) && v > 0 ? v : null);
    };
    const timer = setTimeout(() => fin(null), ms);
    try {
      a = new Audio(); a.preload = 'metadata';
      a.onloadedmetadata = () => fin(a.duration); a.onerror = () => fin(null);
      url = URL.createObjectURL(blob); a.src = url;
    } catch (e) { fin(null); }
  });
}

/**
 * 选来的录音文件 → 存进本机录音库（同一段只存一份）→ [{ clip, createdAt }]
 * clip 是条目 audio 里的一项；createdAt 是文件头里的录音时间（Date | null）。不能用的文件弹提示、跳过。
 */
export async function readClipFiles(files, ctx) {
  const out = [], notes = [];
  for (const f of files) {
    const [, ext] = splitExt(f.name);
    if (ext === 'qta') { notes.push(t('entry.qta', { name: f.name })); continue; }
    if (!AUDIO_EXT.has(ext) && !/^audio\//.test(f.type || '')) { notes.push(t('entry.notAudio', { name: f.name })); continue; }
    try {
      const mime = mimeForFile(f);
      const buf = await f.arrayBuffer();
      const meta = readMp4Meta(buf);                       // 不是 mp4 也不抛错，全是 null
      const blob = new Blob([buf], { type: mime });
      const saved = await ctx.audio.putClip(blob, { mime });
      const dur = meta.durationSec || await probeDuration(blob);
      out.push({
        clip: { sha256: saved.sha256, mime: saved.mime || mime, bytes: saved.bytes ?? blob.size, durationSec: dur ? Math.round(dur * 10) / 10 : null, origName: f.name, addedAt: Date.now() },
        createdAt: meta.createdAt || null,
      });
    } catch (e) { notes.push(t('entry.audioFail', { name: f.name, msg: (e && e.message) || String(e) })); }
  }
  if (notes.length) ctx.toast(notes.join('\n'), { ms: 9000 });
  return out;
}

// ---------- 分享 ----------
const QUOTES = /[“”‘’「」『』"'＂＇]/g;
/**
 * 分享出去的录音文件名：录音有名字（起的名字 / 原文件名）→「名字.m4a」（几段同名的加 (2)）；
 * 没有 → 「2026-11-04 NN 的第一句.m4a」（几段的加 (2)；条目没有标题）
 */
export function shareName(e, clip, i, speakers) {
  const ext = '.' + extForMime(clip.mime);
  const stem = clipFileStem(clip);
  if (stem) {
    const same = e.audio.filter((a, k) => k < i && clipFileStem(a) === stem).length;
    return stem + (same ? ` (${same + 1})` : '') + ext;
  }
  const words = sanitizeFileName(String(firstNNLine(e.text, speakers) || '').replace(QUOTES, ''), 24);
  return sanitizeFileName(`${e.date}${words ? ' ' + words : ''}`, 60) + (e.audio.length > 1 ? ` (${i + 1})` : '') + ext;
}

// ---------- 录音的名字 ----------
const fallbackName = (n) => t('clip.fallback', { n });

/** 播放器上面的一行：录音的名字 + ✎，点了改名 */
export function clipCaption(clip, i, onRename) {
  const name = clipLabel(clip, i, fallbackName);
  return h('button.clip-cap', { type: 'button', 'aria-label': t('clip.renameLabel', { name }), title: t('clip.rename'), onclick: onRename },
    h('span.clip-cap-name', null, name), icon('pencil'));
}

/**
 * 改名的小窗（不在页面里，同步重画页面时不会打断输入）。点「保存」→ onSave(输入的名字)：
 * 调用的地方用 renameClip(最新的 audio, sha, 名字) 改（空着 = 回到默认名：原文件名，没有就是「录音 1」；整理规则见 core/clips.js）
 */
export function renameClipSheet(ctx, clip, i, onSave) {
  const def = origBase(clip) || fallbackName(i + 1);
  const input = h('input.clip-name-in', { type: 'text', value: ownName(clip) || origBase(clip), placeholder: def, maxlength: CLIP_NAME_MAX,
    autocomplete: 'off', enterkeyhint: 'done', 'aria-label': t('clip.renameTitle'),
    onkeydown: (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); save(); } } });
  const s = ctx.sheet(h('div.clip-ren', null, input,
    h('p.f-help', null, t('clip.renameHint', { name: def })),
    clip.origName && ownName(clip) ? h('p.f-help', null, t('clip.origName', { name: clip.origName })) : null), {
    title: t('clip.renameTitle'), cls: 'clip-ren-sheet',
    foot: [h('button.btn', { type: 'button', onclick: () => s.close() }, t('common.cancel')),
      h('button.btn.primary', { type: 'button', onclick: () => save() }, t('common.save'))],
  });
  function save() { s.close(); onSave(input.value); }
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return s;
}
/** 分享出去的文字：日期行、空一行、原话（原样；条目没有标题） */
export function shareText(e, lang) {
  return [fmtEntryDate(e, lang), '', e.text].join('\n').trim();
}

function weekday(date, lang) {
  const [y, m, d] = String(date).split('-').map(Number);
  try { return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : lang === 'zh-Hant-TW' ? 'zh-TW' : 'zh-CN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d))); }
  catch (e) { return ''; }
}

// ---------- 页面 ----------
export function render(main, params, ctx) {
  if (params.sub === 'history') return renderHistory(main, params, ctx);
  const id = params.id;
  let players = [], leaving = false, share = { key: null, ready: null };
  const sp = () => ctx.state.settings.speakers;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fileInput = h('input', { type: 'file', accept: AUDIO_ACCEPT, multiple: true, hidden: true,
    onchange: (ev) => { const fl = [...ev.target.files]; ev.target.value = ''; if (fl.length) addFiles(fl); } });

  const navbar = (actions) => h('header.navbar', null,
    params.pane === 'detail' ? h('span') : h('button.back', { type: 'button', onclick: () => ctx.back('/') }, icon('back'), t('nav.list')),
    h('span'), actions || h('span'));

  function build() {
    const e = ctx.entry(id);
    if (!e) return [navbar(), h('div.page', null, h('p.empty', null, t('common.notFound')))];
    if (e.deleted) {
      // 已删除（从「最近删除」点进来）：只读地看一眼原话，决定要不要恢复
      const by = byLabel(deletionBy(e), sp());
      return [navbar(), h('article.page.entry.e-gone', null,
        h('div.e-banner', { role: 'status' }, h('span', null, t('entry.deleted'), by ? h('small.e-banner-by', null, t('hist.deletedBy', { by, when: fmtAgo(e.deletedAt, ctx.lang()) })) : null),
          h('button.btn.small.soft', { type: 'button', onclick: () => ctx.restore(id) }, t('common.restore'))),
        h('header.e-head', null, h('h1.e-big', null, fmtEntryDate(e, ctx.lang(), { sep: daySep(ctx.lang()) }))),
        e.text.trim() ? chatView(e.text, sp()) : null,
        h('p.e-foot.e-by', null, h('a', { href: '#/e/' + enc(id) + '/history' }, t('hist.title'))))];
    }
    const lang = ctx.lang();
    prepShare(e);
    const actions = h('span.nb-actions', null,
      h('button.icon-btn.e-fav', { type: 'button', 'aria-pressed': String(e.fav), 'aria-label': t(e.fav ? 'list.unfav' : 'list.fav'), title: t(e.fav ? 'list.unfav' : 'list.fav'),
        onclick: () => ctx.update(id, { fav: !e.fav }) }, icon('star')),
      h('button.icon-btn', { type: 'button', 'aria-label': t('common.share'), title: t('common.share'), onclick: () => doShare(e) }, icon('share')),
      h('button.icon-btn', { type: 'button', 'aria-label': t('common.more'), title: t('common.more'), onclick: () => menu(e) }, icon('more')));

    // 页头：日期 + 时间最大（条目没有标题）
    const wd = weekday(e.date, lang);
    const big = fmtDate(e.date, lang, { year: false }) + (e.time ? daySep(lang) + fmtTime(e.time, lang) : '');
    const sub = fmtYear(e.date.slice(0, 4), lang);
    const chips = [
      e.timeSource ? h('span.pill', null, icon('clock'), t('entry.src.' + e.timeSource)) : null,
      e.status === 'inbox' ? h('span.pill.rose', null, t('entry.inbox')) : null,
      e.source.kind === 'apple-notes' ? h('span.pill', null, t('entry.fromNotes')) : null,
      e.source.kind === 'audio-import' ? h('span.pill', null, t('entry.fromImport')) : null,
      e.source.kind === 'recovered' ? h('span.pill.amber', null, t('entry.recovered')) : null,
      e.badDate ? h('span.pill.amber', null, t('entry.badDate', { date: e.badDate })) : null,
    ].filter(Boolean);

    const clips = e.audio.map((c, i) => {
      const p = audioPlayer({ getBlob: () => ctx.clipBlob(c.sha256), durationSec: c.durationSec, key: c.sha256 });
      players.push(p);
      const cap = clipCaption(c, i, () => rename(c.sha256));
      return h('div.e-clip', null, cap, p, clipTranscriber(ctx, e, c));     // 「转成文字（草稿）」
    });

    const nn = sp().nn.name || 'NN';
    const words = e.text.trim()
      ? chatView(e.text, sp(), { hasAudio: e.audio.length > 0, onCue: toPlayer })
      : h('a.e-write', { href: '#/edit/' + enc(id) }, h('span.kai', null, t('entry.noTextHint', { nn })), h('span.btn.soft.small', null, icon('pencil'), t('entry.write')));

    // 「记于」只给在 App 里记的（导入的条目创建时间是导入那天，写出来会误导）
    const showCreated = e.createdAt && (e.source.kind === 'app' || e.source.kind === 'recovered');
    return [
      navbar(actions),
      h('article.page.entry', null,
        h('header.e-head', null,
          h('h1.e-big', null, big),
          h('p.e-sub', null, h('span', null, [sub, wd].filter(Boolean).join(' · ')),
            h('a.e-edit', { href: '#/edit/' + enc(id), 'aria-label': t('entry.editDate'), title: t('entry.editDate') }, icon('pencil'))),
          chips.length ? h('div.e-chips', null, chips) : null),
        clips.length ? h('div.e-audio', null, clips) : null,
        draftView(ctx, e),               // 草稿紧跟在录音下面：边听边改，「填进原话」
        words,
        e.note && e.note.trim() ? h('section.e-note', null, h('h2.e-h', null, t('entry.note')), h('div.e-note-body', null, e.note)) : null,
        showCreated ? h('p.e-foot', null, t('entry.created', { time: fmtInstant(e.createdAt, lang, { year: true }) })) : null,
        lastEditedLine(e, ctx)),
      e.status === 'inbox' ? h('div.bottom-bar.e-done', null,
        h('button.btn.primary.big', { type: 'button', onclick: () => ctx.update(id, { status: 'done' }, { undoLabel: t('entry.doneToast') }) }, icon('check'), t('entry.done'))) : null,
      fileInput,
    ];
  }

  function draw(first = false) {
    const sc = ctx.layout() === 'phone' ? document.scrollingElement : main;
    const top = sc ? sc.scrollTop : 0;
    for (const p of players) p.destroy();
    players = [];
    main.replaceChildren(...build().filter(Boolean));
    if (!first && sc) sc.scrollTop = top;
  }

  // 「🎙 录音」标签：滚到对应的播放器（第 k 个标签 → 第 k 段，多出来的标签 → 最后一段），焦点放到 ▶
  function toPlayer(k = 0) {
    const p = players[Math.min(k, players.length - 1)];
    if (!p) return;
    p.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash');
    const btn = p.querySelector('button');
    if (btn) btn.focus({ preventScroll: true });
  }

  // ---------- 录音改名 ----------
  function rename(sha) {
    const e = ctx.entry(id);
    const i = e ? e.audio.findIndex(a => a.sha256 === sha) : -1;
    if (i < 0) return;
    renameClipSheet(ctx, e.audio[i], i, (name) => {
      const cur = ctx.entry(id);                 // 小窗开着的时候可能同步进来了新的录音列表：在最新的上面改
      if (!cur || cur.deleted) return;
      const next = renameClip(cur.audio, sha, name);
      if (next !== cur.audio) ctx.update(id, { audio: next }, { undoLabel: t('clip.renamed') });
    });
  }

  // ---------- ⋯ 菜单 ----------
  function menu(e) {
    const lang = ctx.lang();
    ctx.sheet((api) => {
      const row = (ic, label, fn, cls = '') => h('button.group-row' + cls, { type: 'button', onclick: () => { api.close(); fn(); } }, icon(ic), h('span', null, label));
      return h('div.group.e-menu', null,
        row('pencil', t('common.edit'), () => ctx.navigate('/edit/' + enc(id))),
        row('import', t('entry.addAudio'), () => fileInput.click()),
        row('mic', t('entry.recordNow'), () => ctx.navigate('/rec?attach=' + enc(id))),
        e.status === 'inbox'
          ? row('check', t('entry.done'), () => ctx.update(id, { status: 'done' }, { undoLabel: t('entry.doneToast') }))
          : row('clock', t('entry.markInbox'), () => ctx.update(id, { status: 'inbox' }, { undoLabel: t('entry.inboxToast') })),
        row('history', t('hist.title'), () => ctx.navigate('/e/' + enc(id) + '/history')),
        row('trash', t('common.delete'), remove, '.danger'));
    }, { title: fmtEntryDate(e, lang, { sep: daySep(lang) }), cls: 'e-menu-sheet' });
  }
  function remove() {
    leaving = true;                       // 删掉以后不在这页重画「已删除」，直接回列表（10 秒内可以撤销）
    if (params.pane === 'detail') ctx.navigate(ctx.home(), { replace: true }); else ctx.back('/');     // 双栏：回到列表或日历（看用户上次选的）
    ctx.remove(id);
  }

  // ---------- 添加录音（文件） ----------
  async function addFiles(fl) {
    const got = await readClipFiles(fl, ctx);
    const e = ctx.entry(id);
    if (!e || e.deleted || !got.length) return;
    const have = new Set(e.audio.map(a => a.sha256)), notes = [];
    const elsewhere = new Set(ctx.entries().filter(x => x.id !== id).flatMap(x => x.audio.map(a => a.sha256)));
    const fresh = got.filter(g => {
      if (have.has(g.clip.sha256)) { notes.push(t('entry.audioDup', { name: g.clip.origName })); return false; }
      if (elsewhere.has(g.clip.sha256)) notes.push(t('entry.audioElsewhere', { name: g.clip.origName }));
      have.add(g.clip.sha256);
      return true;
    });
    if (!fresh.length) { ctx.toast(notes.join('\n')); return; }
    ctx.update(id, { audio: [...e.audio, ...fresh.map(g => g.clip)] });
    // 这条还不知道时间、录音文件里的时间正好是同一天 → 问一句要不要用（不自动改）
    const tz = e.tz || systemTz();
    const at = !e.time && fresh.map(g => g.createdAt).find(Boolean);
    const p = at ? localParts(at, tz || undefined) : null;
    const msg = [t('entry.audioAdded', { n: fresh.length }), ...notes].join('\n');
    if (p && p.date === e.date) {
      ctx.toast(msg, { ms: 10000, action: { label: t('entry.useRecTime', { time: fmtTime(p.time, ctx.lang()) }),
        run: () => ctx.update(id, { time: p.time, recordedAt: at.toISOString(), tz, timeSource: 'mp4' }) } });
    } else ctx.toast(msg);
  }

  // ---------- 分享 ----------
  // 本机有的录音进页面就读好：navigator.share 要在点按的那一刻调用，来不及先读数据库
  function prepShare(e) {
    const key = e.audio.map((a, i) => a.sha256 + '|' + shareName(e, a, i, sp())).join(',');   // 改了名也要重新准备（文件名变了）
    if (share.key === key) return;
    share = { key, ready: null };
    const mine = share;
    Promise.all(e.audio.map(async (c, i) => {
      const rec = await ctx.audio.getClip(c.sha256).catch(() => null);
      return rec && rec.blob ? new File([rec.blob], shareName(e, c, i, sp()), { type: baseMime(c.mime) || 'audio/mp4' }) : null;
    })).then(fs => { mine.ready = fs; }, () => { mine.ready = e.audio.map(() => null); });
  }
  function doShare(e) {
    const text = shareText(e, ctx.lang());
    const ready = share.ready;
    if (e.audio.length && (!ready || ready.some(f => !f))) { shareLater(e, text); return; }
    sendShare(text, ready || []);
  }
  // 录音不在本机：先下载（可能要等），再给一个新的「分享」按钮（分享必须在点按里发起）
  function shareLater(e, text) {
    const s = ctx.sheet(h('p.muted', null, t('player.loading')), { title: t('common.share') });
    Promise.all(e.audio.map(async (c, i) => {
      const blob = await ctx.clipBlob(c.sha256).catch(() => null);
      return blob ? new File([blob], shareName(e, c, i, sp()), { type: baseMime(c.mime) || 'audio/mp4' }) : null;
    })).then(fs => {
      const files = fs.filter(Boolean);
      s.body.replaceChildren(
        h('p.e-share-msg', null, files.length < fs.length ? t('entry.shareMissing') : t('entry.shareReady')),
        h('button.btn.primary.block', { type: 'button', onclick: () => { s.close(); sendShare(text, files.length < fs.length ? [] : files); } }, icon('share'), t('common.share')));
    });
  }
  function sendShare(text, files) {
    const data = files.length ? { files, text } : { text };
    const can = typeof navigator.share === 'function' && (!files.length || (navigator.canShare && navigator.canShare({ files })));
    if (!can) { fallbackShare(text, files); return; }
    navigator.share(data).catch(err => {
      if (err && err.name === 'AbortError') return;          // 用户取消
      ctx.toast(t('entry.shareFail', { msg: (err && err.message) || String(err) }));
    });
  }
  async function fallbackShare(text, files) {
    const ok = await copyText(text);
    for (const f of files) download(f.name, f, f.type);
    ctx.toast(files.length ? t('entry.shareCopied') : ok ? t('entry.textCopied') : t('common.copyFail'));
  }

  draw(true);
  ctx.on('layout', () => draw());                 // 换栏：返回按钮要不要显示
  return {
    onChange: () => { if (!leaving) draw(); },
    cleanup: () => { for (const p of players) p.destroy(); players = []; },
  };
}
