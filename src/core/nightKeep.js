// 床头模式的「留下」：勾上的候选片段（babble-night 里的 PCM 分片）→ WAV 存进录音库（audioStore.putClip，按 sha256 只存一份）→ 一条待整理。
// 留一段 = 一条；几段一起留 = 合成一条：按开始时间排，每段的名字是开始的时刻（HH:MM，24 小时）。
// 条目的日期、时间取最早一段的开头（含前面 8 秒；凌晨录的照样记在当天），source { kind: 'app', night: 'YYYY-MM-DD' }。
// 存好以后候选记下 entryId / sha256 / keptAt。「留下了没有」不另存状态：entryId 指的条目还在就算留下了（后来删掉了也算：留下又删 = 不要了）；
// 「撤销」由调用方做（昨夜页的提示条：删掉那条、去掉候选的链接 → 回到待听）。再留同样这几段：「最近删除」里正好是这几段的那条 → 恢复它，不再建一条重复的。
// 存条目和改候选之间 App 被杀：再点「留下」时这几段已经都在同一条里（clipIndex）→ 只补链接，不再建一条。
// 依赖都由调用方传进来（ctx.night、ctx.audio、ctx.put…），不碰 DOM，Node 里能测。import 时什么都不做。
import { clipOf, recTimeFields } from './drafts.js';
import { clipIndex, makeEntry } from './store.js';
import { localParts } from './dates.js';
import { P, wavBlob } from './nightDetect.js';

const HEAD = 44;           // WAV 头的字节数
const round1 = v => Math.round(v * 10) / 10;
const byStart = (a, b) => (a.startAt || 0) - (b.startAt || 0) || String(a.id).localeCompare(String(b.id));
const sessionOf = (byId, sid) => (byId instanceof Map ? byId.get(sid) : byId && byId[sid]) || null;
const gone = (c) => Object.assign(new Error('gone'), { code: 'gone', candId: c.id });

/**
 * 一段候选 → 条目里的一项 audio：{ sha256, mime: 'audio/wav', bytes, durationSec, origName: '', addedAt, startedAt, name? }
 * saved = putClip 的结果 { sha256, mime, bytes }。durationSec 按 cand.samples 算；分片缺了（写入失败丢过几秒）WAV 会短一些，按 WAV 里实际有的算。
 * merged：几段合成一条时，名字用这段开始的时刻（tz 是那一晚的时区）；单独一段不起名字（显示「录音 1」）
 */
export function itemFor(saved, cand, { merged = false, tz, now = Date.now() } = {}) {
  const inWav = saved.bytes > HEAD ? (saved.bytes - HEAD) / 2 : Infinity;
  const n = Math.min(cand.samples ?? Infinity, inWav), sr = cand.sr || P.SR;
  const item = { ...clipOf({ ...saved, mime: saved.mime || 'audio/wav', durationSec: Number.isFinite(n) ? round1(n / sr) : null }, now), startedAt: cand.startAt };
  const p = merged ? localParts(cand.startAt, tz || undefined) : null;
  if (p) item.name = p.time;
  return item;
}

/** 要留的几段 → 新条目的字段：日期、时间取最早一段的开头（那一晚的时区），待整理，source 记下是哪一夜（sessionsById：Map 或对象都行） */
export function entryFieldsFor(cands, sessionsById) {
  const first = [...cands].sort(byStart)[0], s = first ? sessionOf(sessionsById, first.s) : null;
  return { ...recTimeFields(first ? first.startAt : null, s && s.tz), status: 'inbox', text: '', source: { kind: 'app', night: (s && s.nightOf) || null } };
}

/**
 * 留下几段 → 返回放进去的条目（几段已经在同一条里时返回那一条，不新建；cands 是空的 → null）。
 * deps = { night: ctx.night（getParts、patchCand）, audio: ctx.audio（putClip）, getState: () => ctx.state, put: ctx.put, newEntry: ctx.newEntry,
 *   restore?: (id) => 恢复了的条目 | null（恢复「最近删除」里的条目；不给就照样新建） }
 * undoLabel 交给 put（给了外壳弹 10 秒「撤销」；昨夜页不给，自己弹）。
 * 有一段的声音已经清掉了（7 天到期、或者分片一片都没有）→ 抛 code 'gone' 的错，什么都还没存；putClip 出错照样抛，条目不建
 */
export async function keepClips(deps, cands, sessionsById, { undoLabel, now = Date.now() } = {}) {
  const { night, audio, getState, put, newEntry = makeEntry, restore = null } = deps;
  const list = [...cands].sort(byStart);
  if (!list.length) return null;
  // 1. 先把每段的声音都读出来、拼成 WAV：哪一段没了就整个不做
  const blobs = [];
  for (const c of list) {
    const parts = c.gone ? [] : await night.getParts(c.id);
    const blob = parts.length ? wavBlob(parts.map(x => x.b), c.samples, c.sr || P.SR) : null;
    if (!blob || blob.size <= HEAD) throw gone(c);
    blobs.push(blob);
  }
  // 2. 存进录音库（同样内容只存一份）
  const saved = [];
  for (const b of blobs) saved.push(await audio.putClip(b, { mime: 'audio/wav' }));
  // 3. 这几段都已经在同一条（没删的）里：上次存好条目、还没来得及改候选就被打断了 → 只补链接；
  //    不然「最近删除」里有正好是这几段的一条（留下以后撤销了）→ 恢复它（新删的优先），不建重复的
  const state = getState(), idx = clipIndex(state), ids = saved.map(x => idx.get(x.sha256) || []);
  const hit = ids[0].find(id => ids.every(l => l.includes(id)));
  let entry = hit ? state.data.entries[hit] : null;
  if (!entry && restore) {
    const same = (e) => e.deleted && (e.audio || []).length === saved.length && saved.every(x => e.audio.some(a => a.sha256 === x.sha256));
    const old = Object.values(state.data.entries).filter(same).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))[0];
    if (old) entry = restore(old.id) || null;
  }
  if (!entry) {
    const merged = list.length > 1;
    const audioItems = list.map((c, i) => itemFor(saved[i], c, { merged, tz: (sessionOf(sessionsById, c.s) || {}).tz, now }));
    entry = put(newEntry({ ...entryFieldsFor(list, sessionsById), audio: audioItems }), { undoLabel });
  }
  // 4. 候选记下进了哪一条。改不进去只记日志：条目已经建好、「撤销」也弹了；片段会显示成还没留，再点「留下」走第 3 步补上
  for (let i = 0; i < list.length; i++) {
    try { await night.patchCand(list[i].id, { entryId: entry.id, sha256: saved[i].sha256, keptAt: now }); }
    catch (e) { console.warn('night keep: patchCand', e); }
  }
  return entry;
}
