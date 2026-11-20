// 床头模式那一页：最小 DOM + 照着引擎接口（core/bedside.js 的 Status）写的假引擎。不碰麦克风、IndexedDB，没有真的录音。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, bedLink } from '../src/views/bedside.js';
import { LIVE_LOCK } from '../src/core/bedside.js';
import { nightKey, autoEndAt } from '../src/core/nightReport.js';
import { localParts, fmtTime } from '../src/core/dates.js';
import { setLang, t } from '../src/i18n.js';
import { Element, find, installDom } from './helpers/dom.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));
const wait = ms => new Promise(r => setTimeout(r, ms));
const clock = ms => fmtTime(localParts(ms).time, 'zh-Hans');
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
const T0 = new Date(2026, 10, 17, 23, 41).getTime();       // 晚上11:41 开始（本机时区）
const CLIP = new Date(2026, 10, 18, 2, 13).getTime();       // 凌晨2:13 最近一段
const END7 = new Date(2026, 10, 18, 7, 0).getTime();        // 早上7:00 自动结束

/** 假引擎：阶段和状态由测试推着走；记下每次调用 */
function fakeEngine(log, prep) {
  let o = null, summary = null;
  let st = { phase: 'idle', sessionId: null, nightOf: null, startedAt: null, autoEndAt: null, listening: false, gap: null, clips: 0, lastClipAt: null,
    vad: 'loading', wake: false, capture: null, warn: null, error: null };
  const set = (patch) => { st = { ...st, ...patch }; o.onStatus({ ...st }); };
  const finish = (reason, extra = {}) => { set({ phase: 'ending' }); summary = { sessionId: 'n_1', nightOf: st.nightOf, reason, listenedMs: (7 * 60 + 12) * 60000, clips: st.clips, ...extra }; set({ phase: 'ended', listening: false }); };
  const eng = {
    get phase() { return st.phase; },
    prepare() { log.push(['prepare']); return Promise.resolve(typeof prep === 'function' ? prep() : prep); },
    start(a) { log.push(['start', a]); set({ phase: 'starting', autoEndAt: a.autoEndAt }); return Promise.resolve(); },
    tapResume() { log.push(['tapResume']); return Promise.resolve(); },
    end(reason = 'user') { log.push(['end', reason]); if (st.phase === 'live' || st.phase === 'starting') finish(reason); return Promise.resolve(summary); },
    dispose() { log.push(['dispose']); },
    status: () => ({ ...st }),
  };
  return { create: (opts) => { o = opts; return eng; }, eng, set, finish, opts: () => o };
}

function setup({ lang = 'zh-Hans', settings = {}, local = {}, night = {}, deps = {}, prep = { vad: 'ready', freeBytes: null, budgetSec: 3600 } } = {}) {
  const dom = installDom(); setLang(lang);
  const log = [], timers = [], jobs = new Set();
  const F = fakeEngine(log, prep);
  let guard = null, busy = false;
  const ctx = {
    t, lang: () => lang, device: 'Test',
    state: { settings: { nightStart: '21:00', nightEnd: '07:00', speakers: { nn: { name: '测试NN' }, me: { name: '' } }, ...settings } },
    local, setLocal: (p) => { Object.assign(local, p); log.push(['setLocal', p]); },
    night,
    sync: { pause: (tag) => { log.push(['pause', tag]); return () => log.push(['resume', tag]); } },
    toast: (msg) => log.push(['toast', msg]),
    navigate: (p) => log.push(['navigate', p]), back: (p) => log.push(['back', p]),
    guard: (fn, msg) => { guard = { fn, msg }; },
  };
  const main = new Element('main');
  const handle = render(main, { name: 'record', query: { bed: '1' } }, ctx, {
    createBedside: F.create, holdMs: 5, moveMs: 60000, locks: null, sttBusy: () => busy,
    onJob: (fn) => { jobs.add(fn); return () => jobs.delete(fn); },
    setInterval: (fn, ms) => { timers.push({ fn, ms, on: true }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].on = false; },
    ...deps });
  return { ...dom, main, ctx, log, F, handle, timers, guard: () => guard, setBusy: (b) => { busy = b; for (const fn of jobs) fn(); },
    btn: (label) => find(main, el => el.tag === 'button' && el.textContent.includes(label)),
    has: (s) => main.textContent.includes(s), el: (c) => byCls(main, c) };
}
const live = (env, patch = {}) => env.F.set({ phase: 'live', sessionId: 'n_1', nightOf: '2026-11-17', startedAt: T0, listening: true, vad: 'on', wake: true, ...patch });

