// 卡片左右滑出操作（像「邮件」「备忘录」）：手指往左滑，右边露出「删除」；往右滑，左边露出「收藏」。
// 露出来以后点按钮才做；一口气滑过卡片宽度的 55%（或者快速甩出去）松手就直接做。同一时间只开一张。
// 上半部分是手势的状态机（createSwipeModel：只算数，时间、卡片宽度都由调用的地方给，Node 里能测），
// 下半部分接到页面上（createSwipes：一页一组；列表和日历那天的卡片用，见 views/list.js 的 entryCard）。
// 不妨碍上下滚动：手指移动超过 10 px 才定方向，|dx| > 1.5·|dy| 才算横着滑，定成竖着的这一下后面都不管；可滑的那层 CSS 是 touch-action: pan-y。
// 定成横着以后手指上下走得比横着还多（斜着往上下甩）：多半是想滚动，松手不直接做。从开着的一边拉过中间：甩不算，拉够一个按钮宽才开另一边。
// 从屏幕左边 20 px 以内开始的不管（iOS 的系统手势）；页面被捏合放大时整个不管（单指横着拖是在看放大的页面）。
// 触控、笔走 pointer 事件（在 document 上听，一页一份）；鼠标不拖（会和选字、拖链接打架），
// Mac / iPad 触控板两指横扫走 wheel 事件：只开、关，不直接做（松开手指以后的惯性也算在 wheel 里，分不出来，容易误删）；
// 惯性再大卡片也只移开一点多一个按钮宽，开着的往回扫只会关上、不会扫到另一边。
// 关着时没有按钮（第一次滑动时才建；之后关着时 hidden）：读屏、Tab 都碰不到，卡片上的 ⭐ 和详情页 ⋯ 里的「删除」照旧；
// 开着时能 Tab 到，名字是「删除这条」这样的。
// 系统设了「减少动态效果」：不做动画，直接到位，删除、收藏马上做。
import { h, icon } from './dom.js';

/**
 * 手势参数（px、毫秒）。
 * action：露出来的按钮那一条多宽（开着时卡片移开这么多；按钮本身再让出 gap，styles.css 的 .sw-in 宽 = action − gap）
 */
export const SWIPE = {
  slop: 10,          // 移动超过这么多才定方向
  ratio: 1.5,        // 横着滑：|dx| > ratio·|dy|
  edge: 20,          // 从屏幕左边这么近开始的不管
  action: 84, gap: 8,
  full: 0.55,        // 手指移动超过卡片宽度的这么多（至少 1.5 个按钮宽）→ 松手直接做
  steep: 0.6, steepMin: 40,   // 定成横着以后上下走了超过横着的 0.6 倍（而且超过 40 px）：太斜了，松手不直接做
  rubber: 0.5,       // 超过按钮宽以后卡片只跟手指的一半（橡皮筋）；到了「直接做」的距离再追上手指
  fling: 0.3,        // px/ms：松手时这么快 → 按甩的方向开 / 关
  flingFull: 1.1,    // px/ms：这么快、而且已经拖了「直接做」距离的 70% → 直接做
  sample: 100,       // 速度看最后这么多毫秒
  rest: 80,          // 停住超过这么久才松手：速度算 0
  wheelGap: 160,     // 触控板：隔这么久没有 wheel 事件 = 这一下滑完了
  wheelMax: 1.5,     // 触控板最多拉到这么多个按钮宽（橡皮筋以后卡片移开 1.25 个）
  anim: 240, collapse: 200,   // 回弹 / 滑出去的动画、删掉的卡片收起高度的动画（和 styles.css 一致）
  hold: 4000,        // 手势、动画没完时数据变了：重画等到做完，最多等这么久
  block: 500,        // 开着的卡片被重画关上以后这么久以内，点卡片不算（是冲着刚才的按钮去的）
};

