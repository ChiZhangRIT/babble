// 床头模式的检测部分：纯计算（不碰 DOM、IndexedDB、计时器），Node 里能测。所有位置都是绝对样本下标（16 kHz，从这次开始算）。
//   P                     所有常数（门限、片段规则、看门狗、保留天数…），调参只改这里
//   frameDb(x, off, n)    一帧的能量（dBFS，≥ −120）
//   createGate()          第一级：能量门。噪声底 = 最近 8 秒每帧能量的第 10 百分位，高出 7 dB 算有声（只看过去，不往后看）
//   createHyst()          第二级：说话识别概率的迟滞（0.30 进、0.15 出）；没有概率（null）原样传 null
//   createClipper()       片段状态机：说话 → 开一段（往前带 8 秒）→ 20 秒没说话 → 收在最后一句 + 2 秒；
//                         10 分钟封顶（接着说就无缝开下一段）；连续 3 分钟都像说话 → 当噪声，存前 3 分钟后冷却；
//                         只按音量时额度慢慢放开（一阵鼾声用不完一晚的额度）；今晚存够了（预算或存储满）→ 只数次数不存声音
//   createRing()          15 秒的 Int16 环形缓冲（开段时往前取 8 秒、写分片都从这里读）
//   toPcm16 / wavHeader / wavBlob   分片是裸 PCM16（小端，单声道 16 kHz），读出来时加 44 字节 WAV 头

export const P = Object.freeze({
  SR: 16000, FRAME: 512, BLOCK: 4096,                     // 分析采样率；一帧 32 ms；worklet 每块 256 ms = 8 帧
  RING_SEC: 15,                                           // 环形缓冲（480 KB）：够往前带 8 秒 + 等识别 2 秒 + 写入延迟
  FLOOR_SEC: 8, FLOOR_PCT: 0.10, FLOOR_MIN_DB: -100, GATE_WARM_SEC: 1,   // 噪声底：最近 8 秒的第 10 百分位（每块算一次）；头 1 秒不开门
  GATE_DB: 7, GATE_ABS_MIN_DB: -70, GATE_ATTACK: 2, GATE_HOLD_SEC: 0.3,  // 高出噪声底 7 dB（且不低于 −70）连续 2 帧开门，掉下去后再撑 0.3 秒
  VAD_ENTER: 0.30, VAD_EXIT: 0.15,                        // 说话识别的迟滞
  VAD_GAIN_TARGET_DB: -40, VAD_GAIN_MAX_DB: 30,           // 只给识别的那份放大：噪声底拉到 −40 dBFS，最多 +30 dB（很安静的屋里小声嘀咕不放大认不出来）
  VAD_IDLE_RESET_SEC: 2,                                  // 说过话以后识别 2 秒没听到说话 → 清一次它的状态（大声说完以后它对紧跟着的小声会变迟钝）
  VAD_LOAD_MAX_MS: 600000,                                // 开始 10 分钟后识别还在载入（下载卡住、没报错）→ 重启一次，还不行就整夜按能量
  VAD_WAIT_MS: 2000, VAD_LATE_MAX: 8,                     // 一块 2 秒没回 → 这块按能量算；连着 8 块 → 当识别挂了
  VAD_RESTART_MS: 30000, VAD_MAX_RESTARTS: 1,             // 挂了 30 秒后重启一次，再挂就整夜只按能量
  PRE_ROLL_SEC: 8, POST_ROLL_SEC: 2, REJOIN_SEC: 20,      // 往前带 8 秒、往后留 2 秒；20 秒内又说话算同一段
  MIN_SPEECH_SEC: 0.3, ENERGY_MIN_SPEECH_SEC: 0.6,        // 说话不到这么长的片段丢掉（只按能量时要求高一点）
  MAX_CLIP_SEC: 600,                                      // 一段最长 10 分钟，接着说就无缝开下一段
  NOISE_SEC: 180, NOISE_BUSY: 0.8,                        // 3 分钟里 80% 的帧都像说话 → 噪声（电视、风扇）
  NIGHT_BUDGET_SEC: 3600, BUDGET_FREE_SHARE: 0.5,         // 一晚最多存 60 分钟；开始时按剩余空间的一半往下调
  ENERGY_BUDGET_SHARE: 0.25, ENERGY_BUDGET_RAMP_SEC: 28800, ENERGY_FREE_SEC: 60,  // 只按音量时：先只能用额度的 1/4，按听了多久 8 小时放开；安静后新开的一段至少给 60 秒
  PART_SEC: 1,                                            // 每秒写一个分片
  EPISODE_GAP_SEC: 150,                                   // 报告里间隔 2.5 分钟以内的片段归成一组
  TICK_MS: 2000, STALL_MS: 3000, START_WAIT_MS: 3000,     // 看门狗：3 秒没收到声音 → 断了；建好 3 秒一块都没有 → 换接到输出的接法
  HEARTBEAT_MS: 10000, BEAT_LOG_MS: 60000, LATE_MS: 5000, // 心跳写会话；每分钟记一条 beat；计时器晚了 5 秒以上记 late
  MUTE_WAIT_MS: 30000, REBUILD_MS: 6000, REACQUIRE_MS: 20000, RESTART_MS: 45000,   // 恢复的阶梯（前台时从开始恢复算起）
  RETRY_MIN_MS: 5000, RETRY_MAX_MS: 60000, TAP_AFTER: 3,  // 退避 5 → 60 秒；前台失败 3 次 → 请用户点一下
  WAKE_RETRY_MS: 60000,                                   // 常亮被收回后每分钟再要一次
  RETAIN_DAYS: 7, DELETED_KEEP_MS: 86400000, LOG_KEEP_DAYS: 30, CARD_DAYS: 3,      // 没留下的声音 7 天；删掉的 24 小时内能恢复；记录 30 天；「昨夜」卡片 3 天
  GAP_SHOW_SEC: 30, EVENTS_MAX: 5000,                     // 短于 30 秒的中断合成一行；每晚最多记 5000 条事件
  HOLD_MS: 2000, MOVE_MS: 60000, SESSION_PUT_WAIT_MS: 3000, END_WAIT_MS: 5000,     // 按住结束 2 秒；状态字每分钟挪个位置；写会话、收尾最多等多久
});

