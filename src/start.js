// 无依赖启动器：安装完成后才加载 App；当前页面和控制它的 worker 必须属于同一版。
export const BUILD = 'babble-v30';

function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('boot-timeout')), ms); })]).finally(() => clearTimeout(timer));
}
export function workerBuild(controller, { Channel = globalThis.MessageChannel, timeout = 5000 } = {}) {
  const channel = new Channel();
  const answer = new Promise(resolve => { channel.port1.onmessage = e => resolve(e.data); controller.postMessage('babble-build', [channel.port2]); });
  return within(answer, timeout).finally(() => { channel.port1.close(); channel.port2.close(); });
}
export async function start({ nav = globalThis.navigator, loc = globalThis.location, win = globalThis.window,
  load = () => import('./app.js'), Channel = globalThis.MessageChannel, timeout = 15000 } = {}) {
  win.__babbleBootError = true;                 // 等待期间由这里负责超时提示，避免旧看门狗再盖一层
  win.__babbleBuild = BUILD;                    // App 里要知道是哪一版（床头模式的记录里写上）：App 不能 import 这个文件（会再启动一次）
  if (loc.protocol === 'https:') {
    if (!nav.serviceWorker) throw new Error('worker-unavailable');
    if (!nav.serviceWorker.controller) {
      await within(nav.serviceWorker.register('sw.js', { updateViaCache: 'none' }), timeout);
      await within(nav.serviceWorker.ready, timeout);
      loc.reload();                           // 首次打开还未受控制：重开到刚校验通过的完整版本，不先运行网络里的模块
      return;
    }
    let active;
    try { active = await workerBuild(nav.serviceWorker.controller, { Channel, timeout }); }
    catch (e) { throw new Error('update-pending'); }
    if (active !== BUILD) throw new Error('update-pending');
    // 已安装时从缓存立即启动；网络慢、离线或更新失败都不阻塞旧版使用。
    Promise.resolve().then(() => nav.serviceWorker.register('sw.js', { updateViaCache: 'none' })).catch(() => {});
  }
  await within(load(), timeout);
  win.__babbleBootError = false;
}
function showError(error) {
  let lang = '';
  try { lang = JSON.parse(localStorage.getItem('babble.local') || 'null')?.lang || ''; } catch (e) { /* 默认中文 */ }
  const strings = {
    'zh-Hans': ['请关闭所有「牙牙呓语」页面，再重新打开，让程序完成更新。', '牙牙呓语未能打开，请联网后重试。', '重新尝试'],
    'zh-Hant-TW': ['請關閉所有「牙牙囈語」頁面，再重新開啟，讓程式完成更新。', '牙牙囈語無法開啟，請連上網路後重試。', '重試'],
    en: ['Close all Babble windows, then open Babble again to finish the update.', 'Babble could not start. Connect to the internet and try again.', 'Try again'],
  }[lang] || ['请关闭所有「牙牙呓语」页面，再重新打开，让程序完成更新。', '牙牙呓语未能打开，请联网后重试。', '重新尝试'];
  const box = document.createElement('section'); box.className = 'boot-error'; box.setAttribute('role', 'alert');
  const text = document.createElement('p'); text.textContent = strings[error.message === 'update-pending' ? 0 : 1];
  const button = document.createElement('button'); button.className = 'btn'; button.type = 'button'; button.textContent = strings[2]; button.onclick = () => location.reload();
  box.append(text, button); document.body.append(box);
}
if (typeof window !== 'undefined') start().catch(showError);
