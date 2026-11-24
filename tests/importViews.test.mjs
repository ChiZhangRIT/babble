// 导入的录音转 m4a：每条加录音的路都转（设置 → 数据 → 导入录音：选的、拖进来的；详情页 ⋯「添加录音（文件）」；编辑页「添加录音」），
// 已经是 m4a 的原样；转不了的原样存、那一行 / 提示里说一句；同一个 WAV 导两次（编码器每次编出来都不一样）、在「最近删除」里的都认得出；
// 永久删除以后只认 sha256（srcSha256 不会把永久删除了的录音找回来）。从备忘录迁移不转。
// 最小 DOM + 真的 state.js、memoryStore（录音库）、真的 importM4a / m4a.js；编码器、解码器是假的（tests/helpers/fakeCodec.mjs），声音、文件名都是编的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render as renderImport, readAudioFile } from '../src/views/import.js';
import { render as renderEntry, readClipFiles } from '../src/views/entry.js';
import { render as renderEditor } from '../src/views/editor.js';
import { memoryStore } from '../src/core/audioStore.js';
import * as state from '../src/core/state.js';
import { makeEntry, normalizeEntry, stamp, deletedRecord, purgedRecord, goneShas, claimShas, referencedClips, isTombstone, live, clipIndex, clipKeys, sameClip } from '../src/core/store.js';
import { readMp4Meta } from '../src/core/mp4meta.js';
import { sha256Hex } from '../src/core/sha256.js';
import { pcmToM4a } from '../src/core/m4a.js';
import { decodeMono } from '../src/core/transcribe.js';
import { setLang, t } from '../src/i18n.js';
import { Element, all, find, fakeStorage, installDom } from './helpers/dom.mjs';
import { tone, wavBytes, fakeBrowser } from './helpers/fakeCodec.mjs';

const NN = '\u{1F470}\u{1F3FB}‍♀️';
const LM = Date.UTC(2026, 10, 18, 11, 7, 30);                     // 文件修改时间（编的）
const REC = Date.UTC(2026, 10, 17, 10, 42, 5);                    // m4a 里的录音时间（编的）
const cls = (el, c) => (el.className || el.attrs.class || '').split(' ').includes(c);
const byCls = (root, c) => find(root, el => cls(el, c));
const allCls = (root, c) => all(root, el => cls(el, c));
const btn = (root, label) => find(root, el => el.tag === 'button' && !el.hidden && el.textContent.includes(label));
const raw = (id) => state.getState().data.entries[id];
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, what = 'until', n = 4000) { for (let i = 0; i < n; i++) { if (fn()) return; await tick(); } assert.fail('等不到：' + what); }
async function quiet(fn) { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } }
Element.prototype.cloneNode = function () { const c = new Element(this.tag); Object.assign(c.attrs, this.attrs); c.className = this.className; c._text = this._text; for (const x of this.children) c.appendChild(x.cloneNode()); return c; };
Element.prototype.scrollIntoView = function () {};
Element.prototype.setSelectionRange = function (a, b) { this.selectionStart = a; this.selectionEnd = b; };
Element.prototype.select = function () {};
Element.prototype.prepend = function (el) { el.remove(); this.children.unshift(el); el.parent = this; };
const plainQuery = Element.prototype.querySelector;
Element.prototype.querySelector = function (sel) {
  const m = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(sel || '');
  if (!m) return plainQuery.call(this, sel);
  const k = m[1].replace(/-(\w)/g, (x, c) => c.toUpperCase());
  return find(this, el => el !== this && el.dataset[k] === m[2]) || null;
};

/** 编的 WAV 文件（48 kHz 立体声）：seed 不同内容就不同 */
const wavFile = (name, seed = 1, sec = 2, o = {}) => new File([wavBytes([tone(sec * 48000, seed), tone(sec * 48000, seed + 1, 4000)], 48000, o)], name, { type: 'audio/wav', lastModified: LM });
/** 编的 m4a（语音备忘录那样的：mp4 里的 AAC，带录音时间） */
async function m4aFile(name, seed = 9) {
  const b = fakeBrowser();
  const blob = await pcmToM4a(tone(3 * 16000, seed), { ...b.opts, createdAt: REC });
  return new File([blob], name, { type: 'audio/mp4', lastModified: LM });
}

