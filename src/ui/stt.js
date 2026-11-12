// 语音转文字（草稿）的界面：详情页每段录音下面的「转成文字（草稿）」和进度、草稿区（填进原话 / 修改 / 删除草稿）、
// 设置页「语音转文字」（模型、下载 / 删除、用显卡加速）。识别本身在 core/transcribe.js（worker 里跑 Whisper）。
// 一次只跑一个任务；离开页面也接着跑，做完写进那一条的草稿（原话不碰）。
// 这些部件自己跟着任务进度更新（不用整页重画）；页面重画后旧部件离开了文档，下次有动静时自己退订。
import { h, icon } from './dom.js';
import { t, has } from '../i18n.js';
import * as stt from '../core/transcribe.js';
import { fmtBytes } from '../core/util.js';
import { fmtInstant } from '../core/dates.js';

// ---------- 本机设置（babble.local.stt，不同步：iPhone 用标准、Mac 可以用更准，各管各的） ----------
/** → { model, useGpu, mobile } */
export function prefs(ctx) {
  const p = (ctx.local && ctx.local.stt) || {};
  const mobile = stt.isMobileDevice();
  return { model: stt.modelAllowed(p.model, { mobile }) ? p.model : stt.DEFAULT_MODEL, useGpu: p.useGpu !== false, mobile };
}
const setPrefs = (ctx, patch) => ctx.setLocal({ stt: { ...((ctx.local && ctx.local.stt) || {}), ...patch } });
// 任务进行中留个记号：App 中途被系统关掉（多半是内存不够）时，下次打开能说一声。记号带着这次打开的编号，自己的不算
const SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const mark = (ctx, run) => ctx.setLocal({ sttRun: run ? { ...run, session: SESSION } : null });

// ---------- 部件跟着任务、缓存变化重画 ----------
const watchers = new Set();
const notify = () => { for (const fn of [...watchers]) fn(); };
stt.onJob(notify);
function live(el, paint) {
  let seen = false;
  const fn = () => {
    if (el.isConnected) { seen = true; paint(); } else if (seen) watchers.delete(fn);
  };
  watchers.add(fn);
  paint();
  return el;
}

const cacheMemo = new Map();          // 模型 → 缓存情况（undefined = 正在查，null = 看不到）
function cacheOf(model) {
  if (!cacheMemo.has(model)) { cacheMemo.set(model, undefined); refreshCache(model); }
  return cacheMemo.get(model);
}
async function refreshCache(model) { cacheMemo.set(model, await stt.modelCacheInfo(model)); notify(); }
let gpuInfo = null;
function gpu() {
  if (!gpuInfo) { gpuInfo = { pending: true, gpu: false, f16: false }; stt.probeGpu().then(g => { gpuInfo = g; notify(); }); }
  return gpuInfo;
}
const engineFor = (ctx, model) => { const p = prefs(ctx); return stt.pickEngine(model, { mobile: p.mobile, ...gpu(), useGpu: p.useGpu }); };
const sizeOf = (ctx, model) => stt.MODELS[model][engineFor(ctx, model)].bytes;
const about = (n) => Math.round(n / 1048576) + ' MB';      // 「约 76 MB」不要小数
/** replaceChildren，但跳过 null（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.filter(k => k != null && k !== false));
const modelName = (m) => (stt.MODELS[m] ? t('stt.model.' + m) : String(m || ''));

function persist() { try { const p = navigator.storage && navigator.storage.persist && navigator.storage.persist(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 不支持 */ } }
async function wakeLock() {
  try { return navigator.wakeLock && document.visibilityState === 'visible' ? await navigator.wakeLock.request('screen') : null; } catch (e) { return null; }
}
const unlock = (l) => { try { if (l) l.release(); } catch (e) { /* 已经放了 */ } };

/** 上次没做完的任务（这次启动里没有在跑的任务，却留着记号）→ 记号 | null */
function leftover(ctx) {
  const r = ctx.local && ctx.local.sttRun, j = stt.job();
  if (!r || r.session === SESSION || (j && stt.isRunning(j))) return null;
  if (r.engine === 'webgpu' && prefs(ctx).useGpu) setPrefs(ctx, { useGpu: false });     // 显卡跑到一半被关掉：以后先用处理器
  return r;
}

