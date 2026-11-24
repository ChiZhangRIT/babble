// 设置（#/settings）和同步（#/settings/sync）。
// 设置页自己管更新（返回 onChange）：正在输入时（比如在填名字、令牌）数据变了不重画，等离开输入框再画，免得吞掉输入。
// 也导出 backupBox（导出备份的按钮和「分享 / 下载」）：从备忘录迁移完成页也用它。
// 「最近删除」后面的数 = 删除的梦话 + 移除的录音。存储：这台设备上已经永久删除、等同步确认才删的录音有几段。
// 从备份恢复：开着同步先同步一次（别的设备刚永久删除的也算上），永久删除了的录音不存回来（确认框、完成后都说几段）。
// 同步页「已更新到新版的设备」：每台用上这一版的设备在同步的数据里报到（data.devices，app.js 写），这里列出报到过的、
//   最近改过梦话（修改记录的签名）或还在用旧版本推送、却还没报到的设备名（两步上线时靠它看每台设备是不是都更新了）。
// 开关 core/purge.js 的 PURGE_ENABLED 开着时（现在开着；deps.purgeEnabled 测试用）才有：存储里「其中 n 段没有条目在用」「删除修复存档」，
//   同步页的「清理云端历史」（先确认：说清楚留下什么、旧版本的设备、备份、别的分支；成功后给 Mac 上换文件夹的步骤）、旧版本设备的提醒。
//   停止同步、换到别的仓库时还有没从仓库删掉的录音：确认框里说一声（不受开关影响）。
import { h, icon, copyText, download } from '../ui/dom.js';
import { LANGS, LANG_LABELS, t } from '../i18n.js';
import { SyncError, syncCode, parseSyncCode, syncPhase, tokenWarn, tokenExpired, tokenDaysLeft } from '../core/sync.js';
import { buildBackup, readBackup, restoreBackup, restorePlan, backupFileName } from '../core/backup.js';
import { ARCHIVE_PREFIX } from '../core/persistence.js';
import { PURGE_ENABLED } from '../core/purge.js';
import { isTime, localParts, fmtTime, fmtDate, fmtInstant, daysAgo } from '../core/dates.js';
import { fmtBytes, uniq } from '../core/util.js';
import { deviceSec, byLabel } from './device.js';
import { trashCount, deletedEntries, removedList, oldDevices, foundInRepo, orphansShown } from './deleted.js';
import { fmtAgo } from './history.js';
import { sttSettings } from '../ui/stt.js';
/** replaceChildren，但跳过 null / false（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const TOKEN_DOCS = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token';
const MAX_MIN = [5, 10, 15, 20, 30, 60];
const THEMES = ['auto', 'light', 'dark'];
const DAY = 86400000;
// 令牌到期日：GitHub 的到期时间响应头浏览器读不到（跨域没开放），只能让用户填（新建令牌时页面上有）。存成那天本地 23:59 的毫秒数
const expMs = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], 23, 59).getTime() : null; };
/** 浏览器的存储接口偶尔一直不回（比如有的 WebView 里 persisted()）：最多等 ms，超时当作不知道 */
export const within = (p, ms = 3000, fallback = null) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise(r => setTimeout(() => r(fallback), ms))]);

export function render(main, params, ctx, deps = {}) {
  const purgeOn = deps.purgeEnabled ?? PURGE_ENABLED;
  return params.sub === 'sync' ? syncPage(main, params, ctx, purgeOn) : mainPage(main, params, ctx, purgeOn);
}

/** 这台设备上的修复存档（数据修复时留下的原件：persistence.js 写的 babble.recovery.*）的键 */
function archiveKeys() {
  const out = [];
  try { const st = globalThis.localStorage; for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && k.startsWith(ARCHIVE_PREFIX)) out.push(k); } } catch (e) { /* 读不到就当没有 */ }
  return out;
}

// ---------- 小部件 ----------
// 语言那一行的标题中英文都写（不管现在是哪种语言都认得出），自己的语言写在前面（和 PickNest 等几个 App 一样）
const LANG_ROW = { 'zh-Hans': '语言 / Language', 'zh-Hant-TW': '語言 / Language', en: 'Language / 语言' };
const sec = (id, title, kids, foot) => h('section.set-sec', { id: id ? 'set-' + id : null },
  title ? h('h2.group-h', null, title) : null, h('div.group', null, kids), foot ? h('div.group-foot', null, foot) : null);
// 只有一个输入框 / 开关时整行是 <label>（点哪里都行）；分段按钮之类用 <div>，免得点文字误按第一个按钮
const row = (label, control, help) => h((/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) ? 'label' : 'div') + '.group-row.set-row', null,
  h('span.set-label', null, label, help ? h('small', null, help) : null), control);
const toggleRow = (label, checked, onchange, help) => row(label, h('input.toggle', { type: 'checkbox', role: 'switch', checked, onchange: (e) => onchange(e.target.checked) }), help);
const linkRow = (href, ic, label, value, help) => h('a.group-row.set-link', { href }, ic ? icon(ic) : null,
  help ? h('span.set-label', null, label, h('small', null, help)) : h('span', null, label), h('span.sp'), value != null ? h('span.value', null, value) : null);

