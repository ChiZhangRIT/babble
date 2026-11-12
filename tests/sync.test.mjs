import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSync, toB64, fromB64, bytesToB64, b64ToBytes, gitBlobSha, parseTokenExpiry, syncCode, parseSyncCode, audioPath,
  referencedClips, SYNC_FILE,
} from '../src/core/sync.js';
import { blankState, makeEntry, stamp } from '../src/core/store.js';
import { sha256Hex } from '../src/core/sha256.js';

// 测试只用编出来的数据。
// 模拟 GitHub contents API：文件、git blob sha、ETag/304、409（sha 过期）、422（文件已存在但没给 sha）、>1MB 只给 raw
function mockGitHub({ big = Infinity } = {}) {
  const gh = { files: new Map(), log: [], puts: 0, n304: 0, private: true, faults: [], tokenExp: null, big, commits: [] };
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
      if (f.status) return res(f.status, { message: 'fault' }, f.headers || {});
    }
    if (path === '/repos/me/data') {
      if (h.Authorization !== 'Bearer t') return res(401, { message: 'Bad credentials' });
      return res(200, { full_name: 'me/data', private: gh.private, visibility: gh.private ? 'private' : 'public' });
    }
    // 提交记录（修改记录的云端历史）：babble.json 每次 PUT 算一次提交，新的在前
    const cm = path.match(/^\/repos\/me\/data\/commits\?path=babble\.json&per_page=(\d+)&page=(\d+)$/);
    if (cm) return res(200, gh.commits.slice((cm[2] - 1) * cm[1], cm[2] * cm[1]).map(c => ({ sha: c.sha, commit: { message: c.message, committer: { date: c.date } } })));
    const rm = path.match(/^\/repos\/me\/data\/contents\/babble\.json\?ref=(\w+)$/);
    if (rm) {
      const c = gh.commits.find(x => x.sha === rm[1]);
      return c && h.Accept === 'application/vnd.github.raw+json' ? res(200, c.bytes) : res(404, { message: 'Not Found' });
    }
    const m = path.match(/^\/repos\/me\/data\/contents\/(.+)$/);
    if (!m) return res(404, {});
    const file = gh.files.get(m[1]);
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
      const body = JSON.parse(opt.body);
      if (file && !body.sha) return res(422, { message: '"sha" wasn\'t supplied.' });
      if (file && body.sha !== file.sha) return res(409, { message: 'does not match' });
      const bytes = b64ToBytes(body.content);
      const sha = await gitBlobSha(bytes);
      gh.files.set(m[1], { bytes, sha });
      gh.puts++;
      if (m[1] === SYNC_FILE) gh.commits.unshift({ sha: 'k' + gh.puts, message: body.message, date: new Date(Date.UTC(2026, 0, 1, 0, gh.puts)).toISOString(), bytes });
      return res(file ? 200 : 201, { content: { sha, size: bytes.length } });
    }
    return res(405, {});
  };
  gh.json = () => JSON.parse(new TextDecoder().decode(gh.files.get(SYNC_FILE).bytes));
  gh.writes = () => gh.log.filter(l => l.startsWith('PUT'));
  return gh;
}

// 内存里的录音库（和 audioStore.js 一样的接口）
function memAudio() {
  const clips = new Map();
  return {
    clips,
    async putClip(blob, { mime } = {}) {
      const sha256 = await sha256Hex(blob);
      if (!clips.has(sha256)) clips.set(sha256, { sha256, blob, mime: mime || blob.type || 'audio/mp4', bytes: blob.size, addedAt: Date.now(), uploaded: false });
      return { sha256, mime: clips.get(sha256).mime, bytes: blob.size };
    },
    async getClip(sha) { return clips.get(sha) || null; },
    async hasClip(sha) { return clips.has(sha); },
    async listClips() { return [...clips.values()].map(({ blob, ...r }) => r); },
    async markUploaded(sha, v = true) { const r = clips.get(sha); if (r) r.uploaded = !!v; },
    async pendingUploads() { return (await this.listClips()).filter(r => !r.uploaded); },
  };
}

function device(gh, name, { token = 't', audio = memAudio() } = {}) {
  const d = { name, state: blankState(), version: 0, cfg: { repo: 'me/data', token }, applied: [], statuses: [], local: { audioSync: {} }, audio };
  d.sync = createSync({
    getState: () => d.state, applyRemote: (m, info) => { d.state = m; d.applied.push(info.device); },
    getConfig: () => d.cfg, saveConfig: () => {}, editVersion: () => d.version, device: name,
    audioStore: audio, onStatus: s => d.statuses.push(s), getLocal: () => d.local, saveLocal: () => {},
    fetch: (...a) => gh.fetch(...a),
  });
  d.put = (fields) => {
    const e = makeEntry({ date: '2026-01-02', text: '👰🏻‍♀️“今天吃什么”', ...fields });
    d.state.data.entries[e.id] = stamp(e, d.state.data.entries[e.id]);
    d.version++; d.cfg.dirty = true;
    return e;
  };
  d.record = async (text, fields = {}) => {
    const blob = new Blob([new TextEncoder().encode('假录音 ' + text)], { type: 'audio/mp4' });
    const c = await audio.putClip(blob, { mime: 'audio/mp4' });
    return d.put({ status: 'inbox', audio: [{ ...c, durationSec: 3, origName: '', addedAt: 1 }], ...fields });
  };
  d.run = async () => { const r = await d.sync.syncNow(); await d.sync.idle(); return r; };
  return d;
}

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
