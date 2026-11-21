// 最近删除（#/deleted）：删除的梦话（新删的在前）和从梦话里移除的录音（新移除的在前），都能逐条恢复。
// 点一条梦话先看看原话（详情页只读显示，也能恢复）；移除的录音就地能听，点文字那一栏（名字、「来自 …」）去那条。恢复后其他设备同步时也会一起恢复。
// 删除时签了名（deletedBy）的显示是谁、用哪台设备删的。
// 不放进来的：录音页「放弃这段录音」整条丢掉的（discarded，没有字也没有录音了：恢复了也只是一条空的）、永久删除过的（墓碑）。
// 已删除的梦话里移除过的录音跟着那条走（不单列，那一行说一声有几段）：一起恢复，一起永久删除。
// 分两步上线（core/purge.js 的 PURGE_ENABLED）。打开以后才有：每一项的「永久删除」和还剩几天、
//   下面的「全部永久删除」、「没有条目在用的录音」一节、还在用旧版本的设备的提醒。关着时只能恢复，这些都不显示。
// 永久删除：先确认（说清楚删掉什么、哪里还留着），按显示的这一版删（梦话的 updatedAt、录音的 removedAt：这期间别的设备改过的不删，说一声）；
//   开着同步马上同步一次，同步不上就说「联网同步以后才删录音文件」。没有撤销。
// 「没有条目在用的录音」点「查找」才查：开着同步先同步一轮再看仓库（ctx.sync.orphans），这台设备上的也看（ctx.localOrphans）；
//   找到的记在模块里，重画、回来都还在（每次画都去掉又有条目在用、已经没了的）。只在这台设备上、没上传过的只能一段段删。
//   这次打开修过数据、数据有问题、一条梦话都没有（还没同步下来）时不显示：那时什么都像是没人用。
// 自己管更新（返回 onChange）：列的东西变了才重画（正在放的录音不断）。
// deps（测试用）：purgeEnabled 换掉开关，player 换掉播放器。
import { h, icon } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { fmtEntryDate, fmtInstant, fmtDuration } from '../core/dates.js';
import { previewLines } from '../core/dialogue.js';
import { clipName } from '../core/clips.js';
import { fmtBytes } from '../core/util.js';
import { PURGE_ENABLED } from '../core/purge.js';
import { claimShas } from '../core/store.js';
import { sayNodes } from './entry.js';
import { entryLabel } from './record.js';
import { byLabel } from './device.js';
import { deletionBy } from '../core/history.js';
import { t } from '../i18n.js';

const DAY = 864e5;
const enc = encodeURIComponent;
/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');
const listSep = lang => (lang === 'en' ? ', ' : '、');
const msOf = v => (typeof v === 'number' ? v : Date.parse(v) || null);

/** 已删除的条目，新删的在前（「放弃这段录音」丢掉的空条目、永久删除过的不算） */
export function deletedEntries(state) {
  const empty = e => e.discarded && !String(e.text || '').trim() && !(e.audio || []).length;
  return Object.values((state && state.data && state.data.entries) || {}).filter(e => e.deleted && !e.purged && !empty(e))
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0) || String(a.id).localeCompare(String(b.id)));
}
/** 移除的录音：ctx.removedClips() → [{ entryId, item, at }]，新移除的在前（没删的条目里的；ctx 没有这个 → []） */
export const removedList = (ctx) => (ctx.removedClips ? ctx.removedClips() || [] : []);
/** 最近删除里一共几项（设置页「最近删除」后面的数） */
export const trashCount = (ctx) => deletedEntries(ctx.state).length + removedList(ctx).length;
/** 还剩几天永久删除（trashInfo 的 shownAt；还没开放、不知道 → null）。不到一天算 1 天，过了算 0（「今天」） */
export const daysLeft = (shownAt, now = Date.now()) => (shownAt ? Math.max(0, Math.ceil((shownAt - now) / DAY)) : null);
/** 「n 天后永久删除」：key 是 trashKeys 的键（'e:<id>'、'c:<id>:<sha>'）；没开放、没有 ctx.trashInfo → null */
export function leftText(ctx, key, on) {
  if (!on || !ctx.trashInfo) return null;
  const n = daysLeft((ctx.trashInfo(key) || {}).shownAt);
  return n == null ? null : t('deleted.left', { n });
}
/** 还在用旧版本推送的设备（「iPad、Mac」）；没有 → '' */
export function oldDevices(ctx) {
  const st = ctx.sync && ctx.sync.status ? ctx.sync.status() || {} : {};
  return (st.oldDevices || []).filter(Boolean).join(listSep(ctx.lang()));
}

