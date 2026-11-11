// 录音诊断（#/diag）：一项项点着测，生成一份能复制的报告（只有设备和功能信息，没有录音内容、没有令牌）。
// 「录 5 秒」用内存里的录音库（memoryStore）：不落盘，也不会在下次启动时被当成没收尾的录音找回来。
// 自己管更新（返回 onChange）：同步来的数据变化不会把测到一半的结果清掉。
import { h, icon, copyText } from '../ui/dom.js';
import { audioPlayer, stopAll } from '../ui/player.js';
import { createRecorder } from '../core/recorder.js';
import { memoryStore } from '../core/audioStore.js';
import { readMp4Meta } from '../core/mp4meta.js';
import { localParts, systemTz, fmtTime } from '../core/dates.js';
import { fmtBytes } from '../core/util.js';
import { probeDuration } from './entry.js';
import { within } from './settings.js';
import { t } from '../i18n.js';
/** replaceChildren，但跳过 null / false（DOM 会把 null 写成文字「null」） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const TYPES = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/wav'];
const REC_MS = 5000;
const yes = (v) => (v ? t('diag.yes') : t('diag.no'));

/** UA → 'iOS 18.4' / 'iPadOS 或 macOS 18.4（Safari）' 之类，认不出 → '' */
export function osVersion(ua = '') {
  let m = /\b(?:iPhone|iPad|iPod)[^)]*?OS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
  if (m) return 'iOS ' + [m[1], m[2], m[3]].filter(Boolean).join('.');
  m = /Mac OS X (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
  const safari = /Version\/(\d+(?:\.\d+)*)/.exec(ua);
  if (m) return 'macOS ' + [m[1], m[2], m[3]].filter(Boolean).join('.') + (safari ? ' · Safari ' + safari[1] : '');
  m = /Android (\d+(?:\.\d+)*)/.exec(ua);
  return m ? 'Android ' + m[1] : '';
}

