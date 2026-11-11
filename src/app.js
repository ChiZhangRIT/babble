// 牙牙呓语：启动、外壳（手机底栏 / 侧栏 / 双栏）、路由、主题与夜间、同步调度、录音恢复。页面在 views/，计算在 core/。
//
// ===== 页面接口 =====
// export function render(main, params, ctx) → 清理函数 | { cleanup?(), onChange?(info) } | undefined
//   main    空的容器（<section class="pane view view-<name>">），页面自己画顶栏和内容
//   params  { name, path, id, sub, query, pane, selected, hash }
//           name: 'list' | 'entry' | 'editor' | 'deleted' | 'record' | 'import' | 'settings' | 'diag'
//           #/ → list；#/e/<id> → entry（id）；#/new → editor（sub 'new'，id null）；#/edit/<id> → editor（sub 'edit'）
//           #/rec、#/rec?attach=<id> → record（query.attach）；#/import → import（sub 'audio'）；#/import/notes → import（sub 'notes'）
//           #/settings、#/settings/sync → settings（sub null | 'sync'）；#/deleted → deleted；#/diag → diag；不认识的地址 → list
//           pane: 'main'（单栏）| 'list'（双栏左）| 'detail'（双栏右）；selected: 双栏时右栏正在看的条目 id（给列表高亮）
//   数据变了：页面返回了 onChange 就只调 onChange(info)，页面自己更新（编辑页、录音页必须这样，免得打断输入和录音）；
//            否则 app 把这个页面整个重画一遍（保留滚动位置；带 data-fid 的控件重画后恢复焦点）。
//   双栏（≥1000px）：#/、#/e/<id>、#/new、#/edit/<id> 左栏是列表，右栏是详情 / 编辑（#/ 时右栏是提示）。
//   手机：只有 #/ 和 #/settings 显示底栏；其他页面是「推入」的，自己画返回按钮（ctx.back）。#/rec 时侧栏也隐藏（全屏近黑）。
//   换布局（转 iPad、拉窗口）：同一栏的页面原样保留；要换栏时，有 onChange 或有未保存修改（guard）的页面整个搬过去
//            （params.pane / selected 原地更新），其余重画。要随布局变化的页面听 ctx.on('layout')。
//
// ===== ctx =====
// 数据（src/core/state.js 的包装；改数据一律走这些，app 会保存、同步、重画）
//   ctx.state                  当前数据（只读）：{ app, v, data: { entries }, settings, settingsAt }
//   ctx.local                  本机设置 babble.local（只读）：{ lang, theme, device, sync, lastBackupAt, audioSync }
//   ctx.entries()              没删除的条目，新的在前（byNewest）；缓存到下次数据变化
//   ctx.entry(id)              按 id 取条目（含已删除的），没有 → null
//   ctx.mutate(fn, { undoLabel })  fn(state) 直接改（同步函数），返回 fn 的返回值；修改时间自动补；给 undoLabel 会弹 10 秒「撤销」提示
//   ctx.put(entry, { undoLabel })  新建或整条替换，返回存好的条目
//   ctx.update(id, patch, { undoLabel })  改几个字段，返回存好的条目（没有这条 → null）
//   ctx.newEntry(fields)       makeEntry：补齐默认值的新条目（还没存，要 ctx.put）
//   ctx.remove(id)             软删除 + 10 秒「撤销」提示，返回删除前的条目
//   ctx.restore(id)            从「最近删除」恢复
//   ctx.undo()                 撤销最近一次带 undoLabel 的修改
//   ctx.setSetting(key, value) 改一项设置（speakers、nightStart…）
//   ctx.mergeIn(otherState)    导入备份（逐条合并），返回 { changed }
//   ctx.setLocal(patch)        改本机设置（不重画页面）
//   ctx.editVersion            本机修改计数
// 导航
//   ctx.navigate(path, { replace })  path 如 '/e/abc'、'/rec?attach=abc'（前面的 # 可有可无）；同一地址 = 重画
//   ctx.back(fallback = '/')   App 内有上一页就后退，否则换成 fallback
//   ctx.route                  当前路由（同 params 的结构，不含 pane/selected）
//   ctx.refresh()              重画当前所有页面
//   ctx.guard(isDirty)         离开前检查：isDirty() 为 true 时先确认（路由切换、关闭标签页）；ctx.guard(null) 取消；页面清理时自动取消
//   ctx.layout()               'phone'（<720）| 'side'（720–999，有侧栏）| 'two'（≥1000，双栏）
// 界面
//   ctx.t(key, vars)、ctx.lang()、ctx.setLang(l)、ctx.setTheme('auto'|'light'|'dark')、ctx.theme()（当前生效的 'light'|'dark'）
//   ctx.toast(msg, { ms, action: { label, run } })、ctx.sheet(content, opts)、ctx.confirm(opts) → Promise<boolean>（见 ui/dom.js）
//   ctx.syncBadge()            同步状态小标签（元素，点了去 #/settings/sync）
//   ctx.on(event, fn)          'change'(info) | 'sync'(status) | 'layout'(layout) | 'theme'(theme)；返回取消函数，页面清理时自动取消
//   ctx.onChange(fn)           = ctx.on('change', fn)
// 录音
//   ctx.audio                  src/core/audioStore.js 整个模块（putClip、getClip、hasClip…）
//   ctx.clipBlob(sha)          → Promise<Blob|null>：先找本机，没有且开了同步就按需下载（播放器的 getBlob 用它）
//   ctx.recovered              Promise<string[]>：启动时找回的录音建成的条目 id
//   ctx.bootAt                 这次启动的时刻（毫秒）
//   ctx.takeFiles()            拖进窗口的录音文件（File[]，取一次就清空；没有 → null）。导入页打开时调一下
// 同步
//   ctx.sync.now()             立即同步 → Promise<{ ok, skipped?, error?, offline? }>
//   ctx.sync.connect({ repo, token, tokenExp })  保存同步设置并马上同步一次 → 同上（tokenExp：用户填的令牌到期时刻，可选）
//   ctx.sync.stop()            停止同步（只清本机设置）
//   ctx.sync.checkRepo(repo, token) → Promise<仓库全名>（不是私有 / 没权限会抛 SyncError）
//   ctx.sync.status()          { on, running, pendingUp, pendingDown, lastError, at, err, offline, dirty, repo }
//   ctx.sync.getAudio(sha)     → Promise<Blob|null>
// 其他
//   ctx.device                 设备名（iPhone / iPad / Mac / Browser，或 babble.local.device）
//   ctx.isNight()              现在是不是夜间时段（按设置）
import * as state from './core/state.js';
import { stamp, deletedRecord, restoredRecord, setSetting, live, byNewest, makeEntry, normalizeEntry, clipIndex, newId } from './core/store.js';
import { isNight, localParts, today, fmtTime } from './core/dates.js';
import { debounce } from './core/util.js';
import { createSync } from './core/sync.js';
import * as audio from './core/audioStore.js';
import { recoverPending } from './core/recorder.js';
import { t, setLang, getLang, guessLang, LANGS } from './i18n.js';
import { h, $, icon, toast, sheet, confirmDialog, download } from './ui/dom.js';
import * as list from './views/list.js';
import * as entry from './views/entry.js';
import * as editor from './views/editor.js';
import { EDIT_PREFIX } from './views/editor.js';
import * as deleted from './views/deleted.js';
import * as record from './views/record.js';
import * as importView from './views/import.js';
import * as settings from './views/settings.js';
import * as diagnostics from './views/diagnostics.js';