/** 这段录音还有几条别的梦话在用（永久删除了的不算）：确认框里说「那里的会留着」 */
export function sharedCount(state, id, sha) {
  return Object.values((state && state.data && state.data.entries) || {}).filter(e => e.id !== id && !e.purged
    && [...(e.audio || []), ...(e.removedAudio || [])].some(a => a.sha256 === sha)).length;
}
/** 草稿改过、里面还有这段录音转出的文字：永久删除录音时这些字留着（用户写的不删），确认框里说一声 */
export function draftKeeps(e, sha) {
  const d = e && e.draft, parts = d && Array.isArray(d.parts) ? d.parts : null;
  const part = parts && parts.find(p => p && p.sha256 === sha);
  if (!part || !String(part.text || '').trim()) return false;
  return d.text !== parts.map(p => p.text).join('\n\n') && String(d.text || '').includes(String(part.text).trim());
}

/** 「昨夜」里还没整理（留下以后撤销了）、声音就是这次要永久删除的录音的片段有几段：清理时一起删掉（core/purge.js），确认框里说一声。
 *  还有别的梦话在用的录音不算（那时不删）；没有 ctx.night、读不出来 → 0 */
export async function nightPending(ctx, entries = [], clips = []) {
  if (!ctx.night || !ctx.night.listCands) return 0;
  const E = (ctx.state && ctx.state.data && ctx.state.data.entries) || {}, ids = new Set(entries.map(x => x.id));
  const own = new Set(clips.map(c => c.id + '|' + c.sha256)), shas = new Set(clips.map(c => c.sha256)), kept = new Set();
  for (const { id } of entries) for (const a of [...((E[id] || {}).audio || []), ...((E[id] || {}).removedAudio || [])]) shas.add(a.sha256);
  for (const e of Object.values(E)) {
    if (!e || e.purged || ids.has(e.id)) continue;
    for (const a of e.audio || []) kept.add(a.sha256);
    for (const a of e.removedAudio || []) if (!own.has(e.id + '|' + a.sha256)) kept.add(a.sha256);
  }
  if (![...shas].some(s => !kept.has(s))) return 0;
  try { return ((await ctx.night.listCands()) || []).filter(c => c && !c.gone && !c.entryId && c.sha256 && shas.has(c.sha256) && !kept.has(c.sha256)).length; }
  catch (e) { return 0; }
}

/** 永久删除以后：提示删了几项、几项刚在别处改过没删；开着同步马上同步一次，同步不上说一声（录音文件等同步以后才删） */
async function afterPurge(ctx, r, on) {
  const done = r.done || [], changed = r.changed || [];
  const msg = [done.length ? (done.length === 1 ? t('common.purged') : t('common.purgedN', { n: done.length })) : null,
    changed.length ? t('deleted.changedElsewhere', { n: changed.length }) : null].filter(Boolean).join('\n');
  if (msg) ctx.toast(msg, { ms: changed.length ? 8000 : 4000 });
  if (!on || !done.length) return;
  const s = await Promise.resolve(ctx.sync.now()).catch(() => null);
  if (!s || !s.ok || (ctx.local.sync && ctx.local.sync.offline)) ctx.toast(t('common.purgedOffline'), { ms: 8000 });
}

/**
 * 永久删除「最近删除」里的几项（这一页和详情页共用）：先确认，再 ctx.purgeAll（开着同步时它先同步一次，变了的不删）。没有撤销。
 *   确认框还说：「昨夜」里还没整理、声音就是这些录音的片段会一起删掉；开着同步时各台设备上的录音文件再留 7 天才删（core/purge.js）。
 * @param {object} ctx
 * @param {{ entries?: Array<{id, at}>, clips?: Array<{id, sha256, removedAt}>, all?: boolean, shared?: number, draftKept?: boolean }} what
 *   显示给用户的那几项（at = 显示的那一版的 updatedAt，removedAt = 显示的移除时刻）；all：「全部永久删除」；
 *   shared / draftKept：只删一段录音时，别的梦话也在用它 / 草稿里还留着它转出的字
 * @param {{ onGo?: () => void }} [o]  点了确认、开始删的时候（页面换成「正在永久删除…」）
 * @returns {Promise<{done, changed}|null>}  取消了 → null
 */
