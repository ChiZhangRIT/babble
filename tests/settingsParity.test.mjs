// 和 PickNest（还有房屋账本、虚拟书架）一致的几处：
//   设置最上面「语言 / Language」那一行的标题跟着界面语言（自己的语言在前）；
//   「关于」写版本号（src/start.js 的 BUILD），新版本在后台装好、等着关掉再打开时说一声（core/update.js：只看 registration.waiting，第一次安装不说）；
//   确认框：会删东西的（danger）焦点先在「取消」，那句话用 aria-describedby / aria-labelledby 连上；
//   令牌快到期（不到 14 个日历日，或者已经过期）：侧栏小标签和设置里「同步」那一行变黄「令牌快到期」，真出了错还是红的。
// 都是编的数据，不碰真的 Service Worker、不访问 GitHub。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render as renderSettings, syncState, tokenNote } from '../src/views/settings.js';
import { createUpdateCheck, UPDATE_EVERY } from '../src/core/update.js';
import { syncPhase, tokenDaysLeft, tokenWarn, tokenExpired, TOKEN_WARN_DAYS } from '../src/core/sync.js';
import { memoryStore } from '../src/core/audioStore.js';
import * as state from '../src/core/state.js';
import { makeEntry } from '../src/core/store.js';
import { setLang, t } from '../src/i18n.js';
import { confirmDialog } from '../src/ui/dom.js';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
Element.prototype.scrollIntoView = function () {};
// 最小 DOM 里没有 <dialog> 的这几样：确认框要用
Element.prototype.showModal = function () { this.open = true; };
Element.prototype.close = function () { this.open = false; this.fire('close'); };

/** 本地时间某天 hh:mm 的毫秒（月份从 1 开始）。自己填的到期日存的就是那天 23:59 */
const at = (y, m, d, hh = 23, mm = 59) => new Date(y, m - 1, d, hh, mm).getTime();

/** 设置首页：ctx 只给页面用到的那些；ctx.on 记下订阅（'update' 要手动触发） */
function mainSetup({ lang = 'zh-Hans', st = { on: false }, build = 'babble-v31', ready = false } = {}) {
  const d = installDom({ localStorage: fakeStorage(), matchMedia: () => ({ matches: false, addEventListener() {} }) });
  setLang(lang);
  state.load({ storage: fakeStorage(), locks: null });
  state.setLocal({ device: 'iPhone', who: 'me', whoAsked: true });
  state.mutate(s => { s.data.entries.a = makeEntry({ id: 'a', date: '2026-11-04', text: '编的' }); });
  const subs = {}, env = { ready };
  const audio = memoryStore();
  const ctx = {
    t, lang: () => lang, layout: () => 'phone', build, device: 'iPhone', bootAt: Date.now() - 1000,
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    entry: () => null, tombstone: () => null, removedClips: () => [], storageIssue: () => null, isNight: () => false,
    audio: Object.assign(audio, { estimate: async () => ({ usage: 1000, quota: 1e9 }), persisted: async () => true, persist: async () => true }),
    localOrphans: async () => [], toast: () => ({ close() {} }), confirm: async () => true, navigate() {}, back() {}, guard() {},
    sync: { status: () => ({ running: false, pendingUp: 0, pendingDown: 0, pendingPurge: 0, oldDevices: [], ...st }) },
    setLang() {}, setTheme() {}, setSetting() {},
    updateReady: () => env.ready,
    on: (ev, fn) => { (subs[ev] ||= []).push(fn); return () => {}; },
  };
  const main = new Element('main');
  const handle = renderSettings(main, { name: 'settings', sub: null, query: {} }, ctx, { purgeEnabled: true });
  return { main, env, emit: (ev) => (subs[ev] || []).forEach(fn => fn()), close: () => { handle.cleanup(); d.restore(); } };
}

