import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, daysIn, dow, addDays, shiftMonth, shiftDay, monthGrid, dayIndex, countIn, nearestDate, parseCalPath, weekdayNames } from '../src/views/calendar.js';
import { entryLabel } from '../src/views/record.js';
import { makeEntry } from '../src/core/store.js';
import { STRINGS } from '../src/i18n.js';

// 日历页里不碰 DOM 的部分：月份格子、每天几条、翻月、最近的一天、地址解析、星期表头。全是编的例子
const NN = '👰🏻‍♀️';
const SP = { nn: { name: 'NN', emoji: NN, aliases: [] }, me: { name: '', emoji: '🥷🏻', aliases: [] } };
const E = (id, fields) => makeEntry({ id, ...fields }, 1000);

test('一周从哪天开始：简体星期一，繁体（台湾）和英文星期日；表头跟着排', () => {
  assert.equal(weekStart('zh-Hans'), 1);
  assert.equal(weekStart('zh-Hant-TW'), 0);
  assert.equal(weekStart('en'), 0);
  assert.deepEqual(weekdayNames('zh-Hans'), ['一', '二', '三', '四', '五', '六', '日']);
  assert.deepEqual(weekdayNames('zh-Hant-TW'), ['日', '一', '二', '三', '四', '五', '六']);
  assert.deepEqual(weekdayNames('en'), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
});

test('日期计算：每月天数（闰年）、星期几、加减天数、翻月跨年、隔月同一天到月底', () => {
  assert.equal(daysIn('2024-02'), 29);
  assert.equal(daysIn('2026-02'), 28);
  assert.equal(daysIn('2026-11'), 30);
  assert.equal(dow('2026-11-01'), 0);            // 星期日
  assert.equal(dow('2026-11-04'), 3);
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftMonth('2026-11', 1), '2026-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-03', -15), '2024-12');
  assert.equal(shiftMonth('2026-03', 24), '2028-03');
  assert.equal(shiftDay('2026-01-31', 1), '2026-02-28');
  assert.equal(shiftDay('2024-03-31', -1), '2024-02-29');
  assert.equal(shiftDay('2026-11-04', -12), '2025-11-04');
});

test('月份格子：前面按一周起始空格，整周补齐', () => {
  // 2026 年 11 月 1 日是星期日
  const mon = monthGrid('2026-11', 1);
  assert.equal(mon.length % 7, 0);
  assert.deepEqual(mon.slice(0, 7), [null, null, null, null, null, null, '2026-11-01']);
  assert.equal(mon.filter(Boolean).length, 30);
  assert.equal(mon[mon.length - 1], null);
  const sun = monthGrid('2026-11', 0);
  assert.equal(sun[0], '2026-11-01');
  assert.equal(sun.length, 35);
  assert.equal(monthGrid('2026-02', 0).length, 28);   // 2026 年 2 月正好 4 周，从星期日开始
});

test('每天几条：已删除的不算、待整理的算；有录音、有待整理分别标出', () => {
  const list = [
    E('a', { date: '2026-11-04', text: `${NN}“一”`, audio: [{ sha256: 'a'.repeat(64), mime: 'audio/mp4' }] }),
    E('b', { date: '2026-11-04', status: 'inbox' }),
    E('c', { date: '2026-10-02', text: `${NN}“二”` }),
    { ...E('d', { date: '2026-11-04' }), deleted: true },
    E('e', { date: '2026-11-20' }),
  ];
  const idx = dayIndex(list);
  assert.deepEqual(idx.get('2026-11-04'), { n: 2, audio: true, inbox: true, ids: ['a', 'b'] });
  assert.deepEqual(idx.get('2026-10-02'), { n: 1, audio: false, inbox: false, ids: ['c'] });
  assert.equal(idx.size, 3);
  assert.equal(countIn(idx, '2026-11'), 3);
  assert.equal(countIn(idx, '2026-10'), 1);
  assert.equal(countIn(idx, '2026'), 4);
  assert.equal(countIn(idx, '2025-11'), 0);
  assert.equal(dayIndex([]).size, 0);
});

test('这个月没有时最近的一天：之前之后取更近的，一样近取后面；没有条目 → null', () => {
  const dates = ['2025-12-24', '2026-06-15', '2026-10-02'];
  assert.equal(nearestDate(dates, '2026-11'), '2026-10-02');     // 这个月之后没有：最新的一条
  assert.equal(nearestDate(dates, '2026-05'), '2026-06-15');     // 5/31 → 6/15 比 12/24 → 5/1 近
  assert.equal(nearestDate(dates, '2026-02'), '2025-12-24');     // 12/24 → 2/1 比 2/28 → 6/15 近
  assert.equal(nearestDate(dates, '2024-01'), '2025-12-24');
  assert.equal(nearestDate(['2026-01-31', '2026-03-01'], '2026-02'), '2026-03-01');   // 都差 1 天：取后面
  assert.equal(nearestDate([], '2026-11'), null);
  assert.equal(nearestDate(new Map([['2026-01-01', {}]]).keys(), '2026-11'), '2026-01-01');
});

