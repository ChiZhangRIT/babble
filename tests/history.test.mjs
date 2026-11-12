import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJournal, memoryBackend, changedFields, lineDiff, compactDiff, buildVersions, contentKey, createCloudHistory,
  versionBy, deletionBy, platformDevice, HISTORY_DB, HISTORY_CAP,
} from '../src/core/history.js';
import { blankState, makeEntry, stamp, deletedRecord, restoredRecord, normalizeState, mergeStates, canon } from '../src/core/store.js';
import * as state from '../src/core/state.js';
import { createSync, SYNC_FILE, toB64, SyncError } from '../src/core/sync.js';
import { fmtAgo, madeAt } from '../src/views/history.js';
import { byLabel } from '../src/views/device.js';
import { setLang } from '../src/i18n.js';

// 修改记录：版本记录本（去重、上限、从不抛错）、state 在各种修改时交出旧版本、签名（updatedBy / deletedBy）、
// 两版比较、版本列表合并去重、云端历史（假的 GitHub）。全是编的例子（仓库是公开的，不放真的梦话）
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const SP = { nn: { name: 'NN', emoji: NN, aliases: [] }, me: { name: '', emoji: ME, aliases: [] } };
const fakeStorage = () => {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => m.delete(k) };
};
const quiet = () => {};

// ---------- 两版比较 ----------
test('按行比较：前后相同的行不动，中间按最长公共子序列；compactDiff 收起没变的行', () => {
  const a = [`${NN}“今天吃什么”`, `${ME}“吃什么都行”`, '过了一会儿..', `${NN}“馄饨”`].join('\n');
  const b = [`${NN}“今天吃什么”`, `${ME}“吃什么都行？”`, '过了一会儿..', `${NN}“馄饨”`, `${ME} 🤯`].join('\n');
  const ops = lineDiff(a, b);
  assert.deepEqual(ops.map(o => o.t), ['same', 'del', 'add', 'same', 'same', 'add']);
  assert.equal(ops[1].line, `${ME}“吃什么都行”`);
  assert.equal(ops[2].line, `${ME}“吃什么都行？”`);
  assert.deepEqual(lineDiff('', `${NN}“新的”`), [{ t: 'add', line: `${NN}“新的”` }]);
  assert.deepEqual(lineDiff(`${NN}“旧的”`, ''), [{ t: 'del', line: `${NN}“旧的”` }]);
  assert.deepEqual(lineDiff('一\r\n二', '一\n二').map(o => o.t), ['same', 'same'], '换行符不同不算改动');
  // 很长时不做 O(n²)：中间整段删掉再加上
  const big = lineDiff(Array.from({ length: 30 }, (_, i) => 'a' + i).join('\n'), Array.from({ length: 30 }, (_, i) => 'b' + i).join('\n'), { maxCells: 100 });
  assert.equal(big.filter(o => o.t === 'del').length, 30); assert.equal(big.filter(o => o.t === 'add').length, 30);
  const long = Array.from({ length: 12 }, (_, i) => '行' + i);
  const changed = long.slice(); changed[6] = '改了';
  const c = compactDiff(lineDiff(long.join('\n'), changed.join('\n')), 1);
  assert.deepEqual(c.map(o => o.t), ['skip', 'same', 'del', 'add', 'same', 'skip']);
  assert.equal(c[0].n, 5); assert.equal(c[5].n, 4);
  assert.deepEqual(compactDiff(lineDiff('一', '一')), [{ t: 'skip', n: 1 }]);
});

