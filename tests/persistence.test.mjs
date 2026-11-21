import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistence, readStoredState, STATE_KEY, PENDING_PREFIX, ARCHIVE_PREFIX, LocalDataError } from '../src/core/persistence.js';
import { blankState, makeEntry, setSetting, deletedRecord, purgedRecord, canon } from '../src/core/store.js';

const fakeStorage = () => {
  const m = new Map();
  return { m, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const fakeLocks = () => {
  let chain = Promise.resolve();
  return { request(name, fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; } };
};
const entryState = (id, text = id) => {
  const s = blankState(); s.data.entries[id] = makeEntry({ id, text }, 1000); return s;
};
const pending = st => [...st.m.keys()].filter(k => k.startsWith(PENDING_PREFIX));

test('多标签页：旧快照各自新增，不等 storage 事件也都能落盘，重启后两条都在', () => {
  const st = fakeStorage(), a = createPersistence(st, { locks: null }), b = createPersistence(st, { locks: null });
  a.save(entryState('a'));
  b.save(entryState('b'));
  assert.deepEqual(Object.keys(readStoredState(st).data.entries).sort(), ['a', 'b']);
  assert.equal(pending(st).length, 2);
  assert.equal(st.getItem(STATE_KEY), null, '未整理前不需要依赖总快照');
  assert.equal(canon(createPersistence(st, { locks: null }).read()), canon(readStoredState(st)));
});

test('真正交错写入：两页都读过旧快照，另一页插在日志写入前保存，互不覆盖', () => {
  const st = fakeStorage(), a = createPersistence(st, { locks: null }), b = createPersistence(st, { locks: null });
  const write = st.setItem;
  let interleave = true;
  st.setItem = (key, value) => {
    if (interleave && key.startsWith(PENDING_PREFIX)) { interleave = false; b.save(entryState('b')); }
    return write(key, value);
  };
  a.save(entryState('a'));
  assert.deepEqual(Object.keys(readStoredState(st).data.entries).sort(), ['a', 'b']);
});

test('整理持有同一个 Web Lock；写好快照后才删日志，旧格式数据也一起保留', async () => {
  const st = fakeStorage(), locks = fakeLocks();
  st.setItem(STATE_KEY, JSON.stringify(entryState('legacy')));
  const a = createPersistence(st, { locks }), b = createPersistence(st, { locks });
  a.save(entryState('a')); b.save(entryState('b'));
  await Promise.all([a.idle(), b.idle()]);
  assert.deepEqual(Object.keys(JSON.parse(st.getItem(STATE_KEY)).data.entries).sort(), ['a', 'b', 'legacy']);
  assert.equal(pending(st).length, 0);
});

test('整理期间另一个标签页写入：新日志不能被前一轮删除', async () => {
  const st = fakeStorage(), a = createPersistence(st, { locks: fakeLocks() }), b = createPersistence(st, { locks: null });
  const write = st.setItem;
  let interleave = true;
  st.setItem = (key, value) => {
    if (key === STATE_KEY && interleave) { interleave = false; b.save(entryState('b')); }
    return write(key, value);
  };
  a.save(entryState('a'));
  await a.idle();
  assert.equal(pending(st).length, 1, '这轮没读到的日志仍在');
  assert.deepEqual(Object.keys(readStoredState(st).data.entries).sort(), ['a', 'b']);
  a.read(); await a.idle();
  assert.equal(pending(st).length, 0);
  assert.deepEqual(Object.keys(JSON.parse(st.getItem(STATE_KEY)).data.entries).sort(), ['a', 'b']);
});

test('快照写不下：保存成功的日志不删；关闭后能恢复，空间恢复后再整理', async () => {
  const st = fakeStorage(), write = st.setItem;
  st.setItem = (key, value) => { if (key === STATE_KEY) throw new Error('quota'); return write(key, value); };
  const a = createPersistence(st, { locks: fakeLocks() });
  a.save(entryState('a')); await a.idle();
  assert.equal(pending(st).length, 1);
  assert.equal(readStoredState(st).data.entries.a.text, 'a');
  st.setItem = write;
  const reopened = createPersistence(st, { locks: fakeLocks() });
  assert.equal(reopened.read().data.entries.a.text, 'a'); await reopened.idle();
  assert.equal(pending(st).length, 0);
});

test('日志写失败绝不算成功；原数据保留，空间恢复后可以重试同一份修改', () => {
  const st = fakeStorage(), a = createPersistence(st, { locks: null });
  st.setItem(STATE_KEY, JSON.stringify(entryState('a', '旧')));
  const next = a.read(); next.data.entries.a.text = '新'; next.data.entries.a.updatedAt++;
  const write = st.setItem;
  st.setItem = () => { throw new Error('quota'); };
  assert.throws(() => a.save(next), /quota/);
  assert.equal(readStoredState(st).data.entries.a.text, '旧');
  st.setItem = write; a.save(next);
  assert.equal(readStoredState(st).data.entries.a.text, '新');
});

test('读日志时另一个标签页完成整理：重读新快照，不能漏掉已删掉的日志', async () => {
  const st = fakeStorage(), a = createPersistence(st, { locks: null });
  a.save(entryState('a'));
  const complete = readStoredState(st), get = st.getItem;
  let interleave = true;
  st.getItem = key => {
    if (key.startsWith(PENDING_PREFIX) && interleave) {
      interleave = false;
      st.setItem(STATE_KEY, JSON.stringify(complete));
      for (const k of pending(st)) st.removeItem(k);
    }
    return get(key);
  };
  assert.equal(readStoredState(st).data.entries.a.text, 'a');
});

test('日志按现有规则合并：删除不复活、设置分别保留、旧版未知字段保留', () => {
  const st = fakeStorage(), a = createPersistence(st, { locks: null }), b = createPersistence(st, { locks: null });
  const initial = entryState('a'); initial.data.entries.a.future = { keep: true };
  initial.settings.future = '旧版无时间戳的设置';
  st.setItem(STATE_KEY, JSON.stringify(initial));
  const deleted = a.read(), other = b.read();
  deleted.data.entries.a = deletedRecord(deleted.data.entries.a, 2000);
  setSetting(deleted, 'nightStart', '22:00', 2000);
  setSetting(other, 'maxRecordMin', 5, 2000); other.data.entries.b = makeEntry({ id: 'b', text: '测试' });
  a.save(deleted); b.save(other);
  const merged = readStoredState(st);
  assert.equal(merged.data.entries.a.deleted, true);
  assert.deepEqual(merged.data.entries.a.future, { keep: true });
  assert.equal(merged.settings.nightStart, '22:00');
  assert.equal(merged.settings.maxRecordMin, 5);
  assert.equal(merged.settings.future, initial.settings.future);
});

test('state 集成：两页写入、storage 重载、空间满后的无改动重试，都不丢记录', async () => {
  const a = await import('../src/core/state.js?tab=persistence-a');
  const b = await import('../src/core/state.js?tab=persistence-b');
  const st = fakeStorage();
  a.load({ storage: st, locks: null }); b.load({ storage: st, locks: null });
  a.mutate(s => { s.data.entries.a = makeEntry({ id: 'a', text: 'A' }); });
  b.mutate(s => { s.data.entries.b = makeEntry({ id: 'b', text: 'B' }); });
  a.reload(); b.reload();
  assert.equal(canon(a.getState()), canon(b.getState()));
  assert.equal(Object.keys(a.getState().data.entries).length, 2);
  const write = st.setItem;
  st.setItem = () => { throw new Error('quota'); };
  a.mutate(s => { s.data.entries.a.text = '未保存'; });
  assert.equal(a.saveOk(), false);
  a.reload();
  assert.equal(a.getState().data.entries.a.text, '未保存', '重载不能覆盖内存里没存下的改动');
  assert.equal(a.saveOk(), false);
  st.setItem = write;
  a.mutate(s => { s.data.entries.a.text = '未保存'; });
  assert.equal(a.saveOk(), true, '没有新的字段改动也会重试落盘');
  assert.equal(readStoredState(st).data.entries.a.text, '未保存');
  b.reload();
  assert.equal(b.getState().data.entries.a.text, '未保存');
});

test('state 集成：只变同步配置不反复触发数据同步；接到别的标签页记录会推进版本', async () => {
  const a = await import('../src/core/state.js?tab=version-a');
  const b = await import('../src/core/state.js?tab=version-b');
  const st = fakeStorage();
  a.load({ storage: st, locks: null }); b.load({ storage: st, locks: null });
  const seen = []; a.subscribe((s, info) => seen.push(info));
  const v = a.editVersion(); a.reload();
  assert.equal(seen.at(-1).changed, false);
  assert.equal(a.editVersion(), v);
  b.mutate(s => { s.data.entries.b = makeEntry({ id: 'b', text: '测试' }); });
  a.reload();
  assert.equal(seen.at(-1).changed, true);
  assert.equal(a.editVersion(), v + 1);
});

test('浏览器存储暂不可用：重试仍失败时保持保护，恢复后重新获取存储并正常读写', async () => {
  const a = await import('../src/core/state.js?tab=browser-storage-retry');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const st = fakeStorage(); st.setItem(STATE_KEY, JSON.stringify(entryState('existing')));
  st.setItem(a.LKEY, JSON.stringify({ lang: 'en', sync: { repo: 'someone/test-data', token: 'synthetic', dirty: false } }));
  let available = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { if (!available) throw new Error('SecurityError'); return st; } });
  try {
    a.load({ locks: null });
    assert.equal(a.storageIssue().code, 'unavailable');
    a.reload();
    assert.equal(a.storageIssue().code, 'unavailable', '访问仍被拒绝时不能解除保护');
    assert.equal(a.saveOk(), false);
    assert.throws(() => a.mutate(s => { s.data.entries.new = makeEntry(); }));
    available = true;
    a.reload();
    assert.equal(a.storageIssue(), null);
    assert.equal(a.saveOk(), true);
    assert.equal(a.getState().data.entries.existing.text, 'existing');
    assert.equal(a.getLocal().lang, 'en');
    a.mutate(s => { s.data.entries.existing.text = '重试后保存的测试文字'; });
    assert.equal(a.saveOk(), true);
    assert.equal(readStoredState(st).data.entries.existing.text, '重试后保存的测试文字');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage;
  }
});

