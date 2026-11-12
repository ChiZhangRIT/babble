import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, groupByMonth, totalDuration, cardLines, foldLines, cardExtra, startOpen, CARD_FOLD, CARD_SHOW } from '../src/views/list.js';
import { chatRuns, shareText } from '../src/views/entry.js';
import { deletedEntries } from '../src/views/deleted.js';
import { REACTIONS, workingCopy, savedFields } from '../src/views/editor.js';
import { audioEntry, noteEntry } from '../src/views/import.js';
import { canon, normalizeEntry } from '../src/core/store.js';
import { parseDialogue } from '../src/core/dialogue.js';
import { makeEntry, byNewest } from '../src/core/store.js';

// 页面里不碰 DOM 的部分��列表的筛选 / 分组 / 卡片上的原话和折叠，详情的气泡分组、分享文字，最近删除的排序。
// 全是编的例子（仓库是公开的，不放真的梦话）
const SP = { nn: { name: 'NN', emoji: '👰🏻‍♀️', aliases: [] }, me: { name: '', emoji: '🥷🏻', aliases: [] } };
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const sha = c => c.repeat(64);
const E = (id, fields) => makeEntry({ id, ...fields }, 1000);

const list = [
  E('a', { date: '2026-11-04', time: '02:58', fav: true, text: `${NN}“今天吃什么”\n${ME}“吃什么都行？”\n${NN}“馄饨..”`, audio: [{ sha256: sha('a'), mime: 'audio/mp4', durationSec: 18 }] }),
  E('b', { date: '2026-11-01', status: 'inbox', audio: [{ sha256: sha('b'), mime: 'audio/mp4', durationSec: 40, origName: '测试录音.m4a' }, { sha256: sha('c'), mime: 'audio/mp4', durationSec: null, name: '下雨了' }] }),
  E('c', { date: '2026-10-27', title: '旧标题', text: `${NN} 「為什麼……？」\n${ME} 🤯`, note: '那天很累' }),     // 旧数据里存着的标题：不显示、不搜
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
  assert.deepEqual(ids({ q: '下雨' }), ['b']);            // 录音起的名字
  assert.deepEqual(ids({ q: '測試錄音' }), ['b']);        // 原文件名（去掉扩展名），简繁互通
  assert.deepEqual(ids({ q: '旧标题' }), []);             // 存着的标题不搜
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

test('卡片上是整段原话：每一行都在（反应、旁白、空行、录音提示），没写字的「👰🏻‍♀️ “”」不要；没有标题', () => {
  assert.deepEqual(cardLines(list.find(e => e.id === 'a').text, SP), [
    { kind: 'say', who: 'nn', content: '“今天吃什么”' }, { kind: 'say', who: 'me', content: '“吃什么都行？”' }, { kind: 'say', who: 'nn', content: '“馄饨..”' }]);
  assert.deepEqual(cardLines(list.find(e => e.id === 'c').text, SP), [
    { kind: 'say', who: 'nn', content: '「為什麼……？」' }, { kind: 'react', who: 'me', content: '🤯' }]);   // 原样，不转简体
  assert.deepEqual(cardLines(list.find(e => e.id === 'd').text, SP), [{ kind: 'narr', content: '过了一会儿..' }, { kind: 'act', who: 'nn', content: '伸了个懒腰' }]);
  assert.deepEqual(cardLines('', SP), []);
  assert.deepEqual(cardLines(`${NN} “”`, SP), []);                             // 只有预填的空引号 = 还没写原话

  const text = ['', `${NN}“一”`, '', '', `${NN}：`, `${ME} 指着窗外 “下雨了”`, `${NN} “”`, '过了一会儿..', ''].join('\n');
  assert.deepEqual(cardLines(text, SP), [
    { kind: 'say', who: 'nn', content: '“一”' }, { kind: 'gap' }, { kind: 'cue', who: 'nn' },
    { kind: 'say', who: 'me', content: '指着窗外 “下雨了”' }, { kind: 'narr', content: '过了一会儿..' }]);
  // 改过的表情（🐷 / 🐰）照样认得，旧表情也认得
  const custom = { nn: { name: 'NN', emoji: '🐷', aliases: [NN] }, me: { name: '', emoji: '🐰', aliases: [ME] } };
  assert.deepEqual(cardLines(`🐷“新的”\n${NN}“旧的”\n🐰 😂`, custom).map(x => x.kind + ':' + (x.who || '')), ['say:nn', 'say:nn', 'react:me']);
});

test('长条目折起来：超过 16 行先显示前 12 行（空行不算），还有几行；展开 = 全部', () => {
  const lines = (n) => cardLines(Array.from({ length: n }, (_, i) => `${i % 2 ? ME : NN}“第${i + 1}句”`).join('\n'), SP);
  assert.deepEqual([CARD_FOLD, CARD_SHOW], [16, 12]);
  const sixteen = foldLines(lines(16));
  assert.deepEqual([sixteen.long, sixteen.more, sixteen.shown.length], [false, 0, 16]);     // 正好 16 行：不折
  const long = foldLines(lines(20));
  assert.deepEqual([long.long, long.more, long.shown.length, long.shown[11].content], [true, 8, 12, '“第12句”']);
  const open = foldLines(lines(20), true);
  assert.deepEqual([open.long, open.more, open.shown.length], [true, 8, 20]);
  // 空行不算行数，也不留在折起来的末尾
  const gappy = cardLines(Array.from({ length: 17 }, (_, i) => `${NN}“第${i + 1}句”` + (i % 3 === 2 ? '\n' : '')).join('\n'), SP);
  assert.equal(gappy.filter(x => x.kind === 'gap').length, 5);
  const g = foldLines(gappy);
  assert.deepEqual([g.long, g.more], [true, 5]);
  assert.equal(g.shown.filter(x => x.kind !== 'gap').length, 12);
  assert.notEqual(g.shown[g.shown.length - 1].kind, 'gap');
  assert.equal(foldLines(gappy.filter(x => x.kind !== 'gap').slice(0, 16).concat([{ kind: 'gap' }])).long, false);
});

test('长条目一开始展不展开：搜到的字在折起来的部分 → 展开（点过「收起」也展开）；否则看点没点过', () => {
  const items = cardLines(Array.from({ length: 20 }, (_, i) => `${NN}“第${i + 1}句${i === 15 ? '彈鋼琴' : ''}”`).join('\n'), SP);
  assert.equal(startOpen(items, '', undefined), false);
  assert.equal(startOpen(items, '', true), true);
  assert.equal(startOpen(items, '弹钢琴', undefined), true);                 // 简繁都算
  assert.equal(startOpen(items, '弹钢琴', false), true);                     // 以前收起过：搜到折起来的部分还是展开
  assert.equal(startOpen(items, '第1句', false), false);                     // 命中在看得到的部分：照旧
  assert.equal(startOpen(items.slice(0, 16), '弹钢琴', false), false);       // 不长：没有折起来的部分
});

test('搜索时只命中背景 / 草稿 / 录音名：卡片上多一行说明；原话里命中了就不用；存着的标题不算', () => {
  const extra = (id, q) => { const e = list.find(x => x.id === id); return cardExtra(e, q, cardLines(e.text, SP)); };
  assert.equal(extra('a', '馄饨'), null);
  assert.equal(extra('a', ''), null);
  assert.deepEqual(extra('c', '很累'), { label: 'note', text: '那天很累' });
  assert.deepEqual(extra('d', '草稿'), { label: 'draft', text: '草稿里的一句话' });
  assert.deepEqual(extra('b', '下雨'), { label: 'clip', text: '下雨了' });
  assert.deepEqual(extra('b', '测试'), { label: 'clip', text: '测试录音' });
  assert.equal(extra('c', '旧标题'), null);
});

test('气泡分组：同一个人连着说的并成一组，旁白和空行单独', () => {
  const text = [`${NN}“一”`, `${NN} 摇摇头`, `${ME} 🤯`, '', '过了一会儿..', `${NN}：`, `${ME}“二”`].join('\n');
  const runs = chatRuns(parseDialogue(text, SP));
  assert.deepEqual(runs.map(r => r.type === 'run' ? `${r.who}×${r.items.length}` : r.type), ['nn×2', 'me×1', 'gap', 'narration', 'nn×1', 'me×1']);
  assert.equal(runs[4].items[0].audioCue, true);
  assert.equal(runs[1].items[0].reactionOnly, true);
});

test('分享的文字：日期行、原话原样（存着的标题不带）', () => {
  const c = list.find(e => e.id === 'c');
  assert.equal(shareText(c, 'zh-Hans'), `2026年10月27日\n\n${NN} 「為什麼……？」\n${ME} 🤯`);
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

test('编辑页没有标题：工作副本里没有 title；保存的字段不带 title → 已有条目存着的标题原样留着，新的一条是空的', () => {
  const tpl = { text: `${NN} “”` };
  const prev = makeEntry({ id: 'p', date: '2026-11-04', time: '02:58', title: '旧标题', text: `${NN}“今天吃什么”`, note: '那天很累' }, 1000);
  const w = workingCopy(prev, tpl);
  assert.equal('title' in w, false);
  // 没改就保存：写回去的和原来一模一样（不会多出同步、修改记录）
  const same = savedFields(w, { template: tpl, prev, audio: prev.audio, keepDraft: true });
  assert.equal('title' in same, false);
  assert.equal(canon(normalizeEntry({ ...prev, ...same }, 'p')), canon(prev));
  // 改了原话：标题还在（只是不显示）
  const edited = { ...prev, ...savedFields({ ...w, text: prev.text + `\n${ME} 🤯` }, { template: tpl, prev, audio: prev.audio, keepDraft: true }) };
  assert.deepEqual([edited.title, edited.text], ['旧标题', `${NN}“今天吃什么”\n${ME} 🤯`]);
  // 新的一条
  const fresh = makeEntry(savedFields({ ...workingCopy({ date: '2026-11-05' }, tpl), text: `${NN}“新的”` }, { template: tpl, audio: [] }), 2000);
  assert.deepEqual([fresh.title, fresh.text, fresh.time], ['', `${NN}“新的”`, null]);
  assert.equal(savedFields(workingCopy({ date: '2026-11-05' }, tpl), { template: tpl, audio: [] }).text, '');   // 只有预填的空引号 = 没写
});

test('导入不再把文件名写进标题：文件名只在录音的 origName 里', () => {
  const clip = { sha256: sha('a'), mime: 'audio/mp4', bytes: 9, durationSec: 4, origName: '测试录音.m4a', addedAt: 1 };
  const auto = { date: '2026-11-04', time: '02:58', timeSource: 'mp4', recordedAt: '2026-11-03T18:58:00.000Z', tz: 'Asia/Shanghai' };
  const a = audioEntry({ date: '2026-11-04', time: '02:58', auto }, clip, { now: 5000, batchId: 'b_1', tz: 'Asia/Shanghai' });
  assert.deepEqual([a.title, a.status, a.audio[0].origName, a.timeSource, a.source.kind], ['', 'inbox', '测试录音.m4a', 'mp4', 'audio-import']);
  const m = audioEntry({ date: '2026-11-05', time: '', auto }, clip, { now: 5000, batchId: 'b_1' });
  assert.deepEqual([m.title, m.date, m.time, m.timeSource], ['', '2026-11-05', null, 'manual']);
  const x = { id: 'n_1', date: '2026-11-04', e: { text: `${NN}“为什么下雨”`, raw: 'raw' } };
  const n = noteEntry(x, [clip], { name: '测试录音.m4a', createdAt: null }, { now: 5000, batchId: 'b_2' });
  assert.deepEqual([n.title, n.text, n.audio[0].origName, n.timeSource, n.updatedAt, n.source.kind], ['', x.e.text, '测试录音.m4a', 'note', 2, 'apple-notes']);
});
