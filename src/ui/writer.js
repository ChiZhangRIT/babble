// 写原话的小部件，编辑页（#/new、#/edit/<id>）和录音页（#/rec 边录边写）共用：
// 工具栏（说话人按钮 + 一排反应表情）、往文本框里插一行（光标放进引号中间）、只替换变了的那一段（⌘Z 能撤销）。
import { h } from './dom.js';
import { insertSpeakerLine } from '../core/dialogue.js';
import { t } from '../i18n.js';

export const REACTIONS = ['🤯', '🫨', '😲', '🤭', '😂', '🥲'];

/**
 * 把文本框的内容换成 next、光标放到 cursor。只替换真正变了的那一段，并尽量用 insertText（这样 ⌘Z 能撤销）
 */
export function replaceText(ta, next, cursor) {
  const old = ta.value;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let q = 0;
  while (q < old.length - p && q < next.length - p && old[old.length - 1 - q] === next[next.length - 1 - q]) q++;
  const lowSur = (s, i) => { const c = s.charCodeAt(i); return c >= 0xDC00 && c <= 0xDFFF; };
  while (p > 0 && lowSur(old, p)) p--;                                  // 不要从一个表情中间切开
  while (q > 0 && lowSur(old, old.length - q)) q--;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(p, old.length - q);
  let ok = false;
  try { ok = document.execCommand('insertText', false, next.slice(p, next.length - q)); } catch (e) { ok = false; }
  if (!ok || ta.value !== next) ta.value = next;
  ta.setSelectionRange(cursor, cursor);
}

/** 新写一条时文本框里预填的「👰🏻‍♀️ “”」→ { text, cursor }（光标在引号中间） */
export const startTemplate = (speakers) => insertSpeakerLine('', 0, 'nn', speakers);

/**
 * 在文本框里插一行说话人 / 反应。atEnd：还没点进过文本框（光标位置不算数）时插到最后
 */
export function insertLine(ta, who, body, speakers, { atEnd = false } = {}) {
  const cur = atEnd ? ta.value.length : ta.selectionEnd;
  const r = insertSpeakerLine(ta.value, cur, who, speakers, body);
  replaceText(ta, r.text, r.cursor);
}

/** 点按钮不把焦点从文本框抢走（手机上键盘不收起） */
export const keepFocus = (e) => e.preventDefault();

/** 自己滚动的文本框（录音页）：程序插进去的字在最后时，滚到最下面（打字时浏览器自己会跟着光标） */
export function revealCaret(ta) {
  if (ta.scrollHeight > ta.clientHeight && ta.selectionEnd >= ta.value.length - 2) ta.scrollTop = ta.scrollHeight;
}

/**
 * 原话框上面的工具栏：[👰🏻‍♀️ NN] [🥷🏻 我] …… [extra]，下一行反应表情。
 * speakers：settings.speakers；onInsert(who, body)：body 不给就是「“”」；extra：放在说话人那一行最后的元素（编辑页的「录一段」）
 */
export function writeTools({ speakers, onInsert, extra = null }) {
  const sp = speakers;
  const btn = (cls, label, who, body, aria) => h('button.' + cls, { type: 'button', onmousedown: keepFocus, 'aria-label': aria || null, title: aria || null,
    onclick: () => onInsert(who, body) }, label);
  return h('div.ed-tools', { role: 'toolbar', 'aria-label': t('edit.insert') },
    h('div.ed-spk', null,
      btn('spk-btn.nn', [h('span.spk-emoji', null, sp.nn.emoji), h('span', null, sp.nn.name || 'NN')], 'nn'),
      btn('spk-btn.me', [h('span.spk-emoji', null, sp.me.emoji), h('span', null, sp.me.name || t('edit.me'))], 'me'),
      extra),
    h('div.ed-react', { role: 'group', 'aria-label': t('edit.reactions') },
      REACTIONS.map(r => btn('react-btn', r, 'me', r, sp.me.emoji + ' ' + r))));
}
