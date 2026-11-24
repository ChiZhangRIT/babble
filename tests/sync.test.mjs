import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createSync, toB64, fromB64, bytesToB64, b64ToBytes, gitBlobSha, parseTokenExpiry, syncCode, parseSyncCode, audioPath,
  referencedClips, SYNC_FILE, PURGE_KEY, FEATURES,
} from '../src/core/sync.js';
import { blankState, makeEntry, stamp, deletedRecord, restoredRecord, normalizeEntry, normalizeState, canon } from '../src/core/store.js';
import { createPurger } from '../src/core/purge.js';
import { sha256Hex } from '../src/core/sha256.js';

// 测试只用编出来的数据。
// 模拟 GitHub：contents API（文件、git blob sha、ETag/304、409（sha 过期）、422（文件已存在但没给 sha）、>1MB 只给 raw、DELETE），
// 每次写文件都是分支上的一个提交（gh.head → gh.objs：提交 sha → { files, parents, message, date }）；
// Git Data API：GET git/ref、git/commits/:sha、git/trees/:sha（?recursive=1，gh.truncate = n 只给前 n 个文件并标 truncated）、
// POST git/trees（sha:null 删文件，删不存在的 → 422）、POST git/commits、PATCH git/refs（不是快进 → 422，force 直接改；gh.protected 不许强制）；
// commits?path=…（碰过这个文件的提交，新的在前）、commits?per_page=1（Link rel="last" = 提交数）、branches / tags。
// gh.files 是分支最新提交里的文件：测试直接改它 = 有人在 GitHub 网页上改了那一版
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function mockGitHub({ big = Infinity } = {}) {
  const gh = { log: [], puts: 0, n304: 0, private: true, faults: [], tokenExp: null, big,
    objs: new Map(), trees: new Map(), head: null, n: 0, at: null, branch: 'main', branches: ['main'], tags: [], protected: false, truncate: null };
  const res = (status, body, headers = {}) => {
    const hs = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (gh.tokenExp) hs['github-authentication-token-expiration'] = gh.tokenExp;
    const bytes = body instanceof Uint8Array ? body : null;
    return {
      status, ok: status >= 200 && status < 300, headers: { get: k => hs[k.toLowerCase()] ?? null },
      json: async () => (bytes ? JSON.parse(new TextDecoder().decode(bytes)) : body),
      text: async () => (bytes ? new TextDecoder().decode(bytes) : JSON.stringify(body)),
      arrayBuffer: async () => (bytes || new TextEncoder().encode(JSON.stringify(body))).slice().buffer,
    };
  };
  // 提交、树
  gh.commit = (files, parents, message) => {
    const sha = 'c' + (++gh.n);
    gh.objs.set(sha, { files, parents, message, date: new Date(gh.at ? gh.at() : Date.UTC(2026, 0, 1, 0, gh.n)).toISOString() });
    return sha;
  };
  gh.head = gh.commit(new Map(), [], '初始提交');
  Object.defineProperty(gh, 'files', { get: () => gh.objs.get(gh.head).files });
  const keepTree = (files) => {
    const sha = 't' + createHash('sha1').update(JSON.stringify([...files].map(([p, f]) => [p, f.sha]).sort())).digest('hex').slice(0, 16);
    if (!gh.trees.has(sha)) gh.trees.set(sha, new Map(files));
    return sha;
  };
  /** 有人（网页上、别的设备）在分支上提交了一个文件 / 删了一个文件 */
  gh.putFile = (path, bytes, message = '网页上传') => { const f = new Map(gh.files); f.set(path, { bytes, sha: blobSha(bytes) }); gh.head = gh.commit(f, [gh.head], message); };
  gh.dropFile = (path, message = '网页删除') => { const f = new Map(gh.files); f.delete(path); gh.head = gh.commit(f, [gh.head], message); };
  /** 旧版本（没有 features）或别的设备直接写 babble.json：fn 改 state */
  gh.pushJson = (fn, { device = '旧版 iPad', features = null } = {}) => {
    const j = gh.files.has(SYNC_FILE) ? gh.json() : { app: 'babble', v: 1, state: blankState() };
    fn(j.state);
    const out = { app: 'babble', v: 1, device, savedAt: new Date().toISOString(), ...(features ? { features } : {}), state: j.state };
    gh.putFile(SYNC_FILE, new TextEncoder().encode(JSON.stringify(out)), `更新 ${SYNC_FILE}（${device}）`);
  };
  gh.chain = (from = gh.head) => { const out = []; for (let c = from; c; c = gh.objs.get(c).parents[0]) out.push(c); return out; };
  const fileSha = (c, p) => { const f = c && gh.objs.get(c).files.get(p); return f ? f.sha : null; };
  gh.touching = (p) => gh.chain().filter(c => fileSha(c, p) !== fileSha(gh.objs.get(c).parents[0], p));
  // babble.json 的提交记录（新的在前）
  Object.defineProperty(gh, 'commits', { get: () => gh.touching(SYNC_FILE).map(sha => { const c = gh.objs.get(sha); return { sha, message: c.message, date: c.date, bytes: c.files.get(SYNC_FILE).bytes }; }) });
  const isAncestor = (anc, from) => {
    const seen = new Set(), todo = [from];
    while (todo.length) { const c = todo.pop(); if (c === anc) return true; if (!c || seen.has(c) || !gh.objs.has(c)) continue; seen.add(c); todo.push(...gh.objs.get(c).parents); }
    return false;
  };
  const refName = () => 'heads/' + gh.branch.split('/').map(encodeURIComponent).join('/');
  const listCommit = sha => ({ sha, commit: { message: gh.objs.get(sha).message, committer: { date: gh.objs.get(sha).date } } });
  function gitApi(method, p, body) {
    let m;
    if (method === 'GET' && p === 'ref/' + refName()) return gh.head ? res(200, { ref: 'refs/' + refName(), object: { sha: gh.head, type: 'commit' } }) : res(409, { message: 'Git Repository is empty.' });
    if (method === 'GET' && (m = p.match(/^commits\/(\w+)$/))) {
      const c = gh.objs.get(m[1]);
      return c ? res(200, { sha: m[1], tree: { sha: keepTree(c.files) }, parents: c.parents.map(sha => ({ sha })), message: c.message }) : res(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = p.match(/^trees\/(\w+)(\?recursive=1)?$/))) {
      const t = gh.trees.get(m[1]);
      if (!t) return res(404, { message: 'Not Found' });
      const blobs = [...t].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, f]) => ({ path, mode: '100644', type: 'blob', sha: f.sha, size: f.bytes.length }));
      const dirs = [...new Set(blobs.filter(b => b.path.includes('/')).map(b => b.path.split('/')[0]))].map(d => ({ path: d, mode: '040000', type: 'tree', sha: 'd' + d }));
      if (!m[2]) return res(200, { sha: m[1], tree: [...dirs, ...blobs.filter(b => !b.path.includes('/'))], truncated: false });
      const cut = gh.truncate != null;
      return res(200, { sha: m[1], tree: [...dirs, ...(cut ? blobs.slice(0, gh.truncate) : blobs)], truncated: cut });
    }
    if (method === 'POST' && p === 'trees') {
      const base = gh.trees.get(body.base_tree);
      if (!base) return res(422, { message: 'Invalid tree' });
      const files = new Map(base);
      for (const e of body.tree) {
        if (e.sha !== null) return res(422, { message: '测试只删文件' });
        if (!files.has(e.path)) return res(422, { message: 'GitRPC::BadObjectState' });
        files.delete(e.path);
      }
      return res(201, { sha: keepTree(files) });
    }
    if (method === 'POST' && p === 'commits') {
      const t = gh.trees.get(body.tree);
      if (!t || !(body.parents || []).every(x => gh.objs.has(x))) return res(422, { message: 'Invalid' });
      return res(201, { sha: gh.commit(new Map(t), [...(body.parents || [])], body.message) });
    }
    if (method === 'PATCH' && p === 'refs/' + refName()) {
      if (!gh.objs.has(body.sha)) return res(422, { message: 'Object does not exist' });
      if (body.force && gh.protected) return res(422, { message: 'Cannot force-push to this protected branch' });
      if (!body.force && !isAncestor(gh.head, body.sha)) return res(422, { message: 'Update is not a fast forward' });
      gh.head = body.sha;
      return res(200, { ref: 'refs/' + refName(), object: { sha: body.sha } });
    }
    return res(404, { message: 'Not Found' });
  }
  gh.fetch = async (url, opt = {}) => {
    const method = opt.method || 'GET', h = opt.headers || {};
    const path = url.replace('https://api.github.com', '');
    gh.log.push(`${method} ${path}`);
    assert.match(h.Authorization, /^Bearer /);
    const fault = gh.faults.findIndex(f => (!f.method || f.method === method) && path.includes(f.path || ''));
    if (fault >= 0) {
      const f = gh.faults[fault];
      if (!f.times || --f.times <= 0) gh.faults.splice(fault, 1);
      if (f.throws) throw new TypeError('Load failed');
      if (f.before) f.before();
      if (f.status) return res(f.status, { message: f.message || 'fault' }, f.headers || {});
    }
    const body = opt.body ? JSON.parse(opt.body) : null;
    if (path === '/repos/me/data') {
      if (h.Authorization !== 'Bearer t') return res(401, { message: 'Bad credentials' });
      return res(200, { full_name: 'me/data', private: gh.private, visibility: gh.private ? 'private' : 'public', default_branch: gh.branch });
    }
    if (!path.startsWith('/repos/me/data/')) return res(404, {});
    const sub = path.slice('/repos/me/data/'.length);
    let m;
    // 提交记录：碰过某个文件的（修改记录的云端历史、找没人用的录音），或者全部（数提交）
    if ((m = sub.match(/^commits\?path=([^&]+)&per_page=(\d+)(?:&page=(\d+))?$/))) {
      const per = +m[2], page = +(m[3] || 1);
      return res(200, gh.touching(decodeURIComponent(m[1])).slice((page - 1) * per, page * per).map(listCommit));
    }
    if ((m = sub.match(/^commits\?per_page=(\d+)$/))) {
      const all = gh.chain(), per = +m[1], last = Math.ceil(all.length / per);
      const link = last > 1 ? { Link: `<https://api.github.com/repos/me/data/commits?per_page=${per}&page=2>; rel="next", <https://api.github.com/repos/me/data/commits?per_page=${per}&page=${last}>; rel="last"` } : {};
      return res(200, all.slice(0, per).map(listCommit), link);
    }
    if ((m = sub.match(/^(branches|tags)\?per_page=100$/))) return res(200, gh[m[1]].map(name => ({ name })));
    if (sub.startsWith('git/')) return gitApi(method, sub.slice(4), body);
    const cm = sub.match(/^contents\/([^?]+)(?:\?ref=(\w+))?$/);
    if (!cm) return res(404, {});
    if (cm[2]) {                                       // 某次提交时的文件（只给原文）
      const c = gh.objs.get(cm[2]), f = c && c.files.get(cm[1]);
      return f && h.Accept === 'application/vnd.github.raw+json' ? res(200, f.bytes) : res(404, { message: 'Not Found' });
    }
    const name = cm[1], file = gh.files.get(name);
    if (method === 'GET') {
      if (!file) return res(404, { message: 'Not Found' });
      if (h.Accept === 'application/vnd.github.raw+json') return res(200, file.bytes);
      const etag = `"e-${file.sha}"`;
      if (h['If-None-Match'] === etag) { gh.n304++; return res(304, null); }
      if (file.bytes.length > gh.big) {
        if (h.Accept !== 'application/vnd.github.object+json') return res(403, { message: 'too_large' });
        return res(200, { sha: file.sha, size: file.bytes.length, encoding: 'none', content: '' }, { ETag: etag });
      }
      return res(200, { sha: file.sha, size: file.bytes.length, encoding: 'base64', content: bytesToB64(file.bytes) }, { ETag: etag });
    }
    if (method === 'PUT') {
      if (file && !body.sha) return res(422, { message: '"sha" wasn\'t supplied.' });
      if (file && body.sha !== file.sha) return res(409, { message: 'does not match' });
      const bytes = b64ToBytes(body.content);
      gh.putFile(name, bytes, body.message);
      gh.puts++;
      return res(file ? 200 : 201, { content: { sha: gh.files.get(name).sha, size: bytes.length }, commit: { sha: gh.head, committer: { date: gh.objs.get(gh.head).date } } });
    }
    if (method === 'DELETE') {
      if (!file) return res(404, { message: 'Not Found' });
      if (body.sha !== file.sha) return res(409, { message: 'does not match' });
      gh.dropFile(name, body.message);
      return res(200, { commit: { sha: gh.head } });
    }
    return res(405, {});
  };
  gh.json = () => JSON.parse(new TextDecoder().decode(gh.files.get(SYNC_FILE).bytes));
  gh.writes = () => gh.log.filter(l => l.startsWith('PUT'));
  gh.gitWrites = () => gh.log.filter(l => /^(POST|PATCH) .*\/git\//.test(l));
  gh.deleteCommits = () => gh.chain().filter(c => /^删除录音/.test(gh.objs.get(c).message));
  return gh;
}

