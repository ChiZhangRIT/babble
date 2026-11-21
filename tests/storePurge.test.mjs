import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankState, normalizeState, normalizeEntry, mergeStates, pickEntry, canon, deletedRecord, restoredRecord, stamp, makeEntry,
  purgedRecord, purgeRemovedRecord, restoreRemovedRecord, orphanTombstone, trackRemoved, freshAdds, restoreAudio, killedIn, stateTime,
  claimShas, stubShas, goneShas, contestedShas, referencedClips, removedClips, trashKeys, isTombstone, PURGE_MS, TOUCH_MS,
} from '../src/core/store.js';
import * as state from '../src/core/state.js';
import { readStoredState, STATE_KEY, PENDING_PREFIX } from '../src/core/persistence.js';

// 永久删除的数据层：墓碑、移除的录音、记号（gone）、合并规则、由数据算出来的集合、改一条的函数，以及 state.js 怎么用它们。
// 全是编的例子（仓库是公开的，不放真的梦话）
const sha = c => c.repeat(64);
const A = sha('a'), B = sha('b'), C = sha('c'), D = sha('d');
const item = (s, addedAt = 1000, extra = {}) => ({ sha256: s, mime: 'audio/mp4', bytes: 10, durationSec: 2, origName: '', addedAt, ...extra });
const E = (fields = {}) => normalizeEntry({ id: 'e1', date: '2026-01-02', text: '“今天吃什么”', updatedAt: 1000, audio: [], ...fields }, fields.id || 'e1');
const stateWith = (...list) => { const s = blankState(); for (const e of list) s.data.entries[e.id] = normalizeEntry(e, e.id); return s; };
const shas = e => (e.audio || []).map(a => a.sha256);
const rems = e => (e.removedAudio || []).map(a => a.sha256);
const fakeStorage = () => {
  const m = new Map();
  return { m, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => m.delete(k) };
};
const both = (a, b) => { const x = pickEntry(a, b), y = pickEntry(b, a); assert.equal(canon(x), canon(y), '合并和顺序无关'); return x; };

// ---------- 墓碑 ----------
test('墓碑：只留固定的这些键（原话、录音、别的字段都丢掉），日期都从 purgedAt 来，可重复整理', () => {
  const purgedAt = Date.UTC(2026, 10, 20, 8);
  const t = normalizeEntry({
    id: 'e1', updatedAt: purgedAt + 5, purged: true, purgedAt, purgedFrom: 900, deleted: true, deletedAt: 1, deletedBy: { who: 'me', device: 'Mac' },
    text: '“不该留下的原话”', note: '背景', draft: { text: '草稿' }, fav: true, audio: [item(A)], removedAudio: [item(B, 1, { removedAt: 5 })], badDate: 'x',
    future: 1, updatedBy: { who: 'nn', device: 'iPad', at: purgedAt + 5, extra: 1 },
    gone: [{ sha256: B.toUpperCase(), mime: 'audio/webm', purgedAt, from: 900 }, { sha256: A, purgedAt: 3, from: 800 }, { sha256: A, purgedAt, from: 900 }, { sha256: 'bad' }],
  }, 'e1');
  assert.deepEqual(t, {
    id: 'e1', updatedAt: purgedAt + 5, updatedBy: { who: 'nn', device: 'iPad', at: purgedAt + 5, extra: 1 },
    createdAt: purgedAt, date: '2026-11-20', time: null, recordedAt: null, tz: null, timeSource: null,
    status: 'done', title: '', text: '', note: '', draft: null, fav: false, audio: [], source: { kind: 'app' },
    deleted: true, deletedAt: purgedAt, purged: true, purgedAt, purgedFrom: 900,
    gone: [{ sha256: A, mime: 'audio/mp4', purgedAt, from: 900 }, { sha256: B, mime: 'audio/webm', purgedAt, from: 900 }],
  });
  assert.equal(canon(normalizeEntry(t, 'e1')), canon(t));
  assert.equal(canon(normalizeEntry(JSON.parse(JSON.stringify(t)), 'e1')), canon(t), '存进去、读回来一样');
  assert.ok(isTombstone(t));
  // 旧版 app 点了「恢复」（去掉 deleted、盖新时间）、又在空白的那一行里写了字：还是墓碑，字丢掉
  const { deleted, deletedAt, ...old } = t;
  const back = normalizeEntry({ ...old, updatedAt: t.updatedAt + 9, text: '旧版 app 里写的', audio: [item(C)] }, 'e1');
  assert.equal(back.deleted, true); assert.equal(back.text, ''); assert.deepEqual(back.audio, []); assert.equal(back.updatedAt, t.updatedAt + 9);
  // purgedFrom 没有 → 0（谁也盖不过）；purgedAt 没有 → updatedAt
  const bare = normalizeEntry({ id: 'x', purged: true, updatedAt: 77 }, 'x');
  assert.deepEqual([bare.purgedFrom, bare.purgedAt, bare.deletedAt, bare.date, bare.gone], [0, 77, 77, '1970-01-01', []]);
  assert.equal(normalizeEntry({ id: 'x', purged: true, updatedAt: 1, purgedAt: Infinity }, 'x').purgedAt, 1, '坏的时间不进去（JSON 存不下 Infinity）');
});

// ---------- 没永久删除的条目 ----------
// 这几份是改之前的代码整理出来的样子（canon），没有新字段的条目整理出来必须一字不差：不然每台设备都会无缘无故多出一个版本、多推一次
const LEGACY = [
  { id: 'e1', date: '2026-11-04', time: '02:58', text: '👰🏻‍♀️“今天吃什么”', note: '背景', updatedAt: 1700, createdAt: 1600, fav: true, status: 'inbox',
    audio: [{ sha256: A, mime: 'audio/mp4', bytes: 10, durationSec: 3.5, origName: 'x.m4a', addedAt: 1650, name: '第一段' }, { sha256: 'B'.repeat(64), addedAt: '7' }],
    draft: { text: '草稿', source: 'whisper-base@Mac', parts: [{ sha256: A, text: '草稿' }] }, source: { kind: 'audio-import', batchId: 'b1' },
    updatedBy: { who: 'me', device: 'Mac', at: 1700 }, future: { keep: 1 } },
  { id: 'e2', date: 'bad', deleted: true, deletedAt: 5, deletedBy: { who: 'nn', device: 'iPad', at: 5 }, updatedAt: 5, audio: 'junk', source: 'x', title: '旧标题' },
  { id: 'e3', updatedAt: 0 },
];
const LEGACY_CANON = ['{"audio":[{"addedAt":1650,"bytes":10,"durationSec":3.5,"mime":"audio/mp4","name":"第一段","origName":"x.m4a","sha256":"' + A + '"},{"addedAt":7,"bytes":null,"durationSec":null,"mime":"audio/mp4","origName":"","sha256":"' + B + '"}],"createdAt":1600,"date":"2026-11-04","draft":{"parts":[{"sha256":"' + A + '","text":"草稿"}],"source":"whisper-base@Mac","text":"草稿"},"fav":true,"future":{"keep":1},"id":"e1","note":"背景","recordedAt":null,"source":{"batchId":"b1","kind":"audio-import"},"status":"inbox","text":"👰🏻‍♀️“今天吃什么”","time":"02:58","timeSource":null,"title":"","tz":null,"updatedAt":1700,"updatedBy":{"at":1700,"device":"Mac","who":"me"}}',
  '{"audio":[],"badDate":"bad","createdAt":5,"date":"1970-01-01","deleted":true,"deletedAt":5,"deletedBy":{"at":5,"device":"iPad","who":"nn"},"draft":null,"fav":false,"id":"e2","note":"","recordedAt":null,"source":{"kind":"app"},"status":"done","text":"","time":null,"timeSource":null,"title":"旧标题","tz":null,"updatedAt":5}',
  '{"audio":[],"createdAt":0,"date":"1970-01-01","draft":null,"fav":false,"id":"e3","note":"","recordedAt":null,"source":{"kind":"app"},"status":"done","text":"","time":null,"timeSource":null,"title":"","tz":null,"updatedAt":0}'];

