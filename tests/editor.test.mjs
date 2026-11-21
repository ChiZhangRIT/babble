// 用最小 DOM 跑真实编辑页的输入、保存按钮和离开保护，不仅测试字段转换。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, EDIT_PREFIX } from '../src/views/editor.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, deletedRecord, purgedRecord, goneShas } from '../src/core/store.js';
import { readStoredState, PENDING_PREFIX } from '../src/core/persistence.js';
import { setLang, t } from '../src/i18n.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; } }; this.dataset = {}; this.events = {}; this.hidden = false; this.isConnected = true; this.scrollHeight = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(el) { el.remove(); this.children.push(el); el.parent = this; return el; }
  append(...els) { els.forEach(el => this.appendChild(el)); }
  prepend(el) { el.remove(); this.children.unshift(el); el.parent = this; }
  replaceChildren(...els) { this.children.forEach(el => { el.parent = null; }); this.children = []; this.append(...els); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(el => el !== this); this.parent = null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return (this._text || '') + this.children.map(el => el.textContent).join(''); }
  get firstChild() { return this.children[0]; }
  addEventListener(k, fn) { (this.events[k] ||= new Set()).add(fn); }
  removeEventListener(k, fn) { this.events[k]?.delete(fn); }
  async fire(k) { for (const fn of this.events[k] || []) await fn({ target: this, preventDefault() {} }); }
  contains(el) { return this === el || this.children.some(c => c.contains(el)); }
  focus() { document.activeElement = this; }
  setSelectionRange() {}
  querySelector(sel) {                          // 只认 [data-x="y"]（播放器找「均衡」按钮）
    const m = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(sel || '');
    if (!m) return null;
    const k = m[1].replace(/-(\w)/g, (x, c) => c.toUpperCase());
    return find(this, el => el !== this && el.dataset[k] === m[2]) || null;
  }
  get classList() {
    const names = () => new Set((this.attrs.class || '').split(' ').filter(Boolean)), write = (v) => { this.attrs.class = [...v].join(' '); };
    return { contains: n => names().has(n), add: n => { const v = names(); v.add(n); write(v); }, remove: n => { const v = names(); v.delete(n); write(v); },
      toggle: (n, f) => { const v = names(); if (f ?? !v.has(n)) v.add(n); else v.delete(n); write(v); } };
  }
}
const find = (el, pred) => pred(el) ? el : el.children.map(c => find(c, pred)).find(Boolean);
const hasClass = name => el => (el.attrs.class || '').split(' ').includes(name);

