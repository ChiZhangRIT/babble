// 永久删除（本机这边）：「最近删除」里的永久删除、30 天后自动永久删除、没有条目在用的录音，以及收到墓碑（别的设备永久删除的）以后清掉本机的残留。
// 数据怎么记（墓碑、gone 记号、removedAudio）和合并规则在 store.js；仓库里的文件由 sync.js 删。这里只管：
//   1. 永久删除 = 一次 mutate（cause 'purge'）：条目换成墓碑、移除的录音换成 gone 记号。按用户看到的那一版删（条目的 updatedAt、录音的 removedAt），
//      期间变了（别的设备恢复、改过）就不删，报 changed。
//   2. sweep：清掉本机的残留——录音（babble-audio，连同没收尾的录音分片）、床头模式的片段（babble-night）、修改记录、磁盘上的旧文字、
//      云端历史的缓存、转文字的记号。录音只删「确实没了」的：开着同步时要云端已经确认（confirmedGone），没开同步时要墓碑已经存进本机（saveOk）；
//      IndexedDB 事务里同步地再查一次；一小时内碰过的录音（导入、留下还没做完）、编辑页草稿里刚加的录音不删，用户刚点了永久删除的除外。
//      开着同步时录音在每台设备上再留 PURGE_GRACE_MS（7 天，从记号的 purgedAt 算）才删：这期间打不开、不上传、不进备份；
//      别的设备同时（比如断网时）恢复了、这次永久删除作废的话，录音还在，下一轮同步会重新传上仓库（仓库里的文件照样马上删）。
//      床头模式的片段不等这几天（找回录音用不上它，留着只会被再留一次）：能删了（云端确认过 / 墓碑存进本机了）就删。
//      还留着的（等这几天、等一小时）到时候自己再清理一次（定时器；重新打开 App 后第一次确认云端时也会整个清理一遍）。
//      草稿本身从不删（编辑页、录音页、启动时的 applyRecovery 各自处理）。
//   3. 30 天：每台设备从自己第一次看到它在「最近删除」里算起（babble.trash，只在本机），也不早于同步的设置 trashSince（开放永久删除的时刻）。
//      显示的日期 shownAt 用同步的时间算，不会晚于任何一台设备真的删的时候。
//      第一阶段从来不写 babble.trash、trashSince：开放以后每台设备第一次打开新版时，已经在「最近删除」里的每一项从这一刻起才开始算，
//      至少再等满 30 天。trashSince 是开放以后第一次同步成功的那台设备写下的时刻（没开同步的设备：开放以后第一次打开），只会让它更晚。
//      开着同步时 trashSince 不晚于服务器的时间（GitHub 回应里提交的时刻）：写的那台设备时钟快了也不会让别的设备上写着的日期比真删的晚。
//   4. 报到：这台设备用上了这一版，记进同步的 data.devices；「设置 → 同步」据此列出更新了的设备、还没报到的设备
//      （两步上线时用来看每台设备是不是都更新了；开放以后照样报到，还在用旧版本的设备照样列出来）。
// 分两步上线，现在是第二阶段：PURGE_ENABLED = true（第一阶段 babble-v28 是 false）。设成 false 时页面不显示永久删除的按钮（页面自己看这个开关），
// 这里的永久删除也什么都不做（这台设备不产生墓碑）、不自动永久删除、不记 babble.trash、不写 trashSince；别的设备来的墓碑照样合并、
// 照样清理本机（sweep 不受开关影响），移除的录音照样能放回去。测试传 enabled: false（页面传 purgeEnabled: false）测关着的那部分。
// 依赖都由调用方传进来（app.js），Node 里能测；import 时什么都不做。
import { goneShas, claimShas, stubShas, purgedRecord, purgeRemovedRecord, restoreRemovedRecord, orphanTombstone, trashKeys, isTombstone, setSetting, PURGE_MS, TOUCH_MS } from './store.js';
import { EDIT_PREFIX } from './drafts.js';
import { FEATURES } from './sync.js';
import { debounce, isObj, str } from './util.js';