/** 照着 app.js 的 ctx 的公共部分 */
function setup({ m4a = fakeBrowser().opts } = {}) {
  const d = installDom({ matchMedia: () => ({ matches: false }), localStorage: fakeStorage(), requestAnimationFrame: (fn) => fn() });
  const mk = d.doc.createElement;
  d.doc.createElement = (tag) => { const el = mk(tag); el.style.setProperty = (k, v) => { el.style[k] = v; }; return el; };
  setLang('zh-Hans');
  state.load({ storage: fakeStorage(), locks: null });
  const audio = memoryStore();
  const env = { audio, toasts: [], navs: [], sheets: [], m4a, dropped: null };
  const ctx = env.ctx = {
    t, lang: () => 'zh-Hans', layout: () => 'phone', audio,
    get state() { return state.getState(); }, get local() { return state.getLocal(); }, setLocal: (p) => state.setLocal(p),
    entry: (id) => { const e = id && raw(id); return e && !isTombstone(e) ? e : null; },
    entries: () => live(state.getState()).filter(e => !isTombstone(e)),
    tombstone: (id) => { const e = id && raw(id); return isTombstone(e) ? e : null; },
    goneShas: () => goneShas(state.getState()), newEntry: (f) => makeEntry(f), saveOk: state.saveOk, undo: state.undo,
    put(e, opts) { const id = e.id; if (ctx.tombstone(id)) return null; state.mutate(s => { s.data.entries[id] = normalizeEntry(stamp({ ...e, id }, s.data.entries[id]), id); }, opts); return ctx.entry(id); },
    update: (id, patch, opts) => (ctx.entry(id) ? ctx.put({ ...ctx.entry(id), ...patch, id }, opts) : null),
    mutate: (fn, opts) => state.mutate(fn, opts),
    remove: (id) => state.mutate(s => { s.data.entries[id] = deletedRecord(s.data.entries[id]); }),
    toast: (msg, o = {}) => { env.toasts.push({ msg, ...o }); return { close() { env.toasts.push({ closed: msg }); } }; },
    confirm: async () => true, sheet: (content, o = {}) => { const api = { content, body: new Element('div'), close() {} }; env.sheets.push(api); return api; },
    back: (p) => env.navs.push('back:' + p), navigate: (p) => env.navs.push(p), guard: (fn) => { env.guard = typeof fn === 'function' ? fn : null; }, home: () => '/',
    on: () => () => {}, takeFiles: () => { const f = env.dropped; env.dropped = null; return f; },
    clipBlob: async (sha) => ((await audio.getClip(sha)) || {}).blob || null,
    sync: { status: () => ({ on: false }) },
  };
  env.done = () => { if (env.page && env.page.cleanup) env.page.cleanup(); d.restore(); };
  /** 打开导入页（拖进来的文件：env.dropped） */
  env.openImport = (sub) => { if (env.page && env.page.cleanup) env.page.cleanup(); env.main = new Element('main'); env.page = renderImport(env.main, { name: 'import', sub, query: {} }, ctx, { m4a: env.m4a }); return env.main; };
  /** 选文件：页面里那个 <input type=file> */
  env.pick = async (main, files) => { const input = find(main, el => el.tag === 'input' && el.attrs.type === 'file'); input.files = files; await input.fire('change'); };
  return env;
}
/** 导入页：等读完、转完（上面不再写「正在读取…」「正在转成 m4a…」） */
async function settled(env) {
  for (let i = 0; i < 5; i++) await tick();
  await until(() => !env.main.textContent.includes('正在读取') && !env.main.textContent.includes('正在转成'), '读完、转完');
  for (let i = 0; i < 20; i++) await tick();
}
const goBtn = (main) => find(main, el => el.tag === 'button' && cls(el, 'primary') && cls(el, 'big'));
const skippedText = (main) => allCls(main, 'im-skip').map(x => x.textContent);

// ---------- 导入录音 ----------
test('导入录音：WAV 转成 m4a 再存（sha256 是 m4a 的、srcSha256 是原文件的、mime audio/mp4、名字还是原文件名）；时间来自文件修改时间、也写进 m4a；页面上写着转成 m4a 前后多大', async () => {
  const env = setup();
  try {
    const main = env.openImport();
    const f = wavFile('测试录音 1.wav'), W = await sha256Hex(f);
    await env.pick(main, [f]);
    await settled(env);
    const row = byCls(main, 'im-row');
    assert.ok(row, main.textContent);
    const meta = byCls(row, 'im-meta').textContent;
    assert.ok(meta.startsWith('转成 m4a：') && meta.includes(' → '), meta);
    assert.equal(byCls(row, 'im-kept'), undefined);
    assert.ok(byCls(row, 'im-src').textContent.includes(t('imp.src.file')));
    await goBtn(main).fire('click');
    await until(() => env.navs.length, '导入完');
    const e = live(state.getState())[0];
    assert.equal(env.navs[0], '/e/' + encodeURIComponent(e.id));
    const c = e.audio[0];
    assert.deepEqual([c.mime, c.origName, c.srcSha256, c.durationSec, e.timeSource, e.source.kind], ['audio/mp4', '测试录音 1.wav', W, 2, 'file', 'audio-import']);
    assert.notEqual(c.sha256, W);
    const stored = await env.audio.getClip(c.sha256);
    assert.equal(stored.mime, 'audio/mp4');
    assert.equal(c.bytes, stored.blob.size);
    assert.ok(stored.blob.size < f.size / 3, `${stored.blob.size} vs ${f.size}`);
    assert.equal(c.sha256, await sha256Hex(stored.blob));
    assert.equal(await env.audio.getClip(W), null, '原文件不存');
    assert.equal(env.audio.clips.size, 1);
    const m = readMp4Meta(await stored.blob.arrayBuffer());
    assert.equal(m.createdAt.getTime(), LM, 'm4a 的 creation_time = 文件修改时间（条目的时间也从这来）');
    assert.equal(m.durationSec, 2);
  } finally { env.done(); }
});

