// 说话识别（core/vad.js + workers/vad.worker.js）：createStepper 的上下文 / 状态 / 排队，createVad 在假 worker 上的协议
// （载入、按 seq 配对、转交、出错只报一次、restart、close、stats），vendor 里模型文件的 sha256，
// 以及用 vendor 里真的 transformers.js + onnxruntime wasm 在 Node 里把 worker 走一遍。
// 全是合成信号（噪声、共振峰合成的「元音」），不放真的录音和梦话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStepper, createVad, CTX, STEP } from '../src/core/vad.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 16000;
const tick = () => new Promise(r => setTimeout(r, 0));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await sleep(1); } }
const ramp = (n, k = 1) => Float32Array.from({ length: n }, (_, i) => (i + 1) * k / n);
const cat = (...xs) => { const o = new Float32Array(xs.reduce((a, x) => a + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };

// ---------- createStepper ----------
/** 假模型：记下每步收到的 input / state；概率 = 第几步 / 100，状态填成第几步 */
function recorder({ delay = 0, bad = null } = {}) {
  const calls = [];
  const run = async ({ input, state }) => {
    calls.push({ input: input.slice(), state: state.slice() });
    const k = calls.length;
    if (delay) await sleep(typeof delay === 'function' ? delay(k) : delay);
    return { prob: k === bad ? NaN : k / 100, state: new Float32Array(256).fill(k) };
  };
  return { calls, run };
}

test('createStepper：每步 576 = 上一步最后 64 个 + 这一步 512 个；状态一步步传下去；一块 8 步 → 8 个概率', async () => {
  assert.equal(CTX, 64);
  assert.equal(STEP, 512);
  const m = recorder(), st = createStepper({ run: m.run });
  const a = ramp(4096), b = ramp(4096, -1);
  const out = await st.batch(a);
  assert.ok(out instanceof Float32Array);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5, 6, 7, 8].map(k => Math.fround(k / 100)));
  assert.equal(m.calls.length, 8);
  assert.deepEqual(Array.from(m.calls[0].input), [...new Float32Array(64), ...a.subarray(0, 512)], '第一步前面是 64 个 0');
  for (let k = 1; k < 8; k++) assert.deepEqual(m.calls[k].input, a.slice(k * 512 - 64, (k + 1) * 512), `第 ${k} 步`);
  assert.ok(m.calls[0].state.every(v => v === 0) && m.calls[0].state.length === 256);
  for (let k = 1; k < 8; k++) assert.ok(m.calls[k].state.every(v => v === k), '用的是上一步给的状态');
  await st.batch(b);                                            // 下一块接着上一块
  assert.deepEqual(m.calls[8].input, cat(a.subarray(4032), b.subarray(0, 512)));
  assert.ok(m.calls[8].state.every(v => v === 8));
});

test('createStepper：一次只跑一块、按调用顺序；reset 排在队里（正在跑的那块不受影响）', async () => {
  const m = recorder({ delay: (k) => (k % 3) * 2 }), st = createStepper({ run: m.run });
  const a = ramp(1024), b = ramp(1024, 2), c = ramp(1024, 3);
  const pa = st.batch(a), pb = st.batch(b);
  st.reset();
  const pc = st.batch(c);
  const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
  assert.deepEqual([ra.length, rb.length, rc.length], [2, 2, 2]);
  assert.equal(m.calls.length, 6);
  assert.deepEqual(m.calls[2].input, cat(a.subarray(960), b.subarray(0, 512)), 'b 接在 a 后面');
  assert.ok(m.calls[3].state.every(v => v === 3));
  assert.deepEqual(Array.from(m.calls[4].input), [...new Float32Array(64), ...c.subarray(0, 512)], 'reset 之后从 0 开始');
  assert.ok(m.calls[4].state.every(v => v === 0));
});

