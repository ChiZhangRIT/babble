import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localParts, isNight, daypart, fmtEntryDate, fmtDate, fmtTime, fmtMonth, fmtYear, fmtDuration, fmtTimer, monthKey, isISODate, isTime, today, daysAgo,
} from '../src/core/dates.js';

test('localParts：某一刻在指定时区的日期和钟表时间（凌晨的录音算当天）', () => {
  assert.deepEqual(localParts('2026-11-04T10:58:00Z', 'America/Los_Angeles'), { date: '2026-11-04', time: '02:58' });
  assert.deepEqual(localParts(Date.UTC(2026, 6, 1, 6, 5), 'America/Los_Angeles'), { date: '2026-06-30', time: '23:05' }, '夏令时');
  assert.deepEqual(localParts(new Date('2026-01-01T16:30:00Z'), 'Asia/Shanghai'), { date: '2026-01-02', time: '00:30' }, '午夜是 00 不是 24');
  assert.deepEqual(localParts('2026-11-04T10:58:00Z', 'Not/AZone'), localParts('2026-11-04T10:58:00Z'), '不认识的时区退回本机');
  assert.equal(localParts('不是日期'), null);
  assert.equal(localParts(NaN), null);
});

test('isNight：默认 21:00–07:00 跨午夜；不跨午夜的区间；起止相同 = 没有夜间', () => {
  const at = (h, m = 0) => new Date(2026, 10, 4, h, m);
  const def = {};
  for (const [h, m, want] of [[21, 0, true], [23, 30, true], [0, 0, true], [6, 59, true], [7, 0, false], [12, 0, false], [20, 59, false]]) {
    assert.equal(isNight(at(h, m), def), want, `${h}:${m}`);
  }
  const day = { nightStart: '13:00', nightEnd: '15:00' };
  assert.equal(isNight(at(14), day), true);
  assert.equal(isNight(at(15), day), false);
  assert.equal(isNight(at(3), { nightStart: '07:00', nightEnd: '07:00' }), false);
  assert.equal(isNight(at(3), { nightStart: 'bad', nightEnd: '07:00' }), false);
  assert.equal(isNight(at(22).getTime(), def), true, '毫秒时间戳也行');
});

test('daypart：凌晨 0–5、早上 5–12、下午 12–18、晚上 18–24', () => {
  const cases = { '00:00': 'lateNight', '04:59': 'lateNight', '05:00': 'morning', '11:59': 'morning', '12:00': 'afternoon', '17:59': 'afternoon', '18:00': 'evening', '23:59': 'evening' };
  for (const [time, want] of Object.entries(cases)) assert.equal(daypart(time), want, time);
  assert.equal(daypart(null), null);
  assert.equal(daypart('24:00'), null);
});

test('fmtEntryDate：中文「2026年11月4日 · 凌晨2:58」，英文「Nov 4, 2026 · 2:58 AM」，不知道时间就只有日期', () => {
  const e = { date: '2026-11-04', time: '02:58' };
  assert.equal(fmtEntryDate(e, 'zh-Hans'), '2026年11月4日 · 凌晨2:58');
  assert.equal(fmtEntryDate(e, 'zh-Hant-TW'), '2026年11月4日 · 凌晨2:58');
  assert.equal(fmtEntryDate(e, 'en'), 'Nov 4, 2026 · 2:58 AM');
  assert.equal(fmtEntryDate({ date: '2024-01-01', time: null }, 'zh-Hans'), '2024年1月1日');
  assert.equal(fmtEntryDate({ date: '2024-01-01', time: null }, 'en'), 'Jan 1, 2024');
  assert.equal(fmtEntryDate(e, 'zh-Hans', { year: false, sep: ' ' }), '11月4日 凌晨2:58');
  assert.equal(fmtEntryDate(null), '');
});

test('fmtTime：凌晨0:46、早上7:05、下午12:30、下午1:05、晚上11:41；英文 12 小时制', () => {
  const zh = { '00:46': '凌晨0:46', '07:05': '早上7:05', '12:30': '下午12:30', '13:05': '下午1:05', '23:41': '晚上11:41' };
  for (const [time, want] of Object.entries(zh)) assert.equal(fmtTime(time, 'zh-Hans'), want);
  const en = { '00:46': '12:46 AM', '07:05': '7:05 AM', '12:30': '12:30 PM', '23:41': '11:41 PM' };
  for (const [time, want] of Object.entries(en)) assert.equal(fmtTime(time, 'en'), want);
  assert.equal(fmtTime(null, 'zh-Hans'), '');
});

test('日期、月份、年份；格式不对原样返回或为空', () => {
  assert.equal(fmtDate('2026-11-04', 'zh-Hans', { year: false }), '11月4日');
  assert.equal(fmtDate('2026-11-04', 'en', { year: false }), 'Nov 4');
  assert.equal(fmtDate('11/4', 'zh-Hans'), '11/4');
  assert.equal(fmtMonth('2026-11', 'zh-Hans'), '2026年11月');
  assert.equal(fmtMonth('2026-11', 'zh-Hans', { year: false }), '11月');
  assert.equal(fmtMonth('2026-11', 'en'), 'November 2026');
  assert.equal(fmtYear(2026, 'zh-Hant-TW'), '2026年');
  assert.equal(fmtYear(2026, 'en'), '2026');
  assert.equal(monthKey('2026-11-04'), '2026-11');
  assert.equal(monthKey(''), '');
  assert.equal(monthKey(null), '');
});

test('时长：0:42、1:05、1:02:03；计时器 00:42', () => {
  assert.equal(fmtDuration(42), '0:42');
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(65.4), '1:05');
  assert.equal(fmtDuration(3723), '1:02:03');
  assert.equal(fmtDuration(null), '');
  assert.equal(fmtDuration(NaN), '');
  assert.equal(fmtTimer(42.9), '00:42');
  assert.equal(fmtTimer(600), '10:00');
});

test('校验：真实日期、时间格式；today、daysAgo 用本机日历', () => {
  assert.equal(isISODate('2024-02-29'), true);
  assert.equal(isISODate('2025-02-29'), false);
  assert.equal(isISODate('2026-1-4'), false);
  assert.equal(isTime('02:58'), true);
  assert.equal(isTime('2:58'), false);
  assert.equal(isTime('24:00'), false);
  assert.equal(today(new Date(2026, 0, 2, 3, 4)), '2026-01-02');
  const now = new Date(2026, 10, 11, 9, 0);
  assert.equal(daysAgo(new Date(2026, 10, 8, 23, 0).getTime(), now), 3);
  assert.equal(daysAgo(new Date(2026, 10, 11, 0, 1).getTime(), now), 0);
  assert.equal(daysAgo('bad', now), null);
});
