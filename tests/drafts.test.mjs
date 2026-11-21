import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRecovery, readDraft, writeDraft, dropDraft, clipOf, recTimeFields, insertedText, stashPurgedText, REC_DRAFT, NEW_DRAFT, EDIT_PREFIX } from '../src/core/drafts.js';
import { blankState, makeEntry, normalizeEntry } from '../src/core/store.js';
import { startTemplate, insertLine, REACTIONS } from '../src/ui/writer.js';
import { addedAudio, REACTIONS as EDITOR_REACTIONS, EDIT_PREFIX as EDITOR_PREFIX } from '../src/views/editor.js';

// 边录边写：App 被杀掉以后，找回的录音和没存进条目的字放进同一条。全是编的例子（仓库是公开的）
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const sha = c => c.repeat(64);
const T0 = Date.UTC(2026, 10, 4, 10, 58);              // 洛杉矶 11月4日 凌晨2:58
const TZ = 'America/Los_Angeles';
const clip = (c, extra = {}) => ({ sha256: sha(c), mime: 'audio/mp4', bytes: 1000, durationSec: 12, startedAt: T0, tz: TZ, recId: 'r_' + c, ...extra });
const withEntries = (...list) => { const s = blankState(); for (const e of list) s.data.entries[e.id] = normalizeEntry(e, e.id); return s; };
const E = (id, fields = {}) => makeEntry({ id, date: '2026-11-01', ...fields }, 1000);
const fakeStorage = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => m.delete(k) }; };
const only = (s, pred = () => true) => Object.values(s.data.entries).filter(pred);

test('录音页录到一半被杀：找回的录音和写的字建成同一条待整理（时间来自录音）', () => {
  const s = blankState();
  const r = applyRecovery(s, [clip('a')], { rec: { v: 1, text: `${NN} “今天吃什么”`, target: null, base: null, rec: 'r_a', at: T0 + 5000 } }, 2000);
  const [e] = only(s);
  assert.equal(only(s).length, 1);
  assert.deepEqual(r.ids, [e.id]);
  assert.equal(e.text, `${NN} “今天吃什么”`);
  assert.deepEqual(e.audio.map(a => a.sha256), [sha('a')]);
  assert.equal(e.status, 'inbox');
  assert.equal(e.source.kind, 'recovered');
  assert.deepEqual([e.date, e.time, e.timeSource, e.tz], ['2026-11-04', '02:58', 'recorder', TZ]);
  assert.deepEqual([r.clips, r.texts, r.dropRec], [1, 1, true]);
});

test('「再录一段」时被杀：录音接到同一条，原话换成最新写的', () => {
  const s = withEntries(E('e1', { text: `${NN} “第一句”`, status: 'inbox', audio: [{ sha256: sha('a'), mime: 'audio/mp4' }] }));
  const r = applyRecovery(s, [clip('b', { attachTo: 'e1' })], { rec: { text: `${NN} “第一句”\n${ME} “第二句”`, target: 'e1', base: `${NN} “第一句”`, rec: 'r_b', at: T0 } });
  assert.equal(only(s).length, 1);
  assert.deepEqual(s.data.entries.e1.audio.map(a => a.sha256), [sha('a'), sha('b')]);
  assert.equal(s.data.entries.e1.text, `${NN} “第一句”\n${ME} “第二句”`);
  assert.deepEqual(r.ids, ['e1']);
});

test('录音已经存进某条（停下时存好了、草稿还没来得及改）：字放进那一条，不另建', () => {
  const s = withEntries(E('e1', { audio: [{ sha256: sha('a'), mime: 'audio/mp4' }] }));
  const r = applyRecovery(s, [clip('a')], { rec: { text: `${NN} “存好了”`, target: null, base: null, rec: 'r_a', at: T0 } });
  assert.equal(only(s).length, 1);
  assert.equal(s.data.entries.e1.text, `${NN} “存好了”`);
  assert.equal(s.data.entries.e1.audio.length, 1);
  assert.deepEqual([r.clips, r.texts], [0, 1]);
});

test('没录音、只写了字：存成一条只有字的待整理；要写进的那条删了 → 新建', () => {
  const s = blankState();
  applyRecovery(s, [], { rec: { text: `${NN} “只写了字”`, target: null, base: null, rec: null, at: T0 } });
  const [e] = only(s);
  assert.deepEqual([e.text, e.status, e.audio.length, e.time], [`${NN} “只写了字”`, 'inbox', 0, null]);

  const s2 = withEntries(E('gone', { deleted: true, deletedAt: 5, text: '旧的' }));
  applyRecovery(s2, [clip('c')], { rec: { text: `${NN} “删了还写”`, target: 'gone', base: '旧的', rec: 'r_c', at: T0 } });
  const fresh = only(s2, e => !e.deleted);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].text, `${NN} “删了还写”`);
  assert.equal(fresh[0].audio[0].sha256, sha('c'));
  assert.equal(s2.data.entries.gone.text, '旧的');
});

