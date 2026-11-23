// 说话识别（Silero VAD v6.2，16 kHz）：床头模式每 32 ms 算一次「像不像人在说话」（0..1），整夜开着。
// 模型在 vendor/silero-vad/（来源和 sha256 见那里的 README），在 src/workers/vad.worker.js 里用 transformers.js 自带的 onnxruntime（WASM）跑。
//
// 纯计算（worker 和 Node 测试都 import，不碰 DOM / Worker）：
//   createStepper({ run })   512 个样本一步：前面接上上一步最后 64 个（不接的话 v6.2 对说话也几乎全给 0），状态一步步往下传
// 页面（用到时才开 Worker）：
//   createVad(o)             worker 的代理：load / push（一块 4096 = 8 步）/ reset（每次中断之后）/ restart / close / stats
// 模型：输入 input [1, 576] float32、state [2, 1, 128] float32、sr int64 标量 16000；输出 output [1, 1]（概率）、stateN（下一步的状态）。
// 实测（Mac M4 Max，单线程 WASM，合成信号和 TTS）：一步约 0.16–0.18 毫秒（Node / WKWebView），一块 4096 约 1.5 毫秒；载入约 0.3 秒；
// iPhone 没量过（估计一步 0.2–1 毫秒）。说话 ≈ 1、噪声 / 静音 < 0.15，鼾声样的低频偶尔一两帧到 0.6。

export const CTX = 64, STEP = 512;
const STATE = 2 * 1 * 128;

/**
 * 把 16 kHz 的声音按 512 个样本一步交给模型。
 * @param {{ run: (x: { input: Float32Array, state: Float32Array }) => Promise<{ prob: number, state: Float32Array }> }} o
 *        run 跑一步：input = 上一步最后 64 个 + 这一步 512 个（共 576），state = 上一步给的状态（2×1×128）
 * @returns {{ batch(pcm: Float32Array): Promise<Float32Array>, reset(): void }}
 *        batch：长度是 512 的整数倍 → 每步一个概率。一次只跑一块，按调用顺序排队（reset 也排在队里）。
 *        样本里的 NaN / ∞ 先换成 0（模型不会因此给 NaN，而是对静音也给出 0.9 这种假的高概率）；
 *        算出 NaN（或状态不对）就清零并报错：调用方当作说话识别坏了。
 */
export function createStepper({ run }) {
  let state = new Float32Array(STATE), tail = new Float32Array(CTX), q = Promise.resolve();
  const zero = () => { state = new Float32Array(STATE); tail = new Float32Array(CTX); };
  async function steps(pcm) {
    const n = pcm.length / STEP, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const input = new Float32Array(CTX + STEP);
      input.set(tail);
      input.set(pcm.subarray(i * STEP, (i + 1) * STEP), CTX);
      for (let j = CTX; j < input.length; j++) if (!Number.isFinite(input[j])) input[j] = 0;
      const next = input.slice(STEP);     // 这一步最后 64 个，下一步接在前面
      const r = await run({ input, state });
      const p = r ? Number(r.prob) : NaN;
      if (!Number.isFinite(p) || !r.state || r.state.length !== STATE) { zero(); throw new Error('vad: bad output ' + p); }
      state = r.state;
      tail = next;
      out[i] = p;
    }
    return out;
  }
  return {
    batch(pcm) {
      if (!pcm || !pcm.length || pcm.length % STEP) return Promise.reject(new RangeError('vad: pcm length ' + (pcm && pcm.length)));
      const p = q.then(() => steps(pcm));
      q = p.catch(() => {});
      return p;
    },
    reset() { q = q.then(zero); },
  };
}

const clock = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
const msgOf = (e) => (e && (e.message || e.name)) || String(e);

/**
 * 页面这边的说话识别：开一个模块 worker，一块块把声音转交过去、拿回每 32 ms 的概率。
 * state：idle（还没载入）→ loading → ready；off = 用不了（没有 Worker、载入失败、worker 崩了 / 算出 NaN、已经 close）。
 *   不是 ready 时 push 马上给 null（调用方按音量判断）；restart() 结束旧 worker、开一个新的再载入一次。
 *   一次故障只让一块报错（worker 指明的那块，没指明就是最早等着的那块），其余等着的给 null：调用方只会收到一次。
 *   故障时没有等着的块（空闲时崩了）就没有报错：调用方要看 state。
 * @param {object} [o]
 * @param {Function} [o.Worker]     测试注入假的
 * @param {URL|string} [o.url]
 * @returns {{ readonly state: 'idle'|'loading'|'ready'|'off', load(): Promise<boolean>,
 *   push(pcm: Float32Array): Promise<Float32Array|null>, reset(): void, restart(): Promise<boolean>, close(): void,
 *   stats(): { blocks: number, msAvg: number|null, loadMs: number|null, lastError: string|null } }}
 *   push：pcm 4096 个样本（转交，之后别再用）→ 8 个概率（512 的别的整数倍也行：转文字一次交 1 秒 = 32 步）；load：false = 用不了；
 *   msAvg：worker 里每块实际算了多少毫秒（平均）
 */
