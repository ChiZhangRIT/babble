// 昨夜（#/night）：最小 DOM + 真的 state.js、memoryStore（录音库）、memoryNightStore（床头模式的记录）、真的 keepClips。
// 一晚是编的：两次床头模式、一段没在听、一段一直有声音、四段编的 PCM 片段（仓库是公开的，没有真的录音和梦话）。
// 时间按跑测试的机器的本地时区（session 的 tz 是 null），而且避开 1:00–4:00（夏令时切换的那一小时在这里面）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, nightBanner } from '../src/views/night.js';
import { nightReport, nightCard, reportLines, textSummary, addDays } from '../src/core/nightReport.js';
import { memoryNightStore } from '../src/core/nightStore.js';
import { memoryStore } from '../src/core/audioStore.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, deletedRecord, purgedRecord, goneShas } from '../src/core/store.js';
import { fmtDate, today } from '../src/core/dates.js';
import { setLang, t } from '../src/i18n.js';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';

const SR = 16000;
const D = today(), Y = addDays(D, -1), Y3 = addDays(D, -3);
/** 本地时间 'YYYY-MM-DD' + 'HH:MM' → 毫秒 */
const at = (date, hm, sec = 0) => { const [y, m, d] = date.split('-').map(Number); const [H, M] = hm.split(':').map(Number); return new Date(y, m - 1, d, H, M, sec).getTime(); };
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
const allCls = (root, c) => all(root, el => cls(el, c));
const btn = (root, label) => find(root, el => el.tag === 'button' && el.textContent.includes(label));
const titleOf = (date) => t('night.title', { date: fmtDate(date, 'zh-Hans', { year: false }) });

/** 编的 PCM16：seed 不同内容就不同（sha 也不同） */
const pcm = (n, seed) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = ((i * 37 + seed * 101) % 2000) - 1000; return a; };
const session = (id, nightOf, from, to, extra = {}) => ({ id, v: 1, nightOf, startedAt: from, endedAt: to, status: 'ended', endReason: 'auto', tz: null,
  device: '测试机', gaps: [], notes: [], counts: { clips: 0, dropped: 1 }, reviewedAt: null, ...extra });
/** 一段 state 'new' 的候选和它每秒一片的 PCM → 返回 PCM */
async function cand(night, id, s, startAt, sec, extra = {}) {
  const samples = Math.round(sec * SR), data = pcm(samples, Number(id.replace(/\D/g, '')) || 7);
  let seq = 0;
  for (let i = 0; i < samples; i += SR) await night.putPart(id, seq++, { b: data.slice(i, i + SR).buffer, ls: Math.min(i + SR, samples), sp: 1 });
  await night.putCand({ id, s, v: 1, state: 'new', startAt, speechAt: startAt + 8000, endAt: startAt + samples * 1000 / SR, samples, sr: SR,
    durationSec: Math.round(sec * 10) / 10, speechSec: 1, gateSec: 1, peakDb: -30, vadMax: 0.9, cut: 'quiet', contOf: null, parts: seq, lostSec: 0, ...extra });
  return data;
}
/** 昨夜：23:40 开始，0:30–0:40 麦克风被占用、0:50 有 5 秒中断，4:00 离开了那一页；4:05 又开始，5:10–5:13 一直有声音，7:00 自动结束 */
async function seedNight(night) {
  await night.putSession(session('n_a', Y, at(Y, '23:40'), at(D, '04:00'), { endReason: 'leave',
    gaps: [{ from: at(D, '00:30'), to: at(D, '00:40'), reason: 'muted' }, { from: at(D, '00:50'), to: at(D, '00:50', 5), reason: 'stall' }] }));
  await night.putSession(session('n_b', Y, at(D, '04:05'), at(D, '07:00'), { notes: [{ kind: 'noise', from: at(D, '05:10'), to: at(D, '05:13') }] }));
  const p = {};
  p.c_1 = await cand(night, 'c_1', 'n_a', at(D, '00:10'), 3, { samples: 40000 });   // 收尾时最后一片比片段长：只放到 samples 为止
  p.c_2 = await cand(night, 'c_2', 'n_a', at(D, '00:11'), 2, { cut: 'noise' });
  p.c_3 = await cand(night, 'c_3', 'n_b', at(D, '05:20'), 2, { cut: 'crash' });
  p.c_4 = await cand(night, 'c_4', 'n_b', at(D, '06:00'), 1.5);
  await night.logEvent('n_a', at(Y, '23:40'), 'start', { rate: 48000 });
  await night.logEvent('n_b', at(D, '07:00'), 'end', { reason: 'auto' });
  return p;
}