// 同步状态 → 圆点的样子：ok 绿、wait 灰（同步中、离线、待同步）、warn 黄（令牌快到期）、err 红、off 空心
const PHASE_CLS = { off: 'off', err: 'err', running: 'wait', offline: 'wait', token: 'warn', pending: 'wait', ok: 'ok' };
const PHASE_TEXT = { off: 'sync.off', err: 'sync.error', running: 'sync.syncing', offline: 'sync.offline', token: 'sync.tokenSoon', pending: 'sync.pending' };
/** 同步状态的一句话和颜色（ok / wait / warn / err / off）；怎么排在 core/sync.js 的 syncPhase（侧栏的小标签 app.js 也用这个） */
export function syncState(st, lang, now = Date.now()) {
  const phase = syncPhase(st, now);
  if (phase !== 'ok') return { cls: PHASE_CLS[phase], text: t(PHASE_TEXT[phase]), phase };
  const p = st.at ? localParts(st.at) : null;
  return { cls: 'ok', text: p ? t('sync.ok', { time: fmtTime(p.time, lang) }) : t('sync.ok0'), phase };
}
/** 令牌快到期 / 已经过期时那一句（怎么换）；还早、没填 → null。同步页和侧栏小标签的提示（鼠标停上去）用 */
export function tokenNote(exp, now = Date.now()) {
  if (!tokenWarn(exp, now)) return null;
  if (tokenExpired(exp, now)) return t('set.tokenExpired');
  const n = tokenDaysLeft(exp, now);
  return n <= 0 ? t('set.tokenToday') : t('set.tokenSoon', { n });
}
const stateDot = (s) => h('span.set-state.' + s.cls, null, h('span.dot', { 'aria-hidden': 'true' }), s.text);

