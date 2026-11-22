// 牙牙呓语：启动、外壳（手机底栏 / 侧栏 / 双栏）、路由、主题与夜间、同步调度、录音恢复（含上次没收尾的床头模式）、
// 永久删除后的本机清理和 30 天到期（core/purge.js）、新版设备报到。页面在 views/，计算在 core/。
//
// ===== 页面接口 =====
// export function render(main, params, ctx) → 清理函数 | { cleanup?(), onChange?(info) } | undefined
//   main    空的容器（<section class="pane view view-<name>">），页面自己画顶栏和内容
//   params  { name, path, id, sub, query, pane, selected, hash }
//           name: 'list' | 'calendar' | 'entry' | 'editor' | 'deleted' | 'record' | 'night' | 'import' | 'settings' | 'diag'
//           #/ → list；#/cal、#/cal/YYYY-MM、#/cal/YYYY-MM-DD → calendar（sub 是后面那段或 null）
//           #/e/<id> → entry（id）；#/e/<id>/history → entry（sub 'history'，修改记录）
//           #/new → editor（sub 'new'，id null）；#/edit/<id> → editor（sub 'edit'）
//           #/rec、#/rec?attach=<id> → record（query.attach）；#/rec?bed=1 → record（query.bed：床头模式，record.js 交给 views/bedside.js）
//           #/night → night（id null：最新一晚）；#/night/<YYYY-MM-DD> → night（id，那一晚）；#/import → import（sub 'audio'）；#/import/notes → import（sub 'notes'）
//           #/settings、#/settings/sync → settings（sub null | 'sync'）；#/deleted → deleted；#/diag → diag；不认识的地址 → list
//           pane: 'main'（单栏）| 'list'（双栏左）| 'detail'（双栏右）；selected: 双栏时右栏正在看的条目 id（给列表高亮）
//   数据变了：页面返回了 onChange 就只调 onChange(info)，页面自己更新（编辑页、录音页必须这样，免得打断输入和录音）；
//            否则 app 把这个页面整个重画一遍（保留滚动位置；带 data-fid 的控件重画后恢复焦点）。
//   双栏（≥1000px）：#/、#/cal…、#/e/<id>、#/new、#/edit/<id> 左栏是列表或日历，右栏是详情 / 编辑（#/、#/cal… 时右栏是提示）。
//            看条目、编辑时左栏是哪个，按上次看的（babble.local.listMode：'list' | 'cal'；打开 #/ 或 #/cal… 时记下）。
//   手机：只有 #/、#/cal… 和 #/settings 显示底栏；其他页面是「推入」的，自己画返回按钮（ctx.back）。#/rec 时侧栏也隐藏（全屏近黑）。
//   换布局（转 iPad、拉窗口）：同一栏的页面原样保留；要换栏时，有 onChange 或有未保存修改（guard）的页面整个搬过去
//            （params.pane / selected 原地更新），其余重画。要随布局变化的页面听 ctx.on('layout')。
//
// ===== ctx =====
// 数据（src/core/state.js 的包装；改数据一律走这些，app 会保存、同步、重画）
//   ctx.state                  当前数据（只读）：{ app, v, data: { entries }, settings, settingsAt }
//   ctx.local                  本机设置 babble.local（只读）：{ lang, theme, device, sync, lastBackupAt, audioSync }（页面自己的：recOnly、listMode、床头模式的 bedAutoEnd / bedVadOk / bedKeepNoted…）
//                              永久删除用的：deviceId（报到用的设备 id）、squashMark / squashNote（清理云端历史）、purgeNoticeAt、repairedAt（这次修过数据的时刻）
//   ctx.entries()              没删除的条目，新的在前（byNewest）；缓存到下次数据变化
//   ctx.entry(id)              按 id 取条目（含已删除的），没有、或已经永久删除（只剩墓碑）→ null
//   ctx.tombstone(id)          永久删除以后留下的墓碑（{ id, purged, purgedAt, purgedFrom, gone… }，没有内容）；不是墓碑 → null
//   ctx.mutate(fn, { undoLabel })  fn(state) 直接改（同步函数），返回 fn 的返回值；修改时间自动补；给 undoLabel 会弹 10 秒「撤销」提示
//   ctx.put(entry, { undoLabel })  新建或整条替换，返回存好的条目（那条已经永久删除 → null，什么都不写）
//   ctx.update(id, patch, { undoLabel })  改几个字段，返回存好的条目（没有这条、已经永久删除 → null）
//   ctx.goneShas()             Set：永久删除了、也没有别的条目在用的录音 sha（store.js goneShas）；缓存到下次数据变化
//   ctx.removedClips()         「移除的录音」[{ entryId, item, at }]，新移除的在前（store.js removedClips；没删除的条目里的）
//   ctx.newEntry(fields)       makeEntry：补齐默认值的新条目（还没存，要 ctx.put）
//   ctx.remove(id)             软删除 + 10 秒「撤销」提示，返回删除前的条目
//   ctx.restore(id)            从「最近删除」恢复
//   ctx.undo()                 撤销最近一次带 undoLabel 的修改
//   ctx.setSetting(key, value) 改一项设置（speakers、nightStart…）
//   ctx.mergeIn(otherState)    导入备份（逐条合并），返回 { changed }
//   ctx.setLocal(patch)        改本机设置（不重画页面）
//   ctx.editVersion            本机修改计数
//   ctx.saveOk()               最近一次数据写入是否成功；编辑页确认成功后才清草稿、离开
// 永久删除（core/purge.js）。PURGE_ENABLED 现在开着（第二阶段）；关着时（第一阶段）页面不显示这些按钮，这里也什么都不删，返回 { done: [], changed: [], skipped: true }
//   ctx.purge(list)            永久删除「最近删除」里的条目：list = [{ id, at: 画出来时的 updatedAt }]；开着同步先同步一次（最多等 10 秒）
//                              → Promise<{ done: [id], changed: [id] }>（changed：期间在别的设备上改过 / 恢复了，没删；页面重画、提示 deleted.changedElsewhere）
//   ctx.purgeClips(list)       永久删除移除的录音：[{ id, sha256, removedAt }] → 同上（done / changed 里是 { id, sha256 }）
//   ctx.purgeAll({ entries, clips })  「全部永久删除」：传画出来的那份清单（同上两种），一次删完 → 同上（两种混在一起）
//   ctx.purgeOrphans(list)     没有条目在用的录音 [{ sha256, mime }] → Promise<{ done: [sha], changed: [sha] }>（写一个孤儿墓碑）
//                              以上几个：开着同步时页面接着调 ctx.sync.now()（不等防抖），没同步成功就提示 common.purgedOffline；没有撤销
//   ctx.restoreClip(id, sha)   「移除的录音」放回那条 → 存好的条目 | null（开关关着也能用；提示由页面弹）
//   ctx.localOrphans()         → Promise<[{ sha256, mime, bytes, addedAt, uploaded }]>：这台设备上没有条目在用的录音（一小时内的、草稿里的不算）
//   ctx.trashInfo(key)         「最近删除」里一项的日期 → { shownAt }（这天以后才会被自动永久删除；开着同步、开放以后还没同步成功过 → null）
//                              key：'e:'+条目 id | 'c:'+条目 id+':'+sha（store.js trashKeys）
// 导航
//   ctx.navigate(path, { replace })  path 如 '/e/abc'、'/rec?attach=abc'（前面的 # 可有可无）；同一地址 = 重画
//   ctx.replaceHash(path)      页面自己换了状态（日历翻月、选日子）：只换地址栏，不重画、不加历史记录
//   ctx.back(fallback = '/')   App 内有上一页就后退，否则换成 fallback（'/' 指「呓语」：列表或日历，看上次用的哪个）
//   ctx.home()                 「呓语」的地址：'/' 或 '/cal'（看上次用的哪个）
//   ctx.setListMode('list'|'cal')  「列表 | 日历」切换：记下来；在列表 / 日历页就换过去，双栏看着条目时只换左栏
//   ctx.route                  当前路由（同 params 的结构，不含 pane/selected）
//   ctx.refresh()              重画当前所有页面
//   ctx.guard(isDirty, msg)    离开前检查：isDirty() 为 true 时先确认（路由切换、关闭标签页）；ctx.guard(null) 取消；页面清理时自动取消
//                              msg 可选 { message, confirmLabel, cancelLabel }：换掉「有没保存的修改」那套说法（床头模式：「离开这页就不听了」）
//   ctx.layout()               'phone'（<720）| 'side'（720–999，有侧栏）| 'two'（≥1000，双栏）
// 界面
//   ctx.t(key, vars)、ctx.lang()、ctx.setLang(l)、ctx.setTheme('auto'|'light'|'dark')、ctx.theme()（当前生效的 'light'|'dark'）
//   ctx.toast(msg, { ms, action: { label, run } })、ctx.sheet(content, opts)、ctx.confirm(opts) → Promise<boolean>（见 ui/dom.js）
//   ctx.syncBadge()            同步状态小标签（元素，点了去 #/settings/sync）
//   ctx.on(event, fn)          'change'(info) | 'sync'(status) | 'layout'(layout) | 'theme'(theme)；返回取消函数，页面清理时自动取消
//   ctx.onChange(fn)           = ctx.on('change', fn)
// 录音
//   ctx.audio                  src/core/audioStore.js 整个模块（putClip、getClip、hasClip…）
//   ctx.clipBlob(sha, mime?)   → Promise<Blob|null>：先找本机，没有且开了同步就按需下载（播放器的 getBlob 用它；
//                              已经没有条目引用的录音要给 mime，才找得到仓库里的文件）。永久删除了的（goneShas）→ null，本机还没清掉也不给
//   ctx.recovered              Promise<string[]>：启动时找回的录音（和边录边写没存完的字）放进的条目 id；录音页、编辑页要等它，再读草稿
//   ctx.bootAt                 这次启动的时刻（毫秒）
//   ctx.takeFiles()            拖进窗口的录音文件（File[]，取一次就清空；没有 → null）。导入页打开时调一下
// 床头模式
//   ctx.night                  src/core/nightStore.js 整个模块（IndexedDB babble-night：每晚的记录、候选片段，只在本机）
//   ctx.nightRecovered         Promise：启动时把上次被关掉的床头模式收尾（recoverNights）、按期限清理（purgeNights）；
//                              床头页、昨夜页、列表的「昨夜」卡片要等它再读 babble-night（数据有问题时直接 resolve，不碰）
//   ctx.build                  这一版的名字（src/start.js 的 BUILD，启动器放在 window.__babbleBuild；开发时没有 → null）
// 同步
//   ctx.sync.now(opts)         立即同步 → Promise<{ ok, skipped?, error?, offline? }>（暂停着也照样同步：「立即同步」是用户自己点的）。
//                              opts 交给 sync.js（{ forcePush, forceAudit }，一般不用给）。每一轮做完：清理本机已经确认删掉的、到期的自动永久删除、报到
//   ctx.sync.pause(tag)        暂停自动同步，返回 resume()：有人暂停着时改了数据、定时、联网、切到后台都不同步；最后一个 resume() 后马上排一次
//                              （已经在后台了就马上同步）。别的标签页暂停着也算（每个暂停拿一个 Web Lock「babble-sync-hold:…」）。
//                              床头模式开着时（'bedside'）、昨夜页每次留下以后 10.5 秒（'night-undo'：提示条上撤销时录音还没传上去）、
//                              录音页刚存好的录音（'rec-fresh'：给「放弃这段录音」留时间，见 views/record.js）用
//   ctx.sync.connect({ repo, token, tokenExp })  保存同步设置并马上同步一次 → 同上（tokenExp：用户填的令牌到期时刻，可选）
//   ctx.sync.stop()            停止同步（只清本机设置）
//   ctx.sync.checkRepo(repo, token) → Promise<仓库全名>（不是私有 / 没权限会抛 SyncError）
//   ctx.sync.status()          { on, running, pendingUp, pendingDown, lastError, at, err, offline, dirty, repo,
//                                pendingPurge（待从仓库删的录音段数）, purging, oldDevices（最近还在用旧版本推送的设备名） }
//   ctx.sync.getAudio(sha)     → Promise<Blob|null>
//   ctx.sync.squash()          「清理云端历史」→ Promise<{ ok, already?, commit?, branch?, missing?, error? }>（错误照常翻译 syncErr.<code>）；
//                              成功后写同步的 cloudResetAt（别的设备据此把录音和仓库对一遍）、local.squashNote（{ at, branch }：显示 Mac 上的步骤，
//                              页面「知道了」时 setLocal({ squashNote: null })）。开关关着 → { ok: false, skipped: true }
//   ctx.sync.orphans()         先同步一轮，再找仓库里没有条目在用的录音（只读）→ Promise<{ ok, files: [{ sha256, path, ext, size, at, mime }], recent, more, error? }>
//                              （recent：24 小时内传上来的，只计数不列出）
//   ctx.sync.historyInfo()     → Promise<{ commits, branch, others: [名字] } | null>：仓库有几个提交、默认分支、别的分支 / 标签（尽力而为，确认框用）
//   ctx.sync.devices()         新版设备报到（同步的 data.devices，每台设备每轮同步成功后报到，名字、版本没变时 3 天一次）
//                              → { updated: [{ id, name, who, build, seenAt, me }]（最近报到的在前；me：这台设备）,
//                                  waiting: [{ name, who, at, old }]（60 天内改过梦话、或用旧版本推送过的设备里，还没有对得上的报到的；
//                                  这台设备不算；同名同人的分不出来。at：最近改梦话的时刻，只见过推送 → null；old：最近同步时还是旧版本） }
// 修改记录
//   ctx.history.list(id)       → Promise<[{ id, entryId, at, version, cause, replacedBy }]>：这台设备记下的旧版本，新的在前
//   ctx.history.cloud          core/history.js 的 createCloudHistory：.session(id).run() 从云端的历史版本里找更早的
//                              （永久删除的条目从缓存里去掉；清理过云端历史——本机或别的设备，看 cloudResetAt——缓存整个重来）
// 其他
//   ctx.device                 设备名（babble.local.device，没填就是 iPhone / iPad / Mac / Browser）
//   ctx.isNight()              现在是不是夜间时段（按设置）
import * as state from './core/state.js';
import { stamp, deletedRecord, restoredRecord, setSetting, live, byNewest, makeEntry, normalizeEntry, clipIndex, newId, goneShas, stubShas, removedClips, trashKeys, isTombstone } from './core/store.js';
import { isNight, localParts, fmtTime, fmtDate } from './core/dates.js';
import { debounce, sleep } from './core/util.js';
import { createPurger, PURGE_ENABLED, shaSig, deviceSeen, deviceReport } from './core/purge.js';
import { createSync } from './core/sync.js';
import { journal, createCloudHistory, platformDevice } from './core/history.js';
import * as audio from './core/audioStore.js';
import { recoverPending } from './core/recorder.js';
import * as nightStore from './core/nightStore.js';
import { recoverNights, purgeNights } from './core/bedside.js';
import { t, setLang, getLang, guessLang, LANGS } from './i18n.js';
import { h, $, icon, toast, sheet, confirmDialog, download } from './ui/dom.js';
import * as list from './views/list.js';
import * as calendar from './views/calendar.js';
import * as entry from './views/entry.js';
import * as editor from './views/editor.js';
import { EDIT_PREFIX, REC_DRAFT, NEW_DRAFT, readDraft, writeDraft, applyRecovery, stashPurgedText } from './core/drafts.js';
import * as deleted from './views/deleted.js';
import * as record from './views/record.js';
import * as nightView from './views/night.js';
import * as importView from './views/import.js';
import * as settings from './views/settings.js';
import * as diagnostics from './views/diagnostics.js';
import { askWho, shouldAskWho } from './views/device.js';
import { recoveryPanel } from './ui/recovery.js';
import { forgetClip } from './ui/player.js';