/** 假 ctx（照着 app.js：put / undo 走真的 state，带 undoLabel 的修改外壳会弹「撤销」，数据变了调页面的 onChange） */
async function setup({ seed = seedNight, local = {}, id = null, answer = true, noNight = false, lang = 'zh-Hans', undoHoldMs = 10, purgeEnabled = false } = {}) {
  const copied = [], shared = [];
  const dom = installDom({ navigator: { clipboard: { writeText: async (s) => { copied.push(s); } }, canShare: () => true, share: async (d) => { shared.push(d); } } });
  setLang(lang);
  state.load({ storage: fakeStorage(), locks: null });
  state.setLocal(local);
  const night = memoryNightStore(), audio = memoryStore();
  const pcms = seed ? await seed(night) : {};
  const log = [], toasts = [], confirms = [], players = [], navs = [], ons = [];
  const env = { ...dom, night, audio, pcms, log, toasts, confirms, players, navs, ons, copied, shared, answer, handle: null };
  const ctx = env.ctx = {
    t, lang: () => lang, layout: () => 'phone',
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    entry: (eid) => { const e = state.getState().data.entries[eid]; return e && !e.purged ? e : null; }, newEntry: (f) => makeEntry(f),   // 墓碑：ctx.entry 不给
    tombstone: (eid) => { const e = state.getState().data.entries[eid]; return e && e.purged ? e : null; },
    goneShas: () => goneShas(state.getState()),
    put(e, opts) { state.mutate(s => { s.data.entries[e.id] = normalizeEntry(stamp(e, s.data.entries[e.id]), e.id); }, opts); return ctx.entry(e.id); },
    mutate: (fn, opts) => state.mutate(fn, opts), undo: () => state.undo(), on: (ev, fn) => ons.push([ev, fn]),
    audio, night: noNight ? undefined : night, nightRecovered: Promise.resolve(),
    sync: { pause: (tag) => { log.push(['pause', tag]); return () => log.push(['resume', tag]); } },
    toast: (msg, o = {}) => toasts.push({ msg, ...o }), confirm: async (o) => { confirms.push(o); return env.answer; },
    navigate: (p, o) => navs.push([p, o]), back: (p) => navs.push(['back', p]),
  };
  const off = state.subscribe((s, info) => {
    if (info.undoLabel) toasts.push({ msg: info.undoLabel, shell: true });
    queueMicrotask(() => { if (env.handle) env.handle.onChange(info); for (const [ev, fn] of ons) if (ev === 'change') fn(info); });
  });
  env.main = new Element('main');
  const player = (o) => { const el = document.createElement('div'); el.setAttribute('class', 'player'); el.opts = o; el.destroy = () => { el.destroyed = true; }; players.push(el); return el; };
  env.handle = render(env.main, { name: 'night', id, query: {} }, ctx, { player, undoHoldMs, purgeEnabled });
  await settle();
  Object.assign(env, {
    text: () => env.main.textContent,
    row: (cid) => allCls(env.main, 'nt-clip').find(r => (players.find(p => p.opts.key === 'cand:' + cid && !p.destroyed && r.contains(p)))),
    async check(cid) { const box = find(env.row(cid), el => el.tag === 'input'); box.checked = true; await box.fire('change'); },
    bar: () => byCls(env.main, 'nt-bar'),
    async click(label, root = env.main) { const b = btn(root, label); assert.ok(b, label); await b.fire('click'); await settle(); },
    cand: async (cid) => (await night.listCands()).find(c => c.id === cid),
    entries: () => Object.values(state.getState().data.entries).filter(e => !e.deleted),
    done() { if (env.handle) env.handle.cleanup(); env.handle = null; off(); dom.restore(); },
  });
  return env;
}

test('记录：几点到几点、没在听的时候（原因、短暂中断、一直有声音）；片段按前后分组，带标签和完整播放器；开着这页不暂停同步（只在留下以后等撤销）', async () => {
  const env = await setup();
  try {
    assert.deepEqual(env.log, []);
    assert.equal(byCls(env.main, 'nb-title').textContent, t('night.last'));
    const r = nightReport({ sessions: await env.night.listSessions(), cands: await env.night.listCands(), nightOf: Y });
    const L = reportLines(r, { t, lang: 'zh-Hans' });
    assert.equal(byCls(env.main, 'nt-range').textContent, L.range);
    assert.ok(L.range.startsWith('晚上11:40–早上7:00 · 听了 '), L.range);
    assert.deepEqual(allCls(env.main, 'nt-h').map(x => x.textContent), ['没在听的时候', '这晚还有']);
    const lis = (c) => all(byCls(env.main, c), el => el.tag === 'li').map(li => li.textContent);
    assert.deepEqual(lis('nt-away'), [
      '凌晨0:30–0:40 没在听：麦克风被占用了（来电、Siri 或别的 App）',
      '凌晨4:00–4:05 没在听：离开了床头模式那一页',
      '另外有 1 次短暂中断，一共 5 秒']);
    assert.deepEqual(lis('nt-also'), ['早上5:10–5:13 一直有声音（像电视、风扇），只存了前 3 分钟'], '一直有声音的时候也在听：不放在「没在听」下面');
    for (const c of ['nt-live', 'nt-note', 'nt-empty']) assert.equal(byCls(env.main, c), undefined, c);
    assert.equal(byCls(env.main, 'nt-hint').textContent, t('night.hint'));

    assert.deepEqual(allCls(env.main, 'nt-ep-h').map(x => x.children[0].textContent), ['凌晨0:10 前后 · 2 段', '早上5:20 前后 · 1 段', '早上6:00 前后 · 1 段']);
    assert.deepEqual(allCls(env.main, 'nt-group').map(b => b.textContent), [t('night.pickGroup')]);     // 只有一段的组不用「选这一组」
    assert.deepEqual(allCls(env.main, 'nt-meta').map(m => m.textContent), [
      '凌晨0:10 · 0:03', '凌晨0:11 · 0:02一直有声音', '早上5:20 · 0:02没录完（App 被关掉了）', '早上6:00 · 0:02']);
    assert.ok(find(env.row('c_2'), el => cls(el, 'tag') && el.textContent === t('night.noiseTag')));
    assert.equal(allCls(env.main, 'nt-x').length, 4);
    assert.equal(find(env.row('c_1'), el => el.tag === 'input').attrs['aria-label'], '选这段 凌晨0:10');

    // 播放器：key 是 cand:<id>，时长是片段的；点 ▶ 时才从分片拼 WAV（44 字节头 + 原样的 PCM）
    assert.deepEqual(env.players.map(p => [p.opts.key, p.opts.durationSec]), [['cand:c_1', 3], ['cand:c_2', 2], ['cand:c_3', 2], ['cand:c_4', 1.5]]);
    const blob = await env.players[0].opts.getBlob();
    assert.equal(blob.type, 'audio/wav');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(bytes.length, 44 + 40000 * 2);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
    assert.deepEqual(new Int16Array(bytes.slice(44).buffer), env.pcms.c_1.slice(0, 40000));

    assert.equal(btn(env.bar(), '').textContent, '昨夜没有梦话');
    assert.equal(byCls(env.main, 'nt-foot').textContent, t('night.retain'));            // 没开同步：不说「10 秒后才同步」
    assert.equal(byCls(env.main, 'nt-others'), undefined);
    assert.equal(byCls(env.main, 'nt-older'), undefined);                               // 只有这一晚

    // 数据变了只重画（播放器换新的、旧的 destroy），不重读
    const before = env.night.calls.length, old = [...env.players];
    env.handle.onChange({ source: 'local' });
    assert.ok(old.every(p => p.destroyed));
    assert.equal(env.players.length, 8);
    assert.equal(env.night.calls.length, before);
    env.handle.cleanup();
    assert.ok(env.players.every(p => p.destroyed));
    env.handle = null;
    assert.deepEqual(env.log, []);
  } finally { env.done(); }
});

