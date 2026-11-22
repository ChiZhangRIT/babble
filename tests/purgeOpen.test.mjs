// 开放永久删除（第二阶段，PURGE_ENABLED = true）那天，照着家里的情况冷启动真的 app.js：
// 几台设备都用过第一阶段（报过到、同步过），「最近删除」里有 1–10 天前删的几条（一条带一段 11 秒的误录）、一段移除的录音、一条录音页丢掉的空条目，
// 都还没到 30 天；第一阶段从来不写 babble.trash、trashSince、purgeNoticeAt。开着同步（仓库是假的，只答 babble.json 的读写）。
// 要看到：打开、同步以后一条都不删（仓库里也不删）；每一项从今天起算满 30 天（写着「30 天后永久删除」），差一点到也不删，过了才删；
// 第一次打开说一声 30 天的规矩。别的设备（Mac）先开放、云端已经有 trashSince 的也一样：这台设备照样从自己第一次看到起算满 30 天。
// 时钟：Date.now 换成「真的时间 + skew + fast」（app.js 的 purger 记下的就是这个函数）：skew 往后拨就是过了几天（服务器也跟着过），
// fast 是这台设备的时钟比服务器快多少（假仓库提交时回的 commit.committer.date 用服务器的时间）。全是编的：假的 localStorage、indexedDB、网络。
// 还有：时钟快两天的设备先开放（trashSince 按服务器的时间记）；晚 11 天才打开新版的设备（提示条说最早哪天永久删除，不说「从今天开始算」）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Element, fakeStorage, installDom } from './helpers/dom.mjs';
import { blankState, makeEntry, normalizeEntry, PURGE_MS } from '../src/core/store.js';
import { PURGE_ENABLED, TRASH_KEY } from '../src/core/purge.js';
import { daysLeft } from '../src/views/deleted.js';
import { fmtDate, localParts } from '../src/core/dates.js';
import { t } from '../src/i18n.js';

const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
const realNow = Date.now;
let skew = 0, fast = 0;
Date.now = () => realNow() + skew + fast;
/** 服务器上的时间（GitHub 回的提交时刻只到秒） */
const serverIso = () => new Date(Math.floor((realNow() + skew) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
after(() => { Date.now = realNow; });
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/** 家里的数据（编的）：T = 今天打开新版的时刻 */
function household(T) {
  const sha = (c) => c.repeat(64);
  const clip = (c, extra = {}) => ({ sha256: sha(c), mime: 'audio/mp4', bytes: 90000, durationSec: 4, origName: '', addedAt: T - 12 * DAY, ...extra });
  const live = (id, extra = {}) => makeEntry({ id, date: '2026-11-01', text: '编的原话 ' + id, ...extra }, T - 20 * DAY);
  const gone = (id, daysAgo, extra = {}) => normalizeEntry({ ...live(id, extra), deleted: true, deletedAt: T - daysAgo * DAY, updatedAt: T - daysAgo * DAY,
    deletedBy: { who: 'me', device: 'iPhone', at: T - daysAgo * DAY } }, id);
  const st = blankState();
  st.settings.nightOpensRecorder = false;                 // 夜里跑测试也停在列表（不进录音页）
  const E = st.data.entries;
  E.e_live = live('e_live');
  E.e_rm = normalizeEntry({ ...live('e_rm'), removedAudio: [clip('c', { removedAt: T - 4 * DAY })] }, 'e_rm');   // 编辑页移除的一段，4 天前
  E.e_d10 = gone('e_d10', 10, { text: '', status: 'todo', audio: [clip('a', { durationSec: 11 })] });           // 误录的 11 秒，10 天前删的
  E.e_d9 = gone('e_d9', 9);
  E.e_d6 = gone('e_d6', 6, { audio: [clip('b')] });
  E.e_d3 = gone('e_d3', 3);
  E.e_d1 = gone('e_d1', 1);
  E.e_disc = normalizeEntry({ ...gone('e_disc', 2, { text: '' }), discarded: true }, 'e_disc');                // 录音页「放弃这段录音」丢掉的空条目
  const dev = (id, name, who) => ({ id, name, who, build: 'babble-v28', features: ['purge1'], updatedAt: T - DAY, seenAt: T - DAY, since: T - DAY, whoAt: T - DAY });
  st.data.devices = { d_iphone: dev('d_iphone', 'iPhone', 'me'), d_mac: dev('d_mac', 'Mac', 'me'), d_nn: dev('d_nn', 'NN 的 iPhone', 'nn') };
  return st;
}
const TRASH = ['e:e_d10', 'e:e_d9', 'e:e_d6', 'e:e_d3', 'e:e_d1', 'e:e_disc', 'c:e_rm:' + 'c'.repeat(64)];
const SHOWN = TRASH.filter(k => k !== 'e:e_disc');      // 丢掉的空条目「最近删除」里不列

/** 假的私有仓库：只答仓库信息、babble.json 的读和写；别的（录音、Git Data API）都是 404。记下每个请求 */
function fakeRepo(state) {
  const repo = { json: { app: 'babble', v: 1, device: 'Mac', savedAt: new Date(realNow()).toISOString(), features: ['purge1'], state }, sha: 'j1', n: 1, log: [] };
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer });
  repo.fetch = async (url, init = {}) => {
    const method = init.method || 'GET', path = new URL(url).pathname;
    repo.log.push(method + ' ' + path);
    if (method === 'GET' && path === '/repos/me/dreams') return res(200, { full_name: 'me/dreams', private: true, visibility: 'private', default_branch: 'main' });
    if (path === '/repos/me/dreams/contents/babble.json') {
      if (method === 'GET') return res(200, { sha: repo.sha, encoding: 'base64', content: Buffer.from(JSON.stringify(repo.json)).toString('base64') });
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        if (body.sha !== repo.sha) return res(409, { message: 'conflict' });
        repo.json = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
        repo.sha = 'j' + (++repo.n);
        return res(200, { content: { sha: repo.sha }, commit: { sha: 'c' + repo.n, committer: { date: serverIso() } } });
      }
    }
    return res(404, { message: 'Not Found' });
  };
  return repo;
}

