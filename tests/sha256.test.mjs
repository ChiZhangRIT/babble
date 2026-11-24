import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, sha256Js, HASH_CHUNK_BYTES } from '../src/core/sha256.js';

test('SHA-256 与独立实现一致：块边界、填充边界、带偏移的二进制输入', async () => {
  for (const n of [0,1,55,56,63,64,65,127,128,129,1025]) {
    const backing = Uint8Array.from({length:n+13},(_,i)=>(i*37+19)%256), x = backing.subarray(7,7+n);
    const want = createHash('sha256').update(x).digest('hex');
    assert.equal(sha256Js(x), want); assert.equal(await sha256Hex(x), want);
  }
});

test('大文件哈希分块：不读整个 Blob，多个分片和最后的 SHA 填充仍与 Node crypto 一致', async () => {
  for (const tail of [55,56,64,65]) {
    const x = Uint8Array.from({length:5*HASH_CHUNK_BYTES+tail},(_,i)=>(i*37+19)%256), source = new Blob([x]), sizes = [];
    const file = { size: source.size,
      arrayBuffer() { assert.fail('不得整份读入'); },
      slice(a,b) { sizes.push(Math.min(b, source.size)-a); return source.slice(a,b); }
    };
    assert.equal(await sha256Hex(file), createHash('sha256').update(x).digest('hex'));
    assert.ok(sizes.length > 1 && sizes.every(n=>n<=HASH_CHUNK_BYTES));
  }
});