const BOOT = Date.now();
const VIEWS = { list, entry, editor, deleted, record, import: importView, settings, diag: diagnostics };
const DEVICE = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
  : /iPhone|iPod/.test(navigator.userAgent) ? 'iPhone' : /Mac/.test(navigator.platform) ? 'Mac' : 'Browser';
const THEME_COLOR = { light: '#f8f3ee', dark: '#141216', night: '#0b0c12' };

state.load();
const S = () => state.getState();
const L = () => state.getLocal();

// ---------- 小事件总线（页面订阅，页面清理时自动取消） ----------
const bus = new Map();
function on(ev, fn) { if (!bus.has(ev)) bus.set(ev, new Set()); bus.get(ev).add(fn); return () => bus.get(ev).delete(fn); }
function emit(ev, arg) { for (const fn of [...(bus.get(ev) || [])]) { try { fn(arg); } catch (e) { console.error(e); } } }

// ---------- 路由 ----------
const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };   // 截断的链接（%E0）不要让整个 app 白屏
function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = (qi < 0 ? raw : raw.slice(0, qi)).split('/').filter(Boolean).map(dec);
  const query = Object.fromEntries(new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1)));
  const [a, b] = path;
  let r;
  if (!a) r = { name: 'list' };
  else if (a === 'e' && b) r = { name: 'entry', id: b };
  else if (a === 'edit' && b) r = { name: 'editor', id: b, sub: 'edit' };
  else if (a === 'new') r = { name: 'editor', sub: 'new' };
  else if (a === 'rec') r = { name: 'record' };
  else if (a === 'import') r = { name: 'import', sub: b === 'notes' ? 'notes' : 'audio' };
  else if (a === 'settings') r = { name: 'settings', sub: b || null };
  else if (a === 'deleted') r = { name: 'deleted' };
  else if (a === 'diag') r = { name: 'diag' };
  else r = { name: 'list' };
  return { id: null, sub: null, ...r, path, query, hash: '#/' + raw };
}
const route = () => parseRoute(location.hash);

