// 梦话列表（#/）：标题和条数、「列表 | 日历」切换、待整理横幅、搜索（简繁互通）、筛选、按年 / 月分组的卡片。
// 宽屏双栏时在左栏（params.pane === 'list'），params.selected 是右栏正在看的条目（高亮；j / k 换上一条下一条）。
// 自己管更新（返回 onChange）：数据变了只重画标题和卡片，搜索框原样留着，不丢输入和光标。
// 卡片（entryCard）和页头（listHead）日历页（views/calendar.js）也用。
// 卡片上是整段原话（条目没有标题）：超过 16 行的先显示前 12 行，「展开全部」就地展开，这次打开 App 期间记住。
import { h, icon } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { fmtEntryDate, fmtDate, fmtMonth, fmtYear, fmtDuration, monthKey } from '../core/dates.js';
import { parseDialogue, isDescOnly } from '../core/dialogue.js';
import { matchEntry, highlight } from '../core/search.js';
import { clipName } from '../core/clips.js';
import { sayNodes } from './entry.js';

/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');

// 搜索词和筛选：这次打开 App 期间记住（点进详情再回来还在）
const ui = { q: '', fav: false, audio: false, inbox: false };
// 长条目点过「展开全部」/「收起」的：id → true / false（这次打开 App 期间记住；列表、日历共用）
const opened = new Map();

/** 超过这么多行的卡片先折起来，只显示前 CARD_SHOW 行（只多一两行的不折） */
export const CARD_FOLD = 16, CARD_SHOW = 12;

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
 * 卡片上的整段原话，一行一项（原话一个字不改，只是分好类给卡片画）：
 * - 说话人的行 → { kind: 'say' | 'act', who, content }（act：整行都是动作，没有引号里的话）
 * - 只有表情的反应 → { kind: 'react', who, content }；「👰🏻‍♀️：」后面跟着录音 → { kind: 'cue', who }
 * - 没写字的「👰🏻‍♀️ “”」不要；旁白 → { kind: 'narr', content }；空行 → { kind: 'gap' }（连续的、开头结尾的不要）
 */