const BOOT = Date.now();
const VIEWS = { list, calendar, entry, editor, deleted, record, night: nightView, import: importView, settings, diag: diagnostics };
const DEVICE = platformDevice();
const THEME_COLOR = { light: '#f8f3ee', dark: '#141216', night: '#0b0c12' };

state.load();
state.setDefaultDevice(DEVICE);
state.setJournal(journal.record, journal.forget);   // 条目被换掉前把旧版本记进 babble-history（只排队，不挡保存）；永久删除的条目连旧版本一起忘掉
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
  else if (a === 'cal') r = { name: 'calendar', sub: b || null };
  else if (a === 'e' && b) r = { name: 'entry', id: b, sub: path[2] === 'history' ? 'history' : null };
  else if (a === 'edit' && b) r = { name: 'editor', id: b, sub: 'edit' };
  else if (a === 'new') r = { name: 'editor', sub: 'new' };
  else if (a === 'rec') r = { name: 'record' };
  else if (a === 'night') r = { name: 'night', id: b || null };
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
const HOME = r => r.name === 'list' || r.name === 'calendar';          // 「呓语」：列表或日历
const TOP_LEVEL = r => HOME(r) || (r.name === 'settings' && !r.sub);
const listMode = () => (L().listMode === 'cal' ? 'cal' : 'list');
const home = () => (listMode() === 'cal' ? '/cal' : '/');