test('changedFields：原话 / 背景 / 录音 / 收藏 / 状态 / 日期 / 草稿 / 删除 / 恢复（存着的标题不比：界面上没有标题）', () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64);
  const base = makeEntry({ id: 'x', date: '2026-01-02', text: `${NN}“今天吃什么”`, audio: [{ sha256: A, mime: 'audio/mp4' }] }, 1000);
  assert.deepEqual(changedFields(base, { ...base }), []);
  assert.deepEqual(changedFields(base, { ...base, title: '旧标题', text: base.text + '\n' + ME + ' 🤯' }), ['text']);
  assert.deepEqual(changedFields(base, { ...base, title: '旧标题' }), []);
  assert.deepEqual(changedFields(base, { ...base, audio: [...base.audio, { sha256: B }], fav: true, status: 'inbox' }), ['audio', 'fav', 'status']);
  assert.deepEqual(changedFields(base, { ...base, time: '02:58', note: '那天很累', draft: { text: '草稿', source: 'paste' } }), ['note', 'date', 'draft']);
  const gone = deletedRecord(base, 2000);
  assert.deepEqual(changedFields(base, gone), ['deleted']);
  assert.deepEqual(changedFields(gone, restoredRecord(gone, 3000)), ['restored']);
  assert.deepEqual(changedFields(null, base), []);
});

// ---------- 版本记录本 ----------
test('记录本：新的在前；和上一份一样就不存；隔开的相同版本照存；每条最多 cap 份（删最旧的）', async () => {
  const be = memoryBackend();
  const j = createJournal(be, { cap: 3, log: quiet });
  const v = (text, at) => ({ id: 'e1', date: '2026-01-02', text, updatedAt: at });
  j.record([{ entryId: 'e1', version: v('一', 1), cause: 'edit', at: 10 }]);
  j.record({ entryId: 'e1', version: v('一', 1), cause: 'sync', at: 11 });                // 一模一样：跳过
  j.record([{ entryId: 'e1', version: v('二', 2), cause: 'edit', at: 12 }, { entryId: 'e2', version: { id: 'e2', text: '别的' }, at: 12 }]);
  j.record([{ entryId: 'e1', version: v('一', 1), cause: 'undo', at: 13 }]);            // 和上一份（二）不一样：存
  await j.idle();
  assert.deepEqual((await j.list('e1')).map(r => [r.version.text, r.cause]), [['一', 'undo'], ['二', 'edit'], ['一', 'edit']]);
  assert.equal((await j.list('e2')).length, 1);
  j.record([{ entryId: 'e1', version: v('三', 3), at: 14 }]);
  await j.idle();
  assert.deepEqual((await j.list('e1')).map(r => r.version.text), ['三', '一', '二'], '超过上限删掉最旧的一份');
  assert.equal(HISTORY_CAP, 100);
  assert.equal(HISTORY_DB, 'babble-history');
});

test('记录本：当场复制；坏的输入跳过；后端出错只打日志，后面的照常写', async () => {
  const be = memoryBackend();
  const logs = [];
  const j = createJournal(be, { log: e => logs.push(String(e && e.message)) });
  const ver = { id: 'e1', text: '“今天吃什么”', updatedAt: 1 };
  j.record([{ entryId: 'e1', version: ver, replacedBy: { who: 'me', device: 'Mac' } }]);
  ver.text = '后来被改了';
  j.record([null, { entryId: '', version: ver }, { entryId: 'e3', version: 'not-an-object' }]);
  const circ = { id: 'e4' }; circ.self = circ;
  j.record([{ entryId: 'e4', version: circ }]);               // JSON 复制不了：打日志，不抛
  await j.idle();
  const realAppend = be.append;
  be.append = async () => { throw new Error('disk full'); };
  j.record([{ entryId: 'e5', version: { id: 'e5' } }]);
  await j.idle();
  be.append = realAppend;
  j.record([{ entryId: 'e6', version: { id: 'e6' } }]);
  await j.idle();
  const r = await j.list('e1');
  assert.equal(r.length, 1); assert.equal(r[0].version.text, '“今天吃什么”'); assert.deepEqual(r[0].replacedBy, { who: 'me', device: 'Mac' });
  assert.equal(r[0].cause, 'edit');
  assert.equal((await j.list('e3')).length, 0);
  assert.equal((await j.list('e6')).length, 1, '出过错以后照常写');
  assert.ok(logs.includes('disk full'));
  assert.equal(logs.length, 2);
});

