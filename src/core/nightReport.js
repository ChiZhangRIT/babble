// 床头模式的「这一晚」：纯计算（不碰 DOM、IndexedDB、计时器），Node 里能测。
//   nightKey / autoEndAt     一次床头模式算哪一晚、几点自动结束（按设置里的「夜间时段」，时区按那次的 tz）
//   episodes                 片段按前后间隔归成一组一组
//   nightReport              一晚的报告：从几点听到几点、听了多久、哪些时候没在听（为什么）、存下的片段、没片段时怎么说
//   nightCard                列表上「昨夜」卡片：要不要显示、显示哪种
//   purgePlan                按保留期限该清掉哪些片段的声音、哪些整晚的记录
//   reportLines              报告 → 一行行文字（夜间页、复制摘要共用）
//   textSummary / exportLog  「复制摘要」（给人看的文字，没有录音和原话）和「导出记录文件」（JSON，排查用）
// 文案用传进来的 t()（键在 src/strings/night.js），这里不 import i18n。
import { P } from './nightDetect.js';
import { localParts, fmtTime, fmtDate, isTime, today as todayOf } from './dates.js';
import { fmtBytes } from './util.js';

const DAY = 86400000;
const byStarted = (a, b) => (a.startedAt || 0) - (b.startedAt || 0);
const byStart = (a, b) => (a.startAt || 0) - (b.startAt || 0);
const sum = (xs) => xs.reduce((a, x) => a + x, 0);
const mins = (s) => (isTime(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);
const utc = (date, time = '00:00') => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3))); };

/** 'YYYY-MM-DD' 加减几天 */
export const addDays = (date, n) => new Date(utc(date) + n * DAY).toISOString().slice(0, 10);
/** 某时区的当地日期 + 钟表时间 → 毫秒（夏令时切换那天也对：按差了多少修正，最多三次） */
function atLocal(date, time, tz) {
  const want = utc(date, time);
  let ms = want;
  for (let i = 0; i < 3; i++) { const p = localParts(ms, tz), d = want - utc(p.date, p.time); if (!d) break; ms += d; }
  return ms;
}
/** 夜间时段 → { s, e }（分钟）和结束的 end（HH:MM）；起止相同 = 没有夜间 → null（没设置按 21:00–07:00，同 isNight） */
function nightHours(settings) {
  const s = mins(settings.nightStart ?? '21:00'), e = mins(settings.nightEnd ?? '07:00');
  return s == null || e == null || s === e ? null : { s, e, end: settings.nightEnd ?? '07:00' };
}

/** 算哪一晚：当地时间早于 min(夜间结束, 12:00) → 前一天的夜里；没有夜间 → 当天。早上 9 点试一下不会算进昨夜 */
export function nightKey(ms, settings = {}, tz) {
  const p = localParts(ms, tz);
  if (!p) return null;
  const n = nightHours(settings || {});
  return n && mins(p.time) < Math.min(n.e, 720) ? addDays(p.date, -1) : p.date;
}
/** 开始之后（不含开始那一刻）的下一个夜间结束时刻；没有夜间 → null */
export function autoEndAt(startMs, settings = {}, tz) {
  const p = localParts(startMs, tz), n = nightHours(settings || {});
  if (!p || !n) return null;
  const at = atLocal(p.date, n.end, tz);
  return at > startMs ? at : atLocal(addDays(p.date, 1), n.end, tz);
}

/** 毫秒 → 7 小时 40 分 / 7 小时 / 42 分钟 / 35 秒（不满的分钟舍掉，不往多里说） */
export function fmtSpan(ms, t) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return t('night.s', { s });
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return m < 60 ? t('night.m', { m }) : m % 60 ? t('night.hm', { h, m: m % 60 }) : t('night.h', { h });
}
/** 某一刻按某时区显示：凌晨2:13 / 2:13 AM */
export function fmtClock(ms, tz, lang) { const p = ms == null ? null : localParts(ms, tz); return p ? fmtTime(p.time, lang) : ''; }
/** 时间段的两头；同一个时段的后一个省掉「凌晨」之类：凌晨2:13–2:20、晚上11:41–早上7:00 */
export function fmtRange(from, to, tz, lang) {
  const a = fmtClock(from, tz, lang), b = fmtClock(to, tz, lang);
  return lang !== 'en' && a && a.slice(0, 2) === b.slice(0, 2) ? [a, b.slice(2)] : [a, b];
}

