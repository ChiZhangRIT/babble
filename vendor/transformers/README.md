# vendor/transformers

「语音转文字（草稿）」用的第三方文件，原样拷贝自 npm 包（没有改动、没有 source map）。
GitHub Pages 上直接用；运行时不从 CDN 取任何程序文件，只从 Hugging Face 下载模型。

| 文件 | 来源 | 许可 |
|---|---|---|
| `transformers.min.js` | `@huggingface/transformers` 4.3.2 `dist/` | Apache-2.0（`LICENSE`） |
| `ort-wasm-simd-threaded.mjs` / `.wasm` | `onnxruntime-web` 1.31.0-dev.20260914-8d85527a0 `dist/`：用处理器（CPU）识别 | MIT（`LICENSE-onnxruntime-web`） |
| `ort-wasm-simd-threaded.asyncify.mjs` / `.wasm` | 同上：用显卡（WebGPU）识别时必须用这一版 | MIT |

SHA-256：

```
8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb  transformers.min.js
c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f  ort-wasm-simd-threaded.mjs
06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3  ort-wasm-simd-threaded.wasm
0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611  ort-wasm-simd-threaded.asyncify.mjs
49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082  ort-wasm-simd-threaded.asyncify.wasm
```

升级：`npm pack @huggingface/transformers@<版本>` 和它依赖的 `onnxruntime-web`，拷贝上面这几个文件，
同时改 `sw.js` 的 `VENDOR_CACHE`（名字带版本号，旧的缓存会被清掉）和 `src/core/transcribe.js` 里的说明。