test('浏览器存储对象更换后重试会重连，显式注入的存储和纯内存模式不会读取浏览器存储', async () => {
  const a = await import('../src/core/state.js?tab=browser-storage-rebind');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const first = fakeStorage(), second = fakeStorage();
  first.setItem(STATE_KEY, JSON.stringify(entryState('first')));
  second.setItem(STATE_KEY, JSON.stringify(entryState('second')));
  let current = first, reads = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++; if (!current) throw new Error('SecurityError'); return current; } });
  try {
    a.load({ locks: null });
    current = null; a.reload();
    assert.equal(a.storageIssue().code, 'unavailable');
    assert.ok(a.getState().data.entries.first, '访问失败不能清掉内存中已有的记录');
    current = second; a.reload();
    assert.equal(a.storageIssue(), null);
    assert.deepEqual(Object.keys(a.getState().data.entries).sort(), ['first', 'second']);
    assert.ok(readStoredState(second).data.entries.first, '重连后合并而非丢掉原有的内存记录');
    const injected = fakeStorage(); injected.setItem(STATE_KEY, JSON.stringify(entryState('injected')));
    reads = 0;
    a.load({ storage: injected, locks: null }); a.reload();
    assert.deepEqual(Object.keys(a.getState().data.entries), ['injected']);
    a.load({ storage: null }); a.mutate(s => { s.data.entries.memory = makeEntry({ id: 'memory' }); }); a.reload();
    assert.ok(a.getState().data.entries.memory);
    assert.equal(a.saveOk(), true);
    assert.equal(reads, 0, '测试注入与纯内存模式仍保持隔离');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage;
  }
});