const mqSide = matchMedia('(min-width: 720px)'), mqTwo = matchMedia('(min-width: 1000px)');
const layout = () => (mqTwo.matches ? 'two' : mqSide.matches ? 'side' : 'phone');
const TOP_LEVEL = r => r.name === 'list' || (r.name === 'settings' && !r.sub);

/** 这个路由在这个布局下要画哪些栏 */
function planPanes(r, lay) {
  if (lay === 'two' && (r.name === 'list' || r.name === 'entry' || r.name === 'editor')) {
    return [
      { slot: 'list', name: 'list', params: { ...r, name: 'list', pane: 'list', selected: r.id } },
      { slot: 'detail', name: r.name === 'list' ? 'empty' : r.name, params: { ...r, pane: 'detail', selected: r.id } },
    ];
  }
  return [{ slot: 'main', name: r.name, params: { ...r, pane: 'main', selected: r.id } }];
}

// ---------- 导航（带「离开前确认」和 App 内历史） ----------
const navStack = [];          // App 内走过的地址（判断 ctx.back 能不能真的后退）
let lastWasBack = false;
const scrollMemory = new Map();
function track(hash) {
  lastWasBack = navStack.length >= 2 && navStack[navStack.length - 2] === hash;
  if (lastWasBack) navStack.pop();
  else if (navStack[navStack.length - 1] !== hash) navStack.push(hash);
}
const norm = p => '#/' + String(p || '').replace(/^#?\/?/, '');
let currentHash = null, skipGuard = false;

async function confirmLeave() {
  const dirty = Object.values(mounted).filter(m => m.guard && safeCall(m.guard));
  if (!dirty.length) return true;
  const ok = await confirmDialog({ message: t('common.unsaved'), confirmLabel: t('common.leave'), cancelLabel: t('common.stay'), danger: true });
  if (ok) for (const m of Object.values(mounted)) m.guard = null;
  return ok;
}
const safeCall = fn => { try { return !!fn(); } catch (e) { return false; } };

async function navigate(path, { replace = false } = {}) {
  const target = norm(path);
  if (!(await confirmLeave())) return false;
  if ((location.hash || '#/') === target && !replace) { refresh(); return true; }
  if (replace) {
    history.replaceState(history.state, '', target);
    if (navStack.length) navStack[navStack.length - 1] = target; else navStack.push(target);
    currentHash = target; lastWasBack = false;
    render();
  } else { skipGuard = true; location.hash = target; }
  return true;
}
function back(fallback = '/') {
  if (navStack.length > 1) history.back();
  else navigate(fallback, { replace: true });
}
// 地址变了（点链接、后退前进）：hashchange 和 popstate 都听（WebKit 后退时有时只先来 popstate），同一个地址只处理一次
async function onUrlChange() {
  const target = location.hash || '#/';
  if (target === currentHash) { skipGuard = false; return; }
  if (!skipGuard && Object.values(mounted).some(m => m.guard && safeCall(m.guard))) {
    history.replaceState(history.state, '', currentHash || '#/');   // 先回到原地址，问过再走
    if (!(await confirmLeave())) return;
    skipGuard = true; location.hash = target;
    return;
  }
  skipGuard = false;
  if (currentHash) scrollMemory.set(currentHash, scrollTop());
  currentHash = target;
  track(target);
  render();
}
window.addEventListener('hashchange', onUrlChange);
window.addEventListener('popstate', onUrlChange);
window.addEventListener('beforeunload', e => {
  if (Object.values(mounted).some(m => m.guard && safeCall(m.guard))) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 衍生数据 ----------
let cache = null;
function entries() {
  if (!cache) cache = live(S()).sort(byNewest);
  return cache;
}

// ---------- 同步 ----------
let lastSyncTry = 0;
const syncer = createSync({
  getState: S,
  applyRemote: (merged, info) => state.applyRemote(merged, info),
  getConfig: () => L().sync,
  saveConfig: (cfg) => {
    if (L().sync === cfg) {
      // 数据没存进本机（空间满）：本机存的比云端旧，不记云端版本号——下次启动完整拉取、合并，不会被 304 当成「没变化」
      if (state.saveOk()) state.saveLocal();
      else { const { sha, etag } = cfg; cfg.sha = cfg.etag = null; state.saveLocal(); Object.assign(cfg, { sha, etag }); }
    }
    syncChanged();
  },
  editVersion: state.editVersion,
  device: L().device || DEVICE,
  audioStore: audio,
  getLocal: L, saveLocal: state.saveLocal,
  onStatus: () => syncChanged(),
});
function syncStatus() {
  const c = L().sync;
  const st = (() => { try { return syncer.status() || {}; } catch (e) { return {}; } })();
  return { running: false, pendingUp: 0, pendingDown: 0, lastError: null, ...st, on: !!c,
    repo: c ? c.repo : null, at: c ? c.at || null : null, err: c ? c.err || null : null, offline: !!(c && c.offline), dirty: !!(c && c.dirty) };
}
function syncChanged() { renderSyncBadges(); emit('sync', syncStatus()); }
const syncApi = {
  now: () => { lastSyncTry = Date.now(); const p = syncer.syncNow(); syncChanged(); return p.finally(syncChanged); },
  connect: ({ repo, token, tokenExp = null }) => {
    state.setLocal({ sync: { repo, token, sha: null, etag: null, dirty: true, at: null, err: null, offline: false, ...(tokenExp ? { tokenExp } : {}) } });
    syncChanged();
    return syncApi.now();
  },
  stop: () => { syncSoon.cancel(); state.setLocal({ sync: null }); syncChanged(); },
  checkRepo: (repo, token) => syncer.checkRepo(repo, token),
  status: syncStatus,
  getAudio: (sha) => syncer.getAudio(sha),
};
const syncSoon = debounce(() => { if (L().sync) syncApi.now(); }, 3000);
const syncIfStale = () => { if (L().sync && Date.now() - lastSyncTry > 5000) syncApi.now(); };

// ---------- 主题和夜间 ----------
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme() {
  const st = S().settings;
  if (st.nightForcesDark && isNight(new Date(), st)) return 'dark';
  const th = L().theme;
  if (th === 'light' || th === 'dark') return th;
  return prefersDark.matches ? 'dark' : 'light';
}
function applyTheme() {
  const th = resolvedTheme(), root = document.documentElement;
  const changed = root.dataset.theme !== th;
  root.dataset.theme = th;
  root.dataset.night = isNight(new Date(), S().settings) ? '1' : '0';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = route().name === 'record' ? THEME_COLOR.night : THEME_COLOR[th];
  if (changed) emit('theme', th);
  return changed;
}
/** 编辑页另存的没保存的修改（iOS 在后台把 App 杀掉时留下的，见 views/editor.js）：一天以内的 → 那个编辑页的地址 */
function pendingEdit() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(EDIT_PREFIX)) continue;
      const d = JSON.parse(localStorage.getItem(k) || 'null');
      if (!d || !(Date.now() - (Number(d.at) || 0) < 86400000)) continue;
      const id = k.slice(EDIT_PREFIX.length);
      return id === 'new' ? '#/new' : '#/edit/' + encodeURIComponent(id);
    }
  } catch (e) { /* 读不到就算了 */ }
  return null;
}
/** 夜间时段打开（冷启动，或在后台放了很久再回来）而且停在列表 → 直接进录音页 */
function nightRedirect() {
  const st = S().settings;
  if (!st.nightOpensRecorder || !isNight(new Date(), st) || route().name !== 'list') return false;
  history.replaceState(history.state, '', '#/rec');
  return true;
}

