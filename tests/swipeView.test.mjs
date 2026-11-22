// 列表、日历那天的卡片左右滑（src/ui/swipe.js 接到 views/list.js 的 entryCard 上）：最小 DOM + 真的 state.js，事件按捕获 → 冒泡派发。
//   往左滑露出「删除」、往右滑露出「收藏」；滑只是露出按钮，点了按钮才做（删除 = 进「最近删除」+ 同详情页一样的「撤销」提示）——
//   拖得再远、甩得再快、斜着甩、被打断、触控板猛扫都只是开着或者关上；最后一个测试拿几千串乱来的手势验这一点；
//   点按钮要「这一根手指单独按在按钮上、按着的时候没移开」：两根手指同时按着（一根在滑、另一根按在按钮上）哪一根都不算，按多久都一样；
//   笔、鼠标抬起以后悬着移开不影响；按着按钮的时候数据变了，重画等抬起（还是重画了的话，按在旧按钮上也算新画的同一个）；
//   触控板惯性还没停就点露出来的按钮：按下去就按位置停好，停在这一边才算；
//   竖着滑、从屏幕左边缘开始的不管；同一时间只开一张；点开着的卡片只是关上（不打开条目，⭐ ▶ 也不算点）；滚动、Esc 关上；
//   触控板两指横扫；关着时没有按钮（第一次滑开才建，之后关着时 hidden）、开着时有名字；日历那天的卡片也一样；离开页面时等动画的删除照样做完；
//   数据变了等滑完再重画（接着一张张删不丢）；自己删除引起的重画开着的照样开着，别处改的关上、马上点下来的不算；
//   键盘删掉焦点挪到下一张；双栏时右栏正在改的那条不给删除；滑着取消收藏能撤销；捏合放大着不滑。
// 梦话都是编的（仓库是公开的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render as renderList } from '../src/views/list.js';
import { render as renderCal } from '../src/views/calendar.js';
import { SWIPE } from '../src/ui/swipe.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, deletedRecord, live, byNewest } from '../src/core/store.js';
import { setLang, t } from '../src/i18n.js';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';

const NN = '\u{1F470}\u{1F3FB}‍♀️';
const W = 343, A = SWIPE.action;
const tick = () => new Promise(r => setTimeout(r, 0));
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
const raw = (id) => state.getState().data.entries[id];
const gone = (id) => !!raw(id).deleted;
// 最小 DOM 里没有的
Object.defineProperty(Element.prototype, 'parentNode', { configurable: true, get() { return this.parent || null; } });
Element.prototype.closest = function (sel) {          // 只要 .class
  for (let n = this; n; n = n.parent) if (n.classList && n.classList.contains(sel.slice(1))) return n;
  return null;
};
Element.prototype.scrollIntoView = function () {};

/** 派发事件：先 window、document（swipe.js 在这两个上面听捕获），再从目标往上冒泡；返回事件（看 defaultPrevented） */
function dispatch(target, type, props = {}) {
  const ev = { type, target, defaultPrevented: false, stopped: false, cancelable: true, ...props,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  for (const node of [globalThis.window, globalThis.document]) {
    for (const fn of [...(node.events[type] || [])]) { fn(ev); if (ev.stopped) return ev; }
  }
  for (let el = target; el; el = el.parent) {
    for (const fn of [...(el.events[type] || [])]) fn(ev);
    if (ev.stopped) break;
  }
  return ev;
}

/** 一页的环境：时钟、计时器（手动推进）、宽度、减少动态效果；ctx 照着 app.js（undoLabel → 提示条带「撤销」，数据变了下一个微任务里 onChange） */
function setup({ reduce = false, entries = null } = {}) {   // reduce：true / false，或者每次问的函数（测试中途切换）
  const d = installDom({ localStorage: fakeStorage(), requestAnimationFrame: () => 0, CSS: { escape: (x) => x } });
  const make = d.doc.createElement;
  d.doc.createElement = (tag) => { const el = make(tag); el.style.setProperty = (k, v) => { el.style[k] = v; }; return el; };
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  state.mutate(s => {
    for (const e of entries || [
      { id: 'a', date: '2026-11-04', time: '02:58', text: `${NN}“今天吃什么”` },
      { id: 'b', date: '2026-11-03', time: '03:10', text: `${NN}“馄饨..”`, fav: true },
      { id: 'c', date: '2026-11-01', status: 'inbox', text: '' },
    ]) s.data.entries[e.id] = makeEntry(e, 1000);
  });
  const clock = { t: 1000 }, timers = [];
  let tid = 0;
  const env = {
    now: () => clock.t, width: () => W, reduceMotion: () => (typeof reduce === 'function' ? reduce() : reduce),
    setTimeout: (fn, ms) => { const id = ++tid; timers.push({ id, fn, at: clock.t + ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  /** 把到期的计时器都跑完（动画做完） */
  const flush = (ms = 5000) => {
    const end = clock.t + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const x = timers[0];
      if (!x || x.at > end) break;
      timers.shift();
      clock.t = Math.max(clock.t, x.at);
      x.fn();
    }
  };
  const out = { toasts: [], navs: [], pages: [], clock, timers, flush, env, d };
  const ctx = {
    t, lang: () => 'zh-Hans', layout: () => 'phone',
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    entries: () => live(state.getState()).sort(byNewest),
    entry: (id) => (id && raw(id)) || null,
    put(e, opts) { const id = e.id; state.mutate(s => { s.data.entries[id] = normalizeEntry(stamp({ ...e, id }, s.data.entries[id]), id); }, opts); return raw(id); },
    update: (id, patch, opts) => (raw(id) ? ctx.put({ ...raw(id), ...patch, id }, opts) : null),
    remove(id) { const prev = raw(id); if (!prev || prev.deleted) return null; state.mutate(s => { s.data.entries[id] = deletedRecord(prev); }, { undoLabel: t('common.deletedOne') }); return prev; },
    undo: () => state.undo(),
    toast: (msg, o = {}) => { out.toasts.push({ msg, ...o }); return { close() {} }; },
    navigate: (p, o) => out.navs.push(p + (o && o.replace ? ' (replace)' : '')), back: (p) => out.navs.push('back:' + p), home: () => '/', replaceHash() {},
    on: () => () => {}, setListMode() {},
    clipBlob: async () => { out.blobAsked = (out.blobAsked || 0) + 1; return null; },
  };
  out.ctx = ctx;
  out.off = state.subscribe((s, info) => {
    if (info.undoLabel) out.toasts.push({ msg: info.undoLabel, action: { label: t('common.undo'), run: () => ctx.undo() } });
    queueMicrotask(() => { if (!out.closed) for (const p of out.pages) p.onChange(info); });
  });
  out.list = (params = {}) => {
    const main = new Element('main');
    const page = renderList(main, { name: 'list', path: [], pane: 'main', ...params }, ctx, { swipe: env });
    out.pages.push(page);
    return { main, page };
  };
  out.done = () => { out.closed = true; for (const p of out.pages) p.cleanup(); out.off(); d.restore(); };
  return out;
}

const wraps = (main) => all(main, el => cls(el, 'swipe'));
const wrapOf = (main, id) => wraps(main).find(w => w.children[0].dataset.id === id);
const btnOf = (w, c) => w.children.find(x => cls(x, c));
const linkOf = (w) => byCls(w, 'c-link');
/** 用手指（或笔）拖：pts = [[x, y], …]，每步 16 ms；rest：松手前停多久（0 = 边拖边松手，有速度） */
function drag(env, target, pts, { id = 1, type = 'touch', rest = 200, up = true } = {}) {
  const p = (x, y) => ({ pointerId: id, pointerType: type, clientX: x, clientY: y, button: 0, isPrimary: true });
  dispatch(target, 'pointerdown', p(...pts[0]));
  for (const [x, y] of pts.slice(1)) { env.clock.t += 16; dispatch(target, 'pointermove', p(x, y)); }
  env.clock.t += rest;
  if (up) dispatch(target, 'pointerup', p(...pts[pts.length - 1]));
}
const line = (x0, x1, n = 8, y = 300) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y]);
/** 点一下（按下、抬起、click）→ click 事件 */
function tap(env, target, x = 200, y = 300) {
  drag(env, target, [[x, y]], { rest: 60 });
  env.clock.t += 10;
  return dispatch(target, 'click', { clientX: x, clientY: y });
}

test('往左滑露出「删除」：跟手、松手开着；关着时没有按钮（之后关着时 hidden），开着时按钮能点、有名字', () => {
  const env = setup();
  try {
    const { main } = env.list();
    assert.equal(wraps(main).length, 3);
    const w = wrapOf(main, 'a'), card = w.children[0];
    assert.deepEqual(w.children, [card], '关着：只有卡片，没有按钮（读屏、Tab 都碰不到，长列表也不多建）');
    assert.deepEqual(Object.keys(w.events).sort(), ['touchmove', 'wheel'], '手指、笔的事件在 document 上听，不是每张卡片一份');

    drag(env, linkOf(w), line(300, 240), { up: false });
    const del = btnOf(w, 'sw-del'), fav = btnOf(w, 'sw-fav');
    assert.equal(del.attrs['aria-label'], '删除这条');
    assert.equal(byCls(del, 'sw-t').textContent, '删除');
    assert.equal(fav.attrs['aria-label'], '收藏这条');
    assert.equal(card.style.transform, 'translateX(-60px)');
    assert.equal(del.hidden, false);
    assert.equal(fav.hidden, true);
    assert.equal(del.style.width, (60 - SWIPE.gap) + 'px');
    assert.ok(cls(w, 'sw-drag'));
    dispatch(linkOf(w), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 240, clientY: 300 });
    assert.equal(card.style.transform, `translateX(-${A}px)`);
    assert.equal(w.swipe.side, -1);
    assert.ok(cls(w, 'sw-anim'), '弹到位有动画');
    env.flush();
    assert.ok(!cls(w, 'sw-anim'));
    assert.deepEqual([del.hidden, fav.hidden], [false, true], '开着：只有露出来的那个');
    assert.equal(del.style.width, (A - SWIPE.gap) + 'px');
    assert.equal(byCls(del, 'sw-in').style.opacity, '1');
    assert.equal(gone('a'), false, '只是露出来，还没删');
    // Esc 关上；焦点在按钮上时挪回卡片的链接
    del.focus();
    dispatch(globalThis.document, 'keydown', { key: 'Escape' });
    assert.equal(w.swipe.side, 0);
    assert.equal(globalThis.document.activeElement, linkOf(w));
    env.flush();
    assert.equal(card.style.transform, '');
    assert.deepEqual([del.hidden, fav.hidden], [true, true]);
  } finally { env.done(); }
});

test('点露出来的「删除」：卡片滑出去、收起来以后删（进「最近删除」），提示条和详情页一样能撤销', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(300, 200));
    env.flush();
    const del = btnOf(w, 'sw-del');
    const ev = tap(env, del);
    assert.ok(ev.defaultPrevented);
    assert.ok(cls(w, 'sw-out'));
    assert.ok(w.children[0].style.transform.startsWith('translateX(-'), '往左滑出去');
    assert.equal(gone('a'), false, '动画做完以前还没删（不然列表马上重画，看不到滑出去）');
    env.flush();
    assert.ok(cls(w, 'sw-gone'));
    assert.equal(w.style.height, '0px');
    assert.equal(gone('a'), true);
    assert.deepEqual(env.toasts.map(x => [x.msg, x.action && x.action.label]), [['已删除这条梦话', '撤销']]);
    await tick();
    assert.equal(wrapOf(main, 'a'), undefined, '列表重画，那张不见了');
    assert.equal(wraps(main).length, 2);
    env.toasts[0].action.run();                   // 撤销
    await tick();
    assert.equal(gone('a'), false);
    w = wrapOf(main, 'a');
    assert.ok(w, '回来了');
    assert.equal(w.swipe.side, 0);
    assert.equal(w.children[0].style.transform || '', '');
  } finally { env.done(); }
});