/** 一帧的能量：10·log10(均方 + 1e-12)，所以最小 −120（数字静音；NaN 也按 −120） */
export function frameDb(x, off = 0, n = x.length - off) {
  const end = Math.min(x.length, off + n);
  let s = 0;
  for (let i = off; i < end; i++) s += x[i] * x[i];
  const db = 10 * Math.log10((end > off ? s / (end - off) : 0) + 1e-12);
  return db > -120 ? db : -120;
}

/** 能量门：每帧 push(db) → 开着没有。噪声底每 8 帧（一块）重算一次，只用已经来过的帧 */
export function createGate(p = P) {
  const N = Math.round(p.FLOOR_SEC * p.SR / p.FRAME), warm = p.GATE_WARM_SEC * p.SR / p.FRAME;
  const holdFrames = Math.round(p.GATE_HOLD_SEC * p.SR / p.FRAME);
  const hist = new Float32Array(N), tmp = new Float32Array(N);
  let n = 0, i = 0, k = 0, floor = p.FLOOR_MIN_DB, above = 0, hold = 0, open = false;
  const thr = () => Math.max(floor + p.GATE_DB, p.GATE_ABS_MIN_DB);
  return {
    push(db) {
      hist[i] = db; i = (i + 1) % N; n = Math.min(n + 1, N);
      if (k++ % 8 === 0) { const s = tmp.subarray(0, n); s.set(hist.subarray(0, n)); s.sort(); floor = Math.max(p.FLOOR_MIN_DB, s[Math.floor(n * p.FLOOR_PCT)]); }
      if (n < warm) return (open = false);
      if (db >= thr()) { if (++above >= p.GATE_ATTACK) { open = true; hold = holdFrames; } }
      else { above = 0; if (open && --hold <= 0) open = false; }
      return open;
    },
    floor: () => floor, thr,
    reset() { n = i = k = above = hold = 0; open = false; },     // 每次中断后：1 秒内重新学噪声底
  };
}

/** 说话概率的迟滞：≥ 0.30 进、< 0.15 出；null（识别没回、没开）→ null，状态不变 */
export function createHyst(p = P) {
  let on = false;
  return {
    push(prob) {
      if (prob == null) return null;
      if (!on && prob >= p.VAD_ENTER) on = true;
      else if (on && prob < p.VAD_EXIT) on = false;
      return on;
    },
    reset() { on = false; },
  };
}

/**
 * 片段状态机（idle → open → idle；噪声 → cool；只按音量存得太快 → hold；存满 → full，整晚不再存）。每帧 frame({ at, speech, db, prob, gate })，
 * at = 这一帧第一个样本的绝对下标；返回动作列表，引擎照着写库：
 *   {type:'open', from, at}  {type:'close', from, to, speechSec, gateSec, peakDb, vadMax, cut}  {type:'drop', from, speechSec, cut}
 *   {type:'noise', at}  {type:'noiseEnd', at}  {type:'hold', at}  {type:'holdEnd', at}  {type:'full', at, why: 'budget'|'storage'}
 * minSpeech 每次收段时问一次（识别挂了以后要求变高）；energyOnly 每帧问（识别用不了：鼾声也算「说话」，存的额度按听了多久慢慢放开）
 */
