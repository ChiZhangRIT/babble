// 梦话列表（#/）：标题和条数、「列表 | 日历」切换、待整理横幅、搜索（简繁互通）、筛选、按年 / 月分组的卡片。
// 宽屏双栏时在左栏（params.pane === 'list'），params.selected 是右栏正在看的条目（高亮；j / k 换上一条下一条）。
// 自己管更新（返回 onChange）：数据变了只重画标题和卡片，搜索框原样留着，不丢输入和光标。
// 卡片（entryCard）和页头（listHead）日历页（views/calendar.js）也用。
import { h, icon } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { fmtEntryDate, fmtDate, fmtMonth, fmtYear, fmtDuration, monthKey } from '../core/dates.js';
import { parseDialogue, isDescOnly } from '../core/dialogue.js';
import { matchEntry, highlight } from '../core/search.js';
import { sayNodes } from './entry.js';

/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');

// 搜索词和筛选：这次打开 App 期间记住（点进详情再回来还在）
const ui = { q: '', fav: false, audio: false, inbox: false };

// ---------- 纯计算（Node 里能测） ----------

/** 按搜索词和筛选挑条目（保持原来的顺序） */
export function filterEntries(list, f = {}, speakers) {
  return list.filter(e => (!f.fav || e.fav) && (!f.audio || (e.audio && e.audio.length)) && (!f.inbox || e.status === 'inbox')
    && matchEntry(e, f.q || '', speakers));
}

/** 新的在前的条目 → [{ year, months: [{ key: 'YYYY-MM', items }] }] */
export function groupByMonth(list) {
  const years = [];
  for (const e of list) {
    const key = monthKey(e.date), year = key.slice(0, 4);
    let y = years[years.length - 1];
    if (!y || y.year !== year) years.push(y = { year, months: [] });
    let m = y.months[y.months.length - 1];
    if (!m || m.key !== key) y.months.push(m = { key, items: [] });
    m.items.push(e);
  }
  return years;
}

/** 录音总长（秒）：每段都知道时长才加起来，有不知道的 → null */
export function totalDuration(e) {
  const d = (e.audio || []).map(a => a.durationSec);
  return d.length && d.every(x => Number.isFinite(x)) ? d.reduce((a, b) => a + b, 0) : null;
}

const hasHit = (s, q) => !!s && highlight(s, q).some(x => x.hit);
/** 长文字里第一处命中前后的一小段（一行） */
function snippet(text, q, before = 10, len = 36) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  let at = 0;
  for (const seg of highlight(s, q)) { if (seg.hit) break; at += seg.text.length; }
  const from = Math.max(0, at - before);
  return (from > 0 ? '…' : '') + s.slice(from, from + len) + (from + len < s.length ? '…' : '');
}

/**
 * 卡片上显示什么：标题（只用 entry.title；没填就没有标题这一行）+ 预览行（跳过空行、反应表情、录音提示；
 * 有标题时两行，没标题时三行，都是普通的预览样式）。搜索时预览换成命中的句子；只有背景 / 草稿命中时多一行 extra。
 * @returns {{ head: string, lines: Array<{who?: 'nn'|'me', content: string}>, extra: {label: 'note'|'draft', text: string} | null }}
 */
export function cardPreview(e, speakers, q = '') {
  const blocks = parseDialogue(e.text, speakers).filter(b => b.type !== 'gap' && b.content && !b.reactionOnly && !b.emptyQuote);
  const head = e.title && e.title.trim() ? e.title : '';
  let lines = blocks.slice(0, head ? 2 : 3), extra = null;
  if (q && q.trim()) {
    const hits = blocks.filter(b => hasHit(b.content, q));
    if (hits.length) lines = hits.slice(0, head ? 2 : 3);
    else if (!hasHit(head, q)) {
      if (hasHit(e.note, q)) extra = { label: 'note', text: snippet(e.note, q) };
      else if (e.draft && hasHit(e.draft.text, q)) extra = { label: 'draft', text: snippet(e.draft.text, q) };
    }
  }
  return { head, lines: lines.map(b => (b.type === 'line' ? { who: b.who, content: b.content } : { content: b.content })), extra };
}

// ---------- 列表和日历共用的部件 ----------

/**
 * 一张条目卡片。opts: { q 搜索词（高亮）, selected 双栏时右栏正在看这条, players 数组（卡片里的播放器放进去，重画前要 destroy） }
 */