test('「记一条」录到一半被杀：连同日期、原话、之前录好的那段建成一条待整理（旧草稿里的标题不要）；预填的「👰🏻‍♀️ “”」当成空的', () => {
  const s = blankState();
  const prev = { sha256: sha('f'), mime: 'audio/mp4', bytes: 5, durationSec: 3, origName: '', addedAt: 1 };
  const fresh = { w: { date: '2026-11-04', time: '', title: '测试标题', text: `${NN} “杀掉之前”`, note: '那天很累', draftText: '', draftSrc: '', audio: [prev], timeSource: null, recordedAt: null, tz: null },
    added: [sha('f')], removed: [], at: T0, rec: 'r_a' };
  const r = applyRecovery(s, [clip('a')], { fresh });
  const [e] = only(s);
  assert.deepEqual([e.title, e.text, e.note, e.status, e.date], ['', `${NN} “杀掉之前”`, '那天很累', 'inbox', '2026-11-04']);
  assert.deepEqual(e.audio.map(a => a.sha256), [sha('f'), sha('a')]);
  assert.deepEqual([e.time, e.timeSource], ['02:58', 'recorder']);        // 时间没填、录音是同一天 → 用录音的
  assert.deepEqual([r.dropFresh, r.fresh], [true, null]);

  const s2 = blankState();
  applyRecovery(s2, [clip('a')], { fresh: { ...fresh, w: { ...fresh.w, text: `${NN} “”`, date: '2026-10-01', time: '23:10', timeSource: 'manual' } } });
  const [e2] = only(s2);
  assert.deepEqual([e2.text, e2.date, e2.time, e2.timeSource], ['', '2026-10-01', '23:10', 'manual']);
});

test('「记一条」那段没找回来：草稿留着（去掉 rec），不建条目', () => {
  const s = blankState();
  const r = applyRecovery(s, [], { fresh: { w: { date: '2026-11-04', text: 'x', audio: [] }, added: [], removed: [], at: T0, rec: 'r_lost' } });
  assert.equal(only(s).length, 0);
  assert.equal(r.dropFresh, false);
  assert.deepEqual(r.fresh, { w: { date: '2026-11-04', text: 'x', audio: [] }, added: [], removed: [], at: T0 });
});

test('别的找回的录音照旧：接到 attachTo 那条，或者新建一条待整理；已经在条目里（包括删了的）的跳过', () => {
  const s = withEntries(E('e1'), E('d1', { deleted: true, deletedAt: 9, audio: [{ sha256: sha('d'), mime: 'audio/mp4' }] }));
  const r = applyRecovery(s, [clip('a', { attachTo: 'e1' }), clip('b'), clip('d'), { sha256: '' }], {});
  assert.deepEqual(s.data.entries.e1.audio.map(a => a.sha256), [sha('a')]);
  const made = only(s, e => e.audio.some(a => a.sha256 === sha('b')));
  assert.equal(made.length, 1);
  assert.equal(made[0].source.kind, 'recovered');
  assert.equal(only(s, e => e.audio.some(a => a.sha256 === sha('d'))).length, 1);
  assert.equal(r.clips, 2);
  assert.equal(r.ids.length, 2);
});

test('草稿的读写：坏内容、存不下都不抛；键名', () => {
  const st = fakeStorage();
  assert.equal(REC_DRAFT, 'babble.edit.rec');
  assert.equal(NEW_DRAFT, 'babble.edit.new');
  assert.equal(EDIT_PREFIX, EDITOR_PREFIX);
  assert.equal(readDraft(st, REC_DRAFT), null);
  assert.equal(writeDraft(st, REC_DRAFT, { text: 'a' }), true);
  assert.deepEqual(readDraft(st, REC_DRAFT), { text: 'a' });
  st.setItem(REC_DRAFT, '{坏的');
  assert.equal(readDraft(st, REC_DRAFT), null);
  dropDraft(st, REC_DRAFT);
  assert.equal(st.getItem(REC_DRAFT), null);
  assert.equal(writeDraft({ setItem() { throw new Error('quota'); } }, REC_DRAFT, {}), false);
  assert.equal(writeDraft(null, REC_DRAFT, {}), false);
  assert.equal(readDraft(null, REC_DRAFT), null);
});

