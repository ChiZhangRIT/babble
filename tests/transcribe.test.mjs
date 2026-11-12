// 语音转文字（core/transcribe.js）：模型表、选后端、按说话分段、整理识别结果、合进草稿、填进原话，
// 以及在假 worker 上跑的任务流程（下载进度、识别、取消、显卡出错换处理器、内存不够）和模型缓存的大小 / 删除。
// 全是合成的信号和编出来的句子（仓库是公开的，不放真的梦话和录音）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../src/core/transcribe.js';
import { T2S, toSimplified } from '../src/core/hanzi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 16000;
const NN = '👰🏻‍♀️', ME = '🥷🏻';
const SP = { nn: { name: 'NN', emoji: NN, aliases: [] }, me: { name: '', emoji: ME, aliases: [] } };

// ---------- 合成信号：均匀噪声底 + 正弦「说话」 ----------
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
/** parts: [[起秒, 止秒, dBFS, 频率]]；noiseDb = null → 数字静音 */
function signal(sec, parts = [], { noiseDb = -60, seed = 7 } = {}) {
  const n = Math.round(sec * SR), x = new Float32Array(n), rnd = lcg(seed);
  const na = noiseDb == null ? 0 : Math.pow(10, noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) x[i] = na * rnd();
  for (const [a, b, db = -20, f = 220] of parts) {
    const amp = Math.pow(10, db / 20) * Math.SQRT2;
    for (let i = Math.round(a * SR); i < Math.min(n, Math.round(b * SR)); i++) x[i] += amp * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return x;
}
const secs = segs => segs.map(([a, b]) => [+(a / SR).toFixed(2), +(b / SR).toFixed(2)]);
const near = (got, want, tol = 0.06) => {
  assert.equal(got.length, want.length, JSON.stringify(got));
  got.forEach(([a, b], i) => { assert.ok(Math.abs(a - want[i][0]) <= tol && Math.abs(b - want[i][1]) <= tol, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); });
};

test('模型表：固定版本，按后端选文件；缓存地址带版本号', () => {
  assert.deepEqual(T.MODEL_KEYS, ['base', 'small']);
  assert.equal(T.DEFAULT_MODEL, 'base');
  assert.match(T.MODELS.base.revision, /^[0-9a-f]{40}$/);
  assert.match(T.MODELS.small.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(T.modelFiles('base', 'wasm').filter(f => f.endsWith('.onnx')), ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
  assert.deepEqual(T.modelFiles('base', 'webgpu').filter(f => f.endsWith('.onnx')), ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx']);
  assert.deepEqual(T.modelFiles('small', 'webgpu').filter(f => f.endsWith('.onnx')), ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx']);
  for (const k of T.MODEL_KEYS) for (const e of T.ENGINES) assert.ok(T.modelFiles(k, e).includes('tokenizer.json'));
  assert.equal(T.modelPrefix('base'), `https://huggingface.co/onnx-community/whisper-base/resolve/${T.MODELS.base.revision}/`);
  assert.ok(T.modelPrefix('base').startsWith(T.repoPrefix('base')));
  assert.ok(T.MODELS.base.wasm.bytes < T.MODELS.small.wasm.bytes);
});

test('设备：iPhone / iPad 只用处理器、只给标准；Mac 有 WebGPU 用显卡（更准还要 shader-f16）', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
  const ipadDesktop = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 };
  assert.equal(T.isMobileDevice(iphone), true);
  assert.equal(T.isMobileDevice(ipadDesktop), true);
  assert.equal(T.isMobileDevice(mac), false);
  assert.equal(T.isMobileDevice(null), false);
  assert.equal(T.modelAllowed('small', { mobile: true }), false);
  assert.equal(T.modelAllowed('base', { mobile: true }), true);
  assert.equal(T.modelAllowed('small', { mobile: false }), true);
  assert.equal(T.modelAllowed('huge', {}), false);
  assert.equal(T.pickEngine('base', { mobile: true, gpu: true, f16: true }), 'wasm');
  assert.equal(T.pickEngine('base', { gpu: true }), 'webgpu');
  assert.equal(T.pickEngine('base', { gpu: true, useGpu: false }), 'wasm');
  assert.equal(T.pickEngine('base', { gpu: false }), 'wasm');
  assert.equal(T.pickEngine('small', { gpu: true, f16: false }), 'wasm');
  assert.equal(T.pickEngine('small', { gpu: true, f16: true }), 'webgpu');
});

test('分段：两句之间停很久 → 两段，前后各留 0.25 秒', () => {
  near(secs(T.speechSegments(signal(16, [[2, 4], [10, 12]]))), [[1.75, 4.25], [9.75, 12.25]]);
});

test('分段：停顿短（≤ 1.5 秒）的并成一段；咔哒声（< 0.25 秒）丢掉', () => {
  near(secs(T.speechSegments(signal(12, [[2, 4], [5, 7], [10, 10.1, -10]]))), [[1.75, 7.25]]);
});

test('分段：静音、只有均匀的小杂音 → 不识别；数字静音里的小声说话也找得到', () => {
  assert.deepEqual(T.speechSegments(new Float32Array(SR * 5)), []);
  assert.deepEqual(T.speechSegments(signal(20, [], { noiseDb: -56 })), []);
  assert.deepEqual(T.speechSegments(new Float32Array(100)), []);
  near(secs(T.speechSegments(signal(10, [[3, 5, -50]], { noiseDb: null }))), [[2.75, 5.25]]);
});

test('分段：一直在说（60 秒）→ 切成 ≤ 28 秒的几段，首尾相接、一点不漏', () => {
  const x = signal(60, [[0, 60, -18]]);
  const segs = T.speechSegments(x);
  assert.ok(segs.length >= 3, JSON.stringify(secs(segs)));
  assert.equal(segs[0][0], 0);
  assert.equal(segs[segs.length - 1][1], x.length);
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i][1] - segs[i][0] <= 28 * SR);
    if (i) assert.equal(segs[i][0], segs[i - 1][1]);
  }
});