/** 卡片现在移开多少 px（没移是 0） */
const offsetOf = (w) => Number((/-?\d+/.exec(w.children[0].style.transform || '') || [0])[0]);
/** 记下所有条目的收藏、删除（看手势有没有偷偷改数据） */
const snapshot = () => Object.fromEntries(Object.entries(state.getState().data.entries).map(([id, e]) => [id, { fav: !!e.fav, deleted: !!e.deleted }]));

test('一口气往左滑过卡片宽度的 55%、甚至拖过整张卡片：只是露出「删除」，不删；甩得快也一样；要再点一下「删除」才删（能撤销）', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const before = snapshot();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(320, 320 - 220, 10), { up: false });
    assert.ok(!cls(w, 'sw-armed'), '没有「松手就删」的样子');
    assert.ok(offsetOf(w) < 0 && -offsetOf(w) <= A * SWIPE.pull, '卡片不追上手指：最多移开 1.5 个按钮宽 ' + offsetOf(w));
    dispatch(linkOf(w), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    env.clock.t += 5;
    assert.ok(dispatch(linkOf(w), 'click').defaultPrevented, '滑完松手不算点（不打开条目）');
    assert.equal(env.navs.length, 0);
    env.flush();
    await tick();
    assert.equal(gone('a'), false, '松手只是开着');
    assert.equal(w.swipe.side, -1);
    assert.equal(w.children[0].style.transform, `translateX(-${A}px)`);
    assert.equal(btnOf(w, 'sw-del').hidden, false, '「删除」露着，等着点');
    assert.deepEqual(env.toasts, []);

    w = wrapOf(main, 'b');                        // 甩：140 px、很快
    drag(env, linkOf(w), line(300, 160, 4), { rest: 0 });
    env.flush();
    await tick();
    assert.equal(gone('b'), false);
    assert.equal(w.swipe.side, -1);
    assert.equal(wrapOf(main, 'a').swipe.side, 0, '同一时间只开一张');

    w = wrapOf(main, 'c');                        // 一口气拖过整张卡片（343 px）还多、很快
    drag(env, linkOf(w), line(340, -420, 5), { rest: 0 });
    env.flush();
    await tick();
    assert.equal(gone('c'), false);
    assert.equal(w.swipe.side, -1);
    assert.deepEqual(snapshot(), before, '数据一点没变');
    assert.deepEqual(env.toasts, []);

    env.clock.t += 100;
    tap(env, btnOf(w, 'sw-del'));                 // 点了「删除」才删
    env.flush();
    assert.equal(gone('c'), true);
    assert.equal(env.toasts.at(-1).msg, '已删除这条梦话');
    await tick();
    env.toasts.at(-1).action.run();
    await tick();
    assert.equal(gone('c'), false, '撤销');
  } finally { env.done(); }
});

test('往右滑露出「收藏」：点了收藏、卡片弹回去；一口气滑过去也只是露出来；已经收藏的是「取消收藏」', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(100, 170), { up: false });
    assert.equal(w.children[0].style.transform, 'translateX(70px)');
    dispatch(linkOf(w), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 170, clientY: 300 });
    env.flush();
    assert.equal(w.swipe.side, 1);
    const fav = btnOf(w, 'sw-fav');
    assert.deepEqual([fav.hidden, btnOf(w, 'sw-del').hidden], [false, true]);
    tap(env, fav);
    assert.equal(w.children[0].style.transform, '', '弹回去');
    assert.equal(raw('a').fav, false, '弹回去以后再改');
    env.flush();
    assert.equal(raw('a').fav, true);
    assert.equal(env.toasts.length, 0, '和卡片上的 ⭐ 一样：不弹提示');
    await tick();
    w = wrapOf(main, 'a');
    assert.equal(byCls(w, 'fav-btn').attrs['aria-pressed'], 'true');
    w.swipe.open(1);
    assert.equal(btnOf(w, 'sw-fav').attrs['aria-label'], '取消收藏这条');
    assert.equal(byCls(btnOf(w, 'sw-fav'), 'sw-t').textContent, '取消收藏');
    w.swipe.close();

    w = wrapOf(main, 'b');                        // 已经收藏：一口气往右滑过去 → 只是露出「取消收藏」
    drag(env, linkOf(w), line(60, 290, 10));
    env.flush();
    await tick();
    assert.equal(raw('b').fav, true, '没改');
    assert.equal(w.swipe.side, 1);
    assert.deepEqual(env.toasts, []);
    w = wrapOf(main, 'b');
    drag(env, linkOf(w), line(25, 700, 3), { rest: 0 });   // 往右狠甩 675 px：还是只露出来
    env.flush();
    await tick();
    assert.equal(raw('b').fav, true);
    assert.equal(w.swipe.side, 1);
    env.clock.t += 100;
    tap(env, btnOf(w, 'sw-fav'));                 // 点了才取消收藏，弹「撤销」
    env.flush();
    assert.equal(raw('b').fav, false);
    assert.equal(gone('b'), false);
    assert.deepEqual(env.toasts.map(x => [x.msg, x.action && x.action.label]), [['已取消收藏', '撤销']]);
    await tick();
    env.toasts[0].action.run();
    assert.equal(raw('b').fav, true, '撤销：又收藏上了');
  } finally { env.done(); }
});

test('竖着滑（滚动）不动卡片；从屏幕左边缘开始的不管；这两种之后点一下照常打开条目', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a'), card = w.children[0];
    drag(env, linkOf(w), [[200, 300], [196, 290], [190, 260], [150, 200], [80, 150]]);
    assert.equal(card.style.transform || '', '', '先竖着：后面再横着也不管');
    assert.deepEqual(w.children, [card], '没露出按钮');
    assert.equal(w.swipe.side, 0);
    // 竖着的那一下，iOS 那边的 touchmove 也不挡（页面照常滚）
    assert.equal(dispatch(card, 'touchmove').defaultPrevented, false);

    drag(env, linkOf(w), line(12, 200));          // 从左边缘往右
    assert.equal(card.style.transform || '', '');
    assert.equal(w.swipe.side, 0);

    const ev = tap(env, linkOf(w));
    assert.equal(ev.defaultPrevented, false, '点一下：链接照常打开条目');
  } finally { env.done(); }
});

test('横着拖的时候挡住 iOS 的上下滚动；鼠标不拖（选字、拖链接）', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a'), card = w.children[0];
    drag(env, linkOf(w), line(300, 250), { up: false });
    assert.equal(dispatch(card, 'touchmove').defaultPrevented, true);
    dispatch(card, 'pointercancel', { pointerId: 1 });
    env.flush();
    assert.equal(w.swipe.side, -1, '被系统打断：按位置开着，不删');
    assert.equal(gone('a'), false);
    w.swipe.close();
    drag(env, linkOf(w), line(300, 100), { type: 'mouse' });
    assert.equal(card.style.transform || '', '');
    assert.equal(gone('a'), false);
  } finally { env.done(); }
});

test('同一时间只开一张：在别的卡片上开始滑，开着的那张关上', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const a = wrapOf(main, 'a'), b = wrapOf(main, 'b');
    drag(env, linkOf(a), line(300, 200));
    env.flush();
    assert.equal(a.swipe.side, -1);
    drag(env, linkOf(b), line(100, 200));
    assert.equal(a.swipe.side, 0);
    assert.equal(b.swipe.side, 1);
    env.flush();
    assert.equal(a.children[0].style.transform, '');
    assert.equal(btnOf(a, 'sw-del').hidden, true);
    assert.equal(b.children[0].style.transform, `translateX(${A}px)`);
  } finally { env.done(); }
});

test('点开着的卡片只是关上（不打开条目，卡片里的 ⭐ 也不算点）；点别的卡片也只是关上；点卡片外面照常', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const a = wrapOf(main, 'a'), b = wrapOf(main, 'b');
    drag(env, linkOf(a), line(300, 200));
    env.flush();
    let ev = tap(env, linkOf(a));
    assert.equal(ev.defaultPrevented, true, '不打开条目');
    assert.equal(a.swipe.side, 0);
    assert.equal(tap(env, linkOf(a)).defaultPrevented, false, '关上以后再点：照常打开');

    drag(env, linkOf(a), line(300, 200));
    env.flush();
    ev = tap(env, byCls(a, 'fav-btn'));
    assert.equal(ev.defaultPrevented, true);
    assert.equal(raw('a').fav, false, '⭐ 没被点到');
    assert.equal(a.swipe.side, 0);

    drag(env, linkOf(a), line(300, 200));
    env.flush();
    ev = tap(env, byCls(b, 'fav-btn'));
    assert.equal(ev.stopped, true, '点到别的卡片的 ⭐：只是关上开着的那张');
    assert.equal(raw('b').fav, true);
    assert.equal(a.swipe.side, 0);

    drag(env, linkOf(a), line(300, 200));
    env.flush();
    const search = find(main, el => el.tag === 'input');
    ev = tap(env, search);
    assert.equal(ev.defaultPrevented, false, '点搜索框：照常');
    assert.equal(a.swipe.side, 0, '开着的关上');

    drag(env, linkOf(a), line(300, 200));         // 鼠标点开着的卡片也只是关上
    env.flush();
    dispatch(linkOf(a), 'pointerdown', { pointerId: 9, pointerType: 'mouse', clientX: 200, clientY: 300, button: 0 });
    dispatch(linkOf(a), 'pointerup', { pointerId: 9, pointerType: 'mouse', clientX: 200, clientY: 300, button: 0 });
    assert.equal(dispatch(linkOf(a), 'click').defaultPrevented, true);
    assert.equal(a.swipe.side, 0);
  } finally { env.done(); }
});

test('在 ⭐、▶ 上开始横着滑：照样滑，松手不算点', () => {
  const env = setup({ entries: [{ id: 'a', date: '2026-11-04', time: '02:58', text: `${NN}“今天吃什么”`, audio: [{ sha256: 'a'.repeat(64), mime: 'audio/mp4', durationSec: 12 }] }] });
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a');
    const play = byCls(w, 'player-btn');
    drag(env, play, line(330, 230));
    env.clock.t += 5;
    assert.equal(dispatch(play, 'click').stopped, true, '▶ 没被点到');
    assert.equal(env.blobAsked || 0, 0);
    env.flush();
    assert.equal(w.swipe.side, -1);
    w.swipe.close();
    const star = byCls(w, 'fav-btn');
    drag(env, star, line(330, 230));
    env.clock.t += 5;
    dispatch(star, 'click');
    assert.equal(raw('a').fav, false, '⭐ 没被点到');
    assert.equal(w.swipe.side, -1);
  } finally { env.done(); }
});