test('导入录音：已经是 m4a 的（语音备忘录）原样存、不转；时间来自录音文件；拖进窗口的（别的页面上拖的 takeFiles、导入页上拖的）也一样走这条路，WAV 照样转', async () => {
  const env = setup();
  try {
    const m = await m4aFile('测试录音 2.m4a'), M = await sha256Hex(m);
    env.dropped = [m, wavFile('测试录音 3.wav', 3)];
    const main = env.openImport();
    await settled(env);
    assert.equal(allCls(main, 'im-row').length, 2, main.textContent);
    await goBtn(main).fire('click');
    await until(() => env.navs.length, '导入完');
    const clips = live(state.getState()).flatMap(e => e.audio.map(a => ({ ...a, ts: e.timeSource })));
    const a = clips.find(x => x.origName === '测试录音 2.m4a'), w = clips.find(x => x.origName === '测试录音 3.wav');
    assert.deepEqual([a.sha256, a.srcSha256, a.mime, a.ts], [M, undefined, 'audio/mp4', 'mp4']);
    assert.equal(new Uint8Array(await (await env.audio.getClip(M)).blob.arrayBuffer()).length, m.size);
    assert.deepEqual([w.mime, !!w.srcSha256, w.ts], ['audio/mp4', true, 'file']);
    // 导入页开着时拖到窗口里（捕获阶段的 drop）：一样转
    env.navs.length = 0;
    const main2 = env.openImport();
    for (const fn of window.events.drop || []) fn({ dataTransfer: { files: [wavFile('拖进来的.wav', 14)] }, preventDefault() {} });
    await settled(env);
    assert.ok(byCls(main2, 'im-meta').textContent.startsWith('转成 m4a：'), main2.textContent);
    await goBtn(main2).fire('click');
    await until(() => env.navs.length, '导入完');
    const dropped = live(state.getState()).flatMap(e => e.audio).find(x => x.origName === '拖进来的.wav');
    assert.deepEqual([dropped.mime, !!dropped.srcSha256], ['audio/mp4', true]);
  } finally { env.done(); }
});

test('导入录音：转不了的（浏览器编不了、编码器出错、核对不过、超时、超过 30 分钟）原样存原来的文件，那一行上说一句；导入不卡住', async () => {
  const cases = [
    ['unsupported', () => fakeBrowser({ encoder: { supported: () => false } }).opts, 'imp.kept'],
    ['error', () => fakeBrowser({ encoder: { failAt: 1 } }).opts, 'imp.kept'],
    ['check', () => fakeBrowser({ ac: { silent: true } }).opts, 'imp.kept'],
    ['timeout', () => ({ ...fakeBrowser({ encoder: { flushHang: true } }).opts, timeoutMs: 30 }), 'imp.kept'],
    ['long', () => fakeBrowser().opts, 'imp.keptLong'],
    ['downmix', () => fakeBrowser().opts, 'imp.kept'],
    ['bigger', () => fakeBrowser().opts, 'imp.keptSmall'],
  ];
  const fileFor = (why) => {
    if (why === 'long') return wavFile(`很长的 ${why}.wav`, 5, 1, { byteRate: 40 });
    if (why === 'downmix') { const L = tone(2 * 48000, 5); return new File([wavBytes([L, Int16Array.from(L, x => -x)], 48000)], '反相的.wav', { type: 'audio/wav', lastModified: LM }); }
    if (why === 'bigger') return new File([wavBytes([tone(2 * 8000, 5)], 8000)], '8k 的.wav', { type: 'audio/wav', lastModified: LM });
    return wavFile(`测试 ${why}.wav`, 5);
  };
  for (const [why, opts, key] of cases) {
    const env = setup({ m4a: opts() });
    try {
      const main = env.openImport();
      const f = fileFor(why), W = await sha256Hex(f);
      await quiet(async () => { await env.pick(main, [f]); await settled(env); });
      const row = byCls(main, 'im-row');
      assert.ok(row, why + ' ' + main.textContent);
      assert.equal(byCls(row, 'im-kept').textContent, t(key), why);
      assert.equal(cls(byCls(row, 'im-kept'), 'calm'), why === 'bigger', why + '：原文件已经够小不是出了问题（不标黄）');
      assert.ok(!byCls(row, 'im-meta').textContent.includes('m4a：'), why);
      await goBtn(main).fire('click');
      await until(() => env.navs.length, '导入完 ' + why);
      const c = live(state.getState())[0].audio[0];
      assert.deepEqual([c.sha256, c.mime, c.srcSha256, c.origName], [W, 'audio/wav', undefined, f.name], why);
      assert.equal((await env.audio.getClip(W)).blob.size, f.size, why);
      assert.equal(env.audio.clips.size, 1, why);
    } finally { env.done(); }
  }
});

