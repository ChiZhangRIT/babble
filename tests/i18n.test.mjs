import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, setLang, getLang, guessLang, has, LANGS, LANG_LABELS, STRINGS, TABLES } from '../src/i18n.js';

const fields = s => [...s.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort();
const SAMPLE = { n: 3, time: '凌晨2:58', status: 500, file: 'babble.json', msg: 'x', nn: 'NN', up: 1, down: 2 };

test('每个文案文件：三种语言的键完全一样', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    const keys = Object.keys(table['zh-Hans']).sort();
    for (const lang of LANGS) assert.deepEqual(Object.keys(table[lang] || {}).sort(), keys, `${name} / ${lang}`);
  }
});

test('同一个键不能出现在两个文案文件里（合并时会互相覆盖）', () => {
  const seen = new Map();
  for (const [name, table] of Object.entries(TABLES)) {
    for (const key of Object.keys(table['zh-Hans'])) {
      assert.ok(!seen.has(key), `${key} 同时在 ${seen.get(key)} 和 ${name}`);
      seen.set(key, name);
    }
  }
});

test('动态字段三种语言一致；函数文案能用示例变量算出完整的句子', () => {
  for (const key of Object.keys(STRINGS['zh-Hans'])) {
    const vals = LANGS.map(l => STRINGS[l][key]);
    for (const v of vals) assert.ok(typeof v === 'string' ? v.length : typeof v === 'function', key);
    const strs = vals.filter(v => typeof v === 'string');
    for (const s of strs) assert.deepEqual(fields(s), fields(strs[0]), key);
    for (const [i, v] of vals.entries()) {
      if (typeof v !== 'function') continue;
      for (const n of [0, 1, 2, 12]) {
        const out = v({ ...SAMPLE, n }, { lang: LANGS[i], num: String });
        assert.equal(typeof out, 'string', key);
        assert.ok(out.length && !/\{\w+\}|undefined/.test(out), `${key} → ${out}`);
      }
    }
  }
});

test('公共文案只用约定的前缀；同步错误代码齐全', () => {
  for (const key of Object.keys(TABLES.core['zh-Hans'])) assert.match(key, /^(common|nav|player|sync|syncErr)\./, key);
  for (const code of ['net', 'auth', 'perm', 'public', 'notFound', 'badFile', 'mergeFail', 'http', 'unknown', 'audioUp', 'audioDown', 'shaMismatch']) {
    assert.ok(has('syncErr.' + code), code);
  }
  for (const key of ['nav.list', 'nav.rec', 'nav.settings', 'common.undo', 'common.deletedOne']) assert.ok(has(key), key);
});

test('t()：替换变量；缺变量保留原样；不认识的键返回键名；不认识的语言退回简体', () => {
  setLang('zh-Hans');
  assert.equal(t('sync.ok', { time: '凌晨2:58' }), '已同步 · 凌晨2:58');
  assert.equal(t('sync.ok'), '已同步 · {time}');
  assert.equal(t('syncErr.http', { status: 502 }), 'GitHub 返回错误 502，稍后会再试。');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(setLang('fr'), 'zh-Hans');
  assert.equal(getLang(), 'zh-Hans');
});

test('英文数量分单复数', () => {
  setLang('en');
  assert.match(t('common.recovered', { n: 1 }), /^Recovered 1 unfinished recording\./);
  assert.match(t('common.recovered', { n: 2 }), /^Recovered 2 unfinished recordings\./);
  assert.equal(t('sync.audioUp', { n: 1 }), '1 recording to upload');
  assert.equal(t('sync.audioDown', { n: 4 }), '4 recordings to download');
  setLang('zh-Hans');
  assert.equal(t('sync.audioUp', { n: 4 }), '4 段录音待上传');
});

test('台灣用語；變數內容（使用者的字）不轉換', () => {
  setLang('zh-Hant-TW');
  const want = { 'nav.settings': '設定', 'common.save': '儲存', 'common.undo': '復原', 'sync.repo': '儲存庫', 'sync.token': '存取權杖', 'nav.import': '匯入錄音', 'nav.list': '囈語', 'common.appName': '牙牙囈語' };
  for (const [key, value] of Object.entries(want)) assert.equal(t(key), value, key);
  assert.equal(t('sync.partner', { nn: '简体名字' }).startsWith('简体名字'), true);
  setLang('zh-Hans');
});

test('语言列表和名称；按系统语言猜第一次打开的语言', () => {
  assert.deepEqual(LANGS, ['zh-Hans', 'zh-Hant-TW', 'en']);
  for (const l of LANGS) assert.ok(LANG_LABELS[l], l);
  assert.equal(guessLang(['zh-TW']), 'zh-Hant-TW');
  assert.equal(guessLang(['zh-Hant-HK']), 'zh-Hant-TW');
  assert.equal(guessLang(['zh-CN', 'en']), 'zh-Hans');
  assert.equal(guessLang(['en-US']), 'zh-Hans');            // 英文系统也先用简体，English 要在设置里选
  assert.equal(guessLang(['en-US', 'zh-Hant-TW']), 'zh-Hant-TW');
  assert.equal(guessLang(['fr-FR']), 'zh-Hans');
  assert.equal(guessLang([]), 'zh-Hans');
});

test('源码里写死的文案键（t(\'…\')）都有；拼出来的键（t(\'imp.warn.\' + code)）至少有一个', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const root = new URL('../src/', import.meta.url).pathname;
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js') && f !== 'i18n.js') files.push(p); } })(root);   // i18n.js 自己的注释里有 t('key') 示例
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'\s*([,)+])/g)) {
      if (m[2] === '+') assert.ok(Object.keys(STRINGS['zh-Hans']).some(k => k.startsWith(m[1])), `${path.basename(f)}: ${m[1]}…`);
      else assert.ok(has(m[1]), `${path.basename(f)}: ${m[1]}`);
    }
  }
});