test('滚动、数据变了（重画）都关上开着的卡片', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const a = wrapOf(main, 'a');
    drag(env, linkOf(a), line(300, 200));
    env.flush();
    dispatch(globalThis.window, 'scroll');
    assert.equal(a.swipe.side, -1, '没滚动（位置没变）：还开着');
    globalThis.document.documentElement.scrollTop = 30;
    main.parent = globalThis.document.documentElement;        // 页面在 <html> 里滚
    dispatch(globalThis.window, 'scroll');
    assert.equal(a.swipe.side, 0);
    main.parent = null;

    const b = wrapOf(main, 'b');
    drag(env, linkOf(b), line(300, 200));
    env.flush();
    btnOf(b, 'sw-del').focus();                                 // 键盘用户 Tab 到了「删除」
    env.ctx.update('c', { note: '那天下雨' });                 // 同步进来、别处改了
    await tick();
    const b2 = wrapOf(main, 'b');
    assert.notEqual(b2, b, '重画了');
    assert.equal(b2.swipe.side, 0);
    assert.equal(b2.children[0].style.transform || '', '');
    assert.ok(cls(b2, 'sw-anim'), '新画的那张从开着的样子关上（有动画，不是一下跳回去）');
    assert.equal(globalThis.document.activeElement, linkOf(b2), '焦点放回新画的那张的链接');
    const star = byCls(b2, 'fav-btn');
    env.clock.t += 200;
    assert.equal(tap(env, star).stopped, true, '马上点下来的那一下是冲着「删除」去的：不算点到 ⭐');
    assert.equal(raw('b').fav, true);
    env.clock.t += 600;
    assert.equal(tap(env, linkOf(b2)).defaultPrevented, false, '过一会儿再点：照常');
  } finally { env.done(); }
});

test('触控板两指横扫：往左露出删除、往右关上；竖着滚不挡也不动；只开关、不直接删', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a'), card = w.children[0];
    const wheel = (dx, dy) => { env.clock.t += 16; return dispatch(card, 'wheel', { deltaX: dx, deltaY: dy, deltaMode: 0 }); };
    assert.equal(wheel(2, 14).defaultPrevented, false);
    assert.equal(wheel(30, 6).defaultPrevented, false, '这一下是竖着的');
    env.flush();
    assert.equal(card.style.transform || '', '');
    env.clock.t += 500;
    assert.equal(wheel(8, 0).defaultPrevented, true);
    for (let i = 0; i < 30; i++) wheel(30, 0);                // 惯性也算进来：拉得再远也只是开着
    assert.ok(cls(w, 'sw-drag') === false);
    env.flush();
    assert.equal(w.swipe.side, -1);
    assert.equal(gone('a'), false);
    assert.equal(btnOf(w, 'sw-del').hidden, false);
    env.clock.t += 500;
    wheel(-20, 0); wheel(-40, 0);
    env.flush();
    assert.equal(w.swipe.side, 0);
    env.clock.t += 500;
    wheel(-20, 0); wheel(-50, 0);                            // 往右：收藏那边
    env.flush();
    assert.equal(w.swipe.side, 1);
    assert.equal(btnOf(w, 'sw-fav').hidden, false);
  } finally { env.done(); }
});

test('「减少动态效果」：不做动画；滑得再远也只是露出按钮；点删除、收藏马上做；离开页面时等着动画的删除照样做完', async () => {
  const env = setup({ reduce: true });
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(330, -200, 4), { rest: 0 });  // 很快、拖过整张卡片
    assert.ok(!cls(w, 'sw-anim'));
    assert.deepEqual(env.timers, []);
    assert.equal(gone('a'), false, '只是开着');
    assert.equal(w.swipe.side, -1);
    tap(env, btnOf(w, 'sw-del'));
    assert.equal(gone('a'), true, '点了马上删');
    assert.deepEqual(env.timers, []);
    await tick();
    w = wrapOf(main, 'c');
    drag(env, linkOf(w), line(25, 600, 4), { rest: 0 });
    assert.equal(raw('c').fav, false);
    assert.equal(w.swipe.side, 1);
    tap(env, btnOf(w, 'sw-fav'));
    assert.equal(raw('c').fav, true, '点了马上收藏');
  } finally { env.done(); }

  const env2 = setup();
  try {
    const { main, page } = env2.list();
    const w = wrapOf(main, 'b');
    drag(env2, linkOf(w), line(320, 80, 10));
    env2.flush();
    assert.equal(gone('b'), false);
    tap(env2, btnOf(w, 'sw-del'));
    assert.equal(gone('b'), false, '还在滑出去');
    page.cleanup();                                         // 马上点了别处（换页）
    env2.pages.length = 0;
    assert.equal(gone('b'), true, '没丢');
  } finally { env2.done(); }
});

test('筛选待整理、搜索结果里的卡片也能滑', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const inbox = find(main, el => el.tag === 'button' && el.dataset.k === 'inbox');
    dispatch(inbox, 'click');
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['c']);
    drag(env, linkOf(wrapOf(main, 'c')), line(300, 200));
    env.flush();
    tap(env, btnOf(wrapOf(main, 'c'), 'sw-del'));
    env.flush();
    assert.equal(gone('c'), true);
    await tick();
    assert.equal(inbox.attrs['aria-pressed'], 'false', '都整理好了（删掉了）：筛选自动取消');
    const q = find(main, el => el.tag === 'input');
    const search = (v) => { q.value = v; q.events.input.forEach(fn => fn({ target: q })); };
    search('馄饨');
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['b']);
    drag(env, linkOf(wrapOf(main, 'b')), line(100, 180));
    env.flush();
    assert.equal(wrapOf(main, 'b').swipe.side, 1);
    assert.equal(btnOf(wrapOf(main, 'b'), 'sw-fav').hidden, false);
    search('');                                              // 搜索词这次打开 App 期间记着：清掉，别带到后面
  } finally { env.done(); }
});

test('双栏：右栏正看着的那条滑开点「删除」→ 右栏回到「呓语」（同详情页删除）；动画期间已经点去别的条目了就不跳回去', () => {
  const env = setup();
  let route = { name: 'entry', id: 'a' };
  Object.defineProperty(env.ctx, 'route', { get: () => route });
  try {
    const { main, page } = env.list({ pane: 'list', selected: 'a' });
    drag(env, linkOf(wrapOf(main, 'a')), line(320, 80, 10));
    env.flush();
    assert.equal(gone('a'), false, '滑开只是露出「删除」');
    assert.deepEqual(env.navs, []);
    tap(env, btnOf(wrapOf(main, 'a'), 'sw-del'));
    env.flush();
    assert.equal(gone('a'), true);
    assert.deepEqual(env.navs, ['/ (replace)']);
    page.cleanup();
    env.pages.length = 0;

    route = { name: 'entry', id: 'b' };
    const two = env.list({ pane: 'list', selected: 'b' });
    drag(env, linkOf(wrapOf(two.main, 'b')), line(320, 80, 10));
    env.flush();
    tap(env, btnOf(wrapOf(two.main, 'b'), 'sw-del'));
    route = { name: 'entry', id: 'c' };                     // 滑出去的时候点了另一条：换页、清理时把删除做完
    two.page.cleanup();
    env.pages.length = 0;
    assert.equal(gone('b'), true);
    assert.deepEqual(env.navs, ['/ (replace)'], '不再跳回「呓语」');
  } finally { env.done(); }
});

test('拖着的时候数据变了：等松手、卡片停好再重画（手底下的卡片不换掉）；删除在滑出去时也等删完；一直按着不放最多等 4 秒', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let old = wrapOf(main, 'a');
    drag(env, linkOf(old), line(300, 200), { up: false });
    env.ctx.update('c', { note: '那天下雨' });
    await tick();
    assert.equal(wrapOf(main, 'a'), old, '还没重画');
    env.clock.t += 16;
    dispatch(linkOf(old), 'pointermove', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    dispatch(linkOf(old), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    await tick();
    assert.equal(wrapOf(main, 'a'), old, '卡片还在弹到位：还不重画');
    env.flush();
    await tick();
    assert.notEqual(wrapOf(main, 'a'), old, '停好以后重画了');
    assert.equal(gone('a'), false, '拖过去只是开着');
    assert.equal(wrapOf(main, 'a').swipe.side, 0, '别处改的：关上');

    old = wrapOf(main, 'a');                                // 点了「删除」、正滑出去时数据变了：删完再重画
    old.swipe.open(-1);
    env.clock.t += 1000;
    tap(env, btnOf(old, 'sw-del'));
    env.ctx.update('c', { note: '还在下雨' });
    await tick();
    assert.equal(wrapOf(main, 'a'), old, '删除的动画还没做完：还不重画');
    env.flush();
    assert.equal(gone('a'), true);
    await tick();
    assert.equal(wrapOf(main, 'a'), undefined, '删完以后重画了一次（别处改的也在里面）');
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['b', 'c']);

    // 按着不放：最多等 4 秒，之后照样重画（旧卡片松手什么都不做）
    const b = wrapOf(main, 'b');
    drag(env, linkOf(b), line(300, 240), { up: false });
    env.ctx.update('c', { note: '又下雨了' });
    await tick();
    assert.equal(wrapOf(main, 'b'), b);
    env.flush(SWIPE.hold + 10);
    assert.notEqual(wrapOf(main, 'b'), b, '等太久：重画了');
    dispatch(linkOf(b), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 240, clientY: 300 });
    env.flush();
    assert.equal(b.swipe.side, 0, '那张已经不在了：不算开着');
    assert.equal(wrapOf(main, 'b').swipe.side, 0);
    env.clock.t += 1000;
    assert.equal(tap(env, linkOf(wrapOf(main, 'b'))).defaultPrevented, false, '也不挡新卡片的点按');
  } finally { env.done(); }
});

test('日历那天的卡片：一样能滑、删、收藏；重画（翻月、选日子）时关上', async () => {
  const env = setup();
  try {
    const main = new Element('main');
    const page = renderCal(main, { name: 'calendar', path: ['cal', '2026-11-04'], pane: 'main' }, env.ctx, { swipe: env.env });
    env.pages.push(page);
    let w = wraps(main);
    assert.deepEqual(w.map(x => x.children[0].dataset.id), ['a']);
    drag(env, linkOf(w[0]), line(100, 180));
    env.flush();
    assert.equal(w[0].swipe.side, 1);
    assert.equal(btnOf(w[0], 'sw-fav').hidden, false);
    tap(env, btnOf(w[0], 'sw-fav'));
    env.flush();
    assert.equal(raw('a').fav, true);
    await tick();
    w = wraps(main);
    drag(env, linkOf(w[0]), line(320, 80, 10));
    env.flush();
    assert.equal(gone('a'), false, '滑开只是露出「删除」');
    tap(env, btnOf(w[0], 'sw-del'));
    env.flush();
    assert.equal(gone('a'), true);
    assert.equal(env.toasts.at(-1).msg, '已删除这条梦话');
    await tick();
    assert.equal(wraps(main).length, 0);
    assert.ok(byCls(main, 'cal-none'), '这天没有了');
  } finally { env.done(); }
});

const P1 = (x, y, id = 1) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, isPrimary: true });
/** 时间一格一格（16 ms）往前走：到期的计时器跑掉、微任务（数据变了以后的重画）也跑掉 */
async function until(env, T) {
  while (env.clock.t < T) {
    const next = Math.min(T, env.clock.t + 16);
    env.flush(next - env.clock.t);
    env.clock.t = next;
    await tick();
  }
}
/** 像真的手指那样边走时间边拖（拖的期间前一张的删除可能落下来、列表可能要重画） */
async function liveDrag(env, target, pts) {
  dispatch(target, 'pointerdown', P1(...pts[0]));
  for (const p of pts.slice(1)) { await until(env, env.clock.t + 16); dispatch(target, 'pointermove', P1(...p)); }
  dispatch(target, 'pointerup', P1(...pts.at(-1)));
}