/** 片段按开始时间排好，跟前面隔了超过 gapSec 秒就另起一组 */
export function episodes(cands, gapSec = P.EPISODE_GAP_SEC) {
  const out = [];
  let end = -Infinity;
  for (const c of [...cands].sort(byStart)) {
    if (!out.length || c.startAt - end > gapSec * 1000) out.push([]);
    out[out.length - 1].push(c);
    end = Math.max(end, c.endAt ?? c.startAt);
  }
  return out;
}

// 一次床头模式到几点为止：结束了按结束时刻；还开着按现在；被杀了（还没找回）按最后一次心跳
const endOf = (s, now) => s.endedAt ?? (s.status === 'live' ? now : (s.alive && s.alive.at) || s.startedAt);
const dur = (g) => Math.max(0, g.to - g.from);

/**
 * 一晚的报告（同一个 nightOf 的所有 session 合在一起；两次之间没开着的时间也算没在听）
 * @returns {null | { nightOf, tz, from, to, live, listenedMs, pct, gaps, short: {n, ms}, notes, stopped, userEndedAt,
 *   clips, deleted, episodes, pending, energyMs, empty: null|'stopped'|'userEnded'|'gappy'|'allNight', reviewed }}
 *   gaps 只有 ≥ 30 秒的（{ from, to, reason, tap? }），短的合进 short；clips 是 state 'new' 的片段（带 kept）
 */
export function nightReport({ sessions = [], cands = [], nightOf: key, now = Date.now(), isKept = () => false } = {}) {
  const ss = sessions.filter(s => s && s.nightOf === key).sort(byStarted);
  if (!ss.length) return null;
  const end = (s) => endOf(s, now), show = P.GAP_SHOW_SEC * 1000;
  const inGaps = ss.flatMap(s => (s.gaps || []).map(g => ({ ...g, to: g.to ?? end(s) })));
  const between = ss.slice(1).map((b, i) => ({ from: end(ss[i]), to: b.startedAt, reason: ss[i].status === 'crashed' ? 'killed' : ss[i].endReason || 'killed' }))
    .filter(g => g.to > g.from);
  const all = [...inGaps, ...between].sort((a, b) => a.from - b.from);
  const gaps = all.filter(g => dur(g) >= show), rest = all.filter(g => dur(g) < show && dur(g) > 0);
  const last = ss[ss.length - 1], from = ss[0].startedAt, to = end(last);
  const listenedMs = Math.max(0, sum(ss.map(s => Math.max(0, end(s) - s.startedAt))) - sum(inGaps.map(dur)));
  const pct = to > from ? Math.min(100, Math.round(100 * listenedMs / (to - from))) : 0;
  // 最后一次是被杀的：停在结尾那段没在听的开头（≥ 30 秒才算，比如锁屏后被清掉），没有就停在最后一次心跳。
  // 原因用找回时记的 stopWhy；没有的话按结尾那段没在听的原因（多短都算），再没有就看最后一次心跳时是不是在后台（锁屏后被清掉多半是这样）
  const openAtEnd = (last.gaps || []).find(g => (g.to ?? to) === to && to - g.from >= show), endGap = (last.gaps || []).find(g => (g.to ?? to) === to);
  const killedWhy = last.stopWhy || (endGap ? endGap.reason : last.alive && last.alive.vis === false ? 'hidden' : 'killed');
  const stopped = last.status === 'crashed' ? { at: openAtEnd ? openAtEnd.from : to, why: killedWhy, killed: true }
    : last.endReason === 'leave' || last.endReason === 'error' ? { at: to, why: last.endReason } : null;
  const userEndedAt = last.endReason === 'user' ? to : null;
  const ids = new Set(ss.map(s => s.id)), mine = cands.filter(c => c && ids.has(c.s)), liveIds = new Set(ss.filter(s => s.status === 'live').map(s => s.id));
  const clips = mine.filter(c => c.state === 'new').map(c => ({ ...c, kept: !!isKept(c) })).sort(byStart);
  const deleted = mine.filter(c => c.state === 'deleted' && !c.gone).sort(byStart);
  const notes = mergeHeld(ss.flatMap(s => (s.notes || []).map(n => ({ ...n, to: n.to ?? end(s) }))));
  return {
    nightOf: key, tz: ss[0].tz || null, from, to, live: last.status === 'live', listenedMs, pct,
    gaps, short: { n: rest.length, ms: sum(rest.map(dur)) }, notes, stopped, userEndedAt,
    clips, deleted, episodes: episodes(clips),
    pending: clips.filter(c => !c.kept && !c.gone).length,                // 声音已经清掉的（7 天后）留不了，不算待听
    energyMs: sum(notes.filter(n => n.kind === 'vad').map(dur)),
    // 还在录的（open）不算有片段；结束了的那晚里还 open 的（收段没写进去，下次启动时收）算：别说「没听到说话」
    empty: mine.some(c => c.state !== 'open' || !liveIds.has(c.s)) ? null : stopped ? 'stopped' : userEndedAt ? 'userEnded' : pct < 90 ? 'gappy' : 'allNight',
    reviewed: ss.every(s => !!s.reviewedAt),
  };
}