test('准备：说明、清单（带 TA 的称呼）、到点自动结束；开关写进 bedAutoEnd；打开就载入说话识别，好了记下 bedVadOk', async () => {
  const env = setup();
  try {
    assert.ok(env.has(t('bed.title')) && env.has(t('bed.intro')));
    for (const k of ['bed.tipPower', 'bed.tipLock', 'bed.tipLowPower', 'bed.tipDnd', 'bed.tipLocal', 'bed.tipFirst']) assert.ok(env.has(t(k)), k);
    assert.ok(env.has(t('bed.tipNear', { nn: '测试NN' })));
    assert.ok(env.has(t('bed.autoEnd', { time: '早上7:00' })) && env.has(t('bed.autoEndHelp')));
    const sw = find(env.main, el => el.tag === 'input');
    assert.equal(sw.checked, true);                          // 默认开
    assert.equal(sw.attrs.role, 'switch');
    sw.checked = false; await sw.fire('change');
    assert.deepEqual(env.log.find(x => x[0] === 'setLocal'), ['setLocal', { bedAutoEnd: false }]);
    assert.equal(env.btn(t('bed.start')).disabled, true);     // 还没查完另一个窗口：先点不了，也不写原因
    assert.equal(env.el('bed-why').hidden, true);
    await tick(); await tick();
    assert.equal(env.btn(t('bed.start')).disabled, false);
    assert.deepEqual(env.log.filter(x => x[0] === 'prepare'), [['prepare']]);
    assert.equal(env.el('bed-vad').textContent, t('bed.vadReady'));
    assert.equal(env.el('bed-space').hidden, true);
    assert.ok(env.log.some(x => x[0] === 'setLocal' && x[1].bedVadOk === true));
    assert.ok(env.has(t('bed.tipFirst')), '这一屏画好以后清单不跳');
    assert.equal(env.ctx.local.bedVadOk, true);
  } finally { env.restore(); }
});

test('准备：用过以后不再说第一次要下载；说话识别用不了、空间不够时写出来；没有夜间时段 → 没有自动结束的开关', async () => {
  let loaded;
  const pending = new Promise(r => { loaded = r; });
  const env = setup({ local: { bedVadOk: true }, prep: () => pending });
  try {
    assert.ok(!env.has(t('bed.tipFirst')));
    assert.equal(env.el('bed-vad').hidden, true);            // 还没开始载：不说「正在准备」
    await tick();
    assert.equal(env.el('bed-vad').textContent, t('bed.vadLoading'));
    assert.equal(env.btn(t('bed.start')).disabled, false);    // 载着也能开始
    loaded({ vad: 'off', freeBytes: 1.2e9, budgetSec: 1200 });
    await tick(); await tick();
    assert.equal(env.el('bed-vad').textContent, t('bed.vadOff'));
    assert.equal(env.el('bed-space').textContent, t('bed.space', { free: '1.12 GB', min: 20 }));
    assert.ok(!env.log.some(x => x[0] === 'setLocal'));
  } finally { env.restore(); }
  const flat = setup({ settings: { nightStart: '22:00', nightEnd: '22:00' } });
  try {
    assert.equal(find(flat.main, el => el.tag === 'input'), undefined);
    await flat.btn(t('bed.start')).fire('click');
    assert.deepEqual(flat.log.find(x => x[0] === 'start'), ['start', { autoEndAt: null }]);
  } finally { flat.restore(); }
});