export function cardLines(text, speakers) {
  const out = [];
  for (const b of parseDialogue(text, speakers)) {
    let it;
    if (b.type === 'gap') it = { kind: 'gap' };
    else if (b.type === 'narration') it = { kind: 'narr', content: b.content };
    else if (b.emptyQuote) continue;
    else if (b.audioCue) it = { kind: 'cue', who: b.who };
    else if (b.reactionOnly) it = { kind: 'react', who: b.who, content: b.content };
    else it = { kind: isDescOnly(b.content) ? 'act' : 'say', who: b.who, content: b.content };
    if (it.kind === 'gap' && (!out.length || out[out.length - 1].kind === 'gap')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === 'gap') out.pop();
  return out;
}

/**
 * 折不折：超过 CARD_FOLD 行（空行不算）→ 折起来时只显示前 CARD_SHOW 行；more = 折起来时看不到的行数
 * @returns {{ shown: Array, more: number, long: boolean }}
 */
export function foldLines(items, open = false) {
  const n = items.reduce((k, x) => k + (x.kind === 'gap' ? 0 : 1), 0);
  if (n <= CARD_FOLD) return { shown: items, more: 0, long: false };
  if (open) return { shown: items, more: n - CARD_SHOW, long: true };
  let k = 0, cut = 0;
  while (cut < items.length && k < CARD_SHOW) { if (items[cut].kind !== 'gap') k++; cut++; }
  return { shown: items.slice(0, cut), more: n - CARD_SHOW, long: true };
}

/**
 * 搜索时原话里没有命中、是背景 / 草稿 / 录音名命中的：卡片上多一行说明命中了什么 → { label: 'note'|'draft'|'clip', text } | null
 */
export function cardExtra(e, q, items) {
  if (!q || !q.trim() || items.some(x => hasHit(x.content, q))) return null;
  if (hasHit(e.note, q)) return { label: 'note', text: snippet(e.note, q) };
  if (e.draft && hasHit(e.draft.text, q)) return { label: 'draft', text: snippet(e.draft.text, q) };
  const name = (e.audio || []).map(clipName).find(n => hasHit(n, q));
  return name ? { label: 'clip', text: name } : null;
}

// ---------- 列表和日历共用的部件 ----------

/**
 * 一张条目卡片：日期、录音时长、待整理，下面是整段原话（和详情页一样：引号里说的话楷体，动作 / 旁白普通字体、淡一点）；
 * 长的先折起来（「展开全部（还有 N 行）」，就地展开，不跳页）。整张卡片点了进详情，⭐、▶、展开按钮除外。
 * opts: { q 搜索词（高亮；命中在折起来的那部分时直接展开）, selected 双栏时右栏正在看这条, players 数组（卡片里的播放器放进去，重画前要 destroy） }
 */
export function entryCard(e, ctx, { q = '', selected = false, players = [] } = {}) {
  const { t } = ctx;
  const lang = ctx.lang(), sp = ctx.state.settings.speakers;
  const items = cardLines(e.text, sp), extra = cardExtra(e, q, items);
  const hl = (text) => (q.trim() ? highlight(text, q).map(s => (s.hit ? h('mark', null, s.text) : s.text)) : text);
  const dur = totalDuration(e);
  const href = '#/e/' + encodeURIComponent(e.id);
  let player = null;
  if (e.audio.length) {
    const c = e.audio[0];
    player = audioPlayer({ getBlob: () => ctx.clipBlob(c.sha256), durationSec: c.durationSec, compact: true, key: c.sha256 });
    players.push(player);
  }
  const names = { nn: sp.nn.name || 'NN', me: sp.me.name || t('edit.me') };
  const who = (w) => [h('span.c-emoji', { 'aria-hidden': 'true' }, sp[w].emoji), h('span.sr-only', null, names[w] + '：')];
  const line = (x) => {
    if (x.kind === 'gap') return h('div.c-gap', { 'aria-hidden': 'true' });
    if (x.kind === 'narr') return h('p.c-line.narr', null, sayNodes(x.content, q));
    if (x.kind === 'cue') return h('p.c-line.c-cueline', null, who(x.who), h('span.c-cue', null, icon('mic'), t('entry.cue')));
    if (x.kind === 'react') return h('p.c-line.c-reaction', null, who(x.who), h('span.c-react', null, hl(x.content)));
    return h('p.c-line.' + (x.kind === 'act' ? 'act' : 'kai'), null, who(x.who), sayNodes(x.content, q));   // .act：整行都是动作
  };

  // 长的：先看这次是不是点过；没点过、搜索命中在折起来的那部分 → 直接展开
  const folded = foldLines(items, false);
  let open = opened.has(e.id) ? opened.get(e.id)
    : folded.long && !!q.trim() && items.slice(folded.shown.length).some(x => hasHit(x.content, q));
  const linesEl = h('div.c-lines');
  const moreBtn = folded.long ? h('button.c-more', { type: 'button', onclick: (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    open = !open; opened.set(e.id, open); paint();
    if (!open) { const r = card.getBoundingClientRect(); if (r.top < 0) card.scrollIntoView({ block: 'start' }); }   // 收起后卡片的开头在屏幕上面：滚回来
  } }) : null;
  function paint() {
    const f = foldLines(items, open);
    linesEl.replaceChildren(...f.shown.map(line));
    if (moreBtn) { moreBtn.textContent = open ? t('list.less') : t('list.more', { n: f.more }); moreBtn.setAttribute('aria-expanded', String(open)); }
  }
  paint();

  const card = h('article.card.ecard' + (e.status === 'inbox' ? '.pending' : '') + (selected ? '.sel' : ''), { dataset: { id: e.id } },
    h('div.c-body', null,
      h('p.c-meta', null,
        h('a.c-link', { href, 'aria-current': selected ? 'page' : null }, fmtEntryDate(e, lang, { year: false, sep: daySep(lang) })),
        e.audio.length ? h('span.c-dur', { title: t('list.hasAudio') }, icon('mic', { label: t('list.hasAudio') }), fmtDuration(dur)) : null,
        e.status === 'inbox' ? h('span.tag', null, t('list.inboxTag')) : null),
      items.length ? linesEl : h('p.c-line.ph.kai', null, t('list.noText')),
      moreBtn,
      extra ? h('p.c-extra', null, h('span.tag.neutral', null, t(extra.label === 'note' ? 'list.inNote' : extra.label === 'draft' ? 'list.inDraft' : 'list.inClip')), ' ', hl(extra.text)) : null),
    h('div.c-side', null,
      h('button.fav-btn', {
        type: 'button', 'aria-pressed': String(e.fav), 'aria-label': t(e.fav ? 'list.unfav' : 'list.fav'), title: t(e.fav ? 'list.unfav' : 'list.fav'),
        onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); ctx.update(e.id, { fav: !e.fav }); },
      }, icon('star')),
      player));
  return card;
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
  // 横幅的小字：最新一条待整理的日期时间（还没写原话才说「还没写原话」）
  function inboxBanner(inbox) {
    const e = inbox[0], lang = ctx.lang();
    const sub = [fmtEntryDate(e, lang, { sep: daySep(lang) }), e.text.trim() ? null : t('list.noText')].filter(Boolean).join(' · ');
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