// ---------- 识别一段录音 ----------
const keyOf = (id, sha) => id + '|' + sha;
const justDone = new Set();           // 刚写进草稿的条目：草稿区展开、滚过去
const edits = new Map();              // 条目 id → { text, a, b, focus }：正在改的草稿（页面因为同步之类重画时接着改，光标也回到原处）

async function runClip(ctx, id, clip) {
  const p = prefs(ctx), key = keyOf(id, clip.sha256);
  persist();                          // 在点按里申请持久保存，iOS 不会把模型清掉
  mark(ctx, { key, model: p.model, engine: null, at: Date.now() });
  const lock = await wakeLock();      // 长录音要识别一会儿，屏幕别锁
  let r;
  try {
    r = await stt.transcribe({ key, model: p.model, useGpu: p.useGpu, simplify: ctx.lang() !== 'zh-Hant-TW',
      blob: () => ctx.clipBlob(clip.sha256),
      onEngine: (engine) => mark(ctx, { key, model: p.model, engine, at: Date.now() }),
      onGpuFail: () => setPrefs(ctx, { useGpu: false }) });
  } catch (e) {
    return;                           // 出错显示在部件里；取消就回到按钮
  } finally { mark(ctx, null); unlock(lock); refreshCache(p.model); }
  if (!r.text) { ctx.toast(t('stt.nothing'), { ms: 7000 }); return; }
  const cur = ctx.entry(id);
  if (!cur || cur.deleted) { ctx.toast(t('stt.gone'), { ms: 7000 }); return; }
  const draft = stt.mergeDraft(cur.draft, { sha256: clip.sha256, text: r.text, source: stt.sourceOf(r.model, ctx.device), at: Date.now() }, cur.audio.map(a => a.sha256));
  const ed = edits.get(id);            // 正在改这条的草稿：新结果也接到正在改的文字后面，保存时不会把它盖掉
  if (ed) ed.text = ed.text.replace(/\s+$/, '') + (ed.text.trim() ? '\n\n' : '') + r.text;
  justDone.add(id);
  ctx.update(id, { draft }, { undoLabel: t('stt.saved') });
}

/** 进度：[主文字, 小字, 百分比（null = 不确定）] */
function progressOf(j) {
  if (j.phase === 'download') return [t('stt.download', { pct: Math.floor(j.pct || 0) }), j.total ? t('stt.downloadSize', { loaded: fmtBytes(j.loaded), total: fmtBytes(j.total) }) : t('stt.downloadOnce'), j.pct || 0];
  if (j.phase === 'load') return [t('stt.load'), '', null];
  if (j.phase === 'run') return [j.segs > 1 ? t('stt.runN', { i: Math.min(j.seg + 1, j.segs), n: j.segs }) : t('stt.run'), '', j.segs > 1 ? j.pct : null];
  return [t('stt.prepare'), '', null];
}
function bar() {
  const fill = h('i');
  const el = h('div.stt-bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  el.set = (pct) => {
    el.classList.toggle('busy', pct == null);
    if (pct == null) { el.removeAttribute('aria-valuenow'); fill.style.width = ''; }
    else { el.setAttribute('aria-valuenow', String(Math.round(pct))); fill.style.width = Math.max(2, Math.min(100, pct)) + '%'; }
  };
  return el;
}
const errText = (err) => t('stt.err.' + (err && has('stt.err.' + err.code) ? err.code : 'failed'), { msg: (err && err.message) || '' });

/**
 * 详情页：一段录音下面的「转成文字（草稿）」、进度、出错提示
 * @param {object} ctx  @param {object} entry  @param {object} clip  entry.audio 里的一项
 */
