// 卡片左右滑的手势状态机（src/ui/swipe.js 的 createSwipeModel）：只算数，时间、卡片宽度都由测试给。
//   定方向（超过 10 px、横向要 |dx| > 1.5·|dy|，竖着的整下不管）、屏幕左边缘开始的不管、按钮宽以内跟手、再往外橡皮筋、
//   松手按距离 / 速度开关、拉过卡片宽度的 55% 或快速甩出去直接做、被打断不直接做、点一下、触控板（wheel）只开关；
//   太斜的（先横着滑一点、再往上下甩）不直接做；从开着的一边拉过中间不算甩；触控板的惯性不会扫到另一边、不会拉得像要删
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwipeModel, SWIPE } from '../src/ui/swipe.js';

const W = 343;                                   // iPhone 上卡片的宽（375 − 两边 16）
const A = SWIPE.action;
const FULL = Math.max(A * 1.5, W * SWIPE.full);  // 188.65
/** 从 (x0, y0) 按一串点拖过去，每步 dt 毫秒；返回最后一次 move 的结果。rest：松手前停多久 */
function drag(m, pts, { t0 = 1000, dt = 16 } = {}) {
  let t = t0, r = null;
  m.down(pts[0][0], pts[0][1], t);
  for (const [x, y] of pts.slice(1)) { t += dt; r = m.move(x, y, t); }
  return { r, t };
}
const line = (x0, x1, n = 8, y = 300) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y]);

test('参数：按钮宽 84、方向 10 px、横向 1.5 倍、左边缘 20 px、直接做 55%', () => {
  assert.deepEqual([SWIPE.action, SWIPE.slop, SWIPE.ratio, SWIPE.edge, SWIPE.full], [84, 10, 1.5, 20, 0.55]);
  assert.equal(Math.round(createSwipeModel({ width: () => W }).fullAt), 189);
  assert.equal(createSwipeModel({ width: () => 100 }).fullAt, A * 1.5, '窄的卡片：至少 1.5 个按钮宽');
});

test('移动不到 10 px 不定方向；横着要 |dx| > 1.5·|dy|，竖着的这一下后面都不管', () => {
  const m = createSwipeModel({ width: () => W });
  m.down(200, 300, 0);
  assert.deepEqual(m.move(194, 304, 16), { axis: null });
  assert.equal(m.busy, false);
  assert.deepEqual(m.move(188, 309, 32), { axis: 'v' }, '12 横 9 竖：不够 1.5 倍 → 竖着');
  assert.equal(m.move(100, 309, 48), null, '定成竖着以后再横着拖也不管');
  assert.deepEqual(m.up(64), { kind: 'none' });
  assert.equal(m.open, 0);

  m.down(200, 300, 100);
  const r = m.move(186, 308, 116);               // 14 横 8 竖：横着
  assert.equal(r.axis, 'h');
  assert.equal(r.offset, -14);
  assert.equal(m.busy, true);
  assert.equal(m.move(150, 360, 132).axis, 'h', '定成横着以后上下晃也接着横着拖');
});

test('从屏幕左边 20 px 以内开始的不管（iOS 的系统手势）', () => {
  const m = createSwipeModel({ width: () => W });
  assert.equal(m.down(12, 300, 0), false);
  assert.equal(m.move(150, 300, 16), null);
  assert.deepEqual(m.up(32), { kind: 'none' });
  assert.equal(m.open, 0);
  assert.equal(m.down(20, 300, 100), true, '20 px 开始就算');
});

