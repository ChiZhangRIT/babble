// 卡片左右滑的手势状态机（src/ui/swipe.js 的 createSwipeModel）：只算数，时间由测试给。
//   定方向（超过 10 px、横向要 |dx| > 1.5·|dy|，竖着的整下不管）、屏幕左边缘开始的不管、按钮宽以内跟手、再往外橡皮筋（最多接近 1.5 个按钮宽）、
//   松手按距离 / 速度开关、点一下、触控板（wheel）只开关；拖得再远、甩得再快、斜着甩、被打断都只是开着或者关上——
//   没有「直接做」这种结果（删除、收藏只在点了露出来的按钮时做，见 swipeView.test.mjs）；
//   从开着的一边拉过中间不算甩；触控板的惯性不会扫到另一边、不会拉得像要删
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwipeModel, SWIPE } from '../src/ui/swipe.js';

const W = 343;                                   // iPhone 上卡片的宽（375 − 两边 16）
const A = SWIPE.action;
const CAP = A * SWIPE.pull;                      // 卡片最多移开这么多（到不了）
/** 橡皮筋：按钮宽以外卡片移开多少（和 swipe.js 的 view 一样算） */
const band = (d) => (d <= A ? d : A + (CAP - A) * (1 - Math.exp(-(d - A) * SWIPE.rubber / (CAP - A))));
/** 从 (x0, y0) 按一串点拖过去，每步 dt 毫秒；返回最后一次 move 的结果。rest：松手前停多久 */
function drag(m, pts, { t0 = 1000, dt = 16 } = {}) {
  let t = t0, r = null;
  m.down(pts[0][0], pts[0][1], t);
  for (const [x, y] of pts.slice(1)) { t += dt; r = m.move(x, y, t); }
  return { r, t };
}
const line = (x0, x1, n = 8, y = 300) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y]);

test('参数：按钮宽 84、方向 10 px、横向 1.5 倍、左边缘 20 px、最多拉开 1.5 个按钮宽；没有「滑到底 / 甩出去直接做」的参数', () => {
  assert.deepEqual([SWIPE.action, SWIPE.slop, SWIPE.ratio, SWIPE.edge, SWIPE.pull], [84, 10, 1.5, 20, 1.5]);
  for (const k of ['full', 'flingFull', 'steep', 'steepMin']) assert.equal(k in SWIPE, false, k);
  assert.equal('fullAt' in createSwipeModel(), false);
});

test('移动不到 10 px 不定方向；横着要 |dx| > 1.5·|dy|，竖着的这一下后面都不管', () => {
  const m = createSwipeModel();
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
  const m = createSwipeModel();
  assert.equal(m.down(12, 300, 0), false);
  assert.equal(m.move(150, 300, 16), null);
  assert.deepEqual(m.up(32), { kind: 'none' });
  assert.equal(m.open, 0);
  assert.equal(m.down(20, 300, 100), true, '20 px 开始就算');
});

test('往左拖：按钮宽以内跟手，再往外橡皮筋（刚过时跟一半，越往外越跟不动，到不了 1.5 个按钮宽）；慢慢松手按距离（过一半按钮宽就开）', () => {
  const m = createSwipeModel();
  let { r, t } = drag(m, line(300, 240));
  assert.deepEqual(r, { axis: 'h', offset: -60, side: -1 }, '没有 armed 之类「要直接做了」的状态');
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: -1 }, '停了一会儿才松手：按距离，60 > 42 → 开');
  assert.equal(m.open, -1);

  ({ r } = drag(m, line(300, 150)));            // 从开着接着往左：-84 − 150 = -234 → 只是橡皮筋，不追上手指
  assert.ok(Math.abs(r.offset - -band(234)) < 1e-9, String(r.offset));
  assert.ok(r.offset > -CAP && r.offset < -A, String(r.offset));
  assert.deepEqual(m.cancel(), { kind: 'settle', to: -1 }, '被打断（pointercancel）：按位置开着');
  ({ r } = drag(m, line(300, 260)));            // -84 − 40 = -124：橡皮筋
  assert.ok(Math.abs(r.offset - -band(124)) < 1e-9, String(r.offset));
  assert.ok(Math.abs(band(A + 1) - A - SWIPE.rubber) < 0.01, '刚过按钮宽：卡片只跟手指的一半');
  for (let d = A; d < 5000; d += 7) assert.ok(band(d + 7) >= band(d) && band(d + 7) <= CAP, '越拉越远，但最多 1.5 个按钮宽');
  assert.ok(band(400) < CAP && band(400) > A * 1.45, '拉开 400 px：已经贴着 1.5 个按钮宽');

  const n = createSwipeModel();
  ({ t } = drag(n, line(300, 270)));
  assert.deepEqual(n.up(t + 200), { kind: 'settle', to: 0 }, '只拖了 30 px：弹回去');
});