test('state 集成：空间满后由 storage 事件补存，旧配置不能抹掉待同步标记', async () => {
  const a = await import('../src/core/state.js?tab=retry-sync');
  const st = fakeStorage();
  a.load({ storage: st, locks: null });
  a.setLocal({ sync: { repo: 'someone/test-data', token: 'synthetic', dirty: false } });
  const write = st.setItem;
  st.setItem = () => { throw new Error('quota'); };
  a.mutate(s => { s.data.entries.a = makeEntry({ id: 'a', text: '等待补存' }); });
  assert.equal(a.saveOk(), false);
  st.setItem = write;
  a.reload();
  assert.equal(a.saveOk(), true);
  assert.equal(a.getLocal().sync.dirty, true);
  assert.equal(readStoredState(st).data.entries.a.text, '等待补存');
});

test('损坏快照：原始 JSON 不覆盖；健康日志仍可读，导出不含本机同步令牌', async () => {
  const st = fakeStorage();
  st.setItem(STATE_KEY, '{broken-json'); st.setItem('babble.local', JSON.stringify({ sync: { token: 'synthetic-secret' } }));
  st.setItem(PENDING_PREFIX + 'healthy', JSON.stringify({ app: 'babble', v: 1, patch: entryState('kept') }));
  const p = createPersistence(st, { locks: fakeLocks() });
  assert.throws(() => p.read(), e => e instanceof LocalDataError && !!e.state.data.entries.kept);
  assert.throws(() => p.save(entryState('new')), LocalDataError);
  await p.idle();
  assert.equal(st.getItem(STATE_KEY), '{broken-json');
  const evidence = p.evidence();
  assert.equal(evidence.records.find(r => r.key === STATE_KEY).raw, '{broken-json');
  assert.ok(!JSON.stringify(evidence).includes('synthetic-secret'));
  assert.equal(evidence.state.data.entries.kept.text, 'kept');
});