test('没有新字段的条目：整理出来和以前一字不差；合并走原来的路（同一个对象，一模一样）', () => {
  assert.deepEqual(LEGACY.map(e => canon(normalizeEntry(e, e.id))), LEGACY_CANON);
  const a = E({ text: '甲', updatedAt: 100 }), b = E({ text: '乙', updatedAt: 200 }), c = E({ text: '丙', updatedAt: 200 });
  assert.equal(pickEntry(a, b), b); assert.equal(pickEntry(b, a), b);
  assert.equal(pickEntry(b, c), pickEntry(c, b));
  assert.equal(pickEntry(null, a), a); assert.equal(pickEntry(a, undefined), a);
});

test('记号盖住哪些：这一条里时间不晚于 from 的（audio 看 restoredAt 或 addedAt，removedAudio 看 removedAt）；from = −1 谁也不盖，addedAt 0 的老录音也不盖', () => {
  const g = (s, from) => ({ sha256: s, mime: 'audio/mp4', purgedAt: 5000, from });
  const e = E({ audio: [item(A, 100), item(B, 101), item(C, 0), item(D, 50, { restoredAt: 150 })], gone: [g(A, 100), g(B, 100), g(C, -1), g(D, 100)] });
  assert.deepEqual(shas(e), [B, C, D], 'A（100 ≤ 100）盖住；B（101）、D（放回来的 150）不盖；C 只是记号');
  assert.equal(normalizeEntry({ ...e, audio: [item(C, 0)], gone: [g(C, 0)] }).audio.length, 0, 'from 0 盖得住 addedAt 0');
  assert.equal(normalizeEntry({ ...e, gone: [{ sha256: C }] }).gone[0].from, -1, '没写 from 的只是记号');
  const r = E({ removedAudio: [item(A, 1, { removedAt: 100 }), item(B, 1, { removedAt: 101 })], gone: [g(A, 100), g(B, 100)] });
  assert.deepEqual(rems(r), [B]);
  assert.equal(killedIn(e, item(A, 100)), true); assert.equal(killedIn(e, item(A, 101)), false); assert.equal(killedIn(null, item(A)), false);
  assert.equal(stateTime(item(A, 5, { restoredAt: 9 })), 9); assert.equal(stateTime({ removedAt: 7 }, true), 7);
});

test('移除的录音：removedAt 没写用 updatedAt；同一段留 removedAt 大的；按 removedAt、sha 排；空了不写；audio 里不留 removedAt，removedAudio 里不留 restoredAt', () => {
  const e = E({ updatedAt: 900, audio: [item(C, 5, { removedAt: 1, restoredAt: 'x' })],
    removedAudio: [item(B, 1, { removedAt: 300 }), item(A, 1), item(B, 1, { removedAt: 200, restoredAt: 9 }), { sha256: 'bad' }] });
  assert.deepEqual(e.removedAudio.map(a => [a.sha256, a.removedAt]), [[B, 300], [A, 900]]);
  assert.ok(e.removedAudio.every(a => a.restoredAt === undefined));
  assert.deepEqual(Object.keys(e.audio[0]).sort(), ['addedAt', 'bytes', 'durationSec', 'mime', 'origName', 'sha256']);
  assert.equal(canon(normalizeEntry(e)), canon(e));
  const none = E({ removedAudio: [], gone: [] });
  assert.ok(!('removedAudio' in none) && !('gone' in none));
});

test('同一段既在 audio 又在 removedAudio（本机把它放回 audio 了）：留 audio；不比那次移除新的盖上 restoredAt = removedAt + 1', () => {
  const e = E({ audio: [item(A, 100), item(B, 500)], removedAudio: [item(A, 100, { removedAt: 300 }), item(B, 100, { removedAt: 400 })] });
  assert.deepEqual(shas(e), [A, B]);
  assert.equal(e.removedAudio, undefined);
  assert.equal(e.audio[0].restoredAt, 301);
  assert.equal(e.audio[1].restoredAt, undefined, '本来就比移除新');
  assert.equal(canon(normalizeEntry(e)), canon(e));
});

test('草稿里转出的字（D19）：录音永久删除了 → 那段去掉；没改过的按剩下的重新拼，改过的一个字不动；都没了、字也空 → 没有草稿', () => {
  const g = { sha256: A, mime: 'audio/mp4', purgedAt: 9, from: 5000 };
  const parts = [{ sha256: A, text: '甲段' }, { sha256: B, text: '乙段' }];
  const auto = E({ audio: [item(B)], draft: { text: '甲段\n\n乙段', source: 'whisper-base@Mac', parts }, gone: [g] });
  assert.deepEqual(auto.draft, { text: '乙段', source: 'whisper-base@Mac', parts: [{ sha256: B, text: '乙段' }] });
  assert.equal(canon(normalizeEntry(auto)), canon(auto));
  const edited = E({ audio: [item(B)], draft: { text: '甲段（我改过）\n\n乙段', source: 'paste', parts }, gone: [g] });
  assert.equal(edited.draft.text, '甲段（我改过）\n\n乙段');
  assert.deepEqual(edited.draft.parts, [{ sha256: B, text: '乙段' }]);
  const only = E({ draft: { text: '甲段', source: 'x', parts: [parts[0]] }, gone: [g] });
  assert.equal(only.draft, null);
  const kept = E({ removedAudio: [item(A, 1, { removedAt: 6000 })], draft: { text: '甲段', source: 'x', parts: [parts[0]] }, gone: [g] });
  assert.equal(kept.draft.text, '甲段', '还在「移除的录音」里（放回去过、又移除）：转出的字留着');
  const noStub = E({ draft: { text: '甲段', source: 'x', parts: [parts[0]] } });
  assert.deepEqual(noStub.draft.parts, [parts[0]], '没有记号：不动（录音只是不在这条里）');
});

