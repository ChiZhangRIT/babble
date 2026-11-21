// 床头模式「这一晚」的纯计算测试：算哪一晚、几点自动结束、时长文字、分组、报告（没在听的时候和原因、覆盖率、
// 没片段时的几种说法）、「昨夜」卡片、保留期限、复制摘要、导出记录。全是编的数据（仓库是公开的，不放真的梦话和录音）。
// 时区固定用 Asia/Shanghai（没有夏令时），跟跑测试的机器在哪个时区无关；夏令时单独用 America/Los_Angeles 测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightKey, autoEndAt, fmtSpan, fmtRange, episodes, nightReport, nightCard, purgePlan, reportLines, textSummary, exportLog, addDays }
  from '../src/core/nightReport.js';
import { P } from '../src/core/nightDetect.js';
import { t, setLang, getLang, LANGS } from '../src/i18n.js';

const TZ = 'Asia/Shanghai';
/** 上海时间 → 毫秒 */
const sh = (date, time, sec = 0) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d, ...time.split(':').map(Number), sec) - 8 * 3600000; };
const N17 = (time, sec) => sh('2026-11-17', time, sec), N18 = (time, sec) => sh('2026-11-18', time, sec);
const MIN = 60000, H = 3600000, DAY = 86400000;
const zh = (fn) => { const was = getLang(); setLang('zh-Hans'); try { return fn(); } finally { setLang(was); } };
const SET = { nightStart: '21:00', nightEnd: '07:00' };

test('nightKey：凌晨和早上夜间结束前算前一天的夜里；夜间结束之后、下午、没有夜间都算当天', () => {
  assert.equal(nightKey(N17('23:30'), SET, TZ), '2026-11-17');
  assert.equal(nightKey(N18('02:00'), SET, TZ), '2026-11-17');
  assert.equal(nightKey(N18('06:59'), SET, TZ), '2026-11-17');
  assert.equal(nightKey(N18('07:00'), SET, TZ), '2026-11-18');
  assert.equal(nightKey(N18('07:30'), SET, TZ), '2026-11-18');
  assert.equal(nightKey(N18('13:00'), SET, TZ), '2026-11-18');
  assert.equal(nightKey(N18('02:00'), { nightStart: '22:00', nightEnd: '22:00' }, TZ), '2026-11-18', '起止相同 = 没有夜间');
  assert.equal(nightKey(N18('02:00'), {}, TZ), '2026-11-17', '没设置按 21:00–07:00');
  // 夜间结束晚于中午时按 12:00 截
  assert.equal(nightKey(N18('11:59'), { nightStart: '22:00', nightEnd: '13:00' }, TZ), '2026-11-17');
  assert.equal(nightKey(N18('12:00'), { nightStart: '22:00', nightEnd: '13:00' }, TZ), '2026-11-18');
  // 跨月、跨年
  assert.equal(nightKey(sh('2026-01-01', '01:00'), SET, TZ), '2025-12-31');
  assert.equal(nightKey(sh('2026-03-01', '03:00'), SET, TZ), '2026-02-28');
  // 时区：同一刻，上海是凌晨 2 点（算 17 日夜里），洛杉矶是 17 日上午 10 点（算 17 日）
  const at = Date.UTC(2026, 10, 17, 18, 0);
  assert.equal(nightKey(at, SET, 'Asia/Shanghai'), '2026-11-17');
  assert.equal(nightKey(at, SET, 'America/Los_Angeles'), '2026-11-17');
  assert.equal(nightKey(Date.UTC(2026, 10, 18, 6, 0), SET, 'America/Los_Angeles'), '2026-11-17');   // 洛杉矶 22:00
  assert.equal(nightKey(Date.UTC(2026, 10, 18, 6, 0), SET, 'Asia/Shanghai'), '2026-11-18');         // 上海 14:00
  assert.equal(nightKey(NaN, SET, TZ), null);
});

test('autoEndAt：开始之后的下一个夜间结束（不含开始那一刻）；没有夜间 → null；夏令时结束那天也是当地 7:00', () => {
  assert.equal(autoEndAt(N17('23:00'), SET, TZ), N18('07:00'));
  assert.equal(autoEndAt(N18('05:00'), SET, TZ), N18('07:00'));
  assert.equal(autoEndAt(N18('07:00'), SET, TZ), sh('2026-11-19', '07:00'));
  assert.equal(autoEndAt(N17('23:00', 30), { nightEnd: '06:30' }, TZ), N18('06:30'));
  assert.equal(autoEndAt(N17('23:00'), { nightStart: '07:00', nightEnd: '07:00' }, TZ), null);
  // 洛杉矶 2026-11-01 02:00 夏令时结束：10 月 31 日 23:00 PDT 开始 → 11 月 1 日 07:00 PST（UTC 15:00），不是 06:00
  assert.equal(autoEndAt(Date.UTC(2026, 10, 1, 6, 0), SET, 'America/Los_Angeles'), Date.UTC(2026, 10, 1, 15, 0));
  // 夏令时开始那天（3 月 8 日）：前一晚 23:00 PST 开始 → 07:00 PDT（UTC 14:00）
  assert.equal(autoEndAt(Date.UTC(2026, 2, 8, 7, 0), SET, 'America/Los_Angeles'), Date.UTC(2026, 2, 8, 14, 0));
});