test('导入录音：同一个 WAV 再导一次认得出（编码器每次编出来不一样，靠原文件的 sha256），在「最近删除」里的也认得出；一次选了两遍的只转一次', async () => {
  const b = fakeBrowser(), env = setup({ m4a: b.opts });
  try {
    let main = env.openImport();
    const f = wavFile('测试录音 4.wav', 4), W = await sha256Hex(f);
    await env.pick(main, [f, wavFile('测试录音 4 副本.wav', 4)]);
    await settled(env);
    assert.equal(allCls(main, 'im-row').length, 1);
    assert.deepEqual(skippedText(main), ['测试录音 4 副本.wav' + t('imp.skip.dupBatch')]);
    assert.equal(b.enc.configs.length, 1, '第二个没去转');
    await goBtn(main).fire('click');
    await until(() => env.navs.length, '导入完');
    const e = live(state.getState())[0], M = e.audio[0].sha256;
    // 再编一次是另一个 m4a（证明下面是靠 srcSha256 认出来的）
    const again = await (await import('../src/core/importM4a.js')).importM4a({ blob: f }, fakeBrowser().opts);
    assert.notEqual(again.sha256, M);
    main = env.openImport();
    await env.pick(main, [wavFile('测试录音 4.wav', 4)]);
    await settled(env);
    assert.equal(allCls(main, 'im-row').length, 0);
    assert.equal(skippedText(main).length, 1);
    assert.ok(skippedText(main)[0].startsWith('测试录音 4.wav已经导入过：在「') && !skippedText(main)[0].includes('最近删除'), skippedText(main)[0]);
    assert.equal(b.enc.configs.length, 1, '认出来了就不转');
    // 转出来的 m4a（分享出去又拿回来的）也认得出：sha256 一样
    const out = new File([(await env.audio.getClip(M)).blob], '测试录音 4.m4a', { type: 'audio/mp4' });
    await env.pick(main, [out]);
    await settled(env);
    assert.equal(skippedText(main).length, 2);
    // 删掉那条（进「最近删除」）以后再导：「已经导入过：在最近删除里」
    env.ctx.remove(e.id);
    main = env.openImport();
    await env.pick(main, [wavFile('测试录音 4.wav', 4)]);
    await settled(env);
    assert.deepEqual(skippedText(main), ['测试录音 4.wav' + t('imp.skip.dupDeleted')]);
    assert.equal(env.audio.clips.size, 1, '没有多存一份');
  } finally { env.done(); }
});

test('导入录音：WAV 接到已有的一条（加到已有条目）也是转成 m4a 的那份', async () => {
  const env = setup();
  try {
    state.mutate(s => { s.data.entries.a = makeEntry({ id: 'a', date: '2026-11-18', text: `${NN}“编的一句”` }); });
    const main = env.openImport();
    await env.pick(main, [wavFile('接上的.wav', 7)]);
    await settled(env);
    await btn(main, t('imp.mode.attach')).fire('click');
    await goBtn(main).fire('click');
    await until(() => env.navs.length, '导入完');
    assert.deepEqual(env.navs, ['/e/a']);
    assert.deepEqual(raw('a').audio.map(x => [x.mime, x.origName, !!x.srcSha256]), [['audio/mp4', '接上的.wav', true]]);
  } finally { env.done(); }
});

test('从备忘录迁移不转：选的 WAV 原样存', async () => {
  const env = setup();
  try {
    const main = env.openImport('notes');
    const ta = find(main, el => el.tag === 'textarea');
    ta.value = ['2024', '', '5/20', `${NN}“编的第一句”`, '￼'].join('\n'); await ta.fire('input');
    await find(main, el => el.tag === 'button' && cls(el, 'big') && cls(el, 'block')).fire('click');
    for (let i = 0; i < 20; i++) await tick();
    const f = wavFile('备忘录 1.wav', 8), W = await sha256Hex(f);
    await env.pick(main, [f]);
    await until(() => main.textContent.includes('备忘录 1.wav'), '读完');
    await find(main, el => el.tag === 'button' && cls(el, 'big') && cls(el, 'block') && !el.disabled).fire('click');
    for (let i = 0; i < 20; i++) await tick();
    await byCls(main, 'im-ok').fire('click');                   // 只按顺序配的：点「没问题」
    const go = btn(main, t('imp.r.go', { n: 1 }));
    assert.ok(go, main.textContent);
    await go.fire('click');
    await until(() => live(state.getState()).length, '导入完');
    const c = live(state.getState())[0].audio[0];
    assert.deepEqual([c.sha256, c.mime, c.srcSha256], [W, 'audio/wav', undefined]);
  } finally { env.done(); }
});