/**
 * 一张卡片的手势状态机。位置 p 是手指拖到的地方（正 = 往右，露出左边的按钮；负 = 往左，露出右边的按钮），
 * 卡片实际移动 offset = view(p)：按钮宽以内跟手，再往外一半（橡皮筋），到了「直接做」的距离跟手（armed）。
 * open：-1（右边的按钮露着）/ 0 / 1（左边的露着）。
 * @param {{ width?: () => number, sides?: number[] }} [o]  width：卡片宽（每次按下时量一次）；sides：有按钮的那几边（1 左、-1 右），其余参数见 SWIPE
 */
export function createSwipeModel({ width = () => 320, sides = [1, -1], ...o } = {}) {
  const P = { ...SWIPE, ...o }, A = P.action;
  let open = 0, g = null, w = null;
  const ok = (s) => s !== 0 && sides.includes(s);
  const fullAt = (wd) => Math.max(A * 1.5, wd * P.full);
  function view(p, armed) {
    const s = Math.sign(p), d = Math.abs(p);
    if (!s) return 0;
    if (!ok(s)) return s * Math.min(d * 0.2, 16);          // 这边没有按钮：只能拉动一点点
    if (armed || d <= A) return p;
    return s * (A + (d - A) * P.rubber);
  }
  function speed(gg, t) {
    const last = gg.pts[gg.pts.length - 1];
    if (t - last.t > P.rest) return 0;
    const first = gg.pts.find(q => last.t - q.t <= P.sample) || gg.pts[0];
    return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
  }
  const settleBy = (p) => { const s = Math.sign(p); return ok(s) && Math.abs(p) >= A / 2 ? s : 0; };
  /** 这一下太斜：上下走的（最远）比横着走的 0.6 倍还多 */
  const steep = (gg) => gg.ym > Math.max(P.steepMin, P.steep * Math.abs(gg.p - gg.base));
  /** 从开着的一边拉过了中间（往另一边） */
  const crossed = (gg) => gg.base !== 0 && Math.sign(gg.p) === -Math.sign(gg.base);
  /** 按位置停：拉过中间的要够一个按钮宽才开另一边 */
  const rest = (gg) => (crossed(gg) ? (ok(Math.sign(gg.p)) && Math.abs(gg.p) >= A ? Math.sign(gg.p) : 0) : settleBy(gg.p));
  return {
    get open() { return open; },
    /** 正在横着拖（手指或触控板） */
    get busy() { return !!((g && g.axis === 'h') || (w && w.axis === 'h')); },
    get fullAt() { return fullAt(Number(width()) || 320); },
    /** 直接开 / 关（点按钮、点别处、截图） */
    set(s) { open = ok(s) ? s : 0; g = w = null; },
    /** 按下：从屏幕左边缘开始的不管 → false */
    down(x, y, t) {
      w = null;
      if (x < P.edge) { g = null; return false; }
      g = { x0: x, y0: y, base: open * A, axis: null, p: open * A, ym: 0, armed: false, wd: Number(width()) || 320, pts: [{ x, t }] };
      return true;
    },
    /** 移动 → null（这一下不归我管）| { axis: null }（还没定方向）| { axis: 'v' }（竖着的：交给页面滚动）| { axis: 'h', offset, armed, side } */
    move(x, y, t) {
      if (!g || g.axis === 'v') return null;
      const dx = x - g.x0, dy = y - g.y0;
      if (!g.axis) {
        if (Math.abs(dx) < P.slop && Math.abs(dy) < P.slop) return { axis: null };
        g.axis = Math.abs(dx) > P.ratio * Math.abs(dy) ? 'h' : 'v';
        if (g.axis === 'v') return { axis: 'v' };
      }
      g.p = g.base + dx;
      g.ym = Math.max(g.ym, Math.abs(dy));
      g.pts.push({ x, t });
      while (g.pts.length > 2 && t - g.pts[1].t > P.sample) g.pts.shift();
      const s = Math.sign(g.p), d = Math.abs(g.p), at = fullAt(g.wd);
      g.armed = ok(s) && !steep(g) && (g.armed ? d >= at - 12 : d >= at);   // 来回在线上晃不闪
      return { axis: 'h', offset: view(g.p, g.armed), armed: g.armed, side: s };
    },
    /** 松手 → { kind: 'tap', open }（没动：点了一下）| { kind: 'full', side }（直接做）| { kind: 'settle', to } | { kind: 'none' } */
    up(t) {
      const gg = g;
      g = null;
      if (!gg) return { kind: 'none' };
      if (!gg.axis) return { kind: 'tap', open };
      if (gg.axis === 'v') return { kind: 'none' };
      const s = Math.sign(gg.p), d = Math.abs(gg.p), v = speed(gg, t), cross = crossed(gg);
      const flung = !cross && v * s >= P.flingFull && d >= 0.7 * fullAt(gg.wd);   // 拉过中间的不算甩：要拉够「直接做」的距离
      if (ok(s) && !steep(gg) && (gg.armed || flung)) { open = 0; return { kind: 'full', side: s }; }
      let to;
      if (cross) to = Math.abs(v) >= P.fling && Math.sign(v) !== s ? 0 : rest(gg);
      else to = Math.abs(v) >= P.fling ? (Math.sign(v) === s ? s : 0) : settleBy(gg.p);
      if (!ok(to)) to = 0;
      open = to;
      return { kind: 'settle', to };
    },
    /** 被系统打断（pointercancel）、第二根手指：按位置开 / 关，不直接做 */
    cancel() {
      const gg = g;
      g = null;
      if (!gg || gg.axis !== 'h') return { kind: 'none' };
      open = rest(gg);
      return { kind: 'settle', to: open };
    },
    /**
     * 触控板 / 横向滚轮：dx、dy 是 wheel 事件的 delta（px；两指往左 → deltaX 为正 → 露出右边的按钮）。
     * 隔 wheelGap 没有事件算新的一下；先攒够 slop 再定方向，竖着的整下都不管。
     * 卡片最多拉到 wheelMax 个按钮宽；开着的这一下只能往关的方向走到中间（惯性不会把它扫到另一边）。
     * → { consumed（要 preventDefault）, axis, offset?, side? }
     */
    wheel(dx, dy, t) {
      if (g) return { consumed: false, axis: null };
      if (!w || t - w.t > P.wheelGap) w = { sx: 0, sy: 0, axis: null, base: open * A, p: open * A, t };
      w.t = t;
      if (w.axis === 'v') return { consumed: false, axis: 'v' };
      let step = dx;
      if (!w.axis) {
        w.sx += dx; w.sy += dy;
        if (Math.abs(w.sx) < P.slop && Math.abs(w.sy) < P.slop) return { consumed: Math.abs(dx) > P.ratio * Math.abs(dy), axis: null };
        w.axis = Math.abs(w.sx) > P.ratio * Math.abs(w.sy) ? 'h' : 'v';
        if (w.axis === 'v') return { consumed: false, axis: 'v' };
        step = w.sx;                                       // 定方向以前攒的一起算上
      }
      const max = A * P.wheelMax, lo = w.base > 0 ? 0 : -max, hi = w.base < 0 ? 0 : max;
      w.p = Math.min(hi, Math.max(lo, w.p - step));
      return { consumed: true, axis: 'h', offset: view(w.p, false), side: Math.sign(w.p) };
    },
    /** 触控板这一下滑完了：关着的按位置开 / 关；开着的往回扫了三分之一个按钮宽就关上 */
    wheelEnd() {
      const ww = w;
      w = null;
      if (!ww || ww.axis !== 'h') return { kind: 'none' };
      const s0 = Math.sign(ww.base), back = (ww.base - ww.p) * s0;
      open = s0 ? (back >= A / 3 ? 0 : s0) : settleBy(ww.p);
      return { kind: 'settle', to: open };
    },
  };
}