test('有效 JSON 但结构损坏也不能当成空白覆盖', () => {
  for (const raw of ['null', '[]', '"text"', '{"data":[]}', '{"app":"other"}', '{"v":99}']) {
    const st = fakeStorage(); st.setItem(STATE_KEY, raw);
    assert.throws(() => readStoredState(st), LocalDataError);
    assert.throws(() => createPersistence(st).save(entryState('new')), LocalDataError);
    assert.equal(st.getItem(STATE_KEY), raw);
  }
});

test('部分记录结构损坏或字段无法整理：保留原始文件，可读部分和日志仍可导出恢复', async () => {
  for (const bad of ['not a record', { date: 'invalid', createdAt: 1e100 }]) {
    const st = fakeStorage();
    const original = JSON.stringify({ app: 'babble', v: 1, data: { entries: { bad, good: makeEntry({ id: 'good', text: '完整记录' }) } } });
    st.setItem(STATE_KEY, original);
    const p = createPersistence(st, { locks: fakeLocks() });
    assert.throws(() => p.read(), LocalDataError);
    assert.equal(p.evidence().records[0].raw, original);
    await p.recover(entryState('backup'));
    assert.ok(p.read().data.entries.backup);
    assert.equal(p.archive().records[0].raw, original);
  }
});

test('损坏日志：健康快照和日志一起保留；恢复先存档，再合并备份，不清除别的本机数据', async () => {
  const st = fakeStorage(); st.setItem(STATE_KEY, JSON.stringify(entryState('kept')));
  st.setItem(PENDING_PREFIX + 'bad', 'broken log'); st.setItem('babble.edit.new', 'untouched draft');
  const p = createPersistence(st, { locks: fakeLocks() });
  assert.throws(() => p.read(), LocalDataError);
  const fixed = await p.recover(entryState('backup'));
  assert.deepEqual(Object.keys(fixed.data.entries).sort(), ['backup', 'kept']);
  assert.equal(st.getItem('babble.edit.new'), 'untouched draft');
  assert.equal(st.getItem(PENDING_PREFIX + 'bad'), null);
  const archive = p.archive();
  assert.equal(archive.records.find(r => r.key === PENDING_PREFIX + 'bad').raw, 'broken log');
  assert.equal(archive.records.find(r => r.key === STATE_KEY).raw, JSON.stringify(entryState('kept')));
  assert.equal(Object.keys(createPersistence(st).read().data.entries).length, 2);
});

test('存档或新快照写不下：恢复失败，原件不删除', async () => {
  for (const failing of ['archive', 'snapshot']) {
    const st = fakeStorage(); st.setItem(STATE_KEY, 'original broken state'); st.setItem(PENDING_PREFIX + 'bad', 'original broken log');
    const write = st.setItem;
    st.setItem = (key, value) => {
      if ((failing === 'archive' && key.startsWith(ARCHIVE_PREFIX)) || (failing === 'snapshot' && key === STATE_KEY)) throw new Error('quota');
      return write(key, value);
    };
    const p = createPersistence(st, { locks: fakeLocks() });
    await assert.rejects(p.recover(entryState('backup')), /quota/);
    assert.equal(st.getItem(STATE_KEY), 'original broken state');
    assert.equal(st.getItem(PENDING_PREFIX + 'bad'), 'original broken log');
  }
});