// ---------- 详情页 ⋯「添加录音（文件）」 ----------
test('详情页「添加录音（文件）」：WAV 转成 m4a 再存；同一个再加一次说「已经在这条里了」、不转不存（录音库里没有多一份）；别的条目里有也照样加、说一句；转不了的说一句', async () => {
  const b = fakeBrowser(), env = setup({ m4a: b.opts });
  try {
    state.mutate(s => {
      s.data.entries.a = makeEntry({ id: 'a', date: '2026-11-18', text: `${NN}“编的一句”` });
      s.data.entries.b = makeEntry({ id: 'b', date: '2026-11-16', text: `${NN}“另一句”` });
    });
    const main = new Element('main');
    const page = renderEntry(main, { name: 'entry', id: 'a' }, env.ctx, { m4a: b.opts });
    const input = () => find(main, el => el.tag === 'input' && el.attrs.type === 'file');
    const add = async (files) => { input().files = files; await input().fire('change'); await until(() => env.toasts.some(x => x.msg && !x.msg.startsWith(t('entry.converting'))), '加好'); };
    const f = wavFile('详情页加的.wav', 11), W = await sha256Hex(f);
    await add([f]);
    assert.ok(env.toasts.some(x => x.msg === t('entry.converting')), '转的时候先说一句');
    assert.ok(env.toasts.some(x => x.closed === t('entry.converting')), '转完收起来');
    const c = raw('a').audio[0];
    assert.deepEqual([c.mime, c.origName, c.srcSha256, c.durationSec], ['audio/mp4', '详情页加的.wav', W, 2]);
    assert.equal(env.audio.clips.size, 1);
    assert.equal(env.toasts.at(-1).msg, t('entry.audioAdded', { n: 1 }));
    env.toasts.length = 0;
    await add([wavFile('详情页加的（再一次）.wav', 11)]);
    assert.equal(raw('a').audio.length, 1);
    assert.equal(env.toasts.at(-1).msg, t('entry.audioDup', { name: '详情页加的（再一次）.wav' }));
    assert.equal(env.audio.clips.size, 1, '没转、没存');
    assert.equal(b.enc.configs.length, 1);
    page.cleanup();
    // b 那条也加同一个 WAV：照样加（又转了一次），说「也在另一条梦话里」
    const main2 = new Element('main'), page2 = renderEntry(main2, { name: 'entry', id: 'b' }, env.ctx, { m4a: b.opts });
    env.toasts.length = 0;
    const in2 = find(main2, el => el.tag === 'input' && el.attrs.type === 'file');
    in2.files = [wavFile('详情页加的.wav', 11)]; await in2.fire('change');
    await until(() => env.toasts.some(x => x.msg && x.msg.startsWith(t('entry.audioAdded', { n: 1 }))), '加好');
    assert.equal(env.toasts.at(-1).msg, [t('entry.audioAdded', { n: 1 }), t('entry.audioElsewhere', { name: '详情页加的.wav' })].join('\n'));
    assert.equal(raw('b').audio[0].srcSha256, W);
    page2.cleanup();
  } finally { env.done(); }
  // 转不了：存原来的 WAV，提示里说一句
  const env2 = setup();
  try {
    state.mutate(s => { s.data.entries.a = makeEntry({ id: 'a', date: '2026-11-18', text: `${NN}“编的一句”` }); });
    const main = new Element('main'), m4a = fakeBrowser({ encoder: { supported: () => false } }).opts;
    const page = renderEntry(main, { name: 'entry', id: 'a' }, env2.ctx, { m4a });
    const f = wavFile('转不了.wav', 12), W = await sha256Hex(f), input = find(main, el => el.tag === 'input' && el.attrs.type === 'file');
    input.files = [f]; await input.fire('change');
    await until(() => raw('a').audio.length, '加好');
    await until(() => env2.toasts.some(x => x.msg && x.msg.startsWith(t('entry.audioAdded', { n: 1 }))), '提示');
    assert.deepEqual([raw('a').audio[0].sha256, raw('a').audio[0].mime], [W, 'audio/wav']);
    assert.equal(env2.toasts.at(-1).msg, [t('entry.audioAdded', { n: 1 }), t('entry.kept', { name: '转不了.wav' })].join('\n'));
    page.cleanup();
  } finally { env2.done(); }
});

// ---------- 编辑页「添加录音」 ----------
/** 解原文件（第三个参数是 stats）要等 open()；核对时解 m4a 不等 */
function gatedCodec() {
  const b = fakeBrowser();
  let open, started = 0;
  const gate = new Promise(r => { open = r; });
  const decode = async (blob, sr, stats) => { if (stats) { started++; await gate; } return decodeMono(blob, { AC: b.opts.OfflineAudioContext, sr, stats }); };
  return { opts: { ...b.opts, decode }, open: () => open(), started: () => started, b };
}

test('编辑页「添加录音」：还在转 m4a 时点保存 → 等转完一起存（不丢）；还在转时离开要先问', async () => {
  const g = gatedCodec(), env = setup({ m4a: g.opts });
  try {
    state.mutate(s => { s.data.entries.e = makeEntry({ id: 'e', date: '2026-11-18', text: `${NN}“旧的一句”` }); });
    const main = new Element('main');
    env.page = renderEditor(main, { sub: 'edit', id: 'e', query: {} }, env.ctx, { m4a: g.opts });
    const input = find(main, el => el.tag === 'input' && el.attrs.type === 'file');
    const f = wavFile('慢慢转的.wav', 41), W = await sha256Hex(f);
    const small = new File([wavBytes([tone(2 * 8000, 44)], 8000)], '小的.wav', { type: 'audio/wav', lastModified: LM }), S = await sha256Hex(small);
    input.files = [f, small]; input.fire('change');
    await until(() => g.started() > 0, '开始解码');
    assert.equal(env.guard(), true, '还在转：离开前要问');
    const saving = find(main, el => cls(el, 'ed-save')).fire('click');
    for (let i = 0; i < 30; i++) await tick();
    assert.deepEqual(env.navs, [], '还在转：先不离开');
    assert.equal(raw('e').audio.length, 0);
    assert.equal(env.toasts.at(-1).msg, t('edit.waitConvert'), '点了保存：说一句转完就保存');
    await find(main, el => cls(el, 'ed-save')).fire('click');                // 再点一次：不重复保存
    g.open();
    await saving;
    await until(() => env.navs.length, '保存完');
    assert.deepEqual(env.navs, ['back:/e/e']);
    const c = raw('e').audio;
    assert.equal(c.length, 2, '转完的两段一起存进条目');
    assert.deepEqual([c[0].srcSha256, c[0].mime, c[0].origName], [W, 'audio/mp4', '慢慢转的.wav']);
    assert.deepEqual([c[1].sha256, c[1].mime, c[1].srcSha256], [S, 'audio/wav', undefined], '8 kHz 的：原文件已经够小，原样');
    assert.ok(await env.audio.getClip(c[0].sha256));
    assert.equal(env.toasts.at(-1).msg, [t('edit.saved'), t('entry.keptSmall', { name: '小的.wav' })].join('\n'), '没转成的那句不被「已保存」盖掉');
    assert.equal(env.guard(), false);
  } finally { g.open(); env.done(); }                        // 出错时也放开：转换是排着队的，别卡住后面的测试
});