export function createClipper({ p = P, budgetSec = p.NIGHT_BUDGET_SEC, minSpeech = () => p.MIN_SPEECH_SEC, energyOnly = () => false } = {}) {
  const F = p.FRAME, S = (sec) => Math.round(sec * p.SR), NB = Math.round(p.NOISE_SEC * p.SR / F);
  let mode = 'idle', c = null, prevEnd = 0, runStart = 0, saved = 0, eoSaved = 0, coolLast = 0, heard = 0, lastHeard = -Infinity;
  // 只按音量时到 end 为止最多存多少秒：一开始 1/4，听满 8 小时到全部（识别开着就是整个预算）。
  // 和它比的是只按音量时存下的（eoSaved）：识别开着时存的不占这份额度（识别半夜挂了，后面照样有额度）；整晚的总预算照样算全部（saved）
  const capOf = (end) => (energyOnly() ? Math.min(budgetSec, budgetSec * (p.ENERGY_BUDGET_SHARE + end / p.SR / p.ENERGY_BUDGET_RAMP_SEC)) : budgetSec);
  const count = (speech, end) => { if (speech && end - lastHeard >= S(p.REJOIN_SEC)) heard++; if (speech) lastHeard = end; };

  function close(to, cut) {
    const r = c; c = null; prevEnd = to;
    const sp = r.sp * F / p.SR;
    if (sp < minSpeech()) return { type: 'drop', from: r.from, speechSec: sp, cut };
    saved += (to - r.from) / p.SR;
    if (energyOnly()) eoSaved += (to - r.from) / p.SR;
    return { type: 'close', from: r.from, to, speechSec: sp, gateSec: r.gateN * F / p.SR, peakDb: r.peakDb, vadMax: r.vadMax, cut };
  }
  function frame({ at, speech, db = -120, prob = null, gate = false }) {
    const end = at + F, out = [];
    if (mode === 'full') { count(speech, end); return out; }      // 只数「又听到几次」（隔 20 秒以上算新的一次）
    if (mode === 'cool') {                                // 噪声之后：一直到 20 秒没声音前什么都不存
      if (speech) coolLast = end;
      if (end - coolLast >= S(p.REJOIN_SEC)) { mode = 'idle'; prevEnd = Math.max(prevEnd, coolLast); out.push({ type: 'noiseEnd', at: coolLast }); }
      return out;
    }
    if (mode === 'hold') {                                // 只按音量时存得太快：只数次数，等安静 20 秒、额度也涨回来了（或识别回来了）再存
      count(speech, end);
      if (energyOnly() && (end - lastHeard < S(p.REJOIN_SEC) || eoSaved >= capOf(end))) return out;
      mode = 'idle'; out.push({ type: 'holdEnd', at: end });
    }
    if (mode === 'idle') {
      if (!speech) return out;
      if (saved >= budgetSec) { mode = 'full'; heard = 1; lastHeard = end; return [{ type: 'full', at, why: 'budget' }]; }
      if (eoSaved >= capOf(end) + p.ENERGY_FREE_SEC) { mode = 'hold'; heard = 1; lastHeard = end; return [...out, { type: 'hold', at }]; }
      // 往前带 8 秒，但不越过上一段的结尾、也不越过中断（restart）
      c = { from: Math.max(at - S(p.PRE_ROLL_SEC), prevEnd, runStart), last: end, sp: 0, gateN: 0, peakDb: -120, vadMax: 0, bits: new Uint8Array(NB), bi: 0, busy: 0, eo0: eoSaved };
      mode = 'open'; out.push({ type: 'open', from: c.from, at });
    }
    // open：最近 3 分钟里有几帧像说话（环形计数）
    const b = speech ? 1 : 0;
    c.busy += b - c.bits[c.bi]; c.bits[c.bi] = b; c.bi = (c.bi + 1) % NB;
    if (speech) { c.sp++; c.last = end; }
    if (gate) c.gateN++;
    c.peakDb = Math.max(c.peakDb, db);
    if (prob != null) c.vadMax = Math.max(c.vadMax, prob);
    const len = end - c.from;
    if (saved + len / p.SR >= budgetSec) {
      out.push(close(end, 'budget')); mode = 'full'; heard = 0; lastHeard = end; out.push({ type: 'full', at: end, why: 'budget' });
    } else if (energyOnly() && eoSaved + (Math.min(end, c.last + S(p.POST_ROLL_SEC)) - c.from) / p.SR >= Math.max(capOf(end), c.eo0 + p.ENERGY_FREE_SEC)) {
      // 只按音量时这一阵存得太快（一直打鼾）：收掉，先只数次数（按收段时会留下的长度算：说完后等着的那 20 秒不算）
      out.push(close(Math.min(end, c.last + S(p.POST_ROLL_SEC)), 'budget')); mode = 'hold'; heard = 0; lastHeard = end; out.push({ type: 'hold', at: end });
    } else if (len >= S(p.NOISE_SEC) && c.busy >= p.NOISE_BUSY * NB) {
      out.push(close(end, 'noise')); mode = 'cool'; coolLast = end; out.push({ type: 'noise', at: end });
    } else if (end - c.last >= S(p.REJOIN_SEC)) {
      out.push(close(Math.min(c.last + S(p.POST_ROLL_SEC), end), 'quiet')); mode = 'idle';
    } else if (len >= S(p.MAX_CLIP_SEC)) {
      out.push(close(end, 'max')); mode = 'idle';         // 8 秒内接着说：新的一段 from = prevEnd，无缝接上（引擎记 contOf）
    }
    return out;
  }
  /** 中断或结束：开着的段收在 min(最后一句 + 2 秒, at)；at = 最后判过的样本。full、hold 照旧（hold 按额度和安静了多久自己解除） */
  function flush(at, cut) {
    const out = [];
    if (mode === 'open') { out.push(close(Math.min(c.last + S(p.POST_ROLL_SEC), at), cut)); mode = 'idle'; }
    if (mode === 'cool') { out.push({ type: 'noiseEnd', at }); mode = 'idle'; }
    return out;
  }
  /** 存不进去了：收掉开着的段，之后只数次数。已经是 full 就什么都不做（别重复记） */
  function stopSaving(at, why) {
    if (mode === 'full') return [];
    const out = mode === 'hold' ? [{ type: 'holdEnd', at }] : flush(at, why);
    mode = 'full'; heard = 0; out.push({ type: 'full', at, why });
    return out;
  }
  /** 中断之后接着听：往前带的 8 秒不能越过中断 */
  function restart(at) { runStart = at; prevEnd = Math.max(prevEnd, at); }

  return {
    frame, flush, restart, stopSaving,
    get mode() { return mode; },
    get openInfo() { return c ? { from: c.from, last: c.last, sp: c.sp * F / p.SR } : null; },
    get savedSec() { return saved; },
    get heard() { return heard; },
  };
}