// ---------- state：签名、交出旧版本 ----------
function setup({ who = null, device = null, journal = 'capture' } = {}) {
  const st = fakeStorage();
  st.setItem(state.LKEY, JSON.stringify({ who, device }));
  state.load({ storage: st });
  state.setDefaultDevice('Mac');
  const got = [];
  state.setJournal(journal === 'capture' ? (items) => { got.push(...items.map(i => structuredClone(i))); } : journal);
  return { st, got };
}

test('签名：本机改过的条目带 updatedBy { who, device, at }；没设设备名用平台名；删除签 deletedBy；恢复去掉 deletedBy', () => {
  const { st } = setup({ who: 'nn', device: '测试 iPad' });
  const e = makeEntry({ text: '“今天吃什么”' });
  state.mutate(s => { s.data.entries[e.id] = e; });
  let cur = state.getState().data.entries[e.id];
  assert.deepEqual(cur.updatedBy, { who: 'nn', device: '测试 iPad', at: cur.updatedAt });
  assert.equal(versionBy(cur), cur.updatedBy);
  assert.deepEqual(JSON.parse(st.m.get(state.KEY)).data.entries[e.id].updatedBy, cur.updatedBy, '存进本机');
  state.setLocal({ who: null, device: '  ' });
  state.mutate(s => { s.data.entries[e.id].fav = true; });
  cur = state.getState().data.entries[e.id];
  assert.deepEqual(cur.updatedBy, { who: null, device: 'Mac', at: cur.updatedAt });
  state.setLocal({ who: 'me', device: '测试 iPhone' });
  state.mutate(s => { s.data.entries[e.id] = deletedRecord(s.data.entries[e.id]); }, { undoLabel: '删除' });
  cur = state.getState().data.entries[e.id];
  assert.deepEqual(cur.deletedBy, { who: 'me', device: '测试 iPhone', at: cur.deletedAt });
  assert.equal(deletionBy(cur), cur.deletedBy);
  assert.equal(deletionBy({ ...cur, deletedAt: cur.deletedAt + 9 }), null, '老版本 App 又删了一次：签名对不上就不显示');
  assert.equal(cur.updatedBy.at, cur.updatedAt);
  state.undo();
  cur = state.getState().data.entries[e.id];
  assert.equal(cur.deleted, undefined); assert.equal(cur.deletedBy, undefined, '撤销删除：删除签名也去掉');
  assert.equal(cur.updatedBy.at, cur.updatedAt, '撤销也签名');
  state.mutate(s => { delete s.data.entries[e.id]; });             // 硬删除 → 软删除，也签名
  assert.equal(state.getState().data.entries[e.id].deletedBy.device, '测试 iPhone');
  state.mutate(s => { s.data.entries[e.id] = restoredRecord(s.data.entries[e.id]); });
  assert.equal(state.getState().data.entries[e.id].deletedBy, undefined);
  assert.equal(state.deviceName(), '测试 iPhone');
  assert.deepEqual(state.author(), { who: 'me', device: '测试 iPhone' });
  // 老版本 App 改过（updatedAt 变了、签名还是上一个人的）→ versionBy 不认
  assert.equal(versionBy({ ...cur, updatedAt: cur.updatedAt + 5 }), null);
  assert.equal(versionBy({ updatedAt: 5 }), null);
  state.setJournal(null);
});