// ---------- 语言那一行 ----------
test('设置最上面的「语言」那一行：没有小标题，标题跟着界面语言（简体「语言 / Language」、繁体「語言 / Language」、英文「Language / 语言」），还是下拉框', async () => {
  const want = { 'zh-Hans': '语言 / Language', 'zh-Hant-TW': '語言 / Language', en: 'Language / 语言' };
  for (const lang of Object.keys(want)) {
    const s = mainSetup({ lang });
    try {
      await settle();
      const sec = find(s.main, el => el.id === 'set-lang');
      assert.ok(sec, lang);
      assert.equal(find(s.main, el => el.tag === 'section'), sec, '第一节');
      assert.equal(find(sec, el => el.tag === 'h2'), undefined, '没有小标题');
      const label = byCls(sec, 'set-label'), select = find(sec, el => el.tag === 'select');
      assert.equal(label.textContent, want[lang]);
      assert.equal(select.attrs['aria-label'], want[lang]);
      assert.equal(byCls(sec, 'set-row').tag, 'label', '整行是 <label>');
      assert.deepEqual(all(select, el => el.tag === 'option').filter(o => o.selected).map(o => o.value), [lang]);
    } finally { s.close(); }
  }
});

// ---------- 关于：版本、新版本 ----------
test('「关于」写「版本 babble-v31」（三种语言）；新版本下载好了才显示「关掉牙牙呓语再打开就是新版」，下载好的那一刻（ctx.on update）不重画也显示出来', async () => {
  const words = { 'zh-Hans': ['版本 babble-v31', '新版本已经下载好了：关掉牙牙呓语再打开就是新版。'],
    'zh-Hant-TW': ['版本 babble-v31', '新版本已經下載好了：關掉牙牙囈語再開啟就是新版。'],
    en: ['Version babble-v31', 'A new version has been downloaded. Close Babble and open it again to use it.'] };
  for (const [lang, [version, ready]] of Object.entries(words)) {
    const s = mainSetup({ lang });
    try {
      await settle();
      const about = find(s.main, el => el.id === 'set-about');
      assert.equal(byCls(about, 'set-version').textContent, version);
      const line = byCls(about, 'set-update');
      assert.equal(line.textContent, ready);
      assert.equal(line.attrs.role, 'status');
      assert.equal(line.hidden, true, '还没有新版本：不显示');
      s.env.ready = true; s.emit('update');
      assert.equal(byCls(find(s.main, el => el.id === 'set-about'), 'set-update'), line, '同一个元素（读屏念得出来）');
      assert.equal(line.hidden, false);
    } finally { s.close(); }
  }
  const s = mainSetup({ ready: true, build: null });
  try {
    await settle();
    assert.equal(byCls(s.main, 'set-update').hidden, false, '打开设置时已经下载好了');
    assert.equal(byCls(s.main, 'set-version'), undefined, '不知道是哪一版（开发时）就不写');
  } finally { s.close(); }
});

/** 假的 navigator.serviceWorker：registration 能 update()、能发 updatefound，installing 能 statechange */
function fakeSW({ controller = true, waiting = null } = {}) {
  const ev = {}, reg = { waiting, installing: null, updates: 0,
    addEventListener: (k, fn) => { (ev[k] ||= []).push(fn); },
    update() { this.updates++; return Promise.resolve(this); } };
  const sw = { controller: controller ? {} : null, gets: 0, getRegistration() { this.gets++; return Promise.resolve(reg); } };
  /** 后台装新版：先 installing，校验完 installed → waiting */
  const install = () => {
    const wev = {}, w = { state: 'installing', addEventListener: (k, fn) => { (wev[k] ||= []).push(fn); } };
    reg.installing = w; (ev.updatefound || []).forEach(fn => fn());
    return { installed() { w.state = 'installed'; reg.installing = null; reg.waiting = w; (wev.statechange || []).forEach(fn => fn()); },
      failed() { w.state = 'redundant'; reg.installing = null; (wev.statechange || []).forEach(fn => fn()); } };
  };
  return { sw, reg, install };
}