// ---------- 合并 ----------
const tomb = (fields = {}) => normalizeEntry({ id: 'e1', purged: true, deleted: true, updatedAt: 3000, purgedAt: 3000, purgedFrom: 2000,
  gone: [{ sha256: A, mime: 'audio/mp4', purgedAt: 3000, from: 2000 }], ...fields }, 'e1');

test('墓碑对旧的副本（就是永久删除的那一版、或者更早的）：墓碑赢；那份另有的记号带上，只在那份里的录音不记号（成了没人用的录音，不删）', () => {
  const t = tomb();
  const stale = E({ deleted: true, deletedAt: 2000, updatedAt: 2000, text: '“原话”', audio: [item(A), item(C)], gone: [{ sha256: D, purgedAt: 1500, from: 1400 }] });
  const out = both(t, stale);
  assert.ok(out.purged); assert.equal(out.text, ''); assert.equal(out.updatedAt, 3001, '记号多了：和两边都不一样，盖新 1 毫秒');
  assert.deepEqual(out.gone.map(g => g.sha256), [A, D]);
  assert.equal(canon(both(t, E({ deleted: true, updatedAt: 1500, audio: [item(A)] }))), canon(t), '没有新东西：就是墓碑本身，不盖新时间');
  assert.equal(canon(pickEntry(t, t)), canon(t));
});

test('墓碑对更新的副本（别的设备恢复了、改过）：永久删除作废，那份赢、时间比墓碑新；记号带上只是记号（更早的「移除的录音」的永久删除照样算）', () => {
  const t = tomb({ gone: [{ sha256: A, purgedAt: 3000, from: 2000 }, { sha256: B, purgedAt: 1800, from: 1700 }] });
  const newer = E({ updatedAt: 2500, text: '“恢复以后改的”', audio: [item(A)], removedAudio: [item(B, 1, { removedAt: 1700 }), item(C, 1, { removedAt: 2400 })] });
  const out = both(t, newer);
  assert.ok(!out.purged && !out.deleted);
  assert.equal(out.text, '“恢复以后改的”');
  assert.ok(out.updatedAt > t.updatedAt);
  assert.deepEqual(shas(out), [A]);
  assert.deepEqual(rems(out), [C], 'B 是那次「移除的录音」的永久删除盖住的（from 1700 = 它的 removedAt）');
  assert.deepEqual(out.gone.map(g => [g.sha256, g.from]), [[A, -1], [B, 1700]]);
  // 再合并一次不变；旧版 app 拿到也是直接用（时间更新）
  assert.equal(canon(both(out, t)), canon(out));
  assert.equal(canon(both(out, newer)), canon(out));
});

test('两份墓碑：取新的那份，purgedAt / purgedFrom 取大的，记号合起来', () => {
  const t1 = tomb({ updatedAt: 3000, purgedAt: 3000, purgedFrom: 2000, gone: [{ sha256: A, purgedAt: 3000, from: 2000 }] });
  const t2 = tomb({ updatedAt: 4000, purgedAt: 4000, purgedFrom: 2100, gone: [{ sha256: B, purgedAt: 4000, from: 2100 }], updatedBy: { who: 'nn', device: 'iPad', at: 4000 } });
  const out = both(t1, t2);
  assert.deepEqual([out.purgedAt, out.purgedFrom, out.updatedBy.device], [4000, 2100, 'iPad']);
  assert.deepEqual(out.gone.map(g => g.sha256), [A, B]);
  assert.equal(out.updatedAt, 4001, '和两边都不一样');
});

test('两份都没永久删除：文字整条取新的，录音一段一段比时间', () => {
  const base = { updatedAt: 1000, audio: [item(A), item(B)] };
  // 一边移除了 A，另一边之后改了原话（手里的副本 A 还在）：移除算数
  const removed = E({ ...base, updatedAt: 2000, audio: [item(B)], removedAudio: [item(A, 1000, { removedAt: 2000 })] });
  const edited = E({ ...base, updatedAt: 3000, text: '“改了原话”' });
  let out = both(removed, edited);
  assert.deepEqual([out.text, shas(out), rems(out)], ['“改了原话”', [B], [A]]);
  assert.equal(out.updatedAt, 3001);
  // 一边放回了 A（restoredAt），另一边同时永久删除了「移除的录音」A（from = 那次的 removedAt）：放回去的赢
  const restored = E({ ...base, updatedAt: 4000, audio: [item(B), item(A, 1000, { restoredAt: 4000 })] });
  const purged = E({ ...base, updatedAt: 4500, audio: [item(B)], gone: [{ sha256: A, purgedAt: 4500, from: 2000 }] });
  out = both(restored, purged);
  assert.deepEqual(shas(out), [B, A]);
  assert.equal(out.gone[0].sha256, A, '记号留着，只是盖不住它');
  // 放回去的对之后别人改原话（手里还是移除的样子）：放回去的赢
  out = both(restored, E({ ...removed, updatedAt: 5000, text: '“后来改的”' }));
  assert.deepEqual([out.text, shas(out), rems(out)], ['“后来改的”', [B, A], []]);
  // 只在旧的那份 audio 里、哪儿都没有记录的：和以前一样整条取新的（旧版 app 移除的、旧备份里的不加回来）
  out = both(E({ updatedAt: 6000, audio: [item(B)], removedAudio: [item(C, 1, { removedAt: 5900 })] }), E({ updatedAt: 1000, audio: [item(A), item(B)] }));
  assert.deepEqual([shas(out), rems(out)], [[B], [C]]);
  // 只在旧的那份 removedAudio 里的：照样留在「移除的录音」里
  out = both(E({ updatedAt: 6000, audio: [item(B)] }), E({ updatedAt: 1000, audio: [item(B)], removedAudio: [item(A, 1, { removedAt: 900 })] }));
  assert.deepEqual([shas(out), rems(out)], [[B], [A]]);
  assert.equal(out.updatedAt, 6001);
});

test('盖新时间只在合出来和两边都不一样时；一边包含另一边就原样取那一边', () => {
  const a = E({ updatedAt: 2000, audio: [item(B)], removedAudio: [item(A, 1000, { removedAt: 2000 })] });
  const older = E({ updatedAt: 1000, audio: [item(A), item(B)] });
  assert.equal(canon(both(a, older)), canon(a));
  const b = E({ updatedAt: 3000, text: '“新”', audio: [item(A), item(B)] });
  assert.equal(both(a, b).updatedAt, 3001);
});

test('同一段录音在两条里：一条的记号只管它自己，另一条照样用，算不上「没了」', () => {
  const s = stateWith(
    E({ id: 'e1', deleted: true, updatedAt: 2000 }),
    { ...tomb(), id: 'e2', gone: [{ sha256: A, purgedAt: 3000, from: 2000 }] },
    E({ id: 'e3', audio: [item(A, 1000)] }),
  );
  assert.deepEqual([...goneShas(s)], []);
  assert.deepEqual([...contestedShas(s)], [A], '有记号又有条目在用：同步时查一下仓库里还在不在');
  assert.deepEqual(shas(s.data.entries.e3), [A]);
});

