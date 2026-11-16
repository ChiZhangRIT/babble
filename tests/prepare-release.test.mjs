import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