test('state 交出旧版本：修改 / 删除 / 恢复 / 撤销 / 恢复旧版本 / 同步合并 / 导入备份；新建不记', () => {
  const { got } = setup({ who: 'me', device: 'Mac' });
  const e = makeEntry({ text: '“今天吃什么”' });
  state.mutate(s => { s.data.entries[e.id] = e; });
  assert.equal(got.length, 0, '新建没有旧版本');
  const v1 = structuredClone(state.getState().data.entries[e.id]);
  state.mutate(s => { s.data.entries[e.id].text = '“明天吃什么”'; }, { undoLabel: '改' });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].version, v1);
  assert.equal(got[0].cause, 'edit'); assert.equal(got[0].entryId, e.id); assert.deepEqual(got[0].replacedBy, { who: 'me', device: 'Mac' }); assert.ok(got[0].at > 0);
  state.undo();
  assert.equal(got[1].cause, 'undo'); assert.equal(got[1].version.text, '“明天吃什么”');
  state.mutate(s => { s.data.entries[e.id] = deletedRecord(s.data.entries[e.id]); });
  assert.equal(got[2].cause, 'delete'); assert.equal(got[2].version.deleted, undefined);
  state.mutate(s => { s.data.entries[e.id] = restoredRecord(s.data.entries[e.id]); });
  assert.equal(got[3].cause, 'restore'); assert.equal(got[3].version.deleted, true);
  state.mutate(s => { s.data.entries[e.id].title = '测试标题'; }, { cause: 'revert' });
  assert.equal(got[4].cause, 'revert');
  // 同步合并：别的设备改了这条 → 旧的这份记下，replacedBy 是赢的那份的签名
  const cur = state.getState().data.entries[e.id];
  const remote = structuredClone(state.getState());
  remote.data.entries[e.id] = { ...cur, text: '“后天吃什么”', updatedAt: cur.updatedAt + 10, updatedBy: { who: 'nn', device: 'iPad', at: cur.updatedAt + 10 } };
  const other = makeEntry({ id: 'r_new', text: '“新来的”' });
  remote.data.entries.r_new = other;
  state.applyRemote(mergeStates(state.getState(), remote), { device: 'iPad' });
  assert.equal(got.length, 6, '新来的条目没有旧版本，只记被换掉的这一条');
  assert.equal(got[5].cause, 'sync'); assert.equal(got[5].version.text, '“今天吃什么”'); assert.deepEqual(got[5].replacedBy, { who: 'nn', device: 'iPad' });
  // 没签名的远端版本：replacedBy 用 babble.json 里的设备名
  const cur2 = state.getState().data.entries[e.id];
  const remote2 = structuredClone(state.getState());
  const { updatedBy, ...plainRec } = cur2;
  remote2.data.entries[e.id] = { ...plainRec, note: '旧版本 App 改的', updatedAt: cur2.updatedAt + 10 };
  state.applyRemote(remote2, { device: '旧 iPhone' });
  assert.deepEqual(got[6].replacedBy, { who: null, device: '旧 iPhone' });
  // 导入备份：较新的才换，换掉的记下
  const backup = blankState();
  const now = state.getState().data.entries[e.id];
  backup.data.entries[e.id] = { ...now, text: '“备份里更新的”', updatedAt: now.updatedAt + 50 };
  state.mergeIn(backup);
  assert.equal(got[7].cause, 'import'); assert.equal(got[7].version.text, '“后天吃什么”');
  assert.equal(got.length, 8);
  // 没变化的合并：什么也不记
  state.applyRemote(structuredClone(state.getState()), { device: 'iPad' });
  assert.equal(got.length, 8);
  state.setJournal(null);
});

test('记录本坏了也不影响保存：同步抛错、异步失败，数据照样改好、存好、通知', async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    for (const bad of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('later')), () => { throw new Error('x'); }]) {
      const { st } = setup({ journal: bad });
      const e = makeEntry({ text: '“今天吃什么”' });
      let notified = 0;
      const off = state.subscribe(() => notified++);
      state.mutate(s => { s.data.entries[e.id] = e; });
      state.mutate(s => { s.data.entries[e.id].fav = true; }, { undoLabel: '收藏' });
      assert.equal(JSON.parse(st.m.get(state.KEY)).data.entries[e.id].fav, true);
      assert.equal(state.undo(), '收藏');
      assert.equal(state.getState().data.entries[e.id].fav, false);
      state.applyRemote({ ...structuredClone(state.getState()), data: { entries: { [e.id]: { ...state.getState().data.entries[e.id], text: '“改了”', updatedAt: Date.now() + 1e6 } } } });
      assert.equal(state.getState().data.entries[e.id].text, '“改了”');
      assert.equal(state.saveOk(), true);
      off();
      assert.equal(notified, 4);
    }
    await new Promise(r => setTimeout(r, 0));
    assert.ok(warned.some(w => w.includes('boom')) && warned.some(w => w.includes('later')));
  } finally {
    console.warn = warn;
    state.setJournal(null);
  }
});