// 内存里的录音库（和 audioStore.js 一样的接口；putClip 像老版本一样不认 uploaded）
function memAudio() {
  const clips = new Map();
  return {
    clips,
    async putClip(blob, { mime } = {}) {
      const sha256 = await sha256Hex(blob), now = Date.now();
      if (!clips.has(sha256)) clips.set(sha256, { sha256, blob, mime: mime || blob.type || 'audio/mp4', bytes: blob.size, addedAt: now, uploaded: false });
      clips.get(sha256).touchedAt = now;
      return { sha256, mime: clips.get(sha256).mime, bytes: blob.size };
    },
    async getClip(sha) { return clips.get(sha) || null; },
    async hasClip(sha) { return clips.has(sha); },
    async listClips() { return [...clips.values()].map(({ blob, ...r }) => r); },
    async markUploaded(sha, v = true) { const r = clips.get(sha); if (r) r.uploaded = !!v; },
    async pendingUploads() { return (await this.listClips()).filter(r => !r.uploaded); },
    async deleteClips(shas, { stillGone = () => true, minAge = 0 } = {}) {
      const age = typeof minAge === 'function' ? minAge : () => minAge, out = [];
      for (const s of shas) { const r = clips.get(s); if (r && stillGone(s) && Date.now() - (r.touchedAt || r.addedAt || 0) >= age(s)) { clips.delete(s); out.push(s); } }
      return out;
    },
  };
}
function fakeStorage() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}

function device(gh, name, { token = 't', audio = memAudio(), storage = fakeStorage() } = {}) {
  const d = { name, state: blankState(), version: 0, cfg: { repo: 'me/data', token }, applied: [], statuses: [], local: { audioSync: {} }, audio, storage };
  /** 同一台设备再开一次（重新打开 App、另一个标签页）：同样的数据、设置、录音库和 localStorage */
  d.open = () => createSync({
    getState: () => d.state, applyRemote: (m, info) => { d.state = m; d.applied.push(info.device); },
    getConfig: () => d.cfg, saveConfig: () => {}, editVersion: () => d.version, device: name,
    audioStore: audio, onStatus: s => d.statuses.push(s), getLocal: () => d.local, saveLocal: () => {}, storage,
    fetch: (...a) => gh.fetch(...a),
  });
  d.sync = d.open();
  const changed = () => { d.version++; d.cfg.dirty = true; };
  d.put = (fields) => {
    const e = makeEntry({ date: '2026-01-02', text: '👰🏻‍♀️“今天吃什么”', ...fields });
    d.state.data.entries[e.id] = stamp(e, d.state.data.entries[e.id]);
    changed();
    return e;
  };
  d.record = async (text, fields = {}) => {
    const blob = new Blob([new TextEncoder().encode('假录音 ' + text)], { type: 'audio/mp4' });
    const c = await audio.putClip(blob, { mime: 'audio/mp4' });
    return d.put({ status: 'inbox', audio: [{ ...c, durationSec: 3, origName: '', addedAt: 1 }], ...fields });
  };
  d.entry = id => d.state.data.entries[id];
  d.edit = (id, patch, now = Date.now()) => { const cur = d.entry(id); d.state.data.entries[id] = stamp({ ...cur, ...patch }, cur, now); changed(); return d.entry(id); };
  d.trash = id => { d.state.data.entries[id] = deletedRecord(d.entry(id)); changed(); return d.entry(id); };
  d.restore = id => { d.state.data.entries[id] = restoredRecord(d.entry(id)); changed(); return d.entry(id); };
  // 永久删除：手写和设计里一样的形状（墓碑 / 移除的录音 / 记号），不依赖 store.js 的构造函数
  d.purge = (id, now = Date.now()) => {
    const cur = d.entry(id), from = cur.updatedAt;
    const gone = [...(cur.audio || []), ...(cur.removedAudio || [])].map(a => ({ sha256: a.sha256, mime: a.mime, purgedAt: now, from }));
    d.state.data.entries[id] = { id, updatedAt: Math.max(now, from + 1), purged: true, purgedAt: now, purgedFrom: from, deleted: true, deletedAt: now, gone };
    changed();
    return d.entry(id);
  };
  d.removeClip = (id, sha, now = Date.now()) => {
    const cur = d.entry(id), it = cur.audio.find(a => a.sha256 === sha), removedAt = Math.max(now, cur.updatedAt + 1);
    return d.edit(id, { audio: cur.audio.filter(a => a !== it), removedAudio: [...(cur.removedAudio || []), { ...it, removedAt }] });
  };
  d.purgeRemoved = (id, sha, now = Date.now()) => {
    const cur = d.entry(id), it = cur.removedAudio.find(a => a.sha256 === sha);
    return d.edit(id, { removedAudio: cur.removedAudio.filter(a => a !== it), gone: [...(cur.gone || []), { sha256: sha, mime: it.mime, purgedAt: now, from: it.removedAt }] });
  };
  d.run = async (opts) => { const r = await d.sync.syncNow(opts); await d.sync.idle(); return r; };
  d.P = () => JSON.parse(storage.getItem(PURGE_KEY) || 'null');
  return d;
}
const clipPath = (sha) => audioPath(sha, 'audio/mp4');

test('base64、同步码、git blob sha、令牌到期时间', async () => {
  assert.equal(fromB64(toB64('牙牙呓语 ✓ 👰🏻‍♀️')), '牙牙呓语 ✓ 👰🏻‍♀️');
  const bin = new Uint8Array(70000).map((_, i) => (i * 7) & 255);
  assert.deepEqual(b64ToBytes(bytesToB64(bin)), bin);
  assert.deepEqual(parseSyncCode('  ' + syncCode('me/babble-data', 'github_pat_ABC_123') + '\n'), { repo: 'me/babble-data', token: 'github_pat_ABC_123' });
  for (const bad of ['', 'house-ledger-sync:me/data:t', 'babble-sync:nodata:t', 'babble-sync:me/data:']) assert.equal(parseSyncCode(bad), null);
  // git hash-object 对 "hello\n" 的结果
  assert.equal(await gitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(parseTokenExpiry('2026-12-31 08:00:00 UTC'), Date.UTC(2026, 11, 31, 8));
  assert.equal(parseTokenExpiry('2026-12-31 00:00:00 -0800'), Date.UTC(2026, 11, 31, 8));
  assert.equal(parseTokenExpiry('soon'), null);
  assert.equal(audioPath('a'.repeat(64), 'audio/x-m4a'), `audio/${'a'.repeat(64)}.m4a`);
  assert.equal(audioPath('a'.repeat(64), 'audio/webm;codecs=opus'), `audio/${'a'.repeat(64)}.webm`);
});

test('服务器的时间（serverNow）：这次打开还没提交过 → null；提交 babble.json、传录音以后按回应里提交的时刻（commit.committer.date）往后推；这台设备的时钟快了也照样是服务器的', async () => {
  const gh = mockGitHub(), A = device(gh, 'NN 的 iPhone');
  gh.at = () => Date.now() - 2 * 864e5;                  // 这台设备的时钟比服务器快两天
  try {
    assert.equal(A.sync.serverNow(), null);
    await A.run();                                        // 云端什么都没有：新建 babble.json（提交了）
    const s1 = A.sync.serverNow(), want = Date.now() - 2 * 864e5;
    assert.ok(s1 <= want && s1 > want - 5000, '服务器的时间（秒以下舍掉，只会早一点）');
    const B = device(gh, 'iPhone');
    await B.run();                                        // 只拉，没提交
    assert.equal(B.sync.serverNow(), null, '没提交过：不知道');
    await B.record('编的一段');
    await B.run();                                        // 传录音、babble.json
    assert.ok(Math.abs(B.sync.serverNow() - (Date.now() - 2 * 864e5)) < 5000);
  } finally { gh.at = null; }
});

test('第一次同步：云端没有 babble.json（404）→ 新建，内容是 { app, v, device, savedAt, state }', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  const e = mac.put({});
  const r = await mac.run();
  assert.deepEqual(r, { ok: true });
  const j = gh.json();
  assert.equal(j.app, 'babble'); assert.equal(j.v, 1); assert.equal(j.device, 'Mac'); assert.ok(j.savedAt);
  assert.equal(j.state.data.entries[e.id].text, '👰🏻‍♀️“今天吃什么”');
  assert.equal(mac.cfg.dirty, false); assert.ok(mac.cfg.sha); assert.ok(mac.cfg.at);
  assert.equal(SYNC_FILE, 'babble.json');
});

test('拉取结果落盘时又接上另一个标签页的记录：仍标记待上传，不能把新记录漏在云端外', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  mac.put({ id: 'remote' }); await mac.run();
  let current = blankState();
  const cfg = { repo: 'me/data', token: 't', dirty: false };
  const sync = createSync({
    getState: () => current,
    applyRemote: merged => { current = merged; current.data.entries.local = makeEntry({ id: 'local', text: '另一页刚保存的' }); },
    getConfig: () => cfg, saveConfig() {}, editVersion: () => 0, device: '测试标签页', fetch: (...args) => gh.fetch(...args),
  });
  assert.equal((await sync.syncNow()).ok, true);
  await sync.idle();
  assert.deepEqual(Object.keys(gh.json().state.data.entries).sort(), ['local', 'remote']);
  assert.equal(cfg.dirty, false);
});