test('勾两段 → 留下：一条待整理、两段 WAV 都在录音库；开着同步第一次先说一句（只说一次）；提示条上撤销 → 那条进「最近删除」、回到待听；再留恢复那条', async () => {
  const env = await setup({ local: { sync: { repo: 'me/dreams' } } });
  try {
    assert.equal(byCls(env.main, 'nt-foot').textContent, t('night.syncHeld') + t('night.retain'));
    await env.check('c_1'); await env.check('c_2');
    assert.ok(cls(env.row('c_1'), 'on'));
    assert.equal(byCls(env.main, 'nt-group').attrs['aria-pressed'], 'true');
    assert.equal(byCls(env.bar(), 'nt-keep').textContent, '留下选中的 2 段合成一条，放进「待整理」');
    await env.click('留下选中的 2 段');
    assert.deepEqual(env.confirms.map(c => [c.message, c.confirmLabel, c.cancelLabel]), [[t('night.syncNote'), t('night.syncOk'), t('night.syncNo')]]);
    assert.equal(env.ctx.local.bedKeepNoted, true);
    const [e] = env.entries();
    assert.equal(env.entries().length, 1);
    assert.equal(e.status, 'inbox');
    assert.deepEqual(e.source, { kind: 'app', night: Y });
    assert.deepEqual(e.audio.map(a => [a.mime, a.name, a.durationSec]), [['audio/wav', '00:10', 2.5], ['audio/wav', '00:11', 2]]);
    for (const a of e.audio) assert.equal(await env.audio.hasClip(a.sha256), true);
    const kt = env.toasts.find(x => x.msg === '留下了 2 段，放进了「待整理」');
    assert.deepEqual([kt.ms, kt.action.label, kt.shell], [10000, t('common.undo'), undefined], '页面自己弹（不走外壳的通用撤销）');
    assert.ok(!env.toasts.some(x => x.shell));
    assert.equal((await env.cand('c_1')).entryId, e.id);
    assert.equal((await env.cand('c_2')).entryId, e.id);
    const kept = allCls(env.main, 'nt-kept');
    assert.deepEqual(kept.map(a => [a.attrs.href, a.textContent]), [['#/e/' + e.id, '已留下 · 去看看'], ['#/e/' + e.id, '已留下 · 去看看']]);
    assert.equal(allCls(env.main, 'nt-group').length, 0);
    assert.equal(btn(env.bar(), '').textContent, '其余都删');

    // 再留一段：不再问；一段 = 放进「待整理」
    await env.check('c_3');
    assert.equal(byCls(env.bar(), 'nt-keep').textContent, '留下选中的 1 段放进「待整理」');
    await env.click('留下选中的 1 段');
    assert.equal(env.confirms.length, 1);
    assert.equal(env.entries().length, 2);
    assert.equal(env.row('c_3'), undefined);

    // 撤销刚才那条：那段回到待听（还能勾），那条进「最近删除」，之前那条不动
    const e3 = env.entries().find(x => x.id !== e.id);
    env.toasts.at(-1).action.run(); await settle();
    assert.equal(env.toasts.at(-1).msg, t('common.undone'));
    assert.equal(env.entries().length, 1);
    assert.equal(env.ctx.entry(e3.id).deleted, true);
    assert.equal((await env.cand('c_3')).entryId, null);
    assert.ok(env.row('c_3') && find(env.row('c_3'), el => el.tag === 'input'));
    assert.equal(allCls(env.main, 'nt-kept').length, 2);
    // 再留这一段：恢复「最近删除」里那条，不建重复的
    await env.check('c_3');
    await env.click('留下选中的 1 段');
    assert.equal(env.entries().length, 2);
    assert.equal(env.ctx.entry(e3.id).deleted, undefined);
    assert.equal((await env.cand('c_3')).entryId, e3.id);
    assert.equal(Object.keys(env.ctx.state.data.entries).length, 2);
  } finally { env.done(); }
});