/** 空的 IndexedDB（录音库、床头模式、修改记录都没东西；写进去的不留） */
function emptyIDB() {
  const req = (result) => { const r = { result }; queueMicrotask(() => r.onsuccess && r.onsuccess({ target: r })); return r; };
  const index = () => ({ getAll: () => req([]), getAllKeys: () => req([]), openCursor: () => req(null), openKeyCursor: () => req(null) });
  const store = () => ({ getAll: () => req([]), get: () => req(null), count: () => req(0), put: () => req(null), add: () => req(1), delete: () => req(null), index });
  const db = { objectStoreNames: { contains: () => true }, close() {},
    transaction() { const tx = { objectStore: store, abort() {} }; setImmediate(() => tx.oncomplete && tx.oncomplete()); return tx; } };
  return { open() { const r = {}; queueMicrotask(() => { r.result = db; r.onsuccess && r.onsuccess({ target: r }); }); return r; } };
}

/** 冷启动 app.js（开着同步，是这台 iPhone）；intervals 记下 setInterval（每小时的 30 天检查在里面）。
 *  preToast：启动前已经有一条提示条开着（找回录音之类）；timers：给了就记下 setTimeout（不给就不跑） */
async function boot(tag, { local, remote, preToast = null, timers = null }) {
  const T = Date.now();
  const repo = fakeRepo(remote(T));
  const storage = fakeStorage([['babble.state', JSON.stringify(household(T))], ['babble.local', JSON.stringify(local(T))]]);
  const loc = { hash: '#/', protocol: 'http:' }, intervals = [];
  const dom = installDom({ localStorage: storage, location: loc, history: { state: {}, replaceState(s, title, hash) { loc.hash = hash; } },
    navigator: { languages: ['zh-CN'], userAgent: 'Synthetic', platform: 'Synthetic', locks: { request(name, opts, cb) { return Promise.resolve().then(() => (cb || opts)({ name })); } } },
    matchMedia: () => ({ matches: false, addEventListener() {} }), fetch: repo.fetch, indexedDB: emptyIDB(),
    IDBKeyRange: { only: (x) => x, bound: (a, b) => [a, b] },
    MutationObserver: class { observe() {} disconnect() {} }, getComputedStyle: () => ({ bottom: '24px' }), requestAnimationFrame: () => 0,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: (fn, ms) => { if (timers) timers.push({ fn, ms }); return 0; } });
  dom.doc.visibilityState = 'visible';
  if (preToast) { const el = new Element('div'); el.id = 'toast'; el.className = 'on'; el.append(preToast); dom.doc.body.append(el); }
  const shell = new Element('div'); shell.className = 'app';
  for (const id of ['side', 'main']) { const el = new Element('div'); el.id = id; shell.append(el); }
  const tabs = new Element('nav'); tabs.id = 'tabs';
  dom.doc.body.append(shell, tabs);
  await import('../src/app.js?test=' + tag);
  const app = window.__babble;
  await app.ctx.recovered; await app.ctx.nightRecovered;
  await flush();
  const toastText = () => { const el = dom.doc.querySelector('#toast'); return el ? el.textContent : ''; };
  // 开机那轮同步（autoSync）排在前面：这一次 now() 等它们都做完
  const r = await app.ctx.sync.now();
  await flush();
  const S = () => app.state.getState(), E = () => S().data.entries;
  const hourly = () => { const x = intervals.find(i => i.ms === 3600000); assert.ok(x, '每小时的 30 天检查'); x.fn(); };
  const purgedIds = () => Object.values(E()).filter(e => e.purged).map(e => e.id).sort();
  const trash = () => JSON.parse(storage.getItem(TRASH_KEY) || '{}');
  return { T, repo, storage, dom, app, r, S, E, hourly, purgedIds, trash, toastText,
    // 收尾：先停同步（后台下载不再去网上），等手上的事做完，再换回没有 DOM 的环境（之后的 fetch 是真的网络）
    async done() { app.ctx.sync.stop(); await flush(30); app.state.setJournal(null); dom.restore(); } };
}
const deleteCalls = (repo) => repo.log.filter(x => x.startsWith('DELETE') || x.startsWith('POST') || x.startsWith('PATCH'));
const syncedLocal = (T) => ({ device: 'iPhone', who: 'me', whoAsked: true, deviceId: 'd_iphone',
  sync: { repo: 'me/dreams', token: 'synthetic', sha: 'j1', etag: null, dirty: false, at: T - DAY, err: null, offline: false } });