test('检查新版本：启动时看一次，之后切回前台最多半小时一次；装好（waiting）才算下载好了，只通知一次；校验没过（redundant）不算', async () => {
  let now = 1_000_000, readies = 0;
  const { sw, reg, install } = fakeSW();
  const u = createUpdateCheck({ sw, now: () => now, onReady: () => readies++ });
  assert.equal(await u.check(), false);
  assert.equal(reg.updates, 1, '启动时 update() 一次');
  now += 5 * 60 * 1000;
  await u.check();
  assert.equal(reg.updates, 1, '5 分钟后切回来：不再看');
  now += UPDATE_EVERY;
  await u.check();
  assert.equal(reg.updates, 2, '过了半小时：再看一次');
  const bad = install(); bad.failed();
  assert.equal(u.ready(), false, '缺文件、校验不符：旧版照常用，不提示');
  const good = install();
  assert.equal(u.ready(), false, '还在下载、校验');
  good.installed();
  assert.equal(u.ready(), true);
  assert.equal(readies, 1);
  install().installed();
  assert.equal(readies, 1, '只通知一次');
  now += UPDATE_EVERY;
  assert.equal(await u.check(), true);
  assert.equal(reg.updates, 2, '下载好了就不用再看');
});

test('检查新版本：打开时浏览器已经装好的（waiting）马上算；第一次安装（还没有 controller）、本地预览（没有 Service Worker）不提示；离线时 update() 出错不要紧', async () => {
  let readies = 0;
  const a = fakeSW({ waiting: { state: 'installed' } });
  const ua = createUpdateCheck({ sw: a.sw, onReady: () => readies++ });
  assert.equal(await ua.check(), true);
  assert.equal(readies, 1);
  assert.equal(a.reg.updates, 0, '已经有了就不用再去网上看');

  const b = fakeSW({ controller: false, waiting: { state: 'installed' } });
  const ub = createUpdateCheck({ sw: b.sw, onReady: () => readies++ });
  assert.equal(await ub.check(), false);
  assert.equal(b.sw.gets, 0, '第一次安装：还没受控制，不看');

  const uc = createUpdateCheck({ sw: undefined, onReady: () => readies++ });
  assert.equal(await uc.check(), false);

  const d = fakeSW();
  d.reg.update = () => Promise.reject(new TypeError('Failed to fetch'));
  const ud = createUpdateCheck({ sw: d.sw, onReady: () => readies++ });
  assert.equal(await ud.check(), false);
  assert.equal(readies, 1);
});

test('检查新版本：App 载入时浏览器自己（冷启动的导航）已经在装新版、updatefound 早就过去了，也等得到它装好；没收到事件的，下次切回来再对一下 waiting 也补得上', async () => {
  let now = 1_000_000, readies = 0;
  const a = fakeSW();
  const pending = a.install();                    // 还没人在听 updatefound 就开始装了
  const ua = createUpdateCheck({ sw: a.sw, now: () => now, onReady: () => readies++ });
  assert.equal(await ua.check(), false, '还在装');
  pending.installed();
  assert.equal(ua.ready(), true, '装好了');
  assert.equal(readies, 1);

  const b = fakeSW();
  const ub = createUpdateCheck({ sw: b.sw, now: () => now, onReady: () => readies++ });
  assert.equal(await ub.check(), false);
  b.reg.waiting = { state: 'installed' };         // 装好了，可是这一页没收到事件（比如别的窗口里开始装的）
  assert.equal(ub.ready(), false);
  now += UPDATE_EVERY;
  assert.equal(await ub.check(), true, '半小时后切回来：对一下 waiting 就知道了');
  assert.equal(readies, 2);
});

