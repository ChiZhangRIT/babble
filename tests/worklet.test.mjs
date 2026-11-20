// 采集 worklet 测试：Node 里直接 import（没有 registerProcessor）测降采样；再装上假的 AudioWorklet 全局测处理器。全部合成信号
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimator } from '../src/worklets/capture.worklet.js';
import { tone, noise, rng, rmsDb } from './helpers/signal.mjs';

/** 把 x 按 chunk 个一份推进去，收集全部输出 */
function decimate(inRate, x, chunk = 128) {
  const blocks = [], d = new Decimator(inRate, { block: 256, onBlock: (b) => blocks.push(b) });
  for (let o = 0; o < x.length; o += chunk) d.push(x.subarray(o, o + chunk));
  const out = new Float32Array(blocks.length * 256);
  blocks.forEach((b, i) => out.set(b, i * 256));
  return out;
}

test('Node 里能 import：没有 registerProcessor 也不出错，只导出 Decimator', () => {
  assert.equal(typeof globalThis.registerProcessor, 'undefined');
  assert.equal(typeof Decimator, 'function');
});

for (const inRate of [48000, 44100]) {
  test(`${inRate} → 16000：随机大小地推 10,000 次，输出个数一直在理论值 ±1 以内`, () => {
    let got = 0, fed = 0;
    const d = new Decimator(inRate, { block: 1, onBlock: () => { got++; } }), r = rng(inRate), buf = new Float32Array(1000);
    for (let i = 0; i < 10000; i++) {
      const n = Math.floor((r() + 1) * 300);                          // 0..599，偶尔是 0
      d.push(buf.subarray(0, n)); fed += n;
      assert.ok(Math.abs(got - fed * 16000 / inRate) <= 1, `第 ${i} 次：输入 ${fed}，输出 ${got}`);
    }
    assert.ok(fed > 2000000);
  });

  test(`${inRate}：1 kHz 通过（±1 dB），12 kHz 至少衰减 30 dB`, () => {
    const pass = decimate(inRate, tone(2, -20, 1000, inRate)), stop = decimate(inRate, tone(2, -20, 12000, inRate));
    const lvl = (y) => rmsDb(y, 200, y.length);                       // 跳过开头滤波器还没填满的那几个
    assert.ok(Math.abs(lvl(pass) - -20) <= 1, `1 kHz：${lvl(pass).toFixed(2)} dB`);
    assert.ok(lvl(stop) <= -50, `12 kHz：${lvl(stop).toFixed(1)} dB`);
  });

  test(`${inRate}：3 kHz 正弦降下来和理想的 16 kHz 采样逐点对得上（小数步长的插值没错位、不漂）`, () => {
    const A = 0.5, y = decimate(inRate, tone(4, 20 * Math.log10(A / Math.SQRT2), 3000, inRate), 100);
    const delay = 16 / inRate;                                         // 33 抽头 FIR 的群延迟：16 个输入样本
    let worst = 0;
    for (let j = 100; j < y.length; j++) worst = Math.max(worst, Math.abs(y[j] - A * Math.sin(2 * Math.PI * 3000 * (j / 16000 - delay))));
    assert.ok(worst < 0.03 * A, `最大误差 ${(worst / A * 100).toFixed(2)}%`);
  });
}

test('每块正好 4096 个样本，每块都是新的数组（交出去的不会再被写）', () => {
  const got = [], d = new Decimator(48000, { onBlock: (b) => got.push(b) }), x = noise(3, -30, 3, 48000);
  for (let o = 0; o < x.length; o += 128) d.push(x.subarray(o, o + 128));
  assert.equal(got.length, Math.floor(3 * 16000 / 4096));
  assert.ok(got.every(b => b instanceof Float32Array && b.length === 4096));
  assert.equal(new Set(got.map(b => b.buffer)).size, got.length);
  const one = new Decimator(44100, { block: 1000, onBlock: (b) => assert.equal(b.length, 1000) });
  one.push(noise(1, -30, 4, 44100));
});

test('装上假的 AudioWorklet 全局：注册 babble-capture，process 一直返回 true，块是转交的，没输入就不发', async () => {
  const reg = {}, sent = [];
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage(msg, transfer) { sent.push({ msg: structuredClone(msg, { transfer }), detached: msg.pcm.buffer.byteLength === 0 && transfer[0] === msg.pcm.buffer }); } };
    }
  };
  globalThis.registerProcessor = (name, cls) => { reg[name] = cls; };
  try {
    await import('../src/worklets/capture.worklet.js?worklet');
    const Proc = reg['babble-capture'];
    assert.equal(typeof Proc, 'function');
    const p = new Proc({ processorOptions: { outRate: 16000, block: 4096 } });
    for (const inputs of [[], [[]], [[]], []]) assert.equal(p.process(inputs, []), true);
    assert.equal(sent.length, 0, '没有输入声道：什么都不发');

    const x = tone(0.6, -20, 1000, 48000);
    for (let o = 0; o + 128 <= x.length; o += 128) assert.equal(p.process([[x.subarray(o, o + 128)]], []), true);
    assert.equal(sent.length, Math.floor(0.6 * 16000 / 4096));
    for (const { msg, detached } of sent) {
      assert.equal(msg.type, 'block');
      assert.ok(msg.pcm instanceof Float32Array && msg.pcm.length === 4096);
      assert.ok(detached, '转交了 pcm.buffer（发送方那边已经分离）');
    }
    assert.ok(Math.abs(rmsDb(sent[1].msg.pcm) - -20) < 1, '转交之后下一块照样有内容');
  } finally {
    delete globalThis.sampleRate; delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor;
  }
});