test('分段：很长的一句在 20–28 秒之间最安静的地方切开', () => {
  // 0–40 秒一直说，24 秒处小声一点
  const x = signal(40, [[0, 23.9, -18], [23.9, 24.2, -40], [24.2, 40, -18]]);
  const segs = secs(T.speechSegments(x));
  assert.ok(segs[0][1] > 23.8 && segs[0][1] < 24.3, JSON.stringify(segs));
});

test('简繁转换是一个字换一个字（去掉套话时靠这个对齐位置）', () => {
  for (const [k, v] of T2S) { assert.equal(k.length, 1, k); assert.equal(v.length, 1, k); }
  const s = '媽媽，我不要去上學 😴 𠀀';
  assert.equal(toSimplified(s).length, s.length);
});

test('整理识别结果：繁→简、全角标点、词组间空格换逗号；数字里的标点不动', () => {
  const raw = '今天晚上吃饺子吧,我想要豬肉白菜餡的,明天早上7點起床,別忘了帶魚散。';
  assert.equal(T.cleanText(raw), '今天晚上吃饺子吧，我想要猪肉白菜馅的，明天早上7点起床，别忘了带鱼散。');
  assert.equal(T.cleanText(raw, { simplify: false }), '今天晚上吃饺子吧，我想要豬肉白菜餡的，明天早上7點起床，別忘了帶魚散。');
  assert.equal(T.cleanText('明天早上7点起床 别忘了带鱼饭'), '明天早上7点起床，别忘了带鱼饭');
  assert.equal(T.cleanText('嗯 那個蛋糕是我的 不許吃'), '嗯，那个蛋糕是我的，不许吃');
  assert.equal(T.cleanText('你去哪儿?快回来!'), '你去哪儿？快回来！');
  assert.equal(T.cleanText('一共7,000块 7:30 见'), '一共7,000块 7:30 见');
  assert.equal(T.cleanText(',嗯,'), '嗯');
  assert.equal(T.cleanText('   '), '');
  assert.equal(T.cleanText(null), '');
});

test('整理识别结果：去掉静音 / 杂音上编出来的字幕套话', () => {
  for (const s of ['字幕製作人', '謝謝觀看', '谢谢大家收看!', '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目', '字幕由Amara.org社区提供', '(音乐)', '♪♪']) assert.equal(T.cleanText(s), '', s);
  assert.equal(T.cleanText('今天好累 謝謝觀看'), '今天好累');
  assert.equal(T.cleanText('[音乐] 你别走'), '你别走');
  assert.equal(T.cleanText('谢谢你'), '谢谢你');                    // 正常的话不动
  assert.equal(T.cleanText('我订阅了杂志'), '我订阅了杂志');
});