// ---------- 随机：交换律、合并自己不变、经过同一个仓库一定收敛 ----------
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
/** 几台设备从同一份开始，随机地改原话、移除 / 放回 / 加录音、永久删除移除的录音、删除 / 恢复 / 永久删除，中间偶尔两两合并 */
function histories(rnd, n) {
  const one = a => a[Math.floor(rnd() * a.length)];
  let now = 1000, k = 0;
  const base = E({ updatedAt: now, audio: [item(A, now), item(B, now)] });
  const Dv = Array.from({ length: n }, () => base);
  for (let step = 0; step < 10; step++) {
    now += Math.floor(rnd() * 3) * 500 + 1;
    const i = Math.floor(rnd() * n), c = Dv[i], at = Math.max(now, c.updatedAt + 1);
    if (c.purged) continue;
    const op = one(['text', 'remove', 'restore', 'add', 'purgeClip', 'del', 'undel', 'purge', 'sync', 'sync']);
    let next = null;
    if (op === 'text') next = E({ ...c, text: '“' + now + '”', updatedAt: at });
    else if (op === 'remove' && c.audio.length) { const x = one(c.audio); next = E(trackRemoved(c, { ...c, audio: c.audio.filter(a => a !== x), updatedAt: at }, now)); }
    else if (op === 'restore' && c.removedAudio) next = restoreRemovedRecord(c, one(c.removedAudio).sha256, now);
    else if (op === 'add') next = E({ ...c, audio: [...c.audio, item(sha('cdef'[k++ % 4]), now)], updatedAt: at });
    else if (op === 'purgeClip' && c.removedAudio && !c.deleted) { const x = one(c.removedAudio); next = purgeRemovedRecord(c, [x], now); }
    else if (op === 'del') next = deletedRecord(c, now) && E(deletedRecord(c, now));
    else if (op === 'undel') next = restoredRecord(c, now) && E(restoredRecord(c, now));
    else if (op === 'purge') next = purgedRecord(c, c.updatedAt, now);
    else if (op === 'sync') { const j = Math.floor(rnd() * n); Dv[i] = Dv[j] = pickEntry(Dv[i], Dv[j]); }
    if (next) Dv[i] = next;
  }
  return Dv;
}

test('随机：合并和顺序无关、合并自己不变、并进来过的再合并一次不变', () => {
  const rnd = rng(7);
  for (let run = 0; run < 300; run++) {
    const Dv = histories(rnd, 3 + Math.floor(rnd() * 3));
    for (const x of Dv) {
      assert.equal(canon(pickEntry(x, x)), canon(x));
      for (const y of Dv) {
        const m = pickEntry(x, y);
        assert.equal(canon(m), canon(pickEntry(y, x)));
        assert.equal(canon(pickEntry(x, m)), canon(m), '合并结果再和其中一份合并：不变（不会来回推）');
      }
    }
  }
});

test('随机：几台设备经过同一个仓库同步（每台拉下来合并、推上去），顺序随便，最多三轮就都一样、不再变', () => {
  const rnd = rng(11);
  for (let run = 0; run < 300; run++) {
    const Dv = histories(rnd, 3 + Math.floor(rnd() * 3));
    let repo = null, pass = 0;
    for (; pass < 6; pass++) {
      let changed = false;
      for (const i of [...Dv.keys()].sort(() => rnd() - 0.5)) {
        const m = repo ? pickEntry(Dv[i], repo) : Dv[i];
        if (canon(m) !== canon(Dv[i]) || canon(m) !== canon(repo)) changed = true;
        Dv[i] = repo = m;
      }
      if (!changed) break;
    }
    assert.ok(pass < 3, '三轮以内不再变');
    for (const x of Dv) assert.equal(canon(x), canon(repo));
  }
});

// ---------- 旧版 app（还没更新） ----------
// 旧版的整理和合并（照抄改之前的 store.js）：不认识的字段原样留着，整条取 updatedAt 新的
const oldNormAudio = list => { const seen = new Set(); return (Array.isArray(list) ? list : []).filter(a => a && typeof a === 'object' && /^[0-9a-fA-F]{64}$/.test(a.sha256)).map(a => ({ ...a, sha256: a.sha256.toLowerCase(), mime: a.mime || 'audio/mp4', bytes: a.bytes ?? null, durationSec: a.durationSec ?? null, origName: a.origName || '', addedAt: Number(a.addedAt) || 0 })).filter(a => !seen.has(a.sha256) && seen.add(a.sha256)); };
const oldNormalize = (rec) => {
  const r = { ...rec, updatedAt: Number(rec.updatedAt) || 0 };
  r.createdAt = Number(rec.createdAt) || r.updatedAt; r.audio = oldNormAudio(r.audio);
  for (const k of ['title', 'text', 'note']) r[k] = typeof r[k] === 'string' ? r[k] : '';
  if (r.deleted) { r.deleted = true; r.deletedAt = Number(r.deletedAt) || r.updatedAt; } else { delete r.deleted; delete r.deletedAt; delete r.deletedBy; }
  return r;
};
const oldPick = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) !== (a.updatedAt || 0) ? ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a) : canon(b) > canon(a) ? b : a);
/** 新版、旧版轮流经过仓库同步 rounds 次（每次：拉下来合并，变了就推上去）→ 每次推上去的 */
function alternate(newer, older, { rounds = 6, oldFirst = false } = {}) {
  let repo = null, N = newer, O = older;
  const pushes = [];
  for (let i = 0; i < rounds; i++) {
    if ((i % 2 === 0) !== oldFirst) { const m = repo ? pickEntry(N, normalizeEntry(repo, 'e1')) : N; if (!repo || canon(m) !== canon(normalizeEntry(repo, 'e1'))) { repo = JSON.parse(JSON.stringify(m)); pushes.push(i); } N = m; }
    else { const m = repo ? oldPick(O, oldNormalize(repo)) : O; if (!repo || canon(m) !== canon(repo)) { repo = JSON.parse(JSON.stringify(m)); pushes.push(i); } O = m; }
  }
  return { N, O, repo, pushes };
}

test('旧版 app：拿着旧副本改了原话（盖住的录音还在 audio 里）→ 新版合出来干净的一份、时间新 1 毫秒，旧版直接采用，几轮以后不再推', () => {
  const N = E({ updatedAt: 3000, audio: [item(B)], gone: [{ sha256: A, purgedAt: 3000, from: 2000 }] });
  const O = oldNormalize({ ...E({ audio: [item(A), item(B)] }), updatedAt: 4000, text: '“旧版改的”' });
  const r = alternate(N, O);
  assert.deepEqual([r.N.text, shas(r.N)], ['“旧版改的”', [B]]);
  assert.equal(canon(r.O), canon(r.N), '旧版采用了新版合出来的那份');
  assert.ok(r.pushes.every(i => i <= 2), '第三次以后谁都不用再推');
});