test('开不了：正在转文字 / 另一个窗口开着 / 存不了数据 → 「开始」点不了、写原因、不载说话识别；转完了就能点', async () => {
  const stt = setup();
  try {
    stt.setBusy(true);
    await tick(); await tick();
    assert.equal(stt.btn(t('bed.start')).disabled, true);
    assert.equal(stt.el('bed-why').textContent, t('bed.sttBusy'));
    assert.ok(!stt.log.some(x => x[0] === 'prepare'));
    stt.setBusy(false);
    assert.equal(stt.btn(t('bed.start')).disabled, false);
    assert.equal(stt.el('bed-why').hidden, true);
    await tick();
    assert.deepEqual(stt.log.filter(x => x[0] === 'prepare'), [['prepare']]);
  } finally { stt.restore(); }
  const other = setup({ deps: { locks: { query: async () => ({ held: [{ name: LIVE_LOCK }], pending: [] }) } } });
  try {
    await tick(); await tick();
    assert.equal(other.btn(t('bed.start')).disabled, true);
    assert.equal(other.el('bed-why').textContent, t('bed.otherTab'));
    assert.ok(!other.log.some(x => x[0] === 'prepare'));
  } finally { other.restore(); }
  const none = setup({ night: null });
  try {
    await tick(); await tick();
    assert.equal(none.btn(t('bed.start')).disabled, true);
    assert.equal(none.el('bed-why').textContent, t('bed.noStore'));
    assert.ok(!none.log.some(x => x[0] === 'prepare'));
  } finally { none.restore(); }
});

test('点「开始」：先暂停同步，再在同一次点按里 engine.start({ autoEndAt })；关掉自动结束 → null', async () => {
  const env = setup();
  try {
    await tick();
    const before = Date.now();
    const p = env.btn(t('bed.start')).fire('click');
    // fire 还没 await 完：同步部分已经做完
    const i = env.log.findIndex(x => x[0] === 'pause'), j = env.log.findIndex(x => x[0] === 'start');
    assert.ok(i >= 0 && j > i, JSON.stringify(env.log));
    assert.equal(env.log[i][1], 'bedside');
    assert.ok([autoEndAt(before, env.ctx.state.settings), autoEndAt(Date.now(), env.ctx.state.settings)].includes(env.log[j][1].autoEndAt));
    assert.ok(env.log[j][1].autoEndAt > before);
    await p;
    assert.ok(env.has(t('bed.starting')));
    assert.equal(env.el('bed-start'), undefined);
  } finally { env.restore(); }
  const off = setup({ local: { bedAutoEnd: false } });
  try {
    assert.ok(!find(off.main, el => el.tag === 'input').checked);
    await off.btn(t('bed.start')).fire('click');
    assert.deepEqual(off.log.find(x => x[0] === 'start'), ['start', { autoEndAt: null }]);
  } finally { off.restore(); }
});

test('整夜：纯黑那一屏的暗字（在听 / 存了几段 / 最近一段），暂停和原因，读屏的状态；状态变了才重写字', async () => {
  const env = setup();
  try {
    await env.btn(t('bed.start')).fire('click');
    live(env);
    const root = env.el('bed'), box = env.el('bed-box');
    assert.ok(root && box);
    const [l1, l2] = box.children;
    assert.equal(l1.textContent, `${t('bed.listening')} · ${t('bed.since', { time: '晚上11:41' })} · ${t('bed.noClips')}`);
    assert.equal(l2.hidden, true);
    const sr = find(env.main, el => cls(el, 'sr-only'));
    assert.equal(sr.textContent, t('bed.listening'));
    assert.equal(env.el('bed-warn').hidden, true);
    live(env, { clips: 2, lastClipAt: CLIP });
    assert.equal(l1.textContent, '在听 · 晚上11:41 开始 · 存了 2 段');
    assert.equal(l2.textContent, '最近一段 凌晨2:13');
    assert.equal(env.el('bed-box'), box, '同一屏不重画');
    live(env, { gap: { reason: 'muted', from: CLIP + 60000, needTap: false } });
    assert.equal(l1.textContent, t('bed.paused', { why: t('night.why.muted') }));
    assert.equal(l1.textContent, '暂停了：麦克风被占用了（来电、Siri 或别的 App）');
    assert.equal(l2.textContent, t('bed.pausedSub'));
    assert.equal(sr.textContent, l1.textContent);
    assert.equal(env.el('bed-tap').hidden, true);
    live(env, { gap: { reason: 'weird', from: CLIP } });                // 不认识的原因 → 出了点问题
    assert.equal(l1.textContent, t('bed.paused', { why: t('night.why.error') }));
    live(env, { gap: null });
    assert.equal(l1.textContent, '在听 · 晚上11:41 开始 · 存了 2 段');
    assert.equal(sr.textContent, t('bed.listening'));
  } finally { env.restore(); }
});