test('留下前的说明点「先不留」：什么都不存，勾选留着，下次还问；声音已经清掉的 → 提示，不建条目', async () => {
  const env = await setup({ local: { sync: { repo: 'me/dreams' } }, answer: false });
  try {
    await env.check('c_4');
    await env.click('留下选中的 1 段');
    assert.equal(env.entries().length, 0);
    assert.equal(env.ctx.local.bedKeepNoted, undefined);
    assert.ok(byCls(env.bar(), 'nt-keep'));
    env.answer = true;
    await env.night.deleteParts('c_4');                // 分片没了（比如清理过了），候选还没标 gone
    await env.check('c_1');
    await env.click('留下选中的 2 段');
    assert.equal(env.confirms.length, 2);
    assert.equal(env.entries().length, 0);
    assert.equal(env.toasts.at(-1).msg, t('night.goneAt', { time: '早上6:00' }), '说是哪一段');
    assert.equal(await env.audio.listClips().then(l => l.length), 0);
    assert.equal((await env.cand('c_4')).gone, true, '标上 gone：不再能勾');
    assert.ok(cls(allCls(env.main, 'nt-clip').find(r => r.textContent.includes('早上6:00')), 'gone'));
    assert.equal(byCls(env.bar(), 'nt-keep').textContent, '留下选中的 1 段放进「待整理」', '其余的照样勾着');
    await env.click('留下选中的 1 段');
    assert.equal(env.entries().length, 1);
  } finally { env.done(); }
  // 已经标了 gone 的：没有勾选框和播放器，只能删
  const g = await setup({ seed: async (n) => { await seedNight(n); await n.patchCand('c_4', { gone: true }); } });
  try {
    const row = allCls(g.main, 'nt-clip').find(r => cls(r, 'gone'));
    assert.ok(row.textContent.includes(t('night.gone')));
    assert.equal(find(row, el => el.tag === 'input'), undefined);
    assert.ok(byCls(row, 'nt-x'));
    assert.equal(g.players.length, 3);
  } finally { g.done(); }
});

test('✕ 删一段：提示条能撤销；「已删掉 1 段」里能恢复（超过 24 小时的不算）；勾着的被别处删了 → 不再算勾着', async () => {
  const env = await setup({ seed: async (n) => { await seedNight(n); await cand(n, 'c_5', 'n_b', at(D, '06:30'), 1, { state: 'deleted', deletedAt: Date.now() - 25 * 3600e3 }); } });
  try {
    await env.check('c_4');
    await byCls(env.row('c_4'), 'nt-x').fire('click'); await settle();
    const c = await env.cand('c_4');
    assert.equal(c.state, 'deleted');
    assert.ok(Date.now() - c.deletedAt < 5000);
    assert.equal(env.row('c_4'), undefined);
    assert.equal(byCls(env.bar(), 'nt-keep'), undefined, '删掉的不再算勾着');
    const tst = env.toasts.at(-1);
    assert.deepEqual([tst.msg, tst.ms, tst.action.label], ['删掉了 早上6:00 那段', 10000, t('common.undo')]);
    assert.equal(byCls(env.main, 'nt-fold').children[0].textContent, '已删掉 1 段（24 小时后清掉）');
    tst.action.run(); await settle();
    assert.equal((await env.cand('c_4')).state, 'new');
    assert.ok(env.row('c_4'));
    assert.equal(allCls(env.main, 'nt-fold').some(f => f.textContent.includes('已删掉')), false);

    await env.check('c_1');
    await env.night.patchCand('c_1', { state: 'deleted', deletedAt: Date.now() });      // 比如另一个窗口删了
    await byCls(env.row('c_4'), 'nt-x').fire('click'); await settle();
    assert.equal(byCls(env.bar(), 'nt-keep'), undefined);
    const fold = allCls(env.main, 'nt-fold').find(f => f.textContent.includes('已删掉'));
    assert.equal(fold.children[0].textContent, '已删掉 2 段（24 小时后清掉）');
    const dels = allCls(fold, 'nt-del-row');
    assert.deepEqual(dels.map(x => x.children[0].textContent), ['凌晨0:10 · 0:03', '早上6:00 · 0:02']);
    await env.click(t('night.restore'), dels[1]);
    assert.equal((await env.cand('c_4')).state, 'new');
    assert.equal(env.toasts.at(-1).msg, t('common.restored'));
    assert.ok(env.row('c_4'));
  } finally { env.done(); }
});

test('昨夜没有梦话 / 其余都删：没留下的都删（一次撤销），这一晚记下看过；整理完了 → 回到呓语', async () => {
  const env = await setup();
  try {
    await env.click('昨夜没有梦话');
    assert.deepEqual((await env.night.listCands()).map(c => c.state), ['deleted', 'deleted', 'deleted', 'deleted']);
    assert.ok((await env.night.listSessions()).every(s => s.reviewedAt > 0));
    assert.equal(env.toasts.at(-1).msg, '删掉了 4 段');
    assert.equal(byCls(env.bar(), 'nt-done').textContent, '这一晚整理完了。回到呓语');
    assert.equal(byCls(env.main, 'nt-hint'), undefined);
    env.toasts.at(-1).action.run(); await settle();
    assert.deepEqual((await env.night.listCands()).map(c => c.state), ['new', 'new', 'new', 'new']);
    await env.click('昨夜没有梦话');
    await env.click(t('night.toList'));
    assert.deepEqual(env.navs.at(-1), ['/', { replace: true }]);
  } finally { env.done(); }

  const k = await setup();
  try {
    await k.check('c_2');
    await k.click('留下选中的 1 段');
    assert.ok((await k.night.listSessions()).every(s => !s.reviewedAt), '还有待听的：不算看过');
    await k.click('其余都删');
    assert.deepEqual((await k.night.listCands()).map(c => [c.id, c.state]), [['c_1', 'deleted'], ['c_2', 'new'], ['c_3', 'deleted'], ['c_4', 'deleted']]);
    assert.equal(k.toasts.at(-1).msg, '删掉了 3 段');
    assert.ok((await k.night.listSessions()).every(s => s.reviewedAt > 0));
    assert.ok(byCls(k.bar(), 'nt-done'));
  } finally { k.done(); }
});