test('地址：#/cal/YYYY-MM、#/cal/YYYY-MM-DD；不存在的日期、乱写的 → null', () => {
  assert.deepEqual(parseCalPath('2026-11'), { month: '2026-11', day: null });
  assert.deepEqual(parseCalPath('2026-11-04'), { month: '2026-11', day: '2026-11-04' });
  assert.equal(parseCalPath('2026-13'), null);
  assert.equal(parseCalPath('2026-02-30'), null);
  assert.equal(parseCalPath('abc'), null);
  assert.equal(parseCalPath(undefined), null);
});

test('别处的条目称呼（录音页「已存到」、导入时选条目、修改记录）：日期时间 + 第一句的开头（截短）；没写原话用录音的名字；存着的标题不用', () => {
  assert.equal(entryLabel(E('x', { date: '2026-11-04', time: '02:58', title: '旧标题', text: `${NN}“一句话”` }), SP, 'zh-Hans'), '2026年11月4日 凌晨2:58 · “一句话”');
  assert.equal(entryLabel(E('y', { date: '2026-11-04', text: `${NN}“今天吃什么”` }), SP, 'zh-Hans'), '2026年11月4日 · “今天吃什么”');
  const long = entryLabel(E('z', { date: '2026-11-04', text: `${NN}“这是一句很长很长很长很长很长很长的梦话”` }), SP, 'zh-Hans');
  assert.ok(long.endsWith('…') && long.length < 40, long);
  assert.equal(entryLabel(E('w', { date: '2026-11-04' }), SP, 'en'), 'Nov 4, 2026');
  assert.equal(entryLabel(E('v', { date: '2026-11-04', time: '02:58' }), SP, 'en'), 'Nov 4, 2026, 2:58 AM');
  const clip = (over) => ({ sha256: 'a'.repeat(64), mime: 'audio/mp4', ...over });
  assert.equal(entryLabel(E('u', { date: '2026-11-04', title: '旧标题', audio: [clip({}), clip({ sha256: 'b'.repeat(64), origName: '测试录音.m4a' })] }), SP, 'zh-Hans'), '2026年11月4日 · 🎙 测试录音');
  assert.equal(entryLabel(E('t', { date: '2026-11-04', audio: [clip({ name: '下雨了' })] }), SP, 'zh-Hant-TW'), '2026年11月4日 · 🎙 下雨了');
  assert.equal(entryLabel(E('s', { date: '2026-11-04', text: `${NN}“有字”`, audio: [clip({ name: '下雨了' })] }), SP, 'zh-Hans'), '2026年11月4日 · “有字”');   // 有原话用原话
});

test('条目没有标题：标题相关的文案都去掉了，界面文案里不再说「标题」', () => {
  for (const lang of Object.keys(STRINGS)) {
    for (const k of ['list.noTitle', 'edit.title', 'edit.titlePh', 'hist.f.title', 'hist.titleChange', 'imp.title', 'imp.titlePh', 'imp.defaultName', 'imp.r.defaultName']) {
      assert.equal(STRINGS[lang][k], undefined, lang + ' ' + k);
    }
    for (const [k, v] of Object.entries(STRINGS[lang])) {
      if (typeof v === 'string') assert.doesNotMatch(v.replace(/\{\w+\}/g, ''), /标题|標題|\btitles?\b/i, lang + ' ' + k);
    }
  }
  assert.deepEqual(['zh-Hans', 'zh-Hant-TW'].map(l => STRINGS[l]['list.search']), ['搜原话、背景、录音名', '搜尋原話、背景、錄音名稱']);
  assert.deepEqual(['zh-Hans', 'zh-Hant-TW'].map(l => [STRINGS[l]['list.more'], STRINGS[l]['list.less']]), [['展开全部（还有 {n} 行）', '收起'], ['展開全部（還有 {n} 行）', '收合']]);
  assert.deepEqual([STRINGS.en['list.more']({ n: 5 }), STRINGS.en['list.more']({ n: 1 }), STRINGS.en['list.less']], ['Show all (5 more lines)', 'Show all (1 more line)', 'Show less']);
  assert.equal(STRINGS['zh-Hant-TW']['cal.cal'], '日曆');
});