/** 开着（第二阶段）：有「永久删除」「全部永久删除」「没有梦话在用的录音」「清理云端历史」，30 天自动永久删除开始计时。第一阶段是 false */
export const PURGE_ENABLED = true;
export const TRASH_KEY = 'babble.trash';           // 本机：{ '<trashKey>|<since>': 这台设备第一次看到的时刻 }
/** 开着同步时，永久删除了的录音在各台设备上再留几天才删（见上面 2.）；没开同步不会有别的设备来作废，马上删 */
export const PURGE_GRACE_MS = 7 * 864e5;
/** trashSince 比服务器的时间晚这么多以上才改（服务器的时间只精确到秒，再加上路上的时间；差几分钟在「n 天后」上看不出来） */
export const CLOCK_SLACK_MS = 10 * 6e4;
const SHA = /^[0-9a-f]{64}$/;

/** 一组 sha（Set，或以 sha 为键的 Map）的指纹：个数 + 与顺序无关的和。判断「没了的录音」变了没有，变了才去清理；null → 'none' */
export function shaSig(set) {
  if (!set) return 'none';
  let h = 0;
  for (const s of set instanceof Map ? set.keys() : set) h = (h + (parseInt(String(s).slice(0, 8), 16) || 0)) % 4294967296;
  return set.size + ':' + h;
}

// ---------- 报到（两步上线时用来看是不是每台设备都更新了；开放以后照样报到，「设置 → 同步」照样列出还没更新的设备） ----------
// data.devices[设备 id] = { id, updatedAt, seenAt, since, whoAt, name, aka?, who, build, features }：updatedAt = seenAt = 最后一次报到（合并按它取新的）；
// since：第一次报到（从这时起它就是新版本了：之后同名的旧版本推送一定是别的设备）；whoAt：「谁在用」最后一次改的时刻（在这之后它不会再签没写谁的名）；
// aka：这台设备以前用过的名字（改过名，旧签名照样对得上）；features 和写进 babble.json 的一样（sync.js 的 FEATURES）。旧版本 App 不认识这个集合，原样保留
export const DEVICE_EVERY = 3 * 864e5;             // 什么都没变时多久再报到一次（每次报到都要多推一次 babble.json）
const DEVICE_WITHIN = 60 * 864e5;
const whoOf = (v) => (v === 'me' || v === 'nn' ? v : null);
/**
 * 这台设备报到 → 新的记录；名字、谁在用、版本、功能都没变，离上次报到又不到 every → null（不用每轮同步都多推一次）
 * @param {object|null} prev  data.devices 里这台设备原来的记录
 * @param {{ id: string, name: string, who?: 'me'|'nn'|null, build?: string|null, now?: number, every?: number }} o
 */
export function deviceSeen(prev, { id, name, who = null, build = null, now = Date.now(), every = DEVICE_EVERY } = {}) {
  if (typeof id !== 'string' || !id) return null;
  const p = isObj(prev) ? prev : null, nm = str(name).trim();
  const aka = [...new Set([...(p && Array.isArray(p.aka) ? p.aka : []), ...(p && p.name ? [str(p.name)] : [])])].filter(x => typeof x === 'string' && x && x !== nm).slice(-5);
  const rec = { id, name: nm, ...(aka.length ? { aka } : {}), who: whoOf(who), build: typeof build === 'string' && build ? build : null, features: [...FEATURES] };
  const same = p && ['name', 'who', 'build'].every(k => (p[k] ?? null) === rec[k]) && JSON.stringify(p.aka || []) === JSON.stringify(rec.aka || [])
    && JSON.stringify(p.features || []) === JSON.stringify(rec.features);
  const last = p ? Number(p.seenAt) || Number(p.updatedAt) || 0 : 0;
  if (same && now - last < every) return null;          // 上次记在将来（时钟往回拨过）：也不重写，免得每轮同步都推一次
  const at = Math.max(now, (Number(p && p.updatedAt) || 0) + 1);
  const since = p && Number(p.since) > 0 ? Number(p.since) : at;
  const whoAt = p && (p.who ?? null) === rec.who ? Number(p.whoAt) || since : at;
  return { ...rec, updatedAt: at, seenAt: at, since, whoAt };
}
/**
 * 「设置 → 同步」的设备一览
 *   updated：报过到的（最后报到晚的在前）；me：这台设备（给了 self、这台还没报到——比如还没同步成功过——也列在最前，seenAt null）
 *   waiting：within 以内在梦话上签过名（updatedBy / deletedBy 的 { who, device }）、对不上任何报到记录、也不是这台设备（self：还没报到也算更新了）的；
 *            名字（或以前的名字）一样、谁在用不冲突就算对上——没写谁的签名，要那台设备签名时也还没写谁（whoAt 晚于签名）才算对上
 *            （同名的另一台设备早就写了谁，这个签名就是别的设备签的）。同一个名字有写了谁、也没对上的签名，就不再单列没写谁的。
 *            用旧版本推送过的（sync 的 oldDevices：已经按报到的时间筛过，同名的设备报到以后又有旧版本推送）一定列上。
 *            at：最近一次签名的时刻（只见过旧版本推送的 → null）；old：最近同步时还是旧版本
 * @param {object} state  @param {{ me?: string|null, self?: { name, who }|null, oldDevices?: string[], now?: number, within?: number }} [o]
 * @returns {{ updated: Array<{ id, name, who, build, seenAt, me }>, waiting: Array<{ name, who, at, old }> }}
 */
