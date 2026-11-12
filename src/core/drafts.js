// 没保存的原话和正在录的录音：App 被系统杀掉以后怎么接回去。不碰 DOM，Node 里能测。
// 草稿都在 localStorage 的 babble.edit.<键> 里（编辑页每 400 毫秒、切到后台时另存，见 views/editor.js）：
//   babble.edit.<条目 id> / babble.edit.new   编辑页：{ w: 工作副本, added, removed, at, rec? }
//   babble.edit.rec                            录音页边录边写（views/record.js）：{ v: 1, text, target, base, rec, at }
//       text 还没写进条目的原话（预填的「👰🏻‍♀️ “”」已经当成空的）；target 写进哪一条（还没建 → null）；
//       base 上次写进条目时的原话；rec 正在录的那段的 recId（没在录 → null）。只有写了没存进条目的字时才有这份。
// rec：草稿另存时正在录音。启动时 App 先找回录音（core/recorder.js recoverPending），再用 applyRecovery 把录音和字放进同一条。
import { makeEntry, clipIndex } from './store.js';
import { localParts, today, isISODate, isTime } from './dates.js';
import { insertSpeakerLine } from './dialogue.js';

export const EDIT_PREFIX = 'babble.edit.';
export const REC_DRAFT = EDIT_PREFIX + 'rec';
export const NEW_DRAFT = EDIT_PREFIX + 'new';

/** 读 / 写 / 删一份草稿（localStorage 不在、存不下、内容坏了都不抛） */
export function readDraft(storage, key) {
  try { const d = JSON.parse((storage && storage.getItem(key)) || 'null'); return d && typeof d === 'object' ? d : null; } catch (e) { return null; }
}
export function writeDraft(storage, key, d) {
  if (!storage) return false;
  try { storage.setItem(key, JSON.stringify(d)); return true; } catch (e) { return false; }
}
export function dropDraft(storage, key) {
  try { if (storage) storage.removeItem(key); } catch (e) { /* 没有就算了 */ }
}

/** 录好的一段 → 条目里的一项 audio */
export const clipOf = (c, now = Date.now()) => ({ sha256: c.sha256, mime: c.mime || 'audio/mp4', bytes: c.bytes ?? null, durationSec: c.durationSec ?? null, origName: '', addedAt: now });

/** 录音开始的时刻 → 条目的日期、时间字段（凌晨录的照样记在当天） */
export function recTimeFields(startedAt, tz) {
  const p = startedAt != null ? localParts(startedAt, tz || undefined) : null;
  return p ? { date: p.date, time: p.time, recordedAt: new Date(startedAt).toISOString(), tz: tz || null, timeSource: 'recorder' }
    : { date: today(), time: null, recordedAt: null, tz: tz || null, timeSource: null };
}

/**
 * 启动时把找回的录音、没收尾的草稿放进 state（在 mutate 里调用，直接改 s）。
 * clips：recoverPending 的结果（已经在某条里的也可以传：会跳过，只用来找它在哪条）。
 * drafts.rec：录音页那份；drafts.fresh：编辑页「记一条」那份（只处理录到一半的，即带 rec 的）。
 *   - 录音页：录音接到 target（或录音本来要接的那条 / 已经存进的那条），没有就新建一条待整理；写的字放进同一条。没在录也照样把字存进去。
 *   - 「记一条」：录到一半的那段找回来了 → 连同写好的日期、原话、背景建成一条待整理；没找回 → 草稿留着（去掉 rec），下次打开「记一条」时恢复。
 *   - 其余找回的录音照旧：接到 attachTo 那条，或者新建一条待整理（source recovered）。
 * @returns {{ ids: string[], clips: number, texts: number, dropRec: boolean, dropFresh: boolean, fresh: object|null }}
 *   fresh：要写回的「记一条」草稿（去掉了 rec）；null = 不用动
 */