export function clipTranscriber(ctx, entry, clip) {
  const id = entry.id, key = keyOf(id, clip.sha256);
  const box = h('div.stt');
  let shape = '', refs = null;

  function paintRun(j) {
    if (shape !== 'run') {
      shape = 'run';
      refs = { msg: h('span.stt-msg'), sub: h('span.stt-sub'), bar: bar(), text: h('p.stt-partial') };
      fill(box, h('div.stt-run', null,
        h('div.stt-top', null, h('span.stt-what', null, refs.msg, refs.sub),
          h('button.btn.small.ghost', { type: 'button', onclick: () => stt.cancel() }, t('common.cancel'))),
        refs.bar, refs.text));
    }
    const [msg, sub, pct] = progressOf(j);
    refs.msg.textContent = msg;
    refs.sub.textContent = sub;
    refs.bar.set(pct);
    // 边识别边出字：最后三行
    const words = [...j.lines, j.partial].filter(Boolean).slice(-3).join('\n');
    refs.text.textContent = words;
    refs.text.hidden = !words;
  }
  function paintIdle(j) {
    const p = prefs(ctx), cur = ctx.entry(id) || entry;
    const other = j && stt.isRunning(j) && j.key !== key;
    const done = !!(cur.draft && Array.isArray(cur.draft.parts) && cur.draft.parts.some(x => x && x.sha256 === clip.sha256));
    const info = cacheOf(p.model);
    const need = info && !info.complete[engineFor(ctx, p.model)];
    const lo = leftover(ctx);
    const sig = ['idle', other ? j.kind : '', done, need, lo && lo.key === key, p.model, engineFor(ctx, p.model)].join('|');
    if (shape === sig) return;
    shape = sig;
    fill(box,
      lo && lo.key === key ? h('div.stt-err', { role: 'alert' }, h('p', null, t('stt.crash')),
        h('div.row', null, h('button.btn.small.ghost', { type: 'button', onclick: () => { mark(ctx, null); notify(); } }, t('stt.dismiss')))) : null,
      h('div.stt-idle', null,
        h('button.btn.small' + (done ? '.ghost' : '.soft'), { type: 'button', disabled: !!other, onclick: () => runClip(ctx, id, clip) }, icon('bubble'), t(done ? 'stt.again' : 'stt.btn')),
        other ? h('span.stt-hint', null, t(j.kind === 'download' ? 'stt.downloadingBusy' : 'stt.otherBusy'))
          : need ? h('span.stt-hint', null, t('stt.firstHint', { size: about(sizeOf(ctx, p.model)) })) : null));
  }
  function paintErr(j) {
    const sig = 'err|' + j.id;
    if (shape === sig) return;
    shape = sig;
    fill(box, h('div.stt-err', { role: 'alert' }, h('p', null, errText(j.error)),
      h('div.row', null,
        h('button.btn.small', { type: 'button', onclick: () => { stt.clearJob(j.id); runClip(ctx, id, clip); } }, t('stt.retry')),
        h('button.btn.small.ghost', { type: 'button', onclick: () => stt.clearJob(j.id) }, t('stt.dismiss')))));
  }
  return live(box, () => {
    const j = stt.job(), mine = j && j.key === key;
    if (mine && stt.isRunning(j)) paintRun(j);
    else if (mine && j.phase === 'error') paintErr(j);
    else paintIdle(j);
  });
}

// ---------- 草稿区 ----------

function sourceLabel(d, lang) {
  const w = stt.parseSource(d.source);
  const src = d.source === 'paste' ? t('edit.draftSrc.paste') : w ? t('stt.src', { model: modelName(w.model) }) + (w.device ? ' · ' + w.device : '') : d.source;
  if (!src) return null;
  return t('entry.draftSrc', { src }) + (Number(d.at) > 0 ? ' · ' + fmtInstant(Number(d.at), lang) : '');
}

/** 草稿 → 原话：每行写成 NN 说的话，接在后面（可以撤销） */
function fillWords(ctx, id) {
  const e = ctx.entry(id);
  if (!e || !e.draft) return;
  const add = stt.draftToDialogue(e.draft.text, ctx.state.settings.speakers);
  if (!add) return;
  if (e.text.includes(add)) { ctx.toast(t('stt.already')); return; }
  ctx.update(id, { text: stt.appendText(e.text, add) }, { undoLabel: t('stt.filled') });
}

/**
 * 详情页的草稿区：看、改、填进原话、删掉。没有草稿 → null。
 * 原话还没写、刚识别完、正在改的时候展开。
 */
