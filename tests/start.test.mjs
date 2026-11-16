import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, BUILD } from '../src/start.js';

class Channel {
  constructor() {
    this.port1 = { close() {} };
    this.port2 = { close() {}, reply: data => this.port1.onmessage({ data }) };
  }
}
function setup(controller = BUILD) {
  const calls = [];
  const nav = { serviceWorker: { controller: controller === null ? null : { postMessage: (message, [port]) => { calls.push('version'); port.reply(controller); } },
    register: async () => { calls.push('register'); return {}; }, ready: Promise.resolve({}) } };
  return { calls, nav, loc: { protocol: 'https:', reload: () => calls.push('reload') }, win: {}, Channel, timeout: 50, load: async () => calls.push('app') };
}
test('首次安装：等待完整版本安装后重开，尚未受控制的页面不加载 App', async () => {
  const o = setup(null); await start(o);
  assert.deepEqual(o.calls, ['register', 'reload']);
});
test('已安装：核对当前版本后立即加载；离线检查更新失败不影响启动', async () => {
  const o = setup(); o.nav.serviceWorker.register = async () => { throw new Error('offline'); };
  await start(o);
  assert.deepEqual(o.calls, ['version', 'app']);
  assert.equal(o.win.__babbleBootError, false);
});
test('旧 worker 版本不符：不加载新 App、不强制重载正在使用的页面', async () => {
  const o = setup('babble-v0');
  await assert.rejects(start(o), /update-pending/);
  assert.deepEqual(o.calls, ['version']);
});
test('旧 worker 不支持版本查询：超时后提示完成更新，不能混用程序文件', async () => {
  const o = setup(); o.timeout = 10; o.nav.serviceWorker.controller.postMessage = () => {};
  await assert.rejects(start(o), /update-pending/);
  assert.ok(!o.calls.includes('app'));
});
test('安装或 App 加载失败时明确报错；开发用 http 仍直接打开', async () => {
  const first = setup(null); first.nav.serviceWorker.register = async () => { throw new Error('offline'); };
  await assert.rejects(start(first), /offline/); assert.ok(!first.calls.includes('app'));
  const dev = setup(); dev.loc.protocol = 'http:'; await start(dev);
  assert.deepEqual(dev.calls, ['app']);
  const broken = setup(); broken.load = async () => { throw new Error('bad-module'); };
  await assert.rejects(start(broken), /bad-module/);
});