test('编辑页「添加录音」：还在转 m4a 时确认了离开 → 转完不存、不加进条目（录音库里没有多出来没人用的一段）', async () => {
  const g = gatedCodec(), env = setup({ m4a: g.opts });
  try {
    state.mutate(s => { s.data.entries.e = makeEntry({ id: 'e', date: '2026-11-18', text: `${NN}“旧的一句”` }); });
    const main = new Element('main');
    const page = renderEditor(main, { sub: 'edit', id: 'e', query: {} }, env.ctx, { m4a: g.opts });
    const input = find(main, el => el.tag === 'input' && el.attrs.type === 'file');
    input.files = [wavFile('不要了.wav', 42), wavFile('也不要了.wav', 43)]; input.fire('change');
    await until(() => g.started() > 0, '开始解码');
    assert.equal(env.guard(), true);
    await find(main, el => el.tag === 'button' && cls(el, 'back')).fire('click');     // 取消（app 先问，确认了离开）
    page.cleanup();
    g.open();
    for (let i = 0; i < 300; i++) await tick();
    assert.equal(env.audio.clips.size, 0, '没存');
    assert.equal(g.started(), 1, '第二个不读了');
    assert.equal(raw('e').audio.length, 0);
    assert.ok(env.toasts.some(x => x.closed === t('entry.converting')), '「正在转成 m4a…」收起来');
  } finally { g.open(); env.done(); }
});

test('详情页「添加录音（文件）」：转之前先读时长（<audio>），超过 30 分钟的不去解码、原样存、说「超过 30 分钟」', async () => {
  const b = fakeBrowser(), env = setup({ m4a: b.opts });
  const had = globalThis.Audio;
  globalThis.Audio = class {
    removeAttribute() {} load() {}
    set src(v) { this._src = v; queueMicrotask(() => { this.duration = 31 * 60; if (this.onloadedmetadata) this.onloadedmetadata(); }); }
    get src() { return this._src; }
  };
  try {
    state.mutate(s => { s.data.entries.a = makeEntry({ id: 'a', date: '2026-11-18', text: `${NN}“编的一句”` }); });
    const main = new Element('main');
    env.page = renderEntry(main, { name: 'entry', id: 'a' }, env.ctx, { m4a: b.opts });
    const f = new File([Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4, 5, 6, 7, 8)], '很长的.mp3', { type: 'audio/mpeg', lastModified: LM }), W = await sha256Hex(f);
    const input = find(main, el => el.tag === 'input' && el.attrs.type === 'file');
    input.files = [f]; await input.fire('change');
    await until(() => raw('a').audio.length, '加好');
    await until(() => env.toasts.some(x => x.msg && x.msg.startsWith(t('entry.audioAdded', { n: 1 }))), '提示');
    const c = raw('a').audio[0];
    assert.deepEqual([c.sha256, c.mime, c.durationSec, c.srcSha256], [W, 'audio/mpeg', 31 * 60, undefined]);
    assert.equal(env.toasts.at(-1).msg, [t('entry.audioAdded', { n: 1 }), t('entry.keptLong', { name: '很长的.mp3' })].join('\n'));
    assert.deepEqual([b.ac.rates.length, b.enc.asked.length], [0, 0], '没去解码、也没问编码器');
  } finally { globalThis.Audio = had; env.done(); }
});