/** 这个路由在这个布局下要画哪些栏 */
function planPanes(r, lay) {
  if (lay === 'two' && (HOME(r) || r.name === 'entry' || r.name === 'editor')) {
    const left = r.name === 'calendar' || (r.name !== 'list' && listMode() === 'cal') ? 'calendar' : 'list';
    return [
      { slot: 'list', name: left, params: { ...r, name: left, pane: 'list', selected: r.id } },
      { slot: 'detail', name: HOME(r) ? 'empty' : r.name, params: { ...r, pane: 'detail', selected: r.id } },
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
  const msg = dirty.map(m => m.guardMsg).find(Boolean) || {};       // 页面自己的说法（床头模式：「离开这页就不听了」）
  const ok = await confirmDialog({ message: msg.message || t('common.unsaved'), confirmLabel: msg.confirmLabel || t('common.leave'), cancelLabel: msg.cancelLabel || t('common.stay'), danger: true });
  if (ok) for (const m of Object.values(mounted)) m.guard = null;
  return ok;
}
const safeCall = fn => { try { return !!fn(); } catch (e) { return false; } };

async function navigate(path, { replace = false } = {}) {
  if (state.storageIssue()) return false;
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
  else navigate(fallback === '/' ? home() : fallback, { replace: true });
}
/** 页面自己换了状态（日历翻月、选日子）：只换地址栏，不重画、不加历史记录；挂着的页面记下新地址（下次 render 不当成换页） */
function replaceHash(path) {
  const target = norm(path), before = route().hash;
  if ((location.hash || '#/') === target) return;
  history.replaceState(history.state, '', target);
  currentHash = target;
  if (navStack.length) navStack[navStack.length - 1] = target; else navStack.push(target);
  for (const m of Object.values(mounted)) if (m.params.hash === before) { m.params.hash = target; m.key = m.slot + '|' + m.name + '|' + target; }
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
let cache = null, goneCache = null;
let askWhoPending = false;      // 要问「这台设备是谁在用」，等离开录音页 / 关掉面板再问（见 askWhoSoon）
function entries() {
  if (!cache) cache = live(S()).sort(byNewest);
  return cache;
}
/** 永久删除了、没有别的条目在用的录音（缓存到下次数据变化） */
const goneNow = () => goneCache || (goneCache = goneShas(S()));
const tombOf = (id) => { const e = id && S().data.entries[id]; return isTombstone(e) ? e : null; };

// ---------- 同步 ----------
let lastSyncTry = 0;
// babble.purge（仓库里删录音的进度、确认过的云端版本，几个标签页共用）：每次用时再拿 localStorage（权限恢复后换了对象也跟着换）
const purgeStore = { getItem: (k) => { try { return globalThis.localStorage.getItem(k); } catch (e) { return null; } }, setItem: (k, v) => globalThis.localStorage.setItem(k, v) };
const syncer = createSync({
  getState: S,
  applyRemote: (merged, info) => state.applyRemote(merged, info),
  getConfig: () => state.storageIssue() ? null : L().sync,
  saveConfig: (cfg) => {
    if (L().sync === cfg) {
      // 数据没存进本机（空间满）：本机存的比云端旧，不记云端版本号——下次启动完整拉取、合并，不会被 304 当成「没变化」
      if (state.saveOk()) state.saveLocal();
      else { const { sha, etag } = cfg; cfg.sha = cfg.etag = null; state.saveLocal(); Object.assign(cfg, { sha, etag }); }
    }
    syncChanged();
  },
  editVersion: state.editVersion,
  device: () => state.deviceName(),            // 设置里改了设备名，下一次上传就用新名字
  audioStore: audio,
  getLocal: L, saveLocal: state.saveLocal, setLocal: state.setLocal,     // setLocal：清理云端历史前记下 squashMark
  storage: purgeStore,
  onStatus: () => syncChanged(),
});
function syncStatus() {
  const c = L().sync;
  const st = (() => { try { return syncer.status() || {}; } catch (e) { return {}; } })();
  return { running: false, pendingUp: 0, pendingDown: 0, lastError: null, pendingPurge: 0, purging: false, oldDevices: [], ...st, on: !!c,
    repo: c ? c.repo : null, at: c ? c.at || null : null, err: c ? c.err || null : null, offline: !!(c && c.offline), dirty: !!(c && c.dirty) };
}
function syncChanged() { renderSyncBadges(); emit('sync', syncStatus()); }
const syncApi = {
  now: (opts) => {
    if (state.storageIssue()) return Promise.resolve({ ok: false, skipped: true });
    lastSyncTry = Date.now();
    const p = syncer.syncNow(opts);
    syncChanged();
    return p.then(r => { afterRound(r); return r; }).finally(syncChanged);
  },
  connect: ({ repo, token, tokenExp = null }) => {
    state.setLocal({ sync: { repo, token, sha: null, etag: null, dirty: true, at: null, err: null, offline: false, ...(tokenExp ? { tokenExp } : {}) } });
    syncChanged();
    return syncApi.now();
  },
  stop: () => { syncSoon.cancel(); state.setLocal({ sync: null }); syncChanged(); },
  checkRepo: (repo, token) => syncer.checkRepo(repo, token),
  status: syncStatus,
  getAudio: (sha) => syncer.getAudio(sha),
  async squash() {
    if (!PURGE_ENABLED || state.storageIssue() || !L().sync) return { ok: false, skipped: true };
    squashing = true;
    let r;
    try { r = await syncer.squash(); }
    finally { squashing = false; }
    if (r && r.ok && !r.already) { markCloudReset(); state.setLocal({ squashNote: { at: Date.now(), branch: r.branch || null } }); }
    else if (L().squashMark) markCloudReset();   // 强制更新以后核对没通过（可能已经换了）：照样写 cloudResetAt，别的设备复查一遍
    afterRound({ ok: false });
    syncChanged();
    return r;
  },
  orphans: async () => { const r = await syncer.orphans(); afterRound({ ok: false }); syncChanged(); return r; },   // 里面先同步了一轮
  historyInfo: () => syncer.historyInfo(),
  devices: () => deviceReport(S(), { me: L().deviceId || null, self: { name: state.deviceName(), who: L().who }, oldDevices: syncStatus().oldDevices }),
};
// 暂停自动同步（床头模式整夜开着、昨夜页留下后等撤销、录音页刚存好的录音）：每次 pause 一个记号，都 resume 了才恢复，并马上排一次
//（这时已经切到后台了：不等 3 秒，马上传——后台的定时器要等回到前台才跑）。
// 别的标签页暂停着也算：每个记号拿一个 Web Lock（babble-sync-hold:…，标签页没了自动放开），自动同步之前查一下（查不了就只看这一页）
const HOLD_LOCK = 'babble-sync-hold:';
const holds = new Set(), held = () => holds.size > 0, ownHoldLocks = new Set();
let holdSeq = 0;
syncApi.pause = (tag) => {
  const hold = { tag };
  holds.add(hold); syncSoon.cancel();
  const lk = globalThis.navigator && navigator.locks;
  if (lk && lk.request) {
    const name = HOLD_LOCK + tag + ':' + (++holdSeq) + ':' + Math.random().toString(36).slice(2, 8);
    const freed = new Promise(res => { hold.unlock = res; });
    ownHoldLocks.add(name);
    try { Promise.resolve(lk.request(name, () => freed)).catch(() => {}).finally(() => ownHoldLocks.delete(name)); }
    catch (e) { ownHoldLocks.delete(name); }
  }
  return () => {
    if (!holds.delete(hold)) return;
    if (hold.unlock) hold.unlock();
    if (held()) return;
    if (document.visibilityState === 'hidden' && L().sync && L().sync.dirty) { syncSoon.cancel(); autoSync(); }
    else syncSoon();
  };
};
/** 别的标签页暂停着自动同步吗（这一页自己的不算） */
async function heldElsewhere() {
  const lk = globalThis.navigator && navigator.locks;
  if (!lk || !lk.query) return false;
  try { const q = await lk.query(); return (q.held || []).some(l => l && typeof l.name === 'string' && l.name.startsWith(HOLD_LOCK) && !ownHoldLocks.has(l.name)); }
  catch (e) { return false; }
}
/** 自动同步（改了数据、定时、联网、切到后台、开机）：这一页、别的标签页暂停着都不同步；ok() 是另外的条件（查完锁再看一遍） */
function autoSync(ok = () => true) {
  if (!L().sync || held() || !ok()) return;
  heldElsewhere().then(other => { if (!other && L().sync && !held() && ok()) syncApi.now(); });
}
const syncSoon = debounce(() => autoSync(), 3000);
const syncIfStale = () => autoSync(() => Date.now() - lastSyncTry > 5000);

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
/** 编辑页另存的没保存的修改（iOS 在后台把 App 杀掉时留下的，见 views/editor.js）：一天以内的 → 那个编辑页的地址。
 *  那条已经永久删除了的不管多久以前都回去（先回这种）：编辑页显示「已经永久删除」，让用户选另存为新的一条或丢掉——
 *  不然草稿（里面是原来的原话）就一直留在这台设备上，别处又进不了那个编辑页（草稿不悄悄丢，也不悄悄留着） */
function pendingEdit() {
  let fresh = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(EDIT_PREFIX)) continue;
      const d = JSON.parse(localStorage.getItem(k) || 'null');
      if (!d) continue;
      // 录音页那份、「记一条」录到一半的那份：不用回去接着写，启动时 recover() 会把字和录音存进条目
      if (k === REC_DRAFT || (k === NEW_DRAFT && d.rec)) continue;
      const id = k.slice(EDIT_PREFIX.length), go = id === 'new' ? '#/new' : '#/edit/' + encodeURIComponent(id);
      if (id !== 'new' && tombOf(id)) return go;
      if (!fresh && Date.now() - (Number(d.at) || 0) < 86400000) fresh = go;
    }
  } catch (e) { /* 读不到就算了 */ }
  return fresh;
}
/** 夜间时段打开（冷启动，或在后台放了很久再回来）而且停在列表 → 直接进录音页 */
function nightRedirect() {
  const st = S().settings;
  if (!st.nightOpensRecorder || !isNight(new Date(), st) || !HOME(route())) return false;
  history.replaceState(history.state, '', '#/rec');
  return true;
}