function q16(s) {             // 和 loudness.js encodeWav 一样：超出的削掉，NaN → 0
  s = s > 1 ? 1 : s < -1 ? -1 : s === s ? s : 0;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

/** Float32（−1..1）→ Int16，超出的削掉 */
export function toPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = q16(f32[i]);
  return out;
}

/** 环形缓冲：push 进来的样本按绝对下标编号（total 是一共来过多少），只留最近 sec 秒；read 读一份拷贝，超出范围的部分截掉 */
export function createRing(sec = P.RING_SEC, sr = P.SR) {
  const N = Math.round(sec * sr), buf = new Int16Array(N);
  let total = 0;
  const start = () => Math.max(0, total - N);
  return {
    push(f32) {
      const skip = Math.max(0, f32.length - N);           // 一次比整个环还长：只要最后 N 个
      for (let i = skip, j = (total + skip) % N; i < f32.length; i++, j = j + 1 === N ? 0 : j + 1) buf[j] = q16(f32[i]);
      total += f32.length;
    },
    read(from, to) {
      const a = Math.max(from, start()), b = Math.min(to, total);
      const out = new Int16Array(Math.max(0, b - a));
      for (let i = 0, j = a % N; i < out.length; i++, j = j + 1 === N ? 0 : j + 1) out[i] = buf[j];
      return out;
    },
    get total() { return total; },
    get start() { return start(); },
  };
}

/** 44 字节的 WAV 头：PCM16 单声道小端 */
export function wavHeader(samples, sr = P.SR) {
  const h = new Uint8Array(44), v = new DataView(h.buffer);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  return h;
}

/** 分片（ArrayBuffer，按顺序）→ WAV Blob。长度取 min(samples, 分片里实际有的)：崩溃收尾时 samples 比分片短，多的截掉。
 *  Int16Array 按本机字节序写，在用的平台（ARM、x86）都是小端，所以分片直接拼上 */
export function wavBlob(parts, samples, sr = P.SR) {
  const bytes = parts.reduce((s, b) => s + b.byteLength, 0);
  const n = Math.min(samples ?? Infinity, Math.floor(bytes / 2));
  const body = [];
  let left = n * 2;
  for (const b of parts) {
    if (left <= 0) break;
    const u = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
    body.push(u.byteLength <= left ? u : u.subarray(0, left));
    left -= u.byteLength;
  }
  return new Blob([wavHeader(n, sr), ...body], { type: 'audio/wav' });
}