test('两台设备合并到一致；没变化时用 ETag 得到 304，不再提交', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac'), ipad = device(gh, 'iPad');
  mac.put({ id: 'e_1' });
  await mac.run();
  await ipad.run();
  assert.ok(ipad.state.data.entries.e_1);
  assert.deepEqual(ipad.applied, ['Mac']);
  ipad.put({ id: 'e_2' });
  mac.put({ id: 'e_3' });
  await ipad.run();
  await mac.run();                                    // 带着旧 sha 上传 → 409 → 重新拉取合并再传
  await ipad.run();
  for (const d of [mac, ipad]) assert.deepEqual(Object.keys(d.state.data.entries).sort(), ['e_1', 'e_2', 'e_3']);
  assert.deepEqual(Object.keys(gh.json().state.data.entries).sort(), ['e_1', 'e_2', 'e_3']);
  const puts = gh.puts;
  gh.log.length = 0;
  await mac.run(); await ipad.run();
  assert.equal(gh.puts, puts, '没有改动：不再提交');
  assert.equal(gh.log.filter(l => l.endsWith('/contents/babble.json')).length, 2, '每轮只问一次 babble.json');
  gh.n304 = 0;
  await mac.run(); await ipad.run();
  assert.equal(gh.n304, 2, '带 ETag 再问：304');
});

test('409 冲突：重新拉取、合并后再传，两边的修改都在', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac'), ipad = device(gh, 'iPad');
  mac.put({ id: 'e_1' }); await mac.run(); await ipad.run();
  // Mac 上传前一刻，iPad 抢先提交了
  ipad.put({ id: 'e_ipad' });
  mac.put({ id: 'e_mac' });
  const realFetch = gh.fetch;
  let raced = false;
  gh.fetch = async (url, opt) => {
    if (!raced && opt.method === 'PUT' && url.endsWith(SYNC_FILE)) { raced = true; await ipad.sync.syncNow(); }
    return realFetch(url, opt);
  };
  const r = await mac.sync.syncNow();
  assert.equal(r.ok, true);
  assert.ok(gh.log.some(l => l.startsWith('PUT') && l.endsWith(SYNC_FILE)));
  assert.deepEqual(Object.keys(gh.json().state.data.entries).sort(), ['e_1', 'e_ipad', 'e_mac']);
  assert.equal(mac.cfg.dirty, false);
});

test('上传 babble.json 返回 422：重新拉取再决定，不当成功', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  mac.put({ id: 'e_1' });
  gh.faults.push({ method: 'PUT', path: SYNC_FILE, status: 422 });
  assert.equal((await mac.run()).ok, true);
  assert.equal(gh.writes().length, 2);
  assert.ok(gh.json().state.data.entries.e_1);
});

test('超过 1MB 的 babble.json：object 格式只给 sha，再用 raw 取原文', async () => {
  const gh = mockGitHub({ big: 200 }), mac = device(gh, 'Mac'), ipad = device(gh, 'iPad');
  mac.put({ id: 'e_big', text: '👰🏻‍♀️“' + '今天吃什么'.repeat(50) + '”' });
  await mac.run();
  assert.ok(gh.files.get(SYNC_FILE).bytes.length > 200);
  await ipad.run();
  assert.equal(ipad.state.data.entries.e_big.text, mac.state.data.entries.e_big.text);
  assert.ok(gh.log.includes('GET /repos/me/data/contents/babble.json'));
});

test('上传前确认仓库是私有的：公开仓库不传；checkRepo 返回全名、401 → auth、找不到 → notFound', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  assert.equal(await mac.sync.checkRepo('me/data', 't'), 'me/data');
  await assert.rejects(mac.sync.checkRepo('me/data', 'wrong'), e => e.code === 'auth');
  await assert.rejects(mac.sync.checkRepo('me/nope', 't'), e => e.code === 'notFound');
  gh.private = false;
  await assert.rejects(mac.sync.checkRepo('me/data', 't'), e => e.code === 'public');
  mac.put({ id: 'e_1' });
  await mac.record('一');
  const r = await mac.run();
  assert.equal(r.ok, false); assert.equal(r.error.code, 'public');
  assert.equal(gh.puts, 0, '文字和录音都没传');
});

test('401 → auth（提示重新设置）；断网不算错误，只标离线', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac', { token: 'expired' });
  mac.put({ id: 'e_1' });
  const r = await mac.run();
  assert.equal(r.ok, false); assert.equal(r.error.code, 'auth'); assert.equal(mac.cfg.err.code, 'auth');
  const off = device(gh, 'iPad');
  gh.faults.push({ throws: true, times: 99 });
  const r2 = await off.run();
  assert.equal(r2.ok, false); assert.equal(r2.offline, true); assert.equal(off.cfg.err, null); assert.equal(off.cfg.offline, true);
});

test('请求太多（403 + 剩余 0）是 http 错误，不是权限问题', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  gh.faults.push({ path: '/repos/me/data', status: 403, headers: { 'X-RateLimit-Remaining': '0' } });
  const r = await mac.run();
  assert.equal(r.error.code, 'http'); assert.equal(r.error.vars.status, 403);
});

test('录音：先传录音再传 babble.json；云端已有同样内容的就只标记，不重传；没被条目引用的不传', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  const e = await mac.record('一');
  const sha = e.audio[0].sha256;
  const stray = await mac.audio.putClip(new Blob(['预览后取消的文件']), { mime: 'audio/mp4' });
  await mac.run();
  const writes = gh.writes();
  assert.deepEqual(writes.map(w => w.split('/').pop()), [`${sha}.m4a`, 'babble.json'], '录音在前');
  assert.equal((await mac.audio.getClip(sha)).uploaded, true);
  assert.equal((await mac.audio.getClip(stray.sha256)).uploaded, false);
  assert.ok(!gh.files.has(audioPath(stray.sha256, 'audio/mp4')));
  assert.equal(mac.sync.status().pendingUp, 0);
  // 另一台设备也有这段（比如两边都导入了同一个文件）：GET 200 且 sha 一样 → 不再 PUT
  const ipad = device(gh, 'iPad');
  await ipad.audio.putClip((await mac.audio.getClip(sha)).blob, { mime: 'audio/mp4' });
  ipad.put({ audio: e.audio });
  const before = gh.puts;
  await ipad.run();
  assert.equal(gh.puts, before + 1, '只传了 babble.json');
  assert.equal((await ipad.audio.getClip(sha)).uploaded, true);
});

test('录音 PUT 返回 422：重新 GET 决定——已经在了就算传好，不在就再传；一直不行就报 audioUp，文字照常同步', async () => {
  // 1) 422 时别的设备刚好传了同一段 → GET 看到 → 标记已上传
  let gh = mockGitHub(), mac = device(gh, 'Mac');
  let e = await mac.record('一');
  let sha = e.audio[0].sha256, path = audioPath(sha, 'audio/mp4');
  const bytes = new Uint8Array(await (await mac.audio.getClip(sha)).blob.arrayBuffer());
  const remoteSha = await gitBlobSha(bytes);
  gh.faults.push({ method: 'PUT', path: sha, status: 422, before: () => gh.files.set(path, { bytes, sha: remoteSha }) });
  await mac.run();
  assert.equal((await mac.audio.getClip(sha)).uploaded, true);
  assert.equal(gh.log.filter(l => l.includes(sha) && l.startsWith('GET')).length, 2, 'PUT 失败后又 GET 了一次');
  assert.equal(mac.sync.status().lastError, null);

  // 2) 422 后 GET 还是 404 → 再 PUT 一次成功
  gh = mockGitHub(); mac = device(gh, 'Mac');
  e = await mac.record('二'); sha = e.audio[0].sha256;
  gh.faults.push({ method: 'PUT', path: sha, status: 422 });
  await mac.run();
  assert.equal((await mac.audio.getClip(sha)).uploaded, true);
  assert.equal(gh.writes().filter(w => w.includes(sha)).length, 2);

  // 3) 一直 422 → 不标记、报 audioUp，babble.json 照样传，下一轮再试
  gh = mockGitHub(); mac = device(gh, 'Mac');
  e = await mac.record('三'); sha = e.audio[0].sha256;
  gh.faults.push({ method: 'PUT', path: sha, status: 422, times: 3 });
  const r = await mac.run();
  assert.equal(r.ok, true);
  assert.equal((await mac.audio.getClip(sha)).uploaded, false);
  assert.equal(mac.sync.status().lastError.code, 'audioUp');
  assert.equal(mac.sync.status().pendingUp, 1);
  assert.ok(gh.json().state.data.entries[e.id]);
  mac.put({}); await mac.run();
  assert.equal((await mac.audio.getClip(sha)).uploaded, true);
  assert.equal(mac.sync.status().lastError, null);
});

test('云端那份录音内容不对（以前传坏了）：带 sha 覆盖', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  const e = await mac.record('一');
  const sha = e.audio[0].sha256, path = audioPath(sha, 'audio/mp4');
  const broken = new TextEncoder().encode('坏的');
  gh.files.set(path, { bytes: broken, sha: await gitBlobSha(broken) });
  await mac.run();
  assert.equal((await mac.audio.getClip(sha)).uploaded, true);
  assert.equal(await sha256Hex(gh.files.get(path).bytes), sha);
});

test('下载：缺的录音按新条目在前一段段下，校验 sha256；校验不过的丢掉并报 shaMismatch；云端还没有的不算错', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac'), ipad = device(gh, 'iPad');
  const old = await mac.record('旧', { date: '2025-03-01' });
  const fresh = await mac.record('新', { date: '2026-11-04', time: '02:58' });
  const gone = await mac.record('删', { date: '2026-11-05' });
  mac.state.data.entries[gone.id] = stamp({ ...gone, deleted: true, deletedAt: Date.now() }, gone); mac.version++;
  const shaOld = old.audio[0].sha256, shaNew = fresh.audio[0].sha256, shaGone = gone.audio[0].sha256;
  const goneBytes = new Uint8Array(await (await mac.audio.getClip(shaGone)).blob.arrayBuffer());
  gh.files.set(audioPath(shaGone, 'audio/mp4'), { bytes: goneBytes, sha: await gitBlobSha(goneBytes) });   // 删除前已经传上去了
  await mac.run();
  gh.log.length = 0;
  await ipad.run();
  const gets = gh.log.filter(l => l.startsWith('GET') && l.includes('/contents/audio/')).map(l => l.split('/').pop().slice(0, 64));
  assert.deepEqual(gets, [shaNew, shaOld], '新的在前；已删除条目的录音后台不下载');
  for (const s of [shaOld, shaNew]) {
    const c = await ipad.audio.getClip(s);
    assert.equal(c.uploaded, true); assert.equal(c.mime, 'audio/mp4'); assert.equal(await sha256Hex(c.blob), s);
  }
  assert.equal(await ipad.audio.hasClip(shaGone), false);
  assert.equal(ipad.sync.status().pendingDown, 0);
  assert.ok(ipad.statuses.some(s => s.downloading));

  // 云端文件被改坏了 → 不存，报 shaMismatch
  const phone = device(gh, 'iPhone');
  const p = audioPath(shaNew, 'audio/mp4');
  const real = gh.files.get(p);
  gh.files.set(p, { bytes: new TextEncoder().encode('被改过'), sha: 'x' });
  await phone.run();
  assert.equal(await phone.audio.hasClip(shaNew), false);
  assert.equal(phone.sync.status().lastError.code, 'shaMismatch');
  assert.equal(phone.sync.status().pendingDown, 1);
  gh.files.set(p, real);

  // 对方还没传上来（404）→ 不报错，留着下次
  const watch = device(gh, 'Watch');
  gh.files.delete(audioPath(shaOld, 'audio/mp4'));
  await watch.run();
  assert.equal(await watch.audio.hasClip(shaOld), false);
  assert.equal(watch.sync.status().lastError, null);
  assert.equal(watch.sync.status().pendingDown, 1);

  // 同一个版本再同步：5 分钟内不再问云端；别的设备传了新版本（录音先传）→ 马上再试
  gh.log.length = 0;
  await watch.run();
  assert.equal(gh.log.filter(l => l.includes('/contents/audio/')).length, 0, '没有新版本：不重复问');
  gh.files.set(audioPath(shaOld, 'audio/mp4'), { bytes: new Uint8Array(await (await mac.audio.getClip(shaOld)).blob.arrayBuffer()), sha: 'later' });
  await mac.record('又一条', { date: '2026-11-06' });
  await mac.run();
  await watch.run();
  assert.equal(await watch.audio.hasClip(shaOld), true, '拿到新版本后马上下载');
});

