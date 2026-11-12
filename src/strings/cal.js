// 文案（日历）：cal.*。「列表 | 日历」切换也在这里。
// 繁體（台灣）用台灣用語（日曆、則…）；星期几的名字用 Intl 按语言生成，不写在这里。
// 英文单复数：en(一个, 多个)
const en = (one, many) => (v) => (Number(v.n) === 1 ? one : many).replace('{n}', v.n);

export const STRINGS = {
  'zh-Hans': {
    'cal.mode': '查看方式', 'cal.list': '列表', 'cal.cal': '日历',
    'cal.prevMonth': '上个月', 'cal.nextMonth': '下个月', 'cal.prevYear': '上一年', 'cal.nextYear': '下一年', 'cal.today': '今天',
    'cal.openYear': '{month}，查看全年', 'cal.backMonth': '回到 {month}',
    'cal.n': '{n} 条', 'cal.audio': '有录音', 'cal.inbox': '有待整理',
    'cal.dayNone': '这天没有记录。', 'cal.write': '记一条',
    'cal.emptyMonth': '这个月还没有', 'cal.nearest': '最近一条在 {date}',
    'cal.none': '还没有梦话，记下第一条以后，有梦话的日子会在这里标出来。',
  },

  'zh-Hant-TW': {
    'cal.mode': '檢視方式', 'cal.list': '列表', 'cal.cal': '日曆',
    'cal.prevMonth': '上個月', 'cal.nextMonth': '下個月', 'cal.prevYear': '上一年', 'cal.nextYear': '下一年', 'cal.today': '今天',
    'cal.openYear': '{month}，檢視全年', 'cal.backMonth': '回到 {month}',
    'cal.n': '{n} 則', 'cal.audio': '有錄音', 'cal.inbox': '有待整理',
    'cal.dayNone': '這天沒有記錄。', 'cal.write': '記一則',
    'cal.emptyMonth': '這個月還沒有', 'cal.nearest': '最近一則在 {date}',
    'cal.none': '還沒有夢話，記下第一則以後，有夢話的日子會在這裡標出來。',
  },

  en: {
    'cal.mode': 'View', 'cal.list': 'List', 'cal.cal': 'Calendar',
    'cal.prevMonth': 'Previous month', 'cal.nextMonth': 'Next month', 'cal.prevYear': 'Previous year', 'cal.nextYear': 'Next year', 'cal.today': 'Today',
    'cal.openYear': '{month}, show the whole year', 'cal.backMonth': 'Back to {month}',
    'cal.n': en('{n} entry', '{n} entries'), 'cal.audio': 'with audio', 'cal.inbox': 'to tidy',
    'cal.dayNone': 'Nothing recorded on this day.', 'cal.write': 'Write one',
    'cal.emptyMonth': 'Nothing this month', 'cal.nearest': 'Nearest: {date}',
    'cal.none': 'No sleep talk yet. Once you write one, the days with entries are marked here.',
  },
};