/** 像真的手指那样点一下（按下、抬起、click，期间时间照走） */
async function liveTap(env, target, x = 200, y = 300) {
  dispatch(target, 'pointerdown', P1(x, y));
  await until(env, env.clock.t + 60);
  dispatch(target, 'pointerup', P1(x, y));
  env.clock.t += 10;
  return dispatch(target, 'click', { clientX: x, clientY: y });
}

test('接着一张张删：点了上一张的「删除」马上滑开下一张，上一张的删除在下一张拖到一半时落下来，下一张照样开着、点「删除」删掉', async () => {
  for (const gap of [0, 250, 300, 350, 400, 500]) {
    for (const n of [8, 14]) {
      const env = setup();
      try {
        const { main } = env.list();
        await liveDrag(env, linkOf(wrapOf(main, 'a')), line(320, 80, 10));
        await until(env, env.clock.t + 100);
        assert.equal(gone('a'), false, '滑开只是露出「删除」');
        await liveTap(env, btnOf(wrapOf(main, 'a'), 'sw-del'));
        await until(env, env.clock.t + gap);
        await liveDrag(env, linkOf(wrapOf(main, 'b')), line(320, 80, n));
        await until(env, env.clock.t + 700);
        assert.deepEqual([gone('a'), gone('b')], [true, false], `隔 ${gap} ms、拖 ${n * 16} ms`);
        const b = wrapOf(main, 'b');
        assert.equal(b.swipe.side, -1, `隔 ${gap} ms、拖 ${n * 16} ms：重画以后照样开着`);
        await liveTap(env, btnOf(b, 'sw-del'));
        await until(env, env.clock.t + 700);
        assert.equal(gone('b'), true, `隔 ${gap} ms、拖 ${n * 16} ms`);
        assert.equal(raw('b').fav, true, '⭐ 没被点到');
        assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['c']);
      } finally { env.done(); }
    }
  }
});

test('点了 A 的「删除」马上滑开 B：A 删掉以后 B 还开着，点 B 的「删除」删的是 B（不是点到 ⭐ ▶）', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const wa = wrapOf(main, 'a');
    wa.swipe.open(-1);
    env.clock.t += 1000;
    tap(env, btnOf(wa, 'sw-del'));
    await until(env, env.clock.t + 100);
    await liveDrag(env, linkOf(wrapOf(main, 'b')), line(300, 200, 6));
    await until(env, env.clock.t + 800);
    assert.equal(gone('a'), true);
    const B2 = wrapOf(main, 'b');
    assert.equal(B2.swipe.side, -1, '自己删除引起的重画：开着的那张照样开着');
    assert.equal(B2.children[0].style.transform, `translateX(-${A}px)`);
    assert.equal(btnOf(B2, 'sw-del').hidden, false);
    env.clock.t += 100;
    const ev = tap(env, btnOf(B2, 'sw-del'));
    assert.equal(ev.stopped, true);
    assert.equal(raw('b').fav, true, '⭐ 没被点到');
    await until(env, env.clock.t + 800);
    assert.equal(gone('b'), true);
    assert.deepEqual(env.toasts.map(x => x.msg), ['已删除这条梦话', '已删除这条梦话']);
  } finally { env.done(); }
});

test('键盘：开着时 Tab 到「删除」按 Enter → 焦点挪到下一张的链接（重画以后也在）；删的是最后一张 → 上一张；刚滑完就按也不吞', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(300, 200));
    env.flush();
    const del = btnOf(w, 'sw-del');
    del.focus();
    env.clock.t += 100;                                    // 滑开以后 700 ms 以内：键盘的 click（detail 0）不算刚才那一下手指
    const ev = dispatch(del, 'click', { detail: 0 });
    assert.equal(ev.stopped, true, '按钮自己处理了');
    assert.equal(globalThis.document.activeElement, linkOf(wrapOf(main, 'b')), '马上挪到下一张');
    env.flush();
    assert.equal(gone('a'), true);
    await tick(); await tick();
    assert.equal(globalThis.document.activeElement, linkOf(wrapOf(main, 'b')), '重画以后放回新画的那张');

    w = wrapOf(main, 'c');                                  // 最后一张
    w.swipe.open(-1);
    btnOf(w, 'sw-del').focus();
    dispatch(btnOf(w, 'sw-del'), 'click', { detail: 0 });
    assert.equal(globalThis.document.activeElement, linkOf(wrapOf(main, 'b')), '没有下一张：上一张');
    env.flush();
    await tick(); await tick();
    assert.equal(gone('c'), true);
    assert.equal(globalThis.document.activeElement, linkOf(wrapOf(main, 'b')));
  } finally { env.done(); }
});

test('双栏：右栏正在改的那条不给「删除」（往左只能拉动一点点）；收藏照样能滑；别的卡片照样能删', () => {
  const env = setup();
  Object.defineProperty(env.ctx, 'route', { get: () => ({ name: 'editor', id: 'a', sub: 'edit' }) });
  try {
    const { main } = env.list({ pane: 'list', selected: 'a' });
    const w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(320, 80, 10), { up: false });
    const x = Number(/-?\d+/.exec(w.children[0].style.transform)[0]);
    assert.ok(x < 0 && x >= -16, String(x));
    assert.equal(btnOf(w, 'sw-del'), undefined);
    dispatch(linkOf(w), 'pointerup', P1(80, 300));
    env.flush();
    assert.equal(gone('a'), false);
    assert.equal(w.swipe.side, 0);
    assert.deepEqual(env.navs, []);
    w.swipe.open(1);
    assert.equal(btnOf(w, 'sw-fav').hidden, false);
    w.swipe.close();
    const b = wrapOf(main, 'b');
    drag(env, linkOf(b), line(320, 80, 10));
    env.flush();
    assert.equal(b.swipe.side, -1);
    tap(env, btnOf(b, 'sw-del'));
    env.flush();
    assert.equal(gone('b'), true);
  } finally { env.done(); }
});

test('「收藏」筛选里滑开点「取消收藏」：卡片不见了，提示条能「撤销」回来', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const chip = find(main, el => el.tag === 'button' && el.dataset.k === 'fav');
    dispatch(chip, 'click');
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['b']);
    const w = wrapOf(main, 'b');
    drag(env, linkOf(w), line(60, 290, 10));
    env.flush();
    await tick();
    assert.equal(raw('b').fav, true, '滑开只是露出「取消收藏」');
    assert.equal(w.swipe.side, 1);
    tap(env, btnOf(w, 'sw-fav'));
    env.flush();
    await tick();
    assert.equal(raw('b').fav, false);
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), []);
    assert.equal(env.toasts.at(-1).msg, '已取消收藏');
    env.toasts.at(-1).action.run();
    await tick();
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['b'], '撤销：回来了');
    dispatch(chip, 'click');                                // 筛选这次打开 App 期间记着：清掉，别带到后面
  } finally { env.done(); }
});

test('从开着的一边快速往回甩：只是关上（不露出另一边、不删、不改收藏）', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    w.swipe.open(-1);
    drag(env, linkOf(w), line(100, 220, 4), { rest: 0 });      // 删除露着，往右甩 120 px
    env.flush();
    assert.equal(w.swipe.side, 0);
    w.swipe.open(1);
    drag(env, linkOf(w), line(300, 70, 6), { rest: 0 });       // 收藏露着，往左狠甩 230 px
    env.flush();
    await tick();
    assert.equal(gone('a'), false);
    w = wrapOf(main, 'b');                                      // 已经收藏；删除露着，往右狠甩 270 px
    w.swipe.open(-1);
    drag(env, linkOf(w), line(60, 330, 6), { rest: 0 });
    env.flush();
    await tick();
    assert.equal(raw('b').fav, true);
    assert.equal(env.toasts.length, 0);
  } finally { env.done(); }
});

test('斜着往上甩（头 10 多 px 是横着的）：不删；往下甩：不改收藏', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    drag(env, linkOf(wrapOf(main, 'a')), [[300, 500], [288, 497], [240, 430], [190, 350], [140, 270]], { rest: 0 });
    env.flush();
    await tick();
    assert.equal(gone('a'), false);
    assert.equal(wrapOf(main, 'a').swipe.side, -1, '只是开着');
    drag(env, linkOf(wrapOf(main, 'b')), [[120, 200], [132, 203], [180, 270], [230, 350], [280, 430]], { rest: 0 });
    env.flush();
    await tick();
    assert.equal(raw('b').fav, true);
    assert.equal(wrapOf(main, 'b').swipe.side, 1);
    assert.deepEqual(env.toasts, []);
  } finally { env.done(); }
});

test('触控板：猛扫卡片也只移开不到 1.2 个按钮宽；开着的往回扫（带惯性）关上，不会露出另一边；扫得再猛也不删', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a'), card = w.children[0];
    let max = 0;
    const wheel = (dx) => { env.clock.t += 16; dispatch(card, 'wheel', { deltaX: dx, deltaY: 0, deltaMode: 0 }); max = Math.max(max, Math.abs(Number((/-?\d+/.exec(card.style.transform || '0') || [0])[0]))); };
    for (let i = 0; i < 8; i++) wheel(25);
    for (let v = 25 * 0.93; v >= 0.5; v *= 0.93) wheel(v);
    assert.ok(max <= Math.round(A * 1.2), String(max));
    env.flush();
    assert.equal(w.swipe.side, -1);
    assert.equal(gone('a'), false);
    env.clock.t += 500;
    for (let i = 0; i < 8; i++) wheel(-14);
    for (let v = -14 * 0.9; v <= -0.5; v *= 0.9) wheel(v);
    env.flush();
    assert.equal(w.swipe.side, 0, '关上');
    assert.equal(btnOf(w, 'sw-fav') ? btnOf(w, 'sw-fav').hidden : true, true, '收藏没露出来');
  } finally { env.done(); }
});

test('捏合放大着：手指、触控板都不滑卡片（可滑的那层改回 touch-action: auto）；缩回来照常', () => {
  const env = setup();
  const vp = new Element('visualViewport');
  vp.scale = 1;
  globalThis.window.visualViewport = vp;
  try {
    const { main } = env.list();
    const root = globalThis.document.documentElement, w = wrapOf(main, 'a'), card = w.children[0];
    assert.equal(root.classList.contains('sw-zoomed'), false);
    vp.scale = 2;
    for (const fn of vp.events.resize) fn();
    assert.equal(root.classList.contains('sw-zoomed'), true);
    drag(env, linkOf(w), line(300, 100));
    env.flush();
    assert.equal(card.style.transform || '', '');
    assert.equal(gone('a'), false);
    env.clock.t += 500;
    const ev = dispatch(card, 'wheel', { deltaX: 40, deltaY: 0, deltaMode: 0 });
    assert.equal(ev.defaultPrevented, false, '触控板横扫：移动放大的页面');
    vp.scale = 1;
    for (const fn of vp.events.resize) fn();
    assert.equal(root.classList.contains('sw-zoomed'), false);
    env.clock.t += 500;
    drag(env, linkOf(w), line(300, 200));
    env.flush();
    assert.equal(w.swipe.side, -1);
  } finally { env.done(); }
});