test('createStepper：算出 NaN → 报错并清零；样本里的 NaN / ∞ 换成 0；长度不是 512 的倍数直接拒绝', async () => {
  const m = recorder({ bad: 3 }), st = createStepper({ run: m.run });
  await assert.rejects(st.batch(ramp(4096)), /bad output NaN/);
  assert.equal(m.calls.length, 3, '出错那步之后不再跑');
  await st.batch(ramp(512));
  assert.ok(m.calls[3].input.subarray(0, 64).every(v => v === 0) && m.calls[3].state.every(v => v === 0), '出错之后从 0 开始');
  const bad = ramp(1024);
  bad[10] = NaN; bad[600] = Infinity; bad[700] = -Infinity;
  await st.batch(bad);
  assert.equal(m.calls[4].input[64 + 10], 0);
  assert.equal(m.calls[5].input[64 + 600 - 512], 0);
  assert.equal(m.calls[5].input[64 + 700 - 512], 0);
  assert.ok(Number.isNaN(bad[10]), '原数组不改');
  await assert.rejects(st.batch(new Float32Array(100)), RangeError);
  await assert.rejects(st.batch(new Float32Array(0)), RangeError);
  await assert.rejects(createStepper({ run: async () => ({ prob: 0.5, state: new Float32Array(10) }) }).batch(ramp(512)), /bad output/, '状态长度不对也算坏了');
  await assert.rejects(createStepper({ run: async () => null }).batch(ramp(512)), /bad output/);
});

// ---------- createVad（假 worker） ----------
function fakeWorkers(script = okScript) {
  const made = [];
  class FW {
    constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.terminated = false; made.push(this); }
    postMessage(m, transfer) {
      const got = transfer && transfer.length ? structuredClone(m, { transfer }) : m;     // 和真的一样：转交之后原来的 buffer 就空了
      this.sent.push({ m: got, transfer });
      setTimeout(() => { if (!this.terminated) script(this, got); }, 0);
    }
    emit(m) { if (!this.terminated && this.onmessage) this.onmessage({ data: m }); }
    crash(message) { if (this.onerror) this.onerror({ message, preventDefault() {} }); }
    terminate() { this.terminated = true; }
    blocks() { return this.sent.filter(s => s.m.type === 'block'); }
  }
  return { FW, made };
}
/** 概率 = 这块第一个样本（认得出是哪块），每块算了 1.5 毫秒 */
const probsOf = (pcm) => new Float32Array(8).fill(pcm[0]);
function okScript(w, m) {
  if (m.type === 'load') w.emit({ type: 'ready', ms: 12 });
  if (m.type === 'block') w.emit({ type: 'probs', seq: m.seq, probs: probsOf(m.pcm), ms: 1.5 });
}
const block = (v) => new Float32Array(4096).fill(v);

test('createVad：载入 → ready；不是 ready 时 push 马上给 null、不发消息；块按 seq 配对（乱序回来也对），pcm 转交', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load') setTimeout(() => w.emit({ type: 'ready', ms: 12 }), 5);
    if (m.type === 'block') setTimeout(() => w.emit({ type: 'probs', seq: m.seq, probs: probsOf(m.pcm), ms: m.seq }), (4 - m.seq) * 4);
  });
  const v = createVad({ Worker: FW, url: 'x/vad.worker.js' });
  assert.equal(v.state, 'idle');
  assert.equal(await v.push(block(0.1)), null, '还没载入');
  assert.equal(made.length, 0, '没载入就不开 worker');
  const p1 = v.load(), p2 = v.load();
  assert.equal(v.state, 'loading');
  assert.equal(made.length, 1, '同时载入两次只开一个');
  assert.equal(await v.push(block(0.1)), null, '正在载入');
  assert.deepEqual(await Promise.all([p1, p2]), [true, true]);
  assert.equal(v.state, 'ready');
  assert.equal(made[0].url, 'x/vad.worker.js');
  assert.deepEqual(made[0].opts, { type: 'module' });
  assert.deepEqual(made[0].sent.map(s => s.m.type), ['load'], '没 ready 之前的块没发出去');
  assert.equal(await v.load(), true);
  assert.equal(made.length, 1);
  const bs = [block(0.25), block(0.5), block(0.75)];
  const rs = await Promise.all(bs.map(b => v.push(b)));        // 回来的顺序是 3、2、1
  assert.deepEqual(rs.map(r => r[0]), [0.25, 0.5, 0.75]);
  assert.ok(rs.every(r => r instanceof Float32Array && r.length === 8));
  assert.deepEqual(made[0].blocks().map(s => s.m.seq), [1, 2, 3]);
  assert.ok(bs.every(b => b.buffer.byteLength === 0), 'pcm 是转交过去的');
  assert.ok(made[0].blocks().every(s => s.transfer.length === 1 && s.m.pcm.length === 4096));
  const big = new Float32Array(8192).fill(0.2, 4096);           // 别的 buffer 的一截：先复制，不把整个 buffer 交出去
  const r = await v.push(big.subarray(4096));
  assert.equal(r[0], Math.fround(0.2));
  assert.equal(big.buffer.byteLength, 8192 * 4);
  const s = v.stats();
  assert.equal(s.blocks, 4);
  assert.equal(s.msAvg, (1 + 2 + 3 + 4) / 4);
  assert.ok(Number.isFinite(s.loadMs) && s.loadMs >= 0);
  assert.equal(s.lastError, null);
});