test('开放那天（这台 iPhone 先打开）：「最近删除」里 1–10 天前删的一条都不删、仓库也不动；从今天起算满 30 天，29 天多也不删，过了 30 天才删；第一次打开说一声', async () => {
  assert.equal(PURGE_ENABLED, true, '第二阶段：开关开着');
  skew = 0;
  const A = await boot('open-first', { local: syncedLocal, remote: (T) => household(T) });
  try {
    const { T, app, repo } = A, now = Date.now();
    assert.equal(A.r.ok, true, '同步成功');
    // 一条都没删
    assert.deepEqual(A.purgedIds(), []);
    assert.equal(A.E().e_rm.removedAudio.length, 1, '移除的录音还在');
    assert.ok(A.E().e_d10.deleted && A.E().e_d10.audio.length === 1, '误录的那条和它的录音都还在');
    assert.deepEqual(deleteCalls(repo), [], '仓库里什么都不删');
    // trashSince：这一次同步成功时写下（今天）；每一项这台设备第一次看到 = 今天打开的时候
    const since = A.S().settings.trashSince;
    assert.ok(since >= T && since <= now, 'trashSince 是今天');
    const seen = A.trash();
    assert.deepEqual(Object.keys(seen).map(k => k.split('|')[0]).sort(), [...TRASH].sort());
    for (const v of Object.values(seen)) assert.ok(v >= T && v <= now, '第一次看到 = 今天打开的时候，不是删除的时候');
    // 写着的日期：从今天起 30 天
    for (const k of SHOWN) {
      const { shownAt } = app.ctx.trashInfo(k);
      assert.ok(shownAt >= T + PURGE_MS, k);
      assert.equal(daysLeft(shownAt, now), 30, k);
    }
    // 第一次打开：提示条说 30 天的规矩，只说一次（记下 purgeNoticeAt）
    assert.equal(A.toastText(), t('deleted.policyNote'));
    assert.ok(app.state.getLocal().purgeNoticeAt >= T);
    // 再同步一次：trashSince 传上仓库，墓碑一个都没有
    await app.ctx.sync.now();
    assert.equal(repo.json.state.settings.trashSince, since);
    assert.ok(!Object.values(repo.json.state.data.entries).some(e => e.purged));
    // 过了 29 天 23 小时：同步以后、每小时的检查都不删
    skew = PURGE_MS - HOUR;
    await app.ctx.sync.now();
    A.hourly();
    assert.deepEqual(A.purgedIds(), []);
    assert.equal(daysLeft(app.ctx.trashInfo('e:e_d10').shownAt, Date.now()), 1);
    // 过了 30 天：每小时的检查删掉全部 7 项（6 条梦话 + 1 段移除的录音），传上仓库的是不含内容的记号
    skew = PURGE_MS + 5 * MIN;
    A.hourly();
    assert.deepEqual(A.purgedIds(), ['e_d1', 'e_d10', 'e_d3', 'e_d6', 'e_d9', 'e_disc']);
    const rm = A.E().e_rm;
    assert.ok(!rm.purged && !(rm.removedAudio || []).length && rm.gone.some(g => g.sha256 === 'c'.repeat(64)), '移除的录音换成记号，那条还在');
    assert.ok(!A.E().e_live.purged);
    for (const k of TRASH) assert.equal(app.ctx.trashInfo(k).shownAt, null, k);
    await app.ctx.sync.now();
    const R = repo.json.state.data.entries;
    assert.ok(R.e_d10.purged && R.e_d10.text === '' && !R.e_d10.audio.length && R.e_d10.gone.some(g => g.sha256 === 'a'.repeat(64)));
    assert.equal(R.e_live.text, '编的原话 e_live');
  } finally { skew = 0; await A.done(); }
});