test('日历那天的卡片：拖着的时候数据变了也等松手再重画', async () => {
  const env = setup();
  try {
    const main = new Element('main');
    const page = renderCal(main, { name: 'calendar', path: ['cal', '2026-11-04'], pane: 'main' }, env.ctx, { swipe: env.env });
    env.pages.push(page);
    const w = wraps(main)[0];
    drag(env, linkOf(w), line(300, 200), { up: false });
    env.ctx.update('b', { note: '那天下雨' });
    await tick();
    assert.equal(wraps(main)[0], w, '还没重画');
    dispatch(linkOf(w), 'pointerup', P1(200, 300));
    assert.equal(w.swipe.side, -1);
    env.flush();
    await tick();
    assert.notEqual(wraps(main)[0], w, '停好以后重画了');
    assert.equal(wraps(main)[0].swipe.side, 0, '别处改的：关上');
  } finally { env.done(); }
});

test('很长、很快地拖过整张卡片（往左、往右，手指、笔，减少动态效果开 / 关）：松手只是开着，数据一点没变；滑完浏览器补来的 click 也不算', async () => {
  for (const reduce of [false, true]) {
    for (const type of ['touch', 'pen']) {
      const env = setup({ reduce });
      try {
        const { main } = env.list();
        const before = snapshot();
        for (const [id, pts, side] of [
          ['a', line(360, -700, 4), -1],                  // 往左 1060 px、每步 16 ms（16 px/ms 多）
          ['b', line(22, 1100, 3), 1],                    // 往右 1078 px（已经收藏：露出「取消收藏」）
          ['c', [[340, 300], [300, 301], [-900, 296]], -1],   // 一下子甩出去
          ['a', line(30, 900, 5), 1],
        ]) {
          const w = wrapOf(main, id);
          let max = 0;
          dispatch(linkOf(w), 'pointerdown', { pointerId: 3, pointerType: type, clientX: pts[0][0], clientY: pts[0][1], button: 0 });
          for (const [x, y] of pts.slice(1)) {
            env.clock.t += 16;
            dispatch(linkOf(w), 'pointermove', { pointerId: 3, pointerType: type, clientX: x, clientY: y });
            max = Math.max(max, Math.abs(offsetOf(w)));
          }
          assert.ok(max <= Math.round(A * SWIPE.pull), `卡片最多移开 1.5 个按钮宽：${max}`);
          assert.ok(!cls(w, 'sw-armed'));
          dispatch(linkOf(w), 'pointerup', { pointerId: 3, pointerType: type, clientX: pts.at(-1)[0], clientY: pts.at(-1)[1] });
          env.clock.t += 3;
          const ev = dispatch(linkOf(w), 'click', { detail: 1 });
          assert.ok(ev.defaultPrevented, '滑完的 click 不打开条目');
          for (const b of w.children.filter(x => cls(x, 'sw-btn'))) dispatch(b, 'click', { detail: 1 });   // 连按钮也补一个：也吞掉
          assert.equal(w.swipe.side, side, `${id}：开着`);
          assert.equal(offsetOf(w), side * A, '停在一个按钮宽');
          env.flush();
          await tick();
          assert.deepEqual(snapshot(), before, `${id}：数据一点没变`);
          assert.deepEqual(env.toasts, []);
          assert.deepEqual(env.navs, []);
        }
      } finally { env.done(); }
    }
  }
});

test('在露出来的按钮上按下去、拖开再松手（不是点）：不删、不改收藏，浏览器照样给了 click 也不算；手指不动地点一下才算', async () => {
  for (const type of ['touch', 'mouse', 'pen']) {
    const env = setup();
    try {
      const { main } = env.list();
      const w = wrapOf(main, 'b');
      w.swipe.open(-1);
      env.clock.t += 1000;
      const del = btnOf(w, 'sw-del');
      const p = (x, y) => ({ pointerId: 4, pointerType: type, clientX: x, clientY: y, button: 0 });
      dispatch(del, 'pointerdown', p(320, 300));
      for (const x of [310, 290, 250]) { env.clock.t += 16; dispatch(del, 'pointermove', p(x, 302)); }
      dispatch(del, 'pointerup', p(250, 302));
      env.clock.t += 5;
      assert.equal(dispatch(del, 'click', { detail: 1 }).stopped, true);
      env.flush();
      assert.equal(gone('b'), false, `${type}：拖开了不算点`);
      dispatch(del, 'pointerdown', p(320, 300));        // 没有 pointermove，抬起时已经离开 30 px
      dispatch(del, 'pointerup', p(320, 330));
      dispatch(del, 'click', { detail: 1 });
      env.flush();
      assert.equal(gone('b'), false, `${type}：抬起时离开了也不算`);
      dispatch(del, 'pointerdown', p(320, 300));        // 被系统打断
      dispatch(del, 'pointercancel', p(320, 300));
      dispatch(del, 'click', { detail: 1 });
      env.flush();
      assert.equal(gone('b'), false, `${type}：被打断不算`);
      assert.equal(w.swipe.side, -1, '还开着');
      dispatch(del, 'pointerdown', p(320, 300));        // 抖了几 px 的点：算
      env.clock.t += 16; dispatch(del, 'pointermove', p(324, 297));
      env.clock.t += 60; dispatch(del, 'pointerup', p(324, 297));
      dispatch(del, 'click', { detail: 1 });
      env.flush();
      assert.equal(gone('b'), true, `${type}：点了才删`);
    } finally { env.done(); }
  }
});

test('按钮没露着的时候点了不算：正在关上（还看得见）、卡片正被手指拖着、正在滑出去时再点一次', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(300, 200));
    env.flush();
    tap(env, linkOf(w));                                   // 点卡片：关上（有动画，按钮还看得见）
    const del = btnOf(w, 'sw-del');
    assert.equal(del.hidden, false, '还在关上');
    assert.equal(w.swipe.side, 0);
    dispatch(del, 'click', { detail: 0 });                 // 键盘 / 读屏点到了
    dispatch(del, 'click', { detail: 1 });
    env.flush();
    await tick();
    assert.equal(gone('a'), false, '正在关上的按钮：不算');

    w = wrapOf(main, 'a');                                  // 开着，手指又按住卡片在拖：这时候点按钮也不算
    w.swipe.open(-1);
    env.clock.t += 1000;
    drag(env, linkOf(w), line(300, 260, 4), { up: false });
    dispatch(btnOf(w, 'sw-del'), 'click', { detail: 0 });
    dispatch(linkOf(w), 'pointerup', P1(260, 300));
    env.flush();
    await tick();
    assert.equal(gone('a'), false, '拖着的时候：不算');
    assert.equal(w.swipe.side, -1);

    env.clock.t += 1000;                                    // 点了「删除」、正滑出去时再点一次：只删一次
    let removes = 0;
    const rm = env.ctx.remove;
    env.ctx.remove = (id) => { removes++; return rm(id); };
    tap(env, btnOf(w, 'sw-del'));
    dispatch(btnOf(w, 'sw-del'), 'click', { detail: 0 });
    env.flush();
    await tick();
    assert.equal(gone('a'), true);
    assert.equal(removes, 1);
    w = wrapOf(main, 'b');                                  // 收藏：点了、弹回去的时候再点一次：只改一次
    w.swipe.open(1);
    env.clock.t += 1000;
    tap(env, btnOf(w, 'sw-fav'));
    dispatch(btnOf(w, 'sw-fav'), 'click', { detail: 0 });
    env.flush();
    await tick();
    assert.equal(raw('b').fav, false);
    assert.deepEqual(env.toasts.map(x => x.msg), ['已删除这条梦话', '已取消收藏']);
  } finally { env.done(); }
});

const P2 = (x, y, id = 2) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, isPrimary: false });   // 第二根手指

test('两根手指：一根在滑、另一根按在正露出来的按钮上（按多久、哪根先抬起都一样）：不删、不改收藏；之后一根手指点一下照样做', async () => {
  for (const side of [-1, 1]) {
    for (const hold of [0, 100, 800, 1500]) {
      for (const firstUp of [false, true]) {               // true：滑的那根先抬起，按在按钮上的那根接着按着
        const env = setup();
        const rest = async () => { for (let i = 0; i < 3; i++) { env.flush(); await tick(); } };   // 动画、删除都做完
        try {
          const { main } = env.list();
          const w = wrapOf(main, 'a'), before = snapshot();
          const pts = side < 0 ? line(300, 150, 8) : line(40, 190, 8);
          dispatch(linkOf(w), 'pointerdown', P1(...pts[0]));
          for (const p of pts.slice(1)) { await until(env, env.clock.t + 16); dispatch(linkOf(w), 'pointermove', P1(...p)); }
          const b = btnOf(w, side < 0 ? 'sw-del' : 'sw-fav');
          assert.equal(b.hidden, false, '按钮看得见');
          dispatch(b, 'pointerdown', P2(330, 300));
          if (firstUp) dispatch(linkOf(w), 'pointerup', P1(...pts.at(-1)));
          await until(env, env.clock.t + hold);
          dispatch(b, 'pointerup', P2(330, 300));          // 第二根手指一点没动
          env.clock.t += 5;
          dispatch(b, 'click', { detail: 1 });              // 就算浏览器给了 click
          if (!firstUp) { dispatch(linkOf(w), 'pointerup', P1(...pts.at(-1))); env.clock.t += 5; dispatch(b, 'click', { detail: 1 }); }
          await rest();
          const what = `${side < 0 ? '删除' : '收藏'}、按 ${hold} ms、${firstUp ? '滑的那根先抬起' : '按钮上的先抬起'}`;
          assert.deepEqual(snapshot(), before, `${what}：数据一点没变`);
          assert.equal(w.swipe.side, side, `${what}：按位置停住（开着）`);
          dispatch(b, 'click', { detail: 1 });              // 抬起以后 1 秒以内又来一个（不当成读屏：最近抬起的那一下不是点）
          await rest();
          assert.deepEqual(snapshot(), before, `${what}：之后的 click 也不算`);
          await liveTap(env, b, 330, 300);                  // 一根手指点一下：照样做
          await rest();
          if (side < 0) assert.equal(gone('a'), true, what); else assert.equal(raw('a').fav, true, what);
        } finally { env.done(); }
      }
    }
  }
});

test('一根手指拖开以后一直按着不放（4 秒以上），另一根点露出来的「删除」：照样不算；按在按钮上不动、还没抬起就来的 click 也不算（不当成读屏）', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a');
    const pts = line(300, 150, 8);
    dispatch(linkOf(w), 'pointerdown', P1(...pts[0]));
    for (const p of pts.slice(1)) { await until(env, env.clock.t + 16); dispatch(linkOf(w), 'pointermove', P1(...p)); }
    await until(env, env.clock.t + SWIPE.hold + 500);
    const del = btnOf(w, 'sw-del');
    dispatch(del, 'pointerdown', P2(330, 300));
    await until(env, env.clock.t + 800);                     // 按得比「滑完吞掉 click」的 700 ms 还久
    dispatch(del, 'pointerup', P2(330, 300));
    dispatch(del, 'click', { detail: 1 });
    await until(env, env.clock.t + 800);
    assert.equal(gone('a'), false, '另一根还在拖着');
    dispatch(linkOf(w), 'pointerup', P1(...pts.at(-1)));
    await until(env, env.clock.t + 400);
    assert.equal(w.swipe.side, -1, '按位置停住');
    dispatch(del, 'pointerdown', P1(330, 300));
    await until(env, env.clock.t + 1500);
    dispatch(del, 'click', { detail: 1 });
    await until(env, env.clock.t + 800);
    assert.deepEqual([gone('a'), w.swipe.side, cls(w, 'sw-out')], [false, -1, false], '手指还按着：这个 click 不是它的');
    dispatch(del, 'pointerup', P1(330, 300));
    dispatch(del, 'click', { detail: 1 });
    await until(env, env.clock.t + 800);
    assert.equal(gone('a'), true, '抬起来以后的 click 才算');
  } finally { env.done(); }
});

