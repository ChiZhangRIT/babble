// 床头模式的采集：麦克风（一般 48 kHz）→ 低通 → 16 kHz，凑够一块（4096 个样本 = 256 ms）就交出去。
// 不依赖别的模块：AudioWorklet 里每多一个模块就多一次请求（离线时还得 SW 接得住）。
// Decimator 也给主线程的 ScriptProcessor 兜底用（bedside.js 引用它）；只有在 AudioWorklet 里才注册处理器，Node 里加载不出事。
//
// 低通：33 抽头 Hann 窗 sinc，截止 0.45 × 输出采样率（7.2 kHz）；48 kHz 时 12 kHz 衰减 60 dB 以上（不会有「嘶」声混叠下来）。
// 步长可以是小数（44.1 kHz → 2.75625）：在相邻两个滤波值之间线性插值；位置用整数余数推进，整夜不漂。

function lowpass(taps, fc) {             // fc：截止频率 / 输入采样率
  const h = new Float32Array(taps), m = (taps - 1) / 2;
  let s = 0;
  for (let k = 0; k < taps; k++) {
    const t = k - m, w = Math.sin(Math.PI * (k + 1) / (taps + 1)) ** 2;     // Hann（两端不为 0）
    s += h[k] = w * (t ? Math.sin(2 * Math.PI * fc * t) / (Math.PI * t) : 2 * fc);
  }
  for (let k = 0; k < taps; k++) h[k] /= s;  // 直流增益 1
  return h;
}

export class Decimator {
  constructor(inRate, { outRate = 16000, block = 4096, taps = 33, onBlock } = {}) {
    this.inRate = inRate; this.outRate = outRate; this.block = block; this.onBlock = onBlock;
    this.h = lowpass(taps, 0.45 * outRate / inRate);
    this.L = taps + 1;                       // 一个输出要用到 n0 和 n0+1 两个滤波值：最近 taps+1 个输入
    this.x = new Float32Array(2 * this.L);   // 每个样本存两遍：窗口 x[w .. w+L) 总是连续的（最旧在前），不用取模
    this.w = 0;
    this.need = 2;                           // 还要来几个输入才能出下一个（第 0 个输出在 n0 = 0，要等到 x[1]）
    this.rem = 0;                            // 下一个输出位置的小数部分 × outRate
    this.buf = new Float32Array(block); this.n = 0;
  }
  push(f32) {
    const { h, L, x, inRate, outRate } = this, T = h.length;
    for (let i = 0; i < f32.length; i++) {
      x[this.w] = x[this.w + L] = f32[i];
      if (++this.w === L) this.w = 0;
      this.need--;
      while (this.need <= 0) {
        // 窗口最新的是 x[w+T]（= n0+1），x[w+T-1] 是 n0；h[0] 乘最新的样本
        const w = this.w, fr = this.rem / outRate;
        let a = 0;
        for (let k = 0; k < T; k++) a += h[k] * x[w + T - 1 - k];
        if (fr) { let b = 0; for (let k = 0; k < T; k++) b += h[k] * x[w + T - k]; a += fr * (b - a); }
        this.buf[this.n++] = a;
        if (this.n === this.block) { const pcm = this.buf; this.buf = new Float32Array(this.block); this.n = 0; if (this.onBlock) this.onBlock(pcm); }
        this.rem += inRate;
        const adv = Math.floor(this.rem / outRate);
        this.rem -= adv * outRate; this.need += adv;
      }
    }
  }
}

// AudioWorklet 里：global sampleRate；没有输入声道（还没接上、被打断）就什么都不发，主线程据此发现断了。
// process 一直返回 true（返回 false 时 WebKit 会过早拆掉处理器，bug 184107806）
if (typeof registerProcessor === 'function') registerProcessor('babble-capture', class extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const { outRate = 16000, block = 4096 } = (o && o.processorOptions) || {};
    this.dec = new Decimator(sampleRate, { outRate, block, onBlock: (pcm) => this.port.postMessage({ type: 'block', pcm }, [pcm.buffer]) });
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.dec.push(ch);
    return true;
  }
});