/**
 * 一页的可滑卡片（同一时间只开一张）。点别处、滚动、在别的卡片上开始滑、按 Esc 都会关上开着的那张；
 * 点开着的卡片只是关上（不打开条目，卡片里的 ⭐ ▶ 也不算点）；滑过以后松手不算点。
 * 页面重画卡片前调 reset()；数据变了（onChange）用 whenIdle(重画)：有手指按着、触控板在扫、卡片在动、删除 / 收藏在等动画时，
 * 等做完再重画（不然手底下的卡片换成新的，这一下就丢了）。重画以后：
 *   这一页自己的删除 / 收藏引起的 → 开着的那张照样开着（接着一张张删）；别的（同步进来、别处改了）→ 关上，之后 block 毫秒以内点卡片不算。
 *   焦点在卡片的链接或按钮上 → 放回新画的那张上。
 * 离开页面调 destroy()（等动画的删除 / 收藏马上做完，不会丢）。
 * @param {object} [env]  测试用：{ doc, win, now, setTimeout, clearTimeout, reduceMotion: () => bool, width: (el) => px }
 * @returns {{ wrap(card, opts): HTMLElement, whenIdle(fn): void, close(): void, reset(): void, destroy(): void, readonly current: object|null, readonly busy: boolean }}
 */