test('没片段时老实说为什么；打开就记下看过（还开着的那晚不记，也不说整理完了）', async () => {
  const one = (extra, from = at(Y, '23:00'), to = at(D, '07:00')) => async (n) => { await n.putSession(session('n_1', Y, from, to, extra)); };
  const cases = [
    [{}, '整夜都在听，没听到像说话的声音。'],
    [{ gaps: [{ from: at(D, '04:10'), to: at(D, '06:40'), reason: 'hidden' }] }, '听着的时候没听到说话，不过有 31% 的时间没在听（见上面）。'],
    [{ status: 'crashed', endReason: 'killed', endedAt: at(D, '04:30'), gaps: [{ from: at(D, '04:10'), to: at(D, '04:30'), reason: 'hidden' }] },
      '凌晨4:10 之后就没在听了：屏幕锁上了，或者切到了别的 App。之前没听到说话。'],
    [{ endReason: 'user', endedAt: at(D, '04:30') }, '凌晨4:30 你结束了床头模式，之前没听到说话。'],
  ];
  for (const [extra, line] of cases) {
    const env = await setup({ seed: one(extra) });
    try {
      assert.equal(byCls(env.main, 'nt-empty').textContent, line);
      assert.equal(byCls(env.main, 'nt-hint'), undefined);
      assert.equal(env.players.length, 0);
      assert.ok((await env.night.listSessions())[0].reviewedAt > 0, line);
      assert.equal(byCls(env.bar(), 'nt-done').children[0].textContent, t('night.done'));
    } finally { env.done(); }
  }
  const live = await setup({ seed: async (n) => { await n.putSession(session('n_1', D, Date.now() - 3600e3, null, { status: 'live', endReason: null })); } });
  try {
    assert.equal(byCls(live.main, 'nt-live').textContent, t('night.live'));
    assert.equal((await live.night.listSessions())[0].reviewedAt, null);
    assert.equal(live.bar().hidden, true);
  } finally { live.done(); }
});

test('没用过 → 去开床头模式；找不到那一晚 → 说清楚、给前几晚的链接；没有 ctx.night 也不出错', async () => {
  const never = await setup({ seed: null });
  try {
    assert.ok(never.text().includes(t('night.never')));
    await never.click(t('night.goBed'));
    assert.deepEqual(never.navs, [['/rec?bed=1', undefined]]);
    assert.equal(never.bar(), undefined);
  } finally { never.done(); }
  const missing = await setup({ id: '2020-01-01' });
  try {
    assert.ok(missing.text().includes(t('night.missing')));
    assert.equal(byCls(missing.main, 'nb-title').textContent, titleOf('2020-01-01'));
    assert.deepEqual(all(byCls(missing.main, 'nt-older'), el => el.tag === 'a').map(a => [a.attrs.href, a.textContent]), [['#/night/' + Y, '昨夜（4 段）']]);
  } finally { missing.done(); }
  const bad = await setup({ id: 'nope' });
  try { assert.ok(bad.text().includes(t('night.missing'))); } finally { bad.done(); }
  const none = await setup({ noNight: true });
  try { assert.ok(none.text().includes(t('night.never'))); } finally { none.done(); }
});

test('前几晚还有没整理的、前几晚的链接；打开某一晚（#/night/<date>）', async () => {
  const seed = async (n) => {
    await seedNight(n);
    await n.putSession(session('n_old', Y3, at(Y3, '23:00'), at(addDays(Y3, 1), '07:00')));
    await cand(n, 'c_9', 'n_old', at(addDays(Y3, 1), '05:00'), 1);
  };
  const env = await setup({ seed });
  try {
    const others = byCls(env.main, 'nt-others');
    assert.equal(others.textContent, `前几晚还有没整理的：${titleOf(Y3)}（1 段）`);
    assert.equal(find(others, el => el.tag === 'a').attrs.href, '#/night/' + Y3);
    assert.deepEqual(all(byCls(env.main, 'nt-older'), el => el.tag === 'a').map(a => a.textContent), [`${titleOf(Y3)}（1 段）`]);
  } finally { env.done(); }
  const old = await setup({ seed, id: Y3 });
  try {
    assert.equal(byCls(old.main, 'nb-title').textContent, titleOf(Y3));
    assert.deepEqual(old.players.map(p => p.opts.key), ['cand:c_9']);
    assert.equal(byCls(old.main, 'nt-others'), undefined, '只说更早的');
    assert.deepEqual(all(byCls(old.main, 'nt-older'), el => el.tag === 'a').map(a => a.textContent), ['昨夜（4 段）']);
    assert.equal(btn(old.bar(), '').textContent, titleOf(Y3) + '没有梦话');
  } finally { old.done(); }
});

test('详细记录：复制摘要；导出记录文件（打开时先读好事件，走分享面板）', async () => {
  const env = await setup();
  try {
    await env.click(t('night.copy'));
    const ss = await env.night.listSessions(), cs = await env.night.listCands();
    assert.deepEqual(env.copied, [textSummary(nightReport({ sessions: ss, cands: cs, nightOf: Y }), ss, cs, { t, lang: 'zh-Hans' })]);
    assert.equal(env.toasts.at(-1).msg, t('night.copied'));
    const exp = btn(env.main, t('night.export'));
    assert.equal(exp.disabled, true);                 // 还没打开「详细记录」：事件没读
    const det = allCls(env.main, 'nt-fold').find(f => f.textContent.includes(t('night.details')));
    det.open = true; await det.fire('toggle'); await settle();
    assert.equal(exp.disabled, false);
    await exp.fire('click'); await settle();
    assert.equal(env.shared.length, 1);
    const file = env.shared[0].files[0];
    assert.equal(file.name, `babble-night-${Y}.json`);
    const log = JSON.parse(await file.text());
    assert.deepEqual([log.app, log.kind, log.nightOf, log.sessions.length, log.cands.length, log.events.map(e => e.k)], ['babble', 'night-log', Y, 2, 4, ['start', 'end']]);
    assert.ok(!JSON.stringify(log).includes('"b"'), '没有声音');
    // 重画后「详细记录」还开着，导出照样能点
    env.handle.onChange({ source: 'local' });
    assert.equal(allCls(env.main, 'nt-fold').find(f => f.textContent.includes(t('night.details'))).attrs.open, '');
    assert.ok(!btn(env.main, t('night.export')).disabled);
  } finally { env.done(); }
});