// ---------- 确认框 ----------
test('确认框：会删东西的（danger）焦点先在「取消」上，那句话连着 aria-labelledby（没有标题）/ aria-describedby（有标题）；不会删东西的焦点还在确认按钮上', async () => {
  const d = installDom();
  setLang('zh-Hans');
  try {
    const dlg = () => find(d.doc.body, el => el.tag === 'dialog');
    const btns = () => all(dlg(), el => el.tag === 'button' && cls(el, 'btn'));
    // 只有一句话，会删东西
    let p = confirmDialog({ message: '永久删除这条编的梦话？', confirmLabel: t('common.purge'), danger: true });
    let [cancel, ok] = btns();
    assert.equal(cancel.textContent, t('common.cancel'));
    assert.ok(cls(ok, 'danger-fill'));
    assert.equal(d.doc.activeElement, cancel, '焦点在「取消」');
    const msg = byCls(dlg(), 'confirm-msg');
    assert.ok(msg.id);
    assert.equal(dlg().attrs['aria-labelledby'], msg.id);
    assert.equal(dlg().attrs['aria-label'], undefined);
    await cancel.fire('click');
    assert.equal(await p, false);
    assert.equal(dlg(), undefined, '关掉了');
    // 有标题，会删东西
    p = confirmDialog({ title: '清理云端历史？', message: '编的说明', confirmLabel: '清理', danger: true });
    [cancel, ok] = btns();
    assert.equal(d.doc.activeElement, cancel);
    assert.equal(dlg().attrs['aria-label'], '清理云端历史？');
    assert.equal(dlg().attrs['aria-describedby'], byCls(dlg(), 'confirm-msg').id);
    assert.notEqual(byCls(dlg(), 'confirm-msg').id, msg.id, '每个确认框的 id 不一样');
    await ok.fire('click');
    assert.equal(await p, true);
    // 不会删东西
    p = confirmDialog({ title: '从备份恢复？', message: '编的说明', confirmLabel: '恢复' });
    [cancel, ok] = btns();
    assert.ok(cls(ok, 'primary'));
    assert.equal(d.doc.activeElement, ok, '焦点在确认按钮');
    await ok.fire('click');
    assert.equal(await p, true);
  } finally { d.restore(); }
});

// ---------- 令牌快到期 ----------
test('令牌还有几天：按日历日算（今天到期 0，自己填的日期当天 23:59 以前没过期）；不到 14 天或者已经过期才提醒；跨夏令时也不差一天', () => {
  assert.equal(TOKEN_WARN_DAYS, 14);
  const now = at(2026, 11, 22, 10, 0);
  assert.equal(tokenDaysLeft(at(2026, 11, 22), now), 0);
  assert.equal(tokenDaysLeft(at(2026, 11, 22), at(2026, 11, 22, 0, 5)), 0, '早上晚上看都一样');
  assert.equal(tokenDaysLeft(at(2026, 12, 5), now), 13);
  assert.equal(tokenDaysLeft(at(2026, 12, 6), now), 14);
  assert.equal(tokenDaysLeft(at(2026, 11, 21), now), -1);
  assert.equal(tokenDaysLeft(null, now), null);
  assert.equal(tokenWarn(at(2026, 12, 5), now), true, '还有 13 天');
  assert.equal(tokenWarn(at(2026, 12, 6), now), false, '还有 14 天：还不提醒');
  assert.equal(tokenWarn(at(2026, 10, 1), now), true, '早就过期了');
  assert.equal(tokenWarn(null, now), false, '没填');
  assert.equal(tokenExpired(at(2026, 11, 22), now), false, '今天到期：当天还能用');
  assert.equal(tokenExpired(at(2026, 11, 22, 9, 0), now), true, 'GitHub 给的具体时刻过了');
  // 三月、十一月换夏令时的那几天只有 23 / 25 小时（在没有夏令时的时区里也一样对）
  assert.equal(tokenDaysLeft(at(2026, 3, 14), at(2026, 3, 1, 23, 30)), 13);
  assert.equal(tokenDaysLeft(at(2026, 11, 14), at(2026, 10, 31, 0, 30)), 14);
});

