import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSimplified, T2S } from '../src/core/hanzi.js';
import { fold, matchEntry, highlight } from '../src/core/search.js';

// 全是编的例子（仓库是公开的，不放真的梦话）
const NN = '👰🏻‍♀️', ME = '🥷🏻';

test('hanzi：繁 → 简，常用字都能折（不认识的字原样）', () => {
  const pairs = {
    頭: '头', 枕: '枕', 糧食: '粮食', 錄音: '录音', 為: '为', 爲: '为', 什麼: '什么', 麽: '么', 飛機: '飞机', 器: '器', 壓力: '压力',
    回來: '回来', 夢話: '梦话', 說: '说', 這個: '这个', 們: '们', 裡: '里', 裏: '里', 貓: '猫', 魚: '鱼', 麵: '面', 麪: '面',
    饅: '馒', 鏡: '镜', 腦: '脑', 車: '车', 雲: '云', 寶: '宝', 買: '买', 會: '会', 員: '员', 妳: '你', 牠: '它', 牀: '床', 覺: '觉', 醒: '醒',
  };
  for (const [t, s] of Object.entries(pairs)) assert.equal(toSimplified(t), s, t);
  assert.equal(toSimplified('abc 123 😂 简体'), 'abc 123 😂 简体');
  assert.equal(toSimplified(null), '');
});

test('hanzi：折一次就到底（表里没有链、没有环）', () => {
  for (const [k, v] of T2S) assert.ok(!T2S.has(v) || T2S.get(v) === v, `${k} → ${v} → ${T2S.get(v)}`);
  assert.equal(toSimplified('薴'), toSimplified('苧'));
  assert.equal(toSimplified('苧'), toSimplified('苎'));
  assert.ok(T2S.size > 2800);
});

test('fold：简繁、大小写、全角半角都一样；去掉表情、标点、空白', () => {
  assert.equal(fold('為什麼？'), '为什么');
  assert.equal(fold(`${NN}“今天 吃什么”`), '今天吃什么');
  assert.equal(fold('ＡＢＣ abc'), 'abcabc');
  assert.equal(fold('🤯❔‼️ …「」'), '');
  assert.equal(fold('第３次'), '第3次');
  assert.equal(fold(null), '');
});

const entry = (over = {}) => ({ id: 'e_1', title: '', text: '', note: '', draft: null, ...over });

test('matchEntry：标题、原话、背景、草稿；简体搜繁体、繁体搜简体', () => {
  const e = entry({ title: '下雨天', text: `${NN}“為什麼下雨了”\n${ME}“因为云来了”`, note: '那天在露营', draft: { text: '自动转写的草稿', source: 'voice-memos' } });
  for (const q of ['为什么', '為什麼', '下雨天', '露營', '露营', '自動轉寫', '雲來了', '  因為  ']) assert.equal(matchEntry(e, q), true, q);
  for (const q of ['晴天', '下雪', 'abc']) assert.equal(matchEntry(e, q), false, q);
  assert.equal(matchEntry(e, ''), true);
  assert.equal(matchEntry(e, '   '), true);
  assert.equal(matchEntry(entry(), '雨'), false);
  assert.equal(matchEntry({ text: null }, '雨'), false);
});

test('matchEntry：忽略标点和表情；空格分开的几个词都要命中（可以在不同字段）', () => {
  const e = entry({ title: 'Test 录音', text: `${NN}“吃……什么？”\n${ME} 🤯` });
  assert.equal(matchEntry(e, '吃什么'), true);
  assert.equal(matchEntry(e, '“吃什么”'), true);
  assert.equal(matchEntry(e, 'TEST'), true);
  assert.equal(matchEntry(e, 'test 什么'), true);
  assert.equal(matchEntry(e, 'test 晴天'), false);
});

test('matchEntry：只有表情的搜索词 → 宽松比表情（肤色、FE0F 不管）', () => {
  const e = entry({ text: `${NN}“好”\n${ME} 🤯` });
  assert.equal(matchEntry(e, '🤯'), true);
  assert.equal(matchEntry(e, '😂'), false);
  assert.equal(matchEntry(e, '🥷'), true);
  assert.equal(matchEntry(e, '👰‍♀'), true);
  assert.equal(matchEntry(e, '？'), false);
});

test('highlight：标出原文里命中的部分（简繁、大小写都算），拼起来还是原文', () => {
  const s = '頭髮長，头发短';
  const parts = highlight(s, '头发');
  assert.deepEqual(parts, [{ text: '頭髮', hit: true }, { text: '長，', hit: false }, { text: '头发', hit: true }, { text: '短', hit: false }]);
  assert.equal(parts.map(p => p.text).join(''), s);
  // 中间隔着标点也标成一段
  assert.deepEqual(highlight('吃，什么', '吃什么'), [{ text: '吃，什么', hit: true }]);
  // 多个词、重叠的合并
  assert.deepEqual(highlight('ABCabc', 'bc ca'), [{ text: 'A', hit: false }, { text: 'BCabc', hit: true }]);
  // 表情：宽松模式标原文里的整个表情（含肤色）
  assert.deepEqual(highlight(`${ME} 🤯`, '🥷'), [{ text: ME, hit: true }, { text: ' 🤯', hit: false }]);
  assert.deepEqual(highlight('没有', '晴天'), [{ text: '没有', hit: false }]);
  assert.deepEqual(highlight('没有', ''), [{ text: '没有', hit: false }]);
  assert.deepEqual(highlight('', '晴天'), [{ text: '', hit: false }]);
  // 码位外的字（表情）前后下标不乱
  assert.deepEqual(highlight('😂下雨😂', '下雨'), [{ text: '😂', hit: false }, { text: '下雨', hit: true }, { text: '😂', hit: false }]);
});
