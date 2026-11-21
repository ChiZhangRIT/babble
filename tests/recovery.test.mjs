import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPanel } from '../src/ui/recovery.js';
import { blankState, makeEntry } from '../src/core/store.js';
import { PENDING_PREFIX } from '../src/core/persistence.js';
import { setLang, t } from '../src/i18n.js';
import { Element, find, fakeStorage, installDom } from './helpers/dom.mjs';

function panel({ accept = true, fail = false } = {}) {
  const dom = installDom(); setLang('zh-Hans');
  const repairs = [], confirms = [];
  const state = blankState(); state.data.entries.local = makeEntry({ id: 'local', text: '可读取的测试记录' });
  const remote = blankState(); remote.data.entries.remote = makeEntry({ id: 'remote', text: '云端测试记录' });
  const ctx = { state, local: { sync: { token: 'synthetic' } }, storageIssue: () => ({ code: 'corrupt' }), recoveryExport: () => ({ records: [{ key: 'babble.state', raw: '{broken' }] }),
    audio: { putClip: async () => {} }, retryData() {}, recoveryCloud: async () => remote,
    confirm: async options => { confirms.push(options); return accept; }, repairData: async next => { if (fail) throw new Error('quota'); repairs.push(next); } };
  const main = new Element('main'); recoveryPanel(main, ctx);
  return { ...dom, main, ctx, repairs, confirms, button: key => find(main, el => el.tag === 'button' && el.textContent === t(key)) };
}
test('恢复页面：显示受保护状态，继续前确认，只使用可读记录；取消不执行恢复', async () => {
  for (const accept of [true, false]) {
    const env = panel({ accept });
    try {
      assert.ok(env.main.textContent.includes(t('recovery.intro')));
      await env.button('recovery.keep').fire('click');
      assert.equal(env.confirms.length, 1);
      assert.ok(env.confirms[0].message.includes(t('recovery.keepConfirm')));
      assert.equal(env.repairs.length, Number(accept));
      if (accept) assert.equal(env.repairs[0].data.entries.local.text, '可读取的测试记录');
    } finally { env.restore(); }
  }
});
test('恢复页面：云端读取与恢复分开，失败仍保留页面并允许重试', async () => {
  for (const fail of [true, false]) {
    const env = panel({ fail });
    try {
      await env.button('recovery.cloud').fire('click');
      assert.equal(env.repairs.length, fail ? 0 : 1);
      if (!fail) assert.ok(env.repairs[0].data.entries.remote);
      else assert.equal(find(env.main, el => el.attrs.role === 'alert').textContent, t('recovery.failed'));
      assert.equal(env.button('recovery.cloud').disabled, false);
    } finally { env.restore(); }
  }
});
test('恢复页面：实际读取所选备份；坏备份不执行替换', async () => {
  for (const valid of [true, false]) {
    const env = panel();
    try {
      const input = find(env.main, el => el.tag === 'input');
      const backup = blankState(); backup.data.entries.backup = makeEntry({ id: 'backup', text: '备份测试记录' });
      input.files = [new Blob([valid ? JSON.stringify({ app: 'babble', v: 1, state: backup }) : 'not json'])];
      await input.fire('change');
      assert.equal(env.repairs.length, Number(valid));
      if (valid) assert.ok(env.repairs[0].data.entries.backup);
      else assert.equal(find(env.main, el => el.attrs.role === 'alert').textContent, t('recovery.failed'));
    } finally { env.restore(); }
  }
});

test('恢复页面：从备份修复时只存合并后还有条目在用、没永久删除的录音；记下这次修过数据（repairedAt）', async () => {
  const dom = installDom(); setLang('zh-Hans');
  try {
    const { buildBackup } = await import('../src/core/backup.js');
    const { sha256Hex } = await import('../src/core/sha256.js');
    const blobOf = (s) => new Blob([new TextEncoder().encode('假录音：' + s)], { type: 'audio/mp4' });
    const clips = new Map();
    for (const name of ['永久删除了的', '还在用的']) { const b = blobOf(name); clips.set(await sha256Hex(b), b); }
    const [G, K] = [...clips.keys()];
    const item = (sha) => ({ sha256: sha, mime: 'audio/mp4', bytes: 1, durationSec: 1, origName: '', addedAt: 1 });
    const backup = blankState();
    backup.data.entries.e_t = { ...makeEntry({ id: 'e_t', text: '旧备份里的原话', audio: [item(G)] }, 1000), deleted: true, deletedAt: 5000, updatedAt: 5000 };
    backup.data.entries.e_k = makeEntry({ id: 'e_k', text: '留着的', audio: [item(K)] }, 1000);
    const zip = await buildBackup(backup, { getClip: async (sha) => ({ blob: clips.get(sha) }) });
    const state = blankState();
    state.data.entries.e_t = { id: 'e_t', updatedAt: 9000, purged: true, purgedAt: 9000, purgedFrom: 5000, deleted: true, gone: [{ sha256: G, mime: 'audio/mp4', purgedAt: 9000, from: 5000 }] };
    const put = [], local = {}, repairs = [];
    const ctx = { state, local: {}, storageIssue: () => ({ code: 'corrupt' }), recoveryExport: () => null, retryData() {}, recoveryCloud: async () => null,
      audio: { putClip: async (b) => { put.push(await sha256Hex(b)); } }, setLocal: (patch) => Object.assign(local, patch),
      confirm: async () => true, repairData: async (next) => { repairs.push(next); } };
    const main = new Element('main'); recoveryPanel(main, ctx);
    const input = find(main, el => el.tag === 'input');
    input.files = [zip];
    await input.fire('change');
    assert.equal(repairs.length, 1);
    assert.deepEqual(put, [K]);
    assert.ok(local.repairedAt > 0);
  } finally { dom.restore(); }
});