test('createVad：一块也可以是 512 的别的整数倍（转文字一次交 1 秒 = 32 步），回来的概率个数跟着变', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load') w.emit({ type: 'ready', ms: 1 });
    if (m.type === 'block') w.emit({ type: 'probs', seq: m.seq, probs: new Float32Array(m.pcm.length / STEP).fill(m.pcm[0]), ms: 2 });
  });
  const v = createVad({ Worker: FW });
  await v.load();
  const r = await v.push(new Float32Array(16384).fill(0.5));
  assert.equal(r.length, 32);
  assert.equal(r[31], 0.5);
  assert.equal((await v.push(new Float32Array(1536).fill(0.25))).length, 3);
  assert.deepEqual(made[0].blocks().map(s => s.m.pcm.length), [16384, 1536]);
  assert.equal(v.stats().blocks, 2);
});

test('createVad：worker 回 null（还没好）或长度不对 → null，不算进 stats', async () => {
  let mode = 'null';
  const { FW } = fakeWorkers((w, m) => {
    if (m.type === 'load') w.emit({ type: 'ready', ms: 1 });
    if (m.type === 'block') w.emit({ type: 'probs', seq: m.seq, probs: mode === 'null' ? null : new Float32Array(3), ms: 9 });
  });
  const v = createVad({ Worker: FW });
  await v.load();
  assert.equal(await v.push(block(0.1)), null);
  mode = 'short';
  assert.equal(await v.push(block(0.1)), null);
  assert.equal(v.state, 'ready');
  assert.deepEqual(v.stats(), { blocks: 0, msAvg: null, loadMs: v.stats().loadMs, lastError: null });
});

test('createVad：一块算坏了 → 只有这一块报错，其余等着的给 null；worker 结束、state off，之后 push 给 null', async () => {
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load') w.emit({ type: 'ready', ms: 1 });
    if (m.type === 'block' && m.seq === 2) w.emit({ type: 'error', code: 'run', seq: 2, message: 'vad: bad output NaN' });
  });
  const v = createVad({ Worker: FW });
  await v.load();
  const ps = [v.push(block(0.1)), v.push(block(0.2)), v.push(block(0.3))].map(p => p.then(r => ({ r }), e => ({ e })));
  const [a, b, c] = await Promise.all(ps);
  assert.equal(a.r, null);
  assert.equal(c.r, null);
  assert.equal(b.e.code, 'run');
  assert.match(b.e.message, /bad output NaN/);
  assert.equal(v.state, 'off');
  assert.ok(made[0].terminated);
  assert.equal(await v.push(block(0.1)), null);
  assert.equal(made[0].blocks().length, 3, 'off 之后不再发');
  assert.equal(v.stats().lastError, 'vad: bad output NaN');
  assert.equal(await v.load(), false, 'off 了 load 不重试（要 restart）');
  assert.equal(made.length, 1);
});