test('旧版 app：在作废的那条上 / 墓碑上——新版合出来的结果旧版直接采用，不来回推', () => {
  // 旧版恢复了一份更新的（比 purgedFrom 新）、先推上去：作废，结果时间比墓碑新，旧版采用
  const T = tomb();
  const O = oldNormalize({ ...E({ updatedAt: 2500, text: '“旧版恢复的”', audio: [item(A)] }) });
  let r = alternate(T, O, { oldFirst: true });
  assert.ok(!r.N.purged && r.N.text === '“旧版恢复的”');
  assert.ok(r.N.updatedAt > T.updatedAt);
  assert.equal(canon(r.O), canon(r.N));
  assert.ok(r.pushes.every(i => i <= 2));
  // 墓碑先推上去：旧版只比时间，采用墓碑（它那次恢复没了：新旧版本混用时的已知风险，所以分两步上线）；也不来回推
  r = alternate(T, O);
  assert.ok(r.N.purged); assert.equal(canon(r.O), canon(r.N)); assert.ok(r.pushes.every(i => i <= 2));
  // 旧版手里是永久删除的那一版（不比 purgedFrom 新）：采用墓碑
  r = alternate(T, oldNormalize(E({ deleted: true, updatedAt: 2000, audio: [item(A)] })));
  assert.ok(r.N.purged); assert.equal(canon(r.O), canon(r.N));
  // 旧版在空白的那一行上点了恢复（去掉 deleted、时间更新）：新版还是当墓碑；不再变
  const { deleted, deletedAt, ...restoredByOld } = T;
  r = alternate(T, { ...restoredByOld, updatedAt: 5000 });
  assert.ok(r.N.purged && r.N.deleted);
  assert.equal(canon(normalizeEntry(r.O, 'e1')), canon(r.N));
});

// ---------- 由数据算出来的 ----------
test('有人用 / 有记号 / 确实没了 / 要查的：共用的录音、移除的录音、最近删除里的、孤儿墓碑、只是记号', () => {
  const g = (s, from = 2000) => ({ sha256: s, mime: 'audio/webm', purgedAt: 3000, from });
  const s = stateWith(
    E({ id: 'live', audio: [item(A, 2500)], removedAudio: [item(B, 1, { removedAt: 2600 })], gone: [g(A), g(B)] }),   // 记号盖不住（放回来、重新移除过）
    E({ id: 'del', deleted: true, audio: [item(C)] }),
    { ...tomb(), id: 'tomb', gone: [g(C), g(D)] },
    orphanTombstone([{ sha256: sha('e'), mime: 'audio/mp4' }], 4000),
    E({ id: 'inert', audio: [item(sha('f'))], gone: [g(sha('f'), -1)] }),
  );
  assert.deepEqual([...claimShas(s)].sort(), [A, B, C, sha('f')].sort());
  assert.deepEqual([...stubShas(s).keys()].sort(), [A, B, C, D, sha('e'), sha('f')].sort());
  assert.deepEqual(stubShas(s).get(D), { mime: 'audio/webm', purgedAt: 3000 });
  assert.deepEqual([...goneShas(s)].sort(), [D, sha('e')].sort(), '最近删除里的条目（C）、移除的录音（B）也算有人用');
  assert.deepEqual([...contestedShas(s)].sort(), [A, sha('f')].sort(), '只算没删除的条目的 audio');
  assert.deepEqual([...referencedClips(s).keys()].sort(), [A, sha('f')].sort());
  assert.ok(referencedClips(s, { includeRemoved: true }).has(B));
  assert.ok(referencedClips(s, { includeDeleted: true }).has(C));
  assert.equal(PURGE_MS, 30 * 864e5); assert.equal(TOUCH_MS, 36e5);
});

test('「移除的录音」列表（移除得晚的在前，删除了的条目里的不列）；最近删除的键（条目 e:、移除的录音 c:，带同步来的时间）', () => {
  const s = stateWith(
    E({ id: 'x', updatedAt: 900, removedAudio: [item(A, 1, { removedAt: 100 }), item(B, 1, { removedAt: 300 })] }),
    E({ id: 'y', removedAudio: [item(C, 1, { removedAt: 200 })] }),
    E({ id: 'd', deleted: true, deletedAt: 400, removedAudio: [item(D, 1, { removedAt: 50 })] }),
    tomb({ id: 't' }),
  );
  assert.deepEqual(removedClips(s).map(r => [r.entryId, r.item.sha256, r.at]), [['x', B, 900], ['y', C, 1000], ['x', A, 900]]);
  assert.deepEqual([...trashKeys(s)], [
    ['c:x:' + A, { kind: 'clip', id: 'x', sha: A, since: 100 }], ['c:x:' + B, { kind: 'clip', id: 'x', sha: B, since: 300 }],
    ['c:y:' + C, { kind: 'clip', id: 'y', sha: C, since: 200 }], ['e:d', { kind: 'entry', id: 'd', since: 400 }],
  ]);
});

// ---------- 改一条的函数 ----------
test('purgedRecord：只删用户看到的那一版（updatedAt 对得上、还在最近删除里）；所有录音（含移除的、以前的记号）都记下，from = 那一版', () => {
  const del = E({ deleted: true, updatedAt: 2000, audio: [item(A)], removedAudio: [item(B, 1, { removedAt: 1500 })], gone: [{ sha256: C, purgedAt: 1200, from: 1100 }] });
  assert.equal(purgedRecord(del, 1999, 3000), null, '期间变了');
  assert.equal(purgedRecord(E({ updatedAt: 2000 }), 2000, 3000), null, '没在最近删除里');
  const t = purgedRecord(del, 2000, 3000);
  assert.ok(t.purged && t.deleted);
  assert.deepEqual([t.updatedAt, t.purgedAt, t.purgedFrom], [3000, 3000, 2000]);
  assert.deepEqual(t.gone.map(g => [g.sha256, g.from, g.purgedAt]), [[A, 2000, 3000], [B, 2000, 3000], [C, 1100, 1200]]);
  assert.equal(purgedRecord(t, t.updatedAt, 4000), null, '已经是墓碑');
  const slow = purgedRecord(del, 2000, 10);
  assert.deepEqual([slow.updatedAt, slow.purgedAt], [2001, 2001], '时钟慢：不早于上一版');
});