// ---------- ctx ----------
const ctx = {
  get state() { return S(); },
  get local() { return L(); },
  get editVersion() { return state.editVersion(); },
  saveOk: state.saveOk,
  storageIssue: state.storageIssue,
  recoveryExport: state.recoveryExport,
  recoveryArchive: state.recoveryArchive,
  async recoveryCloud() {
    // 只读云端：损坏期间正常同步被暂停，不能让空白或残缺数据上传。
    const reader = createSync({ getConfig: () => L().sync, getState: S, applyRemote() {}, saveConfig() {}, editVersion: () => 0 });
    const file = await reader.fileAt();
    if (!file?.state || file.state.v !== 1) throw Object.assign(new Error('no-cloud'), { code: 'no-cloud' });
    return file.state;
  },
  async repairData(next) { await state.recoverFrom(next); },
  retryData() { state.reload(); },
  get route() { return route(); },
  entries,
  entry: (id) => { const e = id && S().data.entries[id]; return e && !isTombstone(e) ? e : null; },
  tombstone: tombOf,
  mutate: (fn, opts) => state.mutate(fn, opts),
  put(e, opts) {
    const id = e.id || newId('e_');
    if (tombOf(id)) return null;                 // 永久删除了：不能再写进去（state.js 的 diff 也会挡）
    state.mutate(s => { const prev = s.data.entries[id]; s.data.entries[id] = normalizeEntry(stamp({ ...e, id }, prev), id); }, opts);
    return S().data.entries[id];
  },
  update(id, patch, opts) {
    const prev = ctx.entry(id);
    return prev ? ctx.put({ ...prev, ...patch, id }, opts) : null;
  },
  goneShas: goneNow,
  removedClips: () => removedClips(S()),
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
  async purge(list) { await freshFirst(); return purger.purgeEntries(list); },
  async purgeClips(list) { await freshFirst(); return purger.purgeClips(list); },
  async purgeAll(lists) { await freshFirst(); return purger.purgeAll(lists); },
  purgeOrphans: (list) => purger.purgeOrphans(list),
  restoreClip: (id, sha) => purger.restoreClip(id, sha),
  localOrphans: () => purger.localOrphans(),
  trashInfo: (key) => purger.trashInfo(key),

  navigate, back, replaceHash, home, refresh: () => refresh(), layout,
  setListMode(mode) {
    state.setLocal({ listMode: mode === 'cal' ? 'cal' : 'list' });
    if (HOME(route())) navigate(home(), { replace: true });
    else render();                                // 双栏看着条目：只换左栏，右栏不动（编辑中的不丢）
  },
  guard: () => {},              // 每个页面拿到的是自己的版本（见 viewCtx）
  t, lang: getLang,
  setLang(l) { state.setLocal({ lang: l }); setLang(l); refresh(); },
  setTheme(th) { state.setLocal({ theme: th }); applyTheme(); },
  theme: () => document.documentElement.dataset.theme || 'light',
  toast, sheet, confirm: confirmDialog,
  syncBadge: () => syncBadge(),
  on, onChange: (fn) => on('change', fn),

  audio,
  clipBlob: async (sha, mime) => {
    if (goneNow().has(sha)) return null;         // 永久删除了：本机还没清掉（等云端确认）也不给
    const rec = await audio.getClip(sha).catch(() => null);
    if (rec && rec.blob) return rec.blob;
    return L().sync ? (await syncer.getAudio(sha, mime).catch(() => null)) || null : null;
  },
  recovered: null,
  bootAt: BOOT,
  takeFiles: () => { const f = droppedFiles; droppedFiles = null; return f; },
  night: nightStore,
  nightRecovered: null,
  get build() { return window.__babbleBuild || null; },

  sync: syncApi,
  history: {
    list: async (id) => {                       // 等刚排队的旧版本写完再读（最多等 3 秒）
      await Promise.race([journal.idle(), new Promise(r => setTimeout(r, 3000))]);
      return journal.list(id);
    },
    cloud: createCloudHistory({ commits: (o) => syncer.commits(o), fileAt: (sha) => syncer.fileAt(sha) }),
  },
  get device() { return state.deviceName(); },
  isNight: () => isNight(new Date(), S().settings),
};