test('createVad：worker 崩了（onerror）→ 最早那块报错（code crash），其余 null；空闲时崩了只变 off', async () => {
  const { FW, made } = fakeWorkers((w, m) => { if (m.type === 'load') w.emit({ type: 'ready', ms: 1 }); });
  const v = createVad({ Worker: FW });
  await v.load();
  const ps = [v.push(block(0.1)), v.push(block(0.2))].map(p => p.then(r => ({ r }), e => ({ e })));
  await tick();
  made[0].crash('RangeError: Out of memory');
  const [a, b] = await Promise.all(ps);
  assert.equal(a.e.code, 'crash');
  assert.match(a.e.message, /Out of memory/);
  assert.equal(b.r, null);
  assert.equal(v.state, 'off');
  assert.ok(made[0].terminated);
  const v2 = createVad({ Worker: FW });
  await v2.load();
  made[1].crash('Aborted()');
  assert.equal(v2.state, 'off');
  assert.equal(v2.stats().lastError, 'Aborted()');
});

test('createVad：载入失败 / 取不到 worker 脚本 / 没有 Worker / 构造出错 → load false、state off', async () => {
  const fail = fakeWorkers((w, m) => { if (m.type === 'load') w.emit({ type: 'error', code: 'load', message: 'file was not found locally' }); });
  const v = createVad({ Worker: fail.FW });
  assert.equal(await v.load(), false);
  assert.equal(v.state, 'off');
  assert.ok(fail.made[0].terminated, '载入失败就结束 worker（内存马上还回去）');
  assert.match(v.stats().lastError, /not found/);
  assert.equal(await v.push(block(0.1)), null);

  const imp = fakeWorkers((w, m) => { if (m.type === 'load') w.crash('Importing a module script failed'); });
  const v2 = createVad({ Worker: imp.FW });
  assert.equal(await v2.load(), false);
  assert.equal(v2.state, 'off');

  const v3 = createVad({ Worker: undefined });
  assert.equal(await v3.load(), false);
  assert.equal(v3.state, 'off');
  assert.equal(v3.stats().lastError, 'no Worker');
  assert.equal(await v3.restart(), false);

  const v4 = createVad({ Worker: class { constructor() { throw new Error('SecurityError'); } } });
  assert.equal(await v4.load(), false);
  assert.equal(v4.state, 'off');
});

test('createVad：reset 只在 ready 时发；restart 换新 worker（旧的结束，等着的给 null）；close 之后什么都不做', async () => {
  let hang = false, failLoad = false;
  const { FW, made } = fakeWorkers((w, m) => {
    if (m.type === 'load' && !hang) w.emit(failLoad ? { type: 'error', code: 'load', message: 'x' } : { type: 'ready', ms: 1 });
    if (m.type === 'block' && !hang) okScript(w, m);
  });
  const v = createVad({ Worker: FW });
  hang = true;
  const first = v.load();
  v.reset();
  assert.deepEqual(made[0].sent.map(s => s.m.type), ['load'], '载入中不发 reset');
  hang = false;
  const again = v.restart();                                   // 载入卡住了：换一个
  assert.equal(await first, false, '旧的那次载入算失败');
  assert.equal(await again, true);
  assert.ok(made[0].terminated);
  assert.equal(made.length, 2);
  v.reset();
  assert.deepEqual(made[1].sent.map(s => s.m.type), ['load', 'reset']);
  hang = true;                                                 // 算到一半卡住了
  const stuck = v.push(block(0.4));
  await tick();
  hang = false;
  assert.equal(await v.restart(), true);
  assert.equal(await stuck, null, '卡住的那块给 null（不报错，免得调用方再报一次故障）');
  assert.ok(made[1].terminated);
  assert.equal((await v.push(block(0.6)))[0], Math.fround(0.6));
  failLoad = true;
  assert.equal(await v.restart(), false, '新的载入不了');
  assert.equal(v.state, 'off');
  failLoad = false;
  assert.equal(await v.restart(), true, 'off 之后 restart 还能再试');
  const pending = (hang = true, v.push(block(0.1)));
  await tick();
  v.close();
  assert.equal(await pending, null);
  assert.equal(v.state, 'off');
  assert.ok(made.at(-1).terminated);
  const n = made.length;
  assert.equal(await v.load(), false);
  assert.equal(await v.restart(), false, 'close 之后不再开 worker');
  v.reset();
  assert.equal(made.length, n);
  assert.equal(v.stats().blocks, 1);
});