test('整夜：警告一次一条（存不进 > 常亮 > 说话识别 > 存够了）；要点一下 → 整屏「点一下，接着听」，点了 tapResume', async () => {
  const env = setup();
  try {
    await env.btn(t('bed.start')).fire('click');
    const warn = () => env.el('bed-warn');
    live(env, { wake: false, vad: 'off', warn: 'store' });
    assert.equal(warn().textContent, t('bed.storeFail'), '存不进（声音在丢）排第一');
    live(env, { wake: false, vad: 'off', warn: 'full' });
    assert.equal(warn().textContent, t('bed.noWake'));
    live(env, { wake: true, vad: 'off', warn: 'full' });
    assert.equal(warn().textContent, t('bed.energy'));
    live(env, { vad: 'on', warn: 'store' });
    assert.equal(warn().textContent, t('bed.storeFail'));
    live(env, { warn: 'full' });
    assert.equal(warn().textContent, t('bed.full'));
    live(env, { warn: null, vad: 'loading' });
    assert.equal(warn().hidden, true);

    live(env, { gap: { reason: 'ended', from: CLIP, needTap: true } });
    const tap = env.el('bed-tap');
    assert.equal(tap.hidden, false);
    assert.equal(env.el('bed-box').hidden, true);
    assert.equal(env.el('bed-end').hidden, true);
    assert.ok(tap.textContent.includes(t('bed.tap')));
    assert.ok(tap.textContent.includes(t('bed.tapSub', { why: t('night.why.ended') })));
    assert.equal(find(env.main, el => cls(el, 'sr-only')).textContent, t('bed.tap'));
    assert.equal(env.doc.activeElement, tap);
    await tap.fire('click');
    assert.deepEqual(env.log.filter(x => x[0] === 'tapResume'), [['tapResume']]);
    live(env, { gap: null });
    assert.equal(tap.hidden, true);
    assert.equal(env.el('bed-box').hidden, false);
  } finally { env.restore(); }
});

test('按住结束：点一下只提示；按住（holdMs）才 end(\'user\')；状态字的位置只在 moveMs 到时换', async () => {
  const env = setup();
  try {
    await env.btn(t('bed.start')).fire('click');
    live(env, { clips: 1, lastClipAt: CLIP });
    const box = env.el('bed-box'), end = env.el('bed-end');
    assert.equal(end.textContent, t('bed.endHold'));
    assert.equal(end.attrs['data-toast-avoid'], '');
    const move = env.timers.filter(x => x.on);
    assert.deepEqual(move.map(x => x.ms), [60000]);
    const at0 = box.style.transform;
    assert.equal(at0, 'translate(0px, 0px)');
    live(env, { clips: 2 });
    assert.equal(box.style.transform, at0, '状态变了不挪');
    const seen = new Set([at0]);
    for (let i = 0; i < 8; i++) { move[0].fn(); seen.add(box.style.transform); }
    assert.equal(seen.size, 9);
    for (const s of seen) for (const v of s.match(/-?\d+/g)) assert.ok(Math.abs(Number(v)) <= 24, s);
    move[0].fn();
    assert.equal(box.style.transform, at0);                   // 9 个位置轮一圈

    await end.fire('click');
    assert.deepEqual(env.log.filter(x => x[0] === 'toast'), [['toast', t('bed.endTap')]]);
    assert.ok(!env.log.some(x => x[0] === 'end'));
    await end.fire('pointerdown');
    assert.ok(cls(end, 'pressing'));
    await wait(30);
    assert.deepEqual(env.log.find(x => x[0] === 'end'), ['end', 'user']);
    await end.fire('click');                                  // 松手后的那次点按不再提示
    assert.equal(env.log.filter(x => x[0] === 'toast').length, 1);
    assert.equal(move[0].on, false, '离开整夜那一屏就不挪了');
  } finally { env.restore(); }
});