export function applyRecovery(s, clips = [], drafts = {}, now = Date.now()) {
  const E = s.data.entries;
  const known = clipIndex(s, { includeDeleted: true });
  const alive = id => (id && E[id] && !E[id].deleted ? E[id] : null);
  const touched = new Set(), used = new Set();
  const out = { ids: [], clips: 0, texts: 0, dropRec: false, dropFresh: false, fresh: null };
  const valid = (clips || []).filter(c => c && c.sha256);
  const byRec = new Map(valid.filter(c => c.recId).map(c => [c.recId, c]));
  const put = (e) => { E[e.id] = e; touched.add(e.id); for (const a of e.audio) known.set(a.sha256, [e.id]); return e; };
  const attach = (e, c) => { e.audio = [...(e.audio || []), clipOf(c, now)]; known.set(c.sha256, [e.id]); touched.add(e.id); out.clips++; };
  const fromClip = (c, kind = 'recovered') => {
    out.clips++;
    return put(makeEntry({ ...recTimeFields(c.startedAt, c.tz), status: 'inbox', audio: [clipOf(c, now)], source: { kind } }, now));
  };

  // 录音页：录音 + 写的字放进同一条
  const rd = drafts.rec && typeof drafts.rec === 'object' ? drafts.rec : null;
  if (rd) {
    const c = rd.rec ? byRec.get(rd.rec) : null;
    if (c) used.add(c.recId);
    const inEntry = c && known.has(c.sha256) ? alive(known.get(c.sha256)[0]) : null;
    let T = alive(rd.target) || inEntry || (c && alive(c.attachTo));
    if (c && !known.has(c.sha256)) { if (T) attach(T, c); else T = fromClip(c); }
    const txt = typeof rd.text === 'string' ? rd.text : '';
    if (txt && T && T.text !== txt) { T.text = txt; touched.add(T.id); out.texts++; }
    else if (txt && !T) {
      const p = Number.isFinite(rd.at) ? localParts(rd.at) : null;
      put(makeEntry({ date: p ? p.date : today(), status: 'inbox', text: txt, source: { kind: 'app' } }, now));
      out.texts++;
    }
    out.dropRec = true;
  }

  // 「记一条」录到一半
  const fd = drafts.fresh && typeof drafts.fresh === 'object' && drafts.fresh.rec ? drafts.fresh : null;
  if (fd) {
    const c = byRec.get(fd.rec);
    if (c && !known.has(c.sha256)) {
      used.add(c.recId);
      const w = fd.w && typeof fd.w === 'object' ? fd.w : {};
      const tpl = insertSpeakerLine('', 0, 'nn', s.settings && s.settings.speakers).text;
      const audio = (Array.isArray(w.audio) ? w.audio : []).filter(a => a && typeof a.sha256 === 'string' && a.sha256 !== c.sha256);
      // 时间：填了就用填的；没填、录音又是同一天的 → 用录音开始的时间（和编辑页录完时一样）
      const rt = recTimeFields(c.startedAt, c.tz);
      const date = isISODate(w.date) ? w.date : rt.date;
      const time = isTime(w.time) ? { time: w.time, timeSource: w.timeSource || 'manual', recordedAt: w.recordedAt || null, tz: w.tz || null }
        : rt.time && rt.date === date ? { time: rt.time, timeSource: rt.timeSource, recordedAt: rt.recordedAt, tz: rt.tz }
        : { time: null, timeSource: null, recordedAt: null, tz: null };
      const draft = typeof w.draftText === 'string' && w.draftText.trim() ? { text: w.draftText, source: w.draftSrc || 'paste' } : null;
      put(makeEntry({
        ...time, date,
        text: typeof w.text === 'string' && w.text !== tpl ? w.text : '',          // 没有标题（旧版本草稿里的 title 不要）
        note: typeof w.note === 'string' ? w.note : '', draft, audio: [...audio, clipOf(c, now)], status: 'inbox', source: { kind: 'app' },
      }, now));
      out.clips++;
      out.dropFresh = true;
    } else {
      const { rec, ...rest } = fd;
      out.fresh = rest;
    }
  }

  // 其余的照旧
  for (const c of valid) {
    if (used.has(c.recId) || known.has(c.sha256)) continue;
    const T = alive(c.attachTo);
    if (T) attach(T, c); else fromClip(c);
  }
  out.ids = [...touched];
  return out;
}
