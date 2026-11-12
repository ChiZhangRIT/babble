// 设置（#/settings）和同步（#/settings/sync）。
// 设置页自己管更新（返回 onChange）：正在输入时（比如在填名字、令牌）数据变了不重画，等离开输入框再画，免得吞掉输入。
// 也导出 backupBox（导出备份的按钮和「分享 / 下载」）：从备忘录迁移完成页也用它。
import { h, icon, copyText, download } from '../ui/dom.js';
import { LANGS, LANG_LABELS, t } from '../i18n.js';
import { SyncError, syncCode, parseSyncCode } from '../core/sync.js';
import { buildBackup, readBackup, restoreBackup, backupFileName } from '../core/backup.js';
import { isTime, localParts, fmtTime, fmtDate, fmtInstant, daysAgo } from '../core/dates.js';
import { fmtBytes, uniq } from '../core/util.js';
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

export function render(main, params, ctx) {
  return params.sub === 'sync' ? syncPage(main, params, ctx) : mainPage(main, params, ctx);
}

// ---------- 小部件 ----------
const LANG_ROW = '语言 / Language';
const sec = (id, title, kids, foot) => h('section.set-sec', { id: id ? 'set-' + id : null },
  title ? h('h2.group-h', null, title) : null, h('div.group', null, kids), foot ? h('div.group-foot', null, foot) : null);
// 只有一个输入框 / 开关时整行是 <label>（点哪里都行）；分段按钮之类用 <div>，免得点文字误按第一个按钮
const row = (label, control, help) => h((/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) ? 'label' : 'div') + '.group-row.set-row', null,
  h('span.set-label', null, label, help ? h('small', null, help) : null), control);
const toggleRow = (label, checked, onchange, help) => row(label, h('input.toggle', { type: 'checkbox', role: 'switch', checked, onchange: (e) => onchange(e.target.checked) }), help);
const linkRow = (href, ic, label, value) => h('a.group-row.set-link', { href }, ic ? icon(ic) : null, h('span', null, label), h('span.sp'), value != null ? h('span.value', null, value) : null);