test('录好的一段 → 条目里的 audio；录音时间 → 日期时间字段', () => {
  assert.deepEqual(clipOf(clip('a'), 7), { sha256: sha('a'), mime: 'audio/mp4', bytes: 1000, durationSec: 12, origName: '', addedAt: 7 });
  assert.deepEqual(clipOf({ sha256: sha('a') }, 7), { sha256: sha('a'), mime: 'audio/mp4', bytes: null, durationSec: null, origName: '', addedAt: 7 });
  assert.deepEqual(recTimeFields(T0, TZ), { date: '2026-11-04', time: '02:58', recordedAt: new Date(T0).toISOString(), tz: TZ, timeSource: 'recorder' });
  const none = recTimeFields(null, null);
  assert.deepEqual([none.time, none.timeSource, none.recordedAt], [null, null, null]);
});

test('写原话的小部件：预填模板、反应表情和编辑页一样', () => {
  const sp = { nn: { name: 'NN', emoji: NN, aliases: [] }, me: { name: '', emoji: ME, aliases: [] } };
  assert.deepEqual(startTemplate(sp), { text: `${NN} “”`, cursor: `${NN} “`.length });
  assert.equal(REACTIONS, EDITOR_REACTIONS);
  // insertLine 在文本框里插一行（这里用个假的文本框：没有 document.execCommand 就直接改 value）
  const ta = { value: `${NN} “你好”`, selectionStart: 3, selectionEnd: 3, focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  const doc = globalThis.document;
  globalThis.document = { execCommand: () => false };
  try {
    insertLine(ta, 'me', undefined, sp, { atEnd: true });
    assert.equal(ta.value, `${NN} “你好”\n${ME} “”`);
    assert.equal(ta.selectionEnd, ta.value.length - 1);
  } finally { globalThis.document = doc; }
});

test('编辑页：别的地方只是给这条加了录音 → 只列进来，不打断正在写的', () => {
  const a = { date: '2026-11-04', text: 'x', audio: [{ sha256: sha('a') }] };
  assert.deepEqual(addedAudio(a, { ...a, audio: [{ sha256: sha('a') }, { sha256: sha('b') }] }), [{ sha256: sha('b') }]);
  assert.equal(addedAudio(a, { ...a, text: 'y', audio: [{ sha256: sha('a') }, { sha256: sha('b') }] }), null);   // 原话也变了
  assert.equal(addedAudio(a, { ...a, audio: [{ sha256: sha('b') }, { sha256: sha('a') }] }), null);              // 不是在最后加的
  assert.equal(addedAudio(a, { ...a, audio: [{ sha256: sha('a'), name: '改了名' }, { sha256: sha('b') }] }), null);
  assert.equal(addedAudio(a, a), null);
  assert.equal(addedAudio(null, a), null);
});

// ---------- 要写进的那条已经永久删除了 ----------
const tombE = (id, gone = []) => normalizeEntry({ id, purged: true, deleted: true, updatedAt: 5000, purgedAt: 5000, purgedFrom: 4000,
  gone: gone.map(s => ({ sha256: s, mime: 'audio/mp4', purgedAt: 5000, from: 4000 })) }, id);

test('录音页要写进的那条已经永久删除：预填的旧原话不要，只有后来写的字和找回的录音存成新的一条（purgedText）', () => {
  const base = `${NN} “那条的原话”`;
  const s = withEntries(tombE('t1', [sha('a')]));
  const r = applyRecovery(s, [clip('b', { attachTo: 't1' })], { rec: { text: `${base}\n${ME} “后来写的”`, target: 't1', base, rec: 'r_b', at: T0 } });
  const fresh = only(s, e => !e.purged);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].text, `${ME} “后来写的”`);
  assert.deepEqual(fresh[0].audio.map(a => a.sha256), [sha('b')]);
  assert.ok(s.data.entries.t1.purged && s.data.entries.t1.text === '', '墓碑不动');
  assert.deepEqual([r.purgedText, r.dropRec, r.clips, r.texts], [true, true, 1, 1]);
  assert.ok(!JSON.stringify(s).includes('那条的原话'));
});

test('那条永久删除了、没写新字（或者旧原话改过）：只把找回的录音存成一条，旧原话不存；改过的整段交回去（stash，放进那条的编辑页草稿）；没录音也没新字：什么都不建', () => {
  const base = `${NN} “那条的原话”`;
  for (const [text, stash] of [[base, null], [`${NN} “改过的原话”`, { id: 't1', text: `${NN} “改过的原话”` }]]) {
    const s = withEntries(tombE('t1'));
    const r = applyRecovery(s, [clip('b', { attachTo: 't1' })], { rec: { text, target: 't1', base, rec: 'r_b', at: T0 } });
    const fresh = only(s, e => !e.purged);
    assert.deepEqual([fresh.length, fresh[0].text, fresh[0].audio.length, r.purgedText, r.texts, r.stash], [1, '', 1, true, 0, stash]);
  }
  // 插在旧原话前面、一行中间的字照样算新写的
  for (const [text, want] of [[`${ME} “先写的”\n${base}`, `${ME} “先写的”`], [`${NN} “那条的原话（笑）”`, '（笑）']]) {
    const s = withEntries(tombE('t1'));
    const r = applyRecovery(s, [], { rec: { text, target: 't1', base, rec: null, at: T0 } });
    assert.deepEqual([only(s, e => !e.purged).map(e => e.text), r.stash], [[want], null]);
  }
  const s = withEntries(tombE('t1'));
  const r = applyRecovery(s, [], { rec: { text: base, target: 't1', base: null, rec: null, at: T0 } });
  assert.deepEqual([only(s, e => !e.purged).length, r.purgedText, r.dropRec], [0, true, true]);
});