export function entryCard(e, ctx, { q = '', selected = false, players = [] } = {}) {
  const { t } = ctx;
  const lang = ctx.lang(), sp = ctx.state.settings.speakers, p = cardPreview(e, sp, q);
  const hl = (text) => (q.trim() ? highlight(text, q).map(s => (s.hit ? h('mark', null, s.text) : s.text)) : text);
  const dur = totalDuration(e);
  const href = '#/e/' + encodeURIComponent(e.id);
  let player = null;
  if (e.audio.length) {
    const c = e.audio[0];
    player = audioPlayer({ getBlob: () => ctx.clipBlob(c.sha256), durationSec: c.durationSec, compact: true, key: c.sha256 });
    players.push(player);
  }
  const emoji = who => (who ? h('span.c-emoji', { 'aria-hidden': 'true' }, sp[who].emoji) : null);
  return h('article.card.ecard' + (e.status === 'inbox' ? '.pending' : '') + (selected ? '.sel' : ''), { dataset: { id: e.id } },
    h('div.c-body', null,
      h('p.c-meta', null,
        h('a.c-link', { href, 'aria-current': selected ? 'page' : null }, fmtEntryDate(e, lang, { year: false, sep: daySep(lang) })),
        e.audio.length ? h('span.c-dur', { title: t('list.hasAudio') }, icon('mic', { label: t('list.hasAudio') }), fmtDuration(dur)) : null,
        e.status === 'inbox' ? h('span.tag', null, t('list.inboxTag')) : null),
      p.head ? h('p.c-title', null, hl(p.head)) : null,
      !p.head && !p.lines.length ? h('p.c-line.ph.kai', null, t('list.noText')) : null,
      // 引号里说的话楷体，引号外的动作 / 描述普通字体（sayNodes）；整行都是动作的、旁白：淡一点
      p.lines.map(l => h('p.c-line' + (!l.who ? '.narr' : isDescOnly(l.content) ? '.act' : '.kai'), null, emoji(l.who), sayNodes(l.content, q))),
      p.extra ? h('p.c-extra', null, h('span.tag.neutral', null, t(p.extra.label === 'note' ? 'list.inNote' : 'list.inDraft')), ' ', hl(p.extra.text)) : null),
    h('div.c-side', null,
      h('button.fav-btn', {
        type: 'button', 'aria-pressed': String(e.fav), 'aria-label': t(e.fav ? 'list.unfav' : 'list.fav'), title: t(e.fav ? 'list.unfav' : 'list.fav'),
        onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); ctx.update(e.id, { fav: !e.fav }); },
      }, icon('star')),
      player));
}

/** 「呓语」页头：导入 / 记一条、大标题和「列表 | 日历」切换、条数。mode: 'list' | 'cal' */
export function listHead(ctx, all, mode) {
  const { t } = ctx;
  const oldest = all[all.length - 1];
  const seg = (m, label) => h('button', { type: 'button', 'aria-pressed': String(mode === m), onclick: () => { if (mode !== m) ctx.setListMode(m); } }, label);
  return h('header.page-head', null,
    h('div.toolbar', null,
      h('a.tb-btn', { href: '#/import' }, icon('import'), t('nav.import')),
      h('a.tb-btn', { href: '#/new', title: t('nav.new') + ' (⌘N)' }, icon('plus'), t('nav.new'))),
    h('div.lt-row', null,
      h('h1.lt', null, t('nav.list')),
      h('div.seg.lt-mode', { role: 'group', 'aria-label': t('cal.mode') }, seg('list', t('cal.list')), seg('cal', t('cal.cal')))),
    all.length ? h('p.lt-sub', null, t('list.count', { n: all.length }) + ' · ' + t('list.since', { month: fmtMonth(monthKey(oldest.date), ctx.lang()) })) : null);
}