/** 同步状态的一句话和颜色（ok / wait / err / off） */
export function syncState(st, lang) {
  if (!st || !st.on) return { cls: 'off', text: t('sync.off') };
  if (st.err) return { cls: 'err', text: t('sync.error') };
  if (st.running) return { cls: 'wait', text: t('sync.syncing') };
  if (st.offline) return { cls: 'wait', text: t('sync.offline') };
  if (st.dirty) return { cls: 'wait', text: t('sync.pending') };
  const p = st.at ? localParts(st.at) : null;
  return { cls: 'ok', text: p ? t('sync.ok', { time: fmtTime(p.time, lang) }) : t('sync.ok0') };
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
function mainPage(main, params, ctx) {
  const lang = ctx.lang();
  const page = h('div.page.set');
  main.append(h('header.page-head', null, h('h1.lt', null, t('nav.settings'))), page);
  let storageInfo = null;
  const bbox = backupBox(ctx, { onSaved: () => redraw.soon() });     // 跨重画保留：打包好的备份不会因为同步一下就没了

  function draw() {
    const S = ctx.state.settings, L = ctx.local;
    const st = ctx.sync.status();
    const deletedN = Object.values(ctx.state.data.entries).filter(e => e.deleted).length;
    const pend = [st.pendingUp ? t('sync.audioUp', { n: st.pendingUp }) : null, st.pendingDown ? t('sync.audioDown', { n: st.pendingDown }) : null].filter(Boolean).join(' · ');
    fill(page,
      // 语言放最上面，标题三种语言都写：不管现在是哪种语言都找得到
      sec('lang', null, [row(LANG_ROW, h('select.set-in.set-select', { 'aria-label': LANG_ROW, onchange: (e) => ctx.setLang(e.target.value) },
        LANGS.map(l => h('option', { value: l, selected: l === lang }, LANG_LABELS[l]))))]),
      sec('sync', t('set.syncH'), [h('a.group-row.set-link', { href: '#/settings/sync' }, icon('share'), h('span', null, t('set.sync')), h('span.sp'), stateDot(syncState(st, lang)))],
        st.on ? (pend || (st.repo ? t('set.syncRepo', { repo: st.repo }) : null)) : t('set.syncOffFoot')),
      speakersSec(S),
      nightSec(S),
      sec('look', t('set.lookH'), [
        row(t('set.theme'), h('div.seg.set-seg', { role: 'group', 'aria-label': t('set.theme') }, THEMES.map(v => {
          const on = (L.theme || 'auto') === v;
          return h('button', { type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), onclick: () => { ctx.setTheme(v); draw(); } }, t('set.theme.' + v));
        }))),
      ], S.nightForcesDark ? t('set.lookFoot') : null),
      backupSec(L),
      storageSec(),
      sec('data', t('set.dataH'), [
        linkRow('#/import', 'import', t('nav.import')),
        linkRow('#/import/notes', 'bubble', t('nav.importNotes')),
        linkRow('#/deleted', 'trash', t('nav.deleted'), deletedN ? String(deletedN) : null),
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
    ], ctx.isNight() ? t('set.nightNow') : t('set.nightFoot'));
  }

  // ---------- 备份 ----------
  function backupSec(L) {
    const fileIn = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true,
      onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreFrom(ctx, f); } });
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
    return sec('storage', t('set.storageH'), [
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.used')), usage),
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.clips')), clips),
      h('div.group-row.set-row', null, h('span.set-label', null, t('set.persisted'), h('small', null, t('set.persistHelp'))), h('span.set-persist', null, pers, ask)),
    ], t('set.storageFoot'));
  }
  let loading = false;
  async function loadStorage() {
    if (loading) return;
    loading = true;
    const [est, isP, list] = await Promise.all([within(ctx.audio.estimate()), within(ctx.audio.persisted()), within(ctx.audio.listClips(), 8000, [])]);
    loading = false;
    const bytes = list.reduce((n, c) => n + (c.bytes || 0), 0);
    storageInfo = {
      usage: est && est.usage != null ? (est.quota ? t('set.usedOf', { used: fmtBytes(est.usage), free: fmtBytes(Math.max(0, est.quota - est.usage)) }) : fmtBytes(est.usage)) : t('set.unknown'),
      clips: t('set.clipsN', { n: list.length, size: fmtBytes(bytes) || '0 B' }),
      persisted: isP == null ? t('set.unknown') : isP ? t('set.persistYes') : t('set.persistNot'), isPersisted: !!isP,
    };
    if (main.isConnected) redraw.soon();
  }

  function tipsSec() {
    return h('section.set-sec#set-tips', null, h('h2.group-h', null, t('set.tipsH')),
      h('div.card.set-tips', null, h('ul', null, ['tip1', 'tip2', 'tip3', 'tip4', 'tip5'].map(k => h('li', null, t('set.' + k))))));
  }
  function aboutSec() {
    return h('section.set-sec#set-about', null, h('h2.group-h', null, t('set.aboutH')),
      h('div.card.set-about', null,
        h('div.set-about-top', null, h('img', { src: 'icons/icon-180.png', alt: '', width: 48, height: 48, onerror: (e) => e.target.remove() }),
          h('div', null, h('b.kai', null, t('common.appName')), h('p.small.muted', null, t('set.aboutLine')))),
        h('ul.small', null, ['about1', 'about2', 'about3'].map(k => h('li', null, t('set.' + k))))));
  }

  const redraw = quietRedraw(main, draw);
  draw();
  ctx.on('sync', () => redraw.soon());
  return { onChange: () => redraw.soon(), cleanup: () => redraw.off() };
}