// ---------- 永久删除：本机清理、30 天到期、清理云端历史以后（数据和合并规则在 core/store.js，做法在 core/purge.js） ----------
// 录音只在「确实没了」时删：开着同步要云端确认过（confirmedGone），没开同步要墓碑已经存进本机。什么时候清理：
//   数据变了（本机、撤销、导入、别的标签页、同步合并）而「没了的录音」变了，或者有条目刚被永久删除 → sweepSoon；
//   每一轮同步做完，云端确认的变了 → sweepSoon；这次打开后第一次确认过云端 → 整个清理一遍（full）；
//   启动时（找回录音、床头模式收尾之后）没开同步 → 整个清理一遍。别的设备来的墓碑照样清理（开关关着也是）。
// 30 天到期：启动时、每一轮同步以后（成没成功都算）、开着的时候每小时，本机数据有问题时不做（开关关着时都不做）。
//   从这台设备第一次看到算（babble.trash，启动时、数据变了 1 秒后记下），也不早于 trashSince：开放以后第一次打开时已经在「最近删除」里的，从那一刻起算满 30 天。
//   trashSince 不晚于服务器的时间（syncer.serverNow：这次打开提交过以后才知道；时钟快的设备写下的，知道以后挪回去）。
const purger = createPurger({
  getState: S, mutate: (fn, opts) => state.mutate(fn, opts), audio, night: nightStore, journal,
  saveOk: state.saveOk, syncOn: () => !!L().sync, storageOk: () => !state.storageIssue(),
  confirmedGone: () => syncer.confirmedGone(),
  storage: () => globalThis.localStorage, forgetPlayer: forgetClip, scrubText: (ids) => state.scrubText(ids),
  cloudHistory: ctx.history.cloud, getLocal: L, setLocal: state.setLocal, gone: goneNow,
});
let goneSeen = shaSig(goneNow()), confirmedSeen = null, cloudResetSeen = S().settings.cloudResetAt || null;
let firstConfirmed = true, squashing = false;
const noteTrashSoon = debounce(() => purger.noteTrash(), 1000);
const SQUASH_GRACE = 2 * 60e3;       // 别的标签页正在清理：记号刚写下的先不补（强制更新、核对要几个来回）