export function draftView(ctx, e) {
  const d = e.draft;
  if (!d || !String(d.text || '').trim()) { edits.delete(e.id); return null; }
  const id = e.id, ed = edits.get(id), fresh = justDone.delete(id);
  const src = sourceLabel(d, ctx.lang());
  const el = h('details.e-draft', { open: !!(ed || fresh || !e.text.trim()) },
    h('summary', null, icon('chev'), h('span', null, t('entry.draft')), src ? h('small', null, src) : null));
  const swap = () => { const cur = ctx.entry(id), nx = cur && draftView(ctx, cur); if (nx) el.replaceWith(nx); else el.remove(); };
  if (ed) {
    const keep = () => { ed.a = ta.selectionStart; ed.b = ta.selectionEnd; };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(96, ta.scrollHeight + 2) + 'px'; };
    const ta = h('textarea.e-draft-ta', { value: ed.text, rows: 4, 'aria-label': t('entry.draft'), spellcheck: 'false',
      oninput: () => { ed.text = ta.value; keep(); grow(); }, onkeyup: keep, onpointerup: keep, onselect: keep,
      onfocus: () => { ed.focus = true; }, onblur: () => { keep(); ed.focus = false; } });
    el.append(ta, h('div.e-draft-acts', null,
      h('button.btn.small.primary', { type: 'button', onclick: () => {
        const cur = ctx.entry(id);
        edits.delete(id);
        if (!cur) return;
        const text = ta.value;
        ctx.update(id, { draft: text.trim() ? { ...(cur.draft || {}), text, edited: Date.now() } : null });
        ctx.toast(t(text.trim() ? 'stt.draftSaved' : 'stt.draftDeleted'));
      } }, icon('check'), t('common.save')),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { edits.delete(id); swap(); } }, t('common.cancel'))));
    queueMicrotask(() => {
      if (!ta.isConnected) return;
      grow();
      if (ed.focus || ed.start) { ed.start = false; ta.focus({ preventScroll: true }); if (ed.a != null) ta.setSelectionRange(ed.a, ed.b); }
    });
  } else {
    el.append(h('div.e-draft-body', null, d.text),
      h('div.e-draft-acts', null,
        h('button.btn.small.soft', { type: 'button', onclick: () => fillWords(ctx, id) }, t('stt.fill')),
        h('button.btn.small', { type: 'button', onclick: () => { edits.set(id, { text: d.text, start: true }); swap(); } }, icon('pencil'), t('stt.edit')),
        h('button.btn.small.ghost', { type: 'button', onclick: () => ctx.update(id, { draft: null }, { undoLabel: t('stt.draftDeleted') }) }, t('stt.delDraft'))),
      h('p.e-draft-help', null, t('stt.fillHelp', { nn: ctx.state.settings.speakers.nn.name || 'NN' })));
  }
  if (fresh) {
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => { if (el.isConnected) el.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' }); }, 60);
  }
  return el;
}

// ---------- 设置页 ----------
async function download(ctx, model) {
  const p = prefs(ctx);
  persist();
  mark(ctx, { key: 'download:' + model, model, engine: null, at: Date.now() });
  try {
    await stt.downloadModel({ model, useGpu: p.useGpu,
      onEngine: (engine) => mark(ctx, { key: 'download:' + model, model, engine, at: Date.now() }),
      onGpuFail: () => setPrefs(ctx, { useGpu: false }) });
    stt.clearJob();
    ctx.toast(t('stt.downloadedToast'));
  } catch (e) { /* 出错显示在设置里；取消就算了 */ } finally { mark(ctx, null); refreshCache(model); }
}
async function removeModel(ctx, model) {
  const info = cacheOf(model);
  const ok = await ctx.confirm({ message: t('stt.delQ', { model: modelName(model), size: fmtBytes((info && info.bytes) || 0) }), confirmLabel: t('common.delete'), danger: true });
  if (!ok) return;
  await stt.deleteModel(model).catch(() => 0);
  await refreshCache(model);
  ctx.toast(t('stt.deleted'));
}