test('真实 App 冷启动：损坏数据进入恢复页，不发起同步、不触碰录音存储，不显示空列表', async () => {
  const storage = fakeStorage([['babble.state', '{broken'], ['babble.local', JSON.stringify({ sync: { token: 'synthetic', repo: 'someone/test-data' } })],
    [PENDING_PREFIX + 'healthy', JSON.stringify({ app: 'babble', v: 1, patch: { data: { entries: { e: makeEntry({ id: 'e', text: '完整的测试记录' }) } }, settings: { nightOpensRecorder: false }, settingsAt: { nightOpensRecorder: 1000 } } })]]);
  let network = 0, audioReads = 0;
  const loc = { hash: '#/', protocol: 'http:' };
  const dom = installDom({ localStorage: storage, location: loc, history: { state: {}, replaceState(s, title, hash) { loc.hash = hash; } },
    navigator: { languages: ['zh-CN'], userAgent: 'Synthetic', platform: 'Synthetic', locks: { request: async (name, fn) => fn() } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => { network++; throw new Error('should not fetch'); }, indexedDB: { open() {
      audioReads++; const request = {};
      queueMicrotask(() => {
        request.result = { transaction() { const tx = { objectStore: () => ({ getAll: () => ({ result: [] }) }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
        request.onsuccess();
      });
      return request;
    } },
    setInterval: () => 0, setTimeout: () => 0 });
  try {
    const shell = new Element('div'); shell.className = 'app';
    for (const id of ['side', 'main']) { const el = new Element('div'); el.id = id; shell.append(el); }
    const tabs = new Element('nav'); tabs.id = 'tabs';
    dom.doc.body.append(shell, tabs);
    await import('../src/app.js?test=corrupt-start');
    const app = window.__babble;
    assert.equal(app.state.storageIssue().code, 'corrupt');
    assert.equal(app.state.getState().data.entries.e.text, '完整的测试记录');
    assert.ok(dom.doc.querySelector('.recovery-screen'));
    assert.equal(dom.doc.querySelector('#main').children.length, 0);
    assert.notEqual(shell.getAttribute('inert'), null);
    await app.ctx.recovered;
    assert.equal((await app.ctx.sync.now()).skipped, true);
    assert.equal(network, 0); assert.equal(audioReads, 0);
    assert.equal(storage.getItem('babble.state'), '{broken');
    // 模拟另一页修好数据后发来的 storage 事件：本页也必须解除保护并画出列表，而不是留成空屏。
    storage.setItem('babble.state', JSON.stringify(app.state.getState()));
    app.state.reload();
    await app.ctx.recovered;
    assert.equal(app.state.storageIssue(), null);
    assert.equal(dom.doc.querySelector('.recovery-screen'), null);
    assert.ok(dom.doc.querySelector('#main').textContent.includes('完整的测试记录'));
    assert.equal(dom.doc.querySelector('.safe-mode'), null);
    assert.ok(audioReads > 0, '解除保护后才启动录音恢复');
    // 已打开页面访问权限临时失效：通过真实的「重新读取」按钮重新连接恢复后的存储对象。
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    app.state.reload();
    assert.equal(app.state.storageIssue().code, 'unavailable');
    assert.ok(dom.doc.querySelector('.recovery-screen'));
    const replacement = fakeStorage([...storage.m]);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: replacement });
    await find(dom.doc.querySelector('.recovery-screen'), el => el.tag === 'button' && el.textContent === t('recovery.retry')).fire('click');
    await app.ctx.recovered;
    assert.equal(app.state.storageIssue(), null);
    assert.equal(app.state.saveOk(), true);
    assert.equal(dom.doc.querySelector('.recovery-screen'), null);
    assert.ok(dom.doc.querySelector('#main').textContent.includes('完整的测试记录'));
    assert.ok(JSON.parse(replacement.getItem('babble.state')).data.entries.e);
    app.state.setJournal(null);
  } finally { dom.restore(); }
});