test('结束：听了多久、存了几段，恢复同步；「去看这一晚」→ /night/<日期>，「完成」→ 返回；到点自动结束的说几点', async () => {
  const env = setup();
  try {
    await env.btn(t('bed.start')).fire('click');
    live(env, { clips: 3, lastClipAt: CLIP });
    assert.ok(!env.log.some(x => x[0] === 'resume'));
    await env.el('bed-end').fire('pointerdown'); await wait(30); await tick();
    assert.ok(env.has(t('bed.ended')));
    assert.ok(env.has('听了 7 小时 12 分 · 存了 3 段'), env.main.textContent);
    assert.deepEqual(env.log.filter(x => x[0] === 'pause' || x[0] === 'resume'), [['pause', 'bedside'], ['resume', 'bedside']]);
    await env.btn(t('bed.seeNight')).fire('click');
    assert.deepEqual(env.log.at(-1), ['navigate', '/night/2026-11-17']);
    await env.btn(t('common.done')).fire('click');
    assert.deepEqual(env.log.at(-1), ['back', '/']);
  } finally { env.restore(); }
  const auto = setup();
  try {
    await auto.btn(t('bed.start')).fire('click');
    live(auto, { autoEndAt: END7 });
    auto.F.finish('auto');                                    // 引擎自己到点结束（不是这一页叫的）：再问一次 end() 拿结果
    await tick(); await tick();
    assert.ok(auto.has(t('bed.endedAuto', { time: '早上7:00' })));
    assert.ok(auto.has(`${t('bed.listened', { dur: '7 小时 12 分' })} · ${t('bed.endedNone')}`), auto.main.textContent);
    assert.ok(auto.log.some(x => x[0] === 'resume'));
    assert.equal(auto.el('bed-h').tag, 'h1');
    assert.ok(auto.has(t('bed.lockBack')), '提醒把自动锁定改回来');
  } finally { auto.restore(); }
  // 有没存进来的：照实说（一段都没存进来时不说「没听到像说话的声音」）
  for (const [clips, unsaved, want] of [[1, 2, '存了 1 段 · 2 段没存进这台设备'], [0, 2, '听了 7 小时 12 分 · 2 段没存进这台设备']]) {
    const e = setup();
    try {
      await e.btn(t('bed.start')).fire('click');
      live(e, { clips });
      e.F.finish('auto', { unsaved });
      await tick(); await tick();
      assert.ok(e.el('bed-sum').textContent.endsWith(want), e.el('bed-sum').textContent);
      assert.ok(!e.has(t('bed.endedNone')));
    } finally { e.restore(); }
  }
});

test('离开保护：开着（和正在开）的时候用床头模式的说法；准备和结束以后不拦', async () => {
  const env = setup();
  try {
    const g = env.guard();
    assert.deepEqual(g.msg, { message: t('bed.leaveQ'), confirmLabel: t('bed.leave'), cancelLabel: t('bed.stay') });
    assert.equal(g.fn(), false);
    await env.btn(t('bed.start')).fire('click');
    assert.equal(g.fn(), true);
    live(env);
    assert.equal(g.fn(), true);
    env.F.finish('user');
    assert.equal(g.fn(), false);
    await tick(); await tick();
  } finally { env.restore(); }
});

