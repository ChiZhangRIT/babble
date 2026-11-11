import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNote, parsePathList, suggestPairs, isDefaultRecordingName, fileTitle, nameDates, recordedOnDate,
} from '../src/core/notesImport.js';

// 全是编的例子（仓库是公开的，不放真的梦话和真的录音文件名）
const S = '\uFFFC';   // 备忘录的附件占位符
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const NOTE = [
  '测试笔记',
  '',
  '2024',
  '',
  '1/1',
  `${NN}“今天吃什么”`,
  `${ME}“你想吃什么？”`,
  '',
  `${NN} 伸了个懒腰`,
  `${ME} 🤔`,
  '',
  '1/2',
  S,
  `${NN}“小狗在跳舞”`,
  '',
  '3.5',
  `${NN}“去公园”`,
  S,
  `${ME}“去公园干嘛？”`,
  `${NN} 睡着了${S}`,
  '',
  '12-31',
  S,
  '1/2',
  `${NN}：`,
  `${S}${S}`,
  '2025',
  '2/30',
  `${NN}“月亮好圆”`,
  '1/1',
  `${ME} ？？？`,
  '',
  '',
].join('\n');

test('parseNote：标题、年份行、日期行、条目里的空行保留、首尾空行去掉', () => {
  const r = parseNote(NOTE);
  assert.equal(r.title, '测试笔记');
  assert.deepEqual(r.entries.map(e => [e.key, e.date, e.k, e.audioSlots]), [
    ['n_2024-01-01_1', '2024-01-01', 1, 0],
    ['n_2024-01-02_1', '2024-01-02', 1, 1],
    ['n_2024-03-05_1', '2024-03-05', 1, 2],
    ['n_2024-12-31_1', '2024-12-31', 1, 1],
    ['n_2024-01-02_2', '2024-01-02', 2, 2],
    ['n_2025-02-30_1', null, 1, 0],
    ['n_2025-01-01_1', '2025-01-01', 1, 0],
  ]);
  const [e1, e2, e3, e4, e5, , e7] = r.entries;
  assert.equal(e1.text, `${NN}“今天吃什么”\n${ME}“你想吃什么？”\n\n${NN} 伸了个懒腰\n${ME} 🤔`);
  assert.equal(e1.line, 5);
  assert.equal(e1.dateText, '1/1');
  assert.equal(e7.text, `${ME} ？？？`);
  // 占位符在开头 / 中间 / 行尾：去掉；只剩占位符的行整行不要
  assert.equal(e2.text, `${NN}“小狗在跳舞”`);
  assert.equal(e3.text, `${NN}“去公园”\n${ME}“去公园干嘛？”\n${NN} 睡着了`);
  // 只有一个占位符的一条 → text ''，紧跟着的日期行开始新的一条
  assert.equal(e4.text, '');
  assert.equal(e5.text, `${NN}：`);
  // raw 是原样（含日期行和占位符）
  assert.equal(e3.raw, `3.5\n${NN}“去公园”\n${S}\n${ME}“去公园干嘛？”\n${NN} 睡着了${S}`);
  assert.equal(e4.raw, `12-31\n${S}`);
});

test('parseNote：不存在的日期、日期倒退、空条目、第一个日期前的文字 → 警告（仍然列出来）', () => {
  const r = parseNote(NOTE);
  const bad = r.entries.find(e => e.dateText === '2/30');
  assert.deepEqual(bad.warnings, ['badDate']);
  assert.equal(bad.text, `${NN}“月亮好圆”`);
  // 同一年里 1/2 跟在 12/31 后面：可能写错了，提醒一下
  assert.deepEqual(r.entries[4].warnings, ['outOfOrder']);
  assert.deepEqual(r.warnings, ['outOfOrder', 'badDate']);
  assert.deepEqual(r.issues, [
    { code: 'outOfOrder', line: 24, key: 'n_2024-01-02_2' },
    { code: 'badDate', line: 28, key: 'n_2025-02-30_1' },
  ]);

  const r2 = parseNote(`标题\n随便写的\n${S}\n2024\n1/1\n\n5/6\n${NN}“好”`);
  assert.deepEqual(r2.warnings, ['textOutsideEntry', 'slotOutsideEntry', 'empty']);
  assert.equal(r2.entries[0].audioSlots, 0);
  assert.deepEqual(r2.entries[0].warnings, ['empty']);
  assert.deepEqual(parseNote('只是一段话\n没有日期').warnings, ['textOutsideEntry', 'noEntries']);
  assert.deepEqual(parseNote('').entries, []);
});