test('开放那天（Mac 三小时前先开放了，云端已经有 trashSince）：这台 iPhone 照样从自己今天打开起算满 30 天；写着的日期按云端的 trashSince，不晚于真删的', async () => {
  skew = 0;
  const macAt = Date.now() - 3 * HOUR;
  const B = await boot('open-after-mac', { local: syncedLocal, remote: (T) => {
    const st = household(T);
    st.settings.trashSince = macAt; st.settingsAt.trashSince = macAt;
    st.data.devices.d_mac = { ...st.data.devices.d_mac, build: 'babble-v29', updatedAt: macAt, seenAt: macAt };
    return st;
  } });
  try {
    const { T, app, repo } = B;
    assert.equal(B.r.ok, true);
    assert.equal(B.S().settings.trashSince, macAt, '用 Mac 写的那个，不再写');
    assert.deepEqual(B.purgedIds(), []);
    assert.deepEqual(deleteCalls(repo), []);
    for (const k of SHOWN) assert.equal(app.ctx.trashInfo(k).shownAt, macAt + PURGE_MS, k);   // 不晚于哪台设备真删的（Mac 最早在这时删）
    assert.equal(B.toastText(), t('deleted.policyNote'));
    // Mac 那边到期了，这台还没到（从这台今天打开算）：不删
    skew = PURGE_MS - HOUR;
    await app.ctx.sync.now();
    B.hourly();
    assert.deepEqual(B.purgedIds(), []);
    assert.ok(Date.now() < T + PURGE_MS);
    skew = T + PURGE_MS - realNow() + MIN;
    B.hourly();
    assert.equal(B.purgedIds().length, 6);
  } finally { skew = 0; await B.done(); }
});

