// 修改记录（#/e/<id>/history）：这条梦话的各个版本，新的在前——什么时候、谁、用哪台设备改的，改了什么（原话按行比较）。
// 点一版看它当时的样子（气泡、录音），「恢复这个版本」= 用旧内容做一次新的修改（能撤销，旧的这版也照样留在记录里）。
// 恢复时录音不会变少：现在的录音都留着，再放回那一版有、现在没有的——在「移除的录音」里的直接放回，哪里都没有的要本机或云端找得到；
//   永久删除了的不放回（说一声），看一版时也只写「已经永久删除」、不给播放器。
// 永久删除了的条目（墓碑）只说一句，不列版本（这台设备记的旧版本也已经忘掉了）。
// 版本来自：现在的数据 + 这台设备记下的旧版本（IndexedDB babble-history，不同步）+ 按需从云端 git 历史里找的更早版本。
// 自己管更新（返回 onChange）：数据变了重读本机记录再画，云端找到的留着。
import { h, icon } from '../ui/dom.js';
import { audioPlayer } from '../ui/player.js';
import { buildVersions, changedFields, lineDiff, compactDiff, versionBy } from '../core/history.js';
import { restoreAudio, killedIn } from '../core/store.js';
import { fmtEntryDate, fmtInstant, fmtTime, localParts, daysAgo, today } from '../core/dates.js';
import { chatView } from './entry.js';
import { entryLabel } from './record.js';
import { clipLabel, clipName } from '../core/clips.js';
import { byLabel } from './device.js';
import { t } from '../i18n.js';

const enc = encodeURIComponent;
const daySep = lang => (lang === 'en' ? ', ' : ' ');
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
/** 恢复旧版本时换回来的字段（收藏、待整理状态不跟着变；录音另外处理；旧数据里存着的 title 不动——界面上没有标题） */
const RESTORE = ['date', 'time', 'recordedAt', 'tz', 'timeSource', 'text', 'note', 'draft'];
const DIFF_ROWS = 8;

/** 这一版是什么时候存的：备忘录导入的条目故意用很早的修改时间，那就用创建时间 */
export const madeAt = (e) => (e && e.updatedAt > 1e12 ? e.updatedAt : (e && e.createdAt) || 0);

/** 刚刚 / 5 分钟前 / 3 小时前 / 今天 下午3:05 / 昨天 晚上11:40 / 11月4日 凌晨2:58（不是今年加年份）；不知道 → '' */
export function fmtAgo(ms, lang = 'zh-Hans', now = Date.now()) {
  if (!(ms > 1e12)) return '';
  const d = now - ms;
  if (d < 60e3) return t('hist.justNow');
  if (d < 3600e3) return t('hist.minAgo', { n: Math.floor(d / 60e3) });
  const p = localParts(ms), ago = daysAgo(ms, new Date(now));
  if (ago === 0 && d < 6 * 3600e3) return t('hist.hrAgo', { n: Math.floor(d / 3600e3) });
  if (ago === 0) return t('hist.today', { time: fmtTime(p.time, lang) });
  if (ago === 1) return t('hist.yesterday', { time: fmtTime(p.time, lang) });
  return fmtInstant(ms, lang, { year: p.date.slice(0, 4) !== today(new Date(now)).slice(0, 4) });
}

/** 详情页底部那一行：「最后修改：🥷🏻 名字 · iPhone · 5 分钟前」（链到修改记录）；没有签名的老条目 → null */
export function lastEditedLine(e, ctx) {
  const by = versionBy(e);
  const who = byLabel(by, ctx.state.settings.speakers);
  if (!who) return null;
  const when = fmtAgo(madeAt(e), ctx.lang());
  return h('p.e-foot.e-by', null, h('a', { href: '#/e/' + enc(e.id) + '/history' }, when ? t('hist.lastBy', { by: who, when }) : who));
}