test('同步状态：令牌快到期是黄的「令牌快到期」（三种语言），排在「待同步」前面；出错、离线、同步中照样先说；同步页写还有几天、今天到期、已经到期', () => {
  const now = at(2026, 11, 22, 10, 0), soon = at(2026, 11, 30), later = at(2027, 3, 1);
  assert.equal(syncPhase({ on: true, tokenExpires: soon, dirty: true }, now), 'token');
  assert.equal(syncPhase({ on: true, tokenExpires: later, dirty: true }, now), 'pending');
  assert.equal(syncPhase({ on: true, tokenExpires: soon, err: { code: 'auth' } }, now), 'err', '真出了错还是错');
  assert.equal(syncPhase({ on: true, tokenExpires: soon, offline: true }, now), 'offline');
  assert.equal(syncPhase({ on: true, tokenExpires: soon, running: true }, now), 'running');
  assert.equal(syncPhase({ on: false, tokenExpires: soon }, now), 'off');
  assert.equal(syncPhase({ on: true, tokenExpires: later }, now), 'ok');
  for (const [lang, word] of [['zh-Hans', '令牌快到期'], ['zh-Hant-TW', '權杖快到期'], ['en', 'Token expiring']]) {
    setLang(lang);
    assert.deepEqual(syncState({ on: true, tokenExpires: soon }, lang, now), { cls: 'warn', text: word, phase: 'token' });
    assert.equal(syncState({ on: true, tokenExpires: soon, err: { code: 'auth' } }, lang, now).cls, 'err');
    assert.equal(tokenNote(soon, now), t('set.tokenSoon', { n: 8 }));
    assert.equal(tokenNote(at(2026, 11, 22), now), t('set.tokenToday'));
    assert.equal(tokenNote(at(2026, 11, 2), now), t('set.tokenExpired'));
    assert.equal(tokenNote(later, now), null);
  }
  setLang('zh-Hans');
  assert.equal(tokenNote(soon, now), '还有 8 天：到期前在 GitHub 新建一个令牌，点「换令牌」换上。');
});

test('设置里「同步」那一行：令牌快到期时是黄的「令牌快到期」，同步出错时还是红的「同步出错」；同步页那一行变成提醒', async () => {
  const soon = Date.now() + 3 * 864e5;
  for (const [st, want] of [[{ on: true, tokenExpires: soon }, ['warn', '令牌快到期']], [{ on: true, tokenExpires: soon, err: { code: 'auth' } }, ['err', '同步出错']],
    [{ on: true, tokenExpires: Date.now() + 60 * 864e5 }, ['ok', '已同步']]]) {
    const s = mainSetup({ st });
    try {
      await settle();
      const dot = byCls(find(s.main, el => el.id === 'set-sync'), 'set-state');
      assert.ok(cls(dot, want[0]), dot.attrs.class);
      assert.equal(dot.textContent, want[1]);
    } finally { s.close(); }
  }
  // 同步页
  const d = installDom({ localStorage: fakeStorage(), matchMedia: () => ({ matches: false, addEventListener() {} }) });
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  state.setLocal({ device: 'iPhone', who: 'me', deviceId: 'd_this', sync: { repo: 'me/dreams', token: 'synthetic', tokenExp: soon } });
  const st = { on: true, running: false, repo: 'me/dreams', pendingUp: 0, pendingDown: 0, pendingPurge: 0, oldDevices: [], tokenExpires: soon };
  const ctx = { t, lang: () => 'zh-Hans', layout: () => 'phone', device: 'iPhone',
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    toast: () => ({ close() {} }), confirm: async () => true, back() {}, navigate() {}, on: () => () => {},
    sync: { status: () => st, devices: () => ({ updated: [], waiting: [] }), historyInfo: async () => null } };
  const main = new Element('main');
  const handle = renderSettings(main, { name: 'settings', sub: 'sync', query: {} }, ctx, { purgeEnabled: false });
  try {
    await settle();
    const card = byCls(main, 'set-sync');
    assert.ok(cls(byCls(card, 'set-state'), 'warn'));
    const line = find(card, el => el.tag === 'p' && cls(el, 'set-warn') && el.textContent.startsWith('令牌 '));
    assert.ok(line, card.textContent);
    assert.ok(line.textContent.endsWith(t('set.tokenSoon', { n: 3 })), line.textContent);
  } finally { handle.cleanup(); d.restore(); }
});