test('createVad：默认地址是 src/workers/vad.worker.js；worker 只 import vendor/ 和 core/vad.js，用到的文件都在', async () => {
  const { FW, made } = fakeWorkers(() => {});
  createVad({ Worker: FW }).load();
  const url = made[0].url;
  assert.ok(url.endsWith('/src/workers/vad.worker.js'), url);
  assert.ok(fs.existsSync(fileURLToPath(url)));
  const src = fs.readFileSync(fileURLToPath(url), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => path.relative(root, path.resolve(path.dirname(fileURLToPath(url)), m[1])));
  assert.deepEqual(imports, ['vendor/transformers/transformers.min.js', 'src/core/vad.js']);
  for (const f of imports) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.match(src, /model_file_name: 'silero_vad_16k_op15'/);
  assert.ok(fs.existsSync(path.join(root, 'vendor/silero-vad/silero_vad_16k_op15.onnx')));
  for (const ext of ['mjs', 'wasm']) assert.ok(fs.existsSync(path.join(root, `vendor/transformers/ort-wasm-simd-threaded.${ext}`)));
  assert.match(src, /allowRemoteModels = false/);
  assert.match(src, /wasmPaths = \{ mjs: `\$\{V\}ort-wasm-simd-threaded\.mjs`, wasm: `\$\{V\}ort-wasm-simd-threaded\.wasm` \}/, '用普通版 wasm（不是 asyncify）');
  assert.doesNotMatch(src, /progress_callback\s*:/, '不要下载进度');
});

test('vendor/silero-vad：模型文件和 README 里记的 sha256 一样（换文件要一起改 README）', () => {
  const dir = path.join(root, 'vendor/silero-vad');
  const sha = createHash('sha256').update(fs.readFileSync(path.join(dir, 'silero_vad_16k_op15.onnx'))).digest('hex');
  assert.equal(sha, '7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49');
  assert.ok(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes(`${sha}  silero_vad_16k_op15.onnx`));
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Silero Team/);
});

// ---------- 真模型 ----------
// 打包版 transformers.js 在 Node 里会去找 onnxruntime-node（打包版里是空的）：import 时让它以为不是 Node，就用打包进来的 onnxruntime-web；
// wasm 由 emscripten 在 Node 里直接读文件，模型经 env.fetch 从磁盘读（不联网）。worker 脚本直接在这个进程里 import，self 是个假的。
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
const norm = (x, db) => { let e = 0; for (const v of x) e += v * v; const k = 10 ** (db / 20) / Math.sqrt(e / x.length + 1e-20); return x.map(v => v * k); };
const noise = (sec, db, seed) => { const r = lcg(seed); return norm(Float32Array.from({ length: Math.round(sec * SR) }, () => r()), db); };
const mix = (a, b) => a.map((v, i) => v + (b[i] || 0));
/** 共振峰合成的「元音」：基频 150–245 Hz 起伏的脉冲列过三个共振器，一个音节 220 ms、停 60 ms，五个元音轮换 */
function vowels(sec, db, seed) {
  const F = [[800, 1200, 2500], [300, 2300, 3000], [350, 800, 2400], [500, 1800, 2600], [600, 1000, 2500]];
  const n = Math.round(sec * SR), x = new Float32Array(n), r = lcg(seed), res = [[0, 0], [0, 0], [0, 0]];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, syl = Math.floor(t / 0.28), st = t - syl * 0.28;
    if (st > 0.22) continue;
    ph += (190 + 40 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(6 * Math.PI * t)) / SR;
    let src = r() * 0.02;
    if (ph >= 1) { ph -= 1; src += 1; }
    let y = 0;
    F[syl % 5].forEach((f, k) => {
      const R = Math.exp(-Math.PI * (80 + 40 * k) / SR), c = 2 * R * Math.cos(2 * Math.PI * f / SR), s = res[k], o = src + c * s[0] - R * R * s[1];
      s[1] = s[0]; s[0] = o; y += o / (k + 1);
    });
    x[i] = y * Math.sin(Math.PI * st / 0.22);
  }
  return norm(x, db);
}