// opts：audio 条目里的录音；purgeEnabled 换掉 PURGE_ENABLED；answer 确认框的回答；before(st) 打开编辑页之前（比如先另存一份草稿、把条目换成墓碑）。
// ctx 照着 app.js：永久删除了的（墓碑）ctx.entry 不给、ctx.tombstone 给
function setup(isNew = false, status = 'done', seed = [], { audio = [], purgeEnabled = false, answer = true, before = null } = {}) {
  const globals = Object.fromEntries(['Node', 'document', 'window', 'localStorage', 'requestAnimationFrame'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const m = new Map(seed);
  const st = { fail: false, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => m.get(k) ?? null,
    setItem(k, v) { if (this.fail) throw new Error('QuotaExceededError'); m.set(k, String(v)); }, removeItem: k => m.delete(k) };
  const doc = new Element('document');
  Object.assign(doc, { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag),
    createTextNode: text => { const el = new Element('#text'); el.textContent = text; return el; }, visibilityState: 'visible' });
  for (const [k, v] of Object.entries({ Node: Element, document: doc, window: new Element('window'), localStorage: st, requestAnimationFrame: fn => fn() })) {
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  state.load({ storage: st, locks: null }); setLang('zh-Hans');
  if (!isNew) state.mutate(s => { s.data.entries.e = makeEntry({ id: 'e', date: '2026-01-02', text: '旧文字', status, audio }); });
  if (before) before(st);
  const navigations = [], messages = [], confirms = [];
  let guard;
  const ctx = {
    get state() { return state.getState(); }, newEntry: fields => makeEntry(fields),
    entry: id => { const e = state.getState().data.entries[id]; return e && !e.purged ? e : undefined; },
    tombstone: id => { const e = state.getState().data.entries[id]; return e && e.purged ? e : null; },
    goneShas: () => goneShas(state.getState()), clipBlob: async () => null,
    confirm: async (o) => { confirms.push(o); return answer; },
    put(e, opts) { state.mutate(s => { s.data.entries[e.id] = normalizeEntry(stamp(e, s.data.entries[e.id]), e.id); }, opts); return this.entry(e.id); },
    update(id, patch, opts) { return this.put({ ...this.entry(id), ...patch }, opts); },
    saveOk: state.saveOk, undo: state.undo, guard: fn => { guard = fn; }, layout: () => 'phone', lang: () => 'zh-Hans',
    back: dest => navigations.push(dest), navigate: dest => navigations.push(dest), toast: msg => messages.push(msg),
  };
  const main = new Element('main');
  const handle = render(main, { sub: isNew ? 'new' : 'edit', id: isNew ? null : 'e', query: {} }, ctx, { purgeEnabled });
  const textarea = find(main, el => el.id === 'ed-text');
  const key = EDIT_PREFIX + (isNew ? 'new' : 'e');
  return {
    st, ctx, main, key, handle, navigations, messages, confirms, guard: () => guard(), snapshot: () => [...m],
    async type(text) { textarea.value = text; await textarea.fire('input'); doc.visibilityState = 'hidden'; await doc.fire('visibilitychange'); doc.visibilityState = 'visible'; },
    save: () => find(main, hasClass('ed-save')).fire('click'),
    done: () => find(find(main, hasClass('ed-done')), el => el.tag === 'button').fire('click'),
    cleanup() {
      if (handle) handle.cleanup();               // 只说一句「已经永久删除」的那种：页面什么都不返回
      for (const [k, descriptor] of Object.entries(globals)) {
        if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k];
      }
    },
  };
}

test('编辑保存失败：留在原页、保留文字和恢复草稿、不报成功；无改动重试后才退出', async () => {
  const env = setup();
  try {
    await env.type('新文字');
    const draft = env.st.getItem(env.key);
    assert.equal(JSON.parse(draft).w.text, '新文字');
    env.st.fail = true;
    await env.save(); env.handle.onChange({ source: 'local' });
    assert.equal(env.navigations.length, 0);
    assert.equal(env.guard(), true);
    assert.equal(env.st.getItem(env.key), draft);
    assert.equal(env.messages.at(-1), t('edit.saveFailed'));
    assert.ok(!env.messages.includes(t('edit.saved')));
    assert.equal(find(env.main, el => el.attrs.role === 'alert' && el.textContent === t('edit.saveFailed')).hidden, false);
    assert.equal(readStoredState(env.st).data.entries.e.text, '旧文字');
    env.st.fail = false;
    await env.save();
    assert.equal(readStoredState(env.st).data.entries.e.text, '新文字');
    assert.equal(env.st.getItem(env.key), null);
    assert.deepEqual(env.navigations, ['/e/e']);
    assert.equal(env.guard(), false);
  } finally { env.cleanup(); }
});

test('新建保存反复失败：同一个 id，草稿先记住目标；重试成功只建一条', async () => {
  const env = setup(true);
  try {
    await env.type('新条目的文字');
    const target = JSON.parse(env.st.getItem(env.key)).target;
    assert.ok(target);
    env.st.fail = true;
    await env.save(); await env.save();
    assert.deepEqual(Object.keys(state.getState().data.entries), [target]);
    assert.equal(env.navigations.length, 0);
    env.st.fail = false;
    await env.save();
    assert.deepEqual(Object.keys(readStoredState(env.st).data.entries), [target]);
    assert.equal(readStoredState(env.st).data.entries[target].text, '新条目的文字');
    assert.deepEqual(env.navigations, ['/e/' + target]);
    assert.equal(env.st.getItem(env.key), null);
  } finally { env.cleanup(); }
});

test('整理好了：原话保存失败时不修改状态，重试成功后状态可单独撤销', async () => {
  const env = setup(false, 'inbox');
  try {
    await env.type('整理后的文字'); env.st.fail = true;
    await env.done();
    assert.equal(state.getState().data.entries.e.status, 'inbox');
    assert.equal(env.navigations.length, 0);
    env.st.fail = false;
    await env.done();
    assert.equal(readStoredState(env.st).data.entries.e.status, 'done');
    state.undo();
    assert.equal(state.getState().data.entries.e.status, 'inbox');
    assert.equal(state.getState().data.entries.e.text, '整理后的文字');
  } finally { env.cleanup(); }
});

test('新建失败后草稿重开：即使其他操作已把内存数据补存成功，也沿用草稿 id，不另建一条', async () => {
  const first = setup(true);
  let seed, target;
  try {
    await first.type('恢复后再保存的文字');
    target = JSON.parse(first.st.getItem(first.key)).target;
    first.st.fail = true; await first.save();
    first.st.fail = false;
    assert.equal(state.saveState(), true);    // 比如另一项操作把上次没存下的数据一起补存了
    seed = first.snapshot();                 // 模拟系统终止时留下的持久数据，不调用页面的 cleanup
  } finally { first.cleanup(); }
  const reopened = setup(true, 'done', seed);
  try {
    await reopened.save();
    assert.deepEqual(Object.keys(readStoredState(reopened.st).data.entries), [target]);
    assert.equal(readStoredState(reopened.st).data.entries[target].text, '恢复后再保存的文字');
  } finally { reopened.cleanup(); }
});

test('整理状态单独写入失败：原话已存但仍留在页内；重试后撤销仍能回到待整理', async () => {
  const env = setup(false, 'inbox');
  try {
    await env.type('原话已保存，状态还没有');
    const write = env.st.setItem.bind(env.st);
    let writes = 0;
    env.st.setItem = (key, value) => {
      if (key.startsWith(PENDING_PREFIX) && ++writes === 2) throw new Error('quota');
      return write(key, value);
    };
    await env.done();
    assert.equal(env.navigations.length, 0);
    assert.equal(env.guard(), true);
    assert.equal(readStoredState(env.st).data.entries.e.text, '原话已保存，状态还没有');
    assert.equal(readStoredState(env.st).data.entries.e.status, 'inbox');
    await env.done();
    assert.equal(readStoredState(env.st).data.entries.e.status, 'done');
    state.undo();
    assert.equal(state.getState().data.entries.e.status, 'inbox');
    assert.equal(state.getState().data.entries.e.text, '原话已保存，状态还没有');
  } finally { env.cleanup(); }
});

// ---------- 永久删除（这条在别的设备上永久删除了）、「移除」进最近删除 ----------
const shaOf = c => c.repeat(64);
const clipItem = (c, extra = {}) => ({ sha256: shaOf(c), mime: 'audio/mp4', bytes: 9, durationSec: 4, origName: '', addedAt: 1000, ...extra });
/** 别的设备上删除、再永久删除了这一条（同步进来）。removed：永久删除前这条「移除的录音」里有的 */
function purgeElsewhere(removed = []) {
  state.mutate(s => { s.data.entries.e = { ...deletedRecord(s.data.entries.e), removedAudio: removed }; });
  state.mutate(s => { const e = s.data.entries.e; s.data.entries.e = purgedRecord(e, e.updatedAt); }, { cause: 'purge' });
}
const byText = (main, label) => find(main, el => el.tag === 'button' && el.textContent === label);
const keyDown = (main, e) => { for (const fn of main.events.keydown || []) fn({ preventDefault() {}, ...e }); };

test('改到一半，这条在别的设备上永久删除了：不再另存、没有「保存」（⌘S 也不写）；「另存为新的一条」先确认，存成一条待整理，草稿删掉', async () => {
  const env = setup(false, 'done', [], { audio: [clipItem('a')] });
  try {
    await env.type('改了一半的文字');
    const draft = env.st.getItem(env.key);
    assert.equal(JSON.parse(draft).w.text, '改了一半的文字');
    purgeElsewhere();
    env.handle.onChange({ source: 'remote', purged: ['e'] });
    assert.equal(find(env.main, hasClass('ed-save')), undefined, '没有保存按钮');
    assert.equal(find(env.main, hasClass('ed-purged')).children[0].textContent, t('edit.purged'));
    await env.type('又改了几个字');
    assert.equal(env.st.getItem(env.key), draft, '不再另存（原来那份留着，等用户选）');
    keyDown(env.main, { metaKey: true, key: 's' });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(state.getState().data.entries.e.purged, true);
    assert.equal(state.getState().data.entries.e.text, '', '墓碑里写不进字');
    assert.equal(env.guard(), true, '离开前照样问');
    await byText(env.main, t('edit.saveAsNew')).fire('click');
    assert.deepEqual(env.confirms.map(c => [c.message, c.confirmLabel]), [[t('edit.saveAsNewMsg'), t('edit.saveAsNew')]]);
    const fresh = Object.values(state.getState().data.entries).filter(x => x.id !== 'e');
    assert.equal(fresh.length, 1);
    assert.deepEqual([fresh[0].text, fresh[0].status, fresh[0].audio], ['又改了几个字', 'inbox', []], '永久删除了的录音不带');
    assert.equal(env.st.getItem(env.key), null);
    assert.deepEqual(env.navigations, ['/e/' + fresh[0].id]);
    assert.equal(env.messages.at(-1), t('edit.savedNew'));
    assert.equal(env.guard(), false);
  } finally { env.cleanup(); }
});

test('打开时就已经永久删除：有另存的草稿 → 「已经永久删除」和两个按钮（另存的字还在框里）；另存只带这次加的、没永久删除的录音；「丢掉」删草稿、回列表', async () => {
  const draftOf = (st) => {
    purgeElsewhere([clipItem('d', { removedAt: 5000 })]);
    st.setItem(EDIT_PREFIX + 'e', JSON.stringify({ w: { date: '2026-01-02', time: '', text: '另存着的字', note: '', draftText: '', draftSrc: '', audio: [clipItem('a'), clipItem('c', { addedAt: 9000 }), clipItem('d', { addedAt: 9000 })],
      timeSource: null, recordedAt: null, tz: null }, target: 'e', added: [shaOf('c'), shaOf('d')], removed: [], renamed: [], at: Date.now() }));
  };
  const env = setup(false, 'done', [], { audio: [clipItem('a')], before: draftOf });
  try {
    assert.deepEqual(state.getState().data.entries.e.gone.map(g => g.sha256).sort(), [shaOf('a'), shaOf('d')]);
    assert.ok(byText(env.main, t('edit.saveAsNew')) && byText(env.main, t('edit.discard')));
    assert.equal(find(env.main, el => el.id === 'ed-text').value, '另存着的字');
    await byText(env.main, t('edit.saveAsNew')).fire('click');
    const fresh = Object.values(state.getState().data.entries).filter(x => x.id !== 'e');
    assert.deepEqual(fresh.map(x => [x.text, x.audio.map(a => a.sha256)]), [['另存着的字', [shaOf('c')]]], 'd 永久删除过、a 是原来那条的：都不带');
  } finally { env.cleanup(); }
  const env2 = setup(false, 'done', [], { audio: [clipItem('a')], before: draftOf });
  try {
    await byText(env2.main, t('edit.discard')).fire('click');
    assert.equal(env2.st.getItem(env2.key), null);
    assert.deepEqual(env2.navigations, ['/']);
    assert.deepEqual(Object.keys(state.getState().data.entries), ['e'], '不建条目');
  } finally { env2.cleanup(); }
});

test('打开时就已经永久删除、也没有另存的：只说一句「已经永久删除」（没有按钮），草稿键清掉', async () => {
  const env = setup(false, 'done', [], { before: () => purgeElsewhere() });
  try {
    assert.equal(find(env.main, hasClass('empty')).textContent, t('entry.purgedNote'));
    assert.equal(byText(env.main, t('edit.saveAsNew')), undefined);
    assert.equal(env.st.getItem(env.key), null);
  } finally { env.cleanup(); }
});

test('「移除」一段录音：先说清楚去哪儿（第一阶段：最近删除里能放回来；开放以后：30 天后自动永久删除），保存后进「移除的录音」，提示一句', async () => {
  for (const purgeEnabled of [false, true]) {
    const env = setup(false, 'done', [], { audio: [clipItem('a'), clipItem('b')], purgeEnabled });
    try {
      await find(env.main, el => el.tag === 'button' && el.textContent === t('edit.removeClip')).fire('click');
      assert.equal(env.confirms[0].message, t(purgeEnabled ? 'edit.removeConfirmPurge' : 'edit.removeConfirm'));
      await env.save();
      const e = state.getState().data.entries.e;
      assert.deepEqual(e.audio.map(a => a.sha256), [shaOf('b')]);
      assert.deepEqual(e.removedAudio.map(a => a.sha256), [shaOf('a')]);
      assert.ok(e.removedAudio[0].removedAt > 0);
      assert.equal(env.messages.at(-1), t('edit.saved') + '\n' + t(purgeEnabled ? 'edit.removedNotePurge' : 'edit.removedNote', { n: 1 }));
    } finally { env.cleanup(); }
  }
});