/** 设置页「语音转文字」一节 */
export function sttSettings(ctx) {
  const el = h('section.set-sec#set-stt');
  let dlBar = null, last = '';
  return live(el, () => {
    const p = prefs(ctx), j = stt.job(), g = gpu();
    const running = j && stt.isRunning(j);
    const dl = running && j.kind === 'download' ? j : null;
    // 别处在识别时每出一个字都会通知：设置这里看的东西没变就不重画
    const sig = JSON.stringify([p, g, stt.MODEL_KEYS.map(k => cacheOf(k)), running ? j.kind + j.model : '', dl && dl.phase, j && j.phase === 'error' ? j.id : 0, !!(ctx.local && ctx.local.sttRun)]);
    if (!dl && sig === last) return;
    last = sig;
    // 下载中只更新进度，不重建（免得按「取消」时按钮被换掉）
    if (dl && dlBar && dlBar.isConnected && el.dataset.dl === dl.model + '|' + dl.phase) {
      const [msg, sub, pct] = progressOf(dl);
      el.querySelector('.stt-files small').textContent = [msg, sub].filter(Boolean).join(' · ');
      dlBar.set(pct);
      return;
    }
    el.dataset.dl = dl ? dl.model + '|' + dl.phase : '';
    const models = stt.MODEL_KEYS.map(m => {
      const allowed = stt.modelAllowed(m, { mobile: p.mobile }), on = p.model === m;
      const info = cacheOf(m), have = !!(info && info.complete[engineFor(ctx, m)]);
      return h('div.group-row.stt-model', { role: 'radio', tabindex: allowed ? '0' : '-1', 'aria-checked': String(on), 'aria-disabled': allowed ? null : 'true',
        onclick: () => { if (allowed && !on) { setPrefs(ctx, { model: m }); notify(); } },
        onkeydown: (e) => { if ((e.key === ' ' || e.key === 'Enter') && allowed && !on) { e.preventDefault(); setPrefs(ctx, { model: m }); notify(); } } },
        h('span.stt-radio', { 'aria-hidden': 'true' }),
        h('span.set-label', null, h('span', null, modelName(m)),
          h('small', null, allowed ? t('stt.model.' + m + '.help', { size: about(sizeOf(ctx, m)) }) : t('stt.model.small.mobile'))),
        have ? h('span.value.stt-have', null, icon('check'), t('stt.have')) : null);
    });
    const m = p.model, info = cacheOf(m), engine = engineFor(ctx, m);
    let value, btns = [];
    dlBar = null;
    if (dl && dl.model === m) {
      const [msg, sub, pct] = progressOf(dl);
      value = [msg, sub].filter(Boolean).join(' · ');
      dlBar = bar(); dlBar.set(pct);
      btns = [h('button.btn.small.ghost', { type: 'button', onclick: () => stt.cancel() }, t('common.cancel'))];
    } else if (info === undefined) value = t('common.loading');
    else if (info === null) value = t('stt.noCache');
    else {
      const busy = !!running;
      if (info.complete[engine]) value = t('stt.downloaded', { size: fmtBytes(info.bytes) });
      else {
        value = info.bytes ? t('stt.partial', { size: fmtBytes(info.bytes) }) : t('stt.notDownloaded');
        btns.push(h('button.btn.small', { type: 'button', disabled: busy, onclick: () => download(ctx, m) }, t(info.bytes ? 'stt.resume' : 'stt.downloadNow')));
      }
      if (info.bytes) btns.push(h('button.btn.small.ghost.danger', { type: 'button', disabled: busy, onclick: () => removeModel(ctx, m) }, t('common.delete')));
    }
    const dlErr = j && j.kind === 'download' && j.phase === 'error' ? j : null;
    const lo = leftover(ctx), crashed = lo && String(lo.key).startsWith('download:') ? lo : null;
    fill(el,
      h('h2.group-h', null, t('stt.h')),
      h('div.group', null,
        h('div.stt-models', { role: 'radiogroup', 'aria-label': t('stt.modelLabel') }, models),
        h('div.group-row.set-row.stt-files', null, h('span.set-label', null, t('stt.files'), h('small', null, value)), btns.length ? h('span.stt-btns', null, btns) : null),
        dlBar ? h('div.stt-files-bar', null, dlBar) : null,
        dlErr ? h('div.group-row.stt-files-err', { role: 'alert' }, h('span', null, errText(dlErr.error)),
          h('button.btn.small.ghost', { type: 'button', onclick: () => stt.clearJob(dlErr.id) }, t('stt.dismiss'))) : null,
        crashed && !dl ? h('div.group-row.stt-files-err', { role: 'alert' }, h('span', null, t('stt.crash')),
          h('button.btn.small.ghost', { type: 'button', onclick: () => { mark(ctx, null); last = ''; notify(); } }, t('stt.dismiss'))) : null,
        !p.mobile && g.gpu ? h('label.group-row.set-row', null, h('span.set-label', null, t('stt.gpu'), h('small', null, t('stt.gpuHelp'))),
          h('input.toggle', { type: 'checkbox', role: 'switch', checked: p.useGpu, onchange: (e) => { setPrefs(ctx, { useGpu: e.target.checked }); notify(); } })) : null),
      h('div.group-foot', null, t('stt.foot'), ' ', t('stt.engine.' + engine), ' ', t('stt.test')));
  });
}