test('编辑页「添加录音」：WAV 转成 m4a 放进工作副本，保存时存进条目；同一个再加说「已经在这条里了」', async () => {
  const b = fakeBrowser(), env = setup({ m4a: b.opts });
  try {
    state.mutate(s => { s.data.entries.e = makeEntry({ id: 'e', date: '2026-11-18', text: `${NN}“旧的一句”` }); });
    const main = new Element('main');
    const page = renderEditor(main, { sub: 'edit', id: 'e', query: {} }, env.ctx, { m4a: b.opts });
    const input = () => find(main, el => el.tag === 'input' && el.attrs.type === 'file');
    const f = wavFile('编辑页加的.wav', 13), W = await sha256Hex(f);
    input().files = [f]; await input().fire('change');
    await until(() => env.audio.clips.size === 1, '存进录音库');
    for (let i = 0; i < 10; i++) await tick();
    env.toasts.length = 0;
    input().files = [wavFile('编辑页加的 2.wav', 13)]; await input().fire('change');
    await until(() => env.toasts.some(x => x.msg === t('entry.audioDup', { name: '编辑页加的 2.wav' })), '说已经在了');
    assert.equal(env.audio.clips.size, 1);
    await find(main, el => cls(el, 'ed-save')).fire('click');
    await until(() => raw('e').audio.length, '保存');
    const c = raw('e').audio[0];
    assert.deepEqual([c.mime, c.origName, c.srcSha256, c.durationSec], ['audio/mp4', '编辑页加的.wav', W, 2]);
    assert.equal(b.enc.configs.length, 1);
    page.cleanup();
  } finally { env.done(); }
});

test('导入录音：选了几个要转的，上面写着「正在转成 m4a，还有 n 个…」，转完才能点「导入」', async () => {
  const env = setup();
  try {
    const main = env.openImport();
    const seen = new Set(), canGo = [];
    const watch = () => {
      for (const n of [1, 2, 3]) if (main.textContent.includes(t('imp.converting', { n }))) { seen.add(n); if (n < 3) canGo.push(!goBtn(main).disabled); }
    };
    const picking = env.pick(main, [wavFile('一.wav', 31), wavFile('二.wav', 32), wavFile('三.wav', 33)]);
    for (let i = 0; i < 4000 && seen.size < 3; i++) { watch(); await tick(); }
    for (let i = 0; i < 200; i++) { watch(); await tick(); }
    await picking;
    assert.deepEqual([...seen].sort(), [1, 2, 3], '每转一个，剩下的少一个');
    assert.ok(canGo.length && canGo.every(x => x === false), '还在转（已经有转好的一行）：不能导入');
    await settled(env);
    assert.equal(allCls(main, 'im-row').length, 3);
    assert.equal(goBtn(main).disabled, false);
    assert.ok(!main.textContent.includes('正在转成'));
  } finally { env.done(); }
});

// ---------- 永久删除 ----------
test('永久删除以后：记号只有 m4a 的 sha256（没有 srcSha256）；再导同一个 WAV 和再导永久删除了的 m4a 一样——当成新的导进来；原样存过、永久删除了的 WAV 不会因为 srcSha256 又算「有条目在用」', async () => {
  const env = setup();
  try {
    let main = env.openImport();
    const f = wavFile('要永久删除的.wav', 21), W = await sha256Hex(f);
    await env.pick(main, [f]); await settled(env);
    await goBtn(main).fire('click'); await until(() => env.navs.length, '导入完');
    const e = live(state.getState())[0], M = e.audio[0].sha256;
    state.mutate(s => { s.data.entries[e.id] = deletedRecord(s.data.entries[e.id]); });
    state.mutate(s => { const x = s.data.entries[e.id]; s.data.entries[x.id] = purgedRecord(x, x.updatedAt); }, { cause: 'purge' });
    const tomb = raw(e.id);
    assert.equal(tomb.purged, true);
    assert.deepEqual(tomb.gone.map(g => Object.keys(g).sort()), [['from', 'mime', 'purgedAt', 'sha256']]);
    assert.deepEqual(tomb.gone.map(g => g.sha256), [M]);
    assert.ok(goneShas(state.getState()).has(M));
    assert.ok(!goneShas(state.getState()).has(W));
    // 再导同一个 WAV：不算「已经导入过」（墓碑里没有录音），当成新的导进来——和再导永久删除了的 m4a 一样
    env.navs.length = 0;
    main = env.openImport();
    await env.pick(main, [wavFile('要永久删除的.wav', 21)]); await settled(env);
    assert.equal(allCls(main, 'im-row').length, 1, main.textContent);
    await goBtn(main).fire('click'); await until(() => env.navs.length, '导入完');
    const again = live(state.getState())[0].audio[0];
    assert.equal(again.srcSha256, W);
    assert.ok(!goneShas(state.getState()).has(again.sha256));
    // 对照：永久删除了的 m4a 再导一次，今天也是这样当成新的导进来
    const m = await m4aFile('要永久删除的.m4a', 22), MM = await sha256Hex(m);   // 同一个文件导两次（假编码器每次编出来不一样：只编一次）
    env.navs.length = 0;
    main = env.openImport(); await env.pick(main, [m]); await settled(env);
    await goBtn(main).fire('click'); await until(() => env.navs.length, '导入完');
    const em = live(state.getState()).find(x => x.audio[0].sha256 === MM);
    state.mutate(s => { s.data.entries[em.id] = deletedRecord(s.data.entries[em.id]); });
    state.mutate(s => { const x = s.data.entries[em.id]; s.data.entries[x.id] = purgedRecord(x, x.updatedAt); }, { cause: 'purge' });
    assert.ok(goneShas(state.getState()).has(MM));
    env.navs.length = 0;
    main = env.openImport(); await env.pick(main, [new File([m], m.name, { type: m.type, lastModified: LM })]); await settled(env);
    assert.equal(allCls(main, 'im-row').length, 1);
    await goBtn(main).fire('click'); await until(() => env.navs.length, '导入完');
    assert.ok(!goneShas(state.getState()).has(MM), '重新导入过：不再算没了');
  } finally { env.done(); }
  // 转不了、原样存了 WAV（sha256 = W）→ 永久删除（记号 W）→ 后来再导、这次转成了（srcSha256 = W）：W 还是没了，不会被 srcSha256 找回来
  const env2 = setup({ m4a: fakeBrowser({ encoder: { supported: () => false } }).opts });
  try {
    let main = env2.openImport();
    const f = wavFile('先原样存的.wav', 23), W = await sha256Hex(f);
    await quiet(async () => { await env2.pick(main, [f]); await settled(env2); });
    await goBtn(main).fire('click'); await until(() => env2.navs.length, '导入完');
    const e = live(state.getState())[0];
    assert.equal(e.audio[0].sha256, W);
    state.mutate(s => { s.data.entries[e.id] = deletedRecord(s.data.entries[e.id]); });
    state.mutate(s => { const x = s.data.entries[e.id]; s.data.entries[x.id] = purgedRecord(x, x.updatedAt); }, { cause: 'purge' });
    assert.ok(goneShas(state.getState()).has(W));
    env2.m4a = fakeBrowser().opts;
    env2.navs.length = 0;
    main = env2.openImport();
    await env2.pick(main, [wavFile('先原样存的.wav', 23)]); await settled(env2);
    await goBtn(main).fire('click'); await until(() => env2.navs.length, '导入完');
    const c = live(state.getState())[0].audio[0];
    assert.equal(c.srcSha256, W);
    assert.ok(goneShas(state.getState()).has(W), 'W 还是没了（会在各台设备、仓库里删掉）');
    assert.ok(!claimShas(state.getState()).has(W));
    assert.ok(!referencedClips(state.getState(), { includeDeleted: true, includeRemoved: true }).has(W), '同步不会去传 W');
  } finally { env2.done(); }
});