test('parseNote：没有年份就不猜（date null + noYear），给了 defaultYear 才用', () => {
  const r = parseNote(`1/5\n${NN}“好”`);
  assert.equal(r.title, '');
  assert.equal(r.entries[0].date, null);
  assert.deepEqual(r.entries[0].warnings, ['noYear']);
  assert.equal(r.entries[0].key, 'n_0000-01-05_1');
  const r2 = parseNote(`1/5\n${NN}“好”\n2026\n1/6\n${ME} 🤔`, { defaultYear: 2025 });
  assert.deepEqual(r2.entries.map(e => e.date), ['2025-01-05', '2026-01-06']);
  assert.deepEqual(r2.warnings, []);
});

test('parseNote：日期写法（1/2、1.2、1-2、1月2日、全角、前后空格）、CRLF、「2024年」', () => {
  const r = parseNote('2024年\r\n 1/2 \r\na\r\n1.3\r\nb\r\n1-4\r\nc\r\n1月5日\r\nd\r\n１／６\r\ne\r\n1/7/2024\r\nf');
  assert.deepEqual(r.entries.map(e => e.date), ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06']);
  // 「1/7/2024」不是日期行，算上一条的内容
  assert.equal(r.entries[4].text, 'e\n1/7/2024\nf');
});

test('parsePathList：一行一个路径 → 文件名（file:// 网址解码、去引号、反斜杠、空行）', () => {
  const text = [
    '/Users/someone/Library/Group Containers/group.com.apple.notes/Media/AAA/测试录音.m4a',
    '',
    '  "/tmp/x/123 Main St.m4a"  ',
    'file:///Users/someone/Media/BBB/%E6%96%B0%E5%BD%95%E9%9F%B3%203.m4a',
    'C:\\Users\\someone\\Desktop\\10-5标题.m4a',
  ].join('\n');
  assert.deepEqual(parsePathList(text), ['测试录音.m4a', '123 Main St.m4a', '新录音 3.m4a', '10-5标题.m4a']);
  // macOS 文件名可能是分解形式（NFD），统一成 NFC
  assert.deepEqual(parsePathList('/a/cafe\u0301.m4a'), ['café.m4a']);
  assert.deepEqual(parsePathList(''), []);
});

test('isDefaultRecordingName / fileTitle：语音备忘录的默认名不当标题', () => {
  for (const n of ['123 Main St.m4a', '1600 Amphitheatre Pkwy 2.m4a', '新录音 3.m4a', '新錄音 12.m4a', 'New Recording 7.m4a', 'New Recording.m4a',
    '2024-10-05 10.15.m4a', '20241005 101500.m4a', '10-5.m4a', '10月5日.m4a', '下午 3:15.m4a', 'Audio Recording 2024-10-05 at 10.15.00.m4a',
    '3F2504E0-4F89-11D3-9A0C-0305E82C3301.m4a', '.m4a', '']) {
    assert.equal(isDefaultRecordingName(n), true, n);
  }
  for (const n of ['测试录音.m4a', '10-5标题.m4a', '小狗跳舞.m4a', '為什麼下雨.m4a', 'Main St.m4a', 'Ocean.m4a']) {
    assert.equal(isDefaultRecordingName(n), false, n);
  }
  assert.equal(fileTitle('测试录音.m4a'), '测试录音');
  assert.equal(fileTitle('/a/b/1.5 小时.m4a'), '1.5 小时');   // 只去掉音频扩展名
  assert.equal(fileTitle('新录音 3.m4a'), '');
  assert.equal(fileTitle('小狗跳舞'), '小狗跳舞');
});

test('nameDates：文件名里的日期', () => {
  assert.deepEqual(nameDates('10-5标题.m4a'), [{ y: null, m: 10, d: 5 }]);
  assert.deepEqual(nameDates('散步 3.12.m4a'), [{ y: null, m: 3, d: 12 }]);
  assert.deepEqual(nameDates('11月4日夜里.m4a'), [{ y: null, m: 11, d: 4 }]);
  assert.deepEqual(nameDates('2024-10-05 10.15.m4a'), [{ y: 2024, m: 10, d: 5 }]);
  assert.deepEqual(nameDates('20241005.m4a'), [{ y: 2024, m: 10, d: 5 }]);
  assert.deepEqual(nameDates('测试录音.m4a'), []);
  assert.deepEqual(nameDates('13-40.m4a'), []);
  assert.deepEqual(nameDates('123 Main St.m4a'), []);
});

test('recordedOnDate：同一天或第二天中午前', () => {
  const tz = 'America/Los_Angeles';
  assert.deepEqual(recordedOnDate(new Date('2024-10-06T06:10:00Z'), '2024-10-05', tz), { date: '2024-10-05', time: '23:10' });
  assert.deepEqual(recordedOnDate(new Date('2024-10-06T09:30:00Z'), '2024-10-05', tz), { date: '2024-10-06', time: '02:30' });
  assert.equal(recordedOnDate(new Date('2024-10-06T20:00:00Z'), '2024-10-05', tz), null, '第二天下午不算');
  assert.equal(recordedOnDate(new Date('2024-10-04T20:00:00Z'), '2024-10-05', tz), null, '前一天不算');
  assert.deepEqual(recordedOnDate(Date.UTC(2025, 0, 1, 10), '2024-12-31', tz), { date: '2025-01-01', time: '02:00' }, '跨年');
  assert.equal(recordedOnDate(null, '2024-10-05', tz), null);
  assert.equal(recordedOnDate(new Date('2024-10-06T06:10:00Z'), null, tz), null);
});

// suggestPairs 用的条目（一条一个录音位置，除非另说）
const E = (key, date, text, audioSlots = 1) => ({ key, date, text, audioSlots });
const F = (name, createdAt = null) => ({ name, size: 1000, createdAt, lastModified: 0 });
const TZ = 'America/Los_Angeles';
const pick = rows => rows.map(r => [r.fileName, r.evidence, r.confidence, r.conflict]);

test('suggestPairs：路径列表顺序最可靠（strong），默认名不拿去原话里找', () => {
  const entries = [
    E('a', '2024-01-02', `${NN}“新录音 3”`),
    E('b', '2024-03-05', `${NN}“去公园”`, 2),
    E('c', '2024-12-31', ''),
  ];
  const order = ['新录音 3.m4a', '123 Main St.m4a', '小狗跳舞.m4a', 'Ocean.m4a'];
  const files = [F('Ocean.m4a'), F('小狗跳舞.m4a'), F('123 Main St.m4a'), F('新录音 3.m4a')];
  const rows = suggestPairs(entries, files, { pathOrder: order });
  assert.deepEqual(rows.map(r => [r.slot, r.entrySlot, r.entryKey, r.expectedName]), [
    [0, 0, 'a', '新录音 3.m4a'], [1, 0, 'b', '123 Main St.m4a'], [2, 1, 'b', '小狗跳舞.m4a'], [3, 0, 'c', 'Ocean.m4a'],
  ]);
  assert.deepEqual(pick(rows), [
    ['新录音 3.m4a', ['pathOrder'], 'strong', false],
    ['123 Main St.m4a', ['pathOrder'], 'strong', false],
    ['小狗跳舞.m4a', ['pathOrder'], 'strong', false],
    ['Ocean.m4a', ['pathOrder'], 'strong', false],
  ]);
  // 路径列表里有、但没选这个文件 → 这个位置空着，expectedName 告诉界面缺哪个
  const r2 = suggestPairs(entries, files.slice(0, 3), { pathOrder: order });
  assert.equal(r2[0].fileName, null);
  assert.equal(r2[0].expectedName, '新录音 3.m4a');
  assert.deepEqual(r2[0].evidence, []);
});

test('suggestPairs：文件名里的日期（nameDate），只有一条依据 → weak', () => {
  const entries = [E('a', '2024-10-05', `${NN}“散步”`), E('b', '2024-10-20', `${NN}“看日落”`), E('c', '2024-11-03', `${NN}“下雪了”`)];
  const rows = suggestPairs(entries, [F('10.20.m4a'), F('10-5标题.m4a')]);
  assert.deepEqual(pick(rows), [
    ['10-5标题.m4a', ['nameDate'], 'weak', false],
    ['10.20.m4a', ['nameDate'], 'weak', false],
    [null, [], 'weak', false],
  ]);
});

test('suggestPairs：文件名出现在原话里（简繁折叠；部分命中 ≥2 个连续汉字）', () => {
  const entries = [E('a', '2024-10-05', `${NN}“为什么下雨了”`), E('b', '2024-10-20', `${NN}“小狗在开会”`), E('c', '2024-11-03', `${NN}“好的”`)];
  const rows = suggestPairs(entries, [F('小狗派對.m4a'), F('為什麼下雨.m4a'), F('火车.m4a'), F('新录音 4.m4a')]);
  assert.deepEqual(pick(rows), [
    ['為什麼下雨.m4a', ['titleInText'], 'weak', false],
    ['小狗派對.m4a', ['titleInText'], 'weak', false],
    [null, [], 'weak', false],
  ]);
  assert.deepEqual(rows.map(r => r.titleMatch), ['full', 'partial', undefined]);
  // 只有一个汉字相同不算
  assert.equal(suggestPairs([E('a', '2024-10-05', `${NN}“下午”`)], [F('雨天.m4a'), F('新录音 1.m4a')])[0].fileName, null);
  // 文件名和别的条目更吻合（这里只部分吻合，别处整个出现）→ 也标矛盾
  const r3 = suggestPairs([E('a', '2024-10-05', `${NN}“下雨”`), E('b', '2024-10-06', `${NN}“下雨天”`)], [F('下雨天.m4a'), F('甲.m4a')], { pathOrder: ['下雨天.m4a', '甲.m4a'] });
  assert.deepEqual(r3[0].evidence, ['pathOrder', 'titleInText']);
  assert.deepEqual(r3[0].conflicts, ['titleInText']);
  // 「10-5标题」：日期 + 名字的一部分（标题）都对上 → strong
  const r2 = suggestPairs([E('a', '2024-10-04', `${NN}“标题”`), E('b', '2024-10-05', `${NN}“那个标题”`)], [F('10-5标题.m4a')]);
  assert.deepEqual(pick(r2), [[null, [], 'weak', false], ['10-5标题.m4a', ['nameDate', 'titleInText'], 'strong', false]]);
});

test('suggestPairs：录音时间（mp4Date）当天或第二天中午前；和文件名依据合起来 → strong', () => {
  const entries = [E('a', '2024-10-05', ''), E('b', '2024-10-20', `${NN}“散步”`)];
  const files = [F('散步.m4a', new Date('2024-10-21T09:30:00Z')), F('测试录音.m4a', new Date('2024-10-06T06:10:00Z'))];
  const rows = suggestPairs(entries, files, { tz: TZ });
  assert.deepEqual(pick(rows), [
    ['测试录音.m4a', ['mp4Date', 'order'], 'strong', false],
    ['散步.m4a', ['titleInText', 'mp4Date', 'order'], 'strong', false],
  ]);
  // 第二天下午录的不算这一天
  const r2 = suggestPairs([E('a', '2024-10-05', '')], [F('测试录音.m4a', new Date('2024-10-06T20:00:00Z')), F('另一个.m4a')], { tz: TZ });
  assert.equal(r2[0].fileName, null);
});

test('suggestPairs：依据互相矛盾 → conflict（路径顺序说是这个，但录音时间 / 文件名日期 / 标题指向别处）', () => {
  const entries = [E('a', '2024-10-05', `${NN}“好的”`), E('b', '2024-11-03', `${NN}“去散步吧”`)];
  const order = ['11-3散步.m4a', '测试录音.m4a'];
  const files = [F('11-3散步.m4a'), F('测试录音.m4a', new Date('2024-10-05T20:00:00Z'))];
  const rows = suggestPairs(entries, files, { pathOrder: order, tz: TZ });
  assert.deepEqual(pick(rows), [
    ['11-3散步.m4a', ['pathOrder'], 'strong', true],
    ['测试录音.m4a', ['pathOrder'], 'strong', true],
  ]);
  assert.deepEqual(rows[0].conflicts, ['nameDate', 'titleInText']);
  assert.deepEqual(rows[1].conflicts, ['mp4Date']);
  // 路径列表的个数和录音位置数对不上：顺序靠不住，也标出来
  const r2 = suggestPairs([E('a', '2024-10-05', '')], [F('测试录音.m4a')], { pathOrder: ['测试录音.m4a', '另一个.m4a'] });
  assert.deepEqual(r2[0].conflicts, ['pathCount']);
  assert.equal(r2[0].conflict, true);
  // 路径列表说这个位置该是 X，可 X 被更强的依据……这里 X 就在：不会配给别人
  const r3 = suggestPairs([E('a', '2024-10-05', ''), E('b', '2024-10-06', '')], [F('一.m4a'), F('二.m4a')], { pathOrder: ['二.m4a', '一.m4a'] });
  assert.deepEqual(r3.map(r => r.fileName), ['二.m4a', '一.m4a']);
});

test('suggestPairs：没有路径列表、个数相同 → 按顺序（有 mp4 时间就按时间排），只有 order → weak', () => {
  const entries = [E('a', '2024-01-01', ''), E('b', '2024-06-01', ''), E('c', '2025-01-01', '')];
  const noTime = suggestPairs(entries, [F('甲.m4a'), F('乙.m4a'), F('丙.m4a')]);
  assert.deepEqual(pick(noTime), [['甲.m4a', ['order'], 'weak', false], ['乙.m4a', ['order'], 'weak', false], ['丙.m4a', ['order'], 'weak', false]]);
  // 按录音时间排：给的顺序是乱的；时间对不上这一天 → 标矛盾
  const t = d => new Date(d + 'T20:00:00Z');
  const timed = suggestPairs(entries, [F('丙.m4a', t('2025-01-01')), F('甲.m4a', t('2024-01-01')), F('乙.m4a', t('2024-07-15'))], { tz: TZ });
  assert.deepEqual(pick(timed), [
    ['甲.m4a', ['mp4Date', 'order'], 'strong', false],
    ['乙.m4a', ['order'], 'weak', true],
    ['丙.m4a', ['mp4Date', 'order'], 'strong', false],
  ]);
  // 个数不同就不按顺序猜
  assert.deepEqual(suggestPairs(entries, [F('甲.m4a'), F('乙.m4a')]).map(r => r.fileName), [null, null, null]);
});

test('suggestPairs：一条里有两段录音 → 按录音时间先后；一个文件只配一个位置', () => {
  const entries = [E('a', '2024-10-05', '', 2), E('b', '2024-10-07', '')];
  const files = [F('后.m4a', new Date('2024-10-06T08:00:00Z')), F('先.m4a', new Date('2024-10-06T07:00:00Z')), F('别的.m4a', new Date('2024-10-08T03:00:00Z'))];
  const rows = suggestPairs(entries, files, { tz: TZ });
  assert.deepEqual(rows.map(r => [r.entryKey, r.entrySlot, r.fileName]), [['a', 0, '先.m4a'], ['a', 1, '后.m4a'], ['b', 0, '别的.m4a']]);
  assert.equal(new Set(rows.map(r => r.fileName)).size, 3);
  assert.deepEqual(suggestPairs([], files), []);
  assert.deepEqual(suggestPairs(entries, []).map(r => r.fileName), [null, null, null]);
});

test('parseNote + suggestPairs 连起来：笔记的录音位置按顺序对上路径列表', () => {
  const r = parseNote(NOTE);
  const names = ['一.m4a', '二.m4a', '三.m4a', '四.m4a', '五.m4a', '六.m4a'];
  const rows = suggestPairs(r.entries, names.map(n => F(n)), { pathOrder: names });
  assert.deepEqual(rows.map(x => [x.entryKey, x.fileName]), [
    ['n_2024-01-02_1', '一.m4a'], ['n_2024-03-05_1', '二.m4a'], ['n_2024-03-05_1', '三.m4a'],
    ['n_2024-12-31_1', '四.m4a'], ['n_2024-01-02_2', '五.m4a'], ['n_2024-01-02_2', '六.m4a'],
  ]);
  assert.ok(rows.every(x => x.confidence === 'strong' && !x.conflict));
});