test('getAudio：本机有就直接给；没有就马上下载、存好；同时要两次只下载一次；没开同步 → null', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac'), ipad = device(gh, 'iPad');
  const gone = await mac.record('删');
  mac.state.data.entries[gone.id] = stamp({ ...gone, deleted: true, deletedAt: Date.now() }, gone); mac.version++;
  const sha = gone.audio[0].sha256;
  const bytes = new Uint8Array(await (await mac.audio.getClip(sha)).blob.arrayBuffer());
  gh.files.set(audioPath(sha, 'audio/mp4'), { bytes, sha: await gitBlobSha(bytes) });   // 删除前已经传上去了
  await mac.run();
  await ipad.run();
  assert.equal(await ipad.audio.hasClip(sha), false, '已删除条目的录音不自动下载');
  gh.log.length = 0;
  const [a, b] = await Promise.all([ipad.sync.getAudio(sha), ipad.sync.getAudio(sha.toUpperCase())]);
  assert.equal(await sha256Hex(a), sha);
  assert.equal(a, b);
  assert.equal(gh.log.filter(l => l.includes(sha)).length, 1);
  assert.equal(await ipad.sync.getAudio(sha), (await ipad.audio.getClip(sha)).blob);
  assert.equal(gh.log.filter(l => l.includes(sha)).length, 1, '第二次直接用本机的');
  assert.equal(await ipad.sync.getAudio('f'.repeat(64)), null, '云端也没有');
  ipad.cfg = null;
  assert.equal(await ipad.sync.getAudio('e'.repeat(64)), null);
  assert.equal(await ipad.sync.getAudio('not-a-sha'), null);
});

test('换了仓库：以前标记的「已上传」作废，录音重新传到新仓库', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  const e = await mac.record('一');
  await mac.run();
  const sha = e.audio[0].sha256;
  assert.equal((await mac.audio.getClip(sha)).uploaded, true);
  assert.equal(mac.local.audioSync.repo, 'me/data');
  const gh2 = mockGitHub();
  const realFetch = gh2.fetch;
  gh2.fetch = (url, opt) => realFetch(url.replace('/repos/me/new', '/repos/me/data'), opt);
  mac.cfg = { repo: 'me/new', token: 't', dirty: true };
  const sync2 = createSync({
    getState: () => mac.state, applyRemote: (m) => { mac.state = m; }, getConfig: () => mac.cfg, saveConfig() {}, editVersion: () => mac.version,
    device: 'Mac', audioStore: mac.audio, getLocal: () => mac.local, saveLocal() {}, fetch: (...a) => gh2.fetch(...a),
  });
  await sync2.syncNow();
  assert.ok(gh2.files.has(audioPath(sha, 'audio/mp4')));
  assert.equal(mac.local.audioSync.repo, 'me/new');
});

test('状态：进度变化时通知；记下令牌到期时间；进度写进 local.audioSync', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  gh.tokenExp = '2027-02-01 00:00:00 UTC';
  await mac.record('一'); await mac.record('二');
  await mac.run();
  const ups = mac.statuses.map(s => s.pendingUp);
  assert.ok(ups.includes(2) && ups.includes(1) && ups.at(-1) === 0);
  assert.ok(mac.statuses.some(s => s.running) && !mac.sync.status().running);
  assert.equal(mac.cfg.tokenExp, Date.UTC(2027, 1, 1));
  assert.equal(mac.sync.status().tokenExpires, Date.UTC(2027, 1, 1));
  assert.equal(mac.local.audioSync.pendingUp, 0);
  assert.equal(mac.local.audioSync.pendingDown, 0);
});

test('referencedClips：只算没删除的条目，新的在前，同一段只算一次', () => {
  const s = blankState();
  const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
  s.data.entries.x = makeEntry({ id: 'x', date: '2024-01-01', audio: [{ sha256: A, mime: 'audio/mp4' }] });
  s.data.entries.y = makeEntry({ id: 'y', date: '2026-01-01', audio: [{ sha256: B, mime: 'audio/webm' }, { sha256: A, mime: 'audio/mp4' }] });
  s.data.entries.z = { ...makeEntry({ id: 'z', date: '2026-02-01', audio: [{ sha256: C, mime: 'audio/mp4' }] }), deleted: true };
  assert.deepEqual([...referencedClips(s)], [[B, 'audio/webm'], [A, 'audio/mp4']]);
  assert.deepEqual([...referencedClips(s, { includeDeleted: true }).keys()], [C, B, A]);
});

test('传某段录音时断网 / 超时：这一轮不再传别的录音，但文字照常拉取、上传', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  const a = await mac.record('一'), b = await mac.record('二');
  const shaA = a.audio[0].sha256, shaB = b.audio[0].sha256;
  gh.faults.push({ method: 'PUT', path: '/contents/audio/', throws: true });
  const r = await mac.run();
  assert.equal(r.ok, true);
  assert.ok(gh.json().state.data.entries[a.id], 'babble.json 照样传了');
  assert.equal(gh.writes().filter(w => w.includes('/contents/audio/')).length, 1, '第一段失败后这一轮不再试别的');
  assert.equal((await mac.audio.getClip(shaA)).uploaded || (await mac.audio.getClip(shaB)).uploaded, false);
  assert.equal(mac.sync.status().lastError.code, 'audioUp');
  assert.equal(mac.cfg.offline, false);
  mac.put({}); await mac.run();
  assert.equal((await mac.audio.getClip(shaA)).uploaded && (await mac.audio.getClip(shaB)).uploaded, true, '下一轮传上去了');
});

test('拉取到一半失败（大文件取原文时断网）：ETag 不记下，下一轮还会完整拉取、合并', async () => {
  const gh = mockGitHub({ big: 200 }), mac = device(gh, 'Mac'), ipad = device(gh, 'iPad');
  mac.put({ id: 'e_1' }); await mac.run();
  await ipad.run();
  mac.put({ id: 'e_big', text: '👰🏻‍♀️“' + '今天吃什么'.repeat(50) + '”' }); await mac.run();
  // object 格式的 GET 正常，接着取 raw 原文时断网
  const realFetch = gh.fetch;
  let n = 0;
  gh.fetch = async (url, opt = {}) => {
    if (url.endsWith(SYNC_FILE) && (opt.method || 'GET') === 'GET' && opt.headers.Accept === 'application/vnd.github.raw+json' && n++ === 0) throw new TypeError('Load failed');
    return realFetch(url, opt);
  };
  const r = await ipad.run();
  assert.equal(r.offline, true);
  assert.equal(ipad.state.data.entries.e_big, undefined);
  await ipad.run();
  assert.ok(ipad.state.data.entries.e_big, '没被 304 挡住');
});

test('仓库后来改成公开的：有录音要传时先再确认一次，不传', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  mac.put({ id: 'e_1' }); await mac.run();
  gh.private = false;
  const e = await mac.record('一');
  const r = await mac.run();
  assert.equal(r.ok, false); assert.equal(r.error.code, 'public');
  assert.ok(!gh.files.has(audioPath(e.audio[0].sha256, 'audio/mp4')), '录音没传到公开仓库');
});

test('同步中途点了「停止同步」：剩下的录音和 babble.json 都不再传', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  const a = await mac.record('一'); await mac.record('二');
  gh.faults.push({ method: 'PUT', path: '/contents/audio/', before: () => { mac.cfg = null; } });
  await mac.run();
  assert.equal(gh.writes().filter(w => w.includes('/contents/audio/')).length, 1);
  assert.ok(!gh.files.has(SYNC_FILE), 'babble.json 没传');
  assert.ok(a);
});

test('修改记录的云端历史：commits 列出 babble.json 的提交（新的在前，分页），fileAt 取当时的原文；设备名可以是函数（改名马上生效）', async () => {
  const gh = mockGitHub(), mac = device(gh, 'Mac');
  let name = 'Mac';
  mac.sync = createSync({
    getState: () => mac.state, applyRemote: (m) => { mac.state = m; }, getConfig: () => mac.cfg, saveConfig() {}, editVersion: () => mac.version,
    device: () => name, getLocal: () => mac.local, saveLocal() {}, fetch: (...a) => gh.fetch(...a),
  });
  const e = mac.put({ id: 'e_h', text: '👰🏻‍♀️“一”' });
  await mac.run();
  name = '测试 Mac';
  mac.put({ ...e, text: '👰🏻‍♀️“二”' });
  await mac.run();
  assert.equal(gh.json().device, '测试 Mac');
  assert.match(gh.commits[0].message, /测试 Mac/);
  const list = await mac.sync.commits({ page: 1, perPage: 30 });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(c => c.sha), gh.commits.map(c => c.sha));
  assert.ok(list[0].at > list[1].at);
  assert.equal((await mac.sync.commits({ page: 2, perPage: 1 })).length, 1);
  assert.equal((await mac.sync.commits({ page: 3, perPage: 1 })).length, 0);
  const old = await mac.sync.fileAt(list[1].sha);
  assert.equal(old.device, 'Mac');
  assert.equal(old.state.data.entries.e_h.text, '👰🏻‍♀️“一”');
  assert.equal((await mac.sync.fileAt(list[0].sha)).state.data.entries.e_h.text, '👰🏻‍♀️“二”');
  assert.equal(await mac.sync.fileAt('nope'), null);
  gh.faults.push({ path: '/commits', status: 401 });
  await assert.rejects(mac.sync.commits(), err => err.code === 'auth');
});

// ---------- 永久删除：墓碑、仓库里的录音、对账、清理云端历史 ----------

/** A 录一段、同步；B 同步下来（下载了录音）。返回 { gh, A, B, e, sha } */
async function twoDevices(text = '一') {
  const gh = mockGitHub(), A = device(gh, 'Mac'), B = device(gh, 'iPad');
  const e = await A.record(text);
  await A.run(); await B.run();
  return { gh, A, B, e, sha: e.audio[0].sha256 };
}

