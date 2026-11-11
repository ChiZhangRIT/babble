import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDialogue, previewLines, firstNNLine, insertSpeakerLine, speakerOf, isReactionOnly, DEFAULT_SPEAKERS } from '../src/core/dialogue.js';

// 全是编的例子（仓库是公开的，不放真的梦话）
const SP = { nn: { name: 'NN', emoji: '👰🏻‍♀️', aliases: [] }, me: { name: '', emoji: '🥷🏻', aliases: [] } };
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const L = (who, content, reactionOnly = false) => ({ type: 'line', who, content, reactionOnly });

test('基本规则：说话人、动作、反应、旁白、空行分段、引号原样', () => {
  const text = [
    `${NN}“今天吃什么”`,
    `${ME}“吃什么都行？”`,
    `${NN} 伸了个懒腰`,
    `${ME} 🤯`,
    '',
    '',
    '过了一会儿..',
    `${NN} 摇摇头 “不要”`,
    `${NN} 「這是誰的書？」`,
  ].join('\n');
  assert.deepEqual(parseDialogue(text, SP), [
    L('nn', '“今天吃什么”'),
    L('me', '“吃什么都行？”'),
    L('nn', '伸了个懒腰'),
    L('me', '🤯', true),
    { type: 'gap' },
    { type: 'narration', content: '过了一会儿..' },
    L('nn', '摇摇头 “不要”'),
    L('nn', '「這是誰的書？」'),
  ]);
});

test('表情宽松匹配：有没有 FE0F、肤色、ZWJ 都算同一个人', () => {
  for (const e of ['👰‍♀️', '👰🏻‍♀️', '👰🏻‍♀', '👰‍♀', '👰🏽‍♀️', '👰🏻♀', '👰🏻‍♀️️']) {
    assert.deepEqual(parseDialogue(`${e}“好的”`, SP), [L('nn', '“好的”')], [...e].map(c => c.codePointAt(0).toString(16)).join(' '));
  }
  for (const e of ['🥷', '🥷🏻', '🥷🏿', '🥷️']) assert.equal(speakerOf(`${e} “嗯？”`, SP).who, 'me', e);
  // 不同的表情不算：👰 不是 👰‍♀️，👰‍♂️ 也不是
  assert.equal(speakerOf('👰 “好的”', SP), null);
  assert.equal(speakerOf('👰‍♂️ “好的”', SP), null);
  // 短表情不会吃掉更长的组合表情（👰 后面还连着 ZWJ）
  const short = { nn: { emoji: '🐷' }, me: { emoji: '👰' } };
  assert.equal(speakerOf('👰‍♀️ “好的”', short), null);
  assert.equal(speakerOf('👰🏼 “好的”', short).who, 'me');
});

test('设置里换过表情：旧表情放在 aliases 里也认；不传 speakers 用默认的', () => {
  const sp = { nn: { emoji: '🐷', aliases: ['👰🏻‍♀️'] }, me: { emoji: '🐻', aliases: ['🥷🏻'] } };
  assert.deepEqual(parseDialogue(`🐷 “新的”\n${NN} “旧的”\n${ME}“我也是旧的”\n🐻 “我”`, sp).map(b => b.who), ['nn', 'nn', 'me', 'me']);
  assert.deepEqual(parseDialogue(`${NN}“默认”`), [L('nn', '“默认”')]);
  assert.equal(DEFAULT_SPEAKERS.nn.emoji, NN);
  // 表情写错 / 空着不会崩
  assert.deepEqual(parseDialogue('随便写写', { nn: { emoji: '' }, me: {} }), [{ type: 'narration', content: '随便写写' }]);
});

test('只有表情 / 标点 → reactionOnly；表情紧跟着反应也认', () => {
  for (const c of ['🤯', '？？？', '❔❔❔', '😂😂😂', '🤔', '...', '🫠 🫠', '～～']) {
    assert.equal(parseDialogue(`${ME} ${c}`, SP)[0].reactionOnly, true, c);
  }
  assert.deepEqual(parseDialogue(`${ME}🫨`, SP), [L('me', '🫨', true)]);
  assert.equal(parseDialogue(`${ME} 偷偷笑了😼`, SP)[0].reactionOnly, false);
  assert.equal(parseDialogue(`${ME} 3`, SP)[0].reactionOnly, false);
  assert.equal(isReactionOnly(''), false);
});

test('只有一对引号（工具栏插进来没写字）→ 普通气泡，不当反应；预览和标题后备跳过它', () => {
  for (const c of ['“”', '「」', '""', '“ ”']) {
    const b = parseDialogue(`${NN} ${c}`, SP)[0];
    assert.equal(b.reactionOnly, false, c);
    assert.equal(b.emptyQuote, true, c);
    assert.equal(b.content, c, '原样');
  }
  assert.equal(parseDialogue(`${NN} “？？”`, SP)[0].reactionOnly, true, '引号里有标点还算反应');
  assert.equal(parseDialogue(`${NN} “嗯”`, SP)[0].emptyQuote, undefined);
  assert.equal(firstNNLine(`${NN} “”\n${NN} “真的”`, SP), '“真的”');
  assert.deepEqual(previewLines(`${NN} “”\n${ME} “啥”`, SP).map(b => b.content), ['“啥”']);
});

