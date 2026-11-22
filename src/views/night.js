// 昨夜（#/night 最新一晚、#/night/<YYYY-MM-DD> 那一晚）：床头模式一晚的记录和整理。推入的页面（顶栏「‹ 呓语」），什么布局都是单栏。
//   记录（卡片）：几点听到几点、听了多久（百分比）、没在听的时候和原因（≥ 30 秒的一条条写，短的合成一句）、
//         这晚还有：一直有声音 / 存够了只数次数 / 说话识别没用上（这些时候在听，不算「没在听」）；
//         没片段时老实说为什么（整夜都在听 / 几点就停了 / 你几点结束的 / 有一段时间没在听）。文字都来自 core/nightReport.js 的 reportLines（和复制摘要同一套说法）
//   片段：按前后间隔分组（episodes），每段一个完整播放器（声音是 babble-night 里的 PCM 分片，点 ▶ 时才拼成 WAV）。
//         勾上要留的 → 底部「留下选中的 n 段」（一段 = 一条，几段 = 合成一条，见 core/nightKeep.js）；✕ 删一段（提示条里能撤销，「已删掉」里 24 小时内能恢复）；
//         没勾的时候底部是「其余都删」/「昨夜没有梦话」/「这一晚整理完了」。留下的显示「已留下 · 去看看」（那条后来删了 →「留下过，那条已删除」，
//         永久删除了 →「留下过，那条已永久删除」、没有链接；都不再算待听）；
//         留下后提示条里的「撤销」= 删掉那条（进「最近删除」）、去掉候选的链接 → 回到待听（离开了这页也照样，提示条是外壳的）。
//         撤销时候选的 sha256 留着：那条以后永久删除了，清理时照样认得出这段的声音（core/purge.js 删掉片段）。
//         记着的 sha256 永久删除了（goneShas）、又没留下的 →「这段的录音已经永久删除了」：放不了、留不了、不算待听、不在「已删掉」里
//         （清理等云端确认才删片段，这之前也是这样；留下了它又永久删除 = 把那段录音找回来，keepClips 也不让）。
//   第一次留下、开着同步：先说清楚「同步过的录音一直留在仓库历史里」（babble.local.bedKeepNoted；永久删除的开关开着时——现在开着——用 night.syncNotePurge 的说法）。
//   这一晚没有待听的了（打开时就没有、或者刚整理完）→ 每次床头模式记下 reviewedAt，「昨夜」卡片不再提醒（还开着的那晚不记）。
//   下面：前几晚还有没整理的、前几晚（每一晚的链接）、详细记录（复制摘要；导出记录文件：分享面板，不行就下载）。
// 每次留下暂停同步 10.5 秒（ctx.sync.pause('night-undo')，离开这页也等着）：提示条上点「撤销」时录音还没传上去。
// 自己管更新（返回 onChange）：条目变了（同步来的、别处删了留下的那条）只重算哪些已留下、原地重画，勾选不丢、正在放的不断。
// 重画（删、恢复、留下、条目变了）后焦点回到原来的控件（data-fk）；那一行没了就到下一段的 ✕，再没有就到底部按钮（读屏、键盘不用从头找）。
// 也导出 nightBanner(ctx)：列表、日历上的「昨夜」卡片（复用待整理横幅的样子）。
import { h, icon, copyText, download } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { nightReport, nightCard, reportLines, textSummary, exportLog, fmtClock, addDays } from '../core/nightReport.js';
import { keepClips } from '../core/nightKeep.js';
import { P, wavBlob } from '../core/nightDetect.js';
import { deletedRecord, restoredRecord } from '../core/store.js';
import { PURGE_ENABLED } from '../core/purge.js';
import { fmtDate, fmtDuration, today } from '../core/dates.js';
import { t } from '../i18n.js';

