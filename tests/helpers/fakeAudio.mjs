// 床头模式测试用的假浏览器（全是合成的，不碰真的麦克风、真的时间）：
//   FakeTrack / FakeStream、FakeAudioContext（audioWorklet.addModule、MediaStreamSource、ScriptProcessor、Gain、destination、statechange）、
//   FakeWorkletNode（port.emit(pcm) → onmessage）、fakeVad（echo / fail / hang / nan / crash，restart 的结果可以定）、
//   屏幕常亮（sentinel.release() 发 release）、Web Locks（ifAvailable、query().held）、document / window、音频会话、persist / estimate，
//   外加手动时钟：setTimeout / setInterval 记在表里，advance(ms) 按时间顺序触发，每触发一个都让 Promise 跑完。
export const settle = () => new Promise((r) => setImmediate(r));
export async function flush(n = 3) { for (let i = 0; i < n; i++) await settle(); }
const dbOf = (x, from, n) => { let s = 0; for (let i = from; i < from + n; i++) s += x[i] * x[i]; return 10 * Math.log10(s / n + 1e-12); };

export class FakeTrack extends EventTarget {
  constructor(settings = {}) {
    super();
    Object.assign(this, { kind: 'audio', muted: false, readyState: 'live', stopped: false });
    this.settings = { autoGainControl: false, echoCancellation: false, noiseSuppression: false, sampleRate: 48000, channelCount: 1, ...settings };
  }
  getSettings() { return { ...this.settings }; }
  stop() { this.stopped = true; this.readyState = 'ended'; }          // 和浏览器一样：自己 stop 不发 ended
  setMuted(b) { if (this.muted === !!b) return; this.muted = !!b; this.dispatchEvent(new Event(b ? 'mute' : 'unmute')); }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
export class FakeStream {
  constructor(tracks = [new FakeTrack()]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
class FakeNode {
  constructor(kind, ctx) { Object.assign(this, { kind, context: ctx, outs: [], disconnected: false }); }
  connect(n) { this.outs.push(n); return n; }
  disconnect() { this.outs = []; this.disconnected = true; }
}

/** 手动时钟 + 计时器表 */
export function fakeClock(t0 = Date.UTC(2026, 10, 17, 15, 30)) {
  let t = t0, seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq, d = Math.max(0, Number(ms) || 0); timers.set(id, { fn, at: t + d, every: every ? Math.max(1, d) : 0 }); return id; };
  return {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, true), clearInterval: (id) => { timers.delete(id); },
    get pending() { return timers.size; },
    /** 时间往前走 ms：到点的计时器按先后一个个触发（每个之后让 Promise 跑完） */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        t = Math.max(t, x.at);
        if (x.every) x.at += x.every; else timers.delete(id);
        x.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    /** 时间跳过去、计时器一个都不触发（页面被冻住、计时器被节流） */
    jump(ms) { t += ms; for (const x of timers.values()) if (x.at < t) x.at = t; },
  };
}

/**
 * 假说话识别（接口同 vad.js 的 createVad()）
 *   echo：每 512 个样本 RMS > −45 dBFS → 0.9，否则 0.05；fail：载入失败；hang：push 永远不回；nan：给 NaN；crash：push 报错、state 变 off
 *   restartOk：restart() 的结果；after：重启后换成哪种
 */
export function fakeVad({ mode = 'echo', restartOk = true, after = 'echo' } = {}) {
  const v = {
    mode, restartOk, after, state: 'idle', loads: 0, pushes: 0, resets: 0, restarts: 0, closed: false, waiting: [],
    load() {
      v.loads++;
      if (v.state === 'ready') return Promise.resolve(true);
      if (v.closed || v.state === 'off') return Promise.resolve(false);
      v.state = 'loading';
      return Promise.resolve().then(() => { if (!v.closed) v.state = v.mode === 'fail' ? 'off' : 'ready'; return v.state === 'ready'; });
    },
    push(pcm) {
      v.pushes++;
      if (v.state !== 'ready') return Promise.resolve(null);
      const x = structuredClone(pcm, { transfer: [pcm.buffer] });      // 和真的一样转交：之后原来那块就空了
      if (v.mode === 'hang') return new Promise((res) => v.waiting.push(res));
      if (v.mode === 'crash') { v.state = 'off'; return Promise.reject(Object.assign(new Error('worker crashed'), { code: 'crash' })); }
      if (v.mode === 'nan') return Promise.resolve(new Float32Array(x.length / 512).fill(NaN));
      return Promise.resolve(echoProbs(x));
    },
    reset() { v.resets++; },
    restart() {
      v.restarts++;
      v.waiting.splice(0).forEach((r) => r(null));
      if (v.closed) return Promise.resolve(false);
      v.state = v.restartOk ? 'ready' : 'off';
      if (v.restartOk) v.mode = v.after;
      return Promise.resolve(v.restartOk);
    },
    close() { v.closed = true; v.state = 'off'; v.waiting.splice(0).forEach((r) => r(null)); },
    stats: () => ({ blocks: v.pushes, msAvg: 1.5, loadMs: 300, lastError: v.state === 'off' ? 'off' : null }),
  };
  return v;
}
export function echoProbs(x) {
  const out = new Float32Array(Math.floor(x.length / 512));
  for (let i = 0; i < out.length; i++) out[i] = dbOf(x, i * 512, 512) > -45 ? 0.9 : 0.05;
  return out;
}

/**
 * 一整套假浏览器。env.deps() → createBedside 要的那些（不含 store），测试再加 store 和要改的。
 * 可以中途改：env.deny（getUserMedia 报这个名字的错）、env.resumeMode（'ok' | 'reject' | 'hang'）、env.worklet（'ok' | 'reject' | 'hang' | 'ctor'）、
 *   env.wakeDeny、env.busyLocks（别的标签页拿着的锁名）、env.est（estimate 的结果）
 */
export function fakeAudio({ t0, vad = {}, est = { usage: 2e8, quota: 1e10 } } = {}) {
  const clock = fakeClock(t0);
  const env = {
    clock, est, deny: null, resumeMode: 'ok', worklet: 'ok', wakeDeny: false, busyLocks: new Set(), noScript: false,
    contexts: [], nodes: [], sources: [], streams: [], gum: [], wakes: [], wakeReqs: 0, resumes: 0, persistCalls: 0, statuses: [],
    audioSession: { type: 'auto' },
    doc: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    win: new EventTarget(),
    vad: fakeVad(vad),
  };
  class FakeAudioContext extends EventTarget {
    constructor(opts = {}) {
      super();
      Object.assign(this, { opts, sampleRate: opts.sampleRate || 48000, state: 'suspended', destination: new FakeNode('destination', this) });
      this.audioWorklet = {
        modules: [],
        addModule: (url) => {
          this.audioWorklet.modules.push(String(url));
          return env.worklet === 'reject' ? Promise.reject(new DOMException('fetch failed', 'AbortError')) : env.worklet === 'hang' ? new Promise(() => {}) : Promise.resolve();
        },
      };
      env.contexts.push(this);
    }
    resume() {
      env.resumes++;
      if (this.state === 'closed') return Promise.reject(new DOMException('closed', 'InvalidStateError'));
      if (env.resumeMode === 'reject') return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      if (env.resumeMode === 'hang') return new Promise(() => {});
      return Promise.resolve().then(() => { if (this.state !== 'closed') this.setState('running'); });
    }
    close() { this.setState('closed'); return Promise.resolve(); }
    setState(s) { if (this.state === s) return; this.state = s; this.dispatchEvent(new Event('statechange')); }
    createMediaStreamSource(stream) { const n = new FakeNode('source', this); n.stream = stream; env.sources.push(n); return n; }
    createScriptProcessor(size, ins, outs) {
      if (env.noScript) throw new Error('no ScriptProcessor');
      const n = new FakeNode('script', this);
      Object.assign(n, { bufferSize: size, ins, outsN: outs, onaudioprocess: null });
      env.nodes.push(n);
      return n;
    }
    createGain() { const n = new FakeNode('gain', this); n.gain = { value: 1 }; return n; }
  }
  class FakeWorkletNode extends FakeNode {
    constructor(ctx, name, opts) {
      super('worklet', ctx);
      if (env.worklet === 'ctor') throw new Error('no AudioWorkletNode');
      Object.assign(this, { name, opts });
      this.port = { onmessage: null, closed: false, emit: (pcm) => { if (this.port.onmessage) this.port.onmessage({ data: { type: 'block', pcm } }); } };
      env.nodes.push(this);
    }
  }
  Object.assign(env, {
    AudioContext: FakeAudioContext, AudioWorkletNode: FakeWorkletNode,
    getUserMedia: (c) => {
      env.gum.push(c);
      if (env.deny) return Promise.reject(new DOMException('mic', env.deny));
      const s = new FakeStream([new FakeTrack()]);
      env.streams.push(s);
      return Promise.resolve(s);
    },
    wakeLock: {
      request(type) {
        env.wakeReqs++;
        if (env.wakeDeny) return Promise.reject(new DOMException('wake', 'NotAllowedError'));
        const s = new EventTarget();
        Object.assign(s, { type, released: false, release() { if (!s.released) { s.released = true; s.dispatchEvent(new Event('release')); } return Promise.resolve(); } });
        env.wakes.push(s);
        return Promise.resolve(s);
      },
    },
    locks: {
      held: new Map(),
      request(name, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (env.busyLocks.has(name) || this.held.has(name)) return opts.ifAvailable ? Promise.resolve().then(() => cb(null)) : new Promise(() => {});
        this.held.set(name, true);
        return Promise.resolve().then(() => cb({ name })).finally(() => this.held.delete(name));
      },
      async query() { return { held: [...this.held.keys(), ...env.busyLocks].map((name) => ({ name })) }; },
    },
    persist: () => { env.persistCalls++; return Promise.resolve(true); },
    estimate: () => Promise.resolve(env.est),
    setVisible(b) { env.doc.visibilityState = b ? 'visible' : 'hidden'; env.doc.dispatchEvent(new Event('visibilitychange')); },
    /** 16 kHz 的声音按块（4096）送进去：每块先让时钟走 256 ms（到点的 tick、心跳照常触发），再从现在的 worklet 节点发出来 */
    async play(f32) {
      for (let o = 0; o + 4096 <= f32.length; o += 4096) {
        await clock.advance(256);
        const n = env.node;
        if (n && n.port) n.port.emit(f32.slice(o, o + 4096));
        await flush();
      }
    },
    /** ScriptProcessor 那条路：按 bufferSize 把（ctx 采样率的）声音交给 onaudioprocess */
    async feedScript(f32) {
      const n = env.node;
      for (let o = 0; o + n.bufferSize <= f32.length; o += n.bufferSize) {
        const chunk = f32.slice(o, o + n.bufferSize);
        await clock.advance(Math.round(n.bufferSize * 1000 / env.ctx.sampleRate));
        if (n.onaudioprocess) n.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
        await flush();
      }
    },
    deps: (extra = {}) => ({
      settings: () => ({}), device: 'iPhone', build: 'test', tz: 'Asia/Shanghai', createVad: () => env.vad,
      getUserMedia: env.getUserMedia, AudioContext: FakeAudioContext, AudioWorkletNode: FakeWorkletNode, workletUrl: 'capture.worklet.js', AudioEncoder: null,
      wakeLock: env.wakeLock, audioSession: env.audioSession, locks: env.locks, doc: env.doc, win: env.win, persist: env.persist, estimate: env.estimate,
      now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      onStatus: (s) => env.statuses.push(s), ...extra,
    }),
  });
  Object.defineProperties(env, {             // 取的时候才算（Object.assign 会把 getter 变成当时的值）
    ctx: { get: () => env.contexts[env.contexts.length - 1] || null },
    stream: { get: () => env.streams[env.streams.length - 1] || null },
    track: { get: () => (env.stream ? env.stream.tracks[0] : null) },
    /** 现在接着的采集节点（最后建的、没断开的） */
    node: { get: () => { for (let i = env.nodes.length - 1; i >= 0; i--) if (!env.nodes[i].disconnected) return env.nodes[i]; return null; } },
  });
  return env;
}
