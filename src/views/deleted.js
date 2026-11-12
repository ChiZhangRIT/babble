// 最近删除（#/deleted）：删除的梦话（新删的在前），逐条恢复；点一条先看看原话（详情页只读显示，也能恢复）。
// 没有永久删除（v1）。恢复后其他设备同步时也会一起恢复。数据变了 app 整页重画，这里不用 onChange。
// 删除时签了名（deletedBy）的显示是谁、用哪台设备删的。
import { h, icon } from '../ui/dom.js';
import { fmtEntryDate, fmtInstant } from '../core/dates.js';
import { previewLines } from '../core/dialogue.js';
import { sayNodes } from './entry.js';
import { byLabel } from './device.js';
import { deletionBy } from '../core/history.js';

/** 同一行里日期和时间之间：中文空格（11月4日 凌晨2:58），英文逗号（Nov 4, 2:58 AM） */
const daySep = lang => (lang === 'en' ? ', ' : ' ');

/** 已删除的条目，新删的在前 */
export function deletedEntries(state) {
  return Object.values((state && state.data && state.data.entries) || {}).filter(e => e.deleted)
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

export function render(main, params, ctx) {
  const { t } = ctx;
  const lang = ctx.lang(), sp = ctx.state.settings.speakers;
  const list = deletedEntries(ctx.state);

  // 有标题显示标题；没有就是第一句原话（普通的预览样式，不当标题）；什么都没写 →「还没写原话」
  const row = (e) => {
    const title = e.title && e.title.trim() ? e.title : '';
    const line = title ? null : previewLines(e.text, sp, 1)[0];
    return h('div.group-row.del-row', null,
      h('a.del-body', { href: '#/e/' + encodeURIComponent(e.id) },
        h('span.del-date', null, fmtEntryDate(e, lang, { sep: daySep(lang) })),
        title ? h('span.del-title', null, title)
          : line ? h('span.del-prev' + (line.type === 'line' ? '.kai' : ''), null, line.who ? sp[line.who].emoji + ' ' : '', sayNodes(line.content))
            : h('span.del-prev.ph', null, t('list.noText')),
        h('span.del-at', null, t('deleted.at', { time: fmtInstant(e.deletedAt, lang) }), byLabel(deletionBy(e), sp) ? ' · ' + byLabel(deletionBy(e), sp) : '')),
      h('button.btn.small.soft.del-restore', { type: 'button', onclick: () => ctx.restore(e.id) }, t('common.restore')));
  };

  main.append(
    h('header.navbar', null,
      h('button.back', { type: 'button', onclick: () => ctx.back('/settings') }, icon('back'), t('nav.settings')),
      h('span.nb-title', null, t('nav.deleted')),
      h('span')),
    h('div.page.deleted', null,
      list.length
        ? [h('div.group.del-list', null, list.map(row)), h('p.group-foot', null, t('deleted.hint'))]
        : h('div.empty.del-empty', null, icon('trash'), h('p', null, t('deleted.empty')), h('p.small', null, t('deleted.hint')))));
}