test('繁體、英文也画得出来：没有漏掉的 {变量}、键名、undefined', async () => {
  for (const lang of ['zh-Hant-TW', 'en']) {
    const env = await setup({ lang, local: { sync: { repo: 'me/dreams' } }, seed: async (n) => { await seedNight(n); await n.patchCand('c_4', { state: 'deleted', deletedAt: Date.now() }); } });
    try {
      await env.check('c_1');
      const text = env.text();
      assert.doesNotMatch(text, /\{\w+\}|undefined|NaN|night\.|common\./, lang);
      assert.ok(text.includes(t('night.hint')) && text.includes(t('night.deletedRow', { n: 1 })), lang);
      if (lang === 'en') assert.ok(byCls(env.main, 'nt-range').textContent.startsWith('11:40 PM–7:00 AM · listened '));
      if (lang === 'en') assert.equal(byCls(env.main, 'nt-foot').textContent, t('night.syncHeld') + ' ' + t('night.retain'));
    } finally { env.done(); }
  }
  setLang('zh-Hans');
});

test('「昨夜」卡片：等找回做完再读；有待听的 → 几段；都留下了 → 藏起来，后来删了那条也不再提醒；没片段没看过 → 怎么没片段的；看过了、没有 ctx.night → 藏着', async () => {
  const dom = installDom(); setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  const navs = [], ons = [];
  const mk = (night, extra = {}) => ({ night, lang: () => 'zh-Hans', entry: (id) => state.getState().data.entries[id] || null,
    navigate: (p) => navs.push(p), on: (ev, fn) => ons.push([ev, fn]), nightRecovered: Promise.resolve(), ...extra });
  try {
    const night = memoryNightStore();
    await seedNight(night);
    let done;
    const el = nightBanner(mk(night, { nightRecovered: new Promise(r => { done = r; }) }));
    await settle();
    assert.equal(el.hidden, true);
    assert.equal(night.calls.includes('listSessions'), false, '找回做完之前不读');
    done(); await settle();
    assert.equal(el.hidden, false);
    assert.ok(cls(el, 'page'));
    const b = find(el, x => x.tag === 'button');
    assert.ok(cls(b, 'inbox') && cls(b, 'nt-card'));
    assert.equal(byCls(b, 'inbox-n').textContent, '4');
    assert.equal(find(b, x => x.tag === 'b').textContent, '昨夜 · 存了 4 段待听');
    const card = nightCard({ sessions: await night.listSessions(), cands: await night.listCands(), t, lang: 'zh-Hans' });
    assert.equal(find(b, x => x.tag === 'small').textContent, card.sub);
    assert.ok(card.sub.startsWith('晚上11:40–早上7:00 · 听了 ') && card.sub.endsWith(' · 断了 2 次'), card.sub);
    await b.fire('click');
    assert.deepEqual(navs, ['/night/' + Y]);

    // 四段都留在同一条里 → 不提醒；后来删了那条（留下又不要了）→ 照样不提醒
    const e = makeEntry({ id: 'e_1', date: D, status: 'inbox' });
    state.mutate(s => { s.data.entries.e_1 = e; });
    for (const id of ['c_1', 'c_2', 'c_3', 'c_4']) await night.patchCand(id, { entryId: 'e_1' });
    ons.length = 0;
    const kept = nightBanner(mk(night));
    await settle();
    assert.equal(kept.hidden, true);
    state.mutate(s => { s.data.entries.e_1 = { ...s.data.entries.e_1, deleted: true }; });
    for (const [ev, fn] of ons) if (ev === 'change') fn({});
    await settle();
    assert.equal(kept.hidden, true);
    // 再打开列表：先照上次读到的画（不等读库，不闪），读到了再改
    const again = nightBanner(mk(night, { nightRecovered: new Promise(() => {}) }));
    assert.equal(again.hidden, true);
    await night.patchCand('c_4', { entryId: null });
    const fresh = nightBanner(mk(night, { nightRecovered: new Promise(() => {}) }));
    assert.equal(fresh.hidden, true, '还没读到：照上次的');
    const shown = nightBanner(mk(night)); await settle();
    assert.equal(byCls(shown, 'inbox-n').textContent, '1');
    const cached = nightBanner(mk(night, { nightRecovered: new Promise(() => {}) }));
    assert.equal(cached.hidden, false, '照上次读到的马上画出来');
    assert.equal(byCls(cached, 'inbox-n').textContent, '1');

    // 没片段：没看过 → 「整夜都在听」（数字位置是 ·）；看过 → 藏着
    const empty = memoryNightStore();
    await empty.putSession(session('n_1', Y, at(Y, '23:00'), at(D, '07:00')));
    const e1 = nightBanner(mk(empty)); await settle();
    assert.equal(byCls(e1, 'inbox-n').textContent, '·');
    assert.equal(find(e1, x => x.tag === 'b').textContent, '昨夜 · 整夜都在听，没听到说话');
    await empty.patchSession('n_1', { reviewedAt: Date.now() });
    const e2 = nightBanner(mk(empty)); await settle();
    assert.equal(e2.hidden, true);
    // 只有还开着的、没有 ctx.night
    const live = memoryNightStore();
    await live.putSession(session('n_1', D, Date.now() - 3600e3, null, { status: 'live' }));
    const l = nightBanner(mk(live)); await settle();
    assert.equal(l.hidden, true);
    const none = nightBanner(mk(undefined)); await settle();
    assert.equal(none.hidden, true);
    assert.equal(none.children.length, 0);
  } finally { dom.restore(); }
});