test('快速甩：按甩的方向开 / 关', () => {
  const m = createSwipeModel();
  let { t } = drag(m, line(300, 275, 2, 300), { dt: 20 });       // 25 px / 40 ms
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 }, '距离不到一半，但甩得快 → 开');
  ({ t } = drag(m, line(300, 320, 2), { dt: 20 }));                // 开着往回甩 20 px
  assert.deepEqual(m.up(t), { kind: 'settle', to: 0 });
  ({ t } = drag(m, [[200, 300], [260, 300], [262, 300]], { dt: 30 }));   // 往右拖 62 px，最后慢了
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: 1 }, '往右：露出左边的按钮');
  // 速度只看最后 100 ms：前面快、后面停住 → 按距离
  const n = createSwipeModel();
  n.down(300, 300, 0);
  n.move(260, 300, 16); n.move(255, 300, 200); n.move(254, 300, 300);
  assert.deepEqual(n.up(310), { kind: 'settle', to: -1 });
});

test('拖得再远、甩得再快：松手都只是开着（露出按钮），从来没有「直接做」', () => {
  const m = createSwipeModel();
  let { r, t } = drag(m, line(300, 300 - 195));                   // 以前「滑过 55% 直接做」的距离
  assert.ok(r.offset > -CAP, '卡片不追上手指');
  assert.deepEqual(m.up(t + 300), { kind: 'settle', to: -1 }, '慢慢松手：开着');
  assert.equal(m.open, -1);
  m.set(0);
  ({ t } = drag(m, line(340, -500, 6), { dt: 8 }));               // 一口气拖过卡片宽度一倍多、很快（105 px/8 ms）
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 });
  m.set(0);
  ({ t } = drag(m, line(100, 300), { dt: 12 }));                   // 往右 200 px：收藏那边
  assert.deepEqual(m.up(t), { kind: 'settle', to: 1 });
  m.set(0);
  ({ t } = drag(m, line(25, 900, 4), { dt: 10 }));                 // 往右狠甩 875 px
  assert.deepEqual(m.up(t), { kind: 'settle', to: 1 });
  m.set(0);
  ({ t } = drag(m, line(300, 160, 4), { dt: 25 }));                // 甩 140 px、1.4 px/ms
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 });
  ({ t } = drag(m, line(300, 240, 3), { dt: 15 }));                // 开着再往同一边甩：还是开着（不是「再甩一下就删」）
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 });
  ({ t } = drag(m, line(300, -300, 3), { dt: 15 }));
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 });
  assert.equal(m.open, -1);
});

test('点一下（没动到 10 px）→ tap，带着开没开；被打断时也不直接做', () => {
  const m = createSwipeModel();
  m.down(200, 300, 0); m.move(204, 302, 16);
  assert.deepEqual(m.up(40), { kind: 'tap', open: 0 });
  m.set(-1);
  m.down(200, 300, 100);
  assert.deepEqual(m.up(140), { kind: 'tap', open: -1 });
  assert.equal(m.open, -1, '点一下不改开关（页面去关）');
  m.set(0);
  drag(m, line(300, 50));
  assert.deepEqual(m.cancel(), { kind: 'settle', to: -1 }, '拉得很远又被系统打断：只是开着');
});

test('只有一边有按钮：另一边只能拉动一点点，松手弹回', () => {
  const m = createSwipeModel({ sides: [-1] });
  const { r, t } = drag(m, line(100, 300));
  assert.ok(r.offset > 0 && r.offset <= 16, String(r.offset));
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: 0 });
  m.set(1);
  assert.equal(m.open, 0);
});

test('触控板（wheel）：两指往左 → deltaX 为正 → 露出右边；攒够 10 px 再定方向；竖着的整下都不管；滑完按位置开关、不直接做', () => {
  const m = createSwipeModel();
  assert.deepEqual(m.wheel(4, 1, 0), { consumed: true, axis: null }, '横着的还没攒够：先挡住默认动作（Safari 的前进后退）');
  let r = m.wheel(8, 1, 16);
  assert.deepEqual([r.consumed, r.axis, r.offset, r.side], [true, 'h', -12, -1]);
  r = m.wheel(40, 0, 32);
  assert.equal(r.offset, -52);
  r = m.wheel(400, 0, 48);                       // 惯性一路加：最多拉到 1.5 个按钮宽，橡皮筋以后卡片移开不到 1.2 个
  assert.ok(Math.abs(r.offset - -band(A * SWIPE.wheelMax)) < 1e-9, String(r.offset));
  assert.ok(-r.offset < A * 1.2, String(r.offset));
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

test('斜着的：先横着滑出 10 多 px、再往上下甩，或者手指划个弧 → 松手只按位置 / 速度开关', () => {
  const run = (pts) => {
    const m = createSwipeModel();
    let t = 0, r = null;
    m.down(pts[0][0], pts[0][1], t);
    for (const [x, y] of pts.slice(1)) { t += 16; r = m.move(x, y, t); }
    return { r, up: m.up(t), open: m.open };
  };
  // 往左上：横 -160、竖 -230（55°）
  let o = run([[300, 500], [288, 497], [240, 430], [190, 350], [140, 270]]);
  assert.equal(o.r.axis, 'h', '头 10 px 是横着的：定成横着');
  assert.deepEqual([o.up, o.open], [{ kind: 'settle', to: -1 }, -1], '只是开着（不会误删）');
  // 往右下（收藏那边）也一样
  o = run([[120, 200], [132, 203], [180, 270], [230, 350], [280, 430]]);
  assert.deepEqual([o.up, o.open], [{ kind: 'settle', to: 1 }, 1], '只是开着（不会误改收藏）');
  // 手指自然划个弧（横 220、竖 60）：开着
  o = run(line(320, 100, 8).map(([x], i) => [x, 300 - i * 7.5]));
  assert.deepEqual(o.up, { kind: 'settle', to: -1 });
  // 快速甩 140 px、带 50 px 竖的：开着
  const m = createSwipeModel();
  const { t } = drag(m, [[300, 300], [265, 312], [230, 325], [195, 338], [160, 350]], { dt: 25 });
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 });
});