test('往左拖：按钮宽以内跟手，再往外只跟一半；慢慢松手按距离（过一半按钮宽就开）', () => {
  const m = createSwipeModel({ width: () => W });
  let { r, t } = drag(m, line(300, 240));
  assert.deepEqual([r.offset, r.side, r.armed], [-60, -1, false]);
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: -1 }, '停了一会儿才松手：按距离，60 > 42 → 开');
  assert.equal(m.open, -1);

  ({ r } = drag(m, line(300, 150)));            // 从开着接着往左：-84 − 150 = -234 → 过了直接做的距离，跟手
  assert.equal(r.armed, true);
  assert.equal(r.offset, -234);
  assert.deepEqual(m.cancel(), { kind: 'settle', to: -1 }, '被打断（pointercancel）：不直接做，按位置开着');
  ({ r } = drag(m, line(300, 260)));            // -84 − 40 = -124：橡皮筋
  assert.equal(r.offset, -(A + (124 - A) * SWIPE.rubber));
  assert.equal(r.armed, false);

  const n = createSwipeModel({ width: () => W });
  ({ t } = drag(n, line(300, 270)));
  assert.deepEqual(n.up(t + 200), { kind: 'settle', to: 0 }, '只拖了 30 px：弹回去');
});

test('快速甩：按甩的方向开 / 关', () => {
  const m = createSwipeModel({ width: () => W });
  let { t } = drag(m, line(300, 275, 2, 300), { dt: 20 });       // 25 px / 40 ms
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 }, '距离不到一半，但甩得快 → 开');
  ({ t } = drag(m, line(300, 320, 2), { dt: 20 }));                // 开着往回甩 20 px
  assert.deepEqual(m.up(t), { kind: 'settle', to: 0 });
  ({ t } = drag(m, [[200, 300], [260, 300], [262, 300]], { dt: 30 }));   // 往右拖 62 px，最后慢了
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: 1 }, '往右：露出左边的按钮');
  // 速度只看最后 100 ms：前面快、后面停住 → 按距离
  const n = createSwipeModel({ width: () => W });
  n.down(300, 300, 0);
  n.move(260, 300, 16); n.move(255, 300, 200); n.move(254, 300, 300);
  assert.deepEqual(n.up(310), { kind: 'settle', to: -1 });
});

test('直接做：拉过卡片宽度的 55%（来回在线上晃不闪），或者拉了 70% 又甩得很快', () => {
  const m = createSwipeModel({ width: () => W });
  let { r, t } = drag(m, line(300, 300 - 195));
  assert.equal(r.armed, true);
  assert.equal(r.offset, -195, '到了直接做的距离：卡片追上手指');
  t += 16; r = m.move(300 - 180, 300, t);
  assert.equal(r.armed, true, '往回一点点（还在 12 px 以内）：还是直接做');
  t += 16; r = m.move(300 - 170, 300, t);
  assert.equal(r.armed, false);
  assert.equal(r.offset, -(A + (170 - A) * SWIPE.rubber));
  t += 16; r = m.move(300 - 200, 300, t);
  assert.deepEqual(m.up(t + 300), { kind: 'full', side: -1 }, '慢慢松手也直接做');
  assert.equal(m.open, 0);

  ({ t } = drag(m, line(100, 300), { dt: 12 }));                   // 往右 200 px：收藏那边
  assert.deepEqual(m.up(t), { kind: 'full', side: 1 });

  // 甩：140 px（过了 189 的 70%）、很快 → 直接做；100 px 再快也只是打开
  ({ t } = drag(m, line(300, 160, 4), { dt: 25 }));                // 1.4 px/ms
  assert.deepEqual(m.up(t), { kind: 'full', side: -1 });
  ({ t } = drag(m, line(300, 200, 4), { dt: 15 }));
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 });
  // 开着再往同一边甩 60 px：-84 − 60 = -144 → 直接做（「开着再甩一下就删」）
  ({ t } = drag(m, line(300, 240, 3), { dt: 15 }));
  assert.deepEqual(m.up(t), { kind: 'full', side: -1 });
});

