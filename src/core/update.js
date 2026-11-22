// 新版本：有没有下载好、等着下次打开（「设置 → 关于」里说一声）。
// 已经装好的 App 里 navigator.serviceWorker.register() 不检查更新（start.js 每次启动都注册，注册没变就直接返回），
// 只有冷启动（导航）时浏览器才去看；主屏幕上的 App 常常几天都只是切回来，不是重新打开。
// 所以启动后、切回前台时（最多半小时一次）自己 update()：新版在后台下载、按 release.json 校验好（sw.js），
// sw.js 不 skipWaiting：装好以后停在 waiting，等这台设备上所有牙牙呓语的窗口都关掉、再打开才启用。
// 判断「下载好了」就看 registration.waiting：第一次安装时还没有 controller（start.js 装好后重新载入，那时也没有 waiting），
// 关掉再打开以后新版已经启用、waiting 也空了，所以不会每次打开都说。
export const UPDATE_EVERY = 30 * 60 * 1000;

/**
 * @param o.sw       navigator.serviceWorker（没有 / 开发时没注册 → 什么都不做）
 * @param o.now      () => 毫秒（测试用）
 * @param o.onReady  第一次发现新版本下载好了时调一次
 * @returns { check()：到时间了就去看一次（→ Promise<boolean> 现在是不是下载好了），ready() }
 */
export function createUpdateCheck({ sw = globalThis.navigator?.serviceWorker, now = () => Date.now(), onReady = () => {} } = {}) {
  let ready = false, last = null, watched = null;
  const mark = (reg) => { if (reg.waiting && !ready) { ready = true; try { onReady(); } catch (e) { console.error(e); } } };
  // update() 在新的 worker 开始安装时就返回了，装好（校验完所有文件）要等 statechange 到 installed
  const follow = (reg, w) => { if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') mark(reg); }); };
  function watch(reg) {
    if (watched !== reg) {
      watched = reg;
      reg.addEventListener?.('updatefound', () => follow(reg, reg.installing));
      // 冷启动时浏览器自己（导航）也会去看新版：App 载入时它可能已经在装了，updatefound 早就过去了，接着等它装好
      follow(reg, reg.installing);
    }
    mark(reg);           // 每次看都再对一下 waiting：万一上面哪一步错过了，下次切回来也补得上
  }
  function check() {
    // 没有 controller：本地预览（http 不注册）、第一次安装还没受控制
    if (ready || !sw || !sw.controller || typeof sw.getRegistration !== 'function' || (last != null && now() - last < UPDATE_EVERY)) return Promise.resolve(ready);
    last = now();
    return Promise.resolve().then(() => sw.getRegistration()).then(reg => {
      if (!reg) return;
      watch(reg);
      if (!ready) return reg.update();
    }).catch(() => { /* 离线、GitHub Pages 出错：下次再看 */ }).then(() => ready);
  }
  return { check, ready: () => ready };
}
