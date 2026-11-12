// 「这台设备」：设备名、谁在用这台设备——本机改过的梦话会签上 { who, device }（修改记录、最近删除里显示）。
// 只存在 babble.local（不同步）。deviceSec 是设置页的一节；askWho 是第一次在这台设备上修改梦话时问一次的小面板（app.js 调）。
import { h } from '../ui/dom.js';
import { platformDevice } from '../core/history.js';
import { t } from '../i18n.js';

/** updatedBy / deletedBy → 「🥷🏻 名字 · iPhone」（没写名字：「🥷🏻 iPhone」，不写「我」——在对方设备上会看错）；没有 → '' */
export function byLabel(by, speakers) {
  if (!by || typeof by !== 'object') return '';
  const sp = (by.who === 'me' || by.who === 'nn') && speakers ? speakers[by.who] : null;
  if (sp && !sp.name) return [sp.emoji, by.device].filter(Boolean).join(' ');
  const who = sp ? [sp.emoji, sp.name].filter(Boolean).join(' ') : '';
  return [who, by.device].filter(Boolean).join(' · ');
}

const speakerName = (sp, who) => sp[who].name || (who === 'me' ? t('dev.me') : 'NN');
const speakerBits = (sp, who) => [h('span.dev-emoji', { 'aria-hidden': 'true' }, sp[who].emoji), ' ', speakerName(sp, who)];

/**
 * 设置页里的一节。sec / row 是设置页的小部件（同样的样式）
 * @param {object} ctx
 * @param {{ sec: Function, row: Function }} ui
 */
export function deviceSec(ctx, { sec, row }) {
  const L = ctx.local, sp = ctx.state.settings.speakers;
  const nameIn = h('input.set-in', { type: 'text', value: L.device || '', placeholder: platformDevice(), maxlength: 30, autocomplete: 'off', 'aria-label': t('dev.name'),
    onchange: (e) => { const v = e.target.value.trim(); ctx.setLocal({ device: v || null }); e.target.value = v; } });
  const seg = h('div.seg.set-seg.dev-who', { role: 'group', 'aria-label': t('dev.who') });
  const draw = () => seg.replaceChildren(...[['me', speakerBits(sp, 'me')], ['nn', speakerBits(sp, 'nn')], [null, t('dev.whoNone')]].map(([v, label]) => {
    const on = (ctx.local.who || null) === v;
    return h('button', { type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), onclick: () => { ctx.setLocal({ who: v, whoAsked: true }); draw(); } }, label);
  }));
  draw();
  return sec('device', t('dev.h'), [row(t('dev.name'), nameIn), h('div.group-row.set-row.dev-who-row', null, h('span.set-label', null, t('dev.who')), seg)], t('dev.foot'));
}

/** 问一次「这台设备是谁在用？」：选了或点「以后再说」都不再问（设置里随时能改） */
export function askWho(ctx) {
  const sp = ctx.state.settings.speakers;
  let picked = false, api = null;
  const nameIn = h('input#dev-ask-name.dev-ask-name', { type: 'text', value: ctx.local.device || '', placeholder: platformDevice(), maxlength: 30, autocomplete: 'off' });
  const pick = (who) => {
    picked = true;
    const device = nameIn.value.trim() || ctx.local.device || null;
    ctx.setLocal({ who, device, whoAsked: true });
    api.close();
    ctx.toast(t('dev.saved', { by: byLabel({ who, device: device || platformDevice() }, sp) }));
  };
  api = ctx.sheet(h('div.dev-ask', null,
    h('p.dev-ask-text', null, t('dev.askText')),
    h('div.dev-ask-btns', null, ['me', 'nn'].map(who => h('button.btn.big.dev-ask-btn', { type: 'button', onclick: () => pick(who) },
      h('span.dev-ask-emoji.dev-emoji', { 'aria-hidden': 'true' }, sp[who].emoji), h('span', null, speakerName(sp, who))))),
    h('label.f-label', { for: 'dev-ask-name' }, t('dev.name')), nameIn),
  { title: t('dev.askTitle'), cls: 'dev-ask-sheet', foot: [h('button.btn', { type: 'button', onclick: () => api.close() }, t('dev.later'))],
    onClose: () => { if (!picked) ctx.setLocal({ whoAsked: true }); } });
  return api;
}

/** 该不该问：还没设、也没问过 */
export const shouldAskWho = (local) => !!local && !local.who && !local.whoAsked;