test('点一下（没动到 10 px）→ tap，带着开没开；被打断时也不直接做', () => {
  const m = createSwipeModel({ width: () => W });
  m.down(200, 300, 0); m.move(204, 302, 16);
  assert.deepEqual(m.up(40), { kind: 'tap', open: 0 });
  m.set(-1);
  m.down(200, 300, 100);
  assert.deepEqual(m.up(140), { kind: 'tap', open: -1 });
  assert.equal(m.open, -1, '点一下不改开关（页面去关）');
  m.set(0);
  drag(m, line(300, 50));
  assert.deepEqual(m.cancel(), { kind: 'settle', to: -1 }, '拉过了直接做的距离又被系统打断：只是开着');
});

test('只有一边有按钮：另一边只能拉动一点点，松手弹回', () => {
  const m = createSwipeModel({ width: () => W, sides: [-1] });
  const { r, t } = drag(m, line(100, 300));
  assert.ok(r.offset > 0 && r.offset <= 16, String(r.offset));
  assert.equal(r.armed, false);
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: 0 });
  m.set(1);
  assert.equal(m.open, 0);
});

test('触控板（wheel）：两指往左 → deltaX 为正 → 露出右边；攒够 10 px 再定方向；竖着的整下都不管；滑完按位置开关、不直接做', () => {
  const m = createSwipeModel({ width: () => W });
  assert.deepEqual(m.wheel(4, 1, 0), { consumed: true, axis: null }, '横着的还没攒够：先挡住默认动作（Safari 的前进后退）');
  let r = m.wheel(8, 1, 16);
  assert.deepEqual([r.consumed, r.axis, r.offset, r.side], [true, 'h', -12, -1]);
  r = m.wheel(40, 0, 32);
  assert.equal(r.offset, -52);
  r = m.wheel(400, 0, 48);                       // 惯性一路加：最多拉到 1.5 个按钮宽，橡皮筋以后卡片移开 1.25 个
  assert.equal(r.offset, -(A * 1.25));
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: -1 });
  assert.equal(m.open, -1);
  // 竖着滚：不挡、不动
  assert.deepEqual(m.wheel(1, 6, 1000), { consumed: false, axis: null });
  assert.deepEqual(m.wheel(2, 8, 1016), { consumed: false, axis: 'v' });
  assert.deepEqual(m.wheel(30, 0, 1032), { consumed: false, axis: 'v' }, '这一下定成竖着：后面横着的也不管');
  assert.deepEqual(m.wheelEnd(), { kind: 'none' });
  assert.equal(m.open, -1);
  // 隔了 160 ms 以上算新的一下；往右滑回来关上
  m.wheel(2, 6, 2000); m.wheel(2, 6, 2016);       // 竖着的一下
  r = m.wheel(-30, 0, 2300);
  assert.deepEqual([r.axis, r.offset], ['h', -54]);
  r = m.wheel(-30, 0, 2316);
  assert.equal(r.offset, -24);
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: 0 });
  // 手指按着的时候不算 wheel
  m.down(200, 300, 3000);
  assert.deepEqual(m.wheel(30, 0, 3010), { consumed: false, axis: null });
});

test('太斜的：先横着滑出 10 多 px、再往上下甩（整体更像竖着滚）→ 松手不直接做，也不显示「直接做」', () => {
  const run = (pts) => {
    const m = createSwipeModel({ width: () => W });
    let t = 0, r = null;
    m.down(pts[0][0], pts[0][1], t);
    for (const [x, y] of pts.slice(1)) { t += 16; r = m.move(x, y, t); }
    return { r, up: m.up(t), open: m.open };
  };
  // 往左上：横 -160、竖 -230（55°）
  let o = run([[300, 500], [288, 497], [240, 430], [190, 350], [140, 270]]);
  assert.equal(o.r.axis, 'h', '头 10 px 是横着的：定成横着');
  assert.equal(o.r.armed, false);
  assert.notEqual(o.up.kind, 'full');
  // 往右下（收藏那边）也一样
  o = run([[120, 200], [132, 203], [180, 270], [230, 350], [280, 430]]);
  assert.notEqual(o.up.kind, 'full');
  assert.notEqual(o.open, 0, '只是按位置开着（不会误删、误改收藏）');
  // 手指自然划个弧（横 220、竖 60）照样直接做
  o = run(line(320, 100, 8).map(([x], i) => [x, 300 - i * 7.5]));
  assert.deepEqual(o.up, { kind: 'full', side: -1 });
  // 快速甩 140 px、带 50 px 竖的：照样直接做
  const m = createSwipeModel({ width: () => W });
  const { t } = drag(m, [[300, 300], [265, 312], [230, 325], [195, 338], [160, 350]], { dt: 25 });
  assert.deepEqual(m.up(t), { kind: 'full', side: -1 });
});