export function createSwipes(env = {}) {
  const E = {
    doc: globalThis.document, win: globalThis.window,
    now: () => (globalThis.performance ? performance.now() : Date.now()),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
    reduceMotion: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    width: (el) => el.offsetWidth || 0,
    ...env,
  };
  const P = SWIPE, A = P.action;
  const recs = new WeakMap(), jobs = new Set();     // recs：div.swipe → 这张卡片
  let cards = [];                                    // 这一次画的卡片（按顺序：键盘删掉一张，焦点挪到下一张）
  let cur = null;                                    // 开着（或者正在拖）的那张
  let live = null;                                   // 有手指 / 笔按着的那张
  let swallowUntil = 0, blockUntil = 0;
  let queued = null, queueT = 0;                     // 等着做的重画（whenIdle）
  let own = false;                                   // 这一页自己的删除 / 收藏刚改了数据（接下来的重画不关开着的那张）
  let carry = null;                                  // reset() 记下的：{ open: { id, side, y0, keep }, focus: { id, side } }，新画的同一条接着用
  const swallow = () => { swallowUntil = E.now() + 700; };
  const inCard = (el) => (el && typeof el.closest === 'function' ? el.closest('.swipe') : null);
  const cardOf = (el) => { const w = inCard(el); return (w && recs.get(w)) || null; };
  const scrollPos = (el) => { let y = 0; for (let n = el; n; n = n.parentNode) y += Number(n.scrollTop) || 0; return y; };
  const vv = () => (E.win && E.win.visualViewport) || null;
  const zoomed = () => { const v = vv(); return !!(v && v.scale > 1.01); };
  const isBusy = (c) => c.dragging || c.wheeling;
  const busy = () => !!(live || jobs.size || (cur && (isBusy(cur) || cur.moving)));
  /** 动画做完再做的事（删除、收藏）：离开页面时马上做 */
  function later(ms, fn) {
    const job = { run: () => { if (!jobs.delete(job)) return; E.clearTimeout(job.timer); fn(); queueMicrotask(idle); } };
    jobs.add(job);
    job.timer = E.setTimeout(job.run, ms);
  }
  /** 真的去改数据（删除、收藏）：记下是自己改的 */
  const commit = (run) => { own = true; run(); };
  /** 闲下来了：等着的重画现在做 */
  function idle() {
    if (!queued || busy()) return;
    const fn = queued;
    queued = null; E.clearTimeout(queueT); queueT = 0;
    fn();
  }
  function whenIdle(fn) {
    if (!busy()) { queued = null; E.clearTimeout(queueT); queueT = 0; fn(); return; }
    queued = fn;
    if (!queueT) queueT = E.setTimeout(() => { queueT = 0; const f = queued; queued = null; if (f) f(); }, P.hold);   // 保险：手指一直按着不放（或者漏了抬起）
  }
  function claim(c) {
    if (c.dead) return;                                // 已经重画掉的卡片不再算开着
    if (cur && cur !== c) close(cur, true);
    cur = c;
    c.y0 = scrollPos(c.el);
  }

  // ---------- 一张卡片：建按钮、画、开、关、做 ----------
  const model = (c) => c.model || (c.model = createSwipeModel({ width: () => E.width(c.el), sides: [1, -1].filter(s => opt(c, s)) }));
  const opt = (c, s) => (s > 0 ? c.left : c.right);
  /** 两个按钮第一次要露出来时才建（关着的卡片只有一层 div） */
  function build(c) {
    c.side = { 1: null, '-1': null };
    for (const s of [1, -1]) {
      const o = opt(c, s);
      if (!o) continue;
      const inner = h('span.sw-in', null, icon(o.icon, { cls: o.filled ? 'sw-filled' : '' }), h('span.sw-t', null, o.label));
      const b = h('button.sw-btn.' + (s > 0 ? 'sw-l' : 'sw-r') + (o.cls ? '.' + o.cls : ''), {
        type: 'button', hidden: true, 'aria-label': o.aria || null,
        onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); act(c, s); },
      }, inner);
      c.side[s] = { b, inner };
      c.el.append(b);
    }
  }
  const btnSide = (c, t) => (c.side && t ? [1, -1].find(s => c.side[s] && c.side[s].b.contains(t)) || 0 : 0);
  function paint(c, x, anim = false) {
    const moving = anim && !E.reduceMotion();
    E.clearTimeout(c.animT);
    if (x && !c.side) build(c);
    c.el.classList.toggle('sw-anim', moving);
    c.card.style.transform = x ? `translateX(${Math.round(x)}px)` : '';
    if (c.side) {
      for (const s of [1, -1]) {
        const x0 = c.side[s];
        if (!x0) continue;
        const on = Math.sign(x) === s, d = on ? Math.abs(x) : 0;
        if (on) x0.b.hidden = false;
        x0.b.style.width = Math.max(0, Math.round(d - P.gap)) + 'px';
        x0.inner.style.opacity = String(Math.round(Math.min(1, Math.max(0, (d - 24) / (A - 24))) * 100) / 100);
      }
    }
    const done = () => {
      c.moving = false;
      c.el.classList.remove('sw-anim');
      if (c.side) for (const s of [1, -1]) if (c.side[s] && Math.sign(x) !== s) c.side[s].b.hidden = true;
    };
    c.moving = moving;
    if (moving) c.animT = E.setTimeout(() => { done(); idle(); }, P.anim + 30); else done();
  }
  function setArmed(c, on) {
    if (on === c.armed) return;
    c.armed = on;
    c.el.classList.toggle('sw-armed', on);
    if (E.reduceMotion()) return;
    c.el.classList.add('sw-snap');                     // 到了「直接做」的距离：卡片追上手指（短短的过渡，不跳）
    E.clearTimeout(c.snapT);
    c.snapT = E.setTimeout(() => c.el.classList.remove('sw-snap'), 140);
  }
  function settle(c, to) {
    model(c).set(to);
    paint(c, to * A, true);
    if (to) claim(c);
    else if (cur === c) cur = null;
  }
  /** 关上；焦点在按钮上（键盘用户）就挪回卡片的链接，不丢 */
  function close(c, anim = true) {
    const had = btnSide(c, E.doc.activeElement);
    if (c.pointer != null) stop(c);
    if (c.model) c.model.set(0);
    paint(c, 0, anim);
    if (cur === c) cur = null;
    if (had && c.focus) c.focus.focus({ preventScroll: true });
  }
  function open(c, s) {
    if (!opt(c, s) || c.dead || c.gone) return;
    claim(c);
    model(c).set(s);
    paint(c, s * A);
  }
  /** 键盘删掉一张：焦点挪到下一张（没有就上一张）的链接，不掉回页面开头 */
  function focusNext(c) {
    const i = cards.indexOf(c), ok = (x) => x && !x.gone && !x.dead && x.focus;
    let n = null;
    for (let j = i + 1; j < cards.length && !n; j++) if (ok(cards[j])) n = cards[j];
    for (let j = i - 1; j >= 0 && !n; j--) if (ok(cards[j])) n = cards[j];
    if (n) n.focus.focus({ preventScroll: true });
    else if (E.doc.activeElement && typeof E.doc.activeElement.blur === 'function') E.doc.activeElement.blur();
  }
  /** 点了按钮或者一口气滑过去：删除的卡片滑出去、收起来以后再删（数据一变列表就重画了）；收藏的弹回去以后再改 */
  function act(c, s) {
    const o = opt(c, s);
    if (!o || c.dead || c.gone) return;
    const refocus = btnSide(c, E.doc.activeElement) === s;
    if (cur === c) cur = null;
    model(c).set(0);
    if (!o.out) {
      paint(c, 0, true);
      if (refocus && c.focus) c.focus.focus({ preventScroll: true });
      if (E.reduceMotion()) commit(o.run); else later(P.anim, () => commit(o.run));
      return;
    }
    c.gone = true;
    if (refocus) focusNext(c);
    c.el.classList.add('sw-out');
    if (E.reduceMotion()) { commit(o.run); return; }
    paint(c, s * ((E.width(c.el) || 400) + 24), true);
    later(P.anim, () => {
      const el = c.el;
      el.style.height = (el.offsetHeight || 0) + 'px';
      void el.offsetHeight;                            // 先定住现在的高度，再收到 0（才有过渡）
      el.classList.add('sw-gone');
      el.style.height = '0px';
      later(P.collapse, () => commit(o.run));
    });
  }
  function stop(c) {
    c.pointer = null;
    c.dragging = false;
    if (live === c) live = null;
    c.el.classList.remove('sw-drag');
    setArmed(c, false);
  }
  function finish(c, r) {
    const dragged = c.dragging;
    stop(c);
    if (c.dead) { if (c.model) c.model.set(0); idle(); return; }   // 拖着的时候列表还是重画了（等太久的保险）：旧卡片什么都不做
    if (r.kind === 'tap') { if (r.open) { swallow(); close(c, true); } }
    else {
      if (dragged) swallow();                          // 滑过以后松手不算点（卡片、⭐、▶ 都不触发）
      if (r.kind === 'full') act(c, r.side);
      else if (r.kind === 'settle') settle(c, r.to);
    }
    idle();
  }
  function kill(c) {
    c.dead = true;
    E.clearTimeout(c.animT); E.clearTimeout(c.snapT); E.clearTimeout(c.wheelT);
    if (live === c) live = null;
  }

  // ---------- 手指、笔（document 上听：一页一份，不是每张卡片一份） ----------
  function onDown(e) {
    swallowUntil = 0;                                  // 新的一下：上一下的 click 早就来过了
    const w = inCard(e.target), c = w ? recs.get(w) || null : null;
    if (w && E.now() < blockUntil) swallow();          // 开着的那张刚被重画关上：这一下多半是冲着它的按钮去的
    if (live) {                                        // 已经有一根手指按在卡片上：第二根（捏合、手掌）这一下不算，按着的那张按位置停住
      if (e.pointerId !== live.pointer) { finish(live, live.model.cancel()); if (w) swallow(); }
      return;
    }
    if (cur && cur !== c) { close(cur, true); if (w) swallow(); }   // 点别处：关上开着的那张；点到别的卡片只是关上，不打开这张
    if (!c || c.dead || c.gone) return;
    const t = e.target;
    if ((t && typeof t.closest === 'function' && t.closest('.sw-btn')) || (e.button != null && e.button > 0)) return;
    const m = model(c), wasOpen = m.open;
    if (e.pointerType === 'mouse' || zoomed() || !m.down(e.clientX, e.clientY, E.now())) {
      if (wasOpen) { swallow(); close(c, true); }      // 鼠标不拖；从屏幕边缘开始的、放大着的不管——开着的话照样是「点一下关上」
      return;
    }
    c.pointer = e.pointerId;
    live = c;
  }
  function onMove(e) {
    const c = live;
    if (!c || e.pointerId !== c.pointer) return;
    const r = c.model.move(e.clientX, e.clientY, E.now());
    if (!r || !r.axis) return;
    if (r.axis === 'v') {                              // 竖着滑：这一下交给页面滚动；开着的关上
      const was = c.model.open;
      c.model.cancel();
      stop(c);
      if (was) close(c, true);
      idle();
      return;
    }
    if (!c.dragging) {
      c.dragging = true;
      claim(c);
      c.el.classList.add('sw-drag');
      try { if (c.el.setPointerCapture) c.el.setPointerCapture(e.pointerId); } catch (err) { /* 已经抬起 */ }
    }
    setArmed(c, r.armed);
    paint(c, r.offset);
  }
  function onUp(e) { if (live && e.pointerId === live.pointer) finish(live, live.model.up(E.now())); }
  function onCancel(e) { if (live && e.pointerId === live.pointer) finish(live, live.model.cancel()); }
  // iOS：定成横着滑以后不让页面跟着上下动（touch-action: pan-y 管开头，这里管中途）。每张卡片都挂（只挡卡片上开始的），同一个函数
  function onTouchMove(e) { if (live && live.dragging && e.cancelable !== false) e.preventDefault(); }

  // ---------- 触控板（每张卡片挂同一个函数） ----------
  function onWheel(e) {
    const c = cardOf(e.target);
    if (!c || c.dead || c.gone || live || zoomed()) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (E.width(c.el) || 400) : 1;
    const r = model(c).wheel((e.deltaX || 0) * k, (e.deltaY || 0) * k, E.now());
    if (r.consumed) e.preventDefault();
    if (r.axis !== 'h') return;
    if (!c.wheeling) { c.wheeling = true; claim(c); }
    paint(c, r.offset);
    E.clearTimeout(c.wheelT);
    c.wheelT = E.setTimeout(() => {
      c.wheeling = false;
      if (!c.dead && !c.gone) { const s = c.model.wheelEnd(); if (s.kind === 'settle') settle(c, s.to); }
      idle();
    }, P.wheelGap);
  }

  // ---------- 页面上的：点别处、点开着的那张、滚动、Esc、捏合放大 ----------
  function onClick(e) {
    if (!swallowUntil) return;
    const fresh = E.now() <= swallowUntil;
    swallowUntil = 0;
    if (e.detail === 0) return;                        // 键盘（Enter、空格）、读屏点的：不是刚才那一下手指
    if (fresh && inCard(e.target)) { e.preventDefault(); e.stopPropagation(); }
  }
  function onKey(e) {
    if (e.key !== 'Escape' || !cur || isBusy(cur)) return;
    if (E.doc.querySelector && E.doc.querySelector('dialog[open]')) return;
    close(cur, true);
  }
  function onScroll() {
    if (cur && !isBusy(cur) && Math.abs(scrollPos(cur.el) - cur.y0) > 8) close(cur, true);
  }
  // 捏合放大着：可滑的那层改回 touch-action: auto（单指横着拖要能移动放大的页面）
  function onZoom() { const r = E.doc.documentElement; if (r && r.classList) r.classList.toggle('sw-zoomed', zoomed()); }
  E.doc.addEventListener('pointerdown', onDown, true);
  E.doc.addEventListener('pointermove', onMove, true);
  E.doc.addEventListener('pointerup', onUp, true);
  E.doc.addEventListener('pointercancel', onCancel, true);
  E.doc.addEventListener('click', onClick, true);
  E.doc.addEventListener('keydown', onKey);
  E.win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  const vp = vv();
  if (vp && typeof vp.addEventListener === 'function') { vp.addEventListener('resize', onZoom); onZoom(); }

  /**
   * 把卡片包进可滑的一层，返回这一层（div.swipe：卡片；按钮第一次露出来时才加进去）。
   * id：条目 id（重画以后认出同一条：开着的接着开着、焦点放回来）
   * left / right：{ icon, label ���钮上的字, aria 读屏念的完整名字, cls, filled 图标填实, out: true 做的时候卡片滑出去（删除）, run() }
   * focus：关上时焦点在按钮上就挪到这里（卡片的链接）
   */
  function wrap(card, { id = null, left = null, right = null, focus = null } = {}) {
    const el = h('div.swipe');
    el.append(card);
    const c = { el, card, id, left, right, focus, side: null, model: null, y0: 0, pointer: null, dragging: false, wheeling: false, moving: false,
      armed: false, dead: false, gone: false, animT: 0, snapT: 0, wheelT: 0 };
    recs.set(el, c);
    cards.push(c);
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('wheel', onWheel, { passive: false });
    /** 给测试、截图用：el.swipe.open(-1) 直接打开右边（删除），open(1) 左边（收藏） */
    el.swipe = { open: (s) => open(c, s), close: () => close(c, false), get side() { return c.model ? c.model.open : 0; }, get offset() { return (c.model ? c.model.open : 0) * A; } };
    const cy = carry;
    if (cy && id != null) {
      if (cy.open && cy.open.id === id && opt(c, cy.open.side)) {
        open(c, cy.open.side);                         // 重画前开着：先照样开着（没有动画）
        c.y0 = cy.open.y0;
        if (!cy.open.keep) queueMicrotask(() => { if (!c.dead && cur === c) { void c.el.offsetWidth; close(c, true); } });   // 别处改了数据：画好以后再关上（有动画）
      }
      if (cy.focus && cy.focus.id === id) {
        const fs = cy.focus.side;
        queueMicrotask(() => {                         // 等页面把新卡片放进去才能拿到焦点
          if (c.dead) return;
          const b = fs && c.model && c.model.open === fs && c.side && c.side[fs] ? c.side[fs].b : c.focus;
          if (b) b.focus({ preventScroll: true });
        });
      }
    }
    return el;
  }

  /** 页面要重画卡片了：旧卡片都不再管（等动画的删除 / 收藏照样做；刚滑完、click 还没来时重画了，那个 click 照样吞掉） */
  function reset() {
    const ae = E.doc.activeElement, fc = cardOf(ae), fs = fc ? btnSide(fc, ae) : 0;
    const was = cur && !cur.dead && !cur.gone && !isBusy(cur) && cur.model && cur.model.open ? cur : null;
    carry = {
      open: was && was.id != null ? { id: was.id, side: was.model.open, y0: was.y0, keep: own } : null,
      focus: fc && fc.id != null && (fs || ae === fc.focus) ? { id: fc.id, side: fs } : null,
    };
    if (was && !own) blockUntil = E.now() + P.block;
    own = false;
    for (const c of cards) kill(c);
    cards = []; cur = null; live = null;
    queueMicrotask(() => { carry = null; });           // 只给这一次重画用
  }
  return {
    wrap, reset, whenIdle,
    get current() { return cur ? cur.el : null; },
    get busy() { return busy(); },
    close() { if (cur) close(cur, true); },
    destroy() {
      while (jobs.size) [...jobs][0].run();
      queued = null; E.clearTimeout(queueT); queueT = 0;
      reset();
      carry = null;
      E.doc.removeEventListener('pointerdown', onDown, true);
      E.doc.removeEventListener('pointermove', onMove, true);
      E.doc.removeEventListener('pointerup', onUp, true);
      E.doc.removeEventListener('pointercancel', onCancel, true);
      E.doc.removeEventListener('click', onClick, true);
      E.doc.removeEventListener('keydown', onKey);
      E.win.removeEventListener('scroll', onScroll, { capture: true, passive: true });
      if (vp && typeof vp.removeEventListener === 'function') vp.removeEventListener('resize', onZoom);
    },
  };
}