test('一根手指按在露出来的「删除」上不动，另一根在同一张卡片上滑：按着的那根抬起来（隔多久都一样）不算点', async () => {
  for (const gap of [0, 300, 1200, 2500]) {
    const env = setup();
    try {
      const { main } = env.list();
      const w = wrapOf(main, 'b');
      w.swipe.open(-1);
      env.clock.t += 1000;
      const del = btnOf(w, 'sw-del');
      dispatch(del, 'pointerdown', P1(330, 300));
      const pts = line(200, 120, 6);
      dispatch(linkOf(w), 'pointerdown', P2(...pts[0]));
      for (const p of pts.slice(1)) { await until(env, env.clock.t + 16); dispatch(linkOf(w), 'pointermove', P2(...p)); }
      dispatch(linkOf(w), 'pointerup', P2(...pts.at(-1)));
      await until(env, env.clock.t + 400);
      assert.equal(w.swipe.side, -1, '还开着');
      await until(env, env.clock.t + gap);
      dispatch(del, 'pointerup', P1(330, 300));
      env.clock.t += 5;
      dispatch(del, 'click', { detail: 1 });
      await until(env, env.clock.t + 800);
      assert.equal(gone('b'), false, `隔 ${gap} ms`);
      await liveTap(env, del, 330, 300);
      await until(env, env.clock.t + 800);
      assert.equal(gone('b'), true, `隔 ${gap} ms：之后点一下照样删`);
    } finally { env.done(); }
  }
});

test('漏了抬起（浏览器没给 pointerup）：之后的点照样算，不会一直当成「两根手指」', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a');
    dispatch(byCls(main, 'list-body') || main, 'pointerdown', { pointerId: 30, pointerType: 'touch', clientX: 200, clientY: 50, button: 0, isPrimary: true });   // 卡片外面按下，抬起丢了
    w.swipe.open(-1);
    env.clock.t += 100;
    await liveTap(env, btnOf(w, 'sw-del'), 330, 300);       // 新的第一根手指（isPrimary）：上一根肯定已经抬起了
    await until(env, env.clock.t + 800);
    assert.equal(gone('a'), true, '同一种里的第一根：上一根不算按着');
    const b = wrapOf(main, 'b');
    dispatch(main, 'pointerdown', { pointerId: 31, pointerType: 'pen', clientX: 200, clientY: 50, button: 0 });   // 不说是不是第一根：按了 4 秒以上就不算按着了
    b.swipe.open(-1);
    env.clock.t += SWIPE.hold + 100;
    const del = btnOf(b, 'sw-del');
    dispatch(del, 'pointerdown', { pointerId: 32, pointerType: 'touch', clientX: 330, clientY: 300, button: 0 });
    env.clock.t += 60;
    dispatch(del, 'pointerup', { pointerId: 32, pointerType: 'touch', clientX: 330, clientY: 300, button: 0 });
    dispatch(del, 'click', { detail: 1 });
    await until(env, env.clock.t + 800);
    assert.equal(gone('b'), true);
  } finally { env.done(); }
});

test('接着一张张删：手指按在 B 的「删除」上时 A 的删除落下来——重画等手指抬起（按钮不在手指底下换掉），这一下照样删掉 B；click 先来、重画先来都一样', async () => {
  let waited = 0;
  for (const order of ['click-first', 'redraw-first']) {
    for (const wait of [0, 40, 80, 120, 160, 200, 240, 280, 320]) {
      const env = setup();
      try {
        const { main } = env.list();
        const wa = wrapOf(main, 'a');
        wa.swipe.open(-1);
        env.clock.t += 1000;
        await liveTap(env, btnOf(wa, 'sw-del'), 330, 300);
        await liveDrag(env, linkOf(wrapOf(main, 'b')), line(300, 180, 5));
        await until(env, env.clock.t + wait);
        const wb = wrapOf(main, 'b'), del0 = btnOf(wb, 'sw-del');
        assert.equal(wb.swipe.side, -1);
        const aBefore = gone('a');
        dispatch(del0, 'pointerdown', P1(330, 300));
        await until(env, env.clock.t + 90);
        if (!aBefore && gone('a')) {                          // A 的删除正好在按着的时候落下来
          waited++;
          assert.equal(wrapOf(main, 'b'), wb, '按着的时候不重画');
        }
        const del1 = btnOf(wrapOf(main, 'b'), 'sw-del');
        dispatch(del1, 'pointerup', P1(330, 300));
        if (order === 'redraw-first') await until(env, env.clock.t + 16);   // 触屏：click 晚一点来，等着的重画先做了
        const now = btnOf(wrapOf(main, 'b'), 'sw-del');
        dispatch(order === 'redraw-first' ? now : del1, 'click', { detail: 1 });   // click 落在手指底下现在的那个按钮上
        await until(env, env.clock.t + 800);
        assert.deepEqual([gone('a'), gone('b')], [true, true], `${order}、隔 ${wait} ms`);
        assert.equal(raw('b').fav, true, '⭐ 没被点到');
      } finally { env.done(); }
    }
  }
  assert.ok(waited >= 2, `A 的删除落在按着的时候：${waited} 次`);
});

test('按着「删除」的时候列表还是重画了（按了 4 秒以上）：新画的同一张同一边还开着 → 抬起来点的算；别处改了数据（重画以后关上）→ 不算', async () => {
  {
    const env = setup();
    try {
      const { main } = env.list();
      const wa = wrapOf(main, 'a');
      wa.swipe.open(-1);
      env.clock.t += 1000;
      await liveTap(env, btnOf(wa, 'sw-del'), 330, 300);
      await liveDrag(env, linkOf(wrapOf(main, 'b')), line(300, 180, 5));
      await until(env, env.clock.t + 300);
      const wb = wrapOf(main, 'b'), del0 = btnOf(wb, 'sw-del');
      dispatch(del0, 'pointerdown', P1(330, 300));
      await until(env, env.clock.t + SWIPE.hold + 600);       // A 的删除落下来，重画等到 4 秒（保险）照样画了
      assert.equal(gone('a'), true);
      const wb2 = wrapOf(main, 'b'), del1 = btnOf(wb2, 'sw-del');
      assert.notEqual(wb2, wb, '重画了');
      assert.equal(wb2.swipe.side, -1, '自己删除引起的重画：照样开着');
      dispatch(del1, 'pointerup', P1(330, 300));
      env.clock.t += 5;
      dispatch(del1, 'click', { detail: 1 });
      await until(env, env.clock.t + 800);
      assert.equal(gone('b'), true, '按的是同一张的同一个按钮');
    } finally { env.done(); }
  }
  {
    const env = setup();
    try {
      const { main } = env.list();
      const wb = wrapOf(main, 'b');
      wb.swipe.open(-1);
      env.clock.t += 1000;
      const del0 = btnOf(wb, 'sw-del');
      dispatch(del0, 'pointerdown', P1(330, 300));
      env.ctx.update('c', { note: '同步进来的' });               // 别处改了数据
      await until(env, env.clock.t + 80);
      assert.equal(wrapOf(main, 'b'), wb, '按着的时候不重画');
      dispatch(del0, 'pointerup', P1(330, 300));
      await until(env, env.clock.t + 16);                       // 抬起以后重画：别处改的 → 关上
      const wb2 = wrapOf(main, 'b');
      assert.notEqual(wb2, wb);
      for (const b of [btnOf(wb2, 'sw-del'), del0].filter(Boolean)) dispatch(b, 'click', { detail: 1 });
      await until(env, env.clock.t + 800);
      assert.equal(gone('b'), false, '重画以后关上了：不算');
      assert.equal(wb2.swipe.side, 0);
    } finally { env.done(); }
  }
});

test('触控板惯性还没停就点露出来的「删除」：手放回触控板惯性就停了，按位置停好，第一下点就算；停在关上的那边（扫得太少、往回扫）不算', async () => {
  const mouse = (b, type) => dispatch(b, type, { pointerId: 1, pointerType: 'mouse', clientX: 330, clientY: 300, button: 0, isPrimary: true });
  const wheelOn = (env, w, dxs) => { for (const dx of dxs) { env.clock.t += 16; dispatch(w.children[0], 'wheel', { deltaX: dx, deltaY: 0, deltaMode: 0 }); } };
  for (const [what, setupCard, dxs, want] of [
    ['猛扫开（惯性还在来）', null, [8, 30, 30, 30, 30, 20, 12], true],
    ['只扫了一点点', null, [8, 14], false],
    ['开着的往回扫', -1, [-8, -30, -10], false],
  ]) {
    for (const after of [0, 16, 80]) {
      const env = setup();
      try {
        const { main } = env.list();
        const w = wrapOf(main, 'a');
        if (setupCard) { w.swipe.open(setupCard); env.clock.t += 1000; }
        wheelOn(env, w, dxs);
        const del = btnOf(w, 'sw-del');
        assert.equal(del.hidden, false, `${what}：看得见`);
        env.clock.t += after;                                   // 还不到 wheelGap：这一下还没扫完
        mouse(del, 'pointerdown');
        assert.equal(w.swipe.side, want ? -1 : 0, `${what}：按下去就停好`);
        env.clock.t += 90;
        mouse(del, 'pointerup');
        dispatch(del, 'click', { detail: 1 });
        env.flush();
        await tick();
        assert.equal(gone('a'), want, `${what}、最后一下以后 ${after} ms 点`);
      } finally { env.done(); }
    }
  }
});

test('笔、鼠标点了「删除」抬起以后悬着移开（还没来 click）：照样算；按着的时候移开才不算', async () => {
  for (const type of ['pen', 'mouse']) {
    for (const hover of [0, 6, 14, 30]) {
      const env = setup();
      try {
        const { main } = env.list();
        const w = wrapOf(main, 'b');
        w.swipe.open(-1);
        env.clock.t += 1000;
        const del = btnOf(w, 'sw-del');
        const p = (x, y) => ({ pointerId: 6, pointerType: type, clientX: x, clientY: y, button: 0, isPrimary: true });
        dispatch(del, 'pointerdown', p(320, 300));
        env.clock.t += 60;
        dispatch(del, 'pointerup', p(320, 300));
        dispatch(del, 'pointermove', p(320 + hover, 300 - hover / 2));   // 悬着（同一个 pointerId）
        env.clock.t += 5;
        dispatch(del, 'click', { detail: 1 });
        env.flush();
        await tick();
        assert.equal(gone('b'), true, `${type} 悬着移开 ${hover} px`);
      } finally { env.done(); }
    }
  }
});

test('滑开以后浏览器补来的 click 一个都不放过（不只第一个）：卡片、⭐ 都不触发；下一次按下以后照常', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(300, 200), { rest: 0 });
    for (const el of [linkOf(w), linkOf(w), byCls(w, 'c-body'), byCls(w, 'fav-btn')]) {
      env.clock.t += 40;
      const ev = dispatch(el, 'click', { detail: 1 });
      assert.ok(ev.defaultPrevented && ev.stopped, '吞掉');
    }
    assert.equal(raw('a').fav, false, '⭐ 没被点到');
    assert.deepEqual(env.navs, []);
    env.flush();
    assert.equal(w.swipe.side, -1);
    w.swipe.close();
    assert.equal(tap(env, linkOf(w)).defaultPrevented, false, '关上以后点一下：照常打开');
  } finally { env.done(); }
});

