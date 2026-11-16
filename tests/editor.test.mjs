// 用最小 DOM 跑真实编辑页的输入、保存按钮和离开保护，不仅测试字段转换。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, EDIT_PREFIX } from '../src/views/editor.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp } from '../src/core/store.js';
import { readStoredState, PENDING_PREFIX } from '../src/core/persistence.js';
import { setLang, t } from '../src/i18n.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.dataset = {}; this.events = {}; this.hidden = false; this.isConnected = true; this.scrollHeight = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
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
  querySelector() { return null; }
}
const find = (el, pred) => pred(el) ? el : el.children.map(c => find(c, pred)).find(Boolean);
const hasClass = name => el => (el.attrs.class || '').split(' ').includes(name);

function setup(isNew = false, status = 'done', seed = []) {
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
  if (!isNew) state.mutate(s => { s.data.entries.e = makeEntry({ id: 'e', date: '2026-01-02', text: '旧文字', status }); });
  const navigations = [], messages = [];
  let guard;
  const ctx = {
    get state() { return state.getState(); }, entry: id => state.getState().data.entries[id], newEntry: fields => makeEntry(fields),
    put(e, opts) { state.mutate(s => { s.data.entries[e.id] = normalizeEntry(stamp(e, s.data.entries[e.id]), e.id); }, opts); return this.entry(e.id); },
    update(id, patch, opts) { return this.put({ ...this.entry(id), ...patch }, opts); },
    saveOk: state.saveOk, undo: state.undo, guard: fn => { guard = fn; }, layout: () => 'phone', lang: () => 'zh-Hans',
    back: dest => navigations.push(dest), navigate: dest => navigations.push(dest), toast: msg => messages.push(msg),
  };
  const main = new Element('main');
  const handle = render(main, { sub: isNew ? 'new' : 'edit', id: isNew ? null : 'e', query: {} }, ctx);
  const textarea = find(main, el => el.id === 'ed-text');
  const key = EDIT_PREFIX + (isNew ? 'new' : 'e');
  return {
    st, ctx, main, key, handle, navigations, messages, guard: () => guard(), snapshot: () => [...m],
    async type(text) { textarea.value = text; await textarea.fire('input'); doc.visibilityState = 'hidden'; await doc.fire('visibilitychange'); doc.visibilityState = 'visible'; },
    save: () => find(main, hasClass('ed-save')).fire('click'),
    done: () => find(find(main, hasClass('ed-done')), el => el.tag === 'button').fire('click'),
    cleanup() {
      handle.cleanup();
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