test('留下以后暂停同步一会儿（够提示条上撤销），离开这页也照样等；离开以后撤销照样删掉那条、片段回到待听，开着的「昨夜」卡片跟着变', async () => {
  const env = await setup({ undoHoldMs: 400 });
  try {
    await env.check('c_4');
    await env.click('留下选中的 1 段');
    assert.deepEqual(env.log, [['pause', 'night-undo']]);
    const [e] = env.entries(), undo = env.toasts.at(-1);
    env.handle.cleanup(); env.handle = null;                       // 马上点了「已留下 · 去看看」离开这页
    await settle(2);
    assert.deepEqual(env.log, [['pause', 'night-undo']], '离开这页不恢复同步');
    const banner = nightBanner(env.ctx); await settle();          // 双栏：列表（和卡片）开着
    assert.equal(byCls(banner, 'inbox-n').textContent, '3');
    undo.action.run(); await settle();
    assert.equal(env.ctx.entry(e.id).deleted, true);
    assert.equal((await env.cand('c_4')).entryId, null);
    assert.equal(byCls(banner, 'inbox-n').textContent, '4', '卡片重读了');
    for (let i = 0; i < 100 && env.log.filter(x => x[0] === 'resume').length < 2; i++) await new Promise(r => setTimeout(r, 20));
    // 撤销时也先暂停、条目删好了才放（提示条快到点时撤销也不会在中间传上去）；留下时那一下到点才放
    assert.deepEqual(env.log, [['pause', 'night-undo'], ['pause', 'night-undo'], ['resume', 'night-undo'], ['resume', 'night-undo']]);
  } finally { env.done(); }
  // 离开以后又回到这一晚（新的一页），再点旧提示条上的撤销：新的这页重读，那段回到待听
  const back = await setup({ undoHoldMs: 400 });
  try {
    await back.check('c_4');
    await back.click('留下选中的 1 段');
    const undo = back.toasts.at(-1);
    back.handle.cleanup();
    back.main = new Element('main');
    back.handle = render(back.main, { name: 'night', id: null, query: {} }, back.ctx, { player: (o) => { const el = document.createElement('div'); el.setAttribute('class', 'player'); el.opts = o; el.destroy = () => { el.destroyed = true; }; back.players.push(el); return el; } });
    await settle();
    assert.equal(back.row('c_4'), undefined, '新的一页：已留下');
    undo.action.run(); await settle(3);
    assert.ok(back.row('c_4'), '撤销以后回到待听');
  } finally { back.done(); }
  // 没留成（声音没了、点了「先不留」）：马上恢复
  const g = await setup({ seed: async (n) => { await seedNight(n); await n.deleteParts('c_4'); } });
  try {
    await g.check('c_4');
    await g.click('留下选中的 1 段');
    assert.deepEqual(g.log, [['pause', 'night-undo'], ['resume', 'night-undo']]);
  } finally { g.done(); }
});

test('留下以后那条又删掉了（这台或别的设备）：不回到待听、卡片不再提醒，显示「留下过，那条已删除」；「其余都删」不碰它；从最近删除恢复 → 已留下', async () => {
  const env = await setup();
  try {
    await env.check('c_1');
    await env.click('留下选中的 1 段');
    const [e] = env.entries();
    state.mutate(s => { s.data.entries[e.id] = { ...s.data.entries[e.id], deleted: true, deletedAt: Date.now() }; }); await settle();
    const kept = byCls(env.main, 'nt-kept');
    assert.deepEqual([kept.attrs.href, kept.textContent], ['#/e/' + e.id, t('night.keptDel') + ' · ' + t('night.open')]);
    assert.equal(env.row('c_1'), undefined, '不能再勾');
    await env.click('其余都删');
    assert.deepEqual((await env.night.listCands()).map(c => [c.id, c.state]), [['c_1', 'new'], ['c_2', 'deleted'], ['c_3', 'deleted'], ['c_4', 'deleted']]);
    const banner = nightBanner(env.ctx); await settle();
    assert.equal(banner.hidden, true);
    state.mutate(s => { const { deleted, deletedAt, ...x } = s.data.entries[e.id]; s.data.entries[e.id] = x; }); await settle();
    assert.equal(byCls(env.main, 'nt-kept').textContent, t('night.keptTag') + ' · ' + t('night.open'));
  } finally { env.done(); }
});

test('读屏、键盘：删、恢复、留下、其余都删、条目变了重画以后，焦点回到原来的地方（那一行没了 → 下一段的 ✕，再没有 → 底部按钮）', async () => {
  const env = await setup();
  const fk = (k) => find(env.main, el => el.dataset && el.dataset.fk === k);
  const at = () => env.doc.activeElement;
  try {
    fk('x:c_3').focus();
    await fk('x:c_3').fire('click'); await settle();
    assert.equal(at(), fk('x:c_4'), '删了 c_3 → c_4 的 ✕');
    assert.ok(env.row('c_4').contains(at()));
    await fk('x:c_4').fire('click'); await settle();
    assert.equal(at(), fk('x:c_2'), '后面没有了 → 前面那段');
    const rs = fk('rs:c_4'); rs.focus();
    await rs.fire('click'); await settle();
    assert.equal(at(), fk('pick:c_4'), '恢复 → 那一段的勾选框');
    env.handle.onChange({ source: 'remote' });                     // 同步来的改动：重画，焦点不丢
    assert.equal(at(), fk('pick:c_4'));
    await env.check('c_1');
    const cancel = find(env.bar(), el => el.tag === 'button' && el.textContent === t('common.cancel'));
    cancel.focus(); await cancel.fire('click');
    assert.equal(at(), fk('bar'), '取消 → 底部的新按钮');
    await env.check('c_1');
    fk('bar').focus();
    await env.click('留下选中的 1 段');
    assert.equal(at(), fk('bar'), '留下 → 底部按钮（其余都删）');
    assert.equal(at().textContent, t('night.rest'));
    await fk('bar').fire('click'); await settle();
    assert.equal(at(), fk('bar'));
    assert.equal(at().textContent, t('night.toList'));
  } finally { env.done(); }
});

