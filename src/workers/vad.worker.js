// 说话识别 worker（模块 worker，src/core/vad.js 的 createVad 开的）：Silero VAD v6.2（16 kHz，vendor/silero-vad/），床头模式整夜开着。
// 一个 worker 只载入一次模型；坏了由页面结束、换一个新的（iOS 上反复初始化 onnxruntime 有内存不够的报告，页面最多换一次）。
// 消息：页面 → worker  { type:'load' } | { type:'block', seq, pcm: Float32Array(4096) }（16 kHz 单声道，转交）
//                      { type:'reset' }（每次中断之后：状态和前 64 个样本清零）
//       worker → 页面  { type:'ready', ms } | { type:'probs', seq, probs: Float32Array(8)|null, ms }（null：还没载入好，马上回、不排队；
//                      ms：这一块实际算了多少毫秒）| { type:'error', code:'load'|'run', seq?, message }
// 用 transformers.js 的 AutoModel 载入：config 给 { model_type:'custom' } 就不去取 config.json，前向时按会话的输入名原样传
// （控制台会提示一句 Unknown model class "custom"，没关系）。它不导出 onnxruntime 的 InferenceSession / Tensor
// （env.backends.onnx 只是 ort.env 的浅拷贝），所以不自己建会话；多包一层每步只多几微秒。
import { AutoModel, Tensor, env } from '../../vendor/transformers/transformers.min.js';
import { createStepper } from '../core/vad.js';

const V = new URL('../../vendor/transformers/', import.meta.url).href;
const post = (m, transfer) => self.postMessage(m, transfer || []);
const msgOf = (e) => String((e && e.message) || e);
const clock = () => performance.now();
let stepper = null, loading = null;
const spent = [];                         // 每步算了多少毫秒（按顺序；一块取走它那 8 步）

function load() {
  if (!loading) loading = (async () => {
    const t0 = clock();
    env.allowLocalModels = true;          // 模型就在仓库里（vendor/silero-vad/），不从 Hugging Face 下载
    env.allowRemoteModels = false;
    env.useBrowserCache = false;          // 缓存交给 sw.js（VENDOR_CACHE，按 release.json 核对 sha256），离线也能用
    env.localModelPath = new URL('../../vendor/', import.meta.url).href;
    env.useWasmCache = false;             // 开了会把 .mjs 转成 blob: 再 import（CSP 还得放开 blob:）
    // onnxruntime 的 wasm 用仓库里的普通版（不是 asyncify，内存少）；要改原来那个对象，整个换掉不生效
    const w = env.backends.onnx.wasm;
    w.wasmPaths = { mjs: `${V}ort-wasm-simd-threaded.mjs`, wasm: `${V}ort-wasm-simd-threaded.wasm` };
    w.numThreads = 1;                     // 没有跨源隔离，多线程用不了
    w.proxy = false;
    // dtype 一定要给（处理器默认 q8，会去找 _quantized）；不给 progress_callback：1.3 MB 用不着，给了还会多发 Range 请求
    const model = await AutoModel.from_pretrained('silero-vad', { subfolder: '', model_file_name: 'silero_vad_16k_op15',
      config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm' });
    const sr = new Tensor('int64', BigInt64Array.from([16000n]), []);
    stepper = createStepper({ run: async ({ input, state }) => {
      const t = clock();
      const { output, stateN } = await model({ input: new Tensor('float32', input, [1, input.length]), state: new Tensor('float32', state, [2, 1, 128]), sr });
      spent.push(clock() - t);
      return { prob: output.data[0], state: stateN.data };
    } });
    return Math.round(clock() - t0);
  })();
  return loading;
}

self.onmessage = ({ data: m }) => {
  if (!m) return;
  if (m.type === 'load') load().then(ms => post({ type: 'ready', ms }), e => post({ type: 'error', code: 'load', message: msgOf(e) }));
  else if (m.type === 'block') {
    if (!stepper) { post({ type: 'probs', seq: m.seq, probs: null, ms: 0 }); return; }
    stepper.batch(m.pcm).then(
      (probs) => post({ type: 'probs', seq: m.seq, probs, ms: spent.splice(0, probs.length).reduce((a, b) => a + b, 0) }, [probs.buffer]),
      (e) => { spent.length = 0; post({ type: 'error', code: 'run', seq: m.seq, message: msgOf(e) }); });
  } else if (m.type === 'reset') { if (stepper) stepper.reset(); }
};
self.addEventListener('unhandledrejection', (e) => post({ type: 'error', code: 'run', message: msgOf(e.reason) }));