test('fmtSpan：小时和分 / 分钟 / 秒；不满的分钟舍掉；空的、负的算 0 秒', () => zh(() => {
  assert.equal(fmtSpan(35000, t), '35 秒');
  assert.equal(fmtSpan(42 * MIN + 59000, t), '42 分钟');
  assert.equal(fmtSpan(7 * H + 40 * MIN, t), '7 小时 40 分');
  assert.equal(fmtSpan(59600, t), '1 分钟');
  assert.equal(fmtSpan(H - 1000, t), '59 分钟');
  assert.equal(fmtSpan(H, t), '1 小时');                          // 整点不说「0 分」
  assert.equal(fmtSpan(7 * H + 30000, t), '7 小时');
  assert.equal(fmtSpan(null, t), '0 秒');
  assert.equal(fmtSpan(-5000, t), '0 秒');
}));

test('fmtRange：同一个时段后一个省掉「凌晨」；英文两头都写全', () => {
  assert.deepEqual(fmtRange(N18('02:13'), N18('02:20'), TZ, 'zh-Hans'), ['凌晨2:13', '2:20']);
  assert.deepEqual(fmtRange(N17('23:41'), N18('07:00'), TZ, 'zh-Hans'), ['晚上11:41', '早上7:00']);
  assert.deepEqual(fmtRange(N18('02:13'), N18('02:20'), TZ, 'en'), ['2:13 AM', '2:20 AM']);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('episodes：按开始时间排；跟前一段结束隔了超过 150 秒才另起一组', () => {
  const c = (id, startAt, sec) => ({ id, startAt, endAt: startAt + sec * 1000 });
  const a = c('a', N18('02:00'), 20), b = c('b', a.endAt + P.EPISODE_GAP_SEC * 1000, 10), d = c('d', b.endAt + P.EPISODE_GAP_SEC * 1000 + 1000, 10);
  assert.deepEqual(episodes([d, b, a]).map(g => g.map(x => x.id)), [['a', 'b'], ['d']]);
  assert.deepEqual(episodes([]), []);
  assert.deepEqual(episodes([a, d], 3600).map(g => g.length), [2]);
});

// ---------- 编的一晚：两次床头模式（第一次凌晨 2:10 被杀，2:30 重开到 7:00 自动结束） ----------
const sA = () => ({ id: 'n_a', v: 1, nightOf: '2026-11-17', tz: TZ, startedAt: N17('23:41'), endedAt: N18('02:10'), status: 'crashed', endReason: 'killed',
  device: '测试 iPhone', ua: 'Synthetic UA', build: 'v-test', standalone: true, capture: 'worklet', rate: 48000, pull: false,
  track: { autoGainControl: true, echoCancellation: false, noiseSuppression: false }, env: { aac16k: null, persisted: true, usage: 1610612736, quota: 10737418240 },
  vad: 'on', vadLoadMs: 812, vadMs: 3.27, alive: { at: N18('02:10') },
  gaps: [{ from: N18('01:00'), to: N18('01:00', 10), reason: 'muted' }, { from: N18('01:30'), to: N18('01:37'), reason: 'muted', tap: true },
    { from: N18('02:05'), to: N18('02:10'), reason: 'hidden' }],
  notes: [{ kind: 'vad', from: N17('23:41'), to: N18('00:41') }],
  counts: { clips: 2, dropped: 3, writeFail: 1, wakeLost: 2, resumes: 4, taps: 1, vadRestarts: 1, maxTickGapMs: 6400 }, reviewedAt: null });
const sB = () => ({ id: 'n_b', v: 1, nightOf: '2026-11-17', tz: TZ, startedAt: N18('02:30'), endedAt: N18('07:00'), status: 'ended', endReason: 'auto',
  capture: 'script', rate: 44100, pull: true, vad: 'off', counts: { dropped: 1 },
  gaps: [{ from: N18('03:00'), to: N18('03:00', 20), reason: 'ctx' }],
  notes: [{ kind: 'noise', from: N18('04:10'), to: N18('04:40') }, { kind: 'budget', from: N18('05:00'), to: null, n: 3 }], reviewedAt: null });
const cd = (id, s, startAt, sec, extra) => ({ id, s, v: 1, state: 'new', startAt, endAt: startAt + sec * 1000, samples: sec * 16000, sr: 16000, durationSec: sec, cut: 'quiet', ...extra });
const cands = () => [
  cd('c_1', 'n_a', N18('00:10'), 24),
  cd('c_2', 'n_a', N18('00:12'), 9, { state: 'deleted', deletedAt: N18('08:00') }),
  cd('c_3', 'n_b', N18('03:30'), 18),
  cd('c_4', 'n_b', N18('06:59'), 0, { state: 'open', endAt: null, samples: null, durationSec: null }),
  cd('c_5', 'n_b', N18('03:31'), 12, { cut: 'noise' }),
  cd('c_9', 'n_other', N18('03:00'), 30),
];
const NOW = N18('09:00');

test('nightReport：两次之间和每次里面的没在听、原因；短于 30 秒的合成一行；听了多久和百分比；片段、删掉的、待听、分组', () => {
  const r = nightReport({ sessions: [sB(), sA(), { ...sA(), id: 'n_x', nightOf: '2026-11-16' }], cands: cands(), nightOf: '2026-11-17', now: NOW, isKept: c => c.id === 'c_3' });
  assert.equal(r.nightOf, '2026-11-17'); assert.equal(r.tz, TZ);
  assert.equal(r.from, N17('23:41')); assert.equal(r.to, N18('07:00')); assert.equal(r.live, false);
  assert.deepEqual(r.gaps.map(g => [g.from, g.to, g.reason, !!g.tap]), [
    [N18('01:30'), N18('01:37'), 'muted', true], [N18('02:05'), N18('02:10'), 'hidden', false], [N18('02:10'), N18('02:30'), 'killed', false]]);
  assert.deepEqual(r.short, { n: 2, ms: 30000 });
  // (2:29 + 4:30) − (10 秒 + 7 分 + 5 分 + 20 秒) = 406.5 分钟；7 小时 19 分里的 93%
  assert.equal(r.listenedMs, 406.5 * MIN);
  assert.equal(r.pct, 93);
  assert.equal(r.stopped, null); assert.equal(r.userEndedAt, null); assert.equal(r.empty, null);
  assert.deepEqual(r.clips.map(c => [c.id, c.kept]), [['c_1', false], ['c_3', true], ['c_5', false]]);
  assert.deepEqual(r.deleted.map(c => c.id), ['c_2']);
  assert.equal(r.pending, 2);
  assert.deepEqual(r.episodes.map(g => g.map(c => c.id)), [['c_1'], ['c_3', 'c_5']]);
  assert.equal(r.energyMs, H);
  assert.deepEqual(r.notes.map(n => n.kind), ['vad', 'noise', 'budget']);
  assert.equal(r.notes[2].to, N18('07:00'), '没结束的记号算到那次结束');
  assert.equal(r.reviewed, false);
  assert.equal(nightReport({ sessions: [sA()], cands: [], nightOf: '2026-11-01', now: NOW }), null);
});

test('nightReport：一晚的报告文字（凌晨2:13–2:20 这种写法、原因、要点一下、短暂中断、一直有声音、存满了、没用上说话识别）', () => zh(() => {
  const r = nightReport({ sessions: [sA(), sB()], cands: cands(), nightOf: '2026-11-17', now: NOW });
  const L = reportLines(r, { t, lang: 'zh-Hans' });
  assert.equal(L.range, '晚上11:41–早上7:00 · 听了 6 小时 46 分（93%）');
  assert.deepEqual(L.gaps, ['凌晨1:30–1:37 没在听：麦克风被占用了（来电、Siri 或别的 App），要点一下才接着听',
    '凌晨2:05–2:10 没在听：屏幕锁上了，或者切到了别的 App', '凌晨2:10–2:30 没在听：App 被关掉了（可能是系统清理内存）']);
  assert.equal(L.short, '另外有 2 次短暂中断，一共 30 秒');
  assert.deepEqual(L.notes, ['晚上11:41–凌晨0:41 没用上说话识别，只按音量找，片段会多一些', '凌晨4:10–4:40 一直有声音（像电视、风扇），只存了前 3 分钟',
    '早上5:00 之后片段太多，没再存声音（只数了次数：又听到 3 次）']);
  assert.equal('energy' in L, false, '「没用上说话识别」只说一次（notes 里那条）');
  assert.equal(L.live, null); assert.equal(L.empty, null); assert.equal(L.stopped, null);
  // 存储满了也说又听到几次；只按音量时存得太快的那一阵有起止
  const s2 = { ...sB(), notes: [{ kind: 'storage', from: N18('05:00'), to: null, n: 2 }, { kind: 'budget', from: N18('03:40'), to: N18('04:05'), n: 1, held: true }] };
  assert.deepEqual(reportLines(nightReport({ sessions: [sA(), s2], cands: cands(), nightOf: '2026-11-17', now: NOW }), { t, lang: 'zh-Hans' }).notes.slice(1), [
    '早上5:00 之后本机存不下了，没再存声音（只数了次数：又听到 2 次）', '凌晨3:40–4:05 只按音量找时存得太快（可能是鼾声），这段时间没存声音（只数了次数：又听到 1 次）']);
  // 一次都没再听到：不说「只数了次数」
  const s3 = { ...sB(), notes: [{ kind: 'budget', from: N18('03:40'), to: N18('04:05'), n: 0, held: true }, { kind: 'budget', from: N18('05:00'), to: null, n: 0 }] };
  assert.deepEqual(reportLines(nightReport({ sessions: [sA(), s3], cands: cands(), nightOf: '2026-11-17', now: NOW }), { t, lang: 'zh-Hans' }).notes.slice(1), [
    '凌晨3:40–4:05 只按音量找时存得太快（可能是鼾声），这段时间没存声音', '早上5:00 之后片段太多，没再存声音']);
}));

test('nightReport：只按音量时一阵阵「存得太快」（断断续续的鼾声），隔不到 30 分钟的合成一行（次数相加、说有几阵），隔得久的另起一行', () => zh(() => {
  const held = (from, to, n) => ({ kind: 'budget', from: N18(from), to: N18(to), n, held: true });
  const s = { ...sB(), notes: [{ kind: 'vad', from: N18('02:30'), to: N18('07:00') }, held('03:00', '03:05'), held('03:05', '03:10', 2), held('03:20', '03:25', 1), held('05:00', '05:05', 1)] };
  const r = nightReport({ sessions: [s], cands: [], nightOf: '2026-11-17', now: NOW });
  assert.deepEqual(r.notes.map(n => [n.kind, n.from, n.to, n.n, n.k]), [['vad', N18('02:30'), N18('07:00'), undefined, undefined],
    ['budget', N18('03:00'), N18('03:25'), 3, 3], ['budget', N18('05:00'), N18('05:05'), 1, 1]]);
  assert.deepEqual(reportLines(r, { t, lang: 'zh-Hans' }).notes.slice(1), [
    '凌晨3:00–3:25 只按音量找时存得太快（可能是鼾声），其中 3 阵没存声音（只数了次数：又听到 3 次）',
    '早上5:00–5:05 只按音量找时存得太快（可能是鼾声），这段时间没存声音（只数了次数：又听到 1 次）']);
  assert.equal(s.notes[1].to, N18('03:05'), '不改原来的记录');
}));

const one = (extra) => [{ id: 'n_1', nightOf: '2026-11-17', tz: TZ, startedAt: N17('23:00'), endedAt: N18('07:00'), status: 'ended', endReason: 'auto', gaps: [], notes: [], ...extra }];
const rep = (sessions, cs = []) => nightReport({ sessions, cands: cs, nightOf: '2026-11-17', now: NOW });

test('nightReport：没片段时的每一种（被杀停在锁屏那会儿 / 被杀 / 离开 / 出错 / 自己结束 / 断得多 / 整夜都在听），只有还在录的片段也算没片段', () => zh(() => {
  const crashed = { status: 'crashed', endReason: 'killed', endedAt: N18('02:10'), alive: { at: N18('02:10') } };
  let r = rep(one({ ...crashed, gaps: [{ from: N18('01:50'), to: N18('02:10'), reason: 'hidden' }] }));
  assert.deepEqual(r.stopped, { at: N18('01:50'), why: 'hidden', killed: true });
  assert.equal(r.empty, 'stopped');
  assert.equal(reportLines(r, { t, lang: 'zh-Hans' }).empty, '凌晨1:50 之后就没在听了：屏幕锁上了，或者切到了别的 App。之前没听到说话。');
  r = rep(one(crashed));
  assert.deepEqual(r.stopped, { at: N18('02:10'), why: 'killed', killed: true });
  assert.equal(reportLines(r, { t, lang: 'zh-Hans' }).empty, '凌晨2:10 之后就没在听了：App 被关掉了（可能是系统清理内存）。之前没听到说话。');
  r = rep(one({ ...crashed, gaps: [{ from: N18('02:09', 50), to: N18('02:10'), reason: 'hidden' }] }));
  assert.deepEqual(r.stopped, { at: N18('02:10'), why: 'hidden', killed: true }, '结尾那段太短：停在最后一次心跳，原因照样按它');
  // 找回时记下的 stopWhy 优先；没有 gap 时看最后一次心跳时在不在后台（锁屏后被系统清掉，gap 常常来不及写）
  assert.deepEqual(rep(one({ ...crashed, stopWhy: 'hidden' })).stopped, { at: N18('02:10'), why: 'hidden', killed: true });
  assert.equal(rep(one({ ...crashed, alive: { at: N18('02:10'), vis: false } })).stopped.why, 'hidden');
  assert.equal(rep(one({ ...crashed, alive: { at: N18('02:10'), vis: true, muted: true } })).stopped.why, 'killed', '在前台：不按 muted 猜');
  assert.equal(reportLines(rep(one({ ...crashed, stopWhy: 'hidden' })), { t, lang: 'zh-Hans' }).empty, '凌晨2:10 之后就没在听了：屏幕锁上了，或者切到了别的 App。之前没听到说话。');
  r = rep(one({ endReason: 'leave', endedAt: N18('03:00') }));
  assert.deepEqual(r.stopped, { at: N18('03:00'), why: 'leave' }); assert.equal(r.empty, 'stopped');
  assert.equal(rep(one({ endReason: 'error', endedAt: N18('03:00') })).stopped.why, 'error');
  r = rep(one({ endReason: 'user', endedAt: N18('03:00') }));
  assert.equal(r.stopped, null); assert.equal(r.userEndedAt, N18('03:00')); assert.equal(r.empty, 'userEnded');
  assert.equal(reportLines(r, { t, lang: 'zh-Hans' }).empty, '凌晨3:00 你结束了床头模式，之前没听到说话。');
  r = rep(one({ gaps: [{ from: N18('01:00'), to: N18('03:24'), reason: 'muted' }] }));          // 8 小时里断了 2 小时 24 分 = 30%
  assert.equal(r.pct, 70); assert.equal(r.empty, 'gappy');
  assert.equal(reportLines(r, { t, lang: 'zh-Hans' }).empty, '听着的时候没听到说话，不过有 30% 的时间没在听（见上面）。');
  r = rep(one());
  assert.equal(r.pct, 100); assert.equal(r.empty, 'allNight');
  assert.equal(reportLines(r, { t, lang: 'zh-Hans' }).empty, '整夜都在听，没听到像说话的声音。');
  assert.equal(rep(one({ status: 'live', endedAt: null, endReason: null }), [cd('c_o', 'n_1', N18('03:00'), 0, { state: 'open' })]).empty, 'allNight', '还在录的不算');
  assert.equal(rep(one(), [cd('c_o', 'n_1', N18('03:00'), 0, { state: 'open' })]).empty, null, '结束了还 open 的（收段没写进去，下次启动时收）：别说没听到');
  assert.equal(rep(one(), [cd('c_d', 'n_1', N18('03:00'), 5, { state: 'deleted', deletedAt: NOW })]).empty, null, '片段都删了也不算没片段');
  // 有片段时被杀：不说「之前没听到说话」，只说几点之后没在听了
  r = rep(one(crashed), [cd('c_1', 'n_1', N18('01:00'), 10)]);
  assert.equal(r.empty, null);
  assert.equal(reportLines(r, { t, lang: 'zh-Hans' }).stopped, '凌晨2:10 之后就没在听了：App 被关掉了（可能是系统清理内存）。');
}));

test('nightReport：还开着的按现在算（开着的中断也到现在）；没写进结束时间的按最后一次心跳；两次之间按上一次的结束原因；重叠的不算中断', () => {
  let r = rep(one({ status: 'live', endedAt: null, endReason: null, gaps: [{ from: NOW - 2 * MIN, to: null, reason: 'muted' }] }));
  assert.equal(r.live, true); assert.equal(r.to, NOW);
  assert.deepEqual(r.gaps.map(g => [g.from, g.to]), [[NOW - 2 * MIN, NOW]]);
  assert.equal(r.listenedMs, NOW - 2 * MIN - N17('23:00'));
  r = rep(one({ endedAt: null, alive: { at: N18('04:00') } }));
  assert.equal(r.to, N18('04:00'));
  r = rep([...one({ endedAt: N18('01:00'), endReason: 'user' }), ...one({ id: 'n_2', startedAt: N18('01:20') })]);
  assert.deepEqual(r.gaps.map(g => [g.from, g.to, g.reason]), [[N18('01:00'), N18('01:20'), 'user']]);
  assert.equal(r.empty, 'allNight', '最后一次是自动结束：不算自己结束');
  r = rep([...one({ endedAt: N18('03:00') }), ...one({ id: 'n_2', startedAt: N18('02:00') })]);
  assert.deepEqual(r.gaps, []);
});

test('nightReport：isKept 决定已留下；声音已经清掉的片段（7 天后）不算待听', () => {
  const cs = [cd('c_1', 'n_1', N18('01:00'), 10, { entryId: 'e_1' }), cd('c_2', 'n_1', N18('02:00'), 10, { gone: true }), cd('c_3', 'n_1', N18('03:00'), 10)];
  const r = nightReport({ sessions: one(), cands: cs, nightOf: '2026-11-17', now: NOW, isKept: c => c.entryId === 'e_1' });
  assert.deepEqual(r.clips.map(c => c.kept), [true, false, false]);
  assert.equal(r.pending, 1);
  assert.equal(nightReport({ sessions: one(), cands: cs, nightOf: '2026-11-17', now: NOW }).pending, 2, '不给 isKept：都没留下');
});

test('nightReport：isPurged（录音永久删除了，片段还没清掉）→ purged，不算待听、不在「已删掉」里；留下了的照样算留下；卡片也不提醒', () => {
  const S = 'a'.repeat(64), O = 'b'.repeat(64);
  const cs = [cd('c_1', 'n_1', N18('01:00'), 10, { sha256: S }),                       // 留下、撤销，那条后来永久删除了
    cd('c_2', 'n_1', N18('02:00'), 10, { entryId: 't_k', sha256: S }),                    // 留下的那条永久删除了（墓碑）
    cd('c_3', 'n_1', N18('03:00'), 10, { sha256: O }),                                    // 别的录音：照样待听
    cd('c_4', 'n_1', N18('04:00'), 10, { sha256: S, state: 'deleted', deletedAt: NOW - MIN })];
  const isPurged = c => c.sha256 === S, isKept = c => c.entryId === 't_k';
  const r = nightReport({ sessions: one(), cands: cs, nightOf: '2026-11-17', now: NOW, isKept, isPurged });
  assert.deepEqual(r.clips.map(c => [c.id, c.kept, c.purged]), [['c_1', false, true], ['c_2', true, false], ['c_3', false, false]]);
  assert.equal(r.pending, 1);
  assert.deepEqual(r.deleted.map(c => c.id), [], '永久删除了的恢复不了：不放进「已删掉」');
  assert.equal(nightReport({ sessions: one(), cands: cs, nightOf: '2026-11-17', now: NOW, isKept }).pending, 2, '不给 isPurged：照旧');
  const rest = cs.filter(c => c.id !== 'c_3'), day = { now: NOW, today: '2026-11-18', isKept };
  assert.equal(nightCard({ sessions: one(), cands: rest, ...day }).n, 1, '不给 isPurged：c_1 还算待听');
  assert.equal(nightCard({ sessions: one(), cands: rest, ...day, isPurged }), null, '只剩永久删除了的：卡片不提醒');
});

test('nightCard：最新一晚（不算还开着的）有待听 → clips；昨夜 / 11月17日夜里；3 天后不显示；没片段的没看过才显示；都整理了不显示', () => zh(() => {
  const ss = [sA(), sB()], cs = cands(), opts = { now: NOW, today: '2026-11-18', t, lang: 'zh-Hans' };
  let c = nightCard({ sessions: ss, cands: cs, ...opts });
  assert.equal(c.kind, 'clips'); assert.equal(c.nightOf, '2026-11-17'); assert.equal(c.last, true); assert.equal(c.n, 3);
  assert.equal(c.label, '昨夜'); assert.equal(c.title, '昨夜 · 存了 3 段待听');
  assert.equal(c.sub, '晚上11:41–早上7:00 · 听了 6 小时 46 分 · 断了 3 次');
  assert.equal(c.report.pending, 3);
  c = nightCard({ sessions: ss, cands: cs, ...opts, now: N18('09:00') + DAY, today: '2026-11-19' });
  assert.equal(c.last, false); assert.equal(c.label, '11月17日夜里'); assert.equal(c.title, '11月17日夜里 · 存了 3 段待听');
  assert.equal(nightCard({ sessions: ss, cands: cs, ...opts, now: N17('23:41') + 3 * DAY + 1 }), null);
  const bare = nightCard({ sessions: ss, cands: cs, now: NOW, today: '2026-11-18' });
  assert.equal(bare.kind, 'clips'); assert.equal('label' in bare, false);
  // 都留下或删掉了：不显示
  assert.equal(nightCard({ sessions: ss, cands: cs, ...opts, isKept: () => true }), null);
  // 没片段：没看过才显示，哪种没片段就是哪种
  const crashed = one({ status: 'crashed', endReason: 'killed', endedAt: N18('02:10'), alive: { at: N18('02:10') } });
  c = nightCard({ sessions: crashed, cands: [], ...opts });
  assert.equal(c.kind, 'stopped'); assert.equal(c.n, 0); assert.equal(c.title, '昨夜 · 凌晨2:10 就停了');
  assert.equal(c.sub, '晚上11:00–凌晨2:10 · 听了 3 小时 10 分');
  assert.equal(nightCard({ sessions: [{ ...crashed[0], reviewedAt: NOW }], cands: [], ...opts }), null);
  assert.equal(nightCard({ sessions: one(), cands: [], ...opts }).title, '昨夜 · 整夜都在听，没听到说话');
  assert.equal(nightCard({ sessions: one({ endReason: 'user', endedAt: N18('03:00') }), cands: [], ...opts }).title, '昨夜 · 没听到说话');
  assert.equal(nightCard({ sessions: one({ gaps: [{ from: N18('01:00'), to: N18('04:00'), reason: 'ctx' }] }), cands: [], ...opts }).title,
    '昨夜 · 没听到说话（有一段时间没在听）');
  // 今晚又开着：卡片还是昨夜的；只有开着的 → 不显示
  const live = { id: 'n_live', nightOf: '2026-11-18', tz: TZ, startedAt: sh('2026-11-18', '23:00'), status: 'live', gaps: [], notes: [] };
  assert.equal(nightCard({ sessions: [...ss, live], cands: cs, ...opts, now: sh('2026-11-18', '23:30') }).nightOf, '2026-11-17');
  assert.equal(nightCard({ sessions: [live], cands: [], ...opts }), null);
  assert.equal(nightCard({ sessions: [], cands: [], ...opts }), null);
}));

test('purgePlan：删掉超过 24 小时的、7 天前的片段清声音；30 天前的整晚删掉；不碰还开着的、还在录的；已清掉的不重复；找不到 session 的旧片段按 s 删', () => {
  const now = N18('12:00');
  const S = (id, daysAgo, status = 'ended') => ({ id, nightOf: 'x', startedAt: now - daysAgo * DAY, status, gaps: [], notes: [] });
  const sessions = [S('s_new', 1), S('s_6d', 6), S('s_8d', 8), S('s_31d', 31, 'crashed'), S('s_live', 40, 'live')];
  const C = (id, s, extra) => ({ id, s, state: 'new', startAt: (sessions.find(x => x.id === s) || {}).startedAt, ...extra });
  const cs = [
    C('d25', 's_new', { state: 'deleted', deletedAt: now - 25 * H }), C('d23', 's_new', { state: 'deleted', deletedAt: now - 23 * H }), C('n_new', 's_new'),
    C('n_6d', 's_6d'), C('n_8d', 's_8d'), C('k_8d', 's_8d', { entryId: 'e_1' }), C('g_8d', 's_8d', { gone: true }), C('o_8d', 's_8d', { state: 'open' }),
    C('c_31', 's_31d'), C('l_old', 's_live', { state: 'deleted', deletedAt: now - 30 * DAY }),
    { id: 'orphan_old', s: 'n_gone', state: 'new', startAt: now - 40 * DAY }, { id: 'orphan_new', s: 'n_gone2', state: 'deleted', startAt: now - 2 * DAY, deletedAt: now - 30 * H },
    { id: 'orphan_open', s: 'n_gone3', state: 'open', startAt: now - 40 * DAY },
  ];
  const plan = purgePlan({ sessions, cands: cs, now });
  assert.deepEqual(plan.parts.sort(), ['d25', 'k_8d', 'n_8d', 'orphan_new']);
  assert.deepEqual(plan.sessions.sort(), ['n_gone', 's_31d']);
  assert.deepEqual(purgePlan({ sessions: [], cands: [], now }), { parts: [], sessions: [] });
  assert.equal(P.RETAIN_DAYS, 7); assert.equal(P.LOG_KEEP_DAYS, 30); assert.equal(P.DELETED_KEEP_MS, DAY);
});

test('textSummary：覆盖、原因、各种计数、设备和采集；只用 session 和片段信息（没有原话）；没有漏掉的变量', () => zh(() => {
  const ss = [sA(), sB()], cs = cands();
  cs[0].text = '这是不该出现的原话';                         // 片段本来没有原话；就算有也不进摘要
  const r = nightReport({ sessions: ss, cands: cs, nightOf: '2026-11-17', now: NOW });
  const s = textSummary(r, ss, cs, { t, lang: 'zh-Hans' });
  const lines = s.split('\n');
  assert.equal(lines[0], '牙牙呓语 · 床头模式记录');
  assert.equal(lines[1], '11月17日夜里');
  assert.equal(lines[2], '覆盖：7 小时 19 分，听了 6 小时 46 分（93%）');
  for (const want of ['没在听的时候', '这晚还有', '· 凌晨1:30–1:37 没在听：麦克风被占用了（来电、Siri 或别的 App），要点一下才接着听', '· 凌晨2:10–2:30 没在听：App 被关掉了',
    '· 另外有 2 次短暂中断，一共 30 秒', '· 凌晨4:10–4:40 一直有声音', '片段：存了 4 段，共 1 分钟；太短丢掉 4 段；最长 24 秒',
    '11月17日夜里 1/2：晚上11:41 开始，凌晨2:10 结束（App 被关掉了（可能是系统清理内存））', '11月17日夜里 2/2：凌晨2:30 开始，早上7:00 结束（到点自动结束了）',
    '设备：测试 iPhone · Synthetic UA · v-test · ', '采集：worklet，48000 → 16000 Hz；回声消除 关、降噪 关、自动增益 开', '采集：script + pull，44100 → 16000 Hz；回声消除 —',
    '说话识别：开，载入 812 毫秒，每 256 毫秒的声音算 3.3 毫秒，重启 1 次', '心跳最长间隔 6.4 秒；常亮被收回 2 次；自动接着听 4 次；要点一下 1 次；写入失败 1 次',
    '存储：用了 1.50 GB / 10.00 GB，持久保存 开；m4a(16k) 支持 —', '说话识别：关，载入 — 毫秒']) assert.ok(s.includes(want), want);
  assert.ok(s.indexOf('这晚还有') > s.indexOf('· 另外有 2 次短暂中断'), '没在听的时候在前，这晚还有在后');
  assert.ok(!s.includes('这晚有一段时间说话识别没用上'), '不再重复说没用上说话识别');
  assert.ok(!s.includes('这是不该出现的原话'));
  assert.ok(!/undefined|NaN|null|\{\w+\}/.test(s), s);
  assert.equal(textSummary(null, ss, cs, { t, lang: 'zh-Hans' }), '');
}));

test('三种语言：报告文字、卡片、摘要都拼得完整（文案键都在、变量都换掉了）', () => {
  const was = getLang();
  try {
    for (const lang of LANGS) {
      setLang(lang);
      const ss = [sA(), sB()], cs = cands();
      const r = nightReport({ sessions: ss, cands: cs, nightOf: '2026-11-17', now: NOW });
      const crashed = one({ status: 'crashed', endReason: 'killed', endedAt: N18('02:10'), alive: { at: N18('02:10') } });
      const texts = [textSummary(r, ss, cs, { t, lang }), ...Object.values(reportLines(r, { t, lang })).flat(),
        ...Object.values(reportLines(rep(crashed), { t, lang })).flat(), ...Object.values(reportLines(rep(one({ status: 'live', endedAt: null })), { t, lang })).flat()];
      for (const c of [nightCard({ sessions: ss, cands: cs, now: NOW, today: '2026-11-18', t, lang }), nightCard({ sessions: crashed, cands: [], now: NOW, today: '2026-11-19', t, lang })]) {
        texts.push(c.label, c.title, c.sub);
      }
      for (const s of texts.filter(x => x != null)) {
        assert.ok(typeof s === 'string' && s.length, lang);
        assert.ok(!/undefined|NaN|\{\w+\}|night\.|diag\./.test(s), `${lang}: ${s}`);
      }
    }
  } finally { setLang(was); }
});

test('exportLog：只有这一晚的 session、片段和事件，事件按编号排；能原样转成 JSON', () => {
  const ss = [sB(), sA(), { ...sA(), id: 'n_x', nightOf: '2026-11-16' }];
  const events = [{ n: 3, s: 'n_b', t: 3, k: 'start' }, { n: 1, s: 'n_a', t: 1, k: 'start', d: { rate: 48000 } }, { n: 2, s: 'n_x', t: 2, k: 'start' }, { n: 4, s: 'n_a', t: 4, k: 'end' }];
  const log = exportLog('2026-11-17', ss, cands(), events);
  assert.deepEqual(Object.keys(log), ['app', 'kind', 'v', 'nightOf', 'sessions', 'cands', 'events']);
  assert.equal(log.app, 'babble'); assert.equal(log.kind, 'night-log'); assert.equal(log.v, 1); assert.equal(log.nightOf, '2026-11-17');
  assert.deepEqual(log.sessions.map(s => s.id), ['n_a', 'n_b']);
  assert.deepEqual(log.cands.map(c => c.id), ['c_1', 'c_2', 'c_3', 'c_5', 'c_4']);
  assert.deepEqual(log.events.map(e => e.n), [1, 3, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(log)), log);
});