test('整理识别结果：卡住的重复只留一遍；正常的重复不动', () => {
  assert.equal(T.cleanText('我看你这一天'.repeat(10) + '我看你这'), '我看你这一天');
  assert.equal(T.cleanText('我看你，'.repeat(5)), '我看你');
  assert.equal(T.cleanText('嗯嗯嗯'), '嗯嗯嗯');
  assert.equal(T.cleanText('不要不要不要'), '不要不要不要');
  assert.equal(T.cleanText('哈'.repeat(12)), '哈哈哈');
  assert.equal(T.collapseRepeats('不要'.repeat(5) + '不去'), '不要不去');       // 中间的半截不当重复
});

test('草稿来源', () => {
  assert.equal(T.sourceOf('base', 'Mac'), 'whisper-base@Mac');
  assert.deepEqual(T.parseSource('whisper-base@Mac'), { model: 'base', device: 'Mac' });
  assert.deepEqual(T.parseSource('whisper-small@device'), { model: 'small', device: '' });
  assert.deepEqual(T.parseSource('whisper-small'), { model: 'small', device: '' });
  assert.equal(T.parseSource('paste'), null);
  assert.equal(T.parseSource(null), null);
});

test('合进草稿：按录音顺序拼、同一段重新识别就换掉；改过的、粘贴的草稿只往后接', () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64), order = [A, B];
  const src = 'whisper-base@Mac';
  const d1 = T.mergeDraft(null, { sha256: B, text: '第二段', source: src, at: 1 }, order);
  assert.deepEqual(d1, { text: '第二段', source: src, at: 1, parts: [{ sha256: B, text: '第二段' }] });
  const d2 = T.mergeDraft(d1, { sha256: A, text: '第一段', source: src, at: 2 }, order);
  assert.equal(d2.text, '第一段\n\n第二段');
  assert.equal(d2.at, 2);
  const d3 = T.mergeDraft(d2, { sha256: A, text: '第一段（重来）', source: src, at: 3 }, order);
  assert.equal(d3.text, '第一段（重来）\n\n第二段');
  assert.equal(d3.parts.length, 2);
  // 用户改过
  const edited = { ...d3, text: d3.text + '\n我自己加的', edited: 5 };
  const d4 = T.mergeDraft(edited, { sha256: B, text: '第二段（重来）', source: src, at: 6 }, order);
  assert.equal(d4.text, '第一段（重来）\n\n第二段\n我自己加的\n\n第二段（重来）');
  assert.equal(d4.parts, undefined);
  // 手动粘贴的
  const d5 = T.mergeDraft({ text: '语音备忘录的转写\n', source: 'paste' }, { sha256: A, text: '识别的', source: src, at: 7 }, order);
  assert.equal(d5.text, '语音备忘录的转写\n\n识别的');
  assert.equal(d5.source, src);
  // 空草稿当没有
  assert.equal(T.mergeDraft({ text: '  ', source: 'paste' }, { sha256: A, text: 'x', source: src, at: 8 }, order).text, 'x');
});

test('填进原话：每行写成 NN 说的话；写了说话人的行、空行原样；接在原话后面', () => {
  assert.equal(T.draftToDialogue('今天吃什么\n\n\n明天再说', SP), `${NN}“今天吃什么”\n\n${NN}“明天再说”`);
  assert.equal(T.draftToDialogue(`${ME}“吃什么都行？”\n「為什麼」`, SP), `${ME}“吃什么都行？”\n${NN}「為什麼」`);
  assert.equal(T.draftToDialogue('嗯', { nn: { emoji: '🐷', aliases: [] }, me: { emoji: ME, aliases: [] } }), '🐷“嗯”');
  assert.equal(T.draftToDialogue('  \n ', SP), '');
  assert.equal(T.appendText('', 'x'), 'x');
  assert.equal(T.appendText(`${NN}“原话”\n\n`, 'x'), `${NN}“原话”\nx`);
});

test('出错信息分类', () => {
  assert.equal(T.errorCode('RangeError: Out of memory'), 'oom');
  assert.equal(T.errorCode('Aborted(OOM)'), 'oom');
  assert.equal(T.errorCode('WebAssembly.Memory(): could not allocate memory'), 'oom');
  assert.equal(T.errorCode('TypeError: Failed to fetch'), 'net');
  assert.equal(T.errorCode('Load failed'), 'net');
  assert.equal(T.errorCode('Importing a module script failed.'), 'net');      // 第一次用时没网：worker 连 transformers.js 都取不到
  assert.equal(T.errorCode('webgpuInit is not a function', 'wasm'), 'gpu');
  assert.equal(T.errorCode('something odd', 'webgpu'), 'gpu');
  assert.equal(T.errorCode('something odd', 'wasm'), 'failed');
});