// ---------- ctx ----------
const ctx = {
  get state() { return S(); },
  get local() { return L(); },
  get editVersion() { return state.editVersion(); },
  get route() { return route(); },
  entries,
  entry: (id) => (id && S().data.entries[id]) || null,
  mutate: (fn, opts) => state.mutate(fn, opts),
  put(e, opts) {
    const id = e.id || newId('e_');
    state.mutate(s => { const prev = s.data.entries[id]; s.data.entries[id] = normalizeEntry(stamp({ ...e, id }, prev), id); }, opts);
    return S().data.entries[id];
  },
  update(id, patch, opts) {
    const prev = S().data.entries[id];
    return prev ? ctx.put({ ...prev, ...patch, id }, opts) : null;
  },
  newEntry: (fields) => makeEntry(fields),
  remove(id) {
    const prev = S().data.entries[id];
    if (!prev || prev.deleted) return null;
    state.mutate(s => { s.data.entries[id] = deletedRecord(prev); }, { undoLabel: t('common.deletedOne') });
    return prev;
  },
  restore(id) {
    const r = restoredRecord(S().data.entries[id]);
    if (!r) return null;
    state.mutate(s => { s.data.entries[id] = r; });
    toast(t('common.restored'));
    return S().data.entries[id];
  },
  undo() { const label = state.undo(); if (label) toast(t('common.undone')); return label; },
  setSetting: (key, value) => state.mutate(s => setSetting(s, key, value)),
  mergeIn: (other) => state.mergeIn(other),
  setLocal: (patch) => state.setLocal(patch),

  navigate, back, refresh: () => refresh(), layout,
  guard: () => {},              // 每个页面拿到的是自己的版本（见 viewCtx）
  t, lang: getLang,
  setLang(l) { state.setLocal({ lang: l }); setLang(l); refresh(); },
  setTheme(th) { state.setLocal({ theme: th }); applyTheme(); },
  theme: () => document.documentElement.dataset.theme || 'light',
  toast, sheet, confirm: confirmDialog,
  syncBadge: () => syncBadge(),
  on, onChange: (fn) => on('change', fn),

  audio,
  clipBlob: async (sha) => {
    const rec = await audio.getClip(sha).catch(() => null);
    if (rec && rec.blob) return rec.blob;
    return L().sync ? (await syncer.getAudio(sha).catch(() => null)) || null : null;
  },
  recovered: null,
  bootAt: BOOT,
  takeFiles: () => { const f = droppedFiles; droppedFiles = null; return f; },

  sync: syncApi,
  device: L().device || DEVICE,
  isNight: () => isNight(new Date(), S().settings),
};