/** 开着同步时永久删除前先同步一次（最多等 10 秒）：别的设备刚改过、恢复了的按新的那版判断，变了就不删 */
async function freshFirst() {
  if (purger.enabled && L().sync && !state.storageIssue()) await Promise.race([syncApi.now(), sleep(10000)]).catch(() => {});
}
/** 数据变了：「没了的录音」变了或者有条目刚被永久删除 → 清理本机；清理过云端历史（cloudResetAt 变了）→ 云端历史的缓存重来；记下「最近删除」第一次看到的时刻 */
function purgeWatch(info) {
  const sig = shaSig(goneNow());
  if ((info.purged && info.purged.length) || sig !== goneSeen) { goneSeen = sig; purger.sweepSoon(); }
  const cr = S().settings.cloudResetAt || null;
  if (cr !== cloudResetSeen) { cloudResetSeen = cr; try { ctx.history.cloud.reset(); } catch (e) { console.warn('cloud history', e); } }
  if (purger.enabled) noteTrashSoon();
}
/** 每一轮同步做完：补写清理云端历史的记号；第一次确认过云端 → 整个清理一遍，云端确认的变了 → 清理；
 *  成功的话：还没有 trashSince → 写下（这时才知道云端有没有别的设备写过；开关关着不写），比服务器的时间还晚（写的设备时钟快了）→ 改早；
 *  报到；第一次打开新版、还没说过 30 天的规矩 → 说一声（这时才知道日期）。到期的自动永久删除（同步成没成功都做） */
function afterRound(r) {
  try {
    if (state.storageIssue()) return;
    replaySquash();
    const C = syncer.confirmedGone();
    if (C && firstConfirmed) { firstConfirmed = false; confirmedSeen = shaSig(C); purger.sweep({ full: true }); }
    else if (C && shaSig(C) !== confirmedSeen) { confirmedSeen = shaSig(C); purger.sweepSoon(); }
    if (r && r.ok && !r.skipped) {
      purger.ensureTrashSince(syncer.serverNow());
      registerDevice();
    }
    purger.autoPurge();
    if (r && r.ok && !r.skipped) policyNote();
  } catch (e) { console.warn('purge', e); }
}
/** 启动（和修好数据以后）：等找回录音、床头模式收尾做完再动 babble-audio / babble-night。没开同步 → 写 trashSince、整个清理一遍；
 *  开着同步 → 等第一次确认过云端的那一轮（afterRound）。到期的照样删 */
function bootPurge() {
  Promise.all([ctx.recovered, ctx.nightRecovered].map(p => Promise.resolve(p).catch(() => {}))).then(() => {
    if (state.storageIssue()) return;
    replaySquash();
    if (!L().sync) { purger.ensureTrashSince(); purger.sweep({ full: true }); }
    purger.autoPurge();
    policyNote();
  }).catch(e => console.warn('purge', e));
}
/** 开放永久删除以后第一次打开（每台设备一次，babble.local.purgeNoticeAt）：「最近删除」里有东西就说一声 30 天的规矩。
 *  按每一项写着的日期（trashInfo）说：最早的那项还有满 30 天 →「从今天开始算 30 天」（第一台打开新版的设备）；
 *  不到 30 天（别的设备先开放了，从那时起算；之后才删的照样各算各的）→「最早 {date} 永久删除」。
 *  还不知道日期（开着同步、开放以后还没同步成功过）→ 先不说，同步成功以后再说（afterRound）。
 *  正好有别的提示条（找回的录音之类，可能带按钮）→ 等它收起再说（最多等半分钟），不盖掉它 */
let noteWait = 0;
function policyNote() {
  if (!purger.enabled || L().purgeNoticeAt || state.storageIssue()) return;
  const ids = new Set(deleted.deletedEntries(S()).map(e => e.id));     // 录音页丢掉的空条目「最近删除」里不列
  const keys = [...trashKeys(S())].filter(([k, v]) => v.kind !== 'entry' || ids.has(v.id)).map(([k]) => k);
  if (!keys.length) { state.setLocal({ purgeNoticeAt: Date.now() }); return; }
  const at = keys.map(k => purger.trashInfo(k).shownAt).filter(x => x > 0);
  if (!at.length) return;
  const el = $('#toast');
  if (el && el.classList.contains('on') && noteWait < 10) { noteWait++; setTimeout(policyNote, 3000); return; }
  state.setLocal({ purgeNoticeAt: Date.now() });
  const first = Math.min(...at), p = localParts(first);
  const msg = deleted.daysLeft(first) >= 30 || !p ? t('deleted.policyNote') : t('deleted.policyNoteAt', { date: fmtDate(p.date, getLang(), { year: false }) });
  toast(msg, { ms: 10000 });
}
/** 清理云端历史成功（或强制更新以后核对没通过：可能已经换了）：写同步的 cloudResetAt，别的设备看到就把录音和仓库对一遍；
 *  这台设备的云端历史缓存由 purgeWatch 看到 cloudResetAt 变了重来 */
function markCloudReset() {
  try { ctx.setSetting('cloudResetAt', Date.now()); } catch (e) { console.warn('cloudResetAt', e); return; }   // 存不了（数据有问题）：记号留着，下次再补
  state.setLocal({ squashMark: null });
}
/** 上次清理到一半（强制更新前记下了 squashMark）就被关掉：补写 cloudResetAt（启动时、每一轮同步以后；这一页正在清理时不补） */
function replaySquash() {
  const m = L().squashMark;
  if (m && !squashing && !state.storageIssue() && !(Date.now() - (Number(m.at) || 0) < SQUASH_GRACE)) markCloudReset();
}