// ---------- 假 worker 上的任务流程 ----------
function fakeWorkers(script) {
  const made = [];
  class FW {
    constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.terminated = false; made.push(this); }
    postMessage(m, transfer) { this.sent.push({ m, transfer }); setTimeout(() => { if (!this.terminated) script(this, m); }, 0); }
    emit(m) { if (!this.terminated && this.onmessage) this.onmessage({ data: m }); }
    terminate() { this.terminated = true; }
  }
  return { FW, made };
}
const SAYS = ['今天晚上吃饺子吧,我想要豬肉白菜餡的', '字幕製作人', '媽媽 我不要去上學'];
const okScript = (w, m) => {
  if (m.type === 'load') { w.emit({ type: 'progress', pct: 40, loaded: 40, total: 100 }); w.emit({ type: 'progress', pct: 100, loaded: 100, total: 100 }); w.emit({ type: 'ready' }); }
  if (m.type === 'run') {
    m.segments.forEach((s, i) => { w.emit({ type: 'seg', id: m.id, i }); w.emit({ type: 'partial', id: m.id, i, t: SAYS[i].slice(0, 3) }); w.emit({ type: 'segDone', id: m.id, i, text: SAYS[i] }); });
    w.emit({ type: 'result', id: m.id, texts: m.segments.map((s, i) => SAYS[i]) });
  }
};
const threeSays = () => signal(24, [[1, 3], [8, 10], [16, 18]]);
const deps = (extra = {}) => ({ decode: async () => threeSays(), probeGpu: async () => ({ gpu: false, f16: false }), cacheInfo: async () => ({ bytes: 0, files: [], complete: { wasm: false, webgpu: false } }), mobile: false, workerUrl: () => 'x.js', ...extra });
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await tick(); } }

test('识别：下载模型 → 分段识别 → 整理好的几行；worker 用完就结束', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const phases = [];
  const off = T.onJob(v => { if (v && phases[phases.length - 1] !== v.phase) phases.push(v.phase); });
  const engines = [];
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base', key: 'e|a', onEngine: e => engines.push(e) }, deps({ Worker: FW }));
  off();
  assert.equal(r.text, '今天晚上吃饺子吧，我想要猪肉白菜馅的\n妈妈，我不要去上学');
  assert.deepEqual(r.lines.length, 2);
  assert.equal(r.engine, 'wasm');
  assert.equal(r.segs, 3);
  assert.deepEqual(engines, ['wasm']);
  assert.deepEqual(phases, ['prepare', 'download', 'run', 'done']);
  assert.equal(T.job().total, T.MODELS.base.wasm.bytes, '下载进度的总数用表里的大小');
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.type, 'module');
  assert.ok(made[0].terminated);
  const load = made[0].sent[0].m;
  assert.deepEqual(load, { type: 'load', model: 'onnx-community/whisper-base', revision: T.MODELS.base.revision, device: 'wasm', dtype: 'q8' });
  const run = made[0].sent[1];
  assert.equal(run.m.segments.length, 3);
  assert.equal(run.transfer.length, 3, '处理器：片段直接转交，不复制');
  const j = T.job();
  assert.equal(j.key, 'e|a');
  assert.equal(j.phase, 'done');
});

test('识别：模型已经在缓存里 → 显示「载入」而不是下载进度', async () => {
  const { FW } = fakeWorkers(okScript);
  const phases = new Set();
  const off = T.onJob(v => v && phases.add(v.phase));
  await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, cacheInfo: async () => ({ bytes: 1, files: [], complete: { wasm: true, webgpu: false } }) }));
  off();
  assert.ok(phases.has('load'));
  assert.ok(!phases.has('download'));
});

test('识别：没听出说话 → 不开 worker、不下载模型，结果是空的', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => signal(10, [], { noiseDb: -56 }) }));
  assert.equal(r.text, '');
  assert.equal(made.length, 0);
});