test('purgeRemovedRecord：只删用户看到的那几段（removedAt 对得上）；from = removedAt；草稿里那段转出的字跟着去掉', () => {
  const e = E({ updatedAt: 2000, audio: [item(C)], removedAudio: [item(A, 1, { removedAt: 1500 }), item(B, 1, { removedAt: 1600 })],
    draft: { text: '甲段\n\n丙段', source: 'x', parts: [{ sha256: A, text: '甲段' }, { sha256: C, text: '丙段' }] } });
  assert.equal(purgeRemovedRecord(e, [{ sha256: A, removedAt: 1499 }], 3000), null, '别的设备又移除了一次（时间变了）');
  assert.equal(purgeRemovedRecord(deletedRecord(e, 2500), [{ sha256: A, removedAt: 1500 }], 3000), null, '条目在最近删除里：跟着条目走');
  const r = purgeRemovedRecord(e, [{ sha256: A.toUpperCase(), removedAt: 1500 }, { sha256: B, removedAt: 1 }], 3000);
  assert.deepEqual([rems(r), r.updatedAt], [[B], 3000]);
  assert.deepEqual(r.gone, [{ sha256: A, mime: 'audio/mp4', purgedAt: 3000, from: 1500 }]);
  assert.equal(r.draft.text, '丙段');
  // 旧副本（移除以前的、或者就是那次移除）合进来也活不了；之后放回去的活着
  assert.deepEqual(shas(both(r, E({ updatedAt: 9000, audio: [item(A), item(C)] }))), [C]);
  assert.deepEqual(shas(both(r, E({ updatedAt: 9000, audio: [item(C), item(A, 1, { restoredAt: 1700 })] }))), [C, A]);
});

test('restoreRemovedRecord：放回最后，restoredAt 比移除新（时钟慢也一样）；不在「移除的录音」里 → null；orphanTombstone', () => {
  const e = E({ updatedAt: 5000, audio: [item(C)], removedAudio: [item(A, 1, { removedAt: 5000 })] });
  const r = restoreRemovedRecord(e, A, 100);
  assert.deepEqual([shas(r), r.removedAudio, r.audio[1].restoredAt, r.updatedAt], [[C, A], undefined, 5001, 5001]);
  assert.equal(restoreRemovedRecord(e, B, 100), null);
  assert.equal(restoreRemovedRecord(tomb(), A, 100), null);
  const o = orphanTombstone([{ sha256: A, mime: 'audio/webm' }, { sha256: A.toUpperCase() }, { sha256: 'bad' }], 7000);
  assert.ok(o.id.startsWith('o_') && o.purged);
  assert.deepEqual([o.purgedFrom, o.updatedAt, o.gone], [0, 7000, [{ sha256: A, mime: 'audio/webm', purgedAt: 7000, from: 0 }]]);
  assert.equal(orphanTombstone([], 1), null);
});

test('trackRemoved：拿掉的进 removedAudio（removedAt 不早于上一版）；next 没提到的移除、记号照样留着；被记号盖住的不记；放回来的盖 restoredAt', () => {
  const prev = E({ updatedAt: 5000, audio: [item(A), item(B, 1000, { restoredAt: 3000 }), item(C)], removedAudio: [item(D, 1, { removedAt: 4000 })],
    gone: [{ sha256: C, purgedAt: 9, from: 1000 }, { sha256: sha('e'), purgedAt: 9, from: 1 }] });
  const out = normalizeEntry(trackRemoved(prev, { ...prev, audio: [], removedAudio: undefined, gone: undefined }, 100), 'e1');
  assert.deepEqual(out.removedAudio.map(a => [a.sha256, a.removedAt, a.restoredAt]), [[D, 4000, undefined], [A, 5001, undefined], [B, 5001, undefined]]);
  assert.deepEqual(out.gone.map(g => g.sha256), [C, sha('e')]);
  // removals: false 只是不记新拿掉的
  assert.deepEqual(rems(normalizeEntry(trackRemoved(prev, { ...prev, audio: [] }, 100, { removals: false }))), [D]);
  // 拿回来：盖 restoredAt（removedAudio 里那份不管还在不在）
  const back = trackRemoved(prev, { ...prev, audio: [...prev.audio, item(D)] }, 9000);
  assert.deepEqual([back.audio.at(-1).restoredAt, back.removedAudio], [9000, []]);
  assert.equal(trackRemoved(prev, { ...prev, audio: [...prev.audio, item(D, 9500)] }, 9600).audio.at(-1).restoredAt, undefined, '本来就比移除新（重新选的文件）');
  assert.equal(trackRemoved(tomb(), E(), 1).purged, undefined);
  assert.equal(trackRemoved(null, prev, 1), prev);
});

test('freshAdds：刚加的录音碰上时钟快的设备留下的记号 → addedAt 挪到记号之后；旧的（草稿、旧版本、撤销拿回来的）、只是记号的不动', () => {
  const now = 1_000_000;
  const prev = E({ updatedAt: now - 5, audio: [item(B, 1)], gone: [{ sha256: A, purgedAt: now + 9e5, from: now + 5e5 }, { sha256: C, from: -1 }, { sha256: D, from: now + 5e5 }] });
  const next = { ...prev, audio: [item(B, 1), item(A, now), item(C, now), item(D, now - 7e5)] };
  const out = freshAdds(prev, next, now);
  assert.deepEqual(out.audio.map(a => a.addedAt), [1, now + 5e5 + 1, now, now - 7e5]);
  assert.deepEqual(shas(normalizeEntry(out, 'e1')), [B, A, C], 'D 是 10 分钟以前的：照样被盖住');
  assert.equal(freshAdds(E(), E({ audio: [item(A, now)] }), now).audio[0].addedAt, now, '没有记号：不动');
});

test('restoreAudio（恢复旧版本的录音）：现在的一段不少；那一版有的加回来，移除的放回来，永久删除的不加（计数），拿不到的计数', () => {
  const cur = E({ audio: [item(A)], removedAudio: [item(B, 1, { removedAt: 4000 })], gone: [{ sha256: C, purgedAt: 1, from: 3000 }] });
  const r = restoreAudio(cur, [item(B), item(C, 2000), item(D), item(sha('e')), item(A)], { gone: new Set([sha('e')]), have: s => s === D, now: 100 });
  assert.deepEqual(r.audio.map(a => [a.sha256, a.restoredAt]), [[A, undefined], [B, 4001], [D, undefined]]);
  assert.deepEqual([r.removedAudio, r.purged, r.missing, r.back], [[], 2, 0, 2]);
  assert.equal(restoreAudio(cur, [item(D)]).missing, 1);
});

test('restoredRecord / deletedRecord：墓碑不能恢复、也不再删；deletedAt = 盖好的时间（时钟慢也不早于上一版）', () => {
  assert.equal(restoredRecord(tomb()), null);
  assert.equal(deletedRecord(tomb()), null);
  const d = deletedRecord(E({ updatedAt: 5000 }), 10);
  assert.deepEqual([d.updatedAt, d.deletedAt], [5001, 5001]);
});

// ---------- 别的集合：设备报到 ----------
test('data.devices（设备报到）：每台设备取最后一次报到的那份，两边顺序无关；读进来、旧版 app 照样留着', () => {
  const dev = (id, at, name) => ({ id, updatedAt: at, seenAt: at, name, who: null, build: 'b' + at, features: ['purge1'] });
  const a = normalizeState({ data: { entries: {}, devices: { d_1: dev('d_1', 100, 'iPhone'), d_2: dev('d_2', 500, 'Mac') } } });
  const b = normalizeState({ data: { devices: { d_1: dev('d_1', 300, '小明的 iPhone'), d_3: dev('d_3', 50, 'iPad') } } });
  for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
    assert.deepEqual(Object.keys(m.data.devices).sort(), ['d_1', 'd_2', 'd_3']);
    assert.equal(m.data.devices.d_1.name, '小明的 iPhone');
    assert.equal(m.data.devices.d_2.seenAt, 500);
  }
  assert.equal(canon(mergeStates(a, b)), canon(mergeStates(b, a)));
  const old = JSON.parse(JSON.stringify(mergeStates(a, b)));
  assert.deepEqual(normalizeState(old).data.devices, mergeStates(a, b).data.devices);
});