// ---------- 外壳 ----------
function syncBadge() {
  const s = L().sync;
  let cls = 'off', text = t('sync.off');
  if (s) {
    if (s.err) { cls = 'err'; text = t('sync.error'); }
    else if (s.offline) { cls = 'wait'; text = t('sync.offline'); }
    else if (s.dirty) { cls = 'wait'; text = t('sync.pending'); }
    else { const p = s.at ? localParts(s.at) : null; cls = 'ok'; text = p ? t('sync.ok', { time: fmtTime(p.time, getLang()) }) : t('sync.ok0'); }
  }
  return h('a.sync-badge.' + cls, { href: '#/settings/sync', title: s && s.err ? t('syncErr.' + s.err.code, s.err.vars) : null }, h('span.dot', { 'aria-hidden': 'true' }), text);
}
function renderSyncBadges() {
  for (const el of document.querySelectorAll('.sync-badge')) el.replaceWith(syncBadge());
}

function renderShell(r) {
  document.documentElement.lang = getLang();
  document.title = t('common.appName');
  $('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', t('common.appName'));
  $('link[rel="manifest"]')?.setAttribute('href', getLang() === 'zh-Hant-TW' ? 'manifest.zh-Hant-TW.webmanifest' : 'manifest.webmanifest');   // 添加到主屏幕时的名字跟着语言
  document.body.dataset.route = r.name;
  document.body.dataset.layout = layout();
  document.body.dataset.tabs = TOP_LEVEL(r) ? '1' : '0';
  document.body.dataset.drop = t('common.dropHint');
  const cur = r.name === 'entry' || r.name === 'editor' ? 'list' : r.name === 'import' || r.name === 'deleted' || r.name === 'diag' ? 'settings' : r.name;
  const side = r.name === 'import' ? 'import' : cur;          // 侧栏有「导入录音」这一项；手机底栏没有，算在设置下面
  const item = (id, href, ic, label) => h('a.nav-item' + (side === id ? '.on' : ''), { href, 'aria-current': side === id ? 'page' : null }, ic, h('span', null, label));
  $('#side').replaceChildren(
    h('div.brand', null, h('img', { src: 'icons/icon-180.png', alt: '', width: 32, height: 32, onerror: e => { e.target.style.visibility = 'hidden'; } }), h('b', null, t('common.appName'))),
    h('nav', { 'aria-label': t('nav.label') },
      item('list', '#/', icon('bubble'), t('nav.list')),
      item('record', '#/rec', icon('snout'), t('nav.rec')),
      item('import', '#/import', icon('import'), t('nav.import')),
      item('settings', '#/settings', icon('gear'), t('nav.settings'))),
    h('div.side-foot', null, syncBadge()),
  );
  const tabs = $('#tabs');
  tabs.setAttribute('aria-label', t('nav.label'));
  tabs.replaceChildren(
    h('a.tab' + (cur === 'list' ? '.on' : ''), { href: '#/', 'aria-current': cur === 'list' ? 'page' : null }, icon('bubble'), h('span', null, t('nav.list'))),
    h('a.tab-rec', { href: '#/rec', 'aria-label': t('nav.rec'), title: t('nav.rec') }, icon('snout')),
    h('a.tab' + (cur === 'settings' ? '.on' : ''), { href: '#/settings', 'aria-current': cur === 'settings' ? 'page' : null }, icon('gear'), h('span', null, t('nav.settings'))),
  );
}