test('一轮的顺序：先拉取、再传录音、再传 babble.json；babble.json 带 features；第一次跑对一遍仓库，之后一天内不再列文件', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e = await A.record('一');
  await A.run();
  const order = gh.log.filter(l => /contents\/(babble\.json|audio\/)/.test(l)).map(l => l.split(' ')[0] + ' ' + l.split('/').pop().slice(0, 11));
  assert.deepEqual(order.slice(0, 1), ['GET babble.json'], '先拉取');
  assert.ok(order.indexOf('PUT babble.json') > order.findIndex(l => l.startsWith('PUT ') && l !== 'PUT babble.json'), '录音在 babble.json 之前');
  assert.deepEqual(gh.json().features, ['purge1']);
  assert.deepEqual([...FEATURES], ['purge1']);
  assert.ok(gh.log.some(l => l.includes('/git/trees/')), '新版本第一次跑：对一遍');
  assert.equal(A.sync.status().pendingPurge, 0);
  assert.deepEqual(A.sync.status().oldDevices, []);
  assert.ok(A.P().auditAt && A.P().auditV === 1, '进度存在 babble.purge');
  assert.equal(A.P().sha, A.cfg.sha);
  gh.log.length = 0;
  A.put({}); await A.run(); await A.run();
  assert.equal(gh.log.filter(l => l.includes('/git/')).length, 0, '没有要删的、一天内对过：不再列文件');
  assert.ok(e);
});

test('confirmedGone：没开同步 / 还没确认过现在的云端版本 → null；拉取或上传成功后是那一版里永久删除了的录音；重新打开照样有', async () => {
  const { gh, A, B, e, sha } = await twoDevices();
  assert.deepEqual([...A.sync.confirmedGone()], []);
  A.trash(e.id); await A.run(); await B.run();
  A.purge(e.id);
  assert.deepEqual([...A.sync.confirmedGone()], [], '本机的墓碑还没传上去：不算');
  await A.run();
  assert.deepEqual([...A.sync.confirmedGone()], [sha]);
  assert.deepEqual([...B.sync.confirmedGone()], [], 'B 还没拉到');
  await B.run();
  assert.deepEqual([...B.sync.confirmedGone()], [sha]);
  assert.deepEqual([...B.open().confirmedGone()], [sha], '重新打开：babble.purge 里记着，和 cfg.sha 对得上');
  B.cfg.sha = 'something-else';
  assert.equal(B.sync.confirmedGone(), null, '云端版本对不上：先别删');
  const off = device(gh, 'Off'); off.cfg = null;
  assert.equal(off.sync.confirmedGone(), null);
});

test('永久删除传开：墓碑先进 babble.json（没有原话）、再一次提交删掉仓库里的录音；B 拉到以后才确认、不再下载也不给播放', async () => {
  const { gh, A, B, e, sha } = await twoDevices('秘密');
  assert.ok(await B.audio.hasClip(sha));
  A.trash(e.id); await A.run(); await B.run();
  A.purge(e.id);
  gh.log.length = 0;
  const r = await A.run();
  assert.equal(r.ok, true);
  const t = gh.json().state.data.entries[e.id];
  assert.equal(t.purged, true); assert.equal(t.text || '', ''); assert.deepEqual(t.audio || [], []);
  assert.ok(!JSON.stringify(gh.json()).includes('秘密'));
  const put = gh.log.findIndex(l => l === 'PUT /repos/me/data/contents/babble.json'), patch = gh.log.findIndex(l => l.startsWith('PATCH /repos/me/data/git/refs/heads/main'));
  assert.ok(put >= 0 && patch > put, 'babble.json 先传上去，才删录音');
  assert.ok(!gh.files.has(clipPath(sha)), '仓库里的录音删了');
  assert.equal(gh.deleteCommits().length, 1);
  assert.match(gh.objs.get(gh.deleteCommits()[0]).message, /^删除录音 1 段（Mac）$/, '提交说明里没有条目内容');
  assert.equal(A.sync.status().pendingPurge, 0);
  assert.equal(A.sync.status().lastError, null);
  // B：拉到之前 confirmedGone 里没有（本机录音不能删）；拉到以后有了，清理完本机录音也不会再下载
  assert.ok(!B.sync.confirmedGone().has(sha));
  await B.run();
  assert.ok(B.sync.confirmedGone().has(sha));
  assert.equal(B.entry(e.id).purged, true);
  gh.log.length = 0;
  assert.equal(await B.sync.getAudio(sha), null, '永久删除了：本机还没删也不给');
  assert.deepEqual(await B.audio.deleteClips([sha], { stillGone: s => B.sync.confirmedGone().has(s) }), [sha]);   // purge.js 的清理
  assert.equal(await B.sync.getAudio(sha), null);
  assert.equal(gh.log.length, 0, '不去网上找');
  await B.run();
  assert.equal(await B.audio.hasClip(sha), false, '不会再下载回来');
  assert.equal(gh.log.filter(l => l.startsWith('POST') || l.startsWith('PATCH')).length, 0, 'B 不用再删');
});

test('babble.json 没传上去（500）：不删仓库里的录音；下一轮传上去了才删', async () => {
  const { gh, A, e, sha } = await twoDevices();
  A.trash(e.id); await A.run();
  A.purge(e.id);
  gh.faults.push({ method: 'PUT', path: SYNC_FILE, status: 500 });
  const r = await A.run();
  assert.equal(r.ok, false);
  assert.equal(gh.log.filter(l => l.includes('/git/trees') && l.startsWith('POST')).length, 0);
  assert.ok(gh.files.has(clipPath(sha)));
  assert.equal(A.sync.confirmedGone().has(sha), false);
  await A.run();
  assert.ok(!gh.files.has(clipPath(sha)));
});

test('仓库里本来就没有（从没传上去 / 手动删过）：不写任何东西，记成删好了，之后不再列', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e = await A.record('没传');
  gh.faults.push({ method: 'PUT', path: '/contents/audio/', status: 500 });
  await A.run();
  assert.ok(!gh.files.has(clipPath(e.audio[0].sha256)));
  A.trash(e.id); await A.run();
  A.purge(e.id);
  gh.log.length = 0;
  await A.run();
  assert.equal(gh.gitWrites().length, 0);
  assert.ok(gh.log.some(l => l.includes('/git/trees/')), '列了一次');
  assert.equal(A.sync.status().pendingPurge, 0);
  assert.ok(A.P().done[e.audio[0].sha256]);
  gh.log.length = 0;
  A.put({}); await A.run();
  assert.equal(gh.log.filter(l => l.includes('/git/')).length, 0, '删好了：不再列');
});

test('删的时候别的设备刚提交（不是快进 → 422）：重新列、再删，别人的提交留着', async () => {
  const { gh, A, e, sha } = await twoDevices();
  A.trash(e.id); await A.run();
  A.purge(e.id);
  const other = new TextEncoder().encode('别的设备刚传的录音');
  gh.faults.push({ method: 'PATCH', path: '/git/refs/', before: () => gh.putFile('audio/' + 'f'.repeat(64) + '.m4a', other, '添加录音（iPhone）') });
  await A.run();
  assert.equal(gh.log.filter(l => l.startsWith('PATCH')).length, 2, '第一次不是快进，重新列以后再提交');
  assert.ok(!gh.files.has(clipPath(sha)));
  assert.ok(gh.files.has('audio/' + 'f'.repeat(64) + '.m4a'), '别人的提交还在');
  assert.equal(A.sync.status().pendingPurge, 0);
});

test('列文件时发现 babble.json 又变了：先合并（拿到别人的修改）再删', async () => {
  const { gh, A, e, sha } = await twoDevices();
  A.trash(e.id); await A.run();
  A.purge(e.id);
  let raced = false;
  const realFetch = gh.fetch;
  gh.fetch = async (url, opt = {}) => {
    if (!raced && url.includes('/git/ref/')) { raced = true; gh.pushJson(s => { s.data.entries.e_web = makeEntry({ id: 'e_web', text: '别的设备刚记的' }); }, { device: 'iPhone', features: ['purge1'] }); }
    return realFetch(url, opt);
  };
  gh.log.length = 0;
  await A.run();
  const pull2 = gh.log.findIndex((l, i) => i > gh.log.findIndex(x => x.includes('/git/ref/')) && l === 'GET /repos/me/data/contents/babble.json');
  const del = gh.log.findIndex(l => l.startsWith('POST /repos/me/data/git/trees'));
  assert.ok(pull2 > 0 && del > pull2, '先重新拉取合并，再删');
  assert.ok(A.entry('e_web'), '别人的修改合并进来了');
  assert.ok(!gh.files.has(clipPath(sha)));
  assert.ok(gh.json().state.data.entries.e_web);
});

test('先拉取再上传：没同步过的旧设备（录音从备份恢复、没上传过）拉到墓碑，不会再把录音传回去', async () => {
  const { gh, A, B, e, sha } = await twoDevices();
  A.trash(e.id); await A.run();
  A.purge(e.id); await A.run();
  assert.ok(!gh.files.has(clipPath(sha)));
  await B.audio.markUploaded(sha, false);            // 像从备份恢复的：本机有、没标已上传；B 还拿着旧的那份条目
  assert.ok(!B.entry(e.id).deleted);
  gh.log.length = 0;
  await B.run();
  assert.equal(gh.log.filter(l => l.startsWith('PUT') && l.includes('/contents/audio/')).length, 0, '没有 PUT audio');
  assert.ok(!gh.files.has(clipPath(sha)));
  assert.equal(B.entry(e.id).purged, true);
});

test('同一段录音两条在用：永久删除一条不删文件；两条都永久删除才删', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e1 = await A.record('同一段'), e2 = await A.record('同一段');
  const sha = e1.audio[0].sha256;
  assert.equal(e2.audio[0].sha256, sha);
  await A.run();
  A.trash(e1.id); A.trash(e2.id); await A.run();
  A.purge(e1.id); await A.run();
  assert.ok(gh.files.has(clipPath(sha)), '另一条（在最近删除里）还在用');
  assert.equal(A.sync.confirmedGone().has(sha), false);
  A.purge(e2.id); await A.run();
  assert.ok(!gh.files.has(clipPath(sha)));
});

test('移除的录音：不上传、不下载；永久删除以后仓库里的删掉；别的设备拿旧的那份改字也带不回来', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac'), B = device(gh, 'iPad');
  const e = await A.record('一');
  const s1 = e.audio[0].sha256;
  const c2 = await A.audio.putClip(new Blob(['假录音 二']), { mime: 'audio/mp4' });
  A.edit(e.id, { audio: [...A.entry(e.id).audio, { ...c2, durationSec: 2, origName: '', addedAt: 2 }] });
  await A.run(); await B.run();
  const s2 = c2.sha256;
  assert.ok(gh.files.has(clipPath(s2)) && await B.audio.hasClip(s2));
  // 没传过的一段：加进来又移除了（还没同步）→ 不传
  const c3 = await A.audio.putClip(new Blob(['假录音 三']), { mime: 'audio/mp4' });
  A.edit(e.id, { audio: [...A.entry(e.id).audio, { ...c3, durationSec: 1, origName: '', addedAt: 3 }] });
  A.removeClip(e.id, c3.sha256);
  A.removeClip(e.id, s2);
  await A.run();
  assert.ok(!gh.files.has(clipPath(c3.sha256)), '移除的录音不上传');
  const C = device(gh, 'iPhone');
  await C.run();
  assert.ok(await C.audio.hasClip(s1));
  assert.equal(await C.audio.hasClip(s2), false, '移除的录音不下载');
  A.purgeRemoved(e.id, s2); await A.run();
  assert.ok(!gh.files.has(clipPath(s2)), '永久删除以后仓库里的删了');
  assert.ok(gh.files.has(clipPath(s1)));
  // B 一直没同步，拿着旧的那份（audio 里还有 s2）改了字
  B.edit(e.id, { text: '👰🏻‍♀️“改过的字”' }, Date.now() + 1000);   // 比 A 的那几次修改都晚
  await B.run();
  const merged = normalizeEntry(B.entry(e.id), e.id);
  assert.equal(merged.text, '👰🏻‍♀️“改过的字”');
  assert.ok(!merged.audio.some(a => a.sha256 === s2), '旧副本里的那段被记号盖住');
  assert.ok(!gh.files.has(clipPath(s2)), '没传回去');
  assert.equal(gh.log.filter(l => l.startsWith('PUT') && l.includes(s2)).length, 1, '只有最早那次上传');
});