const HELD_MERGE_MS = 30 * 60000;
/** 只按音量时「存得太快」的几阵（budget + held）前后隔不到 30 分钟 → 合成一条（从第一阵开头到最后一阵结尾，次数相加，k = 几阵）：断断续续打鼾一整夜不写几十行 */
function mergeHeld(notes) {
  const out = [];
  let last = null;
  for (const n of notes) {
    const held = n.kind === 'budget' && n.held;
    if (held && last && n.from - last.to <= HELD_MERGE_MS) { last.to = Math.max(last.to, n.to); last.n = (last.n || 0) + (n.n || 0); last.k++; continue; }
    if (held) { last = { ...n, k: 1 }; out.push(last); } else out.push(n);
  }
  return out;
}

/**
 * 「昨夜」卡片：最新一晚（不算还开着的）有待听的片段 → clips；没片段又还没看过 → 没片段的那种；3 天前的不显示
 * 给了 t（和 lang）就顺便把文字拼好：label（昨夜 / 11月15日夜里）、title（卡片粗体那行）、sub（时间和听了多久）
 * @returns {null | { kind: 'clips'|'allNight'|'gappy'|'stopped'|'userEnded', nightOf, last: boolean, n, report, label?, title?, sub? }}
 */
export function nightCard({ sessions = [], cands = [], now = Date.now(), isKept, today = todayOf(new Date(now)), t, lang } = {}) {
  const key = sessions.filter(s => s && s.status !== 'live' && s.nightOf).map(s => s.nightOf).sort().pop();
  if (!key) return null;
  const r = nightReport({ sessions, cands, nightOf: key, now, isKept });
  if (!r || now - r.from > P.CARD_DAYS * DAY) return null;
  const kind = r.pending > 0 ? 'clips' : r.empty && !r.reviewed ? r.empty : null;
  if (!kind) return null;
  const card = { kind, nightOf: key, last: key === addDays(today, -1), n: r.pending, report: r };
  if (!t) return card;
  const label = card.last ? t('night.last') : t('night.title', { date: fmtDate(key, lang, { year: false }) });
  const title = kind === 'clips' ? t('night.card', { label, n: r.pending }) : kind === 'allNight' ? t('night.cardAll', { label })
    : kind === 'gappy' ? t('night.cardGappy', { label }) : kind === 'stopped' ? t('night.cardStopped', { label, time: fmtClock(r.stopped.at, r.tz, lang) })
      : t('night.cardUser', { label });
  const [from, to] = fmtRange(r.from, r.to, r.tz, lang);
  const sub = t('night.cardSub', { from, to, dur: fmtSpan(r.listenedMs, t) }) + (r.gaps.length ? ' · ' + t('night.gapsN', { n: r.gaps.length }) : '');
  return { ...card, label, title, sub };
}