test('恢复期间新来的日志不删除；没有锁时不执行替换', async () => {
  const st = fakeStorage(); st.setItem(STATE_KEY, 'broken');
  await assert.rejects(createPersistence(st, { locks: null }).recover(entryState('backup')), /unavailable/);
  assert.equal(st.getItem(STATE_KEY), 'broken');
  const write = st.setItem;
  st.setItem = (key, value) => { if (key === STATE_KEY) write(PENDING_PREFIX + 'late', JSON.stringify({ app: 'babble', v: 1, patch: entryState('late') })); return write(key, value); };
  const p = createPersistence(st, { locks: fakeLocks() });
  const fixed = await p.recover(entryState('backup'));
  assert.deepEqual(Object.keys(fixed.data.entries).sort(), ['backup', 'late']);
  assert.notEqual(st.getItem(PENDING_PREFIX + 'late'), null);
});

test('state 损坏期间阻止修改和云端合并；恢复后解除保护，重置同步版本并保留存档', async () => {
  const a = await import('../src/core/state.js?tab=corrupt-recovery');
  const st = fakeStorage(); st.setItem(STATE_KEY, '{broken');
  st.setItem(a.LKEY, JSON.stringify({ sync: { token: 'synthetic-secret', sha: 'stale', etag: 'stale', dirty: false } }));
  a.load({ storage: st, locks: fakeLocks() });
  assert.equal(a.storageIssue().code, 'corrupt');
  assert.throws(() => a.mutate(s => { s.data.entries.new = makeEntry(); }), LocalDataError);
  assert.equal(a.applyRemote(entryState('remote')), false);
  assert.throws(() => a.mergeIn(entryState('imported')), LocalDataError);
  assert.equal(a.saveState(), false);
  assert.equal(st.getItem(STATE_KEY), '{broken');
  await a.recoverFrom(entryState('backup'));
  assert.equal(a.storageIssue(), null); assert.equal(a.saveOk(), true);
  assert.equal(a.getState().data.entries.backup.text, 'backup');
  assert.equal(a.getLocal().sync.sha, null); assert.equal(a.getLocal().sync.dirty, true);
  assert.ok(!JSON.stringify(a.recoveryArchive()).includes('synthetic-secret'));
  a.load({ storage: st, locks: fakeLocks() });
  assert.equal(a.getState().data.entries.backup.text, 'backup');
  assert.equal(a.recoveryExport().records[0].raw, '{broken');
});

// ---------- 永久删除以后清掉磁盘上的旧原话 ----------
const tombOf = (rec, at) => purgedRecord(rec, rec.updatedAt, at);
const logOf = (s) => JSON.stringify({ app: 'babble', v: 1, patch: s });
const withRec = (rec) => { const s = blankState(); s.data.entries[rec.id] = rec; return s; };