test('又有人用上了（B 重新导入、仓库里正好还在，标成已上传）、A 同时删了文件：B 的争议检查发现 404，重新传上去', async () => {
  const { gh, A, B, e, sha } = await twoDevices('重新导入');
  A.trash(e.id); await A.run(); await B.run();
  A.purge(e.id);
  // B 把同一个文件导入成新的一条：上传时 GET 看到仓库里有 → 只标记已上传；B 上传 babble.json 之前，A 跑完一轮删了文件
  const blob = (await B.audio.getClip(sha)).blob;
  await B.audio.markUploaded(sha, false);
  await B.audio.putClip(blob, { mime: 'audio/mp4' });
  B.put({ id: 'e_again', status: 'inbox', audio: [{ sha256: sha, mime: 'audio/mp4', bytes: blob.size, durationSec: 3, origName: '重新导入.m4a', addedAt: Date.now() }] });
  let raced = false;
  const realFetch = gh.fetch;
  gh.fetch = async (url, opt = {}) => {
    if (!raced && opt.method === 'PUT' && url.endsWith('/contents/' + SYNC_FILE) && opt.headers && JSON.parse(opt.body).message.includes('iPad')) { raced = true; await A.run(); }
    return realFetch(url, opt);
  };
  await B.run();
  assert.ok(raced);
  assert.ok(gh.json().state.data.entries.e_again, 'B 的新条目传上去了');
  assert.ok(gh.files.has(clipPath(sha)), 'B 发现仓库里没了，重新传上去');
  assert.equal((await B.audio.getClip(sha)).uploaded, true);
  await A.run();
  assert.equal(A.sync.confirmedGone().has(sha), false, '有条目在用：不再算永久删除');
  assert.ok(gh.files.has(clipPath(sha)), 'A 不会再删');
});

test('永久删除被别处更新的一份作废：A 已经删了文件；B 恢复了那条 → B 赢、A 也恢复，B 把录音重新传上去', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac'), B = device(gh, 'iPad');
  const e = await B.record('恢复');
  const sha = e.audio[0].sha256;
  await B.run(); await A.run();
  B.trash(e.id); await B.run(); await A.run();
  A.purge(e.id); await A.run();
  assert.ok(!gh.files.has(clipPath(sha)));
  assert.deepEqual(await A.audio.deleteClips([sha], { stillGone: s => A.sync.confirmedGone().has(s) }), [sha]);   // A 清理了本机的
  B.restore(e.id);                                   // B 没同步过，在「最近删除」里点了恢复
  await B.run();
  const be = normalizeEntry(B.entry(e.id), e.id);
  assert.ok(!be.purged && !be.deleted, '恢复的那份更新：永久删除作废');
  assert.ok(be.audio.some(a => a.sha256 === sha));
  assert.ok(gh.files.has(clipPath(sha)), '争议检查：B 重新传上去');
  await A.run();
  const ae = normalizeEntry(A.entry(e.id), e.id);
  assert.ok(!ae.purged && !ae.deleted, 'A 也恢复了');
  assert.equal(A.sync.confirmedGone().has(sha), false);
  assert.ok(await A.audio.hasClip(sha), 'A 重新下载');
});

test('永久删除被另一台设备断网时的恢复作废，而那台设备从来没有这段录音：永久删除的那台留着字节（7 天），作废以后重新传上去', async () => {
  const gh = mockGitHub(), A = device(gh, 'iPhone'), C = device(gh, 'iPad');
  const pa = createPurger({ getState: () => A.state, mutate: (fn) => { const r = fn(A.state); A.state = normalizeState(A.state); A.version++; A.cfg.dirty = true; return r; },
    audio: A.audio, syncOn: () => true, confirmedGone: () => A.sync.confirmedGone(), enabled: true });
  const e = await A.record('断网时恢复');
  const sha = e.audio[0].sha256;
  await A.run(); A.trash(e.id); await A.run();
  await C.run();                                     // C 第一次同步时这条已经删除了：不下载它的录音
  assert.equal(await C.audio.hasClip(sha), false);
  C.restore(e.id);                                   // C 断网时点了恢复（还没传上去）
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(pa.purgeEntries([{ id: e.id, at: A.entry(e.id).updatedAt }]), { done: [e.id], changed: [] });
  await A.run();
  assert.ok(!gh.files.has(clipPath(sha)), '仓库里的文件马上删');
  assert.deepEqual((await pa.sweep({ full: true })).clips, [], '本机的先留着');
  assert.ok(A.audio.clips.has(sha));
  assert.equal(await A.sync.getAudio(sha), null, '这期间打不开');
  await C.run();                                     // C 联网：恢复的那份比永久删除时看到的新，这次永久删除作废
  assert.ok(!normalizeEntry(C.entry(e.id), e.id).purged);
  await A.run();
  assert.ok(!A.entry(e.id).purged && !A.entry(e.id).deleted);
  assert.ok(gh.files.has(clipPath(sha)), 'A 重新传上去');
  await C.run();
  assert.ok(await C.sync.getAudio(sha), 'C 听得到');
});

test('下载到一半合并进了永久删除：下载完不存', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac'), C = device(gh, 'iPhone');
  const e = await A.record('一');
  const sha = e.audio[0].sha256;
  await A.run();
  const realFetch = gh.fetch;
  let delayed = false;
  gh.fetch = async (url, opt = {}) => {
    const r = await realFetch(url, opt);
    if (!delayed && url.includes(sha) && opt.headers.Accept === 'application/vnd.github.raw+json') {
      delayed = true;
      A.trash(e.id); A.purge(e.id); await A.run();   // C 下载的时候 A 永久删除了
      await C.sync.syncNow();                        // C 这一轮合并进墓碑（下载循环还在等这一段）
    }
    return r;
  };
  await C.run();
  assert.ok(delayed, '确实在下载');
  assert.equal(C.entry(e.id).purged, true);
  assert.equal(await C.audio.hasClip(sha), false, '下载完发现永久删除了：不存');
});

test('对账：手动从仓库删掉的录音，一天后（或新版本第一次跑）改回待上传、马上重传', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e = await A.record('一');
  const sha = e.audio[0].sha256;
  await A.run();
  gh.dropFile(clipPath(sha));                        // 在 GitHub 网页上删了
  A.put({}); await A.run();
  assert.ok(!gh.files.has(clipPath(sha)), '一天内不对账');
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 3600e3;
  try { await A.run(); } finally { Date.now = realNow; }
  assert.ok(gh.files.has(clipPath(sha)), '过了一天：发现少了，重传');
  // 新版本第一次跑（babble.purge 里没有对账版本）：马上对一遍
  gh.dropFile(clipPath(sha));
  A.storage.m.clear();
  A.sync = A.open();
  await A.run();
  assert.ok(gh.files.has(clipPath(sha)), '第一次跑就对账');
  // 有设备清理过云端历史（cloudResetAt 变了）：马上对一遍
  gh.dropFile(clipPath(sha));
  A.state.settings.cloudResetAt = Date.now(); A.state.settingsAt.cloudResetAt = Date.now(); A.version++; A.cfg.dirty = true;
  await A.run();
  assert.ok(gh.files.has(clipPath(sha)), 'cloudResetAt 变了就对账');
  assert.equal(A.sync.status().lastError, null);
});

test('树太大被截断：babble.json 从根目录取；只把真的确认过的记成删好了', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e1 = await A.record('一'), e2 = await A.record('二');
  const s1 = e1.audio[0].sha256, s2 = e2.audio[0].sha256;
  await A.run();
  A.trash(e1.id); A.trash(e2.id); await A.run();
  A.purge(e1.id); A.purge(e2.id);
  gh.truncate = 0;                                   // 列表里一个文件都没给
  const bad = [s1, s2].sort()[0], ok = [s1, s2].sort()[1];
  gh.faults.push({ method: 'GET', path: '/contents/' + clipPath(bad), status: 500 });
  gh.log.length = 0;
  await A.run();
  assert.ok(gh.log.some(l => /\/git\/trees\/\w+$/.test(l)), 'babble.json 的 sha 从根目录取');
  assert.ok(!gh.files.has(clipPath(ok)), '一段段问到了的删了');
  assert.ok(gh.files.has(clipPath(bad)), '问出错的没删');
  assert.ok(A.P().done[ok] && !A.P().done[bad], '只记确认过的');
  assert.equal(A.sync.status().pendingPurge, 1);
  await A.run();
  assert.ok(!gh.files.has(clipPath(bad)));
  assert.equal(A.sync.status().pendingPurge, 0);
});

test('旧版本在墓碑里写了字（恢复旧版、打字）：拉取时发现，这一轮就传一份干净的', async () => {
  const { gh, A, B, e } = await twoDevices();
  A.trash(e.id); await A.run(); await B.run();
  A.purge(e.id); await A.run(); await B.run();
  gh.pushJson(s => { const t = s.data.entries[e.id]; s.data.entries[e.id] = { ...t, text: '旧版本打的字', audio: [{ sha256: 'a'.repeat(64), mime: 'audio/mp4' }], updatedAt: t.updatedAt + 5 }; });
  await B.run();
  const t = gh.json().state.data.entries[e.id];
  assert.equal(t.purged, true);
  assert.equal(t.text, '', '同一轮里传了干净的');
  assert.ok(!JSON.stringify(gh.json()).includes('旧版本打的字'));
  assert.deepEqual(B.sync.status().oldDevices, ['旧版 iPad']);
});