test('从开着的一边拉过中间：甩不算；拉够一个按钮宽才开另一边；「直接做」要拉够距离', () => {
  const m = createSwipeModel({ width: () => W });
  m.set(-1);                                     // 删除露着，往右快速甩 120 px 想关上
  let { t } = drag(m, line(100, 220, 4), { dt: 16 });
  assert.deepEqual(m.up(t), { kind: 'settle', to: 0 }, '关上，不露出收藏');
  m.set(1);                                      // 收藏露着，往左狠狠甩 230 px
  ({ t } = drag(m, line(300, 70, 6), { dt: 16 }));
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 }, '不删：只是露出删除（-146，过了一个按钮宽）');
  m.set(-1);                                     // 删除露着，往右狠狠甩 270 px（已经收藏的会被取消）
  ({ t } = drag(m, line(60, 330, 6), { dt: 16 }));
  assert.deepEqual(m.up(t), { kind: 'settle', to: 1 }, '不改收藏：只是露出来');
  m.set(-1);                                     // 拉过中间、拉够了「直接做」的距离：照样做
  ({ t } = drag(m, line(40, 330, 10)));
  assert.deepEqual(m.up(t + 200), { kind: 'full', side: 1 });
  m.set(-1);                                     // 被打断：拉过中间不到一个按钮宽 → 关上
  drag(m, line(100, 160, 4));
  assert.deepEqual(m.cancel(), { kind: 'settle', to: 0 });
  m.set(-1);                                     // 慢慢往回拉过中间 30 px：关上
  ({ t } = drag(m, line(100, 214, 8)));
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: 0 });
});

/** 触控板那样的一串 deltaX：手指 n 下、每下 d，再按 k 衰减的惯性 */
function momentum(d, n, k = 0.9) {
  const out = Array(n).fill(d);
  for (let v = d * k; Math.abs(v) >= 0.5; v *= k) out.push(Math.round(v * 10) / 10);
  return out;
}
test('触控板惯性：开着的往回扫只会关上（不会扫到另一边）；扫得再猛卡片也只移开 1.25 个按钮宽；开着的往回扫一点点不关', () => {
  const play = (m, ds, t0) => { let t = t0, max = 0; for (const d of ds) { t += 16; const r = m.wheel(d, 0, t); if (r.offset != null) max = Math.max(max, Math.abs(r.offset)); } return max; };
  const m = createSwipeModel({ width: () => W });
  const max = play(m, momentum(25, 8, 0.93), 0);                  // 猛地往左扫（加上惯性 500 多 px）
  assert.ok(max <= A * 1.25 + 0.01, String(max));
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: -1 });
  play(m, momentum(-14, 8, 0.9), 5000);                           // 往右扫回来（200 多 px）
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: 0 }, '关上，不是露出收藏');
  m.set(1);
  play(m, momentum(25, 8, 0.93), 9000);
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: 0 }, '收藏露着往左猛扫：也只是关上');
  m.set(-1);
  play(m, [-8, -10, -6], 12000);                                  // 往回 24 px（不到三分之一个按钮宽）
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: -1 });
  play(m, [-10, -10, -10], 15000);                                // 往回 30 px：关上
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: 0 });
  m.set(-1);
  play(m, momentum(14, 8), 18000);                                // 开着再往同一边扫：还是开着
  assert.deepEqual(m.wheelEnd(), { kind: 'settle', to: -1 });
});
