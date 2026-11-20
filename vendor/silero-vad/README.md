# vendor/silero-vad

「床头模式」用的说话识别模型（Silero VAD v6.2，只认 16 kHz），原样拷贝（没有改动）。
在 `src/workers/vad.worker.js` 里用 `vendor/transformers/` 的 transformers.js + onnxruntime-web（处理器 WASM）跑；运行时不从网上取任何东西。
不放进 `sw.js` 的 CORE（每次发版都会整个重新下载）：第一次用到时由 `sw.js` 按 `release.json` 的 `vendor` 核对 sha256，存进 VENDOR_CACHE，之后离线也能用。

| 文件 | 来源 | 许可 |
|---|---|---|
| `silero_vad_16k_op15.onnx` | PyPI `silero-vad` 6.2.3 的 wheel（`silero_vad-6.2.3-py3-none-any.whl`）里的 `silero_vad/data/silero_vad_16k_op15.onnx`；和上游 github.com/snakers4/silero-vad tag `v6.2.3`（commit `5cd7945676eb32225748052e2e6a0580e4686a08`）的 `src/silero_vad/data/` 里同名文件逐字节相同 | MIT（`LICENSE`） |
| `LICENSE` | 同一个 wheel 里的 `silero_vad-6.2.3.dist-info/licenses/LICENSE`（Copyright (c) 2020-present Silero Team） | — |

SHA-256：

```
7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49  silero_vad_16k_op15.onnx（1,289,603 字节）
7b7f5436cfcb02fae583a05b512ea96467fd449fe54cb49a5e4f06c51a1e43b8  silero_vad-6.2.3-py3-none-any.whl（下载来的 wheel，不在仓库里）
```

wheel 的 `RECORD` 里记的也是这个文件的哈希（`sha256=ftmN262EzKxM0K6zCZBJKAcT34JcYQqO00VDMY8bLEk`，就是上面那串的 base64 写法）。

模型（opset 15，PyTorch 2.3.1 导出）：输入 `input` [1, 576] float32（上一步最后 64 个样本 + 这一步 512 个）、`state` [2, 1, 128] float32、`sr` int64 标量 16000；
输出 `output` [1, 1]（这 32 ms 像说话的概率）、`stateN`（下一步的 `state`）。前面那 64 个样本一定要接上，不接 v6.2 对说话也几乎全给 0。

升级：`pip download silero-vad==<版本> --no-deps`（或 GitHub 对应 tag 的 `src/silero_vad/data/`），核对 wheel 的 sha256（PyPI 页面上有）和 `RECORD` 里的文件哈希，
拷贝 `silero_vad_16k_op15.onnx` 和 `LICENSE`，改上面的来源和 SHA-256。输入输出的名字或形状变了要改 `src/core/vad.js` 和 `src/workers/vad.worker.js`
（`tests/vad.test.mjs` 会在 Node 里用真模型跑一次合成的声音；换了模型还要在浏览器里载入一次，看看说话时概率接近 1、安静时接近 0）。
最后 `node scripts/prepare-release.mjs`：重算 `release.json` 的 vendor 哈希，并改 `sw.js` 的 VENDOR_CACHE（旧缓存会被清掉）。