test('features：新版本写；旧版本传过的设备记下来（之后在 data.devices 报到过就不算；只用新版本传过还不算：同名的另一台可能还是旧版本）', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  A.put({}); await A.run();
  assert.deepEqual(gh.json().features, ['purge1']);
  gh.pushJson(s => { s.data.entries.e_old = makeEntry({ id: 'e_old', text: '旧版本记的' }); }, { device: '旧版 iPad' });
  await A.run();
  assert.deepEqual(A.sync.status().oldDevices, ['旧版 iPad']);
  assert.ok(A.P().oldPushers['旧版 iPad']);
  gh.pushJson(s => { s.data.entries.e_new = makeEntry({ id: 'e_new', text: '更新以后记的' }); }, { device: '旧版 iPad', features: ['purge1'] });
  await A.run();
  assert.deepEqual(A.sync.status().oldDevices, ['旧版 iPad'], '只用新版本传过：还等它报到');
  const t = Date.now() + 5;
  gh.pushJson(s => { s.data.devices = { d_pad: { id: 'd_pad', name: '旧版 iPad', updatedAt: t, seenAt: t, since: t, whoAt: t } }; }, { device: '旧版 iPad', features: ['purge1'] });
  await A.run();
  assert.deepEqual(A.sync.status().oldDevices, [], '报到了（第一次报到晚于那次旧版本上传）');
  gh.pushJson(s => { s.data.entries.e_p = makeEntry({ id: 'e_p', text: '旧手机记的' }); }, { device: '旧 iPhone' });
  await A.run();
  assert.deepEqual(A.sync.status().oldDevices, ['旧 iPhone']);
  assert.deepEqual(A.open().status().oldDevices, ['旧 iPhone'], '记在 babble.purge 里（重新打开照样有）');
  A.state.data.devices = { ...A.state.data.devices, d_phone: { id: 'd_phone', name: '新名字', aka: ['旧 iPhone'], updatedAt: Date.now() + 1000, seenAt: Date.now() + 1000, since: Date.now() + 1000 } };   // 那台更新了、改了名、报到了（app.js 写的）
  assert.deepEqual(A.sync.status().oldDevices, []);
  A.state.data.devices.d_phone.since = 1;                                              // 第一次报到比旧版本那次上传还早（最近一次报到晚也一样）：是同名的别的设备，还算旧版本
  assert.deepEqual(A.sync.status().oldDevices, ['旧 iPhone']);
});

test('旧版本的设备记进同步的 data.oldSeen：没正好拉到那一版的设备也知道；同名的那台更新了、报到、用新版本传，都盖不掉报到以后的那次旧版本上传', async () => {
  const gh = mockGitHub(), A = device(gh, 'iPhone'), M = device(gh, 'Mac');
  A.put({}); await A.run(); await M.run();
  const t0 = Date.now() - 5000;                          // 他的 iPad 早就更新了、报到过
  gh.pushJson(s => { s.data.devices = { d_his: { id: 'd_his', name: 'iPad', who: 'me', updatedAt: t0, seenAt: t0, since: t0, whoAt: t0 } }; }, { device: 'iPad', features: ['purge1'] });
  await A.run(); await M.run();
  assert.deepEqual(M.sync.status().oldDevices, []);
  // 她的 iPad（同名、旧版本）只改了一项设置；紧接着 A 拉到、又传了一次：M 没看到她那一版
  gh.pushJson(s => { s.settings.nightStart = '22:00'; s.settingsAt = { ...(s.settingsAt || {}), nightStart: Date.now() }; }, { device: 'iPad' });
  await A.run();
  assert.ok(Object.values(gh.json().state.data.oldSeen).some(r => r.name === 'iPad'), 'A 记进了同步的数据、传上去了');
  await M.run();
  assert.deepEqual(M.P().oldPushers, {}, 'M 自己没看到那一版');
  assert.deepEqual(M.sync.status().oldDevices, ['iPad'], 'M 从同步的数据里知道');
  gh.pushJson(s => { s.data.devices.d_his = { ...s.data.devices.d_his, updatedAt: Date.now() + 1, seenAt: Date.now() + 1 }; }, { device: 'iPad', features: ['purge1'] });
  await M.run();
  assert.deepEqual(M.sync.status().oldDevices, ['iPad'], '他的 iPad 又报到、用新版本传：不算');
  const t1 = Date.now() + 10;                            // 她的 iPad 也更新了、第一次报到
  gh.pushJson(s => { s.data.devices.d_hers = { id: 'd_hers', name: 'iPad', who: null, updatedAt: t1, seenAt: t1, since: t1, whoAt: t1 }; }, { device: 'iPad', features: ['purge1'] });
  await M.run();
  assert.deepEqual(M.sync.status().oldDevices, []);
  const n = gh.writes().length;
  await A.run(); await M.run(); await A.run();
  assert.equal(gh.writes().length, n, '之后谁都不再传');
});

test('暂停云端历史重写：直接调用也不发任何请求、不覆盖另一台设备的新提交，普通同步照常', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  A.put({ id: 'local', text: '编的本机记录' }); await A.run();
  gh.pushJson(s => { s.data.entries.remote = makeEntry({ id: 'remote', text: '编的另一台设备记录' }); }, { device: 'iPhone', features: FEATURES });
  const head = gh.head, log = gh.log.length;
  assert.deepEqual(await A.sync.squash(), { ok: false, error: { code: 'squashDisabled', vars: {} } });
  assert.equal(gh.log.length, log, '包括旧页面直接调用也不发强制更新请求');
  assert.equal(gh.head, head);
  assert.ok(gh.json().state.data.entries.remote);
  assert.equal((await A.run()).ok, true);
  assert.ok(A.entry('remote'), '普通同步仍能拉到另一台设备的记录');
  A.cfg = null;
  assert.deepEqual(await A.sync.squash(), { ok: false, skipped: true });
});

test('两台设备同时永久删除同一条：合并到一样；只有一次删除提交生效', async () => {
  const { gh, A, B, e, sha } = await twoDevices();
  A.trash(e.id); await A.run(); await B.run();
  A.purge(e.id, Date.now()); B.purge(e.id, Date.now() + 3600e3);   // B 的时钟快了一小时
  let raced = false;
  const realFetch = gh.fetch;
  gh.fetch = async (url, opt = {}) => {
    if (!raced && opt.method === 'PATCH') { raced = true; await B.run(); }     // A 提交删除之前，B 跑完一轮（也删）
    return realFetch(url, opt);
  };
  await A.run();
  await B.run(); await A.run();
  assert.ok(!gh.files.has(clipPath(sha)));
  assert.equal(gh.deleteCommits().length, 1, '只有一次删除提交');
  assert.equal(canonOf(A.entry(e.id)), canonOf(B.entry(e.id)), '两边一样');
  assert.equal(canonOf(A.entry(e.id)), canonOf(gh.json().state.data.entries[e.id]));
  assert.equal(A.sync.status().pendingPurge, 0); assert.equal(B.sync.status().pendingPurge, 0);
});
const canonOf = (rec) => canon(normalizeEntry(rec, rec.id));

test('删不掉（POST git/trees 一直 500）：报 audioDel、文字照常同步，下一轮再删；断网不算这一轮失败', async () => {
  const { gh, A, e, sha } = await twoDevices();
  A.trash(e.id); await A.run();
  A.purge(e.id);
  gh.faults.push({ method: 'POST', path: '/git/trees', status: 500, times: 9 });
  const r = await A.run();
  assert.equal(r.ok, true);
  assert.equal(A.sync.status().lastError.code, 'audioDel');
  assert.equal(A.sync.status().pendingPurge, 1);
  assert.ok(A.statuses.some(s => s.purging));
  assert.equal(gh.json().state.data.entries[e.id].purged, true);
  gh.faults.length = 0;
  await A.run();
  assert.ok(!gh.files.has(clipPath(sha)));
  assert.equal(A.sync.status().lastError, null);
  assert.equal(A.sync.status().pendingPurge, 0);
  const e2 = await A.record('二');
  await A.run(); A.trash(e2.id); await A.run(); A.purge(e2.id);
  gh.faults.push({ method: 'GET', path: '/git/ref/', throws: true });
  assert.equal((await A.run()).ok, true, '断网：下一轮再删');
  assert.equal(A.sync.status().pendingPurge, 1);
  await A.run();
  assert.equal(A.sync.status().pendingPurge, 0);
});

test('没有要删的、只是对账没做成（500，或者 Git Data API 用不了 = 404）：不报错、不挡同步，1 小时后再对', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  await A.record('一');
  gh.faults.push({ method: 'GET', path: '/git/trees/', status: 500 });
  assert.equal((await A.run()).ok, true);
  assert.equal(A.sync.status().lastError, null);
  assert.ok(!A.P().auditAt, '没对成');
  gh.log.length = 0;
  A.put({}); await A.run();
  assert.equal(gh.log.filter(l => l.includes('/git/')).length, 0, '1 小时内不再试');
  const realNow = Date.now;
  Date.now = () => realNow() + 3601e3;
  try {
    gh.faults.push({ method: 'GET', path: '/git/ref/', status: 404 });
    const r = await A.run();
    assert.equal(r.ok, true, '404（perm）也不让整轮失败');
    assert.equal(A.cfg.err, null);
    assert.equal(A.sync.status().lastError, null);
  } finally { Date.now = realNow; }
  Date.now = () => realNow() + 7300e3;
  try { await A.run(); } finally { Date.now = realNow; }
  assert.ok(A.P().auditAt, '过了 1 小时又对了，这次成了');
  // 有要删的时候 Git Data API 用不了：报 audioDel，同步照常
  const e = await A.record('二');
  await A.run(); A.trash(e.id); await A.run(); A.purge(e.id);
  gh.faults.push({ method: 'GET', path: '/git/ref/', status: 403, times: 9 });
  const r2 = await A.run();
  assert.equal(r2.ok, true);
  assert.equal(A.sync.status().lastError.code, 'audioDel');
  gh.faults.length = 0;
  // 令牌失效还是整轮报错
  gh.faults.push({ method: 'GET', path: '/git/ref/', status: 401 });
  A.put({});
  const r3 = await A.run();
  assert.equal(r3.ok, false); assert.equal(r3.error.code, 'auth');
});

test('上传过程中永久删除了 / 不再有条目在用：那段不传', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e1 = await A.record('一'), e2 = await A.record('二');
  const s2 = e2.audio[0].sha256;
  gh.faults.push({ method: 'PUT', path: '/contents/audio/', before: () => { A.purge(e2.id); } });   // 传第一段时，第二条被永久删除了
  await A.run();
  assert.equal(gh.writes().filter(w => w.includes('/contents/audio/')).length, 1);
  assert.ok(!gh.files.has(clipPath(s2)));
  assert.ok(gh.files.has(clipPath(e1.audio[0].sha256)));
});

test('多个标签页共用 babble.purge：一个对过账，另一个不再对；删好了的互相知道', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e = await A.record('一');
  await A.run();
  const tab2 = A.open();
  gh.log.length = 0;
  A.put({});
  await tab2.syncNow(); await tab2.idle();
  assert.equal(gh.log.filter(l => l.includes('/git/')).length, 0, '另一个标签页记下的对账时间也算');
  A.trash(e.id); await A.run(); A.purge(e.id); await A.run();
  gh.log.length = 0;
  A.put({});
  await tab2.syncNow(); await tab2.idle();
  assert.equal(gh.log.filter(l => l.includes('/git/')).length, 0, '删好了：另一个标签页不再列');
  assert.equal(tab2.status().pendingPurge, 0);
});

