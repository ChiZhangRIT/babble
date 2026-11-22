// 列表、日历那天的卡片左右滑（src/ui/swipe.js 接到 views/list.js 的 entryCard 上）：最小 DOM + 真的 state.js，事件按捕获 → 冒泡派发。
//   往左滑露出「删除」、往右滑露出「收藏」；点按钮做、一口气滑过去直接做（删除 = 进「最近删除」+ 同详情页一样的「撤销」提示）；
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
function setup({ reduce = false, entries = null } = {}) {
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
    now: () => clock.t, width: () => W, reduceMotion: () => reduce,
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

test('一口气往左滑过卡片宽度的 55%：直接删（同样能撤销）；甩得快也行；慢慢拉一点只是打开', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    let w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(320, 320 - 220, 10), { up: false });
    assert.ok(cls(w, 'sw-armed'), '到了直接做的距离');
    assert.equal(w.children[0].style.transform, 'translateX(-220px)', '卡片追上手指');
    dispatch(linkOf(w), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    env.clock.t += 5;
    assert.ok(dispatch(linkOf(w), 'click').defaultPrevented, '滑完松手不算点（不打开条目）');
    assert.equal(env.navs.length, 0);
    env.flush();
    assert.equal(gone('a'), true);
    assert.equal(env.toasts.at(-1).msg, '已删除这条梦话');
    await tick();
    env.toasts.at(-1).action.run();
    await tick();
    assert.equal(gone('a'), false, '撤销');

    w = wrapOf(main, 'b');                        // 甩：140 px、很快
    drag(env, linkOf(w), line(300, 160, 4), { rest: 0 });
    env.flush();
    assert.equal(gone('b'), true);
    await tick();

    w = wrapOf(main, 'c');                        // 慢慢拉 150 px：橡皮筋，松手只是开着
    drag(env, linkOf(w), line(300, 150, 6));
    env.flush();
    assert.equal(gone('c'), false);
    assert.equal(w.swipe.side, -1);
  } finally { env.done(); }
});

test('往右滑露出「收藏」：点了收藏、卡片弹回去；一口气滑过去直接改；已经收藏的是「取消收藏」', async () => {
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

    w = wrapOf(main, 'b');                        // 已经收藏：一口气往右滑过去 → 取消收藏，弹「撤销」
    drag(env, linkOf(w), line(60, 290, 10));
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

test('「减少动态效果」：不做动画，点删除马上删；离开页面时等着动画的删除照样做完', async () => {
  const env = setup({ reduce: true });
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a');
    drag(env, linkOf(w), line(300, 200));
    assert.ok(!cls(w, 'sw-anim'));
    assert.deepEqual(env.timers, []);
    tap(env, btnOf(w, 'sw-del'));
    assert.equal(gone('a'), true);
    assert.deepEqual(env.timers, []);
  } finally { env.done(); }

  const env2 = setup();
  try {
    const { main, page } = env2.list();
    drag(env2, linkOf(wrapOf(main, 'b')), line(320, 80, 10));
    assert.equal(gone('b'), false);
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

test('双栏：右栏正看着的那条滑掉 → 右栏回到「呓语」（同详情页删除）；动画期间已经点去别的条目了就不跳回去', () => {
  const env = setup();
  let route = { name: 'entry', id: 'a' };
  Object.defineProperty(env.ctx, 'route', { get: () => route });
  try {
    const { main, page } = env.list({ pane: 'list', selected: 'a' });
    drag(env, linkOf(wrapOf(main, 'a')), line(320, 80, 10));
    env.flush();
    assert.equal(gone('a'), true);
    assert.deepEqual(env.navs, ['/ (replace)']);
    page.cleanup();
    env.pages.length = 0;

    route = { name: 'entry', id: 'b' };
    const two = env.list({ pane: 'list', selected: 'b' });
    drag(env, linkOf(wrapOf(two.main, 'b')), line(320, 80, 10));
    route = { name: 'entry', id: 'c' };                     // 滑出去的时候点了另一条：换页、清理时把删除做完
    two.page.cleanup();
    env.pages.length = 0;
    assert.equal(gone('b'), true);
    assert.deepEqual(env.navs, ['/ (replace)'], '不再跳回「呓语」');
  } finally { env.done(); }
});

test('拖着的时候数据变了：等松手、卡片停好再重画（手底下的卡片不换掉）；一直按着不放最多等 4 秒', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const old = wrapOf(main, 'a');
    drag(env, linkOf(old), line(300, 200), { up: false });
    env.ctx.update('c', { note: '那天下雨' });
    await tick();
    assert.equal(wrapOf(main, 'a'), old, '还没重画');
    env.clock.t += 16;
    dispatch(linkOf(old), 'pointermove', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    dispatch(linkOf(old), 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    assert.equal(wrapOf(main, 'a'), old, '删除的动画还没做完：还不重画');
    env.flush();
    assert.equal(gone('a'), true, '这一下照样删了');
    await tick();
    assert.equal(wrapOf(main, 'a'), undefined, '松手、删完以后重画了一次（别处改的也在里面）');
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

test('接着一张张删：上一张的删除在下一张拖到一半时落下来，下一张照样删掉', async () => {
  for (const gap of [100, 250, 300, 350, 400, 500]) {
    for (const n of [8, 14]) {
      const env = setup();
      try {
        const { main } = env.list();
        await liveDrag(env, linkOf(wrapOf(main, 'a')), line(320, 80, 10));
        await until(env, env.clock.t + gap);
        await liveDrag(env, linkOf(wrapOf(main, 'b')), line(320, 80, n));
        await until(env, env.clock.t + 1500);
        assert.deepEqual([gone('a'), gone('b')], [true, true], `隔 ${gap} ms、拖 ${n * 16} ms`);
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
    drag(env, linkOf(wrapOf(main, 'b')), line(320, 80, 10));
    env.flush();
    assert.equal(gone('b'), true);
  } finally { env.done(); }
});

test('「收藏」筛选里滑着取消收藏：卡片不见了，提示条能「撤销」回来', async () => {
  const env = setup();
  try {
    const { main } = env.list();
    const chip = find(main, el => el.tag === 'button' && el.dataset.k === 'fav');
    dispatch(chip, 'click');
    assert.deepEqual(wraps(main).map(w => w.children[0].dataset.id), ['b']);
    drag(env, linkOf(wrapOf(main, 'b')), line(60, 290, 10));
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
    assert.ok(!cls(wrapOf(main, 'a'), 'sw-armed'));
    drag(env, linkOf(wrapOf(main, 'b')), [[120, 200], [132, 203], [180, 270], [230, 350], [280, 430]], { rest: 0 });
    env.flush();
    await tick();
    assert.equal(raw('b').fav, true);
  } finally { env.done(); }
});

test('触控板：猛扫卡片也只移开 1.25 个按钮宽；开着的往回扫（带惯性）关上，不会露出另一边', () => {
  const env = setup();
  try {
    const { main } = env.list();
    const w = wrapOf(main, 'a'), card = w.children[0];
    let max = 0;
    const wheel = (dx) => { env.clock.t += 16; dispatch(card, 'wheel', { deltaX: dx, deltaY: 0, deltaMode: 0 }); max = Math.max(max, Math.abs(Number((/-?\d+/.exec(card.style.transform || '0') || [0])[0]))); };
    for (let i = 0; i < 8; i++) wheel(25);
    for (let v = 25 * 0.93; v >= 0.5; v *= 0.93) wheel(v);
    assert.ok(max <= Math.round(A * 1.25), String(max));
    env.flush();
    assert.equal(w.swipe.side, -1);
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