test('留下的那条后来永久删除了（别的设备）：还算留下过——不回到待听、写「留下过，那条已永久删除」、没有链接；撤销留下时候选的 sha256 留着（以后永久删除时认得出这段）', async () => {
  const env = await setup({ local: { sync: { repo: 'me/dreams' } }, purgeEnabled: true });
  try {
    await env.check('c_1');
    await env.click('留下选中的 1 段');
    assert.equal(env.confirms[0].message, t('night.syncNotePurge'), '开放以后换成永久删除的说法');
    const [e] = env.entries();
    state.mutate(s => { s.data.entries[e.id] = deletedRecord(s.data.entries[e.id]); });
    state.mutate(s => { const x = s.data.entries[e.id]; s.data.entries[e.id] = purgedRecord(x, x.updatedAt); }, { cause: 'purge' }); await settle();
    const kept = byCls(env.main, 'nt-kept');
    assert.deepEqual([kept.tag, kept.attrs.href, kept.textContent], ['span', undefined, t('night.keptPurged')]);
    assert.ok(cls(kept, 'off'));
    assert.equal(env.row('c_1'), undefined, '不能再勾、再留');
    const banner = nightBanner(env.ctx); await settle();
    assert.equal(byCls(banner, 'inbox-n').textContent, '3', '「昨夜」卡片不把它算成待听');

    // 留下、撤销：entryId、keptAt 去掉，sha256 留着
    await env.check('c_4');
    await env.click('留下选中的 1 段');
    const sha = (await env.cand('c_4')).sha256;
    assert.ok(sha);
    env.toasts.at(-1).action.run(); await settle();
    const c4 = await env.cand('c_4');
    assert.deepEqual([c4.entryId, c4.keptAt, c4.sha256], [null, null, sha]);
    assert.ok(env.row('c_4'), '回到待听');
  } finally { env.done(); }
});

test('留下、撤销，那条后来永久删除了（片段还没清掉：等云端确认）：写「这段的录音已经永久删除了」，放不了、留不了、不算待听、不在「已删掉」里；正在留的时候同步来了永久删除 → 不留、说一声', async () => {
  const env = await setup();
  const purge = (eid) => state.mutate(s => { const x = s.data.entries[eid]; s.data.entries[eid] = purgedRecord(x, x.updatedAt); }, { cause: 'purge' });
  const keepUndo = async (cid) => {
    await env.check(cid);
    await env.click('留下选中的 1 段');
    const eid = (await env.cand(cid)).entryId;
    env.toasts.at(-1).action.run(); await settle();
    return eid;
  };
  try {
    const e4 = await keepUndo('c_4');
    const sha = (await env.cand('c_4')).sha256;
    assert.ok(state.getState().data.entries[e4].deleted, '撤销：那条进了「最近删除」');
    assert.ok(env.row('c_4'), '撤销后回到待听');
    purge(e4); await settle();
    assert.ok(goneShas(state.getState()).has(sha));
    assert.equal(env.row('c_4'), undefined, '没有播放器、不能勾');
    const row = allCls(env.main, 'nt-clip').find(r => r.textContent.includes(t('night.purgedClip')));
    assert.ok(row && cls(row, 'gone'));
    assert.equal(find(row, el => el.tag === 'input'), undefined);
    assert.ok(find(row, el => cls(el, 'nt-x')), '还能从列表里删掉');
    assert.equal(env.players.filter(p => p.opts.key === 'cand:c_4' && !p.destroyed).length, 0);
    const banner = nightBanner(env.ctx); await settle();
    assert.equal(byCls(banner, 'inbox-n').textContent, '3', '「昨夜」卡片不把它算成待听');
    assert.equal((await env.cand('c_4')).gone, undefined, '片段由清理删（等云端确认），这页不标 gone');
    // ✕ 删掉它：不出现在「已删掉 n 段」里（恢复不了）
    await find(row, el => cls(el, 'nt-x')).fire('click'); await settle();
    assert.equal((await env.cand('c_4')).state, 'deleted');
    assert.equal(byCls(env.main, 'nt-dels'), undefined);

    // c_3：留下、撤销；再勾上点「留下」，读声音的时候同步来了那条的永久删除 → 不建条目、不恢复那条，说一声
    const e3 = await keepUndo('c_3');
    const sha3 = (await env.cand('c_3')).sha256;
    await env.check('c_3');
    const go = btn(env.main, '留下选中的 1 段').fire('click');
    purge(e3);
    await go; await settle();
    assert.match(env.toasts.at(-1).msg, /那段的录音已经永久删除了，留不了/);
    assert.deepEqual(env.entries(), [], '没有新建、也没从最近删除恢复');
    assert.ok(goneShas(state.getState()).has(sha3), '那段录音还是没了的');
    const c3 = await env.cand('c_3');
    assert.deepEqual([c3.entryId, c3.sha256, c3.gone], [null, sha3, undefined]);
    assert.equal(env.row('c_3'), undefined);
    assert.ok(env.text().includes(t('night.purgedClip')));
  } finally { env.done(); }
});