export async function askPurge(ctx, { entries = [], clips = [], all = false, shared = 0, draftKept = false }, { onGo = null } = {}) {
  if (!entries.length && !clips.length) return null;
  const on = !!ctx.sync.status().on, old = oldDevices(ctx);
  const one = entries.length + clips.length === 1;              // 「全部永久删除」时只有一项：也按一项说
  if (one && all && clips.length) {
    shared = sharedCount(ctx.state, clips[0].id, clips[0].sha256);
    draftKept = draftKeeps(ctx.entry ? ctx.entry(clips[0].id) : null, clips[0].sha256);
  }
  const title = !one ? t('deleted.confirmAllT') : entries.length ? t('deleted.confirmT') : t('deleted.confirmClipT');
  const lines = !one ? [t('deleted.purgeAllMsg', { n: entries.length, clips: clips.length })]
    : entries.length ? [t(on ? 'deleted.purgeMsg' : 'deleted.purgeMsgLocal')]
    : [t(on ? 'deleted.purgeClipMsg' : 'deleted.purgeClipMsgLocal'), shared ? t('deleted.shared', { n: shared }) : null, draftKept ? t('deleted.draftKept') : null];
  const night = await nightPending(ctx, entries, clips);
  if (night) lines.push(t('deleted.nightPending', { n: night }));
  if (on) lines.push(t('deleted.graceNote'), t('deleted.historyNote'));
  if (old) lines.push(t('deleted.oldDevices', { devices: old }));
  if (!(await ctx.confirm({ title, message: lines.filter(Boolean).join('\n'), confirmLabel: t('common.purge'), danger: true }))) return null;
  if (onGo) onGo();
  let r;
  try { r = (await ctx.purgeAll({ entries, clips })) || { done: [], changed: [] }; }
  catch (e) { ctx.toast(t('common.renderError') + ((e && e.message) || String(e)), { ms: 8000 }); return null; }
  afterPurge(ctx, r, on);
  return r;
}

// 「没有条目在用的录音」上次找到的（换了仓库就不算了）：{ repo, rows: [{ sha256, mime, bytes, at, here, uploaded, repo }], recent, more, err }
let found = null;
/** 上次找到的，去掉现在又有条目在用（含最近删除里的、移除的）、已经没了的；没查过、换了仓库 → null */
function knownOrphans(ctx) {
  const st = ctx.sync && ctx.sync.status ? ctx.sync.status() || {} : {};
  if (!found || found.repo !== (st.repo || null)) return null;
  const claimed = claimShas(ctx.state), gone = ctx.goneShas ? ctx.goneShas() : new Set();
  return found.rows.filter(r => !claimed.has(r.sha256) && !gone.has(r.sha256));
}
/** 上次「查找」找到的、还在同步仓库里的有几段（清理云端历史的确认框说「也会留下」；没查过 → 0） */
export const foundInRepo = (ctx) => (knownOrphans(ctx) || []).filter(r => r.repo).length;