// ---------- 乱来的手势：几千串手势打在真的列表、日历上，只有点了露出来的按钮才会删除、收藏 ----------
/** 可重复的随机数（同一个种子同一串；出错时消息里带着种子和最后几步） */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const drain = () => new Promise(r => setImmediate(r));    // 微任务（数据变了以后的重画）都跑完
/** 都在同一天：列表、日历那天都有好几张 */
const FUZZ = [
  { id: 'a', date: '2026-11-04', time: '04:58', text: `${NN}“今天吃什么”` },
  { id: 'b', date: '2026-11-04', time: '03:10', text: `${NN}“馄饨..”`, fav: true },
  { id: 'c', date: '2026-11-04', time: '02:40', status: 'inbox', text: '' },
  { id: 'd', date: '2026-11-04', time: '01:20', text: `${NN}“小狗呢”`, audio: [{ sha256: 'd'.repeat(64), mime: 'audio/mp4', durationSec: 9 }] },
  { id: 'e', date: '2026-11-04', time: '00:05', text: `${NN}“不要不要”`, fav: true },
];
const sideOf = (b) => (cls(b, 'sw-l') ? 1 : -1);
/** b 是 old（已经被重画掉的按钮）那张卡片新画的同一个按钮（同一条、同一边） */
const redrawnOf = (b, old) => !!old && cls(old, 'sw-btn') && !!old.parent && !!b.parent && old.parent !== b.parent && old.parent.children[0].dataset.id === b.parent.children[0].dataset.id && sideOf(old) === sideOf(b);
/** 这个按钮现在露着（还在页面上、那一边开着、没藏、卡片没在滑出去） */
const revealed = (b, main) => !!b && cls(b, 'sw-btn') && !b.hidden && !!b.parent && wraps(main).includes(b.parent) && !cls(b.parent, 'sw-out') && b.parent.swipe.side === sideOf(b);

/**
 * 一段「使用」：随机的手势一串接一串。withTaps = false：只有手势（还有手势以后浏览器可能补来的 click）——一次删除、收藏都不许有；
 * withTaps = true：中间夹着真的点露出来的按钮（手指不动地点、键盘 Enter），每次删除、收藏都要对得上前面的一次点。
 */