/** replaceChildren，但跳过 null / false（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const enc = encodeURIComponent;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const errMsg = e => (e && e.message) || String(e);
const selectable = c => !c.kept && !c.gone && !c.purged;    // 能勾、能留的：还没留下、声音还在、不是永久删除了的录音
const UNDO_HOLD_MS = 10500;                                  // 留下以后暂停同步多久：外壳的「撤销」提示条 10 秒，多等半秒

/** 「留下了没有」不另存：候选记下的条目还在就算（后来删了、永久删除了也算：留下又删 = 不要了；「撤销」会去掉候选的链接 → 回到待听） */
export const keptBy = (ctx) => (c) => !!(c.entryId && (ctx.entry(c.entryId) || (ctx.tombstone && ctx.tombstone(c.entryId))));
/** 这段的录音永久删除了没有：记着的 sha256（留下过的才有）在 goneShas 里（别的条目还在用的不算）；没有 ctx.goneShas（测试）→ 都没有 */
export const purgedBy = (ctx) => (c) => !!(c && c.sha256 && ctx.goneShas && ctx.goneShas().has(c.sha256));

// 最近一次读到的 babble-night（{ store, sessions, cands }）：列表、日历重新打开时「昨夜」卡片先照它画（不闪、列表不跳），读到新的再改。
// 昨夜页每次重读都更新它（整理完回到列表就是新的）；床头页打开时清掉（那一晚还在写）。
// nightGen：撤销留下时（可能已经离开了这页，双栏时列表还开着）+1，开着的卡片在下一次「条目变了」时重读
let lastNight = null, nightGen = 0;
export const forgetNight = () => { lastNight = null; };
/** 昨夜 / 11月15日夜里 */
export const nightLabel = (nightOf, lang, now = new Date()) =>
  (nightOf === addDays(today(now), -1) ? t('night.last') : t('night.title', { date: fmtDate(nightOf, lang, { year: false }) }));

/** 导出的记录文件：能分享文件就用分享（主屏幕 Web App 里 <a download> 可能没反应），不能就下载。要在点按里调用（同 record.js 的 saveFile） */
function saveLog(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(e => { if (!e || e.name !== 'AbortError') download(name, blob); });
      return;
    }
  } catch (e) { /* 不支持就下载 */ }
  download(name, blob);
}

// ---------- 列表、日历上的「昨夜」卡片 ----------
/**
 * div.page，没有要提醒的就藏着：最新一晚（不算还开着的）有待听的 →「昨夜 · 存了 3 段待听」；没片段又还没看过 → 怎么没片段的；点了进那一晚。
 * 列表、日历每次打开建一个（先照上次读到的画；等启动时的找回、清理做完再读 babble-night），重画页头时放回同一个元素；
 * 条目变了重算待听几段，撤销了留下（nightGen 变了）就重读。
 * 没有 ctx.night（测试、存不了数据）→ 一直藏着
 */
export function nightBanner(ctx) {
  const el = h('div.page.nt-banner', { hidden: true });
  if (!ctx.night) return el;
  let data = lastNight && lastNight.store === ctx.night ? lastNight : null;
  const paint = () => {
    const c = data && nightCard({ sessions: data.sessions, cands: data.cands, now: Date.now(), isKept: keptBy(ctx), isPurged: purgedBy(ctx), t, lang: ctx.lang() });
    el.hidden = !c;
    fill(el, c && h('button.inbox.nt-card', { type: 'button', onclick: () => ctx.navigate('/night/' + c.nightOf) },
      h('span.inbox-n', { 'aria-hidden': 'true' }, c.kind === 'clips' ? String(c.n) : '·'),
      h('span.inbox-t', null, h('b', null, c.title), h('small', null, c.sub)),
      icon('chev')));
  };
  let gen = -1;
  const read = () => {
    gen = nightGen;
    Promise.resolve(ctx.nightRecovered).catch(() => {})
      .then(() => Promise.all([ctx.night.listSessions(), ctx.night.listCands()]))
      .then(([sessions, cands]) => { data = lastNight = { store: ctx.night, sessions, cands }; paint(); }, e => console.warn('night banner', e));
  };
  if (data) paint();
  read();
  if (ctx.on) ctx.on('change', () => { if (gen !== nightGen) read(); else if (data) paint(); });
  return el;
}