// ---------- 页面挂载 ----------
const mounted = {};           // slot → { slot, name, key, params, el, handle, offs, guard }
const scroller = (el) => (layout() === 'phone' ? document.scrollingElement : el);
function scrollTop() {
  if (layout() === 'phone') return window.scrollY;
  const m = mounted.main || mounted.detail; return m ? m.el.scrollTop : 0;
}

function viewCtx(m) {
  const c = Object.create(ctx);
  c.on = (ev, fn) => { const off = on(ev, fn); m.offs.push(off); return off; };
  c.onChange = (fn) => c.on('change', fn);
  c.guard = (fn) => { m.guard = typeof fn === 'function' ? fn : null; };
  c.params = m.params;
  return c;
}
function runView(m) {
  m.offs = []; m.guard = null; m.handle = null;
  if (m.name === 'empty') {
    m.el.append(h('div.detail-empty', null, h('img', { src: 'icons/icon.svg', alt: '', width: 96, height: 96, onerror: e => e.target.remove() }), h('p', null, t('common.pickEntry'))));
    return;
  }
  try {
    const ret = VIEWS[m.name].render(m.el, m.params, viewCtx(m));
    m.handle = typeof ret === 'function' ? { cleanup: ret } : ret && typeof ret === 'object' ? ret : null;
  } catch (e) { safeMode(m.el, e); }
}
function cleanupView(m) {
  for (const off of m.offs || []) off();
  m.offs = []; m.guard = null;
  try { if (m.handle && m.handle.cleanup) m.handle.cleanup(); } catch (e) { console.error(e); }
  m.handle = null;
}
function unmount(slot) {
  const m = mounted[slot];
  if (!m) return;
  cleanupView(m);
  m.el.remove();
  delete mounted[slot];
}
const keyOf = p => p.slot + '|' + p.name + '|' + p.params.hash;

function mount(p, main, force) {
  const old = mounted[p.slot];
  const key = keyOf(p);
  if (old && old.key === key && !force) return old;
  const keepScroll = old && old.name === p.name && p.slot === 'list' ? old.el.scrollTop : null;   // 双栏左边的列表：换选中的条目不跳回顶部
  if (old) cleanupView(old);
  const el = old ? old.el : h('section.pane');
  el.className = `pane pane-${p.slot} view view-${p.name}`;
  el.replaceChildren();
  const m = { slot: p.slot, name: p.name, key, params: p.params, el, handle: null, offs: [], guard: null };
  mounted[p.slot] = m;
  if (!old) main.append(el);
  runView(m);
  const back = lastWasBack && scrollMemory.get(p.params.hash);
  const top = keepScroll != null ? keepScroll : back != null && back !== false ? back : 0;
  if (layout() === 'phone') window.scrollTo(0, top); else el.scrollTop = top;
  return m;
}

/** 数据变了：带 onChange 的页面自己更新，其余整个重画（保留滚动和焦点） */
function rerender(m) {
  const sc = scroller(m.el), top = sc ? sc.scrollTop : 0;
  const active = document.activeElement, fid = active && active.dataset ? active.dataset.fid : null;
  cleanupView(m);
  m.el.replaceChildren();
  runView(m);
  if (sc) sc.scrollTop = top;
  if (fid) { const el = m.el.querySelector(`[data-fid="${CSS.escape(fid)}"]`); if (el) el.focus({ preventScroll: true }); }
}