test('从开着的一边拉过中间：甩不算；拉够一个按钮宽才开另一边；拉得再远也只是开着另一边', () => {
  const m = createSwipeModel();
  m.set(-1);                                     // 删除露着，往右快速甩 120 px 想关上
  let { t } = drag(m, line(100, 220, 4), { dt: 16 });
  assert.deepEqual(m.up(t), { kind: 'settle', to: 0 }, '关上，不露出收藏');
  m.set(1);                                      // 收藏露着，往左狠狠甩 230 px
  ({ t } = drag(m, line(300, 70, 6), { dt: 16 }));
  assert.deepEqual(m.up(t), { kind: 'settle', to: -1 }, '不删：只是露出删除（-146，过了一个按钮宽）');
  m.set(-1);                                     // 删除露着，往右狠狠甩 270 px（已经收藏的会被取消）
  ({ t } = drag(m, line(60, 330, 6), { dt: 16 }));
  assert.deepEqual(m.up(t), { kind: 'settle', to: 1 }, '不改收藏：只是露出来');
  m.set(-1);                                     // 拉过中间、慢慢拉很远：只是露出收藏
  ({ t } = drag(m, line(40, 330, 10)));
  assert.deepEqual(m.up(t + 200), { kind: 'settle', to: 1 });
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
test('触控板惯性：开着的往回扫只会关上（不会扫到另一边）；扫得再猛卡片也只移开不到 1.2 个按钮宽；开着的往回扫一点点不关', () => {
  const play = (m, ds, t0) => { let t = t0, max = 0; for (const d of ds) { t += 16; const r = m.wheel(d, 0, t); if (r.offset != null) max = Math.max(max, Math.abs(r.offset)); } return max; };
  const m = createSwipeModel();
  const max = play(m, momentum(25, 8, 0.93), 0);                  // 猛地往左扫（加上惯性 500 多 px）
  assert.ok(max < A * 1.2, String(max));
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

/** 可重复的随机数（同一个种子同一串） */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test('随便怎么乱拖、乱甩、乱扫（几万步）：结果只有 tap / settle / none，卡片最多移开 1.5 个按钮宽，开关只会是有按钮的那边', () => {
  const R = rng(20261122);
  const pick = (xs) => xs[Math.floor(R() * xs.length)];
  for (let run = 0; run < 400; run++) {
    const sides = pick([[1, -1], [1], [-1]]);
    const m = createSwipeModel({ sides });
    let t = 0, x = 200, y = 300, down = false;
    for (let i = 0; i < 120; i++) {
      t += Math.floor(R() * 60);
      const op = R();
      let r;
      if (!down && op < 0.25) { x = R() * 400; y = R() * 800; r = m.down(x, y, t); down = r; assert.equal(typeof r, 'boolean'); }
      else if (down && op < 0.7) {
        x += (R() - 0.5) * pick([4, 30, 200, 900]); y += (R() - 0.5) * pick([2, 20, 200]);
        r = m.move(x, y, t);
        if (r && r.axis === 'h') {
          assert.deepEqual(Object.keys(r).sort(), ['axis', 'offset', 'side']);
          assert.ok(Math.abs(r.offset) <= CAP, String(r.offset));
        }
      } else if (down && op < 0.85) { r = m.up(t + pick([0, 0, 50, 300])); down = false; assert.ok(['tap', 'settle', 'none'].includes(r.kind), JSON.stringify(r)); }
      else if (down && op < 0.9) { r = m.cancel(); down = false; assert.ok(['settle', 'none'].includes(r.kind), JSON.stringify(r)); }
      else if (!down && op < 0.97) {
        r = m.wheel((R() - 0.5) * pick([5, 60, 400]), (R() - 0.5) * pick([0, 5, 60]), t);
        if (r.offset != null) assert.ok(Math.abs(r.offset) <= CAP, String(r.offset));
      } else if (!down) { r = m.wheelEnd(); assert.ok(['settle', 'none'].includes(r.kind), JSON.stringify(r)); }
      else if (R() < 0.5) { m.set(pick([1, -1, 0])); down = false; }
      assert.ok(m.open === 0 || sides.includes(m.open), String(m.open));
    }
  }
});