// ---------- state.js ----------
function fresh(local = {}) {
  const st = fakeStorage();
  st.setItem(state.LKEY, JSON.stringify({ who: 'me', device: '测试 Mac', ...local }));
  state.load({ storage: st });
  const rec = [], forgot = [], seen = [];
  state.setJournal(items => { rec.push(...structuredClone(items)); }, ids => { forgot.push(...ids); });
  const off = state.subscribe((s, info) => seen.push(info));
  return { st, rec, forgot, seen, off, done: () => { off(); state.setJournal(null); } };
}
const cur = id => state.getState().data.entries[id];
const put = (e) => state.mutate(s => { s.data.entries[e.id] = e; });
const purge = (id) => state.mutate(s => { s.data.entries[id] = purgedRecord(s.data.entries[id], s.data.entries[id].updatedAt, Date.now()); }, { cause: 'purge' });

test('state：墓碑本机改不了——整条覆盖、改字段、删除、恢复、导入、恢复旧版本都原样留着', () => {
  const env = fresh();
  try {
    put(makeEntry({ id: 'e1', text: '“原话”', audio: [item(A)] }));
    state.mutate(s => { s.data.entries.e1 = deletedRecord(s.data.entries.e1); });
    purge('e1');
    const t = structuredClone(cur('e1'));
    assert.ok(t.purged); assert.equal(t.updatedBy.device, '测试 Mac'); assert.equal(t.deletedBy, undefined, '墓碑只签 updatedBy');
    const v = state.editVersion();
    state.mutate(s => { s.data.entries.e1 = normalizeEntry(stamp({ ...s.data.entries.e1, text: '写回去', deleted: false, purged: false }, s.data.entries.e1), 'e1'); });
    state.mutate(s => { s.data.entries.e1.text = '直接改'; s.data.entries.e1.audio = [item(A)]; });
    state.mutate(s => { delete s.data.entries.e1; });
    state.mutate(s => { const r = restoredRecord(s.data.entries.e1); if (r) s.data.entries.e1 = r; });
    state.mutate(s => { s.data.entries.e1 = makeEntry({ id: 'e1', text: '导入的', updatedAt: 1 }); });
    assert.deepEqual(cur('e1'), t);
    assert.equal(state.editVersion(), v, '什么都没改');
  } finally { env.done(); }
});

test('state：永久删除不记旧版本、连以前的一起忘掉（forget），info.purged；撤销记录清掉：还亮着的「撤销」点了什么都不做，也不会撤到更早那次', () => {
  const env = fresh();
  try {
    put(makeEntry({ id: 'e0', text: '“别的”' }));
    put(makeEntry({ id: 'e1', text: '“原话”' }));
    state.mutate(s => { s.data.entries.e0.fav = true; }, { undoLabel: '收藏' });
    state.mutate(s => { s.data.entries.e1 = deletedRecord(s.data.entries.e1); }, { undoLabel: '删除' });
    const n = env.rec.length;
    purge('e1');
    assert.equal(env.rec.length, n, '永久删除不记版本');
    assert.deepEqual(env.forgot, ['e1']);
    assert.deepEqual(env.seen.at(-1).purged, ['e1']);
    assert.equal(state.peekUndo(), '删除', '那条撤销记录还占着位置（空的）');
    assert.equal(state.undo(), null, '点了「撤销」：什么都没撤');
    assert.ok(cur('e1').purged);
    assert.equal(cur('e0').fav, true, '没有撤到更早的「收藏」');
    assert.equal(state.undo(), '收藏');
  } finally { env.done(); }
});

test('state：拿掉录音 → 移除的录音；撤销 → 放回来（盖 restoredAt）；撤销「接上一段录音」→ 那段进移除的录音；track: false、整条丢掉的不记', () => {
  const env = fresh();
  try {
    put(makeEntry({ id: 'e1', audio: [item(A, Date.now() - 10), item(B, Date.now() - 10)] }));
    const u0 = cur('e1').updatedAt;
    state.mutate(s => { s.data.entries.e1.audio = s.data.entries.e1.audio.filter(a => a.sha256 !== A); }, { undoLabel: '移除' });
    assert.deepEqual([shas(cur('e1')), rems(cur('e1'))], [[B], [A]]);
    assert.ok(cur('e1').removedAudio[0].removedAt > u0);
    assert.equal(state.undo(), '移除');
    assert.deepEqual([shas(cur('e1')), cur('e1').removedAudio], [[A, B], undefined], '放回原来的位置');
    assert.ok(cur('e1').audio[0].restoredAt > u0, '放回来的比那次移除新：别的设备上那次移除盖不过它');
    // 撤销接上一段
    state.mutate(s => { s.data.entries.e1.audio = [...s.data.entries.e1.audio, item(C, Date.now())]; }, { undoLabel: '接上' });
    state.undo();
    assert.deepEqual([shas(cur('e1')), rems(cur('e1'))], [[A, B], [C]]);
    // track: false、discarded
    state.mutate(s => { s.data.entries.e1.audio = [s.data.entries.e1.audio[1]]; }, { track: false });
    assert.deepEqual([shas(cur('e1')), rems(cur('e1'))], [[B], [C]]);
    put(makeEntry({ id: 'e2', audio: [item(D)] }));
    state.mutate(s => { s.data.entries.e2 = { ...deletedRecord(s.data.entries.e2), audio: [], discarded: true }; });
    assert.equal(cur('e2').removedAudio, undefined);
    // 用 put / update 的样子（整条摊开、再整理）放回去：removedAudio 里那份还在也算放回
    state.mutate(s => { const e = s.data.entries.e1; s.data.entries.e1 = normalizeEntry(stamp({ ...e, audio: [...e.audio, item(C)] }, e), 'e1'); });
    assert.deepEqual([shas(cur('e1')), cur('e1').removedAudio], [[B, C], undefined]);
    assert.ok(cur('e1').audio[1].restoredAt > 0);
    // 整条换成一份没有 removedAudio / gone 的旧样子：移除的录音、记号照样留着
    state.mutate(s => { s.data.entries.e1 = { ...s.data.entries.e1, removedAudio: [item(A, 1, { removedAt: 5 })], gone: [{ sha256: D, from: -1 }] }; });
    state.mutate(s => { s.data.entries.e1 = makeEntry({ id: 'e1', text: '整条换掉', audio: [item(B)] }); });
    assert.deepEqual([shas(cur('e1')), rems(cur('e1')), cur('e1').gone.map(g => g.sha256)], [[B], [A, C], [D]], '按 removedAt 排：A（5）在前');
  } finally { env.done(); }
});