test('表情后面的一个空格或冒号去掉；只有「：」或什么都没有 → audioCue', () => {
  assert.deepEqual(parseDialogue(`${NN}：“你好”`, SP), [L('nn', '“你好”')]);
  assert.deepEqual(parseDialogue(`${NN}: hi`, SP), [L('nn', 'hi')]);
  assert.deepEqual(parseDialogue(`${NN}：`, SP), [{ type: 'line', who: 'nn', content: '', reactionOnly: false, audioCue: true }]);
  assert.deepEqual(parseDialogue('👰🏻‍♀：\n', SP), [{ type: 'line', who: 'nn', content: '', reactionOnly: false, audioCue: true }]);
  assert.deepEqual(parseDialogue(`${ME}`, SP)[0].audioCue, true);
});

test('引号不配对、单边引号原样保留（不「修」）；表情后多余的空格去掉', () => {
  const lines = [`${NN} ”明天再说吧`, `${ME}“为什么”"`, `${NN}  “两个空格”`, `${NN} 「單邊引號`];
  assert.deepEqual(parseDialogue(lines.join('\n'), SP).map(b => b.content), ['”明天再说吧', '“为什么”"', '“两个空格”', '「單邊引號']);
});

test('U+FFFC 去掉；只剩占位符的行整行不要（不算空行）；CRLF 和行首空格', () => {
  const text = `\uFFFC\n${NN}“开始”\uFFFC\n\uFFFC\n${ME}“结束”\r\n   过了一会儿..\r\n\n\n`;
  assert.deepEqual(parseDialogue(text, SP), [
    L('nn', '“开始”'), L('me', '“结束”'), { type: 'narration', content: '过了一会儿..' },
  ]);
  assert.deepEqual(parseDialogue('', SP), []);
  assert.deepEqual(parseDialogue(null, SP), []);
  assert.deepEqual(parseDialogue('\n\n  \n', SP), []);
});

test('previewLines 跳过空行、反应和录音提示；firstNNLine 找第一句 NN 的话', () => {
  const text = `${NN}：\n${ME} 🤯\n\n${NN} 伸了个懒腰\n${ME}“干嘛呢？”\n${NN}“没事”`;
  assert.deepEqual(previewLines(text, SP), [L('nn', '伸了个懒腰'), L('me', '“干嘛呢？”')]);
  assert.equal(previewLines(text, SP, 3).length, 3);
  assert.equal(firstNNLine(text, SP), '伸了个懒腰');
  assert.equal(firstNNLine(`${ME}“只有我”`, SP), '');
  assert.equal(firstNNLine(`${NN} 😂\n${NN}“第二句”`), '“第二句”');
});

test('insertSpeakerLine：空文本不加换行，光标在引号中间', () => {
  const r = insertSpeakerLine('', 0, 'nn', SP);
  assert.equal(r.text, `${NN} “”`);
  assert.equal(r.cursor, r.text.length - 1);
  assert.equal(r.text.slice(r.cursor), '”');
});

test('insertSpeakerLine：光标在一行中间（引号里）→ 插到这一行末尾；空行就写在这一行', () => {
  const t0 = `${NN} “今天吃什么”\n${ME} 🤔`;
  const inQuote = t0.indexOf('”');
  const r = insertSpeakerLine(t0, inQuote, 'me', SP);
  assert.equal(r.text, `${NN} “今天吃什么”\n${ME} “”\n${ME} 🤔`);
  assert.equal(r.text.slice(r.cursor - 1, r.cursor + 1), '“”');

  const t1 = `${NN} “好”\n\n${ME} 🤔`;
  const r1 = insertSpeakerLine(t1, t1.indexOf('\n') + 1, 'nn', SP);
  assert.equal(r1.text, `${NN} “好”\n${NN} “”\n${ME} 🤔`);

  const t2 = `${NN} “好”\n`;
  assert.equal(insertSpeakerLine(t2, t2.length, 'me', SP).text, `${NN} “好”\n${ME} “”`);
  // 光标超出范围 → 放到最后
  assert.equal(insertSpeakerLine('abc', 99, 'me', SP).text, `abc\n${ME} “”`);
});

test('insertSpeakerLine：别的内容（反应表情）光标放在最后；用设置里的表情', () => {
  const r = insertSpeakerLine(`${NN} “好”`, 0, 'me', SP, '😂');
  assert.equal(r.text, `${NN} “好”\n${ME} 😂`);
  assert.equal(r.cursor, r.text.length);
  const sp = { nn: { emoji: '🐷' }, me: { emoji: '🐻' } };
  assert.equal(insertSpeakerLine('', 0, 'nn', sp).text, '🐷 “”');
});