export function createVad({ Worker: W = globalThis.Worker, url = new URL('../workers/vad.worker.js', import.meta.url) } = {}) {
  let state = 'idle', w = null, loading = null, loaded = null, closed = false, t0 = 0, seq = 0;
  let blocks = 0, msSum = 0, loadMs = null, lastError = null;
  const pend = new Map();                 // seq → { resolve, reject, n }
  const finishLoad = (ok) => { const f = loaded; loaded = loading = null; if (f) f(ok); };
  function kill() {                       // 结束 worker：等着的块给 null，正在载入的算失败
    const old = w;
    w = null;
    if (old) { old.onmessage = old.onerror = old.onmessageerror = null; try { old.terminate(); } catch (e) { /* 已经停了 */ } }
    for (const p of pend.values()) p.resolve(null);
    pend.clear();
    finishLoad(false);
  }
  function fail(message, code, at) {
    lastError = String(message || 'worker error');
    state = 'off';
    const k = pend.has(at) ? at : pend.keys().next().value, p = k != null ? pend.get(k) : null;
    if (p) pend.delete(k);
    kill();
    if (p) p.reject(Object.assign(new Error(lastError), { code }));
  }
  function onMessage(m) {
    if (m.type === 'ready') { state = 'ready'; loadMs = Math.round(clock() - t0); finishLoad(true); }
    else if (m.type === 'probs') {
      const p = pend.get(m.seq);
      if (!p) return;
      pend.delete(m.seq);
      const ok = m.probs && m.probs.length === p.n;
      if (ok) { blocks++; msSum += Number(m.ms) || 0; }
      p.resolve(ok ? m.probs : null);
    } else if (m.type === 'error') fail(m.message, m.code === 'load' ? 'load' : 'run', m.seq);
  }
  function load() {
    if (state === 'ready') return Promise.resolve(true);
    if (loading) return loading;
    if (closed || state === 'off') return Promise.resolve(false);
    if (typeof W !== 'function') { state = 'off'; lastError = 'no Worker'; return Promise.resolve(false); }
    let me;
    try { me = new W(url, { type: 'module' }); } catch (e) { state = 'off'; lastError = msgOf(e); return Promise.resolve(false); }
    w = me;
    t0 = clock();
    state = 'loading';
    const ready = loading = new Promise((resolve) => { loaded = resolve; });
    me.onmessage = ({ data }) => { if (w === me && data) onMessage(data); };
    // 没说过一句话就出错：多半是 worker 或 transformers.js 没取到（第一次用时没网）
    me.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const early = state === 'loading';
      if (w === me) fail((e && e.message) || (early ? 'Importing a module script failed' : 'worker error'), early ? 'load' : 'crash');
    };
    me.onmessageerror = () => { if (w === me) fail('messageerror', 'crash'); };
    try { me.postMessage({ type: 'load' }); } catch (e) { fail(msgOf(e), 'load'); }
    return ready;
  }
  function push(pcm) {
    if (state !== 'ready' || !w) return Promise.resolve(null);
    // 只转交整块 buffer：是别的 buffer 的一截就先复制一份
    const x = pcm.byteOffset || pcm.byteLength !== pcm.buffer.byteLength ? pcm.slice() : pcm, s = ++seq;
    return new Promise((resolve, reject) => {
      pend.set(s, { resolve, reject, n: Math.floor(x.length / STEP) });
      try { w.postMessage({ type: 'block', seq: s, pcm: x }, [x.buffer]); } catch (e) { pend.delete(s); reject(e); }
    });
  }
  return {
    get state() { return state; },
    load,
    push,
    reset() { if (w && state === 'ready') w.postMessage({ type: 'reset' }); },
    restart() {
      if (closed) return Promise.resolve(false);
      kill();
      state = 'idle';
      return load();
    },
    close() { closed = true; kill(); state = 'off'; },
    stats: () => ({ blocks, msAvg: blocks ? Math.round((msSum / blocks) * 1000) / 1000 : null, loadMs, lastError }),
  };
}
