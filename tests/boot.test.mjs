// src/boot.js（第一次绘制前定深浅色的小脚本）：和 app 用的 isNight 规则一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isNight } from '../src/core/dates.js';

const SRC = fs.readFileSync(new URL('../src/boot.js', import.meta.url), 'utf8');

function boot({ settings, local = {}, at, hash = '', systemDark = false }) {
  const attrs = {};
  const store = { 'babble.state': settings === undefined ? null : JSON.stringify({ settings }), 'babble.local': JSON.stringify(local) };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [at])); } }
  vm.runInNewContext(SRC, {
    localStorage: { getItem: k => store[k] ?? null },
    location: { hash },
    window: { matchMedia: () => ({ matches: systemDark }) },
    matchMedia: () => ({ matches: systemDark }),
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
    Date: FakeDate, JSON, Number,
  });
  return attrs;
}

test('夜里（默认 21:00–07:00）且夜里强制深色 → dark，冷启动在列表 → 先刷录音页的近黑；白天按本机设置 / 系统外观', () => {
  const at = h => new Date(2026, 10, 11, h, 30).getTime();
  assert.deepEqual(boot({ settings: {}, at: at(2) }), { 'data-theme': 'dark', 'data-boot': 'rec' });
  assert.deepEqual(boot({ settings: {}, at: at(2), hash: '#/e/x' }), { 'data-theme': 'dark' });
  assert.deepEqual(boot({ settings: {}, at: at(2), hash: '#/cal/2026-11-04' }), { 'data-theme': 'dark', 'data-boot': 'rec' });   // 日历也算「呓语」
  assert.deepEqual(boot({ settings: {}, at: at(14) }), { 'data-theme': 'light' });
  assert.deepEqual(boot({ settings: {}, at: at(14), systemDark: true }), { 'data-theme': 'dark' });
  assert.deepEqual(boot({ settings: {}, at: at(14), local: { theme: 'dark' } }), { 'data-theme': 'dark' });
  assert.deepEqual(boot({ settings: {}, at: at(14), local: { theme: 'light' }, systemDark: true }), { 'data-theme': 'light' });
  assert.deepEqual(boot({ settings: { nightForcesDark: false, nightOpensRecorder: false }, at: at(23), local: { theme: 'light' } }), { 'data-theme': 'light' });
  assert.deepEqual(boot({ settings: undefined, at: at(14), hash: '#/rec' }), { 'data-theme': 'light', 'data-boot': 'rec' });
});

test('夜间时段的判断和 core/dates.js 的 isNight 一样（跨午夜、不跨午夜、起止相同、写坏了用默认）', () => {
  const cases = [{}, { nightStart: '22:30', nightEnd: '06:15' }, { nightStart: '01:00', nightEnd: '05:00' }, { nightStart: '08:00', nightEnd: '08:00' }, { nightStart: 'bad', nightEnd: '07:00' }];
  for (const s of cases) {
    for (let m = 0; m < 24 * 60; m += 15) {
      const t = new Date(2026, 0, 2, 0, m).getTime();
      const norm = { nightStart: /^\d\d:\d\d$/.test(s.nightStart || '') ? s.nightStart : '21:00', nightEnd: /^\d\d:\d\d$/.test(s.nightEnd || '') ? s.nightEnd : '07:00' };
      const want = isNight(new Date(t), norm);
      assert.equal(boot({ settings: { ...s, nightOpensRecorder: false }, at: t })['data-theme'] === 'dark', want, JSON.stringify(s) + ' ' + m);
    }
  }
});

test('启动看门狗：10 秒还没启动（window.__babble 没有）→ 显示「重新载入」；启动了就不显示', () => {
  for (const booted of [false, true]) {
    const timers = [], added = [];
    const el = () => ({ style: {}, setAttribute() {}, appendChild(c) { (this.kids = this.kids || []).push(c); }, remove() {} });
    const win = { matchMedia: () => ({ matches: false }), addEventListener() {} };
    if (booted) win.__babble = {};
    vm.runInNewContext(SRC, {
      localStorage: { getItem: () => null }, location: { hash: '', reload() {} }, navigator: { language: 'zh-CN' },
      window: win, matchMedia: () => ({ matches: false }),
      document: { documentElement: { setAttribute() {} }, body: { appendChild: (n) => added.push(n) }, createElement: el },
      setTimeout: (fn, ms) => timers.push([fn, ms]), setInterval: () => 0, clearInterval() {}, Date, JSON, Number, String,
    });
    const t10 = timers.find(([, ms]) => ms === 10000);
    assert.ok(t10, '定了 10 秒的看门狗');
    t10[0]();
    assert.equal(added.length, booted ? 0 : 1);
    if (!booted) assert.equal(added[0].kids[1].textContent, '重新载入');
  }
});
