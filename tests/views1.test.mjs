import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, groupByMonth, totalDuration, cardPreview } from '../src/views/list.js';
import { chatRuns, shareText } from '../src/views/entry.js';
import { deletedEntries } from '../src/views/deleted.js';
import { REACTIONS } from '../src/views/editor.js';
import { parseDialogue } from '../src/core/dialogue.js';
import { makeEntry, byNewest } from '../src/core/store.js';

// 页面里不碰 DOM 的部分：列表的筛选 / 分组 / 卡片预览，详情的气泡分组、分享文字，最近删除的排序。
// 全是编的例子（仓库是公开的，不放真的梦话）
const SP = { nn: { name: 'NN', emoji: '👰🏻‍♀️', aliases: [] }, me: { name: '', emoji: '🥷🏻', aliases: [] } };
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const sha = c => c.repeat(64);
const E = (id, fields) => makeEntry({ id, ...fields }, 1000);

const list = [
  E('a', { date: '2026-11-04', time: '02:58', fav: true, text: `${NN}“今天吃什么”\n${ME}“吃什么都行？”\n${NN}“馄饨..”`, audio: [{ sha256: sha('a'), mime: 'audio/mp4', durationSec: 18 }] }),
  E('b', { date: '2026-11-01', status: 'inbox', audio: [{ sha256: sha('b'), mime: 'audio/mp4', durationSec: 40 }, { sha256: sha('c'), mime: 'audio/mp4', durationSec: null }] }),
  E('c', { date: '2026-10-27', title: '测试标题', text: `${NN} 「為什麼……？」\n${ME} 🤯`, note: '那天很累' }),
  E('d', { date: '2025-02-11', text: '过了一会儿..\n' + `${NN} 伸了个懒腰`, draft: { text: '草稿里的一句话', source: 'paste' } }),
].sort(byNewest);

test('筛选：收藏 / 有录音 / 待整理 / 搜索（简繁互通），保持原来的顺序', () => {
  const ids = f => filterEntries(list, f, SP).map(e => e.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ fav: true }), ['a']);
  assert.deepEqual(ids({ audio: true }), ['a', 'b']);
  assert.deepEqual(ids({ inbox: true }), ['b']);
  assert.deepEqual(ids({ q: '为什么' }), ['c']);
  assert.deepEqual(ids({ q: '吃什麼' }), ['a']);
  assert.deepEqual(ids({ q: '很累' }), ['c']);
  assert.deepEqual(ids({ q: '草稿' }), ['d']);
  assert.deepEqual(ids({ q: '馄饨', audio: true, fav: true }), ['a']);
  assert.deepEqual(ids({ q: '没有这句' }), []);
});

test('按年 → 月分组（新的在前）', () => {
  const g = groupByMonth(list);
  assert.deepEqual(g.map(y => [y.year, y.months.map(m => [m.key, m.items.map(e => e.id)])]), [
    ['2026', [['2026-11', ['a', 'b']], ['2026-10', ['c']]]],
    ['2025', [['2025-02', ['d']]]],
  ]);
  assert.deepEqual(groupByMonth([]), []);
});

test('录音总长：每段都知道时长才加；有不知道的 → null', () => {
  assert.equal(totalDuration(list.find(e => e.id === 'a')), 18);
  assert.equal(totalDuration(list.find(e => e.id === 'b')), null);
  assert.equal(totalDuration(list.find(e => e.id === 'c')), null);
});

test('卡片预览：有标题用标题；没有用 NN 的第一句（楷体）；预览跳过反应表情；搜索时换成命中的句子', () => {
  const a = cardPreview(list.find(e => e.id === 'a'), SP);
  assert.equal(a.head, '“今天吃什么”');
  assert.equal(a.headKai, true);
  assert.deepEqual(a.lines, [{ who: 'me', content: '“吃什么都行？”' }, { who: 'nn', content: '“馄饨..”' }]);

  const c = cardPreview(list.find(e => e.id === 'c'), SP);
  assert.equal(c.head, '测试标题');
  assert.equal(c.headKai, false);
  assert.deepEqual(c.lines, [{ who: 'nn', content: '「為什麼……？」' }]);     // 原样，不转简体；🤯 不进预览

  const d = cardPreview(list.find(e => e.id === 'd'), SP);
  assert.equal(d.head, '伸了个懒腰');
  assert.deepEqual(d.lines, [{ content: '过了一会儿..' }]);               // 旁白没有 who

  const b = cardPreview(list.find(e => e.id === 'b'), SP);
  assert.deepEqual([b.head, b.lines], ['', []]);

  assert.deepEqual(cardPreview(list.find(e => e.id === 'a'), SP, '馄饨').lines, [{ who: 'nn', content: '“馄饨..”' }]);
  assert.deepEqual(cardPreview(list.find(e => e.id === 'c'), SP, '很累').extra, { label: 'note', text: '那天很累' });
  assert.deepEqual(cardPreview(list.find(e => e.id === 'd'), SP, '草稿').extra, { label: 'draft', text: '草稿里的一句话' });
  assert.equal(cardPreview(list.find(e => e.id === 'c'), SP, '测试').extra, null);   // 标题命中就不用再提背景
});

test('气泡分组：同一个人连着说的并成一组，旁白和空行单独', () => {
  const text = [`${NN}“一”`, `${NN} 摇摇头`, `${ME} 🤯`, '', '过了一会儿..', `${NN}：`, `${ME}“二”`].join('\n');
  const runs = chatRuns(parseDialogue(text, SP));
  assert.deepEqual(runs.map(r => r.type === 'run' ? `${r.who}×${r.items.length}` : r.type), ['nn×2', 'me×1', 'gap', 'narration', 'nn×1', 'me×1']);
  assert.equal(runs[4].items[0].audioCue, true);
  assert.equal(runs[1].items[0].reactionOnly, true);
});

test('分享的文字：日期行、标题、原话原样', () => {
  const c = list.find(e => e.id === 'c');
  assert.equal(shareText(c, 'zh-Hans'), `2026年10月27日\n测试标题\n\n${NN} 「為什麼……？」\n${ME} 🤯`);
  const a = list.find(e => e.id === 'a');
  assert.equal(shareText(a, 'en'), `Nov 4, 2026 · 2:58 AM\n\n${a.text}`);
});

test('最近删除：只要删除的，新删的在前', () => {
  const state = { data: { entries: {
    x: { id: 'x', deleted: true, deletedAt: 5 }, y: { id: 'y' }, z: { id: 'z', deleted: true, deletedAt: 9 },
  } } };
  assert.deepEqual(deletedEntries(state).map(e => e.id), ['z', 'x']);
  assert.deepEqual(deletedEntries({}), []);
});

test('编辑器的反应表情和 spec 一致', () => {
  assert.deepEqual(REACTIONS, ['🤯', '🫨', '😲', '🤭', '😂', '🥲']);
});
