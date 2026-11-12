// 日历（#/cal、#/cal/YYYY-MM、#/cal/YYYY-MM-DD）：按月看哪些日子有梦话（浅玫瑰色实心圆；下面的小圆点是条数，3 条以上加「+」；
// 右上角小麦克风 = 那天有录音；待整理的也算），今天画一圈。点一天，下面列出那天的卡片（和列表同一种卡片）；
// 点月份标题看全年（12 个小月历，‹ › 换年）快速跳过去。‹ › 翻月、手机上左右滑、「今天」；
// 键盘：方向键在日子之间移动，Home / End 到这周头尾，PageUp / PageDown 翻月（加 Shift 翻年）。
// 宽屏双栏时在左栏（params.pane === 'list'），点卡片右栏显示条目；看着条目时（地址是 #/e/<id>）日历停在那条的那一天。
// 翻月、选日子只换地址（ctx.replaceHash，不加历史记录、不整页重画）；自己管更新（返回 onChange）。
import { h, icon } from '../ui/dom.js';
import { fmtDate, fmtMonth, fmtYear, monthKey, today, isISODate } from '../core/dates.js';
import { pad2 } from '../core/util.js';
import { entryCard, listHead } from './list.js';

// ---------- 纯计算（Node 里能测） ----------

/** 一周从星期几开始（0 = 星期日）：简体中文星期一，繁体（台湾）和英文星期日 */
export const weekStart = lang => (lang === 'zh-Hans' ? 1 : 0);