async function fuzzSession(seed, withTaps, stats) {
  const R = rng(seed);
  const pick = (xs) => xs[Math.floor(R() * xs.length)];
  const between = (lo, hi) => lo + R() * (hi - lo);
  let reduce = R() < 0.3;
  const env = setup({ reduce: () => reduce, entries: FUZZ });
  const log = [];
  const fail = (msg) => { throw new assert.AssertionError({ message: `种子 ${seed}：${msg}\n最后几步：\n` + log.slice(-30).join('\n') }); };
  const editing = R() < 0.15 ? pick(FUZZ).id : null;          // 双栏：右栏正在改这条（不给删除）
  if (editing) Object.defineProperty(env.ctx, 'route', { get: () => ({ name: 'editor', id: editing, sub: 'edit' }) });
  const expect = snapshot();
  const tokens = [];                                            // 点了露出来的按钮：{ id, kind, t }
  const orig = { remove: env.ctx.remove, update: env.ctx.update };
  const spend = (id, kind) => {
    const i = tokens.findIndex(x => x.id === id && x.kind === kind && env.clock.t - x.t <= 3000);
    if (i < 0) fail(`${kind === 'del' ? 'ctx.remove' : 'ctx.update({ fav })'}(${id}) 不是点了露出来的按钮引起的`);
    tokens.splice(i, 1);
    stats.acted++;
  };
  env.ctx.remove = (id) => { spend(id, 'del'); const r = orig.remove(id); if (r) expect[id].deleted = true; return r; };
  env.ctx.update = (id, patch, opts) => { if (patch && 'fav' in patch) { spend(id, 'fav'); expect[id].fav = !!patch.fav; } return orig.update(id, patch, opts); };

  let main, page;
  if (R() < 0.25) {
    main = new Element('main');
    page = renderCal(main, { name: 'calendar', path: ['cal', '2026-11-04'], pane: 'main' }, env.ctx, { swipe: env.env });
    env.pages.push(page);
  } else ({ main, page } = env.list(editing ? { pane: 'list', selected: editing } : {}));
  globalThis.document.body.append(main);                       // 滚动时往上找得到 <html>

  /** 每一步以后：没有「要直接做了」的样子、卡片最多移开 1.5 个按钮宽、数据只按点过的按钮变 */
  const check = (what) => {
    for (const w of wraps(main)) {
      if (cls(w, 'sw-armed')) fail(`${what}：出现了 sw-armed`);
      if (!cls(w, 'sw-out') && Math.abs(offsetOf(w)) > Math.round(A * SWIPE.pull)) fail(`${what}：卡片移开了 ${offsetOf(w)} px`);
    }
    const now = snapshot();
    for (const id of Object.keys(expect)) if (now[id].fav !== expect[id].fav || now[id].deleted !== expect[id].deleted) fail(`${what}：${id} 的数据变了 ${JSON.stringify(now[id])}，应该是 ${JSON.stringify(expect[id])}`);
  };
  const ev = (target, type, props) => { dispatch(target, type, props); check(type); };
  /** 时间往前走：像浏览器那样一个计时器一个计时器地跑，每个之后把微任务（重画）跑完 */
  const adv = async (ms) => {
    const end = env.clock.t + ms;
    for (;;) {
      env.timers.sort((x, y) => x.at - y.at);
      const x = env.timers[0];
      if (!x || x.at > end) break;
      env.timers.shift();
      env.clock.t = Math.max(env.clock.t, x.at);
      x.fn();
      await drain();
      check('计时器');
    }
    env.clock.t = Math.max(env.clock.t, end);
    await drain();
    check('时间');
  };
  /** 点一下按钮（会不会算，由当时露没露着决定）：算的话记一张「票」，之后的删除 / 收藏要用掉一张 */
  const clickBtn = (b, detail) => {
    if (revealed(b, main)) {
      tokens.push({ id: b.parent.children[0].dataset.id, kind: sideOf(b) > 0 ? 'fav' : 'del', t: env.clock.t });
      stats.taps++;
    }
    ev(b, 'click', { detail });
  };
  const btns = () => wraps(main).flatMap(w => w.children.filter(x => cls(x, 'sw-btn')));
  /** 手势从哪儿开始：卡片上的各处（链接、正文、⭐、▶、按钮、外层）或者卡片外面 */
  const target = () => {
    const ws = wraps(main);
    if (!ws.length || R() < 0.06) return main;
    const w = R() < 0.4 ? (ws.find(x => x.swipe.side) || pick(ws)) : pick(ws);
    return pick([linkOf(w), linkOf(w), w.children[0], byCls(w, 'c-body'), byCls(w, 'fav-btn'), byCls(w, 'player-btn'), w, ...w.children.filter(x => cls(x, 'sw-btn'))].filter(Boolean));
  };
  const noClick = (el) => !el || !!el.closest('.fav-btn') || !!el.closest('.player-btn');   // ⭐ ▶ 不在这里补 click（它们自己的点按不归滑动管）

  /** 浏览器（一般不会，这里故意）给第二根手指补的 click：落在它按的地方，或者随便哪个看得见的按钮上（露着的也点：两根手指同时按着的哪一根都不算点） */
  const strayClicks = (el2) => {
    for (let k = 0; k < 2 && R() < 0.6; k++) {
      env.clock.t += Math.floor(R() * 20);
      const b = R() < 0.6 ? el2 : pick(btns().filter(x => !x.hidden));
      if (!b || noClick(b)) continue;
      log.push(`第二根手指的 click ${b.tag}.${b.className || b.attrs.class || ''}${revealed(b, main) ? '（露着的）' : ''}`);
      ev(b, 'click', { detail: 1 });
    }
  };
  /** 一下手指 / 笔 / 鼠标：按下、一串移动、抬起或者被打断；可能再来第二根手指；之后浏览器可能补 click */
  async function gesture() {
    const kind = pick(['h', 'h', 'h', 'fling', 'long', 'diag', 'v', 'zig', 'edge', 'hold', 'tiny', 'multi', 'multi', 'rest']);
    const type = pick(['touch', 'touch', 'touch', 'pen', 'mouse']);
    const id = 1 + Math.floor(R() * 3);
    const shown = btns().filter(x => !x.hidden);
    const el = kind === 'rest' && shown.length && R() < 0.7 ? pick(shown) : target();   // rest：一根手指按着不动（多半按在看得见的按钮上），另一根在同一张卡片上滑
    const x0 = kind === 'edge' ? between(0, 19.9) : between(5, 370), y0 = between(100, 700);
    const sgn = R() < 0.5 ? -1 : 1;
    let pts = [];
    const n = 1 + Math.floor(R() * 12);
    const seg = (dx, dy, k) => { const [x, y] = pts.at(-1) || [x0, y0]; for (let i = 1; i <= k; i++) pts.push([x + (dx * i) / k + between(-2, 2), y + (dy * i) / k + between(-2, 2)]); };
    if (kind === 'h') seg(sgn * between(5, 260), between(-30, 30), n);
    else if (kind === 'fling') seg(sgn * between(30, 260), between(-40, 40), 1 + Math.floor(R() * 3));
    else if (kind === 'long') seg(sgn * between(343, 1400), between(-60, 60), n);
    else if (kind === 'diag') { const ang = between(15, 80) * Math.PI / 180, L = between(30, 700); seg(sgn * L * Math.cos(ang), pick([-1, 1]) * L * Math.sin(ang), n); }
    else if (kind === 'v') seg(between(-20, 20), pick([-1, 1]) * between(15, 600), n);
    else if (kind === 'zig') { for (let k = 0; k < 2 + Math.floor(R() * 4); k++) seg((k % 2 ? -sgn : sgn) * between(40, 400), between(-20, 20), 1 + Math.floor(R() * 4)); }
    else if (kind === 'edge') seg(between(20, 500), between(-20, 20), n);
    else if (kind === 'hold') seg(sgn * between(20, 300), between(-10, 10), n);
    else if (kind === 'tiny') seg(between(-7, 7), between(-7, 7), Math.floor(R() * 3));
    else if (kind === 'rest') seg(between(-4, 4), between(-4, 4), 1 + Math.floor(R() * 2));
    else seg(sgn * between(20, 300), between(-20, 20), n);
    const dt = pick([2, 6, 12, 16, 16, 33]);
    const P = (x, y, pid = id) => ({ pointerId: pid, pointerType: type, clientX: x, clientY: y, button: type === 'mouse' && R() < 0.1 ? 2 : 0, isPrimary: pid === id });
    log.push(`${kind} ${type} #${id} 在 ${el.tag}.${el.className || el.attrs.class || ''} ${JSON.stringify(pts.map(([x, y]) => [Math.round(x), Math.round(y)]))} 每步 ${dt} ms`);
    // 这一下算不算「手指不动地点了按钮」（只有这种之后的 click 才可能做）
    let still = true, two = false, cancelled = false, second = null;
    /** 第二根手指抬起（或者被打断）：按了 hold 那么久；不动的那种抬起时还在原地 */
    const liftSecond = async () => {
      const s2 = second;
      second = null;
      await adv(s2.hold);
      const [ux, uy] = s2.still ? [s2.x + between(-3, 3), s2.y + between(-3, 3)] : [between(30, 360), between(100, 700)];
      ev(s2.el, R() < 0.8 ? 'pointerup' : 'pointercancel', P(ux, uy, s2.pid));
      strayClicks(s2.el);
    };
    const near = ([x, y]) => Math.abs(x - x0) < SWIPE.slop && Math.abs(y - y0) < SWIPE.slop;
    ev(el, 'pointerdown', P(x0, y0));
    for (let i = 0; i < pts.length; i++) {
      if (R() < 0.7) await adv(dt); else env.clock.t += dt;   // 有时候计时器晚到（主线程忙）
      if (!near(pts[i])) still = false;
      ev(el, 'pointermove', P(...pts[i]));
      if (type === 'touch' && R() < 0.3) ev(el, 'touchmove', {});
      if (kind === 'multi' && i === Math.floor(pts.length / 2)) {       // 第二根手指（捏合、手掌、一根在滑另一根按在按钮上）
        two = true;
        const vis = btns().filter(x => !x.hidden);
        const el2 = vis.length && R() < 0.5 ? pick(vis) : target();
        second = { el: el2, pid: id + 10, x: between(30, 360), y: between(100, 700), still: R() < 0.6, hold: pick([0, 16, 100, 800, 1500]), late: R() < 0.4 };
        log.push(`第二根手指在 ${el2.tag}.${el2.className || el2.attrs.class || ''}${revealed(el2, main) ? '（露着的）' : ''} ${second.still ? '不动' : '会动'}、按 ${second.hold} ms${second.late ? '、比第一根晚抬起' : ''}`);
        ev(el2, 'pointerdown', P(second.x, second.y, second.pid));
        if (!second.still) ev(el2, 'pointermove', P(between(30, 360), between(100, 700), second.pid));
        if (!second.late) await liftSecond();
      }
      if (kind === 'rest' && i === 0) {                                // 另一根手指在同一张卡片上横着滑
        two = true;
        const w = (el.closest && el.closest('.swipe')) || pick(wraps(main));
        const on = w ? pick([linkOf(w), w.children[0]].filter(Boolean)) : main;
        const pid = id + 20, sx = between(60, 330), sy = between(100, 700), dx = (R() < 0.5 ? -1 : 1) * between(30, 400), k = 2 + Math.floor(R() * 8);
        log.push(`另一根手指在 ${on.tag} 上横着滑 ${Math.round(dx)} px`);
        ev(on, 'pointerdown', P(sx, sy, pid));
        for (let j = 1; j <= k; j++) { await adv(dt); ev(on, 'pointermove', P(sx + (dx * j) / k, sy + between(-4, 4), pid)); }
        ev(on, R() < 0.85 ? 'pointerup' : 'pointercancel', P(sx + dx, sy, pid));
        strayClicks(on);
        await adv(pick([100, 300, 1200, 2000]));                         // 按着的那根接着按了一会儿
      }
    }
    if (kind === 'hold') await adv(pick([300, 1200, 4500]));            // 按着不放（等着的重画到了 4 秒照样画）
    else if (kind === 'rest') await adv(pick([0, 60]));
    else await adv(pick([0, 0, 0, 10, 60, 150, 400]));
    const end = pts.at(-1) || [x0, y0];
    if (!near(end)) still = false;
    if (R() < 0.12) { cancelled = true; ev(el, 'pointercancel', P(...end)); } else ev(el, 'pointerup', P(...end));
    if (type !== 'touch' && R() < 0.3) {                               // 笔、鼠标抬起以后悬着移动（同一个 pointerId）：不影响刚才那一下算不算点
      const hx = between(-40, 40), hy = between(-40, 40);
      log.push(`抬起以后悬着移动 ${Math.round(hx)}, ${Math.round(hy)}`);
      ev(el, 'pointermove', P(end[0] + hx, end[1] + hy));
    }
    if (R() < 0.2) await adv(0);                                       // click 晚一点来：等着的重画可能先做了（按钮换成新画的）
    // 浏览器可能补来的 click：落在按下去的地方，或者（故意捣乱）落在随便哪个看得见的按钮上，可能不止一个
    for (let k = 0; k < 3 && R() < 0.6; k++) {
      env.clock.t += Math.floor(R() * 20);
      const onBtn = R() < 0.5;
      const b = onBtn ? pick(btns().filter(x => !x.hidden)) : el;
      if (!b || (!onBtn && noClick(b))) continue;
      const tapOnIt = still && !two && !cancelled && cls(b, 'sw-btn') && (b.contains(el) || redrawnOf(b, el));   // 真的是在这个按钮上手指不动地点了一下
      if (tapOnIt && revealed(b, main) && !withTaps) continue;                                   // 只有手势的那几段：不点真的
      log.push(`click ${b.tag}.${b.className || b.attrs.class || ''}${tapOnIt ? '（点了一下）' : ''}`);
      if (tapOnIt) clickBtn(b, 1); else ev(b, 'click', { detail: 1 });
    }
    if (second) await liftSecond();
  }
  /** 触控板：一串 wheel（手指那段 + 惯性），可能横、可能竖、可能中途停一下 */
  async function wheel() {
    const ws = wraps(main);
    if (!ws.length) return;
    const w = pick(ws);
    const el = pick([w.children[0], linkOf(w), byCls(w, 'c-body'), ...w.children.filter(x => cls(x, 'sw-btn'))].filter(Boolean));
    const mode = R() < 0.15 ? 1 : 0, k = mode ? 1 / 16 : 1;
    let vx = (R() < 0.5 ? -1 : 1) * between(1, 60), vy = R() < 0.3 ? between(-40, 40) : between(-3, 3);
    const n = 1 + Math.floor(R() * 12), decay = between(0.8, 0.97);
    log.push(`wheel 在 ${el.tag} vx ${vx.toFixed(1)} vy ${vy.toFixed(1)} ×${n} 衰减 ${decay.toFixed(2)}`);
    for (let i = 0; i < n + 60 && (Math.abs(vx) >= 0.5 || Math.abs(vy) >= 0.5); i++) {
      env.clock.t += pick([8, 16, 16, 17]);
      if (R() < 0.03) await adv(SWIPE.wheelGap + 50);                  // 停了一下：算新的一下
      ev(el, 'wheel', { deltaX: vx * k, deltaY: vy * k, deltaMode: mode });
      if (i >= n) { vx *= decay; vy *= decay; }
      if (R() < 0.2) await drain();
    }
    if (R() < 0.3) {                                                   // 扫完马上（惯性可能还没停）用鼠标点了一下看得见的按钮
      const b = pick(btns().filter(x => !x.hidden));
      if (b) {
        log.push('扫完点按钮');
        const m = { pointerId: 7, pointerType: 'mouse', clientX: 300, clientY: 300, button: 0, isPrimary: true };
        ev(b, 'pointerdown', m);                                       // 按下去：这一下扫完了，按位置停好
        ev(b, 'pointerup', m);
        if (revealed(b, main) && !withTaps) log.push('（停在了按钮这边：只有手势的那几段不点）');   // 那就是真的点了露出来的按钮
        else clickBtn(b, 1);
      }
    }
  }
  /** 真的点露出来的按钮（只在 withTaps 的那几段）：手指不动（抖几 px），或者键盘 Enter */
  async function realTap() {
    if (R() < 0.6) await adv(between(150, 400));                          // 多半是看清楚了才点（触控板的惯性、动画都停了）
    const b = pick(btns().filter(x => revealed(x, main)));
    if (!b) return;
    const type = pick(['touch', 'mouse', 'pen']), x = 320, y = 300;
    log.push(`点 ${b.className || b.attrs.class} (${b.parent.children[0].dataset.id}) ${type}`);
    if (R() < 0.25) { b.focus(); clickBtn(b, 0); return; }              // 键盘
    ev(b, 'pointerdown', { pointerId: 5, pointerType: type, clientX: x, clientY: y, button: 0 });
    if (R() < 0.5) { env.clock.t += 16; ev(b, 'pointermove', { pointerId: 5, pointerType: type, clientX: x + between(-6, 6), clientY: y + between(-6, 6) }); }
    await adv(pick([20, 60, 120]));
    ev(b, 'pointerup', { pointerId: 5, pointerType: type, clientX: x + between(-3, 3), clientY: y + between(-3, 3) });
    if (type !== 'touch' && R() < 0.3) ev(b, 'pointermove', { pointerId: 5, pointerType: type, clientX: x + between(-40, 40), clientY: y + between(-40, 40) });   // 抬起以后悬着移开
    env.clock.t += 5;
    clickBtn(b, 1);
  }

  try {
    const steps = 20 + Math.floor(R() * 30);
    for (let i = 0; i < steps; i++) {
      const r = R();
      if (r < 0.55) await gesture();
      else if (r < 0.68) await wheel();
      else if (r < 0.78 && withTaps) await realTap();
      else if (r < 0.80) { log.push('Esc'); ev(globalThis.document, 'keydown', { key: 'Escape' }); }
      else if (r < 0.83) { log.push('滚动'); globalThis.document.documentElement.scrollTop = Math.round(between(0, 400)); ev(globalThis.window, 'scroll', {}); }
      else if (r < 0.87) {                                              // 别处改了数据（同步进来）：列表重画
        const live = Object.keys(expect).filter(id => !expect[id].deleted);
        if (live.length) { const id = pick(live); log.push(`别处改了 ${id}`); orig.update(id, { note: '改 ' + i }); }
      } else if (r < 0.90) { reduce = !reduce; log.push(`减少动态效果 ${reduce}`); }
      else if (r < 0.93) {                                              // 截图、测试用的 API：只是露出 / 收起按钮
        const ws = wraps(main);
        if (ws.length) { const w = pick(ws), s = pick([1, -1, 0]); log.push(`swipe.open(${s})`); if (s) w.swipe.open(s); else w.swipe.close(); check('open'); }
      } else if (r < 0.96 && !withTaps) {                               // 键盘点到正在关上（还看得见、没露着）的按钮
        const b = pick(btns().filter(x => !x.hidden && !revealed(x, main)));
        if (b) { log.push('键盘点没露着的按钮'); clickBtn(b, 0); }
      } else { const ms = pick([16, 100, 300, 800, 2000]); log.push(`等 ${ms} ms`); await adv(ms); }
      stats.steps++;
    }
    await adv(1000);
    page.cleanup();                                                    // 离开页面：等着动画的删除、收藏马上做完
    env.pages.length = 0;
    check('离开页面');
    env.flush(10000);
    check('离开页面以后');
    if (!withTaps && stats.acted) fail('只有手势的时候删除、收藏了');
  } finally { env.done(); }
}

test('几千串乱来的手势（按下 / 移动 / 抬起 / 打断、甩、拖过整张卡片、斜着、竖着、来回、左边缘、按着不放、第二根手指、鼠标、笔、触控板连扫、减少动态效果开关、重画）：从来不删、不改收藏；只有点了露出来的按钮才做', { timeout: 120000 }, async () => {
  const only = { steps: 0, taps: 0, acted: 0 };
  for (let k = 0; k < 90; k++) await fuzzSession(1000 + k, false, only);
  assert.ok(only.steps >= 2500, String(only.steps));
  assert.equal(only.acted, 0);

  const mixed = { steps: 0, taps: 0, acted: 0 };
  for (let k = 0; k < 60; k++) await fuzzSession(5000 + k, true, mixed);
  assert.ok(mixed.steps >= 1500, String(mixed.steps));
  assert.ok(mixed.taps >= 100 && mixed.acted >= mixed.taps * 0.6, `点了 ${mixed.taps} 次露出来的按钮，做了 ${mixed.acted} 次`);   // 真的点按钮照样好用（不是什么都不做才「通过」）
});