test('识别：显卡出错 → 换一个新 worker 用处理器重来（片段发的是副本）', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load' && m.device === 'webgpu') { w.emit({ type: 'error', message: 'webgpu device lost' }); return; }
    okScript(w, m);
  });
  const fails = [], engines = [];
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base', onGpuFail: e => fails.push(e.code), onEngine: e => engines.push(e) },
    deps({ Worker: FW, probeGpu: async () => ({ gpu: true, f16: true }) }));
  assert.equal(r.engine, 'wasm');
  assert.equal(r.lines.length, 2);
  assert.deepEqual(fails, ['gpu']);
  assert.deepEqual(engines, ['webgpu', 'wasm']);
  assert.equal(made.length, 2);
  assert.ok(made.every(w => w.terminated));
  assert.equal(made[0].sent[0].m.device, 'webgpu');
  assert.deepEqual(made[0].sent[0].m.dtype, { encoder_model: 'fp32', decoder_model_merged: 'q4' });
  assert.equal(made[1].sent[0].m.device, 'wasm');
});

test('识别：显卡跑到一半出错也换处理器；下载不了（网络）不换，直接报错', async () => {
  const { FW } = fakeWorkers((w, m) => {
    if (m.type === 'run' && w.sent[0].m.device === 'webgpu') { w.emit({ type: 'error', message: 'GPU validation error' }); return; }
    okScript(w, m);
  });
  const r = await T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, probeGpu: async () => ({ gpu: true }) }));
  assert.equal(r.engine, 'wasm');
  const net = fakeWorkers((w, m) => { if (m.type === 'load') w.emit({ type: 'error', message: 'TypeError: Failed to fetch' }); });
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: net.FW, probeGpu: async () => ({ gpu: true }) })), e => e.code === 'net');
  assert.equal(net.made.length, 1);
  assert.equal(T.job().phase, 'error');
  assert.equal(T.job().error.code, 'net');
});

test('识别：取消 → 结束 worker，任务记成「取消」；跑着的时候不能再开一个', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load') w.emit({ type: 'ready' });
    if (m.type === 'run') w.emit({ type: 'seg', id: m.id, i: 0 });        // 卡在第一段
  });
  const p = T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW }));
  await waitFor(() => T.job() && T.job().phase === 'run');
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW })), e => e.code === 'busy');
  assert.equal(T.cancel(), true);
  await assert.rejects(p, e => e.code === 'cancel');
  assert.ok(made[0].terminated);
  assert.equal(T.job().phase, 'cancel');
  assert.equal(T.cancel(), false);
});

test('识别：读录音时取消也能停；内存不够 → oom；手机上选了更准 → tooBig；读不出录音 → decode', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { FW, made } = fakeWorkers(okScript);
  const p = T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: FW, decode: async () => { await slow; return threeSays(); } }));
  await tick();
  T.cancel();
  release();
  await assert.rejects(p, e => e.code === 'cancel');
  assert.equal(made.length, 0);

  const oom = fakeWorkers((w, m) => { if (m.type === 'load') w.emit({ type: 'error', message: 'RangeError: Out of memory' }); });
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: oom.FW })), e => e.code === 'oom');
  assert.equal(T.job().error.code, 'oom');
  T.clearJob();
  assert.equal(T.job(), null);

  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'small' }, deps({ Worker: oom.FW, mobile: true })), e => e.code === 'tooBig');
  await assert.rejects(T.transcribe({ blob: null, model: 'base' }, deps({ Worker: oom.FW })), e => e.code === 'noAudio');
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: oom.FW, decode: async () => { throw new T.SttError('decode', 'bad'); } })), e => e.code === 'decode');
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: undefined })), e => e.code === 'unsupported');
  // worker 自己崩了（没发消息）
  const crash = fakeWorkers((w, m) => { if (m.type === 'load' && w.onerror) w.onerror({ message: 'Aborted()', preventDefault() {} }); });
  await assert.rejects(T.transcribe({ blob: new Blob(['x']), model: 'base' }, deps({ Worker: crash.FW })), e => e.code === 'failed' && /Aborted/.test(e.message));
});

test('只下载模型：载入一次就结束 worker，不识别', async () => {
  const { FW, made } = fakeWorkers(okScript);
  const r = await T.downloadModel({ model: 'small' }, deps({ Worker: FW, probeGpu: async () => ({ gpu: true, f16: true }) }));
  assert.equal(r.engine, 'webgpu');
  assert.equal(made.length, 1);
  assert.equal(made[0].sent.length, 1);
  assert.equal(made[0].sent[0].m.model, 'onnx-community/whisper-small');
  assert.ok(made[0].terminated);
  assert.equal(T.job().kind, 'download');
  assert.equal(T.job().key, 'download:small');
});