test('真模型：vendor 里的 transformers.js + onnxruntime wasm 在 Node 里跑 worker；静音 / 噪声低，合成元音高，reset 之后结果一样', async (t) => {
  const rel = Object.getOwnPropertyDescriptor(process, 'release');
  let tf;
  Object.defineProperty(process, 'release', { value: { name: 'browser' }, configurable: true });
  try { tf = await import(pathToFileURL(path.join(root, 'vendor/transformers/transformers.min.js')).href); }
  finally { Object.defineProperty(process, 'release', rel); }
  if (!(tf.env.backends && tf.env.backends.onnx && tf.env.backends.onnx.wasm)) { t.skip('这一版 transformers.js 在 Node 里不用 onnxruntime-web'); return; }
  tf.env.logLevel = 40;                 // 只留错误（不然会提示 Unknown model class "custom"）
  const fetched = [];
  tf.env.fetch = async (u) => {
    const s = String(u);
    fetched.push(s);
    if (!s.startsWith('file:')) throw new Error('测试里不联网：' + s);
    try { return new Response(fs.readFileSync(fileURLToPath(s))); } catch (e) { return new Response('', { status: 404 }); }
  };
  const got = [];
  globalThis.self = { postMessage: (m) => got.push(m), addEventListener() {} };
  try {
    await import(pathToFileURL(path.join(root, 'src/workers/vad.worker.js')).href);
    const send = (m) => self.onmessage({ data: m });
    const next = async (type) => { await waitFor(() => got.some(m => m.type === type)); return got.splice(got.findIndex(m => m.type === type), 1)[0]; };
    send({ type: 'block', seq: 1, pcm: new Float32Array(4096) });
    assert.deepEqual(got.shift(), { type: 'probs', seq: 1, probs: null, ms: 0 }, '没载入：马上回 null');
    send({ type: 'load' });
    const ready = await next('ready');
    assert.ok(ready.ms >= 0);
    assert.deepEqual(fetched.map(s => path.relative(root, fileURLToPath(s))), ['vendor/silero-vad/silero_vad_16k_op15.onnx']);
    let seq = 1;
    const run = async (x) => {
      const out = [];
      for (let i = 0; i + 4096 <= x.length; i += 4096) {
        send({ type: 'block', seq: ++seq, pcm: x.slice(i, i + 4096) });
        const m = await next('probs');
        assert.equal(m.seq, seq);
        assert.ok(m.probs instanceof Float32Array && m.probs.length === 8 && m.ms >= 0);
        out.push(...m.probs);
      }
      return Float32Array.from(out);
    };
    const quiet = await run(new Float32Array(4096 * 8));
    assert.ok(Math.max(...quiet) < 0.05, `静音 ${Math.max(...quiet)}`);
    send({ type: 'reset' });
    const hiss = await run(noise(4096 * 16 / SR, -50, 7));
    assert.ok(Math.max(...hiss) < 0.3, `白噪声 ${Math.max(...hiss)}`);
    // 1 秒噪声 → 3 秒元音（-45 dBFS，噪声 -62）→ 1 秒噪声
    const sig = mix(cat(new Float32Array(16384), vowels(3, -45, 8), new Float32Array(20480)), noise(6, -62, 9));
    send({ type: 'reset' });
    const p1 = await run(sig);
    const before = p1.subarray(0, 30), during = p1.subarray(34, 124);
    assert.ok(Math.max(...before) < 0.3, `元音之前 ${Math.max(...before)}`);
    assert.ok(during.filter(p => p >= 0.5).length >= during.length * 0.6, `元音里 ≥ 0.5 的帧 ${during.filter(p => p >= 0.5).length}/${during.length}`);
    send({ type: 'reset' });
    assert.deepEqual(await run(sig), p1, 'reset 之后同一段结果完全一样（状态和 64 个上下文都清零了）');
    assert.equal(got.filter(m => m.type === 'error').length, 0);
  } finally { delete globalThis.self; }
});