test('记录本接到 state：真的写进去，撤销 / 删除都在；连续两次一样的不重复', async () => {
  const be = memoryBackend();
  const j = createJournal(be, { log: quiet });
  setup({ who: 'nn', device: 'iPad', journal: j.record });
  const e = makeEntry({ id: 'e_j', text: '“一”' });
  state.mutate(s => { s.data.entries[e.id] = e; });
  for (const text of ['“二”', '“三”']) state.mutate(s => { s.data.entries[e.id].text = text; }, { undoLabel: '改' });
  state.undo();
  state.mutate(s => { delete s.data.entries[e.id]; });
  await j.idle();
  const list = await j.list('e_j');
  assert.deepEqual(list.map(r => [r.version.text, r.cause]), [['“二”', 'delete'], ['“三”', 'undo'], ['“二”', 'edit'], ['“一”', 'edit']]);
  state.setJournal(null);
});

test('合并保留赢家的签名（updatedBy / deletedBy 跟着整条走）；normalizeEntry 整理签名、可重复整理', () => {
  const a = blankState(), b = blankState();
  a.data.entries.e1 = { id: 'e1', date: '2026-01-02', text: '甲', updatedAt: 100, updatedBy: { who: 'me', device: 'Mac', at: 100 } };
  b.data.entries.e1 = { id: 'e1', date: '2026-01-02', text: '乙', updatedAt: 200, updatedBy: { who: 'nn', device: 'iPad', at: 200 } };
  for (const m of [mergeStates(a, b), mergeStates(b, a)]) assert.deepEqual(m.data.entries.e1.updatedBy, { who: 'nn', device: 'iPad', at: 200 });
  b.data.entries.e1 = { ...b.data.entries.e1, deleted: true, deletedAt: 200, deletedBy: { who: 'nn', device: 'iPad', at: 200 } };
  assert.deepEqual(mergeStates(a, b).data.entries.e1.deletedBy, { who: 'nn', device: 'iPad', at: 200 });
  const n = normalizeState({ data: { entries: {
    x: { date: '2026-01-02', updatedBy: { who: 'someone', device: 7, extra: 1 } },
    y: { date: '2026-01-02', updatedBy: 'Mac', deletedBy: { who: 'me', device: 'Mac' } },
  } } });
  assert.deepEqual(n.data.entries.x.updatedBy, { who: null, device: '7', extra: 1 });
  assert.equal(n.data.entries.y.updatedBy, undefined, '不是对象的签名丢掉');
  assert.equal(n.data.entries.y.deletedBy, undefined, '没删除的条目不留删除签名');
  assert.equal(canon(normalizeState(n)), canon(n));
});