test('清理：开着 → end(\'leave\') 并恢复同步、停掉挪位置；没开始 → dispose()；onChange 不重画', async () => {
  const env = setup();
  try {
    await env.btn(t('bed.start')).fire('click');
    live(env, { clips: 1, lastClipAt: CLIP });
    const box = env.el('bed-box'), text = box.textContent;
    env.handle.onChange({});
    assert.equal(env.el('bed-box'), box);
    assert.equal(box.textContent, text);
    env.handle.cleanup();
    await tick();
    assert.deepEqual(env.log.find(x => x[0] === 'end'), ['end', 'leave']);
    assert.ok(!env.log.some(x => x[0] === 'dispose'));
    assert.deepEqual(env.log.filter(x => x[0] === 'resume'), [['resume', 'bedside']]);
    assert.ok(env.timers.every(x => !x.on));
  } finally { env.restore(); }
  const idle = setup();
  try {
    await tick();
    idle.handle.cleanup();
    assert.deepEqual(idle.log.filter(x => x[0] === 'dispose' || x[0] === 'end' || x[0] === 'resume'), [['dispose']]);
  } finally { idle.restore(); }
});

test('离开时还在收尾（存最后一段、放开麦克风和锁）：马上又打开的床头页等它收完，才查锁、载入、让点「开始」', async () => {
  let done;
  const slow = new Promise(r => { done = r; });
  const env = setup();
  try {
    await tick();
    await env.btn(t('bed.start')).fire('click');
    live(env);
    env.F.eng.end = (reason) => { env.log.push(['end', reason]); return slow; };
    env.handle.cleanup();
    assert.deepEqual(env.log.find(x => x[0] === 'end'), ['end', 'leave']);
  } finally { env.restore(); }
  const again = setup();
  try {
    await tick(); await tick();
    assert.equal(again.btn(t('bed.start')).disabled, true);
    assert.equal(again.el('bed-why').hidden, true);
    assert.ok(!again.log.some(x => x[0] === 'prepare'));
    done(null);
    await tick(); await tick();
    assert.equal(again.btn(t('bed.start')).disabled, false);
    assert.deepEqual(again.log.filter(x => x[0] === 'prepare'), [['prepare']]);
    again.handle.cleanup();
  } finally { again.restore(); }
});

test('开不了的原因：麦克风类的用录音页的说法（rec.err.*），另一个窗口等用 bed.*；「再试一次」重新开始，同步恢复', async () => {
  const env = setup();
  try {
    await env.btn(t('bed.start')).fire('click');
    env.F.set({ phase: 'error', error: { code: 'denied', message: 'NotAllowedError' } });
    assert.ok(env.has(t('rec.err.denied.t')) && env.has(t('rec.err.denied')));
    assert.deepEqual(env.log.filter(x => x[0] === 'pause' || x[0] === 'resume').map(x => x[0]), ['pause', 'resume']);
    await env.btn(t('rec.retry')).fire('click');
    assert.equal(env.log.filter(x => x[0] === 'start').length, 2);
    assert.equal(env.log.filter(x => x[0] === 'pause').length, 2);
    env.F.set({ phase: 'error', error: { code: 'otherTab' } });
    assert.ok(env.has(t('bed.cantStart')) && env.has(t('bed.otherTab')));
    env.F.set({ phase: 'error', error: { code: 'failed', message: 'boom' } });
    assert.ok(env.has(t('rec.err.failed', { msg: 'boom' })));
    env.F.set({ phase: 'error', error: { code: 'strange' } });                 // 不认识的 → 没能开始
    assert.ok(env.has(t('rec.err.failed.t')));
    env.F.set({ phase: 'error', error: { code: 'unsupported' } });
    assert.ok(env.has(t('rec.err.unsupported.t')));
    assert.equal(env.btn(t('rec.retry')), undefined);
    await env.btn(t('common.back')).fire('click');
    assert.deepEqual(env.log.at(-1), ['back', '/']);
  } finally { env.restore(); }
});

