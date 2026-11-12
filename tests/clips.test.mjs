import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanClipName, clipName, clipLabel, origBase, ownName, renameClip, clipFileStem, CLIP_NAME_MAX } from '../src/core/clips.js';
import { clipFileName, backupMarkdown } from '../src/core/backup.js';
import { changedFields } from '../src/core/history.js';
import { normalizeState, blankState, makeEntry } from '../src/core/store.js';
import { shareName } from '../src/views/entry.js';

// 录音的名字。全是编的例子（仓库是公开的，不放真的录音名）
const SP = { nn: { name: 'NN', emoji: '👰🏻‍♀️', aliases: [] }, me: { name: '', emoji: '🥷🏻', aliases: [] } };
const sha = (c) => c.repeat(64);
const C = (k, more = {}) => ({ sha256: sha(k), mime: 'audio/mp4', bytes: 10, durationSec: 4, origName: '', addedAt: 1, ...more });

test('显示名：起的名字 → 原文件名去掉扩展名 → 「录音 1」', () => {
  assert.equal(clipLabel(C('a', { name: '下雨了', origName: '测试录音.m4a' }), 0), '下雨了');
  assert.equal(clipLabel(C('a', { origName: '测试录音.m4a' }), 0), '测试录音');
  assert.equal(clipLabel(C('a', { origName: '没有扩展名' }), 0), '没有扩展名');
  assert.equal(clipLabel(C('a', { origName: '11.5 晚上' }), 0), '11.5 晚上', '点后面不像扩展名就不去掉');
  assert.equal(clipLabel(C('a', { origName: 'a.b.M4A' }), 0), 'a.b');
  assert.equal(clipLabel(C('a'), 2), '录音 3');
  assert.equal(clipLabel(C('a', { name: '   ' }), 0, (n) => `Recording ${n}`), 'Recording 1', '只有空格不算名字');
  assert.equal(clipLabel(C('a', { name: 42 }), 1, (n) => `#${n}`), '#2', '不是字符串的不算');
  assert.equal(clipName(C('a')), '');
  assert.equal(ownName(null), '');
  assert.equal(origBase({ origName: '  测试录音.m4a ' }), '测试录音');
});