/** 从备份恢复：先读、核对 sha256，告诉用户里面有什么，确认后再合并（较新的为准，不删本机的） */
async function restoreFrom(ctx, file) {
  let r;
  try { r = await readBackup(file); }
  catch (e) { ctx.toast(e && e.code === 'badBackup' ? t('set.badBackup') : t('set.restoreFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); return; }
  const n = Object.values(r.state.data.entries || {}).filter(e => !e.deleted).length;
  const lines = [t('set.restoreCounts', { n, m: r.clips.length })];
  if (r.exportedAt) lines.push(t('set.restoreFrom', { time: fmtInstant(r.exportedAt, ctx.lang(), { year: true }) }));
  if (r.bad.length) lines.push(t('set.restoreBad', { n: r.bad.length }));
  if (r.missing.length) lines.push(t('set.restoreMissing', { n: r.missing.length }));
  lines.push(t('set.restoreMerge'));
  const ok = await ctx.confirm({ title: t('set.restoreQ'), message: lines.join('\n'), confirmLabel: t('set.restoreGo') });
  if (!ok) return;
  try {
    const before = new Map(Object.entries(ctx.state.data.entries).map(([id, e]) => [id, JSON.stringify(e)]));
    const res = await restoreBackup(r, { audioStore: ctx.audio, mergeIn: ctx.mergeIn });
    // 提示里只数看得见的条目（删除标记也会合并进来，但不算「恢复了几条」）
    const n = Object.entries(ctx.state.data.entries).filter(([id, e]) => !e.deleted && before.get(id) !== JSON.stringify(e)).length;
    ctx.toast(res.changed || res.clips ? t('set.restored', { n, m: res.clips }) : t('set.restoreNothing'), { ms: 7000 });
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
function syncPage(main, params, ctx) {
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
    const exp = st.tokenExpires || cfg.tokenExp || null;
    const left = exp ? Math.floor((exp - Date.now()) / DAY) : null;
    const pend = [st.pendingUp ? t('sync.audioUp', { n: st.pendingUp }) : null, st.pendingDown ? t('sync.audioDown', { n: st.pendingDown }) : null].filter(Boolean);
    const nn = ctx.state.settings.speakers.nn.name || 'NN';
    return [
      h('section.card.set-sync', null,
        h('p.set-repo', null, h('b', null, st.repo || cfg.repo || '')),
        h('p', null, stateDot(s)),
        st.at ? h('p.small.muted', null, t('sync.last', { time: fmtInstant(st.at, lang) })) : null,
        st.err ? h('p.err.small', { role: 'alert' }, t('syncErr.' + st.err.code, st.err.vars || {})) : null,
        pend.length ? h('p.small', null, pend.join(' · '), st.uploading || st.downloading ? h('span.muted', null, ' · ', t('sync.syncing')) : null) : null,
        st.lastError ? h('p.small.set-warn', null, t('syncErr.' + st.lastError.code, st.lastError.vars || {})) : null,
        exp ? h('p.small' + (left != null && left <= 14 ? '.set-warn' : '.muted'), null, t('set.tokenExp', { date: fmtDate(localParts(exp).date, lang) }),
          left != null && left <= 14 ? h('span', null, lang === 'en' ? ' ' : '', left < 0 ? t('set.tokenExpired') : t('set.tokenSoon', { n: Math.max(0, left) })) : null) : null,
        // 没填过到期日：在这里补上（改的是同一个设置对象，正在跑的同步不受影响）
        exp ? null : h('label.set-exp-row.small.muted', null, h('span', null, t('set.tokenExpLabel')),
          expInput('', (v) => { const c = ctx.local.sync; if (c && expMs(v)) { c.tokenExp = expMs(v); ctx.setLocal({ sync: c }); draw(); } })),
        h('div.row.set-btns', null,
          h('button.btn.primary', { type: 'button', disabled: busy || st.running, onclick: syncNow }, busy || st.running ? t('sync.syncing') : t('sync.now')),
          h('button.btn', { type: 'button', onclick: copyCode }, t('sync.copyCode')),
          h('button.btn.ghost', { type: 'button', onclick: () => { renew = !renew; error = null; draw(); } }, t('set.renew')))),
      renew ? renewForm(cfg) : null,
      h('div.group-foot.set-notes', null,
        h('p', null, t('sync.partner', { nn })),
        h('p', null, t('sync.historyNote')),
        h('p', null, t('sync.tokenExpiry'))),
      h('div.set-stop', null, h('button.btn.danger', { type: 'button', onclick: stopSync }, t('sync.stop'))),
    ];
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
    busy = true; error = null; draw();
    const wasOn = !!ctx.local.sync, prev = ctx.local.sync;
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
    if (!(await ctx.confirm({ message: t('sync.stopConfirm'), confirmLabel: t('sync.stop'), danger: true }))) return;
    ctx.sync.stop();
    draw();
  }

  const redraw = quietRedraw(main, draw);
  draw();
  ctx.on('sync', () => { if (!busy) redraw.soon(); });
  return { onChange: () => { if (!busy) redraw.soon(); }, cleanup: () => redraw.off() };
}