// ---------- 版本列表 ----------
test('版本列表：当前在最前，同样内容只留一份（不看修改时间和签名），云端记最早出现的提交', () => {
  const cur = makeEntry({ id: 'e1', date: '2026-01-02', text: '“三”' }, 3000);
  const v2 = { ...cur, text: '“二”', updatedAt: 2000, updatedBy: { who: 'me', device: 'Mac', at: 2000 } };
  const v1 = { ...cur, text: '“一”', updatedAt: 1000 };
  const sameAsCur = { ...cur, updatedAt: 2500 };             // 内容和现在一样（比如撤销回来的）
  const list = buildVersions(cur, [{ version: v2, at: 3000 }, { version: sameAsCur, at: 2600 }, { version: v1, at: 2000 }],
    [{ version: { ...v2 }, commit: { sha: 'c2', at: '2026-01-03T00:00:00Z', device: 'Mac' } },
      { version: { ...v1, updatedBy: undefined }, commit: { sha: 'c1b', at: '2026-01-02T00:00:00Z', device: 'iPad' } },
      { version: { ...v1 }, commit: { sha: 'c1a', at: '2026-01-01T00:00:00Z', device: 'iPad' } },
      { version: { ...cur, text: '“零”', updatedAt: 500 }, commit: { sha: 'c0', at: '2025-12-31T00:00:00Z', device: 'iPad' } }]);
  assert.deepEqual(list.map(x => x.v.text), ['“三”', '“二”', '“一”', '“零”']);
  assert.equal(list[0].current, true);
  assert.equal(list[1].local.at, 3000); assert.equal(list[1].cloud.sha, 'c2');
  assert.equal(list[2].cloud.sha, 'c1a', '同样内容出现在好几个提交里：记最早的');
  assert.equal(list[3].local, null);
  assert.equal(contentKey(v1), contentKey({ ...v1, updatedAt: 9, updatedBy: { who: 'nn', device: 'x' } }));
  assert.deepEqual(buildVersions(null, [null, { version: 'x' }], [{}]), []);
});

// ---------- 云端历史 ----------
// 假的 GitHub：babble.json 的提交记录（新的在前）和每次提交时的内容
function fakeRepo(versions) {
  const gh = { log: [], commits: versions.map((v, i) => ({ sha: 'c' + i, date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), file: v })).reverse(), fail: null };
  gh.fetch = async (url, opt = {}) => {
    const path = url.replace('https://api.github.com', '');
    gh.log.push(path);
    const res = (status, body, raw) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null },
      json: async () => body, text: async () => (raw != null ? raw : JSON.stringify(body)) });
    if (gh.fail && path.includes(gh.fail.path)) { const f = gh.fail; if (!--f.times) gh.fail = null; return res(f.status, { message: 'x' }); }
    let m = path.match(/^\/repos\/me\/data\/commits\?path=babble\.json&per_page=(\d+)&page=(\d+)$/);
    if (m) {
      const per = +m[1], page = +m[2];
      return res(200, gh.commits.slice((page - 1) * per, page * per).map(c => ({ sha: c.sha, commit: { message: '更新 babble.json', committer: { date: c.date } } })));
    }
    m = path.match(/^\/repos\/me\/data\/contents\/babble\.json\?ref=(\w+)$/);
    if (m) {
      assert.equal(opt.headers.Accept, 'application/vnd.github.raw+json', '直接要原文（超过 1MB 也行）');
      const c = gh.commits.find(x => x.sha === m[1]);
      if (!c || c.file === null) return res(404, { message: 'Not Found' });
      return res(200, null, typeof c.file === 'string' ? c.file : JSON.stringify(c.file));
    }
    return res(404, {});
  };
  return gh;
}
const fileWith = (device, entries) => ({ app: 'babble', v: 1, device, savedAt: '2026-01-01T00:00:00Z', state: { ...blankState(), data: { entries } } });