// ---------- 数据层 ----------
test('srcSha256：整理时改小写、坏的去掉；clipKeys / sameClip / clipIndex withSrc 两个都认，默认的 clipIndex 只认 sha256', () => {
  const A = 'a'.repeat(64), B = 'B'.repeat(64);
  const e = normalizeEntry(makeEntry({ id: 'x', audio: [{ sha256: A, srcSha256: B, mime: 'audio/mp4' }, { sha256: 'c'.repeat(64), srcSha256: 'nope' }, { sha256: 'd'.repeat(64) }] }));
  assert.equal(e.audio[0].srcSha256, B.toLowerCase());
  assert.ok(!('srcSha256' in e.audio[1]));
  assert.ok(!('srcSha256' in e.audio[2]));
  assert.deepEqual(clipKeys(e.audio[0]), [A, B.toLowerCase()]);
  assert.deepEqual(clipKeys(e.audio[2]), ['d'.repeat(64)]);
  assert.equal(sameClip({ sha256: 'e'.repeat(64), srcSha256: B.toLowerCase() }, e.audio[0]), true);
  assert.equal(sameClip({ sha256: B.toLowerCase() }, e.audio[0]), true);
  assert.equal(sameClip({ sha256: 'e'.repeat(64) }, e.audio[0]), false);
  const s = { data: { entries: { x: e, y: { ...makeEntry({ id: 'y', audio: [{ sha256: 'f'.repeat(64), srcSha256: A }] }), deleted: true } } } };
  assert.deepEqual(clipIndex(s).get(B.toLowerCase()), undefined);
  assert.deepEqual(clipIndex(s, { withSrc: true }).get(B.toLowerCase()), ['x']);
  assert.deepEqual(clipIndex(s, { withSrc: true }).get(A), ['x']);
  assert.deepEqual(clipIndex(s, { withSrc: true, includeDeleted: true }).get(A), ['x', 'y']);
});


test('两个录音导入入口：大 WAV 不整份 arrayBuffer，不复制文件，哈希和原始声音保持一致', async () => {
  const f=wavFile('合成大文件.wav',7,30), expected=await sha256Hex(f), nativeSlice=f.slice.bind(f), readSizes=[];
  f.arrayBuffer=()=>assert.fail('不得读取整个大文件');
  f.slice=(a,b,type)=>{
    const blob=nativeSlice(a,b,type), read=blob.arrayBuffer.bind(blob);
    blob.arrayBuffer=()=>{ readSizes.push(blob.size); assert.ok(blob.size<=1024*1024); return read(); };
    return blob;
  };
  const info=await readAudioFile(f);
  assert.equal(info.bad,undefined); assert.equal(info.sha256,expected);
  assert.equal(info.durationSec,30); assert.equal(info.blob.size,f.size);
  const audio=memoryStore(), notes=[];
  const clips=await readClipFiles([f],{audio,toast:()=>({close(){}})}, {notes,m4a:{AudioEncoder:null,AudioData:null}});
  assert.equal(clips.length,1); assert.equal(clips[0].clip.sha256,expected);
  assert.ok(readSizes.length>2 && readSizes.every(n=>n<=1024*1024));
});
