// 界面小工具：建元素（文字一律用 textContent，不拼 HTML）、图标、提示条、面板、确认框、复制、下载、长按。
import { t } from '../i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card#main', { onclick, title }, '文字', 子元素, [数组也行], null 跳过)
 * 标签名后可跟 .class 和 #id；attrs 里 on* 是事件，class / style（对象）/ dataset 特殊处理，
 * value / checked / selected / disabled / hidden 设成属性值，其余写成 HTML 属性（true → 空字符串，false/null 跳过）。
 * svg：标签名是 svg 或 attrs.svg 为 true 时用 SVG 命名空间（svg 的子元素也要带 svg: true）。
 */
export function h(tag, attrs, ...kids) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
  const m = /^([a-zA-Z][\w-]*)?(.*)$/.exec(tag);
  const name = m[1] || 'div';
  const el = name === 'svg' || attrs.svg ? document.createElementNS(SVG_NS, name) : document.createElement(name);
  const cls = [];
  for (const [, kind, val] of m[2].matchAll(/([.#])([^.#]+)/g)) { if (kind === '.') cls.push(val); else el.id = val; }
  if (cls.length) el.setAttribute('class', cls.join(' '));
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false || k === 'svg') continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + v).trim());
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 图标（和设计稿同一套，24×24 线条图标；play/pause 是实心；snout 是彩色猪鼻子） ----------
const P = d => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const ICONS = {
  play: { fill: true, kids: [P('M7 4.8c0-1 1.1-1.6 1.9-1.1l11.2 7.2c.8.5.8 1.7 0 2.2L8.9 20.3c-.8.5-1.9-.1-1.9-1.1z')] },
  pause: { fill: true, kids: [['rect', { x: 6, y: 4.5, width: 4, height: 15, rx: 1.2 }], ['rect', { x: 14, y: 4.5, width: 4, height: 15, rx: 1.2 }]] },
  star: { kids: [P('M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.6l-5.2 2.8 1-5.9L3.5 9.4l5.9-.8z')] },
  search: { kids: [C(10.5, 10.5, 6.5), P('M15.5 15.5L20 20')] },
  chev: { kids: [P('M9 5.5l6.5 6.5L9 18.5')] },
  chevDown: { kids: [P('M6 9.5l6 6 6-6')] },
  back: { kids: [P('M15 4.5L7.5 12l7.5 7.5')] },
  share: { kids: [P('M12 3.5v11M8 7.5l4-4 4 4M7 10.5H6a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 006 20.5h12a1.5 1.5 0 001.5-1.5v-7a1.5 1.5 0 00-1.5-1.5h-1')] },
  more: { kids: [C(5.5, 12, 1.2), C(12, 12, 1.2), C(18.5, 12, 1.2)] },
  import: { kids: [P('M12 3.5v10M8 9.5l4 4 4-4M4 14v3.5A2.5 2.5 0 006.5 20h11a2.5 2.5 0 002.5-2.5V14')] },
  bubble: { kids: [P('M5.5 4.5h13a2 2 0 012 2v8.5a2 2 0 01-2 2H11l-4.5 3.5v-3.5h-1a2 2 0 01-2-2V6.5a2 2 0 012-2z'), P('M8 9h8M8 12.5h5')] },
  gear: { kids: [C(12, 12, 3), P('M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z')] },
  clock: { kids: [C(12, 12, 8.5), P('M12 7.5V12l3 2')] },
  history: { kids: [P('M4.2 12a7.8 7.8 0 1 0 2.3-5.5L4.2 8.8'), P('M4.2 4.6v4.2h4.2'), P('M12 8v4.3l2.8 1.7')] },
  pencil: { kids: [P('M4.5 19.5l1-4.2L15.8 5a2 2 0 012.9 0l.3.3a2 2 0 010 2.9L8.7 18.5z')] },
  x: { kids: [P('M6.5 6.5l11 11M17.5 6.5l-11 11')] },
  check: { kids: [P('M5 12.5l4.5 4.5L19 7.5')] },
  plus: { kids: [P('M12 5v14M5 12h14')] },
  mic: { kids: [P('M12 3.5a3 3 0 00-3 3v5a3 3 0 006 0v-5a3 3 0 00-3-3z'), P('M6 11a6 6 0 0012 0M12 17v3.5')] },
  trash: { kids: [P('M4.5 7h15M9.5 7V5a1.5 1.5 0 011.5-1.5h2A1.5 1.5 0 0114.5 5v2M6.5 7l1 12a1.5 1.5 0 001.5 1.4h6a1.5 1.5 0 001.5-1.4l1-12')] },
  snout: { box: '0 0 32 24', color: true, kids: [
    ['ellipse', { cx: 16, cy: 12, rx: 15, ry: 11, fill: '#e98aa3' }], ['ellipse', { cx: 16, cy: 10.6, rx: 13.4, ry: 8.8, fill: '#ee96ad', opacity: '.55' }],
    ['ellipse', { cx: 11.4, cy: 12, rx: 2.6, ry: 4.1, fill: '#a9405a' }], ['ellipse', { cx: 20.6, cy: 12, rx: 2.6, ry: 4.1, fill: '#a9405a' }]] },
};
export const ICON_NAMES = Object.keys(ICONS);

/**
 * icon('play') → <svg class="ic ic-play">。label 给了就是有名字的图片（读屏会念），否则 aria-hidden。
 * 线条图标用 currentColor 描边，实心图标用 currentColor 填充；大小由 CSS（.ic 默认 22px）或 size 决定。
 */
export function icon(name, { cls = '', label = null, size = null } = {}) {
  const def = ICONS[name] || ICONS.more;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', def.box || '0 0 24 24');
  svg.setAttribute('class', ['ic', 'ic-' + name, def.fill ? 'ic-fill' : '', def.color ? 'ic-color' : '', cls].filter(Boolean).join(' '));
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of def.kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

// ---------- 提示条 ----------
let toastTimer = null;
/**
 * toast('已删除', { ms: 10000, action: { label: '撤销', run: fn } })
 * 兼容旧写法 { action: '撤销', onAction: fn }。返回 { close }
 * 提示条不挡按钮：显示期间跟着页面变化（换页、录音页换状态、转屏）重新找位置，见 placeToast
 */
export function toast(msg, { ms = 4000, action = null, onAction = null } = {}) {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(el); }
  const act = typeof action === 'string' ? { label: action, run: onAction } : action;
  const close = () => {
    el.classList.remove('on'); el.setAttribute('inert', '');
    unwatch();
    setTimeout(() => { if (!el.classList.contains('on')) el.replaceChildren(); }, 300);
  };
  el.replaceChildren(h('span.toast-msg', null, msg));
  if (act && act.label) el.appendChild(h('button', { type: 'button', onclick: () => { clearTimeout(toastTimer); close(); if (act.run) act.run(); } }, act.label));
  el.classList.add('on');
  el.removeAttribute('inert');
  placeToast(el);
  watch(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(close, ms);
  return { close: () => { clearTimeout(toastTimer); close(); } };
}

// 提示条要让开的按钮：手机底栏、底部按钮条（整理好了、确认导入）、顶栏、录音页的按钮（只记文字 / 返回、停止、长按丢弃、保存后的几个按钮）。
// 页面里别的固定按钮可以加 data-toast-avoid
const TOAST_AVOID = '#tabs, .bottom-bar, .navbar, .n-links, .n-acts, .n-stop, .n-discard, [data-toast-avoid]';
let safeProbe = null;
/** 顶部安全区（刘海 / 灵动岛）多高：env() 只能在 CSS 里用，放一个看不见的元素量一下 */
function safeTop() {
  if (!safeProbe || !safeProbe.isConnected) {
    safeProbe = h('div', { 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '0', width: '0', height: 'env(safe-area-inset-top, 0px)', visibility: 'hidden', pointerEvents: 'none' } });
    document.body.appendChild(safeProbe);
  }
  return safeProbe.offsetHeight || 0;
}
/**
 * 放提示条：先放在 CSS 定的底部位置；挡住了上面那些按钮就往上挪到按钮上方（一层层往上找）；
 * 下半屏都放不下（比如录音时整块都是停止键）就放到顶部安全区下面、顶上的按钮下方
 */
export function placeToast(el = $('#toast')) {
  if (!el) return;
  el.style.top = ''; el.style.bottom = '';
  el.classList.remove('at-top');
  if (!el.classList.contains('on')) return;
  const vh = window.innerHeight, gap = 8, th = el.offsetHeight, tw = el.offsetWidth;
  const left = (window.innerWidth - tw) / 2, right = left + tw;
  const rects = [...document.querySelectorAll(TOAST_AVOID)].filter(n => !el.contains(n)).map(n => n.getBoundingClientRect())
    .filter(r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.left < right && r.right > left);
  const hits = (top) => rects.filter(r => r.top < top + th && r.bottom > top);
  const minTop = safeTop() + gap;
  const base = vh - (parseFloat(getComputedStyle(el).bottom) || 24) - th;
  let top = base;
  for (let i = 0; i < 12 && top >= minTop; i++) {
    const hit = hits(top);
    if (!hit.length) break;
    top = Math.min(...hit.map(r => r.top)) - gap - th;
  }
  if (top >= minTop && top >= vh * 0.2) {
    if (top !== base) el.style.bottom = Math.round(vh - top - th) + 'px';
    return;
  }
  // 下面放不下：从顶上往下找
  top = minTop;
  for (let i = 0; i < 12; i++) {
    const hit = hits(top);
    if (!hit.length) break;
    top = Math.max(...hit.map(r => r.bottom)) + gap;
  }
  el.classList.add('at-top');
  el.style.bottom = 'auto';
  el.style.top = Math.round(Math.min(top, vh - th - gap)) + 'px';
}
// 显示期间：页面内容变了（换页、重画）、窗口大小变了、滚动了（吸底的按钮条位置会变）→ 下一帧重新放
let toastObs = null, toastRaf = 0;
const placeSoon = () => { if (!toastRaf) toastRaf = requestAnimationFrame(() => { toastRaf = 0; placeToast(); }); };
function watch(el) {
  if (toastObs) return;
  toastObs = new MutationObserver(muts => { if (muts.some(m => !el.contains(m.target))) placeSoon(); });
  toastObs.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', placeSoon);
  window.addEventListener('scroll', placeSoon, { passive: true, capture: true });
}
function unwatch() {
  if (!toastObs) return;
  toastObs.disconnect(); toastObs = null;
  window.removeEventListener('resize', placeSoon);
  window.removeEventListener('scroll', placeSoon, { capture: true });
}

// ---------- 面板（手机上从底部弹出，宽屏居中） ----------
/**
 * sheet(内容, { title, foot: [按钮…], wide, cls, onClose, beforeClose, closeLabel })
 * 内容可以是 Node，也可以是 (sheet) => Node。返回 { el, body, close, tryClose, setTitle }。
 * beforeClose() 返回 false 时不关（比如有没保存的修改）；点遮罩、按 Esc、点 ✕ 都走 tryClose。
 */
export function sheet(content, { title = '', foot = null, wide = false, cls = '', onClose = null, beforeClose = null, closeLabel = t('common.close') } = {}) {
  const dlg = h('dialog.sheet' + (wide ? '.wide' : ''), { class: cls || null, 'aria-label': title || null });
  const bodyEl = h('div.sheet-body');
  const close = () => { if (dlg.open) dlg.close(); };
  const tryClose = () => { if (!beforeClose || beforeClose() !== false) close(); };
  const titleEl = h('h2', null, title);
  dlg.append(h('div.sheet-head', null, titleEl, h('button.icon-btn', { type: 'button', 'aria-label': closeLabel, onclick: tryClose }, icon('x'))), bodyEl);
  const api = { el: dlg, body: bodyEl, close, tryClose, setTitle: (x) => { titleEl.textContent = x; } };
  const node = typeof content === 'function' ? content(api) : content;
  if (node) bodyEl.append(node);
  if (foot && foot.length) dlg.append(h('div.sheet-foot', null, foot));
  dlg.addEventListener('cancel', e => { e.preventDefault(); tryClose(); });
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  // 点遮罩关闭：按下和松开都在遮罩上才算（在输入框里拖选文字、松手落到遮罩上不算）
  let downOnBackdrop = false;
  dlg.addEventListener('pointerdown', e => { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', e => { if (e.target === dlg && downOnBackdrop) tryClose(); downOnBackdrop = false; });
  document.body.appendChild(dlg);
  dlg.showModal();
  return api;
}
/** house-ledger 的写法：openSheet({ title, body, foot, wide, onClose, beforeClose }) */
export const openSheet = (o = {}) => sheet(o.body, o);

/**
 * 确认框 → Promise<boolean>
 * confirmDialog('确定删除？') 或 confirmDialog({ title, message, confirmLabel, cancelLabel, danger })
 */
export function confirmDialog(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  return new Promise(resolve => {
    let answer = false;
    const s = sheet(o.message ? h('p.confirm-msg', null, o.message) : null, {
      title: o.title || '', cls: 'confirm',
      onClose: () => resolve(answer),
      foot: [
        h('button.btn', { type: 'button', onclick: () => s.close() }, o.cancelLabel || t('common.cancel')),
        h('button.btn' + (o.danger ? '.danger-fill' : '.primary'), { type: 'button', onclick: () => { answer = true; s.close(); } }, o.confirmLabel || t('common.confirm')),
      ],
    });
    s.el.querySelector('.sheet-foot .btn:last-child').focus();
  });
}

/** 复制文字（不行就退回到选中文本框） → Promise<boolean> */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 退回下面的办法 */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' }, readonly: true });
  ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

/** 下载一个文件：data 是 Blob 或字符串 */
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * 长按：按住 ms 毫秒触发 fn；按住期间元素带 .pressing（CSS 可以画进度）。返回解除函数。
 * 键盘：按住空格 / 回车同样计时。
 */
export function longPress(el, fn, ms = 1000) {
  let timer = null;
  const start = (e) => {
    if (e.type === 'pointerdown' && e.button !== 0) return;
    if (e.type === 'keydown' && (e.repeat || (e.key !== ' ' && e.key !== 'Enter'))) return;
    if (e.type === 'keydown') e.preventDefault();
    clearTimeout(timer); el.classList.add('pressing');
    timer = setTimeout(() => { timer = null; el.classList.remove('pressing'); fn(); }, ms);
  };
  const stop = () => { clearTimeout(timer); timer = null; el.classList.remove('pressing'); };
  const noMenu = e => e.preventDefault();
  const evs = [['pointerdown', start], ['keydown', start], ['pointerup', stop], ['pointerleave', stop], ['pointercancel', stop], ['keyup', stop], ['blur', stop], ['contextmenu', noMenu]];
  for (const [k, f] of evs) el.addEventListener(k, f);
  return () => { stop(); for (const [k, f] of evs) el.removeEventListener(k, f); };
}