test('整理名字：去掉文件名不能用的字符、首尾空格，最长 80 个字', () => {
  assert.equal(cleanClipName('  下雨了  '), '下雨了');
  assert.equal(cleanClipName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(cleanClipName('第一行\n第二行\t\u0001x'), '第一行 第二行 x');
  assert.equal(cleanClipName('...点开头.'), '点开头');
  assert.equal(cleanClipName('“下雨了”「好」'), '“下雨了”「好」', '中文引号可以留着');
  const long = '梦'.repeat(100) + '😂';
  assert.equal([...cleanClipName(long)].length, CLIP_NAME_MAX);
  assert.equal([...cleanClipName('😂'.repeat(90))].length, CLIP_NAME_MAX, '按字算，不把表情切开');
  assert.equal(cleanClipName(null), '');
});

test('renameClip：返回新列表、不改原来的；空着 / 和原文件名一样 = 回到默认；没变返回同一个数组', () => {
  const list = [C('a', { origName: '测试录音.m4a' }), C('b')];
  const frozen = JSON.stringify(list);
  const r1 = renameClip(list, sha('a'), '  下雨了 ');
  assert.notEqual(r1, list);
  assert.equal(r1[0].name, '下雨了');
  assert.equal(r1[0].origName, '测试录音.m4a', '原文件名不改');
  assert.equal(r1[1], list[1]);
  assert.equal(JSON.stringify(list), frozen);
  const r2 = renameClip(r1, sha('a'), '');
  assert.equal('name' in r2[0], false, '空着 = 去掉名字');
  assert.equal(clipLabel(r2[0], 0), '测试录音');
  assert.equal('name' in renameClip(r1, sha('a'), '测试录音')[0], false, '和默认名一样也是去掉');
  assert.equal(renameClip(r1, sha('a'), '下雨了'), r1, '没变');
  assert.equal(renameClip(list, sha('a'), '   '), list, '本来就没名字，空着保存 = 没变');
  assert.equal(renameClip(list, sha('z'), 'x'), list, '找不到这段');
  assert.equal(renameClip(list, sha('b'), 'a/b')[1].name, 'a b');
  assert.deepEqual(renameClip(null, sha('a'), 'x'), []);
});

test('文件名用的名字：起的名字 → 原文件名（语音备忘录的默认名不算）→ 空', () => {
  assert.equal(clipFileStem(C('a', { name: '下雨了', origName: '新录音 3.m4a' })), '下雨了');
  assert.equal(clipFileStem(C('a', { origName: '测试录音.m4a' })), '测试录音');
  assert.equal(clipFileStem(C('a', { origName: '新录音 3.m4a' })), '');
  assert.equal(clipFileStem(C('a', { origName: '123 Main St 5.m4a' })), '', '地址样的默认名');
  assert.equal(clipFileStem(C('a', { origName: 'a:b.m4a' })), 'a b');
  assert.equal(clipFileStem(C('a', { name: 'x/y' })), 'x y', '老数据里没整理过的名字也整理');
  assert.equal(clipFileStem(C('a')), '');
});

test('备份里的录音文件名：录音的名字优先，没有再用第一句（存着的标题不用）', () => {
  const e = { date: '2026-11-04', title: '旧标题', text: '👰🏻‍♀️“今天吃什么”' };
  assert.equal(clipFileName(e, C('a', { name: '下雨了' }), SP), `2026-11-04 下雨了 (aaaaaaaa).m4a`);
  assert.equal(clipFileName(e, C('a', { origName: '测试录音.m4a' }), SP), `2026-11-04 测试录音 (aaaaaaaa).m4a`);
  assert.equal(clipFileName(e, C('a', { origName: '新录音 3.m4a' }), SP), `2026-11-04 今天吃什么 (aaaaaaaa).m4a`);
  assert.equal(clipFileName({ ...e, title: '' }, C('a'), SP), `2026-11-04 今天吃什么 (aaaaaaaa).m4a`);
  assert.equal(clipFileName({ ...e, text: '' }, C('a'), SP), `2026-11-04 (aaaaaaaa).m4a`);
  assert.equal(clipFileName(e, C('a', { name: 'a/b:c', mime: 'audio/webm' }), SP), `2026-11-04 a b c (aaaaaaaa).webm`);
  // 梦话.md 的录音链接文字带上名字（[ ] 转义）
  const s = blankState();
  const x = makeEntry({ id: 'e_x', date: '2026-11-04', text: '👰🏻‍♀️“好”', audio: [C('a', { name: '下雨了 [1]' }), C('b')] }, 1000);
  s.data.entries.e_x = x;
  const md = backupMarkdown(normalizeState(s), { files: { [sha('a')]: 'audio/a.m4a', [sha('b')]: 'audio/b.m4a' } });
  assert.ok(md.includes('[🎙 录音 1 · 下雨了 \\[1\\] · 0:04](<audio/a.m4a>)'), md);
  assert.ok(md.includes('[🎙 录音 2 · 0:04](<audio/b.m4a>)'));
});

test('分享出去的文件名：「名字.m4a」；同名的加 (2)；没名字用日期和第一句（存着的标题不用）', () => {
  const e = { date: '2026-11-04', title: '旧标题', text: '', audio: [C('a', { name: '下雨了' }), C('b', { name: '下雨了' }), C('c'), C('d', { origName: '测试录音.m4a', mime: 'audio/webm' })] };
  assert.deepEqual(e.audio.map((c, i) => shareName(e, c, i, SP)), ['下雨了.m4a', '下雨了 (2).m4a', '2026-11-04 (3).m4a', '测试录音.webm']);
  const one = { date: '2026-11-04', title: '旧标题', text: '👰🏻‍♀️“今天吃什么”', audio: [C('a')] };
  assert.equal(shareName(one, one.audio[0], 0, SP), '2026-11-04 今天吃什么.m4a');
});

test('修改记录：录音改名也算改了录音；名字跟着条目存下来、合并', () => {
  const a = makeEntry({ id: 'e_a', date: '2026-11-04', audio: [C('a')] }, 1000);
  const b = { ...a, audio: renameClip(a.audio, sha('a'), '下雨了') };
  assert.deepEqual(changedFields(a, b), ['audio']);
  assert.deepEqual(changedFields(b, { ...b }), []);
  const s = blankState();
  s.data.entries.e_a = b;
  assert.equal(normalizeState(s).data.entries.e_a.audio[0].name, '下雨了', 'normalize 保留名字');
});
