import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, readBackup, restoreBackup, backupMarkdown, clipFileName, backupFileName, markdownName, BackupError } from '../src/core/backup.js';
import { createZip, readZip } from '../src/core/zip.js';
import { blankState, normalizeState, canon, makeEntry, NN_EMOJI, ME_EMOJI } from '../src/core/store.js';
import { sha256Hex } from '../src/core/sha256.js';

// 测试只用编出来的数据
const dec = new TextDecoder();
const NOW = new Date(2026, 10, 11, 9, 30);

function memAudio() {
  const clips = new Map();
  return {
    clips,
    async putClip(blob, { mime } = {}) {
      const sha256 = await sha256Hex(blob);
      if (!clips.has(sha256)) clips.set(sha256, { sha256, blob, mime: mime || blob.type, bytes: blob.size, addedAt: 1, uploaded: false });
      return { sha256, mime: clips.get(sha256).mime, bytes: blob.size };
    },
    async getClip(sha) { return clips.get(sha) || null; },
    async hasClip(sha) { return clips.has(sha); },
  };
}
const fakeAudio = text => new Blob([new TextEncoder().encode('假录音：' + text)], { type: 'audio/mp4' });

async function fixture() {
  const store = memAudio();
  const A = await store.putClip(fakeAudio('一'), { mime: 'audio/mp4' });
  const C = await store.putClip(fakeAudio('删'), { mime: 'audio/mp4' });
  const D = await store.putClip(fakeAudio('怪名字'), { mime: 'audio/webm' });
  const B = { sha256: await sha256Hex(fakeAudio('不在这台设备上')), mime: 'audio/mp4', bytes: 10 };
  const clip = (c, sec) => ({ ...c, durationSec: sec, origName: '新录音 3.m4a', addedAt: 1 });   // 语音备忘录的默认名：文件名不用它
  const s = blankState();
  const put = f => { const e = makeEntry(f, 1000); s.data.entries[e.id] = e; return e; };
  const text = [
    `${NN_EMOJI}“明天 我们去..”`,
    `${ME_EMOJI}“去哪里？”`,
    `${NN_EMOJI} 伸了个懒腰`,
    `${ME_EMOJI} 🤯`,
    '',
    '过了一会儿..',
    `${NN_EMOJI} 摇摇头 “不要”`,
    `${NN_EMOJI} 「這是測試……？」`,
    '# 不是标题',
    '1. 不是列表',
    `${NN_EMOJI} 她说了”`,
  ].join('\n');
  const a = put({ id: 'e_a', date: '2026-11-04', time: '02:58', title: '测试标题', text, note: '那天很累\n睡得早', fav: true, audio: [clip(A, 42)] });
  const b = put({ id: 'e_b', date: '2024-01-01', text: `${NN_EMOJI}“今天吃什么”\n${ME_EMOJI}“好啊”`, audio: [clip(B, 5)] });
  const c = put({ id: 'e_c', date: '2025-06-01', text: '删掉的内容', audio: [clip(C, 3)] });
  s.data.entries.e_c = { ...c, deleted: true, deletedAt: 2000, updatedAt: 2000 };
  const d = put({ id: 'e_d', date: '2025-02-03', status: 'inbox', title: 'a/b\\c:d*e?f"g<h>i|j\u0001k\nl', text: '', draft: { text: '自动转写的草稿', source: '语音备忘录' }, audio: [clip(D, 61)] });
  return { store, s, a, b, c, d, A, B, C, D };
}

