import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, createZip, readZip, ZipError } from '../src/core/zip.js';

// 测试只用编出来的数据
const enc = new TextEncoder(), dec = new TextDecoder();
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const sample = () => {
  const bin = new Uint8Array(100000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 131 + (i >> 8)) & 255;
  return bin;
};

test('crc32：标准校验值，可以分段算', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const a = enc.encode('今天吃'), b = enc.encode('什么');
  assert.equal(crc32(b, crc32(a)), crc32(enc.encode('今天吃什么')));
});

test('写了再读：中文 / emoji 文件名、二进制、Blob、字符串、空文件、修改时间（2 秒精度）', async () => {
  const bin = sample();
  const when = new Date(2026, 10, 4, 2, 58, 31);
  const zip = await createZip([
    { name: 'babble.json', data: '{"app":"babble"}', date: when },
    { name: '梦话.md', data: '# 牙牙呓语\n👰🏻‍♀️“今天吃什么”\n' },
    { name: 'audio/2026-11-04 测试录音 🐷 (abcd1234).m4a', data: new Blob([bin], { type: 'audio/mp4' }) },
    { name: 'audio/空.m4a', data: new Uint8Array(0) },
  ]);
  assert.equal(zip.type, 'application/zip');
  const files = await readZip(zip);
  assert.deepEqual(files.map(f => f.name), ['babble.json', '梦话.md', 'audio/2026-11-04 测试录音 🐷 (abcd1234).m4a', 'audio/空.m4a']);
  assert.equal(dec.decode(files[0].data), '{"app":"babble"}');
  assert.equal(dec.decode(files[1].data), '# 牙牙呓语\n👰🏻‍♀️“今天吃什么”\n');
  assert.deepEqual(files[2].data, bin);
  assert.equal(files[3].data.length, 0);
  assert.equal(files[0].date.getTime(), new Date(2026, 10, 4, 2, 58, 30).getTime());
  // 也能直接读 Uint8Array / ArrayBuffer
  const raw = await bytesOf(zip);
  assert.equal((await readZip(raw)).length, 4);
  assert.equal((await readZip(raw.buffer)).length, 4);
  // 每个文件都设了 UTF-8 标志（通用位第 11 位），只存储不压缩
  assert.equal(raw[6] | (raw[7] << 8), 0x0800);
  assert.equal(raw[8] | (raw[9] << 8), 0);
});

test('能读别的工具压缩过的 zip（deflate，带目录条目）', async () => {
  // python3 zipfile.ZIP_DEFLATED 生成：demo/babble.json、demo/说明.txt、demo/empty/
  const b64 = 'UEsDBBQAAAAIAHQNa10pISRkEgAAABAAAAAQAAAAZGVtby9iYWJibGUuanNvbqtWSiwoULJSSkpMSspJVaoFAFBLAwQUAAAICAB0DWtdpNvnuxgAAABAAQAADwAAAGRlbW8v6K+05piOLnR4dHuyu+vpkpVPJzQ/2d3wZGeHwpNRPkl8AFBLAwQUAAAACAB0DWtdAAAAAAIAAAAAAAAACwAAAGRlbW8vZW1wdHkvAwBQSwECFAMUAAAACAB0DWtdKSEkZBIAAAAQAAAAEAAAAAAAAAAAAAAAgAEAAAAAZGVtby9iYWJibGUuanNvblBLAQIUAxQAAAgIAHQNa12k2+e7GAAAAEABAAAPAAAAAAAAAAAAAACAAUAAAABkZW1vL+ivtOaYji50eHRQSwECFAMUAAAACAB0DWtdAAAAAAIAAAAAAAAACwAAAAAAAAAAABAA/UGFAAAAZGVtby9lbXB0eS9QSwUGAAAAAAMAAwC0AAAAsAAAAAAA';
  const files = await readZip(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  assert.deepEqual(files.map(f => f.name), ['demo/babble.json', 'demo/说明.txt']);
  assert.equal(dec.decode(files[0].data), '{"app":"babble"}');
  assert.equal(dec.decode(files[1].data), '今天吃什么 '.repeat(20));
});

test('坏文件：不是 zip → notZip；内容被改 → crc；重名 → dupName', async () => {
  await assert.rejects(readZip(enc.encode('这不是 zip 文件，只是一段文字而已。')), e => e instanceof ZipError && e.code === 'notZip');
  await assert.rejects(readZip(new Uint8Array(3)), e => e.code === 'notZip');
  const raw = await bytesOf(await createZip([{ name: 'a.txt', data: '今天吃什么' }]));
  raw[30 + 5 + 9] ^= 0xFF;                                    // 改掉数据的第一个字节（本地头 30 + 文件名 5 + 扩展字段 9）
  await assert.rejects(readZip(raw), e => e.code === 'crc');
  await assert.rejects(createZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]), e => e.code === 'dupName');
});

let hasUnzip = false;
try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); hasUnzip = true; } catch (e) { hasUnzip = false; }
test('系统的 unzip -t 认得我们写的 zip', { skip: !hasUnzip && '没有 unzip' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'babble-zip-'));
  try {
    const file = join(dir, 'test.zip');
    writeFileSync(file, await bytesOf(await createZip([
      { name: 'babble.json', data: '{}' },
      { name: '梦话.md', data: '# 牙牙呓语\n' },
      { name: 'audio/2026-11-04 测试录音 (abcd1234).m4a', data: sample() },
    ])));
    const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
