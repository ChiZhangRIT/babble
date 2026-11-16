// 仅供页面行为测试；不访问浏览器、真实文件或真实用户数据。
export class Element {
  constructor(tag) { this.tag = tag; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.dataset = {}; this.events = {}; this.hidden = false; this.isConnected = true; }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
  append(...children) { children.forEach(child => { if (!(child instanceof Element)) { const text = new Element('#text'); text.textContent = child; child = text; } this.appendChild(child); }); }
  replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  replaceWith(other) { if (this.parent) { const parent = this.parent; parent.children[parent.children.indexOf(this)] = other; other.parent = parent; this.parent = null; } }
  get classList() {
    const names = () => new Set((this.className || this.attrs.class || '').split(' ').filter(Boolean));
    const write = values => { this.className = [...values].join(' '); };
    return { contains: name => names().has(name), add: name => { const values = names(); values.add(name); write(values); },
      remove: name => { const values = names(); values.delete(name); write(values); }, toggle: (name, force) => { const values = names(); if (force ?? !values.has(name)) values.add(name); else values.delete(name); write(values); } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return (this._text || '') + this.children.map(child => child.textContent).join(''); }
  addEventListener(key, fn) { (this.events[key] ||= new Set()).add(fn); }
  removeEventListener(key, fn) { this.events[key]?.delete(fn); }
  async fire(key) { for (const fn of this.events[key] || []) await fn({ target: this, preventDefault() {} }); }
  focus() { globalThis.document.activeElement = this; }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  querySelectorAll(selector) {
    const match = selector.startsWith('#') ? el => el.id === selector.slice(1)
      : selector.startsWith('.') ? el => (el.className || el.attrs.class || '').split(' ').includes(selector.slice(1))
      : el => el.tag === selector;
    return all(this, match).filter(el => el !== this);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
export const all = (el, pred) => [...(pred(el) ? [el] : []), ...el.children.flatMap(child => all(child, pred))];
export const find = (el, pred) => all(el, pred)[0];
export function fakeStorage(seed = []) {
  const m = new Map(seed);
  return { m, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: key => m.get(key) ?? null,
    setItem: (key, value) => m.set(key, String(value)), removeItem: key => m.delete(key) };
}
export function installDom(extra = {}) {
  const doc = new Element('document'); doc.documentElement = new Element('html'); doc.body = new Element('body');
  doc.append(doc.documentElement); doc.documentElement.append(doc.body); doc.scrollingElement = doc.documentElement;
  Object.assign(doc, { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; } });
  const win = new Element('window'); win.scrollTo = () => {};
  const props = { Node: Element, document: doc, window: win, ...extra };
  const originals = Object.fromEntries(Object.keys(props).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(props)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return { doc, restore() { for (const [key, value] of Object.entries(originals)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } } };
}