/** 重画但不打断输入：焦点在本页的输入框里就等它离开再画 */
function quietRedraw(main, draw) {
  let pending = false;
  const busy = () => { const a = document.activeElement; return a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox'; };
  const run = () => {
    pending = false;
    const sc = main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
    const top = sc.scrollTop;
    draw();
    sc.scrollTop = top;
  };
  const onOut = () => setTimeout(() => { if (pending && !busy()) run(); }, 0);
  main.addEventListener('focusout', onOut);
  return { soon: () => { if (busy()) pending = true; else run(); }, off: () => main.removeEventListener('focusout', onOut) };
}

// ======================================================================
// 设置
// ======================================================================
function mainPage(main, params, ctx, purgeOn) {
  const lang = ctx.lang(), langRow = LANG_ROW[lang] || LANG_ROW['zh-Hans'];
  const page = h('div.page.set');
  main.append(h('header.page-head', null, h('h1.lt', null, t('nav.settings'))), page);
  let storageInfo = null;
  const bbox = backupBox(ctx, { onSaved: () => redraw.soon() });     // 跨重画保留：打包好的备份不会因为同步一下就没了
  // 「关于」里的「新版本已经下载好了」：跨重画是同一个元素（role=status），下载好的那一刻读屏才念得出来
  const updateLine = h('p.small.set-update', { role: 'status' }, t('set.updateReady'));
  const paintUpdate = () => { updateLine.hidden = !(ctx.updateReady && ctx.updateReady()); };

  function draw() {
    const S = ctx.state.settings, L = ctx.local;
    const st = ctx.sync.status();
    const deletedN = trashCount(ctx);
    const pend = [st.pendingUp ? t('sync.audioUp', { n: st.pendingUp }) : null, st.pendingDown ? t('sync.audioDown', { n: st.pendingDown }) : null].filter(Boolean).join(' · ');
    fill(page,
      // 语言放最上面，标题三种语言都写：不管现在是哪种语言都找得到
      sec('lang', null, [row(langRow, h('select.set-in.set-select', { 'aria-label': langRow, onchange: (e) => ctx.setLang(e.target.value) },
        LANGS.map(l => h('option', { value: l, selected: l === lang }, LANG_LABELS[l]))))]),
      sec('sync', t('set.syncH'), [h('a.group-row.set-link', { href: '#/settings/sync' }, icon('share'), h('span', null, t('set.sync')), h('span.sp'), stateDot(syncState(st, lang)))],
        st.on ? (pend || (st.repo ? t('set.syncRepo', { repo: st.repo }) : null)) : t('set.syncOffFoot')),
      speakersSec(S),
      deviceSec(ctx, { sec, row }),
      nightSec(S),
      sec('look', t('set.lookH'), [
        row(t('set.theme'), h('div.seg.set-seg', { role: 'group', 'aria-label': t('set.theme') }, THEMES.map(v => {
          const on = (L.theme || 'auto') === v;
          return h('button', { type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), onclick: () => { ctx.setTheme(v); draw(); } }, t('set.theme.' + v));
        }))),
      ], S.nightForcesDark ? t('set.lookFoot') : null),
      sttSettings(ctx),                // 语音转文字（模型、下载 / 删除）：自己跟着下载进度更新
      backupSec(L),
      storageSec(),
      sec('data', t('set.dataH'), [
        linkRow('#/import', 'import', t('nav.import')),
        linkRow('#/import/notes', 'bubble', t('nav.importNotes')),
        linkRow('#/deleted', 'trash', t('nav.deleted'), deletedN ? String(deletedN) : null),
        ctx.recoveryArchive?.() ? h('button.group-row.set-link', { type: 'button', onclick: () => download('babble-recovery-original.json', JSON.stringify(ctx.recoveryArchive(), null, 2), 'application/json') }, t('recovery.archive')) : null,
      ]),
      tipsSec(),
      sec('diag', t('set.diagH'), [linkRow('#/diag', 'mic', t('nav.diag'))], t('set.diagFoot')),
      aboutSec(),
    );
    if (params.query && params.query.focus) {
      const el = page.querySelector('#set-' + CSS.escape(params.query.focus));
      if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
      params.query.focus = null;
    }
  }

  // ---------- 称呼与表情 ----------
  function speakersSec(S) {
    const sp = S.speakers;
    const nameIn = (who, ph) => h('input.set-in', { type: 'text', value: sp[who].name || '', placeholder: ph, maxlength: 20, autocomplete: 'off',
      onchange: (e) => setSpeaker(who, { name: e.target.value }) });
    const emojiIn = (who) => h('input.set-in.set-emoji', { type: 'text', value: sp[who].emoji, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('set.emoji'),
      onchange: (e) => setSpeaker(who, { emoji: e.target.value }, e.target) });
    const aliases = [...(sp.nn.aliases || []), ...(sp.me.aliases || [])];
    return sec('speakers', t('set.speakersH'), [
      row(t('set.nnName'), nameIn('nn', 'NN')),
      row(t('set.nnEmoji'), emojiIn('nn')),
      row(t('set.meName'), nameIn('me', t('set.mePh'))),
      row(t('set.meEmoji'), emojiIn('me')),
    ], [t('set.speakersFoot'), aliases.length ? h('span', null, ' ', t('set.aliases', { list: aliases.join(' ') })) : null]);
  }
  function setSpeaker(who, patch, input) {
    const s = structuredClone(ctx.state.settings.speakers);
    const p = s[who];
    if (patch.name != null) p.name = patch.name.trim();
    if (patch.emoji != null) {
      const e = patch.emoji.trim();
      const other = s[who === 'nn' ? 'me' : 'nn'];
      if (!e || e === p.emoji) { if (input) input.value = p.emoji; return; }
      if (e === other.emoji || (other.aliases || []).includes(e)) { ctx.toast(t('set.emojiTaken')); if (input) input.value = p.emoji; return; }
      p.aliases = uniq([...(p.aliases || []), p.emoji]).filter(a => a !== e);      // 旧表情留着认：以前写的不用改
      p.emoji = e;
    }
    ctx.setSetting('speakers', s);
  }

  // ---------- 夜间 ----------
  function nightSec(S) {
    const timeIn = (key) => h('input.set-in.set-time', { type: 'time', value: S[key], 'aria-label': t('set.' + key),
      onchange: (e) => { if (isTime(e.target.value)) ctx.setSetting(key, e.target.value); else e.target.value = ctx.state.settings[key]; } });
    return sec('night', t('set.nightH'), [
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.nightHours')), h('span.set-range', null, timeIn('nightStart'), h('span.muted', null, '–'), timeIn('nightEnd'))),
      toggleRow(t('set.nightOpens'), S.nightOpensRecorder, (v) => ctx.setSetting('nightOpensRecorder', v)),
      toggleRow(t('set.nightDark'), S.nightForcesDark, (v) => ctx.setSetting('nightForcesDark', v)),
      row(t('set.maxRec'), h('select.set-in.set-select', { onchange: (e) => ctx.setSetting('maxRecordMin', Number(e.target.value)) },
        uniq([...MAX_MIN, S.maxRecordMin]).sort((a, b) => a - b).map(n => h('option', { value: n, selected: n === S.maxRecordMin }, t('set.minutes', { n }))))),
      // 床头模式（不在夜里打开 App 的时候、iPad、Mac 上从这里找）和每一晚的记录（views/night.js）
      linkRow('#/rec?bed=1', 'mic', t('night.setBed'), null, t('night.setBedHelp')),
      linkRow('#/night', 'clock', t('night.setNights')),
    ], ctx.isNight() ? t('set.nightNow') : t('set.nightFoot'));
  }

  // ---------- 备份 ----------
  function backupSec(L) {
    const fileIn = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true,
      onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreFrom(ctx, f, purgeOn); } });
    const ago = L.lastBackupAt ? daysAgo(L.lastBackupAt) : null;
    const last = L.lastBackupAt ? (ago === 0 ? t('set.backupToday') : t('set.backupAgo', { n: ago })) : t('set.backupNever');
    const stale = !L.lastBackupAt || ago >= 30;
    return sec('backup', t('set.backupH'), [
      h('div.group-row.set-block', null, bbox),
      h('button.group-row.set-link.go', { type: 'button', onclick: () => fileIn.click() }, icon('import'), h('span', null, t('set.restore'))),
      fileIn,
    ], [h('span' + (stale ? '.set-warn' : ''), null, t('set.backupLast', { when: last })), ' ', t('set.backupFoot')]);
  }

  // ---------- 存储 ----------
  function storageSec() {
    const usage = h('span.value', null, storageInfo ? storageInfo.usage : t('common.loading'));
    const clips = h('span.value', null, storageInfo ? storageInfo.clips : '');
    const pers = h('span.value', null, storageInfo ? storageInfo.persisted : '');
    const ask = storageInfo && !storageInfo.isPersisted ? h('button.btn.small', { type: 'button', onclick: async () => {
      const ok = await within(ctx.audio.persist(), 8000, false);
      ctx.toast(ok ? t('set.persistOk') : t('set.persistNo'), { ms: 7000 });
      storageInfo = null; loadStorage();
    } }, t('set.persistAsk')) : null;
    if (!storageInfo) loadStorage();
    const I = storageInfo || {}, archives = purgeOn ? archiveKeys() : [];
    return sec('storage', t('set.storageH'), [
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.used')), usage),
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.clips'),
        I.pending ? h('small.set-warn', null, t('set.clipsPending', { n: I.pending })) : null), clips),
      // 点了直接到「最近删除 → 没有梦话在用的录音」；那一节不显示的时候（这次打开修过数据、从备份恢复过……）这一行也不显示
      I.unused && orphansShown(ctx, purgeOn) ? linkRow('#/deleted?focus=orphans', null, t('set.clipsUnused', { n: I.unused })) : null,
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.persisted'), h('small', null, t('set.persistHelp'))), h('span.set-persist', null, pers, ask)),
      archives.length ? h('div.group-row.set-row', null, h('span.set-label', null, t('set.archives', { n: archives.length })),
        h('button.btn.small.danger', { type: 'button', onclick: () => dropArchives() }, t('set.archivesDel'))) : null,
    ], t('set.storageFoot'));
  }
  /** 删除修复存档（确认以后）：数据修复时留下的原件，里面可能还有已经删除、永久删除的原话 */
  async function dropArchives() {
    if (!(await ctx.confirm({ title: t('set.archivesDel'), message: t('set.archivesConfirm'), confirmLabel: t('set.archivesDel'), danger: true }))) return;
    try { for (const k of archiveKeys()) globalThis.localStorage.removeItem(k); } catch (e) { console.warn('archives', e); }
    ctx.setLocal({ archiveLeft: null });
    ctx.toast(t('set.archivesDone'));
    draw();
  }
  let loading = false;
  async function loadStorage() {
    if (loading) return;
    loading = true;
    const [est, isP, list, orphans] = await Promise.all([within(ctx.audio.estimate()), within(ctx.audio.persisted()), within(ctx.audio.listClips(), 8000, []),
      purgeOn && ctx.localOrphans ? within(ctx.localOrphans(), 8000, []) : []]);
    loading = false;
    const bytes = list.reduce((n, c) => n + (c.bytes || 0), 0), gone = ctx.goneShas ? ctx.goneShas() : new Set();
    storageInfo = {
      pending: list.filter(c => gone.has(c.sha256)).length,       // 永久删除了、还在这台设备上（等同步确认、或者一小时内碰过）
      unused: (orphans || []).length,
      usage: est && est.usage != null ? (est.quota ? t('set.usedOf', { used: fmtBytes(est.usage), free: fmtBytes(Math.max(0, est.quota - est.usage)) }) : fmtBytes(est.usage)) : t('set.unknown'),
      clips: t('set.clipsN', { n: list.length, size: fmtBytes(bytes) || '0 B' }),
      persisted: isP == null ? t('set.unknown') : isP ? t('set.persistYes') : t('set.persistNot'), isPersisted: !!isP,
    };
    if (main.isConnected) redraw.soon();
  }

  function tipsSec() {
    const nn = ctx.state.settings.speakers.nn.name || 'NN';
    return h('section.set-sec#set-tips', null, h('h2.group-h', null, t('set.tipsH')),
      h('div.card.set-tips', null, h('ul', null, ['tip1', 'tip2', 'tip3', 'tip6', 'tip4', 'tip5'].map(k => h('li', null, t('set.' + k, { nn }))))));
  }
  function aboutSec() {
    return h('section.set-sec#set-about', null, h('h2.group-h', null, t('set.aboutH')),
      h('div.card.set-about', null,
        h('div.set-about-top', null, h('img', { src: 'icons/icon-180-v4.png', alt: '', width: 48, height: 48, onerror: (e) => e.target.remove() }),
          h('div', null, h('b.kai', null, t('common.appName')), h('p.small.muted', null, t('set.aboutLine')),
            ctx.build ? h('p.small.muted.set-version', null, t('set.version', { v: ctx.build })) : null)),
        h('ul.small', null, ['about1', 'about2', 'about3'].map(k => h('li', null, t('set.' + k)))),
        updateLine));
  }

  const redraw = quietRedraw(main, draw);
  paintUpdate();
  draw();
  ctx.on('sync', () => redraw.soon());
  ctx.on('update', paintUpdate);          // 新版本在后台装好了（core/update.js，app.js 发 'update'）：只改这一行，不重画
  return { onChange: () => redraw.soon(), cleanup: () => redraw.off() };
}