const ymd = dt => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
const utc = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
/** 这个月有几天 */
export const daysIn = ym => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
/** 星期几（0 = 星期日） */
export const dow = iso => utc(iso).getUTCDay();
/** 'YYYY-MM-DD' 加 n 天（负数往前） */
export const addDays = (iso, n) => { const d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

/** 'YYYY-MM' 往后 n 个月（负数往前） */
export function shiftMonth(ym, n) {
  const m = Number(ym.slice(5, 7)) - 1 + n;
  return `${Number(ym.slice(0, 4)) + Math.floor(m / 12)}-${pad2((((m % 12) + 12) % 12) + 1)}`;
}
/** 隔 n 个月的同一天（那个月没有这一天就用月底：1月31日 → 2月28日） */
export function shiftDay(iso, n) {
  const ym = shiftMonth(iso.slice(0, 7), n);
  return `${ym}-${pad2(Math.min(Number(iso.slice(8, 10)), daysIn(ym)))}`;
}

/** 一个月的格子：前面按一周从哪天开始空几格（null），然后 1 号到月底，再补齐到整周 */
export function monthGrid(ym, start = 1) {
  const cells = Array((dow(ym + '-01') - start + 7) % 7).fill(null);
  for (let d = 1, n = daysIn(ym); d <= n; d++) cells.push(`${ym}-${pad2(d)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** 条目 → Map('YYYY-MM-DD' → { n 条数, audio 有没有录音, inbox 有没有待整理, ids 按传进来的顺序 })；已删除的、日期不对的不算 */
export function dayIndex(entries) {
  const map = new Map();
  for (const e of entries || []) {
    if (!e || e.deleted || !isISODate(e.date)) continue;
    let d = map.get(e.date);
    if (!d) map.set(e.date, d = { n: 0, audio: false, inbox: false, ids: [] });
    d.n++;
    d.ids.push(e.id);
    if (e.audio && e.audio.length) d.audio = true;
    if (e.status === 'inbox') d.inbox = true;
  }
  return map;
}
/** 某个月（'YYYY-MM'）或某一年（'YYYY'）一共几条 */
export function countIn(index, prefix) {
  let n = 0;
  for (const [d, v] of index) if (d.startsWith(prefix + '-')) n += v.n;
  return n;
}

const dayNum = iso => utc(iso).getTime() / 86400000;
/** 离这个月最近的、有梦话的日子（这个月一条都没有时给提示用）；一样近取后面那天；一条都没有 → null */
export function nearestDate(dates, ym) {
  const first = ym + '-01', last = `${ym}-${pad2(daysIn(ym))}`;
  let best = null, gap = Infinity;
  for (const d of dates) {
    const g = d < first ? dayNum(first) - dayNum(d) : d > last ? dayNum(d) - dayNum(last) : 0;
    if (g < gap || (g === gap && d > best)) { best = d; gap = g; }
  }
  return best;
}

/** 地址里的 'YYYY-MM' / 'YYYY-MM-DD' → { month, day }；认不出 → null */
export function parseCalPath(s) {
  if (isISODate(s)) return { month: s.slice(0, 7), day: s };
  if (typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return { month: s, day: null };
  return null;
}

const LOCALE = { 'zh-Hans': 'zh-CN', 'zh-Hant-TW': 'zh-TW', en: 'en-US' };
/** 表头：一、二…日 / 日、一…六 / S M T W T F S（按一周从哪天开始排） */
export function weekdayNames(lang, start = weekStart(lang)) {
  const f = new Intl.DateTimeFormat(LOCALE[lang] || 'zh-CN', { weekday: 'narrow', timeZone: 'UTC' });
  return [0, 1, 2, 3, 4, 5, 6].map(i => f.format(new Date(Date.UTC(2023, 0, 1 + ((start + i) % 7)))));   // 2023-01-01 是星期日
}
/** 全年视图小月历的月份名：一月 → 1月 / Jan（英文全称太长） */
const miniMonth = (ym, lang) => (lang === 'en' ? new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(utc(ym + '-01')) : fmtMonth(ym, lang, { year: false }));
const weekdayLong = (iso, lang) => new Intl.DateTimeFormat(LOCALE[lang] || 'zh-CN', { weekday: 'long', timeZone: 'UTC' }).format(utc(iso));

// 这次打开 App 期间记住选中的日子（看完条目回来、换布局时还在；再打开日历默认停在这一天所在的月）
const mem = { day: null };

// ---------- 页面 ----------
export function render(main, params, ctx) {
  const { t } = ctx;
  const own = params.path[0] === 'cal';             // 地址就是日历（不是双栏里看着条目时的左栏）
  const lang = () => ctx.lang();
  const sep = () => (lang() === 'en' ? ', ' : '，');
  let players = [], view = 'month', year = null, focusDay = null, focusK = null, slide = 0, month;

  // 停在哪个月：地址里写了就按地址；双栏里看着某条 → 那条的那天；否则选中的日子所在的月，没选过就是这个月
  const fromPath = own ? parseCalPath(params.path[1]) : null;
  const sel = !own && params.selected ? ctx.entry(params.selected) : null;
  if (fromPath) { month = fromPath.month; if (fromPath.day) mem.day = fromPath.day; }
  else if (sel && !sel.deleted && isISODate(sel.date)) { mem.day = sel.date; month = monthKey(sel.date); }
  else month = mem.day ? monthKey(mem.day) : monthKey(today());

  const shownDay = () => (mem.day && monthKey(mem.day) === month ? mem.day : null);
  const syncHash = () => { if (own) ctx.replaceHash('/cal/' + (shownDay() || month)); };

  const head = h('div.list-head'), body = h('div.page.cal');
  main.append(head, body);

  // ---------- 操作 ----------
  function go(n) { month = shiftMonth(month, n); slide = n; syncHash(); draw(); }
  function goToday() { const d = today(); view = 'month'; month = monthKey(d); mem.day = focusDay = d; syncHash(); draw(); }
  function select(d) {
    mem.day = focusDay = d;
    month = monthKey(d);
    syncHash(); draw();
    // 下面那天的卡片不在屏幕里（矮屏、手机底栏挡着）时滚一下
    const el = body.querySelector('.cal-dayh');
    if (el && el.getBoundingClientRect().top > innerHeight - 180) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function pickMonth(ym) { month = ym; view = 'month'; focusK = 'title'; syncHash(); draw(); }

  // 方向键在日子之间移动（只有一个日子在 Tab 顺序里）；移出这个月就翻过去
  function onGridKey(e) {
    const btn = e.target.closest && e.target.closest('.cal-day');
    if (!btn || e.altKey || e.metaKey || e.ctrlKey) return;
    const d = btn.dataset.date, back = (dow(d) - weekStart(lang()) + 7) % 7;
    const to = {
      ArrowLeft: () => addDays(d, -1), ArrowRight: () => addDays(d, 1), ArrowUp: () => addDays(d, -7), ArrowDown: () => addDays(d, 7),
      Home: () => addDays(d, -back), End: () => addDays(d, 6 - back),
      PageUp: () => shiftDay(d, e.shiftKey ? -12 : -1), PageDown: () => shiftDay(d, e.shiftKey ? 12 : 1),
    }[e.key];
    if (!to) return;
    e.preventDefault();
    focusDay = to();
    if (monthKey(focusDay) !== month) { month = monthKey(focusDay); syncHash(); draw(); }
    for (const b of body.querySelectorAll('.cal-day')) b.tabIndex = b.dataset.date === focusDay ? 0 : -1;
    const el = body.querySelector(`.cal-day[data-date="${focusDay}"]`);
    if (el) el.focus();
  }

  // ---------- 画 ----------
  function draw() {
    const act = document.activeElement;
    const keep = focusK ? `[data-k="${focusK}"]` : act && body.contains(act)
      ? (act.dataset.date ? `.cal-day[data-date="${act.dataset.date}"]` : act.dataset.k ? `[data-k="${act.dataset.k}"]` : null) : null;
    focusK = null;
    for (const p of players) p.destroy();
    players = [];
    const all = ctx.entries(), index = dayIndex(all);
    head.replaceChildren(listHead(ctx, all, 'cal'));
    body.replaceChildren(...(view === 'year' ? yearView(index) : monthView(index, all)));
    slide = 0;
    if (keep) { const el = body.querySelector(keep); if (el) el.focus({ preventScroll: true }); }
  }

  const bar = (title, titleLabel, n, up, onTitle, prev, next) => h('div.cal-bar', null,
    h('button.cal-title', { type: 'button', 'aria-label': titleLabel, dataset: { k: 'title' }, onclick: onTitle },
      h('span.cal-tt', null, h('span', null, title), icon('chevDown', { cls: up ? 'up' : '' })), n ? h('small', null, t('cal.n', { n })) : null),
    h('button.btn.small.soft.cal-today', { type: 'button', dataset: { k: 'today' }, onclick: goToday }, t('cal.today')),
    h('button.icon-btn.cal-nav', { type: 'button', 'aria-label': prev.label, title: prev.label, dataset: { k: 'prev' }, onclick: prev.run }, icon('back')),
    h('button.icon-btn.cal-nav', { type: 'button', 'aria-label': next.label, title: next.label, dataset: { k: 'next' }, onclick: next.run }, icon('chev')));

  function monthView(index, all) {
    const lng = lang(), start = weekStart(lng), td = today(), day = shownDay();
    const n = countIn(index, month);
    const tab = focusDay && monthKey(focusDay) === month ? focusDay : day || (monthKey(td) === month ? td : month + '-01');
    const grid = h('div.cal-grid' + (slide ? (slide > 0 ? '.from-next' : '.from-prev') : ''), { role: 'group', 'aria-label': fmtMonth(month, lng), onkeydown: onGridKey },
      monthGrid(month, start).map(d => (d ? dayCell(d, index.get(d), { today: d === td, sel: d === day, future: d > td, tab: d === tab }) : h('span.cal-pad', { 'aria-hidden': 'true' }))));
    swipe(grid, go);
    const kids = [
      bar(fmtMonth(month, lng), t('cal.openYear', { month: fmtMonth(month, lng) }), n, false, () => { view = 'year'; year = month.slice(0, 4); draw(); },
        { label: t('cal.prevMonth'), run: () => go(-1) }, { label: t('cal.nextMonth'), run: () => go(1) }),
      h('div.card.cal-card', null, h('div.cal-wd', { 'aria-hidden': 'true' }, weekdayNames(lng, start).map(s => h('span', null, s))), grid),
    ];
    if (!all.length) kids.push(h('p.cal-hint', null, t('cal.none')));
    else if (!n) {
      // 这个月一条都没有：告诉用户最近的一条在哪天，点了跳过去
      const near = nearestDate(index.keys(), month);
      kids.push(h('p.cal-hint', null, h('span', null, t('cal.emptyMonth')), ' · ',
        h('button.link-btn', { type: 'button', dataset: { k: 'near' }, onclick: () => select(near) },
          t('cal.nearest', { date: fmtDate(near, lng, { year: near.slice(0, 4) !== td.slice(0, 4) }) }))));
    }
    if (day) kids.push(...dayList(day, index.get(day), all));
    return kids;
  }

  function dayCell(d, info, f) {
    const lng = lang();
    const label = [fmtDate(d, lng, { year: false }), info ? t('cal.n', { n: info.n }) : null, info && info.audio ? t('cal.audio') : null,
      info && info.inbox ? t('cal.inbox') : null, f.today ? t('cal.today') : null].filter(Boolean).join(sep());
    return h('button.cal-day' + (info ? '.has' : '') + (f.today ? '.today' : '') + (f.sel ? '.sel' : '') + (f.future ? '.future' : ''), {
      type: 'button', tabindex: f.tab ? '0' : '-1', 'aria-label': label, 'aria-pressed': String(!!f.sel), 'aria-current': f.today ? 'date' : null,
      dataset: { date: d }, onclick: () => select(d),
    },
    h('span.cal-num', { 'aria-hidden': 'true' }, String(Number(d.slice(8)))),
    info && info.audio ? h('span.cal-mic', { 'aria-hidden': 'true' }, icon('mic')) : null,
    h('span.cal-dots', { 'aria-hidden': 'true' }, info ? Array.from({ length: Math.min(info.n, 3) }, () => h('i')) : null, info && info.n > 3 ? h('b', null, '+') : null));
  }

  // 选中那天的卡片（和列表同一种卡片）；那天没有 →「这天没有记录」+ 记一条（日期预填成那天）
  function dayList(d, info, all) {
    const lng = lang();
    const byId = new Map(all.map(e => [e.id, e]));
    const items = info ? info.ids.map(id => byId.get(id)).filter(Boolean) : [];
    return [
      h('h2.cal-dayh', null,
        h('span', null, fmtDate(d, lng, { year: d.slice(0, 4) !== today().slice(0, 4) }), h('span.cal-wdname', null, weekdayLong(d, lng))),
        items.length ? h('small', null, t('cal.n', { n: items.length })) : null),
      items.length ? h('div.cal-items', null, items.map(e => entryCard(e, ctx, { selected: !!params.selected && params.selected === e.id, players })))
        : h('div.cal-none', null, h('p', null, t('cal.dayNone')), h('a.btn.small.soft', { href: '#/new?date=' + d }, icon('plus'), t('cal.write'))),
    ];
  }

  function yearView(index) {
    const lng = lang(), start = weekStart(lng), td = today();
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);
    const goYear = (n) => { year = String(Number(year) + n); slide = n; draw(); };
    const grid = h('div.cal-year' + (slide ? (slide > 0 ? '.from-next' : '.from-prev') : ''), null, months.map(ym => {
      const n = countIn(index, ym);
      return h('button.cal-mini' + (ym === month ? '.cur' : ''), {
        type: 'button', 'aria-label': fmtMonth(ym, lng) + (n ? sep() + t('cal.n', { n }) : ''), dataset: { k: 'm' + ym }, onclick: () => pickMonth(ym),
      },
      h('span.mini-h', null, h('b', null, miniMonth(ym, lng)), n ? h('small', null, String(n)) : null),
      h('span.mini-grid', { 'aria-hidden': 'true' }, monthGrid(ym, start).map(d => (d
        ? h('i' + (index.has(d) ? '.has' : '') + (d === td ? '.today' : ''), null, String(Number(d.slice(8))))
        : h('i.pad')))));
    }));
    swipe(grid, goYear);
    return [
      bar(fmtYear(year, lng), t('cal.backMonth', { month: fmtMonth(month, lng) }), countIn(index, year), true, () => { view = 'month'; draw(); },
        { label: t('cal.prevYear'), run: () => goYear(-1) }, { label: t('cal.nextYear'), run: () => goYear(1) }),
      grid,
    ];
  }

  // 双栏：右栏的条目在左栏那天的卡片里，不在视野里时滚过去
  function revealSelected() {
    if (params.pane !== 'list' || !params.selected) return;
    requestAnimationFrame(() => {
      const el = body.querySelector(`.ecard[data-id="${CSS.escape(params.selected)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect(), box = main.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'nearest' });
    });
  }

  draw();
  revealSelected();
  if (own) queueMicrotask(syncHash);              // #/cal → #/cal/<选中的日子或月份>（等 app 挂好页面再换地址）
  ctx.on('layout', () => draw());

  return {
    onChange: () => draw(),
    cleanup: () => { for (const p of players) p.destroy(); players = []; },
  };
}

/** 手机上左右滑：往左滑 → fn(1)（下一个月 / 年），往右滑 → fn(-1)。竖着滑照常滚动页面（CSS touch-action: pan-y） */
function swipe(el, fn) {
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); });
  el.addEventListener('pointercancel', () => { x0 = null; });
  el.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - t0 < 900) fn(dx < 0 ? 1 : -1);
  });
}