export function render(main, params, ctx, { purgeEnabled: purgeOn = PURGE_ENABLED, player = audioPlayer } = {}) {
  const lang = ctx.lang();
  const sp = () => ctx.state.settings.speakers;
  let players = [], busy = false, finding = false, sig = null;

  const navbar = () => h('header.navbar', null,
    h('button.back', { type: 'button', onclick: () => ctx.back('/settings') }, icon('back'), t('nav.settings')),
    h('span.nb-title', null, t('nav.deleted')),
    h('span'));
  // 读屏念按钮时连同是哪一项（「恢复：11月4日 凌晨2:58 · …」）
  const act = (key, what) => (what ? t('deleted.actLabel', { act: t(key), what }) : t(key));
  const restoreBtn = (fn, what) => h('button.btn.small.soft.del-restore', { type: 'button', disabled: busy, onclick: fn, 'aria-label': act('common.restore', what) }, t('common.restore'));
  const purgeBtn = (fn, what) => (purgeOn ? h('button.btn.small.danger.del-purge', { type: 'button', disabled: busy, onclick: fn, 'aria-label': act('common.purge', what) }, t('common.purge')) : null);

  // 日期时间 + 第一句原话（条目没有标题）；什么都没写 →「还没写原话」
  const entryRow = (e) => {
    const line = previewLines(e.text, sp(), 1)[0], by = byLabel(deletionBy(e), sp());
    const n = (e.removedAudio || []).length, what = entryLabel(e, sp(), lang);
    // 里面移除过的录音跟着这条走（不在「移除的录音」里单列）：说一声，开放以后是「会一起删掉」，现在是「恢复以后回到移除的录音」
    const more = [leftText(ctx, 'e:' + e.id, purgeOn), n ? t(purgeOn ? 'deleted.hasRemoved' : 'deleted.hasRemovedKeep', { n }) : null].filter(Boolean);
    return h('div.group-row.del-row', null,
      h('a.del-body', { href: '#/e/' + enc(e.id) },
        h('span.del-date', null, fmtEntryDate(e, lang, { sep: daySep(lang) })),
        line ? h('span.del-prev' + (line.type === 'line' ? '.kai' : ''), null, line.who ? sp()[line.who].emoji + ' ' : '', sayNodes(line.content))
          : h('span.del-prev.ph', null, t('list.noText')),
        h('span.del-at', null, t('deleted.at', { time: fmtInstant(e.deletedAt, lang) }), by ? ' · ' + by : ''),
        more.length ? h(purgeOn ? 'span.del-left' : 'span.del-at', null, more.join(' · ')) : null),
      h('span.del-acts', null, restoreBtn(() => ctx.restore(e.id), what),
        purgeBtn(() => run({ entries: [{ id: e.id, at: e.updatedAt }] }), what)));
  };

  // 移除的录音：小播放钮、名字 · 时长、来自哪条、几时移除的（点文字那一栏去那条）。
  // 没起名字的叫「移除的录音」，不按位置编号：编号是在条目里的位置，移除以后条目里剩下的会重新编，对不上
  const clipRow = ({ entryId, item }) => {
    const e = ctx.entry(entryId), sha = item.sha256;
    const p = player({ getBlob: () => ctx.clipBlob(sha, item.mime), durationSec: item.durationSec, compact: true, key: sha });
    players.push(p);
    const dur = fmtDuration(item.durationSec), left = leftText(ctx, 'c:' + entryId + ':' + sha, purgeOn);
    const name = clipName(item) || t('deleted.clipFallback'), from = e ? entryLabel(e, sp(), lang) : null;
    const body = [h('span.del-name', null, name, dur ? h('small', null, ' · ' + dur) : null),
      from ? h('span.del-from', null, t('deleted.clipFrom', { what: from })) : null,
      h('span.del-at', null, t('deleted.removedAt', { time: fmtInstant(item.removedAt, lang) }), left ? ' · ' + left : '')];
    const what = [name, from].filter(Boolean).join(' · ');
    return h('div.group-row.del-row.del-clip', null, p,
      e ? h('a.del-body', { href: '#/e/' + enc(entryId) }, ...body) : h('div.del-body', null, ...body),
      h('span.del-acts', null, restoreBtn(() => restoreClip(entryId, sha), what),
        purgeBtn(() => run({ clips: [{ id: entryId, sha256: sha, removedAt: item.removedAt }], shared: sharedCount(ctx.state, entryId, sha), draftKept: draftKeeps(e, sha) }), what)));
  };
  function restoreClip(id, sha) {
    const r = ctx.restoreClip ? ctx.restoreClip(id, sha) : null;
    if (r) ctx.toast(t('deleted.clipRestored'));
  }

  // ---------- 永久删除 ----------
  async function run(what) {
    if (busy) return;
    try { await askPurge(ctx, what, { onGo: () => { busy = true; draw(); } }); }
    finally { if (busy) { busy = false; draw(); } }
  }

  // ---------- 没有条目在用的录音 ----------
  const orphansAllowed = () => purgeOn && !(ctx.storageIssue && ctx.storageIssue())
    && !(Number(ctx.local.repairedAt) >= (ctx.bootAt || Infinity))
    && Object.values(ctx.state.data.entries || {}).some(e => !e.purged);
  async function findOrphans() {
    if (finding) return;
    finding = true; draw();
    const st = ctx.sync.status(), on = !!st.on;
    const next = { repo: st.repo || null, rows: [], recent: 0, more: false, err: null };
    try {
      // 开着同步：先同步一轮再看仓库（别的设备刚加的录音这时才算有条目在用）；这台设备上的也在那以后看
      const remote = on && ctx.sync.orphans ? await ctx.sync.orphans() : null;
      if (remote && (remote.ok === false || remote.error)) throw remote.error || { code: 'unknown' };
      const local = ctx.localOrphans ? (await ctx.localOrphans()) || [] : [];
      const by = new Map();
      for (const c of local) by.set(c.sha256, { sha256: c.sha256, mime: c.mime, bytes: c.bytes ?? null, at: msOf(c.addedAt), here: true, uploaded: !!c.uploaded, repo: false });
      for (const f of (remote && remote.files) || []) {
        const r = by.get(f.sha256) || { sha256: f.sha256, mime: f.mime, bytes: f.size ?? null, at: msOf(f.at), here: false, uploaded: false };
        by.set(f.sha256, { ...r, repo: true, mime: r.mime || f.mime, bytes: r.bytes ?? f.size ?? null });
      }
      next.rows = [...by.values()].sort((a, b) => (b.at || 0) - (a.at || 0) || a.sha256.localeCompare(b.sha256));
      next.recent = (remote && remote.recent) || 0; next.more = !!(remote && remote.more);
    } catch (e) { next.err = { code: e && typeof e.code === 'string' ? e.code : 'unknown', vars: (e && e.vars) || {} }; }
    found = next; finding = false;
    if (main.isConnected) draw();
  }
  async function purgeOrphans(rows) {
    if (busy || !rows.length) return;
    const on = !!ctx.sync.status().on, old = oldDevices(ctx);
    const onlyHere = rows.some(r => r.here && !r.repo && !r.uploaded);
    const lines = [t(on ? 'deleted.orphansMsg' : 'deleted.orphansMsgLocal'), onlyHere ? t('deleted.orphansOnlyHereMsg') : null,
      on ? t('deleted.graceNote') : null, on ? t('deleted.historyNote') : null, old ? t('deleted.oldDevices', { devices: old }) : null];
    if (!(await ctx.confirm({ title: t('deleted.orphansT', { n: rows.length }), message: lines.filter(Boolean).join('\n'), confirmLabel: t('common.purge'), danger: true }))) return;
    busy = true; draw();
    try {
      const r = (await ctx.purgeOrphans(rows.map(x => ({ sha256: x.sha256, mime: x.mime })))) || { done: [], changed: [] };
      if (found) found.rows = found.rows.filter(x => !(r.done || []).includes(x.sha256));
      afterPurge(ctx, r, on);
    } catch (e) { ctx.toast(t('common.renderError') + ((e && e.message) || String(e)), { ms: 8000 }); }
    finally { busy = false; draw(); }
  }
  const orphanRow = (r) => {
    const p = player({ getBlob: () => ctx.clipBlob(r.sha256, r.mime), compact: true, key: r.sha256 });
    players.push(p);
    const where = r.here && r.repo ? 'deleted.orphansBoth' : r.repo ? 'deleted.orphansRepo' : 'deleted.orphansHere';
    const meta = [fmtBytes(r.bytes), r.at ? t('deleted.added', { time: fmtInstant(r.at, lang, { year: true }) }) : null].filter(Boolean).join(' · ');
    return h('div.group-row.del-row.del-clip', null, p,
      h('div.del-body', null,
        h('span.del-name', null, t(where)),
        r.here && !r.repo && !r.uploaded ? h('span.del-warn', null, t('deleted.orphansOnlyHere')) : null,
        meta ? h('span.del-at', null, meta) : null),
      h('span.del-acts', null, h('button.btn.small.danger.del-purge', { type: 'button', disabled: busy, onclick: () => purgeOrphans([r]),
        'aria-label': t('deleted.actLabel', { act: t('common.purge'), what: [t(where), meta].filter(Boolean).join(' · ') }) }, t('common.purge'))));
  };
  function orphanSec() {
    const rows = knownOrphans(ctx), shared = rows ? rows.filter(r => r.repo || r.uploaded) : [];
    return h('section.del-orphans#orphans', null,
      h('h2.group-h', null, t('deleted.orphansH')),
      h('p.group-foot.del-help', null, t('deleted.orphansHelp')),
      h('button.btn.small.del-find', { type: 'button', disabled: finding || busy, onclick: findOrphans }, finding ? t('deleted.orphansFinding') : t('deleted.orphansFind')),
      found && found.err && rows ? h('p.err.small', { role: 'alert' }, t('syncErr.' + found.err.code, found.err.vars)) : null,
      rows && !found.err && !rows.length ? h('p.group-foot', { role: 'status' }, t('deleted.orphansNone')) : null,
      rows && rows.length ? h('div.group.del-list', null, rows.map(orphanRow)) : null,
      shared.length > 1 ? h('button.btn.danger.block.del-all', { type: 'button', disabled: busy, onclick: () => purgeOrphans(shared) }, t('deleted.orphansPurgeAll')) : null,
      rows && found.recent ? h('p.group-foot', null, t('deleted.orphansRecent', { n: found.recent })) : null,
      rows && found.more ? h('p.group-foot', null, t('deleted.orphansMore')) : null);
  }

  // ---------- 画 ----------
  function build() {
    const list = deletedEntries(ctx.state), clips = removedList(ctx), old = purgeOn ? oldDevices(ctx) : '';
    const any = list.length + clips.length > 0;
    const hint = t(purgeOn ? 'deleted.hintPurge' : 'deleted.hint');
    // 「全部永久删除」按显示的这些删（每一项显示的那一版），不在点下去的时候重新算
    const all = { all: true, entries: list.map(e => ({ id: e.id, at: e.updatedAt })), clips: clips.map(c => ({ id: c.entryId, sha256: c.item.sha256, removedAt: c.item.removedAt })) };
    return [navbar(),
      h('div.page.deleted', null,
        old ? h('p.group-foot.del-old', { role: 'note' }, t('deleted.oldDevices', { devices: old })) : null,
        list.length ? [h('h2.group-h', null, t('deleted.entriesH')), h('div.group.del-list', null, list.map(entryRow))] : null,
        clips.length ? [h('h2.group-h', null, t('deleted.clipsH')), h('div.group.del-list', null, clips.map(clipRow))] : null,
        any ? [purgeOn ? h('button.btn.danger.block.del-all', { type: 'button', disabled: busy, onclick: () => run(all) }, busy ? t('deleted.purging') : t('deleted.purgeAll')) : null,
          h('p.group-foot', null, hint)]
          : h('div.empty.del-empty', null, icon('trash'), h('p', null, t('deleted.empty')), h('p.small', null, hint)),
        orphansAllowed() ? orphanSec() : null)];
  }
  /** 列的东西（和几个开关、称呼表情）的指纹：没变就不重画 */
  const sigOf = () => JSON.stringify([busy, finding, oldDevices(ctx), sp(), deletedEntries(ctx.state).map(e => [e.id, e.updatedAt]),
    removedList(ctx).map(c => [c.entryId, c.item.sha256, c.item.removedAt, c.at]), orphansAllowed() ? (knownOrphans(ctx) || []).map(r => r.sha256) : null]);
  function draw() {
    const sc = ctx.layout && ctx.layout() === 'phone' ? document.scrollingElement : main;
    const top = sc ? sc.scrollTop : 0;
    for (const p of players) p.destroy();
    players = [];
    main.replaceChildren(...build().filter(Boolean));
    if (sig !== null && sc) sc.scrollTop = top;
    sig = sigOf();
  }
  const redraw = () => { if (sigOf() !== sig) draw(); };

  draw();
  if (ctx.on) ctx.on('sync', redraw);                 // 旧版本设备的提醒跟着同步状态变
  return {
    onChange: redraw,
    cleanup: () => { for (const p of players) p.destroy(); players = []; },
  };
}