// ---------- 页面 ----------
export function render(main, params, ctx) {
  const { t } = ctx;
  let players = [], shown = [];
  const sp = () => ctx.state.settings.speakers;
  const nn = () => sp().nn.name || 'NN';

  // 搜索框和筛选只建一次（重画时不动）
  const qInput = h('input', {
    type: 'search', value: ui.q, placeholder: t('list.search'), 'aria-label': t('list.searchLabel'), enterkeyhint: 'search',
    autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', dataset: { fid: 'list-q' },
    oninput: () => { ui.q = qInput.value; paintTools(); drawBody(); },
    onkeydown: (e) => { if (e.key === 'Escape' && qInput.value) { e.preventDefault(); setQ(''); } else if (e.key === 'Enter') qInput.blur(); },
  });
  const qClear = h('button.search-x', { type: 'button', 'aria-label': t('list.clearSearch'), title: t('list.clearSearch'), onclick: () => { setQ(''); qInput.focus(); } }, icon('x'));
  const chip = (key, ic, label) => h('button.chip', { type: 'button', 'aria-pressed': 'false', dataset: { k: key }, onclick: () => { ui[key] = !ui[key]; paintTools(); drawBody(); } }, ic, label);
  const chips = [chip('fav', icon('star'), t('list.fFav')), chip('audio', icon('mic'), t('list.fAudio')), chip('inbox', null, t('list.fInbox'))];
  const tools = h('div.page.list-tools', null,
    h('div.search', { role: 'search' }, icon('search'), qInput, qClear),
    h('div.chips.list-chips', { role: 'group', 'aria-label': t('list.filters') }, chips));
  const head = h('div.list-head'), body = h('div.page.list-body');
  main.append(head, tools, body);

  function setQ(v) { ui.q = v; qInput.value = v; paintTools(); drawBody(); }
  function paintTools() {
    qClear.hidden = !ui.q;
    for (const c of chips) c.setAttribute('aria-pressed', String(!!ui[c.dataset.k]));
  }

  function drawHead(all) {
    const inbox = all.filter(e => e.status === 'inbox');
    head.replaceChildren(listHead(ctx, all, 'list'), inbox.length && !ui.inbox ? h('div.page', null, inboxBanner(inbox)) : '');
  }
  // 横幅的小字：最新一条待整理的日期时间（有标题带上标题；还没写原话才说「还没写原话」）
  function inboxBanner(inbox) {
    const e = inbox[0], lang = ctx.lang();
    const sub = [fmtEntryDate(e, lang, { sep: daySep(lang) }), e.title && e.title.trim() ? e.title : null, e.text.trim() ? null : t('list.noText')].filter(Boolean).join(' · ');
    return h('button.inbox', { type: 'button', onclick: () => { ui.inbox = true; paintTools(); draw(); } },
      h('span.inbox-n', { 'aria-hidden': 'true' }, String(inbox.length)),
      h('span.inbox-t', null, h('b', null, t('list.inbox', { n: inbox.length })), h('small', null, sub)),
      icon('chev'));
  }

  function drawBody() {
    for (const p of players) p.destroy();
    players = [];
    const all = ctx.entries();
    tools.hidden = !all.length;
    if (!all.length) { shown = []; body.replaceChildren(emptyState()); return; }
    shown = filterEntries(all, ui, sp());
    const filtering = !!(ui.q.trim() || ui.fav || ui.audio || ui.inbox);
    const kids = [];
    if (filtering) {
      kids.push(h('p.list-count', null, h('span', null, t('list.results', { n: shown.length })),
        h('button.link-btn', { type: 'button', onclick: clearAll }, t('list.clearFilters'))));
    }
    if (!shown.length) {
      kids.push(h('div.empty.list-none', null, h('p', null, h('b', null, t('list.noResults'))), ui.q.trim() ? h('p.small', null, t('list.noResultsHint')) : null));
    }
    const lang = ctx.lang();
    for (const y of groupByMonth(shown)) {
      kids.push(h('h2.yr', null, fmtYear(y.year, lang)));
      for (const m of y.months) {
        kids.push(h('h3.mo', null, fmtMonth(m.key, lang, { year: false })));
        for (const e of m.items) kids.push(card(e));
      }
    }
    if (!filtering) kids.push(h('p.list-end', null, t('list.first', { date: fmtDate(all[all.length - 1].date, lang) })));
    body.replaceChildren(...kids);
    revealSelected();
  }
  function clearAll() { Object.assign(ui, { fav: false, audio: false, inbox: false }); setQ(''); drawHead(ctx.entries()); }

  const card = (e) => entryCard(e, ctx, { q: ui.q, selected: !!params.selected && params.selected === e.id, players });

  function emptyState() {
    return h('div.empty.list-empty', null,
      h('img', { src: 'icons/icon.svg', alt: '', width: 120, height: 120 }),
      h('h2', null, t('list.emptyTitle')),
      h('p', null, t('list.emptyText', { nn: nn() })),
      h('div.row', null,
        h('a.btn.primary', { href: '#/import/notes' }, icon('import'), t('list.emptyImport')),
        h('a.btn', { href: '#/new' }, icon('plus'), t('list.emptyNew'))));
  }

  // 双栏：右栏的条目不在视野里时滚过去（点卡片时它本来就在视野里，不会动）
  function revealSelected() {
    if (params.pane !== 'list' || !params.selected) return;
    requestAnimationFrame(() => {
      const el = body.querySelector(`[data-id="${CSS.escape(params.selected)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect(), box = main.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function draw() {
    const all = ctx.entries();
    if (ui.inbox && !all.some(e => e.status === 'inbox')) ui.inbox = false;   // 都整理好了：筛选自动取消
    paintTools();
    drawHead(all);
    drawBody();
  }
  draw();

  // 双栏时 j / k（焦点在列表里时也可以用 ↑ / ↓）换上一条、下一条
  const onKey = (ev) => {
    if (params.pane !== 'list' || ev.metaKey || ev.ctrlKey || ev.altKey || document.querySelector('dialog[open]')) return;
    const tg = ev.target;
    if (tg && tg.closest && tg.closest('input, textarea, select, [contenteditable="true"]')) return;
    const arrows = main.contains(document.activeElement);
    const dir = ev.key === 'j' || (arrows && ev.key === 'ArrowDown') ? 1 : ev.key === 'k' || (arrows && ev.key === 'ArrowUp') ? -1 : 0;
    if (!dir || !shown.length) return;
    const i = shown.findIndex(e => e.id === params.selected);
    const next = shown[i < 0 ? 0 : Math.min(shown.length - 1, Math.max(0, i + dir))];
    if (next && next.id !== params.selected) { ev.preventDefault(); ctx.navigate('/e/' + encodeURIComponent(next.id), { replace: true }); }
  };
  window.addEventListener('keydown', onKey);
  ctx.on('layout', () => draw());                 // 换栏（双栏 ↔ 单栏）：选中高亮要跟着变

  return {
    onChange: () => draw(),
    cleanup: () => { window.removeEventListener('keydown', onKey); for (const p of players) p.destroy(); players = []; },
  };
}