// ---------- 报到：这台设备已经是这一版（「设置 → 同步」列出更新了的设备和还没报到的；两步上线时靠它看每台设备是不是都更新了） ----------
// 记在同步的数据里（data.devices，按这台设备的 id；旧版本 App 会原样保留不认识的集合），每轮同步成功后：名字、谁在用、版本变了，
// 或者上次报到超过 3 天才写（每次写都要再推一次）。设备 id 存在 babble.local.deviceId（设备名可以改、两台可以同名，id 不变）
function registerDevice() {
  if (state.storageIssue() || !L().sync) return;
  if (!L().deviceId) state.setLocal({ deviceId: newId('d_') });
  const id = L().deviceId, D = S().data.devices, prev = D && typeof D === 'object' ? D[id] : null;
  const rec = deviceSeen(prev, { id, name: state.deviceName(), who: L().who, build: ctx.build });
  if (rec) state.mutate(s => { if (!s.data.devices || typeof s.data.devices !== 'object') s.data.devices = {}; s.data.devices[id] = rec; });
}

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
  const cur = HOME(r) || r.name === 'entry' || r.name === 'editor' || r.name === 'night' ? 'list' : r.name === 'import' || r.name === 'deleted' || r.name === 'diag' ? 'settings' : r.name;
  const side = r.name === 'import' ? 'import' : cur;          // 侧栏有「导入录音」这一项；手机底栏没有，算在设置下面
  const item = (id, href, ic, label) => h('a.nav-item' + (side === id ? '.on' : ''), { href, 'aria-current': side === id ? 'page' : null }, ic, h('span', null, label));
  $('#side').replaceChildren(
    h('div.brand', null, h('img', { src: 'icons/icon-180-v4.png', alt: '', width: 32, height: 32, onerror: e => { e.target.style.visibility = 'hidden'; } }), h('b', null, t('common.appName'))),
    h('nav', { 'aria-label': t('nav.label') },
      item('list', '#' + home(), icon('bubble'), t('nav.list')),
      item('record', '#/rec', icon('snout'), t('nav.rec')),
      item('import', '#/import', icon('import'), t('nav.import'))),
    h('div.side-foot', null,
      h('nav', { 'aria-label': t('nav.settings') },
        item('settings', '#/settings', icon('gear'), t('nav.settings'))),
      syncBadge()),
  );
  const tabs = $('#tabs');
  tabs.setAttribute('aria-label', t('nav.label'));
  tabs.replaceChildren(
    h('a.tab' + (cur === 'list' ? '.on' : ''), { href: '#' + home(), 'aria-current': cur === 'list' ? 'page' : null }, icon('bubble'), h('span', null, t('nav.list'))),
    h('a.tab-rec', { href: '#/rec', 'aria-label': t('nav.rec'), title: t('nav.rec') }, icon('snout')),
    h('a.tab' + (cur === 'settings' ? '.on' : ''), { href: '#/settings', 'aria-current': cur === 'settings' ? 'page' : null }, icon('gear'), h('span', null, t('nav.settings'))),
  );
}

// ---------- 页面挂载 ----------
const mounted = {};           // slot → { slot, name, key, params, el, handle, offs, guard, guardMsg }
const scroller = (el) => (layout() === 'phone' ? document.scrollingElement : el);
function scrollTop() {
  if (layout() === 'phone') return window.scrollY;
  const m = mounted.main || mounted.detail; return m ? m.el.scrollTop : 0;
}

