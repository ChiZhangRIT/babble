// 对话文本：一行开头是说话人的表情（👰🏻‍♀️ / 🥷🏻，或设置里的旧表情）就是这个人说的，其余是旁白，空行是分段。
// 原话一个字都不改（引号不配对也不「修」）；这里只是把它拆成块给界面画气泡。

export const DEFAULT_SPEAKERS = { nn: { emoji: '👰🏻‍♀️', aliases: [] }, me: { emoji: '🥷🏻', aliases: [] } };
const WHO = ['nn', 'me'];

// 宽松匹配表情：FE0F/FE0E（变体选择符）、肤色 U+1F3FB–1F3FF、零宽连接符 200D 都可有可无，
// 所以 👰‍♀️ / 👰🏻‍♀️ / 👰🏻‍♀ 是同一个人
const SOFT = cp => cp === 0xFE0F || cp === 0xFE0E || (cp >= 0x1F3FB && cp <= 0x1F3FF);
const ZWJ = 0x200D;
const cpsOf = s => Array.from(String(s || ''), c => c.codePointAt(0));
const skeleton = emoji => cpsOf(emoji).filter(cp => !SOFT(cp) && cp !== ZWJ);

/** 行首是不是这个表情：是 → 表情后面的位置（UTF-16 下标），不是 → -1 */
function matchLead(line, skel) {
  let i = 0;
  const at = () => line.codePointAt(i), step = () => { i += at() > 0xFFFF ? 2 : 1; };
  for (let j = 0; j < skel.length; j++) {
    if (j > 0) while (i < line.length && (SOFT(at()) || at() === ZWJ)) step();
    if (i >= line.length || at() !== skel[j]) return -1;
    step();
  }
  while (i < line.length && SOFT(at())) step();
  // 后面还连着 ZWJ → 是另一个更长的表情（👰 不能吃掉 👰‍♂️）
  return i < line.length && at() === ZWJ ? -1 : i;
}

// 说话人的表情（含旧表情）按「骨架」长度从长到短试，长的优先；同样长时 NN 在前
function matchers(speakers) {
  const sp = speakers || DEFAULT_SPEAKERS;
  const list = [];
  for (const who of WHO) {
    const s = sp[who] || {};
    for (const e of [s.emoji, ...(Array.isArray(s.aliases) ? s.aliases : [])]) {
      const skel = typeof e === 'string' ? skeleton(e.trim()) : [];
      if (skel.length) list.push({ who, skel });
    }
  }
  return list.sort((a, b) => b.skel.length - a.skel.length);
}

/** 这一行是谁说的：{ who, rest }（rest = 去掉表情后的部分），没有说话人 → null */
export function speakerOf(line, speakers, ms = matchers(speakers)) {
  const s = String(line || '').trimStart();
  for (const m of ms) {
    const i = matchLead(s, m.skel);
    if (i >= 0) return { who: m.who, rest: s.slice(i) };
  }
  return null;
}