// ---------- 模型缓存 ----------
function fakeCaches(sizes) {
  const store = new Map(Object.entries(sizes));
  return {
    store,
    async has(name) { return name === T.MODEL_CACHE; },
    async open(name) {
      assert.equal(name, T.MODEL_CACHE);
      return {
        async keys() { return [...store.keys()].map(url => ({ url })); },
        async match(r) { const n = store.get(r.url); return n == null ? undefined : { headers: { get: k => (k === 'content-length' ? String(n) : null) } }; },
        async delete(r) { return store.delete(r.url); },
      };
    },
  };
}

test('模型缓存：算这个模型（所有版本）占多少、固定版本齐不齐；删除只删这个模型', async () => {
  const pre = T.modelPrefix('base');
  const sizes = Object.fromEntries(T.modelFiles('base', 'wasm').map((f, i) => [pre + f, 1000 + i]));
  sizes[T.repoPrefix('base') + 'main/onnx/encoder_model.onnx'] = 5000;                       // 旧版本
  sizes['https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'] = 77;   // 别的模型
  sizes['https://huggingface.co/someone/other-app-model/resolve/main/model.onnx'] = 88;        // 同域名下别的 App
  const cs = fakeCaches(sizes);
  const info = await T.modelCacheInfo('base', { caches: cs });
  const want = T.modelFiles('base', 'wasm').reduce((n, f, i) => n + 1000 + i, 0) + 5000;
  assert.equal(info.bytes, want);
  assert.deepEqual(info.complete, { wasm: true, webgpu: false });
  assert.deepEqual((await T.modelCacheInfo('small', { caches: cs })).complete, { wasm: false, webgpu: false });
  assert.equal(await T.deleteModel('base', { caches: cs }), T.modelFiles('base', 'wasm').length + 1);
  assert.deepEqual([...cs.store.keys()].sort(), Object.keys(sizes).filter(u => !u.includes('whisper-base')).sort());
  assert.equal(await T.modelCacheInfo('base', { caches: null }), null);
  assert.equal(await T.deleteModel('base', { caches: null }), 0);
  const empty = { async has() { return false; }, async open() { throw new Error('不该打开（会建出一个空缓存）'); } };
  assert.deepEqual(await T.modelCacheInfo('base', { caches: empty }), { bytes: 0, files: [], complete: { wasm: false, webgpu: false } });
});

// ---------- worker 和第三方文件 ----------
test('worker 只 import 仓库里的 transformers.js，wasm 指向仓库里的文件（不走 CDN）', () => {
  const src = fs.readFileSync(path.join(root, 'src/workers/transcribe.worker.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['../../vendor/transformers/transformers.min.js']);
  assert.match(src, /env\.backends\.onnx\.wasm/);
  assert.match(src, /ort-wasm-simd-threaded\$\{v\}\.mjs/);
  assert.doesNotMatch(src, /jsdelivr|unpkg|https?:\/\//);
  assert.match(src, /language: 'zh'/);
  const core = fs.readFileSync(path.join(root, 'src/core/transcribe.js'), 'utf8');
  assert.match(core, /new URL\('\.\.\/workers\/transcribe\.worker\.js', import\.meta\.url\)/);
  for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'LICENSE', 'LICENSE-onnxruntime-web', 'README.md']) {
    assert.ok(fs.existsSync(path.join(root, 'vendor/transformers', f)), f);
  }
  assert.match(fs.readFileSync(path.join(root, 'vendor/transformers/LICENSE'), 'utf8'), /Apache License/);
  assert.match(fs.readFileSync(path.join(root, 'vendor/transformers/LICENSE-onnxruntime-web'), 'utf8'), /MIT License/);
  for (const f of fs.readdirSync(path.join(root, 'vendor/transformers'))) assert.ok(!f.endsWith('.map'), '不带 source map');
});

test('CSP：允许 wasm，只多放 Hugging Face 的下载地址；worker 只能是本站的', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = Object.fromEntries(csp.split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dir['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(dir['connect-src'], ["'self'", 'https://api.github.com', 'https://huggingface.co', 'https://*.hf.co']);
  assert.deepEqual(dir['worker-src'], ["'self'"]);
  assert.deepEqual(dir['default-src'], ["'self'"]);
});