function viewCtx(m) {
  const c = Object.create(ctx);
  c.on = (ev, fn) => { const off = on(ev, fn); m.offs.push(off); return off; };
  c.onChange = (fn) => c.on('change', fn);
  c.guard = (fn, msg) => { m.guard = typeof fn === 'function' ? fn : null; m.guardMsg = (m.guard && msg) || null; };
  c.params = m.params;
  return c;
}
function runView(m) {
  m.offs = []; m.guard = m.guardMsg = null; m.handle = null;
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
  m.offs = []; m.guard = m.guardMsg = null;
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
  const m = { slot: p.slot, name: p.name, key, params: p.params, el, handle: null, offs: [], guard: null, guardMsg: null };
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

let recoveryRoot = null;
function recoveryScreen() {
  if (state.storageIssue()) {
    syncSoon.cancel();
    if (!recoveryRoot) {
      recoveryRoot = h('section.recovery-screen', { tabindex: -1, role: 'region', 'aria-label': t('recovery.title') });
      document.body.append(recoveryRoot);
      recoveryPanel(recoveryRoot, ctx);
      $('.app')?.setAttribute('inert', '');
      $('#tabs')?.setAttribute('inert', '');
      recoveryRoot.focus();
    }
    return true;
  }
  if (recoveryRoot) { recoveryRoot.remove(); recoveryRoot = null; $('.app')?.removeAttribute('inert'); $('#tabs')?.removeAttribute('inert'); }
  return false;
}
function resumeAfterRecovery() {
  ctx.recovered = recover();
  ctx.nightRecovered = bootNight();
  bootPurge();
  render();
}
function render() {
  delete document.documentElement.dataset.boot;      // src/boot.js 第一次绘制前刷的近黑底，app 画出来以后就不用了
  if (recoveryScreen()) return;
  const r = route();
  if (HOME(r) && listMode() !== (r.name === 'calendar' ? 'cal' : 'list')) state.setLocal({ listMode: r.name === 'calendar' ? 'cal' : 'list' });   // 记下「列表 | 日历」
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
  if (askWhoPending) setTimeout(askWhoSoon, 0);
  if (changedMain && !document.querySelector('dialog[open]')) {
    const focusTo = mounted.detail || mounted.main;
    if (focusTo && !focusTo.el.contains(document.activeElement)) { focusTo.el.tabIndex = -1; focusTo.el.focus({ preventScroll: true }); }   // 换页后读屏、键盘从新页面开始
  }
}
function refresh() {
  if (state.storageIssue()) { render(); return; }
  for (const slot of Object.keys(mounted)) unmount(slot);
  render();
}

// 第一次在这台设备上改梦话：问一次是谁在用（修改记录里显示）。录音页、编辑页（「录一段」接上录音时正在打字）不打扰，
// 有面板开着也等一等，离开后再问
function askWhoSoon() {
  if (!shouldAskWho(L())) { askWhoPending = false; return; }
  const busy = () => route().name === 'record' || route().name === 'editor' || !!document.querySelector('dialog[open]');
  if (busy()) { askWhoPending = true; return; }
  askWhoPending = false;
  setTimeout(() => { if (!shouldAskWho(L())) return; if (busy()) askWhoPending = true; else askWho(ctx); }, 900);
}

// 数据变化 → 提示撤销 / 存储满 → 安排同步 → 页面更新
let rerenderQueued = false;
state.subscribe((st, info) => {
  cache = null; goneCache = null;
  const wasBlocked = !!recoveryRoot;
  if (recoveryScreen()) return;
  if (wasBlocked) resumeAfterRecovery();        // 本页或别的标签页修好数据后，都重新挂载页面并找回待处理录音
  if (info.source === 'local' && info.ids && info.ids.some(id => S().data.entries[id])) askWhoSoon();   // 改的是梦话才问（设备报到不算）
  if (info.saved === false) toast(t('common.storageFull'), { ms: 10000 });
  else if (info.undoLabel) toast(info.undoLabel, { ms: 10000, action: { label: t('common.undo'), run: () => ctx.undo() } });
  else if (info.unpurged && info.unpurged.length) toast(t('deleted.unpurged', { n: info.unpurged.length }), { ms: 10000 });   // 永久删除的时候别的设备上正好改过 / 恢复了：又回来了（哪台设备删的都这么说）
  if (info.source === 'local' || info.source === 'undo' || info.source === 'merge' || (info.source === 'storage' && info.changed)) syncSoon();
  purgeWatch(info);
  emit('change', info);
  applyTheme();                                // 夜间设置可能变了；主题只换颜色，不用重画
  if (rerenderQueued) return;
  rerenderQueued = true;
  queueMicrotask(() => {
    rerenderQueued = false;
    if (recoveryScreen()) return;
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
// 条目建好、真的存进本机以后才清恢复记录（clearRec）；存不下、出错就留着，下次启动再交回来。
// 边录边写的字（录音页那份草稿、「记一条」录到一半的草稿，见 core/drafts.js）和找回的录音放进同一条
const clearRecs = (list) => { for (const c of list) if (c.recId) Promise.resolve(audio.clearRec(c.recId)).catch(() => {}); };
/** 草稿要在第一个 await 之前拿：页面马上就画出来了，录音页、编辑页之后会接着写同一个键 */
function takeDrafts() {
  const one = (key) => { try { const raw = localStorage.getItem(key); return raw ? { key, raw, d: readDraft(localStorage, key) } : null; } catch (e) { return null; } };
  return { rec: one(REC_DRAFT), fresh: one(NEW_DRAFT) };
}
/** 草稿还是启动时那份（页面没有接着写）才删掉 / 换掉 */
function settleDraft(snap, next) {
  try {
    if (!snap || localStorage.getItem(snap.key) !== snap.raw) return;
    if (next) writeDraft(localStorage, snap.key, next); else localStorage.removeItem(snap.key);
  } catch (e) { /* 存不了就算了：下次启动再处理 */ }
}
async function recover() {
  if (state.storageIssue()) return [];
  const snap = takeDrafts();
  let clips = [];
  try { clips = (await recoverPending({ audioStore: audio, before: BOOT })) || []; }
  catch (e) { toast(t('common.recoverFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); return []; }
  // 永久删除了的录音不再拼回来、不再建一条：恢复记录直接清掉。有过永久删除记号、又不在哪条的 audio 里的也一样（剩下的分片不算新录音）
  const known = clipIndex(S(), { includeDeleted: true }), gone = goneNow(), stubs = stubShas(S());
  const all = clips.filter(c => c && c.sha256), dead = all.filter(c => gone.has(c.sha256) || (stubs.has(c.sha256) && !known.has(c.sha256)));
  const valid = all.filter(c => !dead.includes(c));
  clearRecs(dead);
  const drafts = { rec: snap.rec && snap.rec.d, fresh: snap.fresh && snap.fresh.d && snap.fresh.d.rec ? snap.fresh.d : null };
  if (!drafts.rec && !drafts.fresh && valid.every(c => known.has(c.sha256))) { clearRecs(valid); if (snap.rec) settleDraft(snap.rec, null); return []; }   // 已经在某条里的不再建
  let saved = true, res = null;
  const off = state.subscribe((st, info) => { if (info.saved === false) saved = false; });
  try { res = state.mutate(s => applyRecovery(s, valid, drafts)); }
  catch (e) { saved = false; console.error(e); toast(t('common.recoverFail', { msg: (e && e.message) || String(e) }), { ms: 8000 }); }
  off();
  if (!saved || !res) return res ? res.ids : [];          // 存不下已经提示过「空间满」：录音、草稿都留着，下次再来
  clearRecs(valid);
  // 旧原话改过的那段字：先放进那条的编辑页草稿（存不下就留着录音页那份，下次再来），再删录音页那份
  const stashed = !res.stash || stashPurgedText(localStorage, res.stash.id, res.stash.text);
  if (res.dropRec && stashed) settleDraft(snap.rec, null);
  if (res.dropFresh) settleDraft(snap.fresh, null); else if (res.fresh) settleDraft(snap.fresh, res.fresh);
  // 录音页要写进的那条已经永久删除了：只有新写的字（和录音）存成了新的一条，说一声
  const msg = [res.clips ? t('common.recovered', { n: res.clips }) : res.texts ? t('rec.recoveredText') : null,
    res.purgedText ? t(res.stash ? 'rec.targetPurgedKept' : 'rec.targetPurged') : null].filter(Boolean).join('\n');
  if (msg) toast(msg, { ms: res.purgedText ? 10000 : 8000, action: res.stash && stashed ? { label: t('rec.openEdit'), run: () => navigate('/edit/' + encodeURIComponent(res.stash.id)) } : null });
  return res.ids;
}

// ---------- 启动时给上次的床头模式收尾 ----------
// App 被杀掉时还开着的那次标成「断了」（记下最后一次心跳、没收尾的片段剪好），然后按期限清理旧片段；都在本机 babble-night 里，
// 不进条目、不同步。出错就留着，下次启动再来（床头页、昨夜页照样能打开）
const bootNight = () => recoverNights({ store: nightStore, before: BOOT }).then(() => purgeNights(nightStore)).catch(e => console.warn('night', e));

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
    if (L().sync && L().sync.dirty && !held()) { syncSoon.cancel(); autoSync(); }      // 切走前把改动传上去（暂停着就不传）
  }
});
window.addEventListener('online', () => autoSync());
window.addEventListener('storage', e => { if (e.key === state.KEY || e.key === state.LKEY || e.key?.startsWith(state.PENDING_PREFIX)) state.reload(); });   // 别的标签页改了数据
setInterval(() => { if (document.visibilityState === 'visible') { syncIfStale(); applyTheme(); } }, 60000);
setInterval(() => { if (document.visibilityState === 'visible' && !state.storageIssue()) purger.autoPurge(); }, 3600000);   // 开着过夜：到期的照样删
prefersDark.addEventListener('change', () => applyTheme());
for (const mq of [mqSide, mqTwo]) mq.addEventListener('change', () => { render(); emit('layout', layout()); });

// ---------- 启动 ----------
setLang(L().lang && LANGS.includes(L().lang) ? L().lang : guessLang());
// 冷启动：上次写到一半被系统关掉的编辑页优先（停在列表时直接回去接着写），否则按夜间设置
const resumeEdit = pendingEdit();
if (resumeEdit && HOME(route())) history.replaceState(history.state, '', resumeEdit);
else if (!nightRedirect() && route().name === 'list' && !route().path.length && listMode() === 'cal') history.replaceState(history.state, '', '#/cal');   // 上次用的是日历

currentHash = location.hash || '#/';
track(currentHash);
ctx.recovered = state.storageIssue() ? Promise.resolve([]) : recover();
ctx.nightRecovered = state.storageIssue() ? Promise.resolve() : bootNight();      // 数据有问题时不碰 babble-night（修好以后 resumeAfterRecovery 再做）
if (!state.storageIssue()) bootPurge();
render();
autoSync();
window.__babble = { state, ctx, mounted, get S() { return S(); } };   // 方便在浏览器控制台里查看