export function render(main, params, ctx) {
  const lang = ctx.lang();
  const results = new Map();          // 测试 id → [[标签, 值], …]
  let recBusy = false, recPlayer = null, rec = null, gone = false;

  const report = h('textarea.diag-report', { readonly: true, rows: 12, 'aria-label': t('diag.report'), spellcheck: 'false' });
  const cards = h('div.diag-cards');
  main.append(
    h('header.navbar', null, h('button.back', { type: 'button', onclick: () => ctx.back('/settings') }, icon('back'), t('nav.settings')),
      h('span.nb-title', null, t('nav.diag')), h('span')),
    h('div.page.diag', null,
      h('p.diag-lead', null, t('diag.intro')),
      cards,
      h('p.group-h', null, t('diag.report')),
      report,
      h('div.row.diag-acts', null,
        h('button.btn.primary', { type: 'button', onclick: async () => ctx.toast(await copyText(report.value) ? t('common.copied') : t('common.copyFail')) }, t('diag.copy')),
        h('button.btn', { type: 'button', onclick: () => runAll() }, t('diag.again')))));

  // ---------- 各项测试 ----------
  const TESTS = [
    { id: 'env', auto: true, run: envTest },
    { id: 'formats', auto: true, run: formatTest },
    { id: 'mic', auto: true, run: micTest },
    { id: 'record', run: recordTest, button: 'diag.recordGo' },
    { id: 'wake', run: wakeTest, button: 'diag.wakeGo' },
    { id: 'storage', auto: true, run: storageTest },
    { id: 'share', auto: true, run: shareTest },
  ];

  function envTest() {
    const ua = navigator.userAgent || '';
    const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    return [
      [t('diag.standalone'), standalone ? t('diag.standaloneYes') : t('diag.standaloneNo')],
      [t('diag.os'), osVersion(ua) || '—'],
      [t('diag.device'), ctx.device + ' · ' + ctx.layout() + ' · ' + window.screen.width + '×' + window.screen.height + ' @' + (window.devicePixelRatio || 1) + 'x'],
      ['User agent', ua],
      [t('diag.tz'), (systemTz() || '—') + ' · ' + (navigator.language || '')],
      [t('diag.secure'), yes(window.isSecureContext)],
      [t('diag.sw'), navigator.serviceWorker ? (navigator.serviceWorker.controller ? t('diag.swOn') : t('diag.swOff')) : t('diag.no')],
      ['IndexedDB', yes(!!window.indexedDB)],
    ];
  }
  function formatTest() {
    const MR = window.MediaRecorder;
    const out = [['MediaRecorder', yes(!!MR)], ['getUserMedia', yes(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia))]];
    if (MR && MR.isTypeSupported) for (const ty of TYPES) out.push([ty, yes(MR.isTypeSupported(ty))]);
    out.push(['AudioContext', yes(!!(window.AudioContext || window.webkitAudioContext))]);
    out.push(['audioSession', navigator.audioSession ? t('diag.audioSessionType', { type: navigator.audioSession.type || '—' }) : t('diag.no')]);
    return out;
  }
  async function micTest() {
    if (!navigator.permissions || !navigator.permissions.query) return [[t('diag.micPerm'), t('diag.unknownQ')]];
    try { const s = await within(navigator.permissions.query({ name: 'microphone' })); return [[t('diag.micPerm'), s ? t('diag.perm.' + s.state) : t('diag.unknownQ')]]; }
    catch (e) { return [[t('diag.micPerm'), t('diag.unknownQ')]]; }
  }
  async function storageTest() {
    const [est, pers, list] = await Promise.all([within(ctx.audio.estimate()), within(ctx.audio.persisted()), within(ctx.audio.listClips(), 8000)]);
    return [
      [t('diag.persisted'), pers == null ? t('diag.unknownQ') : yes(pers)],
      [t('diag.usage'), est && est.usage != null ? fmtBytes(est.usage) + (est.quota ? ' / ' + fmtBytes(est.quota) : '') : '—'],
      [t('diag.clips'), list ? String(list.length) : '—'],
      [t('diag.entries'), String(ctx.entries().length)],
    ];
  }
  function shareTest() {
    const can = (files) => { try { return !!(navigator.canShare && navigator.canShare({ files })); } catch (e) { return false; } };
    return [
      ['navigator.share', yes(!!navigator.share)],
      [t('diag.shareText'), yes(can([new File(['babble'], 'test.txt', { type: 'text/plain' })]))],
      [t('diag.shareAudio'), yes(can([new File([new Uint8Array(16)], 'test.m4a', { type: 'audio/mp4' })]))],
    ];
  }
  async function wakeTest() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return [[t('diag.wake'), t('diag.no')]];
    try { const s = await navigator.wakeLock.request('screen'); await s.release(); return [[t('diag.wake'), t('diag.wakeOk')]]; }
    catch (e) { return [[t('diag.wake'), t('diag.wakeFail', { msg: (e && (e.message || e.name)) || String(e) })]]; }
  }

  /** 录 5 秒（每秒一片）→ 拼起来 → 格式、大小、时长（文件头 / <audio>）→ 放出来听 */
  async function recordTest() {
    if (recBusy) return null;
    recBusy = true;
    stopAll();
    if (recPlayer) { recPlayer.destroy(); recPlayer = null; }
    const store = memoryStore();
    let last = null, levels = 0, peak = 0;
    rec = createRecorder({ audioStore: store, maxMs: REC_MS + 5000, onState: (s, info) => { last = { s, info }; },
      onLevel: (v) => { levels++; peak = Math.max(peak, v); } });
    show('record', [[t('diag.recording'), '…']], true);
    await rec.start();
    if (rec.state !== 'recording') {
      recBusy = false;
      const code = last && last.info && last.info.code;
      return [[t('diag.recResult'), t('diag.recFail', { code: code || rec.state, msg: (last && last.info && last.info.message) || '' })]];
    }
    const t0 = Date.now();
    await new Promise(r => { const iv = setInterval(() => { if (gone || Date.now() - t0 >= REC_MS || rec.state !== 'recording') { clearInterval(iv); r(); } else show('record', [[t('diag.recording'), Math.ceil((REC_MS - (Date.now() - t0)) / 1000) + ' s']], true); }, 250); });
    const st = rec.stats();
    const res = await rec.stop({ reason: 'diag' });
    rec = null;
    recBusy = false;
    if (!res) return [[t('diag.recResult'), t('diag.recFail', { code: (last && last.info && last.info.code) || 'empty', msg: '' })]];
    const clip = await store.getClip(res.sha256);
    const meta = readMp4Meta(await clip.blob.arrayBuffer());
    const el = await probeDuration(clip.blob);
    if (!gone) {
      recPlayer = audioPlayer({ getBlob: async () => clip.blob, durationSec: el || res.durationSec });
    }
    return [
      [t('diag.recResult'), t('diag.recOk')],
      ['mime', res.mime], [t('diag.chunks'), String(res.chunks)], [t('diag.bytes'), fmtBytes(res.bytes) + ' (' + res.bytes + ')'],
      [t('diag.timerDur'), res.durationSec + ' s'],
      [t('diag.metaDur'), meta.durationSec != null ? meta.durationSec.toFixed(2) + ' s' : t('diag.metaNone')],
      [t('diag.audioDur'), el != null ? el.toFixed(2) + ' s' : '—'],
      ['brand', (meta.brand || '—') + (meta.fragmented ? ' · fragmented' : '')],
      [t('diag.level'), levels ? t('diag.levelOk', { n: levels, peak: Math.round(peak * 100) }) : t('diag.levelNone')],
      [t('diag.wakeDuring'), st && st.wakeLock ? t('diag.yes') : st && st.wakeError ? st.wakeError : t('diag.no')],
      st && st.warn ? [t('diag.persistWarn'), st.warn] : null,
    ].filter(Boolean);
  }

  // ---------- 画面 ----------
  const cardEls = new Map();
  for (const tst of TESTS) {
    const body = h('dl.diag-dl');
    const extra = h('div.diag-extra');
    const btn = tst.button ? h('button.btn.small', { type: 'button', onclick: () => run(tst) }, t(tst.button)) : null;
    const card = h('section.card.diag-card', null,
      h('div.diag-card-h', null, h('h2', null, t('diag.' + tst.id)), btn),
      tst.button ? h('p.f-help.diag-help', null, t('diag.' + tst.id + 'Help')) : null,
      body, extra);
    cardEls.set(tst.id, { card, body, extra, btn });
    cards.append(card);
  }
  function show(id, rows, busy = false) {
    results.set(id, rows);
    const c = cardEls.get(id);
    fill(c.body, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    if (c.btn) c.btn.disabled = busy;
    if (id === 'record') fill(c.extra, recPlayer || '');
    paintReport();
  }
  async function run(tst) {
    try { show(tst.id, (await tst.run()) || results.get(tst.id) || []); }
    catch (e) { show(tst.id, [[t('diag.error'), (e && e.message) || String(e)]]); }
  }
  function runAll() { for (const tst of TESTS) if (tst.auto || results.has(tst.id)) { if (tst.id !== 'record' || !recBusy) run(tst); } }
  function paintReport() {
    const now = localParts(Date.now());
    const lines = [t('diag.title') + ' · ' + now.date + ' ' + fmtTime(now.time, lang) + ' (' + (systemTz() || '') + ')'];
    for (const tst of TESTS) {
      const rows = results.get(tst.id);
      lines.push('', '## ' + t('diag.' + tst.id));
      if (!rows) lines.push(t('diag.notRun'));
      else for (const [k, v] of rows) lines.push(`${k}: ${v}`);
    }
    report.value = lines.join('\n');
  }

  paintReport();
  runAll();
  return {
    onChange: () => {},
    cleanup: () => {
      gone = true;
      if (rec) { const r = rec; rec = null; r.discard().catch(() => {}); }      // 测试录音只在内存里，丢掉就好
      if (recPlayer) { recPlayer.destroy(); recPlayer = null; }
    },
  };
}