test('scrub：快照、日志里墓碑盖得过的旧版本换成墓碑；更新的那份（让永久删除作废的）不动；墓碑里带着的字去掉；有锁、没锁都行', async () => {
  for (const locks of [null, fakeLocks()]) {
    const st = fakeStorage();
    const old = makeEntry({ id: 'x', text: '“很早的原话”' }, 1000), del = deletedRecord({ ...old, text: '“删之前的原话”' }, 2000);
    const t = tombOf(del, 3000);
    st.setItem(STATE_KEY, JSON.stringify(withRec(old)));
    st.setItem(PENDING_PREFIX + 'w.1', logOf(withRec(del)));
    st.setItem(PENDING_PREFIX + 'w.2', logOf(withRec({ ...t, text: '旧版 app 写进墓碑的字' })));
    st.setItem(PENDING_PREFIX + 'w.3', logOf(withRec(makeEntry({ id: 'x', text: '“作废它的那份”' }, 2500))));
    st.setItem(PENDING_PREFIX + 'w.4', logOf(withRec(makeEntry({ id: 'other', text: '“别的条目”' }, 1000))));
    const p = createPersistence(st, { locks });
    const r = await p.scrub(['x', 'missing'], () => ({ data: { entries: { x: t } } }));
    assert.deepEqual(r, { changed: 3, left: [] });
    const all = [...st.m.values()].join('\n');
    for (const text of ['很早的原话', '删之前的原话', '旧版 app 写进墓碑的字']) assert.ok(!all.includes(text), text);
    assert.ok(all.includes('作废它的那份') && all.includes('别的条目'), '更新的那份、别的条目不动');
    assert.equal(JSON.parse(st.getItem(STATE_KEY)).data.entries.x.purged, true);
    assert.deepEqual(await p.scrub(['x'], { data: { entries: { x: t } } }), { changed: 0, left: [] }, '再做一次：没什么可换');
    assert.deepEqual(await p.scrub(['x'], { data: { entries: { x: old } } }), { changed: 0, left: [] }, '不是墓碑：不动');
  }
});

test('scrub：修复存档里整理出的 state、能读懂的原件（快照、日志）换掉；读不懂的原件一个字不改，报出来；写不回去也报', async () => {
  const st = fakeStorage();
  const del = deletedRecord(makeEntry({ id: 'e_x1', text: '“存档里的原话”' }, 1000), 2000), t = tombOf(del, 3000);
  const archive = (records, rec = del) => JSON.stringify({ app: 'babble', v: 1, kind: 'local-recovery', exportedAt: '2026-11-20T00:00:00Z', state: withRec(rec), records, issues: [] });
  const good = ARCHIVE_PREFIX + '1.a', bad = ARCHIVE_PREFIX + '2.b', other = ARCHIVE_PREFIX + '3.c', broken = ARCHIVE_PREFIX + '4.d';
  st.setItem(good, archive([{ key: STATE_KEY, raw: JSON.stringify(withRec(del)) }, { key: PENDING_PREFIX + 'q', raw: logOf(withRec(del)) }]));
  const unreadable = '{坏的 "e_x1": "“存档里的原话”"';
  st.setItem(bad, archive([{ key: STATE_KEY, raw: unreadable }]));
  const otherRaw = archive([{ key: STATE_KEY, raw: '{坏的，但没提到这一条' }], makeEntry({ id: 'e_y1', text: '“别的条目”' }, 1000));
  st.setItem(other, otherRaw);
  st.setItem(broken, '{整份坏了 "e_x1"');
  const p = createPersistence(st, { locks: fakeLocks() });
  const r = await p.scrub(['e_x1'], { data: { entries: { e_x1: t } } });
  assert.deepEqual(r.left.sort(), [bad, broken].sort());
  assert.ok(!st.getItem(good).includes('存档里的原话'));
  assert.equal(JSON.parse(JSON.parse(st.getItem(good)).records[1].raw).patch.data.entries.e_x1.purged, true);
  assert.equal(JSON.parse(st.getItem(bad)).records[0].raw, unreadable, '读不懂的原件原样留着');
  assert.equal(JSON.parse(st.getItem(bad)).state.data.entries.e_x1.purged, true, '同一份存档里能换的照样换');
  assert.equal(st.getItem(broken), '{整份坏了 "e_x1"');
  assert.equal(st.getItem(other), otherRaw, '没提到这一条的存档不碰（坏的原件也不报）');
  // 存档写不回去（空间满）：报出来，原件不动
  const st2 = fakeStorage(); st2.setItem(good, archive([{ key: STATE_KEY, raw: JSON.stringify(withRec(del)) }]));
  const before = st2.getItem(good), write = st2.setItem;
  st2.setItem = (k, v) => { if (k.startsWith(ARCHIVE_PREFIX)) throw new Error('quota'); return write(k, v); };
  const r2 = await createPersistence(st2, { locks: null }).scrub(['e_x1'], { data: { entries: { e_x1: t } } });
  assert.deepEqual(r2.left, [good]);
  assert.equal(st2.getItem(good), before);
  assert.deepEqual(await createPersistence(null).scrub(['e_x1'], { data: { entries: { e_x1: t } } }), { changed: 0, left: [] });
});