/**
 * 保留期限（启动时找回之后、每次开始床头模式时跑）：不碰还开着的 session，不碰还在录的片段（open）
 *   parts：删掉超过 24 小时的、或那晚开始超过 7 天的片段 → 清掉声音（调用方再标 gone）
 *   sessions：开始超过 30 天的整晚记录（连同事件、片段信息一起删）；找不到 session 的旧片段也按它的 s 删
 */
export function purgePlan({ sessions = [], cands = [], now = Date.now() } = {}) {
  const byId = new Map(sessions.filter(Boolean).map(s => [s.id, s]));
  const old = (ms, days) => now - (ms || 0) > days * DAY;
  const drop = new Set([...byId.values()].filter(s => s.status !== 'live' && old(s.startedAt, P.LOG_KEEP_DAYS)).map(s => s.id));
  const parts = [];
  for (const c of cands) {
    if (!c || c.state === 'open' || !c.s || drop.has(c.s)) continue;
    const s = byId.get(c.s);
    if (s && s.status === 'live') continue;
    const started = s ? s.startedAt : c.startAt;
    if (!s && old(started, P.LOG_KEEP_DAYS)) { drop.add(c.s); continue; }
    if (c.gone) continue;
    const deletedLong = c.state === 'deleted' && now - (c.deletedAt || c.endAt || c.startAt || 0) > P.DELETED_KEEP_MS;
    if (deletedLong || old(started, P.RETAIN_DAYS)) parts.push(c.id);
  }
  return { parts, sessions: [...drop] };
}

/**
 * 报告 → 文字（夜间页和复制摘要用同一套说法）
 * @returns {{ range, live, gaps: string[], short, notes: string[], stopped, empty }}  没有的项是 null
 *   gaps、short 放在「没在听的时候」下面；notes（一直有声音、存满了、没用上说话识别）在听着，放在「这晚还有」下面
 *   stopped：有片段时也说一句「几点之后就没在听了：为什么」；empty：没片段时的那句（已经说了为什么停）
 */
export function reportLines(r, { t, lang }) {
  const at = (ms) => fmtClock(ms, r.tz, lang), span = (a, b) => fmtRange(a, b, r.tz, lang);
  const why = (k) => t('night.why.' + (k || 'error'));
  const gap = (g) => { const [from, to] = span(g.from, g.to); return t('night.gap', { from, to, why: why(g.reason) }) + (g.tap ? t('night.gapTap') : ''); };
  const note = (n) => {
    const [from, to] = span(n.from, n.to), more = n.n > 0 ? t('night.heardMore', { n: n.n }) : '';      // 存不下以后又听到几次（0 次不说）
    return n.kind === 'noise' ? t('night.noteNoise', { from, to }) : n.kind === 'vad' ? t('night.noteVad', { from, to })
      : n.kind === 'budget' ? t(!n.held ? 'night.noteBudget' : n.k > 1 ? 'night.noteHeldN' : 'night.noteHeld', { from, to, k: n.k }) + more
        : n.kind === 'storage' ? t('night.noteStorage', { from }) + more : null;
  };
  const [from, to] = span(r.from, r.to);
  return {
    range: t('night.range', { from, to, dur: fmtSpan(r.listenedMs, t), pct: r.pct }), live: r.live ? t('night.live') : null,
    gaps: r.gaps.map(gap), short: r.short.n ? t('night.gapShort', { n: r.short.n, dur: fmtSpan(r.short.ms, t) }) : null,
    notes: r.notes.map(note).filter(Boolean),
    stopped: r.stopped && !r.empty ? t('night.stoppedAt', { time: at(r.stopped.at), why: why(r.stopped.why) }) : null,
    empty: r.empty === 'allNight' ? t('night.allNight') : r.empty === 'gappy' ? t('night.gappy', { pct: 100 - r.pct })
      : r.empty === 'stopped' ? t('night.stopped', { time: at(r.stopped.at), why: why(r.stopped.why) })
        : r.empty === 'userEnded' ? t('night.userEnded', { time: at(r.userEndedAt) }) : null,
  };
}

const num = (v, digits = 0) => (v == null || !Number.isFinite(Number(v)) ? '—' : String(Math.round(Number(v) * 10 ** digits) / 10 ** digits));
/**
 * 「复制摘要」：这一晚的覆盖、没在听的时候、片段统计，每次床头模式的设备 / 采集 / 说话识别 / 心跳 / 存储。
 * 只用 session 和片段的信息（没有录音，也不碰条目，所以没有原话）
 */