/** 换布局（转屏、拉窗口）时同一个页面要换栏：自己管更新（有 onChange）或有没保存的修改的页面整个搬过去，不丢输入、不打断录音 */
function migrate(plan) {
  for (const p of plan) {
    if (mounted[p.slot] && mounted[p.slot].name === p.name) continue;
    const from = Object.keys(mounted).find(s => s !== p.slot && mounted[s].name === p.name && mounted[s].params.hash === p.params.hash
      && !plan.some(q => q.slot === s && q.name === mounted[s].name));
    const m = from && mounted[from];
    if (!m || !((m.handle && m.handle.onChange) || (m.guard && safeCall(m.guard)))) continue;
    if (mounted[p.slot]) unmount(p.slot);
    delete mounted[from];
    Object.assign(m.params, { pane: p.params.pane, selected: p.params.selected });   // 页面拿到的 params 是同一个对象
    Object.assign(m, { slot: p.slot, key: keyOf(p) });
    m.el.className = `pane pane-${p.slot} view view-${p.name}`;
    mounted[p.slot] = m;
  }
}

function render() {
  delete document.documentElement.dataset.boot;      // src/boot.js 第一次绘制前刷的近黑底，app 画出来以后就不用了
  const r = route();
  const plan = planPanes(r, layout());
  renderShell(r);
  applyTheme();
  const main = $('#main');
  main.dataset.panes = String(plan.length);
  migrate(plan);
  for (const slot of Object.keys(mounted)) if (!plan.some(p => p.slot === slot && mounted[slot].name === p.name)) unmount(slot);
  const changedMain = plan.some(p => !mounted[p.slot] || mounted[p.slot].key !== keyOf(p));
  for (const p of plan) mount(p, main);
  // 面板顺序：左栏在前（只在顺序不对时移动，移动元素会丢滚动位置）
  plan.forEach((p, i) => { const el = mounted[p.slot].el; if (main.children[i] !== el) main.insertBefore(el, main.children[i] || null); });
  if (changedMain && !document.querySelector('dialog[open]')) {
    const focusTo = mounted.detail || mounted.main;
    if (focusTo && !focusTo.el.contains(document.activeElement)) { focusTo.el.tabIndex = -1; focusTo.el.focus({ preventScroll: true }); }   // 换页后读屏、键盘从新页面开始
  }
}
function refresh() {
  for (const slot of Object.keys(mounted)) unmount(slot);
  render();
}

// 数据变化 → 提示撤销 / 存储满 → 安排同步 → 页面更新
let rerenderQueued = false;
state.subscribe((st, info) => {
  cache = null;
  if (info.saved === false) toast(t('common.storageFull'), { ms: 10000 });
  else if (info.undoLabel) toast(info.undoLabel, { ms: 10000, action: { label: t('common.undo'), run: () => ctx.undo() } });
  if (info.source === 'local' || info.source === 'undo' || info.source === 'merge') syncSoon();
  emit('change', info);
  applyTheme();                                // 夜间设置可能变了；主题只换颜色，不用重画
  if (rerenderQueued) return;
  rerenderQueued = true;
  queueMicrotask(() => {
    rerenderQueued = false;
    renderSyncBadges();
    for (const m of Object.values(mounted)) {
      if (m.handle && typeof m.handle.onChange === 'function') { try { m.handle.onChange(info); } catch (e) { console.error(e); } }
      else if (m.name !== 'empty') rerender(m);
    }
  });
});

// ---------- 出错时的安全模式：数据有问题也能导出、停止同步 ----------
function safeMode(el, e) {
  console.error(e);
  el.replaceChildren(h('div.page', null, h('section.card.safe-mode', null,
    h('p.err', null, t('common.renderError'), ' ', String((e && e.message) || e)),
    h('p.muted', null, t('common.safeMode')),
    h('div.row', null,
      h('button.btn', { type: 'button', onclick: () => download('babble-data.json', JSON.stringify({ app: 'babble', v: 1, kind: 'raw', exportedAt: new Date().toISOString(), state: S() }), 'application/json') }, t('common.exportRaw')),
      L().sync ? h('button.btn', { type: 'button', onclick: () => { syncApi.stop(); refresh(); } }, t('sync.stop')) : null,
      h('a.btn', { href: '#/diag' }, t('nav.diag'))))));
}