export function deviceReport(state, { me = null, self = null, oldDevices = [], now = Date.now(), within = DEVICE_WITHIN } = {}) {
  const D = state && isObj(state.data) && isObj(state.data.devices) ? state.data.devices : {};
  const recs = Object.values(D).filter(d => isObj(d) && typeof d.id === 'string' && d.id);
  const updated = recs.map(d => ({ id: d.id, name: str(d.name), who: whoOf(d.who), build: typeof d.build === 'string' && d.build ? d.build : null,
    seenAt: Number(d.seenAt) || Number(d.updatedAt) || null, me: d.id === me }))
    .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0) || (a.id < b.id ? -1 : 1));
  if (self && str(self.name).trim() && !updated.some(d => d.me)) updated.unshift({ id: me || str(self.name).trim(), name: str(self.name).trim(), who: whoOf(self.who), build: null, seenAt: null, me: true });
  const names = (d) => [str(d.name), ...(Array.isArray(d.aka) ? d.aka.map(str) : [])];
  const whoSince = (d) => Number(d.whoAt) || Number(d.since) || Infinity;      // 老记录、还没报到的这台设备：不知道，算一直没写谁
  const meRec = recs.find(d => d.id === me);                                 // 这台设备（名字按现在的；报到过的话「谁在用」的时间按它的记录）
  const mine = self ? [{ ...self, ...(meRec ? { whoAt: meRec.whoAt, since: meRec.since } : {}) }] : [];
  const covered = (s) => [...recs, ...mine].some(d => names(d).includes(s.name)
    && (s.who ? !whoOf(d.who) || s.who === whoOf(d.who) : !whoOf(d.who) || whoSince(d) > (s.at || 0)));
  const sigs = new Map();
  const note = (name, who, at) => { const k = (who || '') + '|' + name; if (!sigs.has(k) || (at || 0) > (sigs.get(k).at || 0)) sigs.set(k, { name, who, at }); };
  for (const e of Object.values((state && isObj(state.data) && isObj(state.data.entries) && state.data.entries) || {})) {
    if (!isObj(e)) continue;
    for (const by of [e.updatedBy, e.deletedBy]) {
      const name = isObj(by) ? str(by.device).trim() : '', at = isObj(by) ? Number(by.at) || Number(e.updatedAt) || 0 : 0;
      if (name && now - at <= within) note(name, whoOf(by.who), at);
    }
  }
  const old = new Set((Array.isArray(oldDevices) ? oldDevices : []).map(n => str(n).trim()).filter(Boolean));
  const open = [...sigs.values()].filter(s => !covered(s));
  const list = open.filter(s => !(s.who === null && open.some(x => x.who && x.name === s.name)));
  for (const n of old) if (!list.some(s => s.name === n)) list.push({ name: n, who: null, at: (sigs.get('|' + n) || {}).at ?? null });
  const waiting = list.map(s => ({ ...s, old: old.has(s.name) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { updated, waiting };
}

/**
 * @param {object} o
 * @param {() => object} o.getState                  当前数据
 * @param {(fn, opts) => any} o.mutate               state.mutate
 * @param {object} [o.audio]                         audioStore（listClips、listRecMeta、deleteClips）
 * @param {() => boolean} [o.saveOk]                 最近一次保存成功没有（没开同步时，墓碑存进本机了才删录音）
 * @param {() => boolean} [o.syncOn]                 开着同步没有
 * @param {() => Set<string>|null} [o.confirmedGone] sync 的 confirmedGone：云端确认过的「没了的录音」；null = 这台设备还没确认过现在的云端
 * @param {() => boolean} [o.storageOk]              本机数据没问题（有问题时不自动永久删除）
 * @param {object} [o.journal]                       history.js 的 journal（forget、entryIds）
 * @param {object} [o.night]                         nightStore（listCands、deleteParts、patchCand）
 * @param {Storage|(() => Storage|null)} [o.storage] localStorage：编辑页草稿 babble.edit.*、babble.trash
 * @param {(sha) => void} [o.forgetPlayer]           player.js 的 forgetClip
 * @param {(ids) => any} [o.scrubText]               state.scrubText：磁盘上的旧文字换成墓碑
 * @param {object} [o.cloudHistory]                  createCloudHistory 的结果（forget）
 * @param {() => object} [o.getLocal]  @param {(patch) => void} [o.setLocal]   babble.local（sttRun）
 * @param {() => Set<string>} [o.gone]               goneShas(getState()) 的缓存版（app.js 数据变了就清）
 * @param {boolean} [o.enabled]                      默认 PURGE_ENABLED（现在开着；测试传 false 测关着的那部分）
 * @param {() => number} [o.now]
 */
export function createPurger(o) {
  const { getState, mutate, audio } = o;
  const enabled = o.enabled ?? PURGE_ENABLED;
  const now = o.now || Date.now;
  const grace = o.grace ?? PURGE_GRACE_MS;
  const saveOk = o.saveOk || (() => true), syncOn = o.syncOn || (() => false), storageOk = o.storageOk || (() => true);
  const confirmedGone = () => (o.confirmedGone ? o.confirmedGone() : null);
  const gone = () => (o.gone ? o.gone() : goneShas(getState()));
  const store = () => { try { return (typeof o.storage === 'function' ? o.storage() : o.storage) || null; } catch (e) { return null; } };
  const log = (what, e) => console.warn('purge', what, e);
  const tomb = (id) => { const e = id && getState().data.entries[id]; return isTombstone(e) ? e : null; };
  /** 最早能删字节的时刻：开着同步 = 记号的 purgedAt + grace；没开同步 → 0（不用等） */
  const ripeAt = (purgedAt) => (syncOn() ? (Number(purgedAt) || 0) + grace : 0);
  const handled = new Set();         // 这次打开 App 已经处理过的墓碑（修改记录、磁盘上的文字、云端历史的缓存）；full 时不看它
  const explicit = new Set();        // 这次打开里用户自己点了永久删除的录音：不用等一小时（云端确认以后的那次清理也算）
  const shasOf = (e) => [...(e.audio || []), ...(e.removedAudio || [])].map(a => a.sha256);
  const none = () => ({ done: [], changed: [] });

  /** 编辑页草稿里刚加进来、还没保存的录音（added、inline 的键）：不算没人用，不删（条目里原有的录音不在此列） */
  function draftAdded() {
    const out = new Set(), st = store();
    if (!st) return out;
    let n = 0;
    try { n = st.length; } catch (e) { return out; }
    for (let i = 0; i < n; i++) {
      try {
        const k = st.key(i);
        if (!k || !k.startsWith(EDIT_PREFIX)) continue;
        const d = JSON.parse(st.getItem(k) || 'null');
        if (!isObj(d)) continue;
        for (const s of Array.isArray(d.added) ? d.added : []) if (typeof s === 'string') out.add(s);
        if (isObj(d.inline)) for (const s of Object.keys(d.inline)) out.add(s);
      } catch (e) { /* 这份坏了：跳过 */ }
    }
    return out;
  }

  /** 删字节的前提：开着同步时云端确认过的、没开同步时已经存进本机的「没了的录音」。null = 现在一个都不能删 */
  const settled = () => (syncOn() ? confirmedGone() : saveOk() ? gone() : null);
  /** 现在可以删字节的 sha：没了、在 settled 里、开着同步时过了那几天；草稿里刚加的除外。null = 现在一个都不能删 */
  function killable() {
    const C = settled();
    if (!C) return null;
    const D = draftAdded(), stubs = stubShas(getState()), t = now();
    return new Set([...gone()].filter(s => C.has(s) && !D.has(s) && ripeAt((stubs.get(s) || {}).purgedAt) <= t));
  }
  // 给 deleteClips 在事务里同步地再查一次：同一拍里只算一次（几百段也不用每段都扫一遍所有条目）
  let memo = null;
  const stillGone = (s) => {
    if (!memo) { memo = killable() || new Set(); queueMicrotask(() => { memo = null; }); }
    return memo.has(s);
  };

  // ---------- 清理本机（一次只跑一个；每一步都可以重复做） ----------
  let chain = Promise.resolve(), timer = null;
  /** 还留着、到时候才能删的（等那几天、等一小时）：最早那一刻过几秒再清理一次（只排一个；每次清理重新排） */
  function wakeAt(times) {
    const t = now(), at = Math.min(...times.filter(x => x > t));
    if (timer) { (o.clearTimeout || clearTimeout)(timer); timer = null; }
    if (!Number.isFinite(at)) return;
    timer = (o.setTimeout || setTimeout)(() => { timer = null; sweep(); }, Math.min(at - t + 5000, 2 ** 31 - 1));
    if (timer && timer.unref) timer.unref();       // Node（测试）里不挡着退出
  }
  /** → Promise<{ clips: [sha…], parts: n }>（删掉的录音、床头模式的片段）。own：刚永久删除的这几段，不用等一小时 */
  function sweep(opts = {}) {
    const p = chain.then(() => runSweep(opts));
    chain = p.catch(() => {});
    return p;
  }
  async function runSweep({ full = false, own = [] } = {}) {
    const out = { clips: [], parts: 0 };
    for (const s of own) explicit.add(s);
    const S = getState(), tombs = Object.values(S.data.entries).filter(isTombstone).map(e => e.id), isTomb = new Set(tombs);
    for (const id of [...handled]) if (!isTomb.has(id)) handled.delete(id);   // 永久删除作废了（别的设备改过）：以后再永久删除时重新处理
    const fresh = full ? tombs : tombs.filter(id => !handled.has(id));
    // 1. 录音：forgetPlayer 停掉正在放的、丢掉均衡缓存；deleteClips 连同这些 sha 的录音分片（recMeta）一起删。
    //    没了、确认过、只是还没到时候（那几天、一小时内碰过）的：记下最早能删的时刻，到时候再来
    const K = killable(), C = settled(), wake = [];
    let listed = false;
    if (C && C.size && audio && audio.deleteClips) {
      try {
        const list = await audio.listClips(), kill = list.map(c => c.sha256).filter(s => K && K.has(s));
        if (kill.length) {
          for (const s of kill) { try { if (o.forgetPlayer) o.forgetPlayer(s); } catch (e) { log('player', e); } }
          out.clips = (await audio.deleteClips(kill, { stillGone, minAge: s => (explicit.has(s) ? 0 : TOUCH_MS) })) || [];
          for (const s of out.clips) explicit.delete(s);
        }
        const G = gone(), D = draftAdded(), stubs = stubShas(getState()), del = new Set(out.clips);
        for (const c of list) {
          const s = c.sha256;
          if (del.has(s) || !G.has(s) || !C.has(s) || D.has(s)) continue;
          wake.push(Math.max(ripeAt((stubs.get(s) || {}).purgedAt), explicit.has(s) ? 0 : (Number(c.touchedAt) || Number(c.addedAt) || 0) + TOUCH_MS));
        }
        listed = true;
      } catch (e) { log('clips', e); }
    }
    // 2. 修改记录：新的墓碑 state.js 当场交给 journal.forget；full 时把上次崩溃留下的也清掉
    if (full && o.journal && o.journal.entryIds && tombs.length) {
      try {
        const have = new Set(await o.journal.entryIds());
        const ids = tombs.filter(id => have.has(id));
        if (ids.length) await o.journal.forget(ids);
      } catch (e) { log('journal', e); }
    }
    // 3. 磁盘上的旧文字（babble.state、待合并的日志、修复存档）；失败的下次再来
    let scrubbed = true;
    if (fresh.length && o.scrubText) { try { await o.scrubText(fresh); } catch (e) { scrubbed = false; log('scrub', e); } }
    // 4. 床头模式：留下过、后来永久删除了的片段，和留下以后撤销了、那条后来永久删除了的（sha256 还记着）——删声音、标 gone，
    //    entryId / sha256 留着（还算留下过、还认得出是哪段录音，不能再留一次）。
    //    只等「能删」的前提（settled：开着同步时云端确认过这段没了；没开同步时墓碑存进本机了），不等那几天：永久删除作废了的话，
    //    找回录音靠的是 babble-audio 里留下时存的那份（照样等那几天，下一轮同步重新传上去）；片段只能拿来再留一次，那正是不能做的。
    //    没确认之前片段还在，昨夜页按 goneShas 把它当成已经永久删除了（放不了、留不了、不算待听；views/night.js 的 purgedBy）。
    //    sha 没了的看 settled 里有没有它；sha 还有别的条目在用（或没记下 sha）的看墓碑
    const C2 = settled();
    if (C2 && o.night) {
      try {
        const G = gone();
        for (const c of await o.night.listCands()) {
          if (!c || c.gone) continue;
          const bySha = !!(c.sha256 && G.has(c.sha256));
          if (bySha ? !C2.has(c.sha256) : !tomb(c.entryId)) continue;
          try { await o.night.deleteParts(c.id); await o.night.patchCand(c.id, { gone: true }); out.parts++; } catch (e) { log('night', e); }
        }
      } catch (e) { log('night', e); }
    }
    if (listed || wake.length) wakeAt(wake);
    // 5. 云端历史的缓存（只在内存里）
    if (o.cloudHistory && o.cloudHistory.forget) for (const id of fresh) { try { o.cloudHistory.forget(id); } catch (e) { log('cloud', e); } }
    if (scrubbed) for (const id of fresh) handled.add(id);
    // 6. 转文字的记号（App 中途被关掉时下次提醒用）指着永久删除了的条目或录音：清掉
    const run = o.getLocal && o.getLocal() && o.getLocal().sttRun;
    if (run && typeof run.key === 'string' && o.setLocal) {
      const [id, sha] = run.key.split('|');
      if (tomb(id) || gone().has(sha)) o.setLocal({ sttRun: null });
    }
    return out;
  }
  const sweepSoon = debounce(() => { sweep(); }, 300);

  // ---------- 永久删除 ----------
  /**
   * 一次 mutate 永久删除：entries [{ id, at }]（at = 用户看到的 updatedAt）、clips [{ id, sha256, removedAt }]（用户看到的那几段）。
   * → { done, changed }：条目报 id，录音报 { id, sha256 }；别的设备已经永久删除了的算 done。开关关着 → 什么都不做，{ done: [], changed: [], skipped: true }
   */
  function purgeAll({ entries = [], clips = [] } = {}) {
    if (!enabled) return { ...none(), skipped: true };
    const res = none();
    if (!entries.length && !clips.length) return res;
    const touched = new Set(), t = now();
    mutate(s => {
      const E = s.data.entries;
      for (const { id, at } of entries) {
        const cur = E[id];
        if (isTombstone(cur)) { res.done.push(id); continue; }
        const r = cur ? purgedRecord(cur, at, t) : null;
        if (!r) { res.changed.push(id); continue; }
        for (const sha of shasOf(cur)) touched.add(sha);
        E[id] = r; res.done.push(id);
      }
      const byId = new Map();
      for (const c of clips) { if (!byId.has(c.id)) byId.set(c.id, []); byId.get(c.id).push(c); }
      for (const [id, list] of byId) {
        const cur = E[id];
        const same = (c) => !!cur && !cur.purged && !cur.deleted && (cur.removedAudio || []).some(x => x.sha256 === c.sha256 && x.removedAt === c.removedAt);
        const ok = list.filter(same);
        const r = ok.length ? purgeRemovedRecord(cur, ok.map(c => ({ sha256: c.sha256, removedAt: c.removedAt })), t) : null;
        for (const c of list) (r && ok.includes(c) ? res.done : res.changed).push({ id, sha256: c.sha256 });
        if (r) { E[id] = r; for (const c of ok) touched.add(c.sha256); }
      }
    }, { cause: 'purge' });
    after(touched);
    return res;
  }
  /** 用户刚删的这几段已经算没了：马上清本机（own 不等一小时）。没开同步又存不进本机时不删（下次重试） */
  function after(touched) {
    const G = gone(), own = [...touched].filter(s => G.has(s));
    if (saveOk() || syncOn()) sweep({ own });
  }

  /**
   * 没有条目在用的录音 [{ sha256, mime }]：再查一次没人用、没在草稿里、不是正在存的录音，写一个孤儿墓碑（o_…）；之后照常传开、删掉。
   * → Promise<{ done: [sha], changed: [sha] }>（changed：又有条目在用了、或正在用）
   */
  async function purgeOrphans(list = []) {
    if (!enabled) return { ...none(), skipped: true };
    const res = none();
    if (!list.length) return res;
    let busy = new Set();
    try { busy = new Set(((audio && audio.listRecMeta ? await audio.listRecMeta() : []) || []).map(m => m && m.sha256).filter(Boolean)); } catch (e) { log('recMeta', e); }
    const C = claimShas(getState()), G = gone(), D = draftAdded(), ok = [], seen = new Set();
    for (const x of list) {
      const sha = str(x && x.sha256).toLowerCase();
      if (!SHA.test(sha) || seen.has(sha)) continue;
      seen.add(sha);
      if (G.has(sha)) res.done.push(sha);                                      // 已经没了（别处删过）
      else if (C.has(sha) || D.has(sha) || busy.has(sha)) res.changed.push(sha);
      else ok.push({ sha256: sha, mime: str(x && x.mime) || 'audio/mp4' });
    }
    if (!ok.length) return res;
    mutate(s => { const tb = orphanTombstone(ok, now()); if (tb) s.data.entries[tb.id] = tb; }, { cause: 'purge' });
    res.done.push(...ok.map(x => x.sha256));
    after(new Set(ok.map(x => x.sha256)));
    return res;
  }

  /** 「移除的录音」放回那条（开关关着也能用）→ 存好的条目 | null（那段已经不在「移除的录音」里了）。提示由页面弹 */
  function restoreClip(id, sha) {
    const ok = mutate(s => {
      const cur = s.data.entries[id];
      const r = cur && !cur.purged ? restoreRemovedRecord(cur, sha, now()) : null;
      if (r) s.data.entries[id] = r;
      return !!r;
    });
    return ok ? getState().data.entries[id] : null;
  }

  // ---------- 30 天 ----------
  let wrote = null;                  // 这次打开按自己的钟写下的 trashSince（还不知道服务器几点的时候）
  const trashId = (k, v) => k + '|' + (Number(v && v.since) || 0);    // 同一项删了、恢复、又删：since 变了，重新算 30 天
  function readTrash() {
    try { const st = store(), v = JSON.parse((st && st.getItem(TRASH_KEY)) || 'null'); return isObj(v) ? v : {}; } catch (e) { return {}; }
  }
  /** 记下这台设备第一次看到每一项在「最近删除」里的时刻，已经不在的去掉。写之前重新读：几个标签页同时写，取较早的；记在将来的（时钟错过）改成现在 */
  function noteTrash() {
    const st = store();
    if (!enabled || !st || !storageOk()) return;
    const disk = readTrash(), t = now(), next = {};
    for (const [k, v] of trashKeys(getState())) { const id = trashId(k, v), f = Number(disk[id]); next[id] = f > 0 ? Math.min(f, t) : t; }
    const keys = Object.keys(next);
    if (keys.length === Object.keys(disk).length && keys.every(k => Number(disk[k]) === next[k])) return;
    try { st.setItem(TRASH_KEY, JSON.stringify(next)); } catch (e) { /* 存不下：下次再记，只会更晚删 */ }
  }
  /**
   * 开放永久删除的时刻（同步的设置，只写一次）：没开同步时启动时调；开着同步时每一轮同步成功以后调（第一轮以前不调：不盖掉别的设备早写好的）。
   * serverNow：服务器上现在几点（sync 的 serverNow；这次打开还没提交过 → null）。写的时候不晚于它。
   * 写的那台设备时钟快了（比如快两天）、写的时候还不知道服务器几点 → 知道以后改：这次打开自己写下的，按时钟快了多少往前挪（= 写下那一刻服务器的时间）；
   * 别的设备写的、比服务器现在还晚 CLOCK_SLACK_MS 以上 → 改成服务器现在。不改的话，时钟准的设备上写着的日期比时钟快的那台真删的晚
   * （它按自己的钟、从自己第一次看到算满 30 天）。改早了不会让哪台设备删得更早：每台设备还要从自己第一次看到算满 30 天。→ 写了没有
   */
  function ensureTrashSince(serverNow = null) {
    if (!enabled || !storageOk()) return false;
    const cur = Number(getState().settings.trashSince) || 0, srv = Number(serverNow) > 0 ? Number(serverNow) : null, t = now();
    let v;
    if (!cur) v = srv ? Math.min(t, srv) : t;
    else if (srv) {
      v = cur === wrote ? Math.min(cur, cur - (t - srv)) : srv;
      if (!(cur > v + CLOCK_SLACK_MS)) return false;
    } else return false;
    mutate(s => setSetting(s, 'trashSince', v, t));
    wrote = srv ? null : v;                       // 按自己的钟写的：知道服务器几点以后可能还要挪
    return true;
  }
  /** 「最近删除」里一项（trashKeys 的键）的日期：shownAt = max(trashSince, min(删除时刻, 这台设备第一次看到)) + 30 天；还没有 trashSince（开着同步、开放以后还没同步成功过，云端也没有别的设备写的）→ null */
  function trashInfo(key) {
    const S = getState(), since = Number(S.settings.trashSince) || 0, v = trashKeys(S).get(key);
    if (!since || !v) return { shownAt: null };
    const f = Number(readTrash()[trashId(key, v)]) || Infinity, at = Math.min(Number(v.since) || Infinity, f);
    return { shownAt: Math.max(since, Number.isFinite(at) ? at : since) + PURGE_MS };
  }
  /** 到期的永久删除：这台设备第一次看到它已经 30 天、也过了 trashSince 30 天。同步正不正常都跑；本机数据有问题时不跑。→ { n } */
  function autoPurge() {
    if (!enabled || !storageOk()) return { n: 0 };
    noteTrash();
    const S = getState(), since = Number(S.settings.trashSince) || 0;
    if (!since) return { n: 0 };
    const seen = readTrash(), t = now(), due = [];
    for (const [k, v] of trashKeys(S)) {
      const f = Number(seen[trashId(k, v)]);
      if (f > 0 && Math.max(since, f) + PURGE_MS <= t) due.push(v);
    }
    if (!due.length) return { n: 0 };
    let n = 0;
    mutate(s => {
      const E = s.data.entries;
      for (const v of due) {
        const cur = E[v.id];
        if (!cur || cur.purged) continue;
        const r = v.kind === 'entry' ? purgedRecord(cur, cur.updatedAt, t)
          : !cur.deleted ? purgeRemovedRecord(cur, [{ sha256: v.sha, removedAt: v.since }], t) : null;
        if (r) { E[v.id] = r; n++; }
      }
    }, { cause: 'purge' });
    if (n) sweep();
    return { n };
  }

  // ---------- 这台设备上没有条目在用的录音（只读） ----------
  /** → [{ sha256, mime, bytes, addedAt, uploaded }]：没有条目在用（含最近删除里的）、不是已经没了的、不在草稿里、不是正在存的录音、一小时内没碰过 */
  async function localOrphans() {
    if (!audio) return [];
    const S = getState(), C = claimShas(S), G = gone(), D = draftAdded(), t = now();
    const metas = audio.listRecMeta ? await audio.listRecMeta() : [];
    const R = new Set((metas || []).map(m => m && m.sha256).filter(Boolean));
    return (await audio.listClips())
      .filter(c => !C.has(c.sha256) && !G.has(c.sha256) && !D.has(c.sha256) && !R.has(c.sha256) && t - (c.touchedAt || c.addedAt || 0) >= TOUCH_MS)
      .map(c => ({ sha256: c.sha256, mime: c.mime, bytes: c.bytes ?? null, addedAt: c.addedAt || null, uploaded: !!c.uploaded }));
  }

  return {
    enabled,
    purgeEntries: (list) => purgeAll({ entries: list || [] }),
    purgeClips: (list) => purgeAll({ clips: list || [] }),
    purgeAll, purgeOrphans, restoreClip,
    autoPurge, noteTrash, ensureTrashSince, trashInfo,
    sweep, sweepSoon, localOrphans, draftAdded,
  };
}