test('云端历史：按页取提交、一个个取当时的 babble.json，抽出这一条；到这一条还不存在的版本就停；看过的提交不再下载', async () => {
  const e = (text, at) => makeEntry({ id: 'e1', date: '2026-01-02', text }, at);
  const other = makeEntry({ id: 'o', text: '“别的”' }, 1);
  const gh = fakeRepo([
    fileWith('iPad', { o: other }),                                  // c0：还没有 e1
    fileWith('iPad', { o: other, e1: e('“一”', 1000) }),            // c1
    fileWith('Mac', { o: other, e1: e('“一”', 1000) }),             // c2：e1 没变（改的是别的）
    'not json',                                                       // c3：坏文件，跳过
    fileWith('Mac', { o: other, e1: e('“二”', 2000) }),             // c4
    null,                                                             // c5：那次提交里文件不在（404），跳过
    fileWith('iPhone', { o: other, e1: e('“三”', 3000) }),          // c6
  ]);
  const cfg = { repo: 'me/data', token: 't' };
  const sync = createSync({ getState: () => blankState(), applyRemote() {}, getConfig: () => cfg, saveConfig() {}, editVersion: () => 0, device: 'Mac', fetch: gh.fetch });
  const commits = await sync.commits({ page: 1, perPage: 3 });
  assert.deepEqual(commits.map(c => c.sha), ['c6', 'c5', 'c4']);
  assert.equal(commits[0].at, '2026-01-07T00:00:00.000Z');
  assert.equal((await sync.fileAt('c6')).device, 'iPhone');
  assert.equal(await sync.fileAt('c5'), null);
  assert.equal(await sync.fileAt('c3'), null, '看不懂的文件 → null');
  gh.log.length = 0;

  const cloud = createCloudHistory({ commits: (o) => sync.commits(o), fileAt: (sha) => sync.fileAt(sha) }, { perPage: 3 });
  const s = cloud.session('e1');
  const seen = [];
  const r1 = await s.run({ batch: 4, onProgress: p => seen.push(p.checked) });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.deepEqual(r1.found.map(f => [f.version.text, f.commit.sha, f.commit.device]), [['“三”', 'c6', 'iPhone'], ['“二”', 'c4', 'Mac']]);
  assert.equal(r1.more, true); assert.equal(r1.checked, 4);
  const r2 = await s.run({ batch: 10 });
  assert.deepEqual(r2.found.map(f => f.commit.sha), ['c2', 'c1']);
  assert.equal(r2.more, false, 'c0 里还没有这一条：到头了');
  assert.equal((await s.run()).found.length, 0);
  assert.equal(gh.log.filter(l => l.includes('/commits?')).length, 3, '按页取，每页一次');
  // 合并进版本列表：同样内容（c1、c2）只留一份，记最早的 c1；和本机记录重复的也去掉
  const cur = e('“三”', 3000);
  const list = buildVersions(cur, [{ version: e('“二”', 2000), at: 2500 }], [...r1.found, ...r2.found]);
  assert.deepEqual(list.map(x => [x.v.text, x.cloud && x.cloud.sha, !!x.local]), [['“三”', 'c6', false], ['“二”', 'c4', true], ['“一”', 'c1', false]]);

  // 同一次打开 App 里再看同一条：不再下载文件（只重新问提交列表）
  gh.log.length = 0;
  const again = await cloud.session('e1').run({ batch: 30 });
  assert.equal(again.found.length, 4);
  assert.equal(gh.log.filter(l => l.includes('/contents/')).length, 0);
  // 换一条：同一个提交要为它再取一次文件
  gh.log.length = 0;
  const o = await cloud.session('o').run({ batch: 3 });             // c6、c5（文件不在，跳过）、c4
  assert.equal(o.found.length, 2);
  assert.equal(gh.log.filter(l => l.includes('/contents/')).length, 2);
});

test('云端历史：可以停；出错照样抛（令牌过期 → auth），下次从出错的那个提交接着找；没开同步 → 没有', async () => {
  const gh = fakeRepo([1, 2, 3, 4, 5].map(i => fileWith('Mac', { e1: makeEntry({ id: 'e1', text: '“' + i + '”' }, i * 1000) })));
  let cfg = { repo: 'me/data', token: 't' };
  const sync = createSync({ getState: () => blankState(), applyRemote() {}, getConfig: () => cfg, saveConfig() {}, editVersion: () => 0, device: 'Mac', fetch: gh.fetch });
  const cloud = createCloudHistory(sync, { perPage: 30 });
  const s = cloud.session('e1');
  const r = await s.run({ onProgress: (p) => { if (p.checked === 2) s.stop(); } });
  assert.equal(r.found.length, 2); assert.equal(r.stopped, true); assert.equal(r.more, true);
  gh.fail = { path: '/contents/', status: 401, times: 1 };
  await assert.rejects(s.run(), (err) => err instanceof SyncError && err.code === 'auth');
  const r2 = await s.run();
  assert.deepEqual(r2.found.map(f => f.version.text), ['“3”', '“2”', '“1”']);
  assert.equal(r2.more, false);
  cfg = null;
  assert.deepEqual(await sync.commits(), []);
  assert.equal(await sync.fileAt('c1'), null);
});