test('NN 的 iPhone 时钟快两天、它先开放：trashSince 记成服务器的时间（知道服务器几点以后挪回写下那一刻，再传上仓库）——时钟准的设备上写着的日期就是它真删的时候，不会晚两天', async () => {
  skew = 0; fast = 2 * DAY;
  const serverAt = realNow();
  const B = await boot('fast-first', { local: (T) => ({ ...syncedLocal(T), device: 'NN 的 iPhone', who: 'nn', deviceId: 'd_nn' }), remote: (T) => household(T) });
  try {
    const { app, repo } = B;
    assert.equal(B.r.ok, true);
    await app.ctx.sync.now(); await app.ctx.sync.now();       // 提交过 → 知道服务器几点 → 改；再传上去
    const since = B.S().settings.trashSince;
    assert.ok(since >= serverAt - 2000 && since <= realNow(), `服务器的时间，不是快了两天的（${since - serverAt}）`);
    assert.equal(repo.json.state.settings.trashSince, since, '改过的传上了仓库');
    assert.deepEqual(B.purgedIds(), []);
    assert.deepEqual(deleteCalls(repo), []);
    // 它自己按自己的钟、从自己第一次看到算满 30 天才删（真的时间：开放那一刻 + 30 天）；时钟准的设备上写着的是 trashSince + 30 天
    const realPurge = Math.min(...Object.values(B.trash())) + PURGE_MS - fast;
    assert.ok(Math.abs(since + PURGE_MS - realPurge) < 60e3, `差不到一分钟（改以前差两天）：${since + PURGE_MS - realPurge}`);
    skew = PURGE_MS - HOUR;
    B.hourly();
    assert.deepEqual(B.purgedIds(), [], '真的过了 29 天 23 小时：不删');
    skew = PURGE_MS + 5 * MIN;
    B.hourly();
    assert.equal(B.purgedIds().length, 6);
  } finally { skew = 0; fast = 0; await B.done(); }
});

test('晚 11 天才打开新版的 Mac：提示条不说「从今天开始算 30 天」，说最早哪天永久删除（和那一项下面写着的一样：按第一台开放那天、按删除的时间算）', async () => {
  skew = 0;
  const firstAt = Date.now() - 11 * DAY;
  const M = await boot('late-mac', { local: (T) => ({ ...syncedLocal(T), device: 'Mac', deviceId: 'd_mac' }), remote: (T) => {
    const st = household(T);
    st.settings.trashSince = firstAt; st.settingsAt.trashSince = firstAt;
    return st;
  } });
  try {
    const { app } = M;
    assert.equal(M.r.ok, true);
    assert.equal(M.S().settings.trashSince, firstAt);
    const shown = SHOWN.map(k => app.ctx.trashInfo(k).shownAt), first = Math.min(...shown);
    assert.equal(daysLeft(first), 20, '10 天前删的那条：开放以后第 30 天，还剩 20 天');
    assert.equal(first, app.ctx.trashInfo('e:e_d10').shownAt);
    assert.equal(M.toastText(), t('deleted.policyNoteAt', { date: fmtDate(localParts(first).date, 'zh-Hans', { year: false }) }));
    assert.notEqual(M.toastText(), t('deleted.policyNote'));
    assert.ok(M.app.state.getLocal().purgeNoticeAt > 0, '只说一次');
    assert.deepEqual(M.purgedIds(), []);
  } finally { skew = 0; await M.done(); }
});

test('第一次打开时正好有别的提示条开着（找回录音、带着按钮）：30 天的规矩等它收起再说，不盖掉它；说过就不再说', async () => {
  skew = 0;
  const timers = [];
  const A = await boot('pre-toast', { local: syncedLocal, remote: (T) => household(T), preToast: '编的：找回 1 段上次没保存完的录音', timers });
  try {
    const { app } = A;
    assert.equal(A.r.ok, true);
    assert.ok(A.S().settings.trashSince > 0);
    assert.equal(A.toastText(), '编的：找回 1 段上次没保存完的录音', '没被盖掉');
    assert.ok(!app.state.getLocal().purgeNoticeAt, '还没说');
    const toastEl = A.dom.doc.querySelector('#toast');
    toastEl.classList.remove('on');                          // 那条收起了
    for (const x of timers.splice(0).filter(x => x.ms === 3000)) x.fn();
    assert.equal(A.toastText(), t('deleted.policyNote'));
    assert.ok(app.state.getLocal().purgeNoticeAt > 0);
  } finally { skew = 0; await A.done(); }
});
