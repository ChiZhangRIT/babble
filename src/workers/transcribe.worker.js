// 语音转文字 worker（模块 worker，src/core/transcribe.js 开的）：在这台设备上跑 Whisper，录音不离开设备。
// 一个 worker 只用一种后端（显卡 WebGPU 或处理器 WASM：onnxruntime 第一次建会话前定好，之后换不了），用完由页面结束（内存马上还回去）。
// 消息：页面 → worker  { type:'load', model, revision, device:'webgpu'|'wasm', dtype }
//                      { type:'run', id, segments: Float32Array[] }（16 kHz 单声道，按说话分好的段，每段 ≤ 28 秒）
//       worker → 页面  { type:'progress', pct, loaded, total }（下载模型）| { type:'ready' }
//                      { type:'seg', id, i } | { type:'partial', id, i, t }（边识别边出的字）| { type:'segDone', id, i, text }
//                      { type:'result', id, texts } | { type:'error', message }
import { pipeline, env, TextStreamer } from '../../vendor/transformers/transformers.min.js';

const V = new URL('../../vendor/transformers/', import.meta.url).href;
const post = (m) => self.postMessage(m);
let asr = null;

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      env.allowLocalModels = false;       // 没有本地模型目录：只从 Hugging Face 下载，存进 transformers.js 自己的缓存（transformers-cache）
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      env.useWasmCache = false;           // 开了会把 .mjs 转成 blob: 再 import（CSP 还得放开 blob:）
      // onnxruntime 的 wasm 默认从 jsDelivr 取：改成仓库里的文件。要改原来那个对象，整个换掉不生效
      const v = m.device === 'webgpu' ? '.asyncify' : '';     // 显卡要 asyncify 版；处理器用普通版（峰值内存少一半）
      const w = env.backends.onnx.wasm;
      w.wasmPaths = { mjs: `${V}ort-wasm-simd-threaded${v}.mjs`, wasm: `${V}ort-wasm-simd-threaded${v}.wasm` };
      w.numThreads = 1;                   // 没有跨源隔离，多线程用不了
      w.proxy = false;
      asr = await pipeline('automatic-speech-recognition', m.model, {
        revision: m.revision, device: m.device, dtype: m.dtype,
        progress_callback: (p) => { if (p && p.status === 'progress_total') post({ type: 'progress', pct: p.progress, loaded: p.loaded, total: p.total }); },
      });
      post({ type: 'ready' });
    } else if (m.type === 'run') {
      const texts = [];
      for (let i = 0; i < m.segments.length; i++) {
        const pcm = m.segments[i];
        post({ type: 'seg', id: m.id, i });
        const streamer = new TextStreamer(asr.tokenizer, { skip_prompt: true, skip_special_tokens: true,
          callback_function: (t) => post({ type: 'partial', id: m.id, i, t }) });
        // 每段单独识别（自带的 30 秒分块会整句漏掉）；字数上限按时长给，卡住重复时早点停
        const out = await asr(pcm, { language: 'zh', task: 'transcribe', streamer,
          max_new_tokens: Math.min(440, Math.round((pcm.length / 16000) * 12) + 24) });
        const text = String((out && out.text) || '').trim();
        texts.push(text);
        m.segments[i] = null;               // 识别完的放掉
        post({ type: 'segDone', id: m.id, i, text });
      }
      post({ type: 'result', id: m.id, texts });
    }
  } catch (e) {
    post({ type: 'error', message: String((e && e.message) || e) });
  }
};
self.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String((e.reason && e.reason.message) || e.reason) }));