test('录音文件名：日期 + 标题（或第一句，去掉引号）+ sha 前 8 位；不能用的字符换掉', async () => {
  const { s, a, b, d, A, B, D } = await fixture();
  const sp = s.settings.speakers;
  assert.equal(clipFileName(a, A, sp), `2026-11-04 测试标题 (${A.sha256.slice(0, 8)}).m4a`);
  assert.equal(clipFileName(b, B, sp), `2024-01-01 今天吃什么 (${B.sha256.slice(0, 8)}).m4a`);
  const name = clipFileName(d, D, sp);
  assert.ok(name.endsWith(`(${D.sha256.slice(0, 8)}).webm`));
  assert.doesNotMatch(name.replace(/\.webm$/, ''), /[/\\:*?"<>|\u0000-\u001f]/);
  assert.equal(clipFileName({ date: '2026-01-02', title: '', text: '' }, { sha256: 'f'.repeat(64), mime: 'audio/mp4' }, sp), '2026-01-02 (ffffffff).m4a');
  assert.equal(backupFileName(new Date(2026, 10, 11)), '牙牙呓语备份 2026-11-11.zip');
  assert.equal(markdownName(), '梦话.md');
});

test('导出：zip 里有 babble.json、梦话.md 和录音；本机没有的录音记在 missing', async () => {
  const { store, s, A, B, C, D } = await fixture();
  const info = {};
  const zip = await buildBackup(s, store, { now: NOW, info });
  const files = await readZip(zip);
  const names = files.map(f => f.name);
  assert.equal(names[0], 'babble.json');
  assert.equal(names[1], '梦话.md');
  const json = JSON.parse(dec.decode(files[0].data));
  assert.equal(json.app, 'babble'); assert.equal(json.v, 1); assert.equal(json.kind, 'backup');
  assert.equal(json.exportedAt, NOW.toISOString());
  assert.equal(canon(json.state), canon(s));
  assert.equal(json.files[A.sha256], `audio/2026-11-04 测试标题 (${A.sha256.slice(0, 8)}).m4a`);
  assert.ok(json.files[C.sha256], '已删除条目的录音本机有就带上（恢复后还能听）');
  assert.ok(json.files[D.sha256].endsWith('.webm'));
  assert.equal(json.files[B.sha256], undefined);
  assert.deepEqual(json.missing, [B.sha256]);
  for (const p of Object.values(json.files)) assert.ok(names.includes(p), p);
  const a = files.find(f => f.name === json.files[A.sha256]);
  assert.equal(await sha256Hex(a.data), A.sha256);
  assert.deepEqual({ ...info, bytes: undefined }, { entries: 3, clips: 3, missing: [B.sha256], bytes: undefined });
  assert.equal(info.bytes, zip.size);
});

test('导出时本机没有的录音可以用 getBlob 去拿（比如从云端下载）', async () => {
  const { store, s, B } = await fixture();
  const asked = [];
  const zip = await buildBackup(s, store, { now: NOW, getBlob: async sha => { asked.push(sha); return sha === B.sha256 ? fakeAudio('不在这台设备上') : null; } });
  const json = JSON.parse(dec.decode((await readZip(zip))[0].data));
  assert.deepEqual(asked, [B.sha256], '已删除条目缺的录音不去拿');
  assert.ok(json.files[B.sha256]);
  assert.equal(json.missing, undefined);
});

test('梦话.md：按年分节从旧到新，标题行带日期时间，原话逐字照抄，背景、草稿、录音链接', async () => {
  const { store, s, A } = await fixture();
  const files = await readZip(await buildBackup(s, store, { now: NOW }));
  const md = dec.decode(files[1].data);
  const lines = md.split('\n');
  assert.equal(lines[0], '# 牙牙呓语');
  assert.match(md, /导出于 2026年11月11日 · 共 3 条 · 3 段录音/);
  assert.ok(md.indexOf('## 2024') < md.indexOf('## 2025') && md.indexOf('## 2025') < md.indexOf('## 2026'));
  assert.ok(lines.includes('### 2026年11月4日 凌晨2:58 · 测试标题 ⭐'));
  assert.ok(lines.includes('### 2024年1月1日'));
  assert.ok(lines.includes('### 2025年2月3日 · a/b\\c:d*e?f"g\\<h>i|j k l（待整理）'), '标题照写，只把换行、控制字符换成空格');
  // 原话每行原样（行尾两个空格 = Markdown 换行），空行保留
  for (const l of [`${NN_EMOJI}“明天 我们去..”`, `${ME_EMOJI}“去哪里？”`, `${NN_EMOJI} 伸了个懒腰`, `${ME_EMOJI} 🤯`, '过了一会儿..',
    `${NN_EMOJI} 摇摇头 “不要”`, `${NN_EMOJI} 「這是測試……？」`, `${NN_EMOJI} 她说了”`]) assert.ok(lines.includes(l + '  '), l);
  const i = lines.indexOf(`${ME_EMOJI} 🤯  `);
  assert.equal(lines[i + 1], '');
  assert.equal(lines[i + 2], '过了一会儿..  ');
  // 行首会被当成标题 / 列表的加 \
  assert.ok(lines.includes('\\# 不是标题  '));
  assert.ok(lines.includes('1\\. 不是列表  '));
  assert.ok(lines.includes('> **那天的背景**  '));
  assert.ok(lines.includes('> 那天很累  ') && lines.some(l => l.trimEnd() === '> 睡得早'));
  assert.ok(lines.includes('> **草稿 · 语音备忘录**  '));
  assert.ok(lines.includes(`[🎙 录音 · 0:42](<audio/2026-11-04 测试标题 (${A.sha256.slice(0, 8)}).m4a>)  `));
  assert.ok(lines.includes('🎙 录音 · 0:05（这台设备上没有这段录音，没有放进备份）  '));
  assert.ok(!md.includes('删掉的内容'), '已删除的条目不进 md');
});

test('英文 / 繁体的 md', async () => {
  const { s } = await fixture();
  const en = backupMarkdown(normalizeState(s), { lang: 'en', now: NOW });
  assert.ok(en.startsWith('# Babble · 牙牙呓语\n'));
  assert.match(en, /^### Nov 4, 2026 2:58 AM · 测试标题 ⭐$/m);
  assert.match(en, /Exported Nov 11, 2026 · 3 entries · 3 recordings/);
  const tw = backupMarkdown(normalizeState(s), { lang: 'zh-Hant-TW', now: NOW });
  assert.ok(tw.startsWith('# 牙牙囈語\n'));
  assert.match(tw, /共 3 則/);
  assert.equal(markdownName('zh-Hant-TW'), '夢話.md');
});

test('读备份：数据和录音都回来了，每段录音按 sha256 校验', async () => {
  const { store, s, A, C, D } = await fixture();
  const back = await readBackup(await buildBackup(s, store, { now: NOW }));
  assert.equal(canon(back.state), canon(normalizeState(s)));
  assert.deepEqual(back.clips.map(c => c.sha256).sort(), [A.sha256, C.sha256, D.sha256].sort());
  for (const c of back.clips) assert.equal(await sha256Hex(c.blob), c.sha256);
  assert.equal(back.clips.find(c => c.sha256 === D.sha256).mime, 'audio/webm');
  assert.deepEqual(back.bad, []); assert.deepEqual(back.missing, []);
  assert.equal(back.exportedAt, NOW.toISOString());
});

test('读备份：录音被改过 → 不恢复这段（bad）；zip 里少了 → missing；外面多套一层文件夹也能读', async () => {
  const { store, s, A, C } = await fixture();
  const files = await readZip(await buildBackup(s, store, { now: NOW }));
  const json = JSON.parse(dec.decode(files[0].data));
  const repacked = await createZip(files
    .filter(f => f.name !== json.files[C.sha256])
    .map(f => ({ name: '牙牙呓语备份 2026-11-11/' + f.name, data: f.name === json.files[A.sha256] ? new TextEncoder().encode('被改过') : f.data })));
  const back = await readBackup(repacked);
  assert.deepEqual(back.bad, [A.sha256]);
  assert.deepEqual(back.missing, [C.sha256]);
  assert.equal(back.clips.length, 1);
  assert.ok(back.state.data.entries.e_a);
});

test('读备份：单独的 JSON（安全模式导出 / 数据仓库里的 babble.json）也认；别的文件 → badBackup', async () => {
  const { s } = await fixture();
  const raw = new Blob([JSON.stringify({ app: 'babble', v: 1, kind: 'raw', exportedAt: 'x', state: s })], { type: 'application/json' });
  const back = await readBackup(raw);
  assert.ok(back.state.data.entries.e_a);
  assert.deepEqual(back.clips, []);
  for (const bad of [
    new Blob(['今天吃什么']),
    new Blob([JSON.stringify({ app: 'house-ledger', state: {} })]),
    await createZip([{ name: 'other.json', data: '{}' }]),
    await createZip([{ name: 'babble.json', data: '{"app":"babble"}' }]),
    new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]),
  ]) await assert.rejects(readBackup(bad), e => e instanceof BackupError && e.code === 'badBackup');
});

test('恢复：先存录音再合并；已经有的录音不重复存', async () => {
  const { store, s, A } = await fixture();
  const back = await readBackup(await buildBackup(s, store, { now: NOW }));
  const target = memAudio();
  await target.putClip(fakeAudio('一'), { mime: 'audio/mp4' });
  const merged = [];
  const r = await restoreBackup(back, { audioStore: target, mergeIn: st => { merged.push(st); return { changed: Object.keys(st.data.entries).length }; } });
  assert.deepEqual(r, { changed: 4, clips: 2 });
  assert.equal(merged.length, 1);
  assert.ok(await target.hasClip(A.sha256));
  assert.equal(target.clips.size, 3);
});