test('设备名、签名显示、多久以前', () => {
  assert.equal(platformDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', platform: 'iPhone' }), 'iPhone');
  assert.equal(platformDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), 'iPad');
  assert.equal(platformDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), 'Mac');
  assert.equal(platformDevice({ userAgent: 'Mozilla/5.0 (X11; Linux)', platform: 'Linux' }), 'Browser');
  assert.equal(platformDevice({}), 'Browser');
  assert.equal(byLabel({ who: 'nn', device: 'iPad' }, SP), `${NN} NN · iPad`);
  assert.equal(byLabel({ who: 'me', device: 'iPhone' }, SP), `${ME} iPhone`, '没写名字只显示表情（不写「我」：在对方设备上会看错）');
  assert.equal(byLabel({ who: 'me', device: 'iPhone' }, { ...SP, me: { ...SP.me, name: '测试名' } }), `${ME} 测试名 · iPhone`);
  assert.equal(byLabel({ who: null, device: 'Mac' }, SP), 'Mac');
  assert.equal(byLabel(null, SP), '');
  setLang('zh-Hans');
  const now = new Date(2026, 10, 11, 15, 0).getTime();
  assert.equal(fmtAgo(now - 20e3, 'zh-Hans', now), '刚刚');
  assert.equal(fmtAgo(now - 5 * 60e3, 'zh-Hans', now), '5 分钟前');
  assert.equal(fmtAgo(now - 3 * 3600e3, 'zh-Hans', now), '3 小时前');
  assert.equal(fmtAgo(new Date(2026, 10, 11, 1, 30).getTime(), 'zh-Hans', now), '今天 凌晨1:30');
  assert.equal(fmtAgo(new Date(2026, 10, 10, 23, 40).getTime(), 'zh-Hans', now), '昨天 晚上11:40');
  assert.equal(fmtAgo(new Date(2026, 10, 4, 2, 58).getTime(), 'zh-Hans', now), '11月4日 凌晨2:58');
  assert.equal(fmtAgo(new Date(2025, 0, 1, 9, 0).getTime(), 'zh-Hans', now), '2025年1月1日 早上9:00');
  assert.equal(fmtAgo(2, 'zh-Hans', now), '', '备忘录导入的很早的修改时间不显示');
  setLang('en');
  assert.equal(fmtAgo(now - 60e3, 'en', now), '1 minute ago');
  assert.equal(fmtAgo(now - 2 * 3600e3, 'en', now), '2 hours ago');
  setLang('zh-Hans');
  assert.equal(madeAt({ updatedAt: 3, createdAt: now }), now);
  assert.equal(madeAt({ updatedAt: now, createdAt: 1 }), now);
});

test('版本里的 JSON 能原样还原（记录本存的是 JSON，canon 不受键顺序影响）', () => {
  const e = normalizeState({ data: { entries: { e1: stamp({ id: 'e1', date: '2026-01-02', text: '“一”', updatedBy: { who: 'me', device: 'Mac' } }, null, 5000) } } }).data.entries.e1;
  const back = JSON.parse(JSON.stringify(e));
  assert.equal(canon(back), canon(e));
  assert.equal(contentKey(back), contentKey(e));
  assert.ok(toB64('“一”'));
  assert.equal(SYNC_FILE, 'babble.json');
});