// 只有表情、标点、空白（？？？ ❔ 🤯 😂😂）→ 画成大表情，不画气泡
const WORDY = /[^\p{P}\p{S}\p{Z}\s\p{Cf}\p{M}]/u;
// 只有一对引号（工具栏插进来还没写字的「👰🏻‍♀️ “”」）不算反应：照原样画成小气泡，列表预览、标题后备跳过它
const QUOTES_ONLY = /^[\s“”‘’「」『』"'＂＇﹁﹂﹃﹄]+$/u;
export const isEmptyQuote = s => !!s && QUOTES_ONLY.test(s);
export const isReactionOnly = s => !!s && !WORDY.test(s) && !isEmptyQuote(s);

/**
 * 把对话拆成块（给 entry 页画聊天气泡、给列表卡片取预览）。
 * - 行首是说话人的表情 → { type:'line', who, content, reactionOnly }，表情后面的一个空格 / 冒号去掉，其余原样；只有引号的加 emptyQuote: true
 * - 表情后面什么都没有（或只有「：」）→ content '' 且 audioCue: true（笔记里这里跟着一段录音）
 * - 其他非空行 → { type:'narration', content }；空行 → { type:'gap' }（连续空行算一个，首尾不要）
 * - U+FFFC（备忘录附件占位符）去掉；只剩占位符的行整行不要
 * @param {string} text
 * @param {{nn: {emoji, aliases}, me: {emoji, aliases}}} [speakers]  不传用默认的 👰🏻‍♀️ / 🥷🏻
 * @returns {Array<{type: 'line', who: 'nn'|'me', content: string, reactionOnly: boolean, audioCue?: boolean, emptyQuote?: boolean} | {type: 'narration', content: string} | {type: 'gap'}>}
 */
export function parseDialogue(text, speakers) {
  const out = [], ms = matchers(speakers);
  for (const raw of String(text ?? '').split(/\r\n|[\n\r\u2028\u2029]/)) {
    const hadSlot = raw.includes('\uFFFC');
    const line = raw.replace(/\uFFFC/g, '').trim();
    if (!line) {
      if (!hadSlot && out.length && out[out.length - 1].type !== 'gap') out.push({ type: 'gap' });
      continue;
    }
    const sp = speakerOf(line, speakers, ms);
    if (!sp) { out.push({ type: 'narration', content: line }); continue; }
    const content = sp.rest.replace(/^\s*[:：]?\s*/, '');
    out.push(content
      ? { type: 'line', who: sp.who, content, reactionOnly: isReactionOnly(content), ...(isEmptyQuote(content) ? { emptyQuote: true } : {}) }
      : { type: 'line', who: sp.who, content: '', reactionOnly: false, audioCue: true });
  }
  while (out.length && out[out.length - 1].type === 'gap') out.pop();
  return out;
}

/** 列表卡片的预览行（跳过空行、只有表情的反应、录音提示） */
export function previewLines(text, speakers, n = 2) {
  return parseDialogue(text, speakers).filter(b => b.type !== 'gap' && !b.reactionOnly && !b.emptyQuote && b.content).slice(0, n);
}

/** 第一句 NN 的话（标题的后备）；没有 → '' */
export function firstNNLine(text, speakers) {
  const b = parseDialogue(text, speakers).find(x => x.type === 'line' && x.who === 'nn' && x.content && !x.reactionOnly && !x.emptyQuote);
  return b ? b.content : '';
}

/**
 * 编辑器工具栏：插入一行「表情 “”」，光标放在引号中间 → { text, cursor }。
 * 光标在一行中间时插到这一行的末尾（不会把正在写的引号拆开）；当前行是空行就直接写在这一行，不另起一行。
 * @param {string} [body]  表情后面的内容，默认 '“”'（光标在引号中间）；别的内容（如反应表情）光标放在最后
 */
export function insertSpeakerLine(text, cursor, who, speakers, body = '“”') {
  const s = String(text ?? '');
  const at = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : s.length, s.length));
  const sp = (speakers || DEFAULT_SPEAKERS)[who] || DEFAULT_SPEAKERS[who] || {};
  const lineStart = s.lastIndexOf('\n', at - 1) + 1;
  let lineEnd = s.indexOf('\n', at);
  if (lineEnd < 0) lineEnd = s.length;
  const blank = !s.slice(lineStart, lineEnd).trim();
  const before = blank ? s.slice(0, lineStart) : s.slice(0, lineEnd);
  const after = s.slice(lineEnd);
  const ins = (blank ? '' : '\n') + (sp.emoji || '') + ' ' + body;
  const back = body === '“”' ? 1 : 0;
  return { text: before + ins + after, cursor: before.length + ins.length - back };
}

