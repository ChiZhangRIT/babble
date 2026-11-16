import { h, download } from './dom.js';
import { readBackup } from '../core/backup.js';
import { t } from '../i18n.js';

export function recoveryPanel(main, ctx) {
  let busy = false;
  const status = h('p.err', { role: 'alert', hidden: true });
  const buttons = [];
  const button = (label, run, disabled = false) => {
    const el = h('button.btn', { type: 'button', disabled, onclick: async () => { if (!busy) await run(); } }, label);
    buttons.push({ el, disabled }); return el;
  };
  function lock(value) { busy = value; for (const { el, disabled } of buttons) el.disabled = value || disabled; }
  async function repair(next, clips = [], incomplete = false, keepOnly = false) {
    const ok = await ctx.confirm({ title: t('recovery.confirm'), message: [t('recovery.confirmText'), keepOnly ? t('recovery.keepConfirm') : '', incomplete ? t('recovery.incomplete') : ''].filter(Boolean).join('\n\n'), confirmLabel: t('recovery.go') });
    if (!ok) return;
    // 录音先落盘；后续恢复失败也不删已有录音或恢复分片。
    for (const clip of clips) await ctx.audio.putClip(clip.blob, { mime: clip.mime });
    await ctx.repairData(next);
  }
  async function run(task) {
    lock(true); status.hidden = false; status.textContent = t('recovery.working');
    try { await task(); status.hidden = true; }
    catch (e) { status.textContent = t(e?.code === 'no-cloud' ? 'recovery.noCloud' : e?.message === 'recovery-unavailable' ? 'recovery.unavailable' : 'recovery.failed'); }
    finally { lock(false); }
  }
  const file = h('input', { type: 'file', hidden: true, accept: '.zip,.json,application/zip,application/json',
    onchange: e => { const selected = e.target.files?.[0]; e.target.value = ''; if (selected) return run(async () => { const backup = await readBackup(selected); await repair(backup.state, backup.clips, !!(backup.bad.length || backup.missing.length)); }); } });
  const original = ctx.recoveryExport();
  main.replaceChildren(h('div.page', null, h('section.card.safe-mode', null,
    h('h1', null, t('recovery.title')), h('p', null, t('recovery.intro')),
    ctx.storageIssue()?.code === 'unavailable' ? h('p', null, t('recovery.unavailable')) : null,
    h('p.muted', null, t('recovery.readable', { n: Object.values(ctx.state.data.entries).filter(e => !e.deleted).length })),
    h('div.row', null,
      button(t('recovery.export'), () => download('babble-recovery-original.json', JSON.stringify(original, null, 2), 'application/json'), !original),
      button(t('recovery.retry'), () => run(() => ctx.retryData()))),
    h('p.muted', null, t('recovery.exportHint')),
    h('div.row', null,
      button(t('recovery.backup'), () => file.click()),
      ctx.local.sync ? button(t('recovery.cloud'), () => run(async () => { const next = await ctx.recoveryCloud(); await repair(next); })) : null,
      button(t('recovery.keep'), () => run(() => repair(ctx.state, [], false, true)))),
    status, file)));
}