export function textSummary(report, sessions = [], cands = [], { t, lang } = {}) {
  if (!report) return '';
  const r = report, L = reportLines(r, { t, lang }), at = (ms) => fmtClock(ms, r.tz, lang);
  const ss = sessions.filter(s => s && s.nightOf === r.nightOf).sort(byStarted), ids = new Set(ss.map(s => s.id));
  const durs = cands.filter(c => c && ids.has(c.s) && c.state !== 'open').map(c => Number(c.durationSec) || 0);
  const onOff = (v) => (v == null ? '—' : t(v ? 'night.rep.on' : 'night.rep.off'));
  const title = t('night.title', { date: fmtDate(r.nightOf, lang, { year: false }) });
  const away = [...L.gaps, L.short].filter(Boolean), list = (head, xs) => (xs.length ? [t(head), ...xs.map(x => '· ' + x)] : []);
  const lines = [t('night.rep.head'), title, t('night.rep.cover', { total: fmtSpan(r.to - r.from, t), listened: fmtSpan(r.listenedMs, t), pct: r.pct }), L.live,
    ...list('night.gapsH', away), ...list('night.notesH', L.notes), L.stopped, L.empty,
    t('night.rep.clips', { n: durs.length, dur: fmtSpan(sum(durs) * 1000, t), drop: sum(ss.map(s => (s.counts && s.counts.dropped) || 0)),
      max: durs.length ? fmtSpan(Math.max(...durs) * 1000, t) : '—' })];
  ss.forEach((s, i) => {
    const c = s.counts || {}, tr = s.track || {}, env = s.env || {};
    const reason = s.status === 'live' ? null : s.status === 'crashed' ? 'killed' : s.endReason || 'killed';
    lines.push('',
      t('night.rep.night', { night: ss.length > 1 ? `${title} ${i + 1}/${ss.length}` : title, from: at(s.startedAt), to: reason ? at(endOf(s, r.to)) : '—',
        why: reason ? t('night.why.' + reason) : t('night.live') }),
      t('night.rep.device', { device: s.device || '—', ua: s.ua || '—', build: s.build || '—', where: t(s.standalone ? 'diag.standaloneYes' : 'diag.standaloneNo') }),
      t('night.rep.capture', { kind: (s.capture || '—') + (s.pull ? ' + pull' : ''), rate: s.rate ?? '—',
        ec: onOff(tr.echoCancellation), ns: onOff(tr.noiseSuppression), agc: onOff(tr.autoGainControl) }),
      t('night.rep.vad', { vad: s.vad === 'loading' ? t('night.rep.loading') : s.vad ? onOff(s.vad === 'on') : '—', load: num(s.vadLoadMs), ms: num(s.vadMs, 1), n: c.vadRestarts || 0 }),
      t('night.rep.health', { hb: num(c.maxTickGapMs == null ? null : c.maxTickGapMs / 1000, 1), wake: c.wakeLost || 0, res: c.resumes || 0, tap: c.taps || 0, wf: c.writeFail || 0 }),
      t('night.rep.storage', { used: env.usage == null ? '—' : fmtBytes(env.usage) + (env.quota ? ' / ' + fmtBytes(env.quota) : ''),
        persisted: onOff(env.persisted), aac: onOff(env.aac16k) }));
  });
  return lines.filter(x => x != null).join('\n');
}

/** 「导出记录文件」：这一晚的 session、片段信息（没有声音）和事件，原样放进 JSON（排查、调参用） */
export function exportLog(nightOf, sessions = [], cands = [], events = []) {
  const ss = sessions.filter(s => s && s.nightOf === nightOf).sort(byStarted), ids = new Set(ss.map(s => s.id));
  return { app: 'babble', kind: 'night-log', v: 1, nightOf, sessions: ss,
    cands: cands.filter(c => c && ids.has(c.s)).sort(byStart), events: events.filter(e => e && ids.has(e.s)).sort((a, b) => (a.n || 0) - (b.n || 0)) };
}