test('录音页的入口：平时是一般的说法；今晚断了（App 被关掉 / 离开了那页）不到 6 小时 → 「… 断了，点这里接着听」；点了去 /rec?bed=1', async () => {
  const S = { nightStart: '21:00', nightEnd: '07:00' };
  const link = async (sessions, extra = {}) => {
    const dom = installDom(); setLang('zh-Hans');
    const nav = [];
    try {
      const b = bedLink({ t, lang: () => 'zh-Hans', state: { settings: S }, navigate: p => nav.push(p), night: { listSessions: async () => sessions }, ...extra });
      const first = b.textContent;
      await tick(); await tick(); await tick();
      await b.fire('click');
      return { first, text: b.textContent, nav, b };
    } finally { dom.restore(); }
  };
  const now = Date.now(), tonight = nightKey(now, S);
  const s = (o) => ({ id: 'n_' + Math.random(), nightOf: tonight, startedAt: now - 5 * 3600000, endedAt: now - 3600000, status: 'ended', endReason: 'user', gaps: [], ...o });
  const plain = await link([]);
  assert.equal(plain.first, t('bed.link'));
  assert.equal(plain.text, t('bed.link'));
  assert.deepEqual(plain.nav, ['/rec?bed=1']);
  assert.equal(plain.b.tag, 'button');
  const crashed = await link([s({ startedAt: now - 9 * 3600000 }), s({ status: 'crashed', endReason: 'killed' })]);
  assert.equal(crashed.text, t('bed.linkBroken', { time: clock(now - 3600000) }));
  assert.deepEqual(crashed.nav, ['/rec?bed=1']);
  assert.equal((await link([s({ endReason: 'leave' })])).text, t('bed.linkBroken', { time: clock(now - 3600000) }));
  assert.equal((await link([s({})])).text, t('bed.link'));                                        // 自己结束的
  assert.equal((await link([s({ endReason: 'auto' })])).text, t('bed.link'));
  assert.equal((await link([s({ status: 'crashed', endReason: 'killed', endedAt: now - 7 * 3600000 })])).text, t('bed.link'));   // 太久了
  assert.equal((await link([s({ status: 'crashed', endReason: 'killed', nightOf: '2020-01-01' })])).text, t('bed.link'));        // 不是今晚
  assert.equal((await link([s({ status: 'crashed' }), s({ startedAt: now - 1800000 })])).text, t('bed.link'));                   // 看最后一次
  assert.equal((await link(null, { night: null })).text, t('bed.link'));                                                      // 没有 ctx.night 也行
  // 等开机找回（recoverNights）做完再看：之前崩掉的还标着 live
  let done;
  const gate = new Promise(r => { done = r; });
  const dom = installDom(); setLang('zh-Hans');
  try {
    const b = bedLink({ t, lang: () => 'zh-Hans', state: { settings: S }, navigate() {}, nightRecovered: gate, night: { listSessions: async () => [s({ status: 'crashed', endReason: 'killed' })] } });
    await tick(); await tick();
    assert.equal(b.textContent, t('bed.link'));
    done(); await tick(); await tick(); await tick();
    assert.equal(b.textContent, t('bed.linkBroken', { time: clock(now - 3600000) }));
  } finally { dom.restore(); }
});

test('繁體和英文也画得出来，不留 {变量}', async () => {
  const bad = /\{\w+\}|undefined|null|NaN/;
  for (const lang of ['zh-Hant-TW', 'en']) {
    const env = setup({ lang, prep: { vad: 'off', freeBytes: 1e8, budgetSec: 600 } });
    try {
      await tick(); await tick(); await tick();
      assert.doesNotMatch(env.main.textContent, bad);
      assert.ok(env.has(t('bed.space', { free: '95.4 MB', min: 10 })), env.main.textContent);
      await env.btn(t('bed.start')).fire('click');
      live(env, { clips: 2, lastClipAt: CLIP, gap: null });
      assert.doesNotMatch(env.main.textContent, bad);
      if (lang === 'en') assert.equal(env.el('bed-box').children[0].textContent, 'Listening · since 11:41 PM · 2 clips saved');
      env.F.finish('user'); await tick(); await tick();
      assert.doesNotMatch(env.main.textContent, bad);
      if (lang === 'en') assert.ok(env.has('Listened for 7 h 12 min · 2 clips saved'), env.main.textContent);
    } finally { setLang('zh-Hans'); env.restore(); }
  }
});