/** 从备份恢复：先读、核对 sha256，告诉用户里面有什么，确认后再合并（较新的为准，不删本机的）。
 *  开着同步先同步一次（尽力，最多等 10 秒；开关关着也同步：别的设备可能已经开着永久删除）：别的设备刚永久删除的也算上，
 *  那些录音不存回来。同步慢的话提示条说一声「正在同步」，不让人干等 */
async function restoreFrom(ctx, file, purgeOn = false) {
  let r;
  try { r = await readBackup(file); }
  catch (e) { ctx.toast(e && e.code === 'badBackup' ? t('set.badBackup') : t('set.restoreFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); return; }
  if (ctx.sync.status().on) {
    let note = null;
    const slow = setTimeout(() => { note = ctx.toast(t('set.restoreSyncing'), { ms: 12000 }); }, 400);
    try { await within(ctx.sync.now(), 10000, null); }
    finally { clearTimeout(slow); if (note && note.close) note.close(); }
  }
  const n = Object.values(r.state.data.entries || {}).filter(e => !e.deleted && !e.purged).length;
  const skip = restorePlan(ctx.state, r).skipped.length;
  const lines = [t('set.restoreCounts', { n, m: r.clips.length })];
  if (r.exportedAt) lines.push(t('set.restoreFrom', { time: fmtInstant(r.exportedAt, ctx.lang(), { year: true }) }));
  if (r.bad.length) lines.push(t('set.restoreBad', { n: r.bad.length }));
  if (r.missing.length) lines.push(t('set.restoreMissing', { n: r.missing.length }));
  if (skip) lines.push(t('set.restoreSkipped', { n: skip }));
  lines.push(t(purgeOn ? 'set.restoreMergePurge' : 'set.restoreMerge'));
  const ok = await ctx.confirm({ title: t('set.restoreQ'), message: lines.join('\n'), confirmLabel: t('set.restoreGo') });
  if (!ok) return;
  try {
    const before = new Map(Object.entries(ctx.state.data.entries).map(([id, e]) => [id, JSON.stringify(e)]));
    const res = await restoreBackup(r, { audioStore: ctx.audio, mergeIn: ctx.mergeIn, getState: () => ctx.state });
    ctx.setLocal({ repairedAt: Date.now() });     // 这次打开里从备份恢复过：「没有条目在用的录音」先不列（同修复数据）
    // 提示里只数看得见的条目（删除标记也会合并进来，但不算「恢复了几条」）
    const n2 = Object.entries(ctx.state.data.entries).filter(([id, e]) => !e.deleted && before.get(id) !== JSON.stringify(e)).length;
    const msg = res.changed || res.clips ? t('set.restored', { n: n2, m: res.clips }) : t('set.restoreNothing');
    ctx.toast([msg, res.skipped ? t('set.restoreSkipped', { n: res.skipped }) : null].filter(Boolean).join('\n'), { ms: 7000 });
  } catch (e) { ctx.toast(t('set.restoreFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); }
}

/**
 * 导出备份：先打包好（录音不在本机的会从云端下载），再显示「分享 / 下载」——
 * navigator.share 要在一次新的点按里调用，打包要花时间，所以分两步。
 * @param {object} ctx
 * @param {{onSaved?: () => void}} [o]  分享 / 下载之后（记下「上次备份」时间）
 */
export function backupBox(ctx, { onSaved = null } = {}) {
  const el = h('div.set-backup');
  let phase = 'idle', file = null, info = null, err = null;
  const lang = ctx.lang();
  const saved = () => { ctx.setLocal({ lastBackupAt: Date.now() }); if (onSaved) onSaved(); };
  async function build() {
    phase = 'building'; err = null; draw();
    try {
      const inf = {};
      const blob = await buildBackup(ctx.state, ctx.audio, { lang, getBlob: ctx.clipBlob, info: inf });
      file = new File([blob], backupFileName(new Date(), lang), { type: 'application/zip' });
      info = inf; phase = 'ready';
    } catch (e) { err = (e && e.message) || String(e); phase = 'idle'; }
    draw();
  }
  async function share() {
    try { await navigator.share({ files: [file], title: file.name }); saved(); }
    catch (e) { if (!e || e.name !== 'AbortError') { download(file.name, file); saved(); } }
  }
  function draw() {
    if (phase === 'ready') {
      const canShare = !!(navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })());
      fill(el,
        h('p.set-ready', null, icon('check'), t('set.backupReady', { n: info.entries || 0, m: info.clips || 0, size: fmtBytes(file.size) })),
        info.missing && info.missing.length ? h('p.f-help.set-warn', null, t('set.backupMissing', { n: info.missing.length })) : null,
        h('div.row', null,
          canShare ? h('button.btn.primary', { type: 'button', onclick: share }, icon('share'), t('common.share')) : null,
          h('button.btn' + (canShare ? '' : '.primary'), { type: 'button', onclick: () => { download(file.name, file); saved(); } }, icon('import'), t('common.download')),
          h('button.btn.ghost.small', { type: 'button', onclick: build }, t('set.backupAgain'))));
    } else {
      fill(el,
        h('button.btn.primary', { type: 'button', disabled: phase === 'building', onclick: build }, icon('share'), phase === 'building' ? t('set.backupBuilding') : t('set.backupExport')),
        h('p.f-help', null, t('set.backupWhat')),
        err ? h('p.err.small', { role: 'alert' }, t('set.backupFail', { msg: err })) : null);
    }
  }
  draw();
  return el;
}

// ======================================================================
// 同步
// ======================================================================
/** 清理云端历史以后，在 Mac 的终端里换 babble-data 文件夹：先看有没有自己的改动、没推上去的提交，再在旁边克隆一份新的（不删、不覆盖旧的） */
// 新文件夹从旧文件夹记着的地址克隆（https 还是 ssh、登录方式都和原来一样）；repo 只在旧文件夹没有 origin 时兜底
export const macCommands = (repo) => ['cd ~/Documents/Repositories/babble-data', 'git status --short', 'git log --oneline @{u}..HEAD', 'cd ..',
  `git clone "$(git -C babble-data remote get-url origin || echo https://github.com/${repo}.git)" babble-data-new`].join('\n');

function syncPage(main, params, ctx, purgeOn) {
  const lang = ctx.lang();
  const page = h('div.page.set.set-syncpage');
  main.append(h('header.navbar', null,
    h('button.back', { type: 'button', onclick: () => ctx.back('/settings') }, icon('back'), t('nav.settings')),
    h('span.nb-title', null, t('set.sync')), h('span')), page);
  const form = { repo: '', token: '', code: '', exp: '' };
  let busy = false, error = null, renew = false, newToken = '', newExp = '';
  const expInput = (value, onchange) => h('input.set-exp', { type: 'date', value, 'aria-label': t('set.tokenExpLabel'), onchange: (e) => onchange(e.target.value) });

  function draw() {
    const st = ctx.sync.status();
    fill(page, ...(st.on ? onView(st) : offView()));
  }

  // ---------- 已开启：状态、立即同步、复制同步码、停止 ----------
  function onView(st) {
    const cfg = ctx.local.sync || {};
    const s = syncState(st, lang);
    const exp = st.tokenExpires || cfg.tokenExp || null, note = exp ? tokenNote(exp) : null;
    const pend = [st.pendingUp ? t('sync.audioUp', { n: st.pendingUp }) : null, st.pendingDown ? t('sync.audioDown', { n: st.pendingDown }) : null,
      st.pendingPurge ? t('sync.audioDel', { n: st.pendingPurge }) : null].filter(Boolean);
    const nn = ctx.state.settings.speakers.nn.name || 'NN', old = purgeOn ? oldDevices(ctx) : '';
    return [
      h('section.card.set-sync', null,
        h('p.set-repo', null, h('b', null, st.repo || cfg.repo || '')),
        h('p', null, stateDot(s)),
        st.at ? h('p.small.muted', null, t('sync.last', { time: fmtInstant(st.at, lang) })) : null,
        st.err ? h('p.err.small', { role: 'alert' }, t('syncErr.' + st.err.code, st.err.vars || {})) : null,
        pend.length ? h('p.small', null, pend.join(' · '), st.uploading || st.downloading ? h('span.muted', null, ' · ', t('sync.syncing')) : null) : null,
        st.lastError ? h('p.small.set-warn', null, t('syncErr.' + st.lastError.code, st.lastError.vars || {})) : null,
        old ? h('p.small.set-warn', null, t('sync.oldDevices', { devices: old })) : null,
        exp ? h('p.small' + (note ? '.set-warn' : '.muted'), null, t('set.tokenExp', { date: fmtDate(localParts(exp).date, lang) }),
          note ? h('span', null, lang === 'en' ? ' ' : '', note) : null) : null,
        // 没填过到期日：在这里补上（改的是同一个设置对象，正在跑的同步不受影响）
        exp ? null : h('label.set-exp-row.small.muted', null, h('span', null, t('set.tokenExpLabel')),
          expInput('', (v) => { const c = ctx.local.sync; if (c && expMs(v)) { c.tokenExp = expMs(v); ctx.setLocal({ sync: c }); draw(); } })),
        h('div.row.set-btns', null,
          h('button.btn.primary', { type: 'button', disabled: busy || st.running, onclick: syncNow }, busy || st.running ? t('sync.syncing') : t('sync.now')),
          h('button.btn', { type: 'button', onclick: copyCode }, t('sync.copyCode')),
          h('button.btn.ghost', { type: 'button', onclick: () => { renew = !renew; error = null; draw(); } }, t('set.renew')))),
      macSec(st),
      renew ? renewForm(cfg) : null,
      h('div.group-foot.set-notes', null,
        h('p', null, t('sync.partner', { nn })),
        h('p', null, t(purgeOn ? 'sync.historyNotePurge' : 'sync.historyNote')),
        h('p', null, t('sync.tokenExpiry'))),
      devicesSec(),
      purgeOn ? squashSec(st) : null,
      h('div.set-stop', null, h('button.btn.danger', { type: 'button', onclick: stopSync }, t('sync.stop'))),
    ];
  }

  // ---------- 已更新到新版的设备（两步上线时用来看每台设备是不是都更新了；开放以后照样列出还没更新的） ----------
  // ctx.sync.devices()：报到过的（data.devices，app.js 每轮同步成功后写）和还没报到的（最近改过梦话、或还在用旧版本推送的设备名）。
  // 这台设备一定是新版：还没报到（第一轮同步还没成功）也列上，只是没有报到时间
  function devicesSec() {
    const rep = (ctx.sync.devices && ctx.sync.devices()) || { updated: [], waiting: [] }, sp = ctx.state.settings.speakers;
    const updated = rep.updated.some(d => d.me) ? rep.updated : [{ name: ctx.device, who: ctx.local.who || null, seenAt: null, build: null, me: true }, ...rep.updated];
    const name = (d) => byLabel({ who: d.who || null, device: d.name }, sp) || d.name;
    const seen = (d) => [d.seenAt ? t('sync.deviceSeen', { time: fmtAgo(d.seenAt, lang) }) : d.me ? t('sync.deviceSoon') : null,
      d.build ? t('sync.deviceBuild', { v: String(d.build).replace(/^babble-/, '') }) : null].filter(Boolean).join(' · ');
    return h('section.set-sec.set-devices', null, h('h2.group-h', null, t('sync.devicesH')),
      h('div.card', null,
        h('p.small.muted', null, t(purgeOn ? 'sync.devicesLeadPurge' : 'sync.devicesLead')),
        h('ul.set-dev-list', null, updated.map(d => h('li', null,
          h('span.set-dev-name', null, name(d), d.me ? [h('span.sr-only', null, ' · '), h('span.pill', null, t('sync.deviceThis'))] : null), seen(d) ? h('small', null, seen(d)) : null))),
        rep.waiting.length ? [h('p.set-dev-h', null, t('sync.devicesWaitH')), h('ul.set-dev-list.wait', null, rep.waiting.map(x => h('li', null,
          h('span.set-dev-name', null, name(x)), h('small', null, x.old ? t('sync.deviceOld') : t('sync.deviceEdited', { time: fmtAgo(x.at, lang) })))))]
          : h('p.small.set-dev-ok', null, icon('check'), t('sync.devicesAll')),
        h('p.f-help', null, t('sync.devicesFoot'))));
  }

  // 暂停重写远端提交历史：现有 REST 接口无法原子地核对并替换分支。
  function squashSec() {
    return h('section.set-sec.set-squash', null, h('h2.group-h', null, t('sync.squashH')),
      h('div.card', null, h('p.small', null, t('syncErr.squashDisabled'))));
  }
  /** 清理以后：Mac 上的 babble-data 文件夹怎么换成新的（「知道了」才收起） */
  function macSec(st) {
    if (!ctx.local.squashNote) return null;
    const cmds = macCommands(st.repo || (ctx.local.sync && ctx.local.sync.repo) || '');
    return h('section.card.set-mac', null,
      h('p.set-mac-h', null, h('b', null, t('sync.macH'))),
      h('p.small', null, t('sync.macText')),
      h('pre.set-cmds', null, cmds),
      h('p.small', null, t('sync.macAfter')),
      h('div.row.set-btns', null,
        h('button.btn', { type: 'button', onclick: async () => ctx.toast((await copyText(cmds)) ? t('common.copied') : t('common.copyFail')) }, t('sync.macCopy')),
        h('button.btn.ghost', { type: 'button', onclick: () => { ctx.setLocal({ squashNote: null }); draw(); } }, t('sync.macDone'))));
  }
  function renewForm(cfg) {
    const tokIn = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: newToken, oninput: (e) => { newToken = e.target.value; } });
    return h('section.card.set-form', null,
      h('p.small', null, t('set.renewHelp')),
      h('label.f-label', null, t('sync.token')), tokIn,
      h('label.f-label', null, t('set.tokenExpLabel')), expInput(newExp, (v) => { newExp = v; }), h('p.f-help', null, t('set.tokenExpHelp')),
      error ? h('p.err.small', { role: 'alert' }, error) : null,
      h('div.row.set-btns', null,
        h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => {
          const c = parseSyncCode(newToken);           // 粘贴的是别的设备复制来的同步码也行（换过令牌的那台）
          connect(c ? c.repo : cfg.repo, c ? c.token : newToken.trim(), newExp);
        } }, busy ? t('sync.connecting') : t('common.save')),
        h('a.btn.ghost', { href: TOKEN_URL, target: '_blank', rel: 'noopener' }, t('sync.tokenLink'))));
  }

  // ---------- 未开启：同步码 / 仓库 + 令牌 ----------
  function offView() {
    const repoIn = h('input', { value: form.repo, placeholder: t('sync.repoPh'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('sync.repo'),
      oninput: (e) => { form.repo = e.target.value; fromCode(e.target.value); } });
    const tokIn = h('input', { type: 'password', value: form.token, placeholder: 'github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('sync.token'),
      oninput: (e) => { form.token = e.target.value; fromCode(e.target.value); } });
    const codeIn = h('input', { value: form.code, placeholder: t('sync.codePh'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('sync.code'),
      oninput: (e) => { form.code = e.target.value; fromCode(e.target.value); } });
    function fromCode(text) {
      const c = parseSyncCode(text);
      if (!c) return;
      form.repo = c.repo; form.token = c.token; form.code = '';
      repoIn.value = c.repo; tokIn.value = c.token; codeIn.value = '';
      error = null;
      btn.focus();
    }
    const btn = h('button.btn.primary.big.block', { type: 'button', disabled: busy, onclick: () => connect(form.repo, form.token, form.exp) }, busy ? t('sync.connecting') : t('sync.connect'));
    const tokenSteps = h('ul.set-steps', null, [3, 4, 5, 6, 7, 8].map(n => h('li', null, t('sync.step' + n))));
    return [
      h('p.set-lead', null, t('sync.intro')),
      h('section.card.set-form', null,
        h('p.small', null, t('sync.have')),
        codeIn),
      h('p.group-h', null, t('set.firstTime')),
      h('section.card.set-form', null,
        h('details.set-howto', null, h('summary', null, t('sync.stepsH')),
          h('ol.set-steps', null,
            h('li', null, t('sync.step1')),
            h('li', null, t('sync.step2'),
              h('p', null, h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener' }, t('sync.tokenLink'))),
              h('details', null, h('summary', null, t('sync.tokenStepsH')), h('p', null, t('sync.tokenPath')), tokenSteps,
                h('p', null, t('sync.tokenExpiry')), h('p', null, h('a', { href: TOKEN_DOCS, target: '_blank', rel: 'noopener' }, t('sync.tokenDocs'))))),
            h('li', null, t('sync.step9')))),
        h('label.f-label', null, t('sync.repo')), repoIn,
        h('label.f-label', null, t('sync.token')), tokIn,
        h('label.f-label', null, t('set.tokenExpLabel')), expInput(form.exp, (v) => { form.exp = v; }), h('p.f-help', null, t('set.tokenExpHelp')),
        error ? h('p.err.small', { role: 'alert' }, error) : null,
        btn),
      h('div.group-foot.set-notes', null, h('p', null, t('sync.partner', { nn: ctx.state.settings.speakers.nn.name || 'NN' })), h('p', null, t('sync.historyNote'))),
    ];
  }

  // ---------- 操作 ----------
  async function connect(repo0, token, exp = '') {
    const repo = String(repo0 || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const fail = (m) => { error = m; busy = false; draw(); };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(t('sync.badRepo'));
    if (!token) return fail(t('sync.noToken'));
    if (/^(ghp|gho|ghu|ghs)_/.test(token)) return fail(t('sync.classicToken'));     // 经典令牌能动整个账号，不收
    const wasOn = !!ctx.local.sync, prev = ctx.local.sync, left = wasOn ? ctx.sync.status().pendingPurge || 0 : 0;
    // 换到别的仓库，原来的仓库里还有没删掉的录音：先说一声（以后不会再去那个仓库删）
    if (left && prev && String(prev.repo || '').toLowerCase() !== repo.toLowerCase()
      && !(await ctx.confirm({ message: t('sync.stopPending', { n: left }), confirmLabel: t('sync.connect') }))) return;
    busy = true; error = null; draw();
    try {
      const full = await ctx.sync.checkRepo(repo, token);
      const r = await ctx.sync.connect({ repo: full, token, tokenExp: expMs(exp) });
      if (!r || !r.ok || (ctx.local.sync && ctx.local.sync.offline)) {
        const code = r && r.error ? r.error.code : 'net';
        throw new SyncError(code, (r && r.error && r.error.vars) || {});
      }
      form.repo = ''; form.token = ''; form.exp = ''; newToken = ''; newExp = ''; renew = false; busy = false;
      ctx.toast(t('sync.connected'), { ms: 7000 });
      draw();
    } catch (e) {
      if (!wasOn) ctx.sync.stop();
      else if (prev && ctx.local.sync !== prev) ctx.setLocal({ sync: prev });     // 换令牌失败：留着原来的设置
      fail(t('syncErr.' + (e instanceof SyncError ? e.code : 'unknown'), (e && e.vars) || {}));
    }
  }
  async function syncNow() {
    busy = true; draw();
    const r = await ctx.sync.now().catch(() => ({ ok: false }));
    busy = false; draw();
    if (r && r.ok) ctx.toast(ctx.local.sync && ctx.local.sync.offline ? t('sync.offline') : t('sync.done'));
  }
  async function copyCode() {
    const c = ctx.local.sync;
    if (!c) return;
    ctx.toast(await copyText(syncCode(c.repo, c.token)) ? t('sync.codeCopied') : t('common.copyFail'), { ms: 8000 });
  }
  async function stopSync() {
    const left = ctx.sync.status().pendingPurge || 0;             // 还有没从仓库删掉的录音：停了以后就一直留在那个仓库里
    const message = [t('sync.stopConfirm'), left ? t('sync.stopPending', { n: left }) : null].filter(Boolean).join('\n');
    if (!(await ctx.confirm({ message, confirmLabel: t('sync.stop'), danger: true }))) return;
    ctx.sync.stop();
    draw();
  }

  const redraw = quietRedraw(main, draw);
  draw();
  // 清理云端历史的那张卡写上仓库有几个提交（尽力，打开时读一次）
  ctx.on('sync', () => { if (!busy) redraw.soon(); });
  return { onChange: () => { if (!busy) redraw.soon(); }, cleanup: () => redraw.off() };
}