test('找没有条目在用的录音（只读）：先同步一轮；有条目在用、永久删除了的、24 小时内传的不列', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const used = await A.record('在用'), gone = await A.record('永久删除');
  const trashed = await A.record('在最近删除里');
  await A.run();
  A.trash(gone.id); A.trash(trashed.id); await A.run();
  A.purge(gone.id);
  const orphan = new TextEncoder().encode('以前移除了的'), fresh = new TextEncoder().encode('刚传的');
  const so = await sha256Hex(orphan), sf = await sha256Hex(fresh);
  gh.putFile(`audio/${so}.webm`, orphan, '添加录音');
  gh.at = () => Date.now() - 3600e3;
  gh.putFile(`audio/${sf}.m4a`, fresh, '添加录音');
  gh.at = null;
  const writes = gh.gitWrites().length;
  const r = await A.sync.orphans();
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map(f => [f.sha256, f.path, f.ext, f.mime, f.size]), [[so, `audio/${so}.webm`, 'webm', 'audio/webm', orphan.length]]);
  assert.ok(r.files[0].at > 0);
  assert.equal(r.recent, 1);
  assert.equal(r.more, false);
  assert.ok(!gh.files.has(clipPath(gone.audio[0].sha256)), '那一轮照常删了永久删除的');
  assert.equal(gh.gitWrites().length, writes + 3, '只有那一轮删除的提交（找的时候不写）');
  assert.ok(gh.files.has(`audio/${so}.webm`));
  assert.ok(used && trashed);
  const off = device(gh, 'Off'); off.cfg = null;
  assert.deepEqual(await off.sync.orphans(), { ok: true, skipped: true, files: [], recent: 0, more: false });
});

test('historyInfo：提交数（Link rel="last"）、默认分支、别的分支和标签；没开同步 → null', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  A.put({}); await A.run(); A.put({}); await A.run();
  gh.branches = ['main', 'backup']; gh.tags = ['v1'];
  const info = await A.sync.historyInfo();
  assert.deepEqual(info, { commits: gh.chain().length, branch: 'main', others: ['backup', 'v1'] });
  gh.faults.push({ path: '/commits?per_page=1', status: 500 });
  assert.equal((await A.sync.historyInfo()).commits, null, '拿不到就不显示');
  A.cfg = null;
  assert.equal(await A.sync.historyInfo(), null);
});

test('默认分支不是 main（名字里有 /）：删录音改那个分支，历史重写仍暂停', async () => {
  const gh = mockGitHub();
  gh.branch = 'data/live'; gh.branches = ['data/live'];
  const A = device(gh, 'Mac');
  const e = await A.record('一');
  await A.run();
  A.trash(e.id); await A.run(); A.purge(e.id); await A.run();
  assert.ok(gh.log.some(l => l.startsWith('PATCH /repos/me/data/git/refs/heads/data/live')));
  assert.ok(!gh.files.has(clipPath(e.audio[0].sha256)));
  const head = gh.head;
  assert.equal((await A.sync.squash()).error.code, 'squashDisabled');
  assert.equal(gh.head, head);
});

test('旧版本在墓碑上点了「恢复」（没有 deleted）：传一份改回墓碑的，旧版本那边又回到「最近删除」', async () => {
  const { gh, A, B, e } = await twoDevices();
  A.trash(e.id); await A.run(); A.purge(e.id); await A.run(); await B.run();
  gh.pushJson(s => { const { deleted, deletedAt, ...t } = s.data.entries[e.id]; s.data.entries[e.id] = { ...t, updatedAt: t.updatedAt + 9 }; });
  assert.equal(gh.json().state.data.entries[e.id].deleted, undefined);
  await B.run();
  const t = gh.json().state.data.entries[e.id];
  assert.equal(t.purged, true); assert.equal(t.deleted, true);
  assert.deepEqual(B.sync.status().oldDevices, ['旧版 iPad']);
});

test('旧版本点了「恢复」或打了字以后：改回的墓碑比那份新 1 毫秒，旧版本按时间直接采用，之后两边不来回推', async () => {
  const { gh, A, B, e } = await twoDevices();
  A.trash(e.id); await A.run(); A.purge(e.id); await A.run(); await B.run();
  // 旧版本（0a1aef9）：逐条只比 updatedAt，一样时取内容大的那份；合出来和云端不一样就整份传上去
  const oldPick = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) !== (a.updatedAt || 0) ? ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a) : canon(b) > canon(a) ? b : a);
  let old = gh.json().state;
  const oldSync = () => {
    const remote = gh.json().state.data.entries, mine = old.data.entries;
    const merged = Object.fromEntries([...new Set([...Object.keys(mine), ...Object.keys(remote)])].map(id => [id, oldPick(mine[id], remote[id])]));
    old = { ...old, data: { ...old.data, entries: merged } };
    if (canon(merged) === canon(remote)) return 0;
    gh.pushJson(s => { s.data.entries = structuredClone(merged); });
    return 1;
  };
  const leaks = { '点了「恢复」': (t) => { const { deleted, deletedAt, ...r } = t; return { ...r, updatedAt: t.updatedAt + 9 }; },
    '打了字': (t) => ({ ...t, text: '旧版本打的字', updatedAt: t.updatedAt + 9 }) };
  for (const [what, leak] of Object.entries(leaks)) {
    old.data.entries[e.id] = leak(old.data.entries[e.id]);
    assert.equal(oldSync(), 1, what);
    const pushes = [];
    for (let i = 0; i < 4; i++) { const n = gh.writes().length; await A.run(); const o = oldSync(); await B.run(); pushes.push(gh.writes().length - n + o); }
    assert.deepEqual(pushes, [1, 0, 0, 0], what + '：A 传一次干净的，之后谁都不再传');
    const t = gh.json().state.data.entries[e.id], mine = old.data.entries[e.id];
    assert.ok(t.purged && t.deleted && t.text === '', what);
    assert.equal(canon(mine), canon(t), what + '：旧版本那边也换成了干净的墓碑');
    assert.ok(!JSON.stringify(gh.json()).includes('旧版本打的字'));
  }
});

test('旧版本把新版本移除的录音又放回去了（同一段既在 audio、又在 removedAudio）：拉取时发现，这一轮就传一份干净的；旧版本之后再移除，录音不会回来', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  const e = await A.record('放回去又移除');
  const X = e.audio[0];
  A.removeClip(e.id, X.sha256);
  await A.run();
  const oldPick = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) !== (a.updatedAt || 0) ? ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a) : canon(b) > canon(a) ? b : a);
  let old = gh.json().state;
  const oldSync = () => {
    const remote = gh.json().state.data.entries, mine = old.data.entries;
    const merged = Object.fromEntries([...new Set([...Object.keys(mine), ...Object.keys(remote)])].map(id => [id, oldPick(mine[id], remote[id])]));
    old = { ...old, data: { ...old.data, entries: merged } };
    if (canon(merged) === canon(remote)) return 0;
    gh.pushJson(s => { s.data.entries = structuredClone(merged); });
    return 1;
  };
  oldSync();
  const oldEdit = (fn) => { const cur = old.data.entries[e.id]; old.data.entries[e.id] = { ...fn(cur), updatedAt: cur.updatedAt + 5 }; assert.equal(oldSync(), 1); };
  oldEdit(cur => ({ ...cur, audio: [...cur.audio, { ...X, addedAt: Date.now() }] }));   // 旧版本又选了同一个文件：不认识的 removedAudio 原样留着
  assert.ok(gh.json().state.data.entries[e.id].removedAudio.some(a => a.sha256 === X.sha256));
  await A.run();
  const clean = gh.json().state.data.entries[e.id];
  assert.ok(clean.audio.some(a => a.sha256 === X.sha256) && !(clean.removedAudio || []).length, 'A 马上传了一份干净的');
  assert.ok(clean.updatedAt > old.data.entries[e.id].updatedAt, '比旧版本那份新：旧版本直接采用');
  oldSync();
  assert.ok(!(old.data.entries[e.id].removedAudio || []).length);
  oldEdit(cur => ({ ...cur, audio: cur.audio.filter(a => a.sha256 !== X.sha256) }));   // 旧版本再移除（不留记录）
  await A.run();
  assert.ok(!A.entry(e.id).audio.some(a => a.sha256 === X.sha256), '移除的照样移除了，没被放回来');
  assert.ok(!gh.json().state.data.entries[e.id].audio.some(a => a.sha256 === X.sha256));
  const n = gh.writes().length;
  await A.run(); oldSync(); await A.run();
  assert.equal(gh.writes().length, n, '之后谁都不再传');
});

test('babble.json 被手动改坏了（读不出来）、服务器出错：这一轮报错，但新录的录音照样先传进私有仓库；修好以后照常同步', async () => {
  const gh = mockGitHub(), A = device(gh, 'iPhone');
  await A.record('昨晚'); await A.run();
  gh.putFile(SYNC_FILE, new TextEncoder().encode('{"app":"babble","v":1,"state":{"da'), 'Mac 上手动改坏了');
  const e = await A.record('今晚');
  const sha = e.audio[0].sha256;
  let r = await A.run();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'badFile');
  assert.ok(gh.files.has(clipPath(sha)), '录音先传上去了');
  assert.equal((await A.audio.getClip(sha)).uploaded, true);
  const f = await A.record('又一段'), s2 = f.audio[0].sha256;
  gh.faults.push({ method: 'GET', path: '/contents/' + SYNC_FILE, status: 502 });
  r = await A.run();
  assert.deepEqual([r.ok, r.error.code], [false, 'http']);
  assert.ok(gh.files.has(clipPath(s2)), '服务器出错也一样');
  gh.dropFile(SYNC_FILE, '修好了（删掉重来）');
  r = await A.run();
  assert.equal(r.ok, true);
  assert.ok(gh.json().state.data.entries[e.id] && gh.json().state.data.entries[f.id]);
});

test('「旧版本的设备」不算这台设备自己（更新以后还没传过时，云端那份是自己用旧版本传的）', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  gh.pushJson(s => { s.data.entries.e_1 = makeEntry({ id: 'e_1', text: '旧版本时记的' }); }, { device: 'Mac' });
  await A.run();
  assert.ok(A.entry('e_1'));
  assert.deepEqual(A.sync.status().oldDevices, []);
});

test('forcePush：合并以后没有本机才有的改动也照样传（中途 409 也一样）', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac');
  A.put({}); await A.run();
  const puts = gh.puts;
  gh.faults.push({ method: 'PUT', path: SYNC_FILE, status: 409 });
  gh.log.length = 0;
  assert.equal((await A.run({ forcePush: true })).ok, true);
  assert.equal(gh.writes().length, 2, '409 以后重新拉取，再传一次');
  assert.equal(gh.puts, puts + 1, '真的传上去了');
  assert.equal(A.cfg.sha, gh.files.get(SYNC_FILE).sha);
});

test('getAudio：移除的录音（还没永久删除）照样能播，路径按 removedAudio 里的 mime', async () => {
  const gh = mockGitHub(), A = device(gh, 'Mac'), B = device(gh, 'iPad');
  const blob = new Blob([new TextEncoder().encode('假录音 webm')], { type: 'audio/webm' });
  const c = await A.audio.putClip(blob, { mime: 'audio/webm' });
  const e = A.put({ audio: [{ ...c, mime: 'audio/webm', durationSec: 2, origName: '', addedAt: 1 }] });
  await A.run();
  A.removeClip(e.id, c.sha256); await A.run();
  await B.run();
  assert.equal(await B.audio.hasClip(c.sha256), false, '移除的录音不下载');
  gh.log.length = 0;
  const got = await B.sync.getAudio(c.sha256);
  assert.equal(await sha256Hex(got), c.sha256);
  assert.ok(gh.log.some(l => l.endsWith(`/contents/audio/${c.sha256}.webm`)));
});