// ---------- 启动时找回没收尾的录音 ----------
// 条目建好、真的存进本机以后才清恢复记录（clearRec）；存不下、出错就留着，下次启动再交回来
const clearRecs = (list) => { for (const c of list) if (c.recId) Promise.resolve(audio.clearRec(c.recId)).catch(() => {}); };
async function recover() {
  let clips = [];
  try { clips = (await recoverPending({ audioStore: audio, before: BOOT })) || []; }
  catch (e) { toast(t('common.recoverFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); return []; }
  const known = clipIndex(S(), { includeDeleted: true });
  const valid = clips.filter(c => c && c.sha256);
  const fresh = valid.filter(c => !known.has(c.sha256));     // 已经在某条里的不再建
  clearRecs(valid.filter(c => known.has(c.sha256)));
  if (!fresh.length) return [];
  let saved = true, ids = [];
  const off = state.subscribe((st, info) => { if (info.saved === false) saved = false; });
  try {
    ids = state.mutate(s => fresh.map(c => {
      const now = Date.now();
      const clip = { sha256: c.sha256, mime: c.mime || 'audio/mp4', bytes: c.bytes ?? null, durationSec: c.durationSec ?? null, origName: '', addedAt: now };
      const target = c.attachTo && s.data.entries[c.attachTo];
      if (target && !target.deleted) { target.audio = [...(target.audio || []), clip]; return target.id; }
      const parts = c.startedAt != null ? localParts(c.startedAt, c.tz || undefined) : null;
      const e = makeEntry({
        date: parts ? parts.date : today(), time: parts ? parts.time : null,
        recordedAt: parts ? new Date(c.startedAt).toISOString() : null, tz: c.tz || null, timeSource: parts ? 'recorder' : null,
        status: 'inbox', audio: [clip], source: { kind: 'recovered' },
      }, now);
      s.data.entries[e.id] = e;
      return e.id;
    }));
  } catch (e) { saved = false; console.error(e); toast(t('common.recoverFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); }
  off();
  if (!saved) return ids;                    // 存不下已经提示过「空间满」
  clearRecs(fresh);
  toast(t('common.recovered', { n: fresh.length }), { ms: 8000 });
  return ids;
}

// ---------- 拖进窗口的录音（Mac） ----------
let droppedFiles = null, dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('drop', e => {
  dragDepth = 0; document.body.classList.remove('dragging');
  if (!hasFiles(e)) return;
  const handled = e.defaultPrevented;          // 导入页自己的拖放区已经处理过（它先收到事件）
  e.preventDefault();
  if (handled) return;
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  droppedFiles = files;
  if (route().name === 'import') refresh(); else navigate('/import');
});
// ⌘N / Ctrl+N 记一条
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { e.preventDefault(); navigate('/new'); }
});

// ---------- 第一次点按时申请「不要清理本机数据」（Safari 要求在用户操作里） ----------
let persistAsked = false;
function firstGesture() {
  if (persistAsked) return;
  persistAsked = true;
  window.removeEventListener('pointerdown', firstGesture, true);
  window.removeEventListener('keydown', firstGesture, true);
  try { Promise.resolve(audio.persist()).catch(() => {}); } catch (e) { /* 不支持就算了，设置页会显示状态 */ }
}
window.addEventListener('pointerdown', firstGesture, true);
window.addEventListener('keydown', firstGesture, true);

// ---------- 什么时候同步 ----------
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    applyTheme();
    if (hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000 && nightRedirect()) {
      // 地址是「换掉」的（没有新的历史记录）：App 内历史也换掉最后一项，不然录音页的「返回」「完成」会 history.back() 到不存在的上一页
      currentHash = location.hash; lastWasBack = false;
      if (navStack.length) navStack[navStack.length - 1] = currentHash; else navStack.push(currentHash);
      render();
    }
    syncIfStale();
  } else {
    hiddenAt = Date.now();
    if (L().sync && L().sync.dirty) { syncSoon.cancel(); syncApi.now(); }      // 切走前把改动传上去
  }
});
window.addEventListener('online', () => { if (L().sync) syncApi.now(); });
window.addEventListener('storage', e => { if (e.key === state.KEY || e.key === state.LKEY) state.reload(); });   // 别的标签页改了数据
setInterval(() => { if (document.visibilityState === 'visible') { syncIfStale(); applyTheme(); } }, 60000);
prefersDark.addEventListener('change', () => applyTheme());
for (const mq of [mqSide, mqTwo]) mq.addEventListener('change', () => { render(); emit('layout', layout()); });

// ---------- 启动 ----------
setLang(L().lang && LANGS.includes(L().lang) ? L().lang : guessLang());
// 冷启动：上次写到一半被系统关掉的编辑页优先（停在列表时直接回去接着写），否则按夜间设置
const resumeEdit = pendingEdit();
if (resumeEdit && route().name === 'list') history.replaceState(history.state, '', resumeEdit);
else nightRedirect();
currentHash = location.hash || '#/';
track(currentHash);
ctx.recovered = recover();
render();
if (L().sync) syncApi.now();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__babble = { state, ctx, mounted, get S() { return S(); } };   // 方便在浏览器控制台里查看