// ---------- 页面 ----------
/** @param {{ player?: typeof audioPlayer, undoHoldMs?: number, purgeEnabled?: boolean }} [deps]  测试可以换掉播放器、缩短留下后暂停同步的时间、换掉 PURGE_ENABLED */
export function render(main, params, ctx, { player = audioPlayer, undoHoldMs = UNDO_HOLD_MS, purgeEnabled = PURGE_ENABLED } = {}) {
  const lang = ctx.lang(), night = ctx.night || null;
  const want = params.id || null;                                   // null → 最新一晚
  const isKept = keptBy(ctx), isPurged = purgedBy(ctx);
  const sel = new Set();                                            // 勾上的片段 id（重画、条目变了都留着）
  const open = { deleted: false, older: false, details: false };    // 折起来的几块开着没有（重画后照旧）
  let sessions = [], cands = [], loaded = false, failed = null, gone = false, busy = false, seq = 0, drawn = false, gen = nightGen;
  let key = null, r = null, players = [], rows = new Map(), groups = [], bar = null, exportBtn = null, events = null, eventsKey = null;
  let fks = new Map(), focusTo = null;                              // data-fk → 控件；重画后焦点放到哪（按顺序试，动作一开始就定下来）
  const fk = (k, el) => { el.dataset.fk = k; fks.set(k, el); return el; };

  const tzOf = (c) => (sessions.find(s => s.id === c.s) || {}).tz || (r && r.tz) || null;
  const clockOf = (c) => fmtClock(c.startAt, tzOf(c), lang);
  const metaText = (c) => clockOf(c) + ' · ' + fmtDuration(c.durationSec);
  const navbar = (title) => h('header.navbar', null,
    fk('back', h('button.back', { type: 'button', onclick: () => ctx.back('/') }, icon('back'), t('nav.list'))), h('span.nb-title', null, title), h('span'));
  const fold = (k, title, body) => {
    const d = h('details.nt-fold', { open: open[k] || null }, fk('fold:' + k, h('summary.group-h', null, title)), body);
    d.addEventListener('toggle', () => { open[k] = !!d.open; if (k === 'details' && d.open) prepLog(); });
    return d;
  };

  // ---------- 读 babble-night（等启动时的找回做完） ----------
  async function load() {
    const my = ++seq;
    gen = nightGen;
    try {
      await Promise.resolve(ctx.nightRecovered).catch(() => {});
      const [ss, cs] = night ? await Promise.all([night.listSessions(), night.listCands()]) : [[], []];
      if (my !== seq || gone) return;
      sessions = ss; cands = cs; failed = null;
      if (night) lastNight = { store: night, sessions, cands };     // 回到列表时「昨夜」卡片照这个先画
    } catch (e) {
      if (my !== seq || gone) return;
      console.warn('night', e); failed = e;
    }
    loaded = true;
    draw();
    review();
  }
  /** 这一晚没有待听的了 → 每次床头模式记下看过（「昨夜」卡片不再提醒）；还开着的那晚不记，免得早上的卡片被藏掉 */
  function review() {
    if (failed || !r || r.live || r.pending > 0 || r.reviewed || !night) return;
    const at = Date.now(), mine = sessions.filter(s => s.nightOf === key && !s.reviewedAt);
    for (const s of mine) s.reviewedAt = at;                        // 本页先记上，不用重读
    Promise.all(mine.map(s => night.patchSession(s.id, { reviewedAt: at }))).catch(e => console.warn('night reviewed', e));
  }

  // ---------- 画 ----------
  function draw() {
    if (gone) return;
    const sc = ctx.layout && ctx.layout() === 'phone' ? document.scrollingElement : main, top = sc ? sc.scrollTop : 0;
    const to = focusTo || focusIn();
    for (const p of players) p.destroy();
    players = []; rows = new Map(); groups = []; bar = null; exportBtn = null; fks = new Map();
    fill(main, build());
    if (drawn && sc) sc.scrollTop = top;
    drawn = true;
    if (to && (refocus(to) || !busy)) focusTo = null;             // 正在留下（按钮点不了）：等存好以后那次重画
  }
  /** 焦点在这页的哪个控件上（播放器里的按钮算那一行的勾选框）→ 要试的 data-fk */
  function focusIn() {
    const a = document.activeElement;
    if (!a || a === main || !main.contains(a)) return null;
    if (a.dataset && a.dataset.fk) return [a.dataset.fk, 'bar'];
    for (const [id, x] of rows) if (x.row.contains(a)) return ['pick:' + id, 'bar'];
    return null;
  }
  const refocus = (keys) => keys.some(k => { const el = fks.get(k); if (!el || el.disabled || el.hidden) return false; el.focus({ preventScroll: true }); return true; });
  /** 删掉 c 以后焦点去哪：后面一段的 ✕（留下了的：它的链接），没有就前面一段，再没有就底部按钮 */
  function near(c) {
    const xs = r ? r.clips : [], i = xs.findIndex(x => x.id === c.id);
    return [...xs.slice(i + 1), ...xs.slice(0, Math.max(0, i)).reverse()].flatMap(x => ['x:' + x.id, 'kept:' + x.id]).concat('bar');
  }

  function build() {
    if (!loaded) return [navbar(''), h('div.page', null, h('p.empty.nt-loading', null, t('common.loading')))];
    if (failed) {
      return [navbar(''), h('div.page', null, h('div.empty', null, h('p', null, t('common.renderError') + errMsg(failed)),
        h('button.btn', { type: 'button', onclick: () => load() }, t('common.retry'))))];
    }
    const keys = [...new Set(sessions.map(s => s.nightOf).filter(Boolean))].sort().reverse(), now = Date.now();
    key = want || keys[0] || null;
    r = isDate(key) ? nightReport({ sessions, cands, nightOf: key, now, isKept, isPurged }) : null;
    if (!sessions.length) {
      return [navbar(t('night.setNights')), h('div.page', null, h('div.empty.nt-never', null, icon('clock'), h('p', null, t('night.never')),
        h('button.btn.primary', { type: 'button', onclick: () => ctx.navigate('/rec?bed=1') }, icon('mic'), t('night.goBed'))))];
    }
    if (!r) return [navbar(isDate(want) ? nightLabel(want, lang) : ''), h('div.page', null, h('div.empty.nt-missing', null, h('p', null, t('night.missing'))), olderList(keys))];
    for (const id of [...sel]) if (!r.clips.some(c => c.id === id && selectable(c))) sel.delete(id);     // 留下了、删了、清掉了的不再算勾着

    const L = reportLines(r, { t, lang });
    const list = (cls, head, xs) => (xs.length ? [h('h2.nt-h', null, t(head)), h('ul.nt-lines' + cls, null, xs.map(x => h('li', null, x)))] : null);
    const report = h('section.card.nt-report', null,
      h('p.nt-range', null, L.range),
      L.live ? h('p.nt-live', null, L.live) : null,
      list('.nt-away', 'night.gapsH', [...L.gaps, L.short].filter(Boolean)),
      list('.nt-also', 'night.notesH', L.notes),
      L.stopped ? h('p.nt-note', null, L.stopped) : null,
      L.empty ? h('p.nt-empty', null, L.empty) : null);

    const eps = r.episodes.map(ep => {
      const free = ep.filter(selectable);
      const gb = free.length > 1 ? fk('grp:' + ep[0].id, h('button.link-btn.nt-group', { type: 'button', 'aria-pressed': String(free.every(c => sel.has(c.id))), onclick: () => pickGroup(free) }, t('night.pickGroup'))) : null;
      if (gb) groups.push({ el: gb, ids: free.map(c => c.id) });
      return h('section.nt-ep', null,
        h('h2.group-h.nt-ep-h', null, h('span', null, t('night.episode', { time: clockOf(ep[0]), n: ep.length })), gb),
        h('div.nt-clips', null, ep.map(clipRow)));
    });

    const dels = r.deleted.filter(c => now - (c.deletedAt || 0) <= P.DELETED_KEEP_MS);        // 24 小时后清掉声音：之前都能恢复
    const others = keys.filter(k => k < key).map(k => ({ k, rep: nightReport({ sessions, cands, nightOf: k, now, isKept, isPurged }) }))
      .filter(x => x.rep && !x.rep.live && x.rep.pending > 0);
    const sep = lang === 'en' ? ', ' : '、';
    exportBtn = h('button.btn.small', { type: 'button', disabled: !(events && eventsKey === key), onclick: exportIt }, t('night.export'));
    bar = h('div.bottom-bar.nt-bar');
    paintBar();
    return [
      navbar(nightLabel(key, lang)),
      h('div.page.nt-page', null,
        report,
        r.pending ? h('p.nt-hint', null, t('night.hint')) : null,
        eps,
        dels.length ? fold('deleted', t('night.deletedRow', { n: dels.length }), h('div.group.nt-dels', null, dels.map(c =>
          h('div.group-row.nt-del-row', null, h('span.nt-del-t', null, metaText(c)),
            fk('rs:' + c.id, h('button.btn.small.soft', { type: 'button', onclick: () => restore(c) }, t('night.restore'))))))) : null,
        others.length ? h('p.nt-others', null, t('night.others'),
          others.map((x, i) => [i ? sep : null, h('a', { href: '#/night/' + x.k }, t('night.otherItem', { label: nightLabel(x.k, lang), n: x.rep.pending }))])) : null,
        h('p.group-foot.nt-foot', null, [ctx.local && ctx.local.sync ? t('night.syncHeld') : null, t('night.retain')].filter(Boolean).join(lang === 'en' ? ' ' : '')),
        olderList(keys),
        fold('details', t('night.details'), h('div.nt-acts', null, fk('copy', h('button.btn.small', { type: 'button', onclick: copy }, t('night.copy'))), fk('export', exportBtn)))),
      bar,
    ];
  }

  /**
   * 一段：☐、时刻 · 时长（一直有声音 / 没录完）、完整播放器、✕。留下了的 → 「✓ 已留下 · 去看看」（那条后来删了：「留下过，那条已删除」；
   * 永久删除了：「留下过，那条已永久删除」，没有链接）；声音清掉了的、录音永久删除了的 → 只能删
   */
  function clipRow(c) {
    const meta = h('p.nt-meta', null, h('span', null, metaText(c)),
      c.cut === 'noise' ? h('span.tag.neutral', null, t('night.noiseTag')) : c.cut === 'crash' ? h('span.tag.amber', null, t('night.crashTag')) : null);
    if (c.kept && !ctx.entry(c.entryId)) {
      return h('div.nt-clip.kept', null, fk('kept:' + c.id, h('span.nt-kept.off', { tabindex: '-1' }, icon('check'), t('night.keptPurged'))), meta);
    }
    if (c.kept) {
      const e = ctx.entry(c.entryId), label = e && e.deleted ? t('night.keptDel') : t('night.keptTag');
      return h('div.nt-clip.kept', null, fk('kept:' + c.id, h('a.nt-kept', { href: '#/e/' + enc(c.entryId) }, icon('check'), label + ' · ' + t('night.open'))), meta);
    }
    const x = fk('x:' + c.id, h('button.icon-btn.nt-x', { type: 'button', 'aria-label': t('night.del') + ' ' + clockOf(c), title: t('night.del'), onclick: () => del(c) }, icon('x')));
    if (c.purged || c.gone) return h('div.nt-clip.gone', null, h('div.nt-clip-main', null, meta, h('p.nt-gone', null, t(c.purged ? 'night.purgedClip' : c.parts === 0 ? 'night.notSaved' : 'night.gone'))), x);
    const box = fk('pick:' + c.id, h('input', { type: 'checkbox', checked: sel.has(c.id), 'aria-label': t('night.pick') + ' ' + clockOf(c), onchange: () => pick(c.id, box.checked) }));
    const p = player({ getBlob: async () => wavBlob((await night.getParts(c.id)).map(part => part.b), c.samples, c.sr || P.SR), durationSec: c.durationSec, key: 'cand:' + c.id });
    players.push(p);
    const row = h('div.nt-clip' + (sel.has(c.id) ? '.on' : ''), null, h('label.nt-pick', null, box), h('div.nt-clip-main', null, meta, p), x);
    rows.set(c.id, { row, box });
    return row;
  }

  /** 前几晚：本机记着的每一晚（这一晚除外），新的在前；（n 段）是那晚存下的片段 */
  function olderList(keys) {
    const ks = keys.filter(k => k !== key), now = Date.now();
    return ks.length ? fold('older', t('night.older'), h('div.group.nt-older', null, ks.map(k => {
      const rep = nightReport({ sessions, cands, nightOf: k, now, isKept, isPurged });
      return h('a.group-row', { href: '#/night/' + k }, h('span', null, t('night.otherItem', { label: nightLabel(k, lang), n: rep ? rep.clips.length : 0 })));
    }))) : null;
  }

  // ---------- 勾选和底部按钮 ----------
  function pick(id, on) { if (on) sel.add(id); else sel.delete(id); paintSel(); }
  function pickGroup(free) {
    const all = free.every(c => sel.has(c.id));
    for (const c of free) { if (all) sel.delete(c.id); else sel.add(c.id); }
    paintSel();
  }
  function paintSel() {
    for (const [id, x] of rows) { x.box.checked = sel.has(id); x.row.classList.toggle('on', sel.has(id)); }
    for (const g of groups) g.el.setAttribute('aria-pressed', String(g.ids.every(id => sel.has(id))));
    paintBar();
  }
  // 勾了 → 留下选中的 n 段 / 取消；没勾、有留下的 → 其余都删；没留下的 → 昨夜没有梦话；都整理完 → 这一晚整理完了（还开着的那晚不说）
  // 换按钮时焦点在底部条里（比如点了「取消」）→ 放到新的第一个按钮上
  function paintBar() {
    if (!bar || !r) return;
    const n = sel.size, had = !!document.activeElement && bar.contains(document.activeElement);
    let kids = null;
    fks.delete('bar');
    if (n) {
      kids = h('div.nt-bar-in', null,
        fk('bar', h('button.btn.primary.big.nt-keep', { type: 'button', disabled: busy, onclick: keep }, h('span', null, t('night.keepN', { n })), h('small', null, t(n === 1 ? 'night.keepOne' : 'night.keepMany')))),
        h('button.btn.big.nt-cancel', { type: 'button', disabled: busy, onclick: () => { sel.clear(); paintSel(); } }, t('common.cancel')));
    } else if (r.pending) {
      kids = fk('bar', h('button.btn.big.nt-rest', { type: 'button', disabled: busy, onclick: rest }, r.clips.some(c => c.kept) ? t('night.rest') : t('night.noTalk', { label: nightLabel(key, lang) })));
    } else if (!r.live) {
      kids = h('div.nt-bar-in.nt-done', null, h('p', null, t('night.done')),
        fk('bar', h('button.btn.soft', { type: 'button', onclick: () => ctx.navigate(ctx.home ? ctx.home() : '/', { replace: true }) }, t('night.toList'))));
    }
    fill(bar, kids);
    bar.hidden = !kids;
    if (had) refocus(['bar']);
  }

  // ---------- 删、恢复、留下 ----------
  /** 改 babble-night，再重读、重画；出错提示一下 → 成功了没有 */
  async function act(fn) {
    let ok = true;
    try { await fn(); } catch (e) { ok = false; console.warn('night', e); ctx.toast(t('common.renderError') + errMsg(e)); }
    await load();
    return ok;
  }
  const setState = (ids, state) => {
    const at = Date.now();
    return Promise.all(ids.map(id => night.patchCand(id, state === 'deleted' ? { state, deletedAt: at } : { state, deletedAt: null })));
  };
  const undoToast = (msg, ids) => ctx.toast(msg, { ms: 10000, action: { label: t('common.undo'), run: () => { act(() => setState(ids, 'new')); } } });

  async function del(c) {
    sel.delete(c.id);
    const time = clockOf(c);
    focusTo = near(c);
    if (await act(() => setState([c.id], 'deleted'))) undoToast(t('night.deleted', { time }), [c.id]);
  }
  async function restore(c) {
    focusTo = ['pick:' + c.id, 'x:' + c.id, 'fold:deleted', 'bar'];
    if (await act(() => setState([c.id], 'new'))) ctx.toast(t('common.restored'));
  }
  /** 其余都删 / 昨夜没有梦话：没留下的都删（提示条里一次撤销）；这一晚就算看过了（load 之后 review） */
  async function rest() {
    const ids = r ? r.clips.filter(c => !c.kept).map(c => c.id) : [];
    if (busy || !ids.length) return;
    sel.clear();
    focusTo = ['bar'];
    if (await act(() => setState(ids, 'deleted'))) undoToast(t('night.restDone', { n: ids.length }), ids);
  }
  /**
   * 留下勾上的：第一次（开着同步）先说清楚同步的事；存好以后弹「留下了 n 段」+ 撤销（自己弹，不走外壳的通用撤销：要连候选一起改回来）。
   * 「最近删除」里正好是这几段的那条（上次留下又撤销了）→ 恢复它。存好前后暂停同步 undoHoldMs（离开这页也等着）
   */
  async function keep() {
    const list = r ? r.clips.filter(c => sel.has(c.id) && selectable(c)) : [];
    if (busy || !list.length) return;
    const local = ctx.local || {};
    if (local.sync && !local.bedKeepNoted) {
      if (!(await ctx.confirm({ message: t(purgeEnabled ? 'night.syncNotePurge' : 'night.syncNote'), confirmLabel: t('night.syncOk'), cancelLabel: t('night.syncNo') }))) return;
      ctx.setLocal({ bedKeepNoted: true });
    }
    busy = true; focusTo = ['bar', 'kept:' + list[0].id]; paintBar();
    const hold = ctx.sync && ctx.sync.pause ? ctx.sync.pause('night-undo') : null;
    let made = null;                                                // 新建或恢复的条目（只补了链接的不算：不弹撤销）
    const unTrash = (id) => {                                       // 从「最近删除」恢复（不弹「已恢复」：马上弹「留下了」）
      ctx.mutate(s => { const x = restoredRecord(s.data.entries[id]); if (x) s.data.entries[id] = x; });
      const e = ctx.entry(id);
      return e && !e.deleted ? (made = e) : null;
    };
    try {
      await keepClips({ night, audio: ctx.audio, getState: () => ctx.state, put: (e) => (made = ctx.put(e)), restore: unTrash, newEntry: (f) => ctx.newEntry(f) },
        list, new Map(sessions.map(s => [s.id, s])));
      for (const c of list) sel.delete(c.id);
    } catch (e) {
      if (e && e.code === 'gone') await goneClip(list.find(c => c.id === e.candId));
      else if (e && e.code === 'purged') purgedClip(list.find(c => c.id === e.candId));
      else { console.warn('night keep', e); ctx.toast(t('night.keepFail', { msg: errMsg(e) })); }
    }
    busy = false;
    if (made && (!ctx.saveOk || ctx.saveOk())) keptToast(made.id, list.map(c => c.id));      // 没存进本机：外壳已经在说存储满了
    if (hold) { if (made) setTimeout(hold, undoHoldMs); else hold(); }
    await load();
  }
  /** 「留下了 n 段」+ 撤销：删掉那条（进「最近删除」）、候选去掉链接 → 回到待听。提示条是外壳的：离开了这页也照样撤销 */
  function keptToast(id, ids) {
    ctx.toast(t('night.kept', { n: ids.length }), { ms: 10000, action: { label: t('common.undo'), run: () => unkeep(id, ids) } });
  }
  async function unkeep(id, ids) {
    const hold = ctx.sync && ctx.sync.pause ? ctx.sync.pause('night-undo') : null;
    try { await unkeepNow(id, ids); } finally { if (hold) hold(); }
  }
  async function unkeepNow(id, ids) {
    // sha256 留着：那条（已经删了，进了「最近删除」）以后永久删除时，清理照样找得到这段的声音
    try { await Promise.all(ids.map(cid => night.patchCand(cid, { entryId: null, keptAt: null }))); }
    catch (err) { console.warn('night unkeep', err); }
    // 先改候选、读回来，再删条目：删条目时这页原地重画、开着的「昨夜」卡片重读（nightGen 变了），看到的都是改好的
    lastNight = null; nightGen++;
    if (!gone) await load();
    const e = ctx.entry(id);
    if (e && !e.deleted) ctx.mutate(s => { s.data.entries[id] = deletedRecord(s.data.entries[id]); });
    ctx.toast(t('common.undone'));
  }
  /** 勾着的一段声音没了（分片清掉了、或一片都没存进去）：标成 gone、不再勾着，说是哪一段；其余的照样勾着 */
  async function goneClip(c) {
    if (!c) { ctx.toast(t('night.gone')); return; }
    sel.delete(c.id);
    await night.patchCand(c.id, { gone: true }).catch(e => console.warn('night gone', e));
    ctx.toast(t('night.goneAt', { time: clockOf(c) }));
  }
  /** 勾着的一段是永久删除了的录音（刚同步来的永久删除）：不再勾着，说是哪一段（keepClips 已经记下它的 sha256；声音由清理删，这里不标 gone） */
  function purgedClip(c) {
    if (c) sel.delete(c.id);
    ctx.toast(c ? t('night.purgedAt', { time: clockOf(c) }) : t('night.purgedClip'));
  }

  // ---------- 详细记录 ----------
  async function copy() {
    if (!r) return;
    const ok = await copyText(textSummary(r, sessions, cands, { t, lang }));
    ctx.toast(ok ? t('night.copied') : t('common.copyFail'));
  }
  // 记录文件要带上事件日志：打开「详细记录」时先读好（分享必须在点按的那一刻调用，来不及先读数据库）
  function prepLog() {
    if (!night || !key || eventsKey === key) return;
    const k = eventsKey = key, ids = sessions.filter(s => s.nightOf === k).map(s => s.id);
    events = null; paintExport();
    Promise.all(ids.map(id => night.listEvents(id))).then(a => a.flat(), e => { console.warn('night events', e); return []; })
      .then(ev => { if (eventsKey === k) { events = ev; paintExport(); } });
  }
  const paintExport = () => { if (exportBtn) exportBtn.disabled = !(events && eventsKey === key); };
  function exportIt() {
    if (!r || !events || eventsKey !== key) return;
    saveLog(`babble-night-${key}.json`, JSON.stringify(exportLog(key, sessions, cands, events), null, 2));
  }

  draw();
  load();
  return {
    onChange: () => { if (gen !== nightGen) load(); else if (loaded && !failed) { draw(); review(); } },     // 撤销了留下（可能是离开前那一页的提示条）：重读
    cleanup: () => { gone = true; for (const p of players) p.destroy(); players = []; },
  };
}
