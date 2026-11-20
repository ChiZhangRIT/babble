// node scripts/prepare-release.mjs；--check 仅检查，不写文件。只计算仓库内程序文件，不访问用户数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file));
const hash = file => createHash('sha256').update(read(file)).digest('hex');
const check = process.argv.includes('--check');
let source = read('sw.js').toString(), cache = source.match(/const CACHE = '(babble-v\d+)'/)[1];
let vendorCache = source.match(/const VENDOR_CACHE = '([^']+)'/)[1];
const files = [...source.match(/const CORE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
// vendor/ 里按需下载、sw.js 按这张表核对的文件：transformers.js + onnxruntime（转文字、说话识别共用）、Silero VAD 模型（床头模式）。没有这个文件夹就跳过
const vendorFiles = (dir, keep) => (fs.existsSync(path.join(root, 'vendor', dir)) ? fs.readdirSync(path.join(root, 'vendor', dir)).filter(file => keep.test(file)).sort().map(file => `vendor/${dir}/${file}`) : []);
const manifest = () => ({ app: 'babble', v: 1, cache, vendorCache, worker: hash('sw.js'),
  core: Object.fromEntries(files.map(file => [file, hash(file === './' ? 'index.html' : file)])),
  vendor: Object.fromEntries([...vendorFiles('transformers', /\.(js|mjs|wasm)$/), ...vendorFiles('silero-vad', /\.onnx$/)].map(file => ['./' + file, hash(file)])),
});
const previous = fs.existsSync(path.join(root, 'release.json')) ? JSON.parse(read('release.json')) : null;
if (!check) {
  // 已有的第三方文件改了或去掉了才给 vendor 缓存改名（旧的会被清掉、要重新下载）；只是加了文件不改名：缓存里有的照样能用，新的用到时再下载
  const vendor = manifest().vendor;
  if (previous && previous.vendorCache === vendorCache && Object.entries(previous.vendor || {}).some(([file, sha]) => vendor[file] !== sha)) {
    vendorCache = 'babble-vendor-' + createHash('sha256').update(JSON.stringify(vendor)).digest('hex').slice(0, 12);
    source = source.replace(/const VENDOR_CACHE = '[^']+';/, `const VENDOR_CACHE = '${vendorCache}';`);
    fs.writeFileSync(path.join(root, 'sw.js'), source);
  }
  let start = read('src/start.js').toString().replace(/export const BUILD = 'babble-v\d+';/, `export const BUILD = '${cache}';`);
  fs.writeFileSync(path.join(root, 'src/start.js'), start);
  if (previous?.cache === cache && JSON.stringify(previous) !== JSON.stringify(manifest())) {
    cache = 'babble-v' + (Number(cache.slice('babble-v'.length)) + 1);
    source = source.replace(/const CACHE = 'babble-v\d+';/, `const CACHE = '${cache}';`);
    fs.writeFileSync(path.join(root, 'sw.js'), source);
    start = start.replace(/export const BUILD = 'babble-v\d+';/, `export const BUILD = '${cache}';`);
    fs.writeFileSync(path.join(root, 'src/start.js'), start);
  }
}
const release = manifest();
if (check) {
  if (JSON.stringify(previous) !== JSON.stringify(release) || !read('src/start.js').toString().includes(`export const BUILD = '${cache}';`)) {
    console.error('发布清单已过期，请运行 node scripts/prepare-release.mjs'); process.exitCode = 1;
  } else console.log('发布清单与所有程序文件一致。');
} else {
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  console.log(`已准备 ${cache}，${files.length} 个程序文件。`);
}