test('state：别的设备永久删除的条目同步过来——不记它的旧版本、忘掉以前的、info.purged；作废了（又合并回活的）→ info.unpurged；导入备份同样', () => {
  const env = fresh();
  try {
    put(makeEntry({ id: 'e1', text: '“原话”', audio: [item(A)] }));
    state.mutate(s => { s.data.entries.e1 = deletedRecord(s.data.entries.e1); }, { undoLabel: '删除' });
    const d = cur('e1');
    const remote = structuredClone(state.getState());
    remote.data.entries.e1 = purgedRecord(d, d.updatedAt, d.updatedAt + 10);
    const n = env.rec.length;
    state.applyRemote(mergeStates(state.getState(), remote), { device: 'iPad' });
    assert.ok(cur('e1').purged);
    assert.equal(env.rec.length, n, '换成墓碑的不记旧版本');
    assert.deepEqual(env.forgot, ['e1']);
    assert.deepEqual([env.seen.at(-1).source, env.seen.at(-1).purged, env.seen.at(-1).unpurged], ['remote', ['e1'], []]);
    assert.equal(state.undo(), null, '那次删除撤销不了了');
    // 另一台设备在这之前恢复、改过（比永久删除的那一版新）→ 作废
    const back = structuredClone(state.getState());
    back.data.entries.e1 = { ...restoredRecord(d, d.updatedAt + 5), text: '“恢复以后改的”' };
    state.applyRemote(mergeStates(state.getState(), back), { device: 'iPhone' });
    assert.ok(!cur('e1').purged && cur('e1').text === '“恢复以后改的”');
    assert.deepEqual(env.seen.at(-1).unpurged, ['e1']);
    // 导入备份带着墓碑
    put(makeEntry({ id: 'e2', text: '“备份里删了的”' }));
    state.mutate(s => { s.data.entries.e2 = deletedRecord(s.data.entries.e2); });
    const backup = blankState(); backup.data.entries.e2 = purgedRecord(cur('e2'), cur('e2').updatedAt, cur('e2').updatedAt + 1);
    state.mergeIn(backup);
    assert.ok(cur('e2').purged);
    assert.deepEqual([env.seen.at(-1).source, env.seen.at(-1).purged], ['merge', ['e2']]);
    assert.ok(env.forgot.includes('e2'));
  } finally { env.done(); }
});

test('state：另一个标签页永久删除了（存在磁盘上）——这一页存别的东西时合并进来：info.purged、撤销记录清掉、忘掉旧版本；storage 事件 reload 也一样', async () => {
  const a = await import('../src/core/state.js?tab=purge-a');
  const b = await import('../src/core/state.js?tab=purge-b');
  const st = fakeStorage();
  a.load({ storage: st, locks: null }); b.load({ storage: st, locks: null });
  const forgot = [], seen = [];
  b.setJournal(() => {}, ids => forgot.push(...ids)); b.subscribe((s, info) => seen.push(info));
  b.mutate(s => { s.data.entries.e1 = makeEntry({ id: 'e1', text: '“原话”' }); s.data.entries.e2 = makeEntry({ id: 'e2' }); });
  b.mutate(s => { s.data.entries.e1 = deletedRecord(s.data.entries.e1); }, { undoLabel: '删除' });
  a.reload();
  a.mutate(s => { s.data.entries.e1 = purgedRecord(s.data.entries.e1, s.data.entries.e1.updatedAt, Date.now()); }, { cause: 'purge' });
  b.mutate(s => { s.data.entries.e2.fav = true; });           // 没收到 storage 事件，存的时候合并
  assert.ok(b.getState().data.entries.e1.purged);
  assert.deepEqual(seen.at(-1).purged, ['e1']);
  assert.deepEqual(forgot, ['e1']);
  assert.equal(b.undo(), null);
  // reload：另一页又永久删除了一条
  b.mutate(s => { s.data.entries.e2 = deletedRecord(s.data.entries.e2); });
  a.reload();
  a.mutate(s => { s.data.entries.e2 = purgedRecord(s.data.entries.e2, s.data.entries.e2.updatedAt, Date.now()); }, { cause: 'purge' });
  b.reload();
  assert.deepEqual([seen.at(-1).source, seen.at(-1).purged], ['storage', ['e2']]);
  assert.ok(forgot.includes('e2'));
});

test('state：刚加的录音碰上时钟快的设备的记号（mutate 里自动挪 addedAt），照样留下；从草稿拿回来的旧录音被盖住', () => {
  const env = fresh();
  try {
    const future = Date.now() + 60_000;
    put(normalizeEntry({ ...makeEntry({ id: 'e1' }), gone: [{ sha256: A, purgedAt: future, from: future }] }, 'e1'));
    state.mutate(s => { s.data.entries.e1.audio = [item(A, Date.now()), item(B, 5)]; });
    assert.deepEqual(shas(cur('e1')), [A, B]);
    assert.equal(cur('e1').audio[0].addedAt, future + 1);
    state.mutate(s => { s.data.entries.e1.gone = [...s.data.entries.e1.gone, { sha256: C, from: 1000 }]; });
    state.mutate(s => { s.data.entries.e1.audio = [...s.data.entries.e1.audio, item(C, 10)]; });
    assert.deepEqual(shas(cur('e1')), [A, B], '旧录音（addedAt 10）被盖住');
  } finally { env.done(); }
});

test('state.scrubText：磁盘上的快照、待合并的日志里，墓碑盖得过的旧原话换成墓碑（有 Web Locks、没有都行）', async () => {
  for (const locks of [null, (() => { let chain = Promise.resolve(); return { request(name, fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; } }; })()]) {
    const st = fakeStorage();
    const s0 = blankState(); s0.data.entries.e1 = makeEntry({ id: 'e1', text: '“绝密原话”', audio: [item(A)] }, 1000);
    st.setItem(STATE_KEY, JSON.stringify(s0));
    state.load({ storage: st, locks });
    state.mutate(s => { s.data.entries.e1 = deletedRecord(s.data.entries.e1); });
    state.mutate(s => { s.data.entries.e1 = purgedRecord(s.data.entries.e1, s.data.entries.e1.updatedAt, Date.now()); }, { cause: 'purge' });
    await state.idle();
    const r = await state.scrubText(['e1', 'nope']);
    assert.ok(locks ? r.changed >= 0 : r.changed >= 2, '没有 Web Locks 时没人整理：快照和日志都要换（有锁时整理已经换掉了）');
    for (const [k, v] of st.m) if (k === STATE_KEY || k.startsWith(PENDING_PREFIX)) assert.ok(!v.includes('绝密原话'), k + ' 里没有旧原话了');
    assert.ok(readStoredState(st).data.entries.e1.purged);
    assert.deepEqual(r.left, []);
    assert.deepEqual(await state.scrubText(['e2']), { changed: 0, left: [] }, '不是墓碑：不碰');
  }
});