export function render(main, params, ctx) {
  const id = params.id;
  const lang = ctx.lang();
  const sp = () => ctx.state.settings.speakers;
  const session = ctx.history.cloud.session(id);
  let local = null, loadErr = null, loadSeq = 0;
  const cloudFound = [];
  const cloud = { started: false, running: false, at: 0, checked: 0, more: true, err: null, added: null };
  let progressEl = null, previewApi = null, leaving = false;
  const page = h('div.page.hist');

  main.append(h('header.navbar', null,
    h('button.back', { type: 'button', onclick: () => ctx.back('/e/' + enc(id)) }, icon('back'), t('common.back')),
    h('span.nb-title', null, t('hist.title')), h('span')), page);

  async function loadLocal() {
    const seq = ++loadSeq;
    let list = [], err = null;
    try { list = await ctx.history.list(id); } catch (e) { err = (e && e.message) || String(e); }
    if (seq !== loadSeq) return;
    local = Array.isArray(list) ? list : []; loadErr = err;
    if (main.isConnected) draw();
  }

  const purged = () => !!(ctx.tombstone && ctx.tombstone(id));
  function draw() {
    const e = ctx.entry(id);
    if (!e) { fill(page, h('p.empty', null, t(purged() ? 'entry.purgedNote' : 'common.notFound'))); return; }
    const versions = buildVersions(e, local || [], cloudFound);
    fill(page,
      h('p.hist-sub', null, entryLabel(e, sp(), lang)),
      loadErr ? h('p.err.small.hist-err', { role: 'alert' }, t('hist.loadFail', { msg: loadErr })) : null,
      h('ol.hist-list', null, versions.map((it, i) => versionRow(it, versions[i + 1] || null, i === versions.length - 1))),
      local == null ? h('p.muted.small.hist-loading', { role: 'status' }, t('hist.loading')) : null,
      local != null && versions.length === 1 && !cloud.started ? h('p.hist-empty', null, t('hist.empty')) : null,
      cloudBox(),
      h('p.group-foot.hist-foot', null, t('hist.localNote')));
  }

  // ---------- 一版 ----------
  function byText(it) {
    const who = byLabel(versionBy(it.v), sp());
    if (who) return who;
    if (it.cloud && it.cloud.device) return t('hist.cloudFrom', { device: it.cloud.device });   // 只知道是哪台设备传上去的
    return t('hist.unknownBy');
  }
  function versionRow(it, older, last) {
    const v = it.v;
    const fields = older ? changedFields(older.v, v) : [];
    const when = fmtAgo(madeAt(v), lang) || (it.cloud && it.cloud.at ? fmtAgo(Date.parse(it.cloud.at), lang) : '');
    return h('li', null, h('button.hist-row' + (it.current ? '.cur' : ''), { type: 'button', onclick: () => preview(it) },
      h('span.hist-top', null,
        h('span.hist-when', null, when || '—'),
        it.current ? h('span.pill.rose', null, t('hist.current')) : null,
        it.cloud && !it.local && !it.current ? h('span.pill', null, t('hist.cloud')) : null,
        h('span.sp'), icon('chev', { cls: 'hist-chev' })),
      h('span.hist-by', null, byText(it)),
      older ? h('span.hist-fields', null, fields.length ? fields.map(f => h('span.tag.neutral', null, t('hist.f.' + f))) : h('span.muted', null, t('hist.f.none')))
        : last && !it.current ? h('span.hist-fields', null, h('span.muted', null, t('hist.oldest'))) : null,
      older ? changeDetails(older.v, v, fields) : null));
  }
  function changeDetails(a, b, fields) {
    const out = [];
    if (fields.includes('date')) out.push(h('span.hist-line', null, t('hist.dateChange', { from: fmtEntryDate(a, lang, { sep: daySep(lang) }), to: fmtEntryDate(b, lang, { sep: daySep(lang) }) })));
    if (fields.includes('audio')) {
      const shas = (v) => v.audio.map(c => c.sha256).join(',');
      if (shas(a) !== shas(b)) out.push(h('span.hist-line', null, t('hist.audioChange', { from: a.audio.length, to: b.audio.length })));
      // 改了名的录音：「录音改名：录音 2 → 下雨了」
      const fb = (n) => t('clip.fallback', { n });
      a.audio.forEach((c, i) => {
        const k = b.audio.findIndex(x => x.sha256 === c.sha256);
        if (k >= 0 && clipName(c) !== clipName(b.audio[k])) out.push(h('span.hist-line', null, t('hist.clipRename', { from: clipLabel(c, i, fb), to: clipLabel(b.audio[k], k, fb) })));
      });
    }
    if (fields.includes('text')) out.push(diffBlock(a.text, b.text));
    return out.length ? h('span.hist-details', null, out) : null;
  }
  function diffBlock(a, b) {
    const rows = compactDiff(lineDiff(a, b), 1);
    const shown = rows.slice(0, DIFF_ROWS);
    const rest = rows.slice(DIFF_ROWS).filter(r => r.t === 'add' || r.t === 'del').length;
    return h('span.hist-diff', null,
      shown.map(r => r.t === 'skip' ? h('span.hd-skip', null, t('hist.skip', { n: r.n }))
        : h(r.t === 'add' ? 'ins.hd-add' : r.t === 'del' ? 'del.hd-del' : 'span.hd-same', null,
          h('span.hd-mark', { 'aria-hidden': 'true' }, r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''), r.line.trim() ? h('span.hd-text', null, r.line) : h('span.hd-text.hd-blank', { 'aria-hidden': 'true' }, '⏎'))),
      rest ? h('span.hd-skip', null, t('hist.moreLines', { n: rest })) : null);
  }

  // ---------- 看一版 ----------
  function preview(it) {
    const v = it.v, cur = ctx.entry(id), gone = ctx.goneShas ? ctx.goneShas() : new Set();
    const players = [];
    const time = fmtInstant(madeAt(v), lang, { year: true }) || fmtAgo(it.cloud && Date.parse(it.cloud.at), lang);
    const restoreBtn = it.current ? null : h('button.btn.primary', { type: 'button', onclick: () => restore(it, restoreBtn) }, icon('history'), t('hist.restore'));
    const body = h('div.hist-pv', null,
      h('p.hist-pv-by', null, byText(it)),
      it.current ? h('p.hist-pv-note', null, t('hist.isCurrent')) : null,
      v.deleted ? h('p.hist-pv-note.amber', null, t('hist.versionDeleted')) : null,
      h('p.hist-pv-date', null, fmtEntryDate(v, lang, { sep: daySep(lang) })),
      v.audio.length ? h('div.e-audio', null, v.audio.map((c, i) => {
        const cap = h('p.e-clip-cap', null, clipLabel(c, i, (n) => t('clip.fallback', { n })));
        // 永久删除了的：只写一句，不给播放器（也不去云端找）
        const kept = cur && [...(cur.audio || []), ...(cur.removedAudio || [])].some(a => a.sha256 === c.sha256);
        if (gone.has(c.sha256) || (cur && !kept && killedIn(cur, c))) return h('div.e-clip', null, cap, h('p.hist-purged', null, t('player.purged')));
        const p = audioPlayer({ getBlob: () => ctx.clipBlob(c.sha256, c.mime), durationSec: c.durationSec, key: c.sha256 });
        players.push(p);
        return h('div.e-clip', null, cap, p);
      })) : null,
      v.text.trim() ? chatView(v.text, sp(), { hasAudio: players.length > 0, onCue: (k) => { const p = players[Math.min(k, players.length - 1)]; if (p) p.scrollIntoView({ block: 'center' }); } })
        : h('p.muted.hist-pv-empty', null, t('hist.noText')),
      v.note && v.note.trim() ? h('section.e-note', null, h('h2.e-h', null, t('entry.note')), h('div.e-note-body', null, v.note)) : null);
    previewApi = ctx.sheet(body, { title: t('hist.preview', { time }), wide: true, cls: 'hist-pv-sheet', foot: restoreBtn ? [restoreBtn] : null,
      onClose: () => { for (const p of players) p.destroy(); previewApi = null; } });
  }

  /**
   * 恢复：旧内容做一次新的修改。录音见 store.js 的 restoreAudio（现在的都留着，补上那一版有的）：哪里都没有的先看本机、云端找不找得到；
   * 补哪些在修改里按最新的条目再算一遍（找录音的时候可能同步进来了新的）；两边都有的录音名字换回那一版的。提示里说放回了几段、几段找不到、几段永久删除了
   */
  async function restore(it, btn) {
    const cur = ctx.entry(id);
    if (!cur) return;
    const v = it.v, gone = () => (ctx.goneShas ? ctx.goneShas() : new Set());
    btn.disabled = true;
    btn.replaceChildren(t('hist.restoring'));
    const found = new Set();
    for (const c of v.audio || []) {
      const has = [...(cur.audio || []), ...(cur.removedAudio || [])].some(a => a.sha256 === c.sha256);
      if (has || gone().has(c.sha256) || killedIn(cur, c)) continue;
      if (await ctx.clipBlob(c.sha256, c.mime).catch(() => null)) found.add(c.sha256);
    }
    const fresh = ctx.entry(id);
    if (!fresh) { if (previewApi) previewApi.close(); draw(); return; }      // 找录音的时候这条没了（永久删除了）
    const now = Date.now(), plan = restoreAudio(fresh, v.audio, { gone: gone(), have: found, now });
    const names = new Map((v.audio || []).map(c => [c.sha256, c.name || null]));     // 那一版也有的录音：名字换回那一版的（改名也恢复）
    const named = (a, name) => { const { name: x, ...rest } = a; return name ? { ...rest, name } : rest; };
    const at = madeAt(v);
    const when = at > 1e12 ? fmtInstant(at, lang, { year: localParts(at).date.slice(0, 4) !== today().slice(0, 4) }) : fmtEntryDate(v, lang);
    const label = [t('hist.restored', { time: when }), plan.back ? t('hist.clipsBack', { n: plan.back }) : null,
      plan.missing ? t('hist.clipMissing', { n: plan.missing }) : null, plan.purged ? t('hist.clipPurged', { n: plan.purged }) : null].filter(Boolean).join('\n');
    leaving = true;
    if (previewApi) previewApi.close();
    ctx.mutate(s => {
      const e = s.data.entries[id];
      if (!e || e.purged) return;
      const { audio, removedAudio } = restoreAudio(e, v.audio, { gone: gone(), have: found, now });
      const next = { ...e, audio: audio.map(a => (names.has(a.sha256) ? named(a, names.get(a.sha256)) : a)), removedAudio };
      for (const k of RESTORE) next[k] = v[k] === undefined ? null : structuredClone(v[k]);
      delete next.deleted; delete next.deletedAt; delete next.deletedBy;
      s.data.entries[id] = next;
    }, { undoLabel: label, cause: 'revert' });
    ctx.back('/e/' + enc(id));
  }

  // ---------- 云端历史 ----------
  function cloudBox() {
    const st = ctx.sync.status();
    if (!st.on) return h('p.group-foot.hist-cloud-off', null, t('hist.cloudOff'));
    if (cloud.running) {
      progressEl = h('span', null, t('hist.cloudChecking', { n: cloud.at }));
      return h('div.hist-cloud.hist-cloud-run', { role: 'status' }, progressEl,
        h('button.btn.small', { type: 'button', onclick: () => session.stop() }, t('hist.cloudStop')));
    }
    if (!cloud.started) return h('div.hist-cloud', null, h('button.btn.soft.block', { type: 'button', onclick: runCloud }, icon('history'), t('hist.cloudBtn')));
    const msg = [cloud.more ? t('hist.cloudChecked', { n: cloud.checked }) : t('hist.cloudStart'), cloud.added === 0 && !cloud.err ? t('hist.cloudNothing') : null].filter(Boolean).join(lang === 'en' ? ' ' : '');
    return h('div.hist-cloud', null,
      h('p.small.muted', { role: 'status' }, msg),
      cloud.err ? h('p.err.small', { role: 'alert' }, t('syncErr.' + cloud.err.code, cloud.err.vars || {})) : null,
      cloud.more ? h('button.btn', { type: 'button', onclick: runCloud }, cloud.err ? t('common.retry') : t('hist.cloudMore')) : null);
  }
  async function runCloud() {
    const e = ctx.entry(id);
    const before = e ? buildVersions(e, local || [], cloudFound).length : 0;
    Object.assign(cloud, { started: true, running: true, err: null, at: session.checked + 1 });
    draw();
    try {
      const r = await session.run({ onProgress: (p) => { cloud.at = p.checked; if (progressEl) progressEl.textContent = t('hist.cloudChecking', { n: p.checked }); } });
      cloudFound.push(...r.found);
      cloud.more = r.more;
    } catch (err) {
      cloud.err = { code: err && typeof err.code === 'string' ? err.code : 'unknown', vars: (err && err.vars) || {} };
    }
    cloud.running = false;
    cloud.checked = session.checked;
    const e2 = ctx.entry(id);
    cloud.added = e2 ? buildVersions(e2, local || [], cloudFound).length - before : null;
    progressEl = null;
    if (main.isConnected) draw();
  }

  draw();
  if (!purged()) loadLocal();
  return {
    onChange: () => { if (leaving) return; draw(); if (!purged()) loadLocal(); },
    cleanup: () => { session.stop(); if (previewApi) previewApi.close(); },
  };
}