// ---------- 引号里是说的话，引号外是动作 / 环境（只拆开给界面换字体，原话不动） ----------
// 开引号 “ 「 『 " ＂ ‘；关引号 ” 」 』 " ＂ ’。双引号一家（“ " ＂ / ” " ＂）可以混着配（“好的" 也算一对）。
const OPEN = { '“': '”', '「': '」', '『': '』', '"': '"', '＂': '＂', '‘': '’' };
const CLOSE = new Set(['”', '」', '』', '"', '＂', '’']);
const DOUBLE_OPEN = new Set(['“', '"', '＂']), DOUBLE_CLOSE = new Set(['”', '"', '＂']);
const closes = (open, c) => OPEN[open] === c || (DOUBLE_OPEN.has(open) && DOUBLE_CLOSE.has(c));
const LATIN = /[A-Za-zÀ-ɏ]/;
const SPACE = /\s/;

/**
 * 一行原话拆成「说的话」和「动作 / 描述」：[{ kind: 'speech' | 'desc', text }]，所有 text 连起来就是原文（一个字不差），引号留在说的话里。
 * 用户的实际写法不总是规整的：
 * - 只有开引号 → 说的话一直到这一行末尾
 * - 只有关引号（他说了”）→ 从上一个分界（行首 / 上一句话结束的地方，跳过空格）到这个关引号都算说的话
 * - 前面什么都没开着、在开头或空格后面、后面还有字的 ” → 当开引号用（”下雨了”）
 * - 「」里套『』、引号里有表情都没问题；英文的撇号（don’t）不算引号
 * - 整行没有引号 → 一段 desc；空字符串 → []
 * @param {string} content
 * @returns {Array<{kind: 'speech'|'desc', text: string}>}
 */
export function segments(content) {
  const s = String(content ?? '');
  const out = [];
  const push = (kind, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let stack = [], from = 0, start = 0;           // from：还没归类的文字从哪里开始；start：说的话从哪里开始
  // 这一行后面（i 之后、换行之前）还有没有字
  const textAfter = (i) => { for (let j = i + 1; j < s.length && s[j] !== '\n'; j++) if (!SPACE.test(s[j])) return true; return false; };
  const apostrophe = (i) => s[i] === '’' && i > 0 && LATIN.test(s[i - 1]) && LATIN.test(s[i + 1] || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n' || c === '\r') {                 // 换行：没关上的引号到这里为止
      if (stack.length) { push('speech', s.slice(start, i)); stack = []; from = i; }
      continue;
    }
    if (stack.length) {
      if (apostrophe(i)) continue;
      // 关上最近的、能配上的那一层（「他说『好」→ 」把两层都关上）；配不上的关引号当普通字
      let k = stack.length - 1;
      while (k >= 0 && !closes(stack[k], c)) k--;
      if (k >= 0 && (k === stack.length - 1 || OPEN[stack[k]] === c)) {
        stack.length = k;
        if (!stack.length) { push('speech', s.slice(start, i + 1)); from = i + 1; }
      } else if (OPEN[c] && !CLOSE.has(c)) stack.push(c);
      continue;
    }
    // 外面（动作 / 描述里）
    const before = i === 0 || SPACE.test(s[i - 1]);
    const asOpen = (OPEN[c] && (!CLOSE.has(c) || textAfter(i))) || (c === '”' && before && textAfter(i));
    if (asOpen) {
      push('desc', s.slice(from, i));
      stack = [c === '”' ? '“' : c]; start = i;
    } else if (CLOSE.has(c) && !apostrophe(i)) {
      let b = from;                                  // 只有关引号：从上一个分界（跳过空格）到这里都是说的话
      while (b < i && SPACE.test(s[b])) b++;
      push('desc', s.slice(from, b));
      push('speech', s.slice(b, i + 1));
      from = i + 1;
    }
  }
  if (stack.length) push('speech', s.slice(start));
  else push('desc', s.slice(from));
  return out;
}

/** 整行都是动作 / 描述（没有说的话）：画成浅浅的「动作」气泡 */
export const isDescOnly = (content) => { const g = segments(content); return g.length > 0 && g.every(x => x.kind === 'desc'); };
