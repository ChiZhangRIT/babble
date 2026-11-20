import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('发布准备：校验不写文件；内容变化才升级版本，启动器与 vendor 缓存一起更新，重复运行保持不变', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'babble-release-test-'));
  try {
    for (const dir of ['scripts', 'src', 'vendor/transformers']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(new URL('../scripts/prepare-release.mjs', import.meta.url), path.join(root, 'scripts/prepare-release.mjs'));
    fs.writeFileSync(path.join(root, 'sw.js'), "const CACHE = 'babble-v1';\nconst VENDOR_CACHE = 'babble-vendor-test';\nconst CORE = ['./', './index.html', './src/start.js'];\n");
    fs.writeFileSync(path.join(root, 'src/start.js'), "export const BUILD = 'babble-v1';\n");
    fs.writeFileSync(path.join(root, 'index.html'), '<p>fixture</p>');
    fs.writeFileSync(path.join(root, 'vendor/transformers/test.js'), 'fixture vendor');
    const run = (...args) => spawnSync(process.execPath, ['scripts/prepare-release.mjs', ...args], { cwd: root, encoding: 'utf8' });
    const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    assert.equal(run().status, 0); assert.equal(manifest().cache, 'babble-v1');
    const original = fs.readFileSync(path.join(root, 'release.json'), 'utf8');
    assert.equal(run().status, 0); assert.equal(fs.readFileSync(path.join(root, 'release.json'), 'utf8'), original);
    fs.appendFileSync(path.join(root, 'index.html'), '<p>changed</p>');
    assert.equal(run('--check').status, 1);
    assert.equal(fs.readFileSync(path.join(root, 'release.json'), 'utf8'), original, '--check 不改清单');
    assert.equal(run().status, 0); assert.equal(manifest().cache, 'babble-v2');
    assert.ok(fs.readFileSync(path.join(root, 'src/start.js'), 'utf8').includes("BUILD = 'babble-v2'"));
    fs.appendFileSync(path.join(root, 'vendor/transformers/test.js'), '\nupdated');
    assert.equal(run().status, 0); assert.equal(manifest().cache, 'babble-v3');
    assert.notEqual(manifest().vendorCache, 'babble-vendor-test');
    assert.equal(run('--check').status, 0);
    // 去掉一个第三方文件也改名
    const renamed = manifest().vendorCache;
    fs.writeFileSync(path.join(root, 'vendor/transformers/extra.js'), 'fixture extra');
    assert.equal(run().status, 0); assert.equal(manifest().vendorCache, renamed, '只加了文件：不改名');
    fs.rmSync(path.join(root, 'vendor/transformers/test.js'));
    assert.equal(run().status, 0); assert.notEqual(manifest().vendorCache, renamed, '去掉了文件：改名');
    assert.equal(run('--check').status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('发布准备：vendor/silero-vad 的 .onnx 模型也进 vendor 清单（其它文件不进）；加了模型版本升级，vendor 缓存不改名（转文字已经下载的程序文件照样能离线用）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'babble-release-test-'));
  try {
    for (const dir of ['scripts', 'src', 'vendor/transformers']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(new URL('../scripts/prepare-release.mjs', import.meta.url), path.join(root, 'scripts/prepare-release.mjs'));
    fs.writeFileSync(path.join(root, 'sw.js'), "const CACHE = 'babble-v1';\nconst VENDOR_CACHE = 'babble-vendor-test';\nconst CORE = ['./', './index.html', './src/start.js'];\n");
    fs.writeFileSync(path.join(root, 'src/start.js'), "export const BUILD = 'babble-v1';\n");
    fs.writeFileSync(path.join(root, 'index.html'), '<p>fixture</p>');
    fs.writeFileSync(path.join(root, 'vendor/transformers/test.js'), 'fixture vendor');
    const run = (...args) => spawnSync(process.execPath, ['scripts/prepare-release.mjs', ...args], { cwd: root, encoding: 'utf8' });
    const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    assert.equal(run().status, 0);
    assert.deepEqual(Object.keys(manifest().vendor), ['./vendor/transformers/test.js'], '没有 silero-vad 文件夹：照旧');
    fs.mkdirSync(path.join(root, 'vendor/silero-vad'));
    fs.writeFileSync(path.join(root, 'vendor/silero-vad/x.onnx'), 'fixture model');
    fs.writeFileSync(path.join(root, 'vendor/silero-vad/README.md'), 'fixture readme');
    fs.writeFileSync(path.join(root, 'vendor/silero-vad/LICENSE'), 'fixture license');
    assert.equal(run('--check').status, 1, '加了模型没重新准备：检查失败');
    assert.equal(run().status, 0);
    const m = manifest();
    assert.deepEqual(Object.keys(m.vendor), ['./vendor/transformers/test.js', './vendor/silero-vad/x.onnx']);
    assert.equal(m.vendor['./vendor/silero-vad/x.onnx'], createHash('sha256').update('fixture model').digest('hex'));
    assert.equal(m.cache, 'babble-v2');
    assert.equal(m.vendorCache, 'babble-vendor-test');
    assert.ok(fs.readFileSync(path.join(root, 'sw.js'), 'utf8').includes("const VENDOR_CACHE = 'babble-vendor-test';"));
    assert.equal(run('--check').status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