test('insertedText：在旧原话前后、两行之间、一行中间插进去的字 → 插进去的那部分；旧原话改过、删过、插的字粘着旧的一行换行 → null', () => {
  const B = `${NN}“第一句”\n${NN}“第二句”`;
  for (const [s, want] of [
    [B, ''], [B + `\n${NN}“新”`, `${NN}“新”`], [`${NN}“新”\n` + B, `${NN}“新”`],
    [`${NN}“第一句”\n${ME} 她又笑了\n${NN}“第二句”`, `${ME} 她又笑了`], [`${NN}“第一句（笑）”\n${NN}“第二句”`, '（笑）'],
    [`${NN}“第一句！”\n${NN}“新”\n${NN}“第二句”`, null], [`${NN}“第一局”\n${NN}“第二句”\n${NN}“新”`, null], [`${NN}“第二句”`, null],
  ]) assert.equal(insertedText(B, s), want, s);
  assert.equal(insertedText(`${NN}“旧”`, `${NN}“新”\n${NN}“旧”`), `${NN}“新”`, '插的字开头和旧原话一样：挑在一行开头');
  assert.equal(insertedText('', `${NN}“新”`), `${NN}“新”`);
  assert.equal(insertedText('😀', '😁😀'), '😁', '不从 emoji 中间切开');
});

test('stashPurgedText：放进那条的编辑页草稿（babble.edit.<id>）；已经有草稿就接在后面；没字不写', () => {
  const st = fakeStorage();
  assert.equal(stashPurgedText(st, 't1', '  '), false);
  assert.equal(st.getItem(EDIT_PREFIX + 't1'), null);
  assert.equal(stashPurgedText(st, 't1', `${NN} “改过的原话”`, 5), true);
  assert.deepEqual(readDraft(st, EDIT_PREFIX + 't1'), { w: { text: `${NN} “改过的原话”` }, at: 5 });
  writeDraft(st, EDIT_PREFIX + 't2', { w: { text: '编辑页里写的', note: '背景' }, added: [], at: 1 });
  stashPurgedText(st, 't2', '录音页写的', 9);
  assert.deepEqual(readDraft(st, EDIT_PREFIX + 't2'), { w: { text: '编辑页里写的\n\n录音页写的', note: '背景' }, added: [], at: 9 });
});

test('找回的录音已经永久删除过（有记号、没条目在用）：不另建一条（删掉以后残留的分片）；在「移除的录音」里的：不另建，要接回的那条照样接回', () => {
  const s = withEntries(tombE('t1', [sha('a')]), E('e2', { removedAudio: [{ sha256: sha('c'), mime: 'audio/mp4', removedAt: 9 }, { sha256: sha('7'), mime: 'audio/mp4', removedAt: 9 }] }));
  const r = applyRecovery(s, [clip('a', { attachTo: 'e2' }), clip('c'), clip('d'), clip('7', { attachTo: 'e2' })], {});
  assert.deepEqual(only(s, e => !e.purged && e.id !== 'e2').map(e => e.audio[0].sha256), [sha('d')]);
  assert.deepEqual(normalizeEntry(s.data.entries.e2).audio.map(a => a.sha256), [sha('7')], '录音页放弃以后写回的恢复记录：回到那条（整理时从「移除的录音」拿回来）');
  assert.deepEqual(normalizeEntry(s.data.entries.e2).removedAudio.map(a => a.sha256), [sha('c')]);
  assert.equal(r.clips, 2);
  // 「记一条」草稿里的录音：已经永久删除的不带上
  const s2 = withEntries(tombE('t1', [sha('a')]));
  applyRecovery(s2, [clip('f')], { fresh: { w: { date: '2026-11-04', text: 'x', audio: [{ sha256: sha('a'), mime: 'audio/mp4' }, { sha256: sha('e'), mime: 'audio/mp4' }] }, added: [], removed: [], at: T0, rec: 'r_f' } });
  assert.deepEqual(only(s2, e => !e.purged)[0].audio.map(a => a.sha256), [sha('e'), sha('f')]);
});
